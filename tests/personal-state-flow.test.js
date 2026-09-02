import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-personal-"));
  const path = join(directory, "personal.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, options = {}) => app.inject({ path: route, ...options }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}
function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function send(request, path, method, payload, session) {
  return request(path, { method, headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) }, payload: payload === undefined ? undefined : JSON.stringify(payload) });
}
async function signup(request, username) { const response = await send(request, "/api/auth/signup", "POST", { username, password }); assert.equal(response.statusCode, 201); return { cookie: cookie(response), account: await response.json() }; }
async function owner(request, username = "personal-owner") { const user = await signup(request, username); assert.equal((await send(request, "/api/communities", "POST", { name: "personal" }, user.cookie)).statusCode, 201); return user; }
async function post(request, user, title = "Personal post") { const response = await send(request, "/api/communities/personal/posts", "POST", { type: "text", title, text: title }, user.cookie); assert.equal(response.statusCode, 201); return response.json(); }
async function fixed(response, status, body) { assert.equal(response.statusCode, status); assert.deepEqual(Object.fromEntries(response.headers), { "content-type": "application/json; charset=utf-8" }); assert.deepEqual(await response.json(), body); }

test("SCN-RC-12-H1 saves one readable post durably", async () => { await withApp(async ({ app, path, request }) => {
  const user = await owner(request); const saved = await post(request, user); const route = `/api/posts/${saved.id}/save`;
  for (let i = 0; i < 2; i++) { const response = await send(request, route, "PUT", undefined, user.cookie); assert.equal(response.statusCode, 204); assert.equal(await response.text(), ""); }
  assert.deepEqual(await (await request("/api/me/saved", { headers: { cookie: user.cookie } })).json(), { posts: [saved], nextCursor: null });
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts").get().count, 1); app.close(); const reopened = createApp({ databasePath: path, now: () => 1_700_000_000_000 });
  assert.deepEqual(await (await reopened.inject({ path: "/api/me/saved", headers: { cookie: user.cookie } })).json(), { posts: [saved], nextCursor: null }); reopened.close();
}); });

test("SCN-RC-12-H2 records latest history with retention and stable cursors", async () => { let now = 1_700_000_000_000; await withApp(async ({ app, request }) => {
  const user = await owner(request); const first = await post(request, user, "first"); const second = await post(request, user, "second");
  assert.equal((await request(`/api/posts/${first.id}`, { headers: { cookie: user.cookie } })).statusCode, 200); now += 1; assert.equal((await request(`/api/posts/${second.id}`, { headers: { cookie: user.cookie } })).statusCode, 200); now += 1; assert.equal((await request(`/api/posts/${first.id}`, { headers: { cookie: user.cookie } })).statusCode, 200);
  const page = await (await request("/api/me/history?limit=1", { headers: { cookie: user.cookie } })).json(); assert.equal(page.history[0].post.id, first.id); assert.ok(page.nextCursor);
  const resumed = await (await request(`/api/me/history?cursor=${encodeURIComponent(page.nextCursor)}`, { headers: { cookie: user.cookie } })).json(); assert.deepEqual(resumed.history.map((entry) => entry.post.id), [second.id]);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count, 2);
}, { now: () => now }); });

test("SCN-RC-12-H3 rejects invalid preferences without changing either field", async () => { await withApp(async ({ request }) => {
  const user = await owner(request); assert.deepEqual(await (await request("/api/me/preferences", { headers: { cookie: user.cookie } })).json(), { theme: "system", compactMode: false });
  assert.deepEqual(await (await send(request, "/api/me/preferences", "PATCH", { theme: "dark", compactMode: true }, user.cookie)).json(), { theme: "dark", compactMode: true });
  for (const value of [{}, { theme: "blue" }, { compactMode: "true" }, { nope: true }, "bad"]) { await fixed(await send(request, "/api/me/preferences", "PATCH", value, user.cookie), 422, { error: "Invalid preferences" }); assert.deepEqual(await (await request("/api/me/preferences", { headers: { cookie: user.cookie } })).json(), { theme: "dark", compactMode: true }); }
}); });

test("SCN-RC-12-H4 rejects private user suffix routes before target lookup", async () => { await withApp(async ({ request }) => {
  const user = await owner(request); for (const route of ["/api/users/other/saved", "/api/users/missing/history"]) { await fixed(await request(route, { headers: { cookie: user.cookie } }), 403, { error: "Forbidden" }); await fixed(await request(route), 401, { error: "Authentication required" }); }
}); });

test("SCN-RC-12-H5 repeated unsave and save remain owner scoped", async () => { await withApp(async ({ request }) => {
  const one = await owner(request); const two = await signup(request, "personal-other"); const value = await post(request, one); const route = `/api/posts/${value.id}/save`;
  assert.equal((await send(request, route, "PUT", undefined, one.cookie)).statusCode, 204); assert.equal((await send(request, route, "PUT", undefined, two.cookie)).statusCode, 204);
  for (let i = 0; i < 2; i++) assert.equal((await send(request, route, "DELETE", undefined, one.cookie)).statusCode, 204); for (let i = 0; i < 2; i++) assert.equal((await send(request, route, "PUT", undefined, one.cookie)).statusCode, 204);
  assert.deepEqual((await (await request("/api/me/saved", { headers: { cookie: one.cookie } })).json()).posts.map((item) => item.id), [value.id]); assert.deepEqual((await (await request("/api/me/saved", { headers: { cookie: two.cookie } })).json()).posts.map((item) => item.id), [value.id]);
}); });

test("SCN-RC-12-H6 rolls back full preference patches before retry", async () => { let fail = true; await withApp(async ({ request }) => {
  const user = await owner(request); const patch = { theme: "dark", compactMode: true }; await fixed(await send(request, "/api/me/preferences", "PATCH", patch, user.cookie), 503, { error: "Personal state unavailable" }); assert.deepEqual(await (await request("/api/me/preferences", { headers: { cookie: user.cookie } })).json(), { theme: "system", compactMode: false }); assert.deepEqual(await (await send(request, "/api/me/preferences", "PATCH", patch, user.cookie)).json(), patch);
}, { beforePreferencePersist: () => { if (fail) { fail = false; throw new Error("fault"); } } }); });

test("SCN-RC-12-H7 post deletion cascades private state and future saves fail", async () => { await withApp(async ({ app, request }) => {
  const user = await owner(request); const value = await post(request, user); const route = `/api/posts/${value.id}/save`; assert.equal((await send(request, route, "PUT", undefined, user.cookie)).statusCode, 204); assert.equal((await request(`/api/posts/${value.id}`, { headers: { cookie: user.cookie } })).statusCode, 200); assert.equal((await request(`/api/posts/${value.id}`, { method: "DELETE", headers: { cookie: user.cookie } })).statusCode, 204);
  assert.deepEqual(await (await request("/api/me/saved", { headers: { cookie: user.cookie } })).json(), { posts: [], nextCursor: null }); assert.deepEqual(await (await request("/api/me/history", { headers: { cookie: user.cookie } })).json(), { history: [], nextCursor: null }); await fixed(await send(request, route, "PUT", undefined, user.cookie), 404, { error: "Not found" }); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts UNION ALL SELECT COUNT(*) FROM post_history").all().every((row) => row.count === 0), true);
}); });
