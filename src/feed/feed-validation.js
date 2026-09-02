/** @param {URLSearchParams} query */
export function validateFeedPage(query) {
  const allowed = new Set(["limit", "cursor"]);
  for (const key of query.keys()) if (!allowed.has(key)) return undefined;
  const limits = query.getAll("limit");
  const cursors = query.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) return undefined;

  let limit = 25;
  if (limits.length === 1) {
    const value = limits[0];
    if (!/^(?:[1-9][0-9]?|100)$/.test(value)) return undefined;
    limit = Number(value);
  }
  const cursor = cursors[0];
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{20,256}$/.test(cursor)) return undefined;
  return { limit, cursor };
}
