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

function seedFeedSnapshot(database) {
  database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, ?, ?, ?)").run("guard-owner", "guard-owner", "salt", "verifier", 1);
  database.prepare("INSERT INTO communities (canonical_name, display_name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").run("guarded", "Guarded", "guard-owner", 1);
  database.prepare("INSERT INTO posts (id, community_name, author_user_id, type, title, text_content) VALUES (?, ?, ?, 'text', ?, ?)").run("guard-post", "guarded", "guard-owner", "Guard", "Guard");
  database.prepare("INSERT INTO feed_traversals (id, kind, community_name, principal_id, created_at, expires_at) VALUES (?, 'community', 'guarded', 'anonymous', 1, 2)").run("guard-traversal");
  database.prepare("INSERT INTO feed_traversal_items (traversal_id, ordinal, post_id, score) VALUES ('guard-traversal', 0, 'guard-post', 0)").run();
  database.prepare("INSERT INTO feed_page_tokens (token, traversal_id, start_ordinal) VALUES ('guard-token', 'guard-traversal', 0)").run();
}

const immutableUpdates = [
  ["post_creation_order", "post_id = 'changed-post'"],
  ["post_creation_order", "sequence = 2"],
  ["feed_traversals", "id = 'changed-traversal'"],
  ["feed_traversals", "kind = 'popular'"],
  ["feed_traversals", "community_name = 'changed'"],
  ["feed_traversals", "principal_id = 'changed-principal'"],
  ["feed_traversals", "created_at = 0"],
  ["feed_traversals", "expires_at = 3"],
  ["feed_traversal_items", "traversal_id = 'changed-traversal'"],
  ["feed_traversal_items", "ordinal = 1"],
  ["feed_traversal_items", "post_id = 'changed-post'"],
  ["feed_traversal_items", "score = 1"],
  ["feed_page_tokens", "token = 'changed-token'"],
  ["feed_page_tokens", "traversal_id = 'changed-traversal'"],
  ["feed_page_tokens", "start_ordinal = 1"],
];

test("feed schema rejects every immutable field update while preserving deletion lifecycles", async () => {
  await withDirectory(async (directory) => {
    const database = openDatabase(join(directory, "immutable.sqlite"));
    seedFeedSnapshot(database);
    for (const [table, assignment] of immutableUpdates) {
      assert.throws(() => database.prepare(`UPDATE ${table} SET ${assignment}`).run(), /immutable/,
        `${table}.${assignment.split(" ", 1)[0]} must be immutable`);
    }

    database.prepare("DELETE FROM posts WHERE id = 'guard-post'").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM post_creation_order").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feed_traversal_items").get().count, 1);
    database.prepare("DELETE FROM feed_traversals WHERE expires_at <= 2").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feed_traversal_items").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM feed_page_tokens").get().count, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.close();
  });
});

async function damagedDatabase(directory, name, damage) {
  const path = join(directory, `${name}.sqlite`);
  const database = openDatabase(path);
  damage(database);
  database.close();
  assert.throws(() => openDatabase(path), /feed invariant is invalid/);
}

test("feed startup guard rejects damaged columns, constraints, indexes, and trigger semantics", async () => {
  await withDirectory(async (directory) => {
    const schemaDamage = [
      ["score-column", "feed_traversal_items", "score INTEGER NOT NULL", "score TEXT NOT NULL"],
      ["item-ordinal-check", "feed_traversal_items", "CHECK (ordinal >= 0)", "CHECK (ordinal >= -1)"],
      ["traversal-scope-check", "feed_traversals", "kind = 'community' AND community_name IS NOT NULL", "kind = 'community' AND community_name IS NULL"],
      ["token-offset-check", "feed_page_tokens", "CHECK (start_ordinal >= 0)", "CHECK (start_ordinal >= -1)"],
    ];
    for (const [name, table, expected, replacement] of schemaDamage) {
      await damagedDatabase(directory, name, (database) => {
        const tableSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table).sql;
        const relatedSql = database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(table).map((row) => row.sql);
        const damagedSql = tableSql.replace(expected, replacement);
        assert.notEqual(damagedSql, tableSql);
        database.exec("PRAGMA foreign_keys = OFF");
        database.exec(`DROP TABLE ${table}`);
        database.exec(damagedSql);
        for (const sql of relatedSql) database.exec(sql);
      });
    }
    for (const index of ["feed_traversal_items_post_id", "feed_page_tokens_traversal_offset"]) {
      await damagedDatabase(directory, `missing-${index}`, (database) => database.exec(`DROP INDEX ${index}`));
    }
    await damagedDatabase(directory, "weakened-creation-order", (database) => {
      database.exec(`DROP TRIGGER posts_assign_creation_order;
        CREATE TRIGGER posts_assign_creation_order AFTER INSERT ON posts BEGIN
          INSERT INTO post_creation_order (post_id, sequence) VALUES (NEW.id, 1);
        END;`);
    });
    await damagedDatabase(directory, "weakened-item-immutability", (database) => {
      database.exec(`DROP TRIGGER feed_traversal_item_is_immutable;
        CREATE TRIGGER feed_traversal_item_is_immutable
        BEFORE UPDATE OF traversal_id, ordinal, post_id ON feed_traversal_items BEGIN
          SELECT RAISE(ABORT, 'feed traversal item is immutable');
        END;`);
    });
  });
});

test("feed startup guard rejects every missing immutability guard", async () => {
  await withDirectory(async (directory) => {
    for (const trigger of [
      "post_creation_order_is_immutable",
      "feed_traversal_is_immutable",
      "feed_traversal_item_is_immutable",
      "feed_page_token_is_immutable",
    ]) {
      await damagedDatabase(directory, `missing-${trigger}`, (database) => database.exec(`DROP TRIGGER ${trigger}`));
    }
  });
});
