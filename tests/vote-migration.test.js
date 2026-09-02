import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-vote-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("vote migration upgrades v5, constrains current votes, cascades post deletion, and reopens", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "votes.sqlite");
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 6);
    const user = database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
    user.run("owner", "vote-owner", "salt", "verifier", 1);
    user.run("voter", "vote-voter", "salt", "verifier", 1);
    database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("votes", "Votes", "owner", 1);
    database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "votes", "owner", "text", "Title", "text");
    assert.equal(database.prepare("SELECT voting_state FROM posts WHERE id = ?").get("post").voting_state, "unlocked");
    database.prepare("INSERT INTO post_votes (post_id, voter_user_id, value) VALUES (?, ?, ?)").run("post", "voter", 1);
    assert.throws(() => database.prepare("INSERT INTO post_votes (post_id, voter_user_id, value) VALUES (?, ?, ?)").run("post", "voter", -1));
    assert.throws(() => database.prepare("INSERT INTO post_votes (post_id, voter_user_id, value) VALUES (?, ?, ?)").run("post", "owner", 0));
    database.prepare("DELETE FROM posts WHERE id = ?").run("post");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM post_votes").get().count, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.close();
    const reopened = openDatabase(path);
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 6);
    reopened.close();
  });
});

test("vote schema guard fails closed for a damaged vote table", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "damaged.sqlite");
    const database = openDatabase(path);
    database.close();
    const damaged = new DatabaseSync(path);
    damaged.exec("DROP TABLE post_votes; CREATE TABLE post_votes (post_id TEXT, voter_user_id TEXT, value INTEGER)");
    damaged.close();
    assert.throws(() => openDatabase(path), /vote invariant is invalid/);
  });
});
