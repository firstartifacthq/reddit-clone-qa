CREATE TABLE comments (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id),
  body TEXT,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  created_sequence INTEGER NOT NULL UNIQUE CHECK (created_sequence > 0),
  CHECK (
    (state = 'active' AND author_user_id IS NOT NULL AND body IS NOT NULL) OR
    (state = 'deleted' AND author_user_id IS NULL AND body IS NULL)
  )
);

CREATE INDEX comments_post_sequence ON comments(post_id, created_sequence, id);
CREATE INDEX comments_parent_sequence ON comments(parent_id, created_sequence, id);

CREATE TRIGGER comments_parent_has_same_post_and_depth
BEFORE INSERT ON comments
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM comments AS parent
  WHERE parent.id = NEW.parent_id AND parent.post_id = NEW.post_id AND NEW.depth = parent.depth + 1
)
BEGIN
  SELECT RAISE(ABORT, 'comment parent must belong to post at prior depth');
END;

CREATE TRIGGER comments_root_has_zero_depth
BEFORE INSERT ON comments
WHEN NEW.parent_id IS NULL AND NEW.depth <> 0
BEGIN
  SELECT RAISE(ABORT, 'top-level comment depth must be zero');
END;

CREATE TRIGGER comments_structure_is_immutable
BEFORE UPDATE OF id, post_id, parent_id, depth, created_sequence ON comments
BEGIN
  SELECT RAISE(ABORT, 'comment structure is immutable');
END;

CREATE TABLE comment_traversals (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE comment_traversal_items (
  traversal_id TEXT NOT NULL REFERENCES comment_traversals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  comment_id TEXT NOT NULL,
  PRIMARY KEY (traversal_id, ordinal),
  UNIQUE (traversal_id, comment_id)
);

CREATE TABLE comment_page_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  traversal_id TEXT NOT NULL REFERENCES comment_traversals(id) ON DELETE CASCADE,
  start_ordinal INTEGER NOT NULL CHECK (start_ordinal >= 0),
  UNIQUE (traversal_id, start_ordinal)
);
