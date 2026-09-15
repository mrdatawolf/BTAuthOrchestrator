// TASK-010: standalone, re-runnable proof that a BTAuthOrchestrator session
// token can be verified completely offline using only the public key
// material published at /.well-known/jwks.json, and that a token signed
// under a since-rotated-out key correctly fails that same offline
// verification once CONTRACT-003's emergency rotation has run.
//
// This is deliberately not wired into any consuming app (out of scope per
// TASK-010's Excluded section) - it is a durable operational proof artifact,
// run via `npm run verify-offline` (see scripts/verify-offline.js).
//
// Design note (see the task's Implementation handoff "Assumptions and
// deviations" for the full rationale): CONTRACT-002 enforces a strict
// single-process lock on PGLITE_DATA_DIR, so this script cannot read the
// current signing key directly from the database while a separately
// launched instance of the service already holds that lock. To remain a
// single, self-contained, one-command proof - rather than requiring the
// operator to manually stop/start the service around this script - this
// script itself launches the real compiled service (dist/index.js) as a
// child process against the same real .env, but only *after* it has
// already read the current signing key and released the lock. All JWKS
// fetches and the rotation trigger are then real HTTP calls to that real
// running child process. If this sandbox does not permit live socket
// binding, it falls back to invoking the exported request handler function
// directly (no child process, no real sockets), exactly as TASK-008/012's
// validation did, and says so plainly in the output.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createProbeServer } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

import { loadConfig, type Config } from "./config.js";
import { openDatabase, prepareDataDirectory } from "./database.js";
import { createLocalUserStore } from "./localUsers.js";
import { createSecretsStore } from "./secrets.js";
import { createRequestHandler } from "./index.js";
import { mintSessionToken, type TokenSigningKey } from "./tokens.js";

const VERIFY_CLAIMS = {
  sub: "verify-offline-proof-subject",
  email: "verify-offline-proof@example.invalid",
  upn: "verify-offline-proof@example.invalid",
};
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 250;
const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

interface JwksResponseBody {
  keys: Array<{ kty: string; use: string; alg: string; kid: string; n: string; e: string }>;
}

