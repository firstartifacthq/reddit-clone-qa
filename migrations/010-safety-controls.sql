CREATE TABLE user_blocks (
  blocker_user_id TEXT NOT NULL REFERENCES users(id),
  blocked_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE TABLE post_creation_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  post_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);
CREATE INDEX post_creation_events_user_created ON post_creation_events(user_id, created_at);

CREATE TRIGGER post_creation_events_are_immutable
BEFORE UPDATE ON post_creation_events
BEGIN
  SELECT RAISE(ABORT, 'post creation event is immutable');
END;
