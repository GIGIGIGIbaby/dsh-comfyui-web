import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime } from '../lib/runtime.js';
import { callComfyTool } from '../lib/mcp.js';
import { planWrites, writeEnvelope } from '../lib/write-plan.js';

// A canvas fact shaped exactly like bridge.js list_nodes: writable is 'ok' | 'risky' | 'no',
// choices carries the canvas-side option list, kind is 'plain' | 'dom' | 'hidden' | 'shadowed'.
const node = (id, type, widgets) => ({ id: String(id), type, title: '', widgets });

const nodes = [
  node(195, 'AICG3DPromptSegmentSplit', [
    { name: 'mode', type: 'combo', kind: 'dom', value: '分隔线 ---', writable: 'risky', choices: ['分隔线 ---', '每行一段'] },
    { name: 'max_segments', type: 'number', kind: 'dom', value: 4, writable: 'risky' }
  ]),
  node(78, 'KSampler', [
    { name: 'steps', type: 'number', kind: 'plain', value: 25, writable: 'ok', min: 1, max: 100 },
    { name: 'mode', type: 'combo', kind: 'plain', value: 'T2VA', writable: 'ok', choices: ['T2VA', 'I2VA'] },
    { name: 'queue', type: 'button', kind: 'button', writable: 'no' }
  ])
];

// /object_info says what the server will accept; the canvas may offer a localized label the
// server converts at queue time, which is why both lists have to be consulted.
const defs = {
  KSampler: { input: { required: {
    steps: ['INT', { min: 1, max: 100, default: 25 }],
    mode: [['T2VA', 'I2VA'], {}]
  } } },
  AICG3DPromptSegmentSplit: { input: { required: {} } }
};

test('a batch the server would reject is judged before anything is written', () => {
  const plan = planWrites({ defs, nodes, changes: [
    { nodeId: 78, widget: 'steps', value: 24 },
    { nodeId: 78, widget: 'steps', value: 250 }
  ] });
  assert.equal(plan.status, 'needs_input');
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].code, 'out-of-range');
  assert.deepEqual(plan.blocked[0].accepted, [1, 100]);
  assert.match(plan.blocked[0].reason, /超出|范围/);
  // The legal change is *planned* but the whole batch stays unwritten: the note says so, and
  // the summary leads with the count so a model skimming the first line still sees the refusal.
  assert.equal(plan.planned.length, 1);
  assert.match(plan.note, /画布没有被修改/);
  assert.match(plan.summary, /needs_input/);
  assert.match(plan.summary, /1\/2 项/);
});

test('a stale nodeId answers with the ids that are actually on the canvas', () => {
  const plan = planWrites({ defs, nodes, changes: [{ nodeId: 999, widget: 'steps', value: 3 }] });
  assert.equal(plan.status, 'needs_input');
  assert.equal(plan.blocked[0].code, 'node-not-found');
  assert.match(plan.blocked[0].nextSteps, /list_nodes/);
});

test('a wrong widget name lists the writable names instead of the refused one', () => {
  const plan = planWrites({ defs, nodes, changes: [{ nodeId: 78, widget: 'step', value: 3 }] });
  assert.equal(plan.blocked[0].code, 'widget-not-found');
  assert.deepEqual(plan.blocked[0].accepted, ['steps', 'mode', 'queue']);
});

test('a button is not a parameter and says which action replaces it', () => {
  const plan = planWrites({ defs, nodes, changes: [{ nodeId: 78, widget: 'queue', value: true }] });
  assert.equal(plan.blocked[0].code, 'widget-not-writable');
  assert.match(plan.blocked[0].nextSteps, /run|save_workflow/);
});

test('a value outside the server options names the accepted ones', () => {
  const plan = planWrites({ defs, nodes, changes: [{ nodeId: 78, widget: 'mode', value: 'reference' }] });
  assert.equal(plan.blocked[0].code, 'value-not-in-server-options');
  assert.deepEqual(plan.blocked[0].accepted, ['T2VA', 'I2VA']);
  assert.deepEqual(plan.blocked[0].canvasChoices, ['T2VA', 'I2VA']);
});

