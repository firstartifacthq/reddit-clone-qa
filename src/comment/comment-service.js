// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { randomUUID } from "node:crypto";
import { commentRepresentation } from "./comment-representation.js";
import { parseCommentJson, validateCommentCreate, validateCommentPatch } from "./comment-validation.js";

/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }

export class CommentService {
  /** @param {{repository: import("./comment-repository.js").CommentRepository, notificationService?: import("../notification/notification-service.js").NotificationService, database: {exec: (sql: string) => void}, beforeCommentPersist?: () => void}} options */
  constructor({ repository, notificationService, database, beforeCommentPersist = () => {} }) {
    this.repository = repository; this.notifications = notificationService; this.database = database; this.beforeCommentPersist = beforeCommentPersist;
  }
  /** @param {string} userId @param {string} postId */
  authorizeCreate(userId, postId) {
    if (!this.repository.hasPost(postId)) return "not-found";
    return this.repository.isMemberForPost(postId, userId) ? "allowed" : "forbidden";
  }
  /** @param {string} userId @param {string} commentId */
  authorizeMutation(userId, commentId) {
    // This admission query deliberately excludes stored bodies from denied paths.
    const comment = this.repository.admissionForMutation(commentId);
    if (!comment || comment.state !== "active") return "not-found";
    return comment.author_user_id === userId ? "allowed" : "forbidden";
  }
  /** @param {string} userId @param {string} postId @param {string | Uint8Array | undefined} rawBody */
  create(userId, postId, rawBody) {
    const admission = this.authorizeCreate(userId, postId);
    if (admission !== "allowed") return { kind: admission };
    const validation = validateCommentCreate(parseCommentJson(rawBody));
    if (validation.kind !== "valid") return { kind: "invalid" };
    const valid = /** @type {{kind: "valid", body: string, parentId: string | null}} */ (validation);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.hasPost(postId)) { rollback(this.database); return { kind: "not-found" }; }
      if (!this.repository.isMemberForPost(postId, userId)) { rollback(this.database); return { kind: "forbidden" }; }
      let depth = 0; let parent;
      if (valid.parentId) {
        parent = this.repository.findParent(valid.parentId);
        if (!parent || parent.post_id !== postId) { rollback(this.database); return { kind: "invalid" }; }
        depth = parent.depth + 1;
      }
      this.beforeCommentPersist();
      const id = randomUUID();
      this.repository.insert({ id, postId, parentId: valid.parentId, authorId: userId, body: valid.body, depth, sequence: this.repository.nextCreatedSequence() });
      this.notifications?.recordCommentEvents(parent, { id, authorId: userId, body: valid.body });
      const comment = this.repository.findComment(id);
      this.database.exec("COMMIT");
      return { kind: "success", comment: commentRepresentation(comment) };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} id */
  get(id) { const comment = this.repository.findComment(id); return comment ? commentRepresentation(comment) : undefined; }
  /** @param {string} userId @param {string} id @param {string | Uint8Array | undefined} rawBody */
  edit(userId, id, rawBody) {
    const admission = this.authorizeMutation(userId, id);
    if (admission !== "allowed") return { kind: admission };
    const validation = validateCommentPatch(parseCommentJson(rawBody));
    if (validation.kind !== "valid") return { kind: "invalid" };
    const valid = /** @type {{kind: "valid", body: string}} */ (validation);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.update(id, userId, valid.body)) { rollback(this.database); return { kind: "forbidden" }; }
      const comment = this.repository.findComment(id);
      this.database.exec("COMMIT");
      return { kind: "success", comment: commentRepresentation(comment) };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} userId @param {string} id */
  delete(userId, id) {
    const admission = this.authorizeMutation(userId, id);
    if (admission !== "allowed") return { kind: admission };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (this.repository.tombstone(id, userId) !== 1) { rollback(this.database); return { kind: "forbidden" }; }
      this.database.exec("COMMIT");
      return { kind: "success" };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  /** @param {string} postId @param {number} limit @param {string | undefined} cursor */
  conversation(postId, limit, cursor) {
    if (!this.repository.hasPost(postId)) return { kind: "not-found" };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      let traversalId; let start;
      if (cursor) {
        const token = this.repository.findToken(cursor, postId);
        if (!token) { rollback(this.database); return { kind: "invalid-page" }; }
        traversalId = token.traversal_id; start = token.start_ordinal;
      } else {
        if (!this.repository.hasPost(postId)) { rollback(this.database); return { kind: "not-found" }; }
        const ids = this.repository.orderedIds(postId);
        if (ids.length === 0) { this.database.exec("COMMIT"); return { kind: "success", comments: [], nextCursor: null }; }
        traversalId = randomUUID(); start = 0; this.repository.createTraversal(traversalId, postId, ids);
      }
      const total = this.repository.traversalCount(traversalId);
      const comments = this.repository.page(traversalId, start, start + limit).map(commentRepresentation);
      const nextStart = start + comments.length;
      const nextCursor = nextStart < total ? this.repository.createToken(randomUUID(), traversalId, nextStart) : null;
      this.database.exec("COMMIT");
      return { kind: "success", comments, nextCursor };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
}
