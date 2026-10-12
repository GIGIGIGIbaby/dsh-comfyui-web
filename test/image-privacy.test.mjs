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
  assert.equal(toolViews.length, 1);
  assert.equal(toolViews[0].def.key, 'mcp__comfyui__get_image');
  for (const toolName of ['read_image', 'mcp__other__get_image', 'mcp__comfyui__history']) {
    assert.equal(toolViews[0].component({ toolName, block: {} }), null,
      'an unrelated tool must not enter the ComfyUI image renderer');
  }
});
