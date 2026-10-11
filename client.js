window.__ModuleLoader__.load({ id: 'dsh-comfyui-web', factory: require => {
  const React = require('react');
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const ID = 'dsh-comfyui-web';
  const CSS = `
    .dsh-comfy { display:flex; flex:1 1 auto; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0; box-sizing:border-box; background:var(--dsr-bg,#181a1d); color:inherit; }
    .dsh-comfy-bar { display:flex; flex:none; align-items:center; flex-wrap:wrap; gap:10px; padding:8px 12px; border-bottom:1px solid #80808030; font-size:12px; }
    .dsh-comfy-state { display:flex; align-items:center; gap:6px; margin-right:auto; }
    .dsh-comfy-dot { width:6px; height:6px; border-radius:50%; background:#d28b35; }
    .dsh-comfy-dot.ready { background:#48b08a; }
    .dsh-comfy-dot.off { background:#888; }
    .dsh-comfy-bar label { display:flex; align-items:center; gap:5px; white-space:nowrap; cursor:pointer; }
    .dsh-comfy button,.dsh-comfy-entry { background:transparent; color:inherit; border:1px solid #80808040; border-radius:6px; padding:5px 9px; font:inherit; cursor:pointer; }
    .dsh-comfy button:hover,.dsh-comfy-entry:hover { background:#80808018; }
    .dsh-comfy button:focus-visible,.dsh-comfy-entry:focus-visible { outline:2px solid #48b08a; outline-offset:2px; }
    .dsh-comfy-entry { font-size:12px; display:flex; align-items:center; gap:6px; }
    .dsh-comfy-settings { flex:none; padding:12px; border-bottom:1px solid #80808030; display:grid; gap:12px; font-size:12px; max-height:45%; overflow:auto; }
    .dsh-comfy-settings-head,.dsh-comfy-settings form { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .dsh-comfy-settings-head strong { margin-right:auto; }
    .dsh-comfy-switch { display:flex; align-items:center; gap:6px; cursor:pointer; }
    .dsh-comfy-settings input[type=url] { flex:1; min-width:150px; }
    .dsh-comfy-settings input[type=url],.dsh-comfy-settings textarea { box-sizing:border-box; background:transparent; color:inherit; border:1px solid #80808060; border-radius:6px; padding:7px; font:12px Consolas,monospace; }
    .dsh-comfy-settings textarea { display:block; width:100%; resize:vertical; margin:8px 0; }
    .dsh-comfy-settings p { margin:0; opacity:.75; line-height:1.6; overflow-wrap:anywhere; }
    .dsh-comfy-settings summary { cursor:pointer; }
    .dsh-comfy-settings code { overflow-wrap:anywhere; user-select:text; }
    .dsh-comfy-viewport { flex:1 1 0; min-width:0; min-height:0; overflow:hidden; position:relative; background:#202020; }
    .dsh-comfy-frame { display:block; position:absolute; top:0; left:0; border:0; max-width:none; max-height:none; margin:0; padding:0; background:#202020; transform-origin:top left; }
    .dsh-comfy-zoom { display:flex; align-items:center; gap:4px; font-variant-numeric:tabular-nums; }
    .dsh-comfy-zoom button { padding:3px 7px; min-width:26px; }
    .dsh-comfy-note { padding:8px 12px; font-size:12px; background:#d28b3514; border-bottom:1px solid #d28b3540; overflow-wrap:anywhere; }
    .dsh-comfy-empty { padding:24px; line-height:1.7; font-size:13px; }
  `;
  async function api(body, token, signal) {
    const response = await fetch('/dsh-comfyui/api', body ? { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify(body) } : { signal, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || '连接失败');
    return result;
  }
  function Body({ sessionId, useTabInfo }) {
    const { tab } = useTabInfo();
    const frame = useRef(null);
    const clientId = useRef(crypto.randomUUID());
    const [connection, setConnection] = useState(null);
    const [url, setUrl] = useState('http://127.0.0.1:8188');
    const [ready, setReady] = useState(false);
    const [error, setError] = useState('');
    const [settings, setSettings] = useState(false);
    const [epoch, setEpoch] = useState(0);
    const [saving, setSaving] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [copied, setCopied] = useState(false);
    const [zoom, setZoom] = useState(() => {
      try { const saved = Number(localStorage.getItem('dsh.comfyui.zoom')); return saved >= 0.5 && saved <= 1.25 ? saved : 0.85; }
      catch { return 0.85; }
    });
    const mcpEnabled = connection?.mcp?.enabled !== false;
    const state = useRef({ allowAI: mcpEnabled, visible: tab.visible });
    state.current = { allowAI: mcpEnabled, visible: tab.visible };
    const sendState = () => {
      if (!connection || !frame.current?.contentWindow) return;
      frame.current.contentWindow.postMessage({ source: 'dsh-comfyui-parent', clientId: clientId.current, ...state.current }, new URL(connection.url).origin);
    };
    useEffect(() => {
      const controller = new AbortController();
      api(null, null, controller.signal).then(data => { setConnection(data); setUrl(data.url); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
      const refresh = setInterval(() => api(null, null, controller.signal).then(data => {
        setConnection(previous => previous && previous.url === data.url && previous.frameOrigin === data.frameOrigin && previous.token === data.token && previous.mcp?.enabled === data.mcp?.enabled ? previous : data);
      }).catch(() => {}), 3000);
      return () => { controller.abort(); clearInterval(refresh); };
    }, []);
    useEffect(() => {
      if (!connection) return;
      const receive = event => {
        if (event.origin !== new URL(connection.url).origin || event.source !== frame.current?.contentWindow || event.data?.source !== 'dsh-comfyui' || event.data.clientId !== clientId.current) return;
        setReady(event.data.ready === true);
        if (event.data.warning) setError(event.data.warning); else if (event.data.ready) setError(''); else if (event.data.error) setError(event.data.error);
        sendState();
      };
      window.addEventListener('message', receive);
      const heartbeat = setInterval(sendState, 1000);
      return () => { window.removeEventListener('message', receive); clearInterval(heartbeat); };
    }, [connection]);
    useEffect(() => {
      sendState();
    }, [mcpEnabled, tab.visible, connection]);
    useEffect(() => { try { localStorage.setItem('dsh.comfyui.zoom', String(zoom)); } catch {} }, [zoom]);
    const changeZoom = delta => setZoom(value => Math.min(1.25, Math.max(0.5, Math.round((value + delta) * 100) / 100)));
    async function connect(event) {
      event.preventDefault(); setSaving(true); setError('');
      try {
        const data = await api({ op: 'connect', url }, connection.token);
        setConnection({ ...data, token: connection.token }); setReady(false); setEpoch(value => value + 1);
        await api({ op: 'check' }, connection.token);
      } catch(e) { setError(e.message); } finally { setSaving(false); }
    }
    async function toggleMcp(enabled) {
      setSwitching(true); setError('');
      try { setConnection(await api({ op: 'setMcpEnabled', enabled }, connection.token)); }
      catch(e) { setError(e.message); } finally { setSwitching(false); }
    }
    async function copyConfig() {
      try { await navigator.clipboard.writeText(JSON.stringify(connection.mcp.clientConfig, null, 2)); setCopied(true); }
      catch { setError('复制失败，请选中下方配置手动复制。'); }
    }
    const src = connection ? connection.url + '/?dsh_client=' + encodeURIComponent(clientId.current) + '&dsh_session=' + encodeURIComponent(sessionId) + '&dsh_bridge=' + encodeURIComponent(connection.frameOrigin) : null;
    return h('section', { className: 'dsh-comfy', 'aria-label': 'ComfyUI 工作台' },
      h('style', null, CSS),
      h('div', { className: 'dsh-comfy-bar' },
        h('span', { className: 'dsh-comfy-state', role: 'status' }, h('i', { className: 'dsh-comfy-dot' + (!mcpEnabled ? ' off' : ready ? ' ready' : '') }), !mcpEnabled ? 'MCP 已关闭' : ready ? 'MCP · 共享画布已连接' : '等待 ComfyUI'),
        h('div', { className: 'dsh-comfy-zoom', role: 'group', 'aria-label': 'ComfyUI 界面缩放' },
          h('button', { type: 'button', onClick: () => changeZoom(-0.05), disabled: zoom <= 0.5, 'aria-label': '缩小 ComfyUI 界面' }, '−'),
          h('button', { type: 'button', onClick: () => setZoom(1), title: '恢复 100% 大小', 'aria-label': '当前缩放 ' + Math.round(zoom * 100) + '%，点击恢复 100%' }, Math.round(zoom * 100) + '%'),
          h('button', { type: 'button', onClick: () => changeZoom(0.05), disabled: zoom >= 1.25, 'aria-label': '放大 ComfyUI 界面' }, '+')),
        h('button', { type: 'button', onClick: () => { setReady(false); setEpoch(v => v + 1); }, title: '刷新 ComfyUI 页面' }, '刷新'),
        h('button', { type: 'button', onClick: () => { setSettings(v => !v); setCopied(false); }, 'aria-expanded': settings }, 'MCP 设置')),
      settings ? h('div', { className: 'dsh-comfy-settings', 'aria-label': 'MCP 设置' },
        h('div', { className: 'dsh-comfy-settings-head' }, h('strong', null, 'ComfyUI MCP'),
          h('label', { className: 'dsh-comfy-switch' }, h('input', { type: 'checkbox', role: 'switch', checked: mcpEnabled, disabled: !connection || switching,
            onChange: e => toggleMcp(e.target.checked) }), switching ? '保存中…' : '开启 MCP')),
        h('p', null, mcpEnabled ? 'MCP 已开启，当前对话的 AI 可直接读取、修改和运行画布。' : 'MCP 已关闭，仍可手动编辑和生成。'),
        h('form', { onSubmit: connect },
          h('label', { htmlFor: 'comfy-url-' + clientId.current }, 'ComfyUI 地址'),
          h('input', { id: 'comfy-url-' + clientId.current, type: 'url', required: true, value: url, onChange: e => setUrl(e.target.value) }),
          h('button', { type: 'submit', disabled: saving || !connection }, saving ? '连接中…' : '保存并连接')),
        connection?.mcp ? h(React.Fragment, null,
          h('p', null, 'MCP 地址：', h('code', null, connection.mcp.endpoint)),
          h('details', null, h('summary', null, '其他 AI 客户端的 MCP 配置'),
            h('textarea', { readOnly: true, rows: 7, value: JSON.stringify(connection.mcp.clientConfig, null, 2), 'aria-label': 'MCP 客户端配置' }),
            h('button', { type: 'button', onClick: copyConfig }, copied ? '已复制' : '复制配置'),
            h('p', null, 'dsh 已自动接入；这份配置可用于本机其他支持 MCP 的客户端。'))) : null) : null,
      error ? h('div', { className: 'dsh-comfy-note', role: 'alert' }, error) : null,
      src ? h('div', { className: 'dsh-comfy-viewport' }, h('iframe', { key: epoch, ref: frame, className: 'dsh-comfy-frame', src,
        style: { width: (100 / zoom) + '%', height: (100 / zoom) + '%', transform: 'scale(' + zoom + ')' },
        title: 'ComfyUI 节点编辑与实时生成预览', allow: 'clipboard-read; clipboard-write; fullscreen', allowFullScreen: true,
        onLoad: sendState, referrerPolicy: 'origin' })) : h('div', { className: 'dsh-comfy-empty' }, '正在连接本机 ComfyUI…'));
  }
  function Entry({ open }) {
    return h(React.Fragment, null, h('style', null, CSS), h('button', { type: 'button', className: 'dsh-comfy-entry', onClick: open, title: '在右侧打开 ComfyUI，可改节点、预览并让 AI 操作' },
      h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'aria-hidden': true }, h('rect', { x: 2, y: 3, width: 5, height: 5, rx: 1 }), h('rect', { x: 13, y: 12, width: 5, height: 5, rx: 1 }), h('path', { d: 'M7 5.5h4v9h2' })), 'ComfyUI'));
  }
  function apply(ctx) {
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: ID, keepMounted: true, title: () => 'ComfyUI',
      guide: [{ id: 'comfyui', order: 35, title: () => 'ComfyUI', description: () => '节点编辑 · 实时预览 · AI 操作' }] }));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Body)));
    ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: ID, order: 35,
      inject: () => ({ open: () => ctx.sidebarRight.openTab(ID) }) }, Entry)));
  }
  return { name: ID, inject: ['slots', 'sidebarRight', 'sidebarRightTabs'], apply };
} });
