// Runtime imports are exercised by the Node 24 tests; local module contracts are checked below.
// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { readFileSync } from "node:fs";
// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { DatabaseSync } from "node:sqlite";

/**
 * @typedef {object} Database
 * @property {(sql: string) => void} exec
 * @property {(sql: string) => any} prepare
 * @property {() => void} close
 */

/** @param {string} name */
function migration(name) {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
    .replace("CREATE TABLE users", "CREATE TABLE IF NOT EXISTS users")
    .replace("CREATE TABLE sessions", "CREATE TABLE IF NOT EXISTS sessions")
    .replace("CREATE INDEX sessions_user_id", "CREATE INDEX IF NOT EXISTS sessions_user_id");
}

const baselineMigration = migration("001-auth.sql");
const profileMigration = migration("002-profile-lifecycle.sql");
const communityMigration = migration("003-community-roles.sql");
const postMigration = migration("004-posts.sql");
const commentMigration = migration("005-comments.sql");
const voteMigration = migration("006-votes.sql");
const feedMigration = migration("007-feeds.sql");

/** @param {Database} database */
function assertCommunityOwnerInvariant(database) {
  const triggerCount = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (
      'communities_owner_is_immutable',
      'community_owner_membership_matches_community',
      'community_owner_membership_matches_community_on_update',
      'community_inserts_owner_membership',
      'community_owner_membership_is_immutable',
      'community_owner_membership_cannot_be_removed'
    )`).get().count;
  const invalidState = database.prepare(`SELECT 1
    FROM communities AS community
    LEFT JOIN community_memberships AS membership
      ON membership.community_name = community.canonical_name
      AND membership.user_id = community.owner_user_id
      AND membership.role = 'owner'
    WHERE membership.user_id IS NULL
    UNION ALL
    SELECT 1
    FROM community_memberships AS membership
    JOIN communities AS community ON community.canonical_name = membership.community_name
    WHERE membership.role = 'owner' AND membership.user_id <> community.owner_user_id
    LIMIT 1`).get();
  if (triggerCount !== 6 || invalidState) throw new Error("community owner invariant is invalid");
}

/** @param {Database} database */
function assertPostInvariant(database) {
  const invalid = database.prepare(`SELECT 1 FROM posts WHERE NOT (
    (type = 'text' AND text_content IS NOT NULL AND url_content IS NULL AND media_filename IS NULL AND media_content_type IS NULL AND media_bytes IS NULL) OR
    (type = 'link' AND text_content IS NULL AND url_content IS NOT NULL AND media_filename IS NULL AND media_content_type IS NULL AND media_bytes IS NULL) OR
    (type = 'media' AND text_content IS NULL AND url_content IS NULL AND media_filename IS NOT NULL AND media_content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp') AND media_bytes IS NOT NULL)
  ) LIMIT 1`).get();
  if (invalid) throw new Error("post invariant is invalid");
}

/** @param {Database} database */
function assertVoteInvariant(database) {
  const voteColumns = /** @type {{name: string, type: string, notnull: number, pk: number}[]} */ (database.prepare("PRAGMA table_info(post_votes)").all());
  const expectedColumns = [
    ["post_id", "TEXT", 1], ["voter_user_id", "TEXT", 2], ["value", "INTEGER", 0],
  ];
  const columnsValid = expectedColumns.every(([name, type, pk]) => voteColumns.some((column) =>
    column.name === name && column.type === type && column.notnull === 1 && column.pk === pk));
  const foreignKeys = /** @type {{table: string, from: string, to: string, on_delete: string}[]} */ (database.prepare("PRAGMA foreign_key_list(post_votes)").all());
  const cascade = foreignKeys.some((foreignKey) => foreignKey.table === "posts" && foreignKey.from === "post_id" && foreignKey.to === "id" && foreignKey.on_delete === "CASCADE");
  const voter = foreignKeys.some((foreignKey) => foreignKey.table === "users" && foreignKey.from === "voter_user_id" && foreignKey.to === "id");
  const postColumns = /** @type {{name: string, type: string, notnull: number, dflt_value: string | null}[]} */ (database.prepare("PRAGMA table_info(posts)").all());
  const postState = postColumns.find((column) => column.name === "voting_state");
  const postStateColumnValid = postState?.type === "TEXT"
    && postState.notnull === 1
    && postState.dflt_value === "'unlocked'";
  const voteSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'post_votes'").get();
  const voteChecked = typeof voteSchema?.sql === "string" && /CHECK\s*\(\s*value\s+IN\s*\(\s*-1\s*,\s*1\s*\)\s*\)/i.test(voteSchema.sql);
  const postSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'posts'").get();
  const postStateChecked = typeof postSchema?.sql === "string"
    && /CHECK\s*\(\s*voting_state\s+IN\s*\(\s*'unlocked'\s*,\s*'locked'\s*\)\s*\)/i.test(postSchema.sql);
  const invalidVote = database.prepare("SELECT 1 FROM post_votes WHERE value NOT IN (-1, 1) LIMIT 1").get();
  const invalidPostState = database.prepare("SELECT 1 FROM posts WHERE voting_state IS NULL OR voting_state NOT IN ('unlocked', 'locked') LIMIT 1").get();
  if (!columnsValid || !cascade || !voter || !postStateColumnValid || !voteChecked
      || !postStateChecked || invalidVote || invalidPostState) {
    throw new Error("vote invariant is invalid");
  }
}

/** @param {Database} database */
function assertFeedInvariant(database) {
  const postOrderColumns = /** @type {{name: string, type: string, notnull: number, pk: number}[]} */ (database.prepare("PRAGMA table_info(post_creation_order)").all());
  const orderColumnValid = postOrderColumns.some((column) => column.name === "post_id" && column.type === "TEXT" && column.notnull === 1 && column.pk === 1)
    && postOrderColumns.some((column) => column.name === "sequence" && column.type === "INTEGER" && column.notnull === 1);
  const trigger = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'posts_assign_creation_order'").get();
  const orderSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'post_creation_order'").get();
  const traversalSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'feed_traversals'").get();
  const itemSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'feed_traversal_items'").get();
  const tokenSchema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'feed_page_tokens'").get();
  const tables = [orderSchema, traversalSchema, itemSchema, tokenSchema].every((table) => typeof table?.sql === "string");
  const schemaValid = typeof orderSchema?.sql === "string" && /post_id\s+TEXT\s+PRIMARY\s+KEY\s+NOT\s+NULL\s+REFERENCES\s+posts\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i.test(orderSchema.sql)
    && /sequence\s+INTEGER\s+NOT\s+NULL\s+UNIQUE\s+CHECK\s*\(\s*sequence\s*>\s*0\s*\)/i.test(orderSchema.sql)
    && typeof traversalSchema?.sql === "string" && /kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*kind\s+IN/i.test(traversalSchema.sql)
    && /expires_at\s*>\s*created_at/i.test(traversalSchema.sql)
    && /kind\s*=\s*'community'\s+AND\s+community_name\s+IS\s+NOT\s+NULL/i.test(traversalSchema.sql)
    && typeof itemSchema?.sql === "string" && /PRIMARY\s+KEY\s*\(\s*traversal_id\s*,\s*ordinal\s*\)/i.test(itemSchema.sql)
    && /UNIQUE\s*\(\s*traversal_id\s*,\s*post_id\s*\)/i.test(itemSchema.sql)
    && !/post_id\s+TEXT[^,]*REFERENCES\s+posts/i.test(itemSchema.sql)
    && typeof tokenSchema?.sql === "string" && /token\s+TEXT\s+PRIMARY\s+KEY\s+NOT\s+NULL/i.test(tokenSchema.sql)
    && /UNIQUE\s*\(\s*traversal_id\s*,\s*start_ordinal\s*\)/i.test(tokenSchema.sql);
  const invalid = database.prepare(`SELECT 1 FROM posts AS post
    LEFT JOIN post_creation_order AS ordered ON ordered.post_id = post.id
    WHERE ordered.post_id IS NULL
    UNION ALL
    SELECT 1 FROM post_creation_order WHERE sequence <= 0
    UNION ALL
    SELECT 1 FROM feed_traversals
    WHERE (kind = 'community' AND community_name IS NULL) OR (kind IN ('home', 'popular') AND community_name IS NOT NULL) OR expires_at <= created_at
    UNION ALL
    SELECT 1 FROM feed_traversal_items AS item
    LEFT JOIN feed_traversals AS traversal ON traversal.id = item.traversal_id
    WHERE traversal.id IS NULL OR item.ordinal < 0
    UNION ALL
    SELECT 1 FROM feed_page_tokens AS token
    LEFT JOIN feed_traversals AS traversal ON traversal.id = token.traversal_id
    WHERE traversal.id IS NULL OR token.start_ordinal < 0
    LIMIT 1`).get();
  const duplicateOrder = database.prepare("SELECT 1 FROM post_creation_order GROUP BY sequence HAVING COUNT(*) <> 1 LIMIT 1").get();
  const duplicateItems = database.prepare("SELECT 1 FROM feed_traversal_items GROUP BY traversal_id, post_id HAVING COUNT(*) <> 1 LIMIT 1").get();
  if (!orderColumnValid || !tables || !schemaValid || !trigger || typeof trigger.sql !== "string"
      || !/AFTER\s+INSERT\s+ON\s+posts/i.test(trigger.sql) || !/INSERT\s+INTO\s+post_creation_order/i.test(trigger.sql)
      || invalid || duplicateOrder || duplicateItems) throw new Error("feed invariant is invalid");
}

/** @param {Database} database */
function assertCommentInvariant(database) {
  const triggerCount = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (
      'comments_parent_has_same_post_and_depth',
      'comments_root_has_zero_depth',
      'comments_structure_is_immutable',
      'comments_deletion_is_one_way',
      'comment_traversal_item_matches_post',
      'comment_traversal_item_is_immutable',
      'comment_traversal_post_is_immutable'
    )`).get().count;
  const traversalItemForeignKeys = /** @type {{table: string, from: string, to: string}[]} */ (
    database.prepare("PRAGMA foreign_key_list(comment_traversal_items)").all());
  const hasCommentForeignKey = traversalItemForeignKeys.some((foreignKey) =>
    foreignKey.table === "comments" && foreignKey.from === "comment_id" && foreignKey.to === "id");
  const invalid = database.prepare(`SELECT 1 FROM comments WHERE NOT (
    (state = 'active' AND author_user_id IS NOT NULL AND body IS NOT NULL) OR
    (state = 'deleted' AND author_user_id IS NULL AND body IS NULL)
  )
  UNION ALL
  SELECT 1
  FROM comment_traversal_items AS item
  LEFT JOIN comment_traversals AS traversal ON traversal.id = item.traversal_id
  LEFT JOIN comments AS comment ON comment.id = item.comment_id
  WHERE traversal.id IS NULL OR comment.id IS NULL OR traversal.post_id <> comment.post_id
  LIMIT 1`).get();
  if (triggerCount !== 7 || !hasCommentForeignKey || invalid) throw new Error("comment invariant is invalid");
}

