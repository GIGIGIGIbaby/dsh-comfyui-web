import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime } from '../lib/runtime.js';
import { callComfyTool, draftEnvelope } from '../lib/mcp.js';
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

test('a cascade the pack caused is reported apart from the batch that caused it', () => {
  const envelope = writeEnvelope({
    changed: [{ nodeId: '195', widget: 'text', before: '', after: '镜1', via: 'dom-setter', verified: true }],
    settledMs: 600,
    cascaded: [{ fromNodeId: '195', nodeId: '107', type: 'AIC3D_H3Sequence', widget: 'segments', before: 1, after: 4 }],
    cascadedNote: '下游节点被联动改写了 1 处（node 107）'
  }, [{ nodeId: 195, widget: 'text', value: '镜1' }]);
  assert.equal(envelope.status, 'written');
  assert.deepEqual(envelope.cascaded.map(item => item.nodeId), ['107']);
  assert.match(envelope.cascadedNote, /node 107/);
});

test('a value the front-end debounce overwrites is reported as a partial write, not a success', () => {
  const envelope = writeEnvelope({
    changed: [{ nodeId: '195', widget: 'mode', before: '分隔线 ---', after: '每行一段', via: 'dom-setter', verified: true }],
    settledMs: 600,
    lateChange: [{ nodeId: '195', widget: 'mode', value: '分隔线 ---', now: 'overwritten' }]
  }, [{ nodeId: 195, widget: 'mode', value: '每行一段' }]);
  assert.equal(envelope.status, 'partial', 'the read-back was true and then became false');
  assert.equal(envelope.written, false);
  assert.match(envelope.summary, /600ms 后被前端防抖改写回去了/);
  assert.deepEqual(envelope.lateChange.map(item => item.now), ['overwritten']);
});

test('the settle evidence reaches the caller, not only the page result', () => {
  // Third-round N9: `settledMs` was read inside one sentence of copy and never copied into the
  // envelope, so every MCP reply looked like it had not waited even when the page had spent 600ms
  // diffing. The five existing assertions all read the raw page result, which is why 193 green
  // tests could not see the gap.
  const envelope = writeEnvelope({
    changed: [{ nodeId: '195', widget: 'text', before: '', after: '镜1', via: 'dom-setter', verified: true }],
    settledMs: 600,
    revertedWrites: [{ nodeId: '195', widget: 'text', docs: ['pack_doc'], note: '只在下一次序列化前有效' }],
    wiredInputs: [{ nodeId: '198', widget: 'prompt', linkId: 377 }],
    ambiguousTargets: [{ nodeId: '198', widget: 'prompt', sameName: 2 }]
  }, [{ nodeId: 195, widget: 'text', value: '镜1' }]);
  assert.equal(envelope.settledMs, 600, 'the wait the page paid is part of the reply');
  assert.deepEqual(envelope.revertedWrites.map(item => item.docs), [['pack_doc']]);
  assert.deepEqual(envelope.wiredInputs.map(item => item.linkId), [377]);
  assert.deepEqual(envelope.ambiguousTargets.map(item => item.sameName), [2]);
});

test('the panel state and the tab modified flag reach the caller too', () => {
  // Round 5 (R5-D): the page answers 「用户看得见吗」 and 「标签页标未保存了吗」, and the MCP envelope
  // dropped both — a caller reading only the reply could not tell a repainted panel from a stale one.
  const envelope = writeEnvelope({
    changed: [{ nodeId: '189', widget: 'media_state', before: 'v1', after: 'v2', via: 'native-setter',
      verified: true, panelRefreshed: true, quantized: { requested: 0.999, applied: 1, step: 0.01 } }],
    panels: { refreshed: [{ nodeId: '189', widget: 'media_state' }], refreshFailed: [], noVisiblePanel: [], note: '…' },
    dirtyMarked: true, warning: 'x'
  }, [{ nodeId: 189, widget: 'media_state', value: 'v2' }]);
  assert.deepEqual(envelope.panels.refreshed, [{ nodeId: '189', widget: 'media_state' }]);
  assert.equal(envelope.dirtyMarked, true);
  assert.equal(envelope.changed[0].panelRefreshed, true, 'the per-item facts travel inside changed[]');
  assert.equal(envelope.changed[0].quantized.step, 0.01);

  const quiet = writeEnvelope({ changed: [{ nodeId: '1', widget: 'steps', after: 20, via: 'value+callback', verified: true }] }, []);
  assert.equal(quiet.panels, undefined, 'a plain parameter write invents no panel story');
  assert.equal(quiet.dirtyMarked, undefined);
});

test('the draft store is described honestly whether it was measurable or not', () => {
  const unreadable = draftEnvelope({ available: false, blocking: '当前页面没有可枚举的 localStorage' });
  assert.equal(unreadable.unavailable, '当前页面没有可枚举的 localStorage');
  assert.equal(unreadable.usedChars, undefined, 'an unmeasured store must not report a size');

  const roomy = draftEnvelope({ available: true, usedChars: 1200, keys: [{ key: 'Comfy.Workflow.Draft.v2:x', chars: 1200 }] });
  assert.equal(roomy.usedChars, 1200);
  assert.deepEqual(roomy.keys, ['Comfy.Workflow.Draft.v2:x']);
  assert.match(roomy.advice, /不影响画布里的值/);

  const tight = draftEnvelope({ available: true, usedChars: 4_200_000, keys: [] });
  assert.match(tight.advice, /保存工作流草稿失败|Comfy.Workflow.Persist/);
});

