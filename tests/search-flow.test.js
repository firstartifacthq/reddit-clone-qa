import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-search-"));
  const path = join(directory, "search.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}

function session(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function send(request, path, method, body, cookie) {
  return request(path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
}
async function signup(request, username) {
  const response = await send(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: session(response) };
}
async function setup(request) {
  const owner = await signup(request, "search-owner");
  assert.equal((await send(request, "/api/communities", "POST", { name: "needle_hub" }, owner.cookie)).statusCode, 201);
  const postResponse = await send(request, "/api/communities/needle_hub/posts", "POST", { type: "text", title: "Needle title", text: "needle body" }, owner.cookie);
  assert.equal(postResponse.statusCode, 201);
  const post = await postResponse.json();
  const commentResponse = await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "Needle comment" }, owner.cookie);
  assert.equal(commentResponse.statusCode, 201);
  return { owner, post, comment: await commentResponse.json() };
}
function count(app, table) { return app.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; }
function changes(app) { return app.database.prepare("SELECT total_changes() AS count").get().count; }
async function fixed(response, status, body, headers = { "content-type": "application/json; charset=utf-8" }) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), headers);
  assert.deepEqual(await response.json(), body);
}

// Exact result shapes prevent field leakage across the mixed result contract.
function assertTypedResults(results) {
  for (const result of results) {
    if (result.type === "community") assert.deepEqual(Object.keys(result).sort(), ["canonicalName", "displayName", "type"]);
    else if (result.type === "post") assert.deepEqual(Object.keys(result).sort(), ["content", "id", "title", "type"]);
    else if (result.type === "comment") assert.deepEqual(Object.keys(result).sort(), ["body", "id", "type"]);
    else assert.fail(`unexpected result type ${result.type}`);
  }
}

test("SCN-RC-08-H1 returns deterministic duplicate-free typed mixed literal matches", async () => {
  await withApp(async ({ request }) => {
    const { post, comment } = await setup(request);
    const first = await request("/api/search?q=NEEDLE");
    const second = await request("/api/search?q=NEEDLE");
    await fixed(first, 200, await second.json());
    const body = await first.json();
    assertTypedResults(body.results);
    assert.deepEqual(body.results, [
      { type: "community", canonicalName: "needle_hub", displayName: "needle_hub" },
      { type: "post", id: post.id, title: "Needle title", content: "needle body" },
      { type: "comment", id: comment.id, body: "Needle comment" },
    ]);
    assert.equal(new Set(body.results.map((result) => `${result.type}:${result.id ?? result.canonicalName}`)).size, body.results.length);
    assert.deepEqual(await (await request("/api/search?q=%25")).json(), { results: [] });
    assert.deepEqual(await (await request("/api/search?q=_")).json(), { results: [body.results[0]] });
  });
});

test("SCN-RC-08-H2 restricts supported filters and accepts no matches", async () => {
  await withApp(async ({ request }) => {
    await setup(request);
    for (const type of ["community", "post", "comment"]) {
      const body = await (await request(`/api/search?q=needle&type=${type}`)).json();
      assert.ok(body.results.length > 0);
      assert.equal(body.results.every((result) => result.type === type), true);
    }
    await fixed(await request("/api/search?q=no-such-match&type=post"), 200, { results: [] });
  });
});

test("SCN-RC-08-H3 rejects invalid search input before retrieval or mutation", async () => {
  let reads = 0;
  await withApp(async ({ app, request }) => {
    const beforeChanges = changes(app);
    const invalid = [
      "/api/search", "/api/search?q=one&q=two", "/api/search?q=", "/api/search?q=%20%09", "/api/search?q=bad%00control",
      "/api/search?q=%", "/api/search?q=%FF", "/api/search?q=needle&other=value", "/api/search?q=needle&type=post&type=comment",
      "/api/search?q=needle&type=", "/api/search?q=needle&type=unknown",
    ];
    for (const route of invalid) {
      const response = await request(route);
      await fixed(response, 400, { error: "Invalid search" });
      const text = await response.text();
      assert.equal(text.includes("results"), false);
      assert.equal(text.includes("marker"), false);
    }
    assert.equal(reads, 0);
    assert.equal(changes(app), beforeChanges);
  }, { beforeSearchRead: () => { reads += 1; } });
});

