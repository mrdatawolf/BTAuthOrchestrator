import { constants } from "node:fs";
import { mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

const REQUIRED_DIRECTORY_MODE = 0o700;
const PROCESS_LOCK_FILENAME = ".btauthorchestrator.lock";

const schemaMigration = `
CREATE TABLE IF NOT EXISTS secrets (
  name text PRIMARY KEY,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signing_keys (
  kid text PRIMARY KEY,
  algorithm text NOT NULL,
  status text NOT NULL CHECK (status IN ('current', 'retired', 'revoked')),
  public_key text NOT NULL,
  private_key_ciphertext bytea NOT NULL,
  private_key_iv bytea NOT NULL,
  private_key_auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS signing_keys_one_current
  ON signing_keys ((true))
  WHERE status = 'current';
`;

export interface DatabaseHandle {
  database: PGlite;
  close(): Promise<void>;
}

export async function prepareDataDirectory(dataDirectory: string): Promise<void> {
  try {
    await mkdir(dataDirectory, { mode: REQUIRED_DIRECTORY_MODE, recursive: true });
  } catch (error) {
    throw new Error(
      `Data directory error for ${dataDirectory}: unable to create directory with mode 0700: ${errorMessage(error)}`,
    );
  }

  let directoryStat;
  try {
    directoryStat = await stat(dataDirectory);
  } catch (error) {
    throw new Error(`Data directory error for ${dataDirectory}: unable to inspect directory: ${errorMessage(error)}`);
  }

  if (!directoryStat.isDirectory()) {
    throw new Error(`Data directory error: ${dataDirectory} is not a directory.`);
  }

  const actualMode = directoryStat.mode & 0o777;
  if (actualMode !== REQUIRED_DIRECTORY_MODE) {
    throw new Error(
      `Data directory permissions error: ${dataDirectory} must have mode 0700 (found ${modeString(actualMode)}). Run: chmod 700 ${dataDirectory}`,
    );
  }

  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error(`Data directory ownership error: unable to determine the running user's uid for ${dataDirectory}.`);
  }
  if (directoryStat.uid !== currentUid) {
    throw new Error(
      `Data directory ownership error: ${dataDirectory} is owned by uid ${directoryStat.uid}, but the process runs as uid ${currentUid}. Run: chown ${currentUid} ${dataDirectory}`,
    );
  }
}

export async function openDatabase(dataDirectory: string): Promise<DatabaseHandle> {
  const lockPath = join(dataDirectory, PROCESS_LOCK_FILENAME);
  const lock = await acquireProcessLock(lockPath);
  let database: PGlite | undefined;

  try {
    database = await PGlite.create(dataDirectory);
    await database.exec(schemaMigration);
  } catch (error) {
    if (database !== undefined) {
      await database.close().catch(() => undefined);
    }
    await releaseProcessLock(lock, lockPath).catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    database,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await database.close();
      await releaseProcessLock(lock, lockPath);
    },
  };
}

async function acquireProcessLock(lockPath: string): Promise<FileHandle> {
  try {
    const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await lock.writeFile(`${process.pid}\n`);
    return lock;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new Error(
        `Single-process error: the data directory is already locked (${lockPath}). Stop the other BTAuthOrchestrator process before starting this one.`,
      );
    }
    throw new Error(`Single-process error: unable to create lock ${lockPath}: ${errorMessage(error)}`);
  }
}

async function releaseProcessLock(lock: FileHandle, lockPath: string): Promise<void> {
  await lock.close();
  await unlink(lockPath);
}

function modeString(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
