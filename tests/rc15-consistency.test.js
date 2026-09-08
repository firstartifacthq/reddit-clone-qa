import assert from "node:assert/strict";
import test from "node:test";
import { fixture, businessState } from "../tools/rc15-fixture.js";
import { participation, status } from "../tools/rc15-ledger.js";

test("AC-RC15-6A precommit failures roll back the complete connected business state", async t => {
  let fault;
  const hook = kind => () => { if (fault === kind) throw new Error("private injected fault marker"); };
  const f = await fixture(t, { schedulePrivacyWork: () => {}, beforeNotificationDelivery: hook("delivery"),
    beforePreferencePersist: hook("preference"), beforePrivacyAcceptance: hook("privacy") });
  const s = await participation(f);
  const cases = [
    ["delivery", `/api/posts/${s.posts[0].id}/comments`, "POST", { body: "atomic reply", parentId: s.root.id }, s.recipient, 201],
    ["delivery", `/api/posts/${s.posts[2].id}/vote`, "PUT", { value: 1 }, s.recipient, 200],
    ["delivery", `/api/mod/posts/${s.posts[1].id}`, "DELETE", undefined, s.owner, 204],
    ["preference", "/api/me/preferences", "PATCH", { theme: "light" }, s.recipient, 200],
    ["privacy", "/api/me", "DELETE", undefined, s.participant, 202],
  ];
  for (const [kind, path, method, body, user, success] of cases) {
    const before = businessState(f.app); fault = kind;
    const response = await f.request(path, method, body, user);
    assert.equal(response.status, 503, kind);
    assert.equal((await response.text()).includes("private injected"), false);
    assert.deepEqual(businessState(f.app), before, kind);
    fault = undefined;
    await status(f, path, method, body, user, success);
  }
  assert.deepEqual(await f.json(`/api/posts/${s.control.id}`), s.control);
});

test("AC-RC15-2B overlapping resource operations converge and votes admit a serial history", async t => {
  const f = await fixture(t);
  const s = await participation(f);
  await status(f, "/api/communities/journey/moderators", "PATCH", { username: s.recipient.username, role: "moderator" }, s.owner, 200);
  const postPath = `/api/posts/${s.posts[2].id}`;
  for (const [path, method, expected] of [["/api/communities/journey/members", "POST", [200]],
    [postPath + "/save", "PUT", [204]], [postPath + "/reports", "POST", [201, 409]]]) {
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.request(path, method, undefined, s.recipient)));
    for (const response of responses) { assert.ok(expected.includes(response.status)); await response.arrayBuffer(); }
    if (expected.includes(201)) assert.equal(responses.filter(r => r.status === 201).length, 1);
  }
  const db = f.app.database;
  assert.equal(db.prepare("SELECT role FROM community_memberships WHERE community_name='journey' AND user_id=?").get(s.recipient.id).role, "moderator");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM saved_posts WHERE post_id=? AND user_id=?").get(s.posts[2].id, s.recipient.id).n, 1);
  let clock = 0;
  const history = [];
  const assign = async value => {
    const call = { value, invoked: ++clock }; history.push(call);
    if (value === null) await status(f, postPath + "/vote", "DELETE", undefined, s.recipient, 204);
    else call.result = await f.json(postPath + "/vote", "PUT", { value }, s.recipient);
    call.completed = ++clock;
  };
  await Promise.all([assign(1), assign(-1), assign(null)]);
  await assign(-1);
  await Promise.all([assign(null), assign(1)]);
  const final = await f.json(postPath + "/vote", "GET", undefined, s.recipient);
  // Exhaust the small history, respecting real-time precedence rather than assuming arrival order.
  function serial(remaining, done = [], value = null) {
    if (!remaining.length) return final.value === value;
    return remaining.some(call => {
      if (remaining.some(other => other !== call && other.completed < call.invoked)) return false;
      if (call.value !== null && (call.result.value !== call.value || call.result.score !== call.value || call.result.authorKarma !== call.value)) return false;
      return serial(remaining.filter(other => other !== call), [...done, call], call.value);
    });
  }
  assert.equal(serial(history), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM post_votes WHERE post_id=? AND voter_user_id=?").get(s.posts[2].id, s.recipient.id).n, final.value === null ? 0 : 1);
  const notices = businessState(f.app).notifications;
  for (const { event_key: eventKey } of db.prepare("SELECT event_key FROM notification_events").all()) {
    const retries = await Promise.all(Array.from({ length: 4 }, () => f.app.retryNotificationDelivery({ eventKey })));
    assert.ok(retries.every(r => r.status === 204));
  }
  assert.deepEqual(businessState(f.app).notifications, notices);
  await f.restart();
  assert.deepEqual(await f.json(postPath + "/vote", "GET", undefined, s.recipient), final);
  assert.deepEqual(businessState(f.app).notifications, notices);
  assert.deepEqual(await f.json(`/api/posts/${s.control.id}`), s.control);
});

test("AC-RC15-6B response loss reconciles committed identities without resurrecting authority", async t => {
  const administrators = new Set();
  const f = await fixture(t, { schedulePrivacyWork: () => {}, administratorAuthority: actor => administrators.has(actor.id) });
  const s = await participation(f); administrators.add(s.owner.id);
  const lose = async (path, method, body, user, headers) => {
    f.loseNextResponse(path);
    await assert.rejects(f.request(path, method, body, user, headers), /fetch failed/);
  };
  const path = "/api/communities/journey/posts";
  const body = { type: "text", title: "uncertain committed creation", text: "one durable identity" };
  const headers = { "idempotency-key": "lost-create" };
  await lose(path, "POST", body, s.participant, headers);
  const retained = f.app.database.prepare("SELECT id FROM posts WHERE title=?").all(body.title);
  assert.equal(retained.length, 1);
  const post = await f.json(path, "POST", body, s.participant, 201, headers);
  assert.equal(post.id, retained[0].id);
  const votePath = `/api/posts/${post.id}/vote`;
  await lose(votePath, "PUT", { value: 1 }, s.recipient);
  const afterVote = businessState(f.app);
  assert.equal((await f.json(votePath, "PUT", { value: 1 }, s.recipient)).score, 1);
  assert.deepEqual(businessState(f.app), afterVote);
  const modPath = `/api/mod/posts/${post.id}`;
  await lose(modPath, "DELETE", undefined, s.owner);
  const afterRemove = businessState(f.app);
  await status(f, modPath, "DELETE", undefined, s.owner, 204);
  assert.deepEqual(businessState(f.app), afterRemove);
  await lose("/api/me/export", "POST", undefined, s.participant);
  const afterExport = businessState(f.app);
  const job = await f.json("/api/me/export", "POST", undefined, s.participant, 202);
  assert.ok(job.jobId); assert.deepEqual(businessState(f.app), afterExport);
  await lose("/api/me", "DELETE", undefined, s.participant);
  const afterDeletion = businessState(f.app);
  await f.json("/api/me", "DELETE", undefined, s.participant, 401);
  const deletion = await f.json("/api/admin/users/delete", "POST", { userId: s.participant.id }, s.owner, 202);
  assert.ok(deletion.jobId); assert.deepEqual(businessState(f.app), afterDeletion);
  await f.restart(); f.app.drainPrivacy();
  assert.equal((await f.json(`/api/admin/users/delete/${deletion.jobId}`, "GET", undefined, s.owner)).state, "completed");
  assert.deepEqual(await f.json(`/api/posts/${s.control.id}`), s.control);
});
