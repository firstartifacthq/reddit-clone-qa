import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

const preFeedMigrations = ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql", "006-votes.sql", "006-personal-state.sql"];
function migration(name) { return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"); }
async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function seedAuthority(database) {
  database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "feed-owner", "salt", "verifier", 1);
  database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("feed", "Feed", "owner", 1);
  database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("post", "feed", "owner", "text", "Title", "text", 1);
}
function createVersion8(path, mutate = (sql) => sql) {
  const database = new DatabaseSync(path);
  for (const name of preFeedMigrations) database.exec(migration(name));
  const original = migration("007-feeds.sql");
  const changed = mutate(original);
  assert.notEqual(changed, original, "damage case must alter the feed migration");
  database.exec(changed);
  database.exec("PRAGMA user_version = 8");
  database.close();
}

// This helper makes one deliberate schema mutation while keeping every other
// version-8 declaration identical to the production migration.
function replacing(before, after) {
  return (sql) => {
    assert.equal(sql.includes(before), true, `missing schema fragment: ${before}`);
    return sql.replace(before, after);
  };
}

test("feed migration upgrades a version 7 post with a stable publication time", async () => withDirectory(async (directory) => {
  const path = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  for (const name of preFeedMigrations) legacy.exec(migration(name));
  legacy.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "legacy-owner", "salt", "verifier", 1);
  legacy.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("legacy", "Legacy", "owner", 1);
  legacy.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "legacy", "owner", "text", "Title", "text");
  legacy.exec("PRAGMA user_version = 7"); legacy.close();

  const upgraded = openDatabase(path);
  const published = upgraded.prepare("SELECT published_at FROM posts WHERE id = 'post'").get().published_at;
  assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 8);
  assert.equal(Number.isInteger(published) && published >= 0, true);
  upgraded.close();
}));

test("feed migration creates exact immutable durable feed state", async () => withDirectory(async (directory) => {
  const path = join(directory, "feed.sqlite");
  const database = openDatabase(path);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 8);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('feed_traversals', 'feed_traversal_items', 'feed_page_tokens')").get().count, 3);
  seedAuthority(database);

  for (const values of [
    ["home", null, "owner"],
    ["popular", null, null],
    ["popular", null, "owner"],
    ["community", "feed", null],
    ["community", "feed", "owner"],
  ]) database.prepare("INSERT INTO feed_traversals (id, feed_kind, community_name, requester_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, 1, 2)").run(`traversal-${values.join("-")}`, ...values);
  for (const [kind, community, requester] of [["home", null, null], ["home", "feed", "owner"], ["popular", "feed", null], ["community", null, null]]) {
    assert.throws(() => database.prepare("INSERT INTO feed_traversals (id, feed_kind, community_name, requester_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, 1, 2)").run(`illegal-${kind}-${community}-${requester}`, kind, community, requester));
  }

  database.prepare("INSERT INTO feed_traversal_items (traversal_id, ordinal, post_id) VALUES (?, ?, ?)").run("traversal-popular--", 0, "post");
  database.prepare("INSERT INTO feed_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)").run("token", "traversal-popular--", 1);
  assert.throws(() => database.prepare("UPDATE posts SET published_at = 2 WHERE id = 'post'").run(), /immutable/);
  assert.throws(() => database.prepare("UPDATE feed_traversals SET expires_at = 3 WHERE id = 'traversal-popular--'").run(), /immutable/);
  assert.throws(() => database.prepare("UPDATE feed_traversal_items SET ordinal = 2 WHERE traversal_id = 'traversal-popular--'").run(), /immutable/);
  assert.throws(() => database.prepare("UPDATE feed_page_tokens SET start_ordinal = 2 WHERE token = 'token'").run(), /immutable/);

  database.prepare("DELETE FROM posts WHERE id = 'post'").run();
  assert.equal(database.prepare("SELECT post_id FROM feed_traversal_items").get().post_id, "post", "snapshot identity intentionally outlives a deleted post");
  database.prepare("DELETE FROM feed_traversals WHERE id = 'traversal-popular--'").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feed_traversal_items").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feed_page_tokens").get().count, 0);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
  openDatabase(path).close();
}));

