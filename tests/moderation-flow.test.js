import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { ModerationRepository } from "../src/moderation/moderation-repository.js";
import { ModerationService } from "../src/moderation/moderation-service.js";

const password = "correct-horse-battery";
const epoch = 1_700_000_000_000;
const day = 24 * 60 * 60 * 1_000;

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-moderation-"));
  const path = join(directory, "moderation.sqlite");
  const app = createApp({ databasePath: path, now: () => epoch, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0];
}

async function json(request, path, method, body, session, headers = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...headers, ...(session ? { cookie: session } : {}) },
    ...(body === undefined ? {} : { payload: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
}

async function signup(request, username) {
  const response = await json(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: cookie(response) };
}

async function createCommunity(request, name, owner) {
  assert.equal((await json(request, "/api/communities", "POST", { name }, owner.cookie)).statusCode, 201);
}

async function joinCommunity(request, name, member) {
  assert.equal((await request(`/api/communities/${name}/members`, { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
}

async function changeRole(request, name, owner, member, role) {
  const response = await json(request, `/api/communities/${name}/moderators`, "PATCH", { username: member.account.username, role }, owner.cookie);
  assert.equal(response.statusCode, 200);
}

async function createPost(request, community, author, title, body) {
  const response = await json(request, `/api/communities/${community}/posts`, "POST", body ?? { type: "text", title, text: `${title} body` }, author.cookie);
  assert.equal(response.statusCode, 201);
  return response.json();
}

async function reportPost(request, post, reporter, reason) {
  return json(request, `/api/posts/${post.id}/reports`, "POST", { reason }, reporter.cookie);
}

async function fixture(request) {
  const owner = await signup(request, "moderation-owner");
  const reporter = await signup(request, "moderation-member");
  const outsider = await signup(request, "moderation-outsider");
  await createCommunity(request, "modqueue", owner);
  await joinCommunity(request, "modqueue", reporter);
  const post = await createPost(request, "modqueue", reporter, "reportable");
  return { owner, reporter, outsider, post };
}

async function fixedError(response, status, error, markers = []) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), { "content-type": "application/json; charset=utf-8" });
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error });
  for (const marker of markers) assert.equal(text.includes(marker), false);
}

function rows(app, sql, ...parameters) {
  return app.database.prepare(sql).all(...parameters).map((row) => ({ ...row }));
}

function moderationSnapshot(app) {
  return {
    posts: rows(app, "SELECT id, community_name, author_user_id, type, title, text_content, url_content, media_filename, media_content_type, hex(media_bytes) AS media_hex, moderation_state FROM posts ORDER BY id"),
    reports: rows(app, "SELECT * FROM reports ORDER BY id"),
    roles: rows(app, "SELECT community_name, user_id, role FROM community_memberships ORDER BY community_name, user_id"),
    audits: rows(app, "SELECT * FROM moderation_audit_events ORDER BY created_at, id"),
  };
}

function transitionSnapshot(app, postId) {
  return {
    post: { ...app.database.prepare("SELECT moderation_state FROM posts WHERE id = ?").get(postId) },
    reports: rows(app, "SELECT id, state, resolved_at FROM reports WHERE post_id = ? ORDER BY id", postId),
    audits: rows(app, "SELECT id, action, created_at FROM moderation_audit_events WHERE post_id = ? ORDER BY created_at, id", postId),
  };
}

function startWorker(workerData) {
  const worker = new Worker(new URL("./moderation-worker.js", import.meta.url), { workerData });
  const messages = [];
  const complete = new Promise((resolve, reject) => {
    worker.on("message", (message) => messages.push(message));
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve(messages) : reject(new Error(`moderation worker exited ${code}`)));
  });
  return { worker, messages, complete };
}

async function waitForWorkers(runs) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (runs.every((run) => run.messages.some((message) => message.type === "ready"))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("moderation workers did not reach barrier");
}

async function concurrentRequests(app, path, requests) {
  const barrier = new SharedArrayBuffer(8);
  const control = new Int32Array(barrier);
  const runs = requests.map((request) => startWorker({ path, now: epoch, barrier, ...request }));
  let locked = false;
  try {
    await waitForWorkers(runs);
    assert.equal(Atomics.load(control, 1), requests.length);
    app.database.exec("BEGIN IMMEDIATE");
    locked = true;
    Atomics.store(control, 0, 1);
    assert.equal(Atomics.notify(control, 0, requests.length), requests.length);
    await new Promise((resolve) => setTimeout(resolve, 100));
    app.database.exec("COMMIT");
    locked = false;
    const messages = await Promise.all(runs.map((run) => run.complete));
    return messages.map((workerMessages) => workerMessages.find((message) => message.type === "result"));
  } finally {
    if (locked) app.database.exec("ROLLBACK");
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0, requests.length);
    await Promise.allSettled(runs.map((run) => run.worker.terminate()));
  }
}

