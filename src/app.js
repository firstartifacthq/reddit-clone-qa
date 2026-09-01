import { openDatabase } from "./database.js";
import { createConfig } from "./config.js";
import { AuthRepository } from "./auth/auth-repository.js";
import { AuthService } from "./auth/auth-service.js";
import { authenticationError, invalidCredentialsError, invalidRequestError, notFoundError } from "./http-errors.js";
import { publicCommunities } from "./public-communities.js";
import { renderShell } from "./public-shell.js";

/**
 * @typedef {object} Database
 * @property {(sql: string) => void} exec
 * @property {(sql: string) => any} prepare
 * @property {() => void} close
 */
/**
 * @typedef {object} AppOptions
 * @property {Database} [database]
 * @property {string} [databasePath]
 * @property {number} [port]
 * @property {number} [sessionLifetimeMs]
 * @property {string} [cookieName]
 * @property {boolean} [secureCookies]
 * @property {() => number} [now]
 * @property {() => string} [randomToken]
 */
/** @typedef {Record<string, string | string[] | undefined>} RequestHeaders */
/**
 * @typedef {object} AppRequest
 * @property {string} [method]
 * @property {string} [path]
 * @property {RequestHeaders} [headers]
 * @property {string} [payload]
 */
/**
 * @typedef {object} AppResponse
 * @property {number} status
 * @property {Record<string, string>} headers
 * @property {string} body
 */

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {AppResponse}
 */
function json(status, body, headers = {}) {
  return { status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) };
}

/**
 * @param {string} body
 * @returns {AppResponse}
 */
function html(body) {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

/**
 * @param {unknown} header
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
  if (typeof header !== "string") return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return ["", ""];
    const name = part.slice(0, separator).trim();
    try { return [name, decodeURIComponent(part.slice(separator + 1).trim())]; } catch { return [name, ""]; }
  }));
}

/**
 * @param {unknown} payload
 * @returns {unknown}
 */
function parseJson(payload) {
  if (typeof payload !== "string" || payload.length > 16_384) return undefined;
  try { return JSON.parse(payload); } catch { return undefined; }
}

/**
 * @param {RequestHeaders} headers
 * @returns {Record<string, string>}
 */
function headersFacade(headers) {
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name.toLowerCase()] = value;
    else if (Array.isArray(value)) normalized[name.toLowerCase()] = value.join("; ");
  }
  return normalized;
}

/** @param {AppOptions} [options] */
export function createApp(options = {}) {
  const { database: injectedDatabase, now, randomToken, ...configOptions } = options;
  const config = createConfig(configOptions);
  const database = injectedDatabase || openDatabase(config.databasePath);
  const repository = new AuthRepository(database);
  const auth = new AuthService({ repository, database, config, now, randomToken });
  const ownDatabase = !injectedDatabase;

  /**
   * @param {string} token
   * @param {number} maxAgeSeconds
   */
  function sessionCookie(token, maxAgeSeconds) {
    const attributes = [
      `${config.cookieName}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (config.secureCookies) attributes.push("Secure");
    return attributes.join("; ");
  }

  /**
   * @param {AppRequest} request
   * @returns {Promise<AppResponse>}
   */
  async function handle(request) {
    try {
      const method = (request.method || "GET").toUpperCase();
      const url = new URL(request.path || "/", "http://localhost");
      const headers = headersFacade(request.headers || {});
      const token = parseCookies(headers.cookie)[config.cookieName];
      const account = auth.resolve(token);

      if (method === "POST" && url.pathname === "/api/auth/signup") {
        const result = auth.signup(parseJson(request.payload));
        if (result.kind === "success") return json(201, result.account, { "set-cookie": sessionCookie(result.token, Math.ceil(config.sessionLifetimeMs / 1_000)) });
        if (result.kind === "duplicate") return json(409, { error: "Unable to create account" });
        return json(400, invalidRequestError);
      }
      if (method === "POST" && url.pathname === "/api/auth/login") {
        const result = auth.login(parseJson(request.payload));
        if (result.kind === "success") return json(200, result.account, { "set-cookie": sessionCookie(result.token, Math.ceil(config.sessionLifetimeMs / 1_000)) });
        if (result.kind === "invalid-credentials") return json(401, invalidCredentialsError);
        return json(400, invalidRequestError);
      }
      if (method === "POST" && url.pathname === "/api/auth/logout") {
        auth.logout(token);
        return { status: 204, headers: { "set-cookie": `${sessionCookie("", 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` }, body: "" };
      }
      if (method === "GET" && url.pathname === "/api/me") {
        return account ? json(200, account) : json(401, authenticationError);
      }
      if (method === "GET" && url.pathname === "/api/communities") return json(200, publicCommunities);
      if (method === "GET" && url.pathname === "/") return html(renderShell(account));
      return json(404, notFoundError);
    } catch {
      return json(500, { error: "Internal server error" });
    }
  }

  return {
    handle,
    /** @param {AppRequest} request */
    async inject(request) {
      const result = await handle(request);
      return {
        statusCode: result.status,
        headers: new Headers(result.headers),
        text: async () => result.body,
        json: async () => JSON.parse(result.body),
      };
    },
    config,
    accountCount: () => repository.accountCount(),
    close: () => { if (ownDatabase) database.close(); },
  };
}
