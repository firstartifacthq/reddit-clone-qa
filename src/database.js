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
const personalMigration = migration("006-personal-state.sql");
const feedMigration = migration("007-feeds.sql");
const moderationMigration = migration("008-moderation.sql");
const notificationMigration = migration("009-notifications.sql");

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
function assertFeedInvariant(database) {
  const published = database.prepare("PRAGMA table_info(posts)").all().find((/** @type {any} */ column) => column.name === "published_at");
  const postsSql = normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'posts'").get()?.sql || "");
  const expectedColumns = {
    feed_traversals: [["id", "TEXT", 1, null, 1], ["feed_kind", "TEXT", 1, null, 0], ["community_name", "TEXT", 0, null, 0], ["requester_user_id", "TEXT", 0, null, 0], ["created_at", "INTEGER", 1, null, 0], ["expires_at", "INTEGER", 1, null, 0]],
    feed_traversal_items: [["traversal_id", "TEXT", 1, null, 1], ["ordinal", "INTEGER", 1, null, 2], ["post_id", "TEXT", 1, null, 0]],
    feed_page_tokens: [["token", "TEXT", 1, null, 1], ["traversal_id", "TEXT", 1, null, 0], ["start_ordinal", "INTEGER", 1, null, 0]],
  };
  /** @param {string} table @param {any[][]} expected */
  const columnsMatch = (table, expected) => JSON.stringify(database.prepare(`PRAGMA table_info(${table})`).all().map((/** @type {any} */ column) => [column.name, column.type, column.notnull, column.dflt_value, column.pk])) === JSON.stringify(expected);
  /** @param {string} table @param {string} name @param {number} unique @param {[string, number, string][]} columns */
  const indexMatches = (table, name, unique, columns) => {
    const index = database.prepare(`PRAGMA index_list(${table})`).all().find((/** @type {any} */ entry) => entry.name === name);
    const actual = index && database.prepare("SELECT name, desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(name).map((/** @type {any} */ part) => [part.name, part.desc, part.coll]);
    return index?.unique === unique && index?.origin === "c" && JSON.stringify(actual) === JSON.stringify(columns);
  };
  /** @param {string} table @param {[string, [string, number, string][]][]} expected */
  const uniqueConstraintsMatch = (table, expected) => {
    const actual = database.prepare(`PRAGMA index_list(${table})`).all()
      .filter((/** @type {any} */ index) => index.unique === 1)
      .map((/** @type {any} */ index) => [index.origin, database.prepare("SELECT name, desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(index.name).map((/** @type {any} */ part) => [part.name, part.desc, part.coll])])
      .sort((/** @type {any} */ left, /** @type {any} */ right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify(actual) === JSON.stringify([...expected].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  };
  /** @param {string} table @param {string[][]} expected */
  const foreignKeysMatch = (table, expected) => {
    const actual = database.prepare(`PRAGMA foreign_key_list(${table})`).all().map((/** @type {any} */ key) => [key.from, key.table, key.to, key.on_update, key.on_delete, key.match]).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  };

  const expectedTableSql = {
    feed_traversals: `CREATE TABLE feed_traversals (
      id TEXT PRIMARY KEY NOT NULL,
      feed_kind TEXT NOT NULL CHECK (feed_kind IN ('home', 'popular', 'community')),
      community_name TEXT,
      requester_user_id TEXT,
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
      CHECK (
        (feed_kind = 'home' AND requester_user_id IS NOT NULL AND community_name IS NULL) OR
        (feed_kind = 'popular' AND community_name IS NULL) OR
        (feed_kind = 'community' AND community_name IS NOT NULL)
      )
    )`,
    feed_traversal_items: `CREATE TABLE feed_traversal_items (
      traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
      post_id TEXT NOT NULL,
      PRIMARY KEY (traversal_id, ordinal),
      UNIQUE (traversal_id, post_id)
    )`,
    feed_page_tokens: `CREATE TABLE feed_page_tokens (
      token TEXT PRIMARY KEY NOT NULL,
      traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
      start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
      UNIQUE (traversal_id, start_ordinal)
    )`,
  };
  const tablesMatch = Object.entries(expectedTableSql).every(([name, expected]) => normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)?.sql || "") === normalizedSql(expected));
  const requiredChecks = {
    feed_traversals: [
      "check (feed_kind in ('home', 'popular', 'community'))",
      "check ( (feed_kind = 'home' and requester_user_id is not null and community_name is null) or (feed_kind = 'popular' and community_name is null) or (feed_kind = 'community' and community_name is not null) )",
      "check (typeof(created_at) = 'integer' and created_at >= 0)",
      "check (typeof(expires_at) = 'integer' and expires_at > created_at)",
    ],
    feed_traversal_items: ["check (typeof(ordinal) = 'integer' and ordinal >= 0)"],
    feed_page_tokens: ["check (typeof(start_ordinal) = 'integer' and start_ordinal >= 0)"],
  };
  const checksMatch = Object.entries(requiredChecks).every(([table, checks]) => {
    const sql = normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)?.sql || "");
    return checks.every((check) => sql.includes(check));
  });
  const expectedTriggers = {
    posts_published_at_is_immutable: "create trigger posts_published_at_is_immutable before update of published_at on posts begin select raise(abort, 'post publication time is immutable'); end",
    feed_traversals_are_immutable: "create trigger feed_traversals_are_immutable before update on feed_traversals begin select raise(abort, 'feed traversal is immutable'); end",
    feed_traversal_items_are_immutable: "create trigger feed_traversal_items_are_immutable before update on feed_traversal_items begin select raise(abort, 'feed traversal item is immutable'); end",
    feed_page_tokens_are_immutable: "create trigger feed_page_tokens_are_immutable before update on feed_page_tokens begin select raise(abort, 'feed page token is immutable'); end",
  };
  const triggersMatch = Object.entries(expectedTriggers).every(([name, expected]) => normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.sql || "") === normalizedSql(expected));
  const invalid = database.prepare(`SELECT 1 FROM posts WHERE typeof(published_at) <> 'integer' OR published_at < 0
    UNION ALL SELECT 1 FROM feed_traversals WHERE feed_kind NOT IN ('home', 'popular', 'community')
      OR NOT ((feed_kind = 'home' AND requester_user_id IS NOT NULL AND community_name IS NULL)
        OR (feed_kind = 'popular' AND community_name IS NULL)
        OR (feed_kind = 'community' AND community_name IS NOT NULL))
      OR typeof(created_at) <> 'integer' OR created_at < 0 OR typeof(expires_at) <> 'integer' OR expires_at <= created_at
    UNION ALL SELECT 1 FROM feed_traversal_items WHERE typeof(ordinal) <> 'integer' OR ordinal < 0
    UNION ALL SELECT 1 FROM feed_page_tokens WHERE typeof(start_ordinal) <> 'integer' OR start_ordinal < 0 LIMIT 1`).get();
  const binary = "BINARY";
  if (published?.type !== "INTEGER" || published.notnull !== 1 || published.dflt_value !== "0" || !postsSql.includes("check (typeof(published_at) = 'integer' and published_at >= 0)") ||
    !Object.entries(expectedColumns).every(([table, columns]) => columnsMatch(table, columns)) || !tablesMatch || !checksMatch ||
    !foreignKeysMatch("feed_traversal_items", [["traversal_id", "feed_traversals", "id", "NO ACTION", "CASCADE", "NONE"]]) ||
    !foreignKeysMatch("feed_page_tokens", [["traversal_id", "feed_traversals", "id", "NO ACTION", "CASCADE", "NONE"]]) ||
    !uniqueConstraintsMatch("feed_traversals", [["pk", [["id", 0, binary]]]]) ||
    !uniqueConstraintsMatch("feed_traversal_items", [["pk", [["traversal_id", 0, binary], ["ordinal", 0, binary]]], ["u", [["traversal_id", 0, binary], ["post_id", 0, binary]]]]) ||
    !uniqueConstraintsMatch("feed_page_tokens", [["pk", [["token", 0, binary]]], ["u", [["traversal_id", 0, binary], ["start_ordinal", 0, binary]]]]) ||
    !indexMatches("posts", "posts_feed_publication", 0, [["published_at", 1, binary], ["id", 0, binary]]) ||
    !indexMatches("posts", "posts_feed_community_publication", 0, [["community_name", 0, binary], ["published_at", 1, binary], ["id", 0, binary]]) ||
    !indexMatches("community_memberships", "community_memberships_feed_user", 0, [["user_id", 0, binary], ["community_name", 0, binary]]) ||
    !indexMatches("feed_traversals", "feed_traversals_expiry", 0, [["expires_at", 0, binary]]) ||
    !triggersMatch || invalid || database.prepare("PRAGMA foreign_key_check").get()) throw new Error("feed invariant is invalid");
}

/** @param {Database} database */
function assertModerationInvariant(database) {
  const binary = "BINARY";
  const fail = () => { throw new Error("moderation invariant is invalid"); };
  /** @param {string} table @param {any[][]} expected */
  const columnsMatch = (table, expected) => JSON.stringify(database.prepare(`PRAGMA table_info(${table})`).all()
    .map((/** @type {any} */ column) => [column.name, column.type, column.notnull, column.dflt_value, column.pk])) === JSON.stringify(expected);
  /** @param {string} table @param {string[][]} expected */
  const foreignKeysMatch = (table, expected) => {
    const actual = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map((/** @type {any} */ key) => [key.from, key.table, key.to, key.on_update, key.on_delete, key.match]).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  };
  /** @param {string} table @param {[string, [string, number, string][]][]} expected */
  const uniqueConstraintsMatch = (table, expected) => {
    const actual = database.prepare(`PRAGMA index_list(${table})`).all()
      .filter((/** @type {any} */ index) => index.unique === 1)
      .map((/** @type {any} */ index) => [index.origin, database.prepare("SELECT name, desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(index.name)
        .map((/** @type {any} */ part) => [part.name, part.desc, part.coll])])
      .sort((/** @type {any} */ left, /** @type {any} */ right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify(actual) === JSON.stringify([...expected].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  };
  /** @param {string} table @param {string} name @param {number} unique @param {[string, number, string][]} columns */
  const indexMatches = (table, name, unique, columns) => {
    const index = database.prepare(`PRAGMA index_list(${table})`).all().find((/** @type {any} */ entry) => entry.name === name);
    const actual = index && database.prepare("SELECT name, desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(name)
      .map((/** @type {any} */ part) => [part.name, part.desc, part.coll]);
    return index?.unique === unique && index?.origin === "c" && JSON.stringify(actual) === JSON.stringify(columns);
  };

  const postState = database.prepare("PRAGMA table_info(posts)").all().find((/** @type {any} */ column) => column.name === "moderation_state");
  const postsSql = normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'posts'").get()?.sql || "");
  if (postState?.type !== "TEXT" || postState.notnull !== 1 || postState.dflt_value !== "'active'" ||
    !postsSql.includes("check (moderation_state in ('active', 'removed'))")) fail();

  const expectedColumns = {
    reports: [["id", "TEXT", 1, null, 1], ["occurrence_sequence", "INTEGER", 1, null, 0], ["post_id", "TEXT", 1, null, 0], ["community_name", "TEXT", 1, null, 0], ["reporter_user_id", "TEXT", 1, null, 0], ["reported_at", "INTEGER", 1, null, 0]],
    moderation_audit_events: [["id", "TEXT", 1, null, 1], ["occurrence_sequence", "INTEGER", 1, null, 0], ["post_id", "TEXT", 1, null, 0], ["community_name", "TEXT", 1, null, 0], ["moderator_user_id", "TEXT", 1, null, 0], ["action", "TEXT", 1, null, 0], ["occurred_at", "INTEGER", 1, null, 0]],
    moderation_queue_traversals: [["id", "TEXT", 1, null, 1], ["requester_user_id", "TEXT", 1, null, 0], ["authority_digest", "TEXT", 1, null, 0], ["created_at", "INTEGER", 1, null, 0], ["expires_at", "INTEGER", 1, null, 0]],
    moderation_queue_items: [["traversal_id", "TEXT", 1, null, 1], ["ordinal", "INTEGER", 1, null, 2], ["report_id", "TEXT", 1, null, 0]],
    moderation_queue_tokens: [["token", "TEXT", 1, null, 1], ["traversal_id", "TEXT", 1, null, 0], ["start_ordinal", "INTEGER", 1, null, 0]],
  };
  if (!Object.entries(expectedColumns).every(([table, expected]) => columnsMatch(table, expected))) fail();

  const expectedTableSql = {
    reports: `CREATE TABLE reports (
      id TEXT PRIMARY KEY NOT NULL,
      occurrence_sequence INTEGER NOT NULL UNIQUE CHECK (typeof(occurrence_sequence) = 'integer' AND occurrence_sequence > 0),
      post_id TEXT NOT NULL,
      community_name TEXT NOT NULL REFERENCES communities(canonical_name),
      reporter_user_id TEXT NOT NULL REFERENCES users(id),
      reported_at INTEGER NOT NULL CHECK (typeof(reported_at) = 'integer' AND reported_at >= 0),
      UNIQUE (reporter_user_id, post_id)
    )`,
    moderation_audit_events: `CREATE TABLE moderation_audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      occurrence_sequence INTEGER NOT NULL UNIQUE CHECK (typeof(occurrence_sequence) = 'integer' AND occurrence_sequence > 0),
      post_id TEXT NOT NULL,
      community_name TEXT NOT NULL REFERENCES communities(canonical_name),
      moderator_user_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL CHECK (action IN ('removed', 'restored')),
      occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0)
    )`,
    moderation_queue_traversals: `CREATE TABLE moderation_queue_traversals (
      id TEXT PRIMARY KEY NOT NULL,
      requester_user_id TEXT NOT NULL REFERENCES users(id),
      authority_digest TEXT NOT NULL CHECK (length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^0-9a-f]*'),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at)
    )`,
    moderation_queue_items: `CREATE TABLE moderation_queue_items (
      traversal_id TEXT NOT NULL REFERENCES moderation_queue_traversals(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
      report_id TEXT NOT NULL REFERENCES reports(id),
      PRIMARY KEY (traversal_id, ordinal),
      UNIQUE (traversal_id, report_id)
    )`,
    moderation_queue_tokens: `CREATE TABLE moderation_queue_tokens (
      token TEXT PRIMARY KEY NOT NULL,
      traversal_id TEXT NOT NULL REFERENCES moderation_queue_traversals(id) ON DELETE CASCADE,
      start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
      UNIQUE (traversal_id, start_ordinal)
    )`,
  };
  if (!Object.entries(expectedTableSql).every(([name, expected]) => normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)?.sql || "") === normalizedSql(expected))) fail();

  if (!foreignKeysMatch("reports", [["community_name", "communities", "canonical_name", "NO ACTION", "NO ACTION", "NONE"], ["reporter_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"]]) ||
    !foreignKeysMatch("moderation_audit_events", [["community_name", "communities", "canonical_name", "NO ACTION", "NO ACTION", "NONE"], ["moderator_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"]]) ||
    !foreignKeysMatch("moderation_queue_traversals", [["requester_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"]]) ||
    !foreignKeysMatch("moderation_queue_items", [["report_id", "reports", "id", "NO ACTION", "NO ACTION", "NONE"], ["traversal_id", "moderation_queue_traversals", "id", "NO ACTION", "CASCADE", "NONE"]]) ||
    !foreignKeysMatch("moderation_queue_tokens", [["traversal_id", "moderation_queue_traversals", "id", "NO ACTION", "CASCADE", "NONE"]])) fail();

  if (!uniqueConstraintsMatch("reports", [["pk", [["id", 0, binary]]], ["u", [["occurrence_sequence", 0, binary]]], ["u", [["reporter_user_id", 0, binary], ["post_id", 0, binary]]]]) ||
    !uniqueConstraintsMatch("moderation_audit_events", [["pk", [["id", 0, binary]]], ["u", [["occurrence_sequence", 0, binary]]]]) ||
    !uniqueConstraintsMatch("moderation_queue_traversals", [["pk", [["id", 0, binary]]]]) ||
    !uniqueConstraintsMatch("moderation_queue_items", [["pk", [["traversal_id", 0, binary], ["ordinal", 0, binary]]], ["u", [["traversal_id", 0, binary], ["report_id", 0, binary]]]]) ||
    !uniqueConstraintsMatch("moderation_queue_tokens", [["pk", [["token", 0, binary]]], ["u", [["traversal_id", 0, binary], ["start_ordinal", 0, binary]]]])) fail();

  if (!indexMatches("reports", "reports_community_order", 0, [["community_name", 0, binary], ["occurrence_sequence", 0, binary], ["id", 0, binary]]) ||
    !indexMatches("moderation_audit_events", "moderation_audit_community_order", 0, [["community_name", 0, binary], ["occurrence_sequence", 0, binary], ["id", 0, binary]]) ||
    !indexMatches("moderation_queue_traversals", "moderation_queue_traversals_owner_snapshot", 0, [["requester_user_id", 0, binary], ["authority_digest", 0, binary]]) ||
    !indexMatches("moderation_queue_traversals", "moderation_queue_traversals_expiry", 0, [["expires_at", 0, binary]])) fail();

  const expectedTriggers = {
    moderation_audit_events_are_immutable: "create trigger moderation_audit_events_are_immutable before update on moderation_audit_events begin select raise(abort, 'moderation audit event is immutable'); end",
    moderation_audit_events_cannot_be_deleted: "create trigger moderation_audit_events_cannot_be_deleted before delete on moderation_audit_events begin select raise(abort, 'moderation audit event cannot be deleted'); end",
    moderation_queue_traversals_are_immutable: "create trigger moderation_queue_traversals_are_immutable before update on moderation_queue_traversals begin select raise(abort, 'moderation queue traversal is immutable'); end",
    moderation_queue_items_are_immutable: "create trigger moderation_queue_items_are_immutable before update on moderation_queue_items begin select raise(abort, 'moderation queue item is immutable'); end",
    moderation_queue_tokens_are_immutable: "create trigger moderation_queue_tokens_are_immutable before update on moderation_queue_tokens begin select raise(abort, 'moderation queue token is immutable'); end",
  };
  if (!Object.entries(expectedTriggers).every(([name, expected]) => normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.sql || "") === normalizedSql(expected))) fail();
  const expectedView = "create view readable_posts as select * from posts where moderation_state = 'active'";
  if (normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'readable_posts'").get()?.sql || "") !== expectedView) fail();

  const invalid = database.prepare(`SELECT 1 FROM posts WHERE typeof(moderation_state) <> 'text' OR moderation_state NOT IN ('active', 'removed')
    UNION ALL SELECT 1 FROM reports WHERE occurrence_sequence < 1 OR typeof(occurrence_sequence) <> 'integer' OR reported_at < 0 OR typeof(reported_at) <> 'integer'
    UNION ALL SELECT 1 FROM moderation_audit_events WHERE action NOT IN ('removed', 'restored') OR occurrence_sequence < 1 OR typeof(occurrence_sequence) <> 'integer' OR occurred_at < 0 OR typeof(occurred_at) <> 'integer'
    UNION ALL SELECT 1 FROM moderation_queue_traversals WHERE length(authority_digest) <> 64 OR authority_digest GLOB '*[^0-9a-f]*' OR typeof(created_at) <> 'integer' OR created_at < 0 OR typeof(expires_at) <> 'integer' OR expires_at <= created_at
    UNION ALL SELECT 1 FROM moderation_queue_items WHERE ordinal < 0 OR typeof(ordinal) <> 'integer'
    UNION ALL SELECT 1 FROM moderation_queue_tokens WHERE start_ordinal < 0 OR typeof(start_ordinal) <> 'integer'
    UNION ALL SELECT 1 FROM (SELECT occurrence_sequence FROM reports GROUP BY occurrence_sequence HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT reporter_user_id, post_id FROM reports GROUP BY reporter_user_id, post_id HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT occurrence_sequence FROM moderation_audit_events GROUP BY occurrence_sequence HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT traversal_id, report_id FROM moderation_queue_items GROUP BY traversal_id, report_id HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT traversal_id, start_ordinal FROM moderation_queue_tokens GROUP BY traversal_id, start_ordinal HAVING COUNT(*) > 1)
    LIMIT 1`).get();
  if (invalid || database.prepare("PRAGMA foreign_key_check").get()) fail();
}

/** @param {Database} database */
function assertNotificationInvariant(database) {
  const binary = "BINARY";
  const fail = () => { throw new Error("notification invariant is invalid"); };
  /** @param {string} table @param {any[][]} expected */
  const columnsMatch = (table, expected) => JSON.stringify(database.prepare(`PRAGMA table_info(${table})`).all()
    .map((/** @type {any} */ column) => [column.name, column.type, column.notnull, column.dflt_value, column.pk])) === JSON.stringify(expected);
  /** @param {string} table @param {string[][]} expected */
  const foreignKeysMatch = (table, expected) => {
    const actual = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map((/** @type {any} */ key) => [key.from, key.table, key.to, key.on_update, key.on_delete, key.match]).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  };
  /** @param {string} table @param {[string, [string, number, string][]][]} expected */
  const uniqueConstraintsMatch = (table, expected) => {
    const actual = database.prepare(`PRAGMA index_list(${table})`).all()
      .filter((/** @type {any} */ index) => index.unique === 1)
      .map((/** @type {any} */ index) => [index.origin, database.prepare("SELECT name, desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(index.name)
        .map((/** @type {any} */ part) => [part.name, part.desc, part.coll])])
      .sort((/** @type {any} */ left, /** @type {any} */ right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify(actual) === JSON.stringify([...expected].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  };
  /** @param {string} table @param {string} name @param {number} unique @param {[string, number, string][]} columns */
  const indexMatches = (table, name, unique, columns) => {
    const index = database.prepare(`PRAGMA index_list(${table})`).all().find((/** @type {any} */ entry) => entry.name === name);
    const actual = index && database.prepare("SELECT name, desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(name)
      .map((/** @type {any} */ part) => [part.name, part.desc, part.coll]);
    return index?.unique === unique && index?.origin === "c" && JSON.stringify(actual) === JSON.stringify(columns);
  };

  const expectedColumns = {
    notification_events: [["id", "TEXT", 1, null, 1], ["event_key", "TEXT", 1, null, 0], ["occurrence_sequence", "INTEGER", 1, null, 0], ["recipient_user_id", "TEXT", 1, null, 0], ["kind", "TEXT", 1, null, 0], ["related_item_type", "TEXT", 1, null, 0], ["related_item_id", "TEXT", 1, null, 0], ["occurred_at", "INTEGER", 1, null, 0]],
    notifications: [["id", "TEXT", 1, null, 1], ["event_id", "TEXT", 1, null, 0], ["owner_user_id", "TEXT", 1, null, 0], ["read_state", "INTEGER", 1, "0", 0], ["deleted_at", "INTEGER", 0, null, 0]],
    notification_traversals: [["id", "TEXT", 1, null, 1], ["owner_user_id", "TEXT", 1, null, 0], ["snapshot_key", "TEXT", 1, null, 0], ["created_at", "INTEGER", 1, null, 0], ["expires_at", "INTEGER", 1, null, 0]],
    notification_traversal_items: [["traversal_id", "TEXT", 1, null, 1], ["ordinal", "INTEGER", 1, null, 2], ["notification_id", "TEXT", 1, null, 0]],
    notification_page_tokens: [["token", "TEXT", 1, null, 1], ["traversal_id", "TEXT", 1, null, 0], ["start_ordinal", "INTEGER", 1, null, 0]],
  };
  if (!Object.entries(expectedColumns).every(([table, expected]) => columnsMatch(table, expected))) fail();

  const expectedTableSql = {
    notification_events: `CREATE TABLE notification_events (
      id TEXT PRIMARY KEY NOT NULL,
      event_key TEXT NOT NULL UNIQUE,
      occurrence_sequence INTEGER NOT NULL UNIQUE CHECK (typeof(occurrence_sequence) = 'integer' AND occurrence_sequence > 0),
      recipient_user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('reply', 'mention', 'vote', 'moderation')),
      related_item_type TEXT NOT NULL CHECK (related_item_type IN ('comment', 'post')),
      related_item_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0),
      CHECK (
        (kind IN ('reply', 'mention') AND related_item_type = 'comment') OR
        (kind IN ('vote', 'moderation') AND related_item_type = 'post')
      )
    )`,
    notifications: `CREATE TABLE notifications (
      id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL UNIQUE REFERENCES notification_events(id),
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      read_state INTEGER NOT NULL DEFAULT 0 CHECK (typeof(read_state) = 'integer' AND read_state IN (0, 1)),
      deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
      UNIQUE (owner_user_id, event_id)
    )`,
    notification_traversals: `CREATE TABLE notification_traversals (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      snapshot_key TEXT NOT NULL CHECK (length(snapshot_key) = 64 AND snapshot_key NOT GLOB '*[^0-9a-f]*'),
      created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
      expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
      UNIQUE (owner_user_id, snapshot_key)
    )`,
    notification_traversal_items: `CREATE TABLE notification_traversal_items (
      traversal_id TEXT NOT NULL REFERENCES notification_traversals(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
      notification_id TEXT NOT NULL REFERENCES notifications(id),
      PRIMARY KEY (traversal_id, ordinal),
      UNIQUE (traversal_id, notification_id)
    )`,
    notification_page_tokens: `CREATE TABLE notification_page_tokens (
      token TEXT PRIMARY KEY NOT NULL,
      traversal_id TEXT NOT NULL REFERENCES notification_traversals(id) ON DELETE CASCADE,
      start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
      UNIQUE (traversal_id, start_ordinal)
    )`,
  };
  if (!Object.entries(expectedTableSql).every(([name, expected]) => normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)?.sql || "") === normalizedSql(expected))) fail();

  if (!foreignKeysMatch("notification_events", [["recipient_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"]]) ||
    !foreignKeysMatch("notifications", [["event_id", "notification_events", "id", "NO ACTION", "NO ACTION", "NONE"], ["owner_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"]]) ||
    !foreignKeysMatch("notification_traversals", [["owner_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"]]) ||
    !foreignKeysMatch("notification_traversal_items", [["notification_id", "notifications", "id", "NO ACTION", "NO ACTION", "NONE"], ["traversal_id", "notification_traversals", "id", "NO ACTION", "CASCADE", "NONE"]]) ||
    !foreignKeysMatch("notification_page_tokens", [["traversal_id", "notification_traversals", "id", "NO ACTION", "CASCADE", "NONE"]])) fail();

  if (!uniqueConstraintsMatch("notification_events", [["pk", [["id", 0, binary]]], ["u", [["event_key", 0, binary]]], ["u", [["occurrence_sequence", 0, binary]]]]) ||
    !uniqueConstraintsMatch("notifications", [["pk", [["id", 0, binary]]], ["u", [["event_id", 0, binary]]], ["u", [["owner_user_id", 0, binary], ["event_id", 0, binary]]]]) ||
    !uniqueConstraintsMatch("notification_traversals", [["pk", [["id", 0, binary]]], ["u", [["owner_user_id", 0, binary], ["snapshot_key", 0, binary]]]]) ||
    !uniqueConstraintsMatch("notification_traversal_items", [["pk", [["traversal_id", 0, binary], ["ordinal", 0, binary]]], ["u", [["traversal_id", 0, binary], ["notification_id", 0, binary]]]]) ||
    !uniqueConstraintsMatch("notification_page_tokens", [["pk", [["token", 0, binary]]], ["u", [["traversal_id", 0, binary], ["start_ordinal", 0, binary]]]])) fail();

  const expectedCreatedIndexes = {
    notification_events: ["notification_events_owner_order"], notifications: ["notifications_owner_order"],
    notification_traversals: ["notification_traversals_expiry"], notification_traversal_items: [], notification_page_tokens: [],
  };
  const createdIndexesMatch = Object.entries(expectedCreatedIndexes).every(([table, expected]) => JSON.stringify(database.prepare(`PRAGMA index_list(${table})`).all()
    .filter((/** @type {any} */ index) => index.origin === "c").map((/** @type {any} */ index) => index.name).sort()) === JSON.stringify([...expected].sort()));
  if (!createdIndexesMatch ||
    !indexMatches("notification_events", "notification_events_owner_order", 0, [["recipient_user_id", 0, binary], ["occurrence_sequence", 1, binary], ["id", 0, binary]]) ||
    !indexMatches("notifications", "notifications_owner_order", 0, [["owner_user_id", 0, binary], ["deleted_at", 0, binary], ["id", 0, binary]]) ||
    !indexMatches("notification_traversals", "notification_traversals_expiry", 0, [["expires_at", 0, binary]])) fail();

  const expectedTriggers = {
    notification_events_are_immutable: "create trigger notification_events_are_immutable before update on notification_events begin select raise(abort, 'notification event is immutable'); end",
    notification_events_cannot_be_deleted: "create trigger notification_events_cannot_be_deleted before delete on notification_events begin select raise(abort, 'notification event cannot be deleted'); end",
    notifications_owner_matches_event: "create trigger notifications_owner_matches_event before insert on notifications when new.owner_user_id <> (select recipient_user_id from notification_events where id = new.event_id) begin select raise(abort, 'notification owner must match event recipient'); end",
    notifications_owner_is_immutable: "create trigger notifications_owner_is_immutable before update of owner_user_id, event_id on notifications begin select raise(abort, 'notification ownership is immutable'); end",
    notifications_cannot_be_hard_deleted: "create trigger notifications_cannot_be_hard_deleted before delete on notifications begin select raise(abort, 'notification cannot be hard deleted'); end",
    notifications_deletion_is_one_way: "create trigger notifications_deletion_is_one_way before update on notifications when old.deleted_at is not null begin select raise(abort, 'notification deletion is terminal'); end",
    notification_traversals_are_immutable: "create trigger notification_traversals_are_immutable before update on notification_traversals begin select raise(abort, 'notification traversal is immutable'); end",
    notification_traversal_item_owner_matches_traversal: "create trigger notification_traversal_item_owner_matches_traversal before insert on notification_traversal_items when (select owner_user_id from notifications where id = new.notification_id) <> (select owner_user_id from notification_traversals where id = new.traversal_id) begin select raise(abort, 'notification traversal item owner must match traversal owner'); end",
    notification_traversal_items_are_immutable: "create trigger notification_traversal_items_are_immutable before update on notification_traversal_items begin select raise(abort, 'notification traversal item is immutable'); end",
    notification_page_tokens_are_immutable: "create trigger notification_page_tokens_are_immutable before update on notification_page_tokens begin select raise(abort, 'notification page token is immutable'); end",
  };
  const actualTriggerNames = database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN
    ('notification_events', 'notifications', 'notification_traversals', 'notification_traversal_items', 'notification_page_tokens') ORDER BY name`).all().map((/** @type {{name: string}} */ row) => row.name);
  if (JSON.stringify(actualTriggerNames) !== JSON.stringify(Object.keys(expectedTriggers).sort()) ||
    !Object.entries(expectedTriggers).every(([name, expected]) => normalizedSql(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.sql || "") === normalizedSql(expected))) fail();

  const invalid = database.prepare(`SELECT 1 FROM notification_events WHERE typeof(occurrence_sequence) <> 'integer' OR occurrence_sequence < 1
      OR kind NOT IN ('reply','mention','vote','moderation') OR related_item_type NOT IN ('comment','post')
      OR NOT ((kind IN ('reply','mention') AND related_item_type = 'comment') OR (kind IN ('vote','moderation') AND related_item_type = 'post'))
      OR typeof(occurred_at) <> 'integer' OR occurred_at < 0
    UNION ALL SELECT 1 FROM notifications AS notification JOIN notification_events AS event ON event.id = notification.event_id
      WHERE typeof(notification.read_state) <> 'integer' OR notification.read_state NOT IN (0,1)
      OR (notification.deleted_at IS NOT NULL AND (typeof(notification.deleted_at) <> 'integer' OR notification.deleted_at < 0))
      OR notification.owner_user_id <> event.recipient_user_id
    UNION ALL SELECT 1 FROM notification_traversals WHERE length(snapshot_key) <> 64 OR snapshot_key GLOB '*[^0-9a-f]*'
      OR typeof(created_at) <> 'integer' OR created_at < 0 OR typeof(expires_at) <> 'integer' OR expires_at <= created_at
    UNION ALL SELECT 1 FROM notification_traversal_items AS item
      JOIN notification_traversals AS traversal ON traversal.id = item.traversal_id
      JOIN notifications AS notification ON notification.id = item.notification_id
      WHERE typeof(item.ordinal) <> 'integer' OR item.ordinal < 0 OR notification.owner_user_id <> traversal.owner_user_id
    UNION ALL SELECT 1 FROM notification_page_tokens WHERE typeof(start_ordinal) <> 'integer' OR start_ordinal < 0
    UNION ALL SELECT 1 FROM (SELECT event_key FROM notification_events GROUP BY event_key HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT occurrence_sequence FROM notification_events GROUP BY occurrence_sequence HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT event_id FROM notifications GROUP BY event_id HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT owner_user_id, snapshot_key FROM notification_traversals GROUP BY owner_user_id, snapshot_key HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT traversal_id, ordinal FROM notification_traversal_items GROUP BY traversal_id, ordinal HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT traversal_id, notification_id FROM notification_traversal_items GROUP BY traversal_id, notification_id HAVING COUNT(*) > 1)
    UNION ALL SELECT 1 FROM (SELECT traversal_id, start_ordinal FROM notification_page_tokens GROUP BY traversal_id, start_ordinal HAVING COUNT(*) > 1)
    LIMIT 1`).get();
  if (invalid || database.prepare("PRAGMA foreign_key_check").get()) fail();
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
    if (version > 10) throw new Error("Unsupported database schema version");
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
      database.exec(personalMigration);
      database.exec("PRAGMA user_version = 7");
    }
    if (version === 6) {
      const voteSchemaPresent = Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'post_votes'").get());
      const personalTableCount = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type = 'table' AND name IN ('saved_posts', 'post_history', 'personal_traversals', 'personal_traversal_items', 'personal_page_tokens', 'user_preferences')`).get().count;
      if (voteSchemaPresent && personalTableCount === 0) database.exec(personalMigration);
      else if (!voteSchemaPresent && personalTableCount === 6) database.exec(voteMigration);
      else if (!voteSchemaPresent || personalTableCount !== 6) throw new Error("Ambiguous version 6 database schema");
      database.exec("PRAGMA user_version = 7");
    }
    if (version <= 7) {
      database.exec(feedMigration);
      database.exec("PRAGMA user_version = 8");
    }
    if (version <= 8) {
      database.exec(moderationMigration);
      database.exec("PRAGMA user_version = 9");
    }
    if (version <= 9) {
      database.exec(notificationMigration);
      database.exec("PRAGMA user_version = 10");
    }
    assertCommunityOwnerInvariant(database);
    assertPostInvariant(database);
    assertCommentInvariant(database);
    assertVoteInvariant(database);
    // Notification runs before older global foreign-key checks so notification corruption is classified at its owning boundary.
    assertNotificationInvariant(database);
    assertPersonalInvariant(database);
    assertFeedInvariant(database);
    assertModerationInvariant(database);
    database.exec("COMMIT");
    return database;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    database.close();
    throw error;
  }
}
