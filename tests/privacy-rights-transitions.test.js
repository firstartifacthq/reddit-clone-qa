import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
test("AC-RC13-6B transition trigger rejects completion without acceptance", () => { const app=createApp({databasePath:":memory:"}); app.database.prepare("INSERT INTO privacy_jobs (id,operation,subject_user_id,subject_key,created_at) VALUES ('job_valid_1','export',NULL,'x',0)").run(); assert.throws(()=>app.database.prepare("INSERT INTO privacy_job_events (id,job_id,occurrence_sequence,operation,action,occurred_at) VALUES ('event_valid_1','job_valid_1',1,'export','completed',0)").run(),/privacy job must be pending/); app.close(); });
