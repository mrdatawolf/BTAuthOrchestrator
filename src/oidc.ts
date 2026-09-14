import { createHash, randomBytes } from "node:crypto";

import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Classification errors for CONTRACT-001's Failure behavior table. index.ts
 * maps each of these to its required status-code tier and user-facing
 * message; nothing here writes an HTTP response directly.
 */
export class EntraUnreachableError extends Error {}
export class TokenExchangeError extends Error {}
export class IdTokenValidationError extends Error {}
export class IdentityClaimMissingError extends Error {}

export interface EntraDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNetworkLevelError(error: unknown): boolean {
  // Node's global fetch rejects with a TypeError on DNS/connection failures,
  // and an AbortError (from the timeout signal) on a hung connection. Both
  // are "Entra unreachable" in CONTRACT-001's sense, not a protocol response.
  if (error instanceof TypeError) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

// --- PKCE / state / nonce generation -------------------------------------

/** Cryptographically random, URL-safe opaque token for `state` or `nonce`. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE code_verifier: 43 base64url characters from 32 random bytes (RFC 7636 length bounds: 43-128). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE S256 code_challenge derived from a code_verifier. */
export function computeCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

// --- Handshake state storage (CONTRACT-001 §2) ----------------------------

export interface HandshakeEntry {
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

export interface HandshakeStore {
  create(state: string, nonce: string, codeVerifier: string): void;
  /**
   * Looks up and immediately deletes the entry for `state`, regardless of
   * whether it is found or expired, so a given `state` can be redeemed at
   * most once. Returns undefined if absent or expired (CONTRACT-001 §2, §3.2).
   */
  consume(state: string): HandshakeEntry | undefined;
}

export function createHandshakeStore(ttlMs: number = HANDSHAKE_TTL_MS): HandshakeStore {
  const entries = new Map<string, HandshakeEntry>();

  function pruneExpired(now: number): void {
    for (const [state, entry] of entries) {
      if (now - entry.createdAt > ttlMs) entries.delete(state);
    }
  }

  return {
    create(state, nonce, codeVerifier) {
      pruneExpired(Date.now());
      entries.set(state, { nonce, codeVerifier, createdAt: Date.now() });
    },
    consume(state) {
      const entry = entries.get(state);
      entries.delete(state);
      if (entry === undefined) return undefined;
      if (Date.now() - entry.createdAt > ttlMs) return undefined;
      return entry;
    },
  };
}

// --- Entra discovery document + JWKS caching (CONTRACT-001 §9) -----------

async function fetchDiscoveryDocument(
  tenantId: string,
  timeoutMs: number,
): Promise<EntraDiscoveryDocument> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new EntraUnreachableError(`Entra discovery document request failed: ${errorMessage(error)}`);
  }

  if (response.status >= 500) {
    throw new EntraUnreachableError(`Entra discovery document request returned ${response.status}.`);
  }
  if (!response.ok) {
    // A non-5xx failure fetching a fixed, already-registered discovery URL
    // indicates a configuration problem, not an outage; let it surface as
    // an unclassified error (mapped to the 500-class fallback by the caller).
    throw new Error(`Entra discovery document request returned ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new EntraUnreachableError(
      `Entra discovery document response was not valid JSON: ${errorMessage(error)}`,
    );
  }

  if (typeof payload !== "object" || payload === null) {
    throw new EntraUnreachableError("Entra discovery document response was not a JSON object.");
  }
  const record = payload as Record<string, unknown>;
  const { issuer, authorization_endpoint, token_endpoint, jwks_uri } = record;
  if (
    typeof issuer !== "string" ||
    typeof authorization_endpoint !== "string" ||
    typeof token_endpoint !== "string" ||
    typeof jwks_uri !== "string"
  ) {
    throw new EntraUnreachableError("Entra discovery document response was missing required fields.");
  }

  return { issuer, authorization_endpoint, token_endpoint, jwks_uri };
}

/**
 * Caches Entra's OIDC discovery document in memory (CONTRACT-001 §9), so
 * `/auth/login` and `/auth/callback` do not require a fresh round trip to
 * Entra's metadata on every request. A transient refetch failure falls back
 * to the last-known-good document rather than failing the request, per §9's
 * "does not unnecessarily take down logins that don't require a fresh
 * fetch" requirement. The remote JWKS set used to validate ID token
 * signatures is jose's own `createRemoteJWKSet`, which does its own
 * kid-driven caching with a cooldown against abuse.
 */
export class EntraDiscoveryCache {
  private cached: { document: EntraDiscoveryDocument; fetchedAt: number } | undefined;
  private remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  private remoteJwksUri: string | undefined;

  constructor(
    private readonly ttlMs: number = DISCOVERY_CACHE_TTL_MS,
    private readonly timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  ) {}

  async getDiscoveryDocument(tenantId: string): Promise<EntraDiscoveryDocument> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.fetchedAt < this.ttlMs) {
      return this.cached.document;
    }
    try {
      const document = await fetchDiscoveryDocument(tenantId, this.timeoutMs);
      this.cached = { document, fetchedAt: now };
      return document;
    } catch (error) {
      if (this.cached !== undefined) {
        console.error(
          `Entra discovery refresh failed; continuing with the last cached document: ${errorMessage(error)}`,
        );
        return this.cached.document;
      }
      throw error;
    }
  }

  getRemoteJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    if (this.remoteJwks === undefined || this.remoteJwksUri !== jwksUri) {
      this.remoteJwks = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: this.timeoutMs });
      this.remoteJwksUri = jwksUri;
    }
    return this.remoteJwks;
  }
}

// --- Authorization code exchange (CONTRACT-001 §3.3) ----------------------

export interface ExchangeAuthorizationCodeParams {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  timeoutMs?: number;
}

/**
 * Exchanges an authorization code for Entra's ID token. Only the ID token is
 * returned to the caller; any access token or refresh token in the response
 * is discarded here and never propagated further (CONTRACT-001 §3, "used
 * only transiently... never persisted, never logged, never forwarded").
 */
export async function exchangeAuthorizationCode(
  params: ExchangeAuthorizationCodeParams,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(params.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EntraUnreachableError(`Entra token endpoint request failed: ${errorMessage(error)}`);
  }

  if (response.status >= 500) {
    throw new EntraUnreachableError(`Entra token endpoint returned ${response.status}.`);
  }
  if (!response.ok) {
    throw new TokenExchangeError(`Entra token endpoint returned ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new EntraUnreachableError(
      `Entra token endpoint response was not valid JSON: ${errorMessage(error)}`,
    );
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).id_token !== "string"
  ) {
    throw new TokenExchangeError("Entra token endpoint response did not include an id_token.");
  }

