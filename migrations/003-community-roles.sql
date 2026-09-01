CREATE TABLE communities (
  canonical_name TEXT PRIMARY KEY NOT NULL CHECK (canonical_name = lower(canonical_name)),
  display_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE community_memberships (
  community_name TEXT NOT NULL REFERENCES communities(canonical_name),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('member', 'moderator', 'owner')),
  PRIMARY KEY (community_name, user_id)
);

CREATE UNIQUE INDEX community_memberships_one_owner
  ON community_memberships(community_name) WHERE role = 'owner';

CREATE TRIGGER communities_owner_is_immutable
BEFORE UPDATE OF owner_user_id ON communities
BEGIN
  SELECT RAISE(ABORT, 'community owner is immutable');
END;

CREATE TRIGGER community_owner_membership_matches_community
BEFORE INSERT ON community_memberships
WHEN NEW.role = 'owner' AND NOT EXISTS (
  SELECT 1 FROM communities WHERE canonical_name = NEW.community_name AND owner_user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'owner membership must match community owner');
END;

CREATE TRIGGER community_owner_membership_matches_community_on_update
BEFORE UPDATE OF community_name, user_id, role ON community_memberships
WHEN NEW.role = 'owner' AND NOT EXISTS (
  SELECT 1 FROM communities WHERE canonical_name = NEW.community_name AND owner_user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'owner membership must match community owner');
END;

CREATE TRIGGER community_inserts_owner_membership
AFTER INSERT ON communities
BEGIN
  INSERT INTO community_memberships (community_name, user_id, role)
  VALUES (NEW.canonical_name, NEW.owner_user_id, 'owner');
END;

CREATE TRIGGER community_owner_membership_is_immutable
BEFORE UPDATE OF community_name, user_id, role ON community_memberships
WHEN OLD.role = 'owner'
BEGIN
  SELECT RAISE(ABORT, 'owner membership is immutable');
END;

CREATE TRIGGER community_owner_membership_cannot_be_removed
BEFORE DELETE ON community_memberships
WHEN OLD.role = 'owner'
BEGIN
  SELECT RAISE(ABORT, 'owner membership cannot be removed');
END;
