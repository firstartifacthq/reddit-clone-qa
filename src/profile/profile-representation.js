/** @typedef {{id: string, username: string, bio: string, revision: number}} Profile */

/** @param {Profile} profile */
export function ownerProfileRepresentation(profile) {
  return { id: profile.id, username: profile.username, bio: profile.bio, revision: profile.revision };
}

/** @param {Profile} profile */
export function publicProfileRepresentation(profile) {
  return { id: profile.id, username: profile.username, bio: profile.bio };
}
