import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/database.js";

test("AC-RC13 schema owns immutable privacy transitions", () => {
  const database = openDatabase(":memory:");
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 12);
  database.prepare("INSERT INTO privacy_jobs (id,operation,subject_user_id,subject_key,created_at) VALUES ('job_schema_1','export',NULL,'subject',0)").run();
  database.prepare("INSERT INTO privacy_job_events (id,job_id,occurrence_sequence,operation,action,occurred_at) VALUES ('event_schema_1','job_schema_1',1,'export','accepted',0)").run();
  assert.throws(() => database.prepare("DELETE FROM privacy_job_events WHERE id='event_schema_1'").run(), /privacy audit event cannot be deleted/);
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0); database.close();
});
