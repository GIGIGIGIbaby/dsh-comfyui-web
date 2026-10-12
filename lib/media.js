import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const videoTypes = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime' };
const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
export const videoMime = file => videoTypes[String(file?.filename || '').split('.').at(-1).toLowerCase()];
const mediaMime = file => videoMime(file) || imageTypes[String(file?.filename || '').split('.').at(-1).toLowerCase()];
export function outputVideos(outputs = {}) {
  return Object.entries(outputs).flatMap(([nodeId, output]) =>
    ['videos', 'gifs', 'images'].flatMap(key => Array.isArray(output?.[key]) ? output[key] : [])
      .filter(videoMime).map(file => ({ ...file, nodeId })));
}
// Compare the executed prompt, never the user's possibly edited current graph.
// Standard PreviewImage and SaveImage encode the same IMAGE input as PNG, but
// their filenames, metadata and compression differ. Unknown nodes stay visible.
export function outputImages(history = {}, nodeId) {
  const outputs = history.outputs || {}, prompt = history.prompt?.[2] || {};
  const byNode = new Map(Object.entries(outputs).map(([id, output]) => [id,
    (Array.isArray(output?.images) ? output.images : []).filter(file => !videoMime(file)).map(file => ({ ...file, nodeId: id }))]));
  const source = id => {
    const link = prompt[id]?.inputs?.images;
    return Array.isArray(link) && link.length === 2 && ['string', 'number'].includes(typeof link[0])
      && String(link[0]) && Number.isInteger(link[1]) && link[1] >= 0 ? JSON.stringify([String(link[0]), link[1]]) : null;
  };
  const standardFiles = (files, type) => files.length > 0 && files.every(file => file.type === type && /\.png$/i.test(file.filename));
  const saved = [...byNode].filter(([id, files]) => prompt[id]?.class_type === 'SaveImage'
    && source(id) && standardFiles(files, 'output'));
  const replacements = new Map();
  for (const [id, files] of byNode) {
    if (prompt[id]?.class_type !== 'PreviewImage' || !source(id) || !standardFiles(files, 'temp')) continue;
    const match = saved.find(([saveId, saveFiles]) => source(saveId) === source(id) && saveFiles.length === files.length);
    if (match) replacements.set(id, match[1]);
  }
  // Explicit preview reads resolve to the matching saved batch as well, so an
  // AI inspection cannot add the same image again under its temporary filename.
  if (nodeId !== undefined) return replacements.get(String(nodeId)) || byNode.get(String(nodeId)) || [];
  return [...byNode].flatMap(([id, files]) => replacements.has(id) ? [] : files);
}
function validateFile(file) {
  if (!mediaMime(file) || typeof file.filename !== 'string' || /[\\/\x00-\x1f]/.test(file.filename)
    || typeof file.subfolder !== 'string' || /[\x00-\x1f]/.test(file.subfolder)
    || file.subfolder.split(/[\\/]/).some(part => part === '..') || /^[\\/]|^[A-Za-z]:/.test(file.subfolder)
    || !['output', 'temp', 'input'].includes(file.type)) throw new Error('无效的 ComfyUI 视频文件');
}
export class VideoMedia {
  constructor(runtime) { this.runtime = runtime; }
  async start(keyFile) {
    await mkdir(dirname(keyFile), { recursive: true });
    try { await writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.key = await readFile(keyFile);
    if (this.key.length !== 32) throw new Error('ComfyUI 视频播放密钥无效');
    return this;
  }
  sign(value) { return createHmac('sha256', this.key).update(value).digest(); }
  describe(file, promptId, sessionId) {
    const descriptor = { kind: videoMime(file) ? 'dsh-comfyui-web.video' : 'dsh-comfyui-web.image', promptId, nodeId: file.nodeId,
      filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' };
    validateFile(descriptor);
    const data = Buffer.from(JSON.stringify({ ...descriptor, sessionId, server: this.runtime.url })).toString('base64url');
    return { ...descriptor, url: '/dsh-comfyui/media?ticket=' + data + '.' + this.sign(data).toString('base64url') };
  }
  verify(ticket) {
    if (typeof ticket !== 'string' || ticket.length > 8192) throw new Error('无效的视频播放链接');
    const [data, signature, extra] = ticket.split('.');
    const bytes = Buffer.from(signature || '', 'base64url');
    if (extra || bytes.length !== 32 || !timingSafeEqual(this.sign(data || ''), bytes)) throw new Error('视频播放链接校验失败');
    const file = JSON.parse(Buffer.from(data, 'base64url').toString());
    validateFile(file);
    if (!file.sessionId || file.server !== this.runtime.url) throw new Error('视频不属于当前 ComfyUI 连接');
    return file;
  }
  async handle(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
      res.writeHead(403); res.end(); return;
    }
    let file;
    try { file = this.verify(new URL(req.url, 'http://localhost').searchParams.get('ticket')); }
    catch { res.writeHead(403); res.end(); return; }
    const range = req.headers.range;
    if (range && !/^bytes=(\d+-\d*|-\d+)$/.test(range)) { res.writeHead(416); res.end(); return; }
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', closed);
    const timer = setTimeout(() => controller.abort(new Error('视频读取超时')), 20000);
    try {
      const upstream = await fetch(this.runtime.url + '/view?' + query, { method: req.method,
        headers: range ? { Range: range } : {}, signal: controller.signal });
      clearTimeout(timer);
      if (![200, 206].includes(upstream.status)) { await upstream.body?.cancel(); res.writeHead(upstream.status); res.end(); return; }
      const type = upstream.headers.get('content-type')?.split(';')[0];
      if (type && !type.startsWith(mediaMime(file).split('/')[0] + '/') && type !== 'application/octet-stream') {
        await upstream.body?.cancel(); res.writeHead(415); res.end(); return;
      }
      const headers = { 'Content-Type': mediaMime(file), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name); if (value) headers[name] = value;
      }
      res.writeHead(upstream.status, headers);
      if (req.method === 'HEAD' || !upstream.body) res.end();
      else await pipeline(Readable.fromWeb(upstream.body), res);
    } finally { clearTimeout(timer); res.off('close', closed); }
  }
}
