import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("profile migration creates and reopens the lifecycle schema", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "fresh.sqlite");
    const database = openDatabase(path);
    const columns = database.prepare("PRAGMA table_info(users)").all();
    assert.ok(columns.some((column) => column.name === "bio"));
    assert.ok(columns.some((column) => column.name === "revision"));
    assert.ok(columns.some((column) => column.name === "deletion_requested_at"));
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 9);
    database.close();
    const reopened = openDatabase(path);
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 9);
    reopened.close();
  });
});

test("profile migration upgrades populated baseline data and enforces ASCII case-insensitive usernames", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_verifier TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX sessions_user_id ON sessions(user_id);
      INSERT INTO users VALUES ('one', 'RiverStone', 'salt', 'verifier', 1);`);
    legacy.close();
    const upgraded = openDatabase(path);
    const upgradedUser = upgraded.prepare("SELECT bio, revision, deletion_requested_at FROM users WHERE id = 'one'").get();
    assert.equal(upgradedUser.bio, "");
    assert.equal(upgradedUser.revision, 0);
    assert.equal(upgradedUser.deletion_requested_at, null);
    assert.throws(() => upgraded.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES ('two', 'riverstone', 'salt', 'verifier', 2)").run(), /UNIQUE constraint failed/);
    upgraded.close();
  });
});

test("profile migration fails closed on legacy case collisions", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "collision.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_verifier TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX sessions_user_id ON sessions(user_id);
      INSERT INTO users VALUES ('one', 'River', 'salt', 'verifier', 1);
      INSERT INTO users VALUES ('two', 'river', 'salt', 'verifier', 2);`);
    legacy.close();
    assert.throws(() => openDatabase(path), /UNIQUE constraint failed/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(check.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "bio"), false);
    check.close();
  });
});
