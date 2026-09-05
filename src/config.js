export const POST_RATE_LIMIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** @typedef {{databasePath:string, port:number, sessionLifetimeMs:number, cookieName:string, secureCookies:boolean, postRateLimitMax:number, postRateLimitWindowMs:number, administratorIds:ReadonlySet<string>}} Config */
// @ts-expect-error Node globals are supplied by the supported runtime.
const environment = /** @type {Record<string, string | undefined>} */ (process.env);

/** @param {string | undefined} value */
function administratorIds(value) {
  if (value === undefined || value === "") return new Set();
  const ids = value.split(",");
  if (ids.some((/** @type {string} */ id) => !/^[A-Za-z0-9_-]{8,128}$/.test(id))) throw new TypeError("ADMINISTRATOR_IDS must contain stable opaque account IDs");
  return new Set(ids);
}
/** @returns {Omit<Config, 'administratorIds'> & {administratorIds: Set<string>}} */
function defaults() { return {
  databasePath: environment.DATABASE_PATH || "./reddit.sqlite", port: Number(environment.PORT || 3000), sessionLifetimeMs: Number(environment.SESSION_LIFETIME_MS || 3_600_000), cookieName: environment.SESSION_COOKIE_NAME || "reddit_session", secureCookies: environment.NODE_ENV === "production",
  postRateLimitMax: Number(environment.POST_RATE_LIMIT_MAX || 100), postRateLimitWindowMs: Number(environment.POST_RATE_LIMIT_WINDOW_MS || 60_000), administratorIds: administratorIds(environment.ADMINISTRATOR_IDS),
}; }
/** @param {Partial<Config>} [overrides] @returns {Readonly<Config>} */
export function createConfig(overrides = {}) {
  const config = /** @type {Config} */ ({ ...defaults(), ...overrides });
  if (typeof config.databasePath !== "string" || !config.databasePath) throw new TypeError("databasePath must be a non-empty string");
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) throw new TypeError("port must be an integer from 1 to 65535");
  if (!Number.isSafeInteger(config.sessionLifetimeMs) || config.sessionLifetimeMs < 1_000) throw new TypeError("sessionLifetimeMs must be an integer of at least 1000");
  if (!Number.isSafeInteger(config.postRateLimitMax) || config.postRateLimitMax < 1) throw new TypeError("postRateLimitMax must be a positive safe integer");
  if (!Number.isSafeInteger(config.postRateLimitWindowMs) || config.postRateLimitWindowMs < 1 || config.postRateLimitWindowMs > POST_RATE_LIMIT_RETENTION_MS) throw new TypeError(`postRateLimitWindowMs must be an integer from 1 to ${POST_RATE_LIMIT_RETENTION_MS}`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.cookieName)) throw new TypeError("cookieName must be a cookie-safe name");
  if (!(config.administratorIds instanceof Set) || [...config.administratorIds].some((id) => !/^[A-Za-z0-9_-]{8,128}$/.test(id))) throw new TypeError("administratorIds must be stable opaque account IDs");
  return Object.freeze({ ...config, administratorIds: new Set(config.administratorIds) });
}
