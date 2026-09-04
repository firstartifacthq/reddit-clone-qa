// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { randomUUID } from "node:crypto";
/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }

export class SafetyService {
  /** @param {{repository: import("./safety-repository.js").SafetyRepository, database: {exec: (sql: string) => void}, now?: () => number, postRateLimitMax: number, postRateLimitWindowMs: number, postRateLimitRetentionMs: number, beforePostEnforcement?: () => void}} options */
  constructor({ repository, database, now = Date.now, postRateLimitMax, postRateLimitWindowMs, postRateLimitRetentionMs, beforePostEnforcement = () => {} }) {
    this.repository = repository; this.database = database; this.now = now; this.postRateLimitMax = postRateLimitMax; this.postRateLimitWindowMs = postRateLimitWindowMs; this.postRateLimitRetentionMs = postRateLimitRetentionMs; this.beforePostEnforcement = beforePostEnforcement;
  }
  /** @param {string} blockerId @param {string} targetUsername */
  block(blockerId, targetUsername) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(blockerId)) { rollback(this.database); return { kind: "lost-authority" }; }
      const target = this.repository.activeUserByUsername(targetUsername);
      if (!target || target.id === blockerId) { rollback(this.database); return { kind: "not-found" }; }
      this.repository.block(blockerId, target.id, this.now()); this.database.exec("COMMIT"); return { kind: "success" };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** The caller owns the surrounding serialized post-creation transaction. @param {string} userId
   * @returns {{kind: "allowed", createdAt: number} | {kind: "rate-limited", retryAfterSeconds: number} | {kind: "enforcement-unavailable"}} */
  enforcePostCreation(userId) {
    try {
      this.beforePostEnforcement();
      const now = this.now(); const cutoff = now - this.postRateLimitWindowMs;
      this.repository.expireCreationEvents(now - this.postRateLimitRetentionMs);
      const active = this.repository.creationEvents(userId, cutoff);
      if (active.length >= this.postRateLimitMax) {
        const oldest = active[0].created_at;
        return { kind: "rate-limited", retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.postRateLimitWindowMs - now) / 1_000)) };
      }
      return { kind: "allowed", createdAt: now };
    } catch { return { kind: "enforcement-unavailable" }; }
  }
  /** @param {string} userId @param {string} postId @param {number} createdAt */
  recordPostCreation(userId, postId, createdAt) { this.repository.recordCreation(randomUUID(), userId, postId, createdAt); }
}
