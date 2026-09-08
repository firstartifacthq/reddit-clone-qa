import assert from "node:assert/strict";
import test from "node:test";
import { rename } from "node:fs/promises";
import { processFixture } from "../tools/rc14-process-fixture.js";
import { fixture, password } from "../tools/rc15-fixture.js";
import { participation } from "../tools/rc15-ledger.js";

for (const signal of ["SIGTERM", "SIGKILL"]) test(`AC-RC15-6 ${signal} preserves connected identities and controls`, async t => {
  const process = await processFixture();
  t.after(() => process.close());
  await process.start();
  const f = {
    request: (path, method, body, user) => process.request(path, method, body, user?.cookie),
    async json(path, method, body, user, expected = 200) {
      const response = await this.request(path, method, body, user);
      assert.equal(response.status, expected, path); return response.json();
    },
    async signup(username) {
      const response = await this.request("/api/auth/signup", "POST", { username, password });
      assert.equal(response.status, 201);
      return { ...await response.json(), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
    },
  };
  const ledger = await participation(f);
  const before = await ledger.observe();
  await process.stop(signal); await process.start();
  assert.deepEqual(await ledger.observe(), before);
});

test("AC-RC15-6/6C retained-path and write recovery preserves connected ledger without health-driven repair", async t => {
  const f = await fixture(t);
  const ledger = await participation(f);
  const before = await ledger.observe();
  for (const fault of ["write", "path"]) {
    if (fault === "write") f.app.database.exec("PRAGMA query_only=ON");
    else await rename(f.databasePath, f.databasePath + ".held");
    try { assert.equal((await f.request("/health/ready")).status, 503); }
    finally {
      if (fault === "write") f.app.database.exec("PRAGMA query_only=OFF");
      else await rename(f.databasePath + ".held", f.databasePath);
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(f.app.readiness.state, "ready");
    assert.deepEqual(await ledger.observe(), before);
  }
});
