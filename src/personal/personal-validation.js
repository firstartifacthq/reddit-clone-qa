/** @param {URLSearchParams} params */
export function validatePersonalPage(params) {
  const limits = params.getAll("limit"); const cursors = params.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1 || [...params.keys()].some((key) => key !== "limit" && key !== "cursor")) return undefined;
  const limitText = limits[0];
  const limit = limitText === undefined ? 25 : /^[1-9][0-9]*$/.test(limitText) ? Number(limitText) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return undefined;
  const cursor = cursors[0];
  if (cursor !== undefined && (!cursor || cursor.length > 200)) return undefined;
  return { limit, cursor };
}

/** @param {unknown} patch */
export function validatePreferencePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return undefined;
  const fields = Object.keys(patch);
  if (fields.length === 0 || fields.some((field) => field !== "theme" && field !== "compactMode")) return undefined;
  const value = /** @type {{theme?: unknown, compactMode?: unknown}} */ (patch);
  if (value.theme !== undefined && !["system", "light", "dark"].includes(/** @type {string} */ (value.theme))) return undefined;
  if (value.compactMode !== undefined && typeof value.compactMode !== "boolean") return undefined;
  return /** @type {{theme?: "system" | "light" | "dark", compactMode?: boolean}} */ (value);
}
