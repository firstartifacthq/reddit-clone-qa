import assert from "node:assert/strict";
import test from "node:test";
import { summarize, validFeed } from "../tools/rc14-load.js";

function population() {
  return { durationMs: 300000, concurrency: 100, issued: 100,
    perUser: Array(100).fill(1), outcomes: Array.from({ length: 100 }, (_, user) => ({ user, latencyMs: 1, ok: true })) };
}
test("measurement uses nearest rank, all outcomes, and strict thresholds", () => {
  const run = population();
  assert.equal(summarize(run).passed, true);
  run.outcomes[99].ok = false;
  assert.equal(summarize(run).failureRate, 0.01);
  assert.equal(summarize(run).passed, false);
  run.outcomes[99].ok = true;
  run.outcomes.slice(94).forEach((outcome) => { outcome.latencyMs = 750; });
  assert.equal(summarize(run).p95Ms, 750);
  assert.equal(summarize(run).passed, false);
  run.outcomes.slice(94).forEach((outcome) => { outcome.latencyMs = 749.999; });
  assert.equal(summarize(run).passed, true);
});
test("missing tail, shortened interval, invalid concurrency and invalid latencies fail closed", () => {
  for (const change of [r => r.outcomes.pop(), r => r.durationMs = 299999, r => r.concurrency = 99,
    r => r.perUser[0] = 0, r => r.outcomes[0].latencyMs = NaN, r => r.outcomes[0].latencyMs = -1]) {
    const run = population(); change(run); assert.throws(() => summarize(run));
  }
});
test("HTTP 200 alone is not an authorized feed success", () => {
  assert.equal(validFeed(200, '{"posts":[],"nextCursor":null}', []), true);
  const expectedPost = { id: 'mine', community: 'alpha', author: 'load-owner', type: 'text', title: 'alpha-eligibility', text: 'alpha-content' };
  const expected = [expectedPost];
  assert.equal(validFeed(200, JSON.stringify({ posts: expected, nextCursor: null }), expected), true);
  assert.equal(validFeed(200, JSON.stringify({ posts: [{ ...expectedPost, text: 'wrong content' }], nextCursor: null }), expected), false);
  for (const [status, body, expected] of [[503, '{}', []], [200, 'not-json', []], [200, '{}', []],
    [200, '{"posts":[{"id":"other"}],"nextCursor":null}', ['mine']],
    [200, '{"posts":[{"id":"mine"},{"id":"mine"}],"nextCursor":null}', ['mine']]]) {
    assert.equal(validFeed(status, body, expected), false);
  }
});
