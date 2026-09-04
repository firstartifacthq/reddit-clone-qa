/** @typedef {{prepare: (sql: string) => any}} Database */

export class ModerationRepository {
  /** @param {Database} database */
  constructor(database) {
    this.activeUser = database.prepare("SELECT 1 FROM users WHERE id = ? AND deletion_requested_at IS NULL");
    this.readablePost = database.prepare(`SELECT post.id, post.community_name FROM readable_posts AS post
      JOIN users AS author ON author.id = post.author_user_id AND author.deletion_requested_at IS NULL WHERE post.id = ?`);
    this.memberForPost = database.prepare(`SELECT 1 FROM readable_posts AS post JOIN community_memberships AS membership
      ON membership.community_name = post.community_name JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE post.id = ? AND membership.user_id = ?`);
    this.canonicalPost = database.prepare("SELECT id, community_name, moderation_state FROM posts WHERE id = ?");
    this.readableRepresentation = database.prepare(`SELECT post.*, users.username FROM readable_posts AS post
      JOIN users ON users.id = post.author_user_id AND users.deletion_requested_at IS NULL WHERE post.id = ?`);
    this.authorityFor = database.prepare(`SELECT 1 FROM community_memberships AS membership
      JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE membership.community_name = ? AND membership.user_id = ? AND membership.role IN ('owner', 'moderator')`);
    this.authorityCommunities = database.prepare(`SELECT membership.community_name FROM community_memberships AS membership
      JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE membership.user_id = ? AND membership.role IN ('owner', 'moderator') ORDER BY membership.community_name`);
    this.nextReportSequence = database.prepare("SELECT COALESCE(MAX(occurrence_sequence), 0) + 1 AS value FROM reports");
    this.insertReport = database.prepare(`INSERT INTO reports (id, occurrence_sequence, post_id, community_name, reporter_user_id, reported_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    this.reportById = database.prepare("SELECT * FROM reports WHERE id = ?");
    this.queueCandidates = database.prepare(`SELECT reports.* FROM reports JOIN community_memberships AS membership
      ON membership.community_name = reports.community_name JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE membership.user_id = ? AND membership.role IN ('owner', 'moderator') ORDER BY reports.occurrence_sequence, reports.id`);
    this.deleteExpiredTraversals = database.prepare("DELETE FROM moderation_queue_traversals WHERE expires_at <= ?");
    this.insertTraversal = database.prepare(`INSERT INTO moderation_queue_traversals
      (id, requester_user_id, authority_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`);
    this.insertItem = database.prepare("INSERT INTO moderation_queue_items (traversal_id, ordinal, report_id) VALUES (?, ?, ?)");
    this.token = database.prepare(`SELECT token.traversal_id, token.start_ordinal FROM moderation_queue_tokens AS token
      JOIN moderation_queue_traversals AS traversal ON traversal.id = token.traversal_id
      WHERE token.token = ? AND traversal.requester_user_id = ? AND traversal.authority_digest = ? AND traversal.expires_at > ?`);
    this.page = database.prepare(`SELECT item.ordinal, reports.* FROM moderation_queue_items AS item JOIN reports ON reports.id = item.report_id
      WHERE item.traversal_id = ? AND item.ordinal >= ? ORDER BY item.ordinal LIMIT ?`);
    this.more = database.prepare("SELECT 1 FROM moderation_queue_items WHERE traversal_id = ? AND ordinal >= ? LIMIT 1");
    this.insertToken = database.prepare("INSERT OR IGNORE INTO moderation_queue_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)");
    this.tokenAtStart = database.prepare("SELECT token FROM moderation_queue_tokens WHERE traversal_id = ? AND start_ordinal = ?");
    this.removePost = database.prepare("UPDATE posts SET moderation_state = 'removed' WHERE id = ? AND moderation_state = 'active'");
    this.restorePost = database.prepare("UPDATE posts SET moderation_state = 'active' WHERE id = ? AND moderation_state = 'removed'");
    this.nextAuditSequence = database.prepare("SELECT COALESCE(MAX(occurrence_sequence), 0) + 1 AS value FROM moderation_audit_events");
    this.insertAudit = database.prepare(`INSERT INTO moderation_audit_events
      (id, occurrence_sequence, post_id, community_name, moderator_user_id, action, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.auditByCommunity = database.prepare("SELECT * FROM moderation_audit_events WHERE community_name = ? ORDER BY occurrence_sequence, id");
  }
  /** @param {string} userId */ isActiveUser(userId) { return Boolean(this.activeUser.get(userId)); }
  /** @param {string} id */ readablePostById(id) { return this.readablePost.get(id); }
  /** @param {string} id @param {string} userId */ isMemberForReadablePost(id, userId) { return Boolean(this.memberForPost.get(id, userId)); }
  /** @param {string} id */ postById(id) { return this.canonicalPost.get(id); }
  /** @param {string} id */ readablePostRepresentation(id) { return this.readableRepresentation.get(id); }
  /** @param {string} community @param {string} userId */ hasAuthority(community, userId) { return Boolean(this.authorityFor.get(community, userId)); }
  /** @param {string} userId */ authorityNames(userId) { return this.authorityCommunities.all(userId).map((/** @type {{community_name: string}} */ row) => row.community_name); }
  /** @param {{id: string, postId: string, community: string, reporterId: string, reportedAt: number}} report */
  createReport(report) { this.insertReport.run(report.id, this.nextReportSequence.get().value, report.postId, report.community, report.reporterId, report.reportedAt); return this.reportById.get(report.id); }
  /** @param {string} userId */ queueFor(userId) { return this.queueCandidates.all(userId); }
  /** @param {number} now */ reclaimExpiredTraversals(now) { this.deleteExpiredTraversals.run(now); }
  /** @param {string} id @param {string} requesterId @param {string} digest @param {number} createdAt @param {number} expiresAt @param {{id: string}[]} rows */
  createTraversal(id, requesterId, digest, createdAt, expiresAt, rows) { this.insertTraversal.run(id, requesterId, digest, createdAt, expiresAt); rows.forEach((row, ordinal) => this.insertItem.run(id, ordinal, row.id)); }
  /** @param {string} token @param {string} requesterId @param {string} digest @param {number} now */ tokenFor(token, requesterId, digest, now) { return this.token.get(token, requesterId, digest, now); }
  /** @param {string} id @param {number} start @param {number} limit */ pageFor(id, start, limit) { return this.page.all(id, start, limit); }
  /** @param {string} id @param {number} start */ hasMore(id, start) { return Boolean(this.more.get(id, start)); }
  /** @param {string} token @param {string} traversalId @param {number} start */ createToken(token, traversalId, start) { this.insertToken.run(token, traversalId, start); return this.tokenAtStart.get(traversalId, start).token; }
  /** @param {string} id */ markRemoved(id) { return this.removePost.run(id).changes; }
  /** @param {string} id */ markRestored(id) { return this.restorePost.run(id).changes; }
  /** @param {{id: string, postId: string, community: string, moderatorId: string, action: "removed" | "restored", occurredAt: number}} event */
  appendAudit(event) { this.insertAudit.run(event.id, this.nextAuditSequence.get().value, event.postId, event.community, event.moderatorId, event.action, event.occurredAt); }
  /** @param {string} community */ auditsForCommunity(community) { return this.auditByCommunity.all(community); }
}
