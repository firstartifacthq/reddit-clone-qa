/**
 * @param {string} value
 * @returns {string}
 */
export function trimAsciiWhitespace(value) {
  return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeUsername(value) {
  if (typeof value !== "string") return undefined;
  const username = trimAsciiWhitespace(value);
  return /^[A-Za-z0-9_-]{3,32}$/.test(username) ? username : undefined;
}

/**
 * @param {unknown} body
 * @returns {{username?: string, bio?: string} | undefined}
 */
export function validateProfilePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.some((key) => key !== "username" && key !== "bio")) return undefined;
  /** @type {{username?: string, bio?: string}} */
  const patch = {};
  if (Object.hasOwn(candidate, "username")) {
    const username = normalizeUsername(candidate.username);
    if (!username) return undefined;
    patch.username = username;
  }
  if (Object.hasOwn(candidate, "bio")) {
    if (typeof candidate.bio !== "string" || Array.from(candidate.bio).length > 500) return undefined;
    patch.bio = candidate.bio;
  }
  return patch;
}
