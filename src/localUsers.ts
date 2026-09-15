import { randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

// CONTRACT-005 §1/§9: local_users/local_login_audit live in the same PGlite
// database as CONTRACT-004's tables but are deliberately outside
// SecretsStore's module boundary (see src/password.ts's header comment and
// CONTRACT-005 Interfaces > "Interface to CONTRACT-004"). This module owns
// that boundary for the local-login path only — the admin CRUD API
// (TASK-016) will extend or sit alongside this module, not duplicate it.

export interface LocalUserRow {
  id: string;
  username: string;
  email: string;
  passwordHash: Buffer;
  passwordSalt: Buffer;
  passwordAlgorithm: string;
  passwordCostN: number;
  passwordBlockSizeR: number;
  passwordParallelizationP: number;
  passwordKeyLength: number;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

export type LocalLoginFailureReason = "unknown_username" | "bad_password" | "disabled" | "locked";

export interface LocalLoginAuditInput {
  username: string;
  result: "success" | "failure";
  failureReason: LocalLoginFailureReason | null;
  sourceIp: string | null;
}

export interface LocalUserStore {
  findByUsername(normalizedUsername: string): Promise<LocalUserRow | undefined>;
  // CONTRACT-005 §2 step 4 (success) / Postconditions: resets lockout state.
  recordSuccessfulLogin(userId: string): Promise<void>;
  // CONTRACT-005 §2 step 4 (bad_password) / §3: increments
  // failed_login_attempts; if the new count reaches maxFailedAttempts, sets
  // locked_until = now() + lockoutMinutes in the same statement/transaction
  // so the row can never observably sit at-threshold-but-unlocked.
  recordFailedPassword(userId: string, maxFailedAttempts: number, lockoutMinutes: number): Promise<void>;
  // CONTRACT-005 §6: best-effort caller's responsibility to catch failures;
  // this function does not swallow errors itself so the caller can apply the
  // log-line backstop (src/index.ts).
  writeLoginAudit(input: LocalLoginAuditInput): Promise<void>;
}

interface LocalUserDbRow {
  id: string;
  username: string;
  email: string;
  password_hash: Uint8Array;
  password_salt: Uint8Array;
  password_algorithm: string;
  password_cost_n: number;
  password_block_size_r: number;
  password_parallelization_p: number;
  password_key_length: number;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: string | null;
}

export function createLocalUserStore(database: PGlite): LocalUserStore {
  async function findByUsername(normalizedUsername: string): Promise<LocalUserRow | undefined> {
    const result = await database.query<LocalUserDbRow>(
      `SELECT id, username, email, password_hash, password_salt, password_algorithm,
              password_cost_n, password_block_size_r, password_parallelization_p,
              password_key_length, is_active, failed_login_attempts, locked_until
       FROM local_users
       WHERE username = $1`,
      [normalizedUsername],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      passwordHash: Buffer.from(row.password_hash),
      passwordSalt: Buffer.from(row.password_salt),
      passwordAlgorithm: row.password_algorithm,
      passwordCostN: row.password_cost_n,
      passwordBlockSizeR: row.password_block_size_r,
      passwordParallelizationP: row.password_parallelization_p,
      passwordKeyLength: row.password_key_length,
      isActive: row.is_active,
      failedLoginAttempts: row.failed_login_attempts,
      lockedUntil: row.locked_until !== null ? new Date(row.locked_until) : null,
    };
  }

  async function recordSuccessfulLogin(userId: string): Promise<void> {
    await database.query(
      `UPDATE local_users
       SET failed_login_attempts = 0, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [userId],
    );
  }

  async function recordFailedPassword(
    userId: string,
    maxFailedAttempts: number,
    lockoutMinutes: number,
  ): Promise<void> {
    await database.transaction(async (transaction) => {
      const updated = await transaction.query<{ failed_login_attempts: number }>(
        `UPDATE local_users
         SET failed_login_attempts = failed_login_attempts + 1, updated_at = now()
         WHERE id = $1
         RETURNING failed_login_attempts`,
        [userId],
      );
      const attempts = updated.rows[0]?.failed_login_attempts;
      if (attempts !== undefined && attempts >= maxFailedAttempts) {
        await transaction.query(
          `UPDATE local_users
           SET locked_until = now() + ($1 || ' minutes')::interval
           WHERE id = $2`,
          [String(lockoutMinutes), userId],
        );
      }
    });
  }

  async function writeLoginAudit(input: LocalLoginAuditInput): Promise<void> {
    await database.query(
      `INSERT INTO local_login_audit (id, username, result, failure_reason, source_ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), input.username, input.result, input.failureReason, input.sourceIp],
    );
  }

  return { findByUsername, recordSuccessfulLogin, recordFailedPassword, writeLoginAudit };
}
