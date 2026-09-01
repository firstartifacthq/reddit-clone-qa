import { canonicalCommunityName, validCommunityName } from "./community-name.js";
import { membershipRepresentation, modlogRepresentation } from "./community-representation.js";

/**
 * @param {unknown} body
 * @returns {{username: string, moderator: boolean} | undefined}
 */
function validModeratorChange(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {{username?: unknown, moderator?: unknown}} */ (body);
  return typeof candidate.username === "string" && typeof candidate.moderator === "boolean"
    ? { username: candidate.username, moderator: candidate.moderator }
    : undefined;
}

/**
 * @typedef {object} Database
 * @property {(sql: string) => void} exec
 */

export class CommunityService {
  /** @param {{repository: import("./community-repository.js").CommunityRepository, database: Database}} options */
  constructor({ repository, database }) {
    this.repository = repository;
    this.database = database;
  }

  /** @param {{id: string, username: string}} actor @param {unknown} body */
  create(actor, body) {
    const name = validCommunityName(body);
    if (!name) return { kind: /** @type {const} */ ("invalid") };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.repository.createCommunity(name)) {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("duplicate") };
      }
      this.repository.createOwnerMembership(name, actor.id);
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success"), value: membershipRepresentation({ name }, { username: actor.username, role: "owner" }) };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** @param {{id: string, username: string}} actor @param {string | undefined} name */
  join(actor, name) {
    if (!name) return { kind: /** @type {const} */ ("missing") };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const community = this.repository.findCommunity(name);
      if (!community) {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("missing") };
      }
      this.repository.joinMembership(name, actor.id);
      const membership = this.repository.findMembership(name, actor.id);
      if (!membership) throw new Error("membership was not created");
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success"), value: membershipRepresentation(community, membership) };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** @param {{id: string}} actor @param {string | undefined} name */
  leave(actor, name) {
    if (!name) return { kind: /** @type {const} */ ("missing") };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const community = this.repository.findCommunity(name);
      const membership = community && this.repository.findMembership(name, actor.id);
      if (!community || !membership) {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("missing") };
      }
      if (membership.role === "owner") {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("forbidden") };
      }
      this.repository.removeNonOwnerMembership(name, actor.id);
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success") };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** @param {{id: string}} actor @param {string | undefined} name @param {unknown} body */
  setModerator(actor, name, body) {
    const change = validModeratorChange(body);
    if (!name || !change) return { kind: /** @type {const} */ ("invalid") };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const community = this.repository.findCommunity(name);
      if (!community) {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("missing") };
      }
      const actorMembership = this.repository.findMembership(name, actor.id);
      if (!actorMembership || actorMembership.role !== "owner") {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("forbidden") };
      }
      const target = this.repository.findMembershipByUsername(name, change.username);
      if (!target) {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("missing") };
      }
      if (target.role === "owner") {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("forbidden") };
      }
      const role = change.moderator ? "moderator" : "member";
      this.repository.updateNonOwnerRole(name, target.id, role);
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success"), value: membershipRepresentation(community, { username: target.username, role }) };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** @param {{id: string}} actor @param {string | undefined} name */
  modlog(actor, name) {
    if (!name) return { kind: /** @type {const} */ ("missing") };
    const community = this.repository.findCommunity(name);
    if (!community) return { kind: /** @type {const} */ ("missing") };
    const membership = this.repository.findMembership(name, actor.id);
    if (!membership || (membership.role !== "owner" && membership.role !== "moderator")) {
      return { kind: /** @type {const} */ ("forbidden") };
    }
    return { kind: /** @type {const} */ ("success"), value: modlogRepresentation(community) };
  }

  /** @param {unknown} value */
  communityPath(value) {
    return canonicalCommunityName(value);
  }

  rollback() {
    try { this.database.exec("ROLLBACK"); } catch {}
  }
}
