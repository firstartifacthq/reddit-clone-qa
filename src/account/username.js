/**
 * Canonicalizes the product's ASCII-only surrounding whitespace without
 * converting the case-preserving username stored in SQLite.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeUsername(value) {
  if (typeof value !== "string") return undefined;
  const username = value.replace(/^[\x09-\x0D\x20]+|[\x09-\x0D\x20]+$/g, "");
  return /^[A-Za-z0-9_-]{3,32}$/.test(username) ? username : undefined;
}
