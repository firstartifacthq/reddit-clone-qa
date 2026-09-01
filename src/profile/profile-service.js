import { publicProfileRepresentation, ownerProfileRepresentation } from "./profile-representation.js";
import { validateProfilePatch } from "./profile-validation.js";

/** @typedef {import("./profile-repository.js").ProfileRepository} ProfileRepository */
/** @typedef {{exec: (sql: string) => void}} Database */

/** @param {Database} database */
function rollback(database) {
  try { database.exec("ROLLBACK"); } catch {}
}

/** @param {unknown} error */
function isConstraint(error) {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class ProfileService {
  /** @param {{repository: ProfileRepository, database: Database, now?: () => number}} options */
  constructor({ repository, database, now = Date.now }) {
    this.repository = repository;
    this.database = database;
    this.now = now;
  }

  /** @param {string} id */
  getOwner(id) {
    const profile = this.repository.ownerById(id);
    return profile ? ownerProfileRepresentation(profile) : undefined;
  }

  /** @param {string} username */
  getPublic(username) {
    const profile = this.repository.publicByUsername(username);
    return profile ? publicProfileRepresentation(profile) : undefined;
  }

  /** @param {string} id @param {unknown} body */
  edit(id, body) {
    const patch = validateProfilePatch(body);
    if (!patch) return { kind: /** @type {const} */ ("invalid") };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const profile = this.repository.updateProfile(id, patch);
      if (!profile) {
        rollback(this.database);
        return { kind: /** @type {const} */ ("lost-authority") };
      }
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success"), profile: ownerProfileRepresentation(profile) };
    } catch (error) {
      rollback(this.database);
      if (isConstraint(error)) return { kind: /** @type {const} */ ("conflict") };
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }

  /** @param {string} id */
  delete(id) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = this.repository.requestDeletion(id, this.now());
      if (result.changes !== 1) {
        rollback(this.database);
        return { kind: /** @type {const} */ ("lost-authority") };
      }
      this.repository.revokeAllSessions(id, this.now());
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success") };
    } catch {
      rollback(this.database);
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }
}
