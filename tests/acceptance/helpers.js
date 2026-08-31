import { createServer } from "node:http";
import { createApp, MemoryAuthStore } from "../../src/app.js";

export async function fixture(options = {}) {
  let current = options.now ?? 1_000_000;
  const store = new MemoryAuthStore({ now: () => current, sessionLifetimeMs: options.sessionLifetimeMs ?? 60_000 });
  const server = createServer(createApp({ store, origin: "http://127.0.0.1" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const request = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", ...init });
    return { response, text: await response.text(), cookie: response.headers.get("set-cookie") };
  };
  return { store, request, advance: (ms) => { current += ms; }, close: () => new Promise((resolve) => server.close(resolve)) };
}

export function form(values) {
  return new URLSearchParams(values).toString();
}

export function sessionCookie(setCookie) { return setCookie.split(";")[0]; }

export async function register(app, identifier = "river_user", password = "long-enough-password") {
  return app.request("/register", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://127.0.0.1" }, body: form({ identifier, password, operationId: `operation-${identifier}-0001` }) });
}
