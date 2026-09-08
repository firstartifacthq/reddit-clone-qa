import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fixture, businessState, password } from "../tools/rc15-fixture.js";
import { participation, status } from "../tools/rc15-ledger.js";

test("AC-RC15-5/5A/5J populated moderation and author deletion retain identity and terminal boundaries", async t => {
  const f = await fixture(t);
  const s = await participation(f);
  const post = s.posts[2];
  const path = `/api/posts/${post.id}`;
  const root = await f.json(path + "/comments", "POST", { body: "media root marker" }, s.participant, 201);
  const reply = await f.json(path + "/comments", "POST", { body: "surviving reply", parentId: root.id }, s.recipient, 201);
  await f.json(path + "/vote", "PUT", { value: 1 }, s.recipient);
  await status(f, path + "/save", "PUT", undefined, s.recipient, 204);
  await f.json(path, "GET", undefined, s.recipient);
  const captures = [];
  for (const [route, user, key] of [["/api/feed/home", s.recipient, "posts"], [path + "/comments", s.recipient, "comments"],
    ["/api/me/saved", s.recipient, "posts"], ["/api/me/history", s.recipient, "history"]]) {
    const page = await f.json(route + "?limit=1", "GET", undefined, user);
    assert.ok(page.nextCursor); captures.push({ route: route + `?limit=1&cursor=${page.nextCursor}`, user, key });
  }
  const dependent = () => Object.fromEntries(["comments", "post_votes", "saved_posts", "post_history"].map(name => [name, businessState(f.app)[name]]));
  const before = dependent();
  for (let i = 0; i < 2; i++) await status(f, `/api/mod/posts/${post.id}`, "DELETE", undefined, s.owner, 204);
  for (const route of [path, path + "/media", path + "/comments", `/api/comments/${root.id}`]) await f.json(route, "GET", undefined, s.recipient, 404);
  for (const capture of captures) {
    const response = await f.request(capture.route, "GET", undefined, capture.user);
    if (capture.key === "comments") assert.equal(response.status, 404);
    else { assert.equal(response.status, 200); assert.equal((await response.text()).includes(post.title), false); }
  }
  const afterRemoval = businessState(f.app);
  for (const [route, method, body] of [[path + "/comments", "POST", { body: "refused" }], [path + "/vote", "PUT", { value: -1 }],
    [path + "/save", "PUT", undefined], [path + "/reports", "POST", undefined]]) await f.json(route, method, body, s.recipient, 404);
  assert.deepEqual(businessState(f.app), afterRemoval);
  // Notifications retain event references, not removed content payloads.
  const notices = await f.json("/api/me/notifications", "GET", undefined, s.participant);
  for (const marker of [post.title, root.body, reply.body]) assert.equal(JSON.stringify(notices).includes(marker), false);
  for (const notice of notices.notifications) assert.deepEqual(Object.keys(notice).sort(), ["eventAt", "id", "kind", "read", "relatedItem"]);
  assert.deepEqual(dependent(), before);
  for (let i = 0; i < 2; i++) await f.json(`/api/mod/posts/${post.id}/restore`, "POST", undefined, s.owner);
  assert.deepEqual(await f.json(path), post);
  assert.deepEqual((await f.json(path + "/comments")).comments, [root, reply]);
  assert.deepEqual(dependent(), before);
  assert.deepEqual((await f.json("/api/communities/journey/modlog", "GET", undefined, s.owner)).entries.map(e => e.action), ["removed", "restored"]);
  await status(f, `/api/comments/${root.id}`, "DELETE", undefined, s.participant, 204);
  const comments = (await f.json(path + "/comments")).comments;
  assert.deepEqual(comments, [{ id: root.id, postId: post.id, parentId: null, depth: 0, state: "deleted" }, reply]);
  await status(f, path, "DELETE", undefined, s.participant, 204);
  await f.json(`/api/mod/posts/${post.id}/restore`, "POST", undefined, s.owner, 404);
  await f.json(path, "GET", undefined, s.recipient, 404);
  assert.equal((await f.json("/api/me/saved", "GET", undefined, s.recipient)).posts.some(p => p.id === post.id), false);
  assert.equal((await f.json("/api/me/history", "GET", undefined, s.recipient)).history.some(h => h.post.id === post.id), false);
  assert.equal((await f.json(`/api/posts/${s.posts[0].id}/vote`, "GET", undefined, s.recipient)).authorKarma, 0);
  assert.deepEqual(await f.json(`/api/posts/${s.control.id}`), s.control);
});

