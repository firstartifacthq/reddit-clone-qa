import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-post-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("post migration upgrades version 3 with typed aggregate and retry cascade", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "posts.sqlite");
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 7);
    const user = database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
    user.run("owner", "owner-user", "salt", "verifier", 1);
    database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("posts", "Posts", "owner", 1);
    database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "posts", "owner", "text", "Title", "text");
    database.prepare("INSERT INTO post_idempotency (author_user_id, community_name, idempotency_key, body_digest, post_id, response_json) VALUES (?, ?, ?, ?, ?, ?)").run("owner", "posts", "key", "digest", "post", "{}");
    assert.throws(() => database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content, url_content) VALUES (?, ?, ?, ?, ?, ?, ?)").run("bad", "posts", "owner", "text", "bad", "text", "url"));
    database.prepare("DELETE FROM posts WHERE id = ?").run("post");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM post_idempotency").get().count, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.close();
    const reopened = openDatabase(path);
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 7);
    reopened.close();
  });
});
