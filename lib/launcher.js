import { readFile, writeFile, mkdir, stat, readdir, open } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isFile = path => stat(path).then(value => value.isFile(), () => false);
const isDirectory = path => stat(path).then(value => value.isDirectory(), () => false);
const launcherNames = ['绘世启动器.exe', '启动器.exe', 'StableDiffusionWebUILauncher.exe'];
const publicTarget = ({ kind, path, root, comfyRoot, python }) => ({ kind, path, root, comfyRoot, ...(python ? { python } : {}) });

// Recognize installations by their files, never execute a discovered path during detection.
export async function inspectInstallation(input) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) throw new Error('请选择本机的绝对路径');
  const selected = resolve(input);
  const file = await isFile(selected);
  let folder = file ? dirname(selected) : selected;
  if (!await isDirectory(folder)) throw new Error('所选路径不存在或不是文件夹');
  if (basename(folder) === '.launcher') folder = dirname(folder);
  const folders = [...new Set([folder, dirname(folder)])];
  const targets = [];
  for (const root of folders) {
    let app = 'ComfyUI';
    try {
      const value = (await readFile(join(root, '.app_path'), 'utf8')).trim();
      if (value && !isAbsolute(value) && !value.split(/[\\/]/).includes('..')) app = value;
    } catch {}
    const comfy = await isFile(join(root, 'main.py')) && await isDirectory(join(root, 'comfy')) ? root
      : await isFile(join(root, app, 'main.py')) && await isDirectory(join(root, app, 'comfy')) ? join(root, app) : null;
    if (!comfy) continue;
    const pythonRoots = [...new Set([root, comfy, dirname(comfy)])];
    const interpreters = pythonRoots.flatMap(base => [join(base, 'python', 'python.exe'),
      join(base, 'python_embeded', 'python.exe'), join(base, 'python_embedded', 'python.exe'),
      join(base, '.venv', 'Scripts', 'python.exe'), join(base, 'venv', 'Scripts', 'python.exe')]);
    let python;
    for (const path of interpreters) if (await isFile(path)) { python = path; break; }
    if (python) targets.push({ kind: 'comfyui', path: comfy, root: comfy, comfyRoot: comfy, python });
    for (const name of launcherNames) {
      const path = join(root, name);
      if (await isFile(path)) targets.push({ kind: 'aki', path, root, comfyRoot: comfy, python });
    }
  }
  const unique = [...new Map(targets.map(item => [item.kind + ':' + item.path.toLowerCase(), publicTarget(item)])).values()];
  if (!unique.length) throw new Error('未找到可启动的 ComfyUI。请选择 AKi / 便携整合包目录，或包含 main.py 和本地 Python 环境的 ComfyUI 目录');
  return unique;
}

export async function detectInstallations(config = {}, options = {}) {
  const roots = new Set(options.roots || []);
  for (const value of [config.launcher?.path, config.frontendExtensionsDir, config.customNodesDir]) {
    if (typeof value !== 'string' || !isAbsolute(value)) continue;
    let path = value;
    for (let i = 0; i < 7 && path !== dirname(path); i++, path = dirname(path)) roots.add(path);
  }
  if (!options.roots) {
    for (const base of [homedir(), join(homedir(), 'Desktop'), join(homedir(), 'Downloads'),
      ...'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => letter + ':/')]) {
      for (const suffix of ['', 'AI', 'ComfyUI', 'ComfyUI_windows_portable', 'tools']) {
        const parent = join(base, suffix);
        roots.add(parent);
        const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.slice(0, 200)) {
          if (entry.isDirectory() && /comfy|aki/i.test(entry.name)) roots.add(join(parent, entry.name));
        }
      }
    }
  }
  const found = new Map();
  for (const root of roots) {
    for (const target of await inspectInstallation(root).catch(() => [])) {
      found.set(target.kind + ':' + target.path.toLowerCase(), target);
    }
  }
  return [...found.values()];
}

export async function pickWindowsPath(kind, signal) {
  if (process.platform !== 'win32') throw new Error('资源管理器选择目前仅支持 Windows，请手动填写路径');
  if (!['file', 'folder'].includes(kind)) throw new Error('请选择文件或文件夹');
  // Static script: no user-controlled path is interpolated into PowerShell code.
  const script = `Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
${kind === 'folder' ? `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 AKi 或 ComfyUI 安装目录'
$dialog.ShowNewFolderButton = $false` : `$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择 AKi 启动器或 ComfyUI main.py'
$dialog.Filter = '启动入口|*.exe;main.py|所有文件|*.*'
$dialog.CheckFileExists = $true`}
try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write(${kind === 'folder' ? '$dialog.SelectedPath' : '$dialog.FileName'}) } }
finally { $dialog.Dispose(); $owner.Dispose() }`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 180000, signal, maxBuffer: 16384, encoding: 'utf8' });
  return stdout.trim() || null;
}

export function localLaunchAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('本机启动只适用于 localhost / 127.0.0.1 / ::1 的 HTTP 地址；远程 ComfyUI 请在远程电脑启动');
  }
  return { host: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port: url.port || '80' };
}

