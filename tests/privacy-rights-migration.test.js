import assert from "node:assert/strict";
import { open as openFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database.js";

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-privacy-migration-"));
  const path = join(directory, "database.sqlite");
  try { await run(path); } finally { await rm(directory, { recursive: true, force: true }); }
}

function rewriteObjectSql(database, name, transform) {
  const original = database.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql;
  assert.ok(original, `missing schema object ${name}`);
  const damaged = transform(original);
  assert.notEqual(damaged, original, `damage must alter ${name}`);
  database.enableDefensive(false);
  database.exec("PRAGMA writable_schema=ON");
  assert.equal(database.prepare("UPDATE sqlite_schema SET sql=? WHERE name=?").run(damaged, name).changes, 1);
  database.exec("PRAGMA writable_schema=OFF");
}

function replacing(from, to) {
  return (sql) => {
    assert.ok(sql.includes(from), `missing schema fragment ${from}`);
    return sql.replace(from, to);
  };
}

async function rejectMutation(mutate) {
  await withDatabase(async (path) => {
    openDatabase(path).close();
    const database = new DatabaseSync(path);
    mutate(database);
    database.close();
    assert.throws(() => openDatabase(path), /privacy rights invariant|invariant is invalid|malformed database schema|foreign key|database/);
  });
}

test("AC-RC13 schema owns immutable privacy transitions", () => {
  const database = openDatabase(":memory:");
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 13);
  database.prepare("INSERT INTO privacy_jobs (id,operation,subject_user_id,subject_key,created_at) VALUES ('job_schema_1','export',NULL,'subject',0)").run();
  database.prepare("INSERT INTO privacy_job_events (id,job_id,occurrence_sequence,operation,action,occurred_at) VALUES ('event_schema_1','job_schema_1',1,'export','accepted',0)").run();
  assert.throws(() => database.prepare("DELETE FROM privacy_job_events WHERE id='event_schema_1'").run(), /privacy audit event cannot be deleted/);
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

test("MC-RC13-002 startup rejects every damaged privacy invariant family", async (t) => {
  const triggerMutations = {
    privacy_job_events_legal_transition: "BEFORE INSERT ON privacy_job_events",
    privacy_job_events_are_immutable: "BEFORE UPDATE ON privacy_job_events",
    privacy_job_events_cannot_be_deleted: "BEFORE DELETE ON privacy_job_events",
    privacy_deletion_progress_legal_transition: "BEFORE UPDATE OF phase ON privacy_deletion_progress",
    privacy_deletion_progress_subject_is_immutable: "BEFORE UPDATE OF subject_user_id ON privacy_deletion_progress",
  };
  const cases = [
    ["declared column contract", (db) => rewriteObjectSql(db, "privacy_export_payloads", replacing("payload_json TEXT", "payload_json BLOB"))],
    ["privacy CHECK contract", (db) => rewriteObjectSql(db, "privacy_export_payloads", replacing("CHECK (json_valid(payload_json))", "CHECK (length(payload_json) > 0)"))],
    ["privacy foreign-key action", (db) => rewriteObjectSql(db, "privacy_export_payloads", replacing("ON DELETE CASCADE", "ON DELETE SET NULL"))],
    ["named index ordering and collation", (db) => db.exec("DROP INDEX privacy_job_events_order; CREATE INDEX privacy_job_events_order ON privacy_job_events(id COLLATE NOCASE, occurrence_sequence DESC)")],
    ["transition uniqueness", (db) => db.exec("DROP INDEX privacy_job_event_action_once; CREATE INDEX privacy_job_event_action_once ON privacy_job_events(job_id, action)")],
    ["illegal persisted lifecycle", (db) => {
      db.exec("INSERT INTO privacy_jobs (id,operation,subject_user_id,subject_key,created_at) VALUES ('illegal-job','export',NULL,'subject',0); INSERT INTO privacy_job_events (id,job_id,occurrence_sequence,operation,action,occurred_at) VALUES ('illegal-event','illegal-job',1,'export','accepted',0); INSERT INTO privacy_export_payloads (job_id,payload_json) VALUES ('illegal-job','{}')");
      const immutable = db.prepare("SELECT sql FROM sqlite_schema WHERE name='privacy_job_events_are_immutable'").get().sql;
      db.exec("DROP TRIGGER privacy_job_events_are_immutable");
      db.prepare("UPDATE privacy_job_events SET operation='deletion' WHERE id='illegal-event'").run();
      db.exec(immutable);
    }],
    ["reserved tombstone state", (db) => db.prepare("UPDATE users SET bio='recoverable identity' WHERE id='__privacy_tombstone__'").run()],
    ["foreign-key consistency", (db) => { db.exec("PRAGMA foreign_keys=OFF"); db.prepare("INSERT INTO privacy_audit_tokens (token,traversal_id,next_sequence) VALUES ('orphan','missing',0)").run(); }],
    ...Object.entries(triggerMutations).map(([name, clause]) => [`same-named no-op ${name}`, (db) => db.exec(`DROP TRIGGER ${name}; CREATE TRIGGER ${name} ${clause} BEGIN SELECT 1; END`)]),
  ];
  for (const [name, mutate] of cases) await t.test(name, () => rejectMutation(mutate));
});

test("MC-RC13-002 startup rejects a corrupt SQLite artifact", async () => {
  await withDatabase(async (path) => {
    openDatabase(path).close();
    const file = await openFile(path, "r+");
    try { await file.write(Buffer.alloc(16), 0, 16, 0); } finally { await file.close(); }
    assert.throws(() => openDatabase(path), /database|file is not a database|malformed/i);
  });
});
