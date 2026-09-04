/** @typedef {{prepare: (sql: string) => any}} Database */

export class PersonalRepository {
  /** @param {Database} database */
  constructor(database) {
    this.activeUser = database.prepare("SELECT 1 FROM users WHERE id = ? AND deletion_requested_at IS NULL");
    this.post = database.prepare(`SELECT posts.*, users.username FROM readable_posts AS posts JOIN users ON users.id = posts.author_user_id AND users.deletion_requested_at IS NULL
      WHERE posts.id = ?`);
    this.insertSaved = database.prepare("INSERT OR IGNORE INTO saved_posts (user_id, post_id, saved_at) VALUES (?, ?, ?)");
    this.deleteSaved = database.prepare("DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?");
    this.upsertHistory = database.prepare(`INSERT INTO post_history (user_id, post_id, viewed_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, post_id) DO UPDATE SET viewed_at = excluded.viewed_at`);
    this.deleteExpiredHistory = database.prepare("DELETE FROM post_history WHERE user_id = ? AND viewed_at < ?");
    this.deleteExpiredItems = database.prepare(`DELETE FROM personal_traversal_items
      WHERE event_at < ? AND traversal_id IN (SELECT id FROM personal_traversals WHERE user_id = ? AND listing_kind = 'history')`);
    this.preferences = database.prepare("SELECT theme, compact_mode FROM user_preferences WHERE user_id = ?");
    this.upsertPreferences = database.prepare(`INSERT INTO user_preferences (user_id, theme, compact_mode) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, compact_mode = excluded.compact_mode`);
    this.deleteExpiredTraversals = database.prepare("DELETE FROM personal_traversals WHERE expires_at <= ?");
    this.insertTraversal = database.prepare(`INSERT OR IGNORE INTO personal_traversals
      (id, user_id, listing_kind, snapshot_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
    this.reusableTraversal = database.prepare(`SELECT id FROM personal_traversals
      WHERE user_id = ? AND listing_kind = ? AND snapshot_key = ? AND expires_at > ?`);
    this.insertItem = database.prepare("INSERT INTO personal_traversal_items (traversal_id, ordinal, post_id, event_at) VALUES (?, ?, ?, ?)");
    this.savedRows = database.prepare(`SELECT saved.post_id, saved.saved_at FROM saved_posts AS saved
      JOIN readable_posts AS post ON post.id = saved.post_id WHERE saved.user_id = ? ORDER BY saved.saved_at DESC, saved.post_id ASC`);
    this.historyRows = database.prepare(`SELECT history.post_id, history.viewed_at FROM post_history AS history
      JOIN readable_posts AS post ON post.id = history.post_id WHERE history.user_id = ? AND history.viewed_at >= ? ORDER BY history.viewed_at DESC, history.post_id ASC`);
    this.token = database.prepare(`SELECT token.traversal_id, token.start_ordinal FROM personal_page_tokens AS token
      JOIN personal_traversals AS traversal ON traversal.id = token.traversal_id
      WHERE token.token = ? AND traversal.user_id = ? AND traversal.listing_kind = ? AND traversal.expires_at > ?`);
    this.page = database.prepare(`SELECT item.ordinal, item.event_at, posts.*, users.username FROM personal_traversal_items AS item
      JOIN readable_posts AS posts ON posts.id = item.post_id JOIN users ON users.id = posts.author_user_id AND users.deletion_requested_at IS NULL
      WHERE item.traversal_id = ? AND item.ordinal >= ? ORDER BY item.ordinal LIMIT ?`);
    this.more = database.prepare(`SELECT 1 FROM personal_traversal_items AS item JOIN readable_posts AS post ON post.id = item.post_id
      WHERE item.traversal_id = ? AND item.ordinal >= ? LIMIT 1`);
    this.insertToken = database.prepare("INSERT OR IGNORE INTO personal_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)");
    this.tokenForStart = database.prepare("SELECT token FROM personal_page_tokens WHERE traversal_id = ? AND start_ordinal = ?");
  }
  /** @param {string} userId */ isActiveUser(userId) { return Boolean(this.activeUser.get(userId)); }
  /** @param {string} postId */ findReadablePost(postId) { return this.post.get(postId); }
  /** @param {string} userId @param {string} postId @param {number} now */ save(userId, postId, now) { this.insertSaved.run(userId, postId, now); }
  /** @param {string} userId @param {string} postId */ unsave(userId, postId) { this.deleteSaved.run(userId, postId); }
  /** @param {string} userId @param {string} postId @param {number} now */ view(userId, postId, now) { this.upsertHistory.run(userId, postId, now); }
  /** @param {string} userId @param {number} cutoff */ expireHistory(userId, cutoff) { this.deleteExpiredHistory.run(userId, cutoff); this.deleteExpiredItems.run(cutoff, userId); }
  /** @param {string} userId */ preferenceFor(userId) { return this.preferences.get(userId); }
  /** @param {string} userId @param {string} theme @param {boolean} compactMode */ savePreferences(userId, theme, compactMode) { this.upsertPreferences.run(userId, theme, compactMode ? 1 : 0); }
  /** @param {string} userId @param {"saved" | "history"} kind @param {number} cutoff */ rows(userId, kind, cutoff) { return kind === "saved" ? this.savedRows.all(userId) : this.historyRows.all(userId, cutoff); }
  /** @param {number} now */ reclaimTraversals(now) { this.deleteExpiredTraversals.run(now); }
  /** @param {string} userId @param {"saved" | "history"} kind @param {string} snapshotKey @param {number} now */
  traversalFor(userId, kind, snapshotKey, now) { return this.reusableTraversal.get(userId, kind, snapshotKey, now)?.id; }
  /** @param {string} id @param {string} userId @param {"saved" | "history"} kind @param {string} snapshotKey @param {number} createdAt @param {number} expiresAt @param {{post_id: string, saved_at?: number, viewed_at?: number}[]} rows */
  createTraversal(id, userId, kind, snapshotKey, createdAt, expiresAt, rows) {
    const result = this.insertTraversal.run(id, userId, kind, snapshotKey, createdAt, expiresAt);
    if (result.changes) rows.forEach((row, ordinal) => this.insertItem.run(id, ordinal, row.post_id, row.saved_at ?? row.viewed_at));
    return result.changes ? id : this.traversalFor(userId, kind, snapshotKey, createdAt);
  }
  /** @param {string} token @param {string} userId @param {"saved" | "history"} kind @param {number} now */ tokenFor(token, userId, kind, now) { return this.token.get(token, userId, kind, now); }
  /** @param {string} traversalId @param {number} start @param {number} limit */ pageFor(traversalId, start, limit) { return this.page.all(traversalId, start, limit); }
  /** @param {string} traversalId @param {number} start */ hasMore(traversalId, start) { return Boolean(this.more.get(traversalId, start)); }
  /** @param {string} token @param {string} traversalId @param {number} start */ createToken(token, traversalId, start) { this.insertToken.run(token, traversalId, start); return this.tokenForStart.get(traversalId, start).token; }
}
