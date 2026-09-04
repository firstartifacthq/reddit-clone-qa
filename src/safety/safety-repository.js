/** @typedef {{prepare: (sql: string) => any}} Database */

export class SafetyRepository {
  /** @param {Database} database */
  constructor(database) {
    this.activeUser = database.prepare("SELECT id FROM users WHERE id = ? AND deletion_requested_at IS NULL");
    this.activeUsername = database.prepare("SELECT id FROM users WHERE username = ? AND deletion_requested_at IS NULL");
    this.insertBlock = database.prepare("INSERT OR IGNORE INTO user_blocks (blocker_user_id, blocked_user_id, created_at) VALUES (?, ?, ?)");
    this.deleteExpiredEvents = database.prepare("DELETE FROM post_creation_events WHERE created_at <= ?");
    this.activeEvents = database.prepare("SELECT created_at FROM post_creation_events WHERE user_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC");
    this.insertEvent = database.prepare("INSERT INTO post_creation_events (id, user_id, post_id, created_at) VALUES (?, ?, ?, ?)");
  }
  /** @param {string} userId */ isActiveUser(userId) { return Boolean(this.activeUser.get(userId)); }
  /** @param {string} username */ activeUserByUsername(username) { return this.activeUsername.get(username); }
  /** @param {string} blockerId @param {string} blockedId @param {number} now */ block(blockerId, blockedId, now) { this.insertBlock.run(blockerId, blockedId, now); }
  /** @param {number} cutoff */ expireCreationEvents(cutoff) { this.deleteExpiredEvents.run(cutoff); }
  /** @param {string} userId @param {number} cutoff */ creationEvents(userId, cutoff) { return this.activeEvents.all(userId, cutoff); }
  /** @param {string} id @param {string} userId @param {string} postId @param {number} now */ recordCreation(id, userId, postId, now) { this.insertEvent.run(id, userId, postId, now); }
}
