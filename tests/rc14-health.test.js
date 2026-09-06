import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { fixture, signup } from "../tools/rc14-fixture.js";

function userState(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'operational_capability' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}
test("operational caller/body matrix is read-only, private and independent of storage", async () => {
  const f = await fixture({ administratorAuthority: account => account.username === "health-admin" });
  try {
    const member = await signup(f.request, "health-member");
    const admin = await signup(f.request, "health-admin");
    for (const degraded of [false, true]) {
      f.app.database.exec(`PRAGMA query_only=${degraded ? "ON" : "OFF"}`);
      for (const cookie of [undefined, member.cookie, admin.cookie]) {
        const before = userState(f.app.database);
        const health = await f.request("/health/ready", "GET", undefined, cookie);
        assert.equal(health.status, degraded ? 503 : 200);
        assert.deepEqual(await health.json(), { status: degraded ? "not-ready" : "ready" });
        assert.equal(health.headers.get("set-cookie"), null);
        for (const payload of [undefined, "{", '{"restart":true,"password":"private-canary"}']) {
          const result = await fetch(f.origin + "/health/ready", { method: "POST", headers: cookie ? { cookie } : {}, body: payload });
          assert.equal(result.status, 405); assert.equal(result.headers.get("allow"), "GET");
          assert.deepEqual(await result.json(), { error: "Method not allowed" });
          assert.equal(result.headers.get("set-cookie"), null);
        }
        const restart = await f.request("/debug/restart", "GET", undefined, cookie);
        assert.equal(restart.status, 404); assert.deepEqual(await restart.json(), { error: "Not found" });
        assert.deepEqual(userState(f.app.database), before);
      }
    }
    f.app.database.exec("PRAGMA query_only=OFF");
    assert.equal((await f.request("/health/ready")).status, 200);
    assert.equal((await f.request("/api/feed/home", "GET", undefined, member.cookie)).status, 200);
  } finally { await f.close(); }
});
test("POST health is refused before waiting for a body or resolving auth", async () => {
  const f = await fixture();
  try {
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(f.origin + "/health/ready", { method: "POST", headers: { "content-length": 99999999 } }, res => {
        resolve(res.statusCode); res.resume(); req.destroy();
      });
      req.setTimeout(1000, () => { req.destroy(); reject(new Error("waited for body")); });
      req.on("error", reject); req.flushHeaders();
    });
    assert.equal(response, 405);
    f.app.database.close();
    assert.equal((await f.app.inject({ method: "POST", path: "/health/ready", headers: { cookie: "reddit_session=aaaaaaaaaaaaaaaaaaaaaaaa" } })).statusCode, 405);
    assert.equal((await f.app.inject({ path: "/debug/restart", headers: { cookie: "reddit_session=aaaaaaaaaaaaaaaaaaaaaaaa" } })).statusCode, 404);
  } finally { await f.close(); }
});
