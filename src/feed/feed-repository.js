/** @typedef {object} Statement
 * @property {(...parameters: any[]) => {changes: number}} run
 * @property {(...parameters: any[]) => any} get
 * @property {(...parameters: any[]) => any[]} all
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */

export class FeedRepository {
  /** @param {Database} database */
  constructor(database) {
    const readable = `FROM posts
      JOIN users ON users.id = posts.author_user_id
      JOIN post_creation_order AS creation_order ON creation_order.post_id = posts.id
      LEFT JOIN post_votes AS vote ON vote.post_id = posts.id`;
    const ranked = `SELECT posts.id, COALESCE(SUM(vote.value), 0) AS score
      ${readable}`;
    this.homeCandidates = database.prepare(`${ranked}
      WHERE EXISTS (SELECT 1 FROM community_memberships AS membership
        WHERE membership.community_name = posts.community_name AND membership.user_id = ?)
      GROUP BY posts.id
      ORDER BY score DESC, creation_order.sequence DESC, posts.id ASC`);
    this.popularCandidates = database.prepare(`${ranked}
      GROUP BY posts.id
      ORDER BY score DESC, creation_order.sequence DESC, posts.id ASC`);
    this.communityCandidates = database.prepare(`${ranked}
      WHERE posts.community_name = ?
      GROUP BY posts.id
      ORDER BY score DESC, creation_order.sequence DESC, posts.id ASC`);
    this.community = database.prepare("SELECT 1 FROM communities WHERE canonical_name = ?");
    this.insertTraversal = database.prepare(`INSERT INTO feed_traversals
      (id, kind, community_name, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
    this.insertItem = database.prepare(`INSERT INTO feed_traversal_items
      (traversal_id, ordinal, post_id, score) VALUES (?, ?, ?, ?)`);
    this.token = database.prepare(`SELECT traversal.*, feed_page_tokens.start_ordinal
      FROM feed_page_tokens JOIN feed_traversals AS traversal ON traversal.id = feed_page_tokens.traversal_id
      WHERE feed_page_tokens.token = ?`);
    this.insertToken = database.prepare("INSERT OR IGNORE INTO feed_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)");
    this.tokenForOffset = database.prepare("SELECT token FROM feed_page_tokens WHERE traversal_id = ? AND start_ordinal = ?");
    this.readablePage = database.prepare(`SELECT posts.*, users.username, item.score, item.ordinal
      FROM feed_traversal_items AS item
      JOIN posts ON posts.id = item.post_id
      JOIN users ON users.id = posts.author_user_id
      WHERE item.traversal_id = ? AND item.ordinal >= ?
      ORDER BY item.ordinal
      LIMIT ?`);
    this.deleteExpired = database.prepare("DELETE FROM feed_traversals WHERE expires_at <= ?");
  }

  /** @param {string} name */
  hasCommunity(name) { return Boolean(this.community.get(name)); }
  /** @param {string} principalId */
  candidatesForHome(principalId) { return this.homeCandidates.all(principalId); }
  candidatesForPopular() { return this.popularCandidates.all(); }
  /** @param {string} name */
  candidatesForCommunity(name) { return this.communityCandidates.all(name); }
  /** @param {{id: string, kind: "home" | "popular" | "community", communityName: string | null, principalId: string, createdAt: number, expiresAt: number}} traversal */
  createTraversal(traversal) {
    this.insertTraversal.run(traversal.id, traversal.kind, traversal.communityName, traversal.principalId, traversal.createdAt, traversal.expiresAt);
  }
  /** @param {string} traversalId @param {{id: string, score: number}[]} candidates */
  createItems(traversalId, candidates) {
    candidates.forEach((candidate, ordinal) => this.insertItem.run(traversalId, ordinal, candidate.id, candidate.score));
  }
  /** @param {string} token */
  findToken(token) { return this.token.get(token); }
  /** @param {string} traversalId @param {number} startOrdinal */
  tokenFor(traversalId, startOrdinal) { return this.tokenForOffset.get(traversalId, startOrdinal)?.token; }
  /** @param {string} token @param {string} traversalId @param {number} startOrdinal */
  createToken(token, traversalId, startOrdinal) {
    this.insertToken.run(token, traversalId, startOrdinal);
    return this.tokenFor(traversalId, startOrdinal);
  }
  /** @param {string} traversalId @param {number} startOrdinal @param {number} size */
  page(traversalId, startOrdinal, size) { return this.readablePage.all(traversalId, startOrdinal, size); }
  /** @param {number} now */
  removeExpired(now) { this.deleteExpired.run(now); }
}
