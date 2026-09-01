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

function artifactCounts(app) {
  return {
    posts: app.database.prepare("SELECT COUNT(*) AS count FROM posts").get().count,
    media: app.database.prepare("SELECT COUNT(*) AS count FROM posts WHERE media_bytes IS NOT NULL").get().count,
    idempotency: app.database.prepare("SELECT COUNT(*) AS count FROM post_idempotency").get().count,
  };
}

function malformedUtf8Json(prefix, suffix) {
  return Buffer.concat([Buffer.from(prefix), Buffer.from([0xc3, 0x28]), Buffer.from(suffix)]);
}

async function assertFixedError(response, status, expected, markers = []) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), { "content-type": "application/json; charset=utf-8" });
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), expected);
  for (const marker of markers) assert.equal(body.includes(marker), false, `error disclosed marker: ${marker}`);
  return { status: response.statusCode, headers: Object.fromEntries(response.headers), body };
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
    let key = 0;
    const create = (body) => requestJson(request, "/api/communities/posting/posts", "POST", body, owner.cookie, { "idempotency-key": `boundary-${key++}` });
    const maxText = await create({ type: "text", title: "\u{1f642}".repeat(300), text: "\u{1f642}".repeat(40_000) });
    assert.equal(maxText.statusCode, 201);
    const maxUrl = await create({ type: "link", title: "l", url: `https://x.test/${"x".repeat(2_033)}` });
    assert.equal(maxUrl.statusCode, 201);
    const maxImage = Buffer.alloc(5_242_880);
    pngBytes().copy(maxImage);
    const maxMedia = await create({ type: "media", title: "m", media: { filename: "f".repeat(255), contentType: "image/png", bytesBase64: maxImage.toString("base64") } });
    assert.equal(maxMedia.statusCode, 201);
    const acceptedCounts = { posts: 3, media: 1, idempotency: 3 };
    assert.deepEqual(artifactCounts(app), acceptedCounts);

    const rejected = [
      [{ type: "text", title: "t".repeat(301), text: "x" }, 422],
      [{ type: "text", title: "t", text: "x".repeat(40_001) }, 422],
      [{ type: "link", title: "l", url: `https://x.test/${"x".repeat(2_034)}` }, 422],
      [{ type: "media", title: "m", media: { filename: "f".repeat(256), contentType: "image/png", bytesBase64: pngBytes().toString("base64") } }, 422],
    ];
    for (const [body, status] of rejected) {
      assert.equal((await create(body)).statusCode, status);
      assert.deepEqual(artifactCounts(app), acceptedCounts);
    }
    const tooLargeImage = Buffer.alloc(5_242_881);
    pngBytes().copy(tooLargeImage);
    assert.equal((await create({ type: "media", title: "m", media: { filename: "large.png", contentType: "image/png", bytesBase64: tooLargeImage.toString("base64") } })).statusCode, 413);
    assert.deepEqual(artifactCounts(app), acceptedCounts);
  });
});

test("SCN-RC-04-H3 rejects unsafe links and malformed media without disclosure", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    let key = 0;
    const invalidCases = [
      { type: "link", title: "non-http-title-marker", url: "ftp://non-http-url-marker.test" },
      { type: "link", title: "credentials-title-marker", url: "https://user-marker:password-marker@credentials-url-marker.test" },
      { type: "link", title: "control-title-marker", url: "https://control-url-marker.test/path\u0001value" },
      { type: "link", title: "relative-title-marker", url: "/relative-url-marker" },
      { type: "media", title: "empty-title-marker", media: { filename: "empty-filename-marker.png", contentType: "image/png", bytesBase64: "" } },
      { type: "media", title: "unsupported-title-marker", media: { filename: "unsupported-filename-marker.bmp", contentType: "image/bmp", bytesBase64: pngBytes("unsupported-decoded-marker").toString("base64") } },
      { type: "media", title: "malformed-title-marker", media: { filename: "malformed-filename-marker.png", contentType: "image/png", bytesBase64: "malformed-base64-marker" } },
      { type: "media", title: "signature-title-marker", media: { filename: "signature-filename-marker.png", contentType: "image/png", bytesBase64: Buffer.from("signature-decoded-marker").toString("base64") } },
    ];
    for (const body of invalidCases) {
      const response = await requestJson(request, "/api/communities/posting/posts", "POST", body, owner.cookie, { "idempotency-key": `rejected-${key++}` });
      const markers = [body.title, body.url, body.media?.filename, body.media?.contentType, body.media?.bytesBase64,
        "unsupported-decoded-marker", "signature-decoded-marker"].filter(Boolean);
      await assertFixedError(response, 422, { error: "Invalid post" }, markers);
      assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });
    }
    for (const path of ["/api/posts/rejected-marker", "/api/posts/rejected-marker/media"]) {
      await assertFixedError(await request(path), 404, { error: "Not found" }, ["rejected-marker"]);
    }
  });
});

