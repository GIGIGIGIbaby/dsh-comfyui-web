import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime } from '../lib/runtime.js';
import { callComfyTool } from '../lib/mcp.js';
import { MCP_TOOLS } from '../lib/tool-definitions.js';
import { apply } from '../lib/host.js';

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-lease-'));
  return new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
}
const panel = (id, sessionId) => ({ id, sessionId, ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });

test('the first canvas write takes the lease and a second conversation is refused', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  const dispatched = [];
  rt.command = async (sessionId, action) => { dispatched.push({ sessionId, action }); return { nodes: [] }; };

  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 3 }] }, { dshSessionId: 'A' });
  assert.equal(rt.leaseState().holder, 'A', 'a write renews the lease for its own session');
  assert.equal(rt.leaseState().heldForMs >= 0, true);

  await assert.rejects(callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 4 }] }, { dshSessionId: 'B' }),
    /写租约被另一条对话持有（A，空闲 \d+ 秒）/);
  // A's successful write costs three dispatches: the read the two-phase plan makes before it
  // commits, the write itself, then the audit_graph that measures the front-end draft store for
  // the reply. B's refusal must add none of them — in particular no update_nodes, because a
  // refused write that still reads the canvas is fine while one that still writes is not.
  assert.deepEqual(dispatched.map(item => item.action), ['list_nodes', 'update_nodes', 'audit_graph']);
  assert.equal(dispatched.filter(item => item.action === 'update_nodes').length, 1, 'the refused write never reached the canvas');

  // Reads stay free while someone holds the lease.
  const read = await callComfyTool(rt, 'list_nodes', {}, { dshSessionId: 'B' });
  assert.equal(read.structuredContent.nodes.length, 0);
  assert.equal(rt.leaseState().holder, 'A', 'reading does not steal the lease');
});

test('a dead holder is reclaimed and only the holder may release without force', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.command = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });

  await assert.rejects(callComfyTool(rt, 'lease', { op: 'release' }, { dshSessionId: 'B' }), /不能替它释放/);
  const who = await callComfyTool(rt, 'lease', {}, { dshSessionId: 'B' });
  assert.equal(who.structuredContent.holder, 'A');

  // The holder's panel disappears (conversation closed) and the TTL passes.
  rt.clients.delete('pA');
  rt.lease.renewedAt = Date.now() - 6 * 60 * 1000;
  assert.equal((await callComfyTool(rt, 'lease', { op: 'who' })).structuredContent.holder, null,
    'an abandoned lease must not block the canvas until the next restart');

  const taken = await callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' });
  assert.equal(taken.structuredContent.holder, 'B');
});

test('an open panel does not keep the lease forever: silence expires it even while the holder is alive', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  // The regression: a page can stay connected for hours. Liveness therefore cannot be the
  // condition for expiry — only the time since the last write can be.
  rt.clients.set('pA', panel('pA', 'A'));
  rt.command = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  assert.equal(rt.leaseState().holder, 'A');

  // Still connected, but idle for longer than the TTL.
  rt.clients.set('pA', panel('pA', 'A'));
  rt.lease.renewedAt = Date.now() - 6 * 60 * 1000;
  const state = rt.leaseState();
  assert.equal(state.holder, null, 'a page that is merely open must not hold the canvas forever');
  assert.equal(state.holderAlive, false, 'nobody holds it any more, so nothing is reported alive');

  // The next conversation takes it without force.
  const taken = await callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' });
  assert.equal(taken.structuredContent.holder, 'B');
});

test('force takeover is possible but has to be asked for explicitly', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.command = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' }), /另一条对话持有/);
  const forced = await callComfyTool(rt, 'lease', { op: 'take', force: true }, { dshSessionId: 'B' });
  assert.equal(forced.structuredContent.holder, 'B');
});

test('lease is registered as a state-changing tool with explicit operations', () => {
  const lease = MCP_TOOLS.find(tool => tool.name === 'lease');
  assert.ok(lease);
  assert.equal(lease.annotations.readOnlyHint, false, 'lease can change state, so it is not read-only');
  assert.deepEqual(lease.inputSchema.properties.op.enum, ['who', 'take', 'release']);
});

test('the attachment upload-and-bind path obeys the write lease', async t => {
  // A dsh attachment never reaches callComfyTool: the host calls uploadImage() itself, so the
  // upload and the bind_image it may issue have to take the lease at that call site. The test
  // goes through the host's own registered tool handler; only the page is faked.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-attachment-lease-')), previousHome = process.env.DSH_HOME;
  const uploads = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/upload/image') uploads.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: 'attachment.png', type: 'input' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await mkdir(join(dir, 'comfyui'));
  await writeFile(join(dir, 'comfyui', 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:' + upstream.address().port }));
  process.env.DSH_HOME = dir;
  const attachment = { attachmentId: 'b-image', mediaType: 'image/png', width: 1, height: 1 };
  const effects = [], tools = [], dispatched = [];
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
    get(service) { if (service === 'attachments') return { async readImage() { return { data: Buffer.from('fixture') }; } }; },
    tools: { register(tool) { tools.push(tool); } }, webServer: { register() {} }
  };
  // The host builds its own runtime, so the page-facing dispatches are spied on the class.
  const original = ComfyRuntime.prototype.command;
  ComfyRuntime.prototype.command = async function (sessionId, action) {
    dispatched.push({ sessionId, action });
    return action === 'list_nodes' ? { nodes: [{ id: '5', widgets: [{ name: 'image' }] }] } : { bound: true };
  };
  t.after(async () => {
    ComfyRuntime.prototype.command = original;
    for (const dispose of effects.reverse()) await dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
  });
  await apply(ctx);
  const exec = id => ({ agent: { session: { id, deriveMessages: () => [{ id: 'human-' + id, role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment }] }] } }, signal: new AbortController().signal });
  const tool = name => tools.find(candidate => candidate.name === 'mcp__comfyui__' + name);
  await tool('lease').execute({ op: 'take' }, exec('A'));

  await assert.rejects(tool('upload_image').execute({ attachmentId: 'b-image', nodeId: '5' }, exec('B')),
    /写租约被另一条对话持有（A，空闲 \d+ 秒）/);
  assert.equal(dispatched.some(item => item.action === 'bind_image'), false, 'no bind_image may reach B\'s page');
  assert.deepEqual(dispatched, [], 'the refusal happens before uploadImage() reads or writes anything');
  assert.equal(uploads.length, 0, 'and the refused call does not even upload the bytes');
  assert.equal((await tool('lease').execute({ op: 'who' }, exec('B'))).structuredContent.holder, 'A');

  // Control: the same call goes through once B owns the canvas, so the refusal above is the
  // lease and not an unreachable path.
  await tool('lease').execute({ op: 'take', force: true }, exec('B'));
  const uploaded = await tool('upload_image').execute({ attachmentId: 'b-image', nodeId: '5' }, exec('B'));
  assert.equal(uploaded.structuredContent.widgetValue, 'attachment.png');
  assert.deepEqual(dispatched.map(item => item.action), ['list_nodes', 'bind_image']);
  assert.equal(uploads.length, 1);
});
