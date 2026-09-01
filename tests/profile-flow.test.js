import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const password = "correct-horse-battery";

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-profile-"));
  let now = 1_700_000_000_000;
  const app = createApp({ databasePath: join(directory, "profile.sqlite"), now: () => now, ...options });
  try {
    await run({
      app,
      request: (path, request = {}) => app.inject({ path, ...request }),
    });
  } finally {
    app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "authentication response sets a cookie");
  return value.split(";", 1)[0];
}

async function requestJson(request, path, method, body, session) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function signup(request, username) {
  const response = await requestJson(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { body: await response.json(), cookie: cookie(response) };
}

async function owner(request, session) {
  const response = await request("/api/me", { headers: { cookie: session } });
  assert.equal(response.statusCode, 200);
  return response.json();
}

function assertOwner(value, username, bio = "", revision = 0) {
  assert.deepEqual(Object.keys(value).sort(), ["bio", "id", "revision", "username"]);
  assert.equal(value.username, username);
  assert.equal(value.bio, bio);
  assert.equal(value.revision, revision);
}

test("valid owner profile edit", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "RiverStone");
    assertOwner(await owner(request, account.cookie), "RiverStone");

    const edited = await requestJson(request, "/api/me", "PATCH", { username: "  river-renamed  ", bio: "first bio" }, account.cookie);
    assert.equal(edited.statusCode, 200);
    const editedOwner = await edited.json();
    assertOwner(editedOwner, "river-renamed", "first bio", 1);

    const bioOnly = await requestJson(request, "/api/me", "PATCH", { bio: "second bio" }, account.cookie);
    assert.equal(bioOnly.statusCode, 200);
    assertOwner(await bioOnly.json(), "river-renamed", "second bio", 2);

    const publicProfile = await request("/api/users/RIVER-RENAMED");
    assert.equal(publicProfile.statusCode, 200);
    assert.deepEqual(await publicProfile.json(), { id: editedOwner.id, username: "river-renamed", bio: "second bio" });
  });
});

test("username boundaries and conflicts", async () => {
  await withApp(async ({ request }) => {
    const primary = await signup(request, "primary-user");
    await signup(request, "TakenName");
    for (const username of ["abc", "a".repeat(32)]) {
      const response = await requestJson(request, "/api/me", "PATCH", { username }, primary.cookie);
      assert.equal(response.statusCode, 200);
    }
    const before = await owner(request, primary.cookie);
    for (const username of ["ab", "a".repeat(33)]) {
      const response = await requestJson(request, "/api/me", "PATCH", { username }, primary.cookie);
      assert.equal(response.statusCode, 422);
      assert.deepEqual(await response.json(), { error: "Invalid profile" });
      assert.deepEqual(await owner(request, primary.cookie), before);
    }
    const duplicate = await requestJson(request, "/api/me", "PATCH", { username: "takenname" }, primary.cookie);
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(await owner(request, primary.cookie), before);
  });
});

test("invalid profile bodies", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "valid-user");
    const before = await owner(request, account.cookie);
    const bodies = [
      "{not-json", null, [], "scalar", {}, { extra: "x" }, { bio: "ok", extra: "x" },
      { username: 2 }, { bio: 2 }, { username: "\u00a0valid-user" }, { bio: "\u{1F600}".repeat(501) },
    ];
    for (const body of bodies) {
      const response = await requestJson(request, "/api/me", "PATCH", body, account.cookie);
      assert.equal(response.statusCode, 422);
      assert.deepEqual(await response.json(), { error: "Invalid profile" });
      assert.deepEqual(await owner(request, account.cookie), before);
    }
    const clear = await requestJson(request, "/api/me", "PATCH", { bio: "" }, account.cookie);
    assert.equal(clear.statusCode, 200);
    assertOwner(await clear.json(), "valid-user", "", 1);
  });
});

test("profile mutation authorization", async () => {
  await withApp(async ({ request }) => {
    const target = await signup(request, "target-user");
    const other = await signup(request, "other-user");
    const before = await owner(request, target.cookie);
    const forbidden = await requestJson(request, "/api/users/target-user", "PATCH", { bio: "stolen" }, other.cookie);
    assert.equal(forbidden.statusCode, 403);
    const anonymous = await requestJson(request, "/api/users/target-user", "PATCH", { bio: "stolen" });
    assert.equal(anonymous.statusCode, 401);
    assert.deepEqual(await owner(request, target.cookie), before);
    assert.deepEqual(await (await request("/api/users/target-user")).json(), { id: before.id, username: before.username, bio: before.bio });
  });
});

