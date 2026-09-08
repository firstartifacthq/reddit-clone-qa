import assert from "node:assert/strict";
import test from "node:test";
import { fixture, businessState, mediaBody, image } from "../tools/rc15-fixture.js";

test("AC-RC15-2 privacy audit expiry is exact, durable and rejection is non-mutating", async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now, sessionLifetimeMs: 3 * 86400000,
    administratorAuthority: () => true, schedulePrivacyWork: () => {} });
  const owner = await f.signup("expiry-owner");
  await f.json("/api/me/export", "POST", undefined, owner, 202);
  f.app.drainPrivacy();
  const first = await f.json("/api/admin/audit?limit=1", "GET", undefined, owner);
  assert.ok(first.nextCursor);
  const path = `/api/admin/audit?limit=1&cursor=${first.nextCursor}`;
  now += 86400000 - 1;
  const valid = await f.json(path, "GET", undefined, owner);
  assert.equal(valid.events[0].action, "completed");
  await f.restart();
  assert.deepEqual(await f.json(path, "GET", undefined, owner), valid);
  for (const time of [86401000, 86401001]) {
    now = time;
    const before = businessState(f.app);
    assert.deepEqual(await f.json(path, "GET", undefined, owner, 422), { error: "Invalid request" });
    assert.deepEqual(businessState(f.app), before);
    assert.equal((await f.json("/api/admin/audit", "GET", undefined, owner)).events.length, 2);
  }
});

test("AC-RC15-3/5 keyed creation cannot replay moderator-removed payload", async t => {
  const f = await fixture(t);
  const owner = await f.signup("replay-owner");
  assert.equal((await f.request("/api/communities", "POST", { name: "replay" }, owner)).status, 201);
  const body = { type: "text", title: "private removed marker", text: "original content" };
  const create = status => f.json("/api/communities/replay/posts", "POST", body, owner, status, { "idempotency-key": "retained-key" });
  const post = await create(201);
  assert.deepEqual(await create(201), post);
  assert.equal((await f.request(`/api/mod/posts/${post.id}`, "DELETE", undefined, owner)).status, 204);
  const before = businessState(f.app);
  const denied = await create(404);
  assert.deepEqual(denied, { error: "Not found" });
  assert.deepEqual(businessState(f.app), before);
  await f.restart();
  assert.deepEqual(await create(404), denied);
  await f.json(`/api/mod/posts/${post.id}/restore`, "POST", undefined, owner);
  assert.deepEqual(await create(201), post);
});

