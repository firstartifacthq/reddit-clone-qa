import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-vote-"));
  const path = join(directory, "votes.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}

function session(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0];
}

async function jsonRequest(request, path, method, body, cookie, headers = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...headers, ...(cookie ? { cookie } : {}) },
    payload: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
}

async function signup(request, username) {
  const response = await jsonRequest(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: session(response) };
}

async function postOwner(request, username = "vote-owner") {
  const owner = await signup(request, username);
  assert.equal((await jsonRequest(request, "/api/communities", "POST", { name: "voting" }, owner.cookie)).statusCode, 201);
  const postResponse = await jsonRequest(request, "/api/communities/voting/posts", "POST", { type: "text", title: "A voteable post", text: "body" }, owner.cookie);
  assert.equal(postResponse.statusCode, 201);
  return { owner, post: await postResponse.json() };
}

function votePath(post) { return `/api/posts/${post.id}/vote`; }

function startVoteWorker(workerPath, workerData) {
  const worker = new Worker(workerPath, { workerData });
  const messages = [];
  const complete = new Promise((resolve, reject) => {
    worker.on("message", (message) => messages.push(message));
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolve(messages) : reject(new Error(`vote worker exited ${code}`)));
  });
  return { worker, messages, complete };
}

async function waitForWorkers(runs, type) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (runs.every((run) => run.messages.some((message) => message.type === type))) {
      return runs.map((run) => run.messages.find((message) => message.type === type));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`vote workers did not reach ${type}`);
}
function voteRows(app) { return app.database.prepare("SELECT post_id, voter_user_id, value FROM post_votes ORDER BY post_id, voter_user_id").all().map((row) => ({ ...row })); }
function sums(app, postId) {
  return { ...app.database.prepare(`SELECT
    COALESCE((SELECT SUM(value) FROM post_votes WHERE post_id = ?), 0) AS score,
    COALESCE((SELECT SUM(vote.value) FROM posts JOIN post_votes AS vote ON vote.post_id = posts.id WHERE posts.author_user_id = (SELECT author_user_id FROM posts WHERE id = ?)), 0) AS authorKarma`).get(postId, postId) };
}

async function fixedError(response, status, error, markers = []) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(Object.fromEntries(response.headers), { "content-type": "application/json; charset=utf-8" });
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error });
  for (const marker of markers) assert.equal(body.includes(marker), false);
}

test("SCN-RC-06-H1 sets, reads, clears, and reopens a durable vote resource", async () => {
  await withApp(async ({ app, path, request }) => {
    const { post } = await postOwner(request);
    const voter = await signup(request, "vote-reader");
    const route = votePath(post);
    const initial = await request(route, { headers: { cookie: voter.cookie } });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(await initial.json(), { postId: post.id, value: null, score: 0, authorKarma: 0 });
    const set = await jsonRequest(request, route, "PUT", { value: 1 }, voter.cookie);
    assert.equal(set.statusCode, 200);
    assert.deepEqual(await set.json(), { postId: post.id, value: 1, score: 1, authorKarma: 1 });
    app.close();
    const reopened = createApp({ databasePath: path, now: () => 1_700_000_000_000 });
    assert.deepEqual(await (await reopened.inject({ path: route, headers: { cookie: voter.cookie } })).json(), { postId: post.id, value: 1, score: 1, authorKarma: 1 });
    const cleared = await reopened.inject({ path: route, method: "DELETE", headers: { cookie: voter.cookie } });
    assert.equal(cleared.statusCode, 204);
    assert.deepEqual(Object.fromEntries(cleared.headers), {});
    assert.equal(await cleared.text(), "");
    assert.deepEqual(await (await reopened.inject({ path: route, headers: { cookie: voter.cookie } })).json(), { postId: post.id, value: null, score: 0, authorKarma: 0 });
    reopened.close();
  });
});

