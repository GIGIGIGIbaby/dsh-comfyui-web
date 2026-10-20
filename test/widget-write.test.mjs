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
async function boot(nodes, options = {}) {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test"');
  const timers = [], replies = [], commands = [];
  const graph = {
    _nodes: nodes, links: options.links || [],
    serialize: () => ({ nodes: nodes.map(n => ({ id: n.id, type: n.type, widgets_values: (n.widgets || []).map(w => w.value) })), links: [], groups: [] }),
    setDirtyCanvas() {},
    getNodeById(id) { return nodes.find(node => String(node.id) === String(id)); }
  };
  const workflow = { path: 'workflows/H3.json', filename: 'H3', isLoaded: true, isPersisted: true, isModified: false };
  const app = { rootGraph: graph, graph, canvas: {}, configuringGraph: false,
    extensionManager: { workflow: { activeWorkflow: workflow, openWorkflows: [workflow] } },
    async graphToPrompt() {
      if (options.promptError) throw new Error(options.promptError);
      return { output: options.promptOutput || {} };
    } };
  vm.runInContext(code, vm.createContext({
    window: { parent: { postMessage() {} }, comfyAPI: { app: { app } }, addEventListener() {}, LiteGraph: { createNode: () => null } },
    crypto: { randomUUID: () => 'u' + Math.random() }, URL, URLSearchParams, console,
    location: { origin: 'http://comfy.test', search: '?dsh_client=p&dsh_session=own', href: 'http://comfy.test/' },
    document: { referrer: 'http://dsh.test/', visibilityState: 'visible', addEventListener() {} },
    localStorage: options.localStorage || { getItem: () => null, setItem() {} },
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
    // A write can park on the 600ms settle window, so keep running whatever the bridge queued
    // until the reply lands instead of firing exactly one timer and assuming it is done.
    const before = replies.length;
    for (let turn = 0; turn < 60 && replies.length === before; turn += 1) {
      const next = timers.shift();
      if (next) next();
      await flush();
    }
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
// widget, which refuses to apply while a reference document shadows it. The pack declares
// which widget it replaced — that declaration is what makes the reroute safe.
const editorNode = (declare = true) => {
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: '旧内容', options: { hidden: true }, callback: () => {} };
  const doc = () => node.properties['minimax_h3_prompt_reference_doc'];
  const node = { id: 2, type: 'AICG3D_H3', title: '', mode: 0, properties: { minimax_h3_prompt_reference_doc: { parts: ['a', 'b'] } },
    widgets: [prompt, { name: 'h3_prompt_mentions', type: 'h3_prompt_mentions', value: undefined, serialize: false,
      options: { serialize: false,
        ...(declare ? { serializedWidget: 'prompt', shadowDoc: 'minimax_h3_prompt_reference_doc' } : {}),
        getValue: () => String(prompt.value || ''),
        setValue: value => { if (doc()) return; prompt.value = String(value); } } }],
    inputs: [], outputs: [] };
  return node;
};

// The reviewer's reproduction: a hidden `prompt` and an unrelated DOM `notes` are both empty,
// so their values agree even though they have nothing to do with each other.
const ambiguousNode = () => {
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: '', options: { hidden: true }, callback: () => {} };
  const notes = { name: 'notes', type: 'text', value: '', options: { getValue: () => notes.value, setValue: value => { notes.value = String(value); } } };
  return { id: 4, type: 'SomePackNode', title: '', mode: 0, properties: {},
    widgets: [prompt, notes], inputs: [], outputs: [] };
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

test('an undeclared owner is refused instead of guessed', async () => {
  // Same node as the AICG3D shape, but the pack does not say which widget replaced `prompt`.
  // The write is refused before anything changes: a lucky guess is not a confirmed relationship.
  const node = editorNode(false);
  const command = await boot([node]);
  await assert.rejects(command('update_nodes', { changes: [{ nodeId: 2, widget: 'prompt', value: '新内容' }] }),
    /无法确定控件 prompt 的写入目标/);
  assert.equal(node.widgets[0].value, '旧内容', 'the hidden value is untouched');
  assert.ok(node.properties['minimax_h3_prompt_reference_doc'], 'and so is the document');
});

test('the reviewer reproduction: an empty prompt and an empty notes are not interchangeable', async () => {
  const node = ambiguousNode();
  const command = await boot([node]);
  await assert.rejects(command('update_nodes', { changes: [{ nodeId: 4, widget: 'prompt', value: 'hello' }] }),
    /无法确定控件 prompt 的写入目标/);
  assert.equal(node.widgets[1].value, '', 'notes did not receive the write');
  assert.equal(node.widgets[0].value, '', 'and the prompt was not claimed as written');
});

test('a failed retry puts back the document it removed, and never touches unrelated ones', async () => {
  // The setter refuses even with its document gone, so the retry cannot verify: the document
  // must be restored exactly, and a second `parts` document that names nothing stays put.
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: 'old', options: { hidden: true } };
  const doc = { parts: [{ type: 'text', text: 'shadow' }], keep: 'x' };
  const unrelated = { parts: ['u'], keep: true };
  const node = { id: 5, type: 'PackNode', title: '', mode: 0, properties: { pack_prompt_doc: doc, unrelated },
    widgets: [prompt, { name: 'editor', type: 'custom', value: '', options: { serialize: false, serializedWidget: 'prompt', shadowDoc: 'pack_prompt_doc',
      getValue: () => '', setValue: () => {} } }], inputs: [], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 5, widget: 'prompt', value: 'new' }] });
  assert.equal(result.changed[0].verified, false);
  assert.deepEqual(node.properties.pack_prompt_doc, doc, 'the attributable document is restored');
  assert.deepEqual(node.properties.unrelated, unrelated, 'the unrelated document was never touched');
});

