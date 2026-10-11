(() => {
  'use strict';
  if (window.__DSH_COMFYUI_BRIDGE_ACTIVE__) return;
  window.__DSH_COMFYUI_BRIDGE_ACTIVE__ = true;
  const bridgeProtocol = 2;
  const bridgeVersion = '0.2.2';
  const bootstrap = window.__DSH_COMFYUI_BOOTSTRAP__ || {};
  let token = bootstrap.token || __DSH_BRIDGE_TOKEN__;
  const bridgeBase = bootstrap.bridgeBase || location.origin;
  const query = new URLSearchParams(location.search);
  const embedded = !!(query.get('dsh_client') && query.get('dsh_session') && window.parent !== window);
  const clientId = embedded ? query.get('dsh_client') : crypto.randomUUID();
  const sessionId = embedded ? query.get('dsh_session') : 'comfyui-external';
  let parentOrigin;
  if (embedded) { try { parentOrigin = new URL(document.referrer).origin; } catch { return; } }
  let allowAI = embedded; let visible = true; let busy = false;
  let revision = 0; let lastFingerprint; let initialized = false;
  const undo = []; const completed = new Map();
  const appOf = () => window.comfyAPI?.app?.app;
  const apiOf = () => window.comfyAPI?.api?.api;
  const activeWorkflowOf = app => {
    const workflow = app?.extensionManager?.workflow?.activeWorkflow;
    return workflow && typeof workflow === 'object' ? workflow : null;
  };
  const rootGraphOf = app => app?.rootGraph || app?.graph;
  function graphReady(app) {
    return !!(rootGraphOf(app) && app.canvas && !app.configuringGraph &&
      !window.comfyAPI?.changeTracker?.ChangeTracker?.isLoadingGraph &&
      activeWorkflowOf(app));
  }
  function diagnostics() {
    const app = appOf();
    const tabs = app?.extensionManager?.workflow?.openWorkflows;
    return { bridgeProtocol, bridgeVersion, ready: graphReady(app), allowAI,
      visible: visible && document.visibilityState !== 'hidden',
      hasActiveWorkflow: !!activeWorkflowOf(app), workflowTabs: Array.isArray(tabs) ? tabs.length : null };
  }
  const notify = data => { if (embedded) window.parent.postMessage({ source: 'dsh-comfyui', clientId, ...data }, parentOrigin); };
  window.addEventListener('message', event => {
    if (!embedded || event.source !== window.parent || event.origin !== parentOrigin || event.data?.source !== 'dsh-comfyui-parent' || event.data.clientId !== clientId) return;
    allowAI = event.data.allowAI === true; visible = event.data.visible === true;
  });
  const send = async (path, data) => {
    const r = await fetch(bridgeBase + '/__dsh_comfyui/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify({ clientId, sessionId, ...diagnostics(), ...data }) });
    if (r.status === 403) {
      const next = await (await fetch(bridgeBase + '/__dsh_comfyui/bootstrap')).json();
      token = next.token; revision = 0; initialized = false;
      throw new Error('正在重新连接 ComfyUI 桥接');
    }
    if (!r.ok) throw new Error(await r.text()); return r.json();
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  function snapshot(app) { return clone(rootGraphOf(app).serialize()); }
  function fingerprint(workflow) {
    const clean = clone(workflow);
    // Each browser owns its workflow identity and local revision. Sharing them
    // makes native loaders normalize the graph differently on every page.
    delete clean.id; delete clean.revision;
    if (clean.extra) delete clean.extra.ds;
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify(stable(clean));
  }
  async function replaceCurrentWorkflow(app, workflow) {
    if (!graphReady(app)) throw new Error('ComfyUI 当前工作流正在载入，请稍后再试');
    const active = activeWorkflowOf(app);
    // Never use loadGraphData's null/string fallback: it creates temporary tabs.
    if (!active) throw new Error('ComfyUI 当前工作流尚未就绪，请稍后再试');
    const data = clone(workflow);
    const localId = snapshot(app).id;
    if (localId != null) data.id = localId;
    else delete data.id;
    const ds = app.canvas.ds;
    const view = ds ? { scale: ds.scale, offset: Array.from(ds.offset) } : null;
    try {
      const loaded = await app.loadGraphData(data, false, false, active,
        { checkForRerouteMigration: false, silentAssetErrors: true });
      if (loaded === false) throw new Error('ComfyUI 未能载入工作流');
    } finally {
      if (view && app.canvas.ds) { app.canvas.ds.scale = view.scale; app.canvas.ds.offset[0] = view.offset[0]; app.canvas.ds.offset[1] = view.offset[1]; }
      app.graph.setDirtyCanvas(true, true);
    }
  }
  async function syncWorkflow(app) {
    const owner = activeWorkflowOf(app);
    const workflow = snapshot(app); const current = fingerprint(workflow);
    const changed = initialized && current !== lastFingerprint;
    const update = await send('sync', { revision, ...(!initialized || changed ? { workflow, fingerprint: current } : {}) });
    // A manual workflow switch can finish while the network request is pending.
    // Defer the response rather than applying it to the new tab or a loading graph.
    if (!graphReady(app) || activeWorkflowOf(app) !== owner) return;
    if (update.workflow) {
      if (update.conflict && changed) {
        try { localStorage.setItem('dsh.comfyui.sync-conflict.' + clientId, JSON.stringify(workflow)); } catch {}
        notify({ warning: '另一页也修改了工作流，已同步最新图；本页冲突副本保存在浏览器中。' });
      }
      if (fingerprint(update.workflow) !== current) await replaceCurrentWorkflow(app, update.workflow);
      lastFingerprint = fingerprint(snapshot(app));
    } else lastFingerprint = current;
    revision = update.revision; initialized = true;
  }
  function remember(app) { undo.push({ workflow: snapshot(app), owner: activeWorkflowOf(app) }); if (undo.length > 20) undo.shift(); }
  function nodes(app) {
    return (app.graph._nodes || []).map(n => ({ id: String(n.id), type: n.type, title: n.title, mode: n.mode,
      widgets: (n.widgets || []).filter(w => w.type !== 'button').map(w => ({ name: w.name, type: w.type, value: w.value ?? null,
        ...(Array.isArray(w.options?.values) ? { choices: w.options.values } : {}),
        ...(typeof w.options?.min === 'number' ? { min: w.options.min, max: w.options.max ?? null } : {}) })),
      inputs: (n.inputs || []).map((i, slot) => ({ name: i.name, type: i.type, slot, link: i.link ?? null })),
      outputs: (n.outputs || []).map((o, slot) => ({ name: o.name, type: o.type, slot, links: o.links || [] })) }));
  }
  async function execute(command) {
    const app = appOf(); const args = command.args || {};
    if (!allowAI) throw new Error('此面板已关闭 AI 操作');
    if (!graphReady(app)) throw new Error('ComfyUI 工作流尚未就绪');
    switch (command.action) {
      case 'list_nodes': return { nodes: nodes(app).filter(n => !args.filter || (n.type + ' ' + n.title).toLowerCase().includes(args.filter.toLowerCase())) };
      case 'get_workflow': return { workflow: snapshot(app), prompt: (await app.graphToPrompt()).output };
      case 'update_nodes': {
        const changes = args.changes;
        if (!Array.isArray(changes) || !changes.length || changes.length > 500) throw new Error('changes 必须是包含 1–500 项的数组');
        const edits = changes.map(change => {
          const node = app.graph.getNodeById(change.nodeId);
          if (!node) throw new Error('节点不存在：' + change.nodeId);
          const widget = (node.widgets || []).find(w => w.name === change.widget);
          if (!widget || widget.type === 'button') throw new Error('可编辑参数不存在：' + change.nodeId + '.' + change.widget);
          if (typeof widget.value === 'number' && (typeof change.value !== 'number' || !Number.isFinite(change.value))) throw new Error(widget.name + ' 必须是数字');
          if (typeof widget.value === 'string' && typeof change.value !== 'string') throw new Error(widget.name + ' 必须是文本');
          if (typeof widget.value === 'boolean' && typeof change.value !== 'boolean') throw new Error(widget.name + ' 必须是布尔值');
          if (Array.isArray(widget.options?.values) && !widget.options.values.includes(change.value)) throw new Error(widget.name + ' 的值不在可选项中');
          if (typeof change.value === 'number' && ((widget.options?.min != null && change.value < widget.options.min) || (widget.options?.max != null && change.value > widget.options.max))) throw new Error(widget.name + ' 超出节点允许的范围');
          return { node, widget, value: change.value, before: clone(widget.value) };
        });
        remember(app);
        for (const edit of edits) edit.widget.value = edit.value;
        for (const edit of edits) edit.widget.callback?.(edit.value, app.canvas, edit.node);
        app.graph.setDirtyCanvas(true, true);
        return { changed: edits.map(e => ({ nodeId: String(e.node.id), widget: e.widget.name, before: e.before, after: e.widget.value })) };
      }
      case 'load_workflow': {
        if (!args.workflow || !Array.isArray(args.workflow.nodes) || !Array.isArray(args.workflow.links)) throw new Error('请提供普通 ComfyUI 工作流 JSON（包含 nodes、links），不是 API prompt');
        remember(app);
        await replaceCurrentWorkflow(app, args.workflow);
        return { loaded: true, nodes: nodes(app) };
      }
      case 'undo': {
        if (!undo.length) throw new Error('没有可撤销的 AI 修改');
        const previous = undo.at(-1);
        if (previous.owner !== activeWorkflowOf(app)) throw new Error('当前工作流已切换，请返回原工作流再撤销');
        await replaceCurrentWorkflow(app, previous.workflow); undo.pop();
        return { restored: true, nodes: nodes(app) };
      }
      case 'run': {
        const api = apiOf();
        if (!api?.queuePrompt) throw new Error('当前 ComfyUI 前端没有 queuePrompt 接口');
        const prompt = await app.graphToPrompt();
        const result = await api.queuePrompt(0, prompt);
        return { submitted: true, ...result };
      }
      default: throw new Error('未知面板操作：' + command.action);
    }
  }
  async function poll() {
    if (busy) return; busy = true;
    try {
      const ready = graphReady(appOf());
      if (ready) await syncWorkflow(appOf());
      const response = await send('poll', {});
      notify({ ready, allowAI });
      for (const command of response.commands || []) {
        let reply = completed.get(command.id);
        if (!reply) {
          try {
            reply = { id: command.id, result: await execute(command) };
            if (['update_nodes', 'load_workflow', 'undo'].includes(command.action)) await syncWorkflow(appOf());
          }
          catch (e) { reply = { id: command.id, error: e.message || String(e) }; }
          completed.set(command.id, reply);
          if (completed.size > 200) completed.delete(completed.keys().next().value);
        }
        await send('result', reply);
      }
    } catch (e) { notify({ ready: false, error: e.message }); }
    finally { busy = false; setTimeout(poll, 750); }
  }
  poll();
})();