function authorityKey(communities) {
  return createHash("sha256").update(JSON.stringify([...communities].sort())).digest("hex");
}

test("SCN-RC-09-H1 creates one trimmed durable report without an audit event", async () => withApp(async ({ app, request, path }) => {
  const { owner, reporter, post } = await fixture(request);
  const beforePost = { ...app.database.prepare("SELECT * FROM posts WHERE id = ?").get(post.id) };
  const response = await reportPost(request, post, reporter, "  useful reason  ");
  assert.equal(response.statusCode, 201);
  const report = await response.json();
  assert.deepEqual(report, {
    id: report.id,
    postId: post.id,
    community: "modqueue",
    reason: "useful reason",
    createdAt: new Date(epoch).toISOString(),
  });
  assert.deepEqual({ ...app.database.prepare("SELECT * FROM posts WHERE id = ?").get(post.id) }, beforePost);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM reports WHERE state = 'open'").get().count, 1);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count, 0);
  const queue = await (await request("/api/mod/queue", { headers: { cookie: owner.cookie } })).json();
  assert.deepEqual(queue, { reports: [report], nextCursor: null });

  app.close();
  const reopened = createApp({ databasePath: path, now: () => epoch });
  assert.deepEqual({ ...reopened.database.prepare("SELECT * FROM posts WHERE id = ?").get(post.id) }, beforePost);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM reports WHERE id = ?").get(report.id).count, 1);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count, 0);
  reopened.close();
}));

