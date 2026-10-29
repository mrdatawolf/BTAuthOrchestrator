import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";

export interface ProcessLock { close(): Promise<void> }
interface Holder { id: string; socket: string; pid: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBE_TIMEOUT_MS = 1000;

function refused(path: string, reason: string): Error {
  return new Error(`Single-process error: the data directory is already locked (${path}). ${reason} Stop every instance, then remove ${basename(path)} relative to the data directory before retrying.`);
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

async function readHolder(path: string): Promise<Holder> {
  try {
    const holder = JSON.parse(await readFile(path, "utf8")) as Holder;
    if (!UUID.test(holder.id) || holder.socket !== `.bt-${holder.id}.sock` || !Number.isSafeInteger(holder.pid)) throw new Error();
    return holder;
  } catch {
    throw refused(path, "Holder identity is missing or unreadable (including legacy PID-only locks); liveness is uncertain.");
  }
}

// No application-level response is needed: a paused process still has a
// kernel listen backlog. Only ECONNREFUSED proves a previously published
// listener is dead. Missing paths, permissions and timeouts fail closed.
async function isStale(path: string, holder: Holder): Promise<boolean> {
  return new Promise((resolveProbe, reject) => {
    console.log(`Checking lock holder pid ${holder.pid}, identity ${holder.id}; liveness probe is bounded to ${PROBE_TIMEOUT_MS}ms.`);
    const socket = createConnection(join(dirname(path), holder.socket));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(refused(path, `Liveness probe exceeded ${PROBE_TIMEOUT_MS}ms; holder may be paused.`));
    }, PROBE_TIMEOUT_MS);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveProbe(false); });
    socket.once("error", error => {
      clearTimeout(timer);
      if (code(error) === "ECONNREFUSED") resolveProbe(true);
      else reject(refused(path, `Cannot determine holder liveness (${code(error) ?? "unknown error"}).`));
    });
  });
}

/** POSIX lock publication is exclusive and atomic (link of a complete record).
 * A unique listener exists BEFORE publication, eliminating the startup window
 * in which a live starter could be mistaken for a stale holder.
 *
 * Takeover holds a separate lock keyed by the old holder's UUID, then rereads
 * the parent record before unlinking it. This fences concurrent stale readers:
 * none can unlink a replacement holder. Recovery locks use this same protocol,
 * so a crash during takeover is recoverable too. Old guards are never reused
 * for a different parent identity. Recursion is bounded; pathological chains
 * fail closed with manual guidance rather than wait indefinitely.
 */
export async function acquireProcessLock(inputPath: string): Promise<ProcessLock> {
  return acquireLock(resolve(inputPath), 0);
}

async function acquireLock(path: string, depth: number): Promise<ProcessLock> {
  if (process.platform === "win32") {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(`${process.pid}\n`);
      return { async close() { await file.close(); await unlink(path); } };
    } catch (error) {
      if (code(error) === "EEXIST") {
        throw new Error(`Single-process error: the data directory is already locked (${path}). Stop the other BTAuthOrchestrator process before starting this one.`);
      }
      throw new Error(`Single-process error: unable to create lock ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const id = randomUUID();
  const socketName = `.bt-${id}.sock`;
  const socketPath = join(dirname(path), socketName);
  // 103 bytes fits sockaddr_un on supported POSIX platforms, including macOS.
  if (Buffer.byteLength(socketPath) > 103) throw refused(path, "Unix socket path exceeds 103 bytes; use a shorter data-directory path.");
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolveListen(); });
  });
  const record: Holder = { id, socket: socketName, pid: process.pid };
  const staging = join(dirname(path), `.bt-${id}.tmp`);
  const closeServer = () => new Promise<void>((res, rej) => server.close(error => error ? rej(error) : res()));
  try {
    await writeFile(staging, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    async function claim(target: string, depth: number): Promise<ProcessLock> {
      try {
        await link(staging, target);
      } catch (error) {
        if (code(error) !== "EEXIST") throw refused(target, `Cannot publish lock (${code(error)}).`);
        if (depth >= 8) throw refused(target, "Too many interrupted recovery attempts.");
        const old = await readHolder(target);
        if (!(await isStale(target, old))) throw refused(target, `Holder pid ${old.pid}, identity ${old.id}, is still running.`);
        // A distinct record for each guard is essential: reusing the same ID
        // for nested guards would alias recovery paths.
        const guardPath = join(dirname(path), `.bt-recover-${old.id}`);
        const guard = await acquireLock(guardPath, depth + 1);
        try {
          const current = await readHolder(target);
          if (current.id !== old.id) throw refused(target, "Another starter replaced the stale holder.");
          await unlink(target);
          // Exclusive publication also arbitrates with fresh starters in the
          // unlink/link gap. If another wins, this contender simply refuses.
          await link(staging, target);
          await unlink(join(dirname(path), old.socket)).catch(() => undefined);
          console.log(`Recovered stale lock left by an instance that is no longer running (pid ${old.pid}, identity ${old.id}, ${basename(target)}).`);
        } finally { await guard.close(); }
      }
      return { async close() { await unlink(target); } };
    }
    const held = await claim(path, depth);
    await unlink(staging);
    return { async close() { await held.close(); await closeServer(); } };
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    await closeServer().catch(() => undefined);
    throw error;
  }
}

