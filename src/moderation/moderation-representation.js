/** @param {{id: string, post_id: string, community_name: string, reporter_user_id: string, reported_at: number}} report */
export function reportRepresentation(report) {
  return { id: report.id, postId: report.post_id, community: report.community_name, reporterId: report.reporter_user_id, reportedAt: new Date(report.reported_at).toISOString() };
}
/** @param {{id: string, post_id: string, community_name: string, moderator_user_id: string, action: string, occurred_at: number}} event */
export function auditRepresentation(event) {
  return { id: event.id, postId: event.post_id, community: event.community_name, moderatorId: event.moderator_user_id, action: event.action, occurredAt: new Date(event.occurred_at).toISOString() };
}
