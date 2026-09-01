import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-post-"));
  const path = join(directory, "posts.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}

function session(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0];
}

async function requestJson(request, path, method, body, cookie, headers = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...headers, ...(cookie ? { cookie } : {}) },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function signup(request, username) {
  const response = await requestJson(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: session(response) };
}

async function member(request, username = "post-owner") {
  const user = await signup(request, username);
  assert.equal((await requestJson(request, "/api/communities", "POST", { name: "posting" }, user.cookie)).statusCode, 201);
  return user;
}

function pngBytes(marker = "") {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(marker)]);
}

test("SCN-RC-04-H1 creates each declared post type and reopens them", async () => {
  await withApp(async ({ app, path, request }) => {
    const owner = await member(request);
    const create = (body) => requestJson(request, "/api/communities/posting/posts", "POST", body, owner.cookie);
    const text = await create({ type: "text", title: "  Text title  ", text: "kept exactly\n" });
    const link = await create({ type: "link", title: "Link", url: "https://example.test/path?q=1" });
    const bytes = pngBytes("persisted");
    const media = await create({ type: "media", title: "Image", media: { filename: " image.png ", contentType: "image/png", bytesBase64: bytes.toString("base64") } });
    assert.deepEqual([text.statusCode, link.statusCode, media.statusCode], [201, 201, 201]);
    const posts = await Promise.all([text, link, media].map((response) => response.json()));
    assert.equal(new Set(posts.map((post) => post.id)).size, 3);
    assert.deepEqual(posts[0], { id: posts[0].id, community: "posting", author: "post-owner", type: "text", title: "Text title", text: "kept exactly\n" });
    assert.deepEqual(posts[1], { id: posts[1].id, community: "posting", author: "post-owner", type: "link", title: "Link", url: "https://example.test/path?q=1" });
    assert.deepEqual(posts[2], { id: posts[2].id, community: "posting", author: "post-owner", type: "media", title: "Image", media: { filename: "image.png", contentType: "image/png", byteLength: bytes.length } });
    app.close();
    const reopened = createApp({ databasePath: path });
    for (const post of posts) {
      const response = await reopened.inject({ path: `/api/posts/${post.id}` });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(await response.json(), post);
    }
    const readMedia = await reopened.inject({ path: `/api/posts/${posts[2].id}/media` });
    assert.equal(readMedia.statusCode, 200);
    assert.equal(readMedia.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await readMedia.bytes()), bytes);
    reopened.close();
  });
});

test("SCN-RC-04-H2 validates inclusive boundaries without persisting rejected posts", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    const create = (body) => requestJson(request, "/api/communities/posting/posts", "POST", body, owner.cookie);
    assert.equal((await create({ type: "text", title: "t".repeat(300), text: "x".repeat(40_000) })).statusCode, 201);
    assert.equal((await create({ type: "text", title: "t".repeat(301), text: "x" })).statusCode, 422);
    assert.equal((await create({ type: "link", title: "l", url: `https://x.test/${"x".repeat(2_033)}` })).statusCode, 201);
    assert.equal((await create({ type: "link", title: "l", url: `https://x.test/${"x".repeat(2_034)}` })).statusCode, 422);
    const maxImage = Buffer.alloc(5_242_880);
    pngBytes().copy(maxImage);
    assert.equal((await create({ type: "media", title: "m", media: { filename: "f".repeat(255), contentType: "image/png", bytesBase64: maxImage.toString("base64") } })).statusCode, 201);
    assert.equal((await create({ type: "media", title: "m", media: { filename: "f".repeat(256), contentType: "image/png", bytesBase64: pngBytes().toString("base64") } })).statusCode, 422);
    const tooLargeImage = Buffer.alloc(5_242_881);
    pngBytes().copy(tooLargeImage);
    assert.equal((await create({ type: "media", title: "m", media: { filename: "large.png", contentType: "image/png", bytesBase64: tooLargeImage.toString("base64") } })).statusCode, 413);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 3);
  });
});