test('a caller that passes one change at the top level is handed the exact payload to resend', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', { id: 'pA', sessionId: 'A', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  const dispatched = [];
  rt.command = async (sessionId, action) => { dispatched.push(action); return { nodes }; };
  const error = await callComfyTool(rt, 'update_nodes', { nodeId: 78, widget: 'steps', value: 26 }, { dshSessionId: 'A' })
    .then(() => null, failure => failure);
  assert.ok(error, 'a misplaced key must fail rather than plan an empty batch');
  assert.match(error.message, /参数名是 changes（收到的是 nodeId \/ widget \/ value）/);
  assert.match(error.message, /包进 changes 的一项里/);
  assert.deepEqual(error.example, { changes: [{ nodeId: 78, widget: 'steps', value: 26 }] }, 'the example is the caller\'s own value, ready to paste');
  assert.deepEqual(error.receivedKeys, ['nodeId', 'widget', 'value']);
  assert.deepEqual(dispatched, [], 'nothing reached the canvas');
});

test('list_nodes only speaks about notes when it has one to speak about', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', { id: 'pA', sessionId: 'A', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  rt.command = async () => ({ nodes: [{ id: '78', type: 'KSampler', widgets: [] }], workflowPath: 'workflows/H3.json' });

  const quiet = await callComfyTool(rt, 'list_nodes', {}, { dshSessionId: 'A' });
  assert.deepEqual(quiet.structuredContent, { nodes: [{ id: '78', type: 'KSampler', widgets: [] }], workflowPath: 'workflows/H3.json' },
    'a canvas with no known gotchas comes back exactly as the page sent it');

  await rt.noteStore.add('node:KSampler', 'steps above 30 times out on this box');
  await rt.noteStore.add('node:OtherNode', 'a note about a node that is not on this canvas');
  const noted = await callComfyTool(rt, 'list_nodes', {}, { dshSessionId: 'A' });
  assert.deepEqual(noted.structuredContent.nodes[0].usageNotes, ['steps above 30 times out on this box'],
    'the note rides along with the node it is about');
  assert.deepEqual(noted.structuredContent.usageNotes.map(group => group.target), ['node:KSampler'],
    'and a note for a type that is not on the canvas stays out of the reply');
});

test('a node whose controls are not built yet is answered as a wait, not as an empty widget list', () => {
  // R7-1: the page-side hint never reached the MCP path, because the two-phase plan blocked the change
  // first and only knew to print the widget names it was given — which for `ShowText|pysssss` mid-build
  // is an empty list, i.e. "pick one of nothing".
  const building = [{ id: '111', type: 'ShowText|pysssss', title: '', widgets: [] }];
  const plan = planWrites({ defs: {}, nodes: building, changes: [{ nodeId: 111, widget: 'text_0', value: '探针' }] });
  assert.equal(plan.status, 'needs_input');
  const blocked = plan.blocked[0];
  assert.equal(blocked.code, 'widgets-not-built');
  assert.match(blocked.reason, /一个控件都没有/);
  assert.match(blocked.nextSteps, /requestAnimationFrame/);
  assert.match(blocked.nextSteps, /等几秒|3\.5 秒/);
  assert.match(blocked.nextSteps, /本来就没有可写控件/, 'both causes stay listed, so the hint is not a guess');

  // A node that does have controls but the wrong name keeps the old, more specific answer.
  const named = planWrites({ defs, nodes, changes: [{ nodeId: 78, widget: 'seed', value: 1 }] });
  assert.equal(named.blocked[0].code, 'widget-not-found');
  assert.match(named.blocked[0].nextSteps, /steps/);
});

test('force relaxes the domain judgments at the tool surface too', async t => {
  // The page has its own force; the two-phase plan must not block first and make it meaningless (R6-7).
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', { id: 'pA', sessionId: 'A', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  const seen = [];
  rt.command = async (sessionId, action, payload) => {
    seen.push({ action, payload });
    if (action === 'list_nodes') return { nodes };
    return { changed: payload.changes.map(change => ({ nodeId: String(change.nodeId), widget: change.widget,
      before: 25, after: change.value, via: 'native-setter', verified: true, outOfRange: true })) };
  };
  rt.request = async path => {
    const type = decodeURIComponent(String(path).replace('/object_info/', ''));
    return { [type]: defs[type] };
  };

  const strict = await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 78, widget: 'steps', value: 500 }] }, { dshSessionId: 'A' });
  assert.equal(strict.structuredContent.status, 'needs_input', 'without force the batch is still refused before the canvas');
  assert.equal(strict.structuredContent.blocked[0].code, 'out-of-range');

  const forced = await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 78, widget: 'steps', value: 500 }], force: true }, { dshSessionId: 'A' });
  assert.equal(forced.structuredContent.status, 'written', 'with force the write goes through');
  assert.equal(forced.structuredContent.written, true);
  assert.equal(forced.structuredContent.planned[0].forced, 'out-of-range', 'and the plan says which judgment was relaxed');
  const writer = seen.find(call => call.action === 'update_nodes');
  assert.equal(writer.payload.force, true, 'the page is told force was used, so its own guards relax the same way');
  assert.equal(forced.structuredContent.changed[0].outOfRange, true, 'the per-item flag travels back through the envelope');
});

