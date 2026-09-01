const defaults = Object.freeze({
  databasePath: process.env.DATABASE_PATH || "./reddit.sqlite",
  port: Number(process.env.PORT || 3000),
  sessionLifetimeMs: Number(process.env.SESSION_LIFETIME_MS || 3_600_000),
  cookieName: process.env.SESSION_COOKIE_NAME || "reddit_session",
  secureCookies: process.env.NODE_ENV === "production",
});

export function createConfig(overrides = {}) {
  const config = { ...defaults, ...overrides };
  if (typeof config.databasePath !== "string" || config.databasePath.length === 0) {
    throw new TypeError("databasePath must be a non-empty string");
  }
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new TypeError("port must be an integer from 1 to 65535");
  }
  if (!Number.isSafeInteger(config.sessionLifetimeMs) || config.sessionLifetimeMs < 1_000) {
    throw new TypeError("sessionLifetimeMs must be an integer of at least 1000");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.cookieName)) {
    throw new TypeError("cookieName must be a cookie-safe name");
  }
  return Object.freeze(config);
}
