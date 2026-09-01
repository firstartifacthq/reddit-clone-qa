import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { accountRepresentation } from "./account-representation.js";

const DUMMY_SALT = "reddit-clone-dummy-salt";
const DUMMY_VERIFIER = scryptSync("not-a-user-password", DUMMY_SALT, 64);

function digest(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validateCredentials(body) {
  if (!body || typeof body !== "object") return undefined;
  if (typeof body.username !== "string" || typeof body.password !== "string") return undefined;
  const username = body.username.trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return undefined;
  if (body.password.length < 8 || body.password.length > 128) return undefined;
  return { username, password: body.password };
}

export class AuthService {
  constructor({ repository, database, config, now = Date.now, randomToken = () => randomBytes(32).toString("base64url") }) {
    this.repository = repository;
    this.database = database;
    this.config = config;
    this.now = now;
    this.randomToken = randomToken;
  }

  signup(body) {
    const credentials = validateCredentials(body);
    if (!credentials) return { kind: "invalid-request" };
    const salt = randomBytes(16).toString("base64url");
    const verifier = scryptSync(credentials.password, salt, 64).toString("base64");
    const account = { id: randomUUID(), username: credentials.username };
    const session = this.issueSession(account.id);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.repository.createUser({ ...account, salt, verifier, createdAt: this.now() });
      this.repository.createSession(session);
      this.database.exec("COMMIT");
      return { kind: "success", account: accountRepresentation(account), token: session.token };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      if (String(error.message).includes("UNIQUE constraint failed")) return { kind: "duplicate" };
      throw error;
    }
  }

  login(body) {
    const credentials = validateCredentials(body);
    if (!credentials) return { kind: "invalid-request" };
    const user = this.repository.findUserByUsername(credentials.username);
    const expected = user ? Buffer.from(user.password_verifier, "base64") : DUMMY_VERIFIER;
    const actual = scryptSync(credentials.password, user ? user.password_salt : DUMMY_SALT, 64);
    if (!timingSafeEqual(actual, expected) || !user) return { kind: "invalid-credentials" };
    const session = this.issueSession(user.id);
    this.repository.createSession(session);
    return { kind: "success", account: accountRepresentation(user), token: session.token };
  }

  resolve(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return undefined;
    const account = this.repository.findAuthorizedAccount(digest(token), this.now());
    return account ? accountRepresentation(account) : undefined;
  }

  logout(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return;
    this.repository.revoke(digest(token), this.now());
  }

  issueSession(userId) {
    const token = this.randomToken();
    const issuedAt = this.now();
    return {
      token,
      digest: digest(token),
      userId,
      issuedAt,
      expiresAt: issuedAt + this.config.sessionLifetimeMs,
    };
  }
}
