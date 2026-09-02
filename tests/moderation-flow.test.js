import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-")); const path = join(directory, "moderation.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, options = {}) => app.inject({ path: route, ...options }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}
function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function json(request, path, method, body, session) { return request(path, { method, headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) }, payload: JSON.stringify(body) }); }
async function signup(request, username) { const response = await json(request, "/api/auth/signup", "POST", { username, password }); return { account: await response.json(), cookie: cookie(response) }; }
async function fixture(request) {
  const owner = await signup(request, "moderation-owner"); const reporter = await signup(request, "moderation-member"); const outsider = await signup(request, "moderation-outsider");
  assert.equal((await json(request, "/api/communities", "POST", { name: "modqueue" }, owner.cookie)).statusCode, 201);
  assert.equal((await request("/api/communities/modqueue/members", { method: "POST", headers: { cookie: reporter.cookie } })).statusCode, 200);
  const created = await json(request, "/api/communities/modqueue/posts", "POST", { type: "text", title: "reportable", text: "body" }, reporter.cookie);
  return { owner, reporter, outsider, post: await created.json() };
}

test("SCN-RC-09-H1 creates one trimmed durable report without an audit event", async () => withApp(async ({ app, request, path }) => {
  const { owner, reporter, post } = await fixture(request);
  const response = await json(request, `/api/posts/${post.id}/reports`, "POST", { reason: "  useful reason  " }, reporter.cookie);
  assert.equal(response.statusCode, 201); const report = await response.json(); assert.equal(report.reason, "useful reason"); assert.equal(Object.hasOwn(report, "reporter"), false);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM reports WHERE state = 'open'").get().count, 1);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count, 0);
  assert.equal((await request("/api/mod/queue", { headers: { cookie: owner.cookie } })).statusCode, 200);
  app.close(); const reopened = createApp({ databasePath: path }); assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM reports").get().count, 1); reopened.close();
}));

test("SCN-RC-09-H2 queues stable authority-scoped pages and rejects invalid pages", async () => withApp(async ({ request }) => {
  const { owner, reporter, post } = await fixture(request);
  assert.equal((await json(request, `/api/posts/${post.id}/reports`, "POST", { reason: "one" }, reporter.cookie)).statusCode, 201);
  const first = await request("/api/mod/queue?limit=1", { headers: { cookie: owner.cookie } }); assert.equal(first.statusCode, 200); const page = await first.json(); assert.equal(page.reports.length, 1);
  for (const suffix of ["?limit=0", "?extra=1", "?cursor=bad!", "?limit=1&limit=2"]) assert.equal((await request(`/api/mod/queue${suffix}`, { headers: { cookie: owner.cookie } })).statusCode, 422);
}));

test("SCN-RC-09-H3 rejects malformed, invalid, and duplicate reports without extra rows", async () => withApp(async ({ app, request }) => {
  const { reporter, post } = await fixture(request); const route = `/api/posts/${post.id}/reports`;
  assert.equal((await request(route, { method: "POST", headers: { "content-type": "application/json", cookie: reporter.cookie }, payload: "{" })).statusCode, 422);
  assert.equal((await json(request, route, "POST", { reason: "" }, reporter.cookie)).statusCode, 422);
  assert.equal((await json(request, route, "POST", { reason: "one" }, reporter.cookie)).statusCode, 201);
  assert.equal((await json(request, route, "POST", { reason: "two" }, reporter.cookie)).statusCode, 409);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM reports").get().count, 1);
}));

test("SCN-RC-09-H4 requires membership and current moderator authority", async () => withApp(async ({ request }) => {
  const { outsider, post } = await fixture(request);
  assert.equal((await request(`/api/posts/${post.id}/reports`, { method: "POST", headers: { "content-type": "application/json" }, payload: "{" })).statusCode, 401);
  assert.equal((await json(request, `/api/posts/${post.id}/reports`, "POST", { reason: "x" }, outsider.cookie)).statusCode, 403);
  assert.equal((await request("/api/mod/queue", { headers: { cookie: outsider.cookie } })).statusCode, 403);
}));

test("SCN-RC-09-H5 removes and restores content with immutable audit events", async () => withApp(async ({ app, request }) => {
  const { owner, reporter, post } = await fixture(request); await json(request, `/api/posts/${post.id}/reports`, "POST", { reason: "x" }, reporter.cookie);
  assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  assert.equal((await request(`/api/posts/${post.id}`)).statusCode, 404); assert.equal(app.database.prepare("SELECT state FROM reports").get().state, "resolved");
  assert.equal((await request(`/api/mod/posts/${post.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } })).statusCode, 200);
  assert.equal((await request(`/api/posts/${post.id}`)).statusCode, 200);
  assert.deepEqual(app.database.prepare("SELECT action FROM moderation_audit_events ORDER BY created_at, id").all().map((row) => row.action), ["remove", "restore"]);
}));

test("SCN-RC-09-H6 rolls back injected moderation failures and retries idempotently", async () => withApp(async ({ app, request }) => {
  const { owner, post } = await fixture(request); let fail = true; app.close();
  const broken = createApp({ databasePath: app.config.databasePath, now: () => 1_700_000_000_000, beforeModerationPersist: () => { if (fail) throw new Error("transient"); } });
  const denied = await broken.inject({ path: `/api/mod/posts/${post.id}`, method: "DELETE", headers: { cookie: owner.cookie } }); assert.equal(denied.statusCode, 503); assert.equal(broken.database.prepare("SELECT moderation_state FROM posts WHERE id = ?").get(post.id).moderation_state, "visible");
  fail = false; assert.equal((await broken.inject({ path: `/api/mod/posts/${post.id}`, method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  assert.equal((await broken.inject({ path: `/api/mod/posts/${post.id}`, method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204); assert.equal(broken.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count, 1); broken.close();
}));

test("SCN-RC-09-H7 keeps denied moderation and audit mutation side-effect free", async () => withApp(async ({ app, request }) => {
  const { owner, outsider, post } = await fixture(request); assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: outsider.cookie } })).statusCode, 403);
  assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204); const event = app.database.prepare("SELECT id FROM moderation_audit_events").get();
  const response = await request(`/api/mod/audit/${event.id}`, { method: "PATCH", headers: { cookie: owner.cookie } }); assert.equal(response.statusCode, 405); assert.equal(response.headers.get("allow"), "GET");
  assert.throws(() => app.database.prepare("DELETE FROM moderation_audit_events WHERE id = ?").run(event.id));
}));
