import { connectMcp } from '../lib/mcp.js';
const base = process.argv[2] || 'http://127.0.0.1:3080';
const config = await (await fetch(base + '/dsh-comfyui/api')).json();
const client = config.clients.find(c => c.ready && c.allowAI);
console.log('ComfyUI target:', config.url);
console.log('Connected panels:', config.clients.length);
const mcp = await connectMcp(config.frameOrigin + '/mcp', config.token);
console.log('MCP initialized:', mcp.initialized, '; tools:', mcp.tools.length);
if (client) {
  const result = await mcp.rpc('tools/call', { name: 'list_nodes', arguments: { clientId: client.clientId }, _meta: { dshSessionId: client.sessionId } });
  if (result.isError) throw new Error(result.content[0].text);
  const data = result.structuredContent;
  console.log('Live workflow readable by AI:', true, '; nodes:', data.nodes.length);
}
const extensions = await (await fetch(config.url + '/extensions')).json();
console.log('ComfyUI frontend extension installed:', extensions.includes('/extensions/dsh-comfyui/loader.js'));
const api = await (await fetch(config.frameOrigin + '/queue')).json();
console.log('ComfyUI API through proxy:', Array.isArray(api.queue_running));
await new Promise((resolve, reject) => {
  const ws = new WebSocket(config.frameOrigin.replace('http:', 'ws:') + '/ws');
  const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 5000);
  ws.onmessage = event => {
    if (typeof event.data === 'string' && JSON.parse(event.data).type === 'status') {
      console.log('Live-preview WebSocket:', true); clearTimeout(timer); ws.onclose = resolve; ws.close();
    }
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
});
const events = await fetch(base + '/plugins/events');
const reader = events.body.getReader(); const decoder = new TextDecoder(); let text = '';
while (!/^data: .*\n/m.test(text)) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); }
await reader.cancel();
const line = text.split('\n').find(l => l.startsWith('data: '));
const graph = JSON.parse(line.slice(6)).graph;
const row = graph.entries.find(entry => entry.id === 'dsh-comfyui-web');
console.log('Client module registered:', !!row);
const bundle = await fetch(new URL(row.url, base + '/'));
const script = await bundle.text();
console.log('Proportional zoom published:', bundle.ok && script.includes('100 / zoom') && !script.includes('Math.max(1, zoom)'));
console.log('Direct ComfyUI iframe published:', script.includes("connection.url + '/?dsh_client='"));
