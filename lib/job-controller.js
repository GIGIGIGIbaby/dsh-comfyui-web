// Install the official controller only after admission confirms it is absent.
// Loading below agent.ctx keeps its tools and notifications in that session.
export function createJobControllerLoader(ctx, loadPlugin = () => import('@deepseek-ai/dsh-tool-jobs')) {
  const loading = new WeakMap(), fibers = new Set();
  let stopped = false;
  ctx.effect(() => async () => {
    stopped = true;
    await Promise.allSettled([...fibers].map(fiber => fiber.dispose()));
    fibers.clear();
  });
  return agent => {
    if (loading.has(agent)) return loading.get(agent);
    const work = (async () => {
      if (stopped || typeof agent.ctx?.plugin !== 'function') throw new Error('当前 dsh 未提供会话内插件加载能力');
      const plugin = await loadPlugin();
      if (stopped) throw new Error('ComfyUI 插件已关闭');
      const fiber = agent.ctx.plugin(plugin, { completionDelivery: 'wakeup' });
      fibers.add(fiber);
      try {
        await fiber.await();
        const missing = Object.keys(fiber.inject || {}).filter(name => fiber.ctx.get(name) === undefined);
        if (missing.length) throw new Error('后台任务控制器缺少服务：' + missing.join(', '));
        fiber.ctx.effect(() => () => { fibers.delete(fiber); loading.delete(agent); });
      } catch (error) {
        fibers.delete(fiber);
        await fiber.dispose();
        throw error;
      }
    })();
    loading.set(agent, work);
    work.catch(() => { if (loading.get(agent) === work) loading.delete(agent); });
    return work;
  };
}
