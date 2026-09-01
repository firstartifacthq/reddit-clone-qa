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

const authMigration = readFileSync(new URL("../migrations/001-auth.sql", import.meta.url), "utf8")
  .replace("CREATE TABLE users", "CREATE TABLE IF NOT EXISTS users")
  .replace("CREATE TABLE sessions", "CREATE TABLE IF NOT EXISTS sessions")
  .replace("CREATE INDEX sessions_user_id", "CREATE INDEX IF NOT EXISTS sessions_user_id");
const communitiesMigration = readFileSync(new URL("../migrations/002-communities.sql", import.meta.url), "utf8");

/**
 * @param {string} path
 * @returns {Database}
 */
export function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(authMigration);
  database.exec(communitiesMigration);
  return database;
}
