export function migrate(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_digest TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_account_id_idx ON sessions(account_id);
    INSERT OR IGNORE INTO schema_versions(version) VALUES (1);
  `);
}