test("SCN-RC-06-H2 derives negative score and author karma and cascades deleted-post votes", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post } = await postOwner(request);
    const secondResponse = await jsonRequest(request, "/api/communities/voting/posts", "POST", { type: "text", title: "Second", text: "body" }, owner.cookie);
    const second = await secondResponse.json();
    const up = await signup(request, "vote-up");
    const down = await signup(request, "vote-down");
    assert.equal((await jsonRequest(request, votePath(post), "PUT", { value: -1 }, up.cookie)).statusCode, 200);
    assert.equal((await jsonRequest(request, votePath(second), "PUT", { value: 1 }, down.cookie)).statusCode, 200);
    assert.deepEqual(sums(app, second.id), { score: 1, authorKarma: 0 });
    assert.equal((await request(`/api/posts/${post.id}`, { method: "DELETE", headers: { cookie: owner.cookie } })).statusCode, 204);
    assert.deepEqual(sums(app, second.id), { score: 1, authorKarma: 1 });
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_votes WHERE post_id = ?").get(post.id).count, 0);
    assert.equal(app.database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  });
});

test("SCN-RC-06-H3 repeats current PUT and absent DELETE without extra rows or aggregates", async () => {
  await withApp(async ({ app, request }) => {
    const { post } = await postOwner(request);
    const voter = await signup(request, "vote-retry");
    const route = votePath(post);
    const first = await jsonRequest(request, route, "PUT", { value: -1 }, voter.cookie);
    const original = await first.json();
    const snapshot = { rows: voteRows(app), sums: sums(app, post.id) };
    const repeat = await jsonRequest(request, route, "PUT", { value: -1 }, voter.cookie);
    assert.deepEqual(await repeat.json(), original);
    assert.deepEqual({ rows: voteRows(app), sums: sums(app, post.id) }, snapshot);
    assert.equal((await request(route, { method: "DELETE", headers: { cookie: voter.cookie } })).statusCode, 204);
    const emptySnapshot = { rows: voteRows(app), sums: sums(app, post.id) };
    assert.equal((await request(route, { method: "DELETE", headers: { cookie: voter.cookie } })).statusCode, 204);
    assert.deepEqual({ rows: voteRows(app), sums: sums(app, post.id) }, emptySnapshot);
  });
});

test("SCN-RC-06-H4 admits authority before malformed payload validation with no disclosure", async () => {
  await withApp(async ({ app, request }) => {
    const { owner, post } = await postOwner(request);
    const stranger = await signup(request, "vote-stranger");
    const route = votePath(post);
    const body = "{vote-marker";
    await fixedError(await jsonRequest(request, route, "PUT", body), 401, "Authentication required", ["vote-marker"]);
    await fixedError(await jsonRequest(request, route, "PUT", body, owner.cookie), 403, "Forbidden", ["vote-marker"]);
    app.database.prepare("UPDATE posts SET voting_state = 'locked' WHERE id = ?").run(post.id);
    await fixedError(await jsonRequest(request, route, "PUT", body, stranger.cookie), 403, "Forbidden", ["vote-marker"]);
    app.database.prepare("UPDATE posts SET voting_state = 'unlocked' WHERE id = ?").run(post.id);
    await fixedError(await jsonRequest(request, "/api/posts/missing-vote-marker/vote", "PUT", body, stranger.cookie), 404, "Not found", ["vote-marker", "missing-vote-marker"]);
    assert.deepEqual(voteRows(app), []);
  });
});

test("SCN-RC-06-H5 replaces one current vote atomically and clear reverses only its final value", async () => {
  await withApp(async ({ app, request }) => {
    const { post } = await postOwner(request);
    const voter = await signup(request, "vote-replace");
    const route = votePath(post);
    assert.deepEqual(await (await jsonRequest(request, route, "PUT", { value: 1 }, voter.cookie)).json(), { postId: post.id, value: 1, score: 1, authorKarma: 1 });
    assert.deepEqual(await (await jsonRequest(request, route, "PUT", { value: -1 }, voter.cookie)).json(), { postId: post.id, value: -1, score: -1, authorKarma: -1 });
    assert.equal(voteRows(app).length, 1);
    assert.deepEqual(await (await jsonRequest(request, route, "PUT", { value: 1 }, voter.cookie)).json(), { postId: post.id, value: 1, score: 1, authorKarma: 1 });
    assert.equal((await request(route, { method: "DELETE", headers: { cookie: voter.cookie } })).statusCode, 204);
    assert.deepEqual(sums(app, post.id), { score: 0, authorKarma: 0 });
  });
});

