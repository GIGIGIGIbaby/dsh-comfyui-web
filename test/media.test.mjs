import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VideoMedia, outputVideos } from '../lib/media.js';
import { callComfyTool } from '../lib/mcp.js';

test('video result recognizes native and VHS outputs and signs durable playback links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-'));
  const outputs = { 7: { gifs: [{ filename: 'clip.mp4' }, { filename: 'animated.gif' }] },
    8: { videos: [{ filename: 'movie.webm' }] }, 9: { images: [{ filename: 'image.png' }] } };
  assert.deepEqual(outputVideos(outputs).map(v => [v.nodeId, v.filename]), [['7', 'clip.mp4'], ['8', 'movie.webm']]);
  const runtime = { mcpEnabled: true, url: 'http://127.0.0.1:8188', request: async () => ({ p: { outputs } }) };
  runtime.media = await new VideoMedia(runtime).start(join(dir, 'key'));
  const result = await callComfyTool(runtime, 'get_video', { promptId: 'p', nodeId: '8' }, { dshSessionId: 'own' });
  assert.equal(result.structuredContent.filename, 'movie.webm');
  assert.equal(result.content[0].type, 'text');
  const ticket = new URL(result.structuredContent.url, 'http://localhost').searchParams.get('ticket');
  const restarted = await new VideoMedia(runtime).start(join(dir, 'key'));
  assert.equal(restarted.verify(ticket).sessionId, 'own');
  assert.throws(() => restarted.verify('x' + ticket), /校验/);
  assert.throws(() => restarted.describe({ filename: '../secret.mp4' }, 'p', 'own'), /无效/);
  assert.throws(() => restarted.describe({ filename: 'clip.mp4', subfolder: '../outside' }, 'p', 'own'), /无效/);
  runtime.url = 'http://127.0.0.1:9191';
  assert.throws(() => restarted.verify(ticket), /连接/);
  await assert.rejects(() => callComfyTool(runtime, 'get_video', { promptId: 'p' }), /当前对话/);
});

test('video playback streams ranges, HEAD and failures without exposing arbitrary files', async t => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, range: req.headers.range });
    if (new URL(req.url, 'http://localhost').searchParams.get('filename') === 'html.mp4') {
      res.setHeader('Content-Type', 'text/html'); res.end('bad'); return;
    }
    res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': req.headers.range ? 4 : 8,
      'Accept-Ranges': 'bytes', ...(req.headers.range ? { 'Content-Range': 'bytes 2-5/8' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : req.headers.range ? 'cdef' : 'abcdefgh');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const runtime = { url: 'http://127.0.0.1:' + upstream.address().port };
  const dir = await mkdtemp(join(tmpdir(), 'dsh-video-stream-'));
  const media = await new VideoMedia(runtime).start(join(dir, 'key'));
  const server = http.createServer((req, res) => media.handle(req, res).catch(e => res.destroy(e)));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const path = media.describe({ filename: 'clip.mp4', subfolder: 'video' }, 'p', 'own').url;
  const range = await fetch(base + path, { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 2-5/8');
  assert.equal(await range.text(), 'cdef'); assert.equal(received[0].range, 'bytes=2-5');
  assert.equal(new URL(received[0].url, base).searchParams.get('subfolder'), 'video');
  const head = await fetch(base + path, { method: 'HEAD' }); assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '8'); assert.equal(await head.text(), '');
  assert.equal((await fetch(base + path, { headers: { Range: 'bytes=0-1,3-5' } })).status, 416);
  assert.equal((await fetch(base + path, { headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await fetch(base + '/dsh-comfyui/media?ticket=invalid')).status, 403);
  assert.equal((await fetch(base + media.describe({ filename: 'html.mp4' }, 'p', 'own').url)).status, 415);
});
