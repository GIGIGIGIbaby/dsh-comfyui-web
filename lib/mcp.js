import { randomUUID } from 'node:crypto';
import { outputVideos } from './media.js';

const target = {
  clientId: { type: 'string', description: '可选：server_info 返回的面板身份。多个面板时指定。' },
  sessionId: { type: 'string', description: '独立 MCP 客户端使用；dsh 自动传入当前对话身份，不需要手填。' }
};
const spec = (name, description, properties = {}, required = [], readOnly = false) => ({
  name, description, inputSchema: { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false }
});
export const MCP_TOOLS = [
  spec('server_info', '查看 ComfyUI 服务与当前对话面板连接状态。调用图操作前先确认面板 ready 和 allowAI。', target, [], true),
  spec('list_nodes', '读取当前面板的真实节点、widget 名称和可选参数。手动编辑与 AI 修改都以这张图为准。', { ...target, filter: { type: 'string' } }, [], true),
  spec('get_workflow', '读取当前面板最新的普通工作流和 API prompt。不是后台历史任务；包含未提交的手动修改。', target, [], true),
  spec('list_workflows', '列出 ComfyUI 已打开的工作流标签页和已保存工作流，包含准确 path 与当前标签。切换或复制前先查询。', target, [], true),
  spec('switch_workflow', '切换到指定工作流标签页；已保存但尚未打开的工作流会打开。传 list_workflows 返回的准确 path。重复切换不创建副本，保留各标签未保存修改，不运行生成。', { ...target, path: { type: 'string' } }, ['path']),
  spec('new_workflow', '根据已有工作流创建并打开一个新标签副本，保留源工作流及未保存修改。默认复制当前图；sourcePath 可指定 list_workflows 中的工作流，name 可指定新名称。不会保存覆盖源文件，不会运行生成。每次调用会新建一份，请勿盲目重试。', { ...target, sourcePath: { type: 'string' }, name: { type: 'string' } }),
  spec('update_nodes', '实时修改面板节点参数。先 list_nodes 获取真实 nodeId 和 widget 名；修改后立即在画布显示。不会自动生成。', { ...target, changes: {
    type: 'array', items: { type: 'object', additionalProperties: false, required: ['nodeId', 'widget', 'value'], properties: {
      nodeId: { type: 'string' }, widget: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }
    } }
  } }, ['changes']),
  spec('load_workflow', '替换当前标签页的完整普通工作流 JSON（nodes/links），不会另开标签。要从已有工作流另开副本用 new_workflow。先 get_workflow，再修改节点和连接。不能传 API prompt。', { ...target, workflowJson: { type: 'string' } }, ['workflowJson']),
  spec('undo', '撤销最近一次 AI 改图，恢复结果立即显示在画布。', target),
  spec('run', '仅生成当前面板工作流一次。支持后台任务的 dsh 返回 prompt_id 和通知 job_id，结束后自动通知当前对话，不要 sleep 或轮询。job_kill 只取消通知，停止生成请用 interrupt（影响整个实例）。独立 MCP 客户端用 wait_for_completion。进度、预览实时显示。提交超时先查 queue/history，不能盲目重试。', target),
  spec('wait_for_completion', '通过 ComfyUI 实时事件等待本条对话提交的任务结束，无需 sleep。成功、失败、中断均立即返回。等待超时不会取消生成；可继续等待，同一任务不能重复 run。', {
    ...target, promptId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000, description: '事件等待上限，默认 60000 毫秒。' }
  }, ['promptId'], true),
  spec('queue', '查看整个 ComfyUI 实例的运行和等待队列。', {}, [], true),
  spec('history', '查看生成结果。指定 promptId；省略返回最近 5 项。', { promptId: { type: 'string' } }, [], true),
  spec('object_info', '查询节点定义。指定 nodeType 返回该节点参数，省略返回节点类型名称列表。', { nodeType: { type: 'string' } }, [], true),
  spec('interrupt', '中断整个 ComfyUI 实例当前正在运行的任务。必须打开本条对话面板且允许 AI 操作。', target),
  spec('get_video', '将 ComfyUI 已生成的视频显示在本次回复正文结果区，支持播放和用户切换模糊。传 history 中的 promptId，可选 nodeId/index；支持 VideoHelperSuite 的 gifs 视频输出。只提供视频播放，不会将视频内容作为图片传给模型。请使用本工具展示视频，不要用 Markdown 链接绕过显示设置。', { ...target, promptId: { type: 'string' }, nodeId: { type: 'string' }, index: { type: 'integer', minimum: 0 } }, ['promptId'], true),
  spec('get_image', '读取已生成的图片供 AI 检查，并通过 dsh-comfyui-web 在本次回复正文下方显示生成结果，收起工具过程后仍可查看，支持用户切换模糊。向用户展示 ComfyUI 结果时使用本工具，不要再用 read_image 或图片链接展示同一张图，以免绕过插件的显示设置。返回 MCP 图片内容和文件信息。需要 history 中的 promptId；可选 nodeId 和 index。', { promptId: { type: 'string' }, nodeId: { type: 'string' }, index: { type: 'integer' } }, ['promptId'], true)
];
export const MCP_INSTRUCTIONS = '你操作的是用户可见的 ComfyUI 实时画布。先 server_info、list_nodes/get_workflow，再修改；不要为 sessionId 报错扫描硬盘或自改插件源码。dsh 会自动传入当前对话身份。run 每次只提交一次。completionNotification 为 true 时，完成、失败或中断会自动通知当前 dsh 对话，不要 sleep 或轮询；可继续独立工作。确需等待时用 job_output(wait:true) 或 wait_for_completion。独立 MCP 客户端用 wait_for_completion。超时不是生成失败，不要重复提交。完成后用 get_image 检查并向用户展示生成结果：本工具在对话中显示插件图片卡；传入 promptId，需要时指定 nodeId/index，不知道任务信息先 history。不要再用 read_image 或 Markdown 图片链接展示同一张 ComfyUI 结果，以免绕过用户的模糊显示设置。模糊只作用于用户界面的显示，不改变 AI 收到的原图。工作流标签页先 list_workflows，再 switch_workflow 切换，或 new_workflow 基于当前/已有工作流新建副本。load_workflow 只替换当前图。每次 new_workflow 会创建一个标签，超时不要盲目重试。生成视频使用 get_video 在对话中播放，不要用 Markdown 链接。前端同路径工作流的手动编辑会同步；执行写入前读取最新图，避免覆盖用户刚做的修改。';

const asResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export async function callComfyTool(runtime, name, args = {}, meta = {}, signal) {
  if (!MCP_TOOLS.some(t => t.name === name)) throw new Error('Unknown MCP tool: ' + name);
  const sessionId = meta.dshSessionId || args.sessionId;
  if (name === 'server_info') {
    let connected = true, stats, error;
    try { stats = await runtime.request('/system_stats', {}, signal); } catch(e) { connected = false; error = e.message; }
    return asResult({ ...runtime.status(sessionId), connected, ...(stats ? { stats } : { error }), protocol: 'MCP', realtimePreview: true, realtimeCompletion: true });
  }
  if (!runtime.mcpEnabled) throw new Error('MCP 已关闭，请在 ComfyUI 面板的“MCP 设置”中开启。');
  if (name === 'queue') return asResult(await runtime.request('/queue', {}, signal));
  if (name === 'history') return asResult(await runtime.request('/history' + (args.promptId ? '/' + encodeURIComponent(args.promptId) : '?max_items=5'), {}, signal));
  if (name === 'object_info') {
    const data = await runtime.request('/object_info' + (args.nodeType ? '/' + encodeURIComponent(args.nodeType) : ''), {}, signal);
    return asResult(args.nodeType ? data : { nodeTypes: Object.keys(data) });
  }
  if (name === 'get_image') {
    const history = await runtime.request('/history/' + encodeURIComponent(args.promptId), {}, signal);
    const outputs = history[args.promptId]?.outputs || {};
    const images = args.nodeId ? outputs[args.nodeId]?.images || [] : Object.values(outputs).flatMap(o => o.images || []);
    const image = images[args.index ?? 0]; if (!image) throw new Error('该任务尚无可读取的图片');
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
    const res = await fetch(runtime.url + '/view?' + query, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('读取图片失败：' + res.status);
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png';
    if (!mimeType.startsWith('image/')) throw new Error('返回值不是图片');
    const bytes = Buffer.from(await res.arrayBuffer()); if (bytes.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请使用 ComfyUI 保存较小预览');
    return { content: [{ type: 'text', text: JSON.stringify(image) }, { type: 'image', data: bytes.toString('base64'), mimeType }], structuredContent: { image } };
  }
  if (!sessionId) throw new Error('需要当前对话身份。dsh 自动提供；独立 MCP 客户端先 server_info 获取面板的 sessionId 和 clientId。');
  if (name === 'get_video') {
    const history = await runtime.request('/history/' + encodeURIComponent(args.promptId), {}, signal);
    const videos = outputVideos(history[args.promptId]?.outputs).filter(file => !args.nodeId || file.nodeId === args.nodeId);
    const video = videos[args.index ?? 0];
    if (!video) throw new Error('该任务尚无可播放的视频');
    return asResult(runtime.media.describe(video, args.promptId, sessionId));
  }
  if (name === 'wait_for_completion') return asResult(await runtime.generations.wait(args.promptId, sessionId, signal, args.timeoutMs ?? 60000));
  if (name === 'run') {
    await runtime.generations.connect(signal);
    const result = await runtime.command(sessionId, 'run', {}, signal, args.clientId);
    runtime.generations.track(result.prompt_id, sessionId);
    return asResult({ ...result, completionEvents: true, completionNotification: false, waitTool: 'wait_for_completion' });
  }
  if (name === 'interrupt') {
    await runtime.command(sessionId, 'list_nodes', {}, signal, args.clientId);
    await runtime.request('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, signal);
    return asResult({ interrupted: true });
  }
  const payload = name === 'update_nodes' ? { changes: args.changes }
    : name === 'load_workflow' ? { workflow: JSON.parse(args.workflowJson) }
    : name === 'switch_workflow' ? { path: args.path }
    : name === 'new_workflow' ? { sourcePath: args.sourcePath, name: args.name } : { filter: args.filter };
  return asResult(await runtime.command(sessionId, name, payload, signal, args.clientId));
}

export function createMcpHandler(runtime, readJson, json) {
  const pending = new Map();
  return async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + runtime.token) { json(res, 401, { error: 'MCP authentication required' }); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    let message;
    try { message = await readJson(req); }
    catch { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const id = message.id;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') { json(res, 400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid request' } }); return; }
    if (id === undefined) {
      if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort(new Error('MCP 调用已取消'));
      res.writeHead(202); res.end(); return;
    }
    const controller = new AbortController(); pending.set(id, controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('MCP connection closed')); });
    try {
      let result;
      switch (message.method) {
        case 'initialize': result = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsh-comfyui-web', version: runtime.bridgeVersion }, instructions: MCP_INSTRUCTIONS }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: MCP_TOOLS }; break;
        case 'tools/call': {
          try { result = await callComfyTool(runtime, message.params?.name, message.params?.arguments, message.params?._meta, controller.signal); }
          catch(e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
          break;
        }
        default: json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      json(res, 200, { jsonrpc: '2.0', id, result });
    } finally { pending.delete(id); }
  };
}

export async function connectMcp(endpoint, token) {
  let initialized = false;
  const rpc = async (method, params, signal) => {
    const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      signal, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const response = await res.json();
    if (!res.ok || response.error) throw new Error(response.error?.message || 'MCP HTTP ' + res.status);
    return response.result;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-comfyui-web-adapter', version: '0.4.0' } });
  await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  initialized = true;
  return { rpc, initialized, tools: (await rpc('tools/list')).tools };
}
