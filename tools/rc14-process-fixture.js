import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/server.js";
import { request } from "./rc14-fixture.js";

export async function processFixture() {
  const directory = await mkdtemp(join(tmpdir(), "reddit-rc14-process-"));
  const databasePath = join(directory, "state.sqlite");
  let child;
  let origin;
  return {
    databasePath, directory,
    get origin() { return origin; },
    async start(holdPhase = "") {
      child = fork(new URL(import.meta.url), ["child", databasePath, holdPhase], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("fixture exited before listening"); }),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("fixture startup timeout")), 10000); timer.unref(); })]);
      origin = message[0].origin;
    },
    request: (path, method, body, cookie) => request(origin, path, method, body, cookie),
    async stop(signal = "SIGTERM") {
      if (!child || child.exitCode !== null || child.signalCode) return;
      const exited = once(child, "exit"); child.kill(signal); await exited;
    },
    async close() { await this.stop("SIGKILL"); await rm(directory, { recursive: true, force: true }); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "child") {
  const app = createApp({ databasePath: process.argv[3], administratorAuthority: account => account.username === "rc14-admin",
    beforePrivacyPhase: job => { if (process.argv[4] === (job.phase || job.operation)) throw new Error("local phase barrier"); } });
  const server = createHttpServer(app);
  server.listen(0, "127.0.0.1", () => process.send({ origin: `http://127.0.0.1:${server.address().port}` }));
  process.once("SIGTERM", () => server.close(() => { app.close(); process.exit(0); }));
}
