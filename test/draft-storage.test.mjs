import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// The load-time sweep and the quota reclaim both delete keys the bridge does not own. The two
// failure modes pinned here are the ones a reviewer reproduced: a legacy record (no `savedAt`)
// treated as expired, and a full store answered by wiping every other session's history.

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const day = 24 * 60 * 60 * 1000;
const historyKey = session => 'dsh.comfyui.history.' + encodeURIComponent('http://comfy.test:' + session + ':workflows/H3.json');

const fakeStorage = (entries = {}, options = {}) => {
  const data = new Map(Object.entries(entries));
  let failures = options.failHistory ?? 0;
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) {
      if (options.unreadable && String(key).includes(options.unreadable)) throw new Error('SecurityError: unreadable key');
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (options.refuseWrites) throw new Error('QuotaExceededError');
      if (failures > 0 && String(key).startsWith('dsh.comfyui.history.')) { failures -= 1; throw new Error('QuotaExceededError'); }
      data.set(String(key), String(value));
    },
    removeItem(key) { data.delete(key); },
    snapshot() { return Object.fromEntries(data); }
  };
};

const plainNode = () => ({ id: 1, type: 'KSampler', title: '', mode: 0, properties: {},
  widgets: [{ name: 'steps', type: 'number', value: 20, min: 1, max: 100, options: { min: 1, max: 100 }, callback: () => {} }],
  inputs: [], outputs: [] });

async function boot(nodes, options = {}) {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test"');
  const timers = [], replies = [], commands = [];
  const graph = { _nodes: nodes, links: [], serialize: () => ({ nodes: nodes.map(n => ({ id: n.id, type: n.type, widgets_values: (n.widgets || []).map(w => w.value) })), links: [], groups: [] }),
    setDirtyCanvas() {}, getNodeById(id) { return nodes.find(node => String(node.id) === String(id)); } };
  const workflow = { path: 'workflows/H3.json', filename: 'H3', isLoaded: true, isPersisted: true, isModified: false };
  const app = { rootGraph: graph, graph, canvas: {}, configuringGraph: false,
    extensionManager: { workflow: { activeWorkflow: workflow, openWorkflows: [workflow] } },
    async graphToPrompt() { return { output: {} }; } };
  vm.runInContext(code, vm.createContext({
    window: { parent: { postMessage() {} }, comfyAPI: { app: { app } }, addEventListener() {}, LiteGraph: { createNode: () => null } },
    crypto: { randomUUID: () => 'u' + Math.random() }, URL, URLSearchParams, console,
    location: { origin: 'http://comfy.test', search: '?dsh_client=p&dsh_session=own', href: 'http://comfy.test/' },
    document: { referrer: 'http://dsh.test/', visibilityState: 'visible', addEventListener() {} },
    localStorage: options.localStorage || { getItem: () => null, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
    setTimeout: fn => timers.push(fn), clearTimeout() {},
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      if (String(url).includes('/result')) replies.push(body);
      return { ok: true, status: 200, json: async () => String(url).includes('/poll') ? { commands: commands.splice(0) } : { revision: 1 } };
    }
  }));
  await flush();
  return async (action, args = {}) => {
    commands.push({ id: 'c' + (replies.length + 1), action, args });
    const before = replies.length;
    for (let turn = 0; turn < 60 && replies.length === before; turn += 1) { const next = timers.shift(); if (next) next(); await flush(); }
    const reply = replies.at(-1);
    if (reply?.error) throw Object.assign(new Error(reply.error), { bridgeError: reply.error, hint: reply.hint });
    return reply.result;
  };
}

test('a legacy history record with no savedAt is not expired — it survives the load-time sweep', async () => {
  const legacy = JSON.stringify({ version: 1, undo: [{ id: 'cp1', time: Date.now(), label: 'update_nodes', workflow: { nodes: [], links: [] } }], redo: [] });
  const store = fakeStorage({ [historyKey('other')]: legacy });
  await boot([plainNode()], { localStorage: store });
  assert.ok(store.snapshot()[historyKey('other')], 'a checkpoint created a moment ago must not be deleted for lacking a timestamp');
});

