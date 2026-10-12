import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs';
import { createJobControllerLoader } from '../lib/job-controller.js';
import { runWithCompletionJob, resumeCompletionJob } from '../lib/completion-job.js';

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-jobs-local'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { createScope } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('official controller loads once per minimal agent, wakes its owner, injects while busy and leaves standard controllers alone', async t => {
  const ctx = new Context(), agents = new Map(), registered = [];
  ctx.provide('agents', { get: id => agents.get(id) });
  ctx.provide('tools', { register: tool => { registered.push(tool.name); return () => {}; } });
  ctx.provide('systemPrompt', { section() {}, getSectionOrder: () => 0 });
  await ctx.plugin(LocalJobRegistry, {});
  const jobs = ctx.get('jobs');
  let loads = 0;
  const ensure = createJobControllerLoader(ctx, async () => { loads++; return toolJobs; });
  const scopes = [];
  t.after(async () => {
    for (const scope of scopes) await scope.dispose();
    await ctx.fiber.dispose();
  });
  function agent(id) {
    const scope = createScope(ctx, {}); scopes.push(scope);
    const owner = { id, session: { id }, ctx: scope.ctx, status: 'idle', followups: [], injections: [],
      followup(message) { this.followups.push(message); }, inject(message) { this.injections.push(message); } };
    agents.set(id, owner); return owner;
  }
  const a = agent('minimal-a'), b = agent('minimal-b'), standard = agent('standard');
  assert.throws(() => jobs.start({ kind: 'comfyui', owner: a.id, label: 'before', run() {} }), /no job controller/);
  await Promise.all([ensure(a), ensure(a)]);
  assert.equal(loads, 1); assert.equal(registered.length, 3);
  // A's scoped controller must not accidentally admit B's work globally.
  assert.throws(() => jobs.start({ kind: 'comfyui', owner: b.id, label: 'foreign', run() {} }), /no job controller/);
  let submitted = 0;
  const completions = new Map(), records = new Map();
  const monitor = { owned(id) { return records.get(id); }, wait(id) { return completions.get(id).promise; }, changed() {} };
  function invoke(id) {
    let resolve;
    completions.set(id, { promise: new Promise(r => { resolve = r; }), finish: result => resolve(result) });
    records.set(id, {});
    return async () => { submitted++; return { content: [], structuredContent: { prompt_id: id, submitted: true } }; };
  }
  const resultA = await runWithCompletionJob(jobs, a.id, invoke('a1'), monitor, undefined, () => ensure(a));
  assert.equal(resultA.structuredContent.completionNotification, true);
  completions.get('a1').finish({ finished: true, status: 'completed', prompt_id: 'a1' }); await flush();
  assert.equal(a.followups.length, 1); assert.equal(a.injections.length, 0); assert.equal(b.followups.length, 0);
  assert.equal(a.followups[0].source.kind, 'tool-jobs');
  const resultB = await runWithCompletionJob(jobs, b.id, invoke('b1'), monitor, undefined, () => ensure(b));
  assert.equal(resultB.structuredContent.completionNotification, true); assert.equal(loads, 2);
  b.status = 'running';
  completions.get('b1').finish({ finished: true, status: 'completed', prompt_id: 'b1' }); await flush();
  assert.equal(b.followups.length, 0); assert.equal(b.injections.length, 1);
  assert.equal(a.followups.length, 1, 'another session completion must not wake A again');
  await standard.ctx.plugin(toolJobs, {});
  await runWithCompletionJob(jobs, standard.id, invoke('s1'), monitor, undefined, () => ensure(standard));
  completions.get('s1').finish({ finished: true, status: 'completed', prompt_id: 's1' }); await flush();
  assert.equal(loads, 2, 'an existing standard controller must not get a second controller');
  assert.equal(standard.followups.length, 1); assert.equal(submitted, 3);
});

test('recovered tasks attach the missing controller once without resubmitting or duplicating notices', async t => {
  const ctx = new Context();
  const scope = createScope(ctx, {}), notices = [];
  const owner = { id: 'recover', session: { id: 'recover' }, ctx: scope.ctx, status: 'idle',
    followup: message => notices.push(message), inject: message => notices.push(message) };
  ctx.provide('agents', { get: id => id === owner.id ? owner : undefined });
  ctx.provide('tools', { register() {} });
  ctx.provide('systemPrompt', { section() {}, getSectionOrder: () => 0 });
  await ctx.plugin(LocalJobRegistry, {});
  const ensure = createJobControllerLoader(ctx);
  t.after(async () => { await scope.dispose(); await ctx.fiber.dispose(); });
  let finish, waits = 0;
  const complete = new Promise(resolve => { finish = resolve; });
  const record = { sessionId: owner.id, promptId: 'existing' };
  const monitor = { wait(id) { assert.equal(id, 'existing'); waits++; return complete; }, changed() {} };
  await Promise.all([resumeCompletionJob(ctx.jobs, record, monitor, () => ensure(owner)),
    resumeCompletionJob(ctx.jobs, record, monitor, () => ensure(owner))]);
  assert.equal(waits, 1);
  finish({ finished: true, status: 'completed', prompt_id: 'existing' }); await flush();
  assert.equal(notices.length, 1); assert.equal(record.notificationDelivered, true);
});
