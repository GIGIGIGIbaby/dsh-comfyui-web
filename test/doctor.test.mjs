import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorReport } from '../lib/doctor.js';
import { callComfyTool } from '../lib/mcp.js';

// The doctor is the one call that must answer "usable or not" — so its verdict is tested as a
// verdict, not as a field dump: same facts in, same kind out, and a warning never flips it to fail.
const client = overrides => ({
  sessionId: 'session-me', connected: true, heartbeatAgeMs: 42, refreshRequired: false,
  bridgeVersion: '0.5.12', bridgeProtocol: 6, allowAI: true, ready: true, ...overrides
});

const facts = overrides => ({
  mcpEnabled: true,
  pluginBridgeVersion: '0.5.12',
  pluginBridgeProtocol: 6,
  comfy: { reachable: true, version: '0.39.0' },
  clients: [client()],
  sessionId: 'session-me',
  lease: { holder: null },
  graph: {
    verdict: 'unresolved', workflowPath: 'workflows/H3.json',
    checks: [
      { id: 'saver-present', verdict: 'supported' },
      { id: 'dangling-required-input', verdict: 'unresolved', title: '悬空必填输入' }
    ]
  },
  draftStorage: { available: true, usedChars: 120, ownChars: 400, totalChars: 520, keys: [{ key: 'a', chars: 120 }], ownKeys: [{ key: 'b', kind: 'history', chars: 400 }] },
  promptQueued: { running: 0, pending: 0 },
  // R8-B: whether the canvas can build a submission prompt is an audit fact, handed to the doctor
  // the same way the graph verdict is — it is not re-derived here.
  prompt: { id: 'prompt-serializable', verdict: 'supported', count: 0 },
  ...overrides
});

const byId = report => Object.fromEntries(report.checks.map(item => [item.id, item]));

test('a healthy environment is one verdict with the measured value behind every check', () => {
  const report = doctorReport(facts());
  assert.equal(report.kind, 'ok');
  assert.equal(report.failedChecks, undefined);
  assert.deepEqual(report.checks.map(item => item.id), [
    'mcp-enabled', 'comfyui-reachable', 'bridge-page', 'bridge-heartbeat', 'bridge-stalled', 'bridge-version',
    'ai-permission', 'write-lease', 'graph-executable', 'prompt-serializable', 'disk-output', 'active-workflow',
    'draft-storage', 'queue-idle'
  ]);
  const checks = byId(report);
  assert.equal(checks['comfyui-reachable'].value, '0.39.0');
  assert.equal(checks['bridge-heartbeat'].value, '42ms');
  assert.equal(checks['bridge-version'].value, '0.5.12/6');
  assert.equal(checks['active-workflow'].value, 'workflows/H3.json');
  assert.equal(checks['write-lease'].value, 'free');
  // No check may pass by having no value: a green report without numbers is not evidence.
  for (const item of report.checks) {
    if (item.ok === true) assert.ok(item.value !== undefined && item.value !== null && item.value !== 'skipped', item.id + ' passed without measuring anything');
  }
});

test('a stale bridge is a failure that names the refresh, not a mystery', () => {
  const report = doctorReport(facts({ clients: [client({ bridgeVersion: '0.5.7', bridgeProtocol: 5 })] }));
  assert.equal(report.kind, 'fail');
  assert.deepEqual(report.failedChecks, ['bridge-version']);
  assert.equal(byId(report)['bridge-version'].value, '0.5.7/5');
  assert.match(report.firstAction, /刷新 ComfyUI 页面/);
});

test('a busy queue and a nearly full store are warnings, never a failed verdict', () => {
  // Both are states of the environment working. Reporting kind=fail during a render, or because
  // the browser is nearly out of quota, would teach the caller to ignore the verdict.
  const report = doctorReport(facts({
    promptQueued: { running: 1, pending: 2 },
    draftStorage: { available: true, usedChars: 3_600_000, ownChars: 900_000, totalChars: 3_600_000, keys: [], ownKeys: [] }
  }));
  assert.equal(report.kind, 'ok');
  const checks = byId(report);
  assert.equal(checks['queue-idle'].ok, null);
  assert.equal(checks['queue-idle'].value, 'running 1 / pending 2');
  assert.match(checks['queue-idle'].note, /正常状态/);
  assert.equal(checks['draft-storage'].ok, null);
  // The value has to say which half is which: "3.6M chars, 0 keys" read as a contradiction
  // until the count was split between ComfyUI's drafts and the bridge's own snapshots.
  assert.match(checks['draft-storage'].value, /ComfyUI 草稿 3600000（0 个键） \/ 桥接快照 900000（0 个键）/);
  assert.match(checks['draft-storage'].note, /5M/);
});

