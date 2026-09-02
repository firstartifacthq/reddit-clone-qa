// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { randomUUID } from "node:crypto";
import { feedPostRepresentation } from "../post/post-representation.js";

/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }

export class FeedService {
  /** @param {{repository: import("./feed-repository.js").FeedRepository, database: {exec: (sql: string) => void}, now?: () => number, feedTraversalLifetimeMs: number, beforeFeedSnapshotPersist?: () => void, beforeFeedRead?: () => void}} options */
  constructor({ repository, database, now = Date.now, feedTraversalLifetimeMs, beforeFeedSnapshotPersist = () => {}, beforeFeedRead = () => {} }) {
    this.repository = repository;
    this.database = database;
    this.now = now;
    this.feedTraversalLifetimeMs = feedTraversalLifetimeMs;
    this.beforeFeedSnapshotPersist = beforeFeedSnapshotPersist;
    this.beforeFeedRead = beforeFeedRead;
  }

  /** @param {"home" | "popular" | "community"} kind @param {string | null} communityName @param {string} principalId @param {number} limit @param {string | undefined} cursor */
  read(kind, communityName, principalId, limit, cursor) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const now = this.now();
      let traversalId;
      let startOrdinal;
      if (cursor) {
        const traversal = this.repository.findToken(cursor);
        if (!traversal || traversal.kind !== kind || traversal.community_name !== communityName
          || traversal.principal_id !== principalId || traversal.expires_at <= now) {
          rollback(this.database);
          return { kind: "invalid-page" };
        }
        traversalId = traversal.id;
        startOrdinal = traversal.start_ordinal;
      } else {
        if (kind === "community" && (!communityName || !this.repository.hasCommunity(communityName))) {
          rollback(this.database);
          return { kind: "not-found" };
        }
        this.repository.removeExpired(now);
        const candidates = kind === "home" ? this.repository.candidatesForHome(principalId)
          : kind === "community" ? this.repository.candidatesForCommunity(/** @type {string} */ (communityName))
            : this.repository.candidatesForPopular();
        traversalId = randomUUID();
        startOrdinal = 0;
        this.beforeFeedSnapshotPersist();
        this.repository.createTraversal({
          id: traversalId, kind, communityName, principalId, createdAt: now,
          expiresAt: now + this.feedTraversalLifetimeMs,
        });
        this.repository.createItems(traversalId, candidates);
      }
      this.beforeFeedRead();
      const rows = this.repository.page(traversalId, startOrdinal, limit + 1);
      const pageRows = rows.slice(0, limit);
      let nextCursor = null;
      if (rows.length > limit) {
        const nextStart = pageRows.at(-1).ordinal + 1;
        nextCursor = this.repository.createToken(randomUUID(), traversalId, nextStart);
      }
      const posts = pageRows.map(feedPostRepresentation);
      this.database.exec("COMMIT");
      return { kind: "success", posts, nextCursor };
    } catch {
      rollback(this.database);
      return { kind: "unavailable" };
    }
  }
}
