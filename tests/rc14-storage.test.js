import assert from "node:assert/strict";
import test from "node:test";
import { chmod, rename } from "node:fs/promises";
import { fixture, signup, password } from "../tools/rc14-fixture.js";
import { openDatabase } from "../src/database.js";
import { createApp } from "../src/app.js";
import { createReadiness, durableCapability } from "../src/readiness.js";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function snapshot(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'operational_capability' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}
test("version 12 upgrade preserves populated rows and enforces the operational singleton", async () => {
  const f = await fixture();
  try {
    await signup(f.request, "migration-owner");
    f.app.readiness.close();
    const before = snapshot(f.app.database);
    f.app.database.exec("DROP TABLE operational_capability; PRAGMA user_version=12");
    f.app.close();
    const db = openDatabase(f.databasePath);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 13);
    for (const sql of ["INSERT INTO operational_capability VALUES (2,0)", "DELETE FROM operational_capability", "UPDATE operational_capability SET id=1", "UPDATE operational_capability SET pulse=2"]) assert.throws(() => db.exec(sql));
    db.exec("UPDATE operational_capability SET pulse=1");
    db.close();
    const valid = openDatabase(f.databasePath); valid.close();
    const damaged = openDatabase(f.databasePath);
    damaged.exec("DROP TRIGGER operational_capability_identity; CREATE TRIGGER operational_capability_identity BEFORE UPDATE OF id ON operational_capability BEGIN SELECT 1; END");
    damaged.close();
    assert.throws(() => openDatabase(f.databasePath), /readiness invariant/);
  } finally { await f.close(); }
});
test("fresh samples detect real query-only, directory write and retained-path loss without GET repairs", async () => {
  const f = await fixture();
  try {
    const owner = await signup(f.request, "storage-owner");
    assert.equal((await f.request("/health/ready")).status, 200);
    const before = snapshot(f.app.database);
    for (const kind of ["query-only", "directory", "path"]) {
      assert.equal((await f.request("/health/ready")).status, 200);
      if (kind === "query-only") f.app.database.exec("PRAGMA query_only=ON");
      if (kind === "directory") await chmod(f.directory, 0o500);
      if (kind === "path") await rename(f.databasePath, f.databasePath + ".retained");
      try {
        if (kind !== "path") {
          f.app.database.exec("BEGIN; ROLLBACK");
          assert.ok(f.app.database.prepare("SELECT id FROM users LIMIT 1").get());
          assert.throws(() => f.app.database.exec("UPDATE operational_capability SET pulse=1-pulse"), "fixture must actually prevent writes");
          const response = await f.request("/api/me", "PATCH", { bio: "must-not-commit" }, owner.cookie);
          assert.ok(response.status >= 500);
        }
        assert.equal((await f.request("/health/ready")).status, 503);
        assert.equal((await f.request("/health/ready")).status, 503);
        assert.deepEqual(snapshot(f.app.database), before);
      } finally {
        if (kind === "query-only") f.app.database.exec("PRAGMA query_only=OFF");
        if (kind === "directory") await chmod(f.directory, 0o700);
        if (kind === "path") await rename(f.databasePath + ".retained", f.databasePath);
      }
      await wait(550); // Recovery must occur without health polling.
      assert.equal(f.app.readiness.state, "ready");
      assert.equal((await f.request("/health/ready")).status, 200);
      assert.equal((await f.request("/api/feed/home", "GET", undefined, owner.cookie)).status, 200);
      assert.deepEqual(snapshot(f.app.database), before);
    }
  } finally { await chmod(f.directory, 0o700); await f.close(); }
});
test("observations never schedule or execute monitor work and cannot consume stale success", async () => {
  let tick; let schedules = 0; let commits = 0; let fail = false;
  const monitor = createReadiness({ check: () => { if (fail) throw new Error("commit failed private-canary"); commits++; },
    schedule: work => { schedules++; tick = work; return () => {}; } });
  assert.equal(await monitor.observe(), false);
  tick(); assert.equal(commits, 1);
  const counts = [schedules, commits];
  const observations = [monitor.observe(), monitor.observe()];
  assert.deepEqual([schedules, commits], counts);
  fail = true; tick();
  assert.deepEqual(await Promise.all(observations), [false, false]);
  assert.equal(commits, 1);
  fail = false; tick();
  const pending = monitor.observe(); monitor.close(); assert.equal(await pending, false);
  tick(); assert.equal(commits, 2);
});
test("real capability commit failure rolls back its pulse and fails closed", async () => {
  const f = await fixture();
  try {
    f.app.readiness.close();
    const db = f.app.database;
    const before = db.prepare("SELECT pulse FROM operational_capability").get().pulse;
    const check = durableCapability({ prepare: sql => db.prepare(sql), exec: sql => { if (sql === "COMMIT") throw new Error("fault"); db.exec(sql); } }, f.databasePath);
    assert.throws(check);
    assert.equal(db.prepare("SELECT pulse FROM operational_capability").get().pulse, before);
  } finally { await f.close(); }
});
test("capability failure never rolls back another transaction", async () => {
  const f = await fixture();
  try {
    f.app.readiness.close();
    const db = f.app.database;
    const before = db.prepare("SELECT pulse FROM operational_capability").get().pulse;
    db.exec("BEGIN IMMEDIATE; UPDATE operational_capability SET pulse=1-pulse");
    assert.throws(durableCapability(db, f.databasePath));
    assert.equal(db.prepare("SELECT pulse FROM operational_capability").get().pulse, 1 - before);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT pulse FROM operational_capability").get().pulse, before);
  } finally { await f.close(); }
});
test("mutation families reject BEGIN, statement and COMMIT loss with no partial state", async () => {
  const f = await fixture({ schedulePrivacyWork: () => {} });
  try {
    f.app.readiness.close();
    const owner = await signup(f.request, "atomic-owner");
    const other = await signup(f.request, "atomic-other");
    assert.equal((await f.request("/api/communities", "POST", { name: "atomic" }, owner.cookie)).status, 201);
    assert.equal((await f.request("/api/communities/atomic/members", "POST", undefined, other.cookie)).status, 200);
    const created = await f.request("/api/communities/atomic/posts", "POST", { type: "text", title: "retained", text: "retained" }, owner.cookie);
    const post = await created.json();
    for (let index = 0; index < 26; index++) {
      assert.equal((await f.request('/api/communities/atomic/posts', 'POST', { type: 'text', title: `page-${index}`, text: 'retained' }, owner.cookie)).status, 201);
    }
    assert.equal((await f.request(`/api/posts/${post.id}/comments`, 'POST', { body: 'u/atomic-owner retained notification' }, other.cookie)).status, 201);
    const notices = await (await f.request('/api/me/notifications', 'GET', undefined, owner.cookie)).json();
    const noticeId = notices.notifications[0].id;
    let fault;
    let triggered = false;
    const db = f.app.database;
    const adapter = { close() {}, exec(sql) {
      if (fault === sql) { triggered = true; throw new Error("durable fault"); } return db.exec(sql);
    }, prepare(sql) {
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        return (...args) => {
          if (fault === "statement" && /^(INSERT|UPDATE|DELETE)/i.test(sql.trim())) { triggered = true; throw new Error("durable fault"); }
          return value.apply(target, args);
        };
      } });
    } };
    const app = createApp({ database: adapter, schedulePrivacyWork: () => {} }); app.readiness.close();
    try {
      const cases = [
        ["POST", "/api/auth/signup", { username: "rejected-new", password }, undefined, true],
        ["POST", "/api/auth/login", { username: owner.account.username, password }, undefined, false],
        ["POST", "/api/auth/logout", undefined, other.cookie, false],
        ["PATCH", "/api/me", { bio: "rejected" }, owner.cookie, true],
        ["PUT", `/api/posts/${post.id}/save`, undefined, other.cookie, true],
        ["PATCH", "/api/me/preferences", { theme: "dark", compactMode: true }, other.cookie, true],
        ["PATCH", `/api/me/notifications/${noticeId}`, { read: true }, owner.cookie, true],
        ["DELETE", `/api/mod/posts/${post.id}`, undefined, owner.cookie, true],
        ["GET", "/api/feed/home", undefined, owner.cookie, true],
        ["POST", "/api/communities/atomic/posts", { type: "media", title: "rejected media", media: { filename: "local.png", contentType: "image/png", bytesBase64: Buffer.from([137,80,78,71,13,10,26,10,1,2,3]).toString('base64') } }, owner.cookie, true],
        ["POST", "/api/communities/atomic/posts", { type: "text", title: "rejected", text: "rejected" }, owner.cookie, true],
        ["POST", `/api/posts/${post.id}/comments`, { body: "rejected" }, other.cookie, true],
        ["PUT", `/api/posts/${post.id}/vote`, { value: 1 }, other.cookie, true],
        ["GET", `/api/posts/${post.id}`, undefined, other.cookie, true],
        ["POST", "/api/me/export", undefined, owner.cookie, true],
        ["DELETE", "/api/me", undefined, other.cookie, true],
      ];
      for (const [method, path, body, cookie, transaction] of cases) {
        for (const boundary of transaction ? ["BEGIN IMMEDIATE", "statement", "COMMIT"] : ["statement"]) {
          const before = snapshot(db); fault = boundary; triggered = false;
          const response = await app.inject({ method, path, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
          fault = undefined;
          assert.equal(triggered, true, `${method} ${path} reached ${boundary}`);
          assert.ok(response.statusCode >= 500, `${method} ${path} did not acknowledge ${boundary}`);
          assert.deepEqual(snapshot(db), before, `${method} ${path} rolled back ${boundary}`);
        }
      }
    } finally { app.close(); }
  } finally { await f.close(); }
});
