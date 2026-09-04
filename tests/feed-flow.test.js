import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
const traversalTtlMs = 24 * 60 * 60 * 1_000;
const feedTables = ["feed_traversals", "feed_traversal_items", "feed_page_tokens"];
const canonicalTables = ["users", "sessions", "communities", "community_memberships", "posts", "post_votes"];
async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-"));
  const path = join(directory, "feed.sqlite");
  let time = 1_700_000_000_000;
  const now = () => time;
  const app = createApp({ databasePath: path, now, ...options });
  try {
    await run({ app, path, now, tick: (value = 1) => { time += value; }, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) });
  } finally {
    try { app.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}
function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function json(request, path, method, body, auth) { return request(path, { method, headers: { "content-type": "application/json", ...(auth ? { cookie: auth } : {}) }, payload: JSON.stringify(body) }); }
async function user(request, username) {
  const response = await json(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: cookie(response) };
}
async function community(request, owner, name) { assert.equal((await json(request, "/api/communities", "POST", { name }, owner.cookie)).statusCode, 201); }
async function post(request, owner, name, title) {
  const response = await json(request, `/api/communities/${name}/posts`, "POST", { type: "text", title, text: title }, owner.cookie);
  assert.equal(response.statusCode, 201);
  return response.json();
}
async function vote(request, voter, postId, value) {
  const response = await json(request, `/api/posts/${postId}/vote`, "PUT", { value }, voter.cookie);
  assert.equal(response.statusCode, 200);
}
async function feed(request, route, auth) { return request(route, { headers: auth ? { cookie: auth } : {} }); }
function ids(body) { return body.posts.map((entry) => entry.id); }
function tableState(database, tables = [...feedTables, ...canonicalTables]) {
  return Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}
async function bodyOf(response, status = 200) { assert.equal(response.statusCode, status); return response.json(); }

test("SCN-RC-07-H1 scopes deterministic Home, Popular, and community feeds", async () => withApp(async ({ app, request, tick }) => {
  const owner = await user(request, "feed-owner");
  const member = await user(request, "feed-member");
  const betaMember = await user(request, "feed-beta-member");
  await community(request, owner, "alpha");
  await community(request, owner, "beta");
  const oldest = await post(request, owner, "alpha", "oldest");
  tick();
  const tiedA = await post(request, owner, "alpha", "tied-a");
  const tiedB = await post(request, owner, "alpha", "tied-b");
  tick();
  const newest = await post(request, owner, "alpha", "newest");
  tick();
  const beta = await post(request, owner, "beta", "beta");
  assert.equal((await request("/api/communities/alpha/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
  assert.equal((await request("/api/communities/beta/members", { method: "POST", headers: { cookie: betaMember.cookie } })).statusCode, 200);
  await vote(request, member, tiedA.id, 1);
  await vote(request, member, tiedB.id, 1);
  await vote(request, betaMember, beta.id, 1);

  const tied = [tiedA.id, tiedB.id].sort();
  const expectedScoped = [newest.id, ...tied, oldest.id];
  const homeBody = await bodyOf(await feed(request, "/api/feed/home", member.cookie));
  const communityBody = await bodyOf(await feed(request, "/api/communities/alpha/feed"));
  const popularBody = await bodyOf(await feed(request, "/api/feed/popular"));
  assert.deepEqual(ids(homeBody), expectedScoped, "Home ranks publication time, then score, then ID");
  assert.deepEqual(ids(communityBody), expectedScoped, "community ranking uses the same total order");
  assert.deepEqual(ids(popularBody), [beta.id, ...tied, newest.id, oldest.id], "Popular ranks score before publication time and ID");
  for (const body of [homeBody, communityBody, popularBody]) assert.equal(new Set(ids(body)).size, body.posts.length);
  for (const entry of communityBody.posts) assert.deepEqual(entry, await bodyOf(await feed(request, `/api/posts/${entry.id}`)));
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversals").get().count, 0);
}));

test("SCN-RC-07-H2 snapshots pages and validates inclusive page limits", async () => withApp(async ({ app, path, now, request, tick }) => {
  const owner = await user(request, "page-owner");
  const voter = await user(request, "page-voter");
  await community(request, owner, "pages");
  const created = [];
  for (let index = 0; index < 26; index += 1) { created.push(await post(request, owner, "pages", `post-${index}`)); tick(); }
  const snapshotOrder = created.map((entry) => entry.id).reverse();

  const defaultPage = await bodyOf(await feed(request, "/api/feed/popular"));
  assert.equal(defaultPage.posts.length, 25, "omitted limit defaults to 25");
  assert.ok(defaultPage.nextCursor);
  const one = await bodyOf(await feed(request, "/api/feed/popular?limit=1"));
  assert.equal(one.posts.length, 1);
  assert.ok(one.nextCursor);
  const hundred = await bodyOf(await feed(request, "/api/feed/popular?limit=100"));
  assert.deepEqual(ids(hundred), snapshotOrder);
  assert.equal(hundred.nextCursor, null);
  const exactBoundary = await bodyOf(await feed(request, "/api/feed/popular?limit=26"));
  assert.deepEqual(ids(exactBoundary), snapshotOrder);
  assert.equal(exactBoundary.nextCursor, null, "an exact final boundary does not issue a cursor");
  for (const invalidLimit of ["0", "101", "01", "+1", "1.0"]) {
    assert.deepEqual(await bodyOf(await feed(request, `/api/feed/popular?limit=${encodeURIComponent(invalidLimit)}`), 422), { error: "Invalid feed page" });
  }

  const inserted = await post(request, owner, "pages", "inserted-later");
  await vote(request, voter, created[0].id, 1);
  app.close();
  const reopened = createApp({ databasePath: path, now });
  const reopenedRequest = (route, options = {}) => reopened.inject({ path: route, ...options });
  const resumedRoute = `/api/feed/popular?cursor=${defaultPage.nextCursor}`;
  const resumed = await bodyOf(await feed(reopenedRequest, resumedRoute));
  const replayed = await bodyOf(await feed(reopenedRequest, resumedRoute));
  assert.deepEqual(resumed, replayed, "restart and cursor replay return the identical snapshot page");
  assert.deepEqual([...ids(defaultPage), ...ids(resumed)], snapshotOrder, "later inserts and rank changes neither duplicate nor omit snapshot posts");
  const fresh = await bodyOf(await feed(reopenedRequest, "/api/feed/popular"));
  assert.equal(fresh.posts[0].id, created[0].id, "a new traversal sees the committed score change");
  assert.equal(ids(fresh).includes(inserted.id), true, "a new traversal sees the later insert");
  reopened.close();
}));

test("SCN-RC-07-H3 rejects invalid page authority without disclosure", async () => withApp(async ({ app, request, tick }) => {
  const owner = await user(request, "invalid-owner");
  const other = await user(request, "invalid-other");
  await community(request, owner, "alpha");
  await community(request, owner, "beta");
  const protectedMarker = "never-disclose-feed-marker";
  for (let index = 0; index < 3; index += 1) { await post(request, owner, "alpha", `${protectedMarker}-${index}`); tick(); }
  assert.equal((await request("/api/communities/alpha/members", { method: "POST", headers: { cookie: other.cookie } })).statusCode, 200);
  const popularCursor = (await bodyOf(await feed(request, "/api/feed/popular?limit=1"))).nextCursor;
  const communityCursor = (await bodyOf(await feed(request, "/api/communities/alpha/feed?limit=1"))).nextCursor;
  const homeCursor = (await bodyOf(await feed(request, "/api/feed/home?limit=1", other.cookie))).nextCursor;
  assert.ok(popularCursor && communityCursor && homeCursor);

  const invalidRequests = [
    ["/api/feed/popular?cursor=", undefined],
    ["/api/feed/popular?cursor=%25", undefined],
    ["/api/feed/popular?cursor=a&cursor=b", undefined],
    ["/api/feed/popular?limit=2&limit=3", undefined],
    ["/api/feed/popular?other=protected", undefined],
    ["/api/feed/popular?limit=0", undefined],
    ["/api/feed/popular?limit=101", undefined],
    ["/api/feed/popular?limit=01", undefined],
    ["/api/feed/popular?cursor=00000000-0000-4000-8000-000000000000", undefined],
    [`/api/feed/home?cursor=${communityCursor}`, owner.cookie],
    [`/api/feed/popular?cursor=${communityCursor}`, undefined],
    [`/api/communities/beta/feed?cursor=${communityCursor}`, undefined],
    [`/api/feed/home?cursor=${homeCursor}`, owner.cookie],
  ];
  for (const [route, auth] of invalidRequests) {
    const beforeCounts = tableState(app.database);
    const beforeChanges = app.database.prepare("SELECT total_changes() AS count").get().count;
    const response = await feed(request, route, auth);
    const text = await response.text();
    assert.equal(response.statusCode, 422);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(text), { error: "Invalid feed page" });
    assert.equal(text.includes(protectedMarker), false);
    for (const token of [popularCursor, communityCursor, homeCursor]) assert.equal(text.includes(token), false);
    assert.deepEqual(tableState(app.database), beforeCounts, `invalid request mutated durable rows: ${route}`);
    assert.equal(app.database.prepare("SELECT total_changes() AS count").get().count, beforeChanges, `invalid request performed a write: ${route}`);
  }

  tick(traversalTtlMs + 1);
  const beforeExpired = tableState(app.database);
  const beforeExpiredChanges = app.database.prepare("SELECT total_changes() AS count").get().count;
  const expired = await feed(request, `/api/feed/popular?cursor=${popularCursor}`);
  assert.equal(expired.statusCode, 422);
  assert.deepEqual(await expired.json(), { error: "Invalid feed page" });
  assert.deepEqual(tableState(app.database), beforeExpired, "expired authority must not trigger cleanup");
  assert.equal(app.database.prepare("SELECT total_changes() AS count").get().count, beforeExpiredChanges);
}));

test("SCN-RC-07-H4 requires Home authentication and preserves feed boundaries", async () => withApp(async ({ app, request }) => {
  const alphaOwner = await user(request, "auth-alpha-owner");
  const betaOwner = await user(request, "auth-beta-owner");
  const viewer = await user(request, "auth-viewer");
  await community(request, alphaOwner, "authalpha");
  await community(request, betaOwner, "authbeta");
  const alphaPost = await post(request, alphaOwner, "authalpha", "alpha-visible");
  const betaPost = await post(request, betaOwner, "authbeta", "beta-visible");
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/home", alphaOwner.cookie))), [alphaPost.id]);
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/home", betaOwner.cookie))), [betaPost.id]);

  assert.equal((await request("/api/communities/authalpha/members", { method: "POST", headers: { cookie: viewer.cookie } })).statusCode, 200);
  const hidden = await post(request, alphaOwner, "authalpha", "deleted-author-marker");
  assert.equal((await request("/api/me", { method: "DELETE", headers: { cookie: alphaOwner.cookie } })).statusCode, 202);
  const viewerHome = await bodyOf(await feed(request, "/api/feed/home", viewer.cookie));
  const popular = await bodyOf(await feed(request, "/api/feed/popular"));
  const alpha = await bodyOf(await feed(request, "/api/communities/authalpha/feed"));
  for (const body of [viewerHome, popular, alpha]) {
    assert.equal(ids(body).includes(hidden.id), false);
    assert.equal(JSON.stringify(body).includes("deleted-author-marker"), false);
  }
  assert.deepEqual(ids(popular), [betaPost.id], "public feeds retain only currently readable posts");

  const expired = await user(request, "auth-expired");
  app.database.prepare("UPDATE sessions SET expires_at = 0 WHERE user_id = ?").run(expired.account.id);
  const revoked = await user(request, "auth-revoked");
  assert.equal((await request("/api/auth/logout", { method: "POST", headers: { cookie: revoked.cookie } })).statusCode, 204);
  const deleted = await user(request, "auth-deleted");
  assert.equal((await request("/api/me", { method: "DELETE", headers: { cookie: deleted.cookie } })).statusCode, 202);
  const denied = [undefined, "reddit_session=malformed", expired.cookie, revoked.cookie, deleted.cookie];
  const beforeDenied = tableState(app.database, feedTables);
  for (const auth of denied) {
    const response = await feed(request, "/api/feed/home?limit=not-a-number", auth);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
  }
  assert.deepEqual(tableState(app.database, feedTables), beforeDenied);
  assert.equal((await feed(request, "/api/communities/missing/feed?limit=1")).statusCode, 404);
  assert.deepEqual(tableState(app.database, feedTables), beforeDenied, "missing community cannot create traversal state");
}));

test("SCN-RC-07-H5 refreshes membership and vote ranking on fresh reads", async () => withApp(async ({ app, request }) => {
  const owner = await user(request, "change-owner");
  const member = await user(request, "change-member");
  await community(request, owner, "changefeed");
  const entries = [
    await post(request, owner, "changefeed", "one"),
    await post(request, owner, "changefeed", "two"),
    await post(request, owner, "changefeed", "three"),
  ];
  const initialOrder = entries.map((entry) => entry.id).sort();
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/home", member.cookie))), []);
  assert.equal((await request("/api/communities/changefeed/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/home", member.cookie))), initialOrder);
  const joinedSnapshot = await bodyOf(await feed(request, "/api/feed/home?limit=1", member.cookie));
  assert.equal((await request("/api/communities/changefeed/members/me", { method: "DELETE", headers: { cookie: member.cookie } })).statusCode, 204);
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/home", member.cookie))), []);
  const joinedResume = await bodyOf(await feed(request, `/api/feed/home?cursor=${joinedSnapshot.nextCursor}`, member.cookie));
  assert.deepEqual([...ids(joinedSnapshot), ...ids(joinedResume)], initialOrder, "leaving does not rewrite an issued Home snapshot");
  assert.equal((await request("/api/communities/changefeed/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/home", member.cookie))), initialOrder);

  const target = initialOrder[1];
  const beforeSet = await bodyOf(await feed(request, "/api/feed/popular?limit=1"));
  await vote(request, member, target, 1);
  const afterSetOrder = [target, ...initialOrder.filter((id) => id !== target)];
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/popular"))), afterSetOrder);
  assert.deepEqual([...ids(beforeSet), ...ids(await bodyOf(await feed(request, `/api/feed/popular?cursor=${beforeSet.nextCursor}`)))], initialOrder);

  const beforeReplace = await bodyOf(await feed(request, "/api/feed/popular?limit=1"));
  await vote(request, member, target, -1);
  const afterReplaceOrder = [...initialOrder.filter((id) => id !== target), target];
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/popular"))), afterReplaceOrder);
  assert.deepEqual([...ids(beforeReplace), ...ids(await bodyOf(await feed(request, `/api/feed/popular?cursor=${beforeReplace.nextCursor}`)))], afterSetOrder);
  const replacementRows = app.database.prepare("SELECT value FROM post_votes WHERE post_id = ? AND voter_user_id = ?").all(target, member.account.id);
  assert.equal(replacementRows.length, 1, "replacement keeps one current ledger row");
  assert.equal(replacementRows[0].value, -1);

  const beforeClear = await bodyOf(await feed(request, "/api/feed/popular?limit=1"));
  assert.equal((await request(`/api/posts/${target}/vote`, { method: "DELETE", headers: { cookie: member.cookie } })).statusCode, 204);
  assert.deepEqual(ids(await bodyOf(await feed(request, "/api/feed/popular"))), initialOrder);
  assert.deepEqual([...ids(beforeClear), ...ids(await bodyOf(await feed(request, `/api/feed/popular?cursor=${beforeClear.nextCursor}`)))], afterReplaceOrder);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_votes WHERE post_id = ? AND voter_user_id = ?").get(target, member.account.id).count, 0);
}));

test("SCN-RC-07-H6 rolls back feed failures and retries cleanly", async () => {
  let fail = true;
  await withApp(async ({ app, path, now, request, tick }) => {
    const owner = await user(request, "fault-owner");
    await community(request, owner, "faultfeed");
    const entries = [];
    for (let index = 0; index < 3; index += 1) { entries.push(await post(request, owner, "faultfeed", `fault-${index}`)); tick(); }
    const expected = entries.map((entry) => entry.id).reverse();
    app.close();
    const recovered = createApp({ databasePath: path, now, beforeFeedCommit: () => { if (fail) { fail = false; throw new Error("fault"); } } });
    const recoveredRequest = (route, options = {}) => recovered.inject({ path: route, ...options });
    const before = tableState(recovered.database, feedTables);
    const failed = await feed(recoveredRequest, "/api/feed/popular?limit=1");
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.headers.get("retry-after"), "1");
    assert.deepEqual(await failed.json(), { error: "Feed unavailable" });
    assert.deepEqual(tableState(recovered.database, feedTables), before, "fault rolls back traversal, items, and token together");

    const first = await bodyOf(await feed(recoveredRequest, "/api/feed/popular?limit=1"));
    assert.ok(first.nextCursor);
    const secondRoute = `/api/feed/popular?limit=1&cursor=${first.nextCursor}`;
    const second = await bodyOf(await feed(recoveredRequest, secondRoute));
    const replay = await bodyOf(await feed(recoveredRequest, secondRoute));
    assert.deepEqual(replay, second, "the same valid cursor is idempotent");
    recovered.close();

    const reopened = createApp({ databasePath: path, now });
    const reopenedRequest = (route, options = {}) => reopened.inject({ path: route, ...options });
    assert.deepEqual(await bodyOf(await feed(reopenedRequest, secondRoute)), second, "cursor replay survives reopen");
    const third = await bodyOf(await feed(reopenedRequest, `/api/feed/popular?cursor=${second.nextCursor}`));
    const traversed = [...ids(first), ...ids(second), ...ids(third)];
    assert.deepEqual(traversed, expected);
    assert.equal(new Set(traversed).size, traversed.length);
    assert.equal(third.nextCursor, null);
    reopened.close();
  });
});