test("SCN-RC-04-H4 authorizes before validating request bodies", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    const stranger = await signup(request, "stranger");
    const path = "/api/communities/posting/posts";
    const valid = { type: "text", title: "authority-title-marker", text: "authority-text-marker" };
    const deniedCases = [
      [() => requestJson(request, path, "POST", "{anonymous-malformed-marker"), 401, { error: "Authentication required" }, ["anonymous-malformed-marker"]],
      [() => requestJson(request, path, "POST", valid, undefined, { "idempotency-key": "authority-key" }), 401, { error: "Authentication required" }, [valid.title, valid.text]],
      [() => requestJson(request, path, "POST", valid, stranger.cookie, { "idempotency-key": "authority-key" }), 403, { error: "Forbidden" }, [valid.title, valid.text]],
    ];
    for (const [send, status, error, markers] of deniedCases) {
      await assertFixedError(await send(), status, error, markers);
      assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });
    }

    const created = await requestJson(request, path, "POST", valid, owner.cookie, { "idempotency-key": "authority-key" });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(artifactCounts(app), { posts: 1, media: 0, idempotency: 1 });

    const malformed = malformedUtf8Json(
      '{"type":"text","title":"malformed-create-title-marker-',
      '","text":"malformed-create-text-marker"}',
    );
    const rejected = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookie, "idempotency-key": "malformed-create-key" },
      payload: malformed,
    });
    await assertFixedError(rejected, 422, { error: "Invalid post" }, ["malformed-create-title-marker", "malformed-create-text-marker"]);
    assert.deepEqual(artifactCounts(app), { posts: 1, media: 0, idempotency: 1 });
  });
});

test("SCN-RC-04-H5 limits edits and deletion to the author and makes deleted posts unreadable", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    const other = await signup(request, "post-other");
    const created = await requestJson(request, "/api/communities/posting/posts", "POST", { type: "text", title: "Old", text: "old text" }, owner.cookie, { "idempotency-key": "edit-key" });
    const original = await created.json();
    const route = `/api/posts/${original.id}`;

    await assertFixedError(
      await requestJson(request, route, "PATCH", { title: "nonauthor-patch-marker" }, other.cookie),
      403,
      { error: "Forbidden" },
      ["nonauthor-patch-marker"],
    );
    assert.deepEqual(await (await request(route)).json(), original);
    await assertFixedError(
      await request(route, { method: "DELETE", headers: { cookie: other.cookie } }),
      403,
      { error: "Forbidden" },
      [original.title, original.text],
    );
    assert.deepEqual(await (await request(route)).json(), original);

    const editedResponse = await requestJson(request, route, "PATCH", { title: "New", text: "new text" }, owner.cookie);
    assert.equal(editedResponse.statusCode, 200);
    const edited = await editedResponse.json();
    assert.deepEqual(edited, { ...original, title: "New", text: "new text" });
    assert.deepEqual(
      { id: edited.id, community: edited.community, author: edited.author, type: edited.type },
      { id: original.id, community: original.community, author: original.author, type: original.type },
    );

    for (const patch of [{ url: "https://cross-type-marker.test" }, { title: "unknown-field-title-marker", unknown: "unknown-field-marker" }]) {
      await assertFixedError(await requestJson(request, route, "PATCH", patch, owner.cookie), 422, { error: "Invalid post" }, Object.values(patch));
      assert.deepEqual(await (await request(route)).json(), edited);
    }
    const malformedPatch = malformedUtf8Json('{"title":"malformed-patch-title-marker-', '"}');
    await assertFixedError(await request(route, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: malformedPatch,
    }), 422, { error: "Invalid post" }, ["malformed-patch-title-marker"]);
    assert.deepEqual(await (await request(route)).json(), edited);
    assert.deepEqual(artifactCounts(app), { posts: 1, media: 0, idempotency: 1 });

    const deleted = await request(route, { method: "DELETE", headers: { cookie: owner.cookie } });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(Object.fromEntries(deleted.headers), {});
    assert.equal(await deleted.text(), "");
    const misses = [];
    for (const path of [route, `${route}/media`, "/api/posts/unknown-marker", "/api/posts/unknown-marker/media"]) {
      misses.push(await assertFixedError(await request(path), 404, { error: "Not found" }, [original.title, original.text, "unknown-marker"]));
    }
    assert.deepEqual(misses[0], misses[1]);
    assert.deepEqual(misses[0], misses[2]);
    assert.deepEqual(misses[0], misses[3]);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });
  });
});

