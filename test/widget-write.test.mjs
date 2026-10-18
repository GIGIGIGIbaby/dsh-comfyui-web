import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// Boots bridge.js against a fake ComfyUI page whose widgets reproduce the real failure
// classes found in the installed packs: a hidden original widget replaced by a DOM widget
// that owns the value, a structured "reference document" in node.properties that shadows
// writes, a localized combo whose options are display strings, and a setter that just
// refuses to apply.
async function boot(nodes) {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test"');
  const timers = [], replies = [], commands = [];
  const graph = {
    _nodes: nodes,
    serialize: () => ({ nodes: nodes.map(n => ({ id: n.id, type: n.type, widgets_values: (n.widgets || []).map(w => w.value) })), links: [], groups: [] }),
    setDirtyCanvas() {},
    getNodeById(id) { return nodes.find(node => String(node.id) === String(id)); }
  };
  const workflow = { path: 'workflows/H3.json', filename: 'H3', isLoaded: true, isPersisted: true, isModified: false };
  const app = { rootGraph: graph, graph, canvas: {}, configuringGraph: false,
    extensionManager: { workflow: { activeWorkflow: workflow, openWorkflows: [workflow] } },
    async graphToPrompt() { return { output: {} }; } };
  vm.runInContext(code, vm.createContext({
    window: { parent: { postMessage() {} }, comfyAPI: { app: { app } }, addEventListener() {}, LiteGraph: { createNode: () => null } },
    crypto: { randomUUID: () => 'u' + Math.random() }, URL, URLSearchParams, console,
    location: { origin: 'http://comfy.test', search: '?dsh_client=p&dsh_session=own', href: 'http://comfy.test/' },
    document: { referrer: 'http://dsh.test/', visibilityState: 'visible', addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: fn => timers.push(fn), clearTimeout() {},
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      if (String(url).includes('/result')) replies.push(body);
      return { ok: true, status: 200, json: async () => String(url).includes('/poll') ? { commands: commands.splice(0) } : { revision: 1 } };
    }
  }));
  await flush();
  return async (action, args = {}) => {
    commands.push({ id: 'c' + (replies.length + 1), action, args });
    timers.shift()(); await flush();
    const reply = replies.at(-1);
    // The bridge reports the message and the next step separately (the MCP layer joins them
    // with "下一步："). Keep both reachable so a test can assert on the actionable half.
    if (reply?.error) throw Object.assign(new Error(reply.error), { bridgeError: reply.error, hint: reply.hint, stackTrace: reply.stack });
    return reply.result;
  };
}

const plainNode = () => ({ id: 1, type: 'KSampler', title: '', mode: 0, properties: {},
  widgets: [{ name: 'steps', type: 'number', value: 20, min: 1, max: 100, options: { min: 1, max: 100 }, callback: () => {} },
    { name: 'mode', type: 'combo', value: 'T2VA 文生视频', options: { values: ['T2VA 文生视频', 'I2VA 图生视频'] }, callback: () => {} }],
  inputs: [], outputs: [] });

// The AICG3D shape: `prompt` is hidden and its value is only reachable through the DOM
// widget, which refuses to apply while a reference document shadows it.
const editorNode = () => {
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: '旧内容', options: { hidden: true }, callback: () => {} };
  const doc = () => node.properties['minimax_h3_prompt_reference_doc'];
  const node = { id: 2, type: 'AICG3D_H3', title: '', mode: 0, properties: { minimax_h3_prompt_reference_doc: { parts: ['a', 'b'] } },
    widgets: [prompt, { name: 'h3_prompt_mentions', type: 'h3_prompt_mentions', value: undefined, serialize: false,
      options: { serialize: false,
        getValue: () => String(prompt.value || ''),
        setValue: value => { if (doc()) return; prompt.value = String(value); } } }],
    inputs: [], outputs: [] };
  return node;
};

const stubbornNode = () => ({ id: 3, type: 'SomeVueNode', title: '', mode: 0, properties: {},
  widgets: [{ name: 'text', type: 'custom', value: 'kept', options: { getValue: () => 'kept', setValue: () => {} } }],
  inputs: [], outputs: [] });

