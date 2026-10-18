import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse } from 'node:path';

const setupHint = '请在 ~/.dsh/comfyui/config.json 中设置 customNodesDir 或 frontendExtensionsDir。路径必须能被运行 dsh 的系统写入，并能被 ComfyUI 读取；Docker 建议使用已持久化挂载的 custom_nodes 目录。';
const setupHintEn = 'Set customNodesDir or frontendExtensionsDir in ~/.dsh/comfyui/config.json. The path must be writable by the system running dsh and readable by ComfyUI. For Docker, use a persistent mounted custom_nodes directory.';
const errorEn = message => ({
  'customNodesDir 与 frontendExtensionsDir 请只设置一个，避免安装两份桥接扩展': 'Set either customNodesDir or frontendExtensionsDir, not both, to avoid installing the bridge twice.',
  '请填写运行 dsh 的系统可访问的绝对路径；Windows 不能直接使用容器内的 /usr/... 路径': 'Enter an absolute path accessible to the system running dsh. Windows cannot directly use a container path such as /usr/….'
})[message] || message;

export async function installComfyExtension(config, bridgeOrigin) {
  const custom = config.customNodesDir, frontend = config.frontendExtensionsDir;
  if (!custom && !frontend) return { status: 'unconfigured', message: '尚未配置 ComfyUI 桥接扩展。' + setupHint,
    messageEn: 'The ComfyUI bridge extension has not been configured. ' + setupHintEn };
  const mode = custom ? 'custom_nodes' : 'frontend';
  const target = custom || frontend;
  try {
    if (custom && frontend) throw new Error('customNodesDir 与 frontendExtensionsDir 请只设置一个，避免安装两份桥接扩展');
    if (typeof target !== 'string' || !isAbsolute(target)
      || (process.platform === 'win32' && parse(target).root.length <= 1)) {
      throw new Error('请填写运行 dsh 的系统可访问的绝对路径；Windows 不能直接使用容器内的 /usr/... 路径');
    }
    const directory = join(target, custom ? 'dsh-comfyui-bridge' : 'dsh-comfyui');
    const web = custom ? join(directory, 'web') : directory;
    const source = await readFile(new URL('../comfy-extension.js', import.meta.url), 'utf8');
    await mkdir(web, { recursive: true });
    await writeFile(join(web, 'loader.js'), source.replaceAll('__DSH_DEFAULT_BRIDGE__', JSON.stringify(bridgeOrigin)), 'utf8');
    if (custom) await writeFile(join(directory, '__init__.py'),
      'WEB_DIRECTORY = "./web"\nNODE_CLASS_MAPPINGS = {}\n__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS"]\n', 'utf8');
    return { status: 'installed', mode, directory,
      messageEn: 'Bridge extension installed. After first installation, restart ComfyUI and refresh the dsh panel. For Docker, make sure this directory is mounted into the container’s custom_nodes directory.',
      message: '桥接扩展已写入。首次安装请重启 ComfyUI，再刷新 dsh 面板；Docker 需确认此目录已挂载到容器的 custom_nodes。' };
  } catch (error) {
    return { status: 'failed', mode, message: 'ComfyUI 桥接扩展安装失败：' + error.message + '。' + setupHint,
      messageEn: 'Could not install the ComfyUI bridge extension: ' + errorEn(error.message) + ' ' + setupHintEn };
  }
}
