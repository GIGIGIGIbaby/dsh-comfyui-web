// The existing dsh job controller injects notices at step boundaries while an
// agent is busy, and follows up only when idle. It never cancels its active turn.
import { stopPolicy } from './manual-stop.js';
import { trackingEnded } from './generation.js';

function completionOutcome(completion, promptId) {
  const policy = stopPolicy(completion.status);
  const unknown = completion.status === 'not_found';
  return { status: completion.status === 'completed' || unknown ? 'completed'
    : ['interrupted', 'cancelled', 'monitor_stopped'].includes(completion.status) ? 'killed' : 'failed',
    // dsh's initial wake-up notice includes detail, but not result. Put the
    // stop instruction here so the model sees it before calling another tool.
    detail: (unknown ? 'ComfyUI 任务跟踪结束，结果无法确认' : 'ComfyUI ' + completion.status) + '; prompt_id: ' + promptId
      + (policy.message || completion.message ? '；' + (policy.message || completion.message) : ''),
    result: JSON.stringify({ ...completion, ...policy }) };
}
export const missingJobController = error => /^background jobs unavailable: no job controller serves this agent\b/.test(error?.message || '');

async function runWithoutCompletionJob(invoke, signal, controllerError) {
  const result = await invoke(signal);
  if (result.isError) return result;
  const data = { ...result.structuredContent, completionNotification: false,
    completionNotificationReason: '当前 Agent 未加载后台任务控制器。生成已提交，进度跟踪和结果自动展示正常，但完成后不会自动唤醒 AI；需要当场等待可用 wait_for_completion，勿 sleep 或重复 run。',
    ...(controllerError ? { completionControllerError: controllerError.message } : {}) };
  return { ...result, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function runWithCompletionJob(jobs, sessionId, invoke, monitor, signal, ensureController) {
  if (!jobs) return runWithoutCompletionJob(invoke, signal);
  let submitted, record;
  const submission = new Promise(resolve => { submitted = resolve; });
  const controller = new AbortController();
  let producerStarted = false;
  const spec = {
    kind: 'comfyui', owner: sessionId, label: 'ComfyUI 生成完成通知',
    run(job) {
      producerStarted = true;
      const done = (async () => {
        try {
          const result = await invoke(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
          if (result.isError) {
            submitted(result);
            return { status: 'failed', detail: result.content?.[0]?.text || '生成提交未确认；请检查 queue/history，勿重复提交。' };
          }
          const data = { ...result.structuredContent, job_id: job.id, completionNotification: true,
            jobType: 'completion_notification', cancelGenerationTool: 'interrupt' };
          record = monitor.owned(data.prompt_id, sessionId); record.notificationAttached = true;
          job.append('prompt_id: ' + data.prompt_id + '\n生成结束后用 get_image 检查结果；不需要 sleep 或轮询。\n');
          job.updateProgress('等待 ComfyUI 生成完成');
          submitted({ ...result, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
          const completion = await monitor.wait(data.prompt_id, sessionId, controller.signal);
          if (trackingEnded(completion)) { record.notificationDelivered = true; monitor.changed(); }
          return completionOutcome(completion, data.prompt_id);
        } catch (error) {
          submitted({ isError: true, content: [{ type: 'text', text: error.message }] });
          return { status: controller.signal.aborted ? 'killed' : 'failed',
            detail: controller.signal.aborted ? '通知等待已停止；生成未因此取消，请查 queue/history。' : error.message };
        }
      })();
      return { done, cancel(reason) { if (record && !['owner disposed', 'jobs service disposed'].includes(reason)) { record.notificationDisabled = true; monitor.changed(); } controller.abort(new Error(reason || '生成通知等待已取消')); } };
    }
  };
  try { jobs.start(spec); } catch (error) {
    // Only a known admission failure BEFORE the producer runs is safe to
    // bypass. Never retry a submission or conceal capacity/other job failures.
    if (!producerStarted && /^background jobs unavailable: (?:no job controller serves this agent\b|load @deepseek-ai\/dsh-jobs\b)/.test(error.message)) {
      if (missingJobController(error) && ensureController) return (async () => {
        try { await ensureController(); }
        catch (controllerError) { return runWithoutCompletionJob(invoke, signal, controllerError); }
        // No producer ran before controller admission, so this is not a retry
        // of generation. The second admission may submit exactly once.
        return runWithCompletionJob(jobs, sessionId, invoke, monitor, signal);
      })();
      return runWithoutCompletionJob(invoke, signal);
    }
    throw error;
  }
  return submission;
}
export function resumeCompletionJob(jobs, record, monitor, ensureController) {
  // A historical task with no available result has nothing left to wait for.
  // Keep it in list_tasks, but do not create a new job or wake the agent again.
  if (record.result?.status === 'not_found') return;
  if (record.notificationAttached || record.notificationDelivered || record.notificationDisabled) return;
  const controller = new AbortController();
  let producerStarted = false;
  const spec = { kind: 'comfyui', owner: record.sessionId, label: 'ComfyUI 恢复任务完成通知', run(job) {
    producerStarted = true;
    record.notificationAttached = true;
    job.append('恢复 prompt_id: ' + record.promptId + '；不会重复提交生成。\n');
    const done = monitor.wait(record.promptId, record.sessionId, controller.signal).then(completion => {
      if (trackingEnded(completion)) { record.notificationDelivered = true; monitor.changed(); }
      return completionOutcome(completion, record.promptId);
    }, error => ({ status: 'killed', detail: error.message }));
    return { done, cancel(reason) { if (!['owner disposed', 'jobs service disposed'].includes(reason)) { record.notificationDisabled = true; monitor.changed(); } controller.abort(new Error(reason || '通知等待已取消')); } };
  } };
  try { jobs.start(spec); } catch (error) {
    if (!producerStarted && missingJobController(error) && ensureController) return ensureController()
      .then(() => resumeCompletionJob(jobs, record, monitor));
    throw error;
  }
}