test('only a timestamp older than the retention window removes another session record', async () => {
  const fresh = JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now() });
  const old = JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now() - 4 * day });
  const oldLegacy = JSON.stringify({ version: 1, undo: [{ id: 'cp', time: Date.now() - 4 * day, workflow: { nodes: [] } }], redo: [] });
  const mine = JSON.stringify({ version: 1, undo: [], redo: [] });
  const store = fakeStorage({
    [historyKey('fresh')]: fresh,
    [historyKey('old')]: old,
    [historyKey('old-legacy')]: oldLegacy,
    [historyKey('own')]: mine
  });
  await boot([plainNode()], { localStorage: store });
  const keys = Object.keys(store.snapshot());
  assert.ok(keys.includes(historyKey('fresh')), 'current savedAt survives');
  assert.ok(!keys.includes(historyKey('old')), 'four-day-old savedAt is reclaimed');
  assert.ok(!keys.includes(historyKey('old-legacy')), 'a legacy record dates itself through its newest checkpoint');
  assert.ok(keys.includes(historyKey('own')), 'this session keeps its own history');
});

test('a full store does not answer by erasing another session live history', async () => {
  const freshLegacy = JSON.stringify({ version: 1, undo: [{ id: 'cp', time: Date.now(), workflow: { nodes: [] } }], redo: [] });
  const stale = JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now() - 5 * day });
  const store = fakeStorage({
    [historyKey('fresh')]: freshLegacy,
    [historyKey('stale')]: stale,
    'dsh.comfyui.sync-conflict': 'c'.repeat(80),
    'dsh.comfyui.sync-conflict.dead': 'd'.repeat(80)
  }, { failHistory: 1 });
  const command = await boot([plainNode()], { localStorage: store });
  await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 21 }] });
  const keys = Object.keys(store.snapshot());
  assert.ok(keys.includes(historyKey('fresh')), 'a live foreign snapshot is not the price of a full store');
  assert.ok(!keys.includes(historyKey('stale')), 'a provably old foreign snapshot is reclaimed');
  assert.ok(keys.includes('dsh.comfyui.sync-conflict'), 'the conflict backup the notice points at survives — reclaiming it would make that promise false');
  assert.ok(!keys.includes('dsh.comfyui.sync-conflict.dead'), 'per-client conflict backups, which nothing reads back, are reclaimed first');
});

test('an undated foreign snapshot is reported as unknown, not stale', async () => {
  const legacy = JSON.stringify({ version: 1, undo: [], redo: [] });
  const store = fakeStorage({ [historyKey('other')]: legacy, 'Comfy.Workflow.Draft.v2:a': 'x'.repeat(40) });
  const command = await boot([plainNode()], { localStorage: store });
  const storage = (await command('audit_graph')).draftStorage;
  assert.equal(storage.staleChars, 0, 'no timestamp means unknown age, and unknown age is not a verdict');
  const entry = storage.ownKeys.find(item => item.kind === 'history');
  assert.equal(entry.current, false);
  assert.equal(entry.stale, undefined);
});

test('a readable store that refuses every write says unavailable', async () => {
  // `available` only proves the store could be enumerated. Private windows and some embedded
  // webviews hand back a readable store that rejects every setItem — that is the fault the user
  // actually sees as a permanent 保存草稿失败 banner, so it has to be measured, not assumed.
  const store = fakeStorage({ 'Comfy.Workflow.Draft.v2:a': 'x'.repeat(10) }, { refuseWrites: true });
  const command = await boot([plainNode()], { localStorage: store });
  const storage = (await command('audit_graph')).draftStorage;
  assert.equal(storage.available, true, 'enumeration still works');
  assert.equal(storage.unavailable, true, 'the probe write is what proves the store is dead');
  assert.match(storage.blocking, /可读但写不进/);
});

test('one unreadable key does not blind the whole measurement', async () => {
  const store = fakeStorage({
    'Comfy.Workflow.Draft.v2:dead': 'x'.repeat(50),
    [historyKey('other')]: 'not json at all'
  }, { unreadable: 'Draft.v2:dead' });
  const command = await boot([plainNode()], { localStorage: store });
  const storage = (await command('audit_graph')).draftStorage;
  assert.equal(storage.unavailable, false, 'a hostile key is not a read-only store');
  assert.equal(storage.unreadableKeys, 1);
  assert.equal(storage.staleKeys, 0, 'an undatable foreign record is kept out of the stale total');
});
