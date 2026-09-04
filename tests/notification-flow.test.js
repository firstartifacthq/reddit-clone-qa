import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
async function withApp(run) { const directory = await mkdtemp(join(tmpdir(), "reddit-notifications-")); const path = join(directory, "notifications.sqlite"); let now = 1_700_000_000_000; const app = createApp({ databasePath: path, now: () => now }); try { await run({ app, request: (route, options = {}) => app.inject({ path: route, ...options }), tick: () => { now += 1; } }); } finally { app.close(); await rm(directory, { recursive: true, force: true }); } }
function cookie(response) { return response.headers.get("set-cookie").split(";", 1)[0]; }
async function send(request, path, method, body, auth) { return request(path, { method, headers: { "content-type": "application/json", ...(auth ? { cookie: auth } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) }); }
async function user(request, username) { const response = await send(request, "/api/auth/signup", "POST", { username, password }); assert.equal(response.statusCode, 201); return { account: await response.json(), cookie: cookie(response) }; }
async function setup(request) { const owner = await user(request, "notice-owner"); const actor = await user(request, "notice-actor"); const mod = await user(request, "notice-mod"); assert.equal((await send(request, "/api/communities", "POST", { name: "noticeclub" }, owner.cookie)).statusCode, 201); for (const member of [actor, mod]) assert.equal((await request("/api/communities/noticeclub/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200); assert.equal((await send(request, "/api/communities/noticeclub/moderators", "PATCH", { username: mod.account.username, role: "moderator" }, owner.cookie)).statusCode, 200); const response = await send(request, "/api/communities/noticeclub/posts", "POST", { type: "text", title: "Notice post", text: "body" }, owner.cookie); assert.equal(response.statusCode, 201); return { owner, actor, mod, post: await response.json() }; }
async function inbox(request, owner, suffix = "") { const response = await request(`/api/me/notifications${suffix}`, { headers: { cookie: owner.cookie } }); assert.equal(response.statusCode, 200); return response.json(); }

test("AC-RC11-1 creates distinct reply, mention, vote, and removal notifications but excludes self and malformed mentions", async () => withApp(async ({ app, request, tick }) => {
  const { owner, actor, mod, post } = await setup(request);
  const root = await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "root" }, owner.cookie); const rootComment = await root.json(); tick();
  assert.equal((await send(request, `/api/posts/${post.id}/comments`, "POST", { body: `reply u/${owner.account.username} and u/${owner.account.username}`, parentId: rootComment.id }, actor.cookie)).statusCode, 201); tick();
  assert.equal((await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "embeddedxu/notice-owner and u/no", }, actor.cookie)).statusCode, 201);
  assert.equal((await send(request, `/api/posts/${post.id}/vote`, "PUT", { value: 1 }, actor.cookie)).statusCode, 200); tick();
  assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: mod.cookie } })).statusCode, 204);
  const page = await inbox(request, owner); assert.deepEqual(new Set(page.notifications.map((entry) => entry.kind)), new Set(["reply", "mention", "vote", "moderation"])); assert.equal(page.notifications.length, 4);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 4);
}));

test("AC-RC11-2 and AC-RC11-7 use owner-bound newest-first opaque snapshots without repeats or deleted gaps", async () => withApp(async ({ request, tick }) => {
  const { owner, actor, post } = await setup(request); const ids = [];
  for (const body of ["u/notice-owner one", "u/notice-owner two", "u/notice-owner three"]) { tick(); const response = await send(request, `/api/posts/${post.id}/comments`, "POST", { body }, actor.cookie); ids.push((await response.json()).id); }
  const first = await request("/api/me/notifications?limit=1", { headers: { cookie: owner.cookie } }); const firstBody = await first.json(); assert.ok(firstBody.nextCursor); assert.equal(firstBody.notifications[0].relatedItem.id, ids[2]);
  const foreign = await user(request, "notice-foreign"); const denied = await request(`/api/users/${owner.account.username}/notifications?cursor=${firstBody.nextCursor}`, { headers: { cookie: foreign.cookie } }); assert.equal(denied.statusCode, 403); assert.equal((await denied.text()).includes(ids[0]), false);
  const invalid = await request("/api/me/notifications?limit=0", { headers: { cookie: owner.cookie } }); assert.equal(invalid.statusCode, 422);
  const second = await request(`/api/me/notifications?limit=1&cursor=${firstBody.nextCursor}`, { headers: { cookie: owner.cookie } }); assert.equal(second.statusCode, 200); assert.notEqual((await second.json()).notifications[0].id, firstBody.notifications[0].id);
}));

test("AC-RC11-3, AC-RC11-4, and AC-RC11-5 preserve private mutation authority and terminal deletion", async () => withApp(async ({ app, request }) => {
  const { owner, actor, post } = await setup(request); await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "u/notice-owner" }, actor.cookie); const record = (await inbox(request, owner)).notifications[0];
  assert.equal((await request(`/api/me/notifications/${record.id}`, { method: "PATCH", headers: { cookie: owner.cookie, "content-type": "application/json" }, payload: JSON.stringify({ read: true }) })).statusCode, 204);
  assert.equal((await inbox(request, owner)).notifications[0].read, true);
  assert.equal((await request(`/api/me/notifications/${record.id}`, { method: "PATCH", headers: { cookie: actor.cookie, "content-type": "application/json" }, payload: JSON.stringify({ read: false }) })).statusCode, 404);
  assert.equal((await request(`/api/me/notifications/${record.id}`, { method: "PATCH", headers: { cookie: owner.cookie, "content-type": "application/json" }, payload: "{}" })).statusCode, 422);
  assert.equal((await request(`/api/me/notifications/${record.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  assert.equal((await inbox(request, owner)).notifications.length, 0);
  assert.throws(() => app.database.prepare("DELETE FROM notifications WHERE id = ?").run(record.id), /hard deleted/);
  assert.equal((await request(`/api/me/notifications/${record.id}`,  { method: "PATCH", headers: { cookie: owner.cookie, "content-type": "application/json" }, payload: JSON.stringify({ read: false }) })).statusCode, 404);
  assert.equal((await request(`/api/users/${owner.account.username}/notifications`)).statusCode, 401);
}));

test("AC-RC11-6 retries canonical event delivery only through the private capability", async () => withApp(async ({ app, request }) => {
  const { owner, actor, post } = await setup(request); await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "u/notice-owner" }, actor.cookie); const key = app.database.prepare("SELECT event_key FROM notification_events").get().event_key;
  assert.equal((await request("/api/notifications/delivery/retry", { method: "POST", headers: { "content-type": "application/json" }, payload: "{bad" })).statusCode, 403);
  assert.equal((await app.retryNotificationDelivery({ eventKey: key })).status, 204);
  assert.equal((await inbox(request, owner)).notifications.length, 1);
}));
