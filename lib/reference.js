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
export async function uploadImage(runtime, args, signal) {
  if (args.nodeId) {
    const data = await runtime.command(args.sessionId, 'list_nodes', {}, signal, args.clientId);
    if (!data.nodes?.some(node => node.id === String(args.nodeId) && node.widgets?.some(widget => widget.name === (args.widget || 'image'))))
      throw new Error('目标图片参数不存在，请先 list_nodes 获取准确 nodeId/widget');
  }
  const mime = args.mediaType;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('只支持 PNG、JPEG、WebP、GIF 参考图');
  const bytes = args.bytes || Buffer.from(args.dataBase64 || '', 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('参考图需要在 1 字节到 20 MB 之间');
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
  const filename = 'dsh-' + randomUUID() + '.' + extension;
  const form = new FormData();
  form.set('image', new Blob([bytes], { type: mime }), filename);
  form.set('type', 'input'); form.set('overwrite', 'false');
  const response = await fetch(runtime.url + '/upload/image', { method: 'POST', body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('参考图上传失败：' + response.status);
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
