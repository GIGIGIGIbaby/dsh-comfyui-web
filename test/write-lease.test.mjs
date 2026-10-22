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
  rt.dispatch = async (client, action) => { dispatched.push({ sessionId: client.sessionId, action }); return { nodes: [] }; };

  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 3 }] }, { dshSessionId: 'A' });
  assert.equal(rt.leaseState().holder, 'A', 'a write renews the lease for its own session');
  assert.equal(rt.leaseState().heldForMs >= 0, true);

  // B has a live page too, so its refusal is the lease conflict and not the identity guard — and
  // the lease is now taken at the dispatch, which means the two-phase plan's read already happened.
  rt.clients.set('pB', panel('pB', 'B'));
  const before = dispatched.length;
  await assert.rejects(callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 4 }] }, { dshSessionId: 'B' }),
    /写租约被另一条对话持有（A，空闲 \d+ 秒）/);
  // A's successful write costs three dispatches: the read the two-phase plan makes before it
  // commits, the write itself, then the audit_graph that measures the front-end draft store for
  // the reply. B may read the canvas but its write must never be dispatched.
  assert.deepEqual(dispatched.slice(0, before).map(item => item.action), ['list_nodes', 'update_nodes', 'audit_graph']);
  assert.deepEqual(dispatched.slice(before).map(item => [item.sessionId, item.action]), [['B', 'list_nodes']],
    'the refused conversation read the canvas and wrote nothing');
  assert.equal(dispatched.filter(item => item.action === 'update_nodes').length, 1, 'the refused write never reached the canvas');

  // Reads stay free while someone holds the lease.
  const read = await callComfyTool(rt, 'list_nodes', {}, { dshSessionId: 'B' });
  assert.equal(read.structuredContent.nodes.length, 0);
  assert.equal(rt.leaseState().holder, 'A', 'reading does not steal the lease');
});

test('a dead holder is reclaimed and only the holder may release without force', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });

  await assert.rejects(callComfyTool(rt, 'lease', { op: 'release' }, { dshSessionId: 'B' }), /不能替它释放/);
  const who = await callComfyTool(rt, 'lease', {}, { dshSessionId: 'B' });
  assert.equal(who.structuredContent.holder, 'A');

  // The holder's panel disappears (conversation closed) and the TTL passes.
  rt.clients.delete('pA');
  rt.lease.renewedAt = Date.now() - rt.leaseState().ttlMs - 1000;
  assert.equal((await callComfyTool(rt, 'lease', { op: 'who' })).structuredContent.holder, null,
    'an abandoned lease must not block the canvas until the next restart');

  rt.clients.set('pB', panel('pB', 'B'));
  const taken = await callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' });
  assert.equal(taken.structuredContent.holder, 'B');
});

test('an open panel does not keep the lease forever: silence expires it even while the holder is alive', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  // The regression: a page can stay connected for hours. Liveness therefore cannot be the
  // condition for expiry — only the time since the last write can be.
  rt.clients.set('pA', panel('pA', 'A'));
  rt.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  assert.equal(rt.leaseState().holder, 'A');

  // Still connected, but idle for longer than the TTL.
  rt.clients.set('pA', panel('pA', 'A'));
  const ttlMs = rt.leaseState().ttlMs;
  rt.lease.renewedAt = Date.now() - ttlMs - 1000;
  const state = rt.leaseState();
  assert.equal(state.holder, null, 'a page that is merely open must not hold the canvas forever');
  assert.equal(state.holderAlive, false, 'nobody holds it any more, so nothing is reported alive');

  // The next conversation takes it without force.
  rt.clients.set('pB', panel('pB', 'B'));
  const taken = await callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' });
  assert.equal(taken.structuredContent.holder, 'B');
});

test('force takeover is possible but has to be asked for explicitly', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.clients.set('pB', panel('pB', 'B'));
  rt.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' }), /另一条对话持有/);
  const forced = await callComfyTool(rt, 'lease', { op: 'take', force: true }, { dshSessionId: 'B' });
  assert.equal(forced.structuredContent.holder, 'B');
});

test('the lease TTL is the five minutes the conflict message promises', () => {
  // Every expiry test above measures from `ttlMs`, so a changed constant moves them with it.
  // This one pins the number itself: the conflict text tells the user how long a lost panel
  // blocks the canvas, and that sentence is only true at this value.
  assert.equal(new ComfyRuntime('unused.json', { port: 0 }).leaseState().ttlMs, 5 * 60 * 1000);
});

