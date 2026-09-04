import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) { const directory = await mkdtemp(join(tmpdir(), "reddit-personal-migration-")); try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
function migration(name) { return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"); }
function createVersion6(path, migrationName) {
  const database = new DatabaseSync(path);
  for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql", migrationName]) database.exec(migration(name));
  database.exec("PRAGMA user_version = 6");
  database.close();
}
function seedAuthority(database) {
  database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "owner-user", "salt", "verifier", 1);
  database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("personal", "Personal", "owner", 1);
  database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "personal", "owner", "text", "Title", "text");
}

test("colliding version 6 branches upgrade without losing either domain", async (t) => {
  for (const [name, migrationName] of [["vote-only", "006-votes.sql"], ["personal-only", "006-personal-state.sql"]]) {
    await t.test(name, async () => withDirectory(async (directory) => {
      const path = join(directory, `${name}.sqlite`);
      createVersion6(path, migrationName);
      const database = openDatabase(path);
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 9);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('post_votes', 'saved_posts')").get().count, 2);
      database.close();
    }));
  }
});

test("personal state migration upgrades version 5 and enforces immutable cascading state", async () => { await withDirectory(async (directory) => {
  const path = join(directory, "personal.sqlite"); const legacy = new DatabaseSync(path);
  for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql"]) legacy.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")); legacy.exec("PRAGMA user_version = 5"); legacy.close();
  const database = openDatabase(path); assert.equal(database.prepare("PRAGMA user_version").get().user_version, 9); seedAuthority(database);
  database.prepare("INSERT INTO saved_posts (user_id, post_id, saved_at) VALUES (?, ?, ?)").run("owner", "post", 1);
  database.prepare("INSERT INTO post_history (user_id, post_id, viewed_at) VALUES (?, ?, ?)").run("owner", "post", 1);
  database.prepare("INSERT INTO personal_traversals (id, user_id, listing_kind, snapshot_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run("traversal", "owner", "saved", "a".repeat(64), 1, 2);
  database.prepare("INSERT INTO personal_traversal_items (traversal_id, ordinal, post_id, event_at) VALUES (?, ?, ?, ?)").run("traversal", 0, "post", 1);
  database.prepare("INSERT INTO personal_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)").run("token", "traversal", 1);
  assert.throws(() => database.prepare("UPDATE personal_traversals SET listing_kind = 'history'").run(), /immutable/);
  assert.throws(() => database.prepare("UPDATE personal_traversal_items SET ordinal = 2").run(), /immutable/);
  assert.throws(() => database.prepare("UPDATE personal_page_tokens SET start_ordinal = 2").run(), /immutable/);
  assert.throws(() => database.prepare("INSERT INTO personal_traversals (id, user_id, listing_kind, snapshot_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run("invalid", "owner", "other", "b".repeat(64), 1, 2));
  assert.throws(() => database.prepare("INSERT INTO user_preferences (user_id, theme, compact_mode) VALUES (?, ?, ?)").run("owner", "invalid", 0));
  database.prepare("DELETE FROM posts WHERE id = 'post'").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM saved_posts UNION ALL SELECT COUNT(*) FROM post_history UNION ALL SELECT COUNT(*) FROM personal_traversal_items").all().every((row) => row.count === 0), true);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); database.close();
  const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 9); reopened.close();
}); });

test("fresh personal schema has exact keys, indexes, checks, foreign keys, and triggers", async () => { await withDirectory(async (directory) => {
  const path = join(directory, "fresh.sqlite"); const database = openDatabase(path);
  assert.deepEqual(database.prepare("PRAGMA index_xinfo(saved_posts_owner_order)").all().filter((part) => part.key === 1).map((part) => [part.name, part.desc]), [["user_id", 0], ["saved_at", 1], ["post_id", 0]]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_list(personal_traversal_items)").all().map((key) => [key.table, key.on_delete]).sort(), [["personal_traversals", "CASCADE"], ["posts", "CASCADE"]]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'personal_%_immutable'").get().count, 3);
  database.close();
}); });

test("personal state startup fails closed for every schema invariant family", async () => {
  const cases = [
    ["composite owner key", (database) => database.exec(`DROP TABLE saved_posts; CREATE TABLE saved_posts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      saved_at INTEGER NOT NULL CHECK (typeof(saved_at) = 'integer' AND saved_at >= 0));
      CREATE INDEX saved_posts_owner_order ON saved_posts(user_id, saved_at DESC, post_id ASC);`)],
    ["foreign-key action", (database) => database.exec(`DROP TABLE saved_posts; CREATE TABLE saved_posts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id TEXT NOT NULL REFERENCES posts(id),
      saved_at INTEGER NOT NULL CHECK (typeof(saved_at) = 'integer' AND saved_at >= 0), PRIMARY KEY (user_id, post_id));
      CREATE INDEX saved_posts_owner_order ON saved_posts(user_id, saved_at DESC, post_id ASC);`)],
    ["legal-value check", (database) => database.exec(`DROP TABLE user_preferences; CREATE TABLE user_preferences (
      user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE, theme TEXT NOT NULL,
      compact_mode INTEGER NOT NULL CHECK (typeof(compact_mode) = 'integer' AND compact_mode IN (0, 1)))`)],
    ["deterministic order index", (database) => database.exec("DROP INDEX saved_posts_owner_order; CREATE INDEX saved_posts_owner_order ON saved_posts(user_id, saved_at ASC, post_id ASC)")],
    ["token uniqueness", (database) => { database.exec("DROP TRIGGER personal_page_tokens_are_immutable; DROP TABLE personal_page_tokens"); database.exec(`CREATE TABLE personal_page_tokens (
      token TEXT PRIMARY KEY NOT NULL, traversal_id TEXT NOT NULL REFERENCES personal_traversals(id) ON DELETE CASCADE,
      start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0));
      CREATE TRIGGER personal_page_tokens_are_immutable BEFORE UPDATE ON personal_page_tokens BEGIN SELECT RAISE(ABORT, 'personal page token is immutable'); END;`); }],
    ["snapshot immutability", (database) => database.exec("DROP TRIGGER personal_traversal_items_are_immutable; CREATE TRIGGER personal_traversal_items_are_immutable BEFORE UPDATE ON personal_traversal_items BEGIN SELECT 1; END")],
  ];
  for (const [name, damage] of cases) await withDirectory(async (directory) => {
    const path = join(directory, `${String(name).replaceAll(" ", "-")}.sqlite`); openDatabase(path).close(); const damaged = new DatabaseSync(path); damage(damaged); damaged.close();
    assert.throws(() => openDatabase(path), /personal state invariant is invalid/, name);
  });
});
