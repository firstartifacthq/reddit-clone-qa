import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-notifications-")); const path = join(directory, "notifications.sqlite"); let now = 1_700_000_000_000;
  const app = createApp({ databasePath: path, now: () => now, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }), advance: (amount = 1) => { now += amount; }, now: () => now }); }
  finally { try { app.close(); } catch (error) { if (error?.code !== "ERR_INVALID_STATE") throw error; } await rm(directory, { recursive: true, force: true }); }
}
function cookie(response) { return response.headers.get("set-cookie").split(";", 1)[0]; }
async function send(request, path, method, body, auth, headers = {}) { return request(path, { method, headers: { "content-type": "application/json", ...(auth ? { cookie: auth } : {}), ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) }); }
async function user(request, username) { const response = await send(request, "/api/auth/signup", "POST", { username, password }); assert.equal(response.statusCode, 201); return { account: await response.json(), cookie: cookie(response) }; }
async function setup(request) {
  const owner = await user(request, "notice-owner"); const actor = await user(request, "notice-actor"); const mod = await user(request, "notice-mod");
  assert.equal((await send(request, "/api/communities", "POST", { name: "noticeclub" }, owner.cookie)).statusCode, 201);
  for (const member of [actor, mod]) assert.equal((await request("/api/communities/noticeclub/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
  assert.equal((await send(request, "/api/communities/noticeclub/moderators", "PATCH", { username: mod.account.username, role: "moderator" }, owner.cookie)).statusCode, 200);
  const response = await send(request, "/api/communities/noticeclub/posts", "POST", { type: "text", title: "Notice post", text: "body" }, owner.cookie); assert.equal(response.statusCode, 201);
  return { owner, actor, mod, post: await response.json() };
}
async function inbox(request, owner, suffix = "") { const response = await request(`/api/me/notifications${suffix}`, { headers: { cookie: owner.cookie } }); assert.equal(response.statusCode, 200); return response.json(); }
function durableCounts(database) {
  return Object.fromEntries(["notification_events", "notifications", "notification_traversals", "notification_traversal_items", "notification_page_tokens"].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}
async function mention(request, post, actor, body = "u/notice-owner") { return send(request, `/api/posts/${post.id}/comments`, "POST", { body }, actor.cookie); }
function retryInProcess(path) {
  const script = `const { createApp } = await import(process.env.APP_MODULE); const app = createApp({ databasePath: process.env.DATABASE_PATH }); const response = await app.retryNotificationDelivery({ eventKey: 'retry-key' }); app.close(); if (response.status !== 204) process.exit(1);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { env: { ...process.env, APP_MODULE: new URL("../src/app.js", import.meta.url).href, DATABASE_PATH: path }, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", (chunk) => { error += chunk; }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(error || `retry process exited ${code}`)));
  });
}

test("AC-RC11-1 covers eligible sources, source no-ops, mention boundaries, self events, and inactive recipients", async () => withApp(async ({ app, request, advance }) => {
  const { owner, actor, mod, post } = await setup(request);
  const inactive = await user(request, "inactive-user"); assert.equal((await request("/api/me", { method: "DELETE", headers: { cookie: inactive.cookie } })).statusCode, 202);
  const rootResponse = await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "root" }, owner.cookie); const root = await rootResponse.json(); advance();
  assert.equal((await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "reply u/NOTICE-OWNER and u/notice-owner", parentId: root.id }, actor.cookie)).statusCode, 201);
  for (const body of ["embeddedxu/notice-owner", "u/no", "u/notice-owner-extra", "u/inactive-user"]) assert.equal((await mention(request, post, actor, body)).statusCode, 201);
  assert.equal((await mention(request, post, owner, "self u/notice-owner")).statusCode, 201);
  assert.equal((await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "self reply", parentId: root.id }, owner.cookie)).statusCode, 201);
  advance(); assert.equal((await send(request, `/api/posts/${post.id}/vote`, "PUT", { value: 1 }, actor.cookie)).statusCode, 200);
  assert.equal((await send(request, `/api/posts/${post.id}/vote`, "PUT", { value: 1 }, actor.cookie)).statusCode, 200, "unchanged vote is a source no-op");
  advance(); assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: mod.cookie } })).statusCode, 204);
  assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: mod.cookie } })).statusCode, 204, "repeated removal is a source no-op");
  const page = await inbox(request, owner);
  assert.deepEqual(page.notifications.map((entry) => entry.kind).sort(), ["mention", "moderation", "reply", "vote"]);
  assert.equal(new Set(page.notifications.map((entry) => entry.id)).size, 4);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM notification_events").get().count, 4);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 4);
}));

test("AC-RC11-1 rolls comment, vote, and moderation source state back when notification delivery faults", async () => {
  let fail = false;
  await withApp(async ({ app, request }) => {
    const { owner, actor, mod, post } = await setup(request);
    const beforeComment = { comments: app.database.prepare("SELECT COUNT(*) AS count FROM comments").get().count, ...durableCounts(app.database) };
    fail = true; assert.equal((await mention(request, post, actor)).statusCode, 503);
    assert.deepEqual({ comments: app.database.prepare("SELECT COUNT(*) AS count FROM comments").get().count, ...durableCounts(app.database) }, beforeComment);
    assert.equal((await mention(request, post, actor)).statusCode, 201);

    const beforeVote = durableCounts(app.database); fail = true;
    assert.equal((await send(request, `/api/posts/${post.id}/vote`, "PUT", { value: 1 }, actor.cookie)).statusCode, 503);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_votes").get().count, 0); assert.deepEqual(durableCounts(app.database), beforeVote);
    assert.equal((await send(request, `/api/posts/${post.id}/vote`, "PUT", { value: 1 }, actor.cookie)).statusCode, 200);

    const beforeModeration = durableCounts(app.database); fail = true;
    assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: mod.cookie } })).statusCode, 503);
    assert.equal(app.database.prepare("SELECT moderation_state FROM posts WHERE id = ?").get(post.id).moderation_state, "active");
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count, 0); assert.deepEqual(durableCounts(app.database), beforeModeration);
    assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: mod.cookie } })).statusCode, 204);
  }, { beforeNotificationDelivery: () => { if (fail) { fail = false; throw new Error("injected notification write fault"); } } });
});

test("AC-RC11-2 and AC-RC11-7 enforce full page grammar, stable owner snapshots, deletion gaps, and materialization owner defense", async () => withApp(async ({ app, request, advance }) => {
  const { owner, actor, post } = await setup(request); const commentIds = [];
  for (const body of ["one", "two", "three", "four"]) { advance(); const response = await mention(request, post, actor, `u/notice-owner ${body}`); commentIds.push((await response.json()).id); }
  const foreign = await user(request, "notice-foreign"); const foreignNoticeResponse = await mention(request, post, owner, "u/notice-actor"); assert.equal(foreignNoticeResponse.statusCode, 201);

  assert.equal((await request("/api/me/notifications?limit=100", { headers: { cookie: owner.cookie } })).statusCode, 200);
  const beforeInvalid = durableCounts(app.database);
  for (const query of ["limit=0", "limit=101", "limit=01", "limit=-1", "limit=", "limit=1&limit=2", "cursor=", `cursor=${"x".repeat(201)}`, "cursor=a&cursor=b", "other=1"]) {
    assert.equal((await request(`/api/me/notifications?${query}`, { headers: { cookie: owner.cookie } })).statusCode, 422, query);
    assert.deepEqual(durableCounts(app.database), beforeInvalid, `${query} must not mutate inbox state`);
  }

  const first = await inbox(request, owner, "?limit=1"); assert.equal(first.notifications[0].relatedItem.id, commentIds[3]); assert.ok(first.nextCursor);
  const snapshotIds = app.database.prepare("SELECT item.notification_id FROM notification_page_tokens AS token JOIN notification_traversal_items AS item ON item.traversal_id = token.traversal_id WHERE token.token = ? ORDER BY item.ordinal").all(first.nextCursor).map((row) => row.notification_id);
  advance(); const later = await mention(request, post, actor, "u/notice-owner later"); const laterId = (await later.json()).id;
  assert.equal((await request(`/api/me/notifications?cursor=${first.nextCursor}`, { headers: { cookie: foreign.cookie } })).statusCode, 422, "cursor is owner bound");

  assert.equal((await request(`/api/me/notifications/${snapshotIds[1]}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  const actorNotification = app.database.prepare("SELECT id FROM notifications WHERE owner_user_id = ?").get(actor.account.id).id;
  const traversal = app.database.prepare("SELECT traversal_id FROM notification_page_tokens WHERE token = ?").get(first.nextCursor).traversal_id;
  const triggerSql = app.database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'notification_traversal_item_owner_matches_traversal'").get().sql;
  app.database.exec("DROP TRIGGER notification_traversal_item_owner_matches_traversal");
  app.database.prepare("INSERT INTO notification_traversal_items (traversal_id, ordinal, notification_id) VALUES (?, 99, ?)").run(traversal, actorNotification);
  app.database.exec(triggerSql);

  const secondResponse = await request(`/api/me/notifications?limit=2&cursor=${first.nextCursor}`, { headers: { cookie: owner.cookie } }); const second = await secondResponse.json();
  assert.deepEqual(second.notifications.map((entry) => entry.relatedItem.id), [commentIds[1], commentIds[0]], "deleted ordinal is skipped without a foreign disclosure");
  assert.equal(second.notifications.some((entry) => entry.relatedItem.id === laterId), false, "later event does not drift into retained snapshot");
  assert.equal(second.notifications.some((entry) => entry.id === actorNotification), false);
  const replay = await request(`/api/me/notifications?limit=2&cursor=${first.nextCursor}`, { headers: { cookie: owner.cookie } }); assert.deepEqual(await replay.json(), second);
}));

test("AC-RC11-2 cursors resume after restart, exclude later events, expire without state-changing cleanup", async () => withApp(async ({ app, path, request, advance, now }) => {
  const { owner, actor, post } = await setup(request); const ids = [];
  for (const body of ["one", "two", "three"]) { advance(); const response = await mention(request, post, actor, `u/notice-owner ${body}`); ids.push((await response.json()).id); }
  const first = await inbox(request, owner, "?limit=1"); advance(); await mention(request, post, actor, "u/notice-owner later");
  app.close(); const reopened = createApp({ databasePath: path, now, sessionLifetimeMs: 172_800_000 }); const reopenedRequest = (route, options = {}) => reopened.inject({ path: route, ...options });
  try {
    const secondResponse = await reopenedRequest(`/api/me/notifications?limit=1&cursor=${first.nextCursor}`, { headers: { cookie: owner.cookie } }); assert.equal(secondResponse.statusCode, 200);
    const second = await secondResponse.json(); assert.equal(second.notifications[0].relatedItem.id, ids[1]); assert.ok(second.nextCursor);
    const beforeExpiry = durableCounts(reopened.database); advance(86_400_001);
    assert.equal((await reopenedRequest(`/api/me/notifications?cursor=${second.nextCursor}`, { headers: { cookie: owner.cookie } })).statusCode, 422);
    assert.deepEqual(durableCounts(reopened.database), beforeExpiry, "expired cursor rejection is read-only");
  } finally { reopened.close(); }
}, { sessionLifetimeMs: 172_800_000 }));

test("AC-RC11-3, AC-RC11-4, and AC-RC11-5 persist both read transitions and uniformly deny unknown, foreign, deleted, malformed, and non-owner mutations", async () => withApp(async ({ app, request }) => {
  const { owner, actor, post } = await setup(request); await mention(request, post, actor); await mention(request, post, owner, "u/notice-actor");
  const owned = (await inbox(request, owner)).notifications[0]; const foreign = (await inbox(request, actor)).notifications[0];
  for (const read of [true, false]) {
    assert.equal((await send(request, `/api/me/notifications/${owned.id}`, "PATCH", { read }, owner.cookie)).statusCode, 204);
    assert.equal(app.database.prepare("SELECT read_state FROM notifications WHERE id = ?").get(owned.id).read_state, read ? 1 : 0);
    assert.equal((await inbox(request, owner)).notifications[0].read, read);
  }
  const beforeDenied = app.database.prepare("SELECT id, read_state, deleted_at FROM notifications ORDER BY id").all();
  for (const id of ["unknown-notification", foreign.id]) assert.equal((await send(request, `/api/me/notifications/${id}`, "PATCH", { read: true }, owner.cookie)).statusCode, 404);
  for (const payload of ["{bad", "{}", JSON.stringify({ read: 1 }), JSON.stringify({ read: true, extra: true })]) {
    const response = await request(`/api/me/notifications/${owned.id}`, { method: "PATCH", headers: { cookie: owner.cookie, "content-type": "application/json" }, payload }); assert.equal(response.statusCode, 422);
  }
  assert.deepEqual(app.database.prepare("SELECT id, read_state, deleted_at FROM notifications ORDER BY id").all(), beforeDenied);
  assert.equal((await request(`/api/users/${owner.account.username}/notifications`)).statusCode, 401);
  assert.equal((await request(`/api/users/${owner.account.username}/notifications`, { headers: { cookie: actor.cookie } })).statusCode, 403);
  assert.equal((await request("/api/users/%E0%A4%A/notifications", { headers: { cookie: owner.cookie } })).statusCode, 403);
  assert.equal((await request(`/api/users/${owner.account.username.toUpperCase()}/notifications`, { headers: { cookie: owner.cookie } })).statusCode, 200);

  assert.equal((await request(`/api/me/notifications/${owned.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  assert.equal((await inbox(request, owner)).notifications.length, 0);
  assert.equal((await send(request, `/api/me/notifications/${owned.id}`, "PATCH", { read: true }, owner.cookie)).statusCode, 404);
  assert.equal((await request(`/api/me/notifications/${owned.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 404);
  const retained = app.database.prepare("SELECT deleted_at, event_id FROM notifications WHERE id = ?").get(owned.id); assert.equal(typeof retained.deleted_at, "number"); assert.ok(retained.event_id);
  assert.throws(() => app.database.prepare("DELETE FROM notifications WHERE id = ?").run(owned.id), /hard deleted/);
}));

test("AC-RC11-6 reconciles one missing delivery across repeated, concurrent, and restarted trusted retries while rejecting every serializable forgery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reddit-notification-retry-")); const path = join(directory, "retry.sqlite"); let now = 1_700_000_000_000; let app = createApp({ databasePath: path, now: () => now });
  try {
    let request = (route, options = {}) => app.inject({ path: route, ...options }); const owner = await user(request, "retry-owner");
    app.database.prepare("INSERT INTO notification_events (id, event_key, occurrence_sequence, recipient_user_id, kind, related_item_type, related_item_id, occurred_at) VALUES ('event', 'retry-key', 1, ?, 'mention', 'comment', 'comment', ?)").run(owner.account.id, now);
    const forgeries = [
      { headers: { "content-type": "application/json", cookie: owner.cookie }, payload: JSON.stringify({ eventKey: "retry-key" }) },
      { headers: { "content-type": "application/json", "x-delivery-capability": "true" }, payload: JSON.stringify({ eventKey: "retry-key" }) },
      { path: "/api/notifications/delivery/retry?capability=true", headers: { "content-type": "application/json" }, payload: JSON.stringify({ eventKey: "retry-key" }) },
      { headers: { "content-type": "application/json" }, payload: "{bad" },
    ];
    for (const forgery of forgeries) {
      const route = forgery.path || "/api/notifications/delivery/retry"; const response = await request(route, { method: "POST", headers: forgery.headers, payload: forgery.payload }); assert.equal(response.statusCode, 403);
    }
    assert.equal((await app.handle({ method: "POST", path: "/api/notifications/delivery/retry", headers: { "content-type": "application/json" }, payload: JSON.stringify({ eventKey: "retry-key" }) }, Symbol("forged"))).status, 403);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 0);
    app.close(); await Promise.all(Array.from({ length: 4 }, () => retryInProcess(path)));
    app = createApp({ databasePath: path, now: () => now }); request = (route, options = {}) => app.inject({ path: route, ...options });
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 1, "concurrent trusted processes converge on one delivery");
    const retries = await Promise.all(Array.from({ length: 8 }, () => app.retryNotificationDelivery({ eventKey: "retry-key" })));
    assert.equal(retries.every((response) => response.status === 204), true); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 1);
    app.close(); app = createApp({ databasePath: path, now: () => now }); request = (route, options = {}) => app.inject({ path: route, ...options });
    assert.equal((await app.retryNotificationDelivery({ eventKey: "retry-key" })).status, 204);
    assert.equal((await inbox(request, owner)).notifications.length, 1); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 1);
  } finally { app.close(); await rm(directory, { recursive: true, force: true }); }
});
