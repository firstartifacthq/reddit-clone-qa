/** @typedef {object} Statement
 * @property {(...parameters: any[]) => {changes: number}} run
 * @property {(...parameters: any[]) => any} get
 * @property {(...parameters: any[]) => any[]} all
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */

export class CommentRepository {
  /** @param {Database} database */
  constructor(database) {
    this.postExists = database.prepare("SELECT 1 FROM readable_posts WHERE id = ?");
    this.memberForPost = database.prepare(`SELECT 1 FROM readable_posts AS posts
      JOIN community_memberships AS membership ON membership.community_name = posts.community_name
      JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE posts.id = ? AND membership.user_id = ?`);
    this.commentById = database.prepare(`SELECT comments.*, users.username FROM comments
      JOIN readable_posts AS post ON post.id = comments.post_id LEFT JOIN users ON users.id = comments.author_user_id WHERE comments.id = ?`);
    this.mutationAdmission = database.prepare(`SELECT comments.author_user_id, comments.state FROM comments
      JOIN readable_posts AS post ON post.id = comments.post_id WHERE comments.id = ?`);
    this.parentById = database.prepare("SELECT id, post_id, depth, author_user_id FROM comments WHERE id = ?");
    this.nextSequence = database.prepare("SELECT COALESCE(MAX(created_sequence), 0) + 1 AS value FROM comments");
    this.insertComment = database.prepare(`INSERT INTO comments (id, post_id, parent_id, author_user_id, body, depth, state, created_sequence)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`);
    this.updateComment = database.prepare("UPDATE comments SET body = ? WHERE id = ? AND author_user_id = ? AND state = 'active' RETURNING id");
    this.tombstoneComment = database.prepare("UPDATE comments SET state = 'deleted', author_user_id = NULL, body = NULL WHERE id = ? AND author_user_id = ? AND state = 'active'");
    this.commentsForPost = database.prepare("SELECT id, parent_id, created_sequence FROM comments WHERE post_id = ? ORDER BY created_sequence, id");
    this.insertTraversal = database.prepare("INSERT INTO comment_traversals (id, post_id) VALUES (?, ?)");
    this.insertTraversalItem = database.prepare("INSERT INTO comment_traversal_items (traversal_id, ordinal, comment_id) VALUES (?, ?, ?)");
    this.pageToken = database.prepare(`SELECT comment_page_tokens.token FROM comment_page_tokens
      JOIN comment_traversals ON comment_traversals.id = comment_page_tokens.traversal_id
      WHERE comment_page_tokens.token = ? AND comment_traversals.post_id = ?`);
    this.insertToken = database.prepare("INSERT OR IGNORE INTO comment_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)");
    this.tokenForOffset = database.prepare("SELECT token FROM comment_page_tokens WHERE traversal_id = ? AND start_ordinal = ?");
    this.pageFromToken = database.prepare(`SELECT comment_page_tokens.traversal_id, comment_page_tokens.start_ordinal FROM comment_page_tokens
      JOIN comment_traversals ON comment_traversals.id = comment_page_tokens.traversal_id
      WHERE comment_page_tokens.token = ? AND comment_traversals.post_id = ?`);
    this.snapshotTotal = database.prepare("SELECT COUNT(*) AS count FROM comment_traversal_items WHERE traversal_id = ?");
    this.snapshotPage = database.prepare(`SELECT comments.*, users.username FROM comment_traversal_items AS item
      JOIN comments ON comments.id = item.comment_id JOIN readable_posts AS post ON post.id = comments.post_id
      LEFT JOIN users ON users.id = comments.author_user_id
      WHERE item.traversal_id = ? AND item.ordinal >= ? AND item.ordinal < ? ORDER BY item.ordinal`);
  }
  /** @param {string} postId */
  hasPost(postId) { return Boolean(this.postExists.get(postId)); }
  /** @param {string} postId @param {string} userId */
  isMemberForPost(postId, userId) { return Boolean(this.memberForPost.get(postId, userId)); }
  /** @param {string} id */
  findComment(id) { return this.commentById.get(id); }
  /** @param {string} id */
  admissionForMutation(id) { return this.mutationAdmission.get(id); }
  /** @param {string} id */
  findParent(id) { return this.parentById.get(id); }
  nextCreatedSequence() { return this.nextSequence.get().value; }
  /** @param {{id: string, postId: string, parentId: string | null, authorId: string, body: string, depth: number, sequence: number}} comment */
  insert(comment) { this.insertComment.run(comment.id, comment.postId, comment.parentId, comment.authorId, comment.body, comment.depth, comment.sequence); }
  /** @param {string} id @param {string} authorId @param {string} body */
  update(id, authorId, body) { return this.updateComment.get(body, id, authorId); }
  /** @param {string} id @param {string} authorId */
  tombstone(id, authorId) { return this.tombstoneComment.run(id, authorId).changes; }
  /** @param {string} postId */
  orderedIds(postId) {
    const nodes = this.commentsForPost.all(postId);
    const children = new Map();
    for (const node of nodes) { const key = node.parent_id ?? ""; const values = children.get(key) || []; values.push(node); children.set(key, values); }
    /** @type {string[]} */
    const ids = [];
    /** @param {string | null} parentId */
    const visit = (parentId) => { for (const node of children.get(parentId ?? "") || []) { ids.push(node.id); visit(node.id); } };
    visit(null);
    return ids;
  }
  /** @param {string} id @param {string} postId @param {string[]} ids */
  createTraversal(id, postId, ids) { this.insertTraversal.run(id, postId); ids.forEach((commentId, ordinal) => this.insertTraversalItem.run(id, ordinal, commentId)); }
  /** @param {string} token @param {string} postId */
  findToken(token, postId) { return this.pageFromToken.get(token, postId); }
  /** @param {string} traversalId */
  traversalCount(traversalId) { return this.snapshotTotal.get(traversalId).count; }
  /** @param {string} traversalId @param {number} start @param {number} end */
  page(traversalId, start, end) { return this.snapshotPage.all(traversalId, start, end); }
  /** @param {string} token @param {string} traversalId @param {number} start */
  createToken(token, traversalId, start) { this.insertToken.run(token, traversalId, start); return this.tokenForOffset.get(traversalId, start).token; }
}
