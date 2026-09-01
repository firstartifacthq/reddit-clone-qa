import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";

async function withApp(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-comment-"));
  const path = join(directory, "comments.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000 });
  try { await run({ app, path, request: (route, options = {}) => app.inject({ path: route, ...options }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}
function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function send(request, path, method, body, session) {
  return request(path, { method, headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) }, payload: typeof body === "string" ? body : JSON.stringify(body) });
}
async function signup(request, username) {
  const response = await send(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: cookie(response) };
}
async function setup(request) {
  const owner = await signup(request, "comment-owner");
  assert.equal((await send(request, "/api/communities", "POST", { name: "comments" }, owner.cookie)).statusCode, 201);
  const postResponse = await send(request, "/api/communities/comments/posts", "POST", { type: "text", title: "Conversation", text: "post" }, owner.cookie);
  assert.equal(postResponse.statusCode, 201);
  return { owner, post: await postResponse.json() };
}
async function fixed(response, status, error, markers = []) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), { "content-type": "application/json; charset=utf-8" });
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error });
  for (const marker of markers) assert.equal(text.includes(marker), false);
}
function count(app, table) { return app.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; }

test("SCN-RC-05-H1 creates top-level comments and replies in conversation order", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post } = await setup(request);
    const rootResponse = await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "root" }, owner.cookie);
    const root = await rootResponse.json();
    const replyResponse = await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "reply", parentId: root.id }, owner.cookie);
    const reply = await replyResponse.json();
    assert.deepEqual([rootResponse.statusCode, replyResponse.statusCode], [201, 201]);
    assert.deepEqual(root, { id: root.id, postId: post.id, parentId: null, author: "comment-owner", body: "root", depth: 0, state: "active" });
    assert.deepEqual(reply, { id: reply.id, postId: post.id, parentId: root.id, author: "comment-owner", body: "reply", depth: 1, state: "active" });
    assert.equal(count(app, "comments"), 2);
    assert.deepEqual((await (await request(`/api/posts/${post.id}/comments`)).json()).comments.map((comment) => comment.id), [root.id, reply.id]);
  });
});