  return (payload as { id_token: string }).id_token;
}

// --- ID token validation (CONTRACT-001 §3.4-3.5) ---------------------------

export interface ValidateIdTokenParams {
  idToken: string;
  remoteJwks: ReturnType<typeof createRemoteJWKSet>;
  expectedIssuer: string;
  expectedAudience: string;
  expectedNonce: string;
}

export interface EntraIdentityClaims {
  oid: string;
  email: string;
  preferredUsername: string;
}

/**
 * Validates Entra's ID token per CONTRACT-001 §3.4 (signature against
 * Entra's own JWKS, `iss`, `aud`, `exp`/`iat`/`nbf`, and exact `nonce`
 * match) and extracts the three identity claims per §3.5. Throws
 * `IdTokenValidationError` for any validation failure (400-class) or
 * `IdentityClaimMissingError` if a required claim is absent from an
 * otherwise-valid token (500-class, a configuration problem).
 */
export async function validateIdToken(params: ValidateIdTokenParams): Promise<EntraIdentityClaims> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(params.idToken, params.remoteJwks, {
      issuer: params.expectedIssuer,
      audience: params.expectedAudience,
    });
    payload = result.payload;
  } catch (error) {
    if (error instanceof joseErrors.JWKSTimeout || isNetworkLevelError(error)) {
      throw new EntraUnreachableError(`Entra JWKS fetch failed while validating the ID token: ${errorMessage(error)}`);
    }
    throw new IdTokenValidationError(`ID token validation failed: ${errorMessage(error)}`);
  }

  if (typeof payload.iat !== "number") {
    throw new IdTokenValidationError("ID token is missing a valid iat claim.");
  }

  if (typeof payload.nonce !== "string" || payload.nonce !== params.expectedNonce) {
    // Logged as a distinct event from ordinary expiry per CONTRACT-001 §3's
    // closing paragraph: nonce mismatch is a stronger tampering/replay
    // signal than a stale `state`, even though the user-facing message is
    // deliberately the same generic text as other validation failures.
    console.error("nonce_mismatch: ID token nonce did not match the handshake's stored nonce.");
    throw new IdTokenValidationError("ID token nonce did not match the handshake's stored nonce.");
  }

  const oid = payload.oid;
  const email = payload.email;
  const preferredUsername = payload.preferred_username;
  if (typeof oid !== "string" || oid === "") {
    throw new IdentityClaimMissingError("ID token is missing the oid claim.");
  }
  if (typeof email !== "string" || email === "") {
    throw new IdentityClaimMissingError("ID token is missing the email claim.");
  }
  if (typeof preferredUsername !== "string" || preferredUsername === "") {
    throw new IdentityClaimMissingError("ID token is missing the preferred_username claim.");
  }

  return { oid, email, preferredUsername };
}
