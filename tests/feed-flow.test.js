import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-")); const path = join(directory, "feed.sqlite");
  let time = 1_700_000_000_000;
  const app = createApp({ databasePath: path, now: () => time, ...options });
  try { await run({ app, path, tick: (value = 1) => { time += value; }, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}
function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function json(request, path, method, body, auth) { return request(path, { method, headers: { "content-type": "application/json", ...(auth ? { cookie: auth } : {}) }, payload: JSON.stringify(body) }); }
async function user(request, username) { const response = await json(request, "/api/auth/signup", "POST", { username, password }); assert.equal(response.statusCode, 201); return { account: await response.json(), cookie: cookie(response) }; }
async function community(request, owner, name) { assert.equal((await json(request, "/api/communities", "POST", { name }, owner.cookie)).statusCode, 201); }
async function post(request, owner, name, title) { const response = await json(request, `/api/communities/${name}/posts`, "POST", { type: "text", title, text: title }, owner.cookie); assert.equal(response.statusCode, 201); return response.json(); }
async function feed(request, route, auth) { return request(route, { headers: auth ? { cookie: auth } : {} }); }
function ids(body) { return body.posts.map((entry) => entry.id); }

test("SCN-RC-07-H1 scopes deterministic Home, Popular, and community feeds", async () => withApp(async ({ app, request, tick }) => {
  const owner = await user(request, "feed-owner"); const member = await user(request, "feed-member");
  await community(request, owner, "alpha"); await community(request, owner, "beta");
  const first = await post(request, owner, "alpha", "first"); tick(); const second = await post(request, owner, "alpha", "second");
  tick(); const third = await post(request, owner, "beta", "third");
  assert.equal((await request("/api/communities/alpha/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
  assert.deepEqual(ids(await (await feed(request, "/api/feed/home", member.cookie)).json()), [second.id, first.id]);
  assert.deepEqual(ids(await (await feed(request, "/api/feed/popular")).json()), [third.id, second.id, first.id]);
  const communityBody = await (await feed(request, "/api/communities/alpha/feed")).json();
  assert.deepEqual(ids(communityBody), [second.id, first.id]);
  assert.deepEqual(communityBody.posts[0], await (await feed(request, `/api/posts/${second.id}`)).json());
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count, 0);
}));

test("SCN-RC-07-H2 snapshots pages and validates inclusive page limits", async () => withApp(async ({ request, tick }) => {
  const owner = await user(request, "page-owner"); await community(request, owner, "pages");
  const created = []; for (let index = 0; index < 3; index += 1) { created.push(await post(request, owner, "pages", `post-${index}`)); tick(); }
  const first = await feed(request, "/api/feed/popular?limit=1"); const firstBody = await first.json(); assert.equal(firstBody.posts.length, 1); assert.ok(firstBody.nextCursor);
  const resumed = await feed(request, `/api/feed/popular?limit=100&cursor=${firstBody.nextCursor}`); const resumedBody = await resumed.json();
  assert.equal(resumedBody.nextCursor, null); assert.deepEqual([...ids(firstBody), ...ids(resumedBody)].sort(), created.map((entry) => entry.id).sort());
  assert.equal((await feed(request, "/api/feed/popular?limit=101")).statusCode, 422);
  assert.equal((await feed(request, "/api/feed/popular?limit=01")).statusCode, 422);
}));

test("SCN-RC-07-H3 rejects invalid page authority without disclosure", async () => withApp(async ({ app, request }) => {
  const before = app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count;
  for (const route of ["/api/feed/popular?cursor=", "/api/feed/popular?cursor=a&cursor=b", "/api/feed/popular?limit=2&limit=3", "/api/feed/popular?other=marker", "/api/feed/popular?limit=0"]) {
    const response = await feed(request, route); assert.equal(response.statusCode, 422); assert.deepEqual(await response.json(), { error: "Invalid feed page" });
  }
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count, before);
}));

test("SCN-RC-07-H4 requires Home authentication and preserves feed boundaries", async () => withApp(async ({ request }) => {
  assert.equal((await feed(request, "/api/feed/home?limit=not-a-number")).statusCode, 401);
  const owner = await user(request, "auth-owner"); const outsider = await user(request, "auth-outsider"); await community(request, owner, "authfeed"); const entry = await post(request, owner, "authfeed", "visible");
  assert.deepEqual(ids(await (await feed(request, "/api/feed/home", outsider.cookie)).json()), []);
  assert.deepEqual(ids(await (await feed(request, "/api/feed/popular")).json()), [entry.id]);
  assert.equal((await feed(request, "/api/communities/missing/feed")).statusCode, 404);
}));

test("SCN-RC-07-H5 refreshes membership and vote ranking on fresh reads", async () => withApp(async ({ request, tick }) => {
  const owner = await user(request, "change-owner"); const voter = await user(request, "change-voter"); await community(request, owner, "changefeed");
  const old = await post(request, owner, "changefeed", "old"); tick(); const fresh = await post(request, owner, "changefeed", "fresh");
  assert.deepEqual(ids(await (await feed(request, "/api/feed/home", voter.cookie)).json()), []);
  await request("/api/communities/changefeed/members", { method: "POST", headers: { cookie: voter.cookie } });
  assert.deepEqual(ids(await (await feed(request, "/api/feed/home", voter.cookie)).json()), [fresh.id, old.id]);
  await json(request, `/api/posts/${old.id}/vote`, "PUT", { value: 1 }, voter.cookie);
  assert.deepEqual(ids(await (await feed(request, "/api/feed/popular")).json()), [old.id, fresh.id]);
  await request(`/api/posts/${old.id}/vote`, { method: "DELETE", headers: { cookie: voter.cookie } });
  assert.deepEqual(ids(await (await feed(request, "/api/feed/popular")).json()), [fresh.id, old.id]);
}));

test("SCN-RC-07-H6 rolls back feed failures and retries cleanly", async () => {
  let fail = true;
  await withApp(async ({ app, request, tick }) => {
    const owner = await user(request, "fault-owner"); await community(request, owner, "faultfeed"); await post(request, owner, "faultfeed", "one"); tick(); await post(request, owner, "faultfeed", "two");
    app.close();
    const recovered = createApp({ databasePath: app.config.databasePath, now: () => 1_700_000_000_000, beforeFeedCommit: () => { if (fail) { fail = false; throw new Error("fault"); } } });
    const failed = await recovered.inject({ path: "/api/feed/popular?limit=1" }); assert.equal(failed.statusCode, 503); assert.equal(failed.headers.get("retry-after"), "1"); assert.equal(recovered.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count, 0);
    const successful = await recovered.inject({ path: "/api/feed/popular?limit=1" }); assert.equal(successful.statusCode, 200); recovered.close();
  });
});

test("SCN-RC-07-H7 filters deleted snapshot posts from resumed pages", async () => withApp(async ({ request, tick }) => {
  const owner = await user(request, "delete-owner"); await community(request, owner, "deletefeed"); const first = await post(request, owner, "deletefeed", "first"); tick(); const second = await post(request, owner, "deletefeed", "second");
  const initial = await (await feed(request, "/api/feed/popular?limit=1")).json(); assert.ok(initial.nextCursor);
  assert.equal((await request(`/api/posts/${first.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  const resumed = await (await feed(request, `/api/feed/popular?cursor=${initial.nextCursor}`)).json();
  assert.equal(ids(resumed).includes(first.id), false); assert.deepEqual(ids(resumed), initial.posts[0].id === second.id ? [] : [first.id]);
}));
