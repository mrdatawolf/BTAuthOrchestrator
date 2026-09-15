import { generateKeyPair, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";

import { loadConfig } from "./config.js";
import { openDatabase, prepareDataDirectory, type DatabaseHandle } from "./database.js";
import { createLocalUserStore } from "./localUsers.js";
import { hashPassword } from "./password.js";
import { createSecretsStore } from "./secrets.js";

const generateKeyPairAsync = promisify(generateKeyPair);

interface SeedStateRow {
  has_client_secret: boolean;
  has_current_key: boolean;
  has_local_user: boolean;
}

// CONTRACT-005 §5/Required behavior: the first local user is bootstrapped
// with these exact format rules — deliberately the same rules
// POST /admin/users applies (CONTRACT-005 "Resolved decisions" #4), but
// re-declared here rather than imported from src/index.ts. src/index.ts owns
// the admin API (TASK-016's scope, explicitly not to be touched by this
// task) and its validators are not exported; duplicating these three small,
// stable format rules keeps this seed-script change from creating a new
// coupling to that module. See the handoff's "Assumptions and deviations".
const LOCAL_USER_USERNAME_REGEX = /^[a-z0-9._-]{3,64}$/;
const LOCAL_USER_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_USER_EMAIL_MAX_LENGTH = 254;
const LOCAL_USER_MIN_PASSWORD_LENGTH = 12;

interface LocalUserCredentials {
  username: string;
  email: string;
  password: string;
}

function validateLocalUserUsername(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!LOCAL_USER_USERNAME_REGEX.test(normalized)) {
    throw new Error(
      "Local user username must be 3-64 characters, using only lowercase letters, digits, '.', '-', or '_' (same rule POST /admin/users applies).",
    );
  }
  return normalized;
}

function validateLocalUserEmail(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed === "" ||
    trimmed.length > LOCAL_USER_EMAIL_MAX_LENGTH ||
    !LOCAL_USER_EMAIL_REGEX.test(trimmed)
  ) {
    throw new Error("Local user email must be a valid email address.");
  }
  return trimmed;
}

