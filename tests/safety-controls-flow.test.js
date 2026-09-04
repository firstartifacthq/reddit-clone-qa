import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";
async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-safety-")); const path = join(directory, "safety.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000, ...options });
  try { await run({ app, path, request: (route, requestOptions = {}) => app.inject({ path: route, ...requestOptions }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}
function cookie(response) { const value = response.headers.get("set-cookie"); assert.ok(value); return value.split(";", 1)[0]; }
async function json(request, path, method, body, user, headers = {}) {
  return request(path, { method, headers: { "content-type": "application/json", ...headers, ...(user ? { cookie: user.cookie } : {}) }, payload: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) });
}
async function signup(request, username) { const response = await json(request, "/api/auth/signup", "POST", { username, password }); assert.equal(response.statusCode, 201); return { ...(await response.json()), cookie: cookie(response) }; }
async function member(request, username = "safety-owner") { const user = await signup(request, username); assert.equal((await json(request, "/api/communities", "POST", { name: "safety" }, user)).statusCode, 201); return user; }
function counts(app) { return Object.fromEntries(["posts", "post_idempotency", "post_creation_events"].map((table) => [table, app.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count])); }
function post(title = "valid") { return { type: "text", title, text: "valid text" }; }
async function fixed(response, status, markers = []) { assert.equal(response.statusCode, status); const body = await response.text(); for (const marker of markers) assert.equal(body.includes(marker), false); return { status: response.statusCode, headers: Object.fromEntries(response.headers), body }; }

test("AC-RC10-1 limits a member at the configured maximum without durable artifacts", async () => {
  let current = 1_700_000_000_000;
  await withApp(async ({ app, request }) => { const owner = await member(request); const create = (body, key) => json(request, "/api/communities/safety/posts", "POST", body, owner, { "idempotency-key": key });
    assert.equal((await create(post("first"), "one")).statusCode, 201); const before = counts(app); const rejected = await create(post("over-limit-marker"), "two");
    await fixed(rejected, 429, ["over-limit-marker"]); assert.match(rejected.headers.get("retry-after") || "", /^[1-9]\d*$/); assert.deepEqual(counts(app), before);
    current += 60_001; assert.equal((await create(post("after-window"), "three")).statusCode, 201); assert.deepEqual(counts(app), { posts: 2, post_idempotency: 2, post_creation_events: 1 });
  }, { now: () => current, postRateLimitMax: 1, postRateLimitWindowMs: 60_000 });
});
test("AC-RC10-2 accepts the inclusive final capacity request", async () => {
  await withApp(async ({ app, request }) => { const owner = await member(request); const create = (key) => json(request, "/api/communities/safety/posts", "POST", post(key), owner, { "idempotency-key": key });
    assert.equal((await create("one")).statusCode, 201); const final = await create("two"); assert.equal(final.statusCode, 201); const created = await final.json(); assert.equal((await request(`/api/posts/${created.id}`)).statusCode, 200); assert.deepEqual(counts(app), { posts: 2, post_idempotency: 2, post_creation_events: 2 });
  }, { postRateLimitMax: 2, postRateLimitWindowMs: 60_000 });
});
test("AC-RC10-3 rejects malformed and executable post content before safety persistence", async () => {
  await withApp(async ({ app, request }) => { const owner = await member(request); const cases = ["{bad-json-marker", Buffer.concat([Buffer.from('{"type":"text","title":"utf8-marker-'), Buffer.from([0xc3, 0x28]), Buffer.from('","text":"x"}')]), { type: "text", title: "<script>script-title-marker</script>", text: "x" }, { type: "text", title: "event-title", text: "<img onerror=alert(1)>event-marker" }, { type: "link", title: "uri-marker", url: "javascript:alert(1)" }];
    for (const body of cases) await fixed(await json(request, "/api/communities/safety/posts", "POST", body, owner), 422, ["marker", "<script>", "onerror"]); assert.deepEqual(counts(app), { posts: 0, post_idempotency: 0, post_creation_events: 0 }); assert.equal((await request("/")).statusCode, 200); assert.equal((await (await request("/")).text()).includes("script-title-marker"), false);
  });
});
test("AC-RC10-4 records blocks directionally and idempotently for the authenticated owner", async () => {
  await withApp(async ({ app, request }) => { const owner = await member(request); const target = await signup(request, "blocked-target"); const route = "/api/users/blocked-target/block";
    for (const ignored of [0, 1]) { const response = await request(route, { method: "POST", headers: { cookie: owner.cookie } }); assert.equal(response.statusCode, 204); assert.equal(await response.text(), ""); }
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").get(owner.id, target.id).count, 1); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?").get(target.id, owner.id).count, 0);
  });
});
test("AC-RC10-5 withholds blocker posts and does not record blocked history", async () => {
  await withApp(async ({ app, request }) => { const owner = await member(request); const blocked = await signup(request, "withheld-user"); const other = await signup(request, "unrelated-user"); const made = await json(request, "/api/communities/safety/posts", "POST", post("withheld-title-marker"), owner); const created = await made.json();
    assert.equal((await request("/api/users/withheld-user/block", { method: "POST", headers: { cookie: owner.cookie } })).statusCode, 204); const denied = await request(`/api/posts/${created.id}`, { headers: { cookie: blocked.cookie } }); const unknown = await request("/api/posts/unknown-post-marker", { headers: { cookie: blocked.cookie } });
    assert.deepEqual(await fixed(denied, 404, [created.id, "withheld-title-marker"]), await fixed(unknown, 404, ["unknown-post-marker"])); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM post_history WHERE user_id = ? AND post_id = ?").get(blocked.id, created.id).count, 0); assert.equal((await request(`/api/posts/${created.id}`, { headers: { cookie: other.cookie } })).statusCode, 200);
  });
});
test("AC-RC10-6 rolls back unavailable enforcement and retries once after recovery", async () => {
  let unavailable = true; await withApp(async ({ app, request }) => { const owner = await member(request); const create = () => json(request, "/api/communities/safety/posts", "POST", post("recovery-marker"), owner, { "idempotency-key": "recovery-key" });
    const failed = await create(); await fixed(failed, 503, ["recovery-marker", "fault-marker"]); assert.equal(failed.headers.get("retry-after"), "1"); assert.deepEqual(counts(app), { posts: 0, post_idempotency: 0, post_creation_events: 0 }); unavailable = false; const first = await create(); const replay = await create(); assert.equal(first.statusCode, 201); assert.equal(replay.statusCode, 201); assert.deepEqual(await replay.json(), await first.json()); assert.deepEqual(counts(app), { posts: 1, post_idempotency: 1, post_creation_events: 1 });
  }, { beforePostEnforcement: () => { if (unavailable) throw new Error("fault-marker"); } });
});
test("AC-RC10-7 leaves diagnostic endpoint indistinguishable from an unknown route", async () => {
  await withApp(async ({ request }) => { const anonymous = await fixed(await request("/api/errors/latest"), 404, ["stack", "sql", "session"]); const user = await signup(request, "diagnostic-user"); const authenticated = await fixed(await request("/api/errors/latest", { headers: { cookie: user.cookie } }), 404); const unknown = await fixed(await request("/api/unknown-marker"), 404, ["unknown-marker"]); assert.deepEqual(anonymous, unknown); assert.deepEqual(authenticated, unknown); });
});
