import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("AC-RC13-6A pre-commit failure has no partial acceptance and lost-response retries resolve the committed jobs", async () => {
  const work = [];
  const administrators = new Set();
  let interruptAcceptance = false;
  const app = createApp({
    databasePath: ":memory:",
    administratorAuthority: (account) => administrators.has(account.id),
    schedulePrivacyWork: (run) => work.push(run),
    beforePrivacyAcceptance: () => {
      if (interruptAcceptance) throw new Error("acceptance interrupted");
    },
  });
  const admin = await signup(app, "recovery-admin");
  administrators.add(admin.account.id);
  const exportOwner = await signup(app, "recovery-export");

  interruptAcceptance = true;
  const rejectedExport = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: exportOwner.cookie } });
  assert.equal(rejectedExport.statusCode, 503);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs").get().count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_job_events").get().count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads").get().count, 0);
  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: exportOwner.cookie } })).statusCode, 200);

  interruptAcceptance = false;
  const acceptedExport = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: exportOwner.cookie } });
  const exportJob = await acceptedExport.json();
  assert.equal(acceptedExport.statusCode, 202);
  // Treat the first committed response as lost. Repeating the request must resolve the durable pending job.
  const repeatedExport = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: exportOwner.cookie } });
  assert.equal(repeatedExport.statusCode, 202);
  assert.deepEqual(await repeatedExport.json(), exportJob);
  assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted"]);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 1);

  const deletionTarget = await signup(app, "recovery-delete");
  const secondLogin = await app.inject({
    method: "POST",
    path: "/api/auth/login",
    payload: JSON.stringify({ username: "recovery-delete", password: "privacy-pass-123" }),
  });
  const secondCookie = secondLogin.headers.get("set-cookie").split(";", 1)[0];
  const acceptedTargetExport = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: deletionTarget.cookie } });
  const targetExportJob = await acceptedTargetExport.json();
  const targetPayload = app.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(targetExportJob.jobId).payload_json;
  const eventsBeforeDeletion = app.database.prepare("SELECT COUNT(*) AS count FROM privacy_job_events").get().count;

  interruptAcceptance = true;
  const rejectedDeletion = await app.inject({
    method: "POST",
    path: "/api/admin/users/delete",
    headers: { cookie: admin.cookie },
    payload: JSON.stringify({ userId: deletionTarget.account.id }),
  });
  assert.equal(rejectedDeletion.statusCode, 503);
  assert.equal(app.database.prepare("SELECT deletion_requested_at FROM users WHERE id=?").get(deletionTarget.account.id).deletion_requested_at, null);
  assert.deepEqual(app.database.prepare("SELECT revoked_at FROM sessions WHERE user_id=? ORDER BY rowid").all(deletionTarget.account.id).map((row) => row.revoked_at), [null, null]);
  assert.deepEqual(actions(app.database, targetExportJob.jobId), ["accepted"]);
  assert.equal(app.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(targetExportJob.jobId).payload_json, targetPayload);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs WHERE operation='deletion'").get().count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_progress").get().count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_job_events").get().count, eventsBeforeDeletion);
  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: deletionTarget.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: secondCookie } })).statusCode, 200);

  interruptAcceptance = false;
  const acceptedDeletion = await app.inject({
    method: "POST",
    path: "/api/admin/users/delete",
    headers: { cookie: admin.cookie },
    payload: JSON.stringify({ userId: deletionTarget.account.id }),
  });
  const deletionJob = await acceptedDeletion.json();
  assert.equal(acceptedDeletion.statusCode, 202);
  // The committed administrative response is now considered lost as well.
  const repeatedDeletion = await app.inject({
    method: "POST",
    path: "/api/admin/users/delete",
    headers: { cookie: admin.cookie },
    payload: JSON.stringify({ userId: deletionTarget.account.id }),
  });
  assert.equal(repeatedDeletion.statusCode, 202);
  assert.deepEqual(await repeatedDeletion.json(), deletionJob);
  assert.deepEqual(actions(app.database, targetExportJob.jobId), ["accepted", "revoked"]);
  assert.deepEqual(actions(app.database, deletionJob.jobId), ["accepted"]);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(targetExportJob.jobId).count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_progress WHERE job_id=? AND phase='accepted'").get(deletionJob.jobId).count, 1);
  assert.equal(work.length, 4, "only startup and the three effective acceptances schedule work");
  app.close();
});

