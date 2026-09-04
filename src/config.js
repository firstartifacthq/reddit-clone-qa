/**
 * @typedef {object} Config
 * @property {string} databasePath
 * @property {number} port
 * @property {number} sessionLifetimeMs
 * @property {string} cookieName
 * @property {boolean} secureCookies
 * @property {number} postRateLimitMax
 * @property {number} postRateLimitWindowMs
 */

// The supported Node runtime supplies process; application dependencies stay type-only and pinned.
// @ts-expect-error Node globals are outside this JavaScript slice's ambient types.
const environment = /** @type {Record<string, string | undefined>} */ (process.env);

/** Application construction captures environment configuration once. @returns {Config} */
function defaults() {
  return {
    databasePath: environment.DATABASE_PATH || "./reddit.sqlite",
    port: Number(environment.PORT || 3000),
    sessionLifetimeMs: Number(environment.SESSION_LIFETIME_MS || 3_600_000),
    cookieName: environment.SESSION_COOKIE_NAME || "reddit_session",
    secureCookies: environment.NODE_ENV === "production",
    postRateLimitMax: Number(environment.POST_RATE_LIMIT_MAX || 100),
    postRateLimitWindowMs: Number(environment.POST_RATE_LIMIT_WINDOW_MS || 60_000),
  };
}

/**
 * @param {Partial<Config>} [overrides]
 * @returns {Readonly<Config>}
 */
export function createConfig(overrides = {}) {
  const config = /** @type {Config} */ ({ ...defaults(), ...overrides });
  if (typeof config.databasePath !== "string" || config.databasePath.length === 0) {
    throw new TypeError("databasePath must be a non-empty string");
  }
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new TypeError("port must be an integer from 1 to 65535");
  }
  if (!Number.isSafeInteger(config.sessionLifetimeMs) || config.sessionLifetimeMs < 1_000) {
    throw new TypeError("sessionLifetimeMs must be an integer of at least 1000");
  }
  if (!Number.isSafeInteger(config.postRateLimitMax) || config.postRateLimitMax < 1) {
    throw new TypeError("postRateLimitMax must be a positive safe integer");
  }
  if (!Number.isSafeInteger(config.postRateLimitWindowMs) || config.postRateLimitWindowMs < 1) {
    throw new TypeError("postRateLimitWindowMs must be a positive safe integer");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.cookieName)) {
    throw new TypeError("cookieName must be a cookie-safe name");
  }
  return Object.freeze(config);
}
