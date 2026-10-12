import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../lib/state.js';
import { GenerationMonitor } from '../lib/generation.js';
import { referenceImages, uploadImage } from '../lib/reference.js';
import { callComfyTool } from '../lib/mcp.js';
import { resumeCompletionJob } from '../lib/completion-job.js';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
class Socket extends EventTarget {
  constructor() { super(); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  emit() { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'status' }) })); }
}

test('unfinished tasks survive restart, completed tasks restore once, and transient HTTP errors remain retryable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-comfy-recovery-')), file = join(directory, 'tasks.json');
  const history = {}; let failed = false;
  const runtime = { url: 'http://localhost:8188', async request(path) {
    if (failed) throw new Error('offline');
    return path === '/queue' ? { queue_running: [[0, 'p']], queue_pending: [] } : history;
  } };
  const first = new GenerationMonitor(runtime, { WebSocketImpl: Socket });
  await first.restore(await new TaskStore(file).start()); await first.connect(); first.track('p', 'own');
  await flush(); await first.flush(); await first.stop();
  const second = new GenerationMonitor(runtime, { WebSocketImpl: Socket }); t.after(() => second.stop());
  await second.restore(await new TaskStore(file).start()); await flush();
  assert.equal(second.owned('p', 'own').result, undefined); assert.equal(second.owned('p', 'own').status, 'running');
  failed = true; second.socket.emit(); await flush();
  assert.equal(second.owned('p', 'own').result, undefined, 'a temporary outage must not permanently fail the task');
  failed = false; history.p = { status: { status_str: 'success' }, outputs: { 8: { images: [{ filename: 'image.png' }] } } };
  second.socket.emit(); assert.equal((await second.wait('p', 'own')).status, 'completed');
  let hooks, starts = 0;
  const jobs = { start(spec) { starts++; hooks = spec.run({ append() {} }); } };
  resumeCompletionJob(jobs, second.owned('p', 'own'), second); await hooks.done; await second.flush();
  const third = new GenerationMonitor(runtime, { WebSocketImpl: Socket }); t.after(() => third.stop());
  await third.restore(await new TaskStore(file).start());
  assert.equal(third.owned('p', 'own').notificationDelivered, true); assert.equal(third.active.length, 0); assert.equal(starts, 1);
  await assert.rejects(third.wait('p', 'other'), /当前对话/);
});

test('reference upload selects only user images from the owning session and binds the returned filename', async t => {
  const references = referenceImages({ deriveMessages: () => [
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'old', mediaType: 'image/png' } }] },
    { role: 'tool', content: [{ type: 'image', attachment: { attachmentId: 'not-reference' } }] },
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'new', mediaType: 'image/png' } }] }
  ] });
  assert.deepEqual(references.map(image => image.attachmentId), ['new', 'old']);
  let body;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks).toString();
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: 'reference.png', subfolder: 'refs', type: 'input' }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => upstream.close(r)));
  const commands = [];
  const runtime = { url: 'http://127.0.0.1:' + upstream.address().port, command: async (...args) => { commands.push(args); return { nodes: [{ id: '1', widgets: [{ name: 'image' }] }] }; } };
  const result = await uploadImage(runtime, { bytes: Buffer.from('fixture'), mediaType: 'image/png', sessionId: 'own', nodeId: '1' });
  assert.match(body, /name="image"; filename="dsh-/); assert.match(body, /name="overwrite"[\s\S]*false/);
  assert.equal(result.widgetValue, 'refs/reference.png'); assert.equal(commands[0][1], 'list_nodes');
  assert.equal(commands[1][0], 'own'); assert.equal(commands[1][1], 'bind_image'); assert.equal(commands[1][2].value, result.widgetValue);
  await assert.rejects(uploadImage(runtime, { bytes: Buffer.from('x'), mediaType: 'text/plain' }), /只支持/);
});

test('cancel deletes only an owned pending task and never interrupts a running task or loses a completed result', async () => {
  const deleted = []; let running = false, finished = false, pending = false;
  const record = { promptId: 'p', sessionId: 'own', status: 'queued' };
  const runtime = { mcpEnabled: true, generations: {
    owned(id, owner) { if (owner !== 'own') throw Error('foreign'); return record; },
    settle(_record, result) { record.result = result; record.status = result.status; }, flush: async () => {},
    fromHistory() { record.status = 'completed'; }
  }, async request(path, options) {
    if (options?.method === 'POST') { assert.equal(path, '/queue'); deleted.push(JSON.parse(options.body).delete); pending = false; return {}; }
    if (path === '/queue') return { queue_running: running ? [[0, 'p']] : [], queue_pending: pending ? [[0, 'p']] : [] };
    return finished ? { p: {} } : {};
  } };
  await assert.rejects(callComfyTool(runtime, 'cancel_task', { promptId: 'p', sessionId: 'other' }), /foreign/);
  running = true; const started = await callComfyTool(runtime, 'cancel_task', { promptId: 'p', sessionId: 'own' });
  assert.equal(started.structuredContent.cancelled, false); assert.equal(deleted.length, 0);
  running = false; finished = true;
  assert.equal((await callComfyTool(runtime, 'cancel_task', { promptId: 'p', sessionId: 'own' })).structuredContent.status, 'completed');
  finished = false; pending = true;
  assert.equal((await callComfyTool(runtime, 'cancel_task', { promptId: 'p', sessionId: 'own' })).structuredContent.cancelled, true);
  assert.deepEqual(deleted, [['p']]);
});

