import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationMonitor } from '../lib/generation.js';
import { runWithCompletionJob } from '../lib/completion-job.js';
import { callComfyTool } from '../lib/mcp.js';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
class FakeSocket extends EventTarget {
  constructor(url) {
    super(); this.url = String(url); this.readyState = 0;
    queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  emit(type, data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, data }) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function fixture(t) {
  const history = {}; const pending = new Set(); const running = new Set(); const requests = [];
  const runtime = { url: 'http://127.0.0.1:8188', mcpEnabled: true, async request(path) {
    requests.push(path);
    if (path === '/queue') return { queue_running: [...running].map(id => [0, id]), queue_pending: [...pending].map(id => [0, id]) };
    return { ...history };
  } };
  const monitor = runtime.generations = new GenerationMonitor(runtime, { WebSocketImpl: FakeSocket });
  t.after(() => monitor.stop());
  return { monitor, runtime, history, pending, running, requests };
}

test('queue WebSocket completion wakes event waiters once, without fixed-interval history polling', async t => {
  const { monitor, history, pending, requests } = fixture(t);
  await monitor.connect(); assert.match(monitor.socket.url, /clientId=dsh-comfy-monitor-/);
  pending.add('image'); monitor.track('image', 'owner'); await flush();
  assert.equal(monitor.owned('image', 'owner').status, 'queued');
  const count = requests.length; await flush(); assert.equal(requests.length, count);
  monitor.socket.emit('progress', { prompt_id: 'image', value: 1, max: 10 }); await flush();
  assert.equal(monitor.owned('image', 'owner').progress.value, 1);
  assert.equal(requests.length, count, 'preview progress must not trigger history polling');
  const wait = monitor.wait('image', 'owner');
  history.image = { status: { completed: true, status_str: 'success', messages: [['execution_success', {}]] },
    outputs: { 9: { images: [{ filename: 'image.png', subfolder: '', type: 'output' }] } } };
  pending.clear(); monitor.socket.emit('status', { status: { exec_info: { queue_remaining: 0 } } });
  const result = await wait;
  assert.equal(result.status, 'completed'); assert.equal(result.finished, true); assert.equal(result.images[0].nodeId, '9');
  const settled = monitor.owned('image', 'owner').result;
  monitor.socket.emit('status', {}); monitor.socket.emit('status', {}); await flush();
  assert.equal(monitor.owned('image', 'owner').result, settled);
  await assert.rejects(monitor.wait('image', 'another'), /当前对话/);
});

test('cached completion, errors, interruptions and a lost pending task remain distinct', async t => {
  const { monitor, history } = fixture(t); await monitor.connect();
  history.cached = { status: { status_str: 'success' }, outputs: {} };
  history.failed = { status: { status_str: 'error', messages: [['execution_error', { node_id: '8', exception_message: 'OOM' }]] } };
  history.interrupted = { status: { status_str: 'error', messages: [['execution_interrupted', {}]] } };
  for (const id of ['cached', 'failed', 'interrupted', 'deleted']) monitor.track(id, 'owner');
  const results = await Promise.all(['cached', 'failed', 'interrupted', 'deleted'].map(id => monitor.wait(id, 'owner')));
  assert.deepEqual(results.map(r => r.status), ['completed', 'failed', 'interrupted', 'not_found']);
  assert.equal(results[1].error.message, 'OOM'); assert.equal(results[3].finished, false);
  assert.equal(results[2].retryAllowed, false); assert.equal(results[2].requiresUserInstruction, true);
  assert.match(results[2].message, /主动中断，不是节点故障/);
  assert.equal(results[3].retryAllowed, false);
});

test('event wait timeout and abort do not cancel, resubmit or consume completion for other waiters', async t => {
  const { monitor, pending, history } = fixture(t); await monitor.connect(); pending.add('slow'); monitor.track('slow', 'owner');
  const timed = await monitor.wait('slow', 'owner', undefined, 1); assert.equal(timed.timedOut, true); assert.equal(timed.finished, false);
  const controller = new AbortController(); const aborted = monitor.wait('slow', 'owner', controller.signal);
  controller.abort(new Error('cancel wait')); await assert.rejects(aborted, /cancel wait/);
  assert.equal(monitor.active.length, 1);
  history.slow = { status: { status_str: 'success' }, outputs: {} }; pending.clear(); monitor.socket.emit('status', {});
  assert.equal((await monitor.wait('slow', 'owner')).status, 'completed');
});

test('reconnection reconciles an event missed while offline, keeping the frontend client id untouched', async t => {
  const { monitor, pending, history } = fixture(t); await monitor.connect(); pending.add('offline'); monitor.track('offline', 'owner'); await flush();
  const identity = new URL(monitor.socket.url).searchParams.get('clientId'); monitor.socket.close();
  history.offline = { status: { status_str: 'success' }, outputs: {} }; pending.clear();
  await monitor.connect();
  assert.equal(new URL(monitor.socket.url).searchParams.get('clientId'), identity);
  assert.equal((await monitor.wait('offline', 'owner')).status, 'completed');
});

test('MCP run submits once and independent clients wait for owned prompt completion', async t => {
  const { runtime, monitor, pending, history } = fixture(t); let submitted = 0;
  runtime.command = async () => { submitted++; pending.add('prompt'); return { submitted: true, prompt_id: 'prompt' }; };
  const run = await callComfyTool(runtime, 'run', {}, { dshSessionId: 'owner' });
  assert.equal(run.structuredContent.completionEvents, true); assert.equal(submitted, 1);
  const waiting = callComfyTool(runtime, 'wait_for_completion', { promptId: 'prompt' }, { dshSessionId: 'owner' });
  await assert.rejects(callComfyTool(runtime, 'wait_for_completion', { promptId: 'prompt' }, { dshSessionId: 'other' }), /当前对话/);
  history.prompt = { status: { status_str: 'success' }, outputs: {} }; pending.clear(); monitor.socket.emit('status', {});
  assert.equal((await waiting).structuredContent.finished, true); assert.equal(submitted, 1);
});

test('dsh background completion job is owned, reports once, and cancels only monitoring', async t => {
  const { monitor, pending, history } = fixture(t); await monitor.connect();
  let hooks, spec; let submitted = 0;
  const jobs = { start(value) { spec = value; hooks = value.run({ id: 'comfyui-1', append() {}, updateProgress() {} }); return 'comfyui-1'; } };
  const invoke = async () => {
    submitted++; pending.add('notify'); monitor.track('notify', 'owner');
    return { content: [], structuredContent: { prompt_id: 'notify', submitted: true } };
  };
  const result = await runWithCompletionJob(jobs, 'owner', invoke, monitor);
  assert.equal(spec.owner, 'owner'); assert.equal(spec.kind, 'comfyui');
  assert.equal(result.structuredContent.job_id, 'comfyui-1'); assert.equal(result.structuredContent.completionNotification, true);
  history.notify = { status: { status_str: 'success' }, outputs: {} }; pending.clear(); monitor.socket.emit('status', {});
  assert.equal((await hooks.done).status, 'completed'); assert.equal(submitted, 1);
  await runWithCompletionJob(jobs, 'owner', async () => {
    pending.add('still-generating'); monitor.track('still-generating', 'owner'); return { structuredContent: { prompt_id: 'still-generating' } };
  }, monitor);
  hooks.cancel('stop notification'); assert.equal((await hooks.done).status, 'killed');
  assert.equal(monitor.owned('still-generating', 'owner').result, undefined);
  assert.equal(monitor.owned('still-generating', 'owner').notificationDisabled, true);
  await runWithCompletionJob(jobs, 'owner', async () => {
    pending.add('restart'); monitor.track('restart', 'owner'); return { structuredContent: { prompt_id: 'restart' } };
  }, monitor);
  hooks.cancel('owner disposed'); await hooks.done;
  assert.notEqual(monitor.owned('restart', 'owner').notificationDisabled, true, 'process teardown must not permanently disable recovered notifications');
  let unsafeSubmissions = 0;
  assert.throws(() => runWithCompletionJob({ start() { throw new Error('no controller'); } }, 'owner', async () => { unsafeSubmissions++; }, monitor), /no controller/);
  assert.equal(unsafeSubmissions, 0, 'failed job admission must never submit a generation');
});

test('minimal agents submit once without a job controller and retain event-driven completion results', async t => {
  const { runtime, monitor, pending, history } = fixture(t);
  let submissions = 0, starts = 0;
  runtime.command = async () => {
    submissions++; pending.add('minimal'); return { submitted: true, prompt_id: 'minimal' };
  };
  const jobs = { start() {
    starts++;
    throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)');
  } };
  const result = await runWithCompletionJob(jobs, 'owner',
    signal => callComfyTool(runtime, 'run', {}, { dshSessionId: 'owner' }, signal), monitor);
  assert.equal(submissions, 1); assert.equal(starts, 1);
  assert.equal(result.structuredContent.submitted, true);
  assert.equal(result.structuredContent.completionEvents, true);
  assert.equal(result.structuredContent.completionNotification, false);
  assert.match(result.structuredContent.completionNotificationReason, /不会自动唤醒 AI/);
  assert.equal(JSON.parse(result.content[0].text).completionNotification, false);
  assert.equal(result.structuredContent.job_id, undefined);
  const waiting = monitor.wait('minimal', 'owner');
  history.minimal = { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: 'minimal.png' }] } } };
  pending.clear(); monitor.socket.emit('status', {});
  assert.equal((await waiting).images[0].filename, 'minimal.png');
  assert.equal(submissions, 1, 'completion must not submit another generation');
});

