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
  // Top-level graph fields the bridge must carry through its undo chain. The real `serialize()` emits
  // `definitions`, `last_node_id`, `last_link_id`, `floatingLinks`… and a delta encoder that only knows
  // a whitelist of them loses whatever is not on the list — the fourth-round P0 (R4-E): a canvas left
  // with subgraph proxies and no `definitions` cannot be serialized at all. The fake models that rule
  // so the tests fail the way the page would, not merely differ in JSON.
  const graph = {
    _nodes: nodes, links: options.links || [],
    fields: { last_node_id: Math.max(0, ...nodes.map(node => node.id)), last_link_id: 0, ...(options.fields || {}) },
    serialize: () => {
      if (!graph.fields.definitions && nodes.some(node => node.type === 'SubgraphProxyFixture')) {
        throw new TypeError('Attempted to access LGraph reference that was null or undefined.');
      }
      return { nodes: nodes.map(n => ({ id: n.id, type: n.type, widgets_values: (n.widgets || []).map(w => w.value),
        mode: n.mode ?? 0, properties: n.properties ?? {} })), links: graph.links, groups: [], ...graph.fields };
    },
    // `onDirty` runs inside the settle window: the bridge marks the canvas dirty as the last step of
    // a write, and only then waits for the page's debounce, so this is the deterministic place to
    // reproduce a pack taking the value back after the write-time read-back already matched.
    setDirtyCanvas() { if (options.onDirty) options.onDirty(); },
    getNodeById(id) { return nodes.find(node => String(node.id) === String(id)); }
  };
  const workflow = { path: 'workflows/H3.json', filename: 'H3', isLoaded: true, isPersisted: true, isModified: false };
  const app = { rootGraph: graph, graph, canvas: {}, configuringGraph: false,
    extensionManager: { workflow: { activeWorkflow: workflow, openWorkflows: [workflow] } },
    // The bridge restores a snapshot through the page's own loader, so the fake has to answer it the
    // same way: rebuild the node objects in place (every closure here captures `nodes`) and keep
    // each widget's metadata, so a restored graph looks like the one the write happened on.
    async loadGraphData(data) {
      const previous = new Map(nodes.map(node => [String(node.id), node]));
      const rebuilt = (data?.nodes || []).map(saved => {
        const old = previous.get(String(saved.id));
        const widgets = (saved.widgets_values || []).map((value, index) => ({
          ...(old?.widgets?.[index] || { name: 'widget' + index, type: 'string', options: {}, callback() {} }), value }));
        return { id: saved.id, type: saved.type, title: old?.title || '', mode: saved.mode ?? 0,
          properties: saved.properties ?? {}, widgets, inputs: old?.inputs || [], outputs: old?.outputs || [] };
      });
      nodes.length = 0; nodes.push(...rebuilt);
      graph.links = data?.links || [];
      // The page owns its top-level fields: loading a graph without `definitions` really does leave the
      // canvas without them, which is the state the guard below has to catch.
      graph.fields = Object.fromEntries(Object.entries(data || {})
        .filter(([key, value]) => !['nodes', 'links', 'groups'].includes(key) && value !== undefined));
      return true;
    },
    async graphToPrompt() {
      if (options.promptError) throw new Error(options.promptError);
      return { output: options.promptOutput || {} };
    } };
  vm.runInContext(code, vm.createContext({
    window: { parent: { postMessage() {} }, comfyAPI: { app: { app } }, addEventListener() {}, LiteGraph: { createNode: () => null },
      // Nodes like `ShowText|pysssss` build their display widget a frame after `onConfigure`; a save
      // has to give them that frame or it writes a state that predates the widget (round 6, R6-1).
      ...(options.requestAnimationFrame ? { requestAnimationFrame: options.requestAnimationFrame } : {}) },
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
  const run = async (action, args = {}) => {
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
  // Callable as before, plus the page handles a test needs to move the graph under the bridge's feet.
  run.graph = graph; run.app = app; run.nodes = nodes;
  return run;
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

test('a hidden widget nobody replaced is written in place, and an undeclared document survives', async () => {
  // Same node as the AICG3D shape, but the pack does not declare which widget replaced `prompt`.
  // There is nothing to resolve — the addressed control is the one written. The document is NOT
  // cleared: with no declaration there is no evidence it belongs to this widget, and a delete the
  // retry cannot undo is the one mistake this path must never make. The reply names it instead.
  const node = editorNode(false);
  const sibling = node.widgets[1];
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 2, widget: 'prompt', value: '新内容' }] });
  assert.equal(result.changed[0].requestedWidget, undefined, 'no reroute was claimed');
  assert.equal(result.changed[0].verified, true);
  assert.equal(node.widgets[0].value, '新内容', 'the addressed widget received the value');
  assert.deepEqual(node.properties['minimax_h3_prompt_reference_doc'], { parts: ['a', 'b'] }, 'an unattributable document is left alone');
  assert.deepEqual(result.changed[0].shadowDocsRemaining, ['minimax_h3_prompt_reference_doc'], 'and reported as an open question');
  assert.match(result.warning, /无法确认属于这个控件/);
  assert.equal(sibling.value, undefined, 'the undeclared sibling was not written');
});

test('writing a widget whose input slot is wired says the value cannot reach the queue', async () => {
  // Third-round N5-b, measured on the real canvas: node 198's `prompt` is fed by a
  // PrimitiveStringMultiline over a link, so `graphToPrompt()` submits ["209",0] — the widget write
  // verified and stayed verified, and none of it could ever be submitted. The reply has to name that
  // instead of leaving `verified:true` to be read as "the prompt changed".
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: '', options: { hidden: true }, callback: () => {} };
  const node = { id: 198, type: 'AICG3D_H3SequenceSegment', title: '', mode: 0, properties: {}, widgets: [prompt],
    inputs: [{ name: 'prompt', type: 'STRING', link: 377 }], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 198, widget: 'prompt', value: '新提示词' }] });
  assert.equal(result.changed[0].verified, true, 'the canvas did take the value');
  assert.equal(result.changed[0].inputIsWired, true);
  assert.deepEqual(result.wiredInputs, [{ nodeId: '198', widget: 'prompt', linkId: 377 }]);
  assert.match(result.warning, /连线/);
  assert.match(result.nextSteps[0], /改连线另一端的节点/);
});

test('the reviewer reproduction: an empty prompt and an empty notes are not interchangeable', async () => {
  // Value equality used to redirect this write into `notes`. Nothing claims `prompt`, so the
  // write stays on `prompt` — and `notes` must not move.
  const node = ambiguousNode();
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 4, widget: 'prompt', value: 'hello' }] });
  assert.equal(node.widgets[1].value, '', 'notes did not receive the write');
  assert.equal(node.widgets[0].value, 'hello', 'the addressed widget did');
  assert.equal(result.changed[0].widget, 'prompt');
});