test('a setter that refuses to apply is reported as unverified instead of success', async () => {  const command = await boot([stubbornNode()]);
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

test('audit_graph carries the serialized prompt, and a failed serialization is not fatal', async () => {
  const node = plainNode();
  node.widgets[1].value = '稳定1.5（推荐）';
  const command = await boot([node], { promptOutput: { '1': { class_type: 'KSampler',
    inputs: { steps: 20, mode: '稳定1.5.safetensors', text: 'x'.repeat(210) } } } });
  const audit = await command('audit_graph');
  assert.equal(audit.serializedInputs['1'].mode, '稳定1.5.safetensors', 'the value the queue would receive travels beside the canvas value');
  assert.equal(audit.serializedInputs['1'].text.length, 201, 'strings are capped like widget values');
  assert.match(audit.serializedInputs['1'].text, /…$/);

  const broken = await boot([plainNode()], { promptError: 'serialize failed' });
  const degraded = await broken('audit_graph');
  assert.equal(degraded.serializedInputs, null, 'no evidence beats a guessed one');
  assert.match(degraded.serializedError, /serialize failed/);
  assert.equal(degraded.nodes.length, 1, 'the rest of the audit facts still arrive');
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

// A full localStorage is the difference between "written" and a red toast on the user's screen,
// and it is invisible from the write itself. The page measures it, the reply reports it.
// This one behaves like the real thing (writes land, removeItem removes, length/key enumerate);
// `failHistory` makes the bridge's own snapshot writes throw so a full quota can be simulated.
const fakeStorage = (entries = {}, options = {}) => {
  const data = new Map(Object.entries(entries));
  let failures = options.failHistory ?? 0;
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) {
      if (failures > 0 && String(key).startsWith('dsh.comfyui.history.')) { failures -= 1; throw new Error('QuotaExceededError'); }
      data.set(String(key), String(value));
    },
    removeItem(key) { data.delete(key); },
    snapshot() { return Object.fromEntries(data); }
  };
};

test('audit_graph measures the front-end draft store instead of guessing whether it is full', async () => {
  const command = await boot([plainNode()], {
    localStorage: fakeStorage({
      'Comfy.Workflow.Draft.v2:workflows/H3.json': 'x'.repeat(120),
      'Comfy.Workflow.DraftIndex.v2:personal': 'y'.repeat(30),
      'Comfy.Workflow.Persist': 'true',
      'unrelated.key': 'z'.repeat(999)
    })
  });
  const audit = await command('audit_graph');
  assert.equal(audit.draftStorage.available, true);
  assert.equal(audit.draftStorage.usedChars, 150, 'only Comfy draft keys count, unrelated storage does not');
  assert.deepEqual(audit.draftStorage.keys.map(item => item.key), [
    'Comfy.Workflow.Draft.v2:workflows/H3.json', 'Comfy.Workflow.DraftIndex.v2:personal'
  ]);
  assert.equal(audit.draftStorage.persistSetting, 'true');
});

test('the draft store is measured together with the keys the bridge itself writes', async () => {
  // Measuring only Comfy.Workflow.* let the store sit at its limit while doctor honestly reported
  // "298 chars": the bridge kept one whole graph per checkpoint and one per client in the same quota.
  const otherSession = 'dsh.comfyui.history.' + encodeURIComponent('http://comfy.test:other:workflows/H3.json');
  // A live foreign snapshot: timestamped now, so the load-time prune is not what answers here.
  const foreign = JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now(), pad: 'h'.repeat(400) });
  const command = await boot([plainNode()], {
    localStorage: fakeStorage({
      'Comfy.Workflow.Draft.v2:workflows/H3.json': 'x'.repeat(120),
      'Comfy.Workflow.Persist': 'true',
      [otherSession]: foreign,
      'dsh.comfyui.sync-conflict': 'c'.repeat(50),
      'dsh.comfyui.sync-conflict.dead-client': 'd'.repeat(25)
    })
  });
  const storage = (await command('audit_graph')).draftStorage;
  assert.equal(storage.usedChars, 120, 'ComfyUI draft keys only');
  assert.equal(storage.historyChars, foreign.length);
  assert.equal(storage.conflictChars, 75);
  assert.equal(storage.ownChars, foreign.length + 75, 'the bridge own keys are part of the same quota');
  assert.equal(storage.totalChars, 120 + storage.ownChars);
  assert.equal(storage.staleChars, 0, 'a snapshot saved a moment ago is not stale');
  assert.deepEqual(storage.ownKeys.map(item => item.kind).sort(), ['conflict', 'conflict', 'history']);
  assert.equal(storage.ownKeys.find(item => item.kind === 'history').current, false, 'another session left it behind');
});

