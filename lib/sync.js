export class WorkflowSync {
  constructor() { this.channels = new Map(); }
  exchange({ clientId, workflowKey = 'default', revision = 0, workflow, fingerprint, seedOnly = false }) {
    if (typeof workflowKey !== 'string' || !workflowKey || workflowKey.length > 2048) throw new Error('Invalid workflow identity');
    let channel = this.channels.get(workflowKey);
    if (!channel) {
      channel = { revision: 0, workflow: null, author: null };
      this.channels.set(workflowKey, channel);
      if (this.channels.size > 200) this.channels.delete(this.channels.keys().next().value);
    }
    if (workflow) {
      if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.links)) throw new Error('Invalid shared workflow');
      // Joining/reconnecting is a pull, not an edit. An unchanged saved tab may
      // seed an empty channel, but cannot replace an already shared workflow.
      if (seedOnly && channel.workflow) return {
        revision: channel.revision, workflow: channel.workflow, fingerprint: channel.fingerprint
      };
      if (channel.workflow && revision !== channel.revision && fingerprint !== channel.fingerprint) {
        return { revision: channel.revision, workflow: channel.workflow, fingerprint: channel.fingerprint, conflict: true };
      }
      if (fingerprint !== channel.fingerprint) {
        channel.workflow = workflow; channel.fingerprint = fingerprint; channel.author = clientId; channel.revision++;
      }
    }
    return { revision: channel.revision, ...(revision !== channel.revision && channel.author !== clientId ? { workflow: channel.workflow, fingerprint: channel.fingerprint } : {}) };
  }
}