test('a localized value the canvas itself offers is legal even when the server list differs', () => {
  // comfyui-AICG3D shows "每行一段" on the canvas; writing the canvas label is the path that works.
  const plan = planWrites({ defs, nodes, changes: [{ nodeId: 195, widget: 'mode', value: '每行一段' }] });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.planned[0].risk, 'high', 'a dom-owned control is flagged as high risk up front');
});

test('a numeric string is refused before it reaches a setter', () => {
  const plan = planWrites({ defs, nodes, changes: [{ nodeId: 78, widget: 'steps', value: '24' }] });
  assert.equal(plan.blocked[0].code, 'wrong-type');
  assert.match(plan.blocked[0].nextSteps, /裸值/);
});

test('an unreadable canvas plans nothing and refuses nothing', () => {
  // An empty node list means "could not see", not "you are wrong": the page stays the judge.
  const plan = planWrites({ defs, nodes: [], changes: [{ nodeId: 1, widget: 'seed', value: 3 }] });
  assert.equal(plan.status, 'unknown');
  assert.deepEqual(plan.blocked, []);
});

test('an unverified write is never reported as written', () => {
  const envelope = writeEnvelope({ changed: [
    { nodeId: '78', widget: 'steps', before: 25, after: 26, via: 'native-setter', verified: true },
    { nodeId: '195', widget: 'text', before: '', after: '', via: 'dom-setter', verified: false, hint: '写控件回读不一致' }
  ] }, [{ nodeId: 78, widget: 'steps', value: 26 }, { nodeId: 195, widget: 'text', value: '镜1' }]);
  assert.equal(envelope.status, 'partial');
  assert.equal(envelope.unverified.length, 1);
  assert.equal(envelope.unverified[0].requested, '镜1', 'the envelope pairs the request with the readback');
  assert.equal(envelope.unverified[0].readBack, '');
  assert.equal(envelope.unverified[0].alternatives.length, 3);
  assert.match(envelope.summary, /1\/2 项/);
  assert.match(envelope.note, /dom-setter/);
});

test('a fully verified write carries no warning machinery', () => {
  const envelope = writeEnvelope({ changed: [{ nodeId: '78', widget: 'steps', before: 25, after: 26, via: 'native-setter', verified: true }] },
    [{ nodeId: 78, widget: 'steps', value: 26 }]);
  assert.equal(envelope.status, 'written');
  assert.equal(envelope.unverified, undefined);
});

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-plan-'));
  return new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
}

test('update_nodes refuses the batch at the tool surface and never dispatches a write', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', { id: 'pA', sessionId: 'A', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  const dispatched = [];
  rt.command = async (sessionId, action) => {
    dispatched.push(action);
    if (action === 'list_nodes') return { nodes };
    return { changed: [] };
  };
  rt.request = async path => {
    const type = decodeURIComponent(String(path).replace('/object_info/', ''));
    return { [type]: defs[type] };
  };
  const reply = await callComfyTool(rt, 'update_nodes',
    { changes: [{ nodeId: 78, widget: 'steps', value: 500 }] }, { dshSessionId: 'A' });
  assert.equal(reply.structuredContent.written, false);
  assert.equal(reply.structuredContent.status, 'needs_input');
  assert.deepEqual(dispatched, ['list_nodes'], 'nothing was sent to the canvas writer');
});

test('update_nodes still writes when the plan passes, and reports what landed', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', { id: 'pA', sessionId: 'A', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  rt.command = async (sessionId, action, payload) => {
    if (action === 'list_nodes') return { nodes };
    return { changed: payload.changes.map(change => ({ nodeId: String(change.nodeId), widget: change.widget, before: 25, after: change.value, via: 'native-setter', verified: true })) };
  };
  rt.request = async path => {
    const type = decodeURIComponent(String(path).replace('/object_info/', ''));
    return { [type]: defs[type] };
  };
  const reply = await callComfyTool(rt, 'update_nodes',
    { changes: [{ nodeId: 78, widget: 'steps', value: 26 }] }, { dshSessionId: 'A' });
  assert.equal(reply.structuredContent.status, 'written');
  assert.equal(reply.structuredContent.changed[0].after, 26);
  assert.deepEqual(reply.structuredContent.planned.map(item => item.widget), ['steps']);
});
