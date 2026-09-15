import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

export interface EncryptedValue {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface SigningKeyInput {
  kid: string;
  algorithm: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

// Attribution/context metadata carried into an emergency-rotation audit row.
// Never used in any authorization decision (CONTRACT-003 §4).
export interface EmergencyRotationAuditContext {
  triggeredBy: string | null;
  sourceIp: string | null;
}

export interface SecretsStore {
  encryptValue(plaintext: Buffer, aad: string): EncryptedValue;
  decryptValue(input: EncryptedValue, aad: string): Buffer;
  getSecret(name: string): Promise<string>;
  setSecret(name: string, plaintext: string): Promise<void>;
  insertSigningKey(input: SigningKeyInput): Promise<void>;
  getCurrentSigningKey(): Promise<{
    kid: string;
    algorithm: string;
    publicKeyPem: string;
    privateKeyPem: string;
  }>;
  listPublishableSigningKeys(): Promise<Array<{
    kid: string;
    algorithm: string;
    publicKeyPem: string;
    status: "current" | "retired";
  }>>;
  // CONTRACT-003 §3/§7: atomically revokes the current signing key (if any),
  // inserts the freshly generated key as current, and writes a
  // result = 'success' emergency_rotation_audit row, all inside one
  // transaction, so a committed rotation and its audit row can never
  // diverge. Throws (rolling back the whole transaction — no partial
  // signing_keys row, no phantom audit row) if any step fails; the caller
  // is responsible for writing a separate result = 'failure' audit row in
  // that case (see recordEmergencyRotationFailure), since a failed
  // transaction here cannot itself carry a committed audit row.
  rotateSigningKeyEmergency(
    newKey: SigningKeyInput,
    audit: EmergencyRotationAuditContext,
  ): Promise<{ previousKid: string | null; newKid: string }>;
  // CONTRACT-003 §4/Failure behavior: records a failed trigger attempt
  // (bad credential, or a rotation attempt that failed) as its own,
  // non-transactional row — there is no rotation to couple it to
  // atomically. Best effort: the caller must catch a rejection from this
  // function and fall back to the server-side log-line backstop rather
  // than letting it fail the HTTP response.
  recordEmergencyRotationFailure(
    input: EmergencyRotationAuditContext & { failureReason: string },
  ): Promise<void>;
}

interface CurrentSigningKeyRow {
  kid: string;
  algorithm: string;
  public_key: string;
  private_key_ciphertext: Uint8Array;
  private_key_iv: Uint8Array;
  private_key_auth_tag: Uint8Array;
}

interface PublishableSigningKeyRow {
  kid: string;
  algorithm: string;
  public_key: string;
  status: "current" | "retired";
}

interface SecretRow {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
}

export function createSecretsStore(database: PGlite, dbEncryptionKeyHex: string): SecretsStore {
  if (!/^[0-9a-f]{64}$/.test(dbEncryptionKeyHex)) {
    throw new Error("DB_ENCRYPTION_KEY must be exactly 64 lowercase hexadecimal characters.");
  }
  const encryptionKey = Buffer.from(dbEncryptionKeyHex, "hex");

  function encryptValue(plaintext: Buffer, aad: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  function decryptValue(input: EncryptedValue, aad: string): Buffer {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, input.iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(input.authTag);
    return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
  }

  async function getSecret(name: string): Promise<string> {
    const result = await database.query<SecretRow>(
      `SELECT ciphertext, iv, auth_tag FROM secrets WHERE name = $1`,
      [name],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`No secret named ${name} exists.`);

    return decryptValue(
      {
        ciphertext: Buffer.from(row.ciphertext),
        iv: Buffer.from(row.iv),
        authTag: Buffer.from(row.auth_tag),
      },
      name,
    ).toString("utf8");
  }

  async function setSecret(name: string, plaintext: string): Promise<void> {
    const encrypted = encryptValue(Buffer.from(plaintext, "utf8"), name);
    await database.query(
      `INSERT INTO secrets (name, ciphertext, iv, auth_tag)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         updated_at = now()`,
      [name, encrypted.ciphertext, encrypted.iv, encrypted.authTag],
    );
  }

  async function insertSigningKey(input: SigningKeyInput): Promise<void> {
    const encryptedPrivateKey = encryptValue(Buffer.from(input.privateKeyPem, "utf8"), input.kid);
    await database.transaction(async (transaction) => {
      const current = await transaction.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM signing_keys WHERE status = 'current') AS exists",
      );
      if (current.rows[0]?.exists) {
        throw new Error("A current signing key already exists.");
      }
      await transaction.query(
        `INSERT INTO signing_keys (
           kid, algorithm, status, public_key,
           private_key_ciphertext, private_key_iv, private_key_auth_tag
         ) VALUES ($1, $2, 'current', $3, $4, $5, $6)`,
        [
          input.kid,
          input.algorithm,
          input.publicKeyPem,
          encryptedPrivateKey.ciphertext,
          encryptedPrivateKey.iv,
          encryptedPrivateKey.authTag,
        ],
      );
    });
  }

