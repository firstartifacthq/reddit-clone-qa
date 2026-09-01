import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

export class SqliteStore {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    migrate(this.database);
  }

  createAccount(username, passwordHash, createdAt) {
    const statement = this.database.prepare("INSERT INTO accounts (username, password_hash, created_at) VALUES (?, ?, ?)");
    const result = statement.run(username, passwordHash, createdAt);
    return { id: Number(result.lastInsertRowid), username };
  }

  findAccountByUsername(username) {
    return this.database.prepare("SELECT id, username, password_hash FROM accounts WHERE username = ?").get(username) ?? null;
  }

  createSession(tokenDigest, accountId, expiresAt) {
    this.database.prepare("INSERT INTO sessions (token_digest, account_id, expires_at, revoked_at) VALUES (?, ?, ?, NULL)").run(tokenDigest, accountId, expiresAt);
  }

  findActiveSession(tokenDigest, now) {
    return this.database.prepare(`
      SELECT accounts.id, accounts.username
      FROM sessions JOIN accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_digest = ?
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > ?
    `).get(tokenDigest, now) ?? null;
  }

  revokeSession(tokenDigest, revokedAt) {
    return this.database.prepare("UPDATE sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL").run(revokedAt, tokenDigest).changes;
  }

  transaction(work) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  accountCount() {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM accounts").get().count);
  }

  close() {
    this.database.close();
  }
}
