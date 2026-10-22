import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { createMcpHandler } from './mcp.js';
import { WorkflowSync } from './sync.js';
import { GenerationMonitor } from './generation.js';
import { VideoMedia } from './media.js';
import { TaskStore } from './state.js';
import { NoteStore } from './notes.js';

export const BRIDGE_PROTOCOL = 6;
const liveClient = client => !!(client.stream && !client.stream.destroyed && !client.stream.writableEnded) || Date.now() - client.seen < 10000;

export function normalizeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请填写 ComfyUI 的 http/https 根地址，例如 http://127.0.0.1:8188');
  }
  return url.origin;
}
export async function readJson(req, max = 12 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('请求超过 12 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersOf(headers) { return Object.fromEntries(Object.entries(headers).filter(([k]) => !hop.has(k.toLowerCase()))); }

// Canvas-mutating page actions. The write lease is taken here — at the one point every caller
// (MCP tools, the host's upload-and-bind, tests) actually dispatches to a live page — instead of
// at the tool boundary: a call that dies on nodeId/widget/MIME validation used to lock the graph
// for its holder anyway (second-round report N2). `upload_image` is absent because uploading is
// not a canvas write; the `bind_image` it may follow is.
const WRITE_ACTIONS = new Set(['update_nodes', 'edit_graph', 'load_workflow', 'bind_image', 'save_workflow',
  'save_as_workflow', 'switch_workflow', 'new_workflow', 'undo', 'redo', 'restore_edit', 'run']);

export class ComfyRuntime {
  constructor(configFile, options = {}) {
    this.configFile = configFile; this.url = options.url || 'http://127.0.0.1:8188';
    this.preferredPort = options.port ?? 18188;
    this.token = randomUUID(); this.clients = new Map(); this.pending = new Map(); this.sockets = new Set();
    this.sync = new WorkflowSync();
    this.generations = new GenerationMonitor(this);
    this.mcpEnabled = true;
    this.taskListeners = new Set();
    this.completionNotificationStates = new Map();
    this.extensionInstallation = null;
    // One conversation at a time may write the shared canvas. Reads are always allowed.
    this.lease = { holder: null, takenAt: 0, renewedAt: 0, ttlMs: 5 * 60 * 1000 };
    // A holder with no live page cannot write again — its next call is refused by the guard below —
    // so keeping its lease is a deadlock with a five-minute fuse. Silence from a *living* page is
    // patience; silence from a dead one is abandonment, and 15s (one and a half liveness windows)
    // is enough to tell them apart (third-round report, N1 residual).
    this.deadHolderGraceMs = 15000;
    this.mcpHandler = createMcpHandler(this, readJson, json);
  }
  // A connected panel means the conversation is still around; it does NOT mean it is still
  // writing. Two different questions, and conflating them is what made the TTL decorative:
  // a page can sit open for an hour, so "holder is alive" stayed true and the lease never
  // expired. Expiry is decided by silence (ttlMs since the last write), with one exception: a
  // holder that has no live client at all cannot write again, so its lease stops being patience
  // after `deadHolderGraceMs` and becomes a lock nobody can use. Liveness is also reported
  // (`holderAlive`) so a conflict reply can say whether the holder could be told about it.
  leaseAlive() {
    const holder = this.lease.holder;
    return !!holder && [...this.clients.values()].some(client => client.sessionId === holder && liveClient(client));
  }
  leaseExpired() {
    if (!this.lease.holder) return false;
    const idle = Date.now() - this.lease.renewedAt;
    return idle > this.lease.ttlMs || (idle > this.deadHolderGraceMs && !this.leaseAlive());
  }
  leaseState() {
    if (this.leaseExpired()) { this.lease = { ...this.lease, holder: null, takenAt: 0, renewedAt: 0 }; }
    const holder = this.lease.holder;
    return { holder: holder || null, held: !!holder, holderAlive: this.leaseAlive(),
      ...(holder ? { idleMs: Date.now() - this.lease.renewedAt, heldForMs: Date.now() - this.lease.takenAt } : {}),
      // Both clocks are reported because they answer different questions: `ttlMs` is how long a
      // living page may stay idle, `abandonedAfterMs` is how long a page that is gone may keep
      // others out. A caller told only about the first waits five minutes for a lock that lifts in
      // fifteen seconds.
      ttlMs: this.lease.ttlMs, abandonedAfterMs: this.deadHolderGraceMs };
  }
  acquireLease(sessionId, force = false) {
    if (!sessionId) throw new Error('写操作需要对话身份。');
    this.leaseState();
    const holder = this.lease.holder;
    if (holder && holder !== sessionId && !force) {
      // The wait the caller is being told about depends on which clock is running: a living page
      // keeps the lease until its write silence reaches the TTL, a dead one gives it back after the
      // abandonment grace. Saying "5 minutes" when it is 15 seconds sends the model to wait it out.
      const reachable = this.leaseAlive();
      const error = new Error('写租约被另一条对话持有（' + holder + '，空闲 '
        + Math.round((Date.now() - this.lease.renewedAt) / 1000) + ' 秒），本次写入未执行。'
        + (reachable
          ? '对方页面仍在线，闲置到 ' + Math.round(this.lease.ttlMs / 1000) + ' 秒才会自动释放。'
          : '对方页面已不在线，约 ' + Math.round((this.deadHolderGraceMs - (Date.now() - this.lease.renewedAt)) / 1000) + ' 秒后自动释放。')
        + '画布是用户正在看的实时窗口，接管需要用户明确同意——请报告冲突并等用户指示（用户同意后可用 lease(op=take, force:true)）。');
      error.writeLeaseConflict = true;
      error.lease = this.leaseState();
      throw error;
    }
    // Only a conversation with a LIVE panel may hold the write lease — for a new claim or for a
    // renewal. A client entry that merely exists is not a page: `server_info` hides stale entries
    // behind its own filter while they stay in the Map, so a scripted POST to /state used to be
    // enough to claim the canvas and keep renewing it forever (second-round report N1). Renewal is
    // not exempt either, because the exemption was the permanent-occupation vector; a page that is
    // really gone cannot receive a write anyway.
    if (![...this.clients.values()].some(client => client.sessionId === sessionId && liveClient(client))) {
      throw new Error('写租约必须由连着 ComfyUI 面板的对话持有：会话 ' + sessionId
        + ' 没有活着的页面（从未连接，或页面已关闭/挂起），不能占用写权。先打开或刷新面板让页面连上再试。');
    }
    if (holder !== sessionId) { this.lease.holder = sessionId; this.lease.takenAt = Date.now(); }
    this.lease.renewedAt = Date.now();
    return this.leaseState();
  }
  releaseLease(sessionId, force = false) {
    const holder = this.lease.holder;
    if (holder && holder !== sessionId && !force) {
      const error = new Error('写租约由另一条对话持有（' + holder + '），不能替它释放。确需接管用 force:true 直接写入。');
      error.writeLeaseConflict = true;
      throw error;
    }
    this.lease = { ...this.lease, holder: null, takenAt: 0, renewedAt: 0 };
    return this.leaseState();
  }
  async start() {
    try { const config = JSON.parse(await readFile(this.configFile, 'utf8')); this.url = normalizeUrl(config.url || this.url); this.mcpEnabled = config.mcpEnabled !== false; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.bridgeCode = await readFile(new URL('../bridge.js', import.meta.url), 'utf8');
    this.bridgeVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    this.media = await new VideoMedia(this).start(joinPath(dirname(this.configFile), 'media-key'));
    this.taskStore = await new TaskStore(joinPath(dirname(this.configFile), 'tasks.json')).start();
    // Usage notes are per-install, not per-conversation: what one conversation learns about a
    // pack is exactly what the next one needs, and it must survive a DSH restart.
    this.noteStore = await new NoteStore(joinPath(dirname(this.configFile), 'usage-notes.json')).start();
    this.server = http.createServer((req, res) => this.handle(req, res).catch(e => { if (!res.headersSent) json(res, 502, { error: e.message }); else res.destroy(e); }));
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    const listen = port => new Promise((resolve, reject) => {
      const fail = e => { this.server.off('listening', ready); reject(e); };
      const ready = () => { this.server.off('error', fail); resolve(); };
      this.server.once('error', fail).once('listening', ready).listen(port, '127.0.0.1');
    });
    try { await listen(this.preferredPort); } catch(e) { if(e.code !== 'EADDRINUSE') throw e; await listen(0); }
    this.frameOrigin = `http://127.0.0.1:${this.server.address().port}`;
    await mkdir(dirname(this.configFile), { recursive: true });
    await writeFile(joinPath(dirname(this.configFile), 'connection.json'), JSON.stringify({ endpoint: this.frameOrigin + '/mcp', token: this.token }) + '\n', { mode: 0o600 });
    await this.generations.restore(this.taskStore);
    return this;
  }
  async stop() {
    await this.generations.stop();
    for (const p of this.pending.values()) p.reject(new Error('ComfyUI 插件已关闭'));
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
  async setUrl(value) {
    const next = normalizeUrl(value);
    if (new URL(next).origin === this.frameOrigin) throw new Error('不能连接插件自身的代理端口');
    await mkdir(dirname(this.configFile), { recursive: true });
    const previous = JSON.parse(await readFile(this.configFile, 'utf8').catch(() => '{}'));
    await writeFile(this.configFile, JSON.stringify({ ...previous, url: next }, null, 2) + '\n', { mode: 0o600 });
    await this.generations.stop();
    this.url = next;
    this.generations = new GenerationMonitor(this);
    await this.generations.restore(this.taskStore);
    this.sync = new WorkflowSync();
    for (const p of this.pending.values()) p.reject(new Error('ComfyUI 地址已更改，请重新打开面板'));
    this.clients.clear();
  }
  async setMcpEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('MCP 开关必须是布尔值');
    const previous = JSON.parse(await readFile(this.configFile, 'utf8').catch(() => '{}'));
    await writeFile(this.configFile, JSON.stringify({ ...previous, url: this.url, mcpEnabled: enabled }, null, 2) + '\n', { mode: 0o600 });
    this.mcpEnabled = enabled;
    if (!enabled) for (const [id, pending] of [...this.pending]) {
      if (this.clients.get(pending.clientId)?.queue.some(command => command.id === id)) pending.reject(new Error('MCP 已关闭'));
    }
  }
  status(sessionId) {
    const recent = [...this.clients.values()].filter(c => liveClient(c) || Date.now() - c.seen < 60000);
    return { url: this.url, frameOrigin: this.frameOrigin, mcpEnabled: this.mcpEnabled,
      bridgeVersion: this.bridgeVersion, bridgeProtocol: BRIDGE_PROTOCOL,
      // The bearer token is handed out by unauthenticated GETs (this status route without an Origin,
      // /__dsh_comfyui/bootstrap, and the served bridge.js embeds it), so any process running as
      // this user can read it. All three ports bind 127.0.0.1 only, and the same secret already sits
      // in ~/.dsh/comfyui/connection.json, so this is the local trust boundary rather than a remote
      // hole — but a green report should say so instead of implying the token is confidential.
      localTrustBoundary: 'token 对本机任意进程可读（/dsh-comfyui/api、/__dsh_comfyui/bootstrap、bridge.js 三处都无需鉴权）；端口只绑 127.0.0.1，远程不可达。能发本机请求的进程同样能读 ~/.dsh/comfyui/connection.json。',
      extensionInstallation: this.extensionInstallation,
      writeLease: this.leaseState(),
      generationMonitor: this.generations.status(),
      completionNotificationsAvailable: sessionId && this.completionNotificationStates.has(sessionId)
        ? this.completionNotificationStates.get(sessionId) : this.completionNotificationsAvailable === true,
      syncClients: recent.filter(c => !sessionId || c.sessionId === sessionId).map(c => ({
        // A page running a copy that was never version-injected sends an explicit null, which is a
        // different fault from an old bridge that sent no field at all ('legacy'): only the first
        // one means the injection step is missing, and 'legacy' would send the reader to refresh.
        clientId: c.id, external: c.sessionId === 'comfyui-external',
        bridgeVersion: c.bridgeVersion === null ? null : (c.bridgeVersion || 'legacy'),
        // The negotiated protocol travelled over /poll but was never reported, which left the
        // doctor's version check comparing against undefined. Report the number itself.
        bridgeProtocol: c.bridgeProtocol ?? null,
        refreshRequired: c.bridgeProtocol !== BRIDGE_PROTOCOL, ready: c.ready,
        visible: c.visible, connected: !!liveClient(c), heartbeatAgeMs: Date.now() - c.seen,
        workflowTabs: c.workflowTabs ?? null, hasActiveWorkflow: c.hasActiveWorkflow ?? null,
        synchronization: c.synchronization ?? null
      })), clients: [...this.clients.values()]
      .filter(c => c.sessionId !== 'comfyui-external' && (!sessionId || c.sessionId === sessionId) && (liveClient(c) || Date.now() - c.seen < 60000))
      .map(c => ({ clientId: c.id, sessionId: c.sessionId, ready: c.ready, allowAI: this.mcpEnabled && c.allowAI,
        connected: !!liveClient(c), heartbeatAgeMs: Date.now() - c.seen, visible: c.visible })) };
  }
  tasksChanged() { for (const listener of this.taskListeners) { try { listener(); } catch { /* Isolate a closed event stream. */ } } }
  taskResults(sessionId) {
    return [...this.generations.records.values()].filter(record => record.sessionId === sessionId).map(record => ({
      promptId: record.promptId, status: record.status, created: record.created, progress: record.progress,
      result: record.result, media: record.result?.status === 'completed' ?
        [...record.result.images || [], ...record.result.videos || []].flatMap(file => {
          try { return [this.media.describe(file, record.promptId, sessionId)]; } catch { return []; }
        }) : []
    }));
  }
  async request(path, init = {}, signal) {
    const timeout = AbortSignal.timeout(20000);
    const res = await fetch(this.url + path, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`ComfyUI ${res.status}: ${JSON.stringify(data).slice(0, 1500)}`);
    return data;
  }
  command(sessionId, action, args = {}, signal, clientId) {
    if (!this.mcpEnabled) throw new Error('MCP 已关闭，请在面板的“MCP 设置”中开启。');
    const own = [...this.clients.values()].filter(c => c.sessionId === sessionId);
    const candidates = own.filter(c => c.ready && c.allowAI && liveClient(c));
    const client = clientId ? candidates.find(c => c.id === clientId) : candidates.filter(c => c.visible).at(-1) || (candidates.length === 1 ? candidates[0] : undefined);
    if (!client) {
      if (!own.length) throw new Error('本条对话尚未收到 ComfyUI 桥接扩展连接。请确认面板已打开，并检查扩展安装（MCP 设置中的安装说明）。'
        + (this.extensionInstallation?.message ? ' ' + this.extensionInstallation.message : '')
        + ' 不要改用脚本绕过面板提交生成。');
      if (!own.some(liveClient)) throw new Error('本条对话的 ComfyUI 连接已断开，等待自动重连或刷新面板；这不表示 MCP 开关关闭。请勿绕过面板写入或重复提交。');
      if (own.every(c => !c.allowAI)) throw new Error('本条对话面板尚未允许 AI 操作，请查看 MCP 设置。');
      if (own.every(c => !c.ready)) throw new Error('ComfyUI 工作流正在加载或同步代码需要刷新，请稍后重试读取状态。');
      throw new Error('面板身份未匹配或有多个面板，请从 server_info 选择本条对话的有效 clientId。');
    }
    // The lease is taken at the dispatch, against the client the write will actually use: the page
    // is live and has allowed AI, so the guard inside acquireLease is not a second guess. A call
    // that failed validation before ever getting here no longer reserves the graph (N2), and a
    // conversation whose panel closed cannot keep the lease alive by renewing it (N1).
    const heldBefore = this.lease.holder;
    if (WRITE_ACTIONS.has(action) && typeof this.acquireLease === 'function') this.acquireLease(sessionId);
    // A page-side failure must not leave the canvas reserved by a call that wrote nothing: this is
    // the same lock, only taken further down the stack (third-round N10 — `switch_workflow` with a
    // path that does not exist refused and still held the lease for the full TTL). Only a lease this
    // call actually established is given back, so an established holder keeps its grip across a
    // failed write and can retry without a takeover.
    const established = WRITE_ACTIONS.has(action) && heldBefore !== sessionId;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const dispatched = this.dispatch(client, action, args, signal);
    if (!established) return dispatched;
    return dispatched.catch(error => {
      if (this.lease.holder === sessionId) { try { this.releaseLease(sessionId); } catch {} }
      throw error;
    });
  }
  // Split out from `command()` so a test can fake the page at the transport seam while the
  // identity guards and the write lease above it stay in play — faking `command()` itself meant
  // the lease rules were only ever exercised by the HTTP-layer tests.
  dispatch(client, action, args = {}, signal) {
    return new Promise((resolve, reject) => {
      const id = randomUUID(); let timer;
      const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); client.queue = client.queue.filter(c => c.id !== id); fn(value); };
      const abort = () => finish(reject, signal.reason || new Error('已取消。若指令已送达，请检查面板后再操作。'));
      this.pending.set(id, { clientId: client.id, resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      timer = setTimeout(() => finish(reject, new Error('面板响应超时。请查看当前图和队列，避免重复提交。')), 25000);
      signal?.addEventListener('abort', abort, { once: true });
      client.queue.push({ id, action, args, expiresAt: Date.now() + 25000 }); this.deliverCommands(client);
    });
  }
  deliverCommands(client) {
    if (!this.mcpEnabled || !client.ready || !client.allowAI || !client.stream || client.stream.destroyed) return;
    const commands = client.queue.splice(0);
    if (commands.length) client.stream.write('data: ' + JSON.stringify({ commands }) + '\n\n');
  }
  async handle(req, res) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { json(res, 400, { error: 'Invalid request path' }); return; }
    const path = new URL(req.url, this.frameOrigin).pathname;
    const originalOrigin = new URL(this.url).origin;
    const bridgePath = path.startsWith('/__dsh_comfyui/');
    if (bridgePath && req.headers.origin === originalOrigin) {
      res.setHeader('Access-Control-Allow-Origin', originalOrigin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Dsh-Comfy-Token' }); res.end(); return;
      }
    }
    if (req.headers.origin && req.headers.origin !== this.frameOrigin && !(bridgePath && req.headers.origin === originalOrigin)) { json(res, 403, { error: 'Origin mismatch' }); return; }
    if (path === '/mcp') { await this.mcpHandler(req, res); return; }
    if (path === '/__dsh_comfyui/bootstrap' && req.method === 'GET') {
      json(res, 200, { bridgeBase: this.frameOrigin, token: this.token, originalOrigin,
        bridgeVersion: this.bridgeVersion, bridgeProtocol: BRIDGE_PROTOCOL }); return;
    }
    if (path === '/__dsh_comfyui/bridge.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      // The token sits bare in the source, so it needs JSON.stringify; the version sits inside
      // quotes already, so it is injected raw — quoting it too would hand the page a version
      // string wrapped in literal quote characters and keep doctor's version check red forever.
      res.end(this.bridgeCode.replace('__DSH_BRIDGE_TOKEN__', JSON.stringify(this.token))
        .replace('__DSH_BRIDGE_VERSION__', () => this.bridgeVersion)); return;
    }
    if (path === '/__dsh_comfyui/commands' && req.method === 'GET') {
      const query = new URL(req.url, this.frameOrigin).searchParams;
      const id = query.get('clientId'), sessionId = query.get('sessionId');
      if (query.get('token') !== this.token || !id || !sessionId || Number(query.get('bridgeProtocol')) !== BRIDGE_PROTOCOL) { json(res, 403, { error: 'Command stream authentication failed' }); return; }
      let client = this.clients.get(id);
      if (client && client.sessionId !== sessionId) { json(res, 403, { error: 'Session mismatch' }); return; }
      if (!client) { client = { id, sessionId, queue: [], seen: Date.now(), ready: false, allowAI: false }; this.clients.set(id, client); }
      client.stream?.end(); client.stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n'); this.deliverCommands(client);
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      res.on('close', () => { clearInterval(heartbeat); if (client.stream === res) client.stream = null; });
      return;
    }
    if (path === '/__dsh_comfyui/poll' || path === '/__dsh_comfyui/result' || path === '/__dsh_comfyui/sync' || path === '/__dsh_comfyui/state') {
      if (req.method !== 'POST' || req.headers['x-dsh-comfy-token'] !== this.token) { json(res, 403, { error: 'Bridge authentication failed' }); return; }
      const data = await readJson(req);
      if (typeof data.clientId !== 'string' || typeof data.sessionId !== 'string') throw new Error('Invalid client identity');
      if (path.endsWith('/sync') || path.endsWith('/poll') || path.endsWith('/state')) {
        let client = this.clients.get(data.clientId);
        if (client && client.sessionId !== data.sessionId) throw new Error('Session mismatch');
        if (!client) { client = { id: data.clientId, sessionId: data.sessionId, queue: [] }; this.clients.set(client.id, client); }
        Object.assign(client, { ready: data.ready === true && data.bridgeProtocol === BRIDGE_PROTOCOL,
          allowAI: data.allowAI === true, visible: data.visible === true, seen: Date.now(),
          bridgeProtocol: data.bridgeProtocol, bridgeVersion: data.bridgeVersion,
          workflowTabs: Number.isInteger(data.workflowTabs) ? data.workflowTabs : null,
          hasActiveWorkflow: typeof data.hasActiveWorkflow === 'boolean' ? data.hasActiveWorkflow : null,
          synchronization: Object.fromEntries(['loaded', 'published', 'deferred', 'conflicts'].map(key =>
            [key, Number.isSafeInteger(data.synchronization?.[key]) && data.synchronization[key] >= 0 ? data.synchronization[key] : 0])) });
        // Expired clients cannot capture a later session's graph. Commands are delivered once.
        for (const [id, c] of this.clients) if (!liveClient(c) && Date.now() - c.seen > 60000) this.clients.delete(id);
        // Old pages keep their original JS after a plugin upgrade. Never send them
        // another graph: their loader may create a new ComfyUI workflow tab.
        if (data.bridgeProtocol !== BRIDGE_PROTOCOL) {
          json(res, path.endsWith('/sync') ? 409 : 200, {
            commands: [], refreshRequired: true, bridgeProtocol: BRIDGE_PROTOCOL,
            error: 'ComfyUI 同步代码已更新，请刷新此 ComfyUI 页面后继续。'
          }); return;
        }
        if (path.endsWith('/sync')) { json(res, 200, this.sync.exchange(data)); return; }
        this.deliverCommands(client);
        const commands = client.allowAI && client.ready ? client.queue.splice(0) : [];
        json(res, 200, { commands }); return;
      }
      const pending = this.pending.get(data.id);
      if (pending?.clientId === data.clientId) {
        if (data.error) {
          // Page-side failures carry a stack, the failing stage and a next-step hint;
          // dropping them here is what made "Cannot destructure property 'e'" a dead end.
          const failure = new Error(String(data.error));
          for (const key of ['stack', 'action', 'nodeId', 'widget', 'widgetKind', 'stage', 'hint']) {
            if (data[key] !== undefined && data[key] !== null && data[key] !== '') failure[key] = data[key];
          }
          failure.pageSide = true;
          pending.reject(failure);
        } else pending.resolve(data.result);
      }
      json(res, 200, { ok: true }); return;
    }
    if (path.startsWith('/__dsh_comfyui/')) { json(res, 404, { error: 'Not found' }); return; }
    const target = new URL(req.url, this.url); const transport = target.protocol === 'https:' ? https : http;
    const headers = headersOf(req.headers); headers.host = target.host;
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer?.startsWith(this.frameOrigin)) headers.referer = headers.referer.replace(this.frameOrigin, target.origin);
    const inject = path === '/' && req.method === 'GET';
    if (inject) { headers['accept-encoding'] = 'identity'; delete headers['if-none-match']; delete headers['if-modified-since']; }
    const upstream = transport.request(target, { method: req.method, headers }, response => {
      const outHeaders = headersOf(response.headers);
      if (inject && response.statusCode === 200 && String(outHeaders['content-type']).includes('text/html')) {
        const parts = []; response.on('data', chunk => parts.push(chunk));
        response.on('end', () => {
          try {
            let buffer = Buffer.concat(parts); const encoding = outHeaders['content-encoding'];
            if (encoding === 'gzip') buffer = gunzipSync(buffer); else if (encoding === 'deflate') buffer = inflateSync(buffer); else if (encoding === 'br') buffer = brotliDecompressSync(buffer);
            const html = buffer.toString().replace(/<\/body>/i, '<script defer src="/__dsh_comfyui/bridge.js"></script></body>');
            delete outHeaders['content-length']; delete outHeaders['content-encoding']; delete outHeaders.etag;
            outHeaders['cache-control'] = 'no-store';
            res.writeHead(200, outHeaders); res.end(html);
          } catch(e) { res.destroy(e); }
        }); response.on('error', e => res.destroy(e));
      } else { res.writeHead(response.statusCode, outHeaders); response.pipe(res); }
    });
    upstream.setTimeout(60000, () => upstream.destroy(new Error('ComfyUI 连接超时')));
    upstream.on('error', e => { if (!res.headersSent) json(res, 502, { error: '连接不到 ComfyUI：' + e.message }); else res.destroy(e); });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  }
  upgrade(req, socket, head) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { socket.destroy(); return; }
    if (req.headers.origin && req.headers.origin !== this.frameOrigin) { socket.destroy(); return; }
    const target = new URL(req.url, this.url); const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host, origin: target.origin };
    const upstream = transport.request(target, { headers });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      this.sockets.add(peer); peer.on('close', () => this.sockets.delete(peer));
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (upstreamHead.length) socket.write(upstreamHead); if (head.length) peer.write(head);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      peer.on('close', () => socket.destroy()); socket.on('close', () => peer.destroy());
      peer.pipe(socket); socket.pipe(peer);
    });
    upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy());
    upstream.setTimeout(15000, () => upstream.destroy()); upstream.end();
  }
}
