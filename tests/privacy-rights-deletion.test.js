import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

async function signup(app, username) {
  const response = await app.inject({
    method: "POST",
    path: "/api/auth/signup",
    payload: JSON.stringify({ username, password: "privacy-pass-123" }),
  });
  return {
    account: await response.json(),
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
  };
}

test("AC-RC13-5 unauthenticated deletion has no effect", async () => {
  const app = createApp({ databasePath: ":memory:" });
  const result = await app.inject({ method: "DELETE", path: "/api/me" });
  assert.equal(result.statusCode, 401);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs").get().count, 0);
  app.close();
});

test("AC-RC13-5A administrator deletion restricts only its target and repeated acceptance returns the same pending job", async () => {
  const scheduled = [];
  const administrators = new Set();
  const app = createApp({
    databasePath: ":memory:",
    administratorAuthority: (account) => administrators.has(account.id),
    schedulePrivacyWork: (run) => scheduled.push(run),
  });
  const admin = await signup(app, "delete-admin");
  administrators.add(admin.account.id);
  const target = await signup(app, "delete-target");
  const unrelated = await signup(app, "delete-unrelated");
  const targetLogin = await app.inject({
    method: "POST",
    path: "/api/auth/login",
    payload: JSON.stringify({ username: "delete-target", password: "privacy-pass-123" }),
  });
  const targetSecondCookie = targetLogin.headers.get("set-cookie").split(";", 1)[0];

  const accepted = await app.inject({
    method: "POST",
    path: "/api/admin/users/delete",
    headers: { cookie: admin.cookie },
    payload: JSON.stringify({ userId: target.account.id }),
  });
  const job = await accepted.json();
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(job, { jobId: job.jobId, operation: "deletion", state: "pending" });

  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: target.cookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: targetSecondCookie } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", path: "/api/users/delete-target" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: unrelated.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", path: "/api/me", headers: { cookie: admin.cookie } })).statusCode, 200);

  const repeated = await app.inject({
    method: "POST",
    path: "/api/admin/users/delete",
    headers: { cookie: admin.cookie },
    payload: JSON.stringify({ userId: target.account.id }),
  });
  assert.equal(repeated.statusCode, 202);
  assert.deepEqual(await repeated.json(), job);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs WHERE operation='deletion' AND subject_key=?").get(target.account.id).count, 1);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_job_events WHERE job_id=? AND action='accepted'").get(job.jobId).count, 1);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs WHERE operation='deletion' AND subject_key=?").get(unrelated.account.id).count, 0);

  const status = await app.inject({
    method: "GET",
    path: `/api/admin/users/delete/${job.jobId}`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(await status.json(), job);
  assert.equal(scheduled.length, 2, "startup and the single effective acceptance schedule work");
  app.close();
});
