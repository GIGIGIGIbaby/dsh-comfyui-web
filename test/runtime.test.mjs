import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime, normalizeUrl } from '../lib/runtime.js';

test('validates server URLs', () => {
  assert.equal(normalizeUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  for (const url of ['file:///C:/x', 'http://u:p@localhost/', 'http://localhost/a', 'http://localhost/?x=1']) assert.throws(() => normalizeUrl(url));
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
    return fetch(runtime.frameOrigin + '/__dsh_comfyui/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify({ clientId: 'c', sessionId: 's', ready: true, allowAI: true, visible: true, ...data }) });
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
  assert.throws(() => runtime.command('s', 'run'), /MCP 设置/);
});

test('browser bridge edits actual named widgets, validates whole batch and restores graph', async () => {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test-token"');
  const scheduled = []; const results = []; let commands = []; const messages = [];
  const widget = { name: 'text', type: 'text', value: 'original' };
  const node = { id: 6, type: 'CLIPTextEncode', title: 'Prompt', widgets: [widget], inputs: [], outputs: [] };
  let dirty = false; let submitted = 0;
  const app = { canvas: {}, graph: { _nodes: [node], serialize: () => ({ nodes: [{ id: 6, widgets_values: [widget.value] }], links: [] }),
    getNodeById: id => String(id) === '6' ? node : null, setDirtyCanvas: () => { dirty = true; } },
    graphToPrompt: async () => ({ workflow: { nodes: [] }, output: { 6: { inputs: { text: widget.value }, class_type: node.type } } }),
    loadGraphData: async graph => { widget.value = graph.nodes[0].widgets_values[0]; } };
  const parent = { postMessage: data => messages.push(data) };
  const window = { parent, comfyAPI: { app: { app }, api: { api: { queuePrompt: async () => { submitted++; return { prompt_id: 'test-prompt' }; } } } }, addEventListener: () => {} };
  const context = vm.createContext({ window, location: { search: '?dsh_client=c&dsh_session=s' }, document: { referrer: 'http://127.0.0.1:40000/' }, URL, URLSearchParams,
    setTimeout: fn => scheduled.push(fn), fetch: async (path, options) => {
      const data = JSON.parse(options.body);
      if (path.endsWith('/result')) results.push(data);
      const reply = path.endsWith('/poll') ? { commands: commands.splice(0) } : { ok: true };
      return { ok: true, json: async () => reply };
    } });
  vm.runInContext(code, context);
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  await flush();
  async function command(action, args = {}) { commands.push({ id: String(results.length), action, args }); scheduled.shift()(); await flush(); return results.at(-1); }
  assert.equal(messages.at(-1).ready, true);
  assert.equal((await command('list_nodes')).result.nodes[0].widgets[0].name, 'text');
  assert.match((await command('update_nodes', { changes: [{ nodeId: '6', widget: 'text', value: 'changed' }, { nodeId: '7', widget: 'text', value: 'bad' }] })).error, /不存在/);
  assert.equal(widget.value, 'original');
  assert.equal((await command('update_nodes', { changes: [{ nodeId: '6', widget: 'text', value: 'changed' }] })).result.changed[0].after, 'changed');
  assert.equal(dirty, true);
  await command('undo'); assert.equal(widget.value, 'original');
  assert.equal((await command('run')).result.prompt_id, 'test-prompt'); assert.equal(submitted, 1);
});
