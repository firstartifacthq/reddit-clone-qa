import { openDatabase } from "./database.js";
import { createConfig } from "./config.js";
import { AuthRepository } from "./auth/auth-repository.js";
import { AuthService } from "./auth/auth-service.js";
import { ProfileRepository } from "./profile/profile-repository.js";
import { ProfileService } from "./profile/profile-service.js";
import { normalizeUsername } from "./account/username.js";
import {
  authenticationError, forbiddenError, invalidCredentialsError, invalidProfileError,
  invalidRequestError, notFoundError, profileUnavailableError,
} from "./http-errors.js";
import { publicCommunities } from "./public-communities.js";
import { renderShell } from "./public-shell.js";

/** @typedef {{exec: (sql: string) => void, prepare: (sql: string) => any, close: () => void}} Database */
/** @typedef {{database?: Database, databasePath?: string, port?: number, sessionLifetimeMs?: number, cookieName?: string, secureCookies?: boolean, now?: () => number, randomToken?: () => string}} AppOptions */
/** @typedef {Record<string, string | string[] | undefined>} RequestHeaders */
/** @typedef {{method?: string, path?: string, headers?: RequestHeaders, payload?: string}} AppRequest */
/** @typedef {{status: number, headers: Record<string, string>, body: string}} AppResponse */

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] @returns {AppResponse} */
function json(status, body, headers = {}) {
  return { status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) };
}

/** @param {string} body @returns {AppResponse} */
function html(body) { return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body }; }

/** @param {unknown} header @returns {Record<string, string>} */
function parseCookies(header) {
  if (typeof header !== "string") return {};
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return ["", ""];
    const name = part.slice(0, separator).trim();
    try { return [name, decodeURIComponent(part.slice(separator + 1).trim())]; } catch { return [name, ""]; }
  }));
}

/** @param {unknown} payload @returns {unknown} */
function parseJson(payload) {
  if (typeof payload !== "string" || payload.length > 16_384) return undefined;
  try { return JSON.parse(payload); } catch { return undefined; }
}

/** @param {RequestHeaders} headers @returns {Record<string, string>} */
function headersFacade(headers) {
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name.toLowerCase()] = value;
    else if (Array.isArray(value)) normalized[name.toLowerCase()] = value.join("; ");
  }
  return normalized;
}

/** @param {string} pathname @returns {string | undefined} */
function publicUsername(pathname) {
  const match = /^\/api\/users\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try { return normalizeUsername(decodeURIComponent(match[1])); } catch { return undefined; }
}

/** @param {AppOptions} [options] */
export function createApp(options = {}) {
  const { database: injectedDatabase, now, randomToken, ...configOptions } = options;
  const config = createConfig(configOptions);
  const database = injectedDatabase || openDatabase(config.databasePath);
  const authRepository = new AuthRepository(database);
  const profileRepository = new ProfileRepository(database);
  const auth = new AuthService({ repository: authRepository, database, config, now, randomToken });
  const profiles = new ProfileService({ repository: profileRepository, database, now });
  const ownDatabase = !injectedDatabase;

  /** @param {string} token @param {number} maxAgeSeconds */
  function sessionCookie(token, maxAgeSeconds) {
    const attributes = [`${config.cookieName}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
    if (config.secureCookies) attributes.push("Secure");
    return attributes.join("; ");
  }

  /** @param {AppRequest} request @returns {Promise<AppResponse>} */
  async function handle(request) {
    try {
      const method = (request.method || "GET").toUpperCase();
      const url = new URL(request.path || "/", "http://localhost");
      const headers = headersFacade(request.headers || {});
      const token = parseCookies(headers.cookie)[config.cookieName];
      const account = auth.resolve(token);
      const username = publicUsername(url.pathname);
      const isPublicUserRoute = /^\/api\/users\/[^/]+$/.test(url.pathname);

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
        if (!account) return json(401, authenticationError);
        const profile = profiles.getOwner(account.id);
        return profile ? json(200, profile) : json(401, authenticationError);
      }
      if (method === "PATCH" && url.pathname === "/api/me") {
        if (!account) return json(401, authenticationError);
        const result = profiles.edit(account.id, parseJson(request.payload));
        if (result.kind === "success") return json(200, result.profile);
        if (result.kind === "invalid") return json(422, invalidProfileError);
        if (result.kind === "conflict") return json(409, { error: "Profile conflict" });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        return json(503, profileUnavailableError);
      }
      if (method === "DELETE" && url.pathname === "/api/me") {
        if (!account) return json(401, authenticationError);
        const result = profiles.delete(account.id);
        if (result.kind === "success") return json(202, { status: "Deletion requested" }, { "set-cookie": `${sessionCookie("", 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        return json(503, profileUnavailableError);
      }
      if (method === "PATCH" && isPublicUserRoute) return account ? json(403, forbiddenError) : json(401, authenticationError);
      if (method === "GET" && isPublicUserRoute) {
        if (!username) return json(404, notFoundError);
        const profile = profiles.getPublic(username);
        return profile ? json(200, profile) : json(404, notFoundError);
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
      return { statusCode: result.status, headers: new Headers(result.headers), text: async () => result.body, json: async () => JSON.parse(result.body) };
    },
    config,
    database,
    accountCount: () => authRepository.accountCount(),
    close: () => { if (ownDatabase) database.close(); },
  };
}
