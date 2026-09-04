/** @typedef {{prepare: (sql: string) => any}} Database */

export class FeedRepository {
  /** @param {Database} database */
  constructor(database) {
    this.activeUser = database.prepare("SELECT 1 FROM users WHERE id = ? AND deletion_requested_at IS NULL");
    this.community = database.prepare("SELECT 1 FROM communities WHERE canonical_name = ?");
    const readable = `FROM readable_posts AS posts JOIN users ON users.id = posts.author_user_id AND users.deletion_requested_at IS NULL
      JOIN communities ON communities.canonical_name = posts.community_name`;
    this.homeCandidates = database.prepare(`SELECT posts.*, users.username, COALESCE(SUM(post_votes.value), 0) AS score ${readable}
      JOIN community_memberships AS membership ON membership.community_name = posts.community_name AND membership.user_id = ?
      LEFT JOIN post_votes ON post_votes.post_id = posts.id
      GROUP BY posts.id ORDER BY posts.published_at DESC, score DESC, posts.id ASC`);
    this.popularCandidates = database.prepare(`SELECT posts.*, users.username, COALESCE(SUM(post_votes.value), 0) AS score ${readable}
      LEFT JOIN post_votes ON post_votes.post_id = posts.id
      GROUP BY posts.id ORDER BY score DESC, posts.published_at DESC, posts.id ASC`);
    this.communityCandidates = database.prepare(`SELECT posts.*, users.username, COALESCE(SUM(post_votes.value), 0) AS score ${readable}
      LEFT JOIN post_votes ON post_votes.post_id = posts.id WHERE posts.community_name = ?
      GROUP BY posts.id ORDER BY posts.published_at DESC, score DESC, posts.id ASC`);
    this.insertTraversal = database.prepare(`INSERT INTO feed_traversals
      (id, feed_kind, community_name, requester_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
    this.insertItem = database.prepare("INSERT INTO feed_traversal_items (traversal_id, ordinal, post_id) VALUES (?, ?, ?)");
    this.deleteExpired = database.prepare("DELETE FROM feed_traversals WHERE expires_at <= ?");
    this.token = database.prepare(`SELECT token.traversal_id, token.start_ordinal FROM feed_page_tokens AS token
      JOIN feed_traversals AS traversal ON traversal.id = token.traversal_id
      WHERE token.token = ? AND traversal.feed_kind = ? AND traversal.community_name IS ?
        AND traversal.requester_user_id IS ? AND traversal.expires_at > ?`);
    this.page = database.prepare(`SELECT item.ordinal, posts.*, users.username FROM feed_traversal_items AS item
      JOIN readable_posts AS posts ON posts.id = item.post_id
      JOIN users ON users.id = posts.author_user_id AND users.deletion_requested_at IS NULL
      JOIN communities ON communities.canonical_name = posts.community_name
      WHERE item.traversal_id = ? AND item.ordinal >= ? ORDER BY item.ordinal LIMIT ?`);
    this.more = database.prepare(`SELECT 1 FROM feed_traversal_items AS item
      JOIN readable_posts AS posts ON posts.id = item.post_id
      JOIN users ON users.id = posts.author_user_id AND users.deletion_requested_at IS NULL
      JOIN communities ON communities.canonical_name = posts.community_name
      WHERE item.traversal_id = ? AND item.ordinal >= ? LIMIT 1`);
    this.insertToken = database.prepare("INSERT OR IGNORE INTO feed_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)");
    this.tokenAtStart = database.prepare("SELECT token FROM feed_page_tokens WHERE traversal_id = ? AND start_ordinal = ?");
  }
  /** @param {string} userId */ isActiveUser(userId) { return Boolean(this.activeUser.get(userId)); }
  /** @param {string} name */ hasCommunity(name) { return Boolean(this.community.get(name)); }
  /** @param {"home" | "popular" | "community"} kind @param {string | undefined} requesterId @param {string | undefined} community */
  candidates(kind, requesterId, community) {
    if (kind === "home") return this.homeCandidates.all(requesterId);
    if (kind === "community") return this.communityCandidates.all(community);
    return this.popularCandidates.all();
  }
  /** @param {number} now */ reclaimTraversals(now) { this.deleteExpired.run(now); }
  /** @param {string} token @param {"home" | "popular" | "community"} kind @param {string | null} community @param {string | null} requesterId @param {number} now */
  tokenFor(token, kind, community, requesterId, now) { return this.token.get(token, kind, community, requesterId, now); }
  /** @param {string} id @param {"home" | "popular" | "community"} kind @param {string | null} community @param {string | null} requesterId @param {number} createdAt @param {number} expiresAt @param {{id: string}[]} rows */
  createTraversal(id, kind, community, requesterId, createdAt, expiresAt, rows) {
    this.insertTraversal.run(id, kind, community, requesterId, createdAt, expiresAt);
    rows.forEach((row, ordinal) => this.insertItem.run(id, ordinal, row.id));
  }
  /** @param {string} traversalId @param {number} start @param {number} limit */ pageFor(traversalId, start, limit) { return this.page.all(traversalId, start, limit); }
  /** @param {string} traversalId @param {number} start */ hasMore(traversalId, start) { return Boolean(this.more.get(traversalId, start)); }
  /** @param {string} token @param {string} traversalId @param {number} start */
  createToken(token, traversalId, start) { this.insertToken.run(token, traversalId, start); return this.tokenAtStart.get(traversalId, start).token; }
}
