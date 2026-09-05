// @ts-nocheck
const TOMBSTONE = "__privacy_tombstone__";

/** SQLite is the authority for privacy state; services never retain a parallel job state. */
export class PrivacyRepository {
  /** @param {{prepare:(sql:string)=>any}} database */
  constructor(database) {
    this.database = database;
    this.activeUser = database.prepare("SELECT id FROM users WHERE id = ? AND deletion_requested_at IS NULL AND id <> ?");
    this.currentBySubject = database.prepare(`SELECT j.id, j.operation, j.subject_user_id, j.subject_key, e.action FROM privacy_jobs j JOIN privacy_job_events e ON e.job_id=j.id WHERE j.subject_key=? AND j.operation=? AND e.occurrence_sequence=(SELECT MAX(occurrence_sequence) FROM privacy_job_events WHERE job_id=j.id) AND e.action='accepted' ORDER BY j.created_at DESC LIMIT 1`);
    this.ownerJob = database.prepare(`SELECT j.id, j.operation, j.subject_user_id, e.action FROM privacy_jobs j JOIN privacy_job_events e ON e.job_id=j.id WHERE j.id=? AND j.subject_user_id=? AND e.occurrence_sequence=(SELECT MAX(occurrence_sequence) FROM privacy_job_events WHERE job_id=j.id)`);
    this.job = database.prepare(`SELECT j.id, j.operation, j.subject_user_id, j.subject_key, e.action FROM privacy_jobs j JOIN privacy_job_events e ON e.job_id=j.id WHERE j.id=? AND e.occurrence_sequence=(SELECT MAX(occurrence_sequence) FROM privacy_job_events WHERE job_id=j.id)`);
    this.pendingJobs = database.prepare(`SELECT j.id, j.operation FROM privacy_jobs j JOIN privacy_job_events e ON e.job_id=j.id WHERE e.occurrence_sequence=(SELECT MAX(occurrence_sequence) FROM privacy_job_events WHERE job_id=j.id) AND e.action='accepted' ORDER BY e.occurrence_sequence`);
  }
  active(id) { return Boolean(this.activeUser.get(id, TOMBSTONE)); }
  pendingFor(subject, operation) { return this.currentBySubject.get(subject, operation); }
  ownerQualifiedJob(id, owner) { return this.ownerJob.get(id, owner); }
  current(id) { return this.job.get(id); }
  create(id, operation, subject, now) { this.database.prepare("INSERT INTO privacy_jobs (id, operation, subject_user_id, subject_key, created_at) VALUES (?, ?, ?, ?, ?)").run(id, operation, subject, subject, now); }
  event(id, job, operation, action, now) {
    const sequence = this.database.prepare("SELECT COALESCE(MAX(occurrence_sequence), 0) + 1 AS value FROM privacy_job_events").get().value;
    this.database.prepare("INSERT INTO privacy_job_events (id, job_id, occurrence_sequence, operation, action, occurred_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, job, sequence, operation, action, now);
  }
  payload(jobId) { return this.database.prepare("SELECT payload_json FROM privacy_export_payloads WHERE job_id=?").get(jobId)?.payload_json; }
  storePayload(jobId, payload) { this.database.prepare("INSERT INTO privacy_export_payloads (job_id, payload_json) VALUES (?, ?)").run(jobId, payload); }
  removePayload(jobId) { this.database.prepare("DELETE FROM privacy_export_payloads WHERE job_id=?").run(jobId); }
  revocableExports(subject) { return this.database.prepare(`SELECT j.id FROM privacy_jobs j JOIN privacy_job_events e ON e.job_id=j.id WHERE j.subject_key=? AND j.operation='export' AND e.occurrence_sequence=(SELECT MAX(occurrence_sequence) FROM privacy_job_events WHERE job_id=j.id) AND e.action IN ('accepted','completed')`).all(subject); }
  beginDeletion(jobId) { this.database.prepare("INSERT OR IGNORE INTO privacy_deletion_progress (job_id, phase) VALUES (?, 'pending')").run(jobId); }
  pendingWork() { return this.pendingJobs.all(); }
  maxAuditSequence() { return this.database.prepare("SELECT COALESCE(MAX(occurrence_sequence),0) AS value FROM privacy_job_events").get().value; }
  auditRange(maximum, after, limit) { return this.database.prepare("SELECT id, occurrence_sequence, operation, action, occurred_at FROM privacy_job_events WHERE occurrence_sequence > ? AND occurrence_sequence <= ? ORDER BY occurrence_sequence ASC, id ASC LIMIT ?").all(after, maximum, limit); }
  createTraversal(id, administrator, maximum, now) { this.database.prepare("INSERT INTO privacy_audit_traversals (id, administrator_user_id, maximum_sequence, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, administrator, maximum, now, now + 86_400_000); }
  traversal(token, administrator) { return this.database.prepare(`SELECT traversal.id, token.next_sequence, traversal.maximum_sequence FROM privacy_audit_tokens token JOIN privacy_audit_traversals traversal ON traversal.id=token.traversal_id WHERE token.token=? AND traversal.administrator_user_id=?`).get(token, administrator); }
  token(id, traversal, next) { this.database.prepare("INSERT OR IGNORE INTO privacy_audit_tokens (token, traversal_id, next_sequence) VALUES (?, ?, ?)").run(id, traversal, next); }

  /** A canonical, credential-free acceptance-time snapshot. */
  exportSnapshot(userId) {
    const all = (sql, ...args) => this.database.prepare(sql).all(...args);
    const account = this.database.prepare("SELECT id, username, bio, revision, created_at, deletion_requested_at FROM users WHERE id=?").get(userId);
    const posts = all("SELECT * FROM posts WHERE author_user_id=?", userId).map((row) => ({ ...row, media_bytes: row.media_bytes === null ? null : Buffer.from(row.media_bytes).toString("base64") }));
    return JSON.stringify({ account, data: {
      memberships: all("SELECT * FROM community_memberships WHERE user_id=?", userId), communities: all("SELECT canonical_name, display_name, created_at FROM communities WHERE owner_user_id=?", userId), posts,
      comments: all("SELECT * FROM comments WHERE author_user_id=?", userId), votes: all("SELECT * FROM post_votes WHERE voter_user_id=?", userId), reports: all("SELECT * FROM reports WHERE reporter_user_id=?", userId),
      saved: all("SELECT * FROM saved_posts WHERE user_id=?", userId), history: all("SELECT * FROM post_history WHERE user_id=?", userId), preferences: all("SELECT * FROM user_preferences WHERE user_id=?", userId),
      notifications: all("SELECT n.* FROM notifications n WHERE n.owner_user_id=?", userId), notificationEvents: all("SELECT id, event_key, occurrence_sequence, kind, related_item_type, related_item_id, occurred_at FROM notification_events WHERE recipient_user_id=?", userId),
      blocks: all("SELECT * FROM user_blocks WHERE blocker_user_id=? OR blocked_user_id=?", userId, userId), rateFacts: all("SELECT id, post_id, created_at FROM post_creation_events WHERE user_id=?", userId),
      moderation: all("SELECT id, occurrence_sequence, post_id, community_name, action, occurred_at FROM moderation_audit_events WHERE moderator_user_id=?", userId)
    }});
  }

  /** Remove subject data and only preserve shared structural records through the fixed inactive tombstone. */
  erase(userId) {
    const run = (sql, ...args) => this.database.prepare(sql).run(...args);
    run("DELETE FROM sessions WHERE user_id=?", userId);
    run("DELETE FROM post_idempotency WHERE author_user_id=?", userId);
    run("DELETE FROM saved_posts WHERE user_id=?", userId); run("DELETE FROM post_history WHERE user_id=?", userId); run("DELETE FROM user_preferences WHERE user_id=?", userId);
    run("DELETE FROM personal_traversals WHERE user_id=?", userId); run("DELETE FROM notification_traversals WHERE owner_user_id=?", userId); run("DELETE FROM moderation_queue_traversals WHERE requester_user_id=?", userId);
    run("DELETE FROM user_blocks WHERE blocker_user_id=? OR blocked_user_id=?", userId, userId); run("DELETE FROM post_creation_events WHERE user_id=?", userId); run("DELETE FROM post_votes WHERE voter_user_id=?", userId);
    run("UPDATE comments SET state='deleted', author_user_id=NULL, body=NULL WHERE author_user_id=?", userId);
    run("UPDATE posts SET author_user_id=?, title='[deleted]', text_content=CASE WHEN type='text' THEN '[deleted]' ELSE text_content END, url_content=CASE WHEN type='link' THEN 'https://invalid.example/deleted' ELSE url_content END, media_filename=CASE WHEN type='media' THEN 'deleted' ELSE media_filename END, media_bytes=CASE WHEN type='media' THEN x'' ELSE media_bytes END WHERE author_user_id=?", TOMBSTONE, userId);
    run("UPDATE communities SET owner_user_id=? WHERE owner_user_id=?", TOMBSTONE, userId); run("UPDATE community_memberships SET user_id=? WHERE user_id=? AND role='owner'", TOMBSTONE, userId); run("DELETE FROM community_memberships WHERE user_id=?", userId);
    run("UPDATE reports SET reporter_user_id=? WHERE reporter_user_id=?", TOMBSTONE, userId); run("UPDATE moderation_audit_events SET moderator_user_id=? WHERE moderator_user_id=?", TOMBSTONE, userId);
    run("UPDATE notification_events SET recipient_user_id=? WHERE recipient_user_id=?", TOMBSTONE, userId); run("UPDATE notifications SET owner_user_id=? WHERE owner_user_id=?", TOMBSTONE, userId);
    run("DELETE FROM privacy_audit_traversals WHERE administrator_user_id=?", userId); run("DELETE FROM privacy_export_payloads WHERE job_id IN (SELECT id FROM privacy_jobs WHERE subject_user_id=?)", userId);
    run("UPDATE privacy_jobs SET subject_user_id=NULL, subject_key='__erased__' WHERE subject_user_id=?", userId);
    run("DELETE FROM users WHERE id=?", userId);
  }
}
