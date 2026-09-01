import { parentPort, workerData } from "node:worker_threads";
import { createApp } from "../src/app.js";

const app = createApp({ databasePath: workerData.path, now: () => 1_700_000_000_000 });
const barrier = new Int32Array(workerData.barrier);
Atomics.wait(barrier, 0, 0, 5_000);
app.inject({
  path: "/api/communities/concurrent/members",
  method: "POST",
  headers: { cookie: workerData.cookie },
}).then((response) => {
  app.close();
  parentPort.postMessage(response.statusCode);
}).catch((error) => {
  app.close();
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
});
