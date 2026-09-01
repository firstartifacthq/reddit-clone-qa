import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const credentials = { username: "riverstone", password: "correct-horse-battery" };

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-auth-"));
  let now = 1_700_000_000_000;
  const app = createApp({ databasePath: join(directory, "auth.sqlite"), now: () => now, ...options });
  try {
    await run({
      app,
      advance: (milliseconds) => { now += milliseconds; },
      request: (path, options = {}) => app.inject({ path, ...options }),
    });
  } finally {
    app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "an authenticated response sets a cookie");
  assert.match(cookie, /HttpOnly/i);
  return cookie.split(";", 1)[0];
}

function safeAccount(body) {
  assert.deepEqual(Object.keys(body).sort(), ["id", "username"]);
  assert.equal(body.username, credentials.username);
}

function safeOwnerProfile(body) {
  assert.deepEqual(Object.keys(body).sort(), ["bio", "id", "revision", "username"]);
  assert.equal(body.username, credentials.username);
  assert.equal(body.bio, "");
  assert.equal(body.revision, 0);
}

async function json(path, body, cookie) {
  return {
    path,
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify(body),
  };
}

test("H1 valid signup and login establish a reload-stable shell", async () => {
  await withApp(async ({ request }) => {
    const signup = await request("/api/auth/signup", await json("/api/auth/signup", credentials));
    assert.equal(signup.statusCode, 201);
    const signupBody = await signup.json();
    safeAccount(signupBody);
    const signupCookie = cookieFrom(signup);
    const signupMe = await request("/api/me", { headers: { cookie: signupCookie } });
    assert.equal(signupMe.statusCode, 200);
    safeOwnerProfile(await signupMe.json());
    assert.match(await (await request("/", { headers: { cookie: signupCookie } })).text(), /Account/);

    const login = await request("/api/auth/login", await json("/api/auth/login", credentials));
    assert.equal(login.statusCode, 200);
    safeAccount(await login.json());
    const loginCookie = cookieFrom(login);
    const loginMe = await request("/api/me", { headers: { cookie: loginCookie } });
    assert.equal(loginMe.statusCode, 200);
    safeOwnerProfile(await loginMe.json());
    assert.match(await (await request("/", { headers: { cookie: loginCookie } })).text(), /Account/);

    for (const response of [signup, login, signupMe, loginMe]) {
      const body = await response.text();
      assert.ok(!body.includes(credentials.password));
      assert.ok(!body.includes(signupCookie.split("=", 2)[1]));
      assert.ok(!body.includes(loginCookie.split("=", 2)[1]));
    }
  });
});

test("H2 expired sessions lose authority and retain recovery", async () => {
  await withApp(async ({ request, advance }) => {
    const signup = await request("/api/auth/signup", await json("/api/auth/signup", credentials));
    const cookie = cookieFrom(signup);
    advance(1_001);
    const me = await request("/api/me", { headers: { cookie } });
    assert.equal(me.statusCode, 401);
    assert.deepEqual(await me.json(), { error: "Authentication required" });
    const shell = await request("/", { headers: { cookie } });
    assert.equal(shell.statusCode, 200);
    const body = await shell.text();
    assert.match(body, /Sign in/);
    assert.match(body, /Try again/);
    assert.ok(!body.includes(credentials.username));
  }, { sessionLifetimeMs: 1_000 });
});

test("H3 invalid credentials are bounded and indistinguishable", async () => {
  await withApp(async ({ request }) => {
    await request("/api/auth/signup", await json("/api/auth/signup", credentials));
    const wrong = await request("/api/auth/login", await json("/api/auth/login", { ...credentials, password: "wrong-password" }));
    const unknown = await request("/api/auth/login", await json("/api/auth/login", { username: "unknown-user", password: credentials.password }));
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
    assert.equal(wrong.headers.get("set-cookie"), null);
    assert.equal(unknown.headers.get("set-cookie"), null);
    assert.equal((await request("/api/me")).statusCode, 401);
  });
});

test("H4 anonymous access preserves the public boundary", async () => {
  await withApp(async ({ request }) => {
    for (const headers of [{}, { cookie: "reddit_session=malformed" }]) {
      const me = await request("/api/me", { headers });
      assert.equal(me.statusCode, 401);
      assert.deepEqual(await me.json(), { error: "Authentication required" });
    }
    const shell = await request("/");
    assert.equal(shell.statusCode, 200);
    const shellBody = await shell.text();
    for (const label of ["Sign up", "Sign in", "Communities"]) assert.match(shellBody, new RegExp(label));
    const communities = await request("/api/communities");
    assert.equal(communities.statusCode, 200);
    assert.deepEqual(await communities.json(), { communities: [] });
  });
});

test("H5 logout revokes retained cookies", async () => {
  await withApp(async ({ request }) => {
    const signup = await request("/api/auth/signup", await json("/api/auth/signup", credentials));
    const cookie = cookieFrom(signup);
    const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie } });
    assert.equal(logout.statusCode, 204);
    assert.equal(await logout.text(), "");
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/i);
    const replay = await request("/api/me", { headers: { cookie } });
    assert.equal(replay.statusCode, 401);
    assert.deepEqual(await replay.json(), { error: "Authentication required" });
  });
});

test("H6 interrupted login is safely retryable", async () => {
  await withApp(async ({ request, app }) => {
    const signup = await request("/api/auth/signup", await json("/api/auth/signup", credentials));
    const original = await signup.json();
    await request("/api/auth/login", await json("/api/auth/login", credentials));
    const retry = await request("/api/auth/login", await json("/api/auth/login", credentials));
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(await retry.json(), original);
    const me = await request("/api/me", { headers: { cookie: cookieFrom(retry) } });
    assert.equal(me.statusCode, 200);
    safeOwnerProfile(await me.json());
    assert.equal(app.accountCount(), 1);
  });
});

test("H7 the complete route matrix exposes no reusable secret", async () => {
  await withApp(async ({ request }) => {
    const signup = await request("/api/auth/signup", await json("/api/auth/signup", credentials));
    const cookie = cookieFrom(signup);
    const responses = [
      signup,
      await request("/api/auth/login", await json("/api/auth/login", credentials)),
      await request("/api/auth/logout", { method: "POST", headers: { cookie } }),
      await request("/api/me"),
      await request("/"),
      await request("/api/communities"),
      await request("/api/debug/session"),
    ];
    for (const response of responses) {
      const body = await response.text();
      assert.ok(!body.includes(credentials.password));
      assert.ok(!body.includes(cookie.split("=", 2)[1]));
      if (response.headers.get("content-type")?.includes("application/json")) {
        const responseKeys = Object.keys(JSON.parse(body));
        assert.ok(!responseKeys.some((key) => /password|verifier|session/i.test(key)));
      }
    }
    assert.equal(responses.at(-1).statusCode, 404);
    assert.deepEqual(await (await request("/api/debug/session")).json(), { error: "Not found" });
  });
});
