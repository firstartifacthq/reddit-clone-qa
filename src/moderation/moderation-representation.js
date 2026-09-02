/** @param {{id: string, post_id: string, community_name: string, reason: string, created_at: number}} report */
export function reportRepresentation(report) {
  return { id: report.id, postId: report.post_id, community: report.community_name, reason: report.reason, createdAt: new Date(report.created_at).toISOString() };
}

/** @param {{id: string, community_name: string, post_id: string, actor: string, action: "remove" | "restore", created_at: number}} event */
export function auditRepresentation(event) {
  return { id: event.id, community: event.community_name, postId: event.post_id, actor: event.actor, action: event.action, createdAt: new Date(event.created_at).toISOString() };
}
