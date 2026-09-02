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

CREATE TABLE feed_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('home', 'popular', 'community')),
  community_name TEXT,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  CHECK ((kind = 'community' AND community_name IS NOT NULL) OR (kind IN ('home', 'popular') AND community_name IS NULL))
);

CREATE TABLE feed_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  post_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, post_id)
);

CREATE TABLE feed_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES feed_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);

CREATE INDEX feed_traversal_items_post_id ON feed_traversal_items(post_id);
CREATE INDEX feed_page_tokens_traversal_offset ON feed_page_tokens(traversal_id, start_ordinal);
