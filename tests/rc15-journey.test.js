import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../tools/rc15-fixture.js";
import { participation } from "../tools/rc15-ledger.js";

test("AC-RC15-1 connected HTTP participation retains the same ledger across reopen", async t => {
  const f = await fixture(t);
  const ledger = await participation(f);
  const before = await ledger.observe();
  await f.restart();
  assert.deepEqual(await ledger.observe(), before);
});
