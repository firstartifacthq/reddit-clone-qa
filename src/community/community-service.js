import { normalizeUsername } from "../account/username.js";
import { validateCommunityCreate, validateModeratorChange } from "./community-validation.js";

/** @typedef {import("./community-repository.js").CommunityRepository} CommunityRepository */
/** @typedef {{exec: (sql: string) => void}} Database */

/** @param {Database} database */
function rollback(database) {
  try { database.exec("ROLLBACK"); } catch {}
}

/** @param {unknown} error */
function isDuplicateName(error) {
  return error instanceof Error && /UNIQUE constraint failed: communities\.canonical_name/i.test(error.message);
}

export class CommunityService {
  /** @param {{repository: CommunityRepository, database: Database, now?: () => number}} options */
  constructor({ repository, database, now = Date.now }) {
    this.repository = repository;
    this.database = database;
    this.now = now;
  }

  /** @param {string} ownerId @param {unknown} body */
  create(ownerId, body) {
    const community = validateCommunityCreate(body);
    if (!community) return { kind: /** @type {const} */ ("invalid") };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.repository.createCommunity({ ...community, ownerId, createdAt: this.now() });
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("created") };
    } catch (error) {
      rollback(this.database);
      if (isDuplicateName(error)) return { kind: /** @type {const} */ ("duplicate") };
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }

  /** @param {string} userId @param {string} communityName */
  join(userId, communityName) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.communityByName(communityName)) {
        rollback(this.database);
        return { kind: /** @type {const} */ ("not-found") };
      }
      this.repository.joinUser(communityName, userId);
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success") };
    } catch {
      rollback(this.database);
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }

  /** @param {string} userId @param {string} communityName */
  leave(userId, communityName) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.communityByName(communityName)) {
        rollback(this.database);
        return { kind: /** @type {const} */ ("not-found") };
      }
      this.repository.leaveUser(communityName, userId);
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success") };
    } catch {
      rollback(this.database);
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }

  /** @param {string} requesterId @param {string} communityName @param {unknown} body */
  changeModerator(requesterId, communityName, body) {
    const change = validateModeratorChange(body);
    if (!change) return { kind: /** @type {const} */ ("invalid") };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const community = this.repository.communityByName(communityName);
      if (!community) {
        rollback(this.database);
        return { kind: /** @type {const} */ ("not-found") };
      }
      // Do not reveal target account state to requesters without owner authority.
      if (community.owner_user_id !== requesterId) {
        rollback(this.database);
        return { kind: /** @type {const} */ ("forbidden") };
      }
      const username = normalizeUsername(change.username);
      const target = username && this.repository.activeUserByUsername(username);
      if (!target || target.id === community.owner_user_id || this.repository.setNonOwnerRole(communityName, target.id, change.role) !== 1) {
        rollback(this.database);
        return { kind: /** @type {const} */ ("not-found") };
      }
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success") };
    } catch {
      rollback(this.database);
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }

  /** @param {string} userId @param {string} communityName */
  admitModlog(userId, communityName) {
    if (!this.repository.communityByName(communityName)) return { kind: /** @type {const} */ ("not-found") };
    const role = this.repository.roleForUser(communityName, userId)?.role;
    return role === "owner" || role === "moderator"
      ? { kind: /** @type {const} */ ("admitted") }
      : { kind: /** @type {const} */ ("forbidden") };
  }

  list() { return this.repository.listCommunityNames(); }
}