test('a store that cannot be written is reported with its own cause and cure', () => {
  const report = doctorReport(facts({ draftStorage: { available: true, usedChars: 200, ownChars: 0, totalChars: 200, unavailable: true, keys: [], ownKeys: [] } }));
  assert.equal(report.kind, 'ok', 'a draft-store fault must not read as "the tools are broken"');
  const storage = byId(report)['draft-storage'];
  assert.equal(storage.ok, null);
  assert.match(storage.note, /能读不能写/);
  assert.match(storage.note, /Comfy.Workflow.Persist/);
});

test('an unconfirmed saver is an open question, not a broken environment', () => {
  // `saver-present: unresolved` means the audit saw an output node whose name does not prove it
  // writes a file (rgthree's comparer, KJNodes' preview). Failing doctor for that would send the
  // model to "fix" a canvas that may be fine; passing it as confirmed would promise a file that
  // never arrives. Neither: report it and ask for a run.
  const uncertain = doctorReport(facts({ graph: { verdict: 'unresolved', workflowPath: 'workflows/H3.json',
    checks: [{ id: 'saver-present', verdict: 'unresolved' }] } }));
  assert.equal(uncertain.kind, 'ok', 'an unproven saver must not read as "the tools are broken"');
  assert.equal(byId(uncertain)['disk-output'].ok, null);
  assert.match(byId(uncertain)['disk-output'].note, /temp/);

  const none = doctorReport(facts({ graph: { verdict: 'refuted', workflowPath: 'workflows/H3.json',
    checks: [{ id: 'saver-present', verdict: 'refuted' }] } }));
  assert.equal(byId(none)['disk-output'].ok, false, 'no candidate at all is still a hard failure');
  assert.match(byId(none)['disk-output'].note, /get_image/);
});

test('a page that never connected says so once and skips what it cannot see', () => {
  const report = doctorReport(facts({ clients: [], graph: null, lease: { holder: 'session-other' } }));
  assert.equal(report.kind, 'fail');
  assert.deepEqual(report.failedChecks, ['bridge-page', 'bridge-heartbeat', 'bridge-version', 'ai-permission', 'write-lease']);
  const checks = byId(report);
  assert.match(checks['bridge-page'].note, /打开面板/);
  assert.match(checks['write-lease'].note, /不要自行 force 接管/);
  assert.equal(checks['graph-executable'].value, 'skipped');
});

test('a page whose commands never came back is a failure, not a green report over a dead tab', () => {
  // Round 7 (R7-7): the SSE stream stayed open, so `connected` and the heartbeat both said fine while
  // no tool could answer for 11.6 minutes. The two counters are the only thing that separates
  // 「页面在忙」 from 「页面里有等不到的回调」.
  const pageSide = doctorReport(facts({ clients: [client({ stalledCommands: 1 })] }));
  assert.equal(pageSide.kind, 'fail');
  assert.ok(pageSide.failedChecks.includes('bridge-stalled'), JSON.stringify(pageSide.failedChecks));
  assert.match(byId(pageSide)['bridge-stalled'].note, /刷新 ComfyUI 页面/);
  assert.match(byId(pageSide)['bridge-stalled'].note, /别重复提交/, 'and the note stops a resubmit of a save that may already be on disk');
  const transport = doctorReport(facts({ clients: [client({ timeouts: 2 })] }));
  assert.ok(transport.failedChecks.includes('bridge-stalled'), 'a command the page never answers is the same failure from the other side');
  const clean = doctorReport(facts());
  assert.equal(byId(clean)['bridge-stalled'].ok, true, 'zero unanswered commands is a measured pass, not a silent one');
  assert.equal(byId(clean)['bridge-stalled'].value, '0');
  assert.equal(byId(doctorReport(facts({ clients: [] })))['bridge-stalled'].ok, null, 'no page is no verdict, not a failure');
});
test('a canvas that serializes but cannot build a prompt is a failed verdict, not a green one', () => {
  // R8-B, measured on this machine: doctor returned kind:'ok' with 13 green checks while
  // audit(op=params) gave `prompt-serializable: refuted` on the SAME canvas — serialize() worked and
  // graphToPrompt() threw ("Attempted to access LGraph reference that was null or undefined.") because
  // subgraph proxies lost their definitions. run / get_workflow / audit(op=params) were half-dead and
  // the health check said the environment was fine. `graph-executable` cannot catch this: the
  // structural audit walks the node table and never builds a submission.
  const report = doctorReport(facts({ prompt: { id: 'prompt-serializable', verdict: 'refuted', count: 1,
    evidence: [{ note: 'Attempted to access LGraph reference that was null or undefined.' }] } }));
  assert.notEqual(report.kind, 'ok', 'a canvas that cannot produce a prompt is not a usable environment');
  assert.equal(report.kind, 'fail');
  assert.ok(report.failedChecks.includes('prompt-serializable'), JSON.stringify(report.failedChecks));
  const check = byId(report)['prompt-serializable'];
  assert.equal(check.ok, false);
  assert.equal(check.value, 'graphToPrompt failed');
  assert.match(check.note, /definitions/, 'the cure is the same one the audit gives: reload the full JSON');
  assert.match(check.note, /load_workflow/);
  assert.match(check.note, /LGraph/, 'the page error travels as the reason');
});