test('two claimants are refused instead of picking one', async () => {
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: '', options: { hidden: true } };
  const claim = name => ({ name, type: 'custom', value: '', options: { serialize: false, serializedWidget: 'prompt', getValue: () => '', setValue: () => {} } });
  const node = { id: 6, type: 'PackNode', title: '', mode: 0, properties: {},
    widgets: [prompt, claim('editor_a'), claim('editor_b')], inputs: [], outputs: [] };
  const command = await boot([node]);
  await assert.rejects(command('update_nodes', { changes: [{ nodeId: 6, widget: 'prompt', value: 'x' }] }),
    error => /无法确定控件/.test(error.message) && /同时被多个前端组件声明/.test(error.hint || ''));
  assert.equal(prompt.value, '', 'nothing was written');
});

test('a failed retry puts back the document it removed, and never touches unrelated ones', async () => {
  // The setter refuses even with its document gone, so the retry cannot verify. Track that the
  // document really left the node during the retry, so the restore assertion cannot pass by
  // accident (a test that never deletes proves nothing about restoring).
  let sawWithoutDoc = false;
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: 'old', options: { hidden: true } };
  const doc = { parts: [{ type: 'text', text: 'shadow' }], keep: 'x' };
  const unrelated = { parts: ['u'], keep: true };
  const node = { id: 5, type: 'PackNode', title: '', mode: 0, properties: { pack_prompt_doc: doc, unrelated },
    widgets: [prompt, { name: 'editor', type: 'custom', value: '', options: { serialize: false, serializedWidget: 'prompt', shadowDoc: 'pack_prompt_doc',
      getValue: () => '', setValue: () => { sawWithoutDoc = !node.properties.pack_prompt_doc; } } }], inputs: [], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 5, widget: 'prompt', value: 'new' }] });
  assert.equal(result.changed[0].verified, false);
  assert.equal(sawWithoutDoc, true, 'the retry ran with the document removed');
  assert.deepEqual(node.properties.pack_prompt_doc, doc, 'the attributable document is restored');
  assert.deepEqual(node.properties.unrelated, unrelated, 'the unrelated document was never touched');
});

test('a setter that throws on the retry restores the document before the error escapes', async () => {
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: 'old', options: { hidden: true } };
  const doc = { parts: [{ type: 'text', text: 'shadow' }] };
  let calls = 0;
  const node = { id: 7, type: 'PackNode', title: '', mode: 0, properties: { pack_prompt_doc: doc },
    widgets: [prompt, { name: 'editor', type: 'custom', value: '', options: { serialize: false, serializedWidget: 'prompt', shadowDoc: 'pack_prompt_doc',
      getValue: () => '', setValue: () => { calls += 1; if (calls > 1) throw new Error('boom'); } } }], inputs: [], outputs: [] };
  const command = await boot([node]);
  await assert.rejects(command('update_nodes', { changes: [{ nodeId: 7, widget: 'prompt', value: 'new' }] }), /boom/);
  assert.deepEqual(node.properties.pack_prompt_doc, doc, 'a throwing retry still leaves the document in place');
});

test('a short widget name does not authorise deleting a similarly spelled document', async () => {
  // `text` is a substring of `context_doc`; attribution is by whole token, so the unrelated
  // document must never be offered up as this widget's shadow.
  const unrelated = { parts: [{ type: 'text', text: 'keep me' }] };
  const node = { id: 8, type: 'PackNode', title: '', mode: 0, properties: { context_doc: unrelated },
    widgets: [{ name: 'text', type: 'dom', value: 'old', options: { getValue: () => '', setValue: () => {} } }], inputs: [], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 8, widget: 'text', value: 'new' }] });
  assert.equal(result.changed[0].verified, false);
  assert.equal(result.changed[0].shadowDocsCleared, undefined, 'nothing was cleared');
  assert.deepEqual(node.properties.context_doc, unrelated, 'the unrelated document survived');
});

test('a same-name claimant is reported as a reroute, not as an in-place write', async () => {
  // LiteGraph renames duplicates (`prompt#1`), so two widgets literally sharing the name come from a
  // pack that built them another way. Writing the first is what every other page lookup does, but a
  // `requestedWidget` equal to the asked-for name made the reroute invisible in the reply.
  const hidden = { name: 'prompt', type: 'hidden', hidden: true, value: '旧', options: { hidden: true }, callback: () => {} };
  const dom = { name: 'prompt', type: 'custom', value: '旧', options: { serialize: false,
    getValue: () => hidden.value, setValue: value => { hidden.value = String(value); } } };
  const node = { id: 11, type: 'PackNode', title: '', mode: 0, properties: {}, widgets: [hidden, dom], inputs: [], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 11, widget: 'prompt', value: '新' }] });
  assert.equal(result.changed[0].requestedWidget, 'prompt', 'the addressed name and the written name are the same string');
  assert.equal(result.changed[0].rerouted, true, 'and the reply still says another widget received it');
  assert.equal(result.changed[0].sameNameWidgets, 2);
  assert.deepEqual(result.ambiguousTargets.map(item => [item.nodeId, item.widget, item.sameName]), [['11', 'prompt', 2]]);
  assert.equal(hidden.value, '新', 'the DOM widget owns the value');
});

test('a DOM control that accepts the value keeps its own text mirror in step', async () => {
  // Second-round report N5: the write reached the queue (`verified:true`), yet the pack's document
  // still held the old 5104-character text, so the editor repaints from it and any pack-side sync
  // writes the old text back into the widget. A plain text mirror can be kept in step.
  const text = '镜2：镜头下压，路面反光';
  const doc = { version: 1, text, parts: [{ type: 'text', text }] };
  const hidden = { name: 'prompt', type: 'hidden', hidden: true, value: text, options: { hidden: true }, callback: () => {} };
  const editor = { name: 'h3_prompt_mentions', type: 'custom', value: text,
    options: { serialize: false, shadowDoc: 'minimax_h3_prompt_reference_doc',
      getValue: () => String(hidden.value || ''), setValue: value => { hidden.value = String(value); editor.value = String(value); } } };
  const node = { id: 13, type: 'AICG3D_H3SequenceSegment', title: '', mode: 0, properties: { minimax_h3_prompt_reference_doc: doc },
    widgets: [hidden, editor], inputs: [], outputs: [] };
  const command = await boot([node]);
  const next = text + '，远处有车灯扫过';
  const result = await command('update_nodes', { changes: [{ nodeId: 13, widget: 'h3_prompt_mentions', value: next }] });
  assert.equal(result.changed[0].verified, true);
  assert.equal(result.changed[0].shadowDocsSynced.join(), 'minimax_h3_prompt_reference_doc', 'the mirror is updated instead of deleted');
  assert.equal(node.properties.minimax_h3_prompt_reference_doc.text, next);
  // Field-by-field: the rewritten document was built inside the page realm, so its array/objects
  // have a different prototype and strict deep-equal would fail on that alone.
  assert.equal(node.properties.minimax_h3_prompt_reference_doc.parts.length, 1);
  assert.equal(node.properties.minimax_h3_prompt_reference_doc.parts[0].type, 'text');
  assert.equal(node.properties.minimax_h3_prompt_reference_doc.parts[0].text, next);
  assert.equal(result.warning, undefined, 'a kept-in-step document is not an open question');
});

