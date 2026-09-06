import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-notification-migration-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function rewriteObjectSql(database, name, transform) {
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name);
  assert.ok(row?.sql, `missing schema object ${name}`);
  const changed = transform(row.sql); assert.notEqual(changed, row.sql, `damage must alter ${name}`);
  database.enableDefensive(false); database.exec("PRAGMA writable_schema = ON");
  assert.equal(database.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = ?").run(changed, name).changes, 1);
  database.exec("PRAGMA writable_schema = OFF");
}
function replacing(from, to) { return (sql) => { assert.equal(sql.includes(from), true, `missing schema fragment: ${from}`); return sql.replace(from, to); }; }
async function rejectsDamage(damage) {
  return withDirectory(async (directory) => {
    const path = join(directory, "damaged.sqlite"); const valid = openDatabase(path); valid.close();
    const database = new DatabaseSync(path); damage(database); database.close();
    assert.throws(() => openDatabase(path), /notification invariant|malformed database schema|foreign key mismatch/);
  });
}
function seedUsers(database) {
  for (const [id, username] of [["owner-a", "owner-a"], ["owner-b", "owner-b"]]) database.prepare("INSERT INTO users (id, username, password_salt, password_verifier, created_at) VALUES (?, ?, 'salt', 'verifier', 1)").run(id, username);
}
function seedEvent(database, { id = "a", owner = "owner-a", sequence = 1, kind = "mention", itemType = "comment", occurredAt = 1 } = {}) {
  database.prepare("INSERT INTO notification_events (id, event_key, occurrence_sequence, recipient_user_id, kind, related_item_type, related_item_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, 'item', ?)").run(`event-${id}`, `key-${id}`, sequence, owner, kind, itemType, occurredAt);
}
function seedNotification(database, id = "a", owner = `owner-${id}`) {
  database.prepare("INSERT INTO notifications (id, event_id, owner_user_id) VALUES (?, ?, ?)").run(`notification-${id}`, `event-${id}`, owner);
}
function seedTraversal(database, id = "a", owner = `owner-${id}`) {
  database.prepare("INSERT INTO notification_traversals (id, owner_user_id, snapshot_key, created_at, expires_at) VALUES (?, ?, ?, 1, 2)").run(`traversal-${id}`, owner, id.repeat(64));
}
function withTriggerDisabled(database, name, write) {
  const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name).sql;
  database.exec(`DROP TRIGGER ${name}`); write(); database.exec(sql);
}

test("notification migration installs exact durable owner state and immutable snapshot authority", async () => withDirectory(async (directory) => {
  const path = join(directory, "schema.sqlite"); const database = openDatabase(path);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 13); seedUsers(database);
  seedEvent(database); seedNotification(database); seedTraversal(database);
  database.prepare("INSERT INTO notification_traversal_items (traversal_id, ordinal, notification_id) VALUES ('traversal-a', 0, 'notification-a')").run();
  database.prepare("INSERT INTO notification_page_tokens (token, traversal_id, start_ordinal) VALUES ('token', 'traversal-a', 1)").run();
  for (const statement of [
    "UPDATE notification_events SET occurred_at = 2 WHERE id = 'event-a'",
    "DELETE FROM notification_events WHERE id = 'event-a'",
    "UPDATE notifications SET owner_user_id = 'owner-b' WHERE id = 'notification-a'",
    "DELETE FROM notifications WHERE id = 'notification-a'",
    "UPDATE notification_traversals SET expires_at = 3 WHERE id = 'traversal-a'",
    "UPDATE notification_traversal_items SET ordinal = 1 WHERE traversal_id = 'traversal-a'",
    "UPDATE notification_page_tokens SET start_ordinal = 2 WHERE token = 'token'",
  ]) assert.throws(() => database.exec(statement), /immutable|cannot be/);
  database.prepare("UPDATE notifications SET deleted_at = 2 WHERE id = 'notification-a'").run();
  assert.throws(() => database.prepare("UPDATE notifications SET deleted_at = NULL WHERE id = 'notification-a'").run(), /terminal/);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close(); openDatabase(path).close();
}));

test("notification traversal items reject cross-owner insertion and startup rejects a preexisting mismatch", async () => withDirectory(async (directory) => {
  const path = join(directory, "owner.sqlite"); const database = openDatabase(path); seedUsers(database);
  seedEvent(database); seedNotification(database); seedEvent(database, { id: "b", owner: "owner-b", sequence: 2 }); seedNotification(database, "b"); seedTraversal(database);
  assert.throws(() => database.prepare("INSERT INTO notification_traversal_items (traversal_id, ordinal, notification_id) VALUES ('traversal-a', 0, 'notification-b')").run(), /owner/);
  withTriggerDisabled(database, "notification_traversal_item_owner_matches_traversal", () => database.prepare("INSERT INTO notification_traversal_items (traversal_id, ordinal, notification_id) VALUES ('traversal-a', 0, 'notification-b')").run());
  database.close(); assert.throws(() => openDatabase(path), /notification invariant is invalid/);
}));

