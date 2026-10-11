export class WorkflowSync {
  constructor() { this.revision = 0; this.workflow = null; this.author = null; }
  exchange({ clientId, revision = 0, workflow, fingerprint }) {
    if (workflow) {
      if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.links)) throw new Error('Invalid shared workflow');
      if (this.workflow && revision !== this.revision && fingerprint !== this.fingerprint) {
        return { revision: this.revision, workflow: this.workflow, fingerprint: this.fingerprint, conflict: true };
      }
      if (fingerprint !== this.fingerprint) {
        this.workflow = workflow; this.fingerprint = fingerprint; this.author = clientId; this.revision++;
      }
    }
    return { revision: this.revision, ...(revision !== this.revision && this.author !== clientId ? { workflow: this.workflow, fingerprint: this.fingerprint } : {}) };
  }
}