test("SCN-RC-05-H2 paginates depth-first order with inclusive limits", async () => {
  await withApp(async ({ request }) => {
    const { owner, post } = await setup(request);
    const create = async (body) => (await send(request, `/api/posts/${post.id}/comments`, "POST", body, owner.cookie)).json();
    const root = await create({ body: "root" }); const child = await create({ body: "child", parentId: root.id });
    const grandchild = await create({ body: "grandchild", parentId: child.id }); const sibling = await create({ body: "sibling" });
    const expected = [root.id, child.id, grandchild.id, sibling.id];
    const all = await (await request(`/api/posts/${post.id}/comments?limit=100`)).json();
    assert.deepEqual(all.comments.map((comment) => comment.id), expected); assert.equal(all.nextCursor, null);
    const seen = []; let cursor; do { const page = await (await request(`/api/posts/${post.id}/comments?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json(); seen.push(...page.comments.map((comment) => comment.id)); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(seen, expected);
    await fixed(await request(`/api/posts/${post.id}/comments?limit=0`), 422, "Invalid comment page");
    await fixed(await request(`/api/posts/${post.id}/comments?limit=101`), 422, "Invalid comment page");
  });
});

test("SCN-RC-05-H3 rejects invalid comment creation without persistence", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post } = await setup(request); const path = `/api/posts/${post.id}/comments`;
    for (const body of [{ body: "" }, { body: " \n\t" }, { body: "x", extra: "marker" }, {}, { body: "x".repeat(10_001) }, "{invalid-marker"]) {
      await fixed(await send(request, path, "POST", body, owner.cookie), 422, "Invalid comment", ["marker", "invalid-marker"]);
      assert.equal(count(app, "comments"), 0);
    }
    const astralBody = "\u{1F600}".repeat(10_000);
    const direct = await send(request, path, "POST", { body: astralBody }, owner.cookie);
    const escaped = await send(request, path, "POST", `{"body":"${"\\ud83d\\ude00".repeat(10_000)}"}`, owner.cookie);
    assert.deepEqual([direct.statusCode, escaped.statusCode], [201, 201]);
    assert.deepEqual([...(await direct.json()).body], [...(await escaped.json()).body]);
  });
});

test("SCN-RC-05-H4 denies non-author mutations before parsing", async () => {
  await withApp(async ({ request }) => {
    const { owner, post } = await setup(request); const stranger = await signup(request, "comment-other");
    const comment = await (await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "stored-marker" }, owner.cookie)).json(); const path = `/api/comments/${comment.id}`;
    await fixed(await send(request, path, "PATCH", "{patch-marker", stranger.cookie), 403, "Forbidden", ["patch-marker", "stored-marker"]);
    await fixed(await request(path, { method: "DELETE", headers: { cookie: stranger.cookie } }), 403, "Forbidden", ["stored-marker"]);
    assert.deepEqual(await (await request(path)).json(), comment);
  });
});

test("SCN-RC-05-H5 tombstones authors' comments without detaching descendants", async () => {
  await withApp(async ({ request }) => {
    const { owner, post } = await setup(request); const create = async (body) => (await send(request, `/api/posts/${post.id}/comments`, "POST", body, owner.cookie)).json();
    const root = await create({ body: "remove" }); const child = await create({ body: "child", parentId: root.id }); const grandchild = await create({ body: "grandchild", parentId: child.id });
    const deleted = await request(`/api/comments/${root.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
    assert.equal(deleted.statusCode, 204); assert.deepEqual(Object.fromEntries(deleted.headers), {}); assert.equal(await deleted.text(), "");
    const tombstone = await (await request(`/api/comments/${root.id}`)).json();
    assert.deepEqual(tombstone, { id: root.id, postId: post.id, parentId: null, depth: 0, state: "deleted" });
    const conversation = await (await request(`/api/posts/${post.id}/comments`)).json();
    assert.deepEqual(conversation.comments.map((comment) => comment.id), [root.id, child.id, grandchild.id]);
    assert.deepEqual(conversation.comments.slice(1).map(({ parentId, depth, state }) => ({ parentId, depth, state })), [{ parentId: root.id, depth: 1, state: "active" }, { parentId: child.id, depth: 2, state: "active" }]);
  });
});

test("SCN-RC-05-H6 cursor retries resume immutable snapshots", async () => {
  await withApp(async ({ path, app, request }) => {
    const { owner, post } = await setup(request); const create = async (body) => (await send(request, `/api/posts/${post.id}/comments`, "POST", body, owner.cookie)).json();
    const first = await create({ body: "first" }); const second = await create({ body: "second" }); const third = await create({ body: "third" });
    const firstPage = await (await request(`/api/posts/${post.id}/comments?limit=1`)).json(); const cursor = firstPage.nextCursor;
    const retry = await (await request(`/api/posts/${post.id}/comments?limit=1&cursor=${cursor}`)).json();
    const retryAgain = await (await request(`/api/posts/${post.id}/comments?limit=1&cursor=${cursor}`)).json(); assert.deepEqual(retryAgain, retry);
    await create({ body: "later" });
    const secondPage = await (await request(`/api/posts/${post.id}/comments?limit=100&cursor=${cursor}`)).json();
    assert.deepEqual([firstPage.comments[0].id, ...secondPage.comments.map((comment) => comment.id)], [first.id, second.id, third.id]); assert.equal(secondPage.nextCursor, null);
    app.close(); const reopened = createApp({ databasePath: path });
    const resumed = await (await reopened.inject({ path: `/api/posts/${post.id}/comments?limit=1&cursor=${cursor}` })).json(); assert.deepEqual(resumed, retry); reopened.close();
  });
});

test("SCN-RC-05-H7 never discloses deleted bodies or authors", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post } = await setup(request); const marker = "deleted-body-marker";
    await send(request, `/api/posts/${post.id}/comments`, "POST", { body: "before" }, owner.cookie);
    const comment = await (await send(request, `/api/posts/${post.id}/comments`, "POST", { body: marker }, owner.cookie)).json();
    const cursor = (await (await request(`/api/posts/${post.id}/comments?limit=1`)).json()).nextCursor; assert.ok(cursor);
    assert.equal((await request(`/api/comments/${comment.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    for (const response of [await request(`/api/comments/${comment.id}`), await request(`/api/posts/${post.id}/comments`), await request(`/api/posts/${post.id}/comments?limit=1&cursor=${cursor}`)]) {
      const text = await response.text(); assert.equal(text.includes(marker), false);
      const payload = JSON.parse(text); for (const item of payload.comments ?? [payload]) if (item.id === comment.id) assert.equal(Object.hasOwn(item, "author"), false);
    }
    assert.deepEqual({ ...app.database.prepare("SELECT author_user_id, body FROM comments WHERE id = ?").get(comment.id) }, { author_user_id: null, body: null });
  });
});
