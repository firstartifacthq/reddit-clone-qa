/**
 * @typedef {object} Statement
 * @property {(...parameters: any[]) => unknown} run
 * @property {(...parameters: any[]) => unknown} get
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */
/** @typedef {{id: string, username: string, salt: string, verifier: string, createdAt: number}} NewUser */
/** @typedef {{id: string, username: string, password_salt: string, password_verifier: string, deletion_requested_at: number | null}} StoredUser */
/** @typedef {{digest: string, userId: string, issuedAt: number, expiresAt: number}} NewSession */
/** @typedef {{id: string, username: string, expires_at: number, revoked_at: number | null}} SessionAccountRow */

export class AuthRepository {
  /** @param {Database} database */
  constructor(database) {
    this.insertUser = database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
    this.findUser = database.prepare("SELECT id, username, password_salt, password_verifier, deletion_requested_at FROM users WHERE username = ? COLLATE NOCASE");
    this.insertSession = database.prepare("INSERT INTO sessions (token_digest, user_id, issued_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)");
    this.findSessionAccount = database.prepare(`SELECT users.id, users.username, sessions.expires_at, sessions.revoked_at
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_digest = ? AND users.deletion_requested_at IS NULL`);
    this.revokeSession = database.prepare("UPDATE sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL");
    this.countUsers = database.prepare("SELECT COUNT(*) AS count FROM users WHERE id <> '__privacy_tombstone__'");
  }

  /** @param {NewUser} user */
  createUser(user) { this.insertUser.run(user.id, user.username, user.salt, user.verifier, user.createdAt); }

  /** @param {string} username @returns {StoredUser | undefined} */
  findUserByUsername(username) { return /** @type {StoredUser | undefined} */ (this.findUser.get(username)); }

  /** @param {NewSession} session */
  createSession(session) { this.insertSession.run(session.digest, session.userId, session.issuedAt, session.expiresAt); }

  /** @param {string} digest @param {number} now @returns {{id: string, username: string} | undefined} */
  findAuthorizedAccount(digest, now) {
    const session = /** @type {SessionAccountRow | undefined} */ (this.findSessionAccount.get(digest));
    if (!session || session.revoked_at !== null || session.expires_at <= now) return undefined;
    return { id: session.id, username: session.username };
  }

  /** @param {string} digest @param {number} now */
  revoke(digest, now) { this.revokeSession.run(now, digest); }

  /** @returns {number} */
  accountCount() { return /** @type {{count: number}} */ (this.countUsers.get()).count; }
}
