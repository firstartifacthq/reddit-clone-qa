import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-feed-"));
  const path = join(directory, "feeds.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0];
}

async function send(request, path, method, body, session, headers = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}), ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function signup(request, username) {
  const response = await send(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: cookie(response) };
}

async function community(request, owner, name) {
  const response = await send(request, "/api/communities", "POST", { name }, owner.cookie);
  assert.equal(response.statusCode, 201);
}

async function joinCommunity(request, account, name) {
  assert.equal((await send(request, `/api/communities/${name}/members`, "POST", {}, account.cookie)).statusCode, 200);
}

async function post(request, owner, communityName, body) {
  const normalized = typeof body === "string" ? { type: "text", title: body, text: `${body} body` } : body;
  const response = await send(request, `/api/communities/${communityName}/posts`, "POST", normalized, owner.cookie);
  assert.equal(response.statusCode, 201);
  return response.json();
}

async function vote(request, voter, target, value) {
  const response = await send(request, `/api/posts/${target.id}/vote`, "PUT", { value }, voter.cookie);
  assert.equal(response.statusCode, 200);
}

async function clearVote(request, voter, target) {
  const response = await request(`/api/posts/${target.id}/vote`, { method: "DELETE", headers: { cookie: voter.cookie } });
  assert.equal(response.statusCode, 204);
}

async function fixed(response, status, error, markers = []) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), jsonHeaders);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error });
  for (const marker of markers) assert.equal(body.includes(marker), false, `response disclosed ${marker}`);
  return body;
}

async function feed(request, route, session) {
  const response = await request(route, { headers: session ? { cookie: session } : {} });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.fromEntries(response.headers), jsonHeaders);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["posts", "nextCursor"]);
  assert.ok(body.nextCursor === null || typeof body.nextCursor === "string");
  return body;
}

function rows(database, table) {
  return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }));
}

