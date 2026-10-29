import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";

export function isContainerMode(): boolean {
  return process.env.BT_CONTAINER_MODE === "1";
}

export function containerStorageFix(): string {
  return `The app (UID ${process.getuid?.()}, GID ${process.getgid?.()}) cannot write to /data. In the app's Storage settings for /data, tick Enable ACL and add an entry: User, ID ${process.getuid?.()}, Modify. Then save the app.`;
}

export function containerDirectoryError(kind: "file" | "owner" | "mode", value?: number): string {
  if (kind === "owner") return `/data/pglite belongs to UID ${value}, but the app runs as UID ${process.getuid?.()} (GID ${process.getgid?.()}). In the app's Security Context, enable the custom user and set User ID back to ${value}, or in Storage give the app a new, empty /data ix volume.`;
  if (kind === "mode") return `/data/pglite has mode ${value!.toString(8).padStart(4, "0")} but must be 0700. Something outside the app changed it. Fix it from the TrueNAS Shell (chmod 700 on the app's /data/pglite folder), or restore a snapshot of the app's volume in Storage.`;
  return "/data/pglite is not a directory. In the app's Storage settings, restore a snapshot containing the directory or give the app a new, empty /data ix volume.";
}

// The fifth mountinfo field is the mount point. A filesystem containing
// /data is not a mount AT /data.
export function hasDataMount(mountInfo: string): boolean {
  return mountInfo.split("\n").some(line => line.split(" ")[4] === "/data");
}

export function validateContainerIdentity(dataDirectory: string, uid: number | undefined): void {
  if (uid === undefined || uid === 0) throw new Error(`The container is running as ${uid === 0 ? "root (UID 0)" : "an unknown UID"}. In the app's Security Context, enable the custom user and set User ID and Group ID to 568, or another non-root ID that has Modify access to /data.`);
  if (dataDirectory !== "/data/pglite") throw new Error("PGLITE_DATA_DIR is not /data/pglite. Remove the PGLITE_DATA_DIR environment variable in the app's Environment Variables settings; the image sets it to /data/pglite.");
}

export async function checkContainerStorage(dataDirectory: string): Promise<void> {
  if (!isContainerMode()) return;
  validateContainerIdentity(dataDirectory, process.getuid?.());
  let mounted = false;
  try { mounted = hasDataMount(await readFile("/proc/self/mountinfo", "utf8")); } catch { /* fail closed */ }
  if (!mounted) throw new Error("No storage is mounted at /data. In the app's Storage settings, add an ix volume with Mount Path /data, then save the app.");
  try {
    if (!(await stat("/data")).isDirectory()) throw new Error("not a directory");
    // access consults filesystem permissions/ACLs without creating an entry or
    // inspecting mode/owner. X_OK also requires the directory to be enterable.
    await access("/data", constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(containerStorageFix());
  }
}
