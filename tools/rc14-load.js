import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { request as httpRequest, Agent } from "node:http";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { processFixture } from "./rc14-process-fixture.js";
import { seedFeeds } from "./rc14-fixture.js";

export function candidateDigest() {
  const hash = createHash("sha256");
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else { hash.update(file); hash.update(readFileSync(file)); }
    }
  }
  for (const path of ["src", "migrations", "tools", "tests"]) visit(path);
  for (const path of ["package.json", "package-lock.json"]) hash.update(readFileSync(path));
  return hash.digest("hex");
}
export function validFeed(status, text, expected) {
  try {
    const body = JSON.parse(text);
    return status === 200 && body.nextCursor === null && Array.isArray(body.posts) &&
      isDeepStrictEqual(body.posts, expected);
  } catch { return false; }
}
export function summarize({ durationMs, concurrency, issued, perUser, outcomes }) {
  assert.equal(durationMs, 300000);
  assert.equal(concurrency, 100);
  assert.equal(perUser.length, concurrency);
  assert.ok(perUser.every(count => Number.isSafeInteger(count) && count > 0));
  assert.equal(perUser.reduce((a, b) => a + b, 0), issued);
  assert.equal(outcomes.length, issued);
  assert.ok(issued > 0);
  const actualCounts = Array(concurrency).fill(0);
  for (const outcome of outcomes) {
    assert.ok(Number.isFinite(outcome.latencyMs) && outcome.latencyMs >= 0);
    assert.equal(typeof outcome.ok, "boolean");
    assert.ok(Number.isInteger(outcome.user) && outcome.user >= 0 && outcome.user < concurrency);
    actualCounts[outcome.user]++;
  }
  assert.deepEqual(actualCounts, perUser);
  const failed = outcomes.filter(outcome => !outcome.ok).length;
  const latencies = outcomes.map(outcome => outcome.latencyMs).sort((a, b) => a - b);
  const p95Ms = latencies[Math.ceil(0.95 * issued) - 1];
  return { durationMs, concurrency, issued, succeeded: issued - failed, failed, failureRate: failed / issued,
    latencyPopulation: latencies.length, percentile: "nearest-rank", p95Ms, perUser, outstanding: 0,
    passed: failed / issued < 0.01 && p95Ms < 750 };
}
function coreRequest(origin, user, agent) {
  const start = performance.now();
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      resolve({ ok, latencyMs: performance.now() - start });
    };
    const req = httpRequest(origin + "/api/feed/home", { agent, headers: { cookie: user.cookie } }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.once("end", () => finish(validFeed(res.statusCode, text, user.expected)));
      res.once("error", () => finish(false));
      res.once("aborted", () => finish(false));
    });
    const deadline = setTimeout(() => { req.destroy(); finish(false); }, 10000);
    req.once("error", () => finish(false)); req.end();
  });
}
export async function qualify() {
  const candidate = candidateDigest();
  const fixture = await processFixture();
  const agent = new Agent({ keepAlive: true, maxSockets: 100 });
  try {
    await fixture.start();
    const users = await seedFeeds(fixture.request);
    assert.equal(new Set(users.map(user => user.account.id)).size, 100);
    for (const user of users) assert.equal((await coreRequest(fixture.origin, user, agent)).ok, true);
    assert.equal((await fixture.request("/api/feed/home")).status, 401);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const durationMs = 300000;
    const perUser = Array(100).fill(0);
    const outcomes = [];
    let issued = 0;
    await Promise.all(users.map(async (user, index) => {
      while (performance.now() - start < durationMs) {
        issued++; perUser[index]++;
        outcomes.push({ user: index, ...await coreRequest(fixture.origin, user, agent) });
      }
    }));
    const elapsedThroughSettlementMs = performance.now() - start;
    assert.equal(candidateDigest(), candidate, "candidate changed during qualification");
    for (const user of users) {
      assert.equal((await fixture.request("/api/auth/logout", "POST", undefined, user.cookie)).status, 204);
      assert.equal((await fixture.request("/api/feed/home", "GET", undefined, user.cookie)).status, 401);
    }
    return { candidate, node: process.version, startedAt, elapsedThroughSettlementMs,
      ...summarize({ durationMs, concurrency: 100, perUser, outcomes, issued }) };
  } finally { agent.destroy(); await fixture.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error("qualification accepts no duration, concurrency or target overrides");
  const report = await qualify(); console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
