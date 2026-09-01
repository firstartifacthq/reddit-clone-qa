// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { createHash, randomUUID } from "node:crypto";
import { postRepresentation } from "./post-representation.js";
import { validateIdempotencyKey, validatePostCreate, validatePostPatch } from "./post-validation.js";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }
/** @param {string | Uint8Array | undefined} body */
function rawBytes(body) {
  // @ts-expect-error Buffer is supplied by the supported Node runtime.
  return typeof body === "string" ? Buffer.from(body) : body instanceof Uint8Array ? body : new Uint8Array();
}
/** @param {string | Uint8Array | undefined} body */
function parseBody(body) { try { return JSON.parse(strictUtf8.decode(rawBytes(body))); } catch { return undefined; } }
/** @param {string | Uint8Array | undefined} body */
function bodyDigest(body) { return createHash("sha256").update(rawBytes(body)).digest("hex"); }

export class PostService {
  /** @param {{repository: import("./post-repository.js").PostRepository, database: {exec: (sql: string) => void}, beforeMediaPersist?: () => void}} options */
  constructor({ repository, database, beforeMediaPersist = () => {} }) {
    this.repository = repository;
    this.database = database;
    this.beforeMediaPersist = beforeMediaPersist;
  }

  /** @param {string} userId @param {string} community @param {string | Uint8Array | undefined} rawBody @param {unknown} suppliedKey */
  create(userId, community, rawBody, suppliedKey) {
    // Admission deliberately precedes parsing so unauthenticated/denied malformed bodies do not disclose validation details.
    if (!this.repository.isPostingMember(community, userId)) return { kind: "forbidden" };
    const key = suppliedKey === undefined ? undefined : validateIdempotencyKey(suppliedKey);
    if (suppliedKey !== undefined && !key) return { kind: "invalid" };
    const validation = validatePostCreate(parseBody(rawBody));
    if (validation.kind !== "valid") return validation.kind === "too-large" ? { kind: "too-large" } : { kind: "invalid" };
    const digest = bodyDigest(rawBody);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.isPostingMember(community, userId)) {
        rollback(this.database);
        return { kind: "forbidden" };
      }
      if (key) {
        const prior = this.repository.findIdempotency(userId, community, key);
        if (prior) {
          rollback(this.database);
          return prior.body_digest === digest ? { kind: "success", post: JSON.parse(prior.response_json) } : { kind: "conflict" };
        }
      }
      const id = randomUUID();
      const valid = /** @type {{post: {type: string, title: string, text?: string, url?: string, media?: {filename: string, contentType: string, bytes: Uint8Array}}}} */ (validation);
      const post = { id, community, authorId: userId, ...valid.post };
      if (post.type === "media") this.beforeMediaPersist();
      this.repository.createPost(post);
      const stored = this.repository.findPost(id);
      const representation = postRepresentation(stored);
      if (key) this.repository.createIdempotency({ authorId: userId, community, key, digest, postId: id, snapshot: JSON.stringify(representation) });
      this.database.exec("COMMIT");
      return { kind: "success", post: representation };
    } catch {
      rollback(this.database);
      return { kind: "unavailable" };
    }
  }

  /** @param {string} userId @param {string} community */
  canCreate(userId, community) { return this.repository.isPostingMember(community, userId); }

  /** @param {string} userId @param {string} id */
  authorizeMutation(userId, id) {
    const post = this.repository.findPost(id);
    if (!post) return "not-found";
    return post.author_user_id === userId ? "allowed" : "forbidden";
  }

  /** @param {string} id */
  get(id) { const post = this.repository.findPost(id); return post ? postRepresentation(post) : undefined; }
  /** @param {string} id */
  media(id) { return this.repository.findMedia(id); }

  /** @param {string} userId @param {string} id @param {string | Uint8Array | undefined} rawBody */
  edit(userId, id, rawBody) {
    const current = this.repository.findPost(id);
    if (!current) return { kind: "not-found" };
    if (current.author_user_id !== userId) return { kind: "forbidden" };
    const validation = validatePostPatch(current.type, parseBody(rawBody));
    if (validation.kind !== "valid") return validation.kind === "too-large" ? { kind: "too-large" } : { kind: "invalid" };
    const valid = /** @type {{patch: {title?: string, text?: string, url?: string, media?: {filename: string, contentType: string, bytes: Uint8Array}}}} */ (validation);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      let stored;
      if (current.type === "text") stored = this.repository.updateTextPost(id, userId, valid.patch);
      else if (current.type === "link") stored = this.repository.updateLinkPost(id, userId, valid.patch);
      else {
        if (valid.patch.media) this.beforeMediaPersist();
        stored = this.repository.updateMediaPost(id, userId, valid.patch);
      }
      if (!stored) { rollback(this.database); return { kind: "forbidden" }; }
      const post = this.repository.findPost(id);
      this.database.exec("COMMIT");
      return { kind: "success", post: postRepresentation(post) };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }

  /** @param {string} userId @param {string} id */
  delete(userId, id) {
    const current = this.repository.findPost(id);
    if (!current) return { kind: "not-found" };
    if (current.author_user_id !== userId) return { kind: "forbidden" };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (this.repository.deletePost(id, userId) !== 1) { rollback(this.database); return { kind: "forbidden" }; }
      this.database.exec("COMMIT");
      return { kind: "success" };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
}