test('a conversation with no panel cannot claim the canvas, even with force', async t => {
  // The ghost-session reproduction: naming a sessionId was enough to hold the write lease for a
  // full TTL and shut out the conversation the user is actually driving.
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  // Without force the conflict is the more specific answer; with force the caller has already been
  // told to ignore that, so the panel requirement is what still stops it.
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'ghost' }), /另一条对话持有/);
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take', force: true }, { dshSessionId: 'ghost' }), /没有活着的页面/);
  assert.equal(rt.leaseState().holder, 'A', 'and neither refusal touched the real holder');
  // Nobody holds the canvas any more — the panel requirement is what still keeps a ghost out.
  await callComfyTool(rt, 'lease', { op: 'release' }, { dshSessionId: 'A' });
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'ghost' }), /没有活着的页面/);
  await assert.rejects(callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 2 }] }, { dshSessionId: 'ghost' }),
    /没有活着的页面|连接已断开|桥接扩展连接/, 'a ghost write is stopped before it reaches the page');
  assert.equal(rt.leaseState().holder, null, 'a refused claim never leaves a holder behind');
});

test('a client entry that is registered but dead cannot claim or renew', async t => {
  // Second-round report N1, reproduced without a browser: one POST to /__dsh_comfyui/state puts a
  // client in the Map, and `server_info` hides it after 60s while the entry stays — so an
  // existence check let a scripted caller take the canvas and keep renewing it forever.
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  await callComfyTool(rt, 'lease', { op: 'release' }, { dshSessionId: 'A' });

  const stale = panel('pGhost', 'ghost'); stale.seen = Date.now() - 70 * 1000;
  rt.clients.set('pGhost', stale);
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'ghost' }), /没有活着的页面/,
    'a dead page is not a page');
  assert.equal(rt.leaseState().holder, null, 'and the refusal leaves the canvas free for the next real panel');

  // The same entry cannot keep an established lease alive by renewing it either.
  rt.clients.set('pA', panel('pA', 'A'));
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 2 }] }, { dshSessionId: 'A' });
  rt.clients.set('pA', Object.assign(panel('pA', 'A'), { seen: Date.now() - 70 * 1000 }));
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'A' }), /没有活着的页面/,
    'renewal is not exempt: that exemption was the permanent-occupation vector');
  const ttlMs = rt.leaseState().ttlMs;
  rt.lease.renewedAt = Date.now() - ttlMs - 1000;
  assert.equal(rt.leaseState().holder, null, 'the TTL still ends it on silence');
  assert.equal(rt.leaseState().holderAlive, false);
});

test('a holder whose page is gone can still hand the lease back', async t => {
  // Release is the one operation that must work without a live page: leaving the canvas reserved
  // for a conversation that cannot use it is exactly what the user would feel.
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  rt.clients.delete('pA');
  const released = await callComfyTool(rt, 'lease', { op: 'release' }, { dshSessionId: 'A' });
  assert.equal(released.structuredContent.holder, null, 'the holder may always hand it back');
});

test('a call that fails its own validation never takes the lease', async t => {
  // Second-round report N2, reproduced through the MCP path: `upload_image` with a nodeId that does
  // not exist came back "目标图片参数不存在" and left `lease(who)` holding the caller's session for a
  // full TTL. The lease is now taken at the page dispatch, so a refusal that never dispatched one
  // cannot reserve the canvas.
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  const dispatched = [];
  rt.dispatch = async (client, action) => {
    dispatched.push({ sessionId: client.sessionId, action });
    return action === 'list_nodes' ? { nodes: [{ id: '5', widgets: [{ name: 'image' }] }] } : { bound: true };
  };
  await assert.rejects(callComfyTool(rt, 'upload_image',
    { dataBase64: Buffer.from('fixture').toString('base64'), mediaType: 'image/png', nodeId: '999' }, { dshSessionId: 'A' }),
    /目标图片参数不存在/);
  assert.deepEqual(dispatched.map(item => item.action), ['list_nodes'], 'only the read ran');
  assert.equal(rt.leaseState().holder, null, 'and the refused call left no holder behind');

  // Control: the same shape does take the lease when a write is really dispatched.
  dispatched.length = 0;
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: '5', widget: 'image', value: 'x.png' }] }, { dshSessionId: 'A' });
  assert.deepEqual(dispatched.map(item => item.action), ['list_nodes', 'update_nodes', 'audit_graph']);
  assert.equal(rt.leaseState().holder, 'A', 'a dispatched write is what reserves the canvas');
});

