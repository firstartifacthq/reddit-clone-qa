CREATE TABLE notification_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  occurrence_sequence INTEGER NOT NULL UNIQUE CHECK (typeof(occurrence_sequence) = 'integer' AND occurrence_sequence > 0),
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'mention', 'vote', 'moderation')),
  related_item_type TEXT NOT NULL CHECK (related_item_type IN ('comment', 'post')),
  related_item_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0)
);
CREATE INDEX notification_events_owner_order ON notification_events(recipient_user_id, occurrence_sequence DESC, id ASC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES notification_events(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  read_state INTEGER NOT NULL DEFAULT 0 CHECK (typeof(read_state) = 'integer' AND read_state IN (0, 1)),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at >= 0)),
  UNIQUE (owner_user_id, event_id)
);
CREATE INDEX notifications_owner_order ON notifications(owner_user_id, deleted_at, id);

CREATE TABLE notification_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  snapshot_key TEXT NOT NULL CHECK (length(snapshot_key) = 64 AND snapshot_key NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  UNIQUE (owner_user_id, snapshot_key)
);
CREATE INDEX notification_traversals_expiry ON notification_traversals(expires_at);

CREATE TABLE notification_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES notification_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, notification_id)
);

CREATE TABLE notification_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES notification_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);

CREATE TRIGGER notification_events_are_immutable
BEFORE UPDATE ON notification_events
BEGIN
  SELECT RAISE(ABORT, 'notification event is immutable');
END;
CREATE TRIGGER notification_events_cannot_be_deleted
BEFORE DELETE ON notification_events
BEGIN
  SELECT RAISE(ABORT, 'notification event cannot be deleted');
END;
CREATE TRIGGER notifications_owner_matches_event
BEFORE INSERT ON notifications WHEN NEW.owner_user_id <> (SELECT recipient_user_id FROM notification_events WHERE id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'notification owner must match event recipient');
END;
CREATE TRIGGER notifications_owner_is_immutable
BEFORE UPDATE OF owner_user_id, event_id ON notifications
BEGIN
  SELECT RAISE(ABORT, 'notification ownership is immutable');
END;
CREATE TRIGGER notifications_cannot_be_hard_deleted
BEFORE DELETE ON notifications
BEGIN
  SELECT RAISE(ABORT, 'notification cannot be hard deleted');
END;
CREATE TRIGGER notifications_deletion_is_one_way
BEFORE UPDATE ON notifications WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'notification deletion is terminal');
END;
CREATE TRIGGER notification_traversals_are_immutable
BEFORE UPDATE ON notification_traversals
BEGIN
  SELECT RAISE(ABORT, 'notification traversal is immutable');
END;
CREATE TRIGGER notification_traversal_items_are_immutable
BEFORE UPDATE ON notification_traversal_items
BEGIN
  SELECT RAISE(ABORT, 'notification traversal item is immutable');
END;
CREATE TRIGGER notification_page_tokens_are_immutable
BEFORE UPDATE ON notification_page_tokens
BEGIN
  SELECT RAISE(ABORT, 'notification page token is immutable');
END;
