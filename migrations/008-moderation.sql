ALTER TABLE posts ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'active'
  CHECK (moderation_state IN ('active', 'removed'));

CREATE VIEW readable_posts AS
  SELECT * FROM posts WHERE moderation_state = 'active';

CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  occurrence_sequence INTEGER NOT NULL UNIQUE CHECK (typeof(occurrence_sequence) = 'integer' AND occurrence_sequence > 0),
  post_id TEXT NOT NULL,
  community_name TEXT NOT NULL REFERENCES communities(canonical_name),
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  reported_at INTEGER NOT NULL CHECK (typeof(reported_at) = 'integer' AND reported_at >= 0),
  UNIQUE (reporter_user_id, post_id)
);
CREATE INDEX reports_community_order ON reports(community_name, occurrence_sequence, id);

CREATE TABLE moderation_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurrence_sequence INTEGER NOT NULL UNIQUE CHECK (typeof(occurrence_sequence) = 'integer' AND occurrence_sequence > 0),
  post_id TEXT NOT NULL,
  community_name TEXT NOT NULL REFERENCES communities(canonical_name),
  moderator_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('removed', 'restored')),
  occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0)
);
CREATE INDEX moderation_audit_community_order ON moderation_audit_events(community_name, occurrence_sequence, id);

CREATE TABLE moderation_queue_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  requester_user_id TEXT NOT NULL REFERENCES users(id),
  authority_digest TEXT NOT NULL CHECK (length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at)
);
CREATE INDEX moderation_queue_traversals_owner_snapshot ON moderation_queue_traversals(requester_user_id, authority_digest);
CREATE INDEX moderation_queue_traversals_expiry ON moderation_queue_traversals(expires_at);

CREATE TABLE moderation_queue_items (
  traversal_id TEXT NOT NULL REFERENCES moderation_queue_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  report_id TEXT NOT NULL REFERENCES reports(id),
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, report_id)
);

CREATE TABLE moderation_queue_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES moderation_queue_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);

CREATE TRIGGER moderation_audit_events_are_immutable
BEFORE UPDATE ON moderation_audit_events
BEGIN
  SELECT RAISE(ABORT, 'moderation audit event is immutable');
END;
CREATE TRIGGER moderation_audit_events_cannot_be_deleted
BEFORE DELETE ON moderation_audit_events
BEGIN
  SELECT RAISE(ABORT, 'moderation audit event cannot be deleted');
END;
CREATE TRIGGER moderation_queue_traversals_are_immutable
BEFORE UPDATE ON moderation_queue_traversals
BEGIN
  SELECT RAISE(ABORT, 'moderation queue traversal is immutable');
END;
CREATE TRIGGER moderation_queue_items_are_immutable
BEFORE UPDATE ON moderation_queue_items
BEGIN
  SELECT RAISE(ABORT, 'moderation queue item is immutable');
END;
CREATE TRIGGER moderation_queue_tokens_are_immutable
BEFORE UPDATE ON moderation_queue_tokens
BEGIN
  SELECT RAISE(ABORT, 'moderation queue token is immutable');
END;
