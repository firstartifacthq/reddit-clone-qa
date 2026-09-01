import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";

async function withApp(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-community-"));
  const databasePath = join(directory, "community.sqlite");
  const app = createApp({ databasePath });
  try {
    await run({ app, databasePath, request: (path, options = {}) => app.inject({ path, ...options }) });
  } finally {
    app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "signup returns a session cookie");
  return cookie.split(";", 1)[0];
}

async function requestJson(request, path, method, body, cookie) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function signup(request, username) {
  const response = await requestJson(request, "/api/auth/signup", "POST", { username, password: "correct-horse-battery" });
  assert.equal(response.statusCode, 201);
  return { account: await response.json(), cookie: cookieFrom(response) };
}

function snapshot(databasePath) {
  const database = openDatabase(databasePath);
  try {
    return {
      communities: database.prepare("SELECT name FROM communities ORDER BY name").all().map((row) => ({ ...row })),
      memberships: database.prepare(`SELECT memberships.community_name, users.username, memberships.role
        FROM memberships JOIN users ON users.id = memberships.user_id
        ORDER BY memberships.community_name, users.username`).all().map((row) => ({ ...row })),
    };
  } finally {
    database.close();
  }
}

test("SCN-RC-03-H1 creates an owner-backed canonical community and publicly discovers it after reopen", async () => {
  await withApp(async ({ app, databasePath, request }) => {
    const owner = await signup(request, "communityowner");
    const created = await requestJson(request, "/api/communities", "POST", { name: "  Cats_Club  " }, owner.cookie);
    assert.equal(created.statusCode, 201);
    assert.deepEqual(await created.json(), {
      community: { name: "cats_club" },
      membership: { username: owner.account.username, role: "owner" },
    });
    assert.deepEqual(snapshot(databasePath), {
      communities: [{ name: "cats_club" }],
      memberships: [{ community_name: "cats_club", username: owner.account.username, role: "owner" }],
    });
    const listing = await request("/api/communities");
    assert.deepEqual(await listing.json(), { communities: [{ name: "cats_club" }] });
    app.close();
    const reopened = createApp({ databasePath });
    try {
      assert.deepEqual(await (await reopened.inject({ path: "/api/communities" })).json(), { communities: [{ name: "cats_club" }] });
    } finally {
      reopened.close();
    }
  });
});

test("SCN-RC-03-H2 rejects canonical duplicates without a membership side effect", async () => {
  await withApp(async ({ databasePath, request }) => {
    const owner = await signup(request, "firstowner");
    const requester = await signup(request, "secondowner");
    assert.equal((await requestJson(request, "/api/communities", "POST", { name: "riverside" }, owner.cookie)).statusCode, 201);
    const before = snapshot(databasePath);
    const duplicate = await requestJson(request, "/api/communities", "POST", { name: "  RIVERSIDE\t" }, requester.cookie);
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(snapshot(databasePath), before);
  });
});

test("SCN-RC-03-H3 rejects malformed and invalid community names before persistence", async () => {
  await withApp(async ({ databasePath, request }) => {
    const owner = await signup(request, "validationowner");
    const invalidBodies = ["{", [], null, {}, { name: 123 }, { name: "ab" }, { name: "a".repeat(22) }, { name: "no-dash" }, { name: "slash/name" }, { name: "cafe\u00e9" }];
    const before = snapshot(databasePath);
    for (const body of invalidBodies) {
      const response = await requestJson(request, "/api/communities", "POST", body, owner.cookie);
      assert.equal(response.statusCode, 422);
      assert.deepEqual(snapshot(databasePath), before);
    }
  });
});

test("SCN-RC-03-H4 allows only owners to grant and revoke a non-owner moderator", async () => {
  await withApp(async ({ databasePath, request }) => {
    const owner = await signup(request, "roleowner");
    const moderator = await signup(request, "rolemoderator");
    const member = await signup(request, "rolemember");
    assert.equal((await requestJson(request, "/api/communities", "POST", { name: "role_room" }, owner.cookie)).statusCode, 201);
    for (const actor of [moderator, member]) {
      assert.equal((await requestJson(request, "/api/communities/role_room/members", "POST", {}, actor.cookie)).statusCode, 200);
    }
    const granted = await requestJson(request, "/api/communities/ROLE_ROOM/moderators", "PATCH", { username: moderator.account.username, moderator: true }, owner.cookie);
    assert.equal(granted.statusCode, 200);
    assert.deepEqual(await granted.json(), { community: { name: "role_room" }, membership: { username: moderator.account.username, role: "moderator" } });
    const revoked = await requestJson(request, "/api/communities/role_room/moderators", "PATCH", { username: moderator.account.username, moderator: false }, owner.cookie);
    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(await revoked.json(), { community: { name: "role_room" }, membership: { username: moderator.account.username, role: "member" } });
    const before = snapshot(databasePath);
    for (const actor of [moderator, member]) {
      const denied = await requestJson(request, "/api/communities/role_room/moderators", "PATCH", { username: member.account.username, moderator: true }, actor.cookie);
      assert.equal(denied.statusCode, 403);
      assert.deepEqual(snapshot(databasePath), before);
    }
  });
});

