import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

test("moderation migration upgrades populated version 8 posts to durable active state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-migration-")); const path = join(directory, "database.sqlite");
  try {
    const legacy = new DatabaseSync(path); const names = ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql", "006-votes.sql", "006-personal-state.sql", "007-feeds.sql"];
    for (const name of names) legacy.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    legacy.exec("PRAGMA user_version = 8"); legacy.close();
    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 13);
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM readable_posts").get().count, 0);
    upgraded.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("moderation startup rejects every damaged declarative and persisted invariant family", async (t) => {
  const cases = [
    ["broadened readable view", (database) => database.exec("DROP VIEW readable_posts; CREATE VIEW readable_posts AS SELECT * FROM posts")],
    ["same-named no-op audit update trigger", (database) => database.exec("DROP TRIGGER moderation_audit_events_are_immutable; CREATE TRIGGER moderation_audit_events_are_immutable BEFORE UPDATE ON moderation_audit_events BEGIN SELECT 1; END")],
    ["same-named no-op audit delete trigger", (database) => database.exec("DROP TRIGGER moderation_audit_events_cannot_be_deleted; CREATE TRIGGER moderation_audit_events_cannot_be_deleted BEFORE DELETE ON moderation_audit_events BEGIN SELECT 1; END")],
    ["missing report identity uniqueness", (database) => rewriteSchema(database, "reports", "UNIQUE (reporter_user_id, post_id)", "CHECK (1)")],
    ["altered queue foreign-key endpoint", (database) => rewriteSchema(database, "moderation_queue_items", "REFERENCES reports(id)", "REFERENCES users(id)")],
    ["altered queue foreign-key action", (database) => rewriteSchema(database, "moderation_queue_tokens", "ON DELETE CASCADE", "ON DELETE SET NULL")],
    ["altered report index order", (database) => database.exec("DROP INDEX reports_community_order; CREATE INDEX reports_community_order ON reports(community_name, occurrence_sequence DESC, id)")],
    ["altered traversal index uniqueness", (database) => database.exec("DROP INDEX moderation_queue_traversals_owner_snapshot; CREATE UNIQUE INDEX moderation_queue_traversals_owner_snapshot ON moderation_queue_traversals(requester_user_id, authority_digest)")],
    ["missing traversal digest check", (database) => rewriteSchema(database, "moderation_queue_traversals", "CHECK (length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^0-9a-f]*')", "CHECK (1)")],
    ["altered moderation-state default", (database) => rewriteSchema(database, "posts", "moderation_state TEXT NOT NULL DEFAULT 'active'", "moderation_state TEXT NOT NULL DEFAULT 'removed'")],
    ["illegal persisted authority digest", (database) => {
      database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("damage-user", "damage-user", "salt", "verifier", 0);
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare("INSERT INTO moderation_queue_traversals (id, requester_user_id, authority_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run("damage-traversal", "damage-user", "G".repeat(64), 1, 2);
      database.exec("PRAGMA ignore_check_constraints = OFF");
    }],
    ["illegal persisted traversal expiry", (database) => {
      database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("damage-user", "damage-user", "salt", "verifier", 0);
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare("INSERT INTO moderation_queue_traversals (id, requester_user_id, authority_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run("damage-traversal", "damage-user", "a".repeat(64), 2, 1);
      database.exec("PRAGMA ignore_check_constraints = OFF");
    }],
  ];
  for (const [name, damage] of cases) await t.test(name, () => rejectsDamage(damage));
});

async function damagedDatabase(damage) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-damaged-")); const path = join(directory, "database.sqlite");
  const valid = openDatabase(path); valid.close();
  const database = new DatabaseSync(path); damage(database); database.close();
  return { directory, path };
}

async function rejectsDamage(damage) {
  const { directory, path } = await damagedDatabase(damage);
  try { assert.throws(() => openDatabase(path), /moderation invariant|malformed database schema/); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function rewriteSchema(database, name, from, to) {
  database.enableDefensive(false);
  database.exec("PRAGMA writable_schema = ON");
  const result = database.prepare("UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE name = ?").run(from, to, name);
  assert.equal(result.changes, 1);
  database.exec("PRAGMA writable_schema = OFF");
}

test("moderation schema exposes legal state and append-only audit guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-schema-")); const path = join(directory, "database.sqlite");
  try {
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 13);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('reports', 'moderation_audit_events', 'moderation_queue_traversals', 'moderation_queue_items', 'moderation_queue_tokens') ORDER BY name").all().map((row) => row.name), ["moderation_audit_events", "moderation_queue_items", "moderation_queue_tokens", "moderation_queue_traversals", "reports"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM readable_posts").get().count, 0);
    const postSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'posts'").get().sql;
    assert.match(postSql, /moderation_state TEXT NOT NULL DEFAULT 'active'/);
    database.close();
    const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 13); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
