// Runtime imports are exercised by the Node 24 tests; local module contracts are checked below.
// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { readFileSync } from "node:fs";
// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { DatabaseSync } from "node:sqlite";

/**
 * @typedef {object} Database
 * @property {(sql: string) => void} exec
 * @property {(sql: string) => any} prepare
 * @property {() => void} close
 */

const bootstrapMigration = readFileSync(new URL("../migrations/001-auth.sql", import.meta.url), "utf8")
  .replace("CREATE TABLE users", "CREATE TABLE IF NOT EXISTS users")
  .replace("CREATE TABLE sessions", "CREATE TABLE IF NOT EXISTS sessions")
  .replace("CREATE INDEX sessions_user_id", "CREATE INDEX IF NOT EXISTS sessions_user_id");
const profileMigration = readFileSync(new URL("../migrations/002-profiles.sql", import.meta.url), "utf8");

/**
 * @param {Database} database
 */
function migrate(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(bootstrapMigration);
    const version = /** @type {{user_version: number}} */ (database.prepare("PRAGMA user_version").get()).user_version;
    if (version < 2) {
      database.exec(profileMigration);
      database.exec("PRAGMA user_version = 2");
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/**
 * @param {string} path
 * @returns {Database}
 */
export function openDatabase(path) {
  const database = new DatabaseSync(path);
  try {
    migrate(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