test("SCN-RC-09-H2 traverses stable authority-scoped pages across changes and reopen", async () => {
  let now = epoch;
  await withApp(async ({ app, request, path }) => {
    const { owner, reporter, outsider, post } = await fixture(request);
    await createCommunity(request, "sidequeue", owner);
    await joinCommunity(request, "sidequeue", reporter);
    const sideOne = await createPost(request, "sidequeue", reporter, "side one");
    const sideTwo = await createPost(request, "sidequeue", reporter, "side two");
    await createCommunity(request, "foreignqueue", outsider);
    const foreignPost = await createPost(request, "foreignqueue", outsider, "foreign");
    const reports = [];
    for (const target of [post, sideOne, sideTwo]) {
      const response = await reportPost(request, target, target.community === "modqueue" ? reporter : owner, `reason-${target.id}`);
      assert.equal(response.statusCode, 201);
      reports.push(await response.json());
    }
    assert.equal((await reportPost(request, foreignPost, outsider, "private foreign reason")).statusCode, 201);
    const initial = reports.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

    const firstResponse = await request("/api/mod/queue?limit=1", { headers: { cookie: owner.cookie } });
    assert.equal(firstResponse.statusCode, 200);
    const first = await firstResponse.json();
    assert.deepEqual(first.reports.map((report) => report.id), [initial[0].id]);
    assert.ok(first.nextCursor);

    now += 1;
    const newer = await createPost(request, "modqueue", reporter, "newer");
    assert.equal((await reportPost(request, newer, reporter, "newer reason")).statusCode, 201);
    const resolved = initial[1];
    assert.equal((await request(`/api/mod/posts/${resolved.postId}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);

    app.close();
    const reopened = createApp({ databasePath: path, now: () => now, sessionLifetimeMs: 3 * day });
    const continuationRoute = `/api/mod/queue?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`;
    const second = await (await reopened.inject({ path: continuationRoute, headers: { cookie: owner.cookie } })).json();
    const retry = await (await reopened.inject({ path: continuationRoute, headers: { cookie: owner.cookie } })).json();
    assert.deepEqual(retry, second);
    const seen = [...first.reports, ...second.reports];
    let cursor = second.nextCursor;
    while (cursor) {
      const page = await (await reopened.inject({ path: `/api/mod/queue?limit=1&cursor=${encodeURIComponent(cursor)}`, headers: { cookie: owner.cookie } })).json();
      seen.push(...page.reports);
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen.map((report) => report.id), initial.filter((report) => report.id !== resolved.id).map((report) => report.id));
    assert.equal(new Set(seen.map((report) => report.id)).size, seen.length);
    assert.equal(seen.some((report) => report.postId === newer.id || report.postId === foreignPost.id), false);

    const beforeInvalid = {
      reports: reopened.database.prepare("SELECT COUNT(*) AS count FROM reports").get().count,
      traversals: reopened.database.prepare("SELECT COUNT(*) AS count FROM moderation_traversals").get().count,
      tokens: reopened.database.prepare("SELECT COUNT(*) AS count FROM moderation_page_tokens").get().count,
      audits: reopened.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count,
    };
    for (const suffix of ["?limit=0", "?limit=101", "?limit=01", "?extra=1", "?cursor=bad!", "?limit=1&limit=2", "?cursor=a&cursor=b"]) {
      await fixedError(await reopened.inject({ path: `/api/mod/queue${suffix}`, headers: { cookie: owner.cookie } }), 422, "Invalid moderation page");
    }
    await fixedError(await reopened.inject({ path: continuationRoute, headers: { cookie: outsider.cookie } }), 422, "Invalid moderation page", ["private foreign reason"]);
    assert.deepEqual({
      reports: reopened.database.prepare("SELECT COUNT(*) AS count FROM reports").get().count,
      traversals: reopened.database.prepare("SELECT COUNT(*) AS count FROM moderation_traversals").get().count,
      tokens: reopened.database.prepare("SELECT COUNT(*) AS count FROM moderation_page_tokens").get().count,
      audits: reopened.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count,
    }, beforeInvalid);

    await changeRole((route, options) => reopened.inject({ path: route, ...options }), "modqueue", owner, reporter, "moderator");
    await changeRole((route, options) => reopened.inject({ path: route, ...options }), "sidequeue", owner, reporter, "moderator");
    const rolePage = await (await reopened.inject({ path: "/api/mod/queue?limit=1", headers: { cookie: reporter.cookie } })).json();
    assert.ok(rolePage.nextCursor);
    await changeRole((route, options) => reopened.inject({ path: route, ...options }), "sidequeue", owner, reporter, "member");
    await fixedError(await reopened.inject({ path: `/api/mod/queue?cursor=${encodeURIComponent(rolePage.nextCursor)}`, headers: { cookie: reporter.cookie } }), 422, "Invalid moderation page");

    const expiring = await (await reopened.inject({ path: "/api/mod/queue?limit=1", headers: { cookie: owner.cookie } })).json();
    assert.ok(expiring.nextCursor);
    now += day;
    await fixedError(await reopened.inject({ path: `/api/mod/queue?cursor=${encodeURIComponent(expiring.nextCursor)}`, headers: { cookie: owner.cookie } }), 422, "Invalid moderation page");
    reopened.close();
  }, { now: () => now, sessionLifetimeMs: 3 * day });
});

test("SCN-RC-09-H2 derives captured rows and authority key from one transaction snapshot", async () => withApp(async ({ app, request, path }) => {
  const { owner, reporter, post } = await fixture(request);
  await createCommunity(request, "sidequeue", owner);
  await joinCommunity(request, "sidequeue", reporter);
  await changeRole(request, "modqueue", owner, reporter, "moderator");
  await changeRole(request, "sidequeue", owner, reporter, "moderator");
  const another = await createPost(request, "modqueue", owner, "another queue row");
  assert.equal((await reportPost(request, post, owner, "first")).statusCode, 201);
  assert.equal((await reportPost(request, another, reporter, "second")).statusCode, 201);

  const repository = new ModerationRepository(app.database);
  const secondConnection = openDatabase(path);
  const originalAuthorities = repository.authorityCommunities.bind(repository);
  let preliminary = true;
  repository.authorityCommunities = (userId) => {
    const authorities = originalAuthorities(userId);
    if (preliminary) {
      preliminary = false;
      secondConnection.prepare("UPDATE community_memberships SET role = 'member' WHERE community_name = ? AND user_id = ?").run("sidequeue", reporter.account.id);
    }
    return authorities;
  };
  const service = new ModerationService({ repository, database: app.database, now: () => epoch });
  const first = service.queue(reporter.account.id, 1);
  assert.equal(first.kind, "success");
  assert.ok(first.nextCursor);
  assert.equal(app.database.prepare("SELECT authority_key FROM moderation_traversals ORDER BY created_at DESC LIMIT 1").get().authority_key, authorityKey(["modqueue"]));
  const second = service.queue(reporter.account.id, 1, first.nextCursor);
  assert.equal(second.kind, "success");
  secondConnection.close();
}));

test("SCN-RC-09-H3 rejects invalid and concurrent duplicate reports without effects", async () => withApp(async ({ app, request, path }) => {
  const { reporter, post } = await fixture(request);
  const route = `/api/posts/${post.id}/reports`;
  const invalid = [
    { body: "{", type: "application/json" },
    { body: new Uint8Array([0x7b, 0xc3, 0x28]), type: "application/json" },
    { body: {}, type: "application/json" },
    { body: { reason: "x", extra: true }, type: "application/json" },
    { body: { reason: 1 }, type: "application/json" },
    { body: { reason: " \t " }, type: "application/json" },
    { body: { reason: "x".repeat(501) }, type: "application/json" },
    { body: { reason: "wrong media" }, type: "text/plain" },
  ];
  const before = moderationSnapshot(app);
  for (const entry of invalid) {
    const response = await json(request, route, "POST", entry.body, reporter.cookie, { "content-type": entry.type });
    await fixedError(response, 422, "Invalid report", ["wrong media"]);
    assert.deepEqual(moderationSnapshot(app), before);
  }
  for (const [reason, expected] of [["x", "x"], [` ${"😀".repeat(500)} `, "😀".repeat(500)]]) {
    const target = reason === "x" ? post : await createPost(request, "modqueue", reporter, "unicode boundary");
    const response = await reportPost(request, target, reporter, reason);
    assert.equal(response.statusCode, 201);
    assert.equal((await response.json()).reason, expected);
  }
  await fixedError(await reportPost(request, post, reporter, "duplicate marker"), 409, "Report already exists", ["duplicate marker"]);

  const concurrentPost = await createPost(request, "modqueue", reporter, "concurrent report");
  const results = await concurrentRequests(app, path, [
    { route: `/api/posts/${concurrentPost.id}/reports`, method: "POST", cookie: reporter.cookie, body: { reason: "concurrent one" } },
    { route: `/api/posts/${concurrentPost.id}/reports`, method: "POST", cookie: reporter.cookie, body: { reason: "concurrent two" } },
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).toSorted(), [201, 409]);
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM reports WHERE post_id = ? AND state = 'open'").get(concurrentPost.id).count, 1);
  assert.equal(app.database.prepare("SELECT moderation_state FROM posts WHERE id = ?").get(concurrentPost.id).moderation_state, "visible");
  assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events").get().count, 0);
}));

test("SCN-RC-09-H4 requires authentication, membership, and current moderator authority", async () => withApp(async ({ app, request }) => {
  const { owner, reporter, outsider, post } = await fixture(request);
  assert.equal((await reportPost(request, post, reporter, "audit seed")).statusCode, 201);
  assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  const event = app.database.prepare("SELECT id FROM moderation_audit_events").get();
  assert.equal((await request(`/api/mod/posts/${post.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } })).statusCode, 200);
  const unauthenticated = [
    { path: `/api/posts/${post.id}/reports`, method: "POST", payload: "{" },
    { path: "/api/mod/queue?limit=bad" },
    { path: `/api/mod/posts/${post.id}`, method: "DELETE" },
    { path: `/api/mod/posts/${post.id}/restore`, method: "POST" },
    { path: "/api/communities/modqueue/modlog" },
    { path: `/api/mod/audit/${event.id}` },
  ];
  for (const entry of unauthenticated) await fixedError(await request(entry.path, { method: entry.method, headers: { "content-type": "application/json" }, payload: entry.payload }), 401, "Authentication required");

  const deniedBefore = moderationSnapshot(app);
  await fixedError(await json(request, `/api/posts/${post.id}/reports`, "POST", "{private malformed marker", outsider.cookie), 403, "Forbidden", ["private malformed marker"]);
  for (const entry of [
    { path: "/api/mod/queue?limit=bad" },
    { path: `/api/mod/posts/${post.id}`, method: "DELETE" },
    { path: `/api/mod/posts/${post.id}/restore`, method: "POST" },
    { path: "/api/communities/modqueue/modlog" },
    { path: `/api/mod/audit/${event.id}` },
  ]) await fixedError(await request(entry.path, { method: entry.method, headers: { cookie: outsider.cookie } }), 403, "Forbidden");
  assert.deepEqual(moderationSnapshot(app), deniedBefore);

  await changeRole(request, "modqueue", owner, reporter, "moderator");
  assert.equal((await request("/api/mod/queue", { headers: { cookie: reporter.cookie } })).statusCode, 200);
  await changeRole(request, "modqueue", owner, reporter, "member");
  await fixedError(await request("/api/mod/queue", { headers: { cookie: reporter.cookie } }), 403, "Forbidden");
  assert.equal((await request("/api/communities/modqueue/members/me", { method: "DELETE", headers: { cookie: reporter.cookie } })).statusCode, 204);
  await fixedError(await reportPost(request, post, reporter, "after departure"), 403, "Forbidden", ["after departure"]);
}));

