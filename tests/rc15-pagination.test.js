import assert from "node:assert/strict";
import test from "node:test";
import { fixture, businessState } from "../tools/rc15-fixture.js";
import { status } from "../tools/rc15-ledger.js";

const day = 86400000;
test("AC-RC15-2 all page families retain ordered candidates, replay across restart and expire exactly", async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now, sessionLifetimeMs: 4 * day, postRateLimitMax: 100,
    schedulePrivacyWork: () => {}, administratorAuthority: () => true });
  const owner = await f.signup("paging-owner"), actor = await f.signup("paging-actor");
  await status(f, "/api/communities", "POST", { name: "paging" }, owner, 201);
  await status(f, "/api/communities/paging/members", "POST", undefined, actor, 200);
  const root = await f.json("/api/communities/paging/posts", "POST", { type: "text", title: "conversation", text: "root" }, owner, 201);
  const families = [
    { path: "/api/feed/home", user: actor, key: "posts" },
    { path: "/api/feed/popular", key: "posts" },
    { path: "/api/communities/paging/feed", key: "posts" },
    { path: `/api/posts/${root.id}/comments`, key: "comments", immortal: true },
    { path: "/api/mod/queue", user: owner, key: "reports" },
    { path: "/api/me/notifications", user: owner, key: "notifications" },
    { path: "/api/me/saved", user: actor, key: "posts" },
    { path: "/api/me/history", user: actor, key: "history", id: item => item.post.id },
    { path: "/api/admin/audit", user: owner, key: "events", defaultSize: 50 },
  ];
  const get = (family, query = "") => f.json(family.path + query, "GET", undefined, family.user);
  const ids = (family, page) => page[family.key].map(family.id || (item => item.id));
  const posts = [root], comments = [];
  async function populate(i) {
    now++;
    const post = await f.json("/api/communities/paging/posts", "POST", { type: "text", title: `page ${i}`, text: "snapshot" }, owner, 201);
    posts.push(post);
    comments.push(await f.json(`/api/posts/${root.id}/comments`, "POST", { body: `u/paging-owner entry ${i}` }, actor, 201));
    await status(f, `/api/posts/${post.id}/reports`, "POST", undefined, actor, 201);
    await status(f, `/api/posts/${post.id}/save`, "PUT", undefined, actor, 204);
    await f.json(`/api/posts/${post.id}`, "GET", undefined, actor);
    await f.json("/api/me/export", "POST", undefined, owner, 202); f.app.drainPrivacy();
  }
  for (const size of [0, 1, 2, 28]) {
    while (comments.length < size) await populate(comments.length);
    for (const family of families) {
      const all = await get(family, "?limit=100");
      assert.equal(all.nextCursor, null);
      const initial = await get(family);
      assert.deepEqual(ids(family, initial), ids(family, all).slice(0, family.defaultSize || 25));
      let page = await get(family, "?limit=1"), seen = ids(family, page);
      while (page.nextCursor) {
        page = await get(family, `?limit=1&cursor=${page.nextCursor}`);
        seen.push(...ids(family, page));
      }
      assert.deepEqual(seen, ids(family, all)); assert.equal(new Set(seen).size, seen.length);
    }
  }
  const expectedPosts = posts.toReversed().map(p => p.id);
  for (const family of families.slice(0, 3)) assert.deepEqual(ids(family, await get(family, "?limit=100")), expectedPosts);
  assert.deepEqual(ids(families[3], await get(families[3], "?limit=100")), comments.map(c => c.id));
  const capturedAt = now;
  for (const family of families) {
    family.expected = ids(family, await get(family, "?limit=100"));
    family.first = await get(family, "?limit=1"); assert.ok(family.first.nextCursor);
  }
  await populate(99);
  await f.json(`/api/posts/${posts[1].id}/vote`, "PUT", { value: 1 }, actor);
  await f.restart();
  for (const family of families) {
    const query = `?limit=100&cursor=${family.first.nextCursor}`;
    const resumed = await get(family, query);
    assert.deepEqual(ids(family, resumed), family.expected.slice(1), family.path);
    assert.deepEqual(await get(family, query), resumed);
    family.resumed = resumed;
  }
  for (const time of [capturedAt + day - 1, capturedAt + day, capturedAt + day + 1]) {
    now = time;
    for (const family of families) {
      const query = `?limit=100&cursor=${family.first.nextCursor}`;
      if (family.immortal || time < capturedAt + day) assert.deepEqual(await get(family, query), family.resumed);
      else {
        const before = businessState(f.app);
        await f.json(family.path + query, "GET", undefined, family.user, 422);
        assert.deepEqual(businessState(f.app), before);
      }
    }
  }
  for (const family of families) assert.ok((await get(family))[family.key].length);
});
