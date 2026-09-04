import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-")); const path = join(directory, "moderation.sqlite");
  let time = 1_700_000_000_000; const app = createApp({ databasePath: path, now: () => time, ...options });
  try { await run({ app, path, tick: () => { time += 1; }, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}
function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function send(request, path, method, body, auth) { return request(path, { method, headers: { "content-type": "application/json", ...(auth ? { cookie: auth } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) }); }
async function user(request, username) { const response = await send(request, "/api/auth/signup", "POST", { username, password }); assert.equal(response.statusCode, 201); return { account: await response.json(), cookie: cookie(response) }; }
async function createPost(request, owner, community, title) { const response = await send(request, `/api/communities/${community}/posts`, "POST", { type: "text", title, text: title }, owner.cookie); assert.equal(response.statusCode, 201); return response.json(); }
async function setup(request) { const owner = await user(request, "moderation-owner"); const member = await user(request, "moderation-member"); assert.equal((await send(request, "/api/communities", "POST", { name: "modqueue" }, owner.cookie)).statusCode, 201); assert.equal((await request("/api/communities/modqueue/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200); return { owner, member, post: await createPost(request, owner, "modqueue", "Reported post") }; }
function counts(database) { return Object.fromEntries(["reports", "moderation_audit_events", "moderation_queue_traversals", "moderation_queue_items", "moderation_queue_tokens"].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count])); }
async function report(request, member, post) { return request(`/api/posts/${post.id}/reports`, { method: "POST", headers: { cookie: member.cookie } }); }

test("SCN-RC-09-H1 commits one member report, rolls back a fault, and survives reopen", async () => {
  let fail = true;
  await withApp(async ({ app, path, request }) => {
    const { owner, member, post } = await setup(request);
    assert.equal((await report(request, member, post)).statusCode, 503, "pre-commit fault must not acknowledge a report");
    assert.deepEqual(counts(app.database), { reports: 0, moderation_audit_events: 0, moderation_queue_traversals: 0, moderation_queue_items: 0, moderation_queue_tokens: 0 });
    const created = await report(request, member, post); assert.equal(created.statusCode, 201); assert.equal((await created.json()).postId, post.id);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM reports WHERE post_id = ? AND reporter_user_id = ?").get(post.id, member.account.id).count, 1);
    app.close(); const reopened = createApp({ databasePath: path, now: () => 1_700_000_000_000 });
    const queue = await reopened.inject({ path: "/api/mod/queue", headers: { cookie: owner.cookie } }); assert.equal(queue.statusCode, 200); assert.equal((await queue.json()).reports.length, 1); reopened.close();
  }, { beforeModerationCommit: () => { if (fail) { fail = false; throw new Error("injected moderation fault"); } } });
});

test("SCN-RC-09-H2 snapshots only authorized report queues in deterministic opaque pages", async () => withApp(async ({ app, request }) => {
  const { owner, member, post } = await setup(request); const second = await createPost(request, owner, "modqueue", "Second report"); const third = await createPost(request, owner, "modqueue", "Third report");
  for (const value of [post, second, third]) assert.equal((await report(request, member, value)).statusCode, 201);
  const outsider = await user(request, "queue-outsider"); assert.equal((await send(request, "/api/communities", "POST", { name: "elsewhere" }, outsider.cookie)).statusCode, 201); const hidden = await createPost(request, outsider, "elsewhere", "never-disclose-queue-marker"); assert.equal((await report(request, outsider, hidden)).statusCode, 201);
  const first = await request("/api/mod/queue?limit=1", { headers: { cookie: owner.cookie } }); assert.equal(first.statusCode, 200); const firstBody = await first.json(); assert.ok(firstBody.nextCursor); assert.deepEqual(firstBody.reports.map((entry) => entry.postId), [post.id]);
  const secondPage = await request(`/api/mod/queue?limit=1&cursor=${firstBody.nextCursor}`, { headers: { cookie: owner.cookie } }); const replay = await request(`/api/mod/queue?limit=1&cursor=${firstBody.nextCursor}`, { headers: { cookie: owner.cookie } }); assert.deepEqual(await replay.json(), await secondPage.json(), "replayed cursor has identical page");
  const thirdPage = await request(`/api/mod/queue?limit=1&cursor=${(await secondPage.json()).nextCursor}`, { headers: { cookie: owner.cookie } }); const seen = [...firstBody.reports, ...(await replay.json()).reports, ...(await thirdPage.json()).reports].map((entry) => entry.id); assert.equal(new Set(seen).size, 3); assert.equal(JSON.stringify(seen).includes("never-disclose-queue-marker"), false);
  const before = counts(app.database); const denied = await request(`/api/mod/queue?cursor=${firstBody.nextCursor}`, { headers: { cookie: outsider.cookie } }); assert.equal(denied.statusCode, 422); assert.deepEqual(counts(app.database), before, "cross-account cursor has no write effect");
}));

test("SCN-RC-09-H3 enforces database report uniqueness without queue amplification", async () => withApp(async ({ app, request }) => { const { owner, member, post } = await setup(request); assert.equal((await report(request, member, post)).statusCode, 201); const first = await request("/api/mod/queue?limit=1", { headers: { cookie: owner.cookie } }); const before = counts(app.database); const changes = app.database.prepare("SELECT total_changes() AS count").get().count; const response = await report(request, member, post); assert.equal(response.statusCode, 409); assert.deepEqual(counts(app.database), before); assert.equal(app.database.prepare("SELECT total_changes() AS count").get().count, changes); assert.deepEqual((await first.json()).reports.map((entry) => entry.postId), [post.id]); }));

test("SCN-RC-09-H4 denies members and nonmembers before moderation effects", async () => withApp(async ({ app, request }) => { const { member, post } = await setup(request); const stranger = await user(request, "moderation-stranger"); const before = counts(app.database); for (const actor of [member, stranger]) { const response = await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: actor.cookie } }); assert.equal(response.statusCode, 403); assert.deepEqual(await response.json(), { error: "Forbidden" }); } assert.deepEqual(counts(app.database), before); assert.equal((await request(`/api/posts/${post.id}`)).statusCode, 200); }));

test("SCN-RC-09-H5 restores normal readable surfaces and ordered immutable audit history", async () => withApp(async ({ app, request }) => { const { owner, member, post } = await setup(request); await report(request, member, post); assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204); for (const [route, expected] of [[`/api/posts/${post.id}`, 404], ["/api/feed/popular", 200], [`/api/communities/modqueue/feed`, 200], ["/api/search?q=reported", 200]]) { const response = await request(route); assert.equal(response.statusCode, expected); assert.equal((await response.text()).includes(post.id), false, `${route} excludes removed content`); } const restored = await request(`/api/mod/posts/${post.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } }); assert.equal(restored.statusCode, 200); assert.equal((await restored.json()).id, post.id); assert.equal((await request(`/api/posts/${post.id}`)).statusCode, 200); const log = await request("/api/communities/modqueue/modlog", { headers: { cookie: owner.cookie } }); assert.deepEqual((await log.json()).entries.map((entry) => entry.action), ["removed", "restored"]); assert.throws(() => app.database.prepare("UPDATE moderation_audit_events SET action = 'removed'").run(), /immutable/); const auditCount = app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count; assert.equal((await request(`/api/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count, auditCount, "audit evidence retains target identity after author deletion"); }));

test("SCN-RC-09-H6 retries removal as a no-op after one completed transition", async () => withApp(async ({ app, request }) => { const { owner, member, post } = await setup(request); await report(request, member, post); assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204); const before = counts(app.database); assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204); assert.deepEqual(counts(app.database), before); assert.equal((await request(`/api/posts/${post.id}`)).statusCode, 404); }));

test("SCN-RC-09-H7 rejects every audit patch before parsing or mutation", async () => withApp(async ({ app, request }) => { const { owner, post } = await setup(request); await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } }); const before = counts(app.database); for (const auth of [undefined, owner.cookie]) { const response = await request("/api/mod/audit/not-an-id", { method: "PATCH", headers: auth ? { cookie: auth } : {}, payload: "{malformed" }); assert.equal(response.statusCode, 405); assert.deepEqual(await response.json(), { error: "Method not allowed" }); } assert.deepEqual(counts(app.database), before); assert.throws(() => app.database.prepare("DELETE FROM moderation_audit_events").run(), /cannot be deleted/); }));
