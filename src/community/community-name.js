/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function canonicalCommunityName(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  const canonical = trimmed.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return /^[a-z0-9_]{3,21}$/.test(canonical) ? canonical : undefined;
}

/**
 * @param {unknown} body
 * @returns {string | undefined}
 */
export function validCommunityName(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("name" in body)) return undefined;
  return canonicalCommunityName(body.name);
}
