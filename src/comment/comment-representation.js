/** @param {{id: string, post_id: string, parent_id: string | null, username: string | null, body: string | null, depth: number, state: "active" | "deleted"}} comment */
export function commentRepresentation(comment) {
  if (comment.state === "deleted") return {
    id: comment.id, postId: comment.post_id, parentId: comment.parent_id, depth: comment.depth, state: "deleted",
  };
  return {
    id: comment.id, postId: comment.post_id, parentId: comment.parent_id, author: comment.username, body: comment.body, depth: comment.depth, state: "active",
  };
}
