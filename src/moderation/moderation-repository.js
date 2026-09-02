/** @typedef {{prepare: (sql: string) => any}} Database */

export class ModerationRepository {
  /** @param {Database} database */
  constructor(database) {
    this.reportTarget = database.prepare("SELECT community_name FROM readable_posts WHERE id = ?");
    this.member = database.prepare(`SELECT 1 FROM community_memberships AS membership
      JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE membership.community_name = ? AND membership.user_id = ?`);
    this.openReport = database.prepare("SELECT 1 FROM reports WHERE post_id = ? AND reporter_user_id = ? AND state = 'open'");
    this.insertReport = database.prepare(`INSERT INTO reports (id, post_id, community_name, reporter_user_id, reason, state, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)`);
    this.reportById = database.prepare("SELECT id, post_id, community_name, reason, created_at FROM reports WHERE id = ?");
    this.authorities = database.prepare(`SELECT membership.community_name FROM community_memberships AS membership
      JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE membership.user_id = ? AND membership.role IN ('owner', 'moderator') ORDER BY membership.community_name`);
    this.community = database.prepare("SELECT 1 FROM communities WHERE canonical_name = ?");
    this.modForCommunity = database.prepare(`SELECT 1 FROM community_memberships AS membership
      JOIN users ON users.id = membership.user_id AND users.deletion_requested_at IS NULL
      WHERE membership.community_name = ? AND membership.user_id = ? AND membership.role IN ('owner', 'moderator')`);
    this.postTarget = database.prepare("SELECT id, community_name, moderation_state FROM posts WHERE id = ?");
    this.openReports = database.prepare(`SELECT id, post_id, community_name, reason, created_at FROM reports
      WHERE state = 'open' AND community_name IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`);
    this.insertTraversal = database.prepare(`INSERT INTO moderation_traversals (id, requester_user_id, authority_key, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`);
    this.insertTraversalItem = database.prepare("INSERT INTO moderation_traversal_items (traversal_id, ordinal, report_id) VALUES (?, ?, ?)");
    this.token = database.prepare(`SELECT token.traversal_id, token.start_ordinal, traversal.authority_key FROM moderation_page_tokens AS token
      JOIN moderation_traversals AS traversal ON traversal.id = token.traversal_id
      WHERE token.token = ? AND traversal.requester_user_id = ? AND traversal.expires_at > ?`);
    this.page = database.prepare(`SELECT item.ordinal, reports.id, reports.post_id, reports.community_name, reports.reason, reports.created_at
      FROM moderation_traversal_items AS item JOIN reports ON reports.id = item.report_id
      WHERE item.traversal_id = ? AND item.ordinal >= ? AND reports.state = 'open'
      ORDER BY item.ordinal LIMIT ?`);
    this.more = database.prepare(`SELECT 1 FROM moderation_traversal_items AS item JOIN reports ON reports.id = item.report_id
      WHERE item.traversal_id = ? AND item.ordinal >= ? AND reports.state = 'open' LIMIT 1`);
    this.insertToken = database.prepare("INSERT OR IGNORE INTO moderation_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)");
    this.tokenForStart = database.prepare("SELECT token FROM moderation_page_tokens WHERE traversal_id = ? AND start_ordinal = ?");
    this.updatePostState = database.prepare("UPDATE posts SET moderation_state = ? WHERE id = ? AND moderation_state <> ?");
    this.resolveReports = database.prepare("UPDATE reports SET state = 'resolved', resolved_at = ? WHERE post_id = ? AND state = 'open'");
    this.insertAudit = database.prepare(`INSERT INTO moderation_audit_events (id, community_name, post_id, actor, action, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    this.auditById = database.prepare("SELECT id, community_name, post_id, actor, action, created_at FROM moderation_audit_events WHERE id = ?");
    this.latestAuditTime = database.prepare("SELECT MAX(created_at) AS value FROM moderation_audit_events WHERE post_id = ?");
    this.auditForCommunity = database.prepare("SELECT id, community_name, post_id, actor, action, created_at FROM moderation_audit_events WHERE community_name = ? ORDER BY created_at, id");
  }
  /** @param {string} postId */ reportTargetFor(postId) { return this.reportTarget.get(postId); }
  /** @param {string} community @param {string} userId */ isMember(community, userId) { return Boolean(this.member.get(community, userId)); }
  /** @param {string} postId @param {string} userId */ hasOpenReport(postId, userId) { return Boolean(this.openReport.get(postId, userId)); }
  /** @param {{id: string, postId: string, community: string, reporterId: string, reason: string, createdAt: number}} report */
  createReport(report) { this.insertReport.run(report.id, report.postId, report.community, report.reporterId, report.reason, report.createdAt); }
  /** @param {string} id */ findReport(id) { return this.reportById.get(id); }
  /** @param {string} userId */ authorityCommunities(userId) { return this.authorities.all(userId).map((/** @type {{community_name: string}} */ row) => row.community_name); }
  /** @param {string} community */ hasCommunity(community) { return Boolean(this.community.get(community)); }
  /** @param {string} community @param {string} userId */ isModerator(community, userId) { return Boolean(this.modForCommunity.get(community, userId)); }
  /** @param {string} postId */ moderationTarget(postId) { return this.postTarget.get(postId); }
  /** @param {string[]} communities */ currentReports(communities) { return this.openReports.all(JSON.stringify(communities)); }
  /** @param {string} id @param {string} requesterId @param {string} key @param {number} createdAt @param {number} expiresAt @param {any[]} rows */ createTraversal(id, requesterId, key, createdAt, expiresAt, rows) {
    this.insertTraversal.run(id, requesterId, key, createdAt, expiresAt); rows.forEach((row, ordinal) => this.insertTraversalItem.run(id, ordinal, row.id));
  }
  /** @param {string} token @param {string} requesterId @param {number} now */ findToken(token, requesterId, now) { return this.token.get(token, requesterId, now); }
  /** @param {string} traversalId @param {number} start @param {number} limit */ pageFor(traversalId, start, limit) { return this.page.all(traversalId, start, limit); }
  /** @param {string} traversalId @param {number} start */ hasMore(traversalId, start) { return Boolean(this.more.get(traversalId, start)); }
  /** @param {string} token @param {string} traversalId @param {number} start */ createToken(token, traversalId, start) { this.insertToken.run(token, traversalId, start); return this.tokenForStart.get(traversalId, start).token; }
  /** @param {string} state @param {string} postId */ setState(state, postId) { return this.updatePostState.run(state, postId, state).changes; }
  /** @param {string} postId @param {number} now */ resolveOpenReports(postId, now) { this.resolveReports.run(now, postId); }
  /** @param {{id: string, community: string, postId: string, actor: string, action: string, createdAt: number}} event */ appendAudit(event) { this.insertAudit.run(event.id, event.community, event.postId, event.actor, event.action, event.createdAt); }
  /** @param {string} id */ findAudit(id) { return this.auditById.get(id); }
  /** @param {string} postId */ latestAuditFor(postId) { return this.latestAuditTime.get(postId).value; }
  /** @param {string} community */ auditFor(community) { return this.auditForCommunity.all(community); }
}
