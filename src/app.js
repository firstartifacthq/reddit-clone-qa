import { openDatabase } from "./database.js";
import { createConfig, POST_RATE_LIMIT_RETENTION_MS } from "./config.js";
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
import { PersonalRepository } from "./personal/personal-repository.js";
import { PersonalService } from "./personal/personal-service.js";
import { validatePersonalPage, validatePreferencePatch } from "./personal/personal-validation.js";
import { VoteRepository } from "./vote/vote-repository.js";
import { VoteService } from "./vote/vote-service.js";
import { parseVoteJson, validateVote } from "./vote/vote-validation.js";
import { SearchRepository } from "./search/search-repository.js";
import { SearchService } from "./search/search-service.js";
import { validateSearch } from "./search/search-validation.js";
import { FeedRepository } from "./feed/feed-repository.js";
import { FeedService } from "./feed/feed-service.js";
import { validateFeedPage } from "./feed/feed-validation.js";
import { ModerationRepository } from "./moderation/moderation-repository.js";
import { ModerationService } from "./moderation/moderation-service.js";
import { SafetyRepository } from "./safety/safety-repository.js";
import { SafetyService } from "./safety/safety-service.js";
import { validateModerationQueuePage } from "./moderation/moderation-validation.js";
import { NotificationRepository } from "./notification/notification-repository.js";
import { NotificationService } from "./notification/notification-service.js";
import { validateDeliveryRetry, validateNotificationPage, validateNotificationPatch } from "./notification/notification-validation.js";
import { validateCommentPage } from "./comment/comment-validation.js";
import { canonicalCommunityName } from "./community/community-validation.js";
import { normalizeUsername } from "./account/username.js";
import {
  authenticationError, forbiddenError, invalidCommunityError, invalidCredentialsError, invalidProfileError,
  invalidRequestError, notFoundError, profileUnavailableError, invalidPostError, postConflictError, postUnavailableError, postRateLimitedError,
  invalidCommentError, invalidCommentPageError, commentUnavailableError,
  invalidPersonalPageError, invalidPreferencesError, personalUnavailableError, invalidVoteError, voteUnavailableError,
  invalidSearchError, searchUnavailableError, invalidFeedPageError, feedUnavailableError,
  invalidModerationQueuePageError, moderationUnavailableError, methodNotAllowedError,
  invalidNotificationPageError, invalidNotificationError, notificationUnavailableError, notificationNotFoundError,
} from "./http-errors.js";
import { renderShell } from "./public-shell.js";
import { PrivacyRepository } from "./privacy/privacy-repository.js";
import { PrivacyService } from "./privacy/privacy-service.js";
import { PrivacyWorker } from "./privacy/privacy-worker.js";
import { auditPage, deletionTarget, opaqueId, selfRequest } from "./privacy/privacy-validation.js";

/** @typedef {{exec: (sql: string) => void, prepare: (sql: string) => any, close: () => void}} Database */
/** @typedef {{database?: Database, databasePath?: string, port?: number, sessionLifetimeMs?: number, cookieName?: string, secureCookies?: boolean, postRateLimitMax?: number, postRateLimitWindowMs?: number, administratorIds?: Set<string>, now?: () => number, randomToken?: () => string, identifier?: () => string, administratorAuthority?: (account: {id:string, username:string}) => boolean, schedulePrivacyWork?: (work: () => void) => void, beforePrivacyAcceptance?: () => void, beforePrivacyPhase?: (job: any) => void, beforeMediaPersist?: () => void, beforePostEnforcement?: () => void, beforeCommentPersist?: () => void, beforeSavedPersist?: () => void, beforeHistoryPersist?: () => void, beforePreferencePersist?: () => void, beforeVotePersist?: () => void, beforeSearchRead?: () => void, beforeFeedCommit?: () => void, beforeModerationCommit?: () => void, beforeNotificationDelivery?: () => void}} AppOptions */
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
/** @param {string} pathname */
function privateUserSuffix(pathname) { return /^\/api\/users\/[^/]+\/(saved|history)$/.test(pathname); }
/** @param {string} pathname @returns {string | undefined} */
function blockTargetUsername(pathname) {
  const match = /^\/api\/users\/([^/]+)\/block$/.exec(pathname);
  if (!match) return undefined;
  try { return normalizeUsername(decodeURIComponent(match[1])); } catch { return undefined; }
}
/** @param {string} pathname */
function notificationUserSuffix(pathname) { return /^\/api\/users\/([^/]+)\/notifications$/.exec(pathname); }
/** @param {string} pathname */
function notificationPath(pathname) { const match = /^\/api\/me\/notifications\/([^/]+)$/.exec(pathname); if (!match) return undefined; try { return decodeURIComponent(match[1]); } catch { return undefined; } }
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
function reportPath(pathname) {
  const match = /^\/api\/posts\/([^/]+)\/reports$/.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}
