import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";

async function withApp(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-community-"));
  const path = join(directory, "community.sqlite");
  const app = createApp({ databasePath: path, now: () => 1_700_000_000_000 });
  try { await run({ app, path, request: (route, options = {}) => app.inject({ path: route, ...options }) }); }
  finally { try { app.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
}

function session(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "authentication response sets a cookie");
  return value.split(";", 1)[0];
}

async function requestJson(request, path, method, body, cookie) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function signup(request, username) {
  const response = await requestJson(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: session(response) };
}

async function createCommunity(request, name, cookie) {
  return requestJson(request, "/api/communities", "POST", { name }, cookie);
}

function memberships(app, name) {
  return app.database.prepare("SELECT user_id, role FROM community_memberships WHERE community_name = ? ORDER BY user_id").all(name)
    .map((row) => ({ user_id: row.user_id, role: row.role }));
}

test("SCN-RC-03-H1 creates an owner atomically and persists after reopen", async () => {
  await withApp(async ({ app, request, path }) => {
    const creator = await signup(request, "creator-user");
    const created = await createCommunity(request, "  River_Talk  ", creator.cookie);
    assert.equal(created.statusCode, 201);
    assert.equal(await created.text(), "");
    assert.deepEqual(app.database.prepare("SELECT canonical_name, display_name, owner_user_id FROM communities").all().map((row) => ({
      canonical_name: row.canonical_name, display_name: row.display_name, owner_user_id: row.owner_user_id,
    })), [{ canonical_name: "river_talk", display_name: "River_Talk", owner_user_id: creator.account.id }]);
    assert.deepEqual(memberships(app, "river_talk"), [{ user_id: creator.account.id, role: "owner" }]);
    assert.deepEqual(await (await request("/api/communities")).json(), { communities: ["river_talk"] });
    app.database.exec("CREATE TRIGGER fail_owner_membership BEFORE INSERT ON community_memberships WHEN NEW.community_name = 'broken' BEGIN SELECT RAISE(ABORT, 'transient'); END");
    assert.equal((await createCommunity(request, "broken", creator.cookie)).statusCode, 503);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM communities WHERE canonical_name = 'broken'").get().count, 0);
    app.database.exec("DROP TRIGGER fail_owner_membership");
    assert.equal((await createCommunity(request, "broken", creator.cookie)).statusCode, 201);
    app.close();
    const reopened = createApp({ databasePath: path });
    assert.deepEqual(reopened.database.prepare("SELECT canonical_name FROM communities ORDER BY canonical_name").all().map((row) => ({ canonical_name: row.canonical_name })), [{ canonical_name: "broken" }, { canonical_name: "river_talk" }]);
    reopened.close();
  });
});

test("SCN-RC-03-H2 rejects canonical duplicate names without extra ownership", async () => {
  await withApp(async ({ app, request }) => {
    const creator = await signup(request, "creator-user");
    assert.equal((await createCommunity(request, "River_Talk", creator.cookie)).statusCode, 201);
    const duplicate = await createCommunity(request, "\t river_talk \r", creator.cookie);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM communities").get().count, 1);
    assert.deepEqual(memberships(app, "river_talk"), [{ user_id: creator.account.id, role: "owner" }]);
  });
});

test("SCN-RC-03-H3 rejects invalid community bodies before persistence", async () => {
  await withApp(async ({ app, request }) => {
    const creator = await signup(request, "creator-user");
    for (const body of ["{bad", null, [], "name", {}, { name: "valid", extra: true }, { name: 7 }, { name: "ab" }, { name: "a".repeat(22) }, { name: "bad-name" }, { name: "\u00a0valid" }]) {
      const response = await requestJson(request, "/api/communities", "POST", body, creator.cookie);
      assert.equal(response.statusCode, 422);
    }
    for (const name of ["abc", "a".repeat(21)]) assert.equal((await createCommunity(request, name, creator.cookie)).statusCode, 201);
    assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM communities").get().count, 2);
    assert.equal((await requestJson(request, "/api/communities", "POST", "{bad")).statusCode, 401);
  });
});

test("SCN-RC-03-H4 owner alone assigns existing active members", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await signup(request, "owner-user");
    const member = await signup(request, "member-user");
    assert.equal((await createCommunity(request, "roles", owner.cookie)).statusCode, 201);
    assert.equal((await request("/api/communities/roles/members", { method: "POST", headers: { cookie: member.cookie } })).statusCode, 200);
    const promote = await requestJson(request, "/api/communities/roles/moderators", "PATCH", { username: "member-user", role: "moderator" }, owner.cookie);
    assert.equal(promote.statusCode, 200);
    assert.equal(memberships(app, "roles").find((row) => row.user_id === member.account.id).role, "moderator");
    assert.equal((await requestJson(request, "/api/communities/roles/moderators", "PATCH", { username: "owner-user", role: "member" }, member.cookie)).statusCode, 403);
    assert.equal((await requestJson(request, "/api/communities/roles/moderators", "PATCH", { username: "member-user", role: "member" }, owner.cookie)).statusCode, 200);
    assert.equal(memberships(app, "roles").find((row) => row.user_id === member.account.id).role, "member");
  });
});

test("SCN-RC-03-H5 joins idempotently, preserves roles, and leaves only self", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await signup(request, "owner-user");
    const member = await signup(request, "member-user");
    const neighbor = await signup(request, "neighbor-user");
    await createCommunity(request, "members", owner.cookie);
    for (const account of [member, member, neighbor]) assert.equal((await request("/api/communities/members/members", { method: "POST", headers: { cookie: account.cookie } })).statusCode, 200);
    assert.equal(memberships(app, "members").filter((row) => row.user_id === member.account.id).length, 1);
    const leave = await request("/api/communities/members/members/me", { method: "DELETE", headers: { cookie: member.cookie } });
    assert.equal(leave.statusCode, 204);
    assert.equal(await leave.text(), "");
    assert.deepEqual(memberships(app, "members").map((row) => row.user_id).sort(), [owner.account.id, neighbor.account.id].sort());
  });
});

test("SCN-RC-03-H6 concurrent joins converge on one member record", async () => {
  await withApp(async ({ app, request, path }) => {
    const owner = await signup(request, "owner-user");
    const member = await signup(request, "member-user");
    await createCommunity(request, "concurrent", owner.cookie);
    const barrier = new SharedArrayBuffer(4);
    const workerPath = new URL("./community-join-worker.js", import.meta.url);
    const runWorker = () => new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { path, cookie: member.cookie, barrier } });
      worker.once("message", resolve); worker.once("error", reject);
    });
    const both = Promise.all([runWorker(), runWorker()]);
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2);
    assert.deepEqual(await both, [200, 200]);
    assert.deepEqual(memberships(app, "concurrent").filter((row) => row.user_id === member.account.id), [{ user_id: member.account.id, role: "member" }]);
  });
});

test("SCN-RC-03-H7 member modlog denial is private and read-only", async () => {
  await withApp(async ({ app, request }) => {
    const owner = await signup(request, "owner-user");
    const member = await signup(request, "member-user");
    await createCommunity(request, "private", owner.cookie);
    await request("/api/communities/private/members", { method: "POST", headers: { cookie: member.cookie } });
    const before = memberships(app, "private");
    const denied = await request("/api/communities/private/modlog", { headers: { cookie: member.cookie } });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(await denied.json(), { error: "Forbidden" });
    assert.deepEqual([...denied.headers.keys()], ["content-type"]);
    assert.deepEqual(memberships(app, "private"), before);
  });
});
