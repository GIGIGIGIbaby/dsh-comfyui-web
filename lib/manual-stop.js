export const stoppedGeneration = status => ['interrupted', 'cancelled', 'not_found'].includes(status);

export function stopPolicy(status) {
  if (!stoppedGeneration(status)) return {};
  const message = status === 'interrupted' ? '生成已被主动中断，不是节点故障。'
    : status === 'cancelled' ? '任务已从等待队列取消。'
      : '任务已离开队列且没有历史记录，可能被手动删除；原因尚未确认。';
  return { retryAllowed: false, requiresUserInstruction: true,
    message: message + '停止本轮生成计划；不要修复、重试、重新提交或继续下一段。等待用户明确要求继续生成。' };
}

function latestHumanId(session) {
  if (typeof session?.deriveMessages !== 'function') return undefined;
  return session.deriveMessages().findLast(message => message.role === 'user' && message.source?.kind === 'user')?.id ?? null;
}

// Completion notices are user-role messages too. Only a real human message
// may release this fence; job notices, tool output and model turns cannot.
export class ManualStopGuard {
  constructor(runtime, getSession) { this.runtime = runtime; this.getSession = getSession; }
  capture(session) {
    const id = latestHumanId(session);
    if (id === undefined) return false;
    let changed = false;
    for (const record of this.runtime.generations.records.values()) {
      if (record.sessionId !== session.id || !stoppedGeneration(record.result?.status) || record.stopMessageId !== undefined) continue;
      record.stopMessageId = id; changed = true;
    }
    return changed;
  }
  captureAll() {
    for (const sessionId of new Set([...this.runtime.generations.records.values()].filter(record =>
      stoppedGeneration(record.result?.status) && record.stopMessageId === undefined).map(record => record.sessionId))) {
      this.capture(this.getSession(sessionId));
    }
  }
  check(sessionId) {
    const session = this.getSession(sessionId), id = latestHumanId(session);
    if (id === undefined) return; // Standalone MCP has no trustworthy human-message provenance.
    let changed = this.capture(session), blocked;
    for (const record of this.runtime.generations.records.values()) {
      if (record.sessionId !== sessionId || !stoppedGeneration(record.result?.status) || record.stopReleased) continue;
      if (id && id !== record.stopMessageId) { record.stopReleased = true; changed = true; }
      else blocked = record;
    }
    if (changed) this.runtime.generations.changed();
    if (blocked) throw new Error('ComfyUI 任务 ' + blocked.promptId + ' 已中断或取消，本次 run 未提交。不要自动重试或绕过插件提交；等待用户发出新的生成指令。');
  }
}
