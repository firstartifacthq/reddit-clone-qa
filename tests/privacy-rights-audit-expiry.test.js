import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/server.js";
import { request, signup } from "../tools/rc14-fixture.js";

const lifetime = 86_400_000;

async function auditFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-audit-expiry-"));
  const administrators = new Set();
  let now = 1000;
  let app; let server; let origin;
  async function close() {
    if (server) await new Promise(resolve => server.close(resolve));
    app?.close();
  }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  async function open() {
    app = createApp({
      databasePath: join(directory, "state.sqlite"), now: () => now,
      sessionLifetimeMs: 3 * lifetime,
      administratorAuthority: account => administrators.has(account.id),
      // Retain accepted jobs without unrelated worker transitions during clock jumps.
      schedulePrivacyWork: () => {},
    });
    server = createHttpServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  await open();
  return {
    administrators,
    request: (...args) => request(origin, ...args),
    setTime: value => { now = value; },
    restart: async () => { await close(); await open(); },
    state: () => Object.fromEntries([
      "privacy_jobs", "privacy_job_events", "privacy_export_payloads",
      "privacy_deletion_progress", "privacy_audit_traversals", "privacy_audit_tokens",
    ].map(table => [table, app.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  };
}

async function page(f, cookie, query = "") {
  const response = await f.request(`/api/admin/audit${query ? "?" + query : ""}`, "GET", undefined, cookie);
  return { status: response.status, body: await response.json() };
}

async function acceptExport(f, cookie) {
  const response = await f.request("/api/me/export", "POST", undefined, cookie);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).state, "pending");
}

test("AC-RC15-2B/2C audit expiry is exclusive, durable, limit-independent and recoverable", async t => {
  const f = await auditFixture(t);
  const admin = await signup(f.request, "expiry-admin");
  const owner = await signup(f.request, "expiry-owner");
  f.administrators.add(admin.account.id);
  assert.deepEqual(await page(f, admin.cookie, "limit=1"), { status: 200, body: { events: [], nextCursor: null } });
  await acceptExport(f, admin.cookie);
  await acceptExport(f, owner.cookie);
  const first = await page(f, admin.cookie, "limit=1");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.events.map(event => event.sequence), [1]);
  assert.ok(first.body.nextCursor);
  const continuation = `cursor=${first.body.nextCursor}`;
  const traversal = f.state().privacy_audit_traversals.at(-1);
  assert.equal(traversal.expires_at, 1000 + lifetime);

  const later = await signup(f.request, "expiry-later");
  await acceptExport(f, later.cookie);
  const expected = (await page(f, admin.cookie, `limit=1&${continuation}`)).body;
  assert.deepEqual(expected.events.map(event => event.sequence), [2]);
  assert.equal(expected.events[0].occurredAt, first.body.events[0].occurredAt);
  assert.ok(expected.nextCursor, "an exact page retains the baseline terminal continuation");
  assert.deepEqual(await page(f, admin.cookie, `limit=1&cursor=${expected.nextCursor}`), {
    status: 200, body: { events: [], nextCursor: null },
  });

  f.setTime(traversal.expires_at - 1);
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    for (let limit = 1; limit <= 100; limit++) {
      const result = await page(f, admin.cookie, `limit=${limit}&${continuation}`);
      assert.equal(result.status, 200, `pre-expiry limit=${limit}, restart=${restart}`);
      assert.deepEqual(result.body.events, expected.events, "later inserts stay outside the retained snapshot");
      assert.equal(result.body.nextCursor, limit === 1 ? expected.nextCursor : null);
    }
  }
  const beforeExpiry = f.state();
  for (const offset of [0, 1]) {
    f.setTime(traversal.expires_at + offset);
    for (const restart of [false, true]) {
      if (restart) await f.restart();
      for (let limit = 1; limit <= 100; limit++) {
        assert.deepEqual(await page(f, admin.cookie, `limit=${limit}&${continuation}`), {
          status: 422, body: { error: "Invalid request" },
        }, `expiry offset=${offset}, limit=${limit}, restart=${restart}`);
      }
      assert.deepEqual(f.state(), beforeExpiry, "expired lookups neither renew traversals nor change privacy state");
    }
  }

  const fresh = await page(f, admin.cookie, "limit=1");
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.nextCursor, first.body.nextCursor);
  const events = [...fresh.body.events];
  let cursor = fresh.body.nextCursor;
  while (cursor) {
    const next = await page(f, admin.cookie, `limit=1&cursor=${cursor}`);
    assert.equal(next.status, 200);
    events.push(...next.body.events);
    cursor = next.body.nextCursor;
  }
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.equal(new Set(events.map(event => event.id)).size, 3);
  const afterFresh = f.state();
  await f.restart();
  assert.deepEqual(await page(f, admin.cookie, `limit=1&${continuation}`), {
    status: 422, body: { error: "Invalid request" },
  });
  assert.deepEqual(f.state(), afterFresh);
  for (const table of ["privacy_jobs", "privacy_job_events", "privacy_export_payloads", "privacy_deletion_progress"]) {
    assert.deepEqual(afterFresh[table], beforeExpiry[table]);
  }
});

