import test from "node:test";
import assert from "node:assert/strict";
import * as appModule from "../../src/app.js";
import { AuthService, escapeHtml, hashPassword, normalizeIdentifier, SqliteAuthStore, tokenHash, validateRegistration, verifyPassword } from "../../src/app.js";

test("authentication policy has one service boundary", () => {
  assert.equal(typeof AuthService.prototype.register, "function");
  assert.equal(typeof AuthService.prototype.signIn, "function");
  assert.equal("MemoryAuthStore" in appModule, false);
  for (const workflow of ["register", "signIn", "createRegistration", "createSignInOperation", "retryOperation"]) {
    assert.equal(Object.hasOwn(SqliteAuthStore.prototype, workflow), false);
  }
});

test("normalization, validation, escaping and one-way passwords have stable boundaries", async () => {
  assert.equal(normalizeIdentifier(" User_Name "), "user_name");
  assert.deepEqual(validateRegistration("bad!", "short"), { identifier: "Identifier must contain 3-24 letters, numbers, or underscores.", password: "Password must contain 12-128 characters." });
  assert.equal(escapeHtml('<script>'), "&lt;script&gt;");
  const record = await hashPassword("valid-password", "a".repeat(32));
  assert.notEqual(record, "valid-password");
  assert.equal(await verifyPassword("valid-password", record), true);
  assert.equal(await verifyPassword("wrong-password", record), false);
  assert.notEqual(tokenHash("a"), "a");
});
