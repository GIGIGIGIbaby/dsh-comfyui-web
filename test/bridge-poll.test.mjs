import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { WorkflowSync } from '../lib/sync.js';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// Drives bridge.js the way the browser does and records every bridge POST, so cadence,
// the pull heartbeat and the serialize gate are observable instead of assumed.
async function bootBridge({ stream, counter = true, isModified = false, nodes = 3, sync, clientId = 'panel', workflowPath = 'workflows/H3.json' } = {}) {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test"');
  const calls = [], timers = [], sources = [], commands = [];
  let now = 0, syncGate, replyWorkflow;
  const workflow = { path: workflowPath, filename: 'H3', isLoaded: true, isPersisted: true, isModified };
  const graph = {
    _nodes: Array.from({ length: nodes }, (_, index) => ({ id: index + 1, type: 'KSampler', title: '', mode: 0,
      widgets: [{ name: 'seed', type: 'number', value: 1, options: {} }], inputs: [], outputs: [] })),
    serialize: () => ({ nodes: graph._nodes.map(node => ({ id: node.id, type: node.type, widgets_values: [node.widgets[0].value] })), links: [], groups: [] }),
    setDirtyCanvas() {}, getNodeById(id) { return graph._nodes.find(node => String(node.id) === String(id)); }
  };
  // Current front-ends expose the change counter as graph._version (changeTracker-backed).
  if (counter) graph._version = 7;
  const app = { rootGraph: graph, graph, canvas: {}, configuringGraph: false,
    extensionManager: { workflow: { activeWorkflow: workflow, openWorkflows: [workflow] } },
    async loadGraphData(data) {
      graph._nodes[0].widgets[0].value = data.nodes[0].widgets_values[0];
      if (counter) graph._version++;
      return true;
    },
    async graphToPrompt() { return { output: {} }; } };
  vm.runInContext(code, vm.createContext({
    window: { parent: { postMessage() {} }, comfyAPI: { app: { app } }, addEventListener() {}, LiteGraph: { createNode: () => null } },
    crypto: { randomUUID: () => 'uuid-' + Math.random() }, URL, URLSearchParams, console,
    location: { origin: 'http://comfy.test', search: '?dsh_client=' + clientId + '&dsh_session=own', href: 'http://comfy.test/' },
    document: { referrer: 'http://dsh.test/', visibilityState: 'visible', addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms: Number(ms) }); return timers.length - 1; },
    clearTimeout() {},
    Date: class extends Date { static now() { return now; } },
    EventSource: stream ? Object.assign(class {
      constructor(url) { this.url = url; this.readyState = 1; sources.push(this); queueMicrotask(() => this.onopen?.()); }
      close() { this.readyState = 2; }
    }, { OPEN: 1 }) : undefined,
    fetch: async (url, options) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      const body = options?.body ? JSON.parse(options.body) : {};
      calls.push({ path, body });
      if (path.includes('/bootstrap')) return { ok: true, status: 200, json: async () => ({ token: 'test', bridgeProtocol: 5 }) };
      if (path.includes('/sync')) {
        const result = sync ? sync.exchange(body) : { revision: 1, ...(replyWorkflow ? { workflow: replyWorkflow } : {}) };
        replyWorkflow = null;
        if (syncGate) { const gate = syncGate; syncGate = null; await gate; }
        return { ok: true, status: 200, json: async () => result };
      }
      if (path.includes('/poll')) return { ok: true, status: 200, json: async () => ({ commands: commands.splice(0) }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }));
  await flush();
  const posts = path => calls.filter(call => call.path.includes(path)).length;
  const pushed = () => calls.filter(call => call.path.includes('/sync') && call.body.workflow).length;
  // The delay a poll run schedules for itself is the cadence decision we assert on.
  const tick = async () => { const timer = timers.shift(); now += timer?.ms || 0; await timer?.fn(); await flush(); return timers.at(-1)?.ms; };
  return { tick, posts, pushed, calls, timers, commands, sources, deliver: command => commands.push(command),
    edit: value => { if (value !== undefined) graph._nodes[0].widgets[0].value = value; if (counter) graph._version++; workflow.isModified = true; },
    holdSync() { let release; syncGate = new Promise(resolve => { release = resolve; }); return release; },
    remoteReply(data) { replyWorkflow = data; },
    pullReply: workflow, graph, app };
}

test('an open command stream throttles backup commands but keeps cross-tab sync responsive', async () => {
  const bridge = await bootBridge({ stream: true });
  assert.equal(bridge.posts('/sync'), 1, 'the first tick must still sync so the panel is usable');
  assert.equal(bridge.pushed(), 1, 'the first sync carries the graph');
  assert.equal(bridge.posts('/poll'), 1);
  const delays = [];
  for (let i = 0; i < 5; i++) delays.push(await bridge.tick());
  assert.deepEqual(delays, [400, 400, 400, 400, 400], 'canvas sync retains its fast cadence');
  assert.equal(bridge.posts('/poll'), 1, 'the backup command poll is not needed every sync tick');
  // The pull heartbeat must survive the optimization: an empty-body /sync still runs,
  // so another tab's edit reaches this page within the idle interval.
  assert.equal(bridge.posts('/sync'), 6);
  // Boot sync + one reconcile when the stream opened, then nothing is re-serialized.
  assert.equal(bridge.pushed(), 2);
  for (let i = 0; i < 5; i++) await bridge.tick();
  assert.equal(bridge.posts('/poll'), 2, 'backup polling still runs periodically while SSE is open');
});

