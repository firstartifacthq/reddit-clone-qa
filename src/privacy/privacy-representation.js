/** @param {{id:string, operation:string, action:string}} row */
export function jobRepresentation(row) { return { jobId: row.id, operation: row.operation, state: row.action === "accepted" ? "pending" : row.action }; }
/** @param {{id:string, occurrence_sequence:number, operation:string, action:string, occurred_at:number}} event */
export function auditRepresentation(event) { return { id: event.id, sequence: event.occurrence_sequence, operation: event.operation, action: event.action, occurredAt: event.occurred_at }; }
