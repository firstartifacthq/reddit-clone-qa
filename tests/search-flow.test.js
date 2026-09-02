import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { SearchService } from "../src/search/search-service.js";

const password = "correct-horse-battery";

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-search-"));
  const app = createApp({ databasePath: join(directory, "search.sqlite"), now: () => 1_700_000_000_000, ...options });
  try { await run({ app, request: (path, requestOptions = {}) => app.inject({ path, ...requestOptions }) }); }
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
async function fixture(request) {
  const owner = await signup(request, "search-owner");
  assert.equal((await send(request, "/api/communities", "POST", { name: "Needle_Hub" }, owner.cookie)).statusCode, 201);
  const postResponse = await send(request, "/api/communities/needle_hub/posts", "POST", { type: "text", title: "Needle title", text: "needle post body" }, owner.cookie);
  assert.equal(postResponse.statusCode, 201);
  const post = await postResponse.json();
  const commentResponse = await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "needle comment body" }, owner.cookie);
  assert.equal(commentResponse.statusCode, 201);
  return { owner, post, comment: await commentResponse.json() };
}

async function fixed(response, status, body) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), { "content-type": "application/json; charset=utf-8" });
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), body);
  return text;
}

function tableCounts(app) {
  return Object.fromEntries(["communities", "posts", "comments"].map((table) => [table, app.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}

test("SCN-RC-08-H1 returns stable typed matches from every readable corpus", async () => {
  await withApp(async ({ request }) => {
    const { post, comment } = await fixture(request);
    const first = await request("/api/search?q=needle");
    const second = await request("/api/search?q=needle");
    await fixed(first, 200, { results: [
      { type: "community", canonicalName: "needle_hub" },
      { type: "post", id: post.id },
      { type: "comment", id: comment.id },
    ] });
    assert.deepEqual(await second.json(), await (await request("/api/search?q=needle")).json());
  });
});

test("SCN-RC-08-H2 narrows supported filters and treats no matches as success", async () => {
  await withApp(async ({ request }) => {
    const { post, comment } = await fixture(request);
    assert.deepEqual(await (await request("/api/search?q=needle&type=community")).json(), { results: [{ type: "community", canonicalName: "needle_hub" }] });
    assert.deepEqual(await (await request("/api/search?q=needle&type=post")).json(), { results: [{ type: "post", id: post.id }] });
    assert.deepEqual(await (await request("/api/search?q=needle&type=comment")).json(), { results: [{ type: "comment", id: comment.id }] });
    await fixed(await request("/api/search?q=needle&type=post&type=comment"), 400, { error: "Invalid search" });
    await fixed(await request("/api/search?q=missing&type=comment"), 200, { results: [] });
  });
});

test("SCN-RC-08-H2 does not evaluate cross-type candidates returned by the retrieval boundary", () => {
  let communityReads = 0;
  let commentReads = 0;
  const service = new SearchService({
    repository: { list: () => [
      { type: "community", canonicalName: "needle_hub", displayName: "Needle Hub" },
      { type: "post", id: "post-1", title: "stale", text: null, url: null },
      { type: "comment", id: "comment-1", body: "needle comment" },
    ] },
    readableCommunities: () => { communityReads += 1; return ["needle_hub"]; },
    readPost: () => ({ id: "post-1", type: "text", title: "needle post", text: "body" }),
    readComment: () => { commentReads += 1; return { id: "comment-1", state: "active", body: "needle comment" }; },
  });

  assert.deepEqual(service.search({ query: "needle", type: "post" }, undefined), {
    kind: "success",
    results: [{ type: "post", id: "post-1" }],
  });
  assert.equal(communityReads, 0);
  assert.equal(commentReads, 0);
});

test("SCN-RC-08-H3 rejects invalid raw query forms before actor or corpus retrieval", async () => {
  let actorCalls = 0;
  let actorUnavailable = false;
  let corpusCalls = 0;
  const repository = { list() { corpusCalls += 1; throw new Error("retrieval marker"); } };
  await withApp(async ({ app, request }) => {
    const owner = await signup(request, "validation-owner");
    const before = tableCounts(app);
    const invalid = [
      "/api/search", "/api/search?q=one&q=two", "/api/search?q=%20%09", `/api/search?q=${"x".repeat(201)}`,
      "/api/search?q=bad%00text", "/api/search?q=%", "/api/search?q=%C3%28", "/api/search?q=ok&type=unknown",
      "/api/search?q=ok&type=post&type=comment", "/api/search?%71=one&%71=two",
    ];
    for (const path of invalid) {
      const response = await request(path, { headers: { cookie: owner.cookie } });
      const text = await fixed(response, 400, { error: "Invalid search" });
      assert.equal(text.includes("retrieval marker"), false);
      assert.deepEqual(tableCounts(app), before);
    }
    assert.equal(actorCalls, 0);
    assert.equal(corpusCalls, 0);

    actorUnavailable = true;
    const unavailable = await request("/api/search?q=valid", { headers: { cookie: owner.cookie } });
    const text = await fixed(unavailable, 503, { error: "Search service unavailable" });
    assert.equal(text.includes("actor marker"), false);
    assert.equal(text.includes("results"), false);
    assert.equal(actorCalls, 1);
    assert.equal(corpusCalls, 0);
    assert.deepEqual(tableCounts(app), before);
  }, {
    searchRepository: repository,
    beforeAuthResolve() {
      actorCalls += 1;
      if (actorUnavailable) throw new Error("actor marker");
    },
  });
});

test("SCN-RC-08-H4 preserves direct-read parity and does not disclose deleted resources", async () => {
  await withApp(async ({ request }) => {
    const { owner, post, comment } = await fixture(request);
    const deletedPost = await send(request, "/api/communities/needle_hub/posts", "POST", { type: "text", title: "needle deleted", text: "deleted-needle-marker" }, owner.cookie);
    const deleted = await deletedPost.json();
    assert.equal((await request(`/api/posts/${deleted.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    assert.equal((await request(`/api/comments/${comment.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    const anonymous = await request("/api/search?q=needle");
    const authenticated = await request("/api/search?q=needle", { headers: { cookie: owner.cookie } });
    assert.deepEqual(await authenticated.json(), await anonymous.json());
    const text = await anonymous.text();
    assert.ok(text.includes(post.id));
    assert.equal(text.includes(comment.id), false);
    assert.equal(text.includes(deleted.id), false);
    assert.equal(text.includes("deleted-needle-marker"), false);
    assert.equal(text.includes("redacted"), false);
  });
});

test("MNT-RC08-002 denies community, post, and comment candidates through direct readers", () => {
  const service = new SearchService({
    repository: { list: () => [
      { type: "community", canonicalName: "needle_hub", displayName: "Needle Hub" },
      { type: "post", id: "post-1", title: "needle post", text: null, url: null },
      { type: "comment", id: "comment-1", body: "needle comment" },
    ] },
    readableCommunities: () => [],
    readPost: () => undefined,
    readComment: () => undefined,
  });

  assert.deepEqual(service.search({ query: "needle" }, undefined), { kind: "success", results: [] });
});

test("MNT-RC08-002 discards admitted results when any direct reader throws", () => {
  const community = { type: /** @type {const} */ ("community"), canonicalName: "needle_hub", displayName: "Needle Hub" };
  const post = { type: /** @type {const} */ ("post"), id: "post-1", title: "needle post", text: null, url: null };
  const comment = { type: /** @type {const} */ ("comment"), id: "comment-1", body: "needle comment" };
  const scenarios = [
    {
      candidates: [post, community],
      throwingReader: "readableCommunities",
      admittedReader: "readPost",
    },
    {
      candidates: [community, post],
      throwingReader: "readPost",
      admittedReader: "readableCommunities",
    },
    {
      candidates: [post, comment],
      throwingReader: "readComment",
      admittedReader: "readPost",
    },
  ];

  for (const scenario of scenarios) {
    let admittedCalls = 0;
    const readers = {
      readableCommunities: () => ["needle_hub"],
      readPost: () => ({}),
      readComment: () => ({}),
    };
    readers[scenario.admittedReader] = () => {
      admittedCalls += 1;
      return scenario.admittedReader === "readableCommunities" ? ["needle_hub"] : {};
    };
    readers[scenario.throwingReader] = () => { throw new Error(`${scenario.throwingReader} marker`); };
    const service = new SearchService({ repository: { list: () => scenario.candidates }, ...readers });

    assert.deepEqual(service.search({ query: "needle" }, undefined), { kind: "unavailable" });
    assert.equal(admittedCalls, 1, `${scenario.throwingReader} failed before one candidate was admitted`);
  }
});

test("SCN-RC-08-H5 reflects successful lifecycle changes and preserves rejected mutations", async () => {
  await withApp(async ({ request }) => {
    const { owner, post, comment } = await fixture(request);
    assert.equal((await send(request, `/api/posts/${post.id}`, "PATCH", { title: "fresh title", text: "fresh post body" }, owner.cookie)).statusCode, 200);
    assert.equal((await send(request, `/api/comments/${comment.id}`, "PATCH", { body: "fresh comment body" }, owner.cookie)).statusCode, 200);
    await fixed(await request("/api/search?q=needle"), 200, { results: [{ type: "community", canonicalName: "needle_hub" }] });
    const fresh = await (await request("/api/search?q=fresh")).json();
    assert.deepEqual(fresh.results.map(({ type, id }) => ({ type, id })), [{ type: "post", id: post.id }, { type: "comment", id: comment.id }]);
    const baseline = await (await request("/api/search?q=fresh")).json();
    const stranger = await signup(request, "search-stranger");
    assert.equal((await send(request, `/api/posts/${post.id}`, "PATCH", { title: "rejected" }, stranger.cookie)).statusCode, 403);
    assert.deepEqual(await (await request("/api/search?q=fresh")).json(), baseline);
    assert.equal((await request(`/api/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    assert.equal((await request(`/api/comments/${comment.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 404);
    assert.deepEqual(await (await request("/api/search?q=fresh")).json(), { results: [] });
  });
});

test("SCN-RC-08-H6 returns one stable unavailable response then recovers", async () => {
  let unavailable = true;
  let calls = 0;
  const repository = {
    list(type) {
      calls += 1;
      if (unavailable) throw new Error("database marker");
      return type === "community" ? [{ type: "community", canonicalName: "recover", displayName: "recover" }] : [];
    },
  };
  await withApp(async ({ app, request }) => {
    const owner = await signup(request, "recover-owner");
    assert.equal((await send(request, "/api/communities", "POST", { name: "recover" }, owner.cookie)).statusCode, 201);
    const before = tableCounts(app);
    const failed = await request("/api/search?q=recover");
    const text = await fixed(failed, 503, { error: "Search service unavailable" });
    assert.equal(text.includes("database marker"), false);
    assert.equal(text.includes("results"), false);
    assert.equal(calls, 1);
    assert.deepEqual(tableCounts(app), before);
    unavailable = false;
    await fixed(await request("/api/search?q=recover&type=community"), 200, { results: [{ type: "community", canonicalName: "recover" }] });
  }, { searchRepository: repository });
});

test("SCN-RC-08-H7 successful results have only supported minimal discriminators", async () => {
  await withApp(async ({ request }) => {
    await fixture(request);
    const body = await (await request("/api/search?q=needle")).json();
    for (const result of body.results) {
      if (result.type === "community") assert.deepEqual(Object.keys(result).sort(), ["canonicalName", "type"]);
      else assert.deepEqual(Object.keys(result).sort(), ["id", "type"]);
      assert.ok(["community", "post", "comment"].includes(result.type));
    }
    assert.equal(new Set(body.results.map((result) => `${result.type}:${result.id ?? result.canonicalName}`)).size, body.results.length);
    assert.equal(JSON.stringify(body).includes("body"), false);
    assert.equal(JSON.stringify(body).includes("excerpt"), false);
    assert.equal(JSON.stringify(body).includes("count"), false);
  });
});

test("SCN-RC-08-H7 matches only current direct-read text and excludes tombstones", () => {
  const candidates = [
    { type: /** @type {const} */ ("post"), id: "post-removed", title: "needle removed", text: null, url: null },
    { type: /** @type {const} */ ("post"), id: "post-current", title: "old title", text: null, url: null },
    { type: /** @type {const} */ ("comment"), id: "comment-deleted", body: "needle removed" },
    { type: /** @type {const} */ ("comment"), id: "comment-current", body: "old body" },
  ];
  const posts = new Map([
    ["post-removed", { id: "post-removed", type: "text", title: "current title", text: "current body" }],
    ["post-current", { id: "post-current", type: "text", title: "needle current", text: "current body" }],
  ]);
  const comments = new Map([
    ["comment-deleted", { id: "comment-deleted", state: "deleted" }],
    ["comment-current", { id: "comment-current", state: "active", body: "needle current" }],
  ]);
  const service = new SearchService({
    repository: { list: () => candidates },
    readableCommunities: () => [],
    readPost: (id) => posts.get(id),
    readComment: (id) => comments.get(id),
  });

  assert.deepEqual(service.search({ query: "needle" }, undefined), {
    kind: "success",
    results: [
      { type: "post", id: "post-current" },
      { type: "comment", id: "comment-current" },
    ],
  });
});

test("SCN-RC-08-H1 applies Unicode case-insensitive matching without pattern semantics", () => {
  const service = new SearchService({
    repository: { list: () => [
      { type: "post", id: "post-1", title: "stale", text: null, url: null },
      { type: "post", id: "post-2", title: "stale", text: null, url: null },
    ] },
    readableCommunities: () => [],
    readPost: (id) => id === "post-1"
      ? { id, type: "text", title: "Greek final \u03c2", text: "body" }
      : { id, type: "text", title: "literal [\u03c3]", text: "body" },
    readComment: () => undefined,
  });

  assert.deepEqual(service.search({ query: "\u03a3" }, undefined), {
    kind: "success",
    results: [{ type: "post", id: "post-1" }, { type: "post", id: "post-2" }],
  });
  assert.deepEqual(service.search({ query: "[\u03a3]" }, undefined), {
    kind: "success",
    results: [{ type: "post", id: "post-2" }],
  });
});
