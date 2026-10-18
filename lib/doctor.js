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
    lease, graph, draftStorage, promptQueued
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
  const allowed = live.filter(client => client.allowAI && client.ready);
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
  // The front-end keeps its own draft copy of the workflow in localStorage. A write cannot avoid
  // touching it, and when the store is full every write ends in a red "保存草稿失败" banner that
  // has nothing to do with the write. Report the measured size so that banner is predictable.
  if (draftStorage) {
    const available = draftStorage.available !== false;
    const used = Number(draftStorage.usedChars ?? 0);
    // The bridge keeps undo snapshots and conflict backups in the same quota. Measuring only
    // ComfyUI's own drafts let the store sit at its limit while this number read "298 chars".
    const own = Number(draftStorage.ownChars ?? 0);
    const total = Number(draftStorage.totalChars ?? (used + own));
    const tight = total >= 3_500_000;
    // "unavailable" is the front-end's own permanent flag (it stops saving drafts after the first
    // quota error). It is a different fault from "nearly full" and needs a different action.
    const unavailable = draftStorage.unavailable === true;
    // Snapshots left by a conversation that never came back are pure loss: nothing will ever read
    // them, and a page load deletes them. Saying how much they hold turns "the store is full" into
    // "the store is full because of this".
    const stale = Number(draftStorage.staleChars ?? 0);
    const staleHint = stale > 0
      ? '其中 ' + stale + ' 字符是已经不会再用到的旧会话快照（' + (draftStorage.staleKeys ?? 0) + ' 个键）：刷新页面即自动回收，不用手动清。'
      : null;
    const pruneHint = own > 0
      ? '桥接自己的撤销快照占了 ' + own + ' 字符（' + (draftStorage.ownKeys?.length ?? 0) + ' 个键），与 ComfyUI 的草稿共用同一份浏览器配额。'
      : null;
    checks.push(check('draft-storage', !available ? null : (tight || unavailable ? null : true),
      !available ? (draftStorage.blocking ?? 'unreadable')
        : total + ' chars（ComfyUI 草稿 ' + used + '（' + (draftStorage.keys?.length ?? 0) + ' 个键） / 桥接快照 ' + own + '（' + (draftStorage.ownKeys?.length ?? 0) + ' 个键））',
      !available ? '页面里读不到 localStorage，无法判断草稿占用；不影响画布写入。'
        : unavailable ? '前端已经把草稿存储标记为不可用（配额曾爆过）：此后每次自动保存都会弹「保存工作流草稿失败」，与工具写入无关。先刷新页面恢复，再清理草稿（关掉 Comfy.Workflow.Persist）或换干净的浏览器配置。'
        : tight ? '存储已占 ' + total + ' 字符（浏览器配额约 5M）：再写有弹「保存工作流草稿失败」的风险。' + (pruneHint ? ' ' + pruneHint : '') + (staleHint ? ' ' + staleHint : '') + ' 也可以关掉设置 Comfy.Workflow.Persist 停止自动保存草稿。'
        : (staleHint ? [pruneHint, staleHint].filter(Boolean).join(' ') : pruneHint ?? undefined)));
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
