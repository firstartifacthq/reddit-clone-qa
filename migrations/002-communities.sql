CREATE TABLE IF NOT EXISTS communities (
  name TEXT PRIMARY KEY NOT NULL CHECK (
    length(name) BETWEEN 3 AND 21
    AND name NOT GLOB '*[^a-z0-9_]*'
  )
);

CREATE TABLE IF NOT EXISTS memberships (
  community_name TEXT NOT NULL REFERENCES communities(name) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'moderator', 'member')),
  PRIMARY KEY (community_name, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_owner_per_community
  ON memberships(community_name) WHERE role = 'owner';

CREATE TRIGGER IF NOT EXISTS memberships_preserve_owner_on_update
BEFORE UPDATE OF role ON memberships
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
BEGIN
  SELECT RAISE(ABORT, 'owner role cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS memberships_preserve_owner_on_delete
BEFORE DELETE ON memberships
WHEN OLD.role = 'owner'
BEGIN
  SELECT RAISE(ABORT, 'owner membership cannot be deleted');
END;
