import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// CONTRACT-005 §1: scrypt (Node's built-in crypto.scrypt), not bcrypt or
// argon2id — see the contract for the full tradeoff/rationale. This module
// is deliberately separate from src/secrets.ts's SecretsStore: password
// hashes are one-way and never decrypted, so they do not use CONTRACT-004's
// AES-GCM envelope-encryption machinery (see CONTRACT-005 Interfaces >
// "Interface to CONTRACT-004" and "Resolved decisions" #1). Implementer's
// module-placement call, documented per TASK-015's plan step 2.

// Node's crypto.scrypt has two overloaded signatures (with and without an
// options object); node:util's promisify resolves to the without-options
// overload's type, so it cannot be called with the required `maxmem`/N/r/p
// options object below. This wraps the options-accepting overload directly
// in a Promise instead of relying on promisify's overload resolution.
function scryptWithOptions(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** CONTRACT-005 §1 parameters, current defaults for newly created passwords. */
export const DEFAULT_SCRYPT_N = 131_072; // 2^17
export const DEFAULT_SCRYPT_R = 8;
export const DEFAULT_SCRYPT_P = 1;
export const DEFAULT_SCRYPT_KEY_LENGTH = 64;

/**
 * CONTRACT-005 §1's "Implementation note (interoperability requirement, not
 * an implementation suggestion)": Node's crypto.scrypt default maxmem is
 * 32 MiB; the chosen N/r/p require ~128 MiB. This value (256 MiB) must be
 * passed on every scrypt invocation this feature performs, both hashing and
 * verification, or every call throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
 */
export const SCRYPT_MAXMEM_BYTES = 268_435_456; // 256 MiB

const SALT_LENGTH_BYTES = 16;

export const SUPPORTED_PASSWORD_ALGORITHM = "scrypt";

export interface ScryptParameters {
  costN: number;
  blockSizeR: number;
  parallelizationP: number;
  keyLength: number;
}

export interface StoredPasswordHash extends ScryptParameters {
  hash: Buffer;
  salt: Buffer;
  algorithm: string;
}

async function deriveScryptKey(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return scryptWithOptions(password, salt, parameters.keyLength, {
    N: parameters.costN,
    r: parameters.blockSizeR,
    p: parameters.parallelizationP,
    maxmem: SCRYPT_MAXMEM_BYTES,
  });
}

/**
 * Hashes a freshly supplied password using the current default parameters
 * and a fresh 16-byte salt (crypto.randomBytes(16), never reused). Used by
 * the future admin-create/update-password path and scripts/seed.js
 * (TASK-016/TASK-017 — out of this task's scope to call, but this function
 * is the shared code path both will use, per CONTRACT-005 §5).
 */
export async function hashPassword(password: string): Promise<StoredPasswordHash> {
  const salt = randomBytes(SALT_LENGTH_BYTES);
  const parameters: ScryptParameters = {
    costN: DEFAULT_SCRYPT_N,
    blockSizeR: DEFAULT_SCRYPT_R,
    parallelizationP: DEFAULT_SCRYPT_P,
    keyLength: DEFAULT_SCRYPT_KEY_LENGTH,
  };
  const hash = await deriveScryptKey(password, salt, parameters);
  return { hash, salt, algorithm: SUPPORTED_PASSWORD_ALGORITHM, ...parameters };
}

/**
 * Verifies a candidate password against a stored hash, re-deriving with the
 * row's own stored salt/parameters (CONTRACT-005 §2 step 3) and comparing
 * via crypto.timingSafeEqual — never `===` (same posture as CONTRACT-003 §2's
 * bearer-token comparison).
 */
export async function verifyPassword(
  candidatePassword: string,
  stored: StoredPasswordHash,
): Promise<boolean> {
  if (stored.algorithm !== SUPPORTED_PASSWORD_ALGORITHM) {
    // CONTRACT-005 §1: password_algorithm is application-validated against a
    // small allow-list, not DB-constrained, so a future algorithm needs no
    // schema change — but this task implements only scrypt. No code path in
    // this task's scope can create a row with any other algorithm value; if
    // one is ever encountered, fail loudly rather than silently mis-deriving
    // (caught upstream and mapped to a generic 500, never a raw error to the
    // caller — see src/index.ts).
    throw new Error(`Unsupported password_algorithm: ${stored.algorithm}`);
  }
  const candidateHash = await deriveScryptKey(candidatePassword, stored.salt, stored);
  if (candidateHash.length !== stored.hash.length) return false;
  return timingSafeEqual(candidateHash, stored.hash);
}

// CONTRACT-005 §2 step 3: fixed, non-secret, hardcoded dummy salt/password,
// never derived from the request, used only so an unknown-username lookup
// performs a scrypt derivation of the same cost as a real password check —
// closing the timing side channel between "unknown username" and "known
// username, wrong password". The exact value is not prescribed by the
// contract beyond "fixed and deterministic".
const DUMMY_SALT: Buffer = Buffer.from("bt-auth-orchestrator-local-login-dummy-salt", "utf8").subarray(
  0,
  SALT_LENGTH_BYTES,
);
const DUMMY_PASSWORD = "bt-auth-orchestrator-dummy-password-for-uniform-cost-timing";

/**
 * Performs the same-cost scrypt derivation §2 step 3 requires for an
 * unknown-username outcome. The result is intentionally never compared to
 * anything meaningful — an unknown username is always a failure regardless
 * of this computation's output; only its cost matters.
 */
export async function deriveDummyHashForTimingParity(): Promise<Buffer> {
  return deriveScryptKey(DUMMY_PASSWORD, DUMMY_SALT, {
    costN: DEFAULT_SCRYPT_N,
    blockSizeR: DEFAULT_SCRYPT_R,
    parallelizationP: DEFAULT_SCRYPT_P,
    keyLength: DEFAULT_SCRYPT_KEY_LENGTH,
  });
}
