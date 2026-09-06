import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-comment-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("comment migration preserves structural and tombstone constraints through version 7", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "comments.sqlite"); const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 13);
    database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "owner-user", "salt", "verifier", 1);
    database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("comments", "Comments", "owner", 1);
    database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "comments", "owner", "text", "Title", "text");
    database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("other-post", "comments", "owner", "text", "Other", "text");
    database.prepare("INSERT INTO comments (id, post_id, parent_id, author_user_id, body, depth, state, created_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("root", "post", null, "owner", "body", 0, "active", 1);
    database.prepare("INSERT INTO comments (id, post_id, parent_id, author_user_id, body, depth, state, created_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("child", "post", "root", "owner", "child", 1, "active", 2);
    assert.throws(() => database.prepare("UPDATE comments SET depth = 2 WHERE id = 'root'").run());
    assert.throws(() => database.prepare("INSERT INTO comments (id, post_id, author_user_id, body, depth, state, created_sequence) VALUES ('bad', 'post', 'owner', 'body', 1, 'active', 3)").run());
    assert.throws(() => database.prepare("INSERT INTO comments (id, post_id, author_user_id, body, depth, state, created_sequence) VALUES ('bad-delete', 'post', 'owner', 'body', 0, 'deleted', 3)").run());
    database.prepare("INSERT INTO comments (id, post_id, author_user_id, body, depth, state, created_sequence) VALUES ('other-root', 'other-post', 'owner', 'other', 0, 'active', 3)").run();
    database.prepare("UPDATE comments SET state = 'deleted', author_user_id = NULL, body = NULL WHERE id = 'root'").run();
    assert.throws(() => database.prepare("UPDATE comments SET state = 'active', author_user_id = 'owner', body = 'restored' WHERE id = 'root'").run());
    database.prepare("INSERT INTO comment_traversals (id, post_id) VALUES ('traversal', 'post')").run();
    assert.throws(() => database.prepare("INSERT INTO comment_traversal_items (traversal_id, ordinal, comment_id) VALUES ('traversal', 0, 'missing')").run());
    assert.throws(() => database.prepare("INSERT INTO comment_traversal_items (traversal_id, ordinal, comment_id) VALUES ('traversal', 0, 'other-root')").run());
    database.prepare("INSERT INTO comment_traversal_items (traversal_id, ordinal, comment_id) VALUES ('traversal', 0, 'root')").run();
    database.prepare("INSERT INTO comment_page_tokens (token, traversal_id, start_ordinal) VALUES ('token', 'traversal', 0)").run();
    database.prepare("DELETE FROM posts WHERE id IN ('post', 'other-post')").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM comments").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM comment_traversals").get().count, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); database.close();
    const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 13); reopened.close();
  });
});

test("comment startup fails closed when a durable schema guard is absent", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "missing-comment-guard.sqlite");
    openDatabase(path).close();
    const damaged = new DatabaseSync(path);
    damaged.exec("DROP TRIGGER comments_deletion_is_one_way");
    damaged.close();
    assert.throws(() => openDatabase(path), /comment invariant is invalid/);
  });
});

test("comment migration upgrades a populated version 4 database", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "version-4.sqlite"); const legacy = new DatabaseSync(path);
    for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql"]) legacy.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    legacy.exec("PRAGMA user_version = 4"); legacy.close();
    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 13);
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('comments', 'comment_traversals', 'comment_traversal_items', 'comment_page_tokens')").get().count, 4);
    assert.equal(upgraded.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); upgraded.close();
  });
});