test("SCN-RC-06-H6 rolls back an injected vote persistence failure and one retry applies once", async () => {
  let fail = true;
  await withApp(async ({ app, request }) => {
    const { post } = await postOwner(request);
    const voter = await signup(request, "vote-fault");
    const route = votePath(post);
    const before = { rows: voteRows(app), sums: sums(app, post.id) };
    await fixedError(await jsonRequest(request, route, "PUT", { value: 1 }, voter.cookie), 503, "Vote service unavailable");
    assert.deepEqual({ rows: voteRows(app), sums: sums(app, post.id) }, before);
    assert.deepEqual(await (await jsonRequest(request, route, "PUT", { value: 1 }, voter.cookie)).json(), { postId: post.id, value: 1, score: 1, authorKarma: 1 });
    assert.deepEqual(voteRows(app), [{ post_id: post.id, voter_user_id: voter.account.id, value: 1 }]);
  }, { beforeVotePersist: () => { if (fail) { fail = false; throw new Error("vote-fault-marker"); } } });
});

test("SCN-RC-06-H6 serializes same-actor concurrent mutations to one durable final vote", async () => {
  await withApp(async ({ app, path, request }) => {
    const { post } = await postOwner(request);
    const voter = await signup(request, "vote-concurrent");
    const barrier = new SharedArrayBuffer(8);
    const control = new Int32Array(barrier);
    const workerPath = new URL("./vote-worker.js", import.meta.url);
    const runs = [
      startVoteWorker(workerPath, { path, cookie: voter.cookie, route: votePath(post), value: 1, barrier }),
      startVoteWorker(workerPath, { path, cookie: voter.cookie, route: votePath(post), value: -1, barrier }),
    ];
    let lockHeld = false;
    try {
      await waitForWorkers(runs, "ready");
      assert.equal(Atomics.load(control, 1), 2);
      // A real competing writer makes the configured SQLite wait observable.
      app.database.exec("BEGIN IMMEDIATE");
      lockHeld = true;
      Atomics.store(control, 0, 1);
      assert.equal(Atomics.notify(control, 0, 2), 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.database.exec("COMMIT");
      lockHeld = false;
      const results = await Promise.all(runs.map((run) => run.complete));
      assert.deepEqual(results.flat().filter((message) => message.type === "result").map((message) => message.statusCode), [200, 200]);
    } finally {
      if (lockHeld) app.database.exec("ROLLBACK");
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0, 2);
      await Promise.allSettled(runs.map((run) => run.worker.terminate()));
    }
    const rows = voteRows(app);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].value === 1 || rows[0].value === -1);
    assert.deepEqual(sums(app, post.id), { score: rows[0].value, authorKarma: rows[0].value });
  });
});

test("SCN-RC-06-H7 rejects only invalid admitted PUT grammar and leaves ledger paths unknown", async () => {
  await withApp(async ({ app, request }) => {
    const { post } = await postOwner(request);
    const voter = await signup(request, "vote-invalid");
    const route = votePath(post);
    const invalid = [null, [], {}, { value: 0 }, { value: 1, score: 100 }, { value: "1" }, { value: 1.1 }, { value: true }, { value: -1, actor: "leak-marker" }];
    for (const body of invalid) {
      await fixedError(await jsonRequest(request, route, "PUT", body, voter.cookie), 422, "Invalid vote", ["leak-marker"]);
      assert.deepEqual(voteRows(app), []);
    }
    await fixedError(await jsonRequest(request, route, "PUT", { value: 1 }, voter.cookie, { "content-type": "text/plain" }), 422, "Invalid vote");
    await fixedError(await jsonRequest(request, route, "PUT", new Uint8Array([0x7b, 0xc3, 0x28]), voter.cookie), 422, "Invalid vote");
    const unknown = await request("/api/votes/ledger-marker");
    const ledger = await request("/api/posts/ledger-marker/votes");
    assert.deepEqual({ status: ledger.statusCode, body: await ledger.text() }, { status: unknown.statusCode, body: await unknown.text() });
  });
});