test('list_nodes marks the widgets whose value is not the source of truth', async () => {
  const command = await boot([plainNode(), editorNode(), stubbornNode()]);
  const listed = await command('list_nodes');
  const byId = id => listed.nodes.find(node => node.id === String(id));
  assert.equal(byId(1).widgets.find(w => w.name === 'steps').kind, undefined, 'a plain widget needs no warning');
  assert.equal(byId(1).widgets.find(w => w.name === 'mode').kind, undefined);
  assert.equal(byId(2).widgets.find(w => w.name === 'prompt').kind, 'hidden');
  assert.equal(byId(2).widgets.find(w => w.name === 'h3_prompt_mentions').kind, 'dom');
  assert.equal(byId(3).widgets.find(w => w.name === 'text').kind, 'dom');
});

test('writing a hidden prompt reroutes to the DOM widget and clears the shadowing document', async () => {
  const node = editorNode();
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 2, widget: 'prompt', value: '镜1：手腕举起座套' }] });
  const change = result.changed[0];
  assert.equal(change.requestedWidget, 'prompt', 'the reply says which widget was asked for');
  assert.equal(change.widget, 'h3_prompt_mentions', 'and which one actually owns the value');
  assert.equal(change.warning, undefined);
  assert.equal(result.warning, undefined, 'no warning when everything verified');
  assert.equal(change.verified, true);
  assert.equal(change.via, 'dom-setter', 'the reply names which setter family applied the value');
  assert.deepEqual(change.shadowDocsCleared, ['minimax_h3_prompt_reference_doc']);
  assert.equal(node.properties['minimax_h3_prompt_reference_doc'], undefined, 'the shadow is really gone');
  assert.equal(node.widgets[0].value, '镜1：手腕举起座套', 'the archived value the prompt uses is updated');
});

test('a setter that refuses to apply is reported as unverified instead of success', async () => {
  const command = await boot([stubbornNode()]);
  const result = await command('update_nodes', { changes: [{ nodeId: 3, widget: 'text', value: 'new' }] });
  assert.equal(result.changed[0].verified, false);
  assert.equal(result.changed[0].after, 'kept');
  assert.match(result.warning, /状态由前端组件/);
});

test('plain widgets still write through value+callback and verify', async () => {
  const node = plainNode();
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 30 }] });
  assert.deepEqual({ ...result.changed[0], nodeId: undefined }, { nodeId: undefined, widget: 'steps', before: 20, after: 30, via: 'value+callback', verified: true });
  assert.equal(node.widgets[0].value, 30);
});

test('a localized combo rejects the authoritative value and answers with the display options', async () => {
  const command = await boot([plainNode()]);
  const error = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'mode', value: 'reference' }] }).catch(e => e.bridgeError);
  assert.match(error, /值不在可选项中/);
  assert.match(error, /"T2VA 文生视频"/, 'the reply carries the options the canvas actually accepts');
  const ok = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'mode', value: 'I2VA 图生视频' }] });
  assert.equal(ok.changed[0].verified, true);
});

// The real shape of ComfyUI 0.39's native widgets (ComboWidget/NumberWidget/TextWidget/
// BooleanWidget): value lives on the widget, setValue is a prototype method whose second
// argument is destructured, and a value-only call throws from inside the frontend bundle.
const nativeNode = () => {
  const widget = (name, type, value, options = {}) => {
    const w = { name, type, value, options, callback: () => {} };
    w.setValue = function (next, context) {
      const { e, node, canvas } = context;
      void e; void canvas;
      assert.ok(node, 'the native setter needs its node context');
      if (this.type === 'number') this.value = Number(next); else this.value = next;
      this.callback?.(this.value, canvas, node);
      node.widgetsChanged = (node.widgetsChanged || 0) + 1;
    };
    return w;
  };
  return { id: 4, type: 'AICG3DPromptSegmentSplit', title: '', mode: 0, properties: {},
    widgets: [widget('steps', 'number', 25, { min: 1, max: 100 }), widget('mode', 'combo', '分隔线 ---', { values: ['分隔线 ---', '每行一段'] }),
      widget('filename_prefix', 'text', 'video/h3')],
    inputs: [], outputs: [] };
};