test('a DOM control never deletes the mention structure it did not need to touch', async () => {
  // The same node whose document carries `<Picture n>` references: a plain string cannot represent
  // them, so the document is left exactly as it was and the divergence is reported — deleting it to
  // make the reply look clean would destroy references the pack rebuilds the prompt from.
  const text = '镜3：@角色 走过积水路面';
  const doc = { version: 1, text, parts: [{ type: 'text', text: '镜3：' }, { type: 'mention', tag: '<Picture 3>' }] };
  const hidden = { name: 'prompt', type: 'hidden', hidden: true, value: text, options: { hidden: true }, callback: () => {} };
  const editor = { name: 'h3_prompt_mentions', type: 'custom', value: text,
    options: { serialize: false, shadowDoc: 'minimax_h3_prompt_reference_doc',
      getValue: () => String(hidden.value || ''), setValue: value => { hidden.value = String(value); editor.value = String(value); } } };
  const node = { id: 14, type: 'AICG3D_H3SequenceSegment', title: '', mode: 0, properties: { minimax_h3_prompt_reference_doc: doc },
    widgets: [hidden, editor], inputs: [], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 14, widget: 'h3_prompt_mentions', value: '镜3：@角色 跑过积水' }] });
  assert.equal(result.changed[0].verified, true, 'the widget and the queue did take the new text');
  assert.deepEqual(node.properties.minimax_h3_prompt_reference_doc, doc, 'the document is untouched');
  assert.deepEqual(result.changed[0].shadowDocsRemaining, ['minimax_h3_prompt_reference_doc'], 'and the divergence is reported');
  assert.match(result.warning, /引用文档/);
});

test('an undeclared document whose text mirrors the value is still claimed', async () => {
  // The real AICG3D shape: the pack never declares `shadowDoc`, but every one of its own syncs
  // writes `widget.value` and `doc.text` together (`syncPromptFromEditor`), so the document is
  // provably the mirror of this control. Two proofs — the key names the widget as a whole token
  // and the texts are identical — is what keeps this path working without guessing.
  const text = '镜1：手腕举起座套，镜头缓慢推近';
  const doc = { version: 1, text, parts: [{ type: 'text', text }] };
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: text, options: { hidden: true }, callback: () => {} };
  const node = { id: 9, type: 'AICG3D_H3', title: '', mode: 0, properties: { minimax_h3_prompt_reference_doc: doc },
    widgets: [prompt, { name: 'video_reference', type: 'boolean', value: false, options: {}, callback: () => {} }], inputs: [], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 9, widget: 'prompt', value: text + '，背景是夜里的高速路口' }] });
  assert.deepEqual(result.changed[0].shadowDocsCleared, ['minimax_h3_prompt_reference_doc'], 'the mirror is evidence enough to clear the shadow');
  assert.equal(result.warning, undefined, 'a cleared document is not an open question');
  assert.equal(node.properties.minimax_h3_prompt_reference_doc, undefined);
});

test('a neighbour sharing a token with the document key does not clear it', async () => {
  // The reviewer's over-claim: `video_reference` contains the `reference` token of
  // `minimax_h3_prompt_reference_doc`. Its value is a boolean, so the mirror proof fails and the
  // prompt document — another control's shadow — stays exactly where it was.
  const text = '一段足够长的提示词，用来证明镜像判据';
  const doc = { version: 1, text, parts: [{ type: 'text', text }] };
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: text, options: { hidden: true }, callback: () => {} };
  const ref = { name: 'video_reference', type: 'boolean', value: false, options: {}, callback: () => {} };
  const node = { id: 10, type: 'AICG3D_H3', title: '', mode: 0, properties: { minimax_h3_prompt_reference_doc: doc },
    widgets: [prompt, ref], inputs: [], outputs: [] };
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 10, widget: 'video_reference', value: true }] });
  assert.equal(result.changed[0].verified, true);
  assert.equal(result.changed[0].shadowDocsCleared, undefined, 'a boolean write never clears the prompt document');
  assert.deepEqual(node.properties.minimax_h3_prompt_reference_doc, doc, 'the document is untouched');
  assert.equal(prompt.value, text, 'and the prompt it shadows is untouched too');
});

test('a refused bind_image does not touch the option list it would have extended', async () => {
  const hidden = { name: 'image', type: 'hidden', hidden: true, value: '', options: { hidden: true, values: ['a'] } };
  const claim = name => ({ name, type: 'custom', value: '', options: { serialize: false, serializedWidget: 'image', getValue: () => '', setValue: () => {} } });
  const node = { id: 9, type: 'PackNode', title: '', mode: 0, properties: {}, widgets: [hidden, claim('a1'), claim('a2')], inputs: [], outputs: [] };
  const command = await boot([node]);
  await assert.rejects(command('bind_image', { nodeId: 9, widget: 'image', value: 'new.png' }),
    error => /无法确定控件/.test(error.message) && /同时被多个前端组件声明/.test(error.hint || ''));
  assert.deepEqual(hidden.options.values, ['a'], 'the refused request did not extend the combo');
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
  const audit = await command('audit_graph', { op: 'params' });
  assert.equal(audit.serializedInputs['1'].mode, '稳定1.5.safetensors', 'the value the queue would receive travels beside the canvas value');
  assert.equal(audit.serializedInputs['1'].text.length, 210, 'a normal value is carried whole: truncation would make the audit compare a prefix');
  assert.equal(audit.serializedInputs['1'].text.endsWith('…'), false);
  assert.equal(audit.serializedTruncated, undefined, 'nothing was cut, so nothing is flagged');

  // A value beyond the 4 KB cap is the one case the audit cannot judge; it must say so instead
  // of letting the prefix decide a verdict.
  const long = await boot([plainNode()], { promptOutput: { '1': { class_type: 'KSampler', inputs: { steps: 20, text: 'y'.repeat(5000) } } } });
  const capped = await long('audit_graph', { op: 'params' });
  assert.equal(capped.serializedInputs['1'].text.length, 4097);
  assert.deepEqual(capped.serializedTruncated, ['1.text']);

  // A structural audit never reads the serialized values, so it must not pay a full serialize.
  const structural = await command('audit_graph', { op: 'graph' });
  assert.equal(structural.serializedInputs, undefined, 'op=graph does not serialize the graph');

  const broken = await boot([plainNode()], { promptError: 'serialize failed' });
  const degraded = await broken('audit_graph', { op: 'params' });
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
  assert.equal(storage.bridgeHistoryChars, foreign.length);
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
  assert.equal(storage.bridgeHistoryChars, after[recent].length + after[mine].length);
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
  assert.ok(edits.workflowHistoryChars > 0, 'the snapshots are counted, not assumed to be free');
});

