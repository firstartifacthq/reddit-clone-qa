import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApp(config);
const server = createServer(app.handler);
server.listen(config.port, () => {
  process.stdout.write(`Listening on port ${config.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => {
    app.close();
    process.exit(0);
  }));
}
