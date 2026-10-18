// One call that answers "is this environment usable right now?" — the doctor entry every
// other tool assumes has already passed. It is deliberately a verdict and not a field dump:
// the caller should learn what is broken from `kind`, then read the failing check.
//
// Every check reports the value it actually measured, so a passing report is evidence too.

const check = (id, ok, value, note) => ({ id, ok, value, ...(note ? { note } : {}) });

/** Build the verdict from measured facts. Pure: the caller gathers, this decides. */
export function doctorReport(facts) {
  const {
    mcpEnabled, pluginBridgeVersion, pluginBridgeProtocol, comfy = {}, clients = [], sessionId,
    lease, graph, promptQueued
  } = facts;
  const checks = [];
  checks.push(check('mcp-enabled', mcpEnabled === true, mcpEnabled === true ? 'enabled' : 'disabled',
    mcpEnabled === true ? undefined : 'MCP 已关闭：在 ComfyUI 面板的「MCP 设置」里开启，其余工具都不能用。'));
  checks.push(check('comfyui-reachable', comfy.reachable === true,
    comfy.reachable === true ? (comfy.version ?? 'reachable') : (comfy.error || 'unreachable'),
    comfy.reachable === true ? undefined : 'ComfyUI 服务本身没回 /system_stats：先确认 ComfyUI 在运行、url 指向正确端口。不要把服务端问题当成桥接问题。'));

  const mine = clients.filter(client => client.sessionId === sessionId);
  checks.push(check('bridge-page', mine.length > 0, mine.length,
    mine.length ? undefined : '本条对话没有活着的 ComfyUI 桥接页面：打开面板（或刷新 ComfyUI 页面）让它连上，桥接不是 MCP 开关。'));
  const live = mine.filter(client => client.connected && client.heartbeatAgeMs != null && client.heartbeatAgeMs < 15000);
  checks.push(check('bridge-heartbeat', live.length > 0, mine.length ? Math.min(...mine.map(client => client.heartbeatAgeMs ?? -1)) + 'ms' : 'no page',
    live.length ? undefined : '页面心跳已过期：ComfyUI 标签页被挂起或已关闭，切回该标签页或刷新。'));
  const fresh = mine.filter(client => !client.refreshRequired && client.bridgeVersion === pluginBridgeVersion && client.bridgeProtocol === pluginBridgeProtocol);
  checks.push(check('bridge-version', fresh.length > 0,
    mine.length ? [...new Set(mine.map(client => client.bridgeVersion + '/' + client.bridgeProtocol))].join(',') : 'no page',
    fresh.length ? undefined : '页面里的 bridge.js 与插件版本不一致（插件 ' + pluginBridgeVersion + '/' + pluginBridgeProtocol + '）：刷新 ComfyUI 页面加载新的注入脚本，旧页面不会自己升级。'));
  const allowed = fresh.filter(client => client.allowAI && client.ready);
  checks.push(check('ai-permission', allowed.length > 0, allowed.length,
    allowed.length ? undefined : '页面对着但还没允许 AI 操作（allowAI=false）或工作流没加载完：在面板的 MCP 设置里放行并等图就绪。'));
  const holder = lease?.holder ?? null;
  const leaseOk = !holder || holder === sessionId;
  checks.push(check('write-lease', leaseOk, holder ? 'held by ' + (holder === sessionId ? 'this session' : holder) : 'free',
    leaseOk ? undefined : '画布写权在另一条对话手里：不要自行 force 接管（画布是用户正在看的那张），先 lease(op=who) 看清持有者再问用户。'));

  if (!graph) {
    checks.push(check('graph-executable', null, 'skipped', '页面不可用，无法体检画布；先修好上面的连接项。'));
    checks.push(check('disk-output', null, 'skipped', '同上。'));
    checks.push(check('active-workflow', null, 'skipped', '同上。'));
  } else {
    const refuted = (graph.checks || []).filter(item => item.verdict === 'refuted');
    const unresolved = (graph.checks || []).filter(item => item.verdict === 'unresolved');
    checks.push(check('graph-executable', graph.verdict !== 'refuted', graph.verdict,
      refuted.length ? '画布本身提交不了：' + refuted.map(item => item.title).join('、') + '。逐条读 audit(op=graph) 的 evidence。'
        : unresolved.length ? '没有硬错误，但 ' + unresolved.map(item => item.title).join('、') + ' 需要人确认。' : undefined));
    const saver = (graph.checks || []).find(item => item.id === 'saver-present');
    const hasSaver = saver ? saver.verdict === 'supported' : false;
    checks.push(check('disk-output', hasSaver, hasSaver ? 'saver present' : (saver?.verdict ?? 'unknown'),
      hasSaver ? undefined : '画布上没有落盘节点（SaveImage/SaveVideo）：生成结果只存在队列里，get_image 之后拿不到文件。'));
    checks.push(check('active-workflow', !!graph.workflowPath, graph.workflowPath ?? 'unsaved',
      graph.workflowPath ? undefined : '当前图还没有保存路径：改完用 save_workflow 落盘，否则关掉页面就丢了。'));
  }
  // A busy queue is the environment working, not the environment being broken: it is
  // reported with its actual counts but must not flip the verdict to fail, or every
  // doctor call during a render would read as "unhealthy".
  if (promptQueued) {
    const idle = promptQueued.running === 0 && promptQueued.pending === 0;
    checks.push(check('queue-idle', idle ? true : null,
      'running ' + promptQueued.running + ' / pending ' + promptQueued.pending,
      idle ? undefined : '队列里有任务在跑：这是正常状态，不是故障；只提醒别重复提交同一个 prompt。'));
  }

  const failed = checks.filter(item => item.ok === false);
  return {
    kind: failed.length ? 'fail' : 'ok',
    ...(failed.length ? { failedChecks: failed.map(item => item.id), firstAction: failed[0].note ?? null } : {}),
    checks
  };
}
