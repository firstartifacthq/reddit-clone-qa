// @ts-expect-error Node built-in declarations are outside this JavaScript slice's ambient types.
import { randomUUID } from "node:crypto";

/** @typedef {{prepare: (sql: string) => any}} Database */

export class NotificationRepository {
  /** @param {Database} database */
  constructor(database) {
    this.activeUser = database.prepare("SELECT 1 FROM users WHERE id = ? AND deletion_requested_at IS NULL");
    this.activeByUsername = database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND deletion_requested_at IS NULL");
    this.nextSequence = database.prepare("SELECT COALESCE(MAX(occurrence_sequence), 0) + 1 AS value FROM notification_events");
    this.insertEvent = database.prepare(`INSERT OR IGNORE INTO notification_events
      (id, event_key, occurrence_sequence, recipient_user_id, kind, related_item_type, related_item_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.event = database.prepare("SELECT * FROM notification_events WHERE event_key = ?");
    this.insertNotification = database.prepare("INSERT OR IGNORE INTO notifications (id, event_id, owner_user_id) VALUES (?, ?, ?)");
    this.ownerAdmission = database.prepare("SELECT id FROM notifications WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL");
    this.updateRead = database.prepare("UPDATE notifications SET read_state = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL");
    this.deleteOne = database.prepare("UPDATE notifications SET deleted_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL");
    this.rows = database.prepare(`SELECT notification.id, event.kind, event.related_item_type, event.related_item_id, event.occurred_at, notification.read_state
      FROM notifications AS notification JOIN notification_events AS event ON event.id = notification.event_id
      WHERE notification.owner_user_id = ? AND notification.deleted_at IS NULL ORDER BY event.occurrence_sequence DESC, event.id ASC`);
    this.deleteExpiredTraversals = database.prepare("DELETE FROM notification_traversals WHERE expires_at <= ?");
    this.reusableTraversal = database.prepare("SELECT id FROM notification_traversals WHERE owner_user_id = ? AND snapshot_key = ? AND expires_at > ?");
    this.insertTraversal = database.prepare("INSERT OR IGNORE INTO notification_traversals (id, owner_user_id, snapshot_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)");
    this.insertItem = database.prepare("INSERT INTO notification_traversal_items (traversal_id, ordinal, notification_id) VALUES (?, ?, ?)");
    this.token = database.prepare(`SELECT token.traversal_id, token.start_ordinal FROM notification_page_tokens AS token
      JOIN notification_traversals AS traversal ON traversal.id = token.traversal_id
      WHERE token.token = ? AND traversal.owner_user_id = ? AND traversal.expires_at > ?`);
    this.page = database.prepare(`SELECT item.ordinal, notification.id, event.kind, event.related_item_type, event.related_item_id, event.occurred_at, notification.read_state
      FROM notification_traversal_items AS item JOIN notifications AS notification ON notification.id = item.notification_id
      JOIN notification_events AS event ON event.id = notification.event_id
      WHERE item.traversal_id = ? AND item.ordinal >= ? AND notification.deleted_at IS NULL ORDER BY item.ordinal LIMIT ?`);
    this.more = database.prepare(`SELECT 1 FROM notification_traversal_items AS item JOIN notifications AS notification ON notification.id = item.notification_id
      WHERE item.traversal_id = ? AND item.ordinal >= ? AND notification.deleted_at IS NULL LIMIT 1`);
    this.insertToken = database.prepare("INSERT OR IGNORE INTO notification_page_tokens (token, traversal_id, start_ordinal) VALUES (?, ?, ?)");
    this.tokenAtStart = database.prepare("SELECT token FROM notification_page_tokens WHERE traversal_id = ? AND start_ordinal = ?");
  }
  /** @param {string} id */ isActiveUser(id) { return Boolean(this.activeUser.get(id)); }
  /** @param {string} username */ activeUserByUsername(username) { return this.activeByUsername.get(username)?.id; }
  /** @param {{id: string, eventKey: string, recipientId: string, kind: "reply" | "mention" | "vote" | "moderation", itemType: "comment" | "post", itemId: string, occurredAt: number}} event */
  recordEvent(event) {
    this.insertEvent.run(event.id, event.eventKey, this.nextSequence.get().value, event.recipientId, event.kind, event.itemType, event.itemId, event.occurredAt);
    return this.event.get(event.eventKey);
  }
  /** @param {{id: string, recipient_user_id: string}} event */ deliver(event) { this.insertNotification.run(randomUUID(), event.id, event.recipient_user_id); }
  /** @param {string} id @param {string} owner */ ownsUndeleted(id, owner) { return Boolean(this.ownerAdmission.get(id, owner)); }
  /** @param {string} id @param {string} owner @param {boolean} read */ updateReadState(id, owner, read) { return this.updateRead.run(read ? 1 : 0, id, owner).changes; }
  /** @param {string} id @param {string} owner @param {number} now */ delete(id, owner, now) { return this.deleteOne.run(now, id, owner).changes; }
  /** @param {string} owner */ listingRows(owner) { return this.rows.all(owner); }
  /** @param {number} now */ reclaim(now) { this.deleteExpiredTraversals.run(now); }
  /** @param {string} owner @param {string} key @param {number} now */ traversalFor(owner, key, now) { return this.reusableTraversal.get(owner, key, now)?.id; }
  /** @param {string} id @param {string} owner @param {string} key @param {number} now @param {{id: string}[]} rows */
  createTraversal(id, owner, key, now, rows) { const result = this.insertTraversal.run(id, owner, key, now, now + 86_400_000); if (result.changes) rows.forEach((row, ordinal) => this.insertItem.run(id, ordinal, row.id)); return result.changes ? id : this.traversalFor(owner, key, now); }
  /** @param {string} token @param {string} owner @param {number} now */ tokenFor(token, owner, now) { return this.token.get(token, owner, now); }
  /** @param {string} id @param {number} start @param {number} limit */ pageFor(id, start, limit) { return this.page.all(id, start, limit); }
  /** @param {string} id @param {number} start */ hasMore(id, start) { return Boolean(this.more.get(id, start)); }
  /** @param {string} token @param {string} traversal @param {number} start */ createToken(token, traversal, start) { this.insertToken.run(token, traversal, start); return this.tokenAtStart.get(traversal, start).token; }
}
