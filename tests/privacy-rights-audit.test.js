import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

async function signup(app, username) {
  const response = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username, password: "privacy-pass-123" }) });
  return { account: await response.json(), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}

async function acceptAndCompleteExport(app, cookie, scheduled) {
  const response = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie } });
  assert.equal(response.statusCode, 202);
  scheduled.at(-1)();
  return response.json();
}

async function audit(app, cookie, limit, cursor) {
  const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  const response = await app.inject({ method: "GET", path: `/api/admin/audit?limit=${limit}${suffix}`, headers: { cookie } });
  return { response, body: await response.json() };
}

test("AC-RC13-2 audit is ordered, snapshot bounded, replayable, immutable, and authorization checked per page", async () => {
  const scheduled = [];
  const administrators = new Set();
  const app = createApp({
    databasePath: ":memory:",
    now: () => 7,
    schedulePrivacyWork: (work) => scheduled.push(work),
    administratorAuthority: (account) => administrators.has(account.id),
  });
  const admin = await signup(app, "audit-admin");
  const firstOwner = await signup(app, "audit-owner-one");
  const secondOwner = await signup(app, "audit-owner-two");
  const ordinary = await signup(app, "audit-ordinary");
  administrators.add(admin.account.id);
  await acceptAndCompleteExport(app, firstOwner.cookie, scheduled);
  await acceptAndCompleteExport(app, secondOwner.cookie, scheduled);

  const firstPage = await audit(app, admin.cookie, 1);
  assert.equal(firstPage.response.statusCode, 200);
  assert.equal(firstPage.body.events.length, 1);
  assert.ok(firstPage.body.nextCursor);

  const laterOwner = await signup(app, "audit-owner-later");
  await acceptAndCompleteExport(app, laterOwner.cookie, scheduled);

  const replayA = await audit(app, admin.cookie, 1, firstPage.body.nextCursor);
  const replayB = await audit(app, admin.cookie, 1, firstPage.body.nextCursor);
  assert.deepEqual(replayB.body, replayA.body, "replaying a continuation returns the same page and continuation");

  const retained = [...firstPage.body.events];
  let cursor = firstPage.body.nextCursor;
  while (cursor) {
    const page = await audit(app, admin.cookie, 1, cursor);
    assert.equal(page.response.statusCode, 200);
    retained.push(...page.body.events);
    cursor = page.body.nextCursor;
  }
  assert.deepEqual(retained.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(retained.map((event) => event.action), ["accepted", "completed", "accepted", "completed"]);
  assert.equal(new Set(retained.map((event) => event.id)).size, retained.length);
  assert.ok(retained.every((event) => event.occurredAt === 7));

  const fresh = await audit(app, admin.cookie, 100);
  assert.deepEqual(fresh.body.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(JSON.stringify(fresh.body).includes("audit-owner"), false, "audit representations contain no recoverable subject identity");

  const ordinaryRead = await app.inject({ method: "GET", path: "/api/admin/audit?limit=1", headers: { cookie: ordinary.cookie } });
  assert.equal(ordinaryRead.statusCode, 403);
  administrators.delete(admin.account.id);
  const removedGrant = await app.inject({ method: "GET", path: `/api/admin/audit?limit=1&cursor=${firstPage.body.nextCursor}`, headers: { cookie: admin.cookie } });
  assert.equal(removedGrant.statusCode, 403);
  administrators.add(admin.account.id);

  const originalRows = app.database.prepare("SELECT * FROM privacy_job_events ORDER BY occurrence_sequence").all();
  assert.throws(() => app.database.prepare("UPDATE privacy_job_events SET occurred_at=8 WHERE id=?").run(originalRows[0].id), /immutable/);
  assert.throws(() => app.database.prepare("DELETE FROM privacy_job_events WHERE id=?").run(originalRows[0].id), /cannot be deleted/);
  for (const method of ["DELETE", "PATCH", "PUT", "POST"]) {
    const rejected = await app.inject({ method, path: `/api/admin/audit/${originalRows[0].id}`, headers: { cookie: admin.cookie }, payload: "not-json" });
    assert.equal(rejected.statusCode, 405, `${method} audit tampering is rejected before body parsing`);
  }
  assert.deepEqual(app.database.prepare("SELECT * FROM privacy_job_events ORDER BY occurrence_sequence").all(), originalRows);
  app.close();
});
