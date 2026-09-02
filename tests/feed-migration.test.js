import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

function migration(name) { return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"); }
async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function populateVersion6(path) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql", "006-votes.sql"]) database.exec(migration(name));
  database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "feed-owner", "salt", "verifier", 1);
  database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("feeds", "Feeds", "owner", 1);
  const insert = database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, 'text', ?, ?)");
  insert.run("legacy-b", "feeds", "owner", "B", "B");
  insert.run("legacy-a", "feeds", "owner", "A", "A");
  database.exec("PRAGMA user_version = 6; COMMIT");
  database.close();
}

test("feed migration creates durable order and snapshot tables on clean and populated databases", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "feeds.sqlite");
    populateVersion6(path);
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 7);
    assert.deepEqual(database.prepare("SELECT post_id, sequence FROM post_creation_order ORDER BY sequence").all().map((row) => ({ ...row })), [
      { post_id: "legacy-b", sequence: 1 }, { post_id: "legacy-a", sequence: 2 },
    ]);
    database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, 'text', ?, ?)").run("later", "feeds", "owner", "Later", "Later");
    assert.deepEqual({ ...database.prepare("SELECT sequence FROM post_creation_order WHERE post_id = 'later'").get() }, { sequence: 3 });
    database.prepare("INSERT INTO feed_traversals (id, kind, community_name, principal_id, created_at, expires_at) VALUES (?, 'community', 'feeds', 'anonymous', 1, 2)").run("traversal");
    database.prepare("INSERT INTO feed_traversal_items (traversal_id, ordinal, post_id, score) VALUES ('traversal', 0, 'legacy-a', 0)").run();
    database.prepare("DELETE FROM posts WHERE id = 'legacy-a'").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feed_traversal_items").get().count, 1);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.close();
    const reopened = openDatabase(path);
    assert.equal(reopened.prepare("SELECT sequence FROM post_creation_order WHERE post_id = 'later'").get().sequence, 3);
    reopened.close();
  });
});

test("feed startup guard fails closed when creation-order trigger is removed", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "damaged.sqlite");
    const database = openDatabase(path);
    database.exec("DROP TRIGGER posts_assign_creation_order");
    database.close();
    assert.throws(() => openDatabase(path), /feed invariant is invalid/);
  });
});
