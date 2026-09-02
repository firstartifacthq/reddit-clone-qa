CREATE TABLE saved_posts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  saved_at INTEGER NOT NULL CHECK (typeof(saved_at) = 'integer' AND saved_at >= 0),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX saved_posts_owner_order ON saved_posts(user_id, saved_at DESC, post_id ASC);

CREATE TABLE post_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL CHECK (typeof(viewed_at) = 'integer' AND viewed_at >= 0),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX post_history_owner_order ON post_history(user_id, viewed_at DESC, post_id ASC);

CREATE TABLE personal_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_kind TEXT NOT NULL CHECK (listing_kind IN ('saved', 'history')),
  snapshot_key TEXT NOT NULL CHECK (length(snapshot_key) = 64 AND snapshot_key NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at)
);
CREATE UNIQUE INDEX personal_traversals_owner_kind ON personal_traversals(user_id, listing_kind, snapshot_key);
CREATE INDEX personal_traversals_expiry ON personal_traversals(expires_at);

CREATE TABLE personal_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES personal_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  event_at INTEGER NOT NULL CHECK (typeof(event_at) = 'integer' AND event_at >= 0),
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, post_id)
);

CREATE TABLE personal_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES personal_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  compact_mode INTEGER NOT NULL CHECK (typeof(compact_mode) = 'integer' AND compact_mode IN (0, 1))
);

CREATE TRIGGER personal_traversals_are_immutable
BEFORE UPDATE ON personal_traversals
BEGIN
  SELECT RAISE(ABORT, 'personal traversal is immutable');
END;

CREATE TRIGGER personal_traversal_items_are_immutable
BEFORE UPDATE ON personal_traversal_items
BEGIN
  SELECT RAISE(ABORT, 'personal traversal item is immutable');
END;

CREATE TRIGGER personal_page_tokens_are_immutable
BEFORE UPDATE ON personal_page_tokens
BEGIN
  SELECT RAISE(ABORT, 'personal page token is immutable');
END;
