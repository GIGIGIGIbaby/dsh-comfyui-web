// The existing dsh job controller injects notices at step boundaries while an
// agent is busy, and follows up only when idle. It never cancels its active turn.
export function runWithCompletionJob(jobs, sessionId, invoke, monitor, signal) {
  let submitted;
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
          job.append('prompt_id: ' + data.prompt_id + '\n生成结束后用 get_image 检查结果；不需要 sleep 或轮询。\n');
          job.updateProgress('等待 ComfyUI 生成完成');
          submitted({ ...result, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
          const completion = await monitor.wait(data.prompt_id, sessionId, controller.signal);
          const status = completion.status === 'completed' ? 'completed' : completion.status === 'interrupted' ? 'killed' : 'failed';
          return { status, detail: 'ComfyUI ' + completion.status + '; prompt_id: ' + data.prompt_id, result: JSON.stringify(completion) };
        } catch (error) {
          submitted({ isError: true, content: [{ type: 'text', text: error.message }] });
          return { status: controller.signal.aborted ? 'killed' : 'failed',
            detail: controller.signal.aborted ? '通知等待已停止；生成未因此取消，请查 queue/history。' : error.message };
        }
      })();
      return { done, cancel(reason) { controller.abort(new Error(reason || '生成通知等待已取消')); } };
    }
  });
  return submission;
}
