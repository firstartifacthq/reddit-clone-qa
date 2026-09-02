/** @typedef {import("./search-repository.js").SearchRepository} SearchRepository */
/** @typedef {import("./search-repository.js").SearchCandidate} SearchCandidate */
/** @typedef {{type: "community", canonicalName: string} | {type: "post", id: string} | {type: "comment", id: string}} SearchResult */

const typeRank = { community: 0, post: 1, comment: 2 };

/** @param {string[]} values @param {string} query */
function textMatches(values, query) {
  const needle = query.toLowerCase();
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unicodeCaselessLiteral = new RegExp(escaped, "iu");
  return values.some((value) => value.toLowerCase().includes(needle) || unicodeCaselessLiteral.test(value));
}

/** @param {SearchCandidate & {type: "community"}} candidate @param {string} query */
function communityMatches(candidate, query) {
  return textMatches([candidate.canonicalName, candidate.displayName], query);
}

/** @param {unknown} directRead @param {string} id @param {string} query */
function postMatches(directRead, id, query) {
  if (!directRead || typeof directRead !== "object") return false;
  const post = /** @type {Record<string, unknown>} */ (directRead);
  if (post.id !== id || typeof post.title !== "string") return false;
  return textMatches([post.title, post.text, post.url].filter((value) => typeof value === "string"), query);
}

/** @param {unknown} directRead @param {string} id @param {string} query */
function commentMatches(directRead, id, query) {
  if (!directRead || typeof directRead !== "object") return false;
  const comment = /** @type {Record<string, unknown>} */ (directRead);
  return comment.id === id && comment.state === "active" && typeof comment.body === "string"
    && textMatches([comment.body], query);
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
      /** @type {Set<string> | undefined} */
      let readableCommunities;
      /** @type {Map<string, SearchResult>} */
      const results = new Map();
      for (const candidate of this.repository.list(searchQuery.type)) {
        if (searchQuery.type && candidate.type !== searchQuery.type) continue;
        let currentMatch;
        if (candidate.type === "community") {
          const admittedCommunities = readableCommunities || new Set(this.readableCommunities(actor));
          readableCommunities = admittedCommunities;
          currentMatch = admittedCommunities.has(candidate.canonicalName) && communityMatches(candidate, searchQuery.query);
        } else if (candidate.type === "post") {
          currentMatch = postMatches(this.readPost(candidate.id, actor), candidate.id, searchQuery.query);
        } else if (candidate.type === "comment") {
          currentMatch = commentMatches(this.readComment(candidate.id, actor), candidate.id, searchQuery.query);
        } else {
          throw new Error("unsupported search candidate");
        }
        if (!currentMatch) continue;
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
