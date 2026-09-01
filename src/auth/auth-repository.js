/**
 * @typedef {object} Statement
 * @property {(...parameters: any[]) => {changes?: number}} run
 * @property {(...parameters: any[]) => unknown} get
 */

/**
 * @typedef {object} Database
 * @property {(sql: string) => Statement} prepare
 */

/**
 * @typedef {object} NewUser
 * @property {string} id
 * @property {string} username
 * @property {string} salt
 * @property {string} verifier
 * @property {number} createdAt
 */

/**
 * @typedef {object} StoredUser
 * @property {string} id
 * @property {string} username
 * @property {string} password_salt
 * @property {string} password_verifier
 */

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} username
 * @property {string} bio
 * @property {number} revision
 */

/**
 * @typedef {object} NewSession
 * @property {string} digest
 * @property {string} userId
 * @property {number} issuedAt
 * @property {number} expiresAt
 */

/**
 * @typedef {object} SessionAccountRow
 * @property {string} id
 * @property {string} username
 * @property {string} bio
 * @property {number} revision
 * @property {number} expires_at
 * @property {number | null} revoked_at
 */

export class AuthRepository {
  /** @param {Database} database */
  constructor(database) {
    this.database = database;
    this.insertUser = database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
    this.findUser = database.prepare(`SELECT id, username, password_salt, password_verifier FROM users
      WHERE username = ? COLLATE NOCASE AND deletion_requested_at IS NULL`);
    this.insertSession = database.prepare(`INSERT INTO sessions (token_digest, user_id, issued_at, expires_at, revoked_at)
      SELECT ?, users.id, ?, ?, NULL FROM users WHERE users.id = ? AND users.deletion_requested_at IS NULL`);
    this.findSessionAccount = database.prepare(`SELECT users.id, users.username, users.bio, users.revision, sessions.expires_at, sessions.revoked_at
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_digest = ? AND users.deletion_requested_at IS NULL`);
    this.revokeSession = database.prepare("UPDATE sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL");
    this.updateProfile = database.prepare(`UPDATE users SET
      username = CASE WHEN ? THEN ? ELSE username END,
      bio = CASE WHEN ? THEN ? ELSE bio END,
      revision = revision + 1
      WHERE id = ? AND deletion_requested_at IS NULL
      RETURNING id, username, bio, revision`);
    this.findPublicProfile = database.prepare(`SELECT id, username, bio, revision FROM users
      WHERE username = ? COLLATE NOCASE AND deletion_requested_at IS NULL`);
    this.requestDeletion = database.prepare("UPDATE users SET deletion_requested_at = ? WHERE id = ? AND deletion_requested_at IS NULL");
    this.revokeUserSessions = database.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL");
    this.countUsers = database.prepare("SELECT COUNT(*) AS count FROM users");
  }

  /** @param {NewUser} user */
  createUser(user) {
    this.insertUser.run(user.id, user.username, user.salt, user.verifier, user.createdAt);
  }

  /**
   * @param {string} username
   * @returns {StoredUser | undefined}
   */
  findUserByUsername(username) {
    return /** @type {StoredUser | undefined} */ (this.findUser.get(username));
  }

  /** @param {NewSession} session */
  createSession(session) {
    return (this.insertSession.run(session.digest, session.issuedAt, session.expiresAt, session.userId).changes || 0) === 1;
  }

  /**
   * @param {string} digest
   * @param {number} now
   * @returns {Profile | undefined}
   */
  findAuthorizedAccount(digest, now) {
    const session = /** @type {SessionAccountRow | undefined} */ (this.findSessionAccount.get(digest));
    if (!session || session.revoked_at !== null || session.expires_at <= now) return undefined;
    return { id: session.id, username: session.username, bio: session.bio, revision: session.revision };
  }

  /**
   * @param {string} userId
   * @param {{username?: string, bio?: string}} patch
   * @returns {Profile | undefined}
   */
  updateOwnerProfile(userId, patch) {
    return /** @type {Profile | undefined} */ (this.updateProfile.get(
      patch.username === undefined ? 0 : 1,
      patch.username || "",
      patch.bio === undefined ? 0 : 1,
      patch.bio || "",
      userId,
    ));
  }

  /**
   * @param {string} username
   * @returns {Profile | undefined}
   */
  findActivePublicProfile(username) {
    return /** @type {Profile | undefined} */ (this.findPublicProfile.get(username));
  }

  /**
   * @param {string} userId
   * @param {number} now
   * @returns {boolean}
   */
  deleteActiveAccount(userId, now) {
    if ((this.requestDeletion.run(now, userId).changes || 0) !== 1) return false;
    this.revokeUserSessions.run(now, userId);
    return true;
  }

  /**
   * @param {string} digest
   * @param {number} now
   */
  revoke(digest, now) {
    this.revokeSession.run(now, digest);
  }

  /** @returns {number} */
  accountCount() {
    const row = /** @type {{count: number}} */ (this.countUsers.get());
    return row.count;
  }
}
