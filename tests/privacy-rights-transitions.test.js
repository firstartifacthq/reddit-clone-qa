import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

function fixture() {
  const app = createApp({ databasePath: ":memory:" });
  const db = app.database;
  let sequence = 0;
  const job = (id, operation = "export") => db.prepare("INSERT INTO privacy_jobs (id,operation,subject_user_id,subject_key,created_at) VALUES (?,?,NULL,?,0)").run(id, operation, id);
  const event = (jobId, operation, action) => db.prepare("INSERT INTO privacy_job_events (id,job_id,occurrence_sequence,operation,action,occurred_at) VALUES (?,?,?,?,?,0)").run(`event-${++sequence}`, jobId, sequence, operation, action);
  return { app, db, job, event };
}

test("AC-RC13-6B schema permits only the closed export and deletion lifecycle graphs", () => {
  const { app, db, job, event } = fixture();
  job("export-legal"); event("export-legal", "export", "accepted"); event("export-legal", "export", "completed"); event("export-legal", "export", "revoked");
  job("deletion-legal", "deletion"); event("deletion-legal", "deletion", "accepted"); event("deletion-legal", "deletion", "completed");
  assert.deepEqual(db.prepare("SELECT operation,action FROM privacy_job_events ORDER BY occurrence_sequence").all().map((row) => ({ ...row })), [
    { operation: "export", action: "accepted" }, { operation: "export", action: "completed" }, { operation: "export", action: "revoked" },
    { operation: "deletion", action: "accepted" }, { operation: "deletion", action: "completed" },
  ]);

  job("complete-first");
  assert.throws(() => event("complete-first", "export", "completed"), /privacy job must be pending/);
  job("wrong-operation", "deletion");
  assert.throws(() => event("wrong-operation", "export", "accepted"), /privacy job operation mismatch/);
  job("double-accept"); event("double-accept", "export", "accepted");
  assert.throws(() => event("double-accept", "export", "accepted"));
  job("deletion-revoke", "deletion"); event("deletion-revoke", "deletion", "accepted");
  assert.throws(() => event("deletion-revoke", "deletion", "revoked"));
  job("revoked-complete"); event("revoked-complete", "export", "accepted"); event("revoked-complete", "export", "revoked");
  assert.throws(() => event("revoked-complete", "export", "completed"), /privacy job terminal/);
  assert.throws(() => db.prepare("UPDATE privacy_job_events SET occurred_at=1 WHERE job_id='export-legal'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM privacy_job_events WHERE job_id='export-legal'").run(), /cannot be deleted/);
  app.close();
});

test("MC-RC13-001 deletion progress permits only forward durable checkpoints", () => {
  const { app, db, job, event } = fixture();
  job("deletion-progress", "deletion"); event("deletion-progress", "deletion", "accepted");
  db.prepare("INSERT INTO privacy_deletion_progress (job_id,subject_user_id,phase) VALUES ('deletion-progress','stable-subject','accepted')").run();
  assert.throws(() => db.prepare("UPDATE privacy_deletion_progress SET phase='compacted' WHERE job_id='deletion-progress'").run(), /transition is invalid/);
  db.prepare("UPDATE privacy_deletion_progress SET phase='rows_erased' WHERE job_id='deletion-progress'").run();
  assert.throws(() => db.prepare("UPDATE privacy_deletion_progress SET phase='accepted' WHERE job_id='deletion-progress'").run(), /transition is invalid/);
  db.prepare("UPDATE privacy_deletion_progress SET phase='compacted' WHERE job_id='deletion-progress'").run();
  assert.throws(() => db.prepare("UPDATE privacy_deletion_progress SET phase='rows_erased' WHERE job_id='deletion-progress'").run(), /transition is invalid/);
  assert.throws(() => db.prepare("UPDATE privacy_deletion_progress SET subject_user_id='other' WHERE job_id='deletion-progress'").run(), /subject is immutable/);
  assert.equal(db.prepare("SELECT phase FROM privacy_deletion_progress WHERE job_id='deletion-progress'").get().phase, "compacted");
  app.close();
});
