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

test("personal traversal retries reuse bounded durable snapshots", async () => { let now = 1_700_000_000_000; await withApp(async ({ app, path, request }) => {
  const user = await owner(request); const values = [];
  for (const title of ["one", "two", "three"]) { const value = await post(request, user, title); values.push(value); assert.equal((await send(request, `/api/posts/${value.id}/save`, "PUT", undefined, user.cookie)).statusCode, 204); now += 1; }
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await request("/api/me/saved?limit=3", { headers: { cookie: user.cookie } })).statusCode, 200);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM personal_traversals").get().count, 0);
  let first;
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = await (await request("/api/me/saved?limit=1", { headers: { cookie: user.cookie } })).json();
    first ??= page; assert.deepEqual(page, first);
  }
  assert.deepEqual({ ...app.database.prepare("SELECT (SELECT COUNT(*) FROM personal_traversals) AS traversals, (SELECT COUNT(*) FROM personal_traversal_items) AS items, (SELECT COUNT(*) FROM personal_page_tokens) AS tokens").get() }, { traversals: 1, items: 3, tokens: 1 });
  app.close(); const reopened = createApp({ databasePath: path, now: () => now, sessionLifetimeMs: 2 * 24 * 60 * 60 * 1_000 });
  const resumed = await (await reopened.inject({ path: `/api/me/saved?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, headers: { cookie: user.cookie } })).json();
  assert.equal(resumed.posts.length, 1); assert.notEqual(resumed.posts[0].id, first.posts[0].id);
  now += 24 * 60 * 60 * 1_000;
  assert.equal((await reopened.inject({ path: "/api/me/saved?limit=1", headers: { cookie: user.cookie } })).statusCode, 200);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM personal_traversals").get().count, 1);
  await fixed(await reopened.inject({ path: `/api/me/saved?cursor=${encodeURIComponent(first.nextCursor)}`, headers: { cookie: user.cookie } }), 422, { error: "Invalid page" }); reopened.close();
}, { now: () => now, sessionLifetimeMs: 2 * 24 * 60 * 60 * 1_000 }); });

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

test("SCN-RC-12-H5 repeated unsave and save remain owner scoped", async () => { await withApp(async ({ app, request }) => {
  const one = await owner(request); const two = await signup(request, "personal-other"); const value = await post(request, one); const route = `/api/posts/${value.id}/save`;
  assert.equal((await send(request, route, "PUT", undefined, one.cookie)).statusCode, 204); assert.equal((await send(request, route, "PUT", undefined, two.cookie)).statusCode, 204);
  const otherSavedAt = app.database.prepare("SELECT saved_at FROM saved_posts WHERE user_id = ? AND post_id = ?").get(two.account.id, value.id).saved_at;
  for (let i = 0; i < 2; i++) assert.equal((await send(request, route, "DELETE", undefined, one.cookie)).statusCode, 204); for (let i = 0; i < 2; i++) assert.equal((await send(request, route, "PUT", undefined, one.cookie)).statusCode, 204);
  assert.deepEqual((await (await request("/api/me/saved", { headers: { cookie: one.cookie } })).json()).posts.map((item) => item.id), [value.id]); assert.deepEqual((await (await request("/api/me/saved", { headers: { cookie: two.cookie } })).json()).posts.map((item) => item.id), [value.id]);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts WHERE user_id = ? AND post_id = ?").get(one.account.id, value.id).count, 1);
  assert.equal(app.database.prepare("SELECT saved_at FROM saved_posts WHERE user_id = ? AND post_id = ?").get(two.account.id, value.id).saved_at, otherSavedAt);
}); });

test("SCN-RC-12-H6 rolls back full preference patches before retry", async () => { let fail = true; await withApp(async ({ request }) => {
  const user = await owner(request); const patch = { theme: "dark", compactMode: true }; await fixed(await send(request, "/api/me/preferences", "PATCH", patch, user.cookie), 503, { error: "Personal state unavailable" }); assert.deepEqual(await (await request("/api/me/preferences", { headers: { cookie: user.cookie } })).json(), { theme: "system", compactMode: false }); assert.deepEqual(await (await send(request, "/api/me/preferences", "PATCH", patch, user.cookie)).json(), patch);
}, { beforePreferencePersist: () => { if (fail) { fail = false; throw new Error("fault"); } } }); });

test("moderation removal and restoration gate saved, history, resumed pages, and view writes", async () => { await withApp(async ({ app, request }) => {
  const user = await owner(request, "moderated-personal-owner"); const values = [];
  for (const title of ["moderated one", "moderated two", "moderated three"]) {
    const value = await post(request, user, title); values.push(value);
    assert.equal((await send(request, `/api/posts/${value.id}/save`, "PUT", undefined, user.cookie)).statusCode, 204);
    assert.equal((await request(`/api/posts/${value.id}`, { headers: { cookie: user.cookie } })).statusCode, 200);
  }
  const savedOrder = (await (await request("/api/me/saved", { headers: { cookie: user.cookie } })).json()).posts.map((entry) => entry.id);
  const target = savedOrder[1];
  const savedPage = await (await request("/api/me/saved?limit=1", { headers: { cookie: user.cookie } })).json();
  const historyPage = await (await request("/api/me/history?limit=1", { headers: { cookie: user.cookie } })).json();
  assert.ok(savedPage.nextCursor); assert.ok(historyPage.nextCursor);
  assert.equal((await request(`/api/mod/posts/${target}`, { method: "DELETE", headers: { cookie: user.cookie } })).statusCode, 204);
  const privateRows = { saved: app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts").get().count, history: app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count };
  assert.equal((await (await request("/api/me/saved", { headers: { cookie: user.cookie } })).json()).posts.some((entry) => entry.id === target), false);
  assert.equal((await (await request("/api/me/history", { headers: { cookie: user.cookie } })).json()).history.some((entry) => entry.post.id === target), false);
  assert.equal((await (await request(`/api/me/saved?cursor=${savedPage.nextCursor}`, { headers: { cookie: user.cookie } })).json()).posts.some((entry) => entry.id === target), false);
  assert.equal((await (await request(`/api/me/history?cursor=${historyPage.nextCursor}`, { headers: { cookie: user.cookie } })).json()).history.some((entry) => entry.post.id === target), false);
  await fixed(await request(`/api/posts/${target}`, { headers: { cookie: user.cookie } }), 404, { error: "Not found" });
  await fixed(await send(request, `/api/posts/${target}/save`, "PUT", undefined, user.cookie), 404, { error: "Not found" });
  assert.deepEqual({ saved: app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts").get().count, history: app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count }, privateRows);

  assert.equal((await request(`/api/mod/posts/${target}/restore`, { method: "POST", headers: { cookie: user.cookie } })).statusCode, 200);
  assert.equal((await (await request("/api/me/saved", { headers: { cookie: user.cookie } })).json()).posts.some((entry) => entry.id === target), true);
  assert.equal((await (await request("/api/me/history", { headers: { cookie: user.cookie } })).json()).history.some((entry) => entry.post.id === target), true);
  assert.equal((await (await request(`/api/me/saved?cursor=${savedPage.nextCursor}`, { headers: { cookie: user.cookie } })).json()).posts.some((entry) => entry.id === target), true);
  assert.equal((await (await request(`/api/me/history?cursor=${historyPage.nextCursor}`, { headers: { cookie: user.cookie } })).json()).history.some((entry) => entry.post.id === target), true);
  assert.equal((await request(`/api/posts/${target}`, { headers: { cookie: user.cookie } })).statusCode, 200);
  assert.deepEqual({ saved: app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts").get().count, history: app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count }, privateRows);
}); });

test("SCN-RC-12-H7 post deletion cascades private state and future saves fail", async () => { await withApp(async ({ app, request }) => {
  const user = await owner(request); const value = await post(request, user); const route = `/api/posts/${value.id}/save`; assert.equal((await send(request, route, "PUT", undefined, user.cookie)).statusCode, 204); assert.equal((await request(`/api/posts/${value.id}`, { headers: { cookie: user.cookie } })).statusCode, 200); assert.equal((await request(`/api/posts/${value.id}`, { method: "DELETE", headers: { cookie: user.cookie } })).statusCode, 204);
  assert.deepEqual(await (await request("/api/me/saved", { headers: { cookie: user.cookie } })).json(), { posts: [], nextCursor: null }); assert.deepEqual(await (await request("/api/me/history", { headers: { cookie: user.cookie } })).json(), { history: [], nextCursor: null }); await fixed(await send(request, route, "PUT", undefined, user.cookie), 404, { error: "Not found" }); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts UNION ALL SELECT COUNT(*) FROM post_history").all().every((row) => row.count === 0), true);
}); });

test("history retention, cursor scope, retries, insert isolation, and restart are exact", async () => { let now = 1_700_000_000_000; await withApp(async ({ app, path, request }) => {
  const user = await owner(request); const other = await signup(request, "history-other");
  const newest = await post(request, user, "newest"); const boundary = await post(request, user, "boundary"); const expired = await post(request, user, "expired"); const later = await post(request, user, "later");
  const cutoff = now - 90 * 24 * 60 * 60 * 1_000;
  const insertHistory = app.database.prepare("INSERT INTO post_history (user_id, post_id, viewed_at) VALUES (?, ?, ?)");
  insertHistory.run(user.account.id, newest.id, now); insertHistory.run(user.account.id, boundary.id, cutoff); insertHistory.run(user.account.id, expired.id, cutoff - 1);
  app.database.prepare("INSERT INTO personal_traversals (id, user_id, listing_kind, snapshot_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run("retention-probe", user.account.id, "history", "f".repeat(64), now - 1, now + 1_000);
  app.database.prepare("INSERT INTO personal_traversal_items (traversal_id, ordinal, post_id, event_at) VALUES (?, ?, ?, ?)").run("retention-probe", 0, boundary.id, cutoff);
  app.database.prepare("INSERT INTO personal_traversal_items (traversal_id, ordinal, post_id, event_at) VALUES (?, ?, ?, ?)").run("retention-probe", 1, expired.id, cutoff - 1);
  const first = await (await request("/api/me/history?limit=1", { headers: { cookie: user.cookie } })).json();
  assert.deepEqual(first.history.map((entry) => [entry.post.id, entry.viewedAt]), [[newest.id, new Date(now).toISOString()]]); assert.ok(first.nextCursor);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history WHERE post_id = ?").get(expired.id).count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM personal_traversal_items WHERE traversal_id = 'retention-probe' AND post_id = ?").get(expired.id).count, 0);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM personal_traversal_items WHERE traversal_id = 'retention-probe' AND post_id = ?").get(boundary.id).count, 1);
  insertHistory.run(user.account.id, later.id, now + 1);
  await fixed(await request(`/api/me/history?cursor=${encodeURIComponent(first.nextCursor)}`, { headers: { cookie: other.cookie } }), 422, { error: "Invalid page" });
  await fixed(await request(`/api/me/saved?cursor=${encodeURIComponent(first.nextCursor)}`, { headers: { cookie: user.cookie } }), 422, { error: "Invalid page" });
  app.close(); const reopened = createApp({ databasePath: path, now: () => now });
  const route = `/api/me/history?cursor=${encodeURIComponent(first.nextCursor)}`;
  const resumed = await (await reopened.inject({ path: route, headers: { cookie: user.cookie } })).json();
  const retried = await (await reopened.inject({ path: route, headers: { cookie: user.cookie } })).json();
  assert.deepEqual(retried, resumed); assert.deepEqual(resumed, { history: [{ post: boundary, viewedAt: new Date(cutoff).toISOString() }], nextCursor: null }); reopened.close();
}, { now: () => now }); });

test("save, unsave, and history storage faults roll back before retry", async () => {
  let failSaved = false; let failHistory = false;
  await withApp(async ({ app, request }) => {
    const user = await owner(request); const value = await post(request, user); const saveRoute = `/api/posts/${value.id}/save`;
    failSaved = true; await fixed(await send(request, saveRoute, "PUT", undefined, user.cookie), 503, { error: "Personal state unavailable" });
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts").get().count, 0);
    assert.equal((await send(request, saveRoute, "PUT", undefined, user.cookie)).statusCode, 204);
    failSaved = true; await fixed(await send(request, saveRoute, "DELETE", undefined, user.cookie), 503, { error: "Personal state unavailable" });
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts").get().count, 1);
    assert.equal((await send(request, saveRoute, "DELETE", undefined, user.cookie)).statusCode, 204); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM saved_posts").get().count, 0);
    assert.equal((await request(`/api/posts/${value.id}`)).statusCode, 200); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count, 0);
    await fixed(await request("/api/posts/missing", { headers: { cookie: user.cookie } }), 404, { error: "Not found" }); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count, 0);
    failHistory = true; await fixed(await request(`/api/posts/${value.id}`, { headers: { cookie: user.cookie } }), 503, { error: "Personal state unavailable" }); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count, 0);
    assert.equal((await request(`/api/posts/${value.id}`, { headers: { cookie: user.cookie } })).statusCode, 200); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count, 1);
  }, { beforeSavedPersist: () => { if (failSaved) { failSaved = false; throw new Error("saved fault"); } }, beforeHistoryPersist: () => { if (failHistory) { failHistory = false; throw new Error("history fault"); } } });
});

test("personal validation and inactive admission are exhaustive and nonmutating", async () => { await withApp(async ({ app, request }) => {
  const user = await owner(request); const value = await post(request, user, "admission probe");
  assert.equal((await request(`/api/posts/${value.id}`)).statusCode, 200); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count, 0);
  assert.deepEqual(await (await request("/api/me/preferences", { headers: { cookie: user.cookie } })).json(), { theme: "system", compactMode: false });
  assert.deepEqual(await (await send(request, "/api/me/preferences", "PATCH", { theme: "light" }, user.cookie)).json(), { theme: "light", compactMode: false });
  assert.deepEqual(await (await send(request, "/api/me/preferences", "PATCH", { compactMode: true }, user.cookie)).json(), { theme: "light", compactMode: true });
  const invalidBodies = ["{", "null", "[]", "{}", "{\"unknown\":true}", "{\"theme\":\"blue\"}", "{\"theme\":null}", "{\"compactMode\":1}", "{\"compactMode\":\"true\"}"];
  for (const payload of invalidBodies) {
    await fixed(await request("/api/me/preferences", { method: "PATCH", headers: { cookie: user.cookie, "content-type": "application/json" }, payload }), 422, { error: "Invalid preferences" });
    assert.deepEqual(await (await request("/api/me/preferences", { headers: { cookie: user.cookie } })).json(), { theme: "light", compactMode: true });
  }
  const invalidPages = ["limit=", "limit=0", "limit=01", "limit=1.0", "limit=-1", "limit=101", "limit=1&limit=2", "cursor=", `cursor=${"x".repeat(201)}`, "cursor=unknown", "other=1"];
  const before = { ...app.database.prepare("SELECT (SELECT COUNT(*) FROM personal_traversals) AS traversals, (SELECT COUNT(*) FROM personal_page_tokens) AS tokens, (SELECT COUNT(*) FROM saved_posts) AS saved, (SELECT COUNT(*) FROM post_history) AS history").get() };
  for (const query of invalidPages) await fixed(await request(`/api/me/saved?${query}`, { headers: { cookie: user.cookie } }), 422, { error: "Invalid page" });
  for (const route of ["/api/users/personal-owner/saved?limit=bad", "/api/users/missing/history?cursor=private", "/api/users/%/saved"]) {
    await fixed(await request(route, { headers: { cookie: user.cookie } }), 403, { error: "Forbidden" }); await fixed(await request(route), 401, { error: "Authentication required" });
  }
  assert.deepEqual({ ...app.database.prepare("SELECT (SELECT COUNT(*) FROM personal_traversals) AS traversals, (SELECT COUNT(*) FROM personal_page_tokens) AS tokens, (SELECT COUNT(*) FROM saved_posts) AS saved, (SELECT COUNT(*) FROM post_history) AS history").get() }, before);
  await fixed(await request("/api/me/saved?limit=bad"), 401, { error: "Authentication required" });
  await fixed(await request("/api/me/preferences", { method: "PATCH", payload: "{" }), 401, { error: "Authentication required" });
  app.database.prepare("UPDATE users SET deletion_requested_at = ? WHERE id = ?").run(1, user.account.id);
  assert.equal((await request(`/api/posts/${value.id}`, { headers: { cookie: user.cookie } })).statusCode, 200); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history").get().count, 0);
  await fixed(await request("/api/me/history?limit=bad", { headers: { cookie: user.cookie } }), 401, { error: "Authentication required" });
  await fixed(await request("/api/me/preferences", { method: "PATCH", headers: { cookie: user.cookie }, payload: "{" }), 401, { error: "Authentication required" });
}, { now: () => 1_700_000_000_000 }); });