test('serialization resumes only when the graph counter actually moves', async () => {
  const bridge = await bootBridge({ stream: true });
  await bridge.tick();
  assert.equal(bridge.pushed(), 2, 'the stream opening reconciles once');
  await bridge.tick(); await bridge.tick();
  assert.equal(bridge.pushed(), 2, 'an unchanged counter must not re-serialize');
  assert.equal(bridge.posts('/sync'), 4, 'the empty-body pull continues regardless');
  bridge.edit();
  await bridge.tick();
  assert.equal(bridge.pushed(), 3, 'a bumped graph._version must publish once');
  await bridge.tick();
  assert.equal(bridge.pushed(), 3, 'and the same version must not publish twice');
});

test('front-ends without a counter fall back to their change tracker flag', async () => {
  const bridge = await bootBridge({ stream: true, counter: false });
  await bridge.tick();
  assert.equal(bridge.pushed(), 2, 'stream-open reconcile');
  await bridge.tick();
  assert.equal(bridge.pushed(), 2, 'isModified=false means nothing to push');
  bridge.edit();
  await bridge.tick();
  assert.equal(bridge.pushed(), 3, 'isModified=true must publish again');
});

test('without the command stream the bridge keeps the original fast fallback and drains commands', async () => {
  const bridge = await bootBridge({ stream: false, counter: false, isModified: true });
  const delays = [];
  for (let i = 0; i < 3; i++) delays.push(await bridge.tick());
  assert.deepEqual(delays, [400, 400, 400], 'no SSE => 400 ms polling stays exactly as before');
  assert.equal(bridge.pushed(), 4, 'an unknown change signal keeps publishing every tick, as before');
  bridge.deliver({ id: 'c-1', action: 'list_nodes', args: {} });
  await bridge.tick();
  const replied = bridge.calls.filter(call => call.path.includes('/result')).at(-1);
  assert.equal(replied.body.id, 'c-1');
  assert.equal(replied.body.result.nodes.length, 3, 'commands still execute over the fallback path');
});

test('a dropped command stream falls back to the fast cadence again', async () => {
  const bridge = await bootBridge({ stream: true, counter: false, isModified: true });
  assert.equal(await bridge.tick(), 400);
  const before = bridge.posts('/poll');
  bridge.sources[0].readyState = 2; // EventSource reports CONNECTING after an error
  assert.equal(await bridge.tick(), 400);
  assert.equal(await bridge.tick(), 400);
  assert.equal(bridge.posts('/poll'), before + 2, 'disconnected SSE restores a command poll every tick');
});

test('edits made while a sync request is pending are published on the next tick', async () => {
  const bridge = await bootBridge({ stream: true });
  await bridge.tick(); bridge.edit(2);
  const release = bridge.holdSync();
  const pending = bridge.tick(); await flush();
  bridge.edit(99); release(); await pending;
  await bridge.tick();
  const latest = bridge.calls.filter(call => call.path.includes('/sync') && call.body.workflow).at(-1);
  assert.equal(latest.body.workflow.nodes[0].widgets_values[0], 99);
});

test('a remote reply does not overwrite a manual edit made during its request', async () => {
  const bridge = await bootBridge({ stream: true });
  await bridge.tick();
  bridge.remoteReply({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [7] }], links: [] });
  const release = bridge.holdSync();
  const pending = bridge.tick(); await flush();
  bridge.edit(99); release(); await pending;
  assert.equal(bridge.graph._nodes[0].widgets[0].value, 99);
  await bridge.tick();
  const latest = bridge.calls.filter(call => call.path.includes('/sync') && call.body.workflow).at(-1);
  assert.equal(latest.body.workflow.nodes[0].widgets_values[0], 99);
});

test('two SSE-connected pages exchange a manual edit in one 400ms sync tick', async () => {
  const sync = new WorkflowSync();
  const a = await bootBridge({ stream: true, sync, clientId: 'a' });
  const b = await bootBridge({ stream: true, sync, clientId: 'b' });
  await a.tick(); await b.tick();
  const before = a.pushed();
  a.edit(42);
  const publishDelay = await a.tick();
  const receiveDelay = await b.tick();
  assert.equal(publishDelay, 400);
  assert.equal(receiveDelay, 400);
  assert.ok(publishDelay + receiveDelay < 1000, 'two sync intervals leave time for local HTTP round trips within one second');
  assert.equal(b.graph._nodes[0].widgets[0].value, 42);
  assert.equal(a.pushed(), before + 1);
});

test('sync observes the serialized root graph version while a subgraph is open', async () => {
  const bridge = await bootBridge({ stream: true });
  await bridge.tick();
  bridge.app.graph = { _version: 7 };
  const before = bridge.pushed();
  bridge.edit(42); await bridge.tick();
  assert.equal(bridge.pushed(), before + 1);
});
