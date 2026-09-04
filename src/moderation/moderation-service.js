// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { createHash, randomUUID } from "node:crypto";
import { postRepresentation } from "../post/post-representation.js";
import { auditRepresentation, reportRepresentation } from "./moderation-representation.js";

const TRAVERSAL_TTL_MS = 24 * 60 * 60 * 1_000;
/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }
/** @param {string[]} names */
function authorityDigest(names) { return createHash("sha256").update(JSON.stringify(names)).digest("hex"); }
/** @param {unknown} error */
function isDuplicateReport(error) {
  // SQLite's extended constraint code is stable machine-readable classification; diagnostic text is not.
  return typeof error === "object" && error !== null && "errcode" in error && error.errcode === 2067;
}

export class ModerationService {
  /** @param {{repository: import("./moderation-repository.js").ModerationRepository, database: {exec: (sql: string) => void}, now?: () => number, randomToken?: () => string, beforeModerationCommit?: () => void}} options */
  constructor({ repository, database, now = Date.now, randomToken = randomUUID, beforeModerationCommit = () => {} }) {
    this.repository = repository; this.database = database; this.now = now; this.randomToken = randomToken; this.beforeModerationCommit = beforeModerationCommit;
  }
  /** @param {string} userId @param {string} postId */
  report(userId, postId) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      const post = this.repository.readablePostById(postId);
      if (!post) { rollback(this.database); return { kind: "not-found" }; }
      if (!this.repository.isMemberForReadablePost(postId, userId)) { rollback(this.database); return { kind: "forbidden" }; }
      const report = this.repository.createReport({ id: randomUUID(), postId, community: post.community_name, reporterId: userId, reportedAt: this.now() });
      this.beforeModerationCommit(); this.database.exec("COMMIT");
      return { kind: "success", report: reportRepresentation(report) };
    } catch (error) {
      rollback(this.database); return isDuplicateReport(error) ? { kind: "duplicate" } : { kind: "unavailable" };
    }
  }
  /** @param {string} userId @param {number} limit @param {string | undefined} cursor */
  queue(userId, limit, cursor) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      const digest = authorityDigest(this.repository.authorityNames(userId));
      if (digest === authorityDigest([])) { rollback(this.database); return { kind: "forbidden" }; }
      const now = this.now(); let traversalId; let start;
      if (cursor) {
        const token = this.repository.tokenFor(cursor, userId, digest, now);
        if (!token) { rollback(this.database); return { kind: "invalid-page" }; }
        traversalId = token.traversal_id; start = token.start_ordinal;
      } else {
        const reports = this.repository.queueFor(userId);
        if (reports.length <= limit) { this.database.exec("COMMIT"); return { kind: "success", reports: reports.map(reportRepresentation), nextCursor: null }; }
        traversalId = randomUUID(); start = 0;
        this.repository.createTraversal(traversalId, userId, digest, now, now + TRAVERSAL_TTL_MS, reports);
      }
      const reports = this.repository.pageFor(traversalId, start, limit);
      const nextStart = reports.length ? reports.at(-1).ordinal + 1 : start;
      const nextCursor = this.repository.hasMore(traversalId, nextStart) ? this.repository.createToken(this.randomToken(), traversalId, nextStart) : null;
      this.database.exec("COMMIT"); return { kind: "success", reports: reports.map(reportRepresentation), nextCursor };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId @param {string} postId @param {"remove" | "restore"} transition */
  transition(userId, postId, transition) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      // Target lookup has only identity and community; denied paths never read reports or audit evidence.
      const post = this.repository.postById(postId);
      if (!post) { rollback(this.database); return { kind: "not-found" }; }
      if (!this.repository.hasAuthority(post.community_name, userId)) { rollback(this.database); return { kind: "forbidden" }; }
      const isChange = transition === "remove" ? post.moderation_state === "active" : post.moderation_state === "removed";
      if (isChange) {
        const changed = transition === "remove" ? this.repository.markRemoved(postId) : this.repository.markRestored(postId);
        if (changed !== 1) { rollback(this.database); return { kind: "unavailable" }; }
        this.repository.appendAudit({ id: randomUUID(), postId, community: post.community_name, moderatorId: userId, action: transition === "remove" ? "removed" : "restored", occurredAt: this.now() });
        this.beforeModerationCommit();
      }
      const restored = transition === "restore" ? this.repository.readablePostRepresentation(postId) : undefined;
      this.database.exec("COMMIT");
      return transition === "restore" ? { kind: "success", post: postRepresentation(restored) } : { kind: "success" };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} community */
  modlog(community) { return this.repository.auditsForCommunity(community).map(auditRepresentation); }
}
