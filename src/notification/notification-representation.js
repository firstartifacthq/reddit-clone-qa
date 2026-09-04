/** @param {{id: string, kind: string, related_item_type: string, related_item_id: string, occurred_at: number, read_state: number}} row */
export function notificationRepresentation(row) {
  return {
    id: row.id,
    kind: row.kind,
    relatedItem: { type: row.related_item_type, id: row.related_item_id },
    eventAt: new Date(row.occurred_at).toISOString(),
    read: Boolean(row.read_state),
  };
}
