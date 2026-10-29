import { readFile } from "node:fs/promises";

export function isContainerMode(): boolean {
  return process.env.BT_CONTAINER_MODE === "1";
}

export function containerOwnershipFix(): string {
  return `On the TrueNAS host, run chown ${process.getuid?.()}:${process.getgid?.()} <host path mounted at /data> and chmod 700 <host path mounted at /data>. Never change ownership automatically.`;
}

// mountinfo's fifth field is the mount point, with octal escapes. A root
// filesystem containing /data is not a mount AT /data.
export function hasDataMount(mountInfo: string): boolean {
  return mountInfo.split("\n").some(line => line.split(" ")[4] === "/data");
}

export function validateContainerIdentity(dataDirectory: string, uid: number | undefined): void {
  if (uid === undefined || uid === 0) throw new Error("Container must run as a non-root UID (default 568:568).");
  if (dataDirectory !== "/data") throw new Error("PGLITE_DATA_DIR must be /data in container mode.");
}

export async function checkContainerStorage(dataDirectory: string): Promise<void> {
  if (!isContainerMode()) return;
  validateContainerIdentity(dataDirectory, process.getuid?.());
  let mounted = false;
  try { mounted = hasDataMount(await readFile("/proc/self/mountinfo", "utf8")); } catch { /* fail closed */ }
  if (!mounted) throw new Error("Container requires operator-supplied storage mounted at /data. Configure the host-path mount in the app configuration.");
}
