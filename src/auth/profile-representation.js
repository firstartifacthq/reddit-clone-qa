/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} username
 * @property {string} bio
 * @property {number} revision
 */

/**
 * @param {Profile} profile
 * @returns {Profile}
 */
export function ownerProfileRepresentation(profile) {
  return { id: profile.id, username: profile.username, bio: profile.bio, revision: profile.revision };
}

/**
 * @param {Profile} profile
 * @returns {{id: string, username: string, bio: string}}
 */
export function publicProfileRepresentation(profile) {
  return { id: profile.id, username: profile.username, bio: profile.bio };
}
