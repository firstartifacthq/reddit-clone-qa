import { createServer } from "node:http";
import { AuthService, createApp, SqliteAuthStore } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const origin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
const secureCookies = process.env.NODE_ENV === "production";
const persistence = new SqliteAuthStore({ databasePath: process.env.DATABASE_PATH ?? "data/redditly.sqlite" });
const store = new AuthService({ persistence });
const app = createApp({ store, origin, secureCookies });

createServer((request, response) => {
  app(request, response).catch(() => {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("The request could not be completed. Please retry.");
  });
}).listen(port, () => console.log(`Redditly listening at ${origin}`));
