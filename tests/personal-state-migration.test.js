import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) { const directory = await mkdtemp(join(tmpdir(), "reddit-personal-migration-")); try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); } }

test("personal state migration upgrades version 5 and cascades post private state", async () => { await withDirectory(async (directory) => {
  const path = join(directory, "personal.sqlite"); const legacy = new DatabaseSync(path);
  for (const name of ["001-auth.sql", "002-profile-lifecycle.sql", "003-community-roles.sql", "004-posts.sql", "005-comments.sql"]) legacy.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")); legacy.exec("PRAGMA user_version = 5"); legacy.close();
  const database = openDatabase(path); assert.equal(database.prepare("PRAGMA user_version").get().user_version, 6);
  database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("owner", "owner-user", "salt", "verifier", 1);
  database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("personal", "Personal", "owner", 1);
  database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, ?, ?, ?)").run("post", "personal", "owner", "text", "Title", "text");
  database.prepare("INSERT INTO saved_posts (user_id, post_id, saved_at) VALUES (?, ?, ?)").run("owner", "post", 1); database.prepare("INSERT INTO post_history (user_id, post_id, viewed_at) VALUES (?, ?, ?)").run("owner", "post", 1);
  assert.throws(() => database.prepare("INSERT INTO user_preferences (user_id, theme, compact_mode) VALUES (?, ?, ?)").run("owner", "invalid", 0)); database.prepare("DELETE FROM posts WHERE id = 'post'").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM saved_posts UNION ALL SELECT COUNT(*) FROM post_history").all().every((row) => row.count === 0), true); assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); database.close();
  const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 6); reopened.close();
}); });

test("personal state startup fails closed when required cascade is absent", async () => { await withDirectory(async (directory) => {
  const path = join(directory, "damaged.sqlite"); openDatabase(path).close(); const damaged = new DatabaseSync(path); damaged.exec("DROP TABLE saved_posts; CREATE TABLE saved_posts (user_id TEXT, post_id TEXT, saved_at INTEGER)"); damaged.close(); assert.throws(() => openDatabase(path), /personal state invariant is invalid/);
}); });
