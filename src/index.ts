import { createServer, type RequestListener } from "node:http";

import { exportJWK, importSPKI } from "jose";

import { loadConfig } from "./config.js";
import { openDatabase, prepareDataDirectory, type DatabaseHandle } from "./database.js";
import { createSecretsStore, type SecretsStore } from "./secrets.js";

export function createRequestHandler(secretsStore: SecretsStore): RequestListener {
  return async (request, response) => {
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
    const server = createServer(createRequestHandler(secretsStore));

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
