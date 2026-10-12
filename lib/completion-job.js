// The existing dsh job controller injects notices at step boundaries while an
// agent is busy, and follows up only when idle. It never cancels its active turn.
export function runWithCompletionJob(jobs, sessionId, invoke, monitor, signal) {
  let submitted, record;
  const submission = new Promise(resolve => { submitted = resolve; });
  const controller = new AbortController();
  jobs.start({
    kind: 'comfyui', owner: sessionId, label: 'ComfyUI 生成完成通知',
    run(job) {
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
          if (completion.finished) { record.notificationDelivered = true; monitor.changed(); }
          const status = completion.status === 'completed' ? 'completed' : ['interrupted', 'cancelled'].includes(completion.status) ? 'killed' : 'failed';
          return { status, detail: 'ComfyUI ' + completion.status + '; prompt_id: ' + data.prompt_id, result: JSON.stringify(completion) };
        } catch (error) {
          submitted({ isError: true, content: [{ type: 'text', text: error.message }] });
          return { status: controller.signal.aborted ? 'killed' : 'failed',
            detail: controller.signal.aborted ? '通知等待已停止；生成未因此取消，请查 queue/history。' : error.message };
        }
      })();
      return { done, cancel(reason) { if (record && !['owner disposed', 'jobs service disposed'].includes(reason)) { record.notificationDisabled = true; monitor.changed(); } controller.abort(new Error(reason || '生成通知等待已取消')); } };
    }
  });
  return submission;
}
export function resumeCompletionJob(jobs, record, monitor) {
  const controller = new AbortController();
  jobs.start({ kind: 'comfyui', owner: record.sessionId, label: 'ComfyUI 恢复任务完成通知', run(job) {
    record.notificationAttached = true;
    job.append('恢复 prompt_id: ' + record.promptId + '；不会重复提交生成。\n');
    const done = monitor.wait(record.promptId, record.sessionId, controller.signal).then(completion => {
      if (completion.finished) { record.notificationDelivered = true; monitor.changed(); }
      return { status: completion.status === 'completed' ? 'completed' : ['interrupted', 'cancelled'].includes(completion.status) ? 'killed' : 'failed',
        detail: 'ComfyUI ' + completion.status + '; prompt_id: ' + record.promptId, result: JSON.stringify(completion) };
    }, error => ({ status: 'killed', detail: error.message }));
    return { done, cancel(reason) { if (!['owner disposed', 'jobs service disposed'].includes(reason)) { record.notificationDisabled = true; monitor.changed(); } controller.abort(new Error(reason || '通知等待已取消')); } };
  } });
}
