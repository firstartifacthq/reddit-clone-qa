import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function migration(name) {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

function createPopulatedVersion5(path) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql"]) {
    database.exec(migration(name));
  }
  const user = database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
  user.run("owner", "vote-owner", "salt", "verifier", 1);
  user.run("voter", "vote-voter", "salt", "verifier", 1);
  database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("votes", "Votes", "owner", 1);
  database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("legacy-post", "votes", "owner", "text", "Legacy title", "legacy body");
  database.prepare("INSERT INTO comments (id, post_id, author_user_id, body, depth, state, created_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)").run("legacy-comment", "legacy-post", "voter", "legacy comment", 0, "active", 1);
  database.exec("PRAGMA user_version = 5; COMMIT");
  database.close();
}

function rewritePostsSchema(path, rewrite) {
  const database = new DatabaseSync(path);
  const original = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'posts'").get().sql;
  const damaged = rewrite(original);
  assert.notEqual(damaged, original);
  database.enableDefensive(false);
  database.exec("PRAGMA writable_schema = ON");
  database.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'posts'").run(damaged);
  database.exec("PRAGMA writable_schema = OFF");
  database.close();
}

function seedPost(database) {
  const user = database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)");
  user.run("owner", "vote-owner", "salt", "verifier", 1);
  database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("votes", "Votes", "owner", 1);
  database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "votes", "owner", "text", "Title", "text");
}

test("vote migration upgrades a populated v5 database, constrains votes, cascades, and reopens", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "votes.sqlite");
    createPopulatedVersion5(path);

    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 9);
    assert.deepEqual({ ...database.prepare("SELECT title, text_content, voting_state FROM posts WHERE id = ?").get("legacy-post") }, {
      title: "Legacy title", text_content: "legacy body", voting_state: "unlocked",
    });
    assert.deepEqual({ ...database.prepare("SELECT body, state FROM comments WHERE id = ?").get("legacy-comment") }, {
      body: "legacy comment", state: "active",
    });
    database.prepare("INSERT INTO post_votes (post_id, voter_user_id, value) VALUES (?, ?, ?)").run("legacy-post", "voter", 1);
    assert.throws(() => database.prepare("INSERT INTO post_votes (post_id, voter_user_id, value) VALUES (?, ?, ?)").run("legacy-post", "voter", -1));
    assert.throws(() => database.prepare("INSERT INTO post_votes (post_id, voter_user_id, value) VALUES (?, ?, ?)").run("legacy-post", "owner", 0));
    database.prepare("DELETE FROM posts WHERE id = ?").run("legacy-post");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM post_votes").get().count, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.close();

    const reopened = openDatabase(path);
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 9);
    reopened.close();
  });
});

test("vote schema guard rejects every damaged voting_state column contract", async (t) => {
  const cases = [
    ["missing CHECK", (sql) => sql.replace(/\s+CHECK\s*\(voting_state\s+IN\s*\('unlocked',\s*'locked'\)\)/i, "")],
    ["missing default", (sql) => sql.replace("voting_state TEXT NOT NULL DEFAULT 'unlocked'", "voting_state TEXT NOT NULL")],
    ["nullable", (sql) => sql.replace("voting_state TEXT NOT NULL", "voting_state TEXT")],
    ["wrong type", (sql) => sql.replace("voting_state TEXT", "voting_state INTEGER")],
  ];
  for (const [label, rewrite] of cases) {
    await t.test(label, async () => {
      await withDirectory(async (directory) => {
        const path = join(directory, "damaged.sqlite");
        const database = openDatabase(path);
        database.close();
        rewritePostsSchema(path, rewrite);
        assert.throws(() => openDatabase(path), /vote invariant is invalid/);
      });
    });
  }
});

test("vote schema guard rejects an illegal persisted voting state", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "illegal-state.sqlite");
    const database = openDatabase(path);
    seedPost(database);
    database.close();

    const damaged = new DatabaseSync(path);
    damaged.exec("PRAGMA ignore_check_constraints = ON");
    damaged.prepare("UPDATE posts SET voting_state = 'maintenance' WHERE id = ?").run("post");
    damaged.close();
    assert.throws(() => openDatabase(path), /vote invariant is invalid/);
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
