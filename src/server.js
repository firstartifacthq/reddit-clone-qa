import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { invalidPostError } from "./http-errors.js";
import { POST_BODY_LIMIT_BYTES } from "./post/post-service.js";

const postCreationPath = /^\/api\/communities\/[^/?]+\/posts(?:\?|$)/;
const tooLargeResponse = JSON.stringify(invalidPostError);

/**
 * Retain chunks only until limit. Once crossed, release retained chunks and keep
 * the stream flowing so the fixed response does not depend on decoding a body.
 * @param {import("node:http").IncomingMessage} request
 * @param {number} limit
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let overLimit = false;
    request.on("data", (chunk) => {
      if (overLimit) return;
      bytes += chunk.length;
      if (bytes > limit) {
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(overLimit ? undefined : Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

/** @param {ReturnType<typeof createApp>} [app] */
export function createHttpServer(app = createApp()) {
  return createServer(async (request, response) => {
    try {
      const boundedPost = request.method === "POST" && postCreationPath.test(request.url || "");
      const payload = await readBody(request, boundedPost ? POST_BODY_LIMIT_BYTES : Number.MAX_SAFE_INTEGER);
      if (boundedPost && payload === undefined) {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        response.end(tooLargeResponse);
        return;
      }
      const result = await app.handle({
        method: request.method,
        path: request.url,
        headers: request.headers,
        payload,
      });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch {
      response.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const { port } = app.config;
  const server = createHttpServer(app);
  server.listen(port, () => console.log(`Listening on ${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => { app.close(); process.exit(0); }));
  }
}