test("AC-RC15-4/5B/5C/5D role transitions revoke retained authority without widening scope", async t => {
  const f = await fixture(t);
  const s = await participation(f);
  const rolePath = "/api/communities/journey/moderators";
  const role = (value, actor = s.owner, expected = 200) => status(f, rolePath, "PATCH", { username: s.recipient.username, role: value }, actor, expected);
  const memberships = () => businessState(f.app).community_memberships.map(row => ({ ...row })).sort((a, b) => (a.community_name + a.user_id).localeCompare(b.community_name + b.user_id));
  const original = memberships();
  await role("moderator"); await role("moderator");
  assert.deepEqual(memberships(), original.map(row => row.user_id === s.recipient.id && row.community_name === "journey" ? { ...row, role: "moderator" } : row));
  await status(f, `/api/posts/${s.posts[1].id}/reports`, "POST", undefined, s.recipient, 201);
  const queue = await f.json("/api/mod/queue?limit=1", "GET", undefined, s.recipient);
  assert.ok(queue.nextCursor);
  await role("member", s.recipient, 403);
  await f.json("/api/admin/audit", "GET", undefined, s.recipient, 403);
  await status(f, `/api/mod/posts/${s.control.id}`, "DELETE", undefined, s.recipient, 403);
  await role("member");
  const before = businessState(f.app);
  await f.json(`/api/mod/queue?cursor=${queue.nextCursor}`, "GET", undefined, s.recipient, 403);
  await status(f, `/api/mod/posts/${s.posts[0].id}`, "DELETE", undefined, s.recipient, 403);
  assert.deepEqual(businessState(f.app), before);
  await role("moderator");
  for (let i = 0; i < 2; i++) await status(f, "/api/communities/journey/members/me", "DELETE", undefined, s.recipient, 204);
  assert.deepEqual((await f.json("/api/feed/home", "GET", undefined, s.recipient)).posts, []);
  await status(f, "/api/communities/journey/members", "POST", undefined, s.recipient, 200);
  assert.deepEqual(memberships(), original);
  for (const method of ["DELETE", "POST"]) await status(f, `/api/communities/journey/members${method === "DELETE" ? "/me" : ""}`, method, undefined, s.owner, method === "DELETE" ? 204 : 200);
  assert.deepEqual(memberships(), original);
  await status(f, rolePath, "PATCH", { username: s.owner.username, role: "member" }, s.owner, 404);
  await status(f, rolePath, "PATCH", { username: s.unrelated.username, role: "moderator" }, s.owner, 404);
});

test("AC-RC15-5E through 5I connected export, atomic revocation and local erasure", async t => {
  const administrators = new Set();
  const f = await fixture(t, { schedulePrivacyWork: () => {}, administratorAuthority: actor => administrators.has(actor.id) });
  const s = await participation(f); administrators.add(s.owner.id);
  const user = s.participant;
  await status(f, "/api/communities", "POST", { name: "erasure_shared" }, user, 201);
  await status(f, "/api/communities/erasure_shared/members", "POST", undefined, s.recipient, 200);
  const shared = await f.json("/api/communities/erasure_shared/posts", "POST", { type: "text", title: "surviving shared post", text: "survives" }, s.recipient, 201);
  const root = await f.json(`/api/posts/${shared.id}/comments`, "POST", { body: "target erasure marker" }, user, 201);
  const reply = await f.json(`/api/posts/${shared.id}/comments`, "POST", { body: "survivor", parentId: root.id }, s.recipient, 201);
  const login = await f.request("/api/auth/login", "POST", { username: user.username, password });
  assert.equal(login.status, 200); const second = { cookie: login.headers.get("set-cookie").split(";", 1)[0] };
  const exportJob = await f.json("/api/me/export", "POST", undefined, user, 202);
  assert.deepEqual(await f.json("/api/me/export", "POST", undefined, user, 202), exportJob);
  await f.json("/api/me", "PATCH", { bio: "late excluded bio" }, user);
  f.app.drainPrivacy();
  const resultPath = `/api/me/export/jobs/${exportJob.jobId}/result`;
  const snapshot = await f.json(resultPath, "GET", undefined, user);
  assert.equal(snapshot.account.bio, "connected profile");
  assert.deepEqual(new Set(snapshot.data.posts.map(p => p.id)), new Set(s.posts.map(p => p.id)));
  assert.equal(snapshot.data.comments.some(c => c.id === root.id), true);
  for (const marker of [password, user.cookie.split("=")[1], "password_verifier", "password_salt", "token_digest", "late excluded bio", s.control.text]) assert.equal(JSON.stringify(snapshot).includes(marker), false);
  assert.deepEqual(await f.json(resultPath, "GET", undefined, user), snapshot);
  for (const foreign of [s.owner, s.recipient]) await f.json(resultPath, "GET", undefined, foreign, 404);
  const pending = await f.json("/api/me/export", "POST", undefined, user, 202);
  assert.notEqual(pending.jobId, exportJob.jobId);
  const credentials = f.app.database.prepare("SELECT password_verifier, password_salt FROM users WHERE id=?").get(user.id);
  const deletion = await f.json("/api/me", "DELETE", undefined, user, 202);
  assert.deepEqual(await f.json("/api/admin/users/delete", "POST", { userId: user.id }, s.owner, 202), deletion);
  for (const revoked of [user, second]) for (const route of ["/api/feed/home", "/api/me/saved", "/api/me/export"]) {
    await f.json(route, route.endsWith("export") ? "POST" : "GET", undefined, revoked, 401);
  }
  assert.equal(f.app.database.prepare("SELECT COUNT(*) AS n FROM privacy_export_payloads").get().n, 0);
  f.app.drainPrivacy(); f.app.drainPrivacy();
  assert.equal((await f.json(`/api/admin/users/delete/${deletion.jobId}`, "GET", undefined, s.owner)).state, "completed");
  const events = businessState(f.app).privacy_job_events;
  await f.restart(); f.app.drainPrivacy();
  assert.deepEqual(businessState(f.app).privacy_job_events, events);
  await f.json("/api/auth/login", "POST", { username: user.username, password }, undefined, 401);
  assert.deepEqual(await f.json(`/api/posts/${shared.id}`), shared);
  assert.deepEqual((await f.json(`/api/posts/${shared.id}/comments`)).comments, [{ id: root.id, postId: shared.id, parentId: null, depth: 0, state: "deleted" }, reply]);
  assert.deepEqual(await f.json(`/api/posts/${s.control.id}`), s.control);
  assert.equal((await f.request("/api/feed/home", "GET", undefined, s.recipient)).status, 200);
  const retained = await readFile(f.databasePath);
  for (const marker of [user.id, user.username, "connected profile", "late excluded bio", "target erasure marker", ...Object.values(credentials)]) {
    assert.equal(retained.includes(Buffer.from(marker)), false, "erased marker remains recoverable");
  }
});
