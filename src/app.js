import { openDatabase } from "./database.js";
import { createConfig } from "./config.js";
import { AuthRepository } from "./auth/auth-repository.js";
import { AuthService } from "./auth/auth-service.js";
import { ProfileRepository } from "./profile/profile-repository.js";
import { ProfileService } from "./profile/profile-service.js";
import { CommunityRepository } from "./community/community-repository.js";
import { CommunityService } from "./community/community-service.js";
import { PostRepository } from "./post/post-repository.js";
import { PostService } from "./post/post-service.js";
import { CommentRepository } from "./comment/comment-repository.js";
import { CommentService } from "./comment/comment-service.js";
import { validateCommentPage } from "./comment/comment-validation.js";
import { canonicalCommunityName } from "./community/community-validation.js";
import { normalizeUsername } from "./account/username.js";
import {
  authenticationError, forbiddenError, invalidCommunityError, invalidCredentialsError, invalidProfileError,
  invalidRequestError, notFoundError, profileUnavailableError, invalidPostError, postConflictError, postUnavailableError,
  invalidCommentError, invalidCommentPageError, commentUnavailableError,
} from "./http-errors.js";
import { renderShell } from "./public-shell.js";

/** @typedef {{exec: (sql: string) => void, prepare: (sql: string) => any, close: () => void}} Database */
/** @typedef {{database?: Database, databasePath?: string, port?: number, sessionLifetimeMs?: number, cookieName?: string, secureCookies?: boolean, now?: () => number, randomToken?: () => string, beforeMediaPersist?: () => void, beforeCommentPersist?: () => void}} AppOptions */
/** @typedef {Record<string, string | string[] | undefined>} RequestHeaders */
/** @typedef {{method?: string, path?: string, headers?: RequestHeaders, payload?: string | Uint8Array}} AppRequest */
/** @typedef {{status: number, headers: Record<string, string>, body: string | Uint8Array}} AppResponse */

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] @returns {AppResponse} */
function json(status, body, headers = {}) {
  return { status, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) };
}
/** @param {string} body @returns {AppResponse} */
function html(body) { return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body }; }
/** @param {string} contentType @param {Uint8Array} body @returns {AppResponse} */
function binary(contentType, body) { return { status: 200, headers: { "content-type": contentType }, body }; }
/** @param {number} status @returns {AppResponse} */
function empty(status) { return { status, headers: {}, body: "" }; }
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
  if (typeof payload === "string") {
    if (payload.length > 16_384) return undefined;
    try { return JSON.parse(payload); } catch { return undefined; }
  }
  if (!(payload instanceof Uint8Array) || payload.length > 16_384) return undefined;
  try { return JSON.parse(new TextDecoder().decode(payload)); } catch { return undefined; }
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
// null means that this is not a community route; undefined means an invalid route name.
/** @param {string} pathname @param {string} suffix @returns {string | undefined | null} */
function communityPath(pathname, suffix) {
  const match = new RegExp(`^/api/communities/([^/]+)${suffix}$`).exec(pathname);
  if (!match) return null;
  try { return canonicalCommunityName(decodeURIComponent(match[1])); } catch { return undefined; }
}
/** @param {string} pathname @returns {{id: string, media: boolean} | undefined} */
function postPath(pathname) {
  const match = /^\/api\/posts\/([^/]+)(\/media)?$/.exec(pathname);
  if (!match) return undefined;
  try { return { id: decodeURIComponent(match[1]), media: Boolean(match[2]) }; } catch { return undefined; }
}
/** @param {string} pathname */
function postCommentsPath(pathname) {
  const match = /^\/api\/posts\/([^/]+)\/comments$/.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}
/** @param {string} pathname */
function commentPath(pathname) {
  const match = /^\/api\/comments\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}