/**
 * @param {string} path
 * @returns {Database}
 */
export function openDatabase(path) {
  const database = new DatabaseSync(path, { timeout: 5_000 });
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    const version = /** @type {{user_version: number}} */ (database.prepare("PRAGMA user_version").get()).user_version;
    if (version > 7) throw new Error("Unsupported database schema version");
    if (version === 0) {
      database.exec(baselineMigration);
      database.exec("PRAGMA user_version = 1");
    }
    if (version <= 1) {
      database.exec(profileMigration);
      database.exec("PRAGMA user_version = 2");
    }
    if (version <= 2) {
      database.exec(communityMigration);
      database.exec("PRAGMA user_version = 3");
    }
    if (version <= 3) {
      database.exec(postMigration);
      database.exec("PRAGMA user_version = 4");
    }
    if (version <= 4) {
      database.exec(commentMigration);
      database.exec("PRAGMA user_version = 5");
    }
    if (version <= 5) {
      database.exec(voteMigration);
      database.exec("PRAGMA user_version = 6");
    }
    if (version <= 6) {
      database.exec(feedMigration);
      database.exec("PRAGMA user_version = 7");
    }
    assertCommunityOwnerInvariant(database);
    assertPostInvariant(database);
    assertCommentInvariant(database);
    assertVoteInvariant(database);
    assertFeedInvariant(database);
    database.exec("COMMIT");
    return database;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    database.close();
    throw error;
  }
}
