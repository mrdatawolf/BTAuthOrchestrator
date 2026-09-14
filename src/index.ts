import { createServer, type RequestListener } from "node:http";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
