/** Canonical public opaque identifiers; no caller selects a subject. @param {unknown} value */
export function opaqueId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined; }
/** @param {unknown} rawPayload */
export function selfRequest(rawPayload) { return rawPayload === undefined; }
/** @param {unknown} body */
export function deletionTarget(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  return Object.keys(candidate).length === 1 && Object.hasOwn(candidate, "userId") ? opaqueId(candidate.userId) : undefined;
}
/** @param {URLSearchParams} params */
export function auditPage(params) {
  const entries = [...params.entries()];
  if (entries.some(([key]) => key !== "limit" && key !== "cursor")) return undefined;
  const limits = params.getAll("limit"); const cursors = params.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) return undefined;
  const value = limits[0] ?? "50";
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) return undefined;
  if (cursors.length === 1 && !opaqueId(cursors[0])) return undefined;
  return { limit: Number(value), cursor: cursors[0] };
}
