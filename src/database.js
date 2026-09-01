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
function assertCommentInvariant(database) {
  const invalid = database.prepare(`SELECT 1 FROM comments WHERE NOT (
    (state = 'active' AND author_user_id IS NOT NULL AND body IS NOT NULL) OR
    (state = 'deleted' AND author_user_id IS NULL AND body IS NULL)
  ) LIMIT 1`).get();
  if (invalid) throw new Error("comment invariant is invalid");
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
    if (version > 5) throw new Error("Unsupported database schema version");
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
    assertCommunityOwnerInvariant(database);
    assertPostInvariant(database);
    assertCommentInvariant(database);
    database.exec("COMMIT");
    return database;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    database.close();
    throw error;
  }
}
