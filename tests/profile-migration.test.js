import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

const legacyMigration = await readFile(new URL("../migrations/001-auth.sql", import.meta.url), "utf8");

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-profile-migration-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("profile migration upgrades legacy accounts with default public fields and is repeatable", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(legacyMigration);
    legacy.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-id", "legacy-user", "salt", "verifier", 1);
    legacy.close();

    const upgraded = openDatabase(path);
    assert.deepEqual({ ...upgraded.prepare("SELECT bio, revision, deletion_requested_at FROM users WHERE id = ?").get("legacy-id") }, {
      bio: "", revision: 0, deletion_requested_at: null,
    });
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 2);
    upgraded.close();

    const repeated = openDatabase(path);
    assert.equal(repeated.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
    repeated.close();
  });
});

test("profile migration fails closed when legacy usernames collide by case", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "collision.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(legacyMigration);
    const insert = legacy.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
    insert.run("first", "Alpha", "salt", "verifier", 1);
    insert.run("second", "alpha", "salt", "verifier", 1);
    legacy.close();

    assert.throws(() => openDatabase(path), /UNIQUE constraint failed/i);
    const unchanged = new DatabaseSync(path);
    assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(unchanged.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "bio"), false);
    unchanged.close();
  });
});
