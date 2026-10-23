import { readFile, writeFile, mkdir, stat, readdir, open } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isFile = path => stat(path).then(value => value.isFile(), () => false);
const isDirectory = path => stat(path).then(value => value.isDirectory(), () => false);
const launchExtensions = new Set(['.exe', '.bat', '.cmd', '.ps1', '.lnk']);
const isLaunchFile = path => launchExtensions.has(extname(path).toLowerCase());
const launcherHint = /comfy|aki|绘世|启动|launcher|^(run|start)([_. -]|$)/i;
const maintenanceEntry = /^unins|(?:^|[ _.-])(?:uninstall|setup|update|updater|crashpad)(?:[ _.-]|$)/i;
const normalizeKind = kind => kind === 'aki' ? 'launcher' : kind;
const publicTarget = ({ kind, path, root, comfyRoot, python }) => ({ kind, path, root, comfyRoot, ...(python ? { python } : {}) });

// Recognize installations by their files, never execute a discovered path during detection.
export async function inspectInstallation(input, { automatic = false } = {}) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) throw new Error('请选择本机的绝对路径');
  const selected = resolve(input);
  const file = await isFile(selected);
  if (file && !isLaunchFile(selected) && basename(selected).toLowerCase() !== 'main.py') {
    throw new Error('请选择 exe、bat、cmd、ps1、lnk 启动文件，或 ComfyUI 的 main.py');
  }
  let folder = file ? dirname(selected) : selected;
  if (!await isDirectory(folder)) throw new Error('所选路径不存在或不是文件夹');
  if (basename(folder) === '.launcher') folder = dirname(folder);
  const folders = [...new Set([folder, dirname(folder)])];
  const targets = [];
  const installations = [];
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
    installations.push({ root, comfyRoot: comfy, python });
    if (python) targets.push({ kind: 'comfyui', path: comfy, root: comfy, comfyRoot: comfy, python });
  }
  const addLauncher = path => {
    const root = dirname(path);
    const installation = installations.find(item => item.root === root || item.comfyRoot === root);
    targets.push({ kind: 'launcher', path, root, comfyRoot: installation?.comfyRoot, python: installation?.python });
  };
  if (file && isLaunchFile(selected)) {
    addLauncher(selected);
    // Selecting a file means exactly that entry, not a neighbouring Python installation.
    return targets.filter(item => item.kind === 'launcher').map(publicTarget);
  }
  if (!file) {
    const scanRoots = new Set([folder, ...installations.map(item => item.root)]);
    for (const root of scanRoots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.slice(0, 200)) {
        // A generic "launcher.exe" in the Start Menu may launch an unrelated app.
        // Automatic suggestions need ComfyUI context; explicit selection never does.
        if (automatic && !installations.length && !/comfy/i.test(basename(root)) && !/comfy/i.test(entry.name)) continue;
        if (entry.isFile() && isLaunchFile(entry.name) && !maintenanceEntry.test(entry.name)
          && (!automatic || launcherHint.test(entry.name))) addLauncher(join(root, entry.name));
      }
    }
  }
  const unique = [...new Map(targets.map(item => [item.kind + ':' + item.path.toLowerCase(), publicTarget(item)])).values()];
  if (!unique.length) throw new Error('未找到启动入口。请选择启动器或启动脚本，或包含 main.py 和本地 Python 环境的 ComfyUI 目录');
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
      join(homedir(), 'AppData', 'Local', 'Programs'),
      join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
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
    for (const target of await inspectInstallation(root, { automatic: true }).catch(() => [])) {
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
$dialog.Description = '选择启动器或 ComfyUI 安装目录'
$dialog.ShowNewFolderButton = $false` : `$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择启动器、启动脚本或 ComfyUI main.py'
$dialog.Filter = '启动入口|*.exe;*.bat;*.cmd;*.ps1;*.lnk;main.py|所有文件|*.*'
$dialog.DereferenceLinks = $false
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

export function launchCommand(target, address) {
  if (target.kind === 'comfyui') return { command: target.python,
    args: ['-s', join(target.root, 'main.py'), '--listen', address.host, '--port', address.port, '--disable-auto-launch'] };
  const extension = extname(target.path).toLowerCase();
  if (extension === '.exe') return { command: target.path, args: [] };
  if (extension === '.bat' || extension === '.cmd') {
    // Expand a single environment variable once. A literal %NAME%, ! or & inside the
    // filename must never turn into another expansion or a second shell command.
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', '""%DSH_COMFY_LAUNCH_PATH%""'],
      options: { windowsVerbatimArguments: true, env: { DSH_COMFY_LAUNCH_PATH: target.path } } };
  }
  // Windows PowerShell can silently exit before executing a script when created with
  // DETACHED_PROCESS. File-backed stdio + unref still allow it to outlive the host.
  if (extension === '.ps1') return { command: 'powershell.exe', args: ['-NoProfile', '-File', target.path], options: { detached: false } };
  if (extension === '.lnk') {
    const script = "$ErrorActionPreference = 'Stop'; try { Start-Process -FilePath $env:DSH_COMFY_LAUNCH_PATH -ErrorAction Stop } catch { [Console]::Error.WriteLine($_); exit 1 }";
    return { command: 'powershell.exe', args: ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      options: { detached: false, env: { DSH_COMFY_LAUNCH_PATH: target.path } } };
  }
  throw new Error('不支持的启动文件类型，请重新选择');
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
    this.selected = config.launcher ? { ...config.launcher, kind: normalizeKind(config.launcher.kind) } : null;
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
    kind = normalizeKind(kind);
    if (!['launcher', 'comfyui'].includes(kind)) throw new Error('请选择启动方式');
    const selected = (await inspectInstallation(path)).find(item => item.kind === kind && (kind !== 'launcher' || item.path.toLowerCase() === resolve(path).toLowerCase()));
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
    if (target.comfyRoot) await this.prepare(target);
    const logPath = join(dirname(this.runtime.configFile), 'launch.log');
    const log = await open(logPath, 'a', 0o600);
    await log.write('\n[' + new Date().toISOString() + '] ' + target.kind + ': ' + target.path + '\n');
    try {
      const { command, args, options = {} } = launchCommand(target, address);
      const child = this.spawn(command, args, { cwd: target.root, shell: false, detached: true,
        windowsHide: extname(target.path).toLowerCase() !== '.exe', ...options, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, PYTHONUTF8: '1', ...options.env } });
      this.child = child;
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      this.state = { phase: target.kind === 'launcher' ? 'launcher-opened' : 'starting', pid: child.pid, startedAt: Date.now(), logPath };
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        if (target.kind !== 'launcher' || code !== 0) this.state = { ...this.state, phase: code === 0 ? 'stopped' : 'failed', exitCode: code, signal };
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
