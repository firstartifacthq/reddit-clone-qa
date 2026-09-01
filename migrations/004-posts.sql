CREATE TABLE posts (
  id TEXT PRIMARY KEY NOT NULL,
  community_name TEXT NOT NULL REFERENCES communities(canonical_name),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('text', 'link', 'media')),
  title TEXT NOT NULL,
  text_content TEXT,
  url_content TEXT,
  media_filename TEXT,
  media_content_type TEXT,
  media_bytes BLOB,
  CHECK (
    (type = 'text' AND text_content IS NOT NULL AND url_content IS NULL AND media_filename IS NULL AND media_content_type IS NULL AND media_bytes IS NULL) OR
    (type = 'link' AND text_content IS NULL AND url_content IS NOT NULL AND media_filename IS NULL AND media_content_type IS NULL AND media_bytes IS NULL) OR
    (type = 'media' AND text_content IS NULL AND url_content IS NULL AND media_filename IS NOT NULL AND media_content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp') AND media_bytes IS NOT NULL)
  )
);

CREATE INDEX posts_community_author ON posts(community_name, author_user_id);

CREATE TABLE post_idempotency (
  author_user_id TEXT NOT NULL REFERENCES users(id),
  community_name TEXT NOT NULL REFERENCES communities(canonical_name),
  idempotency_key TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  response_json TEXT NOT NULL,
  PRIMARY KEY (author_user_id, community_name, idempotency_key)
);
