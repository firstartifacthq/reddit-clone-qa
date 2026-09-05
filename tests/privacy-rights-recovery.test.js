import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

test("AC-RC13-6 delayed and duplicate work complete a single durable job", async () => {
  const work = []; const app = createApp({ databasePath: ":memory:", schedulePrivacyWork: (run) => work.push(run) });
  const signed = await app.inject({ method: "POST", path: "/api/auth/signup", payload: JSON.stringify({ username: "recover", password: "privacy-pass-123" }) });
  const cookie = signed.headers.get("set-cookie").split(";")[0];
  const accepted = await app.inject({ method: "POST", path: "/api/me/export", headers: { cookie } }); const job = await accepted.json();
  assert.equal(accepted.statusCode, 202); work.at(-1)(); work.at(-1)();
  const events = app.database.prepare("SELECT action FROM privacy_job_events WHERE job_id=? ORDER BY occurrence_sequence").all(job.jobId).map((event) => event.action);
  assert.deepEqual(events, ["accepted", "completed"]); app.close();
});
