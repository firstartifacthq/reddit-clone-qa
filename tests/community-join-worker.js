import { parentPort, workerData } from "node:worker_threads";
import { createApp } from "../src/app.js";

const app = createApp({ databasePath: workerData.path, now: () => 1_700_000_000_000 });
const control = new Int32Array(workerData.barrier);
Atomics.add(control, 1, 1);
parentPort.postMessage({ type: "ready" });
const waitResult = Atomics.wait(control, 0, 0, 5_000);
parentPort.postMessage({ type: "attempting", waitResult });

try {
  const response = await app.inject({
    path: "/api/communities/concurrent/members",
    method: "POST",
    headers: { cookie: workerData.cookie },
  });
  parentPort.postMessage({ type: "result", statusCode: response.statusCode });
} catch (error) {
  parentPort.postMessage({ type: "result", error: error instanceof Error ? error.message : String(error) });
} finally {
  app.close();
}
