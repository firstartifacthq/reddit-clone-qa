/**
 * @typedef {object} Statement
 * @property {(...parameters: any[]) => unknown} run
 * @property {(...parameters: any[]) => unknown} get
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */
/** @typedef {{id: string, username: string, bio: string, revision: number}} Profile */

export class ProfileRepository {
  /** @param {Database} database */
  constructor(database) {
    this.findOwner = database.prepare("SELECT id, username, bio, revision FROM users WHERE id = ? AND deletion_requested_at IS NULL");
    this.findPublic = database.prepare("SELECT id, username, bio, revision FROM users WHERE username = ? COLLATE NOCASE AND deletion_requested_at IS NULL");
    this.update = database.prepare(`UPDATE users
      SET username = COALESCE(?, username), bio = COALESCE(?, bio), revision = revision + 1
      WHERE id = ? AND deletion_requested_at IS NULL
      RETURNING id, username, bio, revision`);
    this.markDeletionRequested = database.prepare("UPDATE users SET deletion_requested_at = ? WHERE id = ? AND deletion_requested_at IS NULL");
    this.revokeUserSessions = database.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL");
  }

  /** @param {string} id @returns {Profile | undefined} */
  ownerById(id) {
    return /** @type {Profile | undefined} */ (this.findOwner.get(id));
  }

  /** @param {string} username @returns {Profile | undefined} */
  publicByUsername(username) {
    return /** @type {Profile | undefined} */ (this.findPublic.get(username));
  }

  /** @param {string} id @param {{username?: string, bio?: string}} patch @returns {Profile | undefined} */
  updateProfile(id, patch) {
    return /** @type {Profile | undefined} */ (this.update.get(patch.username ?? null, patch.bio ?? null, id));
  }

  /** @param {string} id @param {number} now */
  requestDeletion(id, now) {
    return /** @type {{changes: number}} */ (this.markDeletionRequested.run(now, id));
  }

  /** @param {string} id @param {number} now */
  revokeAllSessions(id, now) {
    this.revokeUserSessions.run(now, id);
  }
}