function validateLocalUserPassword(raw: string): string {
  if (raw.length < LOCAL_USER_MIN_PASSWORD_LENGTH) {
    throw new Error(`Local user password must be at least ${LOCAL_USER_MIN_PASSWORD_LENGTH} characters.`);
  }
  return raw;
}

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  let databaseHandle: DatabaseHandle | undefined;
  try {
    const { clientSecretFile, localUserFile } = parseArguments(arguments_);
    const config = loadConfig(process.env);
    await prepareDataDirectory(config.pgliteDataDir);

    let clientSecretFromFile: string | undefined;
    if (clientSecretFile !== undefined) {
      clientSecretFromFile = await readAndDeleteSecretFile(clientSecretFile);
    }

    // Read (and delete) the local-user input file unconditionally, before
    // the database is even opened — same convention as CLIENT_SECRET's own
    // file handling above: the file is consumed exactly once regardless of
    // whether local_users turns out to already be seeded (checked below).
    let localUserFromFile: LocalUserCredentials | undefined;
    if (localUserFile !== undefined) {
      localUserFromFile = await readAndDeleteLocalUserFile(localUserFile);
    }

    databaseHandle = await openDatabase(config.pgliteDataDir);
    const state = await databaseHandle.database.query<SeedStateRow>(
      `SELECT
         EXISTS (SELECT 1 FROM secrets WHERE name = 'CLIENT_SECRET') AS has_client_secret,
         EXISTS (SELECT 1 FROM signing_keys WHERE status = 'current') AS has_current_key,
         EXISTS (SELECT 1 FROM local_users) AS has_local_user`,
    );
    const hasClientSecret = state.rows[0]?.has_client_secret ?? false;
    const hasCurrentKey = state.rows[0]?.has_current_key ?? false;
    const hasLocalUser = state.rows[0]?.has_local_user ?? false;

    if (hasClientSecret && hasCurrentKey && hasLocalUser) {
      console.error("Database already seeded; nothing to do.");
      process.exitCode = 1;
      return;
    }

    const store = createSecretsStore(databaseHandle.database, config.dbEncryptionKey);
    if (!hasClientSecret) {
      const clientSecret = clientSecretFromFile ?? await promptHidden("CLIENT_SECRET: ", "CLIENT_SECRET");
      await store.setSecret("CLIENT_SECRET", clientSecret);
      console.log("CLIENT_SECRET stored.");
    }

    if (!hasCurrentKey) {
      const kid = randomUUID();
      const { publicKey, privateKey } = await generateKeyPairAsync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      await store.insertSigningKey({
        kid,
        algorithm: "RS256",
        publicKeyPem: publicKey,
        privateKeyPem: privateKey,
      });
      console.log(`Signing key ${kid} generated and stored as current.`);
    }

    // CONTRACT-005 §5: extends the "what needs seeding" pattern above with
    // one more idempotent check, unconditional on LOCAL_LOGIN's value.
    if (!hasLocalUser) {
      const credentials = localUserFromFile ?? await promptLocalUserCredentials();
      const passwordHash = await hashPassword(credentials.password);
      const localUserStore = createLocalUserStore(databaseHandle.database);
      const created = await localUserStore.createUser({
        username: credentials.username,
        email: credentials.email,
        passwordHash,
        // CONTRACT-005 §5: fixed marker — no admin-API caller/actedBy is
        // involved in this bootstrap path.
        createdBy: "seed-script",
      });
      console.log(`Local user ${created.username} created.`);
    } else {
      console.log("local_users already seeded; skipping.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (databaseHandle !== undefined) {
      try {
        await databaseHandle.close();
      } catch (error) {
        console.error(`Database close error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  }
}

interface ParsedArguments {
  clientSecretFile: string | undefined;
  localUserFile: string | undefined;
}

function parseArguments(arguments_: string[]): ParsedArguments {
  let clientSecretFile: string | undefined;
  let localUserFile: string | undefined;
  for (const argument of arguments_) {
    if (argument.startsWith("--client-secret=")) {
      throw new Error("CLIENT_SECRET must not be supplied as a command-line value. Use the hidden prompt or --client-secret-file=<path>.");
    }
    if (argument.startsWith("--client-secret-file=")) {
      if (clientSecretFile !== undefined) throw new Error("--client-secret-file may only be specified once.");
      clientSecretFile = argument.slice("--client-secret-file=".length);
      if (clientSecretFile === "") throw new Error("--client-secret-file requires a path.");
      continue;
    }
    if (
      argument.startsWith("--local-user=") ||
      argument.startsWith("--local-username=") ||
      argument.startsWith("--local-email=") ||
      argument.startsWith("--local-password=")
    ) {
      throw new Error(
        "The local user's username/email/password must not be supplied as command-line values. Use the hidden prompt or --local-user-file=<path>.",
      );
    }
    if (argument.startsWith("--local-user-file=")) {
      if (localUserFile !== undefined) throw new Error("--local-user-file may only be specified once.");
      localUserFile = argument.slice("--local-user-file=".length);
      if (localUserFile === "") throw new Error("--local-user-file requires a path.");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { clientSecretFile, localUserFile };
}

async function readAndDeleteSecretFile(path: string): Promise<string> {
  const contents = await readFile(path, "utf8");
  try {
    await unlink(path);
  } catch (error) {
    throw new Error(
      `Unable to delete CLIENT_SECRET input file ${path}. Delete it manually before retrying; nothing was written to PGlite. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return contents.endsWith("\r\n") ? contents.slice(0, -2) : contents.endsWith("\n") ? contents.slice(0, -1) : contents;
}

// CONTRACT-005 §5: "a one-time, immediately-deleted input file... the
// file's exact format... is an implementation detail this contract does not
// prescribe further." Convention chosen here (also documented in
// docs/DEVELOPMENT.md): exactly three lines, in order — username, then
// email, then password. A single trailing newline is stripped (same
// convention as --client-secret-file's own trailing-newline handling); any
// other line count is an error. Mirrors --client-secret-file's exact
// read-once-then-unlink-or-abort behavior: the file is read, then unlinked
// immediately, and if the unlink fails the whole run aborts (before the
// database is even opened) with nothing written to PGlite and an
// instruction to delete the file manually.
async function readAndDeleteLocalUserFile(path: string): Promise<LocalUserCredentials> {
  const contents = await readFile(path, "utf8");
  try {
    await unlink(path);
  } catch (error) {
    throw new Error(
      `Unable to delete local user input file ${path}. Delete it manually before retrying; nothing was written to PGlite. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const lines = contents.split(/\r\n|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 3) {
    throw new Error(
      "--local-user-file must contain exactly three lines, in order: username, then email, then password.",
    );
  }
  const [usernameLine, emailLine, passwordLine] = lines as [string, string, string];
  return {
    username: validateLocalUserUsername(usernameLine),
    email: validateLocalUserEmail(emailLine),
    password: validateLocalUserPassword(passwordLine),
  };
}

// A small buffered line reader over raw-mode stdin, shared across
// successive prompt() calls within one raw-mode session (see
// promptHidden/promptLocalUserCredentials below).
//
// Why this exists rather than a simpler per-prompt 'data' listener: an
// earlier version attached a fresh 'data' listener per field and had that
// listener bail out (resolve/return) as soon as it saw the first line
// terminator in an incoming chunk. That is unsafe whenever a single
// underlying chunk contains more than one line's worth of characters — for
// example, an operator typing (or pasting) the username, email, and
// password in quick succession, faster than each prompt is printed, can
// easily result in two or three already-terminated lines arriving together
// in one chunk. Returning immediately after the first newline silently
// discarded everything after it in that same chunk, so a later field could
// end up empty (input lost) or bound to the *next* field's value entirely
// (fields shifted by one) — reproduced directly during this task's
// validation and confirmed fixed by this reader (see the handoff's
// "Validation performed").
//
// This reader instead keeps one internal string buffer fed by a single,
// persistent 'data' listener for the whole raw-mode session. Each call to
// readLine() first drains from that buffer (so any characters left over
// after a previous field's terminating newline are used immediately, in
// order, as the start of the next field) before waiting for further 'data'
// events. No character is ever discarded regardless of how many lines
// arrive in a single chunk or how fast they arrive.
class RawLineReader {
  private buffer = "";
  private ended = false;
  private waiter: (() => void) | undefined;

  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    this.wake();
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake();
  };

  constructor() {
    process.stdin.on("data", this.onData);
    process.stdin.on("end", this.onEnd);
  }

  private wake(): void {
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter();
    }
  }

  private async waitForMoreData(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  async readLine(prompt: string, fieldLabel: string, options: { echo: boolean }): Promise<string> {
    process.stdout.write(prompt);
    let value = "";
    for (;;) {
      if (this.buffer.length === 0) {
        if (this.ended) {
          throw new Error(`Interactive ${fieldLabel} input ended before a value was submitted.`);
        }
        await this.waitForMoreData();
        continue;
      }
      const character = this.buffer[0]!;
      this.buffer = this.buffer.slice(1);
      if (character === "\r" || character === "\n") {
        // Treat a "\r\n" pair as one line terminator, not two, so a
        // trailing "\n" after "\r" never leaks into the next field as a
        // spurious empty first character.
        if (character === "\r" && this.buffer[0] === "\n") {
          this.buffer = this.buffer.slice(1);
        }
        process.stdout.write("\n");
        return value;
      }
      if (character === String.fromCharCode(3)) {
        throw new Error(`${fieldLabel} input cancelled.`);
      }
      if (character === String.fromCharCode(127) || character === "\b") {
        if (value.length > 0 && options.echo) {
          process.stdout.write("\b \b");
        }
        value = value.slice(0, -1);
        continue;
      }
      value += character;
      if (options.echo) process.stdout.write(character);
    }
  }

  dispose(): void {
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onEnd);
  }
}

async function promptLocalUserCredentials(): Promise<LocalUserCredentials> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error(
      "Interactive local user input requires a TTY. Use --local-user-file=<path> for non-interactive bootstrap.",
    );
  }
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const reader = new RawLineReader();
  try {
    const username = validateLocalUserUsername(
      await reader.readLine("Local user username: ", "local user username", { echo: true }),
    );
    const email = validateLocalUserEmail(
      await reader.readLine("Local user email: ", "local user email", { echo: true }),
    );
    // CONTRACT-005 acceptance criteria: "the interactive password prompt is
    // hidden (not echoed)" — the same hidden-prompt mechanism CLIENT_SECRET
    // uses. Username/email are not sensitive and are prompted visibly so an
    // operator can see and correct typos before continuing.
    const password = validateLocalUserPassword(
      await reader.readLine("Local user password: ", "local user password", { echo: false }),
    );
    return { username, email, password };
  } finally {
    reader.dispose();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

async function promptHidden(prompt: string, fieldLabel: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error(`Interactive ${fieldLabel} input requires a TTY. Use --client-secret-file=<path> or --local-user-file=<path> for non-interactive bootstrap.`);
  }

  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const reader = new RawLineReader();
  try {
    return await reader.readLine(prompt, fieldLabel, { echo: false });
  } finally {
    reader.dispose();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

if (require.main === module) {
  void main();
}
