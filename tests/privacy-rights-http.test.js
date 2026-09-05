import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createHttpServer } from "../src/server.js";
import { createApp } from "../src/app.js";

test("specified privacy operations traverse node:http", async () => {
  const app = createApp({ databasePath: ":memory:", administratorAuthority: (account) => account.username === "admin" });
  const server = createHttpServer(app); server.listen(0); await once(server, "listening"); const port = server.address().port;
  let response = await fetch(`http://127.0.0.1:${port}/api/auth/signup`, { method: "POST", body: JSON.stringify({ username: "admin", password: "privacy-pass-123" }) });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  response = await fetch(`http://127.0.0.1:${port}/api/admin/audit?limit=1`, { headers: { cookie } }); assert.equal(response.status, 200);
  response = await fetch(`http://127.0.0.1:${port}/api/admin/audit/missing`, { method: "DELETE", headers: { cookie } }); assert.equal(response.status, 405);
  await new Promise((resolve) => server.close(resolve)); app.close();
});
