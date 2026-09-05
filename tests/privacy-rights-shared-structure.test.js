import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
test("AC-RC13-7B reserved tombstone stays inactive", () => { const app=createApp({databasePath:":memory:"}); assert.equal(app.database.prepare("SELECT deletion_requested_at FROM users WHERE id='__privacy_tombstone__'").get().deletion_requested_at,0); app.close(); });
