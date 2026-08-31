import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const DEFAULT_SESSION_MS = 1000 * 60 * 60 * 24 * 7;
const DUMMY_PASSWORD = "not-a-real-account-password";

export const identifierRule = "3-24 letters, numbers, or underscores";
export const credentialRule = "12-128 characters";

export function normalizeIdentifier(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function validateRegistration(identifier, password) {
  const errors = {};
  if (!/^[A-Za-z0-9_]{3,24}$/.test(String(identifier ?? ""))) {
    errors.identifier = `Identifier must contain ${identifierRule}.`;
  }
  const length = String(password ?? "").length;
  if (length < 12 || length > 128) {
    errors.password = `Password must contain ${credentialRule}.`;
  }
  return errors;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, record) {
  const [salt, hash] = String(record).split(":");
  if (!salt || !hash) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(hash, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

export class MemoryAuthStore {
  constructor({ now = () => Date.now(), random = randomBytes, sessionLifetimeMs = DEFAULT_SESSION_MS } = {}) {
    this.now = now;
    this.random = random;
    this.sessionLifetimeMs = sessionLifetimeMs;
    this.accounts = new Map();
    this.sessions = new Map();
    this.operations = new Map();
    this.sequence = 0;
  }

  activeSessionCount() {
    const now = this.now();
    return [...this.sessions.values()].filter((session) => !session.revokedAt && session.expiresAt > now).length;
  }

  accountCount() { return this.accounts.size; }

  async register({ identifier, password, operationId }) {
    const validation = validateRegistration(identifier, password);
    if (Object.keys(validation).length) return { kind: "validation", errors: validation };
    return this.#authenticateOperation({ kind: "register", identifier, password, operationId });
  }

  async signIn({ identifier, password, operationId }) {
    return this.#authenticateOperation({ kind: "sign-in", identifier, password, operationId });
  }

  async #authenticateOperation({ kind, identifier, password, operationId }) {
    const canonical = normalizeIdentifier(identifier);
    const operation = this.operations.get(operationId);
    if (operation) {
      if (operation.kind !== kind || operation.canonical !== canonical) return { kind: "recovery" };
      const account = this.accounts.get(canonical);
      if (!account || !(await verifyPassword(password, account.passwordHash))) return { kind: "authentication-failure" };
      const existing = this.sessions.get(operation.sessionHash);
      // A dropped response may lose the cookie. Rotate one existing session instead of creating another.
      if (existing && !existing.revokedAt && existing.expiresAt > this.now()) {
        return this.#issue(account, operation, existing);
      }
      return this.#issue(account, operation);
    }

    if (kind === "register") {
      if (this.accounts.has(canonical)) return { kind: "conflict" };
      const account = { id: `account-${++this.sequence}`, identifier: String(identifier).trim(), canonical, passwordHash: await hashPassword(password), createdAt: this.now() };
      this.accounts.set(canonical, account);
      return this.#issue(account, { id: operationId, kind, canonical });
    }

    const account = this.accounts.get(canonical);
    // The dummy verification keeps unknown accounts on the same password-work path.
    const record = account?.passwordHash ?? await hashPassword(DUMMY_PASSWORD, "0".repeat(32));
    if (!account || !(await verifyPassword(password, record))) return { kind: "authentication-failure" };
    return this.#issue(account, { id: operationId, kind, canonical });
  }

  #issue(account, operation, existing = null) {
    const token = Buffer.from(this.random(32)).toString("base64url");
    const hash = tokenHash(token);
    const session = existing ?? { id: `session-${++this.sequence}`, accountCanonical: account.canonical, createdAt: this.now(), expiresAt: this.now() + this.sessionLifetimeMs, revokedAt: null };
    if (existing) this.sessions.delete(operation.sessionHash);
    session.tokenHash = hash;
    this.sessions.set(hash, session);
    // Operations keep only a hash pointer; raw session authority is never retained after delivery.
    this.operations.set(operation.id, { ...operation, sessionHash: hash });
    return { kind: "success", account, token };
  }

  resolve(token) {
    if (!token) return null;
    const session = this.sessions.get(tokenHash(token));
    if (!session || session.revokedAt || session.expiresAt <= this.now()) return null;
    const account = this.accounts.get(session.accountCanonical);
    return account ? { account, session } : null;
  }

  signOut(token) {
    const session = token && this.sessions.get(tokenHash(token));
    if (session && !session.revokedAt) session.revokedAt = this.now();
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((entry) => entry.trim().split(/=(.*)/s)).filter(([key]) => key));
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 16_384) request.destroy(); });
    request.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
    request.on("error", reject);
  });
}

function operationId(body) {
  const candidate = String(body.operationId ?? "");
  return /^[A-Za-z0-9_-]{16,128}$/.test(candidate) ? candidate : `server-${randomBytes(18).toString("base64url")}`;
}

