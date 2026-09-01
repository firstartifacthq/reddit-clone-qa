import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

async function withApp(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-auth-"));
  let now = Date.UTC(2026, 0, 1);
  const app = await createApp({ databasePath: join(directory, "app.sqlite"), clock: () => now, ...options });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
    return { response, text: await response.text(), cookie: response.headers.get("set-cookie") };
  };
  try {
    await run({ app, request, setNow: (value) => { now = value; } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function json(body) {
  return JSON.stringify(body);
}

function sessionCookie(setCookie) {
  assert.match(setCookie ?? "", /HttpOnly/i);
  const match = /^reddit_session=[^;]+/.exec(setCookie ?? "");
  assert.ok(match, "expected a session cookie");
  return match[0];
}

function assertNoSecrets(value, secrets = []) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(content.includes(secret), false, `leaked ${secret}`);
  assert.doesNotMatch(content, /password(?:Hash|Verifier)|sessionId|tokenDigest/i);
}

const signupBody = { username: "alice", password: "correct horse battery staple" };

for (const [name, endpoint, expectedStatus] of [
  ["signup", "/api/auth/signup", 201],
  ["login", "/api/auth/login", 200],
]) {
  test(`SCN-RC-01-H1 ${name} establishes a reload-stable authenticated shell`, async () => {
    await withApp(async ({ request }) => {
      if (endpoint.endsWith("login")) {
        const seeded = await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: json(signupBody) });
        assert.equal(seeded.response.status, 201);
      }
      const body = endpoint.endsWith("login") ? { identifier: "ALICE", password: signupBody.password } : signupBody;
      const result = await request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: json(body) });
      assert.equal(result.response.status, expectedStatus);
      assert.deepEqual(JSON.parse(result.text), { account: { id: 1, username: "alice" } });
      const cookie = sessionCookie(result.cookie);
      const me = await request("/api/me", { headers: { cookie } });
      assert.equal(me.response.status, 200);
      assert.deepEqual(JSON.parse(me.text), { account: { id: 1, username: "alice" } });
      const shell = await request("/", { headers: { cookie } });
      assert.equal(shell.response.status, 200);
      assert.match(shell.text, /Signed in as alice/);
      assertNoSecrets([result.text, me.text, shell.text], [signupBody.password, cookie.split("=")[1]]);
    });
  });
}

test("SCN-RC-01-H2 expired sessions fail closed while the shell offers sign-in", async () => {
  await withApp(async ({ request, setNow }) => {
    const signup = await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: json(signupBody) });
    const cookie = sessionCookie(signup.cookie);
    setNow(Date.UTC(2026, 0, 1) + 61_000);
    const me = await request("/api/me", { headers: { cookie } });
    assert.equal(me.response.status, 401);
    assert.deepEqual(JSON.parse(me.text), { error: { code: "authentication_required", message: "Sign in to continue." } });
    const shell = await request("/", { headers: { cookie } });
    assert.equal(shell.response.status, 200);
    assert.match(shell.text, /Sign in/);
    assert.doesNotMatch(shell.text, /alice|Signed in as/);
  }, { sessionLifetimeMs: 60_000 });
});

test("SCN-RC-01-H3 incorrect and unknown logins are indistinguishable and unauthenticated", async () => {
  await withApp(async ({ request }) => {
    await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: json(signupBody) });
    const wrong = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: json({ identifier: "alice", password: "wrong password" }) });
    const unknown = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: json({ identifier: "nobody", password: "wrong password" }) });
    assert.equal(wrong.response.status, 401);
    assert.equal(unknown.response.status, 401);
    assert.equal(wrong.text, unknown.text);
    assert.deepEqual(
      [wrong.response.headers.get("content-type"), wrong.response.headers.get("cache-control"), wrong.cookie],
      [unknown.response.headers.get("content-type"), unknown.response.headers.get("cache-control"), unknown.cookie],
    );
    assert.equal(wrong.cookie, null);
    assert.equal(unknown.cookie, null);
    assertNoSecrets([wrong.text, unknown.text], ["alice", "nobody", "wrong password"]);
    assert.equal((await request("/api/me")).response.status, 401);
  });
});

test("authentication rejects malformed credentials without reflecting them or setting a cookie", async () => {
  await withApp(async ({ request }) => {
    const submitted = "do-not-reflect-this-value";
    const result = await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: json({ username: submitted, password: "short" }) });
    assert.equal(result.response.status, 400);
    assert.equal(result.cookie, null);
    assertNoSecrets(result.text, [submitted, "short"]);
  });
});

test("authentication bounds oversized request bodies without setting a cookie", async () => {
  await withApp(async ({ request }) => {
    const result = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json({ identifier: "a".repeat(17_000), password: "correct horse battery staple" }),
    });
    assert.equal(result.response.status, 401);
    assert.equal(result.cookie, null);
    assertNoSecrets(result.text, ["correct horse battery staple"]);
  });
});

test("SCN-RC-01-H4 anonymous access preserves public routes and denies account data", async () => {
  await withApp(async ({ request }) => {
    const [me, shell, communities] = await Promise.all([request("/api/me"), request("/"), request("/api/communities")]);
    assert.equal(me.response.status, 401);
    assert.equal(shell.response.status, 200);
    assert.equal(communities.response.status, 200);
    assert.deepEqual(JSON.parse(communities.text), { communities: [] });
    assert.match(shell.text, /Sign in/);
    assertNoSecrets([me.text, shell.text, communities.text]);
  });
});

test("SCN-RC-01-H5 logout revokes a copied cookie and clears the client cookie", async () => {
  await withApp(async ({ request }) => {
    const signup = await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: json(signupBody) });
    const copiedCookie = sessionCookie(signup.cookie);
    const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie: copiedCookie } });
    assert.equal(logout.response.status, 204);
    assert.equal(logout.text, "");
    assert.match(logout.cookie ?? "", /Max-Age=0/);
    assert.match(logout.cookie ?? "", /HttpOnly/i);
    const replay = await request("/api/me", { headers: { cookie: copiedCookie } });
    assert.equal(replay.response.status, 401);
    assert.doesNotMatch(replay.text, /account|alice/i);
  });
});

test("SCN-RC-01-H6 retrying an interrupted login creates no account effect", async () => {
  await withApp(async ({ app, request }) => {
    await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: json(signupBody) });
    await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: json({ identifier: "alice", password: signupBody.password }) });
    const retry = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: json({ identifier: "alice", password: signupBody.password }) });
    assert.equal(retry.response.status, 200);
    assert.equal(app.store.accountCount(), 1);
    assert.equal((await request("/api/me", { headers: { cookie: sessionCookie(retry.cookie) } })).response.status, 200);
  });
});

test("SCN-RC-01-H7 no route exposes credential or session material and debug is absent", async () => {
  await withApp(async ({ request }) => {
    const signup = await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: json(signupBody) });
    const cookie = sessionCookie(signup.cookie);
    const responses = [
      signup,
      await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: json({ identifier: "alice", password: signupBody.password }) }),
      await request("/api/me", { headers: { cookie } }),
      await request("/api/auth/logout", { method: "POST", headers: { cookie } }),
      await request("/"),
      await request("/api/communities"),
      await request("/api/debug/session"),
    ];
    assert.equal(responses.at(-1).response.status, 404);
    for (const response of responses) assertNoSecrets(response.text, [signupBody.password, cookie.split("=")[1]]);
    for (const response of responses.filter((entry) => entry.cookie)) assert.match(response.cookie, /HttpOnly/i);
  });
});
