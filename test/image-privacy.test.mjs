import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('image privacy only owns the ComfyUI image tool and leaves dsh image slots untouched', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const registrations = [];
  let plugin;
  const context = vm.createContext({
    localStorage: { getItem: () => 'true' },
    window: {
      __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})); } },
      addEventListener() {}, removeEventListener() {}
    }
  });
  vm.runInContext(source, context);
  plugin.apply({
    effect(fn) { fn(); },
    sidebarRightTabs: { register() {} },
    sidebarRight: { openTab() {} },
    slots: { inject(_name, fn) { fn(); }, register(def, component) { registrations.push({ def, component }); } }
  });
  const globalImageSlots = ['conversation.message.images', 'conversation.trajectory.images', 'tool.call.images'];
  assert.equal(registrations.some(row => globalImageSlots.includes(row.def.name)), false,
    'privacy must not replace renderers for unrelated dsh images');
  const toolViews = registrations.filter(row => row.def.name === 'tool.call.toolview');
  assert.equal(toolViews.length, 2);
  assert.equal(toolViews[0].def.key, 'mcp__comfyui__get_image');
  assert.equal(toolViews[1].def.key, 'mcp__comfyui__get_video');
  for (const toolName of ['read_image', 'mcp__other__get_image', 'mcp__comfyui__history']) {
    assert.equal(toolViews[0].component({ toolName, block: {} }), null,
      'an unrelated tool must not enter the ComfyUI image renderer');
  }
  assert.ok(registrations.some(row => row.def.name === 'conversation.chat.turnTail'),
    'ComfyUI results need a persistent seat outside the tool process');
});

test('reply results recover hidden and nested ComfyUI image calls from the owning turn and session', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const registrations = [];
  let plugin;
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useCallback(fn) { return fn; }, useSyncExternalStore(_subscribe, read) { return read(); }
  };
  const context = vm.createContext({ localStorage: { getItem: () => null }, window: {
    __ModuleLoader__: { load({ factory }) { plugin = factory(() => react); } },
    addEventListener() {}, removeEventListener() {}
  } });
  vm.runInContext(source, context);
  const result = (callId, name, attachmentId, isError = false) => ({ kind: 'tool-result', callId,
    call: { name }, isError, content: [{ type: 'image', attachment: { attachmentId } }], subCalls: [] });
  const owned = result('owned', 'mcp__comfyui__get_image', 'image-a');
  const duplicate = result('repeat', 'mcp__comfyui__get_image', 'image-a');
  const nested = result('nested', 'mcp__comfyui__get_image', 'image-b');
  const parent = result('parent', 'run_code', 'ignored'); parent.subCalls = [nested];
  const unrelated = result('read', 'read_image', 'other-image');
  const failed = result('failed', 'mcp__comfyui__get_image', 'failed-image', true);
  const nodes = new Map([owned, duplicate, parent, unrelated, failed].map(block => [block.callId,
    { kind: 'tool-call', visibility: 'hidden', data: { root: block } }]));
  nodes.set('other-turn', { kind: 'tool-call', data: { root: result('other', 'mcp__comfyui__get_image', 'wrong-turn-image') } });
  const snapshot = { nodes, locations: { getTurn(turn) { return turn === 3 ? ['owned', 'repeat', 'parent', 'read', 'failed'] : ['other-turn']; } } };
  const readScopes = [];
  const ctx = {
    effect(fn) { fn(); }, sidebarRightTabs: { register() {} }, sidebarRight: { openTab() {} },
    slots: { inject(_name, fn) { fn(); }, register(def, component) { registrations.push({ def, component }); } },
    uiConversation: {
      binding(sessionId) { readScopes.push(sessionId); return { target(name) { assert.equal(name, 'chat'); return { getSnapshot: () => snapshot }; } }; },
      imageUrl(sessionId, attachment) { return Promise.resolve(sessionId + ':' + attachment.attachmentId); },
      peekImageUrl(sessionId, attachment) { return sessionId + ':' + attachment.attachmentId; }
    }
  };
  plugin.apply(ctx);
  const tail = registrations.find(row => row.def.name === 'conversation.chat.turnTail');
  const injected = tail.def.inject('own-session');
  const rendered = tail.component({ ...injected, turn: { turn: 3 } });
  const gallery = rendered.props.children.find(child => typeof child?.type === 'function');
  assert.deepEqual(Array.from(gallery.props.images, image => image.attachment.attachmentId), ['image-a', 'image-b']);
  assert.deepEqual(readScopes, ['own-session']);
  assert.equal(await injected.loadImage({ attachmentId: 'image-a' }), 'own-session:image-a');
  assert.equal(injected.loadImage.peek({ attachmentId: 'image-b' }), 'own-session:image-b');
  const emptySource = { getSnapshot: () => ({ nodes: new Map(), locations: { getTurn: () => [] } }) };
  assert.equal(tail.component({ ...injected, resultSource: emptySource, turn: { turn: 3 } }), null);
  const tool = registrations.find(row => row.def.key === 'mcp__comfyui__get_image');
  const callRow = tool.component({ toolName: 'mcp__comfyui__get_image', block: owned });
  assert.equal(callRow.props.children.some(child => typeof child?.type === 'function'), false,
    'the tool process must not contain a second image gallery');
});
