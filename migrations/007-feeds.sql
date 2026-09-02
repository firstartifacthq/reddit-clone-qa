CREATE TABLE post_creation_order (
  post_id TEXT PRIMARY KEY NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0)
);

INSERT INTO post_creation_order (post_id, sequence)
SELECT id, row_number() OVER (ORDER BY rowid)
FROM posts;

CREATE TRIGGER posts_assign_creation_order
AFTER INSERT ON posts
BEGIN
  INSERT INTO post_creation_order (post_id, sequence)
  VALUES (NEW.id, COALESCE((SELECT MAX(sequence) FROM post_creation_order), 0) + 1);
END;

CREATE TRIGGER post_creation_order_is_immutable
BEFORE UPDATE OF post_id, sequence ON post_creation_order
BEGIN
  SELECT RAISE(ABORT, 'post creation order is immutable');
END;

CREATE TABLE feed_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('home', 'popular', 'community')),
  community_name TEXT,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK ((kind = 'community' AND community_name IS NOT NULL) OR (kind IN ('home', 'popular') AND community_name IS NULL))
);

CREATE TRIGGER feed_traversal_is_immutable
BEFORE UPDATE OF id, kind, community_name, principal_id, created_at, expires_at ON feed_traversals
BEGIN
  SELECT RAISE(ABORT, 'feed traversal is immutable');
END;

CREATE TABLE feed_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  post_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, post_id)
);

CREATE TRIGGER feed_traversal_item_is_immutable
BEFORE UPDATE OF traversal_id, ordinal, post_id, score ON feed_traversal_items
BEGIN
  SELECT RAISE(ABORT, 'feed traversal item is immutable');
END;

CREATE TABLE feed_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);

CREATE TRIGGER feed_page_token_is_immutable
BEFORE UPDATE OF token, traversal_id, start_ordinal ON feed_page_tokens
BEGIN
  SELECT RAISE(ABORT, 'feed page token is immutable');
END;

CREATE INDEX feed_traversal_items_post_id ON feed_traversal_items(post_id);
CREATE INDEX feed_page_tokens_traversal_offset ON feed_page_tokens(traversal_id, start_ordinal);
