/** @typedef {{kind: "community" | "post" | "comment", canonical_id: string, canonical_name: string | null, display_name: string | null, title: string | null, content: string | null, body: string | null}} SearchCandidate */
/** @typedef {object} Statement
 * @property {(...parameters: any[]) => any[]} all
 */
/** @typedef {{prepare: (sql: string) => Statement}} Database */

export class SearchRepository {
  /** @param {Database} database */
  constructor(database) {
    // A single statement provides one SQLite read snapshot without a derived search index.
    this.candidates = database.prepare(`SELECT 'community' AS kind, canonical_name AS canonical_id,
        canonical_name, display_name, NULL AS title, NULL AS content, NULL AS body
      FROM communities
      UNION ALL
      SELECT 'post' AS kind, id AS canonical_id, NULL AS canonical_name, NULL AS display_name,
        title, CASE type WHEN 'text' THEN text_content WHEN 'link' THEN url_content ELSE NULL END AS content, NULL AS body
      FROM posts
      UNION ALL
      SELECT 'comment' AS kind, comments.id AS canonical_id, NULL AS canonical_name, NULL AS display_name,
        NULL AS title, NULL AS content, comments.body AS body
      FROM comments JOIN posts ON posts.id = comments.post_id
      WHERE comments.state = 'active' AND comments.body IS NOT NULL`);
  }

  /** @returns {SearchCandidate[]} */
  candidatesForRead() { return /** @type {SearchCandidate[]} */ (this.candidates.all()); }
}