export class ComfyLauncher {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.platform = options.platform || process.platform;
    this.spawn = options.spawn || spawn;
    this.picker = options.picker || pickWindowsPath;
    this.detectOptions = options.detectOptions;
    this.prepare = options.prepare || (async () => {});
    this.now = options.now || Date.now;
    this.probe = options.probe || (async (url = this.runtime.url) => {
      try {
        const response = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(4000) });
        const body = await response.json();
        return response.ok && !!body.system;
      } catch { return false; }
    });
    this.state = { phase: 'idle' };
    this.selected = null;
    this.targets = [];
  }
  async init() {
    const config = await this.readConfig();
    this.selected = config.launcher || null;
    return this;
  }
  async readConfig() { return JSON.parse(await readFile(this.runtime.configFile, 'utf8').catch(() => '{}')); }
  async status() {
    // Share concurrent probes from multiple panels and keep media API reads inexpensive.
    if (!this.healthSample || this.healthSample.url !== this.runtime.url
      || (!this.healthSample.pending && this.now() - this.healthSample.at > 2000)) {
      const sample = this.healthSample = { url: this.runtime.url, at: this.now(), pending: true };
      sample.promise = Promise.resolve().then(() => this.probe(sample.url)).then(online => {
        if (online) this.lastHealthy = { url: sample.url, at: this.now() };
        // Heavy custom-node/object_info work can briefly block ComfyUI's event loop.
        // A single slow response must not tear down a working canvas or offer a duplicate launch.
        return online || (this.lastHealthy?.url === sample.url && this.now() - this.lastHealthy.at < 30000);
      }).finally(() => { sample.pending = false; });
    }
    const connected = await this.healthSample.promise;
    let unavailable = this.platform !== 'win32' ? '本机启动目前仅支持 Windows' : null;
    try { localLaunchAddress(this.runtime.url); } catch (e) { unavailable = e.message; }
    return { ...this.state, phase: connected ? 'ready' : this.state.phase, connected, supported: !unavailable, unavailable, selected: this.selected, targets: this.targets };
  }
  async detect() {
    this.targets = await detectInstallations(await this.readConfig(), this.detectOptions);
    return this.status();
  }
  async inspect(path) {
    this.targets = await inspectInstallation(path);
    return this.status();
  }
  async select(path, kind) {
    if (!['aki', 'comfyui'].includes(kind)) throw new Error('请选择启动方式');
    const selected = (await inspectInstallation(path)).find(item => item.kind === kind && (kind !== 'aki' || item.path.toLowerCase() === resolve(path).toLowerCase()));
    if (!selected) throw new Error('所选启动入口不可用，请重新检测或选择路径');
    const config = await this.readConfig();
    await mkdir(dirname(this.runtime.configFile), { recursive: true });
    // Store a validated path and mode, never caller-supplied commands or shell arguments.
    await writeFile(this.runtime.configFile, JSON.stringify({ ...config, launcher: { path: selected.path, kind } }, null, 2) + '\n', { mode: 0o600 });
    this.selected = { path: selected.path, kind };
    return this.status();
  }
  async pick(kind, signal) {
    if (this.picking) throw new Error('路径选择窗口已打开，请先完成或取消选择');
    this.picking = true;
    try {
      const path = await this.picker(kind, signal);
      return path ? this.inspect(path) : { ...await this.status(), cancelled: true };
    } finally { this.picking = false; }
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.startOnce();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async startOnce() {
    if (this.platform !== 'win32') throw new Error('本机启动目前仅支持 Windows');
    const address = localLaunchAddress(this.runtime.url);
    const status = await this.status();
    if (status.connected) return { ...status, alreadyRunning: true };
    if (this.child || (this.state.phase === 'launcher-opened' && Date.now() - this.state.startedAt < 30000)) return this.status();
    if (!this.selected) throw new Error('请先检测或选择启动路径');
    const target = (await inspectInstallation(this.selected.path)).find(item => item.kind === this.selected.kind && item.path === this.selected.path);
    if (!target) throw new Error('保存的启动路径已失效，请重新选择');
    await this.prepare(target);
    const logPath = join(dirname(this.runtime.configFile), 'launch.log');
    const log = await open(logPath, 'a', 0o600);
    await log.write('\n[' + new Date().toISOString() + '] ' + target.kind + ': ' + target.path + '\n');
    try {
      const command = target.kind === 'aki' ? target.path : target.python;
      const args = target.kind === 'aki' ? [] : ['-s', join(target.root, 'main.py'), '--listen', address.host, '--port', address.port, '--disable-auto-launch'];
      const child = this.spawn(command, args, { cwd: target.root, shell: false, detached: true,
        windowsHide: target.kind !== 'aki', stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PYTHONUTF8: '1' } });
      this.child = child;
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      this.state = { phase: target.kind === 'aki' ? 'launcher-opened' : 'starting', pid: child.pid, startedAt: Date.now(), logPath };
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        if (target.kind !== 'aki' || code !== 0) this.state = { ...this.state, phase: code === 0 ? 'stopped' : 'failed', exitCode: code, signal };
        this.healthSample = null;
      });
      child.on('error', error => { this.state = { ...this.state, phase: 'failed', error: error.message }; this.child = null; });
      child.unref(); this.healthSample = null;
      return this.status();
    } catch (error) {
      this.child = null; this.state = { phase: 'failed', error: error.message, logPath };
      throw error;
    } finally { await log.close(); }
  }
}
