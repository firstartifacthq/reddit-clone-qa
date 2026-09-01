export function loadConfig(overrides = {}) {
  const config = {
    databasePath: process.env.DATABASE_PATH ?? "./reddit-clone.sqlite",
    port: Number(process.env.PORT ?? 3000),
    sessionLifetimeMs: Number(process.env.SESSION_LIFETIME_MS ?? 86_400_000),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    ...overrides,
  };
  if (typeof config.databasePath !== "string" || config.databasePath.length === 0) throw new Error("databasePath is required");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) throw new Error("port must be a valid TCP port");
  if (!Number.isSafeInteger(config.sessionLifetimeMs) || config.sessionLifetimeMs < 1) throw new Error("sessionLifetimeMs must be positive");
  if (typeof config.cookieSecure !== "boolean") throw new Error("cookieSecure must be boolean");
  return Object.freeze(config);
}
