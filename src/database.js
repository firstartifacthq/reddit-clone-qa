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

/** @param {string | undefined} sql */
function normalizeSchemaSql(sql) {
  return typeof sql === "string" ? sql.replace(/\s+/g, " ").trim().replace(/;$/, "") : "";
}

/** @param {Database} database @param {string} name */
function schemaSql(database, name) {
  return normalizeSchemaSql(database.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name)?.sql);
}

/** @param {Database} database @param {string} table @param {[string, string, number, number][]} expected */
function hasExactColumns(database, table, expected) {
  const actual = /** @type {{name: string, type: string, notnull: number, pk: number}[]} */ (
    database.prepare(`PRAGMA table_info(${table})`).all());
  return actual.length === expected.length && expected.every(([name, type, notnull, pk], index) => {
    const column = actual[index];
    return column.name === name && column.type === type && column.notnull === notnull && column.pk === pk;
  });
}

/** @param {Database} database @param {string} table @param {string} referencedTable @param {string} from @param {string} to */
function hasCascade(database, table, referencedTable, from, to) {
  const foreignKeys = /** @type {{table: string, from: string, to: string, on_delete: string}[]} */ (
    database.prepare(`PRAGMA foreign_key_list(${table})`).all());
  return foreignKeys.some((foreignKey) => foreignKey.table === referencedTable && foreignKey.from === from
    && foreignKey.to === to && foreignKey.on_delete === "CASCADE");
}

/** @param {Database} database @param {string} name @param {string} table @param {string[]} columns */
function hasExactIndex(database, name, table, columns) {
  const index = database.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name);
  if (index?.tbl_name !== table || !index.sql) return false;
  const actual = /** @type {{name: string}[]} */ (database.prepare(`PRAGMA index_info(${name})`).all());
  return actual.length === columns.length && actual.every((column, position) => column.name === columns[position]);
}

/** @param {Database} database */
function assertFeedInvariant(database) {
  const expectedTables = {
    post_creation_order: `CREATE TABLE post_creation_order (
      post_id TEXT PRIMARY KEY NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0)
    )`,
    feed_traversals: `CREATE TABLE feed_traversals (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('home', 'popular', 'community')),
      community_name TEXT,
      principal_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
      CHECK ((kind = 'community' AND community_name IS NOT NULL) OR (kind IN ('home', 'popular') AND community_name IS NULL))
    )`,
    feed_traversal_items: `CREATE TABLE feed_traversal_items (
      traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      post_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      PRIMARY KEY (traversal_id, ordinal),
      UNIQUE (traversal_id, post_id)
    )`,
    feed_page_tokens: `CREATE TABLE feed_page_tokens (
      token TEXT PRIMARY KEY NOT NULL,
      traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
      start_ordinal INTEGER NOT NULL CHECK (start_ordinal >= 0),
      UNIQUE (traversal_id, start_ordinal)
    )`,
  };
  const tablesValid = Object.entries(expectedTables).every(([name, sql]) =>
    schemaSql(database, name) === normalizeSchemaSql(sql));
  const columnsValid = hasExactColumns(database, "post_creation_order", [
    ["post_id", "TEXT", 1, 1], ["sequence", "INTEGER", 1, 0],
  ]) && hasExactColumns(database, "feed_traversals", [
    ["id", "TEXT", 1, 1], ["kind", "TEXT", 1, 0], ["community_name", "TEXT", 0, 0],
    ["principal_id", "TEXT", 1, 0], ["created_at", "INTEGER", 1, 0], ["expires_at", "INTEGER", 1, 0],
  ]) && hasExactColumns(database, "feed_traversal_items", [
    ["traversal_id", "TEXT", 1, 1], ["ordinal", "INTEGER", 1, 2],
    ["post_id", "TEXT", 1, 0], ["score", "INTEGER", 1, 0],
  ]) && hasExactColumns(database, "feed_page_tokens", [
    ["token", "TEXT", 1, 1], ["traversal_id", "TEXT", 1, 0], ["start_ordinal", "INTEGER", 1, 0],
  ]);
  const expectedTriggers = {
    posts_assign_creation_order: `CREATE TRIGGER posts_assign_creation_order AFTER INSERT ON posts BEGIN
      INSERT INTO post_creation_order (post_id, sequence)
      VALUES (NEW.id, COALESCE((SELECT MAX(sequence) FROM post_creation_order), 0) + 1);
    END`,
    post_creation_order_is_immutable: `CREATE TRIGGER post_creation_order_is_immutable
      BEFORE UPDATE OF post_id, sequence ON post_creation_order BEGIN
      SELECT RAISE(ABORT, 'post creation order is immutable'); END`,
    feed_traversal_is_immutable: `CREATE TRIGGER feed_traversal_is_immutable
      BEFORE UPDATE OF id, kind, community_name, principal_id, created_at, expires_at ON feed_traversals BEGIN
      SELECT RAISE(ABORT, 'feed traversal is immutable'); END`,
    feed_traversal_item_is_immutable: `CREATE TRIGGER feed_traversal_item_is_immutable
      BEFORE UPDATE OF traversal_id, ordinal, post_id, score ON feed_traversal_items BEGIN
      SELECT RAISE(ABORT, 'feed traversal item is immutable'); END`,
    feed_page_token_is_immutable: `CREATE TRIGGER feed_page_token_is_immutable
      BEFORE UPDATE OF token, traversal_id, start_ordinal ON feed_page_tokens BEGIN
      SELECT RAISE(ABORT, 'feed page token is immutable'); END`,
  };
  const triggersValid = Object.entries(expectedTriggers).every(([name, sql]) =>
    schemaSql(database, name) === normalizeSchemaSql(sql));
  const indexesValid = hasExactIndex(database, "feed_traversal_items_post_id", "feed_traversal_items", ["post_id"])
    && hasExactIndex(database, "feed_page_tokens_traversal_offset", "feed_page_tokens", ["traversal_id", "start_ordinal"]);
  const itemForeignKeys = /** @type {{table: string}[]} */ (
    database.prepare("PRAGMA foreign_key_list(feed_traversal_items)").all());
  const foreignKeysValid = hasCascade(database, "post_creation_order", "posts", "post_id", "id")
    && hasCascade(database, "feed_traversal_items", "feed_traversals", "traversal_id", "id")
    && hasCascade(database, "feed_page_tokens", "feed_traversals", "traversal_id", "id")
    && !itemForeignKeys.some((key) => key.table === "posts");
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
    WHERE traversal.id IS NULL OR item.ordinal < 0 OR typeof(item.score) <> 'integer'
    UNION ALL
    SELECT 1 FROM feed_page_tokens AS token
    LEFT JOIN feed_traversals AS traversal ON traversal.id = token.traversal_id
    WHERE traversal.id IS NULL OR token.start_ordinal < 0
    LIMIT 1`).get();
  if (!tablesValid || !columnsValid || !triggersValid || !indexesValid || !foreignKeysValid || invalid) {
    throw new Error("feed invariant is invalid");
  }
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
