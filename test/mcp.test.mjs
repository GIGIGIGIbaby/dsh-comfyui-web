import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime } from '../lib/runtime.js';
import { WorkflowSync } from '../lib/sync.js';
import { connectMcp } from '../lib/mcp.js';
import { apply } from '../lib/host.js';

test('shared canvas accepts changes, delivers them to other tabs, and preserves conflicting edit', () => {
  const sync = new WorkflowSync();
  const original = { nodes: [{ id: 6, widgets_values: ['cat'] }], links: [] };
  const updated = { nodes: [{ id: 6, widgets_values: ['dog'] }], links: [] };
  assert.equal(sync.exchange({ clientId: 'original', revision: 0, workflow: original, fingerprint: 'cat' }).revision, 1);
  assert.deepEqual(sync.exchange({ clientId: 'dsh', revision: 0 }).workflow, original);
  assert.equal(sync.exchange({ clientId: 'dsh', revision: 1, workflow: updated, fingerprint: 'dog' }).revision, 2);
  assert.deepEqual(sync.exchange({ clientId: 'original', revision: 1 }).workflow, updated);
  const conflict = sync.exchange({ clientId: 'original', revision: 1, workflow: original, fingerprint: 'cat' });
  assert.equal(conflict.conflict, true); assert.deepEqual(conflict.workflow, updated);
});

test('MCP endpoint authenticates, lists real tools, accepts calls, interoperates with official SDK', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-mcp-'));
  const runtime = await new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
  t.after(() => runtime.stop());
  const noAuth = await fetch(runtime.frameOrigin + '/mcp', { method: 'POST', body: '{}' }); assert.equal(noAuth.status, 401);
  const foreign = await fetch(runtime.frameOrigin + '/mcp', { method: 'POST', headers: { Origin: 'https://example.com', Authorization: 'Bearer ' + runtime.token }, body: '{}' }); assert.equal(foreign.status, 403);
  const client = await connectMcp(runtime.frameOrigin + '/mcp', runtime.token);
  assert.equal(client.initialized, true); assert.equal(client.tools.length, 12);
  const failure = await client.rpc('tools/call', { name: 'get_workflow', arguments: {} }); assert.equal(failure.isError, true);
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client'));
  const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')));
  const sdk = new Client({ name: 'dsh-comfyui-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.frameOrigin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + runtime.token } } });
  await sdk.connect(transport); t.after(() => sdk.close());
  const tools = await sdk.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'get_workflow'));
  const error = await sdk.callTool({ name: 'get_workflow', arguments: {} }); assert.equal(error.isError, true);
});

test('dsh MCP adapter obtains runtime agent.session.id and cannot capture another conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-host-')); const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const effects = []; const tools = []; const routes = [];
  const ctx = {
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer); return disposer; },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; } }
  };
  t.after(async () => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; for (const dispose of effects.reverse()) await dispose(); });
  await apply(ctx);
  const { endpoint, token } = JSON.parse(await readFile(join(dir, 'comfyui', 'connection.json'), 'utf8'));
  const base = new URL(endpoint).origin;
  async function bridge(path, extra = {}) {
    const response = await fetch(base + '/__dsh_comfyui/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify({ clientId: 'panel', sessionId: 'owned', ready: true, allowAI: true, visible: true, ...extra }) });
    return response.json();
  }
  await bridge('poll');
  const tool = tools.find(tool => tool.name === 'mcp__comfyui__get_workflow'); assert.ok(tool);
  const execution = { agent: { session: { id: 'owned' } }, signal: new AbortController().signal };
  const result = tool.execute({}, execution);
  let commands = [];
  for (let attempt = 0; attempt < 30 && !commands.length; attempt++) { commands = (await bridge('poll')).commands; if (!commands.length) await new Promise(r => setTimeout(r, 10)); }
  assert.equal(commands[0].action, 'get_workflow');
  await bridge('result', { id: commands[0].id, result: { workflow: { nodes: [], links: [] }, prompt: {} } });
  assert.deepEqual((await result).structuredContent.workflow, { nodes: [], links: [] });
  await assert.rejects(() => tool.execute({}, { ...execution, agent: { session: { id: 'elsewhere' } } }), /这条|本条/);
  await assert.rejects(() => tool.execute({}, { ...execution, agent: { sessionId: 'owned' } }), /当前对话身份/);
});

test('MCP defaults on, disabling persists and blocks tools while preserving manual sync', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-switch-'));
  const configFile = join(dir, 'config.json');
  const runtime = await new ComfyRuntime(configFile, { port: 0 }).start();
  t.after(() => runtime.stop());
  assert.equal(runtime.mcpEnabled, true);
  const client = await connectMcp(runtime.frameOrigin + '/mcp', runtime.token);
  runtime.clients.set('panel', { id: 'panel', sessionId: 'owned', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  const queued = runtime.command('owned', 'run');
  const cancelled = assert.rejects(queued, /MCP 已关闭/);
  await runtime.setMcpEnabled(false); await cancelled;
  assert.equal(runtime.clients.get('panel').queue.length, 0);
  assert.throws(() => runtime.command('owned', 'get_workflow'), /MCP 已关闭/);
  for (const name of ['queue', 'get_workflow', 'run', 'get_image']) {
    const result = await client.rpc('tools/call', { name, arguments: { sessionId: 'owned' } });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /MCP 已关闭/);
  }
  const sync = await fetch(runtime.frameOrigin + '/__dsh_comfyui/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': runtime.token },
    body: JSON.stringify({ clientId: 'manual', sessionId: 'comfyui-external', revision: 0, workflow: { nodes: [], links: [] }, fingerprint: 'empty' }) });
  assert.equal(sync.status, 200); assert.equal((await sync.json()).revision, 1);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).mcpEnabled, false);
  const restarted = await new ComfyRuntime(configFile, { port: 0 }).start();
  t.after(() => restarted.stop()); assert.equal(restarted.mcpEnabled, false);
  await restarted.setMcpEnabled(true); assert.equal(restarted.mcpEnabled, true);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).mcpEnabled, true);
});
