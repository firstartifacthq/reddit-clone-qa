// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { randomUUID } from "node:crypto";
import { postRepresentation } from "../post/post-representation.js";

const TRAVERSAL_TTL_MS = 24 * 60 * 60 * 1_000;
/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }

export class FeedService {
  /** @param {{repository: import("./feed-repository.js").FeedRepository, database: {exec: (sql: string) => void}, now?: () => number, beforeFeedCommit?: () => void}} options */
  constructor({ repository, database, now = Date.now, beforeFeedCommit = () => {} }) {
    this.repository = repository; this.database = database; this.now = now; this.beforeFeedCommit = beforeFeedCommit;
  }
  /** @param {{kind: "home" | "popular" | "community", community?: string, requesterId?: string}} context @param {number} limit @param {string | undefined} cursor */
  listing(context, limit, cursor) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (context.kind === "home" && (!context.requesterId || !this.repository.isActiveUser(context.requesterId))) {
        rollback(this.database); return { kind: "lost-authority" };
      }
      if (context.kind === "community" && (!context.community || !this.repository.hasCommunity(context.community))) {
        rollback(this.database); return { kind: "not-found" };
      }
      const now = this.now(); const community = context.community ?? null; const requesterId = context.requesterId ?? null;
      let traversalId; let start;
      if (cursor) {
        const token = this.repository.tokenFor(cursor, context.kind, community, requesterId, now);
        if (!token) { rollback(this.database); return { kind: "invalid-page" }; }
        traversalId = token.traversal_id; start = token.start_ordinal;
      } else {
        const rows = this.repository.candidates(context.kind, context.requesterId, context.community);
        if (rows.length <= limit) {
          const posts = rows.map(postRepresentation);
          this.beforeFeedCommit(); this.database.exec("COMMIT");
          return { kind: "success", posts, nextCursor: null };
        }
        this.repository.reclaimTraversals(now);
        traversalId = randomUUID(); start = 0;
        this.repository.createTraversal(traversalId, context.kind, community, requesterId, now, now + TRAVERSAL_TTL_MS, rows);
      }
      this.repository.reclaimTraversals(now);
      const rows = this.repository.pageFor(traversalId, start, limit);
      const nextStart = rows.length ? rows.at(-1).ordinal + 1 : start;
      const nextCursor = this.repository.hasMore(traversalId, nextStart)
        ? this.repository.createToken(randomUUID(), traversalId, nextStart) : null;
      const posts = rows.map(postRepresentation);
      this.beforeFeedCommit(); this.database.exec("COMMIT");
      return { kind: "success", posts, nextCursor };
    } catch {
      rollback(this.database); return { kind: "unavailable" };
    }
  }
}
