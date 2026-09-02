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
const personalMigration = migration("006-personal-state.sql");

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

/** @param {string} sql */
function normalizedSql(sql) { return sql.toLowerCase().replace(/[\s;]+/g, " ").trim(); }

/** @param {Database} database */
function assertPersonalInvariant(database) {
  const expectedColumns = {
    saved_posts: [["user_id", "TEXT", 1, 1], ["post_id", "TEXT", 1, 2], ["saved_at", "INTEGER", 1, 0]],
    post_history: [["user_id", "TEXT", 1, 1], ["post_id", "TEXT", 1, 2], ["viewed_at", "INTEGER", 1, 0]],
    personal_traversals: [["id", "TEXT", 1, 1], ["user_id", "TEXT", 1, 0], ["listing_kind", "TEXT", 1, 0], ["snapshot_key", "TEXT", 1, 0], ["created_at", "INTEGER", 1, 0], ["expires_at", "INTEGER", 1, 0]],
    personal_traversal_items: [["traversal_id", "TEXT", 1, 1], ["ordinal", "INTEGER", 1, 2], ["post_id", "TEXT", 1, 0], ["event_at", "INTEGER", 1, 0]],
    personal_page_tokens: [["token", "TEXT", 1, 1], ["traversal_id", "TEXT", 1, 0], ["start_ordinal", "INTEGER", 1, 0]],
    user_preferences: [["user_id", "TEXT", 1, 1], ["theme", "TEXT", 1, 0], ["compact_mode", "INTEGER", 1, 0]],
  };
  /** @param {string} table @param {any[][]} expected */
  const columnsMatch = (table, expected) => JSON.stringify(database.prepare(`PRAGMA table_info(${table})`).all().map((/** @type {any} */ column) => [column.name, column.type, column.notnull, column.pk])) === JSON.stringify(expected);
  if (!Object.entries(expectedColumns).every(([table, columns]) => columnsMatch(table, columns))) throw new Error("personal state invariant is invalid");

  const expectedForeignKeys = {
    saved_posts: [["post_id", "posts", "id", "CASCADE"], ["user_id", "users", "id", "CASCADE"]],
    post_history: [["post_id", "posts", "id", "CASCADE"], ["user_id", "users", "id", "CASCADE"]],
    personal_traversals: [["user_id", "users", "id", "CASCADE"]],
    personal_traversal_items: [["post_id", "posts", "id", "CASCADE"], ["traversal_id", "personal_traversals", "id", "CASCADE"]],
    personal_page_tokens: [["traversal_id", "personal_traversals", "id", "CASCADE"]],
    user_preferences: [["user_id", "users", "id", "CASCADE"]],
  };
  /** @param {string} table @param {string[][]} expected */
  const foreignKeysMatch = (table, expected) => {
    const actual = database.prepare(`PRAGMA foreign_key_list(${table})`).all().map((/** @type {any} */ key) => [key.from, key.table, key.to, key.on_delete]).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  };
  if (!Object.entries(expectedForeignKeys).every(([table, keys]) => foreignKeysMatch(table, keys))) throw new Error("personal state invariant is invalid");

  /** @param {string} table @param {string[]} columns */
  const hasUnique = (table, columns) => database.prepare(`PRAGMA index_list(${table})`).all().some((/** @type {any} */ index) => index.unique === 1 &&
    JSON.stringify(database.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name).map((/** @type {any} */ part) => part.name)) === JSON.stringify(columns));
  /** @param {string} table @param {string} name @param {number} unique @param {[string, number][]} columns */
  const indexMatches = (table, name, unique, columns) => {
    const index = database.prepare(`PRAGMA index_list(${table})`).all().find((/** @type {any} */ candidate) => candidate.name === name);
    const actual = index && database.prepare("SELECT name, desc FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(name).map((/** @type {any} */ part) => [part.name, part.desc]);
    return index?.unique === unique && JSON.stringify(actual) === JSON.stringify(columns);
  };
  if (!indexMatches("saved_posts", "saved_posts_owner_order", 0, [["user_id", 0], ["saved_at", 1], ["post_id", 0]]) ||
    !indexMatches("post_history", "post_history_owner_order", 0, [["user_id", 0], ["viewed_at", 1], ["post_id", 0]]) ||
    !indexMatches("personal_traversals", "personal_traversals_owner_kind", 1, [["user_id", 0], ["listing_kind", 0], ["snapshot_key", 0]]) ||
    !indexMatches("personal_traversals", "personal_traversals_expiry", 0, [["expires_at", 0]]) ||
    !hasUnique("personal_traversal_items", ["traversal_id", "post_id"]) || !hasUnique("personal_page_tokens", ["traversal_id", "start_ordinal"])) {
    throw new Error("personal state invariant is invalid");
  }

  const requiredChecks = {
    saved_posts: ["check (typeof(saved_at) = 'integer' and saved_at >= 0)"],
    post_history: ["check (typeof(viewed_at) = 'integer' and viewed_at >= 0)"],
    personal_traversals: ["check (listing_kind in ('saved', 'history'))", "check (length(snapshot_key) = 64 and snapshot_key not glob '*[^0-9a-f]*')", "check (typeof(created_at) = 'integer' and created_at >= 0)", "check (typeof(expires_at) = 'integer' and expires_at > created_at)"],
    personal_traversal_items: ["check (typeof(ordinal) = 'integer' and ordinal >= 0)", "check (typeof(event_at) = 'integer' and event_at >= 0)"],
    personal_page_tokens: ["check (typeof(start_ordinal) = 'integer' and start_ordinal >= 0)"],
    user_preferences: ["check (theme in ('system', 'light', 'dark'))", "check (typeof(compact_mode) = 'integer' and compact_mode in (0, 1))"],
  };
  for (const [table, checks] of Object.entries(requiredChecks)) {
    const sql = normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)?.sql || "");
    if (!checks.every((check) => sql.includes(check))) throw new Error("personal state invariant is invalid");
  }

  const expectedTriggers = {
    personal_traversals_are_immutable: "create trigger personal_traversals_are_immutable before update on personal_traversals begin select raise(abort, 'personal traversal is immutable'); end",
    personal_traversal_items_are_immutable: "create trigger personal_traversal_items_are_immutable before update on personal_traversal_items begin select raise(abort, 'personal traversal item is immutable'); end",
    personal_page_tokens_are_immutable: "create trigger personal_page_tokens_are_immutable before update on personal_page_tokens begin select raise(abort, 'personal page token is immutable'); end",
  };
  for (const [name, expected] of Object.entries(expectedTriggers)) {
    const actual = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.sql || "";
    if (normalizedSql(actual) !== normalizedSql(expected)) throw new Error("personal state invariant is invalid");
  }

  const invalidState = database.prepare(`SELECT 1 FROM saved_posts WHERE typeof(saved_at) <> 'integer' OR saved_at < 0
    UNION ALL SELECT 1 FROM post_history WHERE typeof(viewed_at) <> 'integer' OR viewed_at < 0
    UNION ALL SELECT 1 FROM personal_traversals WHERE listing_kind NOT IN ('saved', 'history') OR length(snapshot_key) <> 64 OR snapshot_key GLOB '*[^0-9a-f]*' OR typeof(created_at) <> 'integer' OR created_at < 0 OR typeof(expires_at) <> 'integer' OR expires_at <= created_at
    UNION ALL SELECT 1 FROM personal_traversal_items WHERE typeof(ordinal) <> 'integer' OR ordinal < 0 OR typeof(event_at) <> 'integer' OR event_at < 0
    UNION ALL SELECT 1 FROM personal_page_tokens WHERE typeof(start_ordinal) <> 'integer' OR start_ordinal < 0
    UNION ALL SELECT 1 FROM user_preferences WHERE theme NOT IN ('system', 'light', 'dark') OR typeof(compact_mode) <> 'integer' OR compact_mode NOT IN (0, 1)
    LIMIT 1`).get();
  if (invalidState || database.prepare("PRAGMA foreign_key_check").get()) throw new Error("personal state invariant is invalid");
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
    if (version > 6) throw new Error("Unsupported database schema version");
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
      database.exec(personalMigration);
      database.exec("PRAGMA user_version = 6");
    }
    assertCommunityOwnerInvariant(database);
    assertPostInvariant(database);
    assertCommentInvariant(database);
    assertPersonalInvariant(database);
    database.exec("COMMIT");
    return database;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    database.close();
    throw error;
  }
}
