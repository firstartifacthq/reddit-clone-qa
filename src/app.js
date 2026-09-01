import { AuthService } from "./auth/auth-service.js";
import { createSessionManager } from "./auth/sessions.js";
import { loadConfig } from "./config.js";
import { currentAccount } from "./http/account-routes.js";
import { login, logout, signup } from "./http/auth-routes.js";
import { accountFromRequest } from "./http/auth-middleware.js";
import { notFound } from "./http/not-found.js";
import { communities } from "./http/public-routes.js";
import { renderShell } from "./http/shell.js";
import { SqliteStore } from "./storage/sqlite-store.js";

export async function createApp(overrides = {}) {
  const { clock = Date.now, random, ...configOverrides } = overrides;
  const config = loadConfig(configOverrides);
  const store = new SqliteStore(config.databasePath);
  const sessions = createSessionManager({ store, clock, sessionLifetimeMs: config.sessionLifetimeMs, random });
  const authService = new AuthService({ store, sessions, clock });
  const dependencies = { authService, cookieSecure: config.cookieSecure };

  async function handler(request, response) {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (request.method === "POST" && pathname === "/api/auth/signup") return await signup(request, response, dependencies);
      if (request.method === "POST" && pathname === "/api/auth/login") return await login(request, response, dependencies);
      if (request.method === "POST" && pathname === "/api/auth/logout") return logout(request, response, dependencies);
      if (request.method === "GET" && pathname === "/api/me") return currentAccount(request, response, authService);
      if (request.method === "GET" && pathname === "/api/communities") return communities(response);
      if (request.method === "GET" && pathname === "/") {
        const account = accountFromRequest(request, authService);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(renderShell(account));
        return;
      }
      return notFound(response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      }
      response.end(JSON.stringify({ error: { code: "internal_error", message: "Unable to process this request." } }));
    }
  }

  return { handler, store, close: () => store.close() };
}
