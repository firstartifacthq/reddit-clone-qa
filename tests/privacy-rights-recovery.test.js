import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";

async function signup(app, username) {
  const response = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username, password: "privacy-pass-123" }) });
  return { account: await response.json(), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}

const actions = (database, jobId) => database.prepare("SELECT action FROM privacy_job_events WHERE job_id=? ORDER BY occurrence_sequence").all(jobId).map((event) => event.action);

test("AC-RC13-6 delayed, duplicate, and reordered deliveries complete each stable job once", async () => {
  const work = []; const app = createApp({ databasePath: ":memory:", schedulePrivacyWork: (run) => work.push(run) });
  const firstOwner = await signup(app, "recover-first");
  const secondOwner = await signup(app, "recover-second");
  const firstResponse = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: firstOwner.cookie } });
  const secondResponse = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: secondOwner.cookie } });
  const first = await firstResponse.json(); const second = await secondResponse.json();
  assert.equal(firstResponse.statusCode, 202); assert.equal(secondResponse.statusCode, 202);
  assert.notEqual(first.jobId, second.jobId);
  // Scheduler notifications carry no state: reverse and duplicate delivery still drains durable SQLite work.
  work.at(-1)(); work.at(-2)(); work.at(-1)();
  assert.deepEqual(actions(app.database, first.jobId), ["accepted", "completed"]);
  assert.deepEqual(actions(app.database, second.jobId), ["accepted", "completed"]);
  app.close();
});

test("AC-RC13-6 acceptance effects roll back together when interrupted before commit", async () => {
  const work = [];
  const app = createApp({ databasePath: ":memory:", schedulePrivacyWork: (run) => work.push(run), beforePrivacyAcceptance: () => { throw new Error("acceptance interrupted"); } });
  const owner = await signup(app, "accept-rollback");
  const response = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: owner.cookie } });
  assert.equal(response.statusCode, 503);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs").get().count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_job_events").get().count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads").get().count, 0);
  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: owner.cookie } })).statusCode, 200);
  assert.equal(work.length, 1, "only the startup drain was scheduled");
  app.close();
});

test("MC-RC13-001 deletion resumes after row erasure and interrupted compaction without completing early", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-privacy-recovery-"));
  const databasePath = join(directory, "privacy.sqlite");
  const authority = (account) => account.username === "admin";
  try {
    let scheduled = [];
    let app = createApp({ databasePath, administratorAuthority: authority, schedulePrivacyWork: (run) => scheduled.push(run), beforePrivacyPhase: (job) => {
      if (job.operation === "deletion" && job.phase === "rows_erased") throw new Error("stop before compaction");
    } });
    const admin = await signup(app, "admin");
    const owner = await signup(app, "phase-owner");
    const accepted = await app.inject({ method: "DELETE", path: "/api/me", headers: { cookie: owner.cookie } });
    const job = await accepted.json();
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted"]);
    assert.equal(app.database.prepare("SELECT phase FROM privacy_deletion_progress WHERE job_id=?").get(job.jobId).phase, "rows_erased");
    assert.equal((await app.inject({ method: "GET", path: `/api/admin/users/delete/${job.jobId}`, headers: { cookie: admin.cookie } })).statusCode, 200);
    app.close();

    // Reopen with a DatabaseSync adapter that fails while VACUUM executes. The committed
    // erasure checkpoint remains pending and retryable rather than exposing completion.
    scheduled = [];
    const interruptedDatabase = openDatabase(databasePath);
    let failVacuum = true;
    const compactionFaultDatabase = {
      prepare: (...args) => interruptedDatabase.prepare(...args),
      exec: (sql) => {
        if (failVacuum && sql.trim().toUpperCase() === "VACUUM") { failVacuum = false; throw new Error("compaction interrupted"); }
        return interruptedDatabase.exec(sql);
      },
      close: () => interruptedDatabase.close(),
    };
    app = createApp({ database: compactionFaultDatabase, administratorAuthority: authority, schedulePrivacyWork: (run) => scheduled.push(run) });
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted"]);
    assert.equal(app.database.prepare("SELECT phase FROM privacy_deletion_progress WHERE job_id=?").get(job.jobId).phase, "rows_erased");
    app.close(); interruptedDatabase.close();

    // A second reopen completes compaction but is stopped at the durable pre-completion
    // checkpoint. No public terminal event may be visible yet.
    scheduled = [];
    app = createApp({ databasePath, administratorAuthority: authority, schedulePrivacyWork: (run) => scheduled.push(run), beforePrivacyPhase: (work) => {
      if (work.operation === "deletion" && work.phase === "compacted") throw new Error("stop before completion");
    } });
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted"]);
    assert.equal(app.database.prepare("SELECT phase FROM privacy_deletion_progress WHERE job_id=?").get(job.jobId).phase, "compacted");
    app.close();

    scheduled = [];
    app = createApp({ databasePath, administratorAuthority: authority, schedulePrivacyWork: (run) => scheduled.push(run) });
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted", "completed"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_progress WHERE job_id=?").get(job.jobId).count, 0);
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted", "completed"]);
    app.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