/** @param {string | undefined} contentType */
function isJsonContentType(contentType) { return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json"; }

/** @param {AppOptions} [options] */
export function createApp(options = {}) {
  const { database: injectedDatabase, now, randomToken, ...configOptions } = options;
  const config = createConfig(configOptions);
  const database = injectedDatabase || openDatabase(config.databasePath);
  const authRepository = new AuthRepository(database);
  const profileRepository = new ProfileRepository(database);
  const communityRepository = new CommunityRepository(database);
  const postRepository = new PostRepository(database);
  const commentRepository = new CommentRepository(database);
  const auth = new AuthService({ repository: authRepository, database, config, now, randomToken });
  const profiles = new ProfileService({ repository: profileRepository, database, now });
  const communities = new CommunityService({ repository: communityRepository, database, now });
  const posts = new PostService({ repository: postRepository, database, beforeMediaPersist: options.beforeMediaPersist });
  const comments = new CommentService({ repository: commentRepository, database, beforeCommentPersist: options.beforeCommentPersist });
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
      if (method === "POST" && url.pathname === "/api/communities") {
        if (!account) return json(401, authenticationError);
        const result = communities.create(account.id, parseJson(request.payload));
        if (result.kind === "created") return empty(201);
        if (result.kind === "duplicate") return json(409, { error: "Community already exists" });
        if (result.kind === "invalid") return json(422, invalidCommunityError);
        return json(503, { error: "Community service unavailable" });
      }
      const joinCommunity = communityPath(url.pathname, "/members");
      if (method === "POST" && joinCommunity !== null) {
        if (!account) return json(401, authenticationError);
        if (!joinCommunity) return json(404, notFoundError);
        const result = communities.join(account.id, joinCommunity);
        if (result.kind === "success") return empty(200);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, { error: "Community service unavailable" });
      }
      const leaveCommunity = communityPath(url.pathname, "/members/me");
      if (method === "DELETE" && leaveCommunity !== null) {
        if (!account) return json(401, authenticationError);
        if (!leaveCommunity) return json(404, notFoundError);
        const result = communities.leave(account.id, leaveCommunity);
        if (result.kind === "success") return empty(204);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, { error: "Community service unavailable" });
      }
      const moderatorCommunity = communityPath(url.pathname, "/moderators");
      if (method === "PATCH" && moderatorCommunity !== null) {
        if (!account) return json(401, authenticationError);
        if (!moderatorCommunity) return json(404, notFoundError);
        const result = communities.changeModerator(account.id, moderatorCommunity, parseJson(request.payload));
        if (result.kind === "success") return empty(200);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "invalid") return json(422, invalidCommunityError);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, { error: "Community service unavailable" });
      }
      const modlogCommunity = communityPath(url.pathname, "/modlog");
      if (method === "GET" && modlogCommunity !== null) {
        if (!account) return json(401, authenticationError);
        if (!modlogCommunity) return json(404, notFoundError);
        const result = communities.admitModlog(account.id, modlogCommunity);
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        return json(200, { entries: [] });
      }
      const postCommunity = communityPath(url.pathname, "/posts");
      if (method === "POST" && postCommunity !== null) {
        if (!account) return json(401, authenticationError);
        if (!postCommunity) return json(404, notFoundError);
        if (!posts.canCreate(account.id, postCommunity)) return json(403, forbiddenError);
        if (!isJsonContentType(headers["content-type"])) return json(422, invalidPostError);
        const result = posts.create(account.id, postCommunity, request.payload, headers["idempotency-key"]);
        if (result.kind === "success") return json(201, result.post);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "conflict") return json(409, postConflictError);
        if (result.kind === "too-large") return json(413, invalidPostError);
        if (result.kind === "invalid") return json(422, invalidPostError);
        return json(503, postUnavailableError);
      }
      const commentPostId = postCommentsPath(url.pathname);
      if (commentPostId && method === "POST") {
        if (!account) return json(401, authenticationError);
        const admission = comments.authorizeCreate(account.id, commentPostId);
        if (admission === "not-found") return json(404, notFoundError);
        if (admission === "forbidden") return json(403, forbiddenError);
        if (!isJsonContentType(headers["content-type"])) return json(422, invalidCommentError);
        const result = comments.create(account.id, commentPostId, request.payload);
        if (result.kind === "success") return json(201, result.comment);
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "invalid") return json(422, invalidCommentError);
        return json(503, commentUnavailableError);
      }
      if (commentPostId && method === "GET") {
        const page = validateCommentPage(url.searchParams);
        if (!page) return json(422, invalidCommentPageError);
        const result = comments.conversation(commentPostId, page.limit, page.cursor);
        if (result.kind === "success") return json(200, { comments: result.comments, nextCursor: result.nextCursor });
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "invalid-page") return json(422, invalidCommentPageError);
        return json(503, commentUnavailableError);
      }
      const commentId = commentPath(url.pathname);
      if (commentId && method === "GET") {
        const comment = comments.get(commentId);
        return comment ? json(200, comment) : json(404, notFoundError);
      }
      if (commentId && method === "PATCH") {
        if (!account) return json(401, authenticationError);
        const admission = comments.authorizeMutation(account.id, commentId);
        if (admission === "not-found") return json(404, notFoundError);
        if (admission === "forbidden") return json(403, forbiddenError);
        if (!isJsonContentType(headers["content-type"])) return json(422, invalidCommentError);
        const result = comments.edit(account.id, commentId, request.payload);
        if (result.kind === "success") return json(200, result.comment);
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "invalid") return json(422, invalidCommentError);
        return json(503, commentUnavailableError);
      }
      if (commentId && method === "DELETE") {
        if (!account) return json(401, authenticationError);
        const result = comments.delete(account.id, commentId);
        if (result.kind === "success") return empty(204);
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        return json(503, commentUnavailableError);
      }
      const postRoute = postPath(url.pathname);
      if (postRoute && method === "GET") {
        if (postRoute.media) {
          const media = posts.media(postRoute.id);
          return media ? binary(media.media_content_type, media.media_bytes) : json(404, notFoundError);
        }
        const post = posts.get(postRoute.id);
        return post ? json(200, post) : json(404, notFoundError);
      }
      if (postRoute && method === "PATCH") {
        if (!account) return json(401, authenticationError);
        if (postRoute.media) return json(404, notFoundError);
        const admission = posts.authorizeMutation(account.id, postRoute.id);
        if (admission === "not-found") return json(404, notFoundError);
        if (admission === "forbidden") return json(403, forbiddenError);
        if (!isJsonContentType(headers["content-type"])) return json(422, invalidPostError);
        const result = posts.edit(account.id, postRoute.id, request.payload);
        if (result.kind === "success") return json(200, result.post);
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "too-large") return json(413, invalidPostError);
        if (result.kind === "invalid") return json(422, invalidPostError);
        return json(503, postUnavailableError);
      }
      if (postRoute && method === "DELETE") {
        if (!account) return json(401, authenticationError);
        if (postRoute.media) return json(404, notFoundError);
        const result = posts.delete(account.id, postRoute.id);
        if (result.kind === "success") return empty(204);
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        return json(503, postUnavailableError);
      }
      if (method === "GET" && url.pathname === "/api/communities") return json(200, { communities: communities.list() });
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
      const bytes = result.body instanceof Uint8Array ? result.body : new TextEncoder().encode(result.body);
      return {
        statusCode: result.status,
        headers: new Headers(result.headers),
        text: async () => new TextDecoder().decode(bytes),
        bytes: async () => new Uint8Array(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    config,
    database,
    accountCount: () => authRepository.accountCount(),
    close: () => { if (ownDatabase) database.close(); },
  };
}
