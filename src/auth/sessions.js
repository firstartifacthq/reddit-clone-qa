import { createHash, randomBytes } from "node:crypto";

export function sessionDigest(token) {
  return createHash("sha256").update(token).digest("base64url");
}

export function createSessionManager({ store, clock, sessionLifetimeMs, random = randomBytes }) {
  return {
    issue(accountId) {
      const token = Buffer.from(random(32)).toString("base64url");
      store.createSession(sessionDigest(token), accountId, clock() + sessionLifetimeMs);
      return token;
    },
    resolve(token) {
      return token ? store.findActiveSession(sessionDigest(token), clock()) : null;
    },
    revoke(token) {
      if (token) store.revokeSession(sessionDigest(token), clock());
    },
  };
}
