import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyLauncher, detectInstallations, inspectInstallation, localLaunchAddress } from '../lib/launcher.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "AKi & test ' 中文 %value%");
  const comfy = join(root, 'ComfyUI');
  await mkdir(join(comfy, 'comfy'), { recursive: true });
  await mkdir(join(root, 'python'), { recursive: true });
  await writeFile(join(comfy, 'main.py'), '# fixture');
  await writeFile(join(root, 'python', 'python.exe'), 'fixture, never executed');
  await writeFile(join(root, '绘世启动器.exe'), 'fixture, never executed');
  const configFile = join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ url: 'http://127.0.0.1:8188', mcpEnabled: false, customNodesDir: join(comfy, 'custom_nodes') }));
  return { root, comfy, configFile, url: 'http://127.0.0.1:8188' };
}

function processDouble(fail = false) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter(); child.pid = 4321; child.unref = () => {};
    calls.push({ file, args, options, child });
    queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', new Error('spawn denied')));
    return child;
  };
  return { calls, spawn };
}

test('detects both AKi and its bundled ComfyUI without executing any files', async t => {
  const fixtureData = await fixture(t);
  const targets = await inspectInstallation(fixtureData.root);
  assert.equal(targets.length, 2);
  assert.equal(targets.find(item => item.kind === 'comfyui').path, fixtureData.comfy);
  assert.equal(targets.find(item => item.kind === 'comfyui').python, join(fixtureData.root, 'python', 'python.exe'));
  const detected = await detectInstallations({ customNodesDir: join(fixtureData.comfy, 'custom_nodes') }, { roots: [] });
  assert.deepEqual(detected.map(item => item.kind).sort(), ['aki', 'comfyui']);
  assert.equal((await inspectInstallation(join(fixtureData.comfy, 'main.py'))).length, 2);
  await assert.rejects(inspectInstallation('relative/path'), /绝对路径/);
  await assert.rejects(inspectInstallation(join(fixtureData.root, 'missing')), /不存在/);
});

test('portable Python and local venv installations are recognized', async t => {
  const data = await fixture(t);
  await rm(join(data.root, 'python'), { recursive: true });
  await mkdir(join(data.root, 'python_embeded'));
  await writeFile(join(data.root, 'python_embeded', 'python.exe'), 'fixture');
  assert.match((await inspectInstallation(data.root)).find(item => item.kind === 'comfyui').python, /python_embeded/);
  await rm(join(data.root, 'python_embeded'), { recursive: true });
  await mkdir(join(data.comfy, '.venv', 'Scripts'), { recursive: true });
  await writeFile(join(data.comfy, '.venv', 'Scripts', 'python.exe'), 'fixture');
  assert.match((await inspectInstallation(data.comfy)).find(item => item.kind === 'comfyui').python, /\.venv/);
});

test('cancelled native selection preserves the saved target and unrelated settings', async t => {
  const data = await fixture(t);
  const launcher = await new ComfyLauncher(data, { probe: async () => false, picker: async () => null }).init();
  await launcher.select(data.comfy, 'comfyui');
  const before = await readFile(data.configFile, 'utf8');
  const result = await launcher.pick('folder', new AbortController().signal);
  assert.equal(result.cancelled, true);
  assert.equal(await readFile(data.configFile, 'utf8'), before);
  assert.equal(JSON.parse(before).mcpEnabled, false);
  assert.equal(JSON.parse(before).customNodesDir, join(data.comfy, 'custom_nodes'));
});

test('direct launch uses an argv array and blocks duplicate requests while starting', async t => {
  const data = await fixture(t), fake = processDouble();
  const launcher = await new ComfyLauncher(data, { platform: 'win32', spawn: fake.spawn, probe: async () => false }).init();
  await launcher.select(data.comfy, 'comfyui');
  await Promise.all([launcher.start(), launcher.start(), launcher.start()]);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.file, join(data.root, 'python', 'python.exe'));
  assert.deepEqual(call.args, ['-s', join(data.comfy, 'main.py'), '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.cwd, data.comfy);
  assert.equal((await launcher.start()).phase, 'starting');
  assert.equal(fake.calls.length, 1);
  fake.calls[0].child.emit('exit', 1, null);
  assert.equal((await launcher.status()).phase, 'failed');
  await launcher.start();
  assert.equal(fake.calls.length, 2, 'a failed start can be retried');
});

test('AKi opens its selected launcher without assuming an unsupported auto-start flag', async t => {
  const data = await fixture(t), fake = processDouble();
  const launcher = await new ComfyLauncher(data, { platform: 'win32', spawn: fake.spawn, probe: async () => false }).init();
  const exe = join(data.root, '绘世启动器.exe');
  await launcher.select(exe, 'aki');
  assert.equal((await launcher.start()).phase, 'launcher-opened');
  assert.equal(fake.calls[0].file, exe);
  assert.deepEqual(fake.calls[0].args, []);
  assert.equal(fake.calls[0].options.windowsHide, false);
  fake.calls[0].child.emit('exit', 0, null);
  await launcher.start();
  assert.equal(fake.calls.length, 1, 'launcher handoff does not trigger a second instance');
});

test('running services, remote URLs and unsupported hosts never spawn a local process', async t => {
  const data = await fixture(t), fake = processDouble();
  const launcher = await new ComfyLauncher(data, { platform: 'win32', spawn: fake.spawn, probe: async () => true }).init();
  assert.equal((await launcher.start()).alreadyRunning, true);
  data.url = 'http://192.168.1.2:8188';
  await assert.rejects(launcher.start(), /远程/);
  assert.equal((await launcher.status()).supported, false);
  const linux = new ComfyLauncher(data, { platform: 'linux', spawn: fake.spawn });
  await assert.rejects(linux.start(), /Windows/);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(localLaunchAddress('http://[::1]:8190'), { host: '::1', port: '8190' });
});

test('missing interpreters and spawn failures report failure rather than readiness', async t => {
  const data = await fixture(t), fake = processDouble(true);
  const launcher = await new ComfyLauncher(data, { platform: 'win32', spawn: fake.spawn, probe: async () => false }).init();
  await launcher.select(data.comfy, 'comfyui');
  await assert.rejects(launcher.start(), /spawn denied/);
  assert.equal((await launcher.status()).phase, 'failed');
  await rm(join(data.root, 'python', 'python.exe'));
  await assert.rejects(launcher.start(), /失效/);
  assert.equal(fake.calls.length, 1);
});

test('transient health failures neither mark a running service offline nor launch a duplicate', async () => {
  let online = true, now = 100000;
  const runtime = { url: 'http://127.0.0.1:8188' }, fake = processDouble();
  const launcher = new ComfyLauncher(runtime, { platform: 'win32', spawn: fake.spawn, probe: async () => online, now: () => now });
  assert.equal((await launcher.status()).connected, true);
  online = false; now += 3000;
  assert.equal((await launcher.status()).connected, true, 'a brief busy interval preserves readiness');
  assert.equal((await launcher.start()).alreadyRunning, true);
  assert.equal(fake.calls.length, 0);
  now += 30000;
  assert.equal((await launcher.status()).connected, false, 'a sustained outage is still reported');
  online = true; now += 3000;
  assert.equal((await launcher.status()).connected, true);
  runtime.url = 'http://127.0.0.1:8190'; online = false;
  assert.equal((await launcher.status()).connected, false, 'another URL cannot inherit the grace period');
});
