ALTER TABLE posts ADD COLUMN published_at INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(published_at) = 'integer' AND published_at >= 0);
UPDATE posts SET published_at = CAST(unixepoch('subsec') * 1000 AS INTEGER);

CREATE TRIGGER posts_published_at_is_immutable
BEFORE UPDATE OF published_at ON posts
BEGIN
  SELECT RAISE(ABORT, 'post publication time is immutable');
END;

CREATE INDEX posts_feed_publication ON posts(published_at DESC, id ASC);
CREATE INDEX posts_feed_community_publication ON posts(community_name, published_at DESC, id ASC);
CREATE INDEX community_memberships_feed_user ON community_memberships(user_id, community_name);

CREATE TABLE feed_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  feed_kind TEXT NOT NULL CHECK (feed_kind IN ('home', 'popular', 'community')),
  community_name TEXT,
  requester_user_id TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  CHECK (
    (feed_kind = 'home' AND requester_user_id IS NOT NULL AND community_name IS NULL) OR
    (feed_kind = 'popular' AND community_name IS NULL) OR
    (feed_kind = 'community' AND community_name IS NOT NULL)
  )
);
CREATE INDEX feed_traversals_expiry ON feed_traversals(expires_at);

CREATE TABLE feed_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  post_id TEXT NOT NULL,
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, post_id)
);

CREATE TABLE feed_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (typeof(start_ordinal) = 'integer' AND start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);

CREATE TRIGGER feed_traversals_are_immutable
BEFORE UPDATE ON feed_traversals
BEGIN
  SELECT RAISE(ABORT, 'feed traversal is immutable');
END;
CREATE TRIGGER feed_traversal_items_are_immutable
BEFORE UPDATE ON feed_traversal_items
BEGIN
  SELECT RAISE(ABORT, 'feed traversal item is immutable');
END;
CREATE TRIGGER feed_page_tokens_are_immutable
BEFORE UPDATE ON feed_page_tokens
BEGIN
  SELECT RAISE(ABORT, 'feed page token is immutable');
END;