test("SCN-RC-09-H5 hides every ordinary surface and restores original representations", async () => withApp(async ({ app, request }) => {
  const { owner, reporter } = await fixture(request);
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("visibility-media")]);
  const post = await createPost(request, "modqueue", reporter, "VisibilityMarker", {
    type: "media", title: "VisibilityMarker", media: { filename: "marker.png", contentType: "image/png", bytesBase64: bytes.toString("base64") },
  });
  const rootResponse = await json(request, `/api/posts/${post.id}/comments`, "POST", { body: "VisibilityComment root" }, reporter.cookie);
  const root = await rootResponse.json();
  const child = await (await json(request, `/api/posts/${post.id}/comments`, "POST", { body: "VisibilityComment child", parentId: root.id }, reporter.cookie)).json();
  const commentPage = await (await request(`/api/posts/${post.id}/comments?limit=1`)).json();
  assert.ok(commentPage.nextCursor);
  assert.equal((await request(`/api/posts/${post.id}/save`, { method: "PUT", headers: { cookie: reporter.cookie } })).statusCode, 204);
  assert.equal((await request(`/api/posts/${post.id}`, { headers: { cookie: reporter.cookie } })).statusCode, 200);
  assert.equal((await json(request, `/api/posts/${post.id}/vote`, "PUT", { value: 1 }, owner.cookie)).statusCode, 200);
  assert.equal((await reportPost(request, post, reporter, "surface report")).statusCode, 201);

  const original = {
    post: await (await request(`/api/posts/${post.id}`)).json(),
    media: Buffer.from(await (await request(`/api/posts/${post.id}/media`)).bytes()),
    root: await (await request(`/api/comments/${root.id}`)).json(),
    conversation: await (await request(`/api/posts/${post.id}/comments?limit=100`)).json(),
    vote: await (await request(`/api/posts/${post.id}/vote`, { headers: { cookie: owner.cookie } })).json(),
    canonical: rows(app, "SELECT id, community_name, author_user_id, type, title, text_content, url_content, media_filename, media_content_type, hex(media_bytes) AS media_hex FROM posts WHERE id = ?", post.id),
    comments: rows(app, "SELECT * FROM comments WHERE post_id = ? ORDER BY created_sequence", post.id),
    saved: rows(app, "SELECT * FROM saved_posts WHERE post_id = ?", post.id),
    history: rows(app, "SELECT * FROM post_history WHERE post_id = ?", post.id),
    votes: rows(app, "SELECT * FROM post_votes WHERE post_id = ?", post.id),
  };

  const removed = await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(Object.fromEntries(removed.headers), {});
  assert.equal(await removed.text(), "");
  for (const route of [`/api/posts/${post.id}`, `/api/posts/${post.id}/media`, `/api/posts/${post.id}/comments`, `/api/posts/${post.id}/comments?cursor=${encodeURIComponent(commentPage.nextCursor)}`, `/api/comments/${root.id}`, `/api/posts/${post.id}/vote`]) {
    assert.equal((await request(route, { headers: { cookie: owner.cookie } })).statusCode, 404, route);
  }
  assert.equal((await (await request("/api/search?q=VisibilityMarker")).json()).results.some((result) => result.id === post.id), false);
  assert.equal((await (await request("/api/search?q=VisibilityComment")).json()).results.some((result) => result.id === root.id || result.id === child.id), false);
  assert.equal((await (await request("/api/me/saved", { headers: { cookie: reporter.cookie } })).json()).posts.some((item) => item.id === post.id), false);
  assert.equal((await (await request("/api/me/history", { headers: { cookie: reporter.cookie } })).json()).history.some((item) => item.post.id === post.id), false);
  assert.equal(app.database.prepare("SELECT state FROM reports WHERE post_id = ?").get(post.id).state, "resolved");
  assert.deepEqual(rows(app, "SELECT id, community_name, author_user_id, type, title, text_content, url_content, media_filename, media_content_type, hex(media_bytes) AS media_hex FROM posts WHERE id = ?", post.id), original.canonical);
  assert.deepEqual(rows(app, "SELECT * FROM comments WHERE post_id = ? ORDER BY created_sequence", post.id), original.comments);
  assert.deepEqual(rows(app, "SELECT * FROM saved_posts WHERE post_id = ?", post.id), original.saved);
  assert.deepEqual(rows(app, "SELECT * FROM post_history WHERE post_id = ?", post.id), original.history);
  assert.deepEqual(rows(app, "SELECT * FROM post_votes WHERE post_id = ?", post.id), original.votes);

  const restored = await request(`/api/mod/posts/${post.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(Object.fromEntries(restored.headers), {});
  assert.equal(await restored.text(), "");
  assert.deepEqual(await (await request(`/api/posts/${post.id}`)).json(), original.post);
  assert.deepEqual(Buffer.from(await (await request(`/api/posts/${post.id}/media`)).bytes()), original.media);
  assert.deepEqual(await (await request(`/api/comments/${root.id}`)).json(), original.root);
  assert.deepEqual(await (await request(`/api/posts/${post.id}/comments?limit=100`)).json(), original.conversation);
  assert.deepEqual(await (await request(`/api/posts/${post.id}/vote`, { headers: { cookie: owner.cookie } })).json(), original.vote);
  assert.equal(app.database.prepare("SELECT state FROM reports WHERE post_id = ?").get(post.id).state, "resolved");

  const events = rows(app, "SELECT * FROM moderation_audit_events WHERE post_id = ? ORDER BY created_at, id", post.id);
  assert.deepEqual(events.map((event) => event.action), ["remove", "restore"]);
  const modlog = await (await request("/api/communities/modqueue/modlog", { headers: { cookie: owner.cookie } })).json();
  assert.deepEqual(modlog.entries.filter((event) => event.postId === post.id).map((event) => event.id), events.map((event) => event.id));
  for (const event of events) {
    const detail = await (await request(`/api/mod/audit/${event.id}`, { headers: { cookie: owner.cookie } })).json();
    assert.deepEqual(detail, { id: event.id, community: "modqueue", postId: post.id, actor: owner.account.username, action: event.action, createdAt: new Date(event.created_at).toISOString() });
  }
}));

test("SCN-RC-09-H6 rolls back every write phase and serializes retries across reopen", async () => {
  let failPhase;
  await withApp(async ({ app, request, path }) => {
    const { owner, reporter } = await fixture(request);
    for (const phase of ["post-state", "resolve-reports", "append-audit"]) {
      const post = await createPost(request, "modqueue", reporter, `remove fault ${phase}`);
      assert.equal((await reportPost(request, post, reporter, `report ${phase}`)).statusCode, 201);
      const before = transitionSnapshot(app, post.id);
      failPhase = phase;
      await fixedError(await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } }), 503, "Moderation service unavailable");
      assert.deepEqual(transitionSnapshot(app, post.id), before, phase);
      failPhase = undefined;
      assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    }
    for (const phase of ["post-state", "append-audit"]) {
      const post = await createPost(request, "modqueue", reporter, `restore fault ${phase}`);
      assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
      const before = transitionSnapshot(app, post.id);
      failPhase = phase;
      await fixedError(await request(`/api/mod/posts/${post.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } }), 503, "Moderation service unavailable");
      assert.deepEqual(transitionSnapshot(app, post.id), before, phase);
      failPhase = undefined;
      assert.equal((await request(`/api/mod/posts/${post.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } })).statusCode, 200);
    }

    const concurrent = await createPost(request, "modqueue", reporter, "concurrent transition");
    let results = await concurrentRequests(app, path, [
      { route: `/api/mod/posts/${concurrent.id}`, method: "DELETE", cookie: owner.cookie },
      { route: `/api/mod/posts/${concurrent.id}`, method: "DELETE", cookie: owner.cookie },
    ]);
    assert.deepEqual(results.map((result) => result.statusCode), [204, 204]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events WHERE post_id = ? AND action = 'remove'").get(concurrent.id).count, 1);
    assert.equal((await request(`/api/mod/posts/${concurrent.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    results = await concurrentRequests(app, path, [
      { route: `/api/mod/posts/${concurrent.id}/restore`, method: "POST", cookie: owner.cookie },
      { route: `/api/mod/posts/${concurrent.id}/restore`, method: "POST", cookie: owner.cookie },
    ]);
    assert.deepEqual(results.map((result) => result.statusCode), [200, 200]);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM moderation_audit_events WHERE post_id = ? AND action = 'restore'").get(concurrent.id).count, 1);
    assert.equal((await request(`/api/mod/posts/${concurrent.id}/restore`, { method: "POST", headers: { cookie: owner.cookie } })).statusCode, 200);

    app.close();
    const reopened = createApp({ databasePath: path, now: () => epoch });
    assert.equal(reopened.database.prepare("SELECT moderation_state FROM posts WHERE id = ?").get(concurrent.id).moderation_state, "visible");
    assert.deepEqual(reopened.database.prepare("SELECT action FROM moderation_audit_events WHERE post_id = ? ORDER BY created_at, id").all(concurrent.id).map((row) => row.action), ["remove", "restore"]);
    reopened.close();
  }, { beforeModerationPersist: (phase) => { if (phase === failPhase) throw new Error(`fault-${phase}`); } });
});