test("AC-RC15-3/4 audit validation preserves current authority and non-disclosing errors", async t => {
  const f = await auditFixture(t);
  const admin = await signup(f.request, "authority-admin");
  const other = await signup(f.request, "authority-other");
  const ordinary = await signup(f.request, "authority-ordinary");
  f.administrators.add(admin.account.id);
  f.administrators.add(other.account.id);
  await acceptExport(f, ordinary.cookie);
  const first = await page(f, admin.cookie, "limit=1");
  const query = `limit=1&cursor=${first.body.nextCursor}`;
  assert.ok(first.body.nextCursor);
  const before = f.state();
  const invalidQueries = [
    "unknown=1", "limit=1&limit=1", "cursor=abcdefgh&cursor=abcdefgh",
    "limit=0", "limit=101", "limit=-1", "limit=01", "limit=1.0",
    "limit=1e0", "limit=+1", "limit=%201", "limit=", "cursor=",
    "cursor=short", "cursor=bad%2Fcursor", `cursor=${"a".repeat(129)}`, "cursor=unknown_cursor",
  ];
  for (const invalid of invalidQueries) {
    assert.deepEqual(await page(f, admin.cookie, invalid), { status: 422, body: { error: "Invalid request" } }, invalid);
    assert.deepEqual(await page(f, ordinary.cookie, invalid), { status: 403, body: { error: "Forbidden" } });
    assert.deepEqual(await page(f, undefined, invalid), { status: 401, body: { error: "Authentication required" } });
  }
  assert.deepEqual(await page(f, other.cookie, query), { status: 422, body: { error: "Invalid request" } });
  f.administrators.delete(admin.account.id);
  assert.deepEqual(await page(f, admin.cookie, query), { status: 403, body: { error: "Forbidden" } });
  assert.deepEqual(f.state(), before, "rejections leave all privacy state unchanged");
  f.administrators.add(admin.account.id);
  assert.equal((await page(f, admin.cookie, query)).status, 200);
  const defaultPage = await page(f, admin.cookie);
  const explicitPage = await page(f, admin.cookie, "limit=50");
  assert.equal(defaultPage.status, 200);
  assert.deepEqual(defaultPage, explicitPage);
  assert.equal((await f.request("/api/auth/logout", "POST", undefined, admin.cookie)).status, 204);
  assert.deepEqual(await page(f, admin.cookie, query), { status: 401, body: { error: "Authentication required" } });
  f.setTime(1000 + 3 * lifetime);
  assert.deepEqual(await page(f, other.cookie, query), { status: 401, body: { error: "Authentication required" } });
});
