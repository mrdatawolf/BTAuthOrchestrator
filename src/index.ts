import { generateKeyPair, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { promisify } from "node:util";

import { exportJWK, importSPKI } from "jose";

import { loadConfig, type Config } from "./config.js";
import { openDatabase, prepareDataDirectory, type DatabaseHandle } from "./database.js";
import {
  computeCodeChallenge,
  createHandshakeStore,
  EntraDiscoveryCache,
  EntraUnreachableError,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateOpaqueToken,
  IdentityClaimMissingError,
  IdTokenValidationError,
  TokenExchangeError,
  validateIdToken,
  type EntraDiscoveryDocument,
} from "./oidc.js";
import { createSecretsStore, type SecretsStore } from "./secrets.js";
import { mintSessionToken, nextLocalMidnightEpochSeconds } from "./tokens.js";

const generateKeyPairAsync = promisify(generateKeyPair);

const SESSION_COOKIE_NAME = "bt_session";
// Fixed by CONTRACT-001 §7 ("the parent domain shared by all consuming
// apps"); not operator-configurable in this milestone.
const SESSION_COOKIE_DOMAIN = ".biztechro.com";

const ENTRA_UNREACHABLE_MESSAGE =
  "Unable to reach the organization's sign-in service right now. Try again in a few minutes.";
const SIGN_IN_CANCELLED_MESSAGE = "Sign-in was cancelled or denied.";
const SIGN_IN_EXPIRED_MESSAGE = "Your sign-in attempt has expired or is no longer valid. Please start again.";
const SIGN_IN_INCOMPLETE_MESSAGE = "Your sign-in attempt could not be completed. Please start again.";
const GENERIC_SERVER_ERROR_MESSAGE = "Something went wrong signing you in; this has been logged.";

// CONTRACT-003: a generous but bounded cap on the optional JSON request body
// (`{ "triggeredBy"?: string }`) for the emergency-rotation trigger, to avoid
// buffering an unbounded request body in memory before authentication is even
// checked. Not specified by the contract; a narrow implementation judgment
// call, flagged in the handoff.
const EMERGENCY_ROTATION_BODY_LIMIT_BYTES = 16_384;
const EMERGENCY_ROTATION_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractBearerToken(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue !== "string") return null;
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return null;
  const token = headerValue.slice(prefix.length);
  return token.length > 0 ? token : null;
}

// Constant-time comparison per CONTRACT-003 §2: unequal lengths are an
// immediate mismatch without a data-dependent comparison of contents; equal
// lengths are compared via crypto.timingSafeEqual, never `===`.
function constantTimeTokenMatches(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bufferChunk: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bufferChunk.length;
    if (size > EMERGENCY_ROTATION_BODY_LIMIT_BYTES) {
      throw new Error("Request body exceeds the maximum accepted size.");
    }
    chunks.push(bufferChunk);
  }
  return Buffer.concat(chunks);
}

// CONTRACT-003 Failure behavior: a missing/empty/non-string `triggeredBy` (or
// an unparseable body) is stored as null and never treated as a failure —
// this field is a convenience label only, never part of the authorization
// decision.
function extractTriggeredBy(bodyText: string): string | null {
  if (bodyText.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "triggeredBy" in parsed &&
      typeof (parsed as { triggeredBy?: unknown }).triggeredBy === "string" &&
      (parsed as { triggeredBy: string }).triggeredBy !== ""
    ) {
      return (parsed as { triggeredBy: string }).triggeredBy;
    }
    return null;
  } catch {
    return null;
  }
}

// CONTRACT-003 Interfaces: best-effort proxy-forwarded client address (first
// X-Forwarded-For entry) when reachable via the configured reverse proxy,
// otherwise the raw socket peer address. Audit metadata only.
function extractSourceIp(request: IncomingMessage): string | null {
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof forwardedValue === "string" && forwardedValue.trim() !== "") {
    return forwardedValue.split(",")[0]!.trim();
  }
  return request.socket.remoteAddress ?? null;
}

