import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class TaskStore {
  constructor(file) { this.file = file; this.records = []; this.writes = Promise.resolve(); }
  async start() {
    try { const data = JSON.parse(await readFile(this.file, 'utf8')); this.records = data.tasks || []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  save(server, records) {
    const tasks = [...this.records.filter(task => task.server !== server), ...records.map(record => ({
      server, promptId: record.promptId, sessionId: record.sessionId, status: record.status,
      created: record.created, result: record.result, notificationDelivered: record.notificationDelivered,
      notificationDisabled: record.notificationDisabled, stopMessageId: record.stopMessageId, stopReleased: record.stopReleased
    }))].slice(-500);
    this.records = tasks;
    const text = JSON.stringify({ version: 1, tasks });
    const next = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, text, { mode: 0o600 }); await rename(temp, this.file);
    });
    this.writes = next;
    return next;
  }
}
