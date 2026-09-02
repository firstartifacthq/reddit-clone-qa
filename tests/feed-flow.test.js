import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-"));
  const path = join(directory, "feeds.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}

function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function send(request, path, method, body, session) {
  return request(path, { method, headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) }, payload: JSON.stringify(body) });
}
async function signup(request, username) {
  const response = await send(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: cookie(response) };
}
async function community(request, owner, name) {
  assert.equal((await send(request, "/api/communities", "POST", { name }, owner.cookie)).statusCode, 201);
}
async function post(request, owner, communityName, title) {
  const response = await send(request, `/api/communities/${communityName}/posts`, "POST", { type: "text", title, text: `${title} body` }, owner.cookie);
  assert.equal(response.statusCode, 201);
  return response.json();
}
async function vote(request, voter, target, value) {
  const response = await send(request, `/api/posts/${target.id}/vote`, "PUT", { value }, voter.cookie);
  assert.equal(response.statusCode, 200);
}
async function fixed(response, status, error, markers = []) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), { "content-type": "application/json; charset=utf-8" });
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error });
  for (const marker of markers) assert.equal(body.includes(marker), false);
}

async function fixture(request) {
  const owner = await signup(request, "feed-owner");
  await community(request, owner, "alpha");
  await community(request, owner, "beta");
  const alphaOne = await post(request, owner, "alpha", "alpha-one");
  const alphaTwo = await post(request, owner, "alpha", "alpha-two");
  const betaOne = await post(request, owner, "beta", "beta-one");
  return { owner, alphaOne, alphaTwo, betaOne };
}

test("SCN-RC-07-H1 scopes and deterministically ranks all feed routes", async () => {
  await withApp(async ({ request }) => {
    const { owner, alphaOne, alphaTwo, betaOne } = await fixture(request);
    const member = await signup(request, "feed-member");
    assert.equal((await send(request, "/api/communities/alpha/members", "POST", {}, member.cookie)).statusCode, 200);
    const voter = await signup(request, "feed-voter");
    await vote(request, voter, alphaOne, 1);
    const home = await (await request("/api/feed/home?limit=100", { headers: { cookie: member.cookie } })).json();
    const popular = await (await request("/api/feed/popular?limit=100")).json();
    const scoped = await (await request("/api/communities/beta/feed?limit=100")).json();
    assert.deepEqual(home.posts.map((item) => [item.id, item.community, item.score]), [[alphaOne.id, "alpha", 1], [alphaTwo.id, "alpha", 0]]);
    assert.deepEqual(popular.posts.map((item) => item.id), [alphaOne.id, betaOne.id, alphaTwo.id]);
    assert.deepEqual(scoped.posts, [{ ...betaOne, score: 0 }]);
    assert.equal(new Set(popular.posts.map((item) => item.id)).size, popular.posts.length);
  });
});

test("SCN-RC-07-H2 keeps snapshots stable, bounded, and exhaustive", async () => {
  await withApp(async ({ request }) => {
    const { owner, alphaOne, alphaTwo, betaOne } = await fixture(request);
    const pageOne = await (await request("/api/feed/home?limit=1", { headers: { cookie: owner.cookie } })).json();
    assert.equal(pageOne.posts.length, 1); assert.ok(pageOne.nextCursor);
    const later = await post(request, owner, "alpha", "later-post");
    const voter = await signup(request, "feed-snapshot-voter");
    await vote(request, voter, alphaOne, 1);
    const remainder = await (await request(`/api/feed/home?limit=100&cursor=${pageOne.nextCursor}`, { headers: { cookie: owner.cookie } })).json();
    const stable = [pageOne.posts[0], ...remainder.posts];
    assert.deepEqual(stable.map((item) => item.id).sort(), [alphaOne.id, alphaTwo.id, betaOne.id].sort());
    assert.equal(remainder.nextCursor, null);
    const fresh = await (await request("/api/feed/home?limit=100", { headers: { cookie: owner.cookie } })).json();
    assert.equal(fresh.posts[0].id, alphaOne.id); assert.ok(fresh.posts.some((item) => item.id === later.id));
    assert.equal((await request("/api/feed/home", { headers: { cookie: owner.cookie } })).statusCode, 200);
  });
});

