// Runtime imports are exercised by the Node 24 tests; local module contracts are checked below.
// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { accountRepresentation } from "./account-representation.js";
import { ownerProfileRepresentation, publicProfileRepresentation } from "./profile-representation.js";
import { normalizeUsername, validateProfilePatch } from "./profile-validation.js";

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
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  if (!Object.hasOwn(candidate, "username") || !Object.hasOwn(candidate, "password")) return undefined;
  const username = normalizeUsername(candidate.username);
  if (!username || typeof candidate.password !== "string") return undefined;
  if (candidate.password.length < 8 || candidate.password.length > 128) return undefined;
  return { username, password: candidate.password };
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function decodeVerifier(value) {
  // @ts-expect-error Buffer is supplied by the supported Node runtime.
  return Buffer.from(value, "base64");
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** @param {unknown} error */
function isUniqueViolation(error) {
  if (!error || typeof error !== "object") return false;
  const sqliteError = /** @type {{code?: unknown, errcode?: unknown}} */ (error);
  return sqliteError.code === "ERR_SQLITE_ERROR" && sqliteError.errcode === SQLITE_CONSTRAINT_UNIQUE;
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
      if (isUniqueViolation(error)) return { kind: /** @type {const} */ ("duplicate") };
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
    if (!timingSafeEqual(actual, expected) || !user) return { kind: /** @type {const} */ ("invalid-credentials") };
    const session = this.issueSession(user.id);
    if (!this.repository.createSession(session)) return { kind: /** @type {const} */ ("invalid-credentials") };
    return { kind: /** @type {const} */ ("success"), account: accountRepresentation(user), token: session.token };
  }

  /**
   * @param {unknown} token
   * @returns {{id: string, username: string, bio: string, revision: number} | undefined}
   */
  resolve(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return undefined;
    const account = this.repository.findAuthorizedAccount(digest(token), this.now());
    return account ? ownerProfileRepresentation(account) : undefined;
  }

  /**
   * @param {string} userId
   * @param {unknown} body
   */
  updateProfile(userId, body) {
    const patch = validateProfilePatch(body);
    if (!patch) return { kind: /** @type {const} */ ("invalid") };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const profile = this.repository.updateOwnerProfile(userId, patch);
      if (!profile) {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("unauthorized") };
      }
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success"), profile: ownerProfileRepresentation(profile) };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      if (isUniqueViolation(error)) return { kind: /** @type {const} */ ("duplicate") };
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }

  /** @param {unknown} username */
  publicProfile(username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return undefined;
    const profile = this.repository.findActivePublicProfile(normalized);
    return profile ? publicProfileRepresentation(profile) : undefined;
  }

  /** @param {string} userId */
  deleteAccount(userId) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.deleteActiveAccount(userId, this.now())) {
        this.database.exec("ROLLBACK");
        return { kind: /** @type {const} */ ("unauthorized") };
      }
      this.database.exec("COMMIT");
      return { kind: /** @type {const} */ ("success") };
    } catch {
      try { this.database.exec("ROLLBACK"); } catch {}
      return { kind: /** @type {const} */ ("unavailable") };
    }
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
