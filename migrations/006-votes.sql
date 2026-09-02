ALTER TABLE posts ADD COLUMN voting_state TEXT NOT NULL DEFAULT 'unlocked'
  CHECK (voting_state IN ('unlocked', 'locked'));

CREATE TABLE post_votes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  voter_user_id TEXT NOT NULL REFERENCES users(id),
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  PRIMARY KEY (post_id, voter_user_id)
);

CREATE INDEX post_votes_voter_user_id ON post_votes(voter_user_id);
CREATE INDEX posts_author_user_id ON posts(author_user_id, id);
