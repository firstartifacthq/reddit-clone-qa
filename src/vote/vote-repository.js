/** @typedef {object} Statement
 * @property {(...parameters: any[]) => {changes: number}} run
 * @property {(...parameters: any[]) => any} get
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */

export class VoteRepository {
  /** @param {Database} database */
  constructor(database) {
    // Admission intentionally excludes vote state and aggregates from denied paths.
    this.target = database.prepare(`SELECT author_user_id, voting_state FROM readable_posts AS posts
      JOIN users ON users.id = posts.author_user_id AND users.deletion_requested_at IS NULL
      WHERE posts.id = ?`);
    this.current = database.prepare("SELECT value FROM post_votes WHERE post_id = ? AND voter_user_id = ?");
    this.insert = database.prepare("INSERT INTO post_votes (post_id, voter_user_id, value) VALUES (?, ?, ?)");
    this.replace = database.prepare("UPDATE post_votes SET value = ? WHERE post_id = ? AND voter_user_id = ?");
    this.remove = database.prepare("DELETE FROM post_votes WHERE post_id = ? AND voter_user_id = ?");
    this.resource = database.prepare(`SELECT posts.id AS post_id,
      (SELECT value FROM post_votes WHERE post_id = posts.id AND voter_user_id = ?) AS value,
      COALESCE((SELECT SUM(value) FROM post_votes WHERE post_id = posts.id), 0) AS score,
      COALESCE((SELECT SUM(vote.value) FROM readable_posts AS authored
        JOIN post_votes AS vote ON vote.post_id = authored.id
        WHERE authored.author_user_id = posts.author_user_id), 0) AS author_karma
      FROM readable_posts AS posts JOIN users ON users.id = posts.author_user_id AND users.deletion_requested_at IS NULL
      WHERE posts.id = ?`);
  }

  /** @param {string} postId */
  findTarget(postId) { return this.target.get(postId); }
  /** @param {string} postId @param {string} userId */
  currentVote(postId, userId) { return this.current.get(postId, userId); }
  /** @param {string} postId @param {string} userId @param {1 | -1} value */
  insertVote(postId, userId, value) { this.insert.run(postId, userId, value); }
  /** @param {string} postId @param {string} userId @param {1 | -1} value */
  replaceVote(postId, userId, value) { this.replace.run(value, postId, userId); }
  /** @param {string} postId @param {string} userId */
  removeVote(postId, userId) { this.remove.run(postId, userId); }
  /** @param {string} postId @param {string} userId */
  voteResource(postId, userId) { return this.resource.get(userId, postId); }
}
