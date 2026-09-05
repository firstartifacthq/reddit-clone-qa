// @ts-nocheck
import { randomUUID } from "node:crypto";
import { auditRepresentation, jobRepresentation } from "./privacy-representation.js";

function rollback(database) { try { database.exec("ROLLBACK"); } catch {} }

/** Lifecycle orchestration. Every state change is an event written in its effect transaction. */
export class PrivacyService {
  /** @param {{repository:any, database:any, now?:()=>number, identifier?:()=>string, beforeAcceptance?:()=>void}} options */
  constructor({ repository, database, now = Date.now, identifier = randomUUID, beforeAcceptance }) { Object.assign(this, { repository, database, now, identifier, beforeAcceptance }); }
  requestExport(owner) { return this.accept(owner, "export"); }
  requestDeletion(subject) { return this.accept(subject, "deletion"); }
  accept(subject, operation) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (!this.repository.active(subject)) { rollback(this.database); return { kind: "lost-authority" }; }
      const prior = this.repository.pendingFor(subject, operation);
      if (prior) { this.database.exec("COMMIT"); return { kind: "success", job: jobRepresentation(prior), existing: true }; }
      const jobId = this.identifier();
      this.repository.create(jobId, operation, subject, this.now());
      if (operation === "export") this.repository.storePayload(jobId, this.repository.exportSnapshot(subject));
      else {
        for (const exportJob of this.repository.revocableExports(subject)) {
          this.repository.removePayload(exportJob.id);
          this.repository.event(this.identifier(), exportJob.id, "export", "revoked", this.now());
        }
        this.repository.beginDeletion(jobId, subject);
        this.database.prepare("UPDATE users SET deletion_requested_at=? WHERE id=? AND deletion_requested_at IS NULL").run(this.now(), subject);
        this.database.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(this.now(), subject);
      }
      this.repository.event(this.identifier(), jobId, operation, "accepted", this.now());
      this.beforeAcceptance?.();
      this.database.exec("COMMIT");
      return { kind: "success", job: { jobId, operation, state: "pending" }, existing: false };
    } catch { rollback(this.database); return { kind: "unavailable" }; }
  }
  exportStatus(id, owner) { const row = this.repository.ownerQualifiedJob(id, owner); return row?.operation === "export" ? jobRepresentation(row) : undefined; }
  exportResult(id, owner) { const row = this.repository.ownerQualifiedJob(id, owner); if (!row || row.operation !== "export" || row.action !== "completed") return undefined; const value = this.repository.payload(id); return value ? JSON.parse(value) : undefined; }
  deletionStatus(id) { const row = this.repository.current(id); return row?.operation === "deletion" ? jobRepresentation(row) : undefined; }
  completeExport(jobId) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const current = this.repository.current(jobId);
      if (!current || current.operation !== "export" || current.action !== "accepted" || !this.repository.payload(jobId)) { rollback(this.database); return false; }
      this.repository.event(this.identifier(), jobId, "export", "completed", this.now());
      this.database.exec("COMMIT"); return true;
    } catch { rollback(this.database); return false; }
  }
  /** Advance exactly one durable deletion checkpoint. Completion is last, after compaction and verification. */
  advanceDeletion(job) {
    try {
      if (job.phase === "rows_erased") {
        // VACUUM cannot run in a transaction. If it or the following checkpoint commit is interrupted,
        // rows_erased remains authoritative and the same compaction is safely retried after reopen.
        this.database.exec("VACUUM");
        this.database.exec("BEGIN IMMEDIATE");
        const current = this.repository.current(job.id);
        if (!current || current.operation !== "deletion" || current.action !== "accepted" ||
            !this.repository.advanceDeletionPhase(job.id, "rows_erased", "compacted")) { rollback(this.database); return false; }
        this.database.exec("COMMIT");
        return true;
      }

      this.database.exec("BEGIN IMMEDIATE");
      const current = this.repository.current(job.id);
      if (!current || current.operation !== "deletion" || current.action !== "accepted") { rollback(this.database); return false; }
      if (job.phase === "accepted") {
        const subject = this.repository.deletionSubject(job.id, "accepted");
        if (!subject) { rollback(this.database); return false; }
        this.repository.erase(subject);
        if (!this.repository.advanceDeletionPhase(job.id, "accepted", "rows_erased")) { rollback(this.database); return false; }
        this.database.exec("COMMIT");
        return true;
      }
      if (job.phase === "compacted") {
        const subject = this.repository.deletionSubject(job.id, "compacted");
        if (!subject || !this.repository.verifyErasure(job.id, subject)) { rollback(this.database); return false; }
        if (!this.repository.clearDeletionProgress(job.id, "compacted")) { rollback(this.database); return false; }
        this.repository.event(this.identifier(), job.id, "deletion", "completed", this.now());
        this.database.exec("COMMIT");
        return true;
      }
      rollback(this.database);
      return false;
    } catch { rollback(this.database); return false; }
  }
  /** @param {string} administrator @param {number} limit @param {string | undefined} cursor */
  audit(administrator, limit, cursor) {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      let traversalId; let maximum; let after;
      if (cursor) {
        const saved = this.repository.traversal(cursor, administrator);
        if (!saved) { rollback(this.database); return undefined; }
        ({ maximum_sequence: maximum, next_sequence: after } = saved);
        traversalId = saved.id;
      } else {
        maximum = this.repository.maxAuditSequence(); after = 0; traversalId = this.identifier();
        this.repository.createTraversal(traversalId, administrator, maximum, this.now());
      }
      const events = this.repository.auditRange(maximum, after, limit).map(auditRepresentation);
      let nextCursor;
      if (events.length === limit) {
        nextCursor = this.repository.token(this.identifier(), traversalId, events.at(-1).sequence);
      }
      this.database.exec("COMMIT");
      return { events, nextCursor: nextCursor || null };
    } catch { rollback(this.database); return undefined; }
  }
}
