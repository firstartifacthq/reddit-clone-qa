import { voteRepresentation } from "./vote-representation.js";

/** @param {{exec: (sql: string) => void}} database */
function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }

export class VoteService {
  /** @param {{repository: import("./vote-repository.js").VoteRepository, notificationService?: import("../notification/notification-service.js").NotificationService, database: {exec: (sql: string) => void}, beforeVotePersist?: () => void}} options */
  constructor({ repository, notificationService, database, beforeVotePersist = () => {} }) {
    this.repository = repository; this.notifications = notificationService;
    this.database = database;
    this.beforeVotePersist = beforeVotePersist;
  }

  /** @param {string} userId @param {string} postId @param {boolean} mutation */
  authorize(userId, postId, mutation) {
    const target = this.repository.findTarget(postId);
    if (!target) return "not-found";
    if (mutation && (target.author_user_id === userId || target.voting_state !== "unlocked")) return "forbidden";
    return "allowed";
  }

  /** @param {string} userId @param {string} postId */
  get(userId, postId) {
    if (this.authorize(userId, postId, false) !== "allowed") return undefined;
    const resource = this.repository.voteResource(postId, userId);
    return resource ? voteRepresentation(resource) : undefined;
  }

  /** @param {string} userId @param {string} postId @param {1 | -1} value */
  set(userId, postId, value) { return this.transition(userId, postId, value); }
  /** @param {string} userId @param {string} postId */
  clear(userId, postId) { return this.transition(userId, postId, null); }

  /** @param {string} userId @param {string} postId @param {1 | -1 | null} value */
  transition(userId, postId, value) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const admission = this.authorize(userId, postId, true);
      if (admission !== "allowed") { rollback(this.database); return { kind: admission }; }
      const current = this.repository.currentVote(postId, userId);
      const prior = current ? /** @type {1 | -1} */ (current.value) : null;
      if (prior !== value) {
        this.beforeVotePersist();
        if (prior === null && value !== null) this.repository.insertVote(postId, userId, value);
        else if (value === null) this.repository.removeVote(postId, userId);
        else this.repository.replaceVote(postId, userId, value);
        this.notifications?.recordVoteEvent(this.repository.findTarget(postId).author_user_id, userId, postId);
      }
      const resource = this.repository.voteResource(postId, userId);
      this.database.exec("COMMIT");
      return { kind: "success", vote: voteRepresentation(resource) };
    } catch {
      rollback(this.database);
      return { kind: "unavailable" };
    }
  }
}