/** @param {string} pathname */
function moderationPostPath(pathname, suffix = "") {
  const match = new RegExp(`^/api/mod/posts/([^/]+)${suffix}$`).exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}
/** @param {string} pathname */
function votePath(pathname) {
  const match = /^\/api\/posts\/([^/]+)\/vote$/.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
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
  const {
    database: injectedDatabase, now, randomToken, beforeMediaPersist, beforePostEnforcement, beforeCommentPersist,
    beforeSavedPersist, beforeHistoryPersist, beforePreferencePersist, beforeVotePersist, beforeSearchRead, beforeFeedCommit, beforeModerationCommit, beforeNotificationDelivery,
    identifier, administratorAuthority, schedulePrivacyWork, beforePrivacyAcceptance, beforePrivacyPhase, ...configOptions
  } = options;
  const config = createConfig(configOptions);
  const database = injectedDatabase || openDatabase(config.databasePath);
  const authRepository = new AuthRepository(database);
  const profileRepository = new ProfileRepository(database);
  const communityRepository = new CommunityRepository(database);
  const postRepository = new PostRepository(database);
  const commentRepository = new CommentRepository(database);
  const personalRepository = new PersonalRepository(database);
  const voteRepository = new VoteRepository(database);
  const searchRepository = new SearchRepository(database);
  const feedRepository = new FeedRepository(database);
  const moderationRepository = new ModerationRepository(database);
  const safetyRepository = new SafetyRepository(database);
  const notificationRepository = new NotificationRepository(database);
  const notifications = new NotificationService({ repository: notificationRepository, database, now, randomToken, beforeDelivery: beforeNotificationDelivery });
  const auth = new AuthService({ repository: authRepository, database, config, now, randomToken });
  const profiles = new ProfileService({ repository: profileRepository, database, now });
  const communities = new CommunityService({ repository: communityRepository, database, now });
  const safety = new SafetyService({ repository: safetyRepository, database, now, postRateLimitMax: config.postRateLimitMax, postRateLimitWindowMs: config.postRateLimitWindowMs, postRateLimitRetentionMs: POST_RATE_LIMIT_RETENTION_MS, beforePostEnforcement });
  const posts = new PostService({ repository: postRepository, safety, database, now, beforeMediaPersist });
  const comments = new CommentService({ repository: commentRepository, notificationService: notifications, database, beforeCommentPersist });
  const personal = new PersonalService({ repository: personalRepository, database, now, beforeSavedPersist, beforeHistoryPersist, beforePreferencePersist });
  const votes = new VoteService({ repository: voteRepository, notificationService: notifications, database, beforeVotePersist });
  const search = new SearchService({ repository: searchRepository, beforeSearchRead });
  const feeds = new FeedService({ repository: feedRepository, database, now, beforeFeedCommit });
  const moderation = new ModerationService({ repository: moderationRepository, notificationService: notifications, database, now, randomToken, beforeModerationCommit });
  const privacyRepository = new PrivacyRepository(database);
  const privacy = new PrivacyService({ repository: privacyRepository, database, now, identifier, beforeAcceptance: beforePrivacyAcceptance });
  const privacyWorker = new PrivacyWorker({ service: privacy, repository: privacyRepository, beforePhase: beforePrivacyPhase });
  const isAdministrator = administratorAuthority || ((candidate) => config.administratorIds.has(candidate.id));
  const scheduleWork = schedulePrivacyWork || ((work) => setTimeout(work, 0));
  const schedulePrivacy = () => scheduleWork(() => privacyWorker.drain());
  const deliveryCapability = Symbol("notification delivery capability");
  const ownDatabase = !injectedDatabase;

  /** @param {string} token @param {number} maxAgeSeconds */
  function sessionCookie(token, maxAgeSeconds) {
    const attributes = [`${config.cookieName}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
    if (config.secureCookies) attributes.push("Secure");
    return attributes.join("; ");
  }

  /** @param {AppRequest} request @param {symbol | undefined} [capability] @returns {Promise<AppResponse>} */
  async function handle(request, capability) {
    try {
      const method = (request.method || "GET").toUpperCase();
      const url = new URL(request.path || "/", "http://localhost");
      const headers = headersFacade(request.headers || {});
      const token = parseCookies(headers.cookie)[config.cookieName];
      const account = auth.resolve(token);
      const username = publicUsername(url.pathname);
      const isPublicUserRoute = /^\/api\/users\/[^/]+$/.test(url.pathname);

      // Audit history is append-only; this explicit guard precedes any request-body handling.
      if (method === "PATCH" && /^\/api\/mod\/audit\/[^/]+$/.test(url.pathname)) return json(405, methodNotAllowedError, { allow: "GET" });

      if (method === "GET" && url.pathname === "/api/search") {
        const query = validateSearch(url);
        if (!query) return json(400, invalidSearchError);
        const result = search.find(query, account);
        if (result.kind === "success") return json(200, { results: result.results });
        return json(503, searchUnavailableError, { "retry-after": "1" });
      }
      if (method === "GET" && url.pathname === "/api/feed/home") {
        // Home deliberately admits session authority before inspecting page syntax.
        if (!account) return json(401, authenticationError);
        const page = validateFeedPage(url.searchParams);
        if (!page) return json(422, invalidFeedPageError);
        const result = feeds.listing({ kind: "home", requesterId: account.id }, page.limit, page.cursor);
        if (result.kind === "success") return json(200, { posts: result.posts, nextCursor: result.nextCursor });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "invalid-page") return json(422, invalidFeedPageError);
        return json(503, feedUnavailableError, { "retry-after": "1" });
      }
      if (method === "GET" && url.pathname === "/api/feed/popular") {
        const page = validateFeedPage(url.searchParams);
        if (!page) return json(422, invalidFeedPageError);
        const result = feeds.listing({ kind: "popular", requesterId: account?.id }, page.limit, page.cursor);
        if (result.kind === "success") return json(200, { posts: result.posts, nextCursor: result.nextCursor });
        if (result.kind === "invalid-page") return json(422, invalidFeedPageError);
        return json(503, feedUnavailableError, { "retry-after": "1" });
      }
      const feedCommunity = communityPath(url.pathname, "/feed");
      if (method === "GET" && feedCommunity !== null) {
        if (!feedCommunity) return json(404, notFoundError);
        const page = validateFeedPage(url.searchParams);
        if (!page) return json(422, invalidFeedPageError);
        const result = feeds.listing({ kind: "community", community: feedCommunity, requesterId: account?.id }, page.limit, page.cursor);
        if (result.kind === "success") return json(200, { posts: result.posts, nextCursor: result.nextCursor });
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "invalid-page") return json(422, invalidFeedPageError);
        return json(503, feedUnavailableError, { "retry-after": "1" });
      }
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
      const exportJobMatch = /^\/api\/me\/export\/jobs\/([^/]+?)(?:\/(result))?$/.exec(url.pathname);
      const deletionStatusMatch = /^\/api\/admin\/users\/delete\/([^/]+)$/.exec(url.pathname);
      const auditMutation = /^\/api\/admin\/audit(?:\/[^/]+)?$/.test(url.pathname) && ["DELETE", "PATCH", "PUT", "POST"].includes(method);
      if (auditMutation) {
        if (!account) return json(401, authenticationError);
        if (!isAdministrator(account)) return json(403, forbiddenError);
        return json(405, methodNotAllowedError, { allow: "GET" });
      }
      if (method === "POST" && url.pathname === "/api/me/export") {
        if (!account) return json(401, authenticationError);
        if (!selfRequest(request.payload)) return json(422, invalidRequestError);
        const result = privacy.requestExport(account.id);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind !== "success") return json(503, { error: "Privacy service unavailable" });
        if (!result.existing) schedulePrivacy();
        return json(202, result.job);
      }
      if (method === "GET" && exportJobMatch) {
        if (!account) return json(401, authenticationError);
        const jobId = opaqueId(decodeURIComponent(exportJobMatch[1]));
        if (!jobId) return json(404, notFoundError);
        if (exportJobMatch[2]) { const data = privacy.exportResult(jobId, account.id); return data ? json(200, data) : json(404, notFoundError); }
        const job = privacy.exportStatus(jobId, account.id); return job ? json(200, job) : json(404, notFoundError);
      }
      if (method === "GET" && url.pathname === "/api/admin/audit") {
        if (!account) return json(401, authenticationError);
        if (!isAdministrator(account)) return json(403, forbiddenError);
        const page = auditPage(url.searchParams); if (!page) return json(422, invalidRequestError);
        const result = privacy.audit(account.id, page.limit, page.cursor);
        return result ? json(200, result) : json(422, invalidRequestError);
      }
      if (method === "POST" && url.pathname === "/api/admin/users/delete") {
        if (!account) return json(401, authenticationError);
        if (!isAdministrator(account)) return json(403, forbiddenError);
        const target = deletionTarget(parseJson(request.payload)); if (!target) return json(422, invalidRequestError);
        const result = privacy.requestDeletion(target);
        if (result.kind === "lost-authority") return json(404, notFoundError);
        if (result.kind !== "success") return json(503, { error: "Privacy service unavailable" });
        if (!result.existing) schedulePrivacy();
        return json(202, result.job);
      }
      if (method === "GET" && deletionStatusMatch) {
        if (!account) return json(401, authenticationError);
        if (!isAdministrator(account)) return json(403, forbiddenError);
        const jobId = opaqueId(decodeURIComponent(deletionStatusMatch[1])); if (!jobId) return json(404, notFoundError);
        const job = privacy.deletionStatus(jobId); return job ? json(200, job) : json(404, notFoundError);
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
        if (!selfRequest(request.payload)) return json(422, invalidRequestError);
        const result = privacy.requestDeletion(account.id);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind !== "success") return json(503, profileUnavailableError);
        if (!result.existing) schedulePrivacy();
        return json(202, result.job, { "set-cookie": `${sessionCookie("", 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT` });
      }
      if (method === "POST" && url.pathname === "/api/notifications/delivery/retry") {
        // No serializable request component can create this in-process capability.
        if (capability !== deliveryCapability) return json(403, forbiddenError);
        const eventKey = validateDeliveryRetry(parseJson(request.payload));
        if (!eventKey) return json(422, invalidNotificationError);
        const result = notifications.retry(eventKey);
        if (result.kind === "success") return empty(204);
        if (result.kind === "not-found") return json(404, notificationNotFoundError);
        return json(503, notificationUnavailableError);
      }
      if (method === "GET" && url.pathname === "/api/me/notifications") {
        if (!account) return json(401, authenticationError);
        const page = validateNotificationPage(url.searchParams); if (!page) return json(422, invalidNotificationPageError);
        const result = notifications.listing(account.id, page.limit, page.cursor);
        if (result.kind === "success") return json(200, { notifications: result.notifications, nextCursor: result.nextCursor });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "invalid-page") return json(422, invalidNotificationPageError);
        return json(503, notificationUnavailableError);
      }
      const privateNotifications = notificationUserSuffix(url.pathname);
      if (method === "GET" && privateNotifications) {
        if (!account) return json(401, authenticationError);
        let target; try { target = normalizeUsername(decodeURIComponent(privateNotifications[1])); } catch { target = undefined; }
        if (!target || target.toLowerCase() !== account.username.toLowerCase()) return json(403, forbiddenError);
        const page = validateNotificationPage(url.searchParams); if (!page) return json(422, invalidNotificationPageError);
        const result = notifications.listing(account.id, page.limit, page.cursor);
        if (result.kind === "success") return json(200, { notifications: result.notifications, nextCursor: result.nextCursor });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "invalid-page") return json(422, invalidNotificationPageError);
        return json(503, notificationUnavailableError);
      }
      const notificationId = notificationPath(url.pathname);
      if (notificationId && (method === "PATCH" || method === "DELETE")) {
        if (!account) return json(401, authenticationError);
        if (method === "PATCH") {
          if (!isJsonContentType(headers["content-type"])) return json(422, invalidNotificationError);
          const patch = validateNotificationPatch(parseJson(request.payload)); if (!patch) return json(422, invalidNotificationError);
          const result = notifications.setRead(account.id, notificationId, patch.read);
          if (result.kind === "success") return empty(204);
          if (result.kind === "lost-authority") return json(401, authenticationError);
          if (result.kind === "unavailable-target") return json(404, notificationNotFoundError);
          return json(503, notificationUnavailableError);
        }
        const result = notifications.delete(account.id, notificationId);
        if (result.kind === "success") return empty(204);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "unavailable-target") return json(404, notificationNotFoundError);
        return json(503, notificationUnavailableError);
      }
      if (method === "GET" && privateUserSuffix(url.pathname)) return account ? json(403, forbiddenError) : json(401, authenticationError);
      if (method === "GET" && url.pathname === "/api/me/saved") {
        if (!account) return json(401, authenticationError);
        const page = validatePersonalPage(url.searchParams); if (!page) return json(422, invalidPersonalPageError);
        const result = personal.listing(account.id, "saved", page.limit, page.cursor);
        if (result.kind === "success") return json(200, { posts: result.items.map((/** @type {any} */ item) => item.post), nextCursor: result.nextCursor });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "invalid-page") return json(422, invalidPersonalPageError);
        return json(503, personalUnavailableError);
      }
      if (method === "GET" && url.pathname === "/api/me/history") {
        if (!account) return json(401, authenticationError);
        const page = validatePersonalPage(url.searchParams); if (!page) return json(422, invalidPersonalPageError);
        const result = personal.listing(account.id, "history", page.limit, page.cursor);
        if (result.kind === "success") return json(200, { history: result.items, nextCursor: result.nextCursor });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "invalid-page") return json(422, invalidPersonalPageError);
        return json(503, personalUnavailableError);
      }
      if (method === "GET" && url.pathname === "/api/me/preferences") {
        if (!account) return json(401, authenticationError);
        return json(200, personal.preferences(account.id));
      }
      if (method === "PATCH" && url.pathname === "/api/me/preferences") {
        if (!account) return json(401, authenticationError);
        const patch = validatePreferencePatch(parseJson(request.payload));
        if (!patch) return json(422, invalidPreferencesError);
        const result = personal.updatePreferences(account.id, patch);
        if (result.kind === "success") return json(200, result.preferences);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        return json(503, personalUnavailableError);
      }
      if (method === "GET" && url.pathname === "/api/mod/queue") {
        if (!account) return json(401, authenticationError);
        const page = validateModerationQueuePage(url.searchParams);
        if (!page) return json(422, invalidModerationQueuePageError);
        const result = moderation.queue(account.id, page.limit, page.cursor);
        if (result.kind === "success") return json(200, { reports: result.reports, nextCursor: result.nextCursor });
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "invalid-page") return json(422, invalidModerationQueuePageError);
        return json(503, moderationUnavailableError, { "retry-after": "1" });
      }
      const reportPostId = reportPath(url.pathname);
      if (reportPostId && method === "POST") {
        if (!account) return json(401, authenticationError);
        const result = moderation.report(account.id, reportPostId);
        if (result.kind === "success") return json(201, result.report);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "duplicate") return json(409, { error: "Report already exists" });
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, moderationUnavailableError, { "retry-after": "1" });
      }
      const removePostId = moderationPostPath(url.pathname);
      if (removePostId && method === "DELETE") {
        if (!account) return json(401, authenticationError);
        const result = moderation.transition(account.id, removePostId, "remove");
        if (result.kind === "success") return empty(204);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, moderationUnavailableError, { "retry-after": "1" });
      }
      const restorePostId = moderationPostPath(url.pathname, "/restore");
      if (restorePostId && method === "POST") {
        if (!account) return json(401, authenticationError);
        const result = moderation.transition(account.id, restorePostId, "restore");
        if (result.kind === "success") return json(200, result.post);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, moderationUnavailableError, { "retry-after": "1" });
      }
      const savePost = /^\/api\/posts\/([^/]+)\/save$/.exec(url.pathname);
      if (savePost && (method === "PUT" || method === "DELETE")) {
        if (!account) return json(401, authenticationError);
        let postId; try { postId = decodeURIComponent(savePost[1]); } catch { return json(404, notFoundError); }
        const result = method === "PUT" ? personal.save(account.id, postId) : personal.unsave(account.id, postId);
        if (result.kind === "success") return empty(204);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, personalUnavailableError);
      }
      const blockTarget = blockTargetUsername(url.pathname);
      if (method === "POST" && blockTarget !== undefined) {
        if (!account) return json(401, authenticationError);
        if (!blockTarget) return json(404, notFoundError);
        const result = safety.block(account.id, blockTarget);
        if (result.kind === "success") return empty(204);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, postUnavailableError, { "retry-after": "1" });
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
        return json(200, { entries: moderation.modlog(modlogCommunity) });
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
        if (result.kind === "rate-limited") return json(429, postRateLimitedError, { "retry-after": String(result.retryAfterSeconds) });
        if (result.kind === "enforcement-unavailable") return json(503, postUnavailableError, { "retry-after": "1" });
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
      const votePostId = votePath(url.pathname);
      if (votePostId && method === "GET") {
        if (!account) return json(401, authenticationError);
        const vote = votes.get(account.id, votePostId);
        return vote ? json(200, vote) : json(404, notFoundError);
      }
      if (votePostId && (method === "PUT" || method === "DELETE")) {
        if (!account) return json(401, authenticationError);
        // Target admission intentionally precedes media-type and JSON validation.
        const admission = votes.authorize(account.id, votePostId, true);
        if (admission === "not-found") return json(404, notFoundError);
        if (admission === "forbidden") return json(403, forbiddenError);
        if (method === "PUT") {
          if (!isJsonContentType(headers["content-type"])) return json(422, invalidVoteError);
          const value = validateVote(parseVoteJson(request.payload));
          if (value === undefined) return json(422, invalidVoteError);
          const result = votes.set(account.id, votePostId, value);
          if (result.kind === "success") return json(200, result.vote);
          if (result.kind === "not-found") return json(404, notFoundError);
          if (result.kind === "forbidden") return json(403, forbiddenError);
          return json(503, voteUnavailableError);
        }
        const result = votes.clear(account.id, votePostId);
        if (result.kind === "success") return empty(204);
        if (result.kind === "not-found") return json(404, notFoundError);
        if (result.kind === "forbidden") return json(403, forbiddenError);
        return json(503, voteUnavailableError);
      }
      const postRoute = postPath(url.pathname);
      if (postRoute && method === "GET") {
        if (postRoute.media) {
          const media = posts.media(postRoute.id);
          return media ? binary(media.media_content_type, media.media_bytes) : json(404, notFoundError);
        }
        if (!account) {
          const post = posts.get(postRoute.id);
          return post ? json(200, post) : json(404, notFoundError);
        }
        const result = personal.readAndRecord(account.id, postRoute.id);
        if (result.kind === "success") return json(200, result.post);
        if (result.kind === "lost-authority") return json(401, authenticationError);
        if (result.kind === "not-found") return json(404, notFoundError);
        return json(503, personalUnavailableError);
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

  // Existing durable accepted work is resumed after composition is complete.
  schedulePrivacy();
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
    /** @param {{eventKey: string}} request */
    async retryNotificationDelivery(request) {
      return handle({ method: "POST", path: "/api/notifications/delivery/retry", headers: { "content-type": "application/json" }, payload: JSON.stringify(request) }, deliveryCapability);
    },
    config,
    database,
    /** Trusted in-process test/recovery seam; no HTTP worker-control operation exists. */
    drainPrivacy: () => privacyWorker.drain(),
    accountCount: () => authRepository.accountCount(),
    close: () => { privacyWorker.close(); if (ownDatabase) database.close(); },
  };
}
