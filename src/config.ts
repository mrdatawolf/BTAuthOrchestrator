const requiredVariables = [
  "PORT",
  "PGLITE_DATA_DIR",
  "DB_ENCRYPTION_KEY",
  "COOKIE_SECURE",
  "TENANT_ID",
  "CLIENT_ID",
  "SERVICE_ISSUER",
] as const;

export interface Config {
  port: number;
  pgliteDataDir: string;
  dbEncryptionKey: string;
  cookieSecure: string;
  tenantId: string;
  clientId: string;
  issuer: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv): Config {
  const missing = requiredVariables.filter(
    (name) => environment[name]?.trim() === "" || environment[name] === undefined,
  );

  const portValue = environment.PORT?.trim();
  const port = portValue !== undefined && /^\d+$/.test(portValue) ? Number(portValue) : NaN;
  const invalid =
    portValue !== undefined && portValue !== "" &&
    (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      ? ["PORT (must be a positive integer between 1 and 65535)"]
      : [];

  const encryptionKeyValue = environment.DB_ENCRYPTION_KEY?.trim();
  if (
    encryptionKeyValue !== undefined &&
    encryptionKeyValue !== "" &&
    !/^[0-9a-f]{64}$/.test(encryptionKeyValue)
  ) {
    invalid.push("DB_ENCRYPTION_KEY (must be exactly 64 lowercase hexadecimal characters)");
  }

  if (missing.length > 0 || invalid.length > 0) {
    const details = [
      missing.length > 0
        ? `missing required environment variable(s): ${missing.join(", ")}`
        : undefined,
      invalid.length > 0
        ? `invalid environment variable(s): ${invalid.join(", ")}`
        : undefined,
    ].filter((detail): detail is string => detail !== undefined);

    throw new Error(`Configuration error: ${details.join("; ")}`);
  }

  return {
    port,
    pgliteDataDir: environment.PGLITE_DATA_DIR!.trim(),
    dbEncryptionKey: environment.DB_ENCRYPTION_KEY!.trim(),
    cookieSecure: environment.COOKIE_SECURE!.trim(),
    tenantId: environment.TENANT_ID!.trim(),
    clientId: environment.CLIENT_ID!.trim(),
    issuer: environment.SERVICE_ISSUER!.trim(),
  };
}
