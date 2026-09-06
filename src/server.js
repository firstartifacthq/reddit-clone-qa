import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { createConfig } from "./config.js";
import { existsSync, statSync } from "node:fs";
import { operationalRequest, operationalResponse } from "./operational-http.js";
import { invalidPostError } from "./http-errors.js";
import { POST_BODY_LIMIT_BYTES } from "./post/post-service.js";

const postCreationPath = /^\/api\/communities\/[^/]+\/posts$/;
const tooLargeResponse = JSON.stringify(invalidPostError);

/** @param {string | undefined} requestTarget */
function isPostCreationTarget(requestTarget) {
  try {
    return postCreationPath.test(new URL(requestTarget || "/", "http://localhost").pathname);
  } catch {
    return false;
  }
}

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
      const operational = operationalRequest(request.method, request.url);
      if (operational) {
        request.resume();
        const result = await operationalResponse(operational, app.readiness);
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      const boundedPost = request.method === "POST" && isPostCreationTarget(request.url);
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
        payload: payload?.length ? payload : undefined,
      });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch {
      response.destroy();
    }
  });
}

export function createRuntime(options = {}, compose = createApp) {
  if (typeof compose !== "function") throw new TypeError("invalid composition function");
  const config = createConfig(options);
  let app;
  let closed = false;
  let identity = existsSync(config.databasePath) ? statSync(config.databasePath) : undefined;
  let timer;
  const initialize = () => {
    if (closed) return;
    try {
      if (identity) {
        const current = statSync(config.databasePath);
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("retained storage unavailable");
      }
      app = compose(config);
    } catch {
      if (!identity && existsSync(config.databasePath)) identity = statSync(config.databasePath);
      timer = setTimeout(initialize, 250); timer.unref();
    }
  };
  timer = setTimeout(initialize, 0); timer.unref();
  return { config,
    readiness: { observe: () => app?.readiness.observe() || Promise.resolve(false) },
    handle: request => app ? app.handle(request) : Promise.resolve({ status: 503,
      headers: { "content-type": "application/json; charset=utf-8" }, body: '{"error":"Service unavailable"}' }),
    close: () => { closed = true; clearTimeout(timer); app?.close(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createRuntime();
  const { port } = app.config;
  const server = createHttpServer(app);
  server.listen(port, () => console.log(`Listening on ${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => { app.close(); process.exit(0); }));
  }
}