test('a full store costs the undo snapshot, never the canvas write', async () => {
  // saveHistory used to throw, which rolled back a write that had already landed on the canvas.
  // Now the value sticks, the reply admits the snapshot was lost and names the keys it reclaimed.
  const otherSession = 'dsh.comfyui.history.' + encodeURIComponent('http://comfy.test:other:workflows/H3.json');
  const foreign = JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now(), pad: 'h'.repeat(400) });
  const dead = 'd'.repeat(60);
  const store = fakeStorage({ [otherSession]: foreign, 'dsh.comfyui.sync-conflict.dead': dead },
    { failHistory: Infinity });
  const command = await boot([plainNode()], { localStorage: store });
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 31 }] });
  assert.equal(result.changed[0].after, 31, 'the canvas write still happened');
  assert.equal(result.changed[0].verified, true);
  assert.equal(result.historyStore.stored, false, 'the reply admits the snapshot was lost');
  assert.equal(result.historyStore.pruned.keys, 1, 'only the superseded conflict backup is reclaimed: a live record is not');
  assert.equal(result.historyStore.pruned.chars, dead.length);
  assert.match(result.historyStore.note, /localStorage 已满/);
  assert.equal(store.snapshot()[otherSession], foreign, 'another conversation fresh history survives a full store');
  assert.equal(store.snapshot()['dsh.comfyui.sync-conflict.dead'], undefined, 'and the stale conflict backup is gone');
});

