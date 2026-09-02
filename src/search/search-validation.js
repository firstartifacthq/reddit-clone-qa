/** @typedef {{query: string, type?: "community" | "post" | "comment"}} SearchQuery */

const controlCharacter = /\p{Cc}/u;
const supportedTypes = new Set(["community", "post", "comment"]);

/** @param {string} component */
function decodeComponent(component) {
  return decodeURIComponent(component.replace(/\+/g, " "));
}

/**
 * Parse the raw query rather than URLSearchParams so malformed UTF-8 and encoded
 * duplicate keys are rejected before any search retrieval can occur.
 * @param {string} rawQuery
 * @returns {SearchQuery | undefined}
 */
export function validateSearchQuery(rawQuery) {
  /** @type {string[]} */
  const queries = [];
  /** @type {string[]} */
  const types = [];
  try {
    for (const part of rawQuery.split("&")) {
      if (part === "") continue;
      const separator = part.indexOf("=");
      const key = decodeComponent(separator < 0 ? part : part.slice(0, separator));
      const value = decodeComponent(separator < 0 ? "" : part.slice(separator + 1));
      if (key === "q") queries.push(value);
      if (key === "type") types.push(value);
    }
  } catch {
    return undefined;
  }
  if (queries.length !== 1 || types.length > 1) return undefined;
  const query = queries[0].trim();
  if ([...query].length < 1 || [...query].length > 200 || controlCharacter.test(query)) return undefined;
  if (types.length === 0) return { query };
  const type = types[0];
  if (!supportedTypes.has(type)) return undefined;
  return { query, type: /** @type {"community" | "post" | "comment"} */ (type) };
}
