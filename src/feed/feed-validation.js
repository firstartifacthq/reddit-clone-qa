/** @param {URLSearchParams} params */
export function validateFeedPage(params) {
  const limits = params.getAll("limit");
  const cursors = params.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1 || [...params.keys()].some((key) => key !== "limit" && key !== "cursor")) return undefined;
  const text = limits[0];
  const limit = text === undefined ? 25 : /^[1-9][0-9]*$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return undefined;
  const cursor = cursors[0];
  // Tokens are opaque authorities, but keep their accepted transport grammar bounded.
  if (cursor !== undefined && (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor))) return undefined;
  return { limit, cursor };
}
