import { isContainerMode } from "./container.js";
import type { SecretsStore } from "./secrets.js";

// Public marker, stored only inside the encrypted CLIENT_SECRET row.
export const GENERATED_CLIENT_SECRET_PREFIX = "orca-generated-placeholder.";

export function isGeneratedClientSecret(value: string): boolean {
  return value.startsWith(GENERATED_CLIENT_SECRET_PREFIX);
}

// Existing startup checks own missing/decryption failures. In particular,
// native local login must still start when this optional read fails.
export async function checkClientSecretPlaceholder(store: SecretsStore, localLogin: boolean): Promise<boolean> {
  let value: string;
  try { value = await store.getSecret("CLIENT_SECRET"); }
  catch { return false; }
  if (!isGeneratedClientSecret(value)) return false;
  if (!localLogin) {
    throw new Error(isContainerMode()
      ? "CLIENT_SECRET is a generated placeholder from a native demo install. Replace it on that native install before moving the data, or give the app a new, empty /data volume in Storage settings."
      : "CLIENT_SECRET is a generated placeholder from a local-login demo seed. With the service stopped, run: node scripts/seed.js --replace-client-secret");
  }
  return true;
}
