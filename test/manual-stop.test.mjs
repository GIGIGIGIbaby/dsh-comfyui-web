import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualStopGuard } from '../lib/manual-stop.js';
import { GenerationMonitor } from '../lib/generation.js';
import { TaskStore } from '../lib/state.js';
import { callComfyTool } from '../lib/mcp.js';
import { resumeCompletionJob } from '../lib/completion-job.js';

test('manual stop blocks new prompts until human input, ignores notices, stays scoped and survives restart', async t => {
  const file = join(await mkdtemp(join(tmpdir(), 'dsh-comfy-stop-')), 'tasks.json');
  const messages = [{ id: 'human-1', role: 'user', source: { kind: 'user' } }];
  const session = { id: 'owner', deriveMessages: () => messages };
  let submissions = 0;
  const runtime = { url: 'http://127.0.0.1:8188', mcpEnabled: true,
    command: async () => { submissions++; return { prompt_id: 'next' }; } };
  const monitor = runtime.generations = new GenerationMonitor(runtime);
  // No sockets or upstream requests: settle history exactly as the monitor does.
  monitor.schedule = () => {}; monitor.connect = async () => {};
  t.after(() => runtime.generations.stop());
  await monitor.restore(await new TaskStore(file).start());
  const guard = runtime.manualStopGuard = new ManualStopGuard(runtime, id => id === session.id ? session : undefined);
  runtime.tasksChanged = () => guard.captureAll();
  const record = monitor.track('stopped', 'owner');
  monitor.fromHistory(record, { status: { status_str: 'error', messages: [['execution_interrupted', {}]] } });
  assert.equal(record.stopMessageId, 'human-1');
  assert.equal(record.result.retryAllowed, false);
  assert.equal(record.result.error, undefined);
  messages.push({ id: 'notice-1', role: 'user', source: { kind: 'tool-jobs', form: 'notice' } });
  messages.push({ id: 'model-1', role: 'assistant', source: { kind: 'model' } });
  await assert.rejects(callComfyTool(runtime, 'run', {}, { dshSessionId: 'owner' }), /本次 run 未提交/);
  assert.equal(submissions, 0);
  guard.check('other');
  await monitor.flush();
  const restored = runtime.generations = new GenerationMonitor(runtime);
  restored.schedule = () => {}; restored.connect = async () => {};
  await restored.restore(await new TaskStore(file).start());
  assert.equal(restored.owned('stopped', 'owner').stopMessageId, 'human-1');
  await assert.rejects(callComfyTool(runtime, 'run', {}, { dshSessionId: 'owner' }), /本次 run 未提交/);
  messages.push({ id: 'human-2', role: 'user', source: { kind: 'user' } });
  const next = await callComfyTool(runtime, 'run', {}, { dshSessionId: 'owner' });
  assert.equal(next.structuredContent.prompt_id, 'next'); assert.equal(submissions, 1);
  assert.equal(restored.owned('stopped', 'owner').stopReleased, true);
  await restored.flush();
  assert.equal((await new TaskStore(file).start()).records.find(r => r.promptId === 'stopped').stopReleased, true);
});

test('only confirmed interruptions and cancellations fence the conversation', () => {
  const session = { id: 'owner', deriveMessages: () => [{ id: 'request', role: 'user', source: { kind: 'user' } }] };
  for (const status of ['interrupted', 'cancelled', 'not_found', 'failed', 'completed']) {
    const record = { sessionId: 'owner', promptId: status, result: { status } };
    const runtime = { generations: { records: new Map([[status, record]]), changed() {} } };
    const guard = new ManualStopGuard(runtime, () => session);
    if (['interrupted', 'cancelled'].includes(status)) assert.throws(() => guard.check('owner'), /未提交/);
    else assert.doesNotThrow(() => guard.check('owner'));
  }
});

test('recovered interrupted notifications explicitly forbid retries before job_output is read', async () => {
  let hooks;
  const record = { promptId: 'recovered', sessionId: 'owner' };
  const jobs = { start(spec) { hooks = spec.run({ id: 'job', append() {} }); } };
  resumeCompletionJob(jobs, record, { wait: async () => ({ status: 'interrupted', finished: true }), changed() {} });
  const result = await hooks.done;
  assert.equal(result.status, 'killed');
  assert.match(result.detail, /主动中断，不是节点故障/);
  assert.match(result.detail, /不要修复、重试、重新提交或继续下一段/);
  assert.equal(JSON.parse(result.result).requiresUserInstruction, true);
});