test("SCN-RC-07-H3 rejects invalid pagination without fallback or writes", async () => {
  await withApp(async ({ app, request }) => {
    const { owner } = await fixture(request);
    const before = app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count;
    for (const suffix of ["?limit=", "?limit=0", "?limit=101", "?limit=1&limit=2", "?unknown=1", "?cursor=short", "?cursor=x".concat("x".repeat(20))]) {
      await fixed(await request(`/api/feed/home${suffix}`, { headers: { cookie: owner.cookie } }), 400, "Invalid feed page");
    }
    const popular = await (await request("/api/feed/popular?limit=1")).json();
    await fixed(await request(`/api/feed/home?cursor=${popular.nextCursor}`, { headers: { cookie: owner.cookie } }), 400, "Invalid feed page");
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count, before + 1);
  });
});

test("SCN-RC-07-H4 requires Home authentication and binds cursors to accounts", async () => {
  await withApp(async ({ request }) => {
    const { owner } = await fixture(request);
    await fixed(await request("/api/feed/home?limit=bad"), 401, "Authentication required");
    const first = await (await request("/api/feed/home?limit=1", { headers: { cookie: owner.cookie } })).json();
    const other = await signup(request, "feed-other");
    await fixed(await request(`/api/feed/home?cursor=${first.nextCursor}`, { headers: { cookie: other.cookie } }), 400, "Invalid feed page");
    const home = await (await request("/api/feed/home?limit=100", { headers: { cookie: other.cookie } })).json();
    assert.deepEqual(home.posts, []);
  });
});

test("SCN-RC-07-H5 makes fresh membership and vote transitions visible", async () => {
  await withApp(async ({ request }) => {
    const { alphaOne } = await fixture(request);
    const member = await signup(request, "feed-transition-member");
    assert.deepEqual((await (await request("/api/feed/home", { headers: { cookie: member.cookie } })).json()).posts, []);
    assert.equal((await send(request, "/api/communities/alpha/members", "POST", {}, member.cookie)).statusCode, 200);
    assert.ok((await (await request("/api/feed/home", { headers: { cookie: member.cookie } })).json()).posts.some((item) => item.id === alphaOne.id));
    const voter = await signup(request, "feed-transition-voter");
    await vote(request, voter, alphaOne, 1);
    assert.equal((await (await request("/api/feed/popular", { headers: { cookie: member.cookie } })).json()).posts[0].score, 1);
    assert.equal((await send(request, "/api/communities/alpha/members/me", "DELETE", {}, member.cookie)).statusCode, 204);
    assert.equal((await (await request("/api/feed/home", { headers: { cookie: member.cookie } })).json()).posts.some((item) => item.id === alphaOne.id), false);
  });
});

test("SCN-RC-07-H6 survives restart, retries cursors, and rolls back feed faults", async () => {
  let failSnapshot = true;
  await withApp(async ({ app, path, request }) => {
    const { owner } = await fixture(request);
    await fixed(await request("/api/feed/home", { headers: { cookie: owner.cookie } }), 503, "Feed service unavailable");
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count, 0);
    const first = await (await request("/api/feed/home?limit=1", { headers: { cookie: owner.cookie } })).json();
    const retry = await (await request(`/api/feed/home?limit=1&cursor=${first.nextCursor}`, { headers: { cookie: owner.cookie } })).json();
    const retryAgain = await (await request(`/api/feed/home?limit=1&cursor=${first.nextCursor}`, { headers: { cookie: owner.cookie } })).json();
    assert.deepEqual(retryAgain, retry);
    app.close();
    const reopened = createApp({ databasePath: path, now: () => 1_700_000_000_000 });
    const resumed = await (await reopened.inject({ path: `/api/feed/home?limit=1&cursor=${first.nextCursor}`, headers: { cookie: owner.cookie } })).json();
    assert.deepEqual(resumed, retry); reopened.close();
  }, { beforeFeedSnapshotPersist: () => { if (failSnapshot) { failSnapshot = false; throw new Error("feed fault"); } } });
});

test("SCN-RC-07-H7 filters deleted snapshot posts without disclosure", async () => {
  await withApp(async ({ request }) => {
    const { owner, alphaOne, alphaTwo } = await fixture(request);
    const first = await (await request("/api/feed/home?limit=1", { headers: { cookie: owner.cookie } })).json();
    const deleted = first.posts[0].id === alphaOne.id ? alphaTwo : alphaOne;
    assert.equal((await request(`/api/posts/${deleted.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    const next = await request(`/api/feed/home?limit=100&cursor=${first.nextCursor}`, { headers: { cookie: owner.cookie } });
    const body = await next.text();
    assert.equal(body.includes(deleted.id), false); assert.equal(body.includes(deleted.title), false);
    assert.equal(JSON.parse(body).posts.some((item) => item.id === deleted.id), false);
  });
});
