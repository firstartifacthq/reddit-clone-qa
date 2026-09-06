import assert from "node:assert/strict";
import test from "node:test";
import { rename } from "node:fs/promises";
import { PrivacyWorker } from "../src/privacy/privacy-worker.js";
import { processFixture } from "../tools/rc14-process-fixture.js";
import { fixture, signup, password } from "../tools/rc14-fixture.js";
import { createRuntime, createHttpServer } from "../src/server.js";
import { createApp } from "../src/app.js";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function body(response, status = 200) { assert.equal(response.status, status, response.url); const text = await response.text(); return text ? JSON.parse(text) : null; }
async function until(check) {
  for (let attempt = 0; attempt < 40; attempt++) { if (await check()) return; await wait(100); }
  assert.fail("autonomous recovery did not complete");
}
async function ledger(request) {
  const owner = await signup(request, "rc14-admin");
  const member = await signup(request, "rc14-member");
  const revoked = await signup(request, "rc14-revoked");
  assert.equal((await request("/api/auth/logout", "POST", undefined, revoked.cookie)).status, 204);
  await body(await request("/api/me", "PATCH", { bio: "durable profile" }, owner.cookie));
  await body(await request("/api/communities", "POST", { name: "recovery" }, owner.cookie), 201);
  await body(await request("/api/communities/recovery/members", "POST", undefined, member.cookie));
  await body(await request("/api/communities/recovery/moderators", "PATCH", { username: member.account.username, role: "moderator" }, owner.cookie));
  const post = await body(await request("/api/communities/recovery/posts", "POST", { type: "text", title: "durable post", text: "body" }, owner.cookie), 201);
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const media = await body(await request("/api/communities/recovery/posts", "POST", { type: "media", title: "durable media", media: { filename: "local.png", contentType: "image/png", bytesBase64: bytes.toString("base64") } }, owner.cookie), 201);
  await body(await request(`/api/posts/${post.id}/comments`, "POST", { body: "u/rc14-admin retained mention" }, member.cookie), 201);
  await body(await request(`/api/posts/${post.id}/vote`, "PUT", { value: 1 }, member.cookie));
  assert.equal((await request(`/api/posts/${post.id}/save`, "PUT", undefined, member.cookie)).status, 204);
  await body(await request(`/api/posts/${post.id}`, "GET", undefined, member.cookie));
  await body(await request("/api/me/preferences", "PATCH", { theme: "dark", compactMode: true }, member.cookie));
  const hidden = await body(await request("/api/communities/recovery/posts", "POST", { type: "text", title: "removed", text: "hidden" }, owner.cookie), 201);
  assert.equal((await request(`/api/mod/posts/${hidden.id}`, "DELETE", undefined, member.cookie)).status, 204);
  const deleted = await body(await request("/api/communities/recovery/posts", "POST", { type: "text", title: "deleted", text: "gone" }, owner.cookie), 201);
  assert.equal((await request(`/api/posts/${deleted.id}`, "DELETE", undefined, owner.cookie)).status, 204);
  const notices = await body(await request("/api/me/notifications", "GET", undefined, owner.cookie));
  assert.ok(notices.notifications.length > 0);
  assert.equal((await request(`/api/me/notifications/${notices.notifications[0].id}`, "PATCH", { read: true }, owner.cookie)).status, 204);
  const exported = await body(await request("/api/me/export", "POST", undefined, owner.cookie), 202);
  await until(async () => (await body(await request(`/api/me/export/jobs/${exported.jobId}`, "GET", undefined, owner.cookie))).state === "completed");
  const paths = [["/api/me", owner], ["/api/communities", owner], ["/api/communities/recovery/modlog", owner],
    [`/api/posts/${post.id}/comments`, owner], [`/api/posts/${post.id}/vote`, member], ["/api/me/saved", member],
    ["/api/me/history", member], ["/api/me/preferences", member], ["/api/me/notifications", owner],
    ["/api/communities/recovery/modlog", member], [`/api/me/export/jobs/${exported.jobId}/result`, owner], ["/api/admin/audit", owner], ["/api/feed/home", member]];
  async function observe() {
    const result = [];
    for (const [path, user] of paths) result.push([path, await body(await request(path, "GET", undefined, user.cookie))]);
    const response = await request(`/api/posts/${media.id}/media`); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    for (const target of [hidden, deleted]) assert.equal((await request(`/api/posts/${target.id}`)).status, 404);
    assert.equal((await request("/api/feed/home", "GET", undefined, revoked.cookie)).status, 401);
    return result;
  }
  return { observe, owner, member };
}
for (const signal of ["SIGTERM", "SIGKILL"]) test(`${signal} preserves the acknowledged authorized state ledger`, async () => {
  const f = await processFixture();
  try {
    await f.start();
    const state = await ledger(f.request);
    const before = await state.observe();
    await f.stop(signal); await f.start();
    assert.equal((await f.request("/health/ready")).status, 200);
    assert.deepEqual(await state.observe(), before);
    const login = await f.request("/api/auth/login", "POST", { username: state.member.account.username, password });
    assert.equal(login.status, 200); assert.deepEqual(await login.json(), state.member.account);
  } finally { await f.close(); }
});
for (const phase of ["export", "accepted", "rows_erased", "compacted"]) test(`abrupt restart resumes incomplete privacy ${phase} exactly once`, async () => {
  const f = await processFixture();
  try {
    await f.start(phase);
    const admin = await signup(f.request, "rc14-admin");
    const owner = await signup(f.request, "checkpoint-owner");
    const exporting = phase === "export";
    const accepted = await body(await f.request(exporting ? "/api/me/export" : "/api/me", exporting ? "POST" : "DELETE", undefined, owner.cookie), 202);
    const route = exporting ? `/api/me/export/jobs/${accepted.jobId}` : `/api/admin/users/delete/${accepted.jobId}`;
    const cookie = exporting ? owner.cookie : admin.cookie;
    await wait(600);
    assert.equal((await body(await f.request(route, "GET", undefined, cookie))).state, "pending");
    await f.stop("SIGKILL"); await f.start();
    await until(async () => (await body(await f.request(route, "GET", undefined, cookie))).state === "completed");
    const audit = await body(await f.request("/api/admin/audit", "GET", undefined, admin.cookie));
    await f.stop(); await f.start(); await wait(500);
    assert.deepEqual(await body(await f.request("/api/admin/audit", "GET", undefined, admin.cookie)), audit);
    if (!exporting) assert.equal((await f.request("/api/me", "GET", undefined, owner.cookie)).status, 401);
  } finally { await f.close(); }
});
test("dependency restoration resumes pending work without acceptance or health polling", async () => {
  let hold = true;
  const f = await fixture({ beforePrivacyPhase: () => { if (hold) throw new Error("hold"); } });
  try {
    const owner = await signup(f.request, "outage-owner");
    const job = await body(await f.request("/api/me/export", "POST", undefined, owner.cookie), 202);
    f.app.database.exec("PRAGMA query_only=ON"); hold = false;
    await wait(600);
    assert.equal(f.app.readiness.state, "degraded");
    assert.equal((await body(await f.request(`/api/me/export/jobs/${job.jobId}`, "GET", undefined, owner.cookie))).state, "pending");
    f.app.database.exec("PRAGMA query_only=OFF");
    await until(async () => (await body(await f.request(`/api/me/export/jobs/${job.jobId}`, "GET", undefined, owner.cookie))).state === "completed");
    const events = f.app.database.prepare("SELECT * FROM privacy_job_events ORDER BY occurrence_sequence").all();
    await wait(600); assert.deepEqual(f.app.database.prepare("SELECT * FROM privacy_job_events ORDER BY occurrence_sequence").all(), events);
    assert.equal(events.length, 2);
    assert.equal((await f.request("/health/ready")).status, 200);
  } finally { await f.close(); }
});
test("retained dependency restoration preserves the complete authorized ledger", async () => {
  const f = await fixture({ administratorAuthority: actor => actor.username === "rc14-admin" });
  try {
    const state = await ledger(f.request);
    const before = await state.observe();
    for (const fault of ["write", "path"]) {
      if (fault === "write") f.app.database.exec("PRAGMA query_only=ON");
      else await rename(f.databasePath, f.databasePath + ".retained");
      assert.equal((await f.request("/health/ready")).status, 503);
      if (fault === "write") f.app.database.exec("PRAGMA query_only=OFF");
      else await rename(f.databasePath + ".retained", f.databasePath);
      await wait(600);
      assert.equal(f.app.readiness.state, "ready");
      assert.deepEqual(await state.observe(), before);
      assert.equal((await f.request("/health/ready")).status, 200);
    }
  } finally { await f.close(); }
});
test("privacy work selection failure, reentrancy and late callbacks retain checkpoints", () => {
  let fail = true;
  const completed = [];
  const worker = new PrivacyWorker({ repository: { pendingWork() {
    if (fail) throw new Error("dependency unavailable");
    worker.drain();
    return [{ id: "pending-export", operation: "export" }];
  } }, service: { completeExport: id => completed.push(id) } });
  assert.doesNotThrow(() => worker.drain());
  assert.deepEqual(completed, []);
  fail = false;
  worker.drain();
  assert.deepEqual(completed, ["pending-export"]);
  worker.close(); worker.drain();
  assert.deepEqual(completed, ["pending-export"]);
  const closing = new PrivacyWorker({ repository: { pendingWork: () => [{ id: "closed-export", operation: "export" }] },
    service: { completeExport: id => completed.push(id) }, beforePhase: () => closing.close() });
  closing.drain();
  assert.deepEqual(completed, ["pending-export"]);
});
test("listener represents held initialization and autonomously retries retained storage", async () => {
  const f = await fixture();
  const owner = await signup(f.request, "startup-owner");
  f.app.close();
  let hold = true;
  const runtime = createRuntime({ databasePath: f.databasePath }, options => { if (hold) throw new Error("private startup path"); return createApp(options); });
  const server = createHttpServer(runtime);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + "/health/ready")).status, 503);
    await rename(f.databasePath, f.databasePath + ".retained");
    hold = false; await wait(600);
    assert.equal((await fetch(url + "/health/ready")).status, 503);
    await rename(f.databasePath + ".retained", f.databasePath);
    await wait(600);
    assert.equal((await fetch(url + "/health/ready")).status, 200);
    assert.equal((await fetch(url + "/api/me", { headers: { cookie: owner.cookie } })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); runtime.close(); await f.close(); }
});
