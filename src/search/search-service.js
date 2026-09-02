import { searchRepresentation } from "./search-representation.js";

/** @typedef {import("./search-repository.js").SearchCandidate} SearchCandidate */
const typeRank = Object.freeze({ community: 0, post: 1, comment: 2 });

/** @param {string | null} value @param {string} query */
function matches(value, query) { return typeof value === "string" && value.toLowerCase().includes(query); }
/** @param {SearchCandidate} row @param {string} query */
function rowMatches(row, query) {
  if (row.kind === "community") return matches(row.canonical_name, query) || matches(row.display_name, query);
  if (row.kind === "post") return matches(row.title, query) || matches(row.content, query);
  return matches(row.body, query);
}
/** @param {string} left @param {string} right */
function compareIdentifier(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export class SearchService {
  /** @param {{repository: import("./search-repository.js").SearchRepository, beforeSearchRead?: () => void}} options */
  constructor({ repository, beforeSearchRead = () => {} }) {
    this.repository = repository;
    this.beforeSearchRead = beforeSearchRead;
  }

  /** @param {{query: string, type?: "community" | "post" | "comment"}} search @param {{id: string, username: string} | undefined} requester */
  find(search, requester) {
    // The requester remains at this boundary so future canonical visibility predicates stay transport-independent.
    void requester;
    try {
      this.beforeSearchRead();
      const query = search.query.toLowerCase();
      const seen = new Set();
      const results = [];
      for (const row of this.repository.candidatesForRead()) {
        if (search.type && row.kind !== search.type) continue;
        if (!rowMatches(row, query)) continue;
        const key = `${row.kind}:${row.canonical_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ row, representation: searchRepresentation(row) });
      }
      results.sort((left, right) => typeRank[left.row.kind] - typeRank[right.row.kind]
        || compareIdentifier(left.row.canonical_id, right.row.canonical_id));
      return { kind: "success", results: results.map((result) => result.representation) };
    } catch { return { kind: "unavailable" }; }
  }
}
