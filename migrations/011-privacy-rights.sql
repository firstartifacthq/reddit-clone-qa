-- RC-13 privacy rights ledger. State is represented only by append-only events.
INSERT OR IGNORE INTO users (id, username, password_salt, password_verifier, created_at, bio, revision, deletion_requested_at)
VALUES ('__privacy_tombstone__', '__privacy_tombstone__', '!', '!', 0, '', 0, 0);

-- Existing immutable actor records may be anonymized to the reserved inactive structural account.
DROP TRIGGER communities_owner_is_immutable;
CREATE TRIGGER communities_owner_is_immutable BEFORE UPDATE OF owner_user_id ON communities
WHEN NEW.owner_user_id <> '__privacy_tombstone__'
BEGIN SELECT RAISE(ABORT, 'community owner is immutable'); END;
DROP TRIGGER community_owner_membership_matches_community_on_update;
CREATE TRIGGER community_owner_membership_matches_community_on_update BEFORE UPDATE OF community_name, user_id, role ON community_memberships
WHEN NEW.role = 'owner' AND NEW.user_id <> '__privacy_tombstone__' AND NOT EXISTS (SELECT 1 FROM communities WHERE canonical_name = NEW.community_name AND owner_user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'owner membership must match community owner'); END;
DROP TRIGGER community_owner_membership_is_immutable;
CREATE TRIGGER community_owner_membership_is_immutable BEFORE UPDATE OF community_name, user_id, role ON community_memberships
WHEN OLD.role = 'owner' AND NEW.user_id <> '__privacy_tombstone__'
BEGIN SELECT RAISE(ABORT, 'owner membership is immutable'); END;
DROP TRIGGER community_owner_membership_cannot_be_removed;
CREATE TRIGGER community_owner_membership_cannot_be_removed BEFORE DELETE ON community_memberships
WHEN OLD.role = 'owner' AND OLD.user_id <> '__privacy_tombstone__'
BEGIN SELECT RAISE(ABORT, 'owner membership cannot be removed'); END;
DROP TRIGGER notification_events_are_immutable;
CREATE TRIGGER notification_events_are_immutable BEFORE UPDATE ON notification_events
WHEN NEW.recipient_user_id <> '__privacy_tombstone__'
BEGIN SELECT RAISE(ABORT, 'notification event is immutable'); END;
DROP TRIGGER notifications_owner_is_immutable;
CREATE TRIGGER notifications_owner_is_immutable BEFORE UPDATE OF owner_user_id, event_id ON notifications
WHEN NEW.owner_user_id <> '__privacy_tombstone__'
BEGIN SELECT RAISE(ABORT, 'notification ownership is immutable'); END;
DROP TRIGGER moderation_audit_events_are_immutable;
CREATE TRIGGER moderation_audit_events_are_immutable BEFORE UPDATE ON moderation_audit_events
WHEN NEW.moderator_user_id <> '__privacy_tombstone__'
BEGIN SELECT RAISE(ABORT, 'moderation audit event is immutable'); END;

CREATE TABLE privacy_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('export', 'deletion')),
  subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  subject_key TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);
CREATE INDEX privacy_jobs_pending_subject_operation ON privacy_jobs(subject_key, operation);
CREATE INDEX privacy_jobs_subject_operation ON privacy_jobs(subject_user_id, operation, created_at);

CREATE TABLE privacy_job_events (
 id TEXT PRIMARY KEY NOT NULL,
 job_id TEXT NOT NULL REFERENCES privacy_jobs(id),
 occurrence_sequence INTEGER NOT NULL UNIQUE CHECK (typeof(occurrence_sequence) = 'integer' AND occurrence_sequence > 0),
 operation TEXT NOT NULL CHECK (operation IN ('export', 'deletion')),
 action TEXT NOT NULL CHECK (action IN ('accepted', 'completed', 'revoked')),
 occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0),
 CHECK ((operation = 'export' AND action IN ('accepted','completed','revoked')) OR (operation = 'deletion' AND action IN ('accepted','completed')))
);
CREATE INDEX privacy_job_events_order ON privacy_job_events(occurrence_sequence, id);
CREATE UNIQUE INDEX privacy_job_event_action_once ON privacy_job_events(job_id, action);
CREATE TRIGGER privacy_job_events_legal_transition BEFORE INSERT ON privacy_job_events
BEGIN
 SELECT CASE WHEN NEW.operation <> (SELECT operation FROM privacy_jobs WHERE id = NEW.job_id) THEN RAISE(ABORT, 'privacy job operation mismatch') END;
 SELECT CASE WHEN NEW.action = 'accepted' AND EXISTS (SELECT 1 FROM privacy_job_events WHERE job_id = NEW.job_id) THEN RAISE(ABORT, 'privacy job already accepted') END;
 SELECT CASE WHEN NEW.action = 'completed' AND NOT EXISTS (SELECT 1 FROM privacy_job_events WHERE job_id = NEW.job_id AND action = 'accepted') THEN RAISE(ABORT, 'privacy job must be pending') END;
 SELECT CASE WHEN NEW.action = 'completed' AND EXISTS (SELECT 1 FROM privacy_job_events WHERE job_id = NEW.job_id AND action IN ('completed','revoked')) THEN RAISE(ABORT, 'privacy job terminal') END;
 SELECT CASE WHEN NEW.action = 'revoked' AND (NEW.operation <> 'export' OR NOT EXISTS (SELECT 1 FROM privacy_job_events WHERE job_id = NEW.job_id AND action IN ('accepted','completed')) OR EXISTS (SELECT 1 FROM privacy_job_events WHERE job_id = NEW.job_id AND action = 'revoked')) THEN RAISE(ABORT, 'privacy job cannot be revoked') END;
END;
CREATE TRIGGER privacy_job_events_are_immutable BEFORE UPDATE ON privacy_job_events BEGIN SELECT RAISE(ABORT, 'privacy audit event is immutable'); END;
CREATE TRIGGER privacy_job_events_cannot_be_deleted BEFORE DELETE ON privacy_job_events BEGIN SELECT RAISE(ABORT, 'privacy audit event cannot be deleted'); END;

CREATE TABLE privacy_export_payloads (job_id TEXT PRIMARY KEY NOT NULL REFERENCES privacy_jobs(id) ON DELETE CASCADE, payload_json TEXT NOT NULL);
CREATE TABLE privacy_deletion_progress (job_id TEXT PRIMARY KEY NOT NULL REFERENCES privacy_jobs(id) ON DELETE CASCADE, phase TEXT NOT NULL CHECK (phase IN ('pending','sanitizing','vacuumed')));
CREATE TABLE privacy_audit_traversals (id TEXT PRIMARY KEY NOT NULL, administrator_user_id TEXT NOT NULL, maximum_sequence INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE privacy_audit_tokens (token TEXT PRIMARY KEY NOT NULL, traversal_id TEXT NOT NULL REFERENCES privacy_audit_traversals(id) ON DELETE CASCADE, next_sequence INTEGER NOT NULL, UNIQUE(traversal_id, next_sequence));
