import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";

const password = "correct-horse-battery";

async function withApp(run) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-profile-"));
  let now = 1_700_000_000_000;
  const database = openDatabase(join(directory, "profile.sqlite"));
  const app = createApp({ database, now: () => now });
  try {
    await run({
      database,
      request: (path, options = {}) => app.inject({ path, ...options }),
      now: () => now,
    });
  } finally {
    app.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function requestJson(request, path, method, body, cookie) {
  return request(path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function cookieFrom(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";", 1)[0];
}

async function signup(request, username) {
  const response = await requestJson(request, "/api/auth/signup", "POST", { username, password });
  assert.equal(response.statusCode, 201);
  return { body: await response.json(), cookie: cookieFrom(response) };
}

async function owner(request, cookie) {
  const response = await request("/api/me", { headers: { cookie } });
  assert.equal(response.statusCode, 200);
  return response.json();
}

async function publicProfile(request, username) {
  return request(`/api/users/${encodeURIComponent(username)}`);
}

function assertOwner(body, expected) {
  assert.deepEqual(Object.keys(body).sort(), ["bio", "id", "revision", "username"]);
  assert.deepEqual(body, expected);
}

test("AC-RC02-1 updates owner and public profiles atomically", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "riverstone");
    const initial = await owner(request, account.cookie);
    assertOwner(initial, { id: account.body.id, username: "riverstone", bio: "", revision: 0 });

    const edit = await requestJson(request, "/api/me", "PATCH", { username: "river-stone", bio: "Hello, world" }, account.cookie);
    assert.equal(edit.statusCode, 200);
    assertOwner(await edit.json(), { id: account.body.id, username: "river-stone", bio: "Hello, world", revision: 1 });
    const visible = await publicProfile(request, "river-stone");
    assert.equal(visible.statusCode, 200);
    assert.deepEqual(await visible.json(), { id: account.body.id, username: "river-stone", bio: "Hello, world" });
    assert.equal((await publicProfile(request, "riverstone")).statusCode, 404);

    const bioOnly = await requestJson(request, "/api/me", "PATCH", { bio: "Second" }, account.cookie);
    assertOwner(await bioOnly.json(), { id: account.body.id, username: "river-stone", bio: "Second", revision: 2 });
  });
});

test("AC-RC02-2 enforces normalized username boundaries and preserves rejected state", async () => {
  await withApp(async ({ request }) => {
    const ownerAccount = await signup(request, "profile-owner");
    await signup(request, "TakenName");
    for (const [username, expected] of [[" abc ", 200], ["x".repeat(32), 200], ["ab", 422], ["x".repeat(33), 422], ["takenname", 409]]) {
      const before = await owner(request, ownerAccount.cookie);
      const response = await requestJson(request, "/api/me", "PATCH", { username }, ownerAccount.cookie);
      assert.equal(response.statusCode, expected);
      if (expected !== 200) {
        assert.deepEqual(await response.json(), expected === 409 ? { error: "Username unavailable" } : { error: "Invalid profile" });
        assert.deepEqual(await owner(request, ownerAccount.cookie), before);
      }
    }
  });
});

test("AC-RC02-3 rejects invalid patches without mutation", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "profile-owner");
    const initial = await owner(request, account.cookie);
    const invalidBodies = ["{", "null", "[]", "42", "{}", { other: "value" }, { bio: "ok", extra: true }, { username: 1 }, { bio: 1 }, { username: "not valid" }, { bio: "😀".repeat(501) }];
    for (const body of invalidBodies) {
      const response = await requestJson(request, "/api/me", "PATCH", body, account.cookie);
      assert.equal(response.statusCode, 422);
      assert.deepEqual(await response.json(), { error: "Invalid profile" });
      assert.deepEqual(await owner(request, account.cookie), initial);
    }
    const boundary = await requestJson(request, "/api/me", "PATCH", { bio: "😀".repeat(500) }, account.cookie);
    assert.equal(boundary.statusCode, 200);
  });
});

test("AC-RC02-4 restricts profile mutation to the active owner", async () => {
  await withApp(async ({ request }) => {
    const target = await signup(request, "target-user");
    const other = await signup(request, "other-user");
    const before = await owner(request, target.cookie);
    for (const [path, cookie, expected] of [["/api/me", undefined, 401], ["/api/users/target-user", undefined, 401], ["/api/users/target-user", other.cookie, 403]]) {
      const response = await requestJson(request, path, "PATCH", { bio: "not allowed" }, cookie);
      assert.equal(response.statusCode, expected);
      assert.deepEqual(await owner(request, target.cookie), before);
    }
  });
});

test("AC-RC02-5 deletion revokes sessions, hides profile, and reserves username", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "deleted-user");
    const login = await requestJson(request, "/api/auth/login", "POST", { username: "deleted-user", password });
    const secondCookie = cookieFrom(login);
    const deletion = await request("/api/me", { method: "DELETE", headers: { cookie: account.cookie } });
    assert.equal(deletion.statusCode, 202);
    assert.match(deletion.headers.get("set-cookie") || "", /Max-Age=0/i);
    const hidden = await publicProfile(request, "deleted-user");
    const unknown = await publicProfile(request, "unknown-user");
    assert.equal(hidden.statusCode, 404);
    assert.deepEqual(await hidden.json(), await unknown.json());
    for (const cookie of [account.cookie, secondCookie]) assert.equal((await request("/api/me", { headers: { cookie } })).statusCode, 401);
    assert.equal((await requestJson(request, "/api/me", "PATCH", { bio: "cannot restore" }, account.cookie)).statusCode, 401);
    const retry = await requestJson(request, "/api/auth/login", "POST", { username: "deleted-user", password });
    assert.equal(retry.statusCode, 401);
    assert.equal(retry.headers.get("set-cookie"), null);
    assert.equal((await requestJson(request, "/api/auth/signup", "POST", { username: "DELETED-USER", password })).statusCode, 409);
    const another = await signup(request, "another-user");
    assert.equal((await requestJson(request, "/api/me", "PATCH", { username: "deleted-user" }, another.cookie)).statusCode, 409);
  });
});

test("AC-RC02-6 rolls back pre-commit persistence failures and retries once", async () => {
  await withApp(async ({ database, request }) => {
    const account = await signup(request, "failure-user");
    const before = await owner(request, account.cookie);
    database.exec("CREATE TRIGGER fail_profile_update BEFORE UPDATE OF bio ON users BEGIN SELECT RAISE(FAIL, 'temporary failure'); END");
    const failed = await requestJson(request, "/api/me", "PATCH", { bio: "will retry" }, account.cookie);
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(await failed.json(), { error: "Profile service unavailable" });
    assert.deepEqual(await owner(request, account.cookie), before);
    database.exec("DROP TRIGGER fail_profile_update");
    const retry = await requestJson(request, "/api/me", "PATCH", { bio: "will retry" }, account.cookie);
    assertOwner(await retry.json(), { ...before, bio: "will retry", revision: before.revision + 1 });
  });
});

test("AC-RC02-7 exposes only the active public projection", async () => {
  await withApp(async ({ request }) => {
    const account = await signup(request, "public-user");
    await requestJson(request, "/api/me", "PATCH", { bio: "Public bio" }, account.cookie);
    const response = await publicProfile(request, "PUBLIC-USER");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await response.json(), { id: account.body.id, username: "public-user", bio: "Public bio" });
    for (const [name, value] of response.headers) assert.doesNotMatch(`${name}:${value}`, /password|salt|verifier|token|session|revision|deletion|email/i);
  });
});