test('saveAfterWrite answers which moment reached the disk', async t => {
  // R5-H: the honest version of 「写完顺带保存」 — a pack can move the canvas after the save (AICG3D does,
  // measured at ~300 ms), so `{saved:true}` alone would be a promise the plugin cannot keep.
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', { id: 'pA', sessionId: 'A', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  const calls = [];
  rt.command = async (sessionId, action, payload) => {
    calls.push(action);
    if (action === 'list_nodes') return { nodes };
    if (action === 'update_nodes') return { changed: payload.changes.map(change => ({ nodeId: String(change.nodeId),
      widget: change.widget, before: 25, after: change.value, via: 'native-setter', verified: true })), canvasHash: 'hash-1' };
    if (action === 'save_workflow') return { saved: true, workflow: { path: 'workflows/H3.json' },
      savedStateHash: 'hash-1', canvasHash: 'hash-1', canvasMatchesSaved: true };
    if (action === 'graph_fingerprint') return { ok: true, savedHash: 'hash-1', canvasHash: 'hash-2', canvasMatchesSaved: false };
    return { usedChars: 100, available: true, keys: [] };
  };
  rt.request = async path => {
    const type = decodeURIComponent(String(path).replace('/object_info/', ''));
    return { [type]: defs[type] };
  };

  const reply = await callComfyTool(rt, 'update_nodes',
    { changes: [{ nodeId: 78, widget: 'steps', value: 26 }], saveAfterWrite: true }, { dshSessionId: 'A' });
  assert.deepEqual(calls.filter(action => action === 'save_workflow'), ['save_workflow'], 'the save ran once, after the write');
  assert.equal(reply.structuredContent.saved.path, 'workflows/H3.json');
  assert.equal(reply.structuredContent.saved.savedStateHash, 'hash-1');
  assert.equal(reply.structuredContent.saved.canvasHashAtSave, 'hash-1');
  assert.equal(reply.structuredContent.saved.canvasHashNow, 'hash-2');
  assert.equal(reply.structuredContent.saved.driftedAfterSave, true, 'the canvas moved after the save, and the reply says so');
  assert.match(reply.structuredContent.saved.driftNote, /再调一次 save_workflow/);

  // A save that fails must not be reported as a failed write — the canvas change already happened.
  rt.command = async (sessionId, action, payload) => {
    if (action === 'list_nodes') return { nodes };
    if (action === 'save_workflow') throw new Error('没有保存路径');
    return { changed: payload.changes.map(change => ({ nodeId: String(change.nodeId), widget: change.widget,
      before: 25, after: change.value, via: 'native-setter', verified: true })) };
  };
  const failed = await callComfyTool(rt, 'update_nodes',
    { changes: [{ nodeId: 78, widget: 'steps', value: 27 }], saveAfterWrite: true }, { dshSessionId: 'A' });
  assert.equal(failed.structuredContent.written, true, 'the write result survives a failed save');
  assert.match(failed.structuredContent.saveError, /画布写入已成功，但顺带保存失败/);
});

test('audit(op=writes) asks the page for the flags-only census and returns the classification', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', { id: 'pA', sessionId: 'A', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  const actions = [];
  rt.command = async (sessionId, action) => {
    actions.push(action);
    if (action !== 'audit_writes') throw new Error('unexpected action ' + action);
    return { workflowPath: 'workflows/H3.json', serializable: true, subgraphCount: 0,
      nodes: [{ id: '198', type: 'AICG3D_H3SelectedVideoContext', title: '', mode: 0, subgraph: null, widgetCount: 1,
        widgets: [{ name: 'prompt', kind: 'hidden', hasSetter: false, hasGetter: false, serializes: false,
          inOptions: null, optionCount: null, step: null, wired: 377, mirror: false, props: [] }], shadowDocs: [] }] };
  };
  rt.request = async path => {
    const type = decodeURIComponent(String(path).replace('/object_info/', ''));
    return { [type]: defs[type] || { input: { required: {} } } };
  };
  const reply = await callComfyTool(rt, 'audit', { op: 'writes' }, { dshSessionId: 'A' });
  assert.deepEqual(actions, ['audit_writes'], 'the census takes its own page action, not the structural one');
  assert.equal(reply.structuredContent.op, 'writes');
  assert.equal(reply.structuredContent.blocked, 1);
  assert.match(reply.structuredContent.blockedItems[0].note, /连线/);
  assert.equal(reply.structuredContent.verdict, 'refuted');

  await assert.rejects(callComfyTool(rt, 'audit', { op: 'nonsense' }, { dshSessionId: 'A' }), /graph \/ params \/ writes/);
});
