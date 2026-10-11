import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { ComfyRuntime, readJson, json } from './runtime.js';
import { connectMcp } from './mcp.js';
import { runWithCompletionJob } from './completion-job.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-comfyui-web';
export const inject = ['tools', 'webServer'];
export async function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const runtime = await new ComfyRuntime(join(home, 'comfyui', 'config.json')).start();
  runtime.completionNotificationsAvailable = !!ctx.get?.('jobs');
  const settings = () => ({ ...runtime.status(), token: runtime.token, protocol: 'MCP',
    mcp: { enabled: runtime.mcpEnabled, endpoint: runtime.frameOrigin + '/mcp',
      clientConfig: { mcpServers: { comfyui: { command: 'node', args: [fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url))],
        env: { DSH_HOME: home } } } } } });
  ctx.effect(() => () => runtime.stop());
  const config = JSON.parse(await readFile(runtime.configFile, 'utf8').catch(() => '{}'));
  if (config.frontendExtensionsDir) {
    const directory = join(config.frontendExtensionsDir, 'dsh-comfyui');
    await mkdir(directory, { recursive: true });
    const source = await readFile(new URL('../comfy-extension.js', import.meta.url), 'utf8');
    await writeFile(join(directory, 'loader.js'), source.replace('__DSH_DEFAULT_BRIDGE__', JSON.stringify(runtime.frameOrigin)));
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-comfyui/api', handler: async (req, res) => {
      try {
        const origin = req.headers.origin;
        if (origin && origin !== 'http://' + req.headers.host) { json(res, 403, { error: 'Origin mismatch' }); return; }
        if (req.method === 'GET') { json(res, 200, settings()); return; }
        if (req.method !== 'POST' || origin !== 'http://' + req.headers.host || req.headers['x-dsh-comfy-token'] !== runtime.token) { json(res, 403, { error: 'Authentication failed' }); return; }
        const body = await readJson(req);
        if (body.op === 'connect') { await runtime.setUrl(body.url); json(res, 200, settings()); }
        else if (body.op === 'setMcpEnabled') { await runtime.setMcpEnabled(body.enabled); json(res, 200, settings()); }
        else if (body.op === 'check') { const stats = await runtime.request('/system_stats'); json(res, 200, { connected: true, system: stats.system }); }
        else if (body.op === 'command') { json(res, 200, await runtime.command(body.sessionId, body.action, body.args, undefined, body.clientId)); }
        else throw new Error('Unknown operation');
      } catch(e) { json(res, 400, { error: e.message }); }
    }
  }));
  const client = await connectMcp(runtime.frameOrigin + '/mcp', runtime.token);
  for (const tool of client.tools) {
    ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'mcp__comfyui__' + tool.name, rawName: tool.name,
      description: tool.description, inputSchema: tool.inputSchema,
      async call(args, exec) {
        const sessionId = exec?.agent?.session?.id;
        if (!sessionId) throw new Error('ComfyUI MCP 未获得 dsh 当前对话身份，请重新加载插件；不要通过扫描硬盘寻找 sessionId。');
        const invoke = signal => client.rpc('tools/call', { name: tool.name, arguments: args, _meta: { dshSessionId: sessionId } }, signal);
        if (tool.name === 'run') {
          const jobs = exec.agent.ctx?.get?.('jobs') || ctx.get?.('jobs');
          if (jobs) return runWithCompletionJob(jobs, sessionId, invoke, runtime.generations, exec.signal);
        }
        return invoke(exec.signal);
      }
    })));
  }
}
