import assert from "node:assert/strict";
import { mediaBody, image } from "./rc15-fixture.js";

export async function status(f, path, method, body, user, expected) {
  const response = await f.request(path, method, body, user);
  assert.equal(response.status, expected, `${method} ${path}`);
  await response.arrayBuffer();
}

// The ledger is derived from intended operations and acknowledged IDs, never repository serializers.
export async function participation(f) {
  const owner = await f.signup("journey-owner");
  const participant = await f.signup("journey-participant");
  const recipient = await f.signup("journey-recipient");
  const unrelated = await f.signup("journey-unrelated");
  const profile = await f.json("/api/me", "PATCH", { bio: "connected profile" }, participant);
  assert.equal(profile.id, participant.id);
  for (const [name, user] of [["journey", owner], ["control", unrelated]]) {
    await status(f, "/api/communities", "POST", { name }, user, 201);
  }
  for (const user of [participant, recipient]) await status(f, "/api/communities/journey/members", "POST", undefined, user, 200);
  const bodies = [{ type: "text", title: "capstone literal %_ text", text: "connected text" },
    { type: "link", title: "capstone literal %_ link", url: "https://example.org/connected" },
    { ...mediaBody, title: "capstone literal %_ media" }];
  const posts = [];
  for (const body of bodies) {
    const created = await f.json("/api/communities/journey/posts", "POST", body, participant, 201);
    const payload = body.type === "media" ? { media: { filename: body.media.filename, contentType: body.media.contentType, byteLength: image.length } } : body.type === "text" ? { text: body.text } : { url: body.url };
    const expected = { id: created.id, community: "journey", author: participant.username, type: body.type, title: body.title, ...payload };
    assert.deepEqual(created, expected);
    posts.push(expected);
  }
  const control = await f.json("/api/communities/control/posts", "POST", { type: "text", title: "control post", text: "untouched control" }, unrelated, 201);
  const root = await f.json(`/api/posts/${posts[0].id}/comments`, "POST", { body: "connected root" }, participant, 201);
  const reply = await f.json(`/api/posts/${posts[0].id}/comments`, "POST", { body: "connected reply", parentId: root.id }, recipient, 201);
  assert.equal(reply.postId, posts[0].id); assert.equal(reply.parentId, root.id);
  await f.json(`/api/posts/${posts[0].id}/vote`, "PUT", { value: 1 }, recipient);
  await f.json(`/api/posts/${posts[1].id}/vote`, "PUT", { value: -1 }, owner);
  await status(f, `/api/posts/${posts[0].id}/reports`, "POST", undefined, recipient, 201);
  await status(f, `/api/posts/${posts[0].id}/save`, "PUT", undefined, recipient, 204);
  assert.deepEqual(await f.json(`/api/posts/${posts[0].id}`, "GET", undefined, recipient), posts[0]);
  await f.json("/api/me/preferences", "PATCH", { theme: "dark", compactMode: true }, recipient);
  const get = (path, user) => f.json(path, "GET", undefined, user);
  async function observe() {
    assert.deepEqual(await get("/api/me", participant), profile);
    for (const post of posts) assert.deepEqual(await get(`/api/posts/${post.id}`), post);
    const response = await f.request(`/api/posts/${posts[2].id}/media`);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
    for (const user of [owner, participant, recipient]) assert.deepEqual(new Set((await get("/api/feed/home", user)).posts.map(p => p.id)), new Set(posts.map(p => p.id)));
    assert.deepEqual((await get("/api/feed/home", unrelated)).posts, [control]);
    assert.deepEqual(await get(`/api/posts/${control.id}`), control);
    assert.deepEqual((await get(`/api/posts/${posts[0].id}/comments`)).comments, [root, reply]);
    assert.deepEqual(await get(`/api/posts/${posts[0].id}/vote`, recipient), { postId: posts[0].id, value: 1, score: 1, authorKarma: 0 });
    assert.deepEqual(await get(`/api/posts/${posts[1].id}/vote`, owner), { postId: posts[1].id, value: -1, score: -1, authorKarma: 0 });
    assert.deepEqual(new Set((await get("/api/search?type=post&q=literal%20%25_")).results.map(p => p.id)), new Set(posts.map(p => p.id)));
    const queue = await get("/api/mod/queue", owner);
    assert.equal(queue.reports.length, 1); assert.equal(queue.reports[0].postId, posts[0].id);
    const notifications = (await get("/api/me/notifications", participant)).notifications;
    assert.ok(notifications.some(n => n.kind === "reply" && n.relatedItem.id === reply.id));
    assert.ok(notifications.some(n => n.kind === "vote" && n.relatedItem.id === posts[0].id));
    assert.deepEqual((await get("/api/me/saved", recipient)).posts, [posts[0]]);
    assert.deepEqual((await get("/api/me/history", recipient)).history.map(h => h.post), [posts[0]]);
    assert.deepEqual(await get("/api/me/preferences", recipient), { theme: "dark", compactMode: true });
    for (const user of [owner, participant, unrelated]) assert.deepEqual((await get("/api/me/saved", user)).posts, []);
    assert.deepEqual(await get("/api/me/preferences", unrelated), { theme: "system", compactMode: false });
    assert.deepEqual((await get("/api/me/notifications", unrelated)).notifications, []);
    return { queue, notifications };
  }
  return { owner, participant, recipient, unrelated, posts, root, reply, control, observe };
}
