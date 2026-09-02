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

/** @param {Database} database */
function assertPersonalInvariant(database) {
  const tables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'
    AND name IN ('saved_posts', 'post_history', 'personal_traversals', 'personal_traversal_items', 'personal_page_tokens', 'user_preferences')`).get().count;
  const savedForeignKeys = database.prepare("PRAGMA foreign_key_list(saved_posts)").all();
  const historyForeignKeys = database.prepare("PRAGMA foreign_key_list(post_history)").all();
  const itemForeignKeys = database.prepare("PRAGMA foreign_key_list(personal_traversal_items)").all();
  const tokenForeignKeys = database.prepare("PRAGMA foreign_key_list(personal_page_tokens)").all();
  const indexCount = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index'
    AND name IN ('saved_posts_owner_order', 'post_history_owner_order', 'personal_traversals_owner_kind')`).get().count;
  const preferenceSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'user_preferences'").get()?.sql || "";
  /** @param {{table: string, from: string, on_delete: string}[]} foreignKeys @param {string} table @param {string} from */
  const hasCascade = (foreignKeys, table, from) => foreignKeys.some((key) => key.table === table && key.from === from && key.on_delete === 'CASCADE');
  if (tables !== 6 || indexCount !== 3 || !hasCascade(savedForeignKeys, 'posts', 'post_id') || !hasCascade(historyForeignKeys, 'posts', 'post_id') ||
    !hasCascade(itemForeignKeys, 'posts', 'post_id') || !hasCascade(tokenForeignKeys, 'personal_traversals', 'traversal_id') ||
    !preferenceSql.includes("theme IN ('system', 'light', 'dark')") || !preferenceSql.includes('compact_mode IN (0, 1)')) throw new Error("personal state invariant is invalid");
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
