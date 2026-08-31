import test from "node:test";
import assert from "node:assert/strict";
import { fixture, register, sessionCookie } from "./helpers.js";

const invalidSessions = {
  missing: async () => "",
  malformed: async () => "session=%not-a-cookie-token%",
  unknown: async () => "session=unknown-session-token",
  expired: async (app) => {
    const result = await register(app);
    app.advance(60_001);
    return sessionCookie(result.cookie);
  },
  revoked: async (app) => {
    const result = await register(app);
    const cookie = sessionCookie(result.cookie);
    app.store.signOut(cookie.slice("session=".length));
    return cookie;
  },
  orphaned: async (app) => {
    const result = await register(app);
    app.persistence.database.exec("PRAGMA foreign_keys = OFF");
    app.persistence.database.prepare("DELETE FROM accounts WHERE canonical_identifier = ?").run("river_user");
    app.persistence.database.exec("PRAGMA foreign_keys = ON");
    return sessionCookie(result.cookie);
  }
};

for (const [name, arrange] of Object.entries(invalidSessions)) {
  test(`protected account denies a ${name} session before rendering account data`, async (t) => {
    const app = await fixture();
    t.after(app.close);
    const cookie = await arrange(app);
    const result = await app.request("/account", { headers: cookie ? { cookie } : {} });
    assert.equal(result.response.status, 401);
    assert.match(result.text, /Sign in required/);
    assert.match(result.text, /href="\/"[^>]*>Home/);
    assert.match(result.text, /href="\/about">About/);
    assert.match(result.text, /href="\/sign-in">Sign in/);
    assert.doesNotMatch(result.text, /Your account is ready|river_user|Signed in as/);
    if (cookie) assert.match(result.cookie, /Max-Age=0/);
  });
}
