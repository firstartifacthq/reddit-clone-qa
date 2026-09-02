/** @param {string} search */
function hasWellFormedEncoding(search) {
  const rawPairs = search.length === 0 ? [] : search.slice(1).split("&");
  try {
    for (const pair of rawPairs) {
      const separator = pair.indexOf("=");
      decodeURIComponent((separator < 0 ? pair : pair.slice(0, separator)).replace(/\+/g, " "));
      if (separator >= 0) decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, " "));
    }
    return true;
  } catch { return false; }
}

/** @typedef {"community" | "post" | "comment"} SearchType */

/** @param {URL} url @returns {{query: string, type?: SearchType} | undefined} */
export function validateSearch(url) {
  if (!hasWellFormedEncoding(url.search)) return undefined;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "q" && key !== "type")) return undefined;
  const queries = url.searchParams.getAll("q");
  const types = url.searchParams.getAll("type");
  if (queries.length !== 1 || types.length > 1) return undefined;
  const query = queries[0].trim();
  if (query.length === 0 || /[\p{Cc}]/u.test(queries[0])) return undefined;
  const type = /** @type {SearchType | undefined} */ (types[0]);
  if (type !== undefined && type !== "community" && type !== "post" && type !== "comment") return undefined;
  return { query, type };
}