test("feed startup rejects every damaged declarative schema invariant family", async (t) => {
  const cases = [
    ["published_at default", replacing("published_at INTEGER NOT NULL DEFAULT 0", "published_at INTEGER NOT NULL DEFAULT 1")],
    ["published_at check", replacing("published_at >= 0", "published_at >= -1")],
    ["feed kind check", replacing("feed_kind IN ('home', 'popular', 'community')", "feed_kind IN ('home', 'popular', 'community', 'other')")],
    ["home context shape", replacing("feed_kind = 'home' AND requester_user_id IS NOT NULL", "feed_kind = 'home' AND requester_user_id IS NULL")],
    ["popular context shape", replacing("feed_kind = 'popular' AND community_name IS NULL", "feed_kind = 'popular' AND community_name IS NOT NULL")],
    ["community context shape", replacing("feed_kind = 'community' AND community_name IS NOT NULL", "feed_kind = 'community' AND community_name IS NULL")],
    ["created time check", replacing("created_at >= 0", "created_at >= -1")],
    ["expiry check", replacing("expires_at > created_at", "expires_at >= created_at")],
    ["item ordinal check", replacing("ordinal >= 0", "ordinal >= -1")],
    ["token start check", replacing("start_ordinal >= 0", "start_ordinal >= -1")],
    ["declared column", replacing("post_id TEXT NOT NULL,", "post_id BLOB NOT NULL,")],
    ["item foreign-key endpoint", replacing("feed_traversal_items (\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id)", "feed_traversal_items (\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(expires_at)")],
    ["item foreign-key action", replacing("feed_traversal_items (\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE", "feed_traversal_items (\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE RESTRICT")],
    ["token foreign-key endpoint", replacing("feed_page_tokens (\n  token TEXT PRIMARY KEY NOT NULL,\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id)", "feed_page_tokens (\n  token TEXT PRIMARY KEY NOT NULL,\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(expires_at)")],
    ["token foreign-key action", replacing("feed_page_tokens (\n  token TEXT PRIMARY KEY NOT NULL,\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE", "feed_page_tokens (\n  token TEXT PRIMARY KEY NOT NULL,\n  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE RESTRICT")],
    ["unexpected post foreign key", replacing("post_id TEXT NOT NULL,", "post_id TEXT NOT NULL REFERENCES posts(id),")],
    ["item uniqueness", replacing(",\n  UNIQUE (traversal_id, post_id)", "")],
    ["token uniqueness", replacing(",\n  UNIQUE (traversal_id, start_ordinal)", "")],
    ["named-index uniqueness", replacing("CREATE INDEX posts_feed_publication", "CREATE UNIQUE INDEX posts_feed_publication")],
    ["named-index direction", replacing("posts_feed_publication ON posts(published_at DESC", "posts_feed_publication ON posts(published_at ASC")],
    ["named-index collation", replacing("posts_feed_publication ON posts(published_at DESC", "posts_feed_publication ON posts(published_at COLLATE NOCASE DESC")],
    ["community index order", replacing("community_name, published_at DESC", "community_name, published_at ASC")],
    ["membership index order", replacing("community_memberships(user_id, community_name)", "community_memberships(community_name, user_id)")],
    ["expiry index direction", replacing("feed_traversals(expires_at)", "feed_traversals(expires_at DESC)")],
    ["publication trigger", replacing("SELECT RAISE(ABORT, 'post publication time is immutable');", "SELECT 1;")],
    ["traversal trigger", replacing("SELECT RAISE(ABORT, 'feed traversal is immutable');", "SELECT 1;")],
    ["item trigger", replacing("SELECT RAISE(ABORT, 'feed traversal item is immutable');", "SELECT 1;")],
    ["token trigger", replacing("SELECT RAISE(ABORT, 'feed page token is immutable');", "SELECT 1;")],
  ];
  for (const [name, damage] of cases) await t.test(name, async () => withDirectory(async (directory) => {
    const path = join(directory, `${String(name).replaceAll(" ", "-")}.sqlite`);
    createVersion8(path, damage);
    assert.throws(() => openDatabase(path));
  }));
});

test("feed startup rejects every illegal persisted traversal context", async (t) => {
  for (const [name, kind, community, requester] of [
    ["home without requester", "home", null, null],
    ["home with community", "home", "feed", "owner"],
    ["popular with community", "popular", "feed", null],
    ["community without community", "community", null, null],
  ]) await t.test(name, async () => withDirectory(async (directory) => {
    const path = join(directory, `${name.replaceAll(" ", "-")}.sqlite`);
    const database = openDatabase(path); seedAuthority(database);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare("INSERT INTO feed_traversals (id, feed_kind, community_name, requester_user_id, created_at, expires_at) VALUES ('illegal', ?, ?, ?, 1, 2)").run(kind, community, requester);
    database.close();
    assert.throws(() => openDatabase(path), /feed invariant is invalid/);
  }));
});