test("SCN-RC-04-H3 rejects unsafe links and malformed media without disclosure", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    const create = (body) => requestJson(request, "/api/communities/posting/posts", "POST", body, owner.cookie);
    for (const body of [
      { type: "link", title: "secret title", url: "ftp://secret.test" },
      { type: "link", title: "secret title", url: "https://user:pass@secret.test" },
      { type: "media", title: "secret title", media: { filename: "secret.png", contentType: "image/png", bytesBase64: "not-base64" } },
      { type: "media", title: "secret title", media: { filename: "secret.png", contentType: "image/png", bytesBase64: Buffer.from("not png").toString("base64") } },
    ]) {
      const response = await create(body);
      assert.equal(response.statusCode, 422);
      assert.equal((await response.text()).includes("secret"), false);
    }
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 0);
  });
});

test("SCN-RC-04-H4 authorizes before validating request bodies", async () => {
  await withApp(async ({ request }) => {
    const owner = await member(request);
    const stranger = await signup(request, "stranger");
    const path = "/api/communities/posting/posts";
    assert.equal((await requestJson(request, path, "POST", "{bad")).statusCode, 401);
    assert.equal((await requestJson(request, path, "POST", "{bad", stranger.cookie)).statusCode, 403);
    assert.equal((await requestJson(request, path, "POST", { type: "text", title: "ok", text: "ok" }, owner.cookie, { "idempotency-key": "eligible" })).statusCode, 201);
  });
});

test("SCN-RC-04-H5 limits edits and deletion to the author and makes deleted posts unreadable", async () => {
  await withApp(async ({ request }) => {
    const owner = await member(request);
    const other = await signup(request, "post-other");
    const create = await requestJson(request, "/api/communities/posting/posts", "POST", { type: "text", title: "Old", text: "old text" }, owner.cookie);
    const post = await create.json();
    assert.equal((await requestJson(request, `/api/posts/${post.id}`, "PATCH", { title: "New", text: "new text" }, other.cookie)).statusCode, 403);
    const edited = await requestJson(request, `/api/posts/${post.id}`, "PATCH", { title: "New", text: "new text" }, owner.cookie);
    assert.equal(edited.statusCode, 200);
    assert.deepEqual(await edited.json(), { ...post, title: "New", text: "new text" });
    assert.equal((await requestJson(request, `/api/posts/${post.id}`, "PATCH", { url: "https://bad.test" }, owner.cookie)).statusCode, 422);
    const deleted = await request(`/api/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
    assert.equal(deleted.statusCode, 204);
    assert.equal(await deleted.text(), "");
    for (const path of [`/api/posts/${post.id}`, `/api/posts/${post.id}/media`, "/api/posts/missing", "/api/posts/missing/media"]) {
      const response = await request(path);
      assert.equal(response.statusCode, 404);
      assert.deepEqual(await response.json(), { error: "Not found" });
    }
  });
});

test("SCN-RC-04-H6 rolls back media faults and idempotent retries converge", async () => {
  let failed = false;
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    const bytes = pngBytes("retry");
    const body = { type: "media", title: "Retry", media: { filename: "retry.png", contentType: "image/png", bytesBase64: bytes.toString("base64") } };
    const create = () => requestJson(request, "/api/communities/posting/posts", "POST", body, owner.cookie, { "idempotency-key": "retry-key" });
    assert.equal((await create()).statusCode, 503);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 0);
    const first = await create();
    const second = await create();
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 1);
  }, { beforeMediaPersist: () => { if (!failed) { failed = true; throw new Error("injected secret"); } } });
});

test("SCN-RC-04-H7 uses fixed non-disclosing errors for conflicts and unreadable posts", async () => {
  await withApp(async ({ request }) => {
    const owner = await member(request);
    const body = { type: "text", title: "private-title", text: "private-content" };
    const headers = { "idempotency-key": "conflict-key" };
    assert.equal((await requestJson(request, "/api/communities/posting/posts", "POST", body, owner.cookie, headers)).statusCode, 201);
    const conflict = await requestJson(request, "/api/communities/posting/posts", "POST", { ...body, text: "different" }, owner.cookie, headers);
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(await conflict.json(), { error: "Post conflict" });
  });
});
