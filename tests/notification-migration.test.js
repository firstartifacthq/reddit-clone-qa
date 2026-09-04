import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/database.js";

test("notification migration installs durable unique event, owner, state, and immutable traversal authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-notification-migration-")); const path = join(directory, "schema.sqlite");
  try {
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 10);
    for (const table of ["notification_events", "notifications", "notification_traversals", "notification_traversal_items", "notification_page_tokens"]) assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'notification_events_are_immutable'").get());
    database.close(); const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA foreign_key_check").get(), undefined); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
