/** @param {URLSearchParams} params */
export function validateNotificationPage(params) {
  const limits = params.getAll("limit"); const cursors = params.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1 || [...params.keys()].some((key) => key !== "limit" && key !== "cursor")) return undefined;
  const text = limits[0]; const limit = text === undefined ? 25 : /^[1-9][0-9]*$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return undefined;
  const cursor = cursors[0];
  if (cursor !== undefined && (!cursor || cursor.length > 200)) return undefined;
  return { limit, cursor };
}

/** @param {unknown} patch */
export function validateNotificationPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return undefined;
  const fields = Object.keys(patch);
  if (fields.length !== 1 || fields[0] !== "read" || typeof /** @type {{read?: unknown}} */ (patch).read !== "boolean") return undefined;
  return /** @type {{read: boolean}} */ (patch);
}

/** @param {unknown} value */
export function validateDeliveryRetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = Object.keys(value); const eventKey = /** @type {{eventKey?: unknown}} */ (value).eventKey;
  if (fields.length !== 1 || fields[0] !== "eventKey" || typeof eventKey !== "string" || eventKey.length < 1 || eventKey.length > 200) return undefined;
  return eventKey;
}