test('native widgets receive the context their setValue destructures', async () => {
  const node = nativeNode();
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [
    { nodeId: 4, widget: 'steps', value: 26 }, { nodeId: 4, widget: 'mode', value: '每行一段' }, { nodeId: 4, widget: 'filename_prefix', value: 'video/h3b' }
  ] });
  assert.deepEqual(result.changed.map(change => [change.widget, change.after, change.via, change.verified]), [
    ['steps', 26, 'native-setter', true], ['mode', '每行一段', 'native-setter', true], ['filename_prefix', 'video/h3b', 'native-setter', true]
  ]);
  assert.equal(node.widgetsChanged, 3, 'every setter really ran');
  assert.equal(result.warning, undefined);
});

test('a native widget that requires a context reports the stage instead of a bare TypeError', async () => {
  const node = nativeNode();
  node.widgets[0].setValue = function (next, context) {
    const { node: owner } = context;
    this.value = Number(next); void owner;
  };
  const command = await boot([node]);
  // No context on the call path would throw here; the bridge must pass one.
  const result = await command('update_nodes', { changes: [{ nodeId: 4, widget: 'steps', value: 30 }] });
  assert.equal(result.changed[0].verified, true);
});

test('list_nodes and audit call a native widget plain, not dom', async () => {
  const command = await boot([nativeNode()]);
  const listed = await command('list_nodes');
  const widgets = listed.nodes.find(node => node.id === '4').widgets;
  assert.deepEqual(widgets.map(w => [w.name, w.kind, w.writable]), [['steps', undefined, 'ok'], ['mode', undefined, 'ok'], ['filename_prefix', undefined, 'ok']]);
  const audit = await command('audit_graph');
  assert.deepEqual(audit.nodes.find(node => node.id === '4').widgets.map(w => w.kind), ['plain', 'plain', 'plain']);
});

test('bind_image reports the widget that owns the value and whether it stuck', async () => {
  const node = editorNode();
  node.widgets[0].type = 'combo'; node.widgets[0].hidden = false; node.widgets[0].options = { values: ['old.png'] };
  const command = await boot([node]);
  const bound = await command('bind_image', { nodeId: 2, widget: 'prompt', value: 'refs/new.png' });
  assert.equal(bound.verified, true);
  assert.equal(node.widgets[0].value, 'refs/new.png');
  assert.deepEqual(node.widgets[0].options.values, ['old.png', 'refs/new.png'], 'unknown filenames are still offered');
});
// Validation errors are a different failure class from a page-side exception: the page did
// nothing wrong, the caller used a stale id or a wrong widget name. Every hint below must
// name the next call, and must not send the model hunting for a stack trace.
test('a stale nodeId answers with the ids that do exist, not a stack-trace hint', async () => {
  const command = await boot([plainNode()]);
  await assert.rejects(() => command('update_nodes', { changes: [{ nodeId: 999, widget: 'steps', value: 5 }] }),
    error => {
      assert.match(error.message, /节点不存在：999/);
      return true;
    });
});

test('validation failures carry a next step that fits the failure', async () => {
  const command = await boot([plainNode(), editorNode()]);
  const failures = [
    [{ nodeId: 999, widget: 'steps', value: 5 }, '当前画布只有 2 个节点.*id 是 \\[1'],
    [{ nodeId: 1, widget: 'nope', value: 5 }, '可写控件名是 \\[steps, mode\\]'],
    [{ nodeId: 1, widget: 'steps', value: 'twenty' }, '当前是数字 20.*传裸数字'],
    [{ nodeId: 1, widget: 'mode', value: '不存在的选项' }, '可选值见错误正文'],
    [{ nodeId: 1, widget: 'steps', value: 5000 }, '允许范围是 \\[1, 100\\]']
  ];
  for (const [change, pattern] of failures) {
    await assert.rejects(() => command('update_nodes', { changes: [change] }), error => {
      assert.ok(error.message.length > 0);
      // A validation rejection must not borrow the page-side "read the stack" advice.
      assert.doesNotMatch(String(error.hint), /按 stack 里的文件:行号定位/);
      assert.match(String(error.hint), new RegExp(pattern));
      return true;
    });
  }
});

test('list_nodes filter matches the node id and an empty hit says what the ids are', async () => {
  const command = await boot([plainNode(), editorNode()]);
  const hit = await command('list_nodes', { filter: '2' });
  assert.deepEqual(hit.nodes.map(node => node.id), ['2'], 'filter 2 finds node 2 by id');
  const miss = await command('list_nodes', { filter: 'zzz' });
  assert.equal(miss.nodes.length, 0);
  assert.match(miss.filterHint, /当前画布 2 个节点/);
});
