import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(new URL("../migrations/001-auth.sql", import.meta.url), "utf8")
  .replace("CREATE TABLE users", "CREATE TABLE IF NOT EXISTS users")
  .replace("CREATE TABLE sessions", "CREATE TABLE IF NOT EXISTS sessions")
  .replace("CREATE INDEX sessions_user_id", "CREATE INDEX IF NOT EXISTS sessions_user_id");

export function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(migration);
  return database;
}
