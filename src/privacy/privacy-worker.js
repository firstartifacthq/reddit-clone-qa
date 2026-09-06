// @ts-nocheck
export class PrivacyWorker {
  /** @param {{service:any, repository:any, beforePhase?: (job:any)=>void}} options */
  constructor({ service, repository, beforePhase }) { Object.assign(this, { service, repository, beforePhase, closed: false }); }
  drain() {
    if (this.closed || this.draining) return;
    this.draining = true;
    try {
      for (const job of this.repository.pendingWork()) {
        if (this.closed) break;
        if (job.operation === "export") {
          try { this.beforePhase?.(job); } catch { continue; }
          if (this.closed) break;
          this.service.completeExport(job.id);
          continue;
        }
        // A healthy delivery drains all durable phases. A fault leaves the current
        // checkpoint eligible for selection when the dependency returns.
        let phase = job;
        while (phase && !this.closed) {
          try { this.beforePhase?.(phase); } catch { break; }
          if (this.closed || !this.service.advanceDeletion(phase)) break;
          phase = this.repository.deletionWork(job.id);
        }
      }
    } catch {
      // Leave durable checkpoints pending; the lifecycle retries after capability returns.
    } finally { this.draining = false; }
  }
  close() { this.closed = true; }
}
