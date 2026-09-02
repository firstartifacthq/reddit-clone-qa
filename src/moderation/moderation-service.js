// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { createHash, randomUUID } from "node:crypto";
import { auditRepresentation, reportRepresentation } from "./moderation-representation.js";
import { parseReportJson, validateReport } from "./moderation-validation.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }
/** @param {string[]} communities */
function authorityKey(communities) { return createHash("sha256").update(JSON.stringify([...communities].sort())).digest("hex"); }

export class ModerationService {
  /** @param {{repository: import("./moderation-repository.js").ModerationRepository, database: {exec: (sql: string) => void}, now?: () => number, beforeModerationPersist?: () => void}} options */
  constructor({ repository, database, now = Date.now, beforeModerationPersist = () => {} }) {
    this.repository = repository; this.database = database; this.now = now; this.beforeModerationPersist = beforeModerationPersist;
  }
  /** @param {string} userId @param {string} postId */
  reportAdmission(userId, postId) {
    const target = this.repository.reportTargetFor(postId);
    if (!target) return "not-found";
    return this.repository.isMember(target.community_name, userId) ? "allowed" : "forbidden";
  }
  /** @param {string} userId @param {string} postId @param {string | Uint8Array | undefined} body */
  report(userId, postId, body) {
    const admission = this.reportAdmission(userId, postId);
    if (admission !== "allowed") return { kind: admission };
    const reason = validateReport(parseReportJson(body));
    if (!reason) return { kind: "invalid" };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const target = this.repository.reportTargetFor(postId);
      if (!target) { rollback(this.database); return { kind: "not-found" }; }
      if (!this.repository.isMember(target.community_name, userId)) { rollback(this.database); return { kind: "forbidden" }; }
      if (this.repository.hasOpenReport(postId, userId)) { rollback(this.database); return { kind: "duplicate" }; }
      const id = randomUUID(); this.repository.createReport({ id, postId, community: target.community_name, reporterId: userId, reason, createdAt: this.now() });
      const report = this.repository.findReport(id); this.database.exec("COMMIT"); return { kind: "success", report: reportRepresentation(report) };
    } catch (error) {
      rollback(this.database);
      if (error instanceof Error && /reports\.post_id, reports\.reporter_user_id/i.test(error.message)) return { kind: "duplicate" };
      return { kind: "unavailable" };
    }
  }
  /** @param {string} userId */
  authorities(userId) { return this.repository.authorityCommunities(userId); }
  /** @param {string} userId @param {number} limit @param {string | undefined} cursor */
  queue(userId, limit, cursor) {
    const current = this.authorities(userId); if (!current.length) return { kind: "forbidden" };
    const key = authorityKey(current);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      // Every continuation is bound to the role set currently held by its requester.
      const inside = this.authorities(userId); if (!inside.length) { rollback(this.database); return { kind: "forbidden" }; }
      const currentKey = authorityKey(inside);
      let traversalId; let start;
      if (cursor) {
        const token = this.repository.findToken(cursor, userId, this.now());
        if (!token || token.authority_key !== currentKey) { rollback(this.database); return { kind: "invalid-page" }; }
        traversalId = token.traversal_id; start = token.start_ordinal;
      } else {
        const rows = this.repository.currentReports(inside);
        if (!rows.length) { this.database.exec("COMMIT"); return { kind: "success", reports: [], nextCursor: null }; }
        traversalId = randomUUID(); start = 0; const now = this.now(); this.repository.createTraversal(traversalId, userId, key, now, now + DAY_MS, rows);
      }
      const rows = this.repository.pageFor(traversalId, start, limit);
      const nextStart = rows.length ? rows.at(-1).ordinal + 1 : start;
      const nextCursor = this.repository.hasMore(traversalId, nextStart) ? this.repository.createToken(randomUUID(), traversalId, nextStart) : null;
      this.database.exec("COMMIT"); return { kind: "success", reports: rows.map(reportRepresentation), nextCursor };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId @param {string} username @param {string} postId @param {"remove" | "restore"} action */
  transition(userId, username, postId, action) {
    const target = this.repository.moderationTarget(postId);
    if (!target) return { kind: "not-found" }; if (!this.repository.isModerator(target.community_name, userId)) return { kind: "forbidden" };
    const desired = action === "remove" ? "removed" : "visible";
    try {
      this.database.exec("BEGIN IMMEDIATE"); const inside = this.repository.moderationTarget(postId);
      if (!inside) { rollback(this.database); return { kind: "not-found" }; }
      if (!this.repository.isModerator(inside.community_name, userId)) { rollback(this.database); return { kind: "forbidden" }; }
      if (inside.moderation_state === desired) { this.database.exec("COMMIT"); return { kind: "success" }; }
      this.beforeModerationPersist(); this.repository.setState(desired, postId); const now = this.now();
      if (action === "remove") this.repository.resolveOpenReports(postId, now);
      const createdAt = Math.max(now, (this.repository.latestAuditFor(postId) ?? -1) + 1);
      this.repository.appendAudit({ id: randomUUID(), community: inside.community_name, postId, actor: username, action, createdAt });
      this.database.exec("COMMIT"); return { kind: "success" };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId @param {string} eventId */
  audit(userId, eventId) {
    if (!this.authorities(userId).length) return { kind: "forbidden" };
    const event = this.repository.findAudit(eventId); if (!event) return { kind: "not-found" };
    return this.repository.isModerator(event.community_name, userId) ? { kind: "success", event: auditRepresentation(event) } : { kind: "forbidden" };
  }
  /** @param {string} userId @param {string} community */
  modlog(userId, community) {
    if (!this.repository.hasCommunity(community)) return { kind: "not-found" };
    if (!this.repository.isModerator(community, userId)) return { kind: "forbidden" };
    return { kind: "success", entries: this.repository.auditFor(community).map(auditRepresentation) };
  }
}
