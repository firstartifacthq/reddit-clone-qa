// @ts-nocheck
export class PrivacyWorker {
  /** @param {{service:any, repository:any, beforePhase?: (job:any)=>void}} options */
  constructor({ service, repository, beforePhase }) { Object.assign(this, { service, repository, beforePhase, closed: false }); }
  drain() {
    if (this.closed) return;
    for (const job of this.repository.pendingWork()) {
      if (job.operation === "export") {
        try { this.beforePhase?.(job); } catch { continue; }
        this.service.completeExport(job.id);
        continue;
      }
      // A healthy delivery drains all durable phases. A fault stops only this job at its
      // current checkpoint; startup selection includes that checkpoint on the next process.
      let phase = job;
      while (phase && !this.closed) {
        try { this.beforePhase?.(phase); } catch { break; }
        if (!this.service.advanceDeletion(phase)) break;
        phase = this.repository.deletionWork(job.id);
      }
    }
  }
  close() { this.closed = true; }
}
