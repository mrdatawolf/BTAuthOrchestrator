import { generateKeyPair, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";

import { loadConfig } from "./config.js";
import { openDatabase, prepareDataDirectory, type DatabaseHandle } from "./database.js";
import { createSecretsStore } from "./secrets.js";

const generateKeyPairAsync = promisify(generateKeyPair);

interface SeedStateRow {
  has_client_secret: boolean;
  has_current_key: boolean;
}

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  let databaseHandle: DatabaseHandle | undefined;
  try {
    const clientSecretFile = parseArguments(arguments_);
    const config = loadConfig(process.env);
    await prepareDataDirectory(config.pgliteDataDir);

    let clientSecretFromFile: string | undefined;
    if (clientSecretFile !== undefined) {
      clientSecretFromFile = await readAndDeleteSecretFile(clientSecretFile);
    }

    databaseHandle = await openDatabase(config.pgliteDataDir);
    const state = await databaseHandle.database.query<SeedStateRow>(
      `SELECT
         EXISTS (SELECT 1 FROM secrets WHERE name = 'CLIENT_SECRET') AS has_client_secret,
         EXISTS (SELECT 1 FROM signing_keys WHERE status = 'current') AS has_current_key`,
    );
    const hasClientSecret = state.rows[0]?.has_client_secret ?? false;
    const hasCurrentKey = state.rows[0]?.has_current_key ?? false;

    if (hasClientSecret && hasCurrentKey) {
      console.error("Database already seeded; nothing to do.");
      process.exitCode = 1;
      return;
    }

    const store = createSecretsStore(databaseHandle.database, config.dbEncryptionKey);
    if (!hasClientSecret) {
      const clientSecret = clientSecretFromFile ?? await promptHidden("CLIENT_SECRET: ");
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

function parseArguments(arguments_: string[]): string | undefined {
  let clientSecretFile: string | undefined;
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
    throw new Error(`Unknown argument: ${argument}`);
  }
  return clientSecretFile;
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

async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error("Interactive CLIENT_SECRET input requires a TTY. Use --client-secret-file=<path> for non-interactive bootstrap.");
  }

  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
      };
      const onData = (chunk: string): void => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") {
            settled = true;
            cleanup();
            process.stdout.write("\n");
            resolve(value);
            return;
          }
          if (character === "\u0003") {
            settled = true;
            cleanup();
            reject(new Error("CLIENT_SECRET input cancelled."));
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = value.slice(0, -1);
          } else {
            value += character;
          }
        }
      };
      const onEnd = (): void => {
        if (settled) return;
        cleanup();
        reject(new Error("Interactive CLIENT_SECRET input ended before a value was submitted."));
      };
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

if (require.main === module) {
  void main();
}
