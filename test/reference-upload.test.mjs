import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { uploadImage } from '../lib/reference.js';

// Third-round report N7: reference-image uploads returned 参考图上传失败：400 for every call on this
// machine. The cause was not the network, the MIME or ComfyUI — it was `new FormData()` + `new Blob()`
// being Node's while `globalThis.fetch` had been replaced by another plugin's bundled undici, so the
// request lost its multipart boundary. These tests parse the bytes on the wire and run with hostile
// globals, which is the only way to pin that the upload depends on neither.

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');

// A deliberately naive parser: the boundary comes from the request header, and every part is cut on
// it. Nothing here knows about FormData, so what the plugin sends is all that is checked.
function parseMultipart(body, headerValue) {
  const boundary = /boundary=(.+)$/.exec(headerValue || '')?.[1];
  if (!boundary) return null;
  const chunks = body.toString('latin1').split('--' + boundary).filter(Boolean && (part => part.trim() !== '' && part.trim() !== '--'));
  const fields = {}, files = {};
  for (const raw of chunks) {
    const part = raw.replace(/^\r\n/, '').replace(/\r\n$/, '');
    if (part === '--') continue;
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    const content = Buffer.from(part.slice(split + 4), 'latin1');
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    if (filename !== undefined) files[name] = { filename, contentType: /content-type: ([^\r\n]+)/.exec(head)?.[1], content };
    else fields[name] = content.toString('utf8');
  }
  return { fields, files };
}

async function uploadServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { port: server.address().port, requests,
    runtime: { url: 'http://127.0.0.1:' + server.address().port, command: async () => ({ nodes: [{ id: '5', widgets: [{ name: 'image' }] }] }) } };
}

test('the upload is a real multipart request that carries image, type and overwrite', async t => {
  const seen = await uploadServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: 'dsh-upload.png', subfolder: '', type: 'input' }));
  });
  const result = await uploadImage(seen.runtime, { sessionId: 's', mediaType: 'image/png', bytes: pngBytes });
  assert.equal(result.widgetValue, 'dsh-upload.png');
  const request = seen.requests[0];
  assert.equal(request.url, '/upload/image');
  assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
  const parsed = parseMultipart(request.body, request.headers['content-type']);
  assert.ok(parsed, 'the boundary in the header must be findable in the body');
  assert.deepEqual(parsed.fields, { type: 'input', overwrite: 'false' }, 'the flags ComfyUI requires beside the file');
  assert.equal(Object.keys(parsed.files)[0], 'image');
  assert.match(parsed.files.image.filename, /^dsh-[0-9a-f-]+\.png$/);
  assert.equal(parsed.files.image.contentType, 'image/png');
  assert.deepEqual([...parsed.files.image.content], [...pngBytes], 'the bytes survive the hand-built body unchanged');
});

test('a foreign FormData and Blob in the process cannot break the upload', async t => {
  // The poison that broke every upload on this box: `globalThis.fetch` was another build's undici
  // while `globalThis.FormData` stayed Node's, and the mismatched pair produced a text/plain body.
  // Replacing the *constructors* with hostile stubs is the same class of fault and is what the fix
  // must be immune to: the body is assembled from Buffers, so neither global is ever consulted.
  const originals = { FormData: globalThis.FormData, Blob: globalThis.Blob };
  globalThis.FormData = class { set() { throw new Error('FormData came from a different implementation'); } };
  globalThis.Blob = class { constructor() { throw new Error('Blob came from a different implementation'); } };
  t.after(() => { globalThis.FormData = originals.FormData; globalThis.Blob = originals.Blob; });
  const seen = await uploadServer(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: 'dsh-hostile.png', type: 'input' }));
  });
  const result = await uploadImage(seen.runtime, { sessionId: 's', mediaType: 'image/jpeg', bytes: Buffer.from('/9j/4AAQSkZJRg==', 'base64') });
  assert.equal(result.uploaded, true, 'the upload still completes with hostile globals');
  const parsed = parseMultipart(seen.requests[0].body, seen.requests[0].headers['content-type']);
  assert.equal(parsed.files.image.contentType, 'image/jpeg');
  assert.equal(parsed.fields.type, 'input');
});

test('a refused upload reports what ComfyUI actually said', async t => {
  // "参考图上传失败：400" with an empty body is what sent the review into a retry loop: the server's
  // reason is the actionable half, and it was being thrown away.
  const seen = await uploadServer(t, (req, res) => { res.statusCode = 400; res.end('Invalid image file'); });
  await assert.rejects(uploadImage(seen.runtime, { sessionId: 's', mediaType: 'image/png', bytes: pngBytes }),
    /参考图上传失败：400 Invalid image file/);
  assert.equal(seen.requests.length, 1, 'and it still costs exactly one request');
});
