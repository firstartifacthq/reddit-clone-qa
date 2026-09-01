/**
 * @typedef {object} Statement
 * @property {(...parameters: any[]) => unknown} run
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
 * @property {number} expires_at
 * @property {number | null} revoked_at
 */

export class AuthRepository {
  /** @param {Database} database */
  constructor(database) {
    this.database = database;
    this.insertUser = database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
    this.findUser = database.prepare("SELECT id, username, password_salt, password_verifier FROM users WHERE username = ?");
    this.insertSession = database.prepare("INSERT INTO sessions (token_digest, user_id, issued_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)");
    this.findSessionAccount = database.prepare(`SELECT users.id, users.username, sessions.expires_at, sessions.revoked_at
      FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_digest = ?`);
    this.revokeSession = database.prepare("UPDATE sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL");
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
    this.insertSession.run(session.digest, session.userId, session.issuedAt, session.expiresAt);
  }

  /**
   * @param {string} digest
   * @param {number} now
   * @returns {{id: string, username: string} | undefined}
   */
  findAuthorizedAccount(digest, now) {
    const session = /** @type {SessionAccountRow | undefined} */ (this.findSessionAccount.get(digest));
    if (!session || session.revoked_at !== null || session.expires_at <= now) return undefined;
    return { id: session.id, username: session.username };
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
