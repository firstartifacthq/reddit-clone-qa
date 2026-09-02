/** @typedef {object} Statement
 * @property {(...parameters: any[]) => any[]} all
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */

/**
 * @typedef {{type: "community", canonicalName: string, displayName: string} |
 *   {type: "post", id: string, title: string, text: string | null, url: string | null} |
 *   {type: "comment", id: string, body: string}} SearchCandidate
 */

export class SearchRepository {
  /** @param {Database} database */
  constructor(database) {
    this.communities = database.prepare("SELECT canonical_name, display_name FROM communities");
    this.posts = database.prepare("SELECT id, title, text_content, url_content FROM posts");
    this.comments = database.prepare("SELECT id, body FROM comments WHERE state = 'active'");
  }

  /** @param {"community" | "post" | "comment" | undefined} type @returns {SearchCandidate[]} */
  list(type) {
    /** @type {SearchCandidate[]} */
    const candidates = [];
    if (!type || type === "community") {
      candidates.push(...this.communities.all().map((row) => ({ type: /** @type {const} */ ("community"), canonicalName: row.canonical_name, displayName: row.display_name })));
    }
    if (!type || type === "post") {
      candidates.push(...this.posts.all().map((row) => ({ type: /** @type {const} */ ("post"), id: row.id, title: row.title, text: row.text_content, url: row.url_content })));
    }
    if (!type || type === "comment") {
      candidates.push(...this.comments.all().map((row) => ({ type: /** @type {const} */ ("comment"), id: row.id, body: row.body })));
    }
    return candidates;
  }
}