test('a page load reclaims the snapshots whose sessions are long gone', async () => {
  // Every new conversation writes its own history key and never deletes it. Without this the store
  // only ever fills up, and the first symptom is ComfyUI's own "保存工作流草稿失败" banner.
  const encode = path => 'dsh.comfyui.history.' + encodeURIComponent(path);
  const ancient = encode('http://comfy.test:gone-a:workflows/A.json');
  const recent = encode('http://comfy.test:gone-b:workflows/B.json');
  const mine = encode('http://comfy.test:own:workflows/H3.json');
  const store = fakeStorage({
    [ancient]: JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, pad: 'a'.repeat(300) }),
    [recent]: JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now(), pad: 'b'.repeat(200) }),
    [mine]: JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, pad: 'm'.repeat(100) }),
    'Comfy.Workflow.Persist': 'true'
  });
  const command = await boot([plainNode()], { localStorage: store });
  const after = store.snapshot();
  assert.equal(after[ancient], undefined, 'ten days old: nothing will ever read it');
  assert.ok(after[recent], 'saved today: the user may still switch back to it');
  assert.ok(after[mine], 'this session keeps its own history however old it is');
  const storage = (await command('audit_graph')).draftStorage;
  assert.equal(storage.staleChars, 0, 'what survived the sweep is not reported as stale');
  assert.equal(storage.historyChars, after[recent].length + after[mine].length);
});

test('stale snapshots are reported before they are the reason a draft save fails', async () => {
  // The sweep runs once per page load, so a tab left open for days can still be holding keys that
  // went stale afterwards (and a store we may read but not delete keeps them for good). doctor has
  // to be able to point at them instead of only saying "the store is full".
  const encode = path => 'dsh.comfyui.history.' + encodeURIComponent(path);
  const old = JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, pad: 'o'.repeat(500) });
  const base = fakeStorage({
    [encode('http://comfy.test:gone:workflows/A.json')]: old,
    [encode('http://comfy.test:own:workflows/H3.json')]: JSON.stringify({ version: 1, undo: [], redo: [], savedAt: Date.now(), pad: 'm'.repeat(50) })
  });
  // Readable and enumerable, but this page may not delete anything.
  const readOnly = { ...base, removeItem: undefined };
  Object.defineProperty(readOnly, 'length', { get: () => base.length });
  const command = await boot([plainNode()], { localStorage: readOnly });
  const storage = (await command('audit_graph')).draftStorage;
  assert.equal(storage.staleKeys, 1);
  assert.equal(storage.staleChars, old.length);
  assert.ok(storage.staleAfterMs >= 24 * 60 * 60 * 1000, 'the age threshold is reported with the finding');
  assert.equal(storage.ownKeys.filter(item => item.stale).length, 1);
});

test('list_edits reports how much of the shared store its own snapshots hold', async () => {
  const command = await boot([plainNode()], { localStorage: fakeStorage() });
  await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 22 }] });
  const edits = await command('list_edits');
  assert.equal(edits.maxCheckpoints, 20);
  assert.equal(edits.budget, 1_500_000);
  assert.ok(edits.historyChars > 0, 'the snapshots are counted, not assumed to be free');
});

test('links stored in a Map are followed, not silently reported as none', async () => {
  // Newer litegraph keeps graph.links in a Map. Reading graph.links[id] on a Map is undefined
  // for every id, so a node with four outgoing links looked completely unwired.
  const upstream = plainNode();
  const downstream = { id: 9, type: 'AICG3D_H3Sequence', title: '', mode: 0, properties: {},
    widgets: [{ name: 'segments', type: 'number', value: 1, options: {}, callback: () => {} }], inputs: [], outputs: [] };
  upstream.widgets[0].callback = () => { downstream.widgets[0].value = 7; };
  upstream.outputs = [{ name: 'out', type: 'LATENT', links: [100] }];
  const command = await boot([upstream, downstream], { links: new Map([[100, { id: 100, origin_id: 1, target_id: 9 }]]) });
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 21 }] });
  assert.equal(result.settledMs, 600, 'the wiring was seen, so the settle wait was paid');
  assert.deepEqual(result.cascaded.map(item => [item.nodeId, item.widget, item.before, item.after]), [['9', 'segments', 1, 7]]);
  const audit = await command('audit_graph');
  assert.equal(audit.linkCount, 1, 'the audit counts the same links the write path follows');
});