test("SCN-RC-09-H7 keeps denial and immutable audit attempts side-effect free", async () => withApp(async ({ app, request }) => {
  const { owner, outsider, reporter, post } = await fixture(request);
  for (const target of [post.id, "unknown-post-marker"]) {
    await fixedError(await request(`/api/mod/posts/${target}`, { method: "DELETE", headers: { cookie: outsider.cookie } }), 403, "Forbidden", [target]);
    await fixedError(await request(`/api/mod/posts/${target}/restore`, { method: "POST", headers: { cookie: outsider.cookie } }), 403, "Forbidden", [target]);
  }
  assert.equal((await request(`/api/mod/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
  for (const target of [post.id, "unknown-post-marker"]) {
    await fixedError(await request(`/api/mod/posts/${target}`, { method: "DELETE", headers: { cookie: outsider.cookie } }), 403, "Forbidden", [target]);
    await fixedError(await request(`/api/mod/posts/${target}/restore`, { method: "POST", headers: { cookie: outsider.cookie } }), 403, "Forbidden", [target]);
  }

  await createCommunity(request, "unrelated", outsider);
  const beforeDenied = moderationSnapshot(app);
  for (const path of [`/api/mod/posts/${post.id}`, `/api/mod/posts/${post.id}/restore`]) {
    await fixedError(await request(path, { method: path.endsWith("restore") ? "POST" : "DELETE", headers: { cookie: outsider.cookie } }), 403, "Forbidden", [post.id]);
  }
  for (const path of ["/api/mod/posts/unknown-post-marker", "/api/mod/posts/unknown-post-marker/restore"]) {
    await fixedError(await request(path, { method: path.endsWith("restore") ? "POST" : "DELETE", headers: { cookie: outsider.cookie } }), 404, "Not found", ["unknown-post-marker"]);
  }
  assert.deepEqual(moderationSnapshot(app), beforeDenied);

  const event = app.database.prepare("SELECT id FROM moderation_audit_events WHERE post_id = ?").get(post.id);
  for (const method of ["PATCH", "DELETE"]) {
    const response = await request(`/api/mod/audit/${event.id}`, { method, headers: { cookie: owner.cookie } });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.deepEqual(await response.json(), { error: "Method not allowed" });
  }
  await fixedError(await request("/api/mod/audit/unknown-event-marker", { headers: { cookie: owner.cookie } }), 404, "Not found", ["unknown-event-marker"]);
  await fixedError(await request(`/api/mod/audit/${event.id}`, { headers: { cookie: reporter.cookie } }), 403, "Forbidden", [event.id]);
  await fixedError(await request("/api/mod/audit/unknown-event-marker", { headers: { cookie: reporter.cookie } }), 403, "Forbidden", ["unknown-event-marker"]);
  assert.deepEqual(moderationSnapshot(app), beforeDenied);

  assert.throws(() => app.database.prepare("UPDATE moderation_audit_events SET actor = 'changed' WHERE id = ?").run(event.id), /immutable/i);
  assert.throws(() => app.database.prepare("DELETE FROM moderation_audit_events WHERE id = ?").run(event.id), /immutable/i);
  assert.deepEqual(moderationSnapshot(app), beforeDenied);
}));
