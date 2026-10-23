import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime, normalizeUrl, BRIDGE_PROTOCOL } from '../lib/runtime.js';
import { WorkflowSync } from '../lib/sync.js';
import { createPageTimers } from './helpers/page-timers.mjs';

test('validates server URLs', () => {
  assert.equal(normalizeUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  for (const url of ['file:///C:/x', 'http://u:p@localhost/', 'http://localhost/a', 'http://localhost/?x=1']) assert.throws(() => normalizeUrl(url));
});

test('browser tab resume synchronizes into the existing workflow without duplicate tabs or repeated loads', async () => {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test-token"');
  const sync = new WorkflowSync();
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  function page(clientId, external = false) {
    const scheduled = createPageTimers(); const commands = []; const replies = []; const calls = []; const events = new Map();
    let syncGate;
    const active = { path: 'shared.json' }; const tabs = [active];
    const tracker = { isLoadingGraph: false };
    let graph = { id: clientId, revision: 1, nodes: [{ id: 6, widgets_values: ['original'] }], links: [] };
    const app = { extensionManager: { workflow: { activeWorkflow: active } }, canvas: { ds: { scale: 0.8, offset: [20, 30] } },
      graph: { serialize: () => structuredClone(graph), setDirtyCanvas() {} },
      async loadGraphData(data, clean, restoreView, workflow) {
        calls.push({ clean, restoreView, workflow });
        if (!workflow) { const created = {}; tabs.push(created); app.extensionManager.workflow.activeWorkflow = created; }
        graph = structuredClone(data); graph.id = clientId; graph.revision++;
        app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0];
        return true;
      } };
    const parent = { postMessage() {} };
    const window = { parent, comfyAPI: { app: { app }, changeTracker: { ChangeTracker: tracker } }, addEventListener() {} };
    if (external) window.parent = window;
    const context = vm.createContext({ window, crypto: { randomUUID: () => clientId }, location: { search: external ? '' : '?dsh_client=' + clientId + '&dsh_session=s' },
      document: { referrer: 'http://127.0.0.1:3080/', addEventListener(name, callback) { events.set(name, callback); } }, URL, URLSearchParams,
      localStorage: { setItem() {} }, setTimeout: scheduled.schedule, clearTimeout: scheduled.unschedule, fetch: async (path, options) => {
        const data = JSON.parse(options.body);
        if (path.endsWith('/result')) replies.push(data);
        const reply = path.endsWith('/sync') ? sync.exchange(data) : path.endsWith('/poll') ? { commands: commands.splice(0) } : { ok: true };
        if (path.endsWith('/sync') && syncGate) { const gate = syncGate; syncGate = null; await gate; }
        return { ok: true, json: async () => reply };
      } });
    return { app, tracker, tabs, active, calls, replies, start() { vm.runInContext(code, context); },
      edit(value) { events.get('pointerdown')?.({ isTrusted: true }); graph.nodes[0].widgets_values[0] = value; events.get('input')?.({ isTrusted: true }); events.get('pointerup')?.({ isTrusted: true }); }, value() { return graph.nodes[0].widgets_values[0]; },
      localRevision() { graph.revision++; },
      holdSync() { let release; syncGate = new Promise(resolve => { release = resolve; }); return release; },
      async tick() { scheduled.runNext(); await flush(); },
      async command(action, args = {}) { const before = replies.length; commands.push({ id: String(before), action, args });
        await scheduled.runUntil(() => replies.length > before); return replies.at(-1); } };
  }
  const original = page('original', true); const embedded = page('embedded');
  original.start(); await flush(); embedded.start(); await flush();
  assert.equal(embedded.calls.length, 0, 'identical initial sync must not reload a graph');
  original.edit('edited while other tab was inactive'); await original.tick();
  await embedded.tick();
  assert.equal(embedded.value(), original.value()); assert.equal(embedded.tabs.length, 1);
  assert.equal(embedded.calls[0].workflow, embedded.active);
  assert.equal(embedded.calls[0].clean, false); assert.equal(embedded.calls[0].restoreView, false);
  assert.deepEqual(embedded.app.canvas.ds, { scale: 0.8, offset: [20, 30] });
  for (let i = 0; i < 5; i++) { await original.tick(); await embedded.tick(); }
  assert.equal(embedded.calls.length, 1, 'tab resume with unchanged content must not repeat graph loading');
  for (let i = 0; i < 5; i++) { original.localRevision(); embedded.localRevision(); await original.tick(); await embedded.tick(); }
  assert.equal(embedded.calls.length, 1, 'browser-local workflow IDs and revisions must not cause reload ping-pong');
  assert.equal(original.calls.length, 0);
  // No loader call is allowed while the workflow manager is missing or returns
  // a temporary string identity. Both used to fall through to new-tab loading.
  for (const missing of [undefined, { activeWorkflow: null }, { activeWorkflow: 'workflow.json' }]) {
    original.app.extensionManager.workflow = missing;
    embedded.edit('edit while original is initializing'); await embedded.tick(); await original.tick();
    assert.equal(original.calls.length, 0); assert.equal(original.tabs.length, 1);
  }
  original.app.extensionManager.workflow = { activeWorkflow: original.active };
  await original.tick(); assert.equal(original.value(), embedded.value()); assert.equal(original.tabs.length, 1);
  original.edit('remote edit during workflow switch'); await original.tick();
  const release = embedded.holdSync(); const beforeSwitch = embedded.calls.length;
  await embedded.tick(); embedded.app.extensionManager.workflow.activeWorkflow = { path: 'new-tab.json' };
  release(); await flush();
  assert.equal(embedded.calls.length, beforeSwitch, 'a delayed response must not load into a different workflow tab');
  embedded.app.extensionManager.workflow.activeWorkflow = embedded.active;
  await embedded.tick(); assert.equal(embedded.value(), original.value()); assert.equal(embedded.tabs.length, 1);
  original.app.rootGraph = original.app.graph;
  original.app.graph = { serialize: () => ({ nodes: [], links: [] }), setDirtyCanvas() {} };
  const beforeSubgraph = embedded.calls.length;
  await original.tick(); await embedded.tick();
  assert.equal(embedded.calls.length, beforeSubgraph, 'opening a subgraph must not replace the shared root workflow');
  const next = { nodes: [{ id: 6, widgets_values: ['AI loaded graph'] }], links: [] };
  assert.equal((await embedded.command('load_workflow', { workflow: next })).result.loaded, true);
  assert.equal(embedded.tabs.length, 1); assert.equal(embedded.calls.at(-1).workflow, embedded.active);
  embedded.app.extensionManager.workflow.activeWorkflow = { path: 'other.json' };
  assert.match((await embedded.command('undo')).error, /工作流已切换/);
  embedded.app.extensionManager.workflow.activeWorkflow = embedded.active;
  assert.equal((await embedded.command('undo')).result.restored, true);
  assert.equal(embedded.tabs.length, 1); assert.equal(embedded.calls.at(-1).workflow, embedded.active);
  original.tracker.isLoadingGraph = true; original.edit('incomplete loading state'); await original.tick();
  await embedded.tick(); assert.notEqual(embedded.value(), 'incomplete loading state');
});