  async function getCurrentSigningKey(): Promise<{
    kid: string;
    algorithm: string;
    publicKeyPem: string;
    privateKeyPem: string;
  }> {
    const result = await database.query<CurrentSigningKeyRow>(
      `SELECT kid, algorithm, public_key, private_key_ciphertext, private_key_iv, private_key_auth_tag
       FROM signing_keys
       WHERE status = 'current'`,
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("No current signing key exists.");

    const privateKeyPem = decryptValue(
      {
        ciphertext: Buffer.from(row.private_key_ciphertext),
        iv: Buffer.from(row.private_key_iv),
        authTag: Buffer.from(row.private_key_auth_tag),
      },
      row.kid,
    ).toString("utf8");
    return { kid: row.kid, algorithm: row.algorithm, publicKeyPem: row.public_key, privateKeyPem };
  }

  async function listPublishableSigningKeys(): Promise<Array<{
    kid: string;
    algorithm: string;
    publicKeyPem: string;
    status: "current" | "retired";
  }>> {
    const result = await database.query<PublishableSigningKeyRow>(
      `SELECT kid, algorithm, public_key, status
       FROM signing_keys
       WHERE status IN ('current', 'retired')
       ORDER BY created_at, kid`,
    );
    return result.rows.map((row) => ({
      kid: row.kid,
      algorithm: row.algorithm,
      publicKeyPem: row.public_key,
      status: row.status,
    }));
  }

  async function rotateSigningKeyEmergency(
    newKey: SigningKeyInput,
    audit: EmergencyRotationAuditContext,
  ): Promise<{ previousKid: string | null; newKid: string }> {
    const encryptedPrivateKey = encryptValue(Buffer.from(newKey.privateKeyPem, "utf8"), newKey.kid);
    return database.transaction(async (transaction) => {
      const current = await transaction.query<{ kid: string }>(
        "SELECT kid FROM signing_keys WHERE status = 'current'",
      );
      const previousKid = current.rows[0]?.kid ?? null;

      if (previousKid !== null) {
        await transaction.query(
          `UPDATE signing_keys SET status = 'revoked', revoked_at = now() WHERE kid = $1`,
          [previousKid],
        );
      }

      await transaction.query(
        `INSERT INTO signing_keys (
           kid, algorithm, status, public_key,
           private_key_ciphertext, private_key_iv, private_key_auth_tag
         ) VALUES ($1, $2, 'current', $3, $4, $5, $6)`,
        [
          newKey.kid,
          newKey.algorithm,
          newKey.publicKeyPem,
          encryptedPrivateKey.ciphertext,
          encryptedPrivateKey.iv,
          encryptedPrivateKey.authTag,
        ],
      );

      await transaction.query(
        `INSERT INTO emergency_rotation_audit (
           id, result, triggered_by, source_ip, previous_kid, new_kid, failure_reason
         ) VALUES ($1, 'success', $2, $3, $4, $5, NULL)`,
        [randomUUID(), audit.triggeredBy, audit.sourceIp, previousKid, newKey.kid],
      );

      return { previousKid, newKid: newKey.kid };
    });
  }

  async function recordEmergencyRotationFailure(
    input: EmergencyRotationAuditContext & { failureReason: string },
  ): Promise<void> {
    await database.query(
      `INSERT INTO emergency_rotation_audit (
         id, result, triggered_by, source_ip, previous_kid, new_kid, failure_reason
       ) VALUES ($1, 'failure', $2, $3, NULL, NULL, $4)`,
      [randomUUID(), input.triggeredBy, input.sourceIp, input.failureReason],
    );
  }

  return {
    encryptValue,
    decryptValue,
    getSecret,
    setSecret,
    insertSigningKey,
    getCurrentSigningKey,
    listPublishableSigningKeys,
    rotateSigningKeyEmergency,
    recordEmergencyRotationFailure,
  };
}
