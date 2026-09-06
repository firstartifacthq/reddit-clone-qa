import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/server.js";

export const password = "rc14-local-passphrase";
export async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-rc14-"));
  const databasePath = join(directory, "state.sqlite");
  const app = createApp({ databasePath, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { app, server, directory, databasePath, origin,
    request: (path, method = "GET", body, cookie) => request(origin, path, method, body, cookie),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function request(origin, path, method = "GET", body, cookie) {
  return fetch(origin + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
}
export async function signup(request, username) {
  const response = await request("/api/auth/signup", "POST", { username, password });
  assert.equal(response.status, 201);
  return { account: await response.json(), cookie: response.headers.get("set-cookie").split(";")[0] };
}
export async function seedFeeds(request) {
  const owner = await signup(request, "load-owner");
  const posts = [];
  for (const name of ["alpha", "beta"]) {
    assert.equal((await request("/api/communities", "POST", { name }, owner.cookie)).status, 201);
    const response = await request(`/api/communities/${name}/posts`, "POST", { type: "text", title: `${name}-eligibility`, text: `${name}-content` }, owner.cookie);
    assert.equal(response.status, 201);
    const created = await response.json();
    posts.push({ id: created.id, community: name, author: 'load-owner', type: 'text', title: `${name}-eligibility`, text: `${name}-content` });
  }
  const users = [];
  for (let index = 0; index < 100; index++) {
    const user = await signup(request, `load-user-${index}`);
    const eligible = ["alpha", "beta"].filter((_, bit) => (index % 4) & (1 << bit));
    for (const name of eligible) assert.equal((await request(`/api/communities/${name}/members`, "POST", undefined, user.cookie)).status, 200);
    users.push({ ...user, expected: posts.filter((_, bit) => (index % 4) & (1 << bit)).reverse() });
  }
  return users;
}
