// Runtime imports are exercised by the Node 24 tests; local module contracts are checked below.
// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { accountRepresentation } from "./account-representation.js";

/** @typedef {import("./auth-repository.js").AuthRepository} AuthRepository */
/**
 * @typedef {object} Config
 * @property {number} sessionLifetimeMs
 */
/**
 * @typedef {object} Database
 * @property {(sql: string) => void} exec
 */
/**
 * @typedef {object} ServiceOptions
 * @property {AuthRepository} repository
 * @property {Database} database
 * @property {Config} config
 * @property {() => number} [now]
 * @property {() => string} [randomToken]
 */
/**
 * @typedef {object} Credentials
 * @property {string} username
 * @property {string} password
 */
/**
 * @typedef {object} Session
 * @property {string} token
 * @property {string} digest
 * @property {string} userId
 * @property {number} issuedAt
 * @property {number} expiresAt
 */

const DUMMY_SALT = "reddit-clone-dummy-salt";
const DUMMY_VERIFIER = scryptSync("not-a-user-password", DUMMY_SALT, 64);

/**
 * @param {string} token
 * @returns {string}
 */
function digest(token) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * @param {unknown} body
 * @returns {Credentials | undefined}
 */
function validateCredentials(body) {
  if (!body || typeof body !== "object") return undefined;
  if (!("username" in body) || !("password" in body)) return undefined;
  if (typeof body.username !== "string" || typeof body.password !== "string") return undefined;
  const username = body.username.trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) return undefined;
  if (body.password.length < 8 || body.password.length > 128) return undefined;
  return { username, password: body.password };
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function decodeVerifier(value) {
  // @ts-expect-error Buffer is supplied by the supported Node runtime.
  return Buffer.from(value, "base64");
}

export class AuthService {
  /** @param {ServiceOptions} options */
  constructor({ repository, database, config, now = Date.now, randomToken = () => randomBytes(32).toString("base64url") }) {
    this.repository = repository;
    this.database = database;
    this.config = config;
    this.now = now;
    this.randomToken = randomToken;
  }

  /** @param {unknown} body */
  signup(body) {
    const credentials = validateCredentials(body);
    if (!credentials) return { kind: /** @type {const} */ ("invalid-request") };
    const salt = randomBytes(16).toString("base64url");
    const verifier = scryptSync(credentials.password, salt, 64).toString("base64");
    const account = { id: randomUUID(), username: credentials.username };
    const session = this.issueSession(account.id);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.repository.createUser({ ...account, salt, verifier, createdAt: this.now() });
      this.repository.createSession(session);
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success"), account: accountRepresentation(account), token: session.token };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return { kind: /** @type {const} */ ("duplicate") };
      }
      throw error;
    }
  }

  /** @param {unknown} body */
  login(body) {
    const credentials = validateCredentials(body);
    if (!credentials) return { kind: /** @type {const} */ ("invalid-request") };
    const user = this.repository.findUserByUsername(credentials.username);
    const expected = user ? decodeVerifier(user.password_verifier) : DUMMY_VERIFIER;
    const actual = scryptSync(credentials.password, user ? user.password_salt : DUMMY_SALT, 64);
    if (!timingSafeEqual(actual, expected) || !user) {
      return { kind: /** @type {const} */ ("invalid-credentials") };
    }
    const session = this.issueSession(user.id);
    this.repository.createSession(session);
    return { kind: /** @type {const} */ ("success"), account: accountRepresentation(user), token: session.token };
  }

  /**
   * @param {unknown} token
   * @returns {{id: string, username: string} | undefined}
   */
  resolve(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return undefined;
    const account = this.repository.findAuthorizedAccount(digest(token), this.now());
    return account ? accountRepresentation(account) : undefined;
  }

  /** @param {unknown} token */
  logout(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return;
    this.repository.revoke(digest(token), this.now());
  }

  /**
   * @param {string} userId
   * @returns {Session}
   */
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
