import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

test("safety controls migrate a populated version 9 database and persist directional authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-safety-migration-")); const path = join(directory, "database.sqlite");
  try {
    const legacy = new DatabaseSync(path); for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql", "006-votes.sql", "006-personal-state.sql", "007-feeds.sql", "008-moderation.sql"]) legacy.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")); legacy.exec("PRAGMA user_version = 9"); legacy.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "owner", "salt", "verifier", 0); legacy.close();
    const upgraded = openDatabase(path); assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 10); assert.deepEqual(upgraded.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('user_blocks', 'post_creation_events') ORDER BY name").all().map((row) => row.name), ["post_creation_events", "user_blocks"]); upgraded.close();
    const reopened = openDatabase(path); assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("safety controls reject damaged owner, rate-event, index, and immutability invariants", async (t) => {
  const cases = [
    ["self block check", (db) => rewrite(db, "user_blocks", "CHECK (blocker_user_id <> blocked_user_id)", "CHECK (1)")],
    ["event timestamp check", (db) => rewrite(db, "post_creation_events", "CHECK (typeof(created_at) = 'integer' AND created_at >= 0)", "CHECK (1)")],
    ["event order index", (db) => db.exec("DROP INDEX post_creation_events_user_created; CREATE INDEX post_creation_events_user_created ON post_creation_events(created_at, user_id)")],
    ["event immutable trigger", (db) => db.exec("DROP TRIGGER post_creation_events_are_immutable; CREATE TRIGGER post_creation_events_are_immutable BEFORE UPDATE ON post_creation_events BEGIN SELECT 1; END")],
    ["illegal persisted event", (db) => { db.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("damage", "damage", "salt", "verifier", 0); db.exec("PRAGMA ignore_check_constraints = ON"); db.prepare("INSERT INTO post_creation_events (id, user_id, post_id, created_at) VALUES (?, ?, ?, ?)").run("event", "damage", "post", -1); db.exec("PRAGMA ignore_check_constraints = OFF"); }],
  ];
  for (const [name, damage] of cases) await t.test(name, async () => { const directory = await mkdtemp(join(tmpdir(), "reddit-safety-damaged-")); const path = join(directory, "database.sqlite"); try { const good = openDatabase(path); good.close(); const db = new DatabaseSync(path); damage(db); db.close(); assert.throws(() => openDatabase(path), /safety controls invariant|malformed database schema/); } finally { await rm(directory, { recursive: true, force: true }); } });
});
function rewrite(db, table, from, to) { db.enableDefensive(false); db.exec("PRAGMA writable_schema = ON"); assert.equal(db.prepare("UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE name = ?").run(from, to, table).changes, 1); db.exec("PRAGMA writable_schema = OFF"); }
