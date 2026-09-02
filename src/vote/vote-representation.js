/** @param {{post_id: string, value: 1 | -1 | null, score: number, author_karma: number}} vote */
export function voteRepresentation(vote) {
  return { postId: vote.post_id, value: vote.value, score: vote.score, authorKarma: vote.author_karma };
}
