/** @typedef {import("./search-repository.js").SearchRepository} SearchRepository */
/** @typedef {import("./search-repository.js").SearchCandidate} SearchCandidate */
/** @typedef {{type: "community", canonicalName: string} | {type: "post", id: string} | {type: "comment", id: string}} SearchResult */

const typeRank = { community: 0, post: 1, comment: 2 };

/** @param {SearchCandidate} candidate @param {string} query */
function matches(candidate, query) {
  const needle = query.toLowerCase();
  if (candidate.type === "community") return [candidate.canonicalName, candidate.displayName].some((value) => value.toLowerCase().includes(needle));
  if (candidate.type === "post") return [candidate.title, candidate.text, candidate.url].some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
  return candidate.body.toLowerCase().includes(needle);
}

/** @param {SearchCandidate} candidate @returns {SearchResult} */
function serialize(candidate) {
  if (candidate.type === "community") return { type: "community", canonicalName: candidate.canonicalName };
  if (candidate.type === "post") return { type: "post", id: candidate.id };
  if (candidate.type === "comment") return { type: "comment", id: candidate.id };
  throw new Error("unsupported search candidate");
}

/** @param {SearchResult} result */
function identity(result) { return result.type === "community" ? result.canonicalName : result.id; }

export class SearchService {
  /**
   * @param {{repository: SearchRepository | {list: (type?: "community" | "post" | "comment") => SearchCandidate[]}, readableCommunities: (actor: unknown) => string[], readPost: (id: string, actor: unknown) => unknown, readComment: (id: string, actor: unknown) => unknown}} options
   */
  constructor({ repository, readableCommunities, readPost, readComment }) {
    this.repository = repository;
    this.readableCommunities = readableCommunities;
    this.readPost = readPost;
    this.readComment = readComment;
  }

  /** @param {{query: string, type?: "community" | "post" | "comment"}} searchQuery @param {unknown} actor */
  search(searchQuery, actor) {
    try {
      const readableCommunities = searchQuery.type === "post" || searchQuery.type === "comment"
        ? new Set()
        : new Set(this.readableCommunities(actor));
      /** @type {Map<string, SearchResult>} */
      const results = new Map();
      for (const candidate of this.repository.list(searchQuery.type)) {
        const readable = candidate.type === "community"
          ? readableCommunities.has(candidate.canonicalName)
          : candidate.type === "post" ? Boolean(this.readPost(candidate.id, actor)) : Boolean(this.readComment(candidate.id, actor));
        if (!readable || !matches(candidate, searchQuery.query)) continue;
        const result = serialize(candidate);
        results.set(`${result.type}:${identity(result)}`, result);
      }
      return {
        kind: /** @type {const} */ ("success"),
        results: [...results.values()].sort((left, right) => {
          const rank = typeRank[left.type] - typeRank[right.type];
          if (rank !== 0) return rank;
          return identity(left) < identity(right) ? -1 : identity(left) > identity(right) ? 1 : 0;
        }),
      };
    } catch {
      return { kind: /** @type {const} */ ("unavailable") };
    }
  }
}