const domainTables = [
  "users", "sessions", "communities", "community_memberships", "posts", "post_idempotency",
  "comments", "comment_traversals", "comment_traversal_items", "comment_page_tokens", "post_votes",
];
const feedTables = ["feed_traversals", "feed_traversal_items", "feed_page_tokens"];
function snapshot(database, tables = [...domainTables, ...feedTables]) {
  return Object.fromEntries(tables.map((table) => [table, rows(database, table)]));
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

function ids(page) { return page.posts.map((item) => item.id); }
function scores(page) { return page.posts.map((item) => [item.id, item.score]); }

test("SCN-RC-07-H1 scopes and deterministically ranks all feed routes", async () => {
  await withApp(async ({ request }) => {
    const owner = await signup(request, "rank-owner");
    const otherOwner = await signup(request, "rank-other-owner");
    const moderator = await signup(request, "rank-moderator");
    const member = await signup(request, "rank-member");
    const nonMember = await signup(request, "rank-nonmember");
    await community(request, owner, "alpha");
    await community(request, otherOwner, "beta");
    await joinCommunity(request, moderator, "alpha");
    await joinCommunity(request, member, "alpha");
    assert.equal((await send(request, "/api/communities/alpha/moderators", "PATCH", { username: moderator.account.username, role: "moderator" }, owner.cookie)).statusCode, 200);

    const text = await post(request, owner, "alpha", { type: "text", title: "rank-text", text: "rank-text-body" });
    const link = await post(request, owner, "alpha", { type: "link", title: "rank-link", url: "https://rank-link.test/path" });
    const mediaBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rank-media-bytes")]);
    const media = await post(request, owner, "alpha", {
      type: "media", title: "rank-media",
      media: { filename: "rank.png", contentType: "image/png", bytesBase64: mediaBytes.toString("base64") },
    });
    const beta = await post(request, otherOwner, "beta", "rank-beta");
    const upOne = await signup(request, "rank-up-one");
    const upTwo = await signup(request, "rank-up-two");
    await vote(request, upOne, text, 1);
    await vote(request, upTwo, text, 1);
    await vote(request, upOne, link, 1);
    await vote(request, upOne, media, 1);

    const expectedAlpha = [{ ...text, score: 2 }, { ...media, score: 1 }, { ...link, score: 1 }];
    for (const account of [owner, moderator, member]) {
      const home = await feed(request, "/api/feed/home?limit=100", account.cookie);
      assert.deepEqual(home, { posts: expectedAlpha, nextCursor: null });
      assert.ok(home.posts.every((item) => Number.isSafeInteger(item.score)));
    }
    assert.deepEqual(await feed(request, "/api/feed/home?limit=100", nonMember.cookie), { posts: [], nextCursor: null });
    assert.deepEqual(await feed(request, "/api/feed/popular?limit=100"), {
      posts: [...expectedAlpha, { ...beta, score: 0 }], nextCursor: null,
    });
    assert.deepEqual(await feed(request, "/api/communities/beta/feed?limit=100"), { posts: [{ ...beta, score: 0 }], nextCursor: null });
    assert.equal(new Set(ids(await feed(request, "/api/feed/popular?limit=100"))).size, 4);
  });
});

test("SCN-RC-07-H2 keeps snapshots stable, bounded, and exhaustive", async () => {
  await withApp(async ({ request }) => {
    const owner = await signup(request, "page-owner");
    const member = await signup(request, "page-member");
    await community(request, owner, "alpha");
    await community(request, owner, "beta");
    await community(request, owner, "gamma");
    await joinCommunity(request, member, "alpha");
    await joinCommunity(request, member, "beta");
    const original = [];
    for (let index = 0; index < 27; index += 1) original.push(await post(request, owner, index % 2 ? "alpha" : "beta", `page-${index}`));
    const defaultPage = await feed(request, "/api/feed/home", member.cookie);
    assert.equal(defaultPage.posts.length, 25);
    assert.ok(defaultPage.nextCursor);
    const defaultLast = await feed(request, `/api/feed/home?cursor=${defaultPage.nextCursor}`, member.cookie);
    assert.equal(defaultLast.posts.length, 2);
    assert.equal(defaultLast.nextCursor, null);
    assert.equal((await feed(request, "/api/feed/home?limit=1", member.cookie)).posts.length, 1);
    assert.equal((await feed(request, "/api/feed/home?limit=100", member.cookie)).posts.length, 27);

    const first = await feed(request, "/api/feed/home?limit=1", member.cookie);
    assert.ok(first.nextCursor);
    const secondSnapshotPost = original.at(-2);
    assert.equal((await request(`/api/posts/${secondSnapshotPost.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    const gamma = await post(request, owner, "gamma", "page-gamma-new");
    await joinCommunity(request, member, "gamma");
    assert.equal((await send(request, "/api/communities/alpha/members/me", "DELETE", {}, member.cookie)).statusCode, 204);
    const voter = await signup(request, "page-voter");
    await vote(request, voter, original[0], 1);

    const second = await feed(request, `/api/feed/home?limit=2&cursor=${first.nextCursor}`, member.cookie);
    assert.equal(second.posts.length, 2);
    const third = await feed(request, `/api/feed/home?limit=100&cursor=${second.nextCursor}`, member.cookie);
    assert.equal(third.nextCursor, null);
    const oldTraversal = [...first.posts, ...second.posts, ...third.posts];
    const expectedOld = original.map((item) => item.id).filter((id) => id !== secondSnapshotPost.id);
    assert.deepEqual(ids({ posts: oldTraversal }).sort(), expectedOld.sort());
    assert.equal(new Set(oldTraversal.map((item) => item.id)).size, oldTraversal.length);
    assert.ok(oldTraversal.every((item) => item.id !== gamma.id));
    assert.ok(oldTraversal.every((item) => item.score === 0));

    const fresh = await feed(request, "/api/feed/home?limit=100", member.cookie);
    assert.ok(fresh.posts.some((item) => item.id === gamma.id));
    assert.ok(fresh.posts.every((item) => item.community !== "alpha"));
    assert.equal(fresh.posts.find((item) => item.id === original[0].id).score, 1);
  });
});

test("SCN-RC-07-H3 rejects invalid pagination without fallback or writes", async () => {
  let now = 1_700_000_000_000;
  await withApp(async ({ app, request }) => {
    const { owner } = await fixture(request);
    const other = await signup(request, "invalid-other");
    const invalidGrammar = [
      "?limit=", "?limit=0", "?limit=101", "?limit=1.5", "?limit=01", "?limit=x",
      "?limit=1&limit=2", "?cursor=", "?cursor=a&cursor=b", "?unknown=1", "?cursor=short",
    ];
    for (const suffix of invalidGrammar) {
      const before = snapshot(app.database);
      await fixed(await request(`/api/feed/home${suffix}`, { headers: { cookie: owner.cookie } }), 400, "Invalid feed page");
      assert.deepEqual(snapshot(app.database), before, suffix);
    }
    for (const token of ["x".repeat(36), `${"y".repeat(255)}z`]) {
      const before = snapshot(app.database);
      await fixed(await request(`/api/feed/home?cursor=${token}`, { headers: { cookie: owner.cookie } }), 400, "Invalid feed page");
      assert.deepEqual(snapshot(app.database), before);
    }

    const home = await feed(request, "/api/feed/home?limit=1", owner.cookie);
    const popular = await feed(request, "/api/feed/popular?limit=1", owner.cookie);
    const alpha = await feed(request, "/api/communities/alpha/feed?limit=1", owner.cookie);
    assert.ok(home.nextCursor && popular.nextCursor && alpha.nextCursor);
    const rejected = [
      ["/api/feed/popular", home.nextCursor, owner.cookie],
      ["/api/communities/beta/feed", alpha.nextCursor, owner.cookie],
      ["/api/feed/home", home.nextCursor, other.cookie],
      ["/api/feed/home", `${home.nextCursor.slice(0, -1)}${home.nextCursor.endsWith("x") ? "y" : "x"}`, owner.cookie],
    ];
    for (const [route, token, session] of rejected) {
      const before = snapshot(app.database);
      await fixed(await request(`${route}?cursor=${token}`, { headers: { cookie: session } }), 400, "Invalid feed page");
      assert.deepEqual(snapshot(app.database), before, route);
    }
    now += 86_400_001;
    const beforeExpired = snapshot(app.database);
    await fixed(await request(`/api/feed/popular?cursor=${popular.nextCursor}`, { headers: { cookie: owner.cookie } }), 400, "Invalid feed page");
    assert.deepEqual(snapshot(app.database), beforeExpired);
  }, { now: () => now, feedTraversalLifetimeMs: 86_400_000 });
});

test("SCN-RC-07-H4 requires Home authentication and binds cursors to active accounts", async () => {
  const now = 1_700_000_000_000;
  await withApp(async ({ app, request }) => {
    const { owner, alphaOne, alphaTwo } = await fixture(request);
    await fixed(await request("/api/feed/home?limit=bad"), 401, "Authentication required");

    const expired = await signup(request, "auth-expired");
    app.database.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(now - 1, expired.account.id);
    await fixed(await request("/api/feed/home", { headers: { cookie: expired.cookie } }), 401, "Authentication required");
    const revoked = await signup(request, "auth-revoked");
    assert.equal((await request("/api/auth/logout", { method: "POST", headers: { cookie: revoked.cookie } })).statusCode, 204);
    await fixed(await request("/api/feed/home", { headers: { cookie: revoked.cookie } }), 401, "Authentication required");
    const deleted = await signup(request, "auth-deleted");
    app.database.prepare("UPDATE users SET deletion_requested_at = ? WHERE id = ?").run(now, deleted.account.id);
    await fixed(await request("/api/feed/home", { headers: { cookie: deleted.cookie } }), 401, "Authentication required");

    const first = await feed(request, "/api/feed/home?limit=1", owner.cookie);
    const other = await signup(request, "auth-other");
    await fixed(await request(`/api/feed/home?cursor=${first.nextCursor}`, { headers: { cookie: other.cookie } }), 400, "Invalid feed page");
    assert.deepEqual(await feed(request, "/api/feed/home?limit=100", other.cookie), { posts: [], nextCursor: null });

    const directDenied = first.posts[0].id === alphaOne.id ? alphaTwo : alphaOne;
    const popular = await feed(request, "/api/feed/popular?limit=1", owner.cookie);
    const scoped = await feed(request, "/api/communities/alpha/feed?limit=1", owner.cookie);
    assert.equal((await request(`/api/posts/${directDenied.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    await fixed(await request(`/api/posts/${directDenied.id}`), 404, "Not found", [directDenied.id, directDenied.title]);
    for (const [route, cursor] of [["/api/feed/home", first.nextCursor], ["/api/feed/popular", popular.nextCursor], ["/api/communities/alpha/feed", scoped.nextCursor]]) {
      const page = await feed(request, `${route}?limit=100&cursor=${cursor}`, owner.cookie);
      assert.equal(JSON.stringify(page).includes(directDenied.id), false);
      assert.equal(JSON.stringify(page).includes(directDenied.title), false);
    }
  });
});

test("SCN-RC-07-H5 makes fresh membership and every vote transition visible", async () => {
  await withApp(async ({ request }) => {
    const { alphaOne, alphaTwo } = await fixture(request);
    const member = await signup(request, "transition-member");
    assert.deepEqual(await feed(request, "/api/feed/home", member.cookie), { posts: [], nextCursor: null });
    await joinCommunity(request, member, "alpha");
    const old = await feed(request, "/api/feed/home?limit=1", member.cookie);
    assert.ok(old.nextCursor);
    const voter = await signup(request, "transition-voter");

    const assertTransition = async (alphaExpected) => {
      for (const route of ["/api/feed/home?limit=100", "/api/communities/alpha/feed?limit=100"]) {
        assert.deepEqual(scores(await feed(request, route, member.cookie)), alphaExpected, route);
      }
      const popular = await feed(request, "/api/feed/popular?limit=100", member.cookie);
      const alphaProjection = popular.posts.filter((item) => item.community === "alpha").map((item) => [item.id, item.score]);
      assert.deepEqual(alphaProjection, alphaExpected);
    };
    await vote(request, voter, alphaOne, 1);
    await assertTransition([[alphaOne.id, 1], [alphaTwo.id, 0]]);
    await vote(request, voter, alphaOne, -1);
    await assertTransition([[alphaTwo.id, 0], [alphaOne.id, -1]]);
    await clearVote(request, voter, alphaOne);
    await assertTransition([[alphaTwo.id, 0], [alphaOne.id, 0]]);

    const oldRemainder = await feed(request, `/api/feed/home?limit=100&cursor=${old.nextCursor}`, member.cookie);
    assert.ok(oldRemainder.posts.every((item) => item.score === 0));
    assert.equal((await send(request, "/api/communities/alpha/members/me", "DELETE", {}, member.cookie)).statusCode, 204);
    assert.deepEqual(await feed(request, "/api/feed/home", member.cookie), { posts: [], nextCursor: null });
  });
});

test("SCN-RC-07-H6 survives restart, isolates failures, and exhausts exactly once", async () => {
  let failSnapshot = true;
  let failRead = false;
  await withApp(async ({ app, path, request }) => {
    const { owner } = await fixture(request);
    const beforeSnapshotFault = snapshot(app.database, feedTables);
    await fixed(await request("/api/feed/home", { headers: { cookie: owner.cookie } }), 503, "Feed service unavailable");
    assert.deepEqual(snapshot(app.database, feedTables), beforeSnapshotFault);

    const first = await feed(request, "/api/feed/home?limit=1", owner.cookie);
    const isolation = await feed(request, "/api/communities/alpha/feed?limit=1", owner.cookie);
    assert.ok(first.nextCursor && isolation.nextCursor);
    const traversal = app.database.prepare("SELECT traversal_id FROM feed_page_tokens WHERE token = ?").get(first.nextCursor).traversal_id;
    const expected = app.database.prepare("SELECT post_id FROM feed_traversal_items WHERE traversal_id = ? ORDER BY ordinal").all(traversal).map((row) => row.post_id);
    const beforeReadFault = snapshot(app.database, feedTables);
    failRead = true;
    await fixed(await request(`/api/feed/home?limit=2&cursor=${first.nextCursor}`, { headers: { cookie: owner.cookie } }), 503, "Feed service unavailable");
    assert.deepEqual(snapshot(app.database, feedTables), beforeReadFault);
    const isolatedPage = await feed(request, `/api/communities/alpha/feed?limit=100&cursor=${isolation.nextCursor}`, owner.cookie);
    assert.equal(isolatedPage.nextCursor, null);

    const current = first.nextCursor;
    const page = await feed(request, `/api/feed/home?limit=2&cursor=${current}`, owner.cookie);
    const retry = await feed(request, `/api/feed/home?limit=2&cursor=${current}`, owner.cookie);
    assert.deepEqual(retry, page);
    app.close();
    const reopened = createApp({ databasePath: path, now: () => 1_700_000_000_000 });
    const resumed = await reopened.inject({ path: `/api/feed/home?limit=2&cursor=${current}`, headers: { cookie: owner.cookie } });
    assert.equal(resumed.statusCode, 200);
    assert.deepEqual(await resumed.json(), page);

    const consumed = [...first.posts, ...page.posts];
    let cursor = page.nextCursor;
    while (cursor) {
      const response = await reopened.inject({ path: `/api/feed/home?limit=2&cursor=${cursor}`, headers: { cookie: owner.cookie } });
      assert.equal(response.statusCode, 200);
      const next = await response.json();
      consumed.push(...next.posts);
      cursor = next.nextCursor;
    }
    assert.deepEqual(consumed.map((item) => item.id), expected);
    assert.equal(new Set(consumed.map((item) => item.id)).size, expected.length);
    reopened.close();
  }, {
    beforeFeedSnapshotPersist: () => { if (failSnapshot) { failSnapshot = false; throw new Error("snapshot-fault-marker"); } },
    beforeFeedRead: () => { if (failRead) { failRead = false; throw new Error("read-fault-marker"); } },
  });
});

test("SCN-RC-07-H7 suppresses text, link, and media markers on success and error", async () => {
  let failRead = true;
  await withApp(async ({ app, request }) => {
    const owner = await signup(request, "privacy-owner");
    await community(request, owner, "alpha");
    const text = await post(request, owner, "alpha", { type: "text", title: "private-text-title", text: "private-text-body" });
    const link = await post(request, owner, "alpha", { type: "link", title: "private-link-title", url: "https://private-link-marker.test/path" });
    const mediaMarker = "private-media-byte-marker";
    const mediaBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(mediaMarker)]);
    const media = await post(request, owner, "alpha", {
      type: "media", title: "private-media-title",
      media: { filename: "private-media-filename.png", contentType: "image/png", bytesBase64: mediaBytes.toString("base64") },
    });
    const keeper = await post(request, owner, "alpha", "privacy-keeper");
    const markers = [
      text.id, text.title, text.text, link.id, link.title, link.url, media.id, media.title,
      media.media.filename, media.media.contentType, mediaMarker, owner.account.id, "alpha",
    ];
    const domainBeforeError = snapshot(app.database, domainTables);
    await fixed(await request("/api/feed/home", { headers: { cookie: owner.cookie } }), 503, "Feed service unavailable", markers);
    assert.deepEqual(snapshot(app.database, domainTables), domainBeforeError);

    const pages = [];
    for (const route of ["/api/feed/home?limit=1", "/api/feed/popular?limit=1", "/api/communities/alpha/feed?limit=1"]) {
      const page = await feed(request, route, owner.cookie);
      assert.deepEqual(ids(page), [keeper.id]);
      assert.ok(page.nextCursor);
      pages.push([route.split("?")[0], page.nextCursor]);
    }
    assert.deepEqual(snapshot(app.database, domainTables), domainBeforeError);
    for (const target of [text, link, media]) {
      assert.equal((await request(`/api/posts/${target.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
      await fixed(await request(`/api/posts/${target.id}`), 404, "Not found", markers);
    }
    const domainAfterDelete = snapshot(app.database, domainTables);
    for (const [route, cursor] of pages) {
      const response = await request(`${route}?limit=100&cursor=${cursor}`, { headers: { cookie: owner.cookie } });
      assert.equal(response.statusCode, 200);
      const body = await response.text();
      assert.deepEqual(JSON.parse(body), { posts: [], nextCursor: null });
      for (const marker of markers) assert.equal(body.includes(marker), false, `${route} disclosed ${marker}`);
    }
    await fixed(await request(`/api/feed/home?cursor=${"unknown-private-marker".padEnd(36, "x")}`, { headers: { cookie: owner.cookie } }), 400, "Invalid feed page", markers);
    assert.deepEqual(snapshot(app.database, domainTables), domainAfterDelete);
  }, { beforeFeedRead: () => { if (failRead) { failRead = false; throw new Error("private-read-fault-marker"); } } });
});
