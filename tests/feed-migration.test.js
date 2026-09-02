import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

test("feed migration upgrades a version 7 post with a stable publication time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-upgrade-")); const path = join(directory, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql", "006-votes.sql", "006-personal-state.sql"]) legacy.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    legacy.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "legacy-owner", "salt", "verifier", 1);
    legacy.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("legacy", "Legacy", "owner", 1);
    legacy.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "legacy", "owner", "text", "Title", "text");
    legacy.exec("PRAGMA user_version = 7"); legacy.close();
    const upgraded = openDatabase(path); const published = upgraded.prepare("SELECT published_at FROM posts WHERE id = 'post'").get().published_at;
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 8); assert.equal(Number.isInteger(published) && published >= 0, true); upgraded.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("feed migration creates immutable durable feed state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-migration-")); const path = join(directory, "feed.sqlite");
  try {
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('feed_traversals', 'feed_traversal_items', 'feed_page_tokens')").get().count, 3);
    database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "feed-owner", "salt", "verifier", 1);
    database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("feed", "Feed", "owner", 1);
    database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("post", "feed", "owner", "text", "Title", "text", 1);
    assert.throws(() => database.prepare("UPDATE posts SET published_at = 2 WHERE id = 'post'").run(), /immutable/);
    database.close();
    const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); reopened.close();
    const corrupt = new DatabaseSync(path); corrupt.exec("DROP TRIGGER feed_page_tokens_are_immutable"); corrupt.close();
    assert.throws(() => openDatabase(path), /feed invariant is invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