test("MC-RC13-003 deletion acceptance rollback preserves every durable effect before persistent retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-privacy-acceptance-"));
  const databasePath = join(directory, "privacy.sqlite");
  try {
    let interruptAcceptance = false;
    let scheduled = [];
    let app = createApp({
      databasePath,
      schedulePrivacyWork: (run) => scheduled.push(run),
      beforePrivacyAcceptance: () => { if (interruptAcceptance) throw new Error("deletion acceptance interrupted"); },
    });
    const owner = await signup(app, "deletion-rollback");
    const secondLogin = await app.inject({
      method: "POST",
      path: "/api/auth/login",
      payload: JSON.stringify({ username: "deletion-rollback", password: "privacy-pass-123" }),
    });
    const secondCookie = secondLogin.headers.get("set-cookie").split(";", 1)[0];
    const exportResponse = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: owner.cookie } });
    const exportJob = await exportResponse.json();
    scheduled.at(-1)();
    const payloadBefore = app.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).payload_json;
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "completed"]);

    interruptAcceptance = true;
    const interrupted = await app.inject({ method: "DELETE", path: "/api/me", headers: { cookie: owner.cookie } });
    assert.equal(interrupted.statusCode, 503);
    assert.equal(app.database.prepare("SELECT deletion_requested_at FROM users WHERE id=?").get(owner.account.id).deletion_requested_at, null);
    assert.deepEqual(app.database.prepare("SELECT revoked_at FROM sessions WHERE user_id=? ORDER BY issued_at").all(owner.account.id).map((row) => row.revoked_at), [null, null]);
    assert.equal(app.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).payload_json, payloadBefore);
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "completed"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs WHERE operation='deletion'").get().count, 0);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_deletion_progress").get().count, 0);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_job_events").get().count, 2);
    assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: owner.cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: secondCookie } })).statusCode, 200);
    app.close();

    // Reopening proves the rollback, not live connection state, is authoritative.
    scheduled = [];
    app = createApp({ databasePath, schedulePrivacyWork: (run) => scheduled.push(run) });
    assert.equal(app.database.prepare("SELECT deletion_requested_at FROM users WHERE id=?").get(owner.account.id).deletion_requested_at, null);
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "completed"]);
    assert.equal(app.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).payload_json, payloadBefore);
    const retried = await app.inject({ method: "DELETE", path: "/api/me", headers: { cookie: secondCookie } });
    const deletionJob = await retried.json();
    assert.equal(retried.statusCode, 202);
    assert.equal(deletionJob.state, "pending");
    assert.equal(app.database.prepare("SELECT deletion_requested_at IS NOT NULL AS restricted FROM users WHERE id=?").get(owner.account.id).restricted, 1);
    assert.deepEqual(app.database.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE user_id=? ORDER BY issued_at").all(owner.account.id).map((row) => row.revoked), [1, 1]);
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "completed", "revoked"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 0);
    assert.deepEqual(actions(app.database, deletionJob.jobId), ["accepted"]);
    assert.equal(app.database.prepare("SELECT phase FROM privacy_deletion_progress WHERE job_id=?").get(deletionJob.jobId).phase, "accepted");
    app.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("MC-RC13-003 interrupted export resumes its original durable snapshot exactly once after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-privacy-export-resume-"));
  const databasePath = join(directory, "privacy.sqlite");
  try {
    let scheduled = [];
    let app = createApp({
      databasePath,
      schedulePrivacyWork: (run) => scheduled.push(run),
      beforePrivacyPhase: (job) => { if (job.operation === "export") throw new Error("export processing interrupted"); },
    });
    const owner = await signup(app, "persistent-export");
    await app.inject({ method: "PATCH", path: "/api/me", headers: { cookie: owner.cookie }, payload: JSON.stringify({ bio: "accepted-snapshot-canary" }) });
    const accepted = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: owner.cookie } });
    const job = await accepted.json();
    assert.equal(accepted.statusCode, 202);
    const acceptedPayload = app.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(job.jobId).payload_json;
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(job.jobId).count, 1);
    app.close();

    scheduled = [];
    app = createApp({ databasePath, schedulePrivacyWork: (run) => scheduled.push(run) });
    const pending = await app.inject({ method: "GET", path: `/api/me/export/jobs/${job.jobId}`, headers: { cookie: owner.cookie } });
    assert.deepEqual(await pending.json(), { jobId: job.jobId, operation: "export", state: "pending" });
    assert.equal(app.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(job.jobId).payload_json, acceptedPayload);
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted", "completed"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=? AND payload_json=?").get(job.jobId, acceptedPayload).count, 1);
    const completed = await app.inject({ method: "GET", path: `/api/me/export/jobs/${job.jobId}/result`, headers: { cookie: owner.cookie } });
    assert.equal(completed.statusCode, 200);
    assert.equal((await completed.json()).account.bio, "accepted-snapshot-canary");
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted", "completed"]);
    app.close();

    scheduled = [];
    app = createApp({ databasePath, schedulePrivacyWork: (run) => scheduled.push(run) });
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, job.jobId), ["accepted", "completed"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=? AND payload_json=?").get(job.jobId, acceptedPayload).count, 1);
    app.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("MC-RC13-003 stale export delivery cannot resurrect a revoked export before or after persistent erasure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-privacy-no-resurrection-"));
  const databasePath = join(directory, "privacy.sqlite");
  const canary = "stale-export-erasure-canary";
  try {
    let holdDeletion = true;
    let scheduled = [];
    let app = createApp({
      databasePath,
      schedulePrivacyWork: (run) => scheduled.push(run),
      beforePrivacyPhase: (job) => { if (holdDeletion && job.operation === "deletion") throw new Error("hold deletion pending"); },
    });
    const owner = await signup(app, canary);
    const acceptedExport = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: owner.cookie } });
    const exportJob = await acceptedExport.json();
    const staleExportDelivery = scheduled.at(-1);
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted"]);

    const acceptedDeletion = await app.inject({ method: "DELETE", path: "/api/me", headers: { cookie: owner.cookie } });
    const deletionJob = await acceptedDeletion.json();
    const deletionDelivery = scheduled.at(-1);
    assert.equal(acceptedDeletion.statusCode, 202);
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "revoked"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 0);

    staleExportDelivery();
    staleExportDelivery();
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "revoked"]);
    assert.deepEqual(actions(app.database, deletionJob.jobId), ["accepted"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 0);

    holdDeletion = false;
    deletionDelivery();
    assert.deepEqual(actions(app.database, deletionJob.jobId), ["accepted", "completed"]);
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "revoked"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_job_events WHERE job_id=? AND action='completed'").get(exportJob.jobId).count, 0);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 0);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(owner.account.id).count, 0);
    staleExportDelivery();
    deletionDelivery();
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "revoked"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 0);
    app.close();

    // Closed callbacks and a fresh startup drain both remain harmless, and the compacted
    // artifact no longer contains the snapshot's erased identity canary.
    staleExportDelivery();
    assert.equal((await readFile(databasePath)).includes(Buffer.from(canary)), false);
    scheduled = [];
    app = createApp({ databasePath, schedulePrivacyWork: (run) => scheduled.push(run) });
    scheduled.at(-1)();
    assert.deepEqual(actions(app.database, exportJob.jobId), ["accepted", "revoked"]);
    assert.deepEqual(actions(app.database, deletionJob.jobId), ["accepted", "completed"]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_export_payloads WHERE job_id=?").get(exportJob.jobId).count, 0);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(owner.account.id).count, 0);
    app.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
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