test("SCN-RC-08-H4 preserves current canonical public read authority", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post, comment } = await setup(request);
    const member = await signup(request, "search-member");
    const outsider = await signup(request, "search-outsider");
    assert.equal((await request("/api/communities/needle_hub/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
    for (const headers of [{}, { cookie: member.cookie }, { cookie: outsider.cookie }]) {
      const body = await (await request("/api/search?q=needle", { headers })).json();
      assert.deepEqual(body.results.map((result) => result.type), ["community", "post", "comment"]);
      assert.equal((await request(`/api/posts/${post.id}`, { headers })).statusCode, 200);
    }
    assert.equal((await request(`/api/comments/${comment.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    const tombstoned = await (await request("/api/search?q=needle%20comment")).json();
    const absent = await (await request("/api/search?q=unknown-marker")).json();
    assert.deepEqual(tombstoned, absent);
    assert.equal(JSON.stringify(tombstoned).includes(comment.id), false);
  });
});

test("SCN-RC-08-H5 reflects committed post and comment edits without stale duplicates", async () => {
  await withApp(async ({ request }) => {
    const { owner, post, comment } = await setup(request);
    const postPatch = await send(request, `/api/posts/${post.id}`, "PATCH", { title: "Current post title", text: "Current post content" }, owner.cookie);
    const currentPost = await postPatch.json();
    assert.equal(postPatch.statusCode, 200);
    const commentPatch = await send(request, `/api/comments/${comment.id}`, "PATCH", { body: "Current comment body" }, owner.cookie);
    const currentComment = await commentPatch.json();
    assert.equal(commentPatch.statusCode, 200);
    assert.deepEqual(await (await request("/api/search?q=needle")).json(), { results: [{ type: "community", canonicalName: "needle_hub", displayName: "needle_hub" }] });
    assert.deepEqual(await (await request("/api/search?q=current%20post&type=post")).json(), { results: [{ type: "post", id: post.id, title: currentPost.title, content: currentPost.text }] });
    assert.deepEqual(await (await request("/api/search?q=current%20comment&type=comment")).json(), { results: [{ type: "comment", id: comment.id, body: currentComment.body }] });
  });
});

test("SCN-RC-08-H6 maps an injected retrieval outage to retryable recovery", async () => {
  let fail = true;
  await withApp(async ({ app, request }) => {
    const { post } = await setup(request);
    const beforeChanges = changes(app);
    const failed = await request("/api/search?q=needle");
    await fixed(failed, 503, { error: "Search unavailable" }, { "content-type": "application/json; charset=utf-8", "retry-after": "1" });
    const text = await failed.text();
    assert.equal(text.includes("search-fault-marker"), false);
    assert.equal(text.includes("results"), false);
    assert.equal(changes(app), beforeChanges);
    const recovered = await (await request("/api/search?q=needle&type=post")).json();
    assert.deepEqual(recovered, { results: [{ type: "post", id: post.id, title: "Needle title", content: "needle body" }] });
  }, { beforeSearchRead: () => { if (fail) { fail = false; throw new Error("search-fault-marker"); } } });
});

test("moderation removal and restoration gate post and comment search", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post, comment } = await setup(request);
    assert.deepEqual((await (await request("/api/search?q=needle")).json()).results.map((entry) => entry.type), ["community", "post", "comment"]);
    assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    const removed = await (await request("/api/search?q=needle")).json();
    assert.deepEqual(removed.results.map((entry) => entry.type), ["community"]);
    assert.equal(JSON.stringify(removed).includes(post.id), false); assert.equal(JSON.stringify(removed).includes(comment.id), false);
    const beforeChanges = changes(app); assert.equal((await request("/api/search?q=needle&type=comment")).statusCode, 200); assert.equal(changes(app), beforeChanges);
    assert.equal((await request(`/api/mod/posts/${post.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } })).statusCode, 200);
    const restored = await (await request("/api/search?q=needle")).json();
    assert.deepEqual(restored.results.map((entry) => entry.type), ["community", "post", "comment"]);
    assert.equal(restored.results.some((entry) => entry.id === post.id), true); assert.equal(restored.results.some((entry) => entry.id === comment.id), true);
  });
});

test("SCN-RC-08-H7 omits deleted content and search creates no durable user state", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post, comment } = await setup(request);
    const before = { history: count(app, "post_history"), saved: count(app, "saved_posts"), votes: count(app, "post_votes"), memberships: count(app, "community_memberships") };
    assert.equal((await request("/api/search?q=needle", { headers: { cookie: owner.cookie } })).statusCode, 200);
    assert.equal((await request(`/api/comments/${comment.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    assert.equal((await request(`/api/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    const afterDeletes = changes(app);
    for (const route of ["/api/search?q=needle", "/api/search?q=needle", "/api/search?q=needle&type=comment"]) {
      const body = await (await request(route, { headers: { cookie: owner.cookie } })).json();
      assert.equal(JSON.stringify(body).includes(post.id), false);
      assert.equal(JSON.stringify(body).includes(comment.id), false);
      assert.equal(JSON.stringify(body).includes("Needle title"), false);
      assert.equal(JSON.stringify(body).includes("Needle comment"), false);
    }
    assert.deepEqual({ history: count(app, "post_history"), saved: count(app, "saved_posts"), votes: count(app, "post_votes"), memberships: count(app, "community_memberships") }, { history: before.history, saved: before.saved, votes: before.votes, memberships: before.memberships });
    assert.equal(changes(app), afterDeletes, "searches do not add durable changes after explicit deletions");
  });
});
