import { randomUUID } from 'node:crypto';

export function referenceImages(session) {
  const found = new Map();
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user') continue;
    for (const part of message.content || []) if (part.type === 'image' && part.attachment) {
      found.delete(part.attachment.attachmentId);
      found.set(part.attachment.attachmentId, part.attachment);
    }
  }
  return [...found.values()].reverse();
}
const UPLOAD_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** The cheap refusals, apart from the upload so a doomed call never claims the canvas write
 *  lease: an attachment that cannot be an image should fail before it locks the graph. */
export function assertUploadable(mediaType, bytes) {
  if (!UPLOAD_MIME.includes(mediaType)) throw new Error('只支持 PNG、JPEG、WebP、GIF 参考图');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('参考图需要在 1 字节到 20 MB 之间');
}
// The multipart body is assembled by hand, and neither `FormData` nor `Blob` is touched.
// Measured on this machine: another plugin in the same process replaces `globalThis.fetch` with
// its own bundled undici (`@opencode2dsh/dsh-plugin` installer: `globalThis.fetch = moduleFetch`),
// while `globalThis.FormData` stays Node's. A Request whose body is a FormData from a *different*
// implementation than the fetch that sends it loses its boundary and is sent as
// `content-type: text/plain;charset=UTF-8`; ComfyUI's `image_upload()` then sees no `image` field
// and answers a bare 400 with an empty body — which is exactly what every reference-image upload
// on this box did, in both the dataBase64 and the attachment path, while the same bytes through a
// matched pair returned 200. Owning the bytes makes the call independent of whatever the process
// globals have been edited into.
const multipartBody = ({ filename, mime, bytes, fields }) => {
  const boundary = '----dshComfyBoundary' + randomUUID().replace(/-/g, '');
  const head = text => Buffer.from(text, 'utf8');
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(head(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(head(`--${boundary}\r\ncontent-disposition: form-data; name="image"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`));
  parts.push(Buffer.from(bytes));
  parts.push(head(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
};
export async function uploadImage(runtime, args, signal) {
  if (args.nodeId) {
    const data = await runtime.command(args.sessionId, 'list_nodes', {}, signal, args.clientId);
    if (!data.nodes?.some(node => node.id === String(args.nodeId) && node.widgets?.some(widget => widget.name === (args.widget || 'image'))))
      throw new Error('目标图片参数不存在，请先 list_nodes 获取准确 nodeId/widget');
  }
  const mime = args.mediaType;
  const bytes = args.bytes || Buffer.from(args.dataBase64 || '', 'base64');
  assertUploadable(mime, bytes);
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
  const filename = 'dsh-' + randomUUID() + '.' + extension;
  const { boundary, body } = multipartBody({ filename, mime, bytes, fields: { type: 'input', overwrite: 'false' } });
  const response = await fetch(runtime.url + '/upload/image', { method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': String(body.length) },
    body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  // A non-2xx body carries the reason (a path outside the input dir, an unsupported extension), and
  // a bare "400" with nothing else is what sent this whole feature into a retry loop during the
  // review; keep whatever the server actually said.
  if (!response.ok) throw new Error('参考图上传失败：' + response.status + ' ' + (await response.text().catch(() => '')).slice(0, 200));
  const file = await response.json();
  if (typeof file.name !== 'string' || /[\\/]/.test(file.name)) throw new Error('ComfyUI 返回了无效的图片名称');
  const value = (file.subfolder ? file.subfolder + '/' : '') + file.name;
  let binding, bindingError;
  if (args.nodeId) {
    try { binding = await runtime.command(args.sessionId, 'bind_image', { nodeId: args.nodeId, widget: args.widget || 'image', value }, signal, args.clientId); }
    catch (error) { bindingError = '图片已上传，但绑定失败：' + error.message + '。请使用 widgetValue 修正节点，不要重复上传。'; }
  }
  return { uploaded: true, filename: file.name, subfolder: file.subfolder || '', type: file.type || 'input',
    widgetValue: value, ...(binding ? { binding } : {}), ...(bindingError ? { bindingError } : {}), ...(!args.nodeId ? { message: '已上传；使用 update_nodes 将 widgetValue 填入目标图片节点，或指定 nodeId 上传并绑定。' } : {}) };
}
