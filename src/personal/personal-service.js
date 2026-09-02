// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { randomUUID } from "node:crypto";
import { postRepresentation } from "../post/post-representation.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const defaultPreferences = Object.freeze({ theme: "system", compactMode: false });
/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }
/** @param {{theme: string, compact_mode: number} | undefined} row */
function preferenceRepresentation(row) { return row ? { theme: row.theme, compactMode: Boolean(row.compact_mode) } : { ...defaultPreferences }; }

export class PersonalService {
  /** @param {{repository: import("./personal-repository.js").PersonalRepository, database: {exec: (sql: string) => void}, now?: () => number, beforeSavedPersist?: () => void, beforeHistoryPersist?: () => void, beforePreferencePersist?: () => void}} options */
  constructor({ repository, database, now = Date.now, beforeSavedPersist = () => {}, beforeHistoryPersist = () => {}, beforePreferencePersist = () => {} }) {
    this.repository = repository; this.database = database; this.now = now; this.beforeSavedPersist = beforeSavedPersist; this.beforeHistoryPersist = beforeHistoryPersist; this.beforePreferencePersist = beforePreferencePersist;
  }
  /** @param {string} userId @param {string} postId */
  save(userId, postId) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      if (!this.repository.findReadablePost(postId)) { rollback(this.database); return { kind: "not-found" }; }
      this.beforeSavedPersist(); this.repository.save(userId, postId, this.now()); this.database.exec("COMMIT"); return { kind: "success" };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId @param {string} postId */
  unsave(userId, postId) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      this.beforeSavedPersist(); this.repository.unsave(userId, postId); this.database.exec("COMMIT"); return { kind: "success" };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId @param {string} postId */
  readAndRecord(userId, postId) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      const post = this.repository.findReadablePost(postId);
      if (!post) { rollback(this.database); return { kind: "not-found" }; }
      const now = this.now(); this.beforeHistoryPersist(); this.repository.view(userId, postId, now); this.repository.expireHistory(userId, now - 90 * DAY_MS);
      this.database.exec("COMMIT"); return { kind: "success", post: postRepresentation(post) };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId */ preferences(userId) { return preferenceRepresentation(this.repository.preferenceFor(userId)); }
  /** @param {string} userId @param {{theme?: "system" | "light" | "dark", compactMode?: boolean}} patch */
  updatePreferences(userId, patch) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      const prior = preferenceRepresentation(this.repository.preferenceFor(userId)); const next = { ...prior, ...patch };
      this.beforePreferencePersist(); this.repository.savePreferences(userId, next.theme, next.compactMode); this.database.exec("COMMIT"); return { kind: "success", preferences: next };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId @param {"saved" | "history"} kind @param {number} limit @param {string | undefined} cursor */
  listing(userId, kind, limit, cursor) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(userId)) { rollback(this.database); return { kind: "lost-authority" }; }
      const cutoff = this.now() - 90 * DAY_MS; if (kind === "history") this.repository.expireHistory(userId, cutoff);
      let traversalId; let start;
      if (cursor) {
        const token = this.repository.tokenFor(cursor, userId, kind);
        if (!token) { rollback(this.database); return { kind: "invalid-page" }; }
        traversalId = token.traversal_id; start = token.start_ordinal;
      } else {
        const rows = this.repository.rows(userId, kind, cutoff); if (rows.length === 0) { this.database.exec("COMMIT"); return { kind: "success", items: [], nextCursor: null }; }
        traversalId = randomUUID(); start = 0; this.repository.createTraversal(traversalId, userId, kind, rows);
      }
      const rows = this.repository.pageFor(traversalId, start, limit); const nextStart = rows.length ? rows.at(-1).ordinal + 1 : start;
      const nextCursor = this.repository.hasMore(traversalId, nextStart) ? this.repository.createToken(randomUUID(), traversalId, nextStart) : null;
      this.database.exec("COMMIT"); return { kind: "success", items: rows.map((/** @type {any} */ row) => ({ post: postRepresentation(row), viewedAt: new Date(row.event_at).toISOString() })), nextCursor };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
}
