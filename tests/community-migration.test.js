import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-community-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("community migration creates version 3 and protects owner membership", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "fresh.sqlite");
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
    database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "owner-user", "salt", "verifier", 1);
    database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("community", "Community", "owner", 1);
    database.prepare("INSERT INTO community_memberships (community_name, user_id, role) VALUES (?, ?, ?)").run("community", "owner", "owner");
    assert.throws(() => database.prepare("DELETE FROM community_memberships WHERE community_name = ? AND user_id = ?").run("community", "owner"), /owner membership cannot be removed/);
    assert.throws(() => database.prepare("UPDATE community_memberships SET role = 'member' WHERE community_name = ? AND user_id = ?").run("community", "owner"), /owner membership is immutable/);
    database.close();
    const reopened = openDatabase(path);
    assert.equal(reopened.prepare("SELECT role FROM community_memberships").get().role, "owner");
    reopened.close();
  });
});

test("community migration upgrades a populated version 2 database", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_verifier TEXT NOT NULL, created_at INTEGER NOT NULL, bio TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), deletion_requested_at INTEGER);
      CREATE TABLE sessions (token_digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX sessions_user_id ON sessions(user_id);
      CREATE UNIQUE INDEX users_username_nocase ON users(username COLLATE NOCASE);
      PRAGMA user_version = 2;
      INSERT INTO users VALUES ('owner', 'owner-user', 'salt', 'verifier', 1, '', 0, NULL);`);
    legacy.close();
    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM communities").get().count, 0);
    upgraded.close();
  });
});
