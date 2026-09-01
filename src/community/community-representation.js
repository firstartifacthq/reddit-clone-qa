/** @param {{name: string}} community */
export function publicCommunityRepresentation(community) {
  return { name: community.name };
}

/**
 * @param {{name: string}} community
 * @param {{username: string, role: string}} membership
 */
export function membershipRepresentation(community, membership) {
  return {
    community: publicCommunityRepresentation(community),
    membership: { username: membership.username, role: membership.role },
  };
}

/** @param {{name: string}} community */
export function modlogRepresentation(community) {
  return { community: publicCommunityRepresentation(community), entries: [] };
}