function sessionCookie(token, secure, lifetimeMs) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(lifetimeMs / 1000)}${secure ? "; Secure" : ""}`;
}

function clearCookie(secure) {
  return `session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function shell({ account = null, title = "Home", content = "", status = 200 }) {
  const actions = account
    ? `<span class="identity">Signed in as <strong>${escapeHtml(account.identifier)}</strong></span><a href="/account">Account</a><form method="post" action="/sign-out"><button>Sign out</button></form>`
    : `<a href="/register">Register</a><a href="/sign-in">Sign in</a>`;
  return { status, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} | Redditly</title><link rel="stylesheet" href="/styles.css"></head><body><header><a class="brand" href="/">Redditly</a><nav aria-label="Public navigation"><a href="/">Home</a><a href="/about">About</a></nav><div class="actions">${actions}</div></header><main><h1>${escapeHtml(title)}</h1>${content}</main><script type="module" src="/auth-client.js"></script></body></html>` };
}

function authForm({ mode, error = "", errors = {} }) {
  const registration = mode === "register";
  const action = registration ? "/register" : "/sign-in";
  const rules = registration ? `<p class="rules">Identifier: ${identifierRule}. Password: ${credentialRule}.</p>` : "";
  const message = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  const fields = `<label>Identifier<input name="identifier" autocomplete="username" required></label>${errors.identifier ? `<p class="error" role="alert">${escapeHtml(errors.identifier)}</p>` : ""}<label>Password<input type="password" name="password" autocomplete="current-password" required></label>${errors.password ? `<p class="error" role="alert">${escapeHtml(errors.password)}</p>` : ""}`;
  return `${message}${rules}<form class="auth-form" method="post" action="${action}">${fields}<input type="hidden" name="operationId"><button type="submit">${registration ? "Create account" : "Sign in"}</button><button class="retry" type="submit" hidden>Retry</button></form>`;
}

function send(response, rendered, headers = {}) {
  response.writeHead(rendered.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'", "x-content-type-options": "nosniff", ...headers });
  response.end(rendered.body);
}

export function createApp({ store = new MemoryAuthStore(), origin = "http://localhost", secureCookies = false } = {}) {
  return async function app(request, response) {
    const url = new URL(request.url, origin);
    const sensitiveQuery = [...url.searchParams.keys()].some((key) => /pass|token|secret|credential|session/i.test(key));
    if (sensitiveQuery) return send(response, shell({ title: "Not found", content: "<p>That page is unavailable.</p>", status: 404 }));
    const token = parseCookies(request.headers.cookie).session;
    const context = store.resolve(token);
    const invalidToken = token && !context;
    const baseHeaders = invalidToken ? { "set-cookie": clearCookie(secureCookies) } : {};
    const route = url.pathname;

    if (request.method === "GET" && route === "/") return send(response, shell({ account: context?.account, content: "<p>Welcome to a calmer conversation.</p>" }), baseHeaders);
    if (request.method === "GET" && route === "/about") return send(response, shell({ account: context?.account, title: "About", content: "<p>A public place for thoughtful discussion.</p>" }), baseHeaders);
    if (request.method === "GET" && route === "/register") return send(response, shell({ account: context?.account, title: "Register", content: context ? "<p>You are already signed in.</p>" : authForm({ mode: "register" }) }), baseHeaders);
    if (request.method === "GET" && route === "/sign-in") return send(response, shell({ account: context?.account, title: "Sign in", content: context ? "<p>You are already signed in.</p>" : authForm({ mode: "sign-in" }) }), baseHeaders);

    if (request.method === "GET" && route === "/account") {
      if (!context) return send(response, shell({ title: "Sign in required", status: 401, content: '<p>This account page requires sign-in.</p><a class="button" href="/sign-in">Sign in</a>' }), baseHeaders);
      return send(response, shell({ account: context.account, title: "Account", content: `<p>Your account is ready, ${escapeHtml(context.account.identifier)}.</p>` }));
    }

    if (request.method === "POST" && (route === "/register" || route === "/sign-in")) {
      const requestOrigin = request.headers.origin;
      if (requestOrigin && requestOrigin !== origin) return send(response, shell({ title: "Request denied", status: 403, content: "<p>Please retry from this site.</p>" }));
      const body = await parseBody(request);
      const result = route === "/register"
        ? await store.register({ identifier: body.identifier, password: body.password, operationId: operationId(body) })
        : await store.signIn({ identifier: body.identifier, password: body.password, operationId: operationId(body) });
      if (result.kind === "success") return send(response, shell({ account: result.account, content: "<p data-auth-success>You are signed in.</p>" }), { "set-cookie": sessionCookie(result.token, secureCookies, store.sessionLifetimeMs) });
      if (result.kind === "validation") return send(response, shell({ title: "Register", status: 422, content: authForm({ mode: "register", errors: result.errors }) }));
      if (result.kind === "conflict") return send(response, shell({ title: "Register", status: 409, content: authForm({ mode: "register", error: "That identifier cannot be used. Choose another and retry." }) }));
      if (result.kind === "recovery") return send(response, shell({ title: "Try again", status: 409, content: `<div data-auth-terminal>${authForm({ mode: route === "/register" ? "register" : "sign-in", error: "This request cannot be retried. Start again." })}</div>` }));
      return send(response, shell({ title: "Sign in", status: 401, content: authForm({ mode: "sign-in", error: "Sign-in could not be completed; check your details and retry." }) }));
    }

    if (request.method === "POST" && route === "/sign-out") {
      const requestOrigin = request.headers.origin;
      if (requestOrigin && requestOrigin !== origin) return send(response, shell({ title: "Request denied", status: 403, content: "<p>Please retry from this site.</p>" }));
      store.signOut(token);
      return send(response, shell({ content: "<p>You are signed out.</p>" }), { "set-cookie": clearCookie(secureCookies) });
    }

    if (request.method === "GET" && route === "/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" });
      return response.end(CSS);
    }
    if (request.method === "GET" && route === "/auth-client.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return response.end(CLIENT_JS);
    }
    return send(response, shell({ title: "Not found", status: 404, content: "<p>That page is unavailable.</p>" }), baseHeaders);
  };
}

const CSS = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const CLIENT_JS = readFileSync(new URL("../public/auth-client.js", import.meta.url), "utf8");
