import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

async function signup(app, username) {
  const response = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username, password: "privacy-pass-123" }) });
  return { account: await response.json(), cookie: response.headers.get("set-cookie").split(";")[0] };
}
test("AC-RC13-1 owner-bound export accepts once and has stable status", async () => {
  const work = []; const app = createApp({ databasePath: ":memory:", schedulePrivacyWork: (run) => work.push(run) });
  const alice = await signup(app, "alice"); const bob = await signup(app, "bobby");
  const first = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: alice.cookie } });
  assert.equal(first.statusCode, 202); const job = await first.json();
  const repeat = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie: alice.cookie } });
  assert.deepEqual(await repeat.json(), job);
  const foreign = await app.inject({ method: "GET", path: `/api/me/export/jobs/${job.jobId}`, headers: { cookie: bob.cookie } });
  assert.equal(foreign.statusCode, 404);
  work.at(-1)(); const owner = await app.inject({ method: "GET", path: `/api/me/export/jobs/${job.jobId}`, headers: { cookie: alice.cookie } });
  assert.deepEqual(await owner.json(), { jobId: job.jobId, operation: "export", state: "completed" }); app.close();
});