interface AcceptanceResult {
  id: "AC1" | "AC2" | "AC3";
  description: string;
  passed: boolean;
  detail: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// Verifies a token completely offline against an already-fetched JWKS
// document: builds a jose "local" JWK set (no network I/O of its own) and
// instruments the global fetch during the call so the proof is empirical,
// not merely a claim based on which jose helper was chosen.
async function verifyOffline(
  token: string,
  jwks: JwksResponseBody,
  issuer: string,
): Promise<{ verified: boolean; error?: string; networkCallsDuringVerify: number }> {
  const keySet = createLocalJWKSet(jwks as unknown as JSONWebKeySet);
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    networkCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    await jwtVerify(token, keySet, { issuer, algorithms: ["RS256"] });
    return { verified: true, networkCallsDuringVerify: networkCalls };
  } catch (error) {
    return { verified: false, error: errorMessage(error), networkCallsDuringVerify: networkCalls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function canBindLoopbackSocket(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createProbeServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

async function readCurrentSigningKey(config: Config): Promise<TokenSigningKey> {
  await prepareDataDirectory(config.pgliteDataDir);
  const handle = await openDatabase(config.pgliteDataDir);
  try {
    const store = createSecretsStore(handle.database, config.dbEncryptionKey);
    const currentKey = await store.getCurrentSigningKey();
    return { kid: currentKey.kid, algorithm: currentKey.algorithm, privateKeyPem: currentKey.privateKeyPem };
  } finally {
    // Release the single-process lock immediately: this read is the only
    // direct database access this script performs, and it must complete
    // (and fully release the lock) before the real service process below
    // is started against the same PGLITE_DATA_DIR.
    await handle.close();
  }
}

async function waitForHealthy(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The spawned service process exited early (code ${child.exitCode}) before becoming healthy. ` +
          "See its stdout/stderr above.",
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(HEALTH_CHECK_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms waiting for the spawned service to become healthy.`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(CHILD_SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

// --- Fallback-mode HTTP simulation helpers (no real sockets) ---

function createFakeRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): IncomingMessage {
  const stream = Readable.from(body !== undefined ? [body] : []);
  return Object.assign(stream, {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function createFakeResponse(): { response: ServerResponse; result: Promise<CapturedResponse> } {
  let resolveResult!: (value: CapturedResponse) => void;
  const result = new Promise<CapturedResponse>((resolve) => {
    resolveResult = resolve;
  });
  let status = 0;
  let headers: Record<string, string> = {};
  const response = {
    writeHead(statusCode: number, responseHeaders?: Record<string, string>) {
      status = statusCode;
      headers = responseHeaders ?? {};
    },
    end(body?: string) {
      resolveResult({ status, headers, body: body ?? "" });
    },
  };
  return { response: response as unknown as ServerResponse, result };
}

// --- Live-mode (real HTTP against a spawned real service) run ---

async function runLiveMode(config: Config): Promise<AcceptanceResult[]> {
  logSection("Mode: live HTTP against a real spawned instance of the compiled service");

  const signingKey = await readCurrentSigningKey(config);
  console.log(`Read current signing key kid=${signingKey.kid} from ${config.pgliteDataDir} (lock released).`);

  const token = await mintSessionToken(VERIFY_CLAIMS, signingKey, config.issuer, new Date());
  console.log(`Minted a session token via mintSessionToken() directly (no interactive Entra login), kid=${signingKey.kid}.`);

  const entryPointPath = join(__dirname, "index.js");
  const child = spawn(process.execPath, [entryPointPath], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  const baseUrl = `http://127.0.0.1:${config.port}`;
  try {
    await waitForHealthy(baseUrl, child);
    console.log(`Real compiled service is listening and healthy at ${baseUrl}.`);

    return await runVerificationSequence({
      config,
      signingKey,
      token,
      fetchJwks: async () => {
        const response = await fetch(`${baseUrl}/.well-known/jwks.json`);
        return (await response.json()) as JwksResponseBody;
      },
      triggerRotation: async () => {
        const response = await fetch(`${baseUrl}/admin/emergency-rotate-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.emergencyRotationToken}` },
          body: JSON.stringify({ triggeredBy: "verify-offline-proof (TASK-010)" }),
        });
        const body = (await response.json()) as { status?: string; previousKid?: string; newKid?: string; error?: string };
        return { status: response.status, body };
      },
    });
  } finally {
    await stopChild(child);
    console.log("Spawned service process stopped.");
  }
}

// --- Fallback-mode (direct handler invocation, no sockets) run ---

async function runFallbackMode(config: Config): Promise<AcceptanceResult[]> {
  logSection("Mode: in-process handler fallback (this sandbox does not permit live socket binding)");
  console.log(
    "Falling back to invoking the exported createRequestHandler() function directly, exactly as " +
      "TASK-008/012's validation did when live socket binding was unavailable. No real HTTP socket, " +
      "no real child process, is used in this mode.",
  );

  await prepareDataDirectory(config.pgliteDataDir);
  const handle = await openDatabase(config.pgliteDataDir);
  try {
    const store = createSecretsStore(handle.database, config.dbEncryptionKey);
    const currentKey = await store.getCurrentSigningKey();
    const signingKey: TokenSigningKey = {
      kid: currentKey.kid,
      algorithm: currentKey.algorithm,
      privateKeyPem: currentKey.privateKeyPem,
    };
    console.log(`Read current signing key kid=${signingKey.kid} from ${config.pgliteDataDir}.`);

    const token = await mintSessionToken(VERIFY_CLAIMS, signingKey, config.issuer, new Date());
    console.log(`Minted a session token via mintSessionToken() directly (no interactive Entra login), kid=${signingKey.kid}.`);

    const localUserStore = createLocalUserStore(handle.database);
    const handler = createRequestHandler(store, config, localUserStore);

    const fetchJwks = async (): Promise<JwksResponseBody> => {
      const request = createFakeRequest("GET", "/.well-known/jwks.json", {});
      const { response, result } = createFakeResponse();
      await (handler(request, response) as unknown as Promise<void>);
      const captured = await result;
      return JSON.parse(captured.body) as JwksResponseBody;
    };

    const triggerRotation = async (): Promise<{ status: number; body: { status?: string; previousKid?: string; newKid?: string; error?: string } }> => {
      const bodyBuffer = Buffer.from(JSON.stringify({ triggeredBy: "verify-offline-proof (TASK-010)" }), "utf8");
      const request = createFakeRequest(
        "POST",
        "/admin/emergency-rotate-keys",
        { authorization: `Bearer ${config.emergencyRotationToken}`, "content-type": "application/json" },
        bodyBuffer,
      );
      const { response, result } = createFakeResponse();
      await (handler(request, response) as unknown as Promise<void>);
      const captured = await result;
      return { status: captured.status, body: JSON.parse(captured.body) as { status?: string; previousKid?: string; newKid?: string; error?: string } };
    };

    return await runVerificationSequence({ config, signingKey, token, fetchJwks, triggerRotation });
  } finally {
    await handle.close();
  }
}

// --- Shared verification sequence (steps 2-4 of TASK-010's plan) ---

async function runVerificationSequence(input: {
  config: Config;
  signingKey: TokenSigningKey;
  token: string;
  fetchJwks: () => Promise<JwksResponseBody>;
  triggerRotation: () => Promise<{ status: number; body: { status?: string; previousKid?: string; newKid?: string; error?: string } }>;
}): Promise<AcceptanceResult[]> {
  const { config, signingKey, token, fetchJwks, triggerRotation } = input;
  const results: AcceptanceResult[] = [];

  logSection("Step: one-time JWKS fetch (pre-rotation)");
  const jwksBefore = await fetchJwks();
  console.log(`Fetched JWKS: ${jwksBefore.keys.length} key(s), kids=[${jwksBefore.keys.map((k) => k.kid).join(", ")}].`);

  logSection("Step: offline verification of the freshly minted token");
  const beforeResult = await verifyOffline(token, jwksBefore, config.issuer);
  const ac1Passed = beforeResult.verified;
  results.push({
    id: "AC1",
    description: "A freshly minted token verifies successfully offline using only the public key.",
    passed: ac1Passed,
    detail: ac1Passed
      ? `jwtVerify succeeded against the fetched JWKS (kid=${signingKey.kid}).`
      : `jwtVerify unexpectedly failed: ${beforeResult.error}`,
  });
  console.log(`[AC1] ${ac1Passed ? "PASS" : "FAIL"} - ${results[results.length - 1]!.detail}`);

  const ac2Passed = beforeResult.networkCallsDuringVerify === 0;
  results.push({
    id: "AC2",
    description: "No call to BTAuthOrchestrator occurs during verification itself, only the one-time key fetch.",
    passed: ac2Passed,
    detail: `Instrumented global fetch recorded ${beforeResult.networkCallsDuringVerify} call(s) during the jwtVerify() call itself (only the JWKS fetch above happened outside this window).`,
  });
  console.log(`[AC2] ${ac2Passed ? "PASS" : "FAIL"} - ${results[results.length - 1]!.detail}`);

  logSection("Step: trigger CONTRACT-003 emergency key rotation");
  const rotation = await triggerRotation();
  if (rotation.status !== 200 || rotation.body.status !== "rotated") {
    throw new Error(
      `Emergency rotation did not succeed as expected (status=${rotation.status}, body=${JSON.stringify(rotation.body)}). ` +
        "Cannot demonstrate AC3 without a real rotation.",
    );
  }
  console.log(`Rotated: previousKid=${rotation.body.previousKid} newKid=${rotation.body.newKid}.`);
  if (rotation.body.previousKid !== signingKey.kid) {
    console.log(
      `Note: rotation's previousKid (${rotation.body.previousKid}) did not match the minting kid (${signingKey.kid}). ` +
        "This can happen if another rotation occurred between the JWKS fetch and this trigger; the verification " +
        "below still proves the minting kid is absent from the fresh JWKS regardless.",
    );
  }

  logSection("Step: re-fetch JWKS (post-rotation) and confirm the rotated-out kid is absent");
  const jwksAfter = await fetchJwks();
  const rotatedOutKidStillPresent = jwksAfter.keys.some((key) => key.kid === signingKey.kid);
  console.log(
    `Fetched JWKS: ${jwksAfter.keys.length} key(s), kids=[${jwksAfter.keys.map((k) => k.kid).join(", ")}]. ` +
      `Rotated-out kid (${signingKey.kid}) present: ${rotatedOutKidStillPresent}.`,
  );

  logSection("Step: offline verification of the same token after rotation (expected to fail)");
  const afterResult = await verifyOffline(token, jwksAfter, config.issuer);
  const ac3Passed = !afterResult.verified && !rotatedOutKidStillPresent;
  results.push({
    id: "AC3",
    description: "A token signed under a since-rotated-out key fails verification.",
    passed: ac3Passed,
    detail: ac3Passed
      ? `jwtVerify correctly threw against the fresh JWKS (rotated-out kid absent): ${afterResult.error}`
      : `Expected verification failure did not occur as expected ` +
        `(verified=${afterResult.verified}, rotatedOutKidStillPresent=${rotatedOutKidStillPresent}, error=${afterResult.error ?? "none"}).`,
  });
  console.log(`[AC3] ${ac3Passed ? "PASS" : "FAIL"} - ${results[results.length - 1]!.detail}`);

  return results;
}

export async function main(): Promise<void> {
  const config = loadConfig(process.env);

  logSection("BTAuthOrchestrator offline verification proof (TASK-010)");
  console.log(`Issuer: ${config.issuer}`);
  console.log(`Data directory: ${config.pgliteDataDir}`);

  const canBindSocket = await canBindLoopbackSocket();
  const results = canBindSocket ? await runLiveMode(config) : await runFallbackMode(config);

  logSection("Summary");
  for (const result of results) {
    console.log(`${result.id}: ${result.passed ? "PASS" : "FAIL"} - ${result.description}`);
  }
  const allPassed = results.every((result) => result.passed);
  console.log(`Overall: ${allPassed ? "PASS" : "FAIL"}`);

  process.exitCode = allPassed ? 0 : 1;
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