test('precise graph edits roll back failures, snapshots survive browser reload, and save-as preserves the source', async () => {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test"');
  const storage = new Map(); let nextId = 1, checkpoints = 0;
  const graph = { _nodes: [], links: [], setDirtyCanvas() {},
    getNodeById(id) { return this._nodes.find(node => String(node.id) === String(id)); },
    add(node) { node.id = nextId++; node.graph = this; this._nodes.push(node); },
    remove(node) { this._nodes = this._nodes.filter(item => item !== node); node.graph = null; },
    serialize() { return { nodes: this._nodes.map(node => ({ id: node.id, type: node.type, pos: node.pos, widgets_values: node.widgets.map(widget => widget.value) })), links: [...this.links] }; }
  };
  function create(type) {
    if (!['Source', 'Target'].includes(type)) return null;
    return { type, pos: [0, 0], widgets: [{ name: 'image', type: 'combo', value: 'old.png', options: { values: ['old.png'] } }],
      inputs: [{ name: 'input', type: 'IMAGE', link: null }], outputs: [{ name: 'output', type: 'IMAGE' }],
      connect(from, to, slot) { const link = { id: graph.links.length + 1, from: this.id, to: to.id }; graph.links.push(link); to.inputs[slot].link = link.id; return link; },
      disconnectInput(slot) { const id = this.inputs[slot].link; graph.links = graph.links.filter(link => link.id !== id); this.inputs[slot].link = null; } };
  }
  graph.add(create('Source'));
  const original = { path: 'workflows/Main.json', filename: 'Main', directory: 'workflows', isLoaded: true, isPersisted: true,
    changeTracker: { prepareForSave() { original.activeState = graph.serialize(); } } };
  const all = [original], saved = [];
  const store = { activeWorkflow: original, openWorkflows: all, getWorkflowByPath: path => all.find(w => w.path === path), createNewTemporary() {},
    async syncWorkflows() {}, async saveWorkflow(workflow) { saved.push({ path: workflow.path, graph: structuredClone(workflow.activeState) }); workflow.isPersisted = true; },
    saveAs(source, path) { const target = { ...source, path, activeState: structuredClone(source.activeState), changeTracker: { prepareForSave() { target.activeState = graph.serialize(); } } }; all.push(target); return target; } };
  const app = { extensionManager: { workflow: store }, canvas: {}, graph,
    async loadGraphData(data, _clean, _view, workflow) {
      const nodes = data.nodes.map(saved => { const node = create(saved.type); node.id = saved.id; node.pos = saved.pos; node.widgets[0].value = saved.widgets_values[0]; node.graph = graph; return node; });
      graph._nodes = nodes; graph.links = [...data.links]; store.activeWorkflow = workflow; return true;
    } };
  async function browser() {
    const timers = [], replies = [], commands = [], parent = { postMessage() {} };
    vm.runInNewContext(code, { window: { parent, LiteGraph: { createNode: create }, comfyAPI: { app: { app } }, addEventListener() {} },
      crypto: { randomUUID: () => 'checkpoint-' + checkpoints++ }, URL, URLSearchParams,
      location: { origin: 'http://localhost:8188', search: '?dsh_client=p&dsh_session=own' }, document: { referrer: 'http://localhost:3080/' },
      localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      setTimeout: fn => timers.push(fn), fetch: async (path, options) => {
        const data = JSON.parse(options.body); if (path.endsWith('/result')) replies.push(data);
        return { ok: true, json: async () => path.endsWith('/poll') ? { commands: commands.splice(0) } : { revision: 0 } };
      } }); await flush();
    return async (action, args = {}) => { commands.push({ id: 'call-' + replies.length, action, args }); timers.shift()(); await flush(); return replies.at(-1); };
  }
  let command = await browser();
  const edited = await command('edit_graph', { operations: [ { op: 'create_node', nodeType: 'Target', ref: 'new', position: [200, 100] },
    { op: 'connect', fromNodeId: '1', fromSlot: 0, toNodeId: 'new', toSlot: 0 } ] });
  assert.equal(edited.result.changed.length, 2); assert.equal(graph._nodes.length, 2); assert.equal(graph.links.length, 1);
  command = await browser();
  assert.equal((await command('list_edits')).result.checkpoints.length, 1);
  await command('undo'); assert.equal(graph._nodes.length, 1); assert.equal(graph.links.length, 0);
  command = await browser(); await command('redo'); assert.equal(graph._nodes.length, 2); assert.equal(graph.links.length, 1);
  const before = graph.serialize();
  assert.match((await command('edit_graph', { operations: [{ op: 'delete_node', nodeId: '1' }, { op: 'connect', fromNodeId: 'missing', fromSlot: 0, toNodeId: '2', toSlot: 0 }] })).error, /不存在/);
  assert.deepEqual(graph.serialize(), before);
  graph._nodes[0].pos = [500, 500];
  assert.match((await command('undo')).error, /手动/);
  const backup = (await command('list_edits')).result.checkpoints[0].checkpointId;
  assert.equal((await command('restore_edit', { checkpointId: backup })).result.restored, true);
  await command('save_workflow'); assert.equal(saved[0].path, original.path);
  const source = structuredClone(original.activeState);
  assert.equal((await command('save_as_workflow', { name: 'Video test' })).result.saved, true);
  assert.equal(saved.at(-1).path, 'workflows/Video test.json'); assert.deepEqual(structuredClone(original.activeState), source);
  assert.match((await command('save_as_workflow', { name: 'Main' })).error, /已存在/);
});
