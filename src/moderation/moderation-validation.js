/** @param {URLSearchParams} params */
export function validateModerationQueuePage(params) {
  const limits = params.getAll("limit"); const cursors = params.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1 || [...params.keys()].some((key) => key !== "limit" && key !== "cursor")) return undefined;
  const limitText = limits[0]; const limit = limitText === undefined ? 25 : /^[1-9][0-9]*$/.test(limitText) ? Number(limitText) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return undefined;
  const cursor = cursors[0];
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) return undefined;
  return { limit, cursor };
}
