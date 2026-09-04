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
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 9);
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM readable_posts").get().count, 0);
    upgraded.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("moderation schema exposes legal state and append-only audit guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-schema-")); const path = join(directory, "database.sqlite");
  try {
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 9);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('reports', 'moderation_audit_events', 'moderation_queue_traversals', 'moderation_queue_items', 'moderation_queue_tokens') ORDER BY name").all().map((row) => row.name), ["moderation_audit_events", "moderation_queue_items", "moderation_queue_tokens", "moderation_queue_traversals", "reports"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM readable_posts").get().count, 0);
    const postSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'posts'").get().sql;
    assert.match(postSql, /moderation_state TEXT NOT NULL DEFAULT 'active'/);
    database.close();
    const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 9); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
