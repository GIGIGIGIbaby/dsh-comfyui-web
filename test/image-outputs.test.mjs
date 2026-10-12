import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { outputImages } from '../lib/media.js';
import { GenerationMonitor } from '../lib/generation.js';
import { callComfyTool } from '../lib/mcp.js';

const file = (filename, type = 'output') => ({ filename, type, subfolder: '' });
function history() {
  return { prompt: [0, 'p', {
    9: { class_type: 'PreviewImage', inputs: { images: ['8', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'final' } },
    11: { class_type: 'PreviewImage', inputs: { images: ['upscale', 0] } }
  }], status: { status_str: 'success' }, outputs: {
    9: { images: [file('preview-a.png', 'temp'), file('preview-b.png', 'temp')] },
    10: { images: [file('saved-a.png'), file('saved-b.png')] },
    11: { images: [file('upscaled.png', 'temp')] }
  } };
}

test('completion displays the saved batch once and retains a different preview branch', async () => {
  const h = history(), original = structuredClone(h);
  const monitor = new GenerationMonitor({});
  const record = monitor.track('p', 'owner');
  monitor.fromHistory(record, h);
  assert.deepEqual((await monitor.wait('p', 'owner')).images.map(image => image.filename),
    ['saved-a.png', 'saved-b.png', 'upscaled.png']);
  assert.deepEqual(h, original, 'selection must leave the actual generation history unchanged');
});

test('preview-only, different slots, missing saves and unknown nodes are never hidden', () => {
  const h = history();
  delete h.outputs[10];
  assert.deepEqual(outputImages(h).map(image => image.filename), ['preview-a.png', 'preview-b.png', 'upscaled.png']);
  const otherSlot = history(); otherSlot.prompt[2][10].inputs.images[1] = 1;
  assert.equal(outputImages(otherSlot).length, 5);
  const unknown = history(); unknown.prompt[2][10].class_type = 'CustomSaveAndTransform';
  assert.equal(outputImages(unknown).length, 5);
  const noGraph = history(); delete noGraph.prompt;
  assert.equal(outputImages(noGraph).length, 5);
  const partial = history(); partial.outputs[10].images.pop();
  assert.equal(outputImages(partial).length, 4, 'different batch lengths must not silently lose images');
  const noInput = history(); delete noInput.prompt[2][10].inputs;
  assert.equal(outputImages(noInput).length, 5);
  const video = history(); video.outputs[12] = { images: [file('clip.mp4')] };
  assert.equal(outputImages(video).length, 3, 'video outputs are handled by the video renderer');
});

test('AI inspection of a duplicate preview reads the saved image and preserves batch indexing', async t => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push(new URL(req.url, 'http://localhost').searchParams.get('filename'));
    res.setHeader('Content-Type', 'image/png'); res.end('image fixture');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const runtime = { mcpEnabled: true, url: 'http://127.0.0.1:' + upstream.address().port,
    request: async () => ({ p: history() }) };
  const result = await callComfyTool(runtime, 'get_image', { promptId: 'p', nodeId: '9', index: 1 });
  assert.deepEqual(requests, ['saved-b.png']);
  assert.equal(result.structuredContent.image.nodeId, '10');
  assert.equal(result.structuredContent.image.promptId, 'p');
  assert.equal(result.content[1].type, 'image');
  await callComfyTool(runtime, 'get_image', { promptId: 'p' });
  await callComfyTool(runtime, 'get_image', { promptId: 'p', nodeId: '11' });
  assert.deepEqual(requests, ['saved-b.png', 'saved-a.png', 'upscaled.png']);
});