test('proxy injects bridge, forwards HTTP, rejects cross-origin writes, and isolates sessions', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/?')) { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>ComfyUI</body></html>'); }
    else if (req.url === '/interrupt') res.end();
    else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, origin: req.headers.origin })); }
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-test-'));
  const runtime = await new ComfyRuntime(join(dir, 'config.json'), { port: 0, url: `http://127.0.0.1:${upstream.address().port}` }).start();
  t.after(() => runtime.stop());
  const root = await fetch(runtime.frameOrigin + '/?dsh_client=c&dsh_session=s');
  assert.match(await root.text(), /__dsh_comfyui\/bridge.js/);
  assert.equal((await fetch(runtime.frameOrigin + '/queue')).status, 200);
  assert.equal((await fetch(runtime.frameOrigin + '/prompt', { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  assert.deepEqual(await runtime.request('/interrupt', { method: 'POST' }), {});
  async function bridge(path, data, token = runtime.token) {
    return fetch(runtime.frameOrigin + '/__dsh_comfyui/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify({ clientId: 'c', sessionId: 's', bridgeProtocol: BRIDGE_PROTOCOL, ready: true, allowAI: true, visible: true, ...data }) });
  }
  assert.equal((await bridge('poll', {}, 'bad')).status, 403);
  await bridge('poll', {});
  assert.throws(() => runtime.command('other-session', 'list_nodes'), /本条|这条/);
  const result = runtime.command('s', 'list_nodes');
  const { commands } = await (await bridge('poll', {})).json();
  assert.equal(commands.length, 1);
  assert.equal((await (await bridge('poll', {})).json()).commands.length, 0);
  await bridge('result', { id: commands[0].id, result: { nodes: [] } });
  assert.deepEqual(await result, { nodes: [] });
  await bridge('poll', { allowAI: false });
  assert.throws(() => runtime.command('s', 'run'), /连接设置/);
  runtime.sync.exchange({ clientId: 'new-page', workflow: { nodes: [], links: [] }, fingerprint: 'new' });
  const stale = await bridge('sync', { bridgeProtocol: undefined, revision: 0 });
  assert.equal(stale.status, 409);
  const blocked = await stale.json(); assert.equal(blocked.refreshRequired, true);
  assert.equal(blocked.workflow, undefined, 'old pages must never receive a graph they can load into a new tab');
  const diagnostics = runtime.status().syncClients.find(c => c.clientId === 'c');
  assert.equal(diagnostics.refreshRequired, true); assert.equal(diagnostics.bridgeVersion, 'legacy');
  const oldPage = await bridge('sync', { bridgeProtocol: 5, bridgeVersion: '0.5.10', revision: 1,
    workflow: { nodes: [{ id: 'old-code' }], links: [] }, fingerprint: 'old-code' });
  assert.equal(oldPage.status, 409, 'the reverted bridge must not participate in the new synchronization protocol');
  assert.equal((await oldPage.json()).workflow, undefined);
  assert.equal(runtime.sync.exchange({ clientId: 'inspector' }).fingerprint, 'new');
});

test('browser bridge edits actual named widgets, validates whole batch and restores graph', async () => {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test-token"');
  const scheduled = createPageTimers(); const results = []; let commands = []; const messages = [];
  const widget = { name: 'text', type: 'text', value: 'original' };
  const node = { id: 6, type: 'CLIPTextEncode', title: 'Prompt', widgets: [widget], inputs: [], outputs: [] };
  let dirty = false; let submitted = 0;
  const app = { extensionManager: { workflow: { activeWorkflow: { path: 'test.json' } } }, canvas: {}, graph: { _nodes: [node], serialize: () => ({ nodes: [{ id: 6, widgets_values: [widget.value] }], links: [] }),
    getNodeById: id => String(id) === '6' ? node : null, setDirtyCanvas: () => { dirty = true; } },
    graphToPrompt: async () => ({ workflow: { nodes: [] }, output: { 6: { inputs: { text: widget.value }, class_type: node.type } } }),
    loadGraphData: async graph => { widget.value = graph.nodes[0].widgets_values[0]; } };
  const parent = { postMessage: data => messages.push(data) };
  const window = { parent, comfyAPI: { app: { app }, api: { api: { queuePrompt: async () => { submitted++; return { prompt_id: 'test-prompt' }; } } } }, addEventListener: () => {} };
  const context = vm.createContext({ window, location: { search: '?dsh_client=c&dsh_session=s' }, document: { referrer: 'http://127.0.0.1:40000/' }, URL, URLSearchParams,
    crypto: { randomUUID: () => 'checkpoint-' + results.length },
    setTimeout: scheduled.schedule, clearTimeout: scheduled.unschedule, fetch: async (path, options) => {
      const data = JSON.parse(options.body);
      if (path.endsWith('/result')) results.push(data);
      const reply = path.endsWith('/poll') ? { commands: commands.splice(0) } : { ok: true };
      return { ok: true, json: async () => reply };
    } });
  vm.runInContext(code, context);
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  await flush();
  async function command(action, args = {}, expiresAt) { const before = results.length;
    commands.push({ id: String(before), action, args, expiresAt });
    await scheduled.runUntil(() => results.length > before); return results.at(-1); }
  assert.equal(messages.at(-1).ready, true);
  assert.match((await command('update_nodes', { changes: [{ nodeId: '6', widget: 'text', value: 'expired change' }] }, 1)).error, /过期/);
  assert.equal(widget.value, 'original', 'a delayed expired command must not modify the graph');
  assert.equal((await command('list_nodes')).result.nodes[0].widgets[0].name, 'text');
  assert.match((await command('update_nodes', { changes: [{ nodeId: '6', widget: 'text', value: 'changed' }, { nodeId: '7', widget: 'text', value: 'bad' }] })).error, /不存在/);
  assert.equal(widget.value, 'original');
  assert.equal((await command('update_nodes', { changes: [{ nodeId: '6', widget: 'text', value: 'changed' }] })).result.changed[0].after, 'changed');
  assert.equal(dirty, true);
  await command('undo'); assert.equal(widget.value, 'original');
  assert.equal((await command('run')).result.prompt_id, 'test-prompt'); assert.equal(submitted, 1);
});

test('the served bridge carries the plugin version, never a literal that can drift', async t => {
  // P0-3: bridge.js used to hard-code its own version, so a locally re-versioned package made
  // doctor's bridge-version check fail forever — with a cure ("刷新页面") that cannot fix a
  // bookkeeping gap. The runtime now substitutes package.json's version into the served copy;
  // a leftover placeholder anywhere in the file would reintroduce the permanent red.
  const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-version-'));
  const runtime = await new ComfyRuntime(join(dir, 'config.json'), { port: 0, url: `http://127.0.0.1:${upstream.address().port}` }).start();
  t.after(() => runtime.stop());
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const served = await (await fetch(runtime.frameOrigin + '/__dsh_comfyui/bridge.js')).text();
  assert.equal(runtime.bridgeVersion, version, 'the runtime reports the package version it serves');
  // The version placeholder sits inside quotes in the source already, so the injection must be
  // raw. JSON.stringify here produced `'"0.5.12-…"'` — a version wrapped in literal quote
  // characters — which keeps doctor's version check red forever, i.e. the very defect this test
  // was written to pin. Asserting the exact literal shape is what catches that class of mistake.
  assert.ok(served.includes("const versionLiteral = '" + version + "'"), 'the page receives the version as the plain quoted literal');
  assert.ok(!served.includes("'\"" + version + "\"'"), 'no extra quoting inside the string literal');
  for (const placeholder of ['__DSH_BRIDGE_VERSION__', '__DSH_BRIDGE_TOKEN__']) {
    assert.equal(served.split(placeholder).length - 1, 0, placeholder + ' must not survive into the page');
  }
  // Second-round report N6: the token is readable by any local process through three unauthenticated
  // GETs. That is a deliberate local trust boundary (loopback bind, and the same secret already lives
  // in ~/.dsh/comfyui/connection.json), so the running surface has to say it rather than let a green
  // server_info imply the token is confidential.
  assert.match(runtime.status().localTrustBoundary, /本机任意进程可读/);
});

test('a command the page never answers is counted on both sides and the timeout names the cure', async t => {
  // R7-7: the round-7 freeze was invisible because `connected` reads the SSE stream, which stays open while
  // the page's command loop is wedged. Two counters close that gap — the page's own watchdog and this
  // transport-side one — and the timeout text now says what a timeout cannot prove.
  const runtime = new ComfyRuntime('/tmp/dsh-comfyui-timeout-test.json', { port: 0 });
  const written = [];
  const client = { id: 'c-timeout', sessionId: 's', queue: [], seen: Date.now(), ready: true, allowAI: true,
    stream: { write: data => written.push(String(data)), destroyed: false } };
  runtime.clients.set(client.id, client);
  const commandId = () => JSON.parse(written.at(-1).replace(/^data: /, '').trim()).commands[0].id;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = runtime.dispatch(client, 'save_as_workflow', { name: 'x' });
    assert.match(written.join(''), /save_as_workflow/, 'the command reached the page');
    t.mock.timers.tick(25_000);
    const message = await pending.then(() => null, error => error.message);
    assert.match(message, /面板响应超时/);
    assert.match(message, /保存类动作常已落盘/, 'a save that timed out may still have hit the disk, and the caller must be told');
    assert.match(message, /再决定是否重发/, 'so the answer is to check, not to fire the same write again');
    assert.match(message, /F5 刷新/, 'and the recovery for a wedged page is named');
    assert.equal(client.timeouts, 1, 'the transport counted it, so doctor can fail on it');

    // A command that IS answered must not leave its watchdog to fire later and be counted as a second stall.
    const answered = runtime.dispatch(client, 'list_nodes', {});
    runtime.pending.get(commandId()).resolve({ nodes: [] });
    assert.deepEqual(await answered, { nodes: [] }, 'the reply reaches the caller');
    t.mock.timers.tick(60_000);
    assert.equal(client.timeouts, 1, 'answering clears the watchdog instead of letting it expire behind the reply');
    assert.equal(runtime.pending.size, 0);

    client.stalledCommands = 2;
    const reported = runtime.status().clients.find(item => item.clientId === client.id);
    assert.equal(reported.timeouts, 1);
    assert.equal(reported.stalledCommands, 2, 'and the page-reported count travels with the client');
    assert.equal(runtime.status().syncClients.find(item => item.clientId === client.id).stalledCommands, 2);
  } finally {
    t.mock.timers.reset();
  }
});

test('a page-side refusal does not renew the lease an idle holder already has', async () => {
  // Eighth-round report R8-C. acquireLease() both claims and renews, and command() called it
  // unconditionally before the dispatch — so for a conversation that ALREADY held the lease every
  // page-side refusal (ok:false, e.g. a wrong widget type) pushed renewedAt to now. An idle holder
  // could sit there retrying a write that never lands and never lose the canvas. The plan phase
  // (needs_input in lib/mcp.js) returns before reaching command(), which is why only page-side
  // refusals showed the symptom.
  const runtime = new ComfyRuntime('/tmp/dsh-comfyui-renew-test.json', { port: 0 });
  const panel = (id, sessionId) => ({ id, sessionId, ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  runtime.clients.set('pA', panel('pA', 'A'));
  runtime.clients.set('pB', panel('pB', 'B'));
  const dispatched = [];
  let refuse = false;
  runtime.dispatch = async (client, action) => {
    dispatched.push({ sessionId: client.sessionId, action });
    if (refuse) throw Object.assign(new Error('resolution 必须是文本'), { pageSide: true, stage: 'apply' });
    return { changed: [] };
  };

  await runtime.command('A', 'update_nodes', { changes: [] });
  assert.equal(runtime.leaseState().holder, 'A', 'the first landed write claims the canvas');

  // Age the clock, then let the page refuse the retry: a write that wrote nothing is not activity.
  runtime.lease.renewedAt = Date.now() - 60_000;
  refuse = true;
  await assert.rejects(runtime.command('A', 'update_nodes', { changes: [] }), /resolution 必须是文本/);
  assert.equal(runtime.lease.holder, 'A', 'the established holder keeps the lease across its own failed write');
  assert.ok(Date.now() - runtime.lease.renewedAt >= 60_000,
    'and the refused write must not push the idle clock forward — failing in a loop cannot hold the canvas');

  // The renewal has to be earned: the same call, actually landing, does move the clock.
  refuse = false;
  await runtime.command('A', 'update_nodes', { changes: [] });
  assert.ok(Date.now() - runtime.lease.renewedAt < 5000, 'a write that landed renews the lease');

  // Claiming still happens before the dispatch, so a second conversation is refused, not queued.
  const before = dispatched.length;
  assert.throws(() => runtime.command('B', 'update_nodes', { changes: [] }), /写租约被另一条对话持有（A/);
  assert.equal(dispatched.length, before, 'B never reached its page');

  // A lease that had already expired is a new claim, not a renewal, so a refusal gives it back.
  runtime.lease.renewedAt = Date.now() - 6 * 60 * 1000;
  refuse = true;
  await assert.rejects(runtime.command('A', 'update_nodes', { changes: [] }), /resolution 必须是文本/);
  assert.equal(runtime.leaseState().holder, null,
    'a claim this call established is released when the write was refused');

  // Two writes from the same conversation can be in flight. The restore is synchronous (before the
  // dispatch), so a renewal another call earns later can never be rewound by this one's refusal —
  // this pins that ordering instead of leaving it to luck.
  let openGate; const gate = new Promise(resolve => { openGate = resolve; });
  let refuseLate = false;
  runtime.dispatch = async (client, action) => {
    if (refuseLate) { refuseLate = false; await gate; throw new Error('resolution 必须是文本'); }
    return { changed: [] };
  };
  await runtime.command('A', 'update_nodes', { changes: [] });
  runtime.lease.renewedAt = Date.now() - 60_000;
  refuseLate = true;
  const inFlight = runtime.command('A', 'update_nodes', { changes: [] }).catch(error => error);
  await runtime.command('A', 'update_nodes', { changes: [] });
  assert.ok(Date.now() - runtime.lease.renewedAt < 5000, 'the write that landed renewed the lease');
  openGate();
  assert.match((await inFlight).message, /resolution 必须是文本/);
  assert.ok(Date.now() - runtime.lease.renewedAt < 5000,
    'a late refusal from the same conversation must not rewind the renewal the landed write earned');
});