test("SCN-RC-03-H5 lets a member leave without deleting other state or retaining authority", async () => {
  await withApp(async ({ databasePath, request }) => {
    const owner = await signup(request, "leaveowner");
    const member = await signup(request, "leavemember");
    assert.equal((await requestJson(request, "/api/communities", "POST", { name: "leave_room" }, owner.cookie)).statusCode, 201);
    assert.equal((await requestJson(request, "/api/communities/leave_room/members", "POST", {}, member.cookie)).statusCode, 200);
    const leave = await request("/api/communities/leave_room/members/me", { method: "DELETE", headers: { cookie: member.cookie } });
    assert.equal(leave.statusCode, 204);
    assert.equal(await leave.text(), "");
    assert.deepEqual(snapshot(databasePath), {
      communities: [{ name: "leave_room" }],
      memberships: [{ community_name: "leave_room", username: owner.account.username, role: "owner" }],
    });
    assert.equal((await request("/api/communities/leave_room/modlog", { headers: { cookie: member.cookie } })).statusCode, 403);
  });
});

test("SCN-RC-03-H6 repeated and concurrent joins converge without downgrading roles", async () => {
  await withApp(async ({ databasePath, request }) => {
    const owner = await signup(request, "joinowner");
    const member = await signup(request, "joinmember");
    assert.equal((await requestJson(request, "/api/communities", "POST", { name: "join_room" }, owner.cookie)).statusCode, 201);
    const independent = createApp({ databasePath });
    try {
      const independentRequest = (path, options = {}) => independent.inject({ path, ...options });
      const joins = await Promise.all(Array.from({ length: 8 }, (_, index) => requestJson(
        index % 2 === 0 ? request : independentRequest,
        "/api/communities/join_room/members",
        "POST",
        {},
        member.cookie,
      )));
      for (const response of joins) {
        assert.equal(response.statusCode, 200);
        assert.deepEqual(await response.json(), { community: { name: "join_room" }, membership: { username: member.account.username, role: "member" } });
      }
    } finally {
      independent.close();
    }
    assert.deepEqual(snapshot(databasePath), {
      communities: [{ name: "join_room" }],
      memberships: [
        { community_name: "join_room", username: member.account.username, role: "member" },
        { community_name: "join_room", username: owner.account.username, role: "owner" },
      ],
    });
    const ownerJoin = await requestJson(request, "/api/communities/join_room/members", "POST", {}, owner.cookie);
    assert.equal(ownerJoin.statusCode, 200);
    assert.deepEqual((await ownerJoin.json()).membership, { username: owner.account.username, role: "owner" });
  });
});

test("SCN-RC-03-H7 limits moderator logs to current owners and moderators", async () => {
  await withApp(async ({ databasePath, request }) => {
    const owner = await signup(request, "logowner");
    const moderator = await signup(request, "logmoderator");
    const member = await signup(request, "logmember");
    assert.equal((await requestJson(request, "/api/communities", "POST", { name: "log_room" }, owner.cookie)).statusCode, 201);
    for (const actor of [moderator, member]) assert.equal((await requestJson(request, "/api/communities/log_room/members", "POST", {}, actor.cookie)).statusCode, 200);
    assert.equal((await requestJson(request, "/api/communities/log_room/moderators", "PATCH", { username: moderator.account.username, moderator: true }, owner.cookie)).statusCode, 200);
    const before = snapshot(databasePath);
    const forbidden = await request("/api/communities/log_room/modlog", { headers: { cookie: member.cookie } });
    assert.equal(forbidden.statusCode, 403);
    const forbiddenBody = await forbidden.text();
    assert.ok(!forbiddenBody.includes("entries"));
    assert.deepEqual(snapshot(databasePath), before);
    for (const actor of [owner, moderator]) {
      const allowed = await request("/api/communities/LOG_ROOM/modlog", { headers: { cookie: actor.cookie } });
      assert.equal(allowed.statusCode, 200);
      assert.deepEqual(await allowed.json(), { community: { name: "log_room" }, entries: [] });
    }
  });
});
