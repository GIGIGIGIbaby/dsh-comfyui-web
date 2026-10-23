import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { WorkflowSync } from '../lib/sync.js';
import { callComfyTool } from '../lib/mcp.js';
import { createPageTimers } from './helpers/page-timers.mjs';

test('different workflow tabs sync independently and returning to a tab retrieves its latest graph', () => {
  const sync = new WorkflowSync();
  const a = { nodes: [{ id: 1 }], links: [] }, b = { nodes: [{ id: 2 }], links: [] };
  sync.exchange({ clientId: 'one', workflowKey: 'a.json', workflow: a, fingerprint: 'a' });
  sync.exchange({ clientId: 'two', workflowKey: 'b.json', workflow: b, fingerprint: 'b' });
  assert.deepEqual(sync.exchange({ clientId: 'two', workflowKey: 'a.json' }).workflow, a);
  assert.deepEqual(sync.exchange({ clientId: 'one', workflowKey: 'b.json' }).workflow, b);
  assert.equal(sync.exchange({ clientId: 'one', workflowKey: 'c.json' }).workflow, undefined);
});

test('MCP routes workflow selection and cloning with the authenticated session', async () => {
  const calls = [];
  const runtime = { mcpEnabled: true, command(session, action, args) { calls.push({ session, action, args }); return {}; } };
  await callComfyTool(runtime, 'switch_workflow', { path: 'workflows/A.json', sessionId: 'forged' }, { dshSessionId: 'own' });
  await callComfyTool(runtime, 'new_workflow', { name: 'Copy', sourcePath: 'workflows/A.json' }, { dshSessionId: 'own' });
  assert.deepEqual(calls, [ { session: 'own', action: 'switch_workflow', args: { path: 'workflows/A.json' } },
    { session: 'own', action: 'new_workflow', args: { sourcePath: 'workflows/A.json', name: 'Copy' } } ]);
});

test('bridge switches native workflow objects and duplicates once without overwriting source drafts', async () => {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test"');
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  const graphOf = value => ({ id: value, nodes: [{ id: 1, widgets_values: [value] }], links: [] });
  const a = { path: 'workflows/A.json', filename: 'A', isLoaded: true, activeState: graphOf('a') };
  const b = { path: 'workflows/B.json', filename: 'B', isPersisted: true, isLoaded: false,
    async load() { this.isLoaded = true; this.activeState = graphOf('b'); return this; } };
  const open = [a], all = [a, b];
  let graph = graphOf('unsaved a'), commands = [], failLoad = false;
  const replies = [], timers = createPageTimers(), sync = new WorkflowSync();
  const store = { activeWorkflow: a, openWorkflows: open, persistedWorkflows: [b],
    getWorkflowByPath: path => all.find(w => w.path === path), async syncWorkflows() {},
    async closeWorkflow(workflow) {
      const index = all.indexOf(workflow); if (index >= 0) all.splice(index, 1);
      const opened = open.indexOf(workflow); if (opened >= 0) open.splice(opened, 1);
    },
    createNewTemporary(name, state) {
      const w = { path: 'workflows/' + name, filename: name, isLoaded: true, activeState: structuredClone(state) };
      all.push(w); return w;
    } };
  const calls = [];
  const app = { extensionManager: { workflow: store }, canvas: {},
    graph: { serialize: () => structuredClone(graph), setDirtyCanvas() {}, _nodes: [] },
    async loadGraphData(data, clean, view, workflow) {
      calls.push({ workflow, clean, view });
      store.activeWorkflow.activeState = structuredClone(graph);
      if (failLoad) { failLoad = false; graph = graphOf('partially loaded'); return false; }
      graph = structuredClone(data); store.activeWorkflow = workflow;
      if (!open.includes(workflow)) open.push(workflow);
      return true;
    } };
  const parent = { postMessage() {} };
  const context = vm.createContext({ window: { parent, comfyAPI: { app: { app } }, addEventListener() {} },
    crypto: { randomUUID: () => 'copy-id' }, URL, URLSearchParams,
    location: { search: '?dsh_client=panel&dsh_session=own' }, document: { referrer: 'http://localhost:3080/' },
    setTimeout: timers.schedule, clearTimeout: timers.unschedule, fetch: async (url, options) => {
      const data = JSON.parse(options.body);
      if (url.endsWith('/result')) replies.push(data);
      return { ok: true, json: async () => url.endsWith('/sync') ? sync.exchange(data)
        : url.endsWith('/poll') ? { commands: commands.splice(0) } : {} };
    } });
  vm.runInContext(code, context); await flush();
  async function command(action, args = {}, id = 'command-' + replies.length) {
    const before = replies.length;
    commands.push({ id, action, args });
    await timers.runUntil(() => replies.length > before);
    return replies.at(-1);
  }
  assert.equal((await command('list_workflows')).result.saved[0].path, b.path);
  assert.equal((await command('switch_workflow', { path: b.path })).result.switched, true);
  assert.equal(open.length, 2); assert.equal(graph.nodes[0].widgets_values[0], 'b');
  assert.equal(a.activeState.nodes[0].widgets_values[0], 'unsaved a');
  const loads = calls.length;
  await command('switch_workflow', { path: b.path }); assert.equal(calls.length, loads); assert.equal(open.length, 2);
  await command('switch_workflow', { path: a.path }); assert.equal(graph.nodes[0].widgets_values[0], 'unsaved a');
  const copy = await command('new_workflow', { name: 'Trial' }, 'copy-once');
  assert.equal(copy.result.created, true); assert.equal(open.length, 3);
  assert.equal(store.activeWorkflow.path, 'workflows/Trial.json'); assert.equal(graph.id, 'copy-id');
  assert.equal(graph.nodes[0].widgets_values[0], 'unsaved a');
  await command('new_workflow', { name: 'Trial' }, 'copy-once'); assert.equal(open.length, 3, 'redelivery must not create a second tab');
  assert.equal(a.activeState.id, 'unsaved a');
  assert.match((await command('new_workflow', { name: '../overwrite' })).error, /名称/);
  assert.match((await command('switch_workflow', { path: 'missing' })).error, /不存在/);
  await command('new_workflow', { sourcePath: b.path, name: 'From saved' });
  assert.equal(graph.nodes[0].widgets_values[0], 'b'); assert.equal(open.length, 4);
  const retained = store.activeWorkflow;
  failLoad = true;
  assert.match((await command('switch_workflow', { path: a.path })).error, /未能打开/);
  assert.equal(store.activeWorkflow, retained); assert.equal(graph.nodes[0].widgets_values[0], 'b');
  const countBefore = all.length;
  failLoad = true;
  assert.match((await command('new_workflow', { name: 'Failed copy' })).error, /未能打开/);
  assert.equal(all.length, countBefore, 'a failed new tab must not leave an orphan workflow');
  assert.equal(store.activeWorkflow, retained);
  assert.ok(calls.every(call => call.workflow && call.clean === true && call.view === true));
});
