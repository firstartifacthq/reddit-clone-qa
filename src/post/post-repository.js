/** @typedef {object} Statement
 * @property {(...parameters: any[]) => {changes: number}} run
 * @property {(...parameters: any[]) => any} get
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */

export class PostRepository {
  /** @param {Database} database */
  constructor(database) {
    this.postingMember = database.prepare(`SELECT 1 FROM community_memberships AS membership
      JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE membership.community_name = ? AND membership.user_id = ?`);
    this.postById = database.prepare(`SELECT posts.*, users.username FROM posts JOIN users ON users.id = posts.author_user_id WHERE posts.id = ?`);
    this.mediaById = database.prepare("SELECT media_content_type, media_bytes FROM posts WHERE id = ? AND type = 'media'");
    this.idempotencyByKey = database.prepare("SELECT body_digest, response_json FROM post_idempotency WHERE author_user_id = ? AND community_name = ? AND idempotency_key = ?");
    this.insertPost = database.prepare(`INSERT INTO posts (id, community_name, author_user_id, type, title, text_content, url_content, media_filename, media_content_type, media_bytes, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertIdempotency = database.prepare(`INSERT INTO post_idempotency (author_user_id, community_name, idempotency_key, body_digest, post_id, response_json)
      VALUES (?, ?, ?, ?, ?, ?)`);
    this.updateText = database.prepare("UPDATE posts SET title = COALESCE(?, title), text_content = COALESCE(?, text_content) WHERE id = ? AND author_user_id = ? RETURNING *");
    this.updateLink = database.prepare("UPDATE posts SET title = COALESCE(?, title), url_content = COALESCE(?, url_content) WHERE id = ? AND author_user_id = ? RETURNING *");
    this.updateMedia = database.prepare(`UPDATE posts SET title = COALESCE(?, title), media_filename = COALESCE(?, media_filename),
      media_content_type = COALESCE(?, media_content_type), media_bytes = COALESCE(?, media_bytes) WHERE id = ? AND author_user_id = ? RETURNING *`);
    this.deleteByAuthor = database.prepare("DELETE FROM posts WHERE id = ? AND author_user_id = ?");
    this.countPosts = database.prepare("SELECT COUNT(*) AS count FROM posts");
  }

  /** @param {string} community @param {string} userId */
  isPostingMember(community, userId) { return Boolean(this.postingMember.get(community, userId)); }
  /** @param {string} id */
  findPost(id) { return this.postById.get(id); }
  /** @param {string} id */
  findMedia(id) { return this.mediaById.get(id); }
  /** @param {string} userId @param {string} community @param {string} key */
  findIdempotency(userId, community, key) { return this.idempotencyByKey.get(userId, community, key); }
  /** @param {{id: string, community: string, authorId: string, type: string, title: string, text?: string, url?: string, media?: {filename: string, contentType: string, bytes: Uint8Array}, publishedAt: number}} post */
  createPost(post) {
    this.insertPost.run(post.id, post.community, post.authorId, post.type, post.title, post.text ?? null, post.url ?? null,
      post.media?.filename ?? null, post.media?.contentType ?? null, post.media?.bytes ?? null, post.publishedAt);
  }
  /** @param {{authorId: string, community: string, key: string, digest: string, postId: string, snapshot: string}} entry */
  createIdempotency(entry) { this.insertIdempotency.run(entry.authorId, entry.community, entry.key, entry.digest, entry.postId, entry.snapshot); }
  /** @param {string} id @param {string} authorId @param {{title?: string, text?: string}} patch */
  updateTextPost(id, authorId, patch) { return this.updateText.get(patch.title ?? null, patch.text ?? null, id, authorId); }
  /** @param {string} id @param {string} authorId @param {{title?: string, url?: string}} patch */
  updateLinkPost(id, authorId, patch) { return this.updateLink.get(patch.title ?? null, patch.url ?? null, id, authorId); }
  /** @param {string} id @param {string} authorId @param {{title?: string, media?: {filename: string, contentType: string, bytes: Uint8Array}}} patch */
  updateMediaPost(id, authorId, patch) {
    return this.updateMedia.get(patch.title ?? null, patch.media?.filename ?? null, patch.media?.contentType ?? null, patch.media?.bytes ?? null, id, authorId);
  }
  /** @param {string} id @param {string} authorId */
  deletePost(id, authorId) { return this.deleteByAuthor.run(id, authorId).changes; }
  count() { return this.countPosts.get().count; }
}