test('a page-side failure gives back the lease this call just took', async t => {
  // Third-round N10: `switch_workflow` with a path that does not exist is an ordinary business
  // refusal, but the lease had already been taken at the dispatch and nothing returned it — the
  // canvas stayed locked to the conversation that failed, for the full TTL.
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.dispatch = async () => { throw new Error('工作流不存在，请先 list_workflows 获取准确 path'); };
  await assert.rejects(callComfyTool(rt, 'switch_workflow', { path: 'workflows/nope.json' }, { dshSessionId: 'A' }), /工作流不存在/);
  assert.equal(rt.leaseState().holder, null, 'a refused page action releases what this call established');

  // An established holder is not evicted by its own failed write: that is the same owner retrying,
  // and dropping its lease mid-session would let another conversation move the canvas under it.
  await callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'A' });
  await assert.rejects(callComfyTool(rt, 'switch_workflow', { path: 'workflows/nope.json' }, { dshSessionId: 'A' }), /工作流不存在/);
  assert.equal(rt.leaseState().holder, 'A', 'the lease it already had survives the failure');
});

test('a holder whose page is gone stops blocking others in 15 seconds, not 5 minutes', async t => {
  // Third-round N1 residual: a ghost that claimed the canvas inside its 10-second live window and
  // then vanished held a lock nobody could use — its own next write would be refused by the live
  // guard, so the TTL was only ever serving a conversation that could not write.
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  assert.equal(rt.leaseState().holder, 'A');

  rt.clients.set('pA', Object.assign(panel('pA', 'A'), { seen: Date.now() - 20 * 1000 }));
  rt.lease.renewedAt = Date.now() - 16 * 1000;
  assert.equal(rt.leaseState().holder, null, 'dead page + idle past the abandonment grace lifts the lock');

  // While the page is still live, idleness alone is patience: the TTL stays the only clock.
  const rt2 = await runtime(); t.after(() => rt2.stop());
  rt2.clients.set('pA', panel('pA', 'A'));
  rt2.dispatch = async () => ({ nodes: [] });
  await callComfyTool(rt2, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  rt2.lease.renewedAt = Date.now() - 16 * 1000;
  assert.equal(rt2.leaseState().holder, 'A', 'a live page keeps its lease through the same silence');
  assert.equal(rt2.leaseState().abandonedAfterMs, 15000, 'and the reply reports both clocks');
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
  const original = ComfyRuntime.prototype.dispatch;
  ComfyRuntime.prototype.dispatch = async function (client, action) {
    dispatched.push({ sessionId: client.sessionId, action });
    return action === 'list_nodes' ? { nodes: [{ id: '5', widgets: [{ name: 'image' }] }] } : { bound: true };
  };
  // A lease claim now needs a panel for that conversation. This test is about *ordering* — the
  // lease before the upload — so every session gets a connected page instead of a panel assertion.
  const claimed = [];
  const originalAcquire = ComfyRuntime.prototype.acquireLease;
  ComfyRuntime.prototype.acquireLease = function (sessionId, force) {
    claimed.push(sessionId);
    this.clients.set('panel-' + sessionId, panel('panel-' + sessionId, sessionId));
    return originalAcquire.call(this, sessionId, force);
  };
  t.after(async () => {
    ComfyRuntime.prototype.dispatch = original;
    ComfyRuntime.prototype.acquireLease = originalAcquire;
    for (const dispose of effects.reverse()) await dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
  });
  await apply(ctx);
  const execWith = (id, picture) => ({ agent: { session: { id, deriveMessages: () => [{ id: 'human-' + id, role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: picture }] }] } }, signal: new AbortController().signal });
  const exec = id => execWith(id, attachment);
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

  // The guard that costs nothing: an attachment that can never be uploaded is refused before the
  // canvas is claimed, so a mistyped call does not lock the graph for its TTL.
  const claimsBefore = claimed.length;
  await assert.rejects(tool('upload_image').execute({ attachmentId: 'not-an-image', nodeId: '5' },
    execWith('B', { attachmentId: 'not-an-image', mediaType: 'application/pdf', width: 1, height: 1 })), /只支持 PNG/);
  assert.equal(claimed.length, claimsBefore, 'the lease was never claimed for a doomed upload');
  assert.equal(uploads.length, 1, 'and nothing was uploaded either');
});
