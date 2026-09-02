import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/database.js";

test("moderation migration installs canonical visibility, durable records, and immutable audit evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-migration-")); const path = join(directory, "state.sqlite");
  try {
    const database = openDatabase(path);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'readable_posts'").get().sql.includes("moderation_state = 'visible'"), true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('reports', 'moderation_audit_events', 'moderation_traversals', 'moderation_traversal_items', 'moderation_page_tokens')").get().count, 5);
    database.close();
    const reopened = openDatabase(path); assert.equal(reopened.prepare("PRAGMA foreign_key_check").get(), undefined); reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