test('an empty answer from the slot API does not hide a link the table does know', async () => {
  // A graph loaded through loadGraphData can have the slot API answer null while the link
  // table still holds the wire. Trusting the empty answer alone reported "no downstream
  // nodes" on a canvas where the pack does rewrite the nodes below.
  const upstream = plainNode();
  const downstream = { id: 9, type: 'AICG3D_H3Sequence', title: '', mode: 0, properties: {},
    widgets: [{ name: 'segments', type: 'number', value: 1, options: {}, callback: () => {} }], inputs: [], outputs: [] };
  upstream.widgets[0].callback = () => { downstream.widgets[0].value = 6; };
  upstream.outputs = [{ name: 'out', type: 'LATENT', links: [100] }];
  upstream.getOutputNodes = () => null;
  const command = await boot([upstream, downstream], { links: [{ id: 100, origin_id: 1, target_id: 9 }] });
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 21 }] });
  assert.equal(result.settledMs, 600, 'the table answered when the slot API said nothing');
  assert.deepEqual(result.cascaded.map(item => [item.nodeId, item.widget, item.before, item.after]), [['9', 'segments', 1, 6]]);
});

test('the graph is asked for its own downstream nodes before any link table is read', async () => {
  // output.links is deprecated in newer litegraph and can be empty while the slot is wired.
  // node.getOutputNodes(slot) is the API the front-end itself uses, so it must win.
  const upstream = plainNode();
  const downstream = { id: 9, type: 'AICG3D_H3Sequence', title: '', mode: 0, properties: {},
    widgets: [{ name: 'segments', type: 'number', value: 1, options: {}, callback: () => {} }], inputs: [], outputs: [] };
  upstream.widgets[0].callback = () => { downstream.widgets[0].value = 5; };
  upstream.outputs = [{ name: 'out', type: 'LATENT', links: [] }];
  upstream.getOutputNodes = slot => (slot === 0 ? [downstream] : null);
  // The link table is empty on purpose: only getOutputNodes can answer here.
  const command = await boot([upstream, downstream], { links: new Map() });
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 21 }] });
  assert.equal(result.settledMs, 600, 'the slot-level API was trusted over the deprecated links array');
  assert.deepEqual(result.cascaded.map(item => [item.nodeId, item.widget, item.before, item.after]), [['9', 'segments', 1, 5]]);
});

test('a write that makes the pack rewrite the nodes below it reports the cascade', async () => {
  const upstream = plainNode();
  const downstream = { id: 9, type: 'AICG3D_H3Sequence', title: '', mode: 0, properties: {},
    widgets: [{ name: 'segments', type: 'number', value: 1, options: {}, callback: () => {} }], inputs: [], outputs: [] };
  // The autofill driver: changing "steps" refills the wired node a debounce later, which is
  // exactly the rewrite a reply that only lists the touched node would hide.
  upstream.widgets[0].callback = () => { downstream.widgets[0].value = 4; };
  upstream.outputs = [{ name: 'out', type: 'LATENT', links: [100] }];
  const command = await boot([upstream, downstream], { links: [{ id: 100, origin_id: 1, target_id: 9 }] });
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 21 }] });
  assert.equal(result.changed[0].verified, true);
  assert.equal(result.settledMs, 600, 'the reply says how long it waited before trusting the read-back');
  assert.deepEqual(result.cascaded.map(item => [item.nodeId, item.widget, item.before, item.after]), [['9', 'segments', 1, 4]]);
  assert.match(result.cascadedNote, /不在本批 changes 里/);
  assert.match(result.cascadedNote, /node 9/);
});

test('a batch of pure parameters does not pay the settle wait', async () => {
  const command = await boot([plainNode()]);
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 33 }] });
  assert.equal(result.settledMs, undefined, 'nothing is wired below node 1, so nothing can cascade');
  assert.equal(result.cascaded, undefined);
});