test("accepted account deletion", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "departing-user");
    const secondLogin = await requestJson(request, "/api/auth/login", "POST", { username: "departing-user", password });
    const secondCookie = cookie(secondLogin);
    const deleted = await request("/api/me", { method: "DELETE", headers: { cookie: account.cookie } });
    assert.equal(deleted.statusCode, 202);
    assert.match(deleted.headers.get("set-cookie"), /Max-Age=0/i);
    const unknown = await request("/api/users/no-such-user");
    const hidden = await request("/api/users/departing-user");
    assert.equal(hidden.statusCode, 404);
    assert.deepEqual(await hidden.json(), await unknown.json());
    assert.deepEqual([...hidden.headers.keys()].sort(), [...unknown.headers.keys()].sort());
    for (const session of [account.cookie, secondCookie]) {
      assert.equal((await request("/api/me", { headers: { cookie: session } })).statusCode, 401);
      assert.equal((await requestJson(request, "/api/me", "PATCH", { bio: "no" }, session)).statusCode, 401);
    }
    const login = await requestJson(request, "/api/auth/login", "POST", { username: "departing-user", password });
    assert.equal(login.statusCode, 401);
    assert.equal(login.headers.get("set-cookie"), null);
    const signupReuse = await requestJson(request, "/api/auth/signup", "POST", { username: "DEPARTING-USER", password });
    assert.equal(signupReuse.statusCode, 409);
    const replacement = await signup(request, "replacement-user");
    const renameReuse = await requestJson(request, "/api/me", "PATCH", { username: "departing-user" }, replacement.cookie);
    assert.equal(renameReuse.statusCode, 409);
  });
});

test("account deletion failure rolls back and retry succeeds", async () => {
  await withApp(async ({ request, app }) => {
    const account = await signup(request, "recovering-user");
    const secondLogin = await requestJson(request, "/api/auth/login", "POST", { username: "recovering-user", password });
    const secondCookie = cookie(secondLogin);
    const before = await owner(request, account.cookie);
    const lifecycle = app.database.prepare("SELECT deletion_requested_at FROM users WHERE id = ?");
    const sessionState = app.database.prepare("SELECT COUNT(*) AS total, COUNT(revoked_at) AS revoked FROM sessions WHERE user_id = ?");

    // This can abort revocation only after the uncommitted deletion marker is visible.
    app.database.exec(`CREATE TRIGGER fail_session_revocation
      BEFORE UPDATE OF revoked_at ON sessions
      WHEN (SELECT deletion_requested_at FROM users WHERE id = NEW.user_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'transient'); END`);

    const failed = await request("/api/me", { method: "DELETE", headers: { cookie: account.cookie } });
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(await failed.json(), { error: "Profile service unavailable" });
    assert.equal(failed.headers.get("set-cookie"), null);
    assert.equal(lifecycle.get(account.body.id).deletion_requested_at, null);
    assert.equal(sessionState.get(account.body.id).total, 2);
    assert.equal(sessionState.get(account.body.id).revoked, 0);
    for (const session of [account.cookie, secondCookie]) assert.deepEqual(await owner(request, session), before);
    assert.deepEqual(await (await request("/api/users/RECOVERING-USER")).json(), {
      id: before.id, username: before.username, bio: before.bio,
    });

    app.database.exec("DROP TRIGGER fail_session_revocation");
    const retried = await request("/api/me", { method: "DELETE", headers: { cookie: account.cookie } });
    assert.equal(retried.statusCode, 202);
    assert.notEqual(lifecycle.get(account.body.id).deletion_requested_at, null);
    assert.equal(sessionState.get(account.body.id).total, 2);
    assert.equal(sessionState.get(account.body.id).revoked, 2);
    assert.equal((await request("/api/users/recovering-user")).statusCode, 404);
    for (const session of [account.cookie, secondCookie]) {
      assert.equal((await request("/api/me", { headers: { cookie: session } })).statusCode, 401);
      assert.equal((await request("/api/me", { method: "DELETE", headers: { cookie: session } })).statusCode, 401);
    }
  });
});

test("profile persistence failure and retry", async () => {
  await withApp(async ({ request, app }) => {
    const account = await signup(request, "retry-user");
    const before = await owner(request, account.cookie);
    app.database.exec("CREATE TRIGGER fail_one_profile_update BEFORE UPDATE OF bio ON users WHEN NEW.bio = 'retry bio' BEGIN SELECT RAISE(ABORT, 'transient'); END");
    const failed = await requestJson(request, "/api/me", "PATCH", { bio: "retry bio" }, account.cookie);
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(await failed.json(), { error: "Profile service unavailable" });
    assert.deepEqual(await owner(request, account.cookie), before);
    app.database.exec("DROP TRIGGER fail_one_profile_update");
    const retried = await requestJson(request, "/api/me", "PATCH", { bio: "retry bio" }, account.cookie);
    assert.equal(retried.statusCode, 200);
    assertOwner(await retried.json(), "retry-user", "retry bio", before.revision + 1);
  });
});

test("anonymous public profile privacy", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "visible-user");
    const ownerProfile = await owner(request, account.cookie);
    const active = await request("/api/users/VISIBLE-USER");
    assert.equal(active.statusCode, 200);
    assert.deepEqual(await active.json(), { id: ownerProfile.id, username: "visible-user", bio: "" });
    const missing = await request("/api/users/no-such-user");
    const malformed = await request("/api/users/%E0%A4%A");
    assert.equal(missing.statusCode, 404);
    assert.equal(malformed.statusCode, 404);
    assert.deepEqual(await missing.json(), await malformed.json());
    for (const response of [active, missing, malformed]) {
      const text = await response.text();
      assert.ok(!/password|salt|verifier|token|digest|email|deletion|revision/i.test(text));
      for (const header of response.headers.keys()) assert.doesNotMatch(header, /password|salt|verifier|token|digest|email|deletion|revision/i);
    }
  });
});
