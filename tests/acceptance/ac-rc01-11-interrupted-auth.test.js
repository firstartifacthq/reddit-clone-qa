import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, SqliteAuthStore } from "../../src/app.js";
import { installAuthClient } from "../../public/auth-client.js";

async function durableFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "redditly-auth-"));
  const databasePath = join(directory, "auth.sqlite");
  let current = 1_000_000;
  let store = new SqliteAuthStore({
    databasePath,
    now: () => current,
    sessionLifetimeMs: options.sessionLifetimeMs ?? 60_000,
    random: options.random
  });
  const server = createServer((request, response) => {
    createApp({ store, origin: "http://127.0.0.1" })(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("The request could not be completed. Please retry.");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    get store() { return store; },
    origin,
    request: (path, init = {}) => fetch(`${origin}${path}`, { redirect: "manual", ...init }),
    advance: (milliseconds) => { current += milliseconds; },
    reconstruct: () => {
      store.close();
      store = new SqliteAuthStore({ databasePath, now: () => current, sessionLifetimeMs: options.sessionLifetimeMs ?? 60_000 });
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function browserClient({ action, identifier, password, fetchImpl }) {
  const values = { identifier, password, operationId: "" };
  const retry = { hidden: true, disabled: false };
  const submit = { disabled: false };
  const status = { hidden: true, textContent: "" };
  const fields = Object.entries(values).map(([name]) => ({
    name,
    disabled: false,
    get value() { return values[name]; },
    set value(value) { values[name] = value; },
    type: name === "password" ? "password" : "text"
  }));
  const form = {
    action,
    elements: fields,
    querySelector(selector) {
      if (selector === "[name=operationId]") return fields.find((field) => field.name === "operationId");
      if (selector === ".retry") return retry;
      if (selector === "[data-auth-status]") return status;
      if (selector === "button[type=submit]:not(.retry)") return submit;
      return null;
    },
    addEventListener() {}
  };
  const storageValues = new Map();
  const storage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
    removeItem: (key) => storageValues.delete(key)
  };
  const documentRef = { querySelector: (selector) => selector === ".auth-form" ? form : null };
  let rendered = "";
  const controller = installAuthClient({
    documentRef,
    storage,
    cryptoRef: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
    fetchRef: fetchImpl,
    replaceDocument: (html) => { rendered = html; }
  });
  return { controller, retry, status, values, storageValues, rendered: () => rendered };
}

function droppedFirstResponse(realFetch) {
  let requests = 0;
  const wrapped = async (...args) => {
    const response = await realFetch(...args);
    requests += 1;
    if (requests === 1) {
      await response.arrayBuffer();
      throw new TypeError("response interrupted");
    }
    wrapped.lastCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    return response;
  };
  wrapped.lastCookie = "";
  return wrapped;
}

function post(app, flow, values) {
  return app.request(`/${flow}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://127.0.0.1" },
    body: new URLSearchParams(values)
  });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startProductionServer(databasePath, port) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, DATABASE_PATH: databasePath, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("production server did not start")), 5_000);
    child.once("exit", (code) => reject(new Error(`production server exited with ${code}`)));
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Redditly listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return child;
}

async function stopProductionServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

for (const flow of ["register", "sign-in"]) {
  test(`interrupted ${flow} exposes Retry and converges through HTTP on one authority`, async (t) => {
    const app = await durableFixture();
    t.after(app.close);
    if (flow === "sign-in") {
      await app.store.register({ identifier: "retry_user", password: "valid-password", operationId: "seed-registration-0001" });
    }
    const before = app.store.activeSessionCount();
    const fetchImpl = droppedFirstResponse(fetch);
    const browser = browserClient({ action: `${app.origin}/${flow}`, identifier: "retry_user", password: "valid-password", fetchImpl });

    await browser.controller.submit();
    const retainedId = browser.values.operationId;
    assert.equal(browser.retry.hidden, false);
    assert.equal(browser.retry.disabled, false);
    assert.match(browser.status.textContent, /Retry/);
    assert.equal(browser.values.password, "valid-password");
    assert.equal(browser.storageValues.size, 1);
    const persistedMetadata = [...browser.storageValues.values()].join("");
    assert.doesNotMatch(persistedMetadata, /retry_user|valid-password/);

    await browser.controller.submit();
    assert.equal(browser.values.operationId, retainedId);
    assert.match(browser.rendered(), /data-auth-success/);
    const account = await app.request("/account", { headers: { cookie: fetchImpl.lastCookie } });
    assert.equal(account.status, 200);
    assert.match(await account.text(), /retry_user/);
    assert.equal(app.store.accountCount(), 1);
    assert.equal(app.store.activeSessionCount(), before + 1);
    assert.equal(browser.values.password, "");
    assert.equal(browser.storageValues.size, 0);
  });
}

test("durable transactions survive reconstruction and reject partial or duplicate authority", async (t) => {
  let issuanceCalls = 0;
  const app = await durableFixture({ random: (size) => {
    issuanceCalls += 1;
    if (issuanceCalls === 1) throw new Error("injected issuance failure");
    return Buffer.alloc(size, issuanceCalls);
  } });
  t.after(app.close);

  await assert.rejects(app.store.register({ identifier: "atomic_user", password: "valid-password", operationId: "atomic-operation-0001" }), /issuance failure/);
  assert.equal(app.store.accountCount(), 0);
  assert.equal(app.store.operationCount(), 0);
  assert.equal(app.store.activeSessionCount(), 0);

  const intent = { identifier: "durable_user", password: "valid-password", operationId: "durable-operation-0001" };
  const results = await Promise.all([app.store.register(intent), app.store.register(intent)]);
  assert.ok(results.every((result) => result.kind === "success"));
  assert.equal(app.store.accountCount(), 1);
  assert.equal(app.store.operationCount(), 1);
  assert.equal(app.store.activeSessionCount(), 1);
  app.reconstruct();
  assert.equal(app.store.accountCount(), 1);
  assert.equal(app.store.activeSessionCount(), 1);
});

test("production server reconstructs from its file-backed session authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "redditly-production-"));
  const databasePath = join(directory, "production.sqlite");
  const port = await unusedPort();
  let child = await startProductionServer(databasePath, port);
  t.after(async () => {
    await stopProductionServer(child);
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  const registered = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ identifier: "restart_user", password: "valid-password", operationId: "restart-operation-0001" })
  });
  const cookie = registered.headers.get("set-cookie").split(";")[0];
  assert.equal(registered.status, 200);
  assert.match(registered.headers.get("set-cookie"), /Secure/);
  assert.equal(existsSync(databasePath), true);

  await stopProductionServer(child);
  child = await startProductionServer(databasePath, port);
  const restored = await fetch(`${origin}/account`, { headers: { cookie } });
  assert.equal(restored.status, 200);
  assert.match(await restored.text(), /restart_user/);
});

test("HTTP retry requires matching intent and replaces expired authority", async (t) => {
  const app = await durableFixture({ sessionLifetimeMs: 10 });
  t.after(app.close);
  const intent = { identifier: "expiry_user", password: "valid-password", operationId: "expiry-operation-0001" };
  assert.equal((await post(app, "register", intent)).status, 200);
  app.advance(11);
  const replaced = await post(app, "register", intent);
  assert.equal(replaced.status, 200);
  assert.equal(app.store.activeSessionCount(), 1);

  const changed = await post(app, "register", { ...intent, identifier: "changed_user" });
  assert.equal(changed.status, 409);
  assert.match(await changed.text(), /cannot be retried/);
  const operationOnly = await post(app, "register", { identifier: "", password: "", operationId: intent.operationId });
  assert.equal(operationOnly.status, 422);
  assert.equal(app.store.accountCount(), 1);
  assert.equal(app.store.operationCount(), 1);
  assert.equal(app.store.activeSessionCount(), 1);
});