function renderHtml(status: number, title: string, message: string): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><html><head><title>${title}</title></head><body><p>${message}</p></body></html>`,
  };
}

function buildSetCookieHeader(token: string, iat: number, exp: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Domain=${SESSION_COOKIE_DOMAIN}`,
    "Path=/",
    `Expires=${new Date(exp * 1000).toUTCString()}`,
    `Max-Age=${exp - iat}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function createRequestHandler(secretsStore: SecretsStore, config: Config): RequestListener {
  const handshakeStore = createHandshakeStore();
  const discoveryCache = new EntraDiscoveryCache();

  async function handleLogin(): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    let discovery: EntraDiscoveryDocument;
    try {
      discovery = await discoveryCache.getDiscoveryDocument(config.tenantId);
    } catch (error) {
      console.error(`Entra discovery fetch failed during login initiation: ${errorMessage(error)}`);
      return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
    }

    const state = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);
    handshakeStore.create(state, nonce, codeVerifier);

    const redirectUri = `${config.issuer}/auth/callback`;
    const authorizeUrl = new URL(discovery.authorization_endpoint);
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "openid profile email");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("nonce", nonce);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    return { status: 302, headers: { Location: authorizeUrl.toString() }, body: "" };
  }

  async function handleCallback(
    url: URL,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const params = url.searchParams;

    const errorParam = params.get("error");
    if (errorParam !== null) {
      const description = params.get("error_description");
      console.error(
        `Entra returned an authorization error at the callback: ${errorParam}${description !== null ? ` (${description})` : ""}`,
      );
      return renderHtml(400, "Sign-in cancelled", SIGN_IN_CANCELLED_MESSAGE);
    }

    const state = params.get("state");
    const entry = state !== null ? handshakeStore.consume(state) : undefined;
    if (entry === undefined) {
      return renderHtml(400, "Sign-in expired", SIGN_IN_EXPIRED_MESSAGE);
    }

    const code = params.get("code");
    if (code === null || code === "") {
      return renderHtml(400, "Sign-in incomplete", SIGN_IN_INCOMPLETE_MESSAGE);
    }

    let discovery: EntraDiscoveryDocument;
    try {
      discovery = await discoveryCache.getDiscoveryDocument(config.tenantId);
    } catch (error) {
      console.error(`Entra discovery fetch failed during callback handling: ${errorMessage(error)}`);
      return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
    }

    let clientSecret: string;
    try {
      clientSecret = await secretsStore.getSecret("CLIENT_SECRET");
    } catch (error) {
      console.error(`Unable to load CLIENT_SECRET: ${errorMessage(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }

    const redirectUri = `${config.issuer}/auth/callback`;

    let idToken: string;
    try {
      idToken = await exchangeAuthorizationCode({
        tokenEndpoint: discovery.token_endpoint,
        clientId: config.clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier: entry.codeVerifier,
      });
    } catch (error) {
      if (error instanceof EntraUnreachableError) {
        console.error(`Entra token exchange unreachable: ${errorMessage(error)}`);
        return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
      }
      if (error instanceof TokenExchangeError) {
        console.error(`Entra token exchange rejected the request: ${errorMessage(error)}`);
        return renderHtml(400, "Sign-in incomplete", SIGN_IN_INCOMPLETE_MESSAGE);
      }
      console.error(`Unexpected token exchange failure: ${errorMessage(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }

    let claims: { oid: string; email: string; preferredUsername: string };
    try {
      const remoteJwks = discoveryCache.getRemoteJwks(discovery.jwks_uri);
      claims = await validateIdToken({
        idToken,
        remoteJwks,
        expectedIssuer: discovery.issuer,
        expectedAudience: config.clientId,
        expectedNonce: entry.nonce,
      });
    } catch (error) {
      if (error instanceof EntraUnreachableError) {
        console.error(`Entra JWKS fetch failed during ID token validation: ${errorMessage(error)}`);
        return renderHtml(502, "Sign-in unavailable", ENTRA_UNREACHABLE_MESSAGE);
      }
      if (error instanceof IdentityClaimMissingError) {
        console.error(`Entra ID token was missing a required identity claim: ${errorMessage(error)}`);
        return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
      }
      if (error instanceof IdTokenValidationError) {
        console.error(`ID token validation failed: ${errorMessage(error)}`);
        return renderHtml(400, "Sign-in incomplete", SIGN_IN_INCOMPLETE_MESSAGE);
      }
      console.error(`Unexpected ID token validation failure: ${errorMessage(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }

    try {
      const signingKey = await secretsStore.getCurrentSigningKey();
      const now = new Date();
      const token = await mintSessionToken(
        { sub: claims.oid, email: claims.email, upn: claims.preferredUsername },
        signingKey,
        config.issuer,
        now,
      );
      const iat = Math.floor(now.getTime() / 1_000);
      const exp = nextLocalMidnightEpochSeconds(now);
      const cookieSecure = config.cookieSecure.trim().toLowerCase() === "true";
      return {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": buildSetCookieHeader(token, iat, exp, cookieSecure),
        },
        body: "<!doctype html><html><head><title>Signed in</title></head><body><p>You're signed in. You may close this window.</p></body></html>",
      };
    } catch (error) {
      console.error(`Session token minting failed: ${errorMessage(error)}`);
      return renderHtml(500, "Sign-in error", GENERIC_SERVER_ERROR_MESSAGE);
    }
  }

  async function writeEmergencyRotationFailureAudit(input: {
    triggeredBy: string | null;
    sourceIp: string | null;
    failureReason: string;
  }): Promise<void> {
    try {
      await secretsStore.recordEmergencyRotationFailure(input);
    } catch (error) {
      // CONTRACT-003 Failure behavior: never block the caller's response on
      // this write; fall back to a server-side log-line backstop naming only
      // a timestamp and failure category — never the credential value or any
      // secret material.
      console.error(
        `Emergency rotation audit write failed; log-line backstop: timestamp=${new Date().toISOString()} failureReason=${input.failureReason}: ${errorMessage(error)}`,
      );
    }
  }

  async function handleEmergencyRotateKeys(
    request: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const sourceIp = extractSourceIp(request);

    let bodyText = "";
    try {
      bodyText = (await readRequestBody(request)).toString("utf8");
    } catch (error) {
      // An oversized/unreadable body is not an authorization decision; it
      // just means triggeredBy is unavailable for this attempt.
      console.error(`Emergency rotation request body could not be read: ${errorMessage(error)}`);
    }
    const triggeredBy = extractTriggeredBy(bodyText);

    const token = extractBearerToken(request.headers.authorization);
    if (token === null || !constantTimeTokenMatches(token, config.emergencyRotationToken)) {
      await writeEmergencyRotationFailureAudit({ triggeredBy, sourceIp, failureReason: "bad_credential" });
      return {
        status: 401,
        headers: EMERGENCY_ROTATION_RESPONSE_HEADERS,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    try {
      const kid = randomUUID();
      const { publicKey, privateKey } = await generateKeyPairAsync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const result = await secretsStore.rotateSigningKeyEmergency(
        { kid, algorithm: "RS256", publicKeyPem: publicKey, privateKeyPem: privateKey },
        { triggeredBy, sourceIp },
      );
      const rotatedAt = new Date();
      return {
        status: 200,
        headers: EMERGENCY_ROTATION_RESPONSE_HEADERS,
        body: JSON.stringify({
          status: "rotated",
          previousKid: result.previousKid,
          newKid: result.newKid,
          rotatedAt: rotatedAt.toISOString(),
        }),
      };
    } catch (error) {
      console.error(`Emergency key rotation failed: ${errorMessage(error)}`);
      await writeEmergencyRotationFailureAudit({ triggeredBy, sourceIp, failureReason: "rotation_error" });
      return {
        status: 500,
        headers: EMERGENCY_ROTATION_RESPONSE_HEADERS,
        body: JSON.stringify({ error: "Unable to complete emergency rotation" }),
      };
    }
  }

  return async (request, response) => {
    if (request.method === "GET" && request.url === "/auth/login") {
      const result = await handleLogin();
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    if (request.method === "GET" && (request.url ?? "").split("?")[0] === "/auth/callback") {
      const url = new URL(request.url ?? "/auth/callback", "http://localhost");
      const result = await handleCallback(url);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
      try {
        const signingKeys = await secretsStore.listPublishableSigningKeys();
        const keys = await Promise.all(signingKeys.map(async (signingKey) => {
          if (signingKey.algorithm !== "RS256") {
            throw new Error(`Unsupported signing algorithm for key ${signingKey.kid}.`);
          }
          const publicKey = await importSPKI(signingKey.publicKeyPem, "RS256");
          const jwk = await exportJWK(publicKey);
          if (jwk.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) {
            throw new Error(`Signing key ${signingKey.kid} is not a valid RSA public key.`);
          }
          return {
            kty: "RSA" as const,
            use: "sig" as const,
            alg: "RS256" as const,
            kid: signingKey.kid,
            n: jwk.n,
            e: jwk.e,
          };
        }));
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ keys }));
      } catch {
        response.writeHead(500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ error: "Unable to publish signing keys" }));
      }
      return;
    }

    if (request.method === "POST" && (request.url ?? "").split("?")[0] === "/admin/emergency-rotate-keys") {
      const result = await handleEmergencyRotateKeys(request);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  };
}

async function start(): Promise<void> {
  let databaseHandle: DatabaseHandle | undefined;
  try {
    const config = loadConfig(process.env);
    await prepareDataDirectory(config.pgliteDataDir);
    databaseHandle = await openDatabase(config.pgliteDataDir);
    const secretsStore = createSecretsStore(databaseHandle.database, config.dbEncryptionKey);
    const server = createServer(createRequestHandler(secretsStore, config));

    server.listen(config.port, () => {
      console.log(`BTAuthOrchestrator listening on port ${config.port}`);
    });

    server.on("error", (error) => {
      console.error(`Startup error: ${error.message}`);
      process.exitCode = 1;
    });

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await databaseHandle?.close();
    };
    const shutdownFromSignal = async (): Promise<void> => {
      try {
        await shutdown();
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Shutdown error: ${message}`);
        process.exit(1);
      }
    };
    process.once("SIGINT", () => void shutdownFromSignal());
    process.once("SIGTERM", () => void shutdownFromSignal());
  } catch (error) {
    await databaseHandle?.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void start();
}
