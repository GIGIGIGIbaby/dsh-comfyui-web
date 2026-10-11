import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const configPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'comfyui', 'connection.json');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let message;
  try {
    message = JSON.parse(line);
    const connection = JSON.parse(await readFile(configPath, 'utf8'));
    const response = await fetch(connection.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify(message) });
    if (message.id !== undefined) {
      const data = await response.json(); process.stdout.write(JSON.stringify(data) + '\n');
    }
  } catch(e) {
    if (message?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } }) + '\n');
    else process.stderr.write(e.message + '\n');
  }
});
