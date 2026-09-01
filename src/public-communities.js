import { publicCommunityRepresentation } from "./community/community-representation.js";

/**
 * @param {{publicCommunities: () => {name: string}[]}} repository
 */
export function publicCommunities(repository) {
  return { communities: repository.publicCommunities().map(publicCommunityRepresentation) };
}