test('a page that never reported prompt serializability gets no verdict about it', () => {
  // Same convention as graph-serializable: an older bridge that says nothing is not judged for a fact
  // it never measured, and this must not become a silent pass either.
  const report = doctorReport(facts({ prompt: null }));
  assert.equal(report.kind, 'ok');
  const check = byId(report)['prompt-serializable'];
  assert.equal(check.ok, null);
  assert.equal(check.value, 'not reported');
  const pending = byId(doctorReport(facts({ prompt: { id: 'prompt-serializable', verdict: 'unresolved' } })));
  assert.equal(pending['prompt-serializable'].ok, null, 'an open question must not read as a pass');
  const skipped = byId(doctorReport(facts({ clients: [], graph: null })));
  assert.equal(skipped['prompt-serializable'].ok, null, 'no page is no verdict');
  assert.equal(skipped['prompt-serializable'].value, 'skipped');
});
test('the doctor asks the page for the prompt facts once and reuses the audit judgment', async () => {
  // R8-B end to end: the doctor must not re-derive "can this canvas produce a prompt?" — it hands the
  // same page reply to auditParams() the audit tool uses, so the two faces can never disagree. This
  // pins both halves: one round trip (no second command), and the check that reaches the report.
  const v = (overrides = {}) => ({ sessionId: 'session-me', connected: true, heartbeatAgeMs: 42,
    refreshRequired: false, bridgeVersion: '0.5.12', bridgeProtocol: 6, allowAI: true, ready: true, ...overrides });
  const defsByType = {
    KSampler: { input: { required: { steps: ['INT', { min: 1, max: 100 }] } } },
    SaveImage: { input: { required: { images: ['IMAGE'] } }, output_node: true }
  };
  const commands = [];
  const runtime = {
    mcpEnabled: true, bridgeVersion: '0.5.12', bridgeProtocol: 6, noteStore: null,
    status: () => ({ clients: [v()], syncClients: [v()], writeLease: null }),
    request: async path => path === '/system_stats' ? { system: { comfyui_version: '0.39.0' } }
      : path === '/queue' ? { queue_running: [], queue_pending: [] }
        : (() => { const type = decodeURIComponent(path.replace('/object_info/', '')); return { [type]: defsByType[type] }; })(),
    command: async (sessionId, action, args) => {
      commands.push([action, args]);
      return { nodes: [{ id: '1', type: 'KSampler', title: '', mode: 0,
        widgets: [{ name: 'steps', kind: 'int', type: 'number', value: 20 }], inputs: [], outputs: [] },
        { id: '2', type: 'SaveImage', title: '', mode: 0, widgets: [], inputs: [{ name: 'images', type: 'IMAGE', link: 1 }],
          outputs: [] }],
        serializable: true, workflowPath: 'workflows/H3.json',
        ...(action === 'audit_graph' && args.op === 'params' ? promptFacts : {}) };
    }
  };
  // serialize() succeeded (that is what auditGraph reads) but graphToPrompt() threw: the exact shape the
  // real page reports, from the machine where doctor said ok next to audit(op=params) refuted.
  const promptFacts = { serializedInputs: null, promptFailed: true,
    serializedError: 'Attempted to access LGraph reference that was null or undefined.' };

  const report = (await callComfyTool(runtime, 'doctor', {}, { dshSessionId: 'session-me' })).structuredContent;
  assert.equal(report.kind, 'fail', 'a tab that cannot build a prompt is not a usable environment');
  assert.ok(report.failedChecks.includes('prompt-serializable'), JSON.stringify(report.failedChecks));
  const check = report.checks.find(item => item.id === 'prompt-serializable');
  assert.equal(check.ok, false);
  assert.match(check.note, /definitions/);
  assert.match(check.note, /LGraph/, 'the page error travels into the doctor note');
  // One command, and it asked for the facts that carry the prompt — not a second round trip.
  assert.equal(commands.length, 1, 'the prompt check reuses the same page reply: ' + JSON.stringify(commands));
  assert.deepEqual(commands[0], ['audit_graph', { op: 'params' }]);

  // A healthy page keeps kind=ok and reports the pass with a measured value.
  promptFacts.serializedInputs = { 1: { steps: 20 } }; promptFacts.promptFailed = false;
  delete promptFacts.serializedError;
  const healthy = (await callComfyTool(runtime, 'doctor', {}, { dshSessionId: 'session-me' })).structuredContent;
  assert.equal(healthy.kind, 'ok');
  assert.equal(healthy.checks.find(item => item.id === 'prompt-serializable').ok, true);
});