test("notification startup rejects every damaged declarative schema family", async (t) => {
  const tableCases = [
    ["event column contract", "notification_events", replacing("related_item_id TEXT NOT NULL", "related_item_id BLOB NOT NULL")],
    ["read-state default", "notifications", replacing("DEFAULT 0", "DEFAULT 1")],
    ["event sequence check", "notification_events", replacing("occurrence_sequence > 0", "occurrence_sequence >= 0")],
    ["event kind check", "notification_events", replacing("'moderation'))", "'moderation', 'other'))")],
    ["related type check", "notification_events", replacing("'comment', 'post'))", "'comment', 'post', 'other'))")],
    ["kind and item pairing check", "notification_events", replacing("related_item_type = 'comment') OR", "related_item_type IN ('comment', 'post')) OR")],
    ["event time check", "notification_events", replacing("occurred_at >= 0", "occurred_at >= -1")],
    ["read state check", "notifications", replacing("read_state IN (0, 1)", "read_state IN (0, 1, 2)")],
    ["deleted time check", "notifications", replacing("deleted_at >= 0", "deleted_at >= -1")],
    ["snapshot digest check", "notification_traversals", replacing("length(snapshot_key) = 64", "length(snapshot_key) <= 64")],
    ["traversal created check", "notification_traversals", replacing("created_at >= 0", "created_at >= -1")],
    ["traversal expiry check", "notification_traversals", replacing("expires_at > created_at", "expires_at >= created_at")],
    ["item ordinal check", "notification_traversal_items", replacing("ordinal >= 0", "ordinal >= -1")],
    ["token start check", "notification_page_tokens", replacing("start_ordinal >= 0", "start_ordinal >= -1")],
    ["event recipient foreign key", "notification_events", replacing("REFERENCES users(id)", "REFERENCES users(created_at)")],
    ["notification event foreign key", "notifications", replacing("REFERENCES notification_events(id)", "REFERENCES notification_events(occurred_at)")],
    ["notification owner foreign key", "notifications", replacing("REFERENCES users(id)", "REFERENCES users(created_at)")],
    ["traversal owner foreign key", "notification_traversals", replacing("REFERENCES users(id)", "REFERENCES users(created_at)")],
    ["item notification foreign key", "notification_traversal_items", replacing("REFERENCES notifications(id)", "REFERENCES notifications(event_id)")],
    ["item traversal cascade", "notification_traversal_items", replacing("ON DELETE CASCADE", "ON DELETE RESTRICT")],
    ["token traversal cascade", "notification_page_tokens", replacing("ON DELETE CASCADE", "ON DELETE RESTRICT")],
    ["event-key uniqueness", "notification_events", replacing("event_key TEXT NOT NULL UNIQUE", "event_key TEXT NOT NULL")],
    ["event-sequence uniqueness", "notification_events", replacing("occurrence_sequence INTEGER NOT NULL UNIQUE", "occurrence_sequence INTEGER NOT NULL")],
    ["event delivery uniqueness", "notifications", replacing("event_id TEXT NOT NULL UNIQUE", "event_id TEXT NOT NULL")],
    ["owner event uniqueness", "notifications", replacing(",\n  UNIQUE (owner_user_id, event_id)", "")],
    ["owner snapshot uniqueness", "notification_traversals", replacing(",\n  UNIQUE (owner_user_id, snapshot_key)", "")],
    ["snapshot item uniqueness", "notification_traversal_items", replacing(",\n  UNIQUE (traversal_id, notification_id)", "")],
    ["page start uniqueness", "notification_page_tokens", replacing(",\n  UNIQUE (traversal_id, start_ordinal)", "")],
  ];
  for (const [name, object, damage] of tableCases) await t.test(name, () => rejectsDamage((database) => rewriteObjectSql(database, object, damage)));
  const indexCases = [
    ["event owner-order direction", "notification_events_owner_order", "CREATE INDEX notification_events_owner_order ON notification_events(recipient_user_id, occurrence_sequence ASC, id ASC)"],
    ["notification owner-order collation", "notifications_owner_order", "CREATE INDEX notifications_owner_order ON notifications(owner_user_id COLLATE NOCASE, deleted_at, id)"],
    ["traversal expiry uniqueness", "notification_traversals_expiry", "CREATE UNIQUE INDEX notification_traversals_expiry ON notification_traversals(expires_at)"],
  ];
  for (const [name, index, sql] of indexCases) await t.test(name, () => rejectsDamage((database) => database.exec(`DROP INDEX ${index}; ${sql}`)));
  await t.test("unexpected notification index", () => rejectsDamage((database) => database.exec("CREATE INDEX notification_unexpected ON notifications(read_state)")));
  await t.test("unexpected notification trigger", () => rejectsDamage((database) => database.exec("CREATE TRIGGER notification_unexpected AFTER INSERT ON notifications BEGIN SELECT 1; END")));
  const triggers = ["notification_events_are_immutable", "notification_events_cannot_be_deleted", "notifications_owner_matches_event", "notifications_owner_is_immutable", "notifications_cannot_be_hard_deleted", "notifications_deletion_is_one_way", "notification_traversals_are_immutable", "notification_traversal_item_owner_matches_traversal", "notification_traversal_items_are_immutable", "notification_page_tokens_are_immutable"];
  for (const name of triggers) await t.test(`${name} exact body`, () => rejectsDamage((database) => rewriteObjectSql(database, name, (sql) => sql.replace(/SELECT RAISE\(ABORT, '[^']+'\);/, "SELECT 1;"))));
});

test("notification startup rejects every illegal persisted state family", async (t) => {
  const cases = [
    ["event sequence", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); seedEvent(database, { sequence: 0 }); }],
    ["event kind", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); seedEvent(database, { kind: "other" }); }],
    ["related item type", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); seedEvent(database, { itemType: "other" }); }],
    ["kind and item pairing", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); seedEvent(database, { kind: "vote", itemType: "comment" }); }],
    ["event time", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); seedEvent(database, { occurredAt: -1 }); }],
    ["read state", (database) => { seedUsers(database); seedEvent(database); database.exec("PRAGMA ignore_check_constraints = ON"); database.prepare("INSERT INTO notifications (id, event_id, owner_user_id, read_state) VALUES ('notification-a', 'event-a', 'owner-a', 2)").run(); }],
    ["deleted time", (database) => { seedUsers(database); seedEvent(database); database.exec("PRAGMA ignore_check_constraints = ON"); database.prepare("INSERT INTO notifications (id, event_id, owner_user_id, deleted_at) VALUES ('notification-a', 'event-a', 'owner-a', -1)").run(); }],
    ["snapshot key", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); database.prepare("INSERT INTO notification_traversals VALUES ('traversal-a', 'owner-a', 'G', 1, 2)").run(); }],
    ["traversal creation", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); database.prepare("INSERT INTO notification_traversals VALUES ('traversal-a', 'owner-a', ?, -1, 2)").run("a".repeat(64)); }],
    ["traversal expiry", (database) => { seedUsers(database); database.exec("PRAGMA ignore_check_constraints = ON"); database.prepare("INSERT INTO notification_traversals VALUES ('traversal-a', 'owner-a', ?, 2, 1)").run("a".repeat(64)); }],
    ["item ordinal", (database) => { seedUsers(database); seedEvent(database); seedNotification(database); seedTraversal(database); database.exec("PRAGMA ignore_check_constraints = ON"); database.prepare("INSERT INTO notification_traversal_items VALUES ('traversal-a', -1, 'notification-a')").run(); }],
    ["token start", (database) => { seedUsers(database); seedTraversal(database); database.exec("PRAGMA ignore_check_constraints = ON"); database.prepare("INSERT INTO notification_page_tokens VALUES ('token', 'traversal-a', -1)").run(); }],
    ["notification owner mismatch", (database) => { seedUsers(database); seedEvent(database); withTriggerDisabled(database, "notifications_owner_matches_event", () => seedNotification(database, "a", "owner-b")); }],
    ["traversal item owner mismatch", (database) => { seedUsers(database); seedEvent(database); seedNotification(database); seedEvent(database, { id: "b", owner: "owner-b", sequence: 2 }); seedNotification(database, "b"); seedTraversal(database); withTriggerDisabled(database, "notification_traversal_item_owner_matches_traversal", () => database.prepare("INSERT INTO notification_traversal_items VALUES ('traversal-a', 0, 'notification-b')").run()); }],
    ["foreign key corruption", (database) => { database.exec("PRAGMA foreign_keys = OFF"); database.prepare("INSERT INTO notification_events VALUES ('event-a', 'key-a', 1, 'missing', 'mention', 'comment', 'item', 1)").run(); }],
  ];
  for (const [name, damage] of cases) await t.test(name, () => rejectsDamage(damage));
});
