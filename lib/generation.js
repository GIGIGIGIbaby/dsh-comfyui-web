import { randomUUID } from 'node:crypto';
import { outputVideos, videoMime } from './media.js';

// ComfyUI broadcasts a queue status AFTER committing a prompt's history.
// Listen with our own client id so we never replace the frontend preview socket.
export class GenerationMonitor {
  constructor(runtime, { WebSocketImpl = globalThis.WebSocket } = {}) {
    this.runtime = runtime; this.WebSocketImpl = WebSocketImpl;
    this.clientId = 'dsh-comfy-monitor-' + randomUUID(); this.records = new Map();
    this.stopped = false; this.dirty = false; this.checking = false; this.reconnectDelay = 1000;
  }
  get active() { return [...this.records.values()].filter(record => !record.result); }
  status() { return { connected: this.socket?.readyState === 1, active: this.active.length, error: this.lastError || null }; }
  async connect(signal) {
    if (this.stopped) throw new Error('ComfyUI 完成通知已关闭');
    if (signal?.aborted) throw signal.reason;
    if (this.socket?.readyState === 1) return;
    if (!this.opening) {
      const url = new URL('/ws', this.runtime.url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('clientId', this.clientId);
      this.opening = new Promise((resolve, reject) => {
        const socket = this.socket = new this.WebSocketImpl(url);
        const timer = setTimeout(() => { reject(new Error('ComfyUI 实时通知连接超时，尚未提交生成任务')); socket.close(); }, 5000);
        socket.addEventListener('open', () => {
          clearTimeout(timer); this.lastError = null; this.reconnectDelay = 1000;
          resolve(); this.schedule();
        });
        socket.addEventListener('message', event => {
          if (this.stopped || this.socket !== socket || typeof event.data !== 'string') return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'status' || (message.data?.prompt_id && this.records.has(message.data.prompt_id))) this.schedule();
          } catch { /* Binary previews and unrelated messages carry no completion. */ }
        });
        socket.addEventListener('error', () => { this.lastError = 'ComfyUI 实时通知连接异常'; socket.close(); });
        socket.addEventListener('close', () => {
          clearTimeout(timer); reject(new Error('ComfyUI 实时通知连接已断开'));
          if (this.socket === socket) this.socket = null;
          if (!this.stopped && this.active.length) this.reconnect();
        });
      }).finally(() => { this.opening = null; });
    }
    await withAbort(this.opening, signal);
  }
  reconnect() {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => { this.lastError = error.message; if (this.active.length) this.reconnect(); });
    }, this.reconnectDelay);
    this.reconnectTimer.unref?.();
    this.reconnectDelay = Math.min(10000, this.reconnectDelay * 2);
  }
  track(promptId, sessionId) {
    if (typeof promptId !== 'string' || !promptId || !sessionId) throw new Error('ComfyUI 没有返回有效的 prompt_id');
    const existing = this.records.get(promptId);
    if (existing) {
      if (existing.sessionId !== sessionId) throw new Error('生成任务不属于当前对话');
      return existing;
    }
    let resolve;
    const record = { promptId, sessionId, status: 'queued', done: new Promise(r => { resolve = r; }), resolve: null };
    record.resolve = resolve; this.records.set(promptId, record);
    for (const [id, old] of this.records) if (this.records.size > 200 && old.result) this.records.delete(id);
    // Covers a cached, very fast completion that happened before /prompt replied.
    this.schedule(); return record;
  }
  owned(promptId, sessionId) {
    const record = this.records.get(promptId);
    if (!record || record.sessionId !== sessionId) throw new Error('该生成任务不属于当前对话，请使用本条对话 run 返回的 prompt_id');
    return record;
  }
  async wait(promptId, sessionId, signal, timeoutMs) {
    const record = this.owned(promptId, sessionId);
    if (record.result) return record.result;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)) throw new Error('timeoutMs 必须在 1–120000 之间');
    let timer;
    try {
      const waiting = timeoutMs === undefined ? record.done : Promise.race([record.done, new Promise(resolve => {
        timer = setTimeout(() => resolve({ prompt_id: promptId, status: record.status, finished: false, timedOut: true,
          message: '任务仍未结束；这是事件等待超时，生成没有取消，请勿重复 run。' }), timeoutMs);
      })]);
      return await withAbort(waiting, signal);
    } finally { clearTimeout(timer); }
  }
  settle(record, result) {
    if (record.result) return;
    record.result = { prompt_id: record.promptId, ...result }; record.status = result.status;
    record.resolve(record.result);
  }
  fromHistory(record, history) {
    const messages = history.status?.messages || [];
    const interrupted = messages.find(message => message[0] === 'execution_interrupted');
    const error = messages.find(message => message[0] === 'execution_error');
    const status = interrupted ? 'interrupted' : error || history.status?.status_str === 'error' ? 'failed' : 'completed';
    const images = Object.entries(history.outputs || {}).flatMap(([nodeId, output]) =>
      (Array.isArray(output?.images) ? output.images : []).filter(image => !videoMime(image)).map(image => ({ nodeId, ...image })));
    const videos = outputVideos(history.outputs);
    this.settle(record, { status, finished: true, images, ...(videos.length ? { videos } : {}),
      ...(error ? { error: { nodeId: error[1]?.node_id, nodeType: error[1]?.node_type, message: error[1]?.exception_message } } : {}) });
  }
  schedule() {
    if (this.stopped || !this.active.length) return;
    this.dirty = true;
    if (!this.checking) {
      this.checking = true;
      this.checkWork = this.reconcile().finally(() => { this.checking = false; if (this.dirty && !this.stopped) this.schedule(); });
    }
  }
  async reconcile() {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      const missing = [];
      await Promise.all(this.active.map(async record => {
        try {
          const data = await this.runtime.request('/history/' + encodeURIComponent(record.promptId));
          if (data[record.promptId]) this.fromHistory(record, data[record.promptId]);
          else missing.push(record);
        } catch (error) {
          this.lastError = error.message;
          this.settle(record, { status: 'monitor_error', finished: false, message: '无法确认生成结果：' + error.message });
        }
      }));
      if (!missing.length || this.stopped) continue;
      try {
        const queue = await this.runtime.request('/queue');
        const running = new Set((queue.queue_running || []).map(item => item[1]));
        const pending = new Set((queue.queue_pending || []).map(item => item[1]));
        await Promise.all(missing.map(async record => {
          if (record.result) return;
          if (running.has(record.promptId)) record.status = 'running';
          else if (pending.has(record.promptId)) record.status = 'queued';
          else {
            // The task can finish between reading history and reading the queue.
            const data = await this.runtime.request('/history/' + encodeURIComponent(record.promptId));
            if (data[record.promptId]) this.fromHistory(record, data[record.promptId]);
            else this.settle(record, { status: 'not_found', finished: false, message: '任务已不在队列中，且没有结果记录；可能被手动删除。不会重新提交。' });
          }
        }));
      } catch (error) {
        for (const record of missing) this.settle(record, { status: 'monitor_error', finished: false, message: '无法确认生成结果：' + error.message });
      }
    }
  }
  async stop() {
    this.stopped = true; clearTimeout(this.reconnectTimer); this.socket?.close();
    for (const record of this.active) this.settle(record, { status: 'monitor_stopped', finished: false,
      message: '插件通知已停止，ComfyUI 生成没有因此取消。请检查 history，勿重复提交。' });
    await this.checkWork;
  }
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('已取消等待'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new Error('已取消等待')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
