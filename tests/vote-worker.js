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
    path: workerData.route,
    method: "PUT",
    headers: { "content-type": "application/json", cookie: workerData.cookie },
    payload: JSON.stringify({ value: workerData.value }),
  });
  parentPort.postMessage({ type: "result", statusCode: response.statusCode, body: await response.json() });
} catch (error) {
  parentPort.postMessage({ type: "result", error: error instanceof Error ? error.message : String(error) });
} finally {
  app.close();
}