test("SCN-RC-04-H6 rolls back media faults and idempotent retries converge", async () => {
  let failed = false;
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    const bytes = pngBytes("retry-decoded-marker");
    const body = { type: "media", title: "retry-title-marker", media: { filename: "retry-filename-marker.png", contentType: "image/png", bytesBase64: bytes.toString("base64") } };
    const route = "/api/communities/posting/posts";
    const headers = { "idempotency-key": "retry-key" };
    const create = () => requestJson(request, route, "POST", body, owner.cookie, headers);
    await assertFixedError(await create(), 503, { error: "Post service unavailable" },
      [body.title, body.media.filename, body.media.bytesBase64, "retry-decoded-marker", "internal-media-failure-marker"]);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });

    const first = await create();
    const second = await create();
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    const original = await first.json();
    assert.deepEqual(await second.json(), original);
    assert.deepEqual(artifactCounts(app), { posts: 1, media: 1, idempotency: 1 });
    const media = await request(`/api/posts/${original.id}/media`);
    assert.equal(media.statusCode, 200);
    assert.deepEqual(Object.fromEntries(media.headers), { "content-type": "image/png" });
    assert.deepEqual(Buffer.from(await media.bytes()), bytes);

    const conflict = await requestJson(request, route, "POST", JSON.stringify(body, null, 2), owner.cookie, headers);
    await assertFixedError(conflict, 409, { error: "Post conflict" }, [body.title, body.media.filename, body.media.bytesBase64]);
    assert.deepEqual(artifactCounts(app), { posts: 1, media: 1, idempotency: 1 });
    assert.deepEqual(await (await request(`/api/posts/${original.id}`)).json(), original);

    const deleted = await request(`/api/posts/${original.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });
  }, { beforeMediaPersist: () => { if (!failed) { failed = true; throw new Error("internal-media-failure-marker"); } } });
});

test("SCN-RC-04-H7 uses fixed non-disclosing errors for every unreadable outcome", async () => {
  let failMedia = true;
  await withApp(async ({ app, request }) => {
    const owner = await member(request);
    const stranger = await signup(request, "matrix-stranger");
    const route = "/api/communities/posting/posts";
    const privateBody = { type: "text", title: "matrix-private-title-marker", text: "matrix-private-text-marker" };

    await assertFixedError(await requestJson(request, route, "POST", privateBody), 401,
      { error: "Authentication required" }, [privateBody.title, privateBody.text]);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });
    await assertFixedError(await requestJson(request, route, "POST", privateBody, stranger.cookie), 403,
      { error: "Forbidden" }, [privateBody.title, privateBody.text]);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });
    const invalidBody = { type: "link", title: "matrix-invalid-title-marker", url: "/matrix-relative-url-marker" };
    await assertFixedError(await requestJson(request, route, "POST", invalidBody, owner.cookie), 422,
      { error: "Invalid post" }, [invalidBody.title, invalidBody.url]);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });

    const oversizedBytes = Buffer.alloc(5_242_881);
    pngBytes("matrix-oversized-decoded-marker").copy(oversizedBytes);
    const oversized = { type: "media", title: "matrix-oversized-title-marker", media: {
      filename: "matrix-oversized-filename-marker.png", contentType: "image/png", bytesBase64: oversizedBytes.toString("base64"),
    } };
    await assertFixedError(await requestJson(request, route, "POST", oversized, owner.cookie), 413,
      { error: "Invalid post" }, [oversized.title, oversized.media.filename, "matrix-oversized-decoded-marker"]);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });

    const unavailableBytes = pngBytes("matrix-unavailable-decoded-marker");
    const unavailable = { type: "media", title: "matrix-unavailable-title-marker", media: {
      filename: "matrix-unavailable-filename-marker.png", contentType: "image/png", bytesBase64: unavailableBytes.toString("base64"),
    } };
    await assertFixedError(await requestJson(request, route, "POST", unavailable, owner.cookie, { "idempotency-key": "matrix-unavailable-key" }), 503,
      { error: "Post service unavailable" }, [unavailable.title, unavailable.media.filename, unavailable.media.bytesBase64,
        "matrix-unavailable-decoded-marker", "matrix-internal-failure-marker"]);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });

    const conflictHeaders = { "idempotency-key": "matrix-conflict-key" };
    const created = await requestJson(request, route, "POST", privateBody, owner.cookie, conflictHeaders);
    assert.equal(created.statusCode, 201);
    const post = await created.json();
    const conflictingBody = { ...privateBody, text: "matrix-conflicting-text-marker" };
    await assertFixedError(await requestJson(request, route, "POST", conflictingBody, owner.cookie, conflictHeaders), 409,
      { error: "Post conflict" }, [conflictingBody.title, conflictingBody.text]);
    assert.deepEqual(artifactCounts(app), { posts: 1, media: 0, idempotency: 1 });

    const deleted = await request(`/api/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(artifactCounts(app), { posts: 0, media: 0, idempotency: 0 });
    const privateMarkers = [privateBody.title, privateBody.text, post.id];
    const unreadable = [];
    for (const path of [
      `/api/posts/${post.id}`,
      `/api/posts/${post.id}/media`,
      "/api/posts/matrix-unknown-id-marker",
      "/api/posts/matrix-unknown-id-marker/media",
    ]) {
      unreadable.push(await assertFixedError(await request(path), 404, { error: "Not found" }, [...privateMarkers, "matrix-unknown-id-marker"]));
    }
    for (const response of unreadable.slice(1)) assert.deepEqual(response, unreadable[0]);
  }, { beforeMediaPersist: () => {
    if (failMedia) { failMedia = false; throw new Error("matrix-internal-failure-marker"); }
  } });
});