test("moderation removal and restoration gate fresh and retained feed pages", async () => withApp(async ({ app, request, tick }) => {
  const owner = await user(request, "moderated-feed-owner"); await community(request, owner, "moderatedfeed");
  const entries = [];
  for (let index = 0; index < 4; index += 1) { entries.push(await post(request, owner, "moderatedfeed", `moderated-feed-${index}`)); tick(); }
  const ordered = entries.map((entry) => entry.id).reverse(); const target = ordered[1];
  const contexts = [
    ["/api/feed/home?limit=1", owner.cookie], ["/api/feed/popular?limit=1", undefined], ["/api/communities/moderatedfeed/feed?limit=1", undefined],
  ];
  const snapshots = [];
  for (const [route, auth] of contexts) snapshots.push(await bodyOf(await feed(request, route, auth)));
  assert.equal((await request(`/api/mod/posts/${target}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  for (const [index, snapshot] of snapshots.entries()) {
    const resumedRoute = `${contexts[index][0].replace("limit=1", "limit=100")}&cursor=${snapshot.nextCursor}`;
    const resumed = await bodyOf(await feed(request, resumedRoute, contexts[index][1]));
    assert.deepEqual(ids(resumed), ordered.slice(2));
  }
  for (const [route, auth] of contexts) assert.equal(ids(await bodyOf(await feed(request, route.replace("limit=1", "limit=100"), auth))).includes(target), false);
  assert.equal((await request(`/api/mod/posts/${target}/restore`, { method: "POST", headers: { cookie: owner.cookie } })).statusCode, 200);
  for (const [index, snapshot] of snapshots.entries()) {
    const resumedRoute = `${contexts[index][0].replace("limit=1", "limit=100")}&cursor=${snapshot.nextCursor}`;
    const resumed = await bodyOf(await feed(request, resumedRoute, contexts[index][1]));
    assert.deepEqual(ids(resumed), ordered.slice(1), "restoration re-enables retained snapshot identity");
  }
  for (const [route, auth] of contexts) assert.equal(ids(await bodyOf(await feed(request, route.replace("limit=1", "limit=100"), auth))).includes(target), true);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM posts WHERE id = ?").get(target).count, 1);
}));

test("SCN-RC-07-H7 filters deleted snapshot posts from resumed pages", async () => withApp(async ({ app, request, tick }) => {
  const owner = await user(request, "delete-owner");
  await community(request, owner, "deletefeed");
  const entries = [];
  for (let index = 0; index < 4; index += 1) { entries.push(await post(request, owner, "deletefeed", `protected-delete-marker-${index}`)); tick(); }
  const ordered = entries.map((entry) => entry.id).reverse();
  const home = await bodyOf(await feed(request, "/api/feed/home?limit=1", owner.cookie));
  const popular = await bodyOf(await feed(request, "/api/feed/popular?limit=1"));
  const communityPage = await bodyOf(await feed(request, "/api/communities/deletefeed/feed?limit=1"));
  assert.deepEqual(ids(home), [ordered[0]]);
  assert.deepEqual(ids(popular), [ordered[0]]);
  assert.deepEqual(ids(communityPage), [ordered[0]]);
  const beforeCanonical = tableState(app.database, canonicalTables);
  const deletedId = ordered[1];
  assert.equal((await request(`/api/posts/${deletedId}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);

  const resumedPages = [
    await bodyOf(await feed(request, `/api/feed/home?limit=2&cursor=${home.nextCursor}`, owner.cookie)),
    await bodyOf(await feed(request, `/api/feed/popular?limit=2&cursor=${popular.nextCursor}`)),
    await bodyOf(await feed(request, `/api/communities/deletefeed/feed?limit=2&cursor=${communityPage.nextCursor}`)),
  ];
  for (const resumed of resumedPages) {
    assert.deepEqual(ids(resumed), ordered.slice(2), "a deleted ordinal is skipped and the page fills from later readable items");
    assert.equal(resumed.nextCursor, null);
    const combined = [ordered[0], ...ids(resumed)];
    assert.equal(new Set(combined).size, combined.length, "gap filling never duplicates a prior post");
    assert.equal(JSON.stringify(resumed).includes("protected-delete-marker-2"), false, "deleted metadata is not disclosed");
  }
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM feed_traversal_items WHERE post_id = ?").get(deletedId).count, 3, "immutable snapshots retain stale identity without restoring access");
  const afterCanonical = tableState(app.database, canonicalTables);
  assert.equal(afterCanonical.posts, beforeCanonical.posts - 1);
  for (const table of canonicalTables.filter((table) => table !== "posts" && table !== "post_votes")) assert.equal(afterCanonical[table], beforeCanonical[table]);
}));
