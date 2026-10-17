import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../lib/state.js';
import { GenerationMonitor } from '../lib/generation.js';
import { ManualStopGuard } from '../lib/manual-stop.js';
import { runWithCompletionJob, resumeCompletionJob } from '../lib/completion-job.js';

test('legacy missing-result records stay settled across reloads without jobs, requests or a manual-stop fence', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'dsh-comfy-unknown-')), 'tasks.json');
  const server = 'http://127.0.0.1:8188';
  await writeFile(file, JSON.stringify({ version: 1, tasks: [{ server, promptId: 'old-task', sessionId: 'owner',
    created: 1, status: 'not_found', stopMessageId: 'human-1',
    result: { status: 'not_found', finished: false, message: '停止本轮生成计划', requiresUserInstruction: true } }] }));
  let requests = 0, starts = 0, sockets = 0;
  const session = { id: 'owner', deriveMessages: () => [{ id: 'human-1', role: 'user', source: { kind: 'user' } }] };
  for (let reload = 0; reload < 3; reload++) {
    const runtime = { url: server, request() { requests++; throw new Error('should not re-query settled history'); } };
    const monitor = runtime.generations = new GenerationMonitor(runtime, { WebSocketImpl: class {
      constructor() { sockets++; throw new Error('should not reconnect a settled task'); }
    } });
    try {
      await monitor.restore(await new TaskStore(file).start());
      const record = monitor.owned('old-task', 'owner');
      assert.equal(monitor.active.length, 0);
      assert.equal(record.result.finished, false, 'do not claim generation completed');
      assert.equal(record.result.trackingEnded, true);
      assert.equal(record.result.interruptionConfirmed, false);
      assert.doesNotMatch(record.result.message, /停止本轮生成计划|可能被手动删除/);
      assert.doesNotThrow(() => new ManualStopGuard(runtime, () => session).check('owner'));
      resumeCompletionJob({ start() { starts++; } }, record, monitor);
      await monitor.flush();
    } finally { await monitor.stop(); }
  }
  assert.equal(requests, 0);
  assert.equal(sockets, 0);
  assert.equal(starts, 0);
});

test('a current task with unknown results ends its notification without reporting failure or manual interruption', async () => {
  let hooks, submissions = 0, starts = 0;
  const unknown = { prompt_id: 'missing', status: 'not_found', finished: false, trackingEnded: true };
  const record = { promptId: 'missing', sessionId: 'owner', result: unknown };
  const monitor = { owned: () => record, wait: async () => unknown, changed() {} };
  const jobs = { start(spec) { starts++; hooks = spec.run({ id: 'notify', append() {}, updateProgress() {} }); } };
  await runWithCompletionJob(jobs, 'owner', async () => {
    submissions++; return { content: [], structuredContent: { prompt_id: 'missing' } };
  }, monitor);
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'completed', 'the notification ended; generation itself remains unknown');
  assert.match(outcome.detail, /结果无法确认/);
  assert.doesNotMatch(outcome.detail, /停止本轮生成计划|ComfyUI failed/);
  const result = JSON.parse(outcome.result);
  assert.equal(result.finished, false);
  assert.equal(result.retryAllowed, false, 'unknown results must not cause duplicate submission');
  assert.equal(result.interruptionConfirmed, false);
  assert.equal(record.notificationDelivered, true);
  assert.equal(submissions, 1);
  record.notificationAttached = false;
  resumeCompletionJob(jobs, record, monitor);
  assert.equal(starts, 1);
});

test('an unfinished recovered task can settle as unknown once without being replayed', async () => {
  let hooks, finish, starts = 0;
  const record = { promptId: 'recovered', sessionId: 'owner' };
  const waiting = new Promise(resolve => { finish = resolve; });
  const jobs = { start(spec) { starts++; hooks = spec.run({ id: 'notify', append() {} }); } };
  const monitor = { wait: () => waiting, changed() {} };
  resumeCompletionJob(jobs, record, monitor);
  record.result = { status: 'not_found', finished: false, trackingEnded: true };
  finish(record.result);
  assert.equal((await hooks.done).status, 'completed');
  assert.equal(record.notificationDelivered, true);
  record.notificationAttached = false;
  resumeCompletionJob(jobs, record, monitor);
  assert.equal(starts, 1);
});
