ALTER TABLE posts ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'visible'
  CHECK (moderation_state IN ('visible', 'removed'));

CREATE VIEW readable_posts AS
  SELECT * FROM posts WHERE moderation_state = 'visible';

CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  community_name TEXT NOT NULL REFERENCES communities(canonical_name),
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= created_at)),
  CHECK ((state = 'open' AND resolved_at IS NULL) OR (state = 'resolved' AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX reports_one_open_per_reporter ON reports(post_id, reporter_user_id) WHERE state = 'open';
CREATE INDEX reports_open_community_order ON reports(community_name, state, created_at, id);

CREATE TRIGGER reports_cannot_reopen
BEFORE UPDATE OF state ON reports
WHEN OLD.state = 'resolved' AND NEW.state <> 'resolved'
BEGIN
  SELECT RAISE(ABORT, 'resolved reports cannot reopen');
END;

CREATE TABLE moderation_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  community_name TEXT NOT NULL,
  post_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('remove', 'restore')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);
CREATE INDEX moderation_audit_community_order ON moderation_audit_events(community_name, created_at, id);
CREATE INDEX moderation_audit_post_order ON moderation_audit_events(post_id, created_at, id);

CREATE TRIGGER moderation_audit_events_are_immutable
BEFORE UPDATE ON moderation_audit_events
BEGIN
  SELECT RAISE(ABORT, 'moderation audit events are immutable');
END;
CREATE TRIGGER moderation_audit_events_cannot_be_deleted
BEFORE DELETE ON moderation_audit_events
BEGIN
  SELECT RAISE(ABORT, 'moderation audit events are immutable');
END;

CREATE TABLE moderation_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  authority_key TEXT NOT NULL CHECK (length(authority_key) = 64 AND authority_key NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at)
);
CREATE INDEX moderation_traversals_expiry ON moderation_traversals(expires_at);
CREATE TABLE moderation_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES moderation_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, report_id)
);
CREATE TABLE moderation_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES moderation_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);
CREATE TRIGGER moderation_traversals_are_immutable BEFORE UPDATE ON moderation_traversals BEGIN SELECT RAISE(ABORT, 'moderation traversal is immutable'); END;
CREATE TRIGGER moderation_traversal_items_are_immutable BEFORE UPDATE ON moderation_traversal_items BEGIN SELECT RAISE(ABORT, 'moderation traversal item is immutable'); END;
CREATE TRIGGER moderation_page_tokens_are_immutable BEFORE UPDATE ON moderation_page_tokens BEGIN SELECT RAISE(ABORT, 'moderation page token is immutable'); END;
