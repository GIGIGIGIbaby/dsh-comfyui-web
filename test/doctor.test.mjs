import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorReport } from '../lib/doctor.js';

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
  ...overrides
});

const byId = report => Object.fromEntries(report.checks.map(item => [item.id, item]));

test('a healthy environment is one verdict with the measured value behind every check', () => {
  const report = doctorReport(facts());
  assert.equal(report.kind, 'ok');
  assert.equal(report.failedChecks, undefined);
  assert.deepEqual(report.checks.map(item => item.id), [
    'mcp-enabled', 'comfyui-reachable', 'bridge-page', 'bridge-heartbeat', 'bridge-version',
    'ai-permission', 'write-lease', 'graph-executable', 'disk-output', 'active-workflow',
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

test('a store the front-end already gave up on is reported with its own cause and cure', () => {
  const report = doctorReport(facts({ draftStorage: { available: true, usedChars: 200, ownChars: 0, totalChars: 200, unavailable: true, keys: [], ownKeys: [] } }));
  assert.equal(report.kind, 'ok', 'a draft-store fault must not read as "the tools are broken"');
  const storage = byId(report)['draft-storage'];
  assert.equal(storage.ok, null);
  assert.match(storage.note, /标记为不可用/);
  assert.match(storage.note, /刷新页面/);
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
