// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { createHash, randomUUID } from "node:crypto";
import { notificationRepresentation } from "./notification-representation.js";

/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }
/** @param {{id: string}[]} rows */
function membershipKey(rows) { const hash = createHash("sha256"); for (const row of rows) hash.update(row.id); return hash.digest("hex"); }
/** @param {string} body */
function mentionedNames(body) {
  const names = new Set(); const expression = /(?:^|[^A-Za-z0-9_-])u\/([A-Za-z0-9_-]{3,32})(?![A-Za-z0-9_-])/gi;
  for (const match of body.matchAll(expression)) names.add(match[1].toLowerCase());
  return names;
}

export class NotificationService {
  /** @param {{repository: import("./notification-repository.js").NotificationRepository, database: {exec: (sql: string) => void}, now?: () => number, randomToken?: () => string}} options */
  constructor({ repository, database, now = Date.now, randomToken = randomUUID }) { this.repository = repository; this.database = database; this.now = now; this.randomToken = randomToken; }
  /** @param {{eventKey: string, recipientId: string, kind: "reply" | "mention" | "vote" | "moderation", itemType: "comment" | "post", itemId: string, occurredAt?: number}} input */
  record(input) {
    if (!this.repository.isActiveUser(input.recipientId)) return;
    const event = this.repository.recordEvent({ id: randomUUID(), ...input, occurredAt: input.occurredAt ?? this.now() });
    this.repository.deliver(event);
  }
  /** @param {{id: string, author_user_id: string} | undefined} parent @param {{id: string, authorId: string, body: string}} comment */
  recordCommentEvents(parent, comment) {
    if (parent && parent.author_user_id !== comment.authorId) this.record({ eventKey: `comment:${comment.id}:reply:${parent.id}`, recipientId: parent.author_user_id, kind: "reply", itemType: "comment", itemId: comment.id });
    for (const name of mentionedNames(comment.body)) {
      const recipientId = this.repository.activeUserByUsername(name);
      if (recipientId && recipientId !== comment.authorId) this.record({ eventKey: `comment:${comment.id}:mention:${recipientId}`, recipientId, kind: "mention", itemType: "comment", itemId: comment.id });
    }
  }
  /** @param {string} recipientId @param {string} voterId @param {string} postId */
  recordVoteEvent(recipientId, voterId, postId) { if (recipientId !== voterId) this.record({ eventKey: `vote:${randomUUID()}`, recipientId, kind: "vote", itemType: "post", itemId: postId }); }
  /** @param {string} recipientId @param {string} moderatorId @param {string} postId @param {string} auditId */
  recordModerationEvent(recipientId, moderatorId, postId, auditId) { if (recipientId !== moderatorId) this.record({ eventKey: `moderation:${auditId}`, recipientId, kind: "moderation", itemType: "post", itemId: postId }); }
  /** @param {string} owner @param {number} limit @param {string | undefined} cursor */
  listing(owner, limit, cursor) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isActiveUser(owner)) { rollback(this.database); return { kind: "lost-authority" }; }
      let traversal; let start;
      if (cursor) {
        const token = this.repository.tokenFor(cursor, owner, this.now());
        if (!token) { rollback(this.database); return { kind: "invalid-page" }; }
        this.repository.reclaim(this.now()); traversal = token.traversal_id; start = token.start_ordinal;
      } else {
        this.repository.reclaim(this.now()); const rows = this.repository.listingRows(owner);
        if (rows.length <= limit) { this.database.exec("COMMIT"); return { kind: "success", notifications: rows.map(notificationRepresentation), nextCursor: null }; }
        const key = membershipKey(rows); traversal = this.repository.traversalFor(owner, key, this.now()) ?? this.repository.createTraversal(randomUUID(), owner, key, this.now(), rows); start = 0;
      }
      const rows = this.repository.pageFor(traversal, start, limit); const nextStart = rows.length ? rows.at(-1).ordinal + 1 : start;
      const nextCursor = this.repository.hasMore(traversal, nextStart) ? this.repository.createToken(this.randomToken(), traversal, nextStart) : null;
      this.database.exec("COMMIT"); return { kind: "success", notifications: rows.map(notificationRepresentation), nextCursor };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} owner @param {string} id @param {boolean} read */
  setRead(owner, id, read) {
    // Owner admission runs before payload-dependent transaction work and reveals no target data.
    if (!this.repository.ownsUndeleted(id, owner)) return { kind: "unavailable-target" };
    try { this.database.exec("BEGIN IMMEDIATE"); if (!this.repository.isActiveUser(owner)) { rollback(this.database); return { kind: "lost-authority" }; } if (!this.repository.updateReadState(id, owner, read)) { rollback(this.database); return { kind: "unavailable-target" }; } this.database.exec("COMMIT"); return { kind: "success" }; } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} owner @param {string} id */
  delete(owner, id) {
    if (!this.repository.ownsUndeleted(id, owner)) return { kind: "unavailable-target" };
    try { this.database.exec("BEGIN IMMEDIATE"); if (!this.repository.isActiveUser(owner)) { rollback(this.database); return { kind: "lost-authority" }; } if (!this.repository.delete(id, owner, this.now())) { rollback(this.database); return { kind: "unavailable-target" }; } this.database.exec("COMMIT"); return { kind: "success" }; } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} key */
  retry(key) {
    try { this.database.exec("BEGIN IMMEDIATE"); const event = this.repository.event.get(key); if (!event) { rollback(this.database); return { kind: "not-found" }; } this.repository.deliver(event); this.database.exec("COMMIT"); return { kind: "success" }; } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
}