test("AC-RC15-3A blocked media cannot bypass the protected direct read or create history", async t => {
  const f = await fixture(t);
  const owner = await f.signup("media-owner");
  const blocked = await f.signup("media-blocked");
  const unrelated = await f.signup("media-unrelated");
  assert.equal((await f.request("/api/communities", "POST", { name: "media" }, owner)).status, 201);
  const post = await f.json("/api/communities/media/posts", "POST", mediaBody, owner, 201);
  assert.equal((await f.request("/api/users/media-blocked/block", "POST", undefined, owner)).status, 204);
  const before = businessState(f.app);
  for (const suffix of ["", "/media"]) {
    const response = await f.request(`/api/posts/${post.id}${suffix}`, "GET", undefined, blocked);
    assert.equal(response.status, 404, suffix || "post");
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  assert.deepEqual(businessState(f.app), before);
  for (const user of [unrelated, undefined]) {
    const response = await f.request(`/api/posts/${post.id}/media`, "GET", undefined, user);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  }
});

test("AC-RC15-3 malformed cross-feature requests preserve every business table", async t => {
  const { participation } = await import("../tools/rc15-ledger.js");
  const f = await fixture(t, { schedulePrivacyWork: () => {}, administratorAuthority: () => true });
  const s = await participation(f);
  const routes = ["/api/feed/home", "/api/feed/popular", "/api/communities/journey/feed",
    `/api/posts/${s.posts[0].id}/comments`, "/api/mod/queue", "/api/me/notifications", "/api/me/saved", "/api/me/history", "/api/admin/audit"];
  const cases = routes.flatMap(path => ["limit=0", "limit=101", "limit=01", "limit=1.0", "limit=", "limit=1&limit=2", "cursor=a&cursor=b", "cursor=unknown-cursor"].map(query => [path + "?" + query, "GET", undefined, s.owner]));
  cases.push([`/api/posts/${s.posts[1].id}/comments`, "POST", { body: "cross-parent marker", parentId: s.root.id }, s.recipient],
    ["/api/me/preferences", "PATCH", { theme: "invalid", compactMode: true }, s.recipient],
    ["/api/me/export", "POST", { userId: s.unrelated.id }, s.recipient],
    ["/api/communities/journey/posts", "POST", { type: "text", title: "mixed", text: "text", url: "https://example.org" }, s.participant]);
  const before = businessState(f.app);
  for (const [path, method, body, user] of cases) {
    const response = await f.request(path, method, body, user);
    assert.ok([404, 422].includes(response.status), path);
    assert.equal((await response.text()).includes("marker"), false);
    assert.deepEqual(businessState(f.app), before, path);
  }
  await f.json(`/api/posts/${s.posts[1].id}/comments`, "POST", { body: "valid recovery" }, s.recipient, 201);
});

test("AC-RC15-3A safety admission is inclusive and rejected content has no downstream effect", async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now, postRateLimitMax: 2, postRateLimitWindowMs: 100 });
  const owner = await f.signup("safety-owner");
  assert.equal((await f.request("/api/communities", "POST", { name: "safety" }, owner)).status, 201);
  const path = "/api/communities/safety/posts";
  for (const body of [{ type: "text", title: "unsafe", text: "<script>unsafe_marker()</script>" },
    { type: "text", title: "unsafe", text: '<img src="x" onerror="unsafe_marker()">' },
    { type: "link", title: "unsafe", url: "javascript:unsafe_marker()" }]) {
    const before = businessState(f.app);
    const response = await f.request(path, "POST", body, owner);
    assert.equal(response.status, 422); assert.equal((await response.text()).includes("unsafe_marker"), false);
    assert.deepEqual(businessState(f.app), before);
  }
  const body = { type: "text", title: "allowed", text: "safe" };
  for (let i = 0; i < 2; i++) await f.json(path, "POST", body, owner, 201);
  const before = businessState(f.app);
  await f.json(path, "POST", body, owner, 429); assert.deepEqual(businessState(f.app), before);
  now = 1100;
  await f.json(path, "POST", body, owner, 201);
});

test("AC-RC15-4A retained credentials lose cross-feature authority exactly at expiry and logout", async t => {
  const { password } = await import("../tools/rc15-fixture.js");
  let now = 1000;
  const f = await fixture(t, { now: () => now, sessionLifetimeMs: 1000, schedulePrivacyWork: () => {} });
  const owner = await f.signup("session-owner");
  assert.equal((await f.request("/api/communities", "POST", { name: "sessions" }, owner)).status, 201);
  const operations = [["/api/feed/home", "GET"], ["/api/communities/sessions/posts", "POST", { type: "text", title: "session post", text: "body" }],
    ["/api/me/preferences", "PATCH", { theme: "dark" }], ["/api/me/export", "POST"]];
  now = 1999;
  for (const [path, method, body] of operations) {
    const response = await f.request(path, method, body, owner);
    assert.ok([200, 201, 202].includes(response.status)); await response.arrayBuffer();
  }
  const other = await f.signup("session-other");
  async function denied(user) {
    const before = businessState(f.app);
    for (const [path, method, body] of operations) await f.json(path, method, body, user, 401);
    assert.deepEqual(businessState(f.app), before);
    await f.json("/api/me", "GET", undefined, other);
  }
  for (const time of [2000, 2001]) { now = time; await denied(owner); }
  const response = await f.request("/api/auth/login", "POST", { username: owner.username, password });
  assert.equal(response.status, 200);
  const fresh = { cookie: response.headers.get("set-cookie").split(";", 1)[0] };
  await f.json("/api/me", "GET", undefined, fresh); await denied(owner);
  assert.equal((await f.request("/api/auth/logout", "POST", undefined, fresh)).status, 204);
  await denied(fresh);
});
