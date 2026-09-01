/** @param {string} value */
export function asciiTrim(value) {
  return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
}

/** @param {unknown} value @returns {string | undefined} */
export function canonicalCommunityName(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = asciiTrim(value);
  return /^[A-Za-z0-9_]{3,21}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** @param {unknown} body @returns {{canonicalName: string, displayName: string} | undefined} */
export function validateCommunityCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  if (Object.keys(candidate).length !== 1 || !Object.hasOwn(candidate, "name") || typeof candidate.name !== "string") return undefined;
  const canonicalName = canonicalCommunityName(candidate.name);
  if (!canonicalName) return undefined;
  return { canonicalName, displayName: asciiTrim(candidate.name) };
}

/** @param {unknown} body @returns {{username: string, role: "member" | "moderator"} | undefined} */
export function validateModeratorChange(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  if (Object.keys(candidate).length !== 2 || !Object.hasOwn(candidate, "username") || !Object.hasOwn(candidate, "role")) return undefined;
  if (typeof candidate.username !== "string" || (candidate.role !== "member" && candidate.role !== "moderator")) return undefined;
  return { username: candidate.username, role: candidate.role };
}
