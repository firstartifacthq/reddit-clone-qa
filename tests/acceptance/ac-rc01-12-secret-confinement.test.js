import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createApp, MemoryAuthStore, tokenHash, verifyPassword } from "../../src/app.js";
import { fixture, form, register, sessionCookie } from "./helpers.js";

async function safeFailureServer(secret) {
  const store = new MemoryAuthStore();
  store.register = async () => { throw new Error(`internal failure ${secret}`); };
  const app = createApp({ store, origin: "http://127.0.0.1", secureCookies: true });
  const server = createServer((request, response) => app(request, response).catch(() => {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("The request could not be completed. Please retry.");
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    request: (path, init) => fetch(`${origin}${path}`, { redirect: "manual", ...init }),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("credential and session canaries remain confined across success, routing and persistence", async (t) => {
  const app = await fixture();
  t.after(app.close);
  const password = "confined-password-canary";
  const result = await register(app, "private_user", password);
  const cookie = sessionCookie(result.cookie);
  const token = cookie.slice("session=".length);

  assert.doesNotMatch(result.text, new RegExp(password));
  assert.doesNotMatch(result.text, new RegExp(token));
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /SameSite=Strict/);
  const account = [...app.store.accounts.values()][0];
  const persistedSession = [...app.store.sessions.values()][0];
  assert.notEqual(account.passwordHash, password);
  assert.equal(await verifyPassword(password, account.passwordHash), true);
  assert.equal(persistedSession.tokenHash, tokenHash(token));
  assert.notEqual(persistedSession.tokenHash, token);

  for (const path of ["/", "/about", "/account"]) {
    const page = await app.request(path, { headers: { cookie } });
    assert.doesNotMatch(page.text, new RegExp(`${password}|${token}|passwordHash|tokenHash`));
    assert.doesNotMatch(page.response.url, new RegExp(`${password}|${token}`));
  }
  for (const key of ["password", "credential", "token", "session", "secret"]) {
    const blocked = await app.request(`/?${key}=canary`);
    assert.equal(blocked.response.status, 404);
  }
  for (const path of ["/debug", "/sessions", "/api/sessions", "/account/debug", "/.env"]) {
    assert.equal((await app.request(path)).response.status, 404);
  }

  const operationOnly = await app.request("/account", { headers: { cookie: "session=operation-private_user-0001" } });
  assert.equal(operationOnly.response.status, 401);
  const noIntent = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ operationId: "operation-private_user-0001" })
  });
  assert.equal(noIntent.response.status, 422);
  assert.equal(app.store.accountCount(), 1);
  assert.equal(app.store.activeSessionCount(), 1);
});

test("client storage, cross-origin rejection and bounded failures expose no reusable secret", async (t) => {
  const source = await readFile(new URL("../../public/auth-client.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /localStorage|document\.cookie/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /operationId/);

  const app = await fixture();
  t.after(app.close);
  const denied = await app.request("/sign-in", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.invalid" },
    body: form({ identifier: "private_user", password: "cross-origin-secret", operationId: "cross-origin-operation-1" })
  });
  assert.equal(denied.response.status, 403);
  assert.doesNotMatch(denied.text, /cross-origin-secret|private_user/);

  const secret = "failure-password-canary";
  const failing = await safeFailureServer(secret);
  t.after(failing.close);
  const response = await failing.request("/register", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ identifier: "failure_user", password: secret, operationId: "failure-operation-0001" })
  });
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.match(text, /Please retry/);
  assert.doesNotMatch(text, new RegExp(secret));
  assert.doesNotMatch(text, /stack|Error:/);
  assert.match(response.headers.get("cache-control"), /no-store/);
});