test('the conflict backup the notice promises can be read back', async () => {
  // The notice tells the user 另一页版本已备份到浏览器. Until `list_edits` measured the slot, nothing
  // in the codebase ever read that key, so the sentence described a backup nobody could confirm
  // (second-round report, P2-3 follow-up). Size, age and node count — not the graph itself.
  const savedAt = Date.now() - 60_000;
  const store = fakeStorage({ 'dsh.comfyui.sync-conflict': JSON.stringify({ savedAt, workflow: { nodes: [{ id: 1 }, { id: 2 }], links: [] } }) });
  const command = await boot([plainNode()], { localStorage: store });
  const edits = await command('list_edits');
  assert.equal(edits.conflictBackup.present, true);
  assert.equal(edits.conflictBackup.nodes, 2);
  assert.equal(edits.conflictBackup.savedAt, savedAt);
  assert.equal(edits.conflictBackup.workflow, undefined, 'the backed-up graph itself stays out of the reply');
  const none = await boot([plainNode()], { localStorage: fakeStorage() });
  assert.equal((await none('list_edits')).conflictBackup.present, false, 'and an empty slot says so instead of being silent');
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

test('a pack that takes the value back on the same node is caught with nothing wired below', async () => {
  // The reviewer's fake success: a hidden control verifies at write time, then the pack's own
  // editor repaints it a few hundred milliseconds later, and the queued prompt is the old text.
  // The settle re-read used to be skipped whenever the node had no downstream links.
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: '旧文案', options: { hidden: true },
    callback: () => {} };
  const node = { id: 12, type: 'PackNode', title: '', mode: 0, properties: {}, widgets: [prompt], inputs: [], outputs: [] };
  let reverts = 0;
  const command = await boot([node], { onDirty: () => {
    if (prompt.value === '新文案' && reverts === 0) { prompt.value = '旧文案'; reverts += 1; }
  } });
  const result = await command('update_nodes', { changes: [{ nodeId: 12, widget: 'prompt', value: '新文案' }] });
  assert.ok(reverts > 0, 'the page really did take the value back before the re-read');
  assert.equal(result.settledMs, 600, 'a pack-driven control always pays the re-read, links or not');
  assert.deepEqual(result.lateChange.map(item => [item.widget, item.now]), [['prompt', 'overwritten']]);
  assert.equal(result.changed[0].verified, false, 'the reply no longer claims a value the page took back');
  assert.equal(result.changed[0].after, '旧文案', 'and reports what the widget holds after the debounce');
});

// ---------------------------------------------------------------- undo snapshots as one chain
//
// Each checkpoint used to be a whole `graph.serialize()`: about 135 KB per AI write on the H3
// canvases, so eleven of them ate 1.49 MB of a ~5 MB browser quota and the oldest steps began being
// dropped while the user still wanted to walk back. The store now keeps one full anchor plus a patch
// per later entry — only acceptable if it is byte-exact, so every test below compares a reconstructed
// graph against the state captured live at the time.

const bigPrompt = marker => marker + ': ' + 'x'.repeat(4000);
// A canvas with several long prompts, because that is where the copies hurt: one write touches one
// node, and a single-node fixture would make a patch as big as the graph it replaces.
const promptNodes = (count = 8, marker = 'init') => Array.from({ length: count }, (_, index) => ({
  id: 21 + index, type: 'AICG3D_H3SequenceSegment', title: '', mode: 0, properties: {},
  widgets: [{ name: 'prompt', type: 'string', value: bigPrompt(marker + index), options: {}, callback() {} },
    { name: 'steps', type: 'number', value: 20, options: {}, callback() {} }],
  inputs: [{ name: 'prompt_in', type: 'STRING', link: null }], outputs: [] }));
const HISTORY_KEY = 'dsh.comfyui.history.' + encodeURIComponent('http://comfy.test:own:workflows/H3.json');
const promptsOf = nodes => JSON.stringify(nodes.map(node => node.widgets[0].value));

test('a chain of parameter writes rebuilds every earlier graph byte for byte', async () => {
  const nodes = promptNodes();
  const command = await boot(nodes);
  const captured = [];
  for (let i = 0; i < 6; i += 1) {
    captured.push(promptsOf(nodes));
    await command('update_nodes', { changes: [{ nodeId: 21 + i, widget: 'prompt', value: bigPrompt('W' + i) }] });
  }

  const edits = await command('list_edits');
  assert.deepEqual(edits.checkpoints.map(item => item.encoded), ['delta', 'delta', 'delta', 'delta', 'delta', 'full'],
    'the oldest checkpoint is the anchor and every later one stores only what moved');
  assert.deepEqual(edits.checkpoints.map(item => item.nodes), [8, 8, 8, 8, 8, 8], 'a patch still reports its node count');
  assert.ok(edits.workflowHistoryChars * 3 < edits.workflowFullChars,
    'chain ' + edits.workflowHistoryChars + ' vs full copies ' + edits.workflowFullChars + ': the saving has to be measurable');

  for (let i = 0; i < 6; i += 1) {
    await command('undo');
    assert.equal(promptsOf(nodes), captured[5 - i], 'undo #' + (i + 1) + ' restores the exact graph');
  }
  await command('update_nodes', { changes: [{ nodeId: 21, widget: 'steps', value: 7 }] });
  await command('undo');
  assert.equal(promptsOf(nodes), captured[0], 'a write after the walk-back still diffs against the right parent');
});

test('a v1 history of full copies is folded into a chain on load, losslessly', async () => {
  // The real store is full of these today. Loading it must compact it without changing what any
  // checkpoint restores to, or the saving arrives as data loss.
  const graphOf = (nodeId, marker) => ({ nodes: promptNodes().map(node => ({
    id: node.id, type: node.type, mode: 0, properties: {},
    widgets_values: [node.id === nodeId ? bigPrompt(marker) : node.widgets[0].value, node.widgets[1].value]
  })), links: [], groups: [] });
  const nodes = promptNodes();
  const store = fakeStorage({ [HISTORY_KEY]: JSON.stringify({ version: 1, savedAt: Date.now(), expectedHash: null,
    undo: [{ id: 'cp-1', time: Date.now() - 3000, label: 'update_nodes', workflow: graphOf(23, 'A') },
      { id: 'cp-2', time: Date.now() - 2000, label: 'update_nodes', workflow: graphOf(26, 'B') }], redo: [] }) });
  const command = await boot(nodes, { localStorage: store });

  const edits = await command('list_edits');
  assert.deepEqual(edits.checkpoints.map(item => item.encoded), ['delta', 'full'],
    'the later full copy became a patch against the anchor, in place');
  assert.ok(edits.workflowHistoryChars < edits.workflowFullChars,
    'compacted ' + edits.workflowHistoryChars + ' < full copies ' + edits.workflowFullChars);

  await command('restore_edit', { checkpointId: 'cp-2' });
  assert.equal(nodes.find(node => node.id === 26).widgets[0].value, bigPrompt('B'),
    'the patched entry rebuilds what its full copy held');
  assert.equal(nodes.find(node => node.id === 21).widgets[0].value, bigPrompt('init0'),
    'and an untouched node comes through unchanged');
  await command('restore_edit', { checkpointId: 'cp-1' });
  assert.equal(nodes.find(node => node.id === 23).widgets[0].value, bigPrompt('A'), 'the anchor restores as before');
});

test('dropping the oldest step hands the anchor forward, so the survivors still rebuild', async () => {
  // The cap removes the head, and the head is where the full graph lives. Materialising the
  // successor *after* the drop is impossible — its patch points at deleted data — so this ordering is
  // the test: twenty steps must all still restore, including the oldest survivor.
  const nodes = promptNodes(4);
  const command = await boot(nodes);
  const captured = [];
  for (let i = 0; i < 22; i += 1) {
    captured.push(promptsOf(nodes));
    await command('update_nodes', { changes: [{ nodeId: 21 + (i % 4), widget: 'prompt', value: bigPrompt('m' + i) }] });
  }

  const edits = await command('list_edits');
  assert.equal(edits.checkpoints.length, 20, 'the cap holds at twenty steps');
  assert.equal(edits.checkpoints.filter(item => item.encoded === 'full').length, 1, 'exactly one anchor after the head moved');
  assert.equal(edits.checkpoints.at(-1).encoded, 'full', 'and it is the oldest survivor');
  await command('restore_edit', { checkpointId: edits.checkpoints.at(-1).checkpointId });
  assert.equal(promptsOf(nodes), captured[2], 'the handed-forward anchor restores the graph it replaced');
  await command('restore_edit', { checkpointId: edits.checkpoints[0].checkpointId });
  assert.equal(promptsOf(nodes), captured[21], 'and the newest step still rebuilds through the chain');
});

test('a chain with no anchor anywhere is dropped rather than restored from a guess', async () => {
  const nodes = promptNodes(1, 'ok');
  const store = fakeStorage();
  const first = await boot(nodes, { localStorage: store });
  await first('update_nodes', { changes: [{ nodeId: 21, widget: 'prompt', value: bigPrompt('fine') }] });
  const stored = JSON.parse(store.snapshot()[HISTORY_KEY]);
  assert.ok(stored.undo[0].workflow, 'the first entry is the anchor before it is broken');
  stored.undo = [{ ...stored.undo[0], workflow: undefined }];
  store.setItem(HISTORY_KEY, JSON.stringify(stored));

  const command = await boot(nodes, { localStorage: store });
  const before = promptsOf(nodes);
  const edits = await command('list_edits');
  assert.equal(edits.checkpoints.length, 0, 'an un-anchorable entry is not offered back as restorable');
  assert.equal(promptsOf(nodes), before, 'the canvas was not touched');
});

// R4-E / R4-D. The delta encoder used to compare a whitelist of seven top-level keys, so a workflow
// with subgraphs lost `definitions` the moment its checkpoint chain went through a patch — and a canvas
// holding subgraph proxies without their definitions cannot be serialized at all. One ordinary undo
// turned the tab half-dead (`get_workflow`, `audit(op=params)` and `run` all failing) while `doctor`
// still reported ok. These fixtures reproduce the front-end's own rule, so a lossy chain fails the way
// the page would rather than merely differing in JSON.

const subgraphGraph = () => ({ id: 'a67caa28-0000-0000-0000-000000000001', name: 'FLUX 子图',
  nodes: [{ id: 86, type: 'PrimitiveInt', title: 'seed', widgets_values: [432262096973490] }], links: [], inputs: [], outputs: [] });
const proxyNode = () => ({ id: 31, type: 'SubgraphProxyFixture', title: '子图', mode: 0, properties: {},
  widgets: [{ name: 'seed', type: 'number', value: 5, options: {}, callback() {} }], inputs: [], outputs: [] });
const savedWorkflow = (promptValue, fields) => ({
  nodes: [{ id: 21, type: 'AICG3D_H3SequenceSegment', mode: 0, properties: {}, widgets_values: [promptValue, 20] },
    { id: 31, type: 'SubgraphProxyFixture', mode: 0, properties: {}, widgets_values: [5] }],
  links: [], groups: [], last_node_id: 31, last_link_id: 0, ...fields });
const withDefinitions = { definitions: { subgraphs: [subgraphGraph()] } };

test('an undo restores definitions, the id counters and a field the encoder never heard of', async () => {
  const nodes = [...promptNodes(2), proxyNode()];
  const command = await boot(nodes, { fields: { ...withDefinitions, floatingLinks: [], zzzFutureField: { kept: true } } });

  await command('update_nodes', { changes: [{ nodeId: 21, widget: 'prompt', value: bigPrompt('W') }] });
  // The page moves these between the two writes exactly like a real pack does on load: counters
  // advance, the subgraph's own widget values get refilled.
  command.graph.fields.last_node_id = 905;
  command.graph.fields.last_link_id = 420;
  command.graph.fields.definitions.subgraphs[0].nodes[0].widgets_values = [1];
  command.graph.fields.zzzFutureField = { kept: false, added: 'now' };
  await command('update_nodes', { changes: [{ nodeId: 22, widget: 'steps', value: 33 }] });

  const edits = await command('list_edits');
  assert.deepEqual(edits.checkpoints.map(item => item.encoded), ['delta', 'full'],
    'carrying every field must not cost the compression: the newest step is still a patch');
  assert.equal(edits.serializable, true);

  await command('undo');
  assert.equal(command.graph.fields.last_node_id, 905, 'R4-D: the node counter comes back');
  assert.equal(command.graph.fields.last_link_id, 420, 'R4-D: and so does the link counter');
  // Compared as JSON: the restored object was built inside the page's realm, and a cross-realm
  // deepEqual fails on prototype identity while the value is identical.
  assert.equal(JSON.stringify(command.graph.fields.definitions.subgraphs[0].nodes[0].widgets_values), '[1]',
    'R4-E: the subgraph definition comes back as it was');
  assert.equal(JSON.stringify(command.graph.fields.zzzFutureField), '{"kept":false,"added":"now"}',
    'a key nobody enumerated is carried just the same');
  assert.equal(nodes.find(node => node.id === 22).widgets[1].value, 20, 'the refused write is gone again');
  assert.equal(nodes.find(node => node.id === 21).widgets[0].value, bigPrompt('W'));
  assert.equal(command.graph.serialize().nodes.length, 3, 'and the canvas still serializes — no proxy left without definitions');

  await command('undo');
  assert.equal(command.graph.fields.last_node_id, 31, 'the anchor holds the state from before the first write');
  assert.equal(JSON.stringify(command.graph.fields.definitions.subgraphs[0].nodes[0].widgets_values), '[432262096973490]');
});

test('a field the graph loses is recorded as lost, not left behind from the parent', async () => {
  const nodes = promptNodes(1);
  const command = await boot(nodes, { fields: withDefinitions });
  await command('update_nodes', { changes: [{ nodeId: 21, widget: 'steps', value: 24 }] });
  delete command.graph.fields.definitions;                    // the page drops the key entirely
  await command('update_nodes', { changes: [{ nodeId: 21, widget: 'steps', value: 25 }] });

  const edits = await command('list_edits');
  await command('restore_edit', { checkpointId: edits.checkpoints[0].checkpointId });
  assert.equal('definitions' in command.graph.fields, false, 'the newer snapshot really has no definitions');
  await command('restore_edit', { checkpointId: edits.checkpoints.at(-1).checkpointId });
  assert.ok(command.graph.fields.definitions, 'restoring the older step puts the key back instead of inheriting it');
});

test('steps written by the old whitelist encoder are retired, not offered back as restorable', async () => {
  const nodes = [...promptNodes(1), proxyNode()];
  // A chain as the buggy build left it: an anchor plus a patch that was built from the whitelist, so
  // it carries nodes/links/groups and nothing else. Rebuilding it yields a canvas with proxies and no
  // definitions — precisely the state that cannot be serialized.
  const lossyPatch = { nodes: { 21: { id: 21, type: 'AICG3D_H3SequenceSegment', mode: 0, properties: {},
      widgets_values: [bigPrompt('new'), 20] } }, removed: [], links: [], groups: [] };
  const store = fakeStorage({ [HISTORY_KEY]: JSON.stringify({ version: 2, savedAt: Date.now(), expectedHash: null,
    undo: [{ id: 'cp-1', time: Date.now() - 3000, label: 'load_workflow', nodes: 2, workflow: savedWorkflow(bigPrompt('old'), withDefinitions) },
      { id: 'cp-2', time: Date.now() - 2000, label: 'update_nodes', nodes: 2, patch: lossyPatch }], redo: [] }) });
  const command = await boot(nodes, { localStorage: store, fields: withDefinitions });
  const before = promptsOf(nodes);

  const edits = await command('list_edits');
  assert.deepEqual(edits.checkpoints.map(item => item.checkpointId), ['cp-1'], 'only the provably sound step survives');
  assert.equal(edits.legacyPatchesDropped, 1, 'and the caller is told a step was retired, not that it never existed');
  assert.match(edits.legacyNote, /definitions/);
  assert.equal(edits.serializable, true);
  assert.equal(promptsOf(nodes), before, 'reading the chain did not touch the canvas');
  await assert.rejects(() => command('restore_edit', { checkpointId: 'cp-2' }), /没有该快照/);
  await command('restore_edit', { checkpointId: 'cp-1' });
  assert.equal(nodes.find(node => node.id === 21).widgets[0].value, bigPrompt('old'), 'the surviving anchor still restores');
  assert.equal(promptsOf(nodes).includes(bigPrompt('new')), false, 'the retired patch is not reachable by any path');
  // A second page load pays the repair only once: the record now declares the codec that can be trusted.
  const again = await boot(nodes, { localStorage: store, fields: withDefinitions });
  const second = await again('list_edits');
  assert.equal(second.checkpoints.length, 2, 'the anchor plus the step the restore itself recorded — nothing else retired');
  assert.ok(second.checkpoints.some(item => item.checkpointId === 'cp-1'), 'the surviving anchor is still offered');
  assert.equal(second.legacyPatchesDropped, undefined, 'the migration is one-time, not a permanent tax');
});

test('a restore that would leave the canvas unserializable is refused and rolled back', async () => {
  const nodes = [...promptNodes(1), proxyNode()];
  // Both entries are full snapshots under a trustworthy codec, so the migration leaves them alone;
  // the newer one is simply a graph without definitions, as if it came from a file saved by something
  // else. Compaction may still fold it — a patch that loses the key must lose it faithfully.
  const store = fakeStorage({ [HISTORY_KEY]: JSON.stringify({ version: 2, codec: 'fields', savedAt: Date.now(), expectedHash: null,
    undo: [{ id: 'cp-1', time: Date.now() - 3000, label: 'load_workflow', nodes: 2, workflow: savedWorkflow(bigPrompt('A'), withDefinitions) },
      { id: 'cp-2', time: Date.now() - 2000, label: 'load_workflow', nodes: 2, workflow: savedWorkflow(bigPrompt('B'), {}) }], redo: [] }) });
  const command = await boot(nodes, { localStorage: store, fields: withDefinitions });

  const edits = await command('list_edits');
  assert.deepEqual(edits.checkpoints.map(item => item.checkpointId), ['cp-2', 'cp-1'], 'no step is retired here');
  assert.equal(edits.legacyPatchesDropped, undefined, 'a chain that declares the trustworthy codec is not touched');
  await assert.rejects(() => command('restore_edit', { checkpointId: 'cp-2' }), /无法序列化/);
  assert.ok(command.graph.fields.definitions, 'the canvas is back in the state that still works');
  assert.equal(nodes.find(node => node.id === 21).widgets[0].value, bigPrompt('init0'), 'the refused restore left no half-applied graph');
  assert.equal((await command('list_edits')).serializable, true, 'and the tab is usable again');
});

test('a canvas that cannot serialize is explained as a missing definitions, not a dead bridge', async () => {
  const nodes = [...promptNodes(1), proxyNode()];
  const command = await boot(nodes, { fields: withDefinitions });
  delete command.graph.fields.definitions;                    // e.g. a file that was edited outside

  await assert.rejects(() => command('get_workflow'), /definitions.*load_workflow/s);
  const edits = await command('list_edits');
  assert.equal(edits.serializable, false, 'the listing says what is wrong instead of letting the next call die');
});

test('get_workflow can skip graphToPrompt, which some packs patch for side effects', async () => {
  const command = await boot(promptNodes(1, 'p'));
  let calls = 0;
  command.app.graphToPrompt = async () => { calls += 1; return { output: { 21: { class_type: 'AICG3D_H3SequenceSegment' } } }; };

  const skipped = await command('get_workflow', { includePrompt: false });
  assert.equal(calls, 0, 'asking for the graph alone must not pay for a serialization');
  assert.equal(skipped.prompt, null); assert.equal(skipped.promptSkipped, true);
  assert.equal(skipped.workflow.nodes.length, 1, 'the workflow itself still arrives');

  const whole = await command('get_workflow', {});
  assert.equal(calls, 1, 'the documented default is unchanged');
  assert.deepEqual(whole.prompt, { 21: { class_type: 'AICG3D_H3SequenceSegment' } });
});

// ---------------------------------------------------------------- saving what the canvas actually holds.
// `ComfyWorkflowWithChangeTracker.save()` writes `JSON.stringify(this.activeState)`, not the graph, and
// `captureCanvasState()` — the only thing that refreshes `activeState` — early-returns while a change is
// pending, a restore is running or the graph is not "ready". A node that builds its display widget in a
// `requestAnimationFrame` after `onConfigure` (`ShowText|pysssss`, measured at ~3.5 s on this machine)
// can therefore stay absent from `activeState` for the whole session: round 6 (R6-1) saved a copy and the
// node's `widgets_values` disappeared from the file, while an in-place save of the same canvas kept it.

test('a save hands the disk the canvas, even when a node only builds its widget a frame later', async () => {
  const text = 'x'.repeat(533);
  const shown = { id: 11, type: 'ShowText|pysssss', title: '', mode: 0, properties: {}, widgets: [], inputs: [], outputs: [] };
  let frames = 0;
  // The fake stands in for one frame boundary: the pack builds its display widget inside its own
  // `requestAnimationFrame` (pysssss does exactly that), and the page resumes what it awaited after.
  const command = await boot([shown], { requestAnimationFrame: fn => {
    frames += 1;
    shown.widgets = [{ name: 'text_0', type: 'string', value: text, options: {}, callback() {} }];
    fn();
  } });
  const store = command.app.extensionManager.workflow, active = store.activeWorkflow;
  store.getWorkflowByPath = path => store.openWorkflows.find(item => item.path === path);
  store.createNewTemporary = () => { throw new Error('unused'); };
  active.directory = 'workflows';
  // The tracker holds the state the tab cached BEFORE the deferred widget existed, and its own capture
  // does nothing — blocked by `changeCount > 0`, which is the shape round 6 measured. The workflow
  // delegates the way the front-end does (`get activeState() { return this.changeTracker?.activeState }`).
  const stale = JSON.parse(JSON.stringify(command.graph.serialize()));
  active.changeTracker = { activeState: stale, prepareForSave() {} };
  Object.defineProperty(active, 'activeState', { configurable: true, get() { return this.changeTracker?.activeState ?? null; } });
  assert.deepEqual(active.activeState.nodes[0].widgets_values, [], 'the cached state has no widget yet');
  let written = null;
  store.saveWorkflow = async workflow => { written = JSON.parse(JSON.stringify(workflow.activeState)); };
  store.saveAs = () => { throw new Error('unused in this test'); };

  const reply = await command('save_workflow');
  assert.equal(frames, 1, 'the save gave the page a frame for its deferred widgets');
  assert.equal(shown.widgets.length, 1, 'and the node did build its widget in it');
  assert.equal(written.nodes[0].widgets_values[0], text, 'so the file carries the 533 characters instead of losing them');
  assert.equal(reply.saved, true);
  assert.equal(reply.saveStateWarning, undefined, 'a state that had to be taken from the canvas is not a warning');
});

test('a save says so when the tab state cannot be reconciled with the canvas', async () => {
  const shown = { id: 11, type: 'ShowText|pysssss', title: '', mode: 0, properties: {},
    widgets: [{ name: 'text_0', type: 'string', value: 'already built', options: {}, callback() {} }], inputs: [], outputs: [] };
  const command = await boot([shown]);
  const store = command.app.extensionManager.workflow;
  store.getWorkflowByPath = path => store.openWorkflows.find(item => item.path === path);
  store.createNewTemporary = () => { throw new Error('unused'); };
  store.saveWorkflow = async () => {};
  store.saveAs = () => { throw new Error('unused in this test'); };
  // No changeTracker at all: nothing can be corrected here, and pretending otherwise is how the value
  // used to go missing silently.
  const reply = await command('save_workflow');
  assert.equal(reply.saved, true, 'the save still happens — refusing it would be worse than warning');
  assert.match(reply.saveStateWarning, /changeTracker/);
});

// ---------------------------------------------------------------- what a write looks like to the user.
// Round 5's three write-path findings, each with the page behaviour it was written against:
// R5-A a Float widget quantizes its own input, so 0.999 becomes 1 and the read-back "disagrees";
// R5-B a bridge write touches none of the events the tab's change tracker listens to, so the tab goes
//      on saying 「已保存」 while the canvas holds values nobody persisted;
// R5-C the queue reads a hidden control while the user reads a DOM panel that repaints only through
//      that panel's own `setValue`, so a verified write can still look like nothing happened.

const floatNode = (options = {}) => ({ id: 78, type: 'KSampler', title: '', mode: 0, properties: {},
  widgets: [{ name: 'denoise', type: 'number', value: 0.9, options: { min: 0, max: 1, step: 0.01, ...options },
    // LiteGraph's own `onFloatValueChange`: round to the step, then `Number(x.toFixed(p))`.
    callback(value) { const step = this.options.step;
      this.value = Number((Math.round(value / step) * step).toFixed(2)); } }],
  inputs: [], outputs: [] });

test('a value the panel quantizes is an accepted write, and says what was applied', async () => {
  const command = await boot([floatNode()]);
  const reply = await command('update_nodes', { changes: [{ nodeId: 78, widget: 'denoise', value: 0.999 }] });
  assert.equal(reply.changed[0].verified, true, 'half a step away is the panel accepting the value, not refusing it');
  assert.equal(reply.changed[0].after, 1);
  assert.equal(JSON.stringify(reply.changed[0].quantized), JSON.stringify({ requested: 0.999, applied: 1, step: 0.01 }));
  assert.equal(reply.warning, undefined, 'and the batch must not be marked needs_input over it');
  const listed = await command('list_nodes', { detail: 'values' });
  assert.equal(listed.nodes[0].widgets[0].step, 0.01, 'the granularity is visible before the write, not only after');
  assert.equal(listed.nodes[0].widgets[0].round, 0.01);

  // A genuinely refused write still reports false: the difference there is bigger than the step.
  const stubbornWidget = { name: 'denoise', type: 'number', options: { min: 0, max: 1, step: 0.01 }, callback() {} };
  let held = 0.9;
  Object.defineProperty(stubbornWidget, 'value', { get: () => held, set: () => {} });
  const stubborn = await boot([{ id: 78, type: 'KSampler', title: '', mode: 0, properties: {},
    widgets: [stubbornWidget], inputs: [], outputs: [] }]);
  const kept = await stubborn('update_nodes', { changes: [{ nodeId: 78, widget: 'denoise', value: 0.5 }] });
  assert.equal(kept.changed[0].verified, false, 'a value that stays where it was is still a failure');
  assert.equal(kept.changed[0].quantized, undefined);
});

test('a write to the data layer also repaints the panel the user is looking at', async () => {
  const state = { id: 189, type: 'AICG3D_H3Loader', title: '', mode: 0,
    // The pack's own private copies of the same value. They are not what the queue carries
    // (`mediaLoaderState` reads the hidden widget and falls back to the property only when it is empty,
    // and `media_loader_state` has no reader at all), so the bridge leaves them alone — but names them,
    // because a caller comparing properties against the canvas would otherwise read the write as failed
    // (round 5, R5-E).
    properties: { media_loader_state: '{"images":["old.png"]}', minimax_h3_inline_media_state: '{"images":["old.png"]}' },
    widgets: [], inputs: [], outputs: [] };
  const media = { name: 'media_state', type: 'string', value: '{"images":["old.png"]}', options: { serialize: false }, callback() {} };
  const repaints = [];
  const panel = { name: 'h3_media_loader', type: 'h3_media_loader', value: media.value, options: {
    // The pair AICG3D registers: `getValue` reads the hidden widget, `setValue` writes it and renders.
    getValue: () => media.value,
    setValue: value => { media.value = String(value); repaints.push(value); } }, callback() {} };
  state.widgets = [media, panel];
  const command = await boot([state]);

  const reply = await command('update_nodes', { changes: [{ nodeId: 189, widget: 'media_state', value: '{"images":["new.png"]}' }] });
  assert.equal(reply.changed[0].verified, true);
  assert.equal(reply.changed[0].panelRefreshed, true, 'the visible panel was driven through its own setValue');
  assert.equal(JSON.stringify(repaints), JSON.stringify(['{"images":["new.png"]}']));
  assert.equal(JSON.stringify(reply.panels.refreshed), JSON.stringify([{ nodeId: '189', widget: 'media_state' }]));
  assert.match(reply.panels.note, /noVisiblePanel/, 'the reply explains the three answers, not just the good one');
  assert.deepEqual([...reply.changed[0].propertiesStale].sort(), ['media_loader_state', 'minimax_h3_inline_media_state'],
    'the stale private copies are reported, not silently rewritten');
  assert.equal(state.properties.media_loader_state, '{"images":["old.png"]}', 'and they are left exactly as the pack wrote them');

  // A node whose panel is not built yet (the segment editors exist only once the user expands them) is
  // reported as such instead of claiming a repaint that did not happen.
  const hidden = { id: 107, type: 'AICG3D_H3SequenceSegment', title: '', mode: 0, properties: {},
    widgets: [{ name: 'inline_media_state', type: 'string', value: '{"a":1}', options: { serialize: false }, callback() {} }],
    inputs: [], outputs: [] };
  const second = await (await boot([hidden]))('update_nodes', { changes: [{ nodeId: 107, widget: 'inline_media_state', value: '{"a":2}' }] });
  assert.equal(second.changed[0].verified, true, 'the queue value still moved');
  assert.equal(second.changed[0].panelRefreshed, 'no-dom-mirror');
  assert.equal(JSON.stringify(second.panels.noVisiblePanel), JSON.stringify([{ nodeId: '107', widget: 'inline_media_state' }]));

  // A panel that throws is the data write plus a visible complaint — never a failed write.
  const broken = { id: 207, type: 'AICG3D_H3MediaLoader', title: '', mode: 0, properties: {}, widgets: [], inputs: [], outputs: [] };
  const brokenState = { name: 'media_state', type: 'string', value: 'v1', options: { serialize: false }, callback() {} };
  broken.widgets = [brokenState, { name: 'h3_media_loader', type: 'h3_media_loader', value: 'v1',
    options: { getValue: () => brokenState.value, setValue() { throw new Error('面板未挂载'); } }, callback() {} }];
  const third = await (await boot([broken]))('update_nodes', { changes: [{ nodeId: 207, widget: 'media_state', value: 'v2' }] });
  assert.equal(third.changed[0].verified, true);
  assert.equal(third.changed[0].panelRefreshed, false);
  assert.match(third.warning, /面板刷新失败/);
});

test('a bridge write marks the tab as unsaved, the way moving a node by hand does', async () => {
  const command = await boot([floatNode()]);
  const graph = command.graph, app = command.app, active = app.extensionManager.workflow.activeWorkflow;
  let versions = 0, emitted = 0, captured = 0, changes = 0;
  graph.incrementVersion = () => { versions += 1; };
  graph.change = () => { changes += 1; };
  app.canvas.emitAfterChange = () => { emitted += 1; };
  // Only `after-change` is emitted: `captureCanvasState` returns while `changeCount > 0`, so a lone
  // `before-change` would wedge the tracker for the rest of the session.
  assert.equal(app.canvas.emitBeforeChange, undefined);
  active.changeTracker = { captureCanvasState() { captured += 1; active.isModified = true; } };

  const reply = await command('update_nodes', { changes: [{ nodeId: 78, widget: 'denoise', value: 0.9 }] });
  assert.equal(versions, 1, 'the graph counter moved, so serialization and change detection see the write');
  assert.equal(emitted, 1, 'the canvas event the change tracker listens for was published');
  assert.equal(captured, 1, 'and the tracker itself was asked directly, because a headless write emits nothing else');
  assert.equal(changes, 1, 'and the canvas was told to redraw');
  assert.equal(reply.dirtyMarked, true, 'the answer reported is the tab own isModified');
  assert.equal(reply.dirtyNote, undefined);

  // A front-end without the tracker API still gets an honest note instead of a silent 「已保存」.
  const bare = await boot([floatNode()]);
  bare.app.extensionManager.workflow.activeWorkflow.changeTracker = undefined;
  const second = await bare('update_nodes', { changes: [{ nodeId: 78, widget: 'denoise', value: 0.8 }] });
  assert.match(second.dirtyNote, /没有变更追踪接口|未保存/);
  assert.equal(second.dirtyMarked, false);
});

// ---------------------------------------------------------------- two wording bugs that cost real writes.
// R5-F: the "this write will be reverted" warning fired on any document that was not exactly one text
// part. AICG3D keeps a plain multi-paragraph prompt as several text parts and resyncs it fine, so the
// warning sent callers down the expensive path (整图回灌) for a write that would have persisted.
// R6-4: `ShowText|pysssss` builds its widget inside a requestAnimationFrame after `onConfigure`
// (~3.5 s measured), and a write aimed at it during that window answered 「可编辑参数不存在」 — which
// reads as "this node cannot be changed" rather than "not yet".

test('a multi-paragraph text document is mirrored, not announced as a write that will be reverted', async () => {
  const long = '第一段' + '第二段' + '第三段';
  const node = { id: 190, type: 'AICG3D_H3ContextSegments', title: '', mode: 0,
    properties: { minimax_h3_prompt_reference_doc: { text: long,
      parts: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }, { type: 'text', text: '第三段' }] } },
    widgets: [{ name: 'prompt', type: 'h3_prompt', value: long,
      options: { serialize: false, getValue: () => node.widgets[0].value, setValue: value => { node.widgets[0].value = String(value); } } }],
    inputs: [], outputs: [] };
  const command = await boot([node]);
  const reply = await command('update_nodes', { changes: [{ nodeId: 190, widget: 'prompt', value: '换成中文的新提示词' }] });

  assert.equal(reply.changed[0].verified, true);
  assert.deepEqual(reply.changed[0].shadowDocsSynced, ['minimax_h3_prompt_reference_doc'],
    'the document is a text mirror of the widget, so it is kept in step');
  assert.equal(reply.revertedWrites, undefined, 'and the caller is not told to take the expensive path for nothing');
  const doc = node.properties.minimax_h3_prompt_reference_doc;
  assert.equal(doc.text, '换成中文的新提示词');
  assert.equal(doc.parts.length, 1, 'collapsing the paragraphs is what the pack itself does when it resyncs');

  // A document whose `text` says more than its parts is not a mirror, and a document with a mention is
  // still the diverged case: both must keep the warning.
  // Attributable (its `text` mirrors the widget), but the parts do not add up to that text — the
  // document is holding structure the plain string cannot represent, so it must not be rewritten.
  const hiddenExtra = { id: 191, type: 'AICG3D_H3ContextSegments', title: '', mode: 0,
    properties: { minimax_h3_prompt_reference_doc: { text: long,
      parts: [{ type: 'text', text: '第一段' }, { type: 'mention', label: '图片1' }, { type: 'text', text: '第二段第三段' }] } },
    widgets: [{ name: 'prompt', type: 'h3_prompt', value: long,
      options: { serialize: false, getValue: () => hiddenExtra.widgets[0].value, setValue: value => { hiddenExtra.widgets[0].value = String(value); } } }],
    inputs: [], outputs: [] };
  const second = await (await boot([hiddenExtra]))('update_nodes', { changes: [{ nodeId: 191, widget: 'prompt', value: '新内容' }] });
  assert.deepEqual(second.changed[0].shadowDocsDiverged, ['minimax_h3_prompt_reference_doc'],
    'a doc that carries something its parts do not show is not overwritten from a plain string');
  assert.match(second.revertedWrites[0].note, /下一次序列化前有效/);
});

test('a node whose controls are not built yet says so instead of denying it can be written', async () => {
  const shown = { id: 111, type: 'ShowText|pysssss', title: '', mode: 0, properties: {}, widgets: [], inputs: [], outputs: [] };
  const command = await boot([shown]);
  const error = await command('update_nodes', { changes: [{ nodeId: 111, widget: 'text_0', value: '探针' }] }).catch(caught => caught);
  assert.match(error.bridgeError, /可编辑参数不存在：111.text_0/);
  assert.match(error.hint, /requestAnimationFrame/, 'the hint names the deferred build, not just the missing name');
  assert.match(error.hint, /等 4 秒|3\.5 秒/, 'and gives the caller the one action that works: wait and resend');
  assert.match(error.hint, /本来就没有可写控件/, 'the other cause stays listed, so the hint cannot be a guess');
});
