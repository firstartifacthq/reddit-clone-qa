import { createServer } from "node:http";
import { createApp } from "./app.js";

const app = createApp();
const { port } = app.config;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const result = await app.handle({
    method: request.method,
    path: request.url,
    headers: request.headers,
    payload: Buffer.concat(chunks),
  });
  response.writeHead(result.status, result.headers);
  response.end(result.body);
});

server.listen(port, () => console.log(`Listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => { app.close(); process.exit(0); }));
}
