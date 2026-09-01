import { normalizeUsername } from "../account/username.js";

const editableFields = new Set(["username", "bio"]);

/**
 * @param {unknown} body
 * @returns {{username?: string, bio?: string} | undefined}
 */
export function validateProfilePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  const entries = Object.entries(candidate);
  if (entries.length === 0 || entries.some(([key]) => !editableFields.has(key))) return undefined;
  /** @type {{username?: string, bio?: string}} */
  const patch = {};
  if (Object.hasOwn(candidate, "username")) {
    const username = normalizeUsername(candidate.username);
    if (!username) return undefined;
    patch.username = username;
  }
  if (Object.hasOwn(candidate, "bio")) {
    if (typeof candidate.bio !== "string" || [...candidate.bio].length > 500) return undefined;
    patch.bio = candidate.bio;
  }
  return patch;
}
