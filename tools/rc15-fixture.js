import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/server.js";

export const password = "rc15-local-passphrase";
export const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
export const mediaBody = { type: "media", title: "capstone media", media: {
  filename: "capstone.png", contentType: "image/png", bytesBase64: image.toString("base64"),
} };

// Only transport/lifetime mechanics are shared; assertions and expected ledgers live in tests.
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reddit-rc15-"));
  const databasePath = join(directory, "state.sqlite");
  let app, server, origin, lostPath;
  async function start() {
    app = createApp({ databasePath, ...options });
    server = createHttpServer({ ...app, async handle(request) {
      const result = await app.handle(request);
      if (request.path === lostPath && result.status >= 200 && result.status < 300) {
        lostPath = undefined;
        throw new Error("test transport drops committed response");
      }
      return result;
    } });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) await new Promise(resolve => server.close(resolve));
    app?.close();
  }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  const request = async (path, method = "GET", body, user, headers = {}) => {
    const response = await fetch(origin + path, { method,
      headers: { "content-type": "application/json", ...(user ? { cookie: user.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    return response;
  };
  const json = async (path, method, body, user, status = 200, headers) => {
    const response = await request(path, method, body, user, headers);
    assert.equal(response.status, status, `${method || "GET"} ${path}`);
    return response.json();
  };
  return { get app() { return app; }, databasePath, request, json,
    loseNextResponse(path) { lostPath = path; },
    async restart() { await stop(); await start(); },
    async signup(username) {
      const response = await request("/api/auth/signup", "POST", { username, password });
      assert.equal(response.status, 201);
      return { ...await response.json(), cookie: response.headers.get("set-cookie").split(";", 1)[0] };
    },
  };
}

export function businessState(app) {
  const tables = app.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  // Independent readiness samples are operational state, not business effects.
  return Object.fromEntries(tables.filter(({ name }) => name !== "operational_capability").map(({ name }) =>
    [name, app.database.prepare(`SELECT * FROM "${name}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
