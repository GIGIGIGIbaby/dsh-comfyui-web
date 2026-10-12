import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime, BRIDGE_PROTOCOL } from '../lib/runtime.js';

test('persistent commands remain available while hidden and idle, reconnect without replay, and keep session fences', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-command-stream-'));
  const runtime = await new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
  t.after(() => runtime.stop());
  const bridge = (path, data = {}) => fetch(runtime.frameOrigin + '/__dsh_comfyui/' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': runtime.token },
    body: JSON.stringify({ clientId: 'panel', sessionId: 'owner', ready: true, allowAI: true, visible: false, bridgeProtocol: BRIDGE_PROTOCOL, ...data }) });
  await bridge('poll');
  const streamUrl = runtime.frameOrigin + '/__dsh_comfyui/commands?' + new URLSearchParams({
    token: runtime.token, clientId: 'panel', sessionId: 'owner', bridgeProtocol: BRIDGE_PROTOCOL
  });
  assert.equal((await fetch(streamUrl.replace(runtime.token, 'bad'))).status, 403);
  assert.equal((await fetch(streamUrl.replace('sessionId=owner', 'sessionId=foreign'))).status, 403);
  assert.equal((await fetch(streamUrl, { headers: { Origin: 'https://foreign.test' } })).status, 403);
  const response = await fetch(streamUrl, { headers: { Origin: 'http://127.0.0.1:8188' } });
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8188');
  const reader = response.body.getReader(); await reader.read();
  runtime.clients.get('panel').seen = Date.now() - 600000;
  assert.equal(runtime.status('owner').clients[0].connected, true);
  assert.equal(runtime.status('owner').clients[0].visible, false);
  assert.throws(() => runtime.command('foreign', 'update_nodes'), /本条|这条/);
  const result = runtime.command('owner', 'list_nodes');
  const message = Buffer.from((await reader.read()).value).toString();
  const command = JSON.parse(message.split('\n').find(line => line.startsWith('data: ')).slice(6)).commands[0];
  assert.equal(command.action, 'list_nodes'); assert.ok(command.expiresAt > Date.now());
  await bridge('result', { id: command.id, result: { nodes: [] } }); assert.deepEqual(await result, { nodes: [] });
  await reader.cancel();
  for (let i = 0; i < 20 && runtime.clients.get('panel').stream; i++) await new Promise(r => setTimeout(r, 5));
  assert.throws(() => runtime.command('owner', 'run'), /断开.*不表示 MCP/);
  const reconnected = await fetch(streamUrl); const nextReader = reconnected.body.getReader();
  const initial = Buffer.from((await nextReader.read()).value).toString();
  assert.equal(initial.includes('commands'), false, 'reconnecting must not replay a delivered action');
  const next = runtime.command('owner', 'get_workflow');
  const packet = Buffer.from((await nextReader.read()).value).toString();
  const newCommand = JSON.parse(packet.split('\n').find(line => line.startsWith('data: ')).slice(6)).commands[0];
  assert.notEqual(newCommand.id, command.id);
  await bridge('result', { id: newCommand.id, result: { workflow: { nodes: [], links: [] } } }); await next;
  await bridge('state', { allowAI: false });
  assert.throws(() => runtime.command('owner', 'run'), /MCP 设置/);
  await nextReader.cancel();
});
