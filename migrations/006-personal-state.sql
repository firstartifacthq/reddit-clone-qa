CREATE TABLE saved_posts (
  user_id TEXT NOT NULL REFERENCES users(id),
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX saved_posts_owner_order ON saved_posts(user_id, saved_at DESC, post_id ASC);

CREATE TABLE post_history (
  user_id TEXT NOT NULL REFERENCES users(id),
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX post_history_owner_order ON post_history(user_id, viewed_at DESC, post_id ASC);

CREATE TABLE personal_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  listing_kind TEXT NOT NULL CHECK (listing_kind IN ('saved', 'history'))
);
CREATE INDEX personal_traversals_owner_kind ON personal_traversals(user_id, listing_kind);

CREATE TABLE personal_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES personal_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  event_at INTEGER NOT NULL,
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, post_id)
);

CREATE TABLE personal_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES personal_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  compact_mode INTEGER NOT NULL CHECK (compact_mode IN (0, 1))
);
