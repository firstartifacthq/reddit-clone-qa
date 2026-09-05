// @ts-nocheck
export class PrivacyWorker {
  /** @param {{service:any, repository:any, beforePhase?: (job:any)=>void}} options */
  constructor({ service, repository, beforePhase }) { Object.assign(this, { service, repository, beforePhase, closed: false }); }
  drain() {
    if (this.closed) return;
    for (const job of this.repository.pendingWork()) {
      try { this.beforePhase?.(job); } catch { continue; }
      if (job.operation === "export") this.service.completeExport(job.id);
      else this.service.completeDeletion(job.id);
    }
  }
  close() { this.closed = true; }
}