test('an absent jobs service uses the same submission, preserves abort and returns original failures', async () => {
  const controller = new AbortController(); let submissions = 0;
  const result = await runWithCompletionJob(undefined, 'owner', async signal => {
    submissions++; assert.equal(signal, controller.signal);
    return { content: [], structuredContent: { submitted: true, prompt_id: 'no-service' } };
  }, {}, controller.signal);
  assert.equal(submissions, 1); assert.equal(result.structuredContent.completionNotification, false);
  const failure = { isError: true, content: [{ type: 'text', text: '面板连接已断开' }] };
  assert.equal(await runWithCompletionJob(undefined, 'owner', async () => failure, {}), failure);
});

test('capacity failures and exceptions after the producer starts never trigger a second submission', async () => {
  let submissions = 0;
  const invoke = async () => { submissions++; return { isError: true, content: [{ type: 'text', text: 'fixture' }] }; };
  assert.throws(() => runWithCompletionJob({ start() { throw new Error('background job limit reached for this owner'); } },
    'owner', invoke, {}), /job limit/);
  assert.equal(submissions, 0);
  let hooks;
  const jobs = { start(spec) {
    hooks = spec.run({ id: 'fixture-job' });
    throw new Error('background jobs unavailable: no job controller serves this agent');
  } };
  assert.throws(() => runWithCompletionJob(jobs, 'owner', invoke, {}), /no job controller/);
  await hooks.done;
  assert.equal(submissions, 1, 'an invoked producer must never fall back and run again');
});
