export class AuthRepository {
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

  createUser(user) {
    this.insertUser.run(user.id, user.username, user.salt, user.verifier, user.createdAt);
  }

  findUserByUsername(username) {
    return this.findUser.get(username);
  }

  createSession(session) {
    this.insertSession.run(session.digest, session.userId, session.issuedAt, session.expiresAt);
  }

  findAuthorizedAccount(digest, now) {
    const session = this.findSessionAccount.get(digest);
    if (!session || session.revoked_at !== null || session.expires_at <= now) return undefined;
    return { id: session.id, username: session.username };
  }

  revoke(digest, now) {
    this.revokeSession.run(now, digest);
  }

  accountCount() {
    return this.countUsers.get().count;
  }
}
