import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime } from '../lib/runtime.js';
import { callComfyTool } from '../lib/mcp.js';
import { MCP_TOOLS } from '../lib/tool-definitions.js';
import { auditGraph, auditParams, auditWrites, defInputs, paramViolations } from '../lib/audit.js';

// ---------------------------------------------------------------- definitions

test('object_info inputs normalize into connect / widget / combo kinds', () => {
  // Shape taken verbatim from the server: `GET /object_info/<type>` returns
  // { <type>: { input: { required, optional }, output, ... } }.
  const inputs = defInputs({
    name: 'Something',
    input: {
      required: {
        model: ['MODEL', { control_after_generate: undefined }],
        seed: ['INT', { min: 0, max: 1125899906842624, default: 0 }],
        text: ['STRING', { multiline: true, default: '' }],
        ckpt_name: [['a.safetensors', 'b.safetensors'], { default: 'a.safetensors' }],
        alt_combo: ['COMBO', { values: ['x', 'y'] }],
        images: ['IMAGE'],
        both: ['IMAGE', 'MASK'],
        format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: {} }, { key: 'mp4', inputs: {} }] }],
        style: ['COMBO', { options: ['flat', 'photo'] }],
        hypernetwork_name: ['COMBO', { multiselect: false, options: [] }],
        control_net_name: [[]]
      },
      optional: { vae: ['VAE'] }
    }
  });
  assert.equal(inputs.model.kind, 'connect');
  assert.equal(inputs.model.type, 'MODEL');
  assert.equal(inputs.model.group, 'required');
  assert.equal(inputs.seed.kind, 'int');
  assert.equal(inputs.seed.min, 0);
  assert.equal(inputs.text.kind, 'string');
  assert.equal(inputs.ckpt_name.kind, 'combo');
  assert.deepEqual(inputs.ckpt_name.options, ['a.safetensors', 'b.safetensors']);
  assert.deepEqual(inputs.alt_combo.options, ['x', 'y'], 'COMBO with values: is read as an option list too');
  assert.equal(inputs.vae.group, 'optional');
  assert.equal(inputs.both.kind, 'connect', 'a list of accepted class codes is a wire, not a combo');
  assert.equal(inputs.both.type, 'IMAGE');
  assert.equal(inputs.format.kind, 'combo', 'V3 dynamic combo is a widget, so it is never "unwired required input"');
  assert.deepEqual(inputs.format.options, ['auto', 'mp4'], 'the dynamic option keys are what the canvas stores');
  assert.deepEqual(inputs.style.options, ['flat', 'photo'], 'options as the second element is an option list too');
  assert.equal(inputs.hypernetwork_name.kind, 'combo');
  assert.equal(inputs.hypernetwork_name.options, undefined, 'an empty list means filled at run time, not "nothing accepted"');
  assert.equal(inputs.control_net_name.kind, 'combo');
  assert.equal(inputs.control_net_name.options, undefined);
  assert.deepEqual(defInputs({ required: { seed: ['INT', {}] } }), {},
    'a block without the server\'s `input` envelope is not a definition — reading one must not look like "no constraints"');
});

// ---------------------------------------------------------------- graph audit

const defs = {
  KSampler: { input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'],
    latent_image: ['LATENT'], seed: ['INT', { min: 0, max: 9 }], steps: ['INT', { min: 1, max: 50 }] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd1.safetensors', 'sd2.safetensors']] } } },
  SaveImage: { input: { required: { images: ['IMAGE'] } } }
};
const node = (id, type, extra = {}) => ({ id: String(id), type, title: '', mode: 0, widgets: [], inputs: [], outputs: [], shadowDocs: [], ...extra });

test('graph audit refutes a required connection on the way to an output node', () => {
  const page = { nodes: [node(1, 'KSampler', { inputs: [{ name: 'model', type: 'MODEL', link: 3 },
    { name: 'positive', type: 'CONDITIONING', link: 4 }, { name: 'negative', type: 'CONDITIONING', link: 5 },
    { name: 'latent_image', type: 'LATENT', link: null }],
  outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }] }),
  node(2, 'SaveImage', { inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] })], linkCount: 4 };
  const result = auditGraph({ page, defs });
  assert.equal(result.verdict, 'refuted');
  const dangling = result.checks.find(check => check.id === 'dangling-required-input');
  assert.equal(dangling.verdict, 'refuted');
  assert.deepEqual(dangling.evidence[0], { nodeId: '1', type: 'KSampler', title: '', input: 'latent_image', needs: 'LATENT' });
  assert.equal(result.unusedIncomplete, undefined, 'a wired chain has nothing left over');
});

test('an unused incomplete branch is advisory, not an execution blocker', () => {
  // Reviewer's case: a valid output branch plus an unused, unconnected KSampler. ComfyUI
  // validates required inputs through the output nodes, so the stray branch must not refute.
  const chain = node(1, 'KSampler', {
    inputs: [{ name: 'model', type: 'MODEL', link: 3 }, { name: 'positive', type: 'CONDITIONING', link: 4 },
      { name: 'negative', type: 'CONDITIONING', link: 5 }, { name: 'latent_image', type: 'LATENT', link: 6 }],
    outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }] });
  const save = node(2, 'SaveImage', { inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] });
  const stray = node(99, 'KSampler', { inputs: [{ name: 'model', type: 'MODEL', link: null },
    { name: 'positive', type: 'CONDITIONING', link: null }, { name: 'negative', type: 'CONDITIONING', link: null },
    { name: 'latent_image', type: 'LATENT', link: null }] });
  const result = auditGraph({ page: { nodes: [chain, save, stray], linkCount: 4 }, defs });
  assert.equal(result.verdict, 'supported', 'the runnable chain decides the verdict');
  assert.equal(result.checks.find(check => check.id === 'dangling-required-input').verdict, 'supported');
  assert.deepEqual(result.unusedIncomplete.nodes.map(item => [item.nodeId, item.input]),
    [['99', 'model'], ['99', 'positive'], ['99', 'negative'], ['99', 'latent_image']]);
  assert.match(result.unusedIncomplete.note, /不影响提交/);
});

test('a widget-backed input slot with no link is not an unwired required input', () => {
  // Real shape: the page lists combo widgets among node.inputs with link null, and V3
  // dynamic combos (SaveVideo.format) are spelled with a class-code-looking label.
  const saverDefs = { SaveVideo: { input: { required: {
    video: ['VIDEO'],
    format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: {} }, { key: 'mp4', inputs: {} }] }] } } } };
  const page = { nodes: [node(205, 'SaveVideo', { inputs: [{ name: 'video', type: 'VIDEO', link: 12 },
    { name: 'format', type: 'COMFY_DYNAMICCOMBO_V3', slot: 1, link: null }],
  widgets: [{ name: 'format', kind: 'dom', type: 'combo', value: 'auto' }] })], linkCount: 1 };
  const result = auditGraph({ page, defs: saverDefs });
  assert.equal(result.checks.find(check => check.id === 'dangling-required-input').verdict, 'supported');
  assert.equal(result.checks.find(check => check.id === 'param-values'), undefined);
});

test('a canvas that cannot serialize is a hard failure, and an old bridge is not judged for it', () => {
  const healthy = { nodes: [node(1, 'CheckpointLoaderSimple'), node(2, 'SaveImage', { inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] })], linkCount: 1 };
  const blocked = auditGraph({ page: { ...healthy, serializable: false }, defs });
  assert.equal(blocked.verdict, 'refuted', 'the queue is built from graph.serialize(), so nothing can run');
  const serializable = blocked.checks.find(c => c.id === 'graph-serializable');
  assert.equal(serializable.verdict, 'refuted');
  assert.match(serializable.hint, /definitions/);
  assert.match(serializable.hint, /load_workflow/, 'and the hint gives the one action that fixes it');

  // A page predating the fact reports nothing: "unknown" must not become "broken".
  const silent = auditGraph({ page: healthy, defs });
  assert.equal(silent.checks.find(c => c.id === 'graph-serializable'), undefined);
  assert.equal(silent.verdict, 'supported');
  assert.equal(auditGraph({ page: { ...healthy, serializable: true }, defs })
    .checks.find(c => c.id === 'graph-serializable').verdict, 'supported');
});

test('graph audit separates intentional bypass, shadowed widgets and a missing saver', () => {
  const healthy = { nodes: [node(1, 'CheckpointLoaderSimple'), node(2, 'SaveImage', { inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] })], linkCount: 1 };
  assert.equal(auditGraph({ page: healthy, defs }).verdict, 'supported');
  assert.equal(auditGraph({ page: healthy, defs }).checks.find(c => c.id === 'saver-present').verdict, 'supported');

  const noSaver = { nodes: [node(1, 'CheckpointLoaderSimple')], linkCount: 0 };
  const missing = auditGraph({ page: noSaver, defs }).checks.find(c => c.id === 'saver-present');
  assert.equal(missing.verdict, 'refuted');

  const bypassed = auditGraph({ page: { nodes: [node(3, 'KSampler', { mode: 4 })], linkCount: 0 }, defs });
  assert.equal(bypassed.checks.find(c => c.id === 'bypassed-nodes').verdict, 'unresolved',
    'a bypass may be deliberate, so it must not read as a hard failure');
  assert.equal(bypassed.checks.find(c => c.id === 'dangling-required-input').verdict, 'supported',
    'muted or bypassed nodes are exempt from the wiring check');

  const shadowed = auditGraph({ page: { nodes: [node(7, 'AICG3D_H3', { shadowDocs: ['minimax_h3_prompt_reference_doc'],
    widgets: [{ name: 'prompt', kind: 'hidden' }] })], linkCount: 0 }, defs: { ...defs, AICG3D_H3: { input: { required: {} } } } });
  const shadow = shadowed.checks.find(c => c.id === 'shadowed-widgets');
  assert.equal(shadow.verdict, 'unresolved');
  assert.equal(shadow.evidence[0].hiddenPrompt, true);
  assert.match(shadow.hint, /verified/);

  const wiredUnknown = auditGraph({ page: { nodes: [node(8, 'MissingPackNode', { inputs: [{ name: 'image', type: 'IMAGE', link: 4 }],
    outputs: [{ name: 'image', type: 'IMAGE', links: [] }] })], linkCount: 1 }, defs });
  assert.equal(wiredUnknown.checks.find(c => c.id === 'definitions-known').verdict, 'unresolved',
    'an unknown type wired into the graph is a real open question');

  const annotation = auditGraph({ page: { nodes: [node(9, 'MarkdownNote', { widgets: [{ name: 'text', kind: 'plain', type: 'string', value: '备注' }] })], linkCount: 0 }, defs });
  assert.equal(annotation.checks.find(c => c.id === 'definitions-known').verdict, 'supported', 'an unwired annotation node is not an open question');
  assert.deepEqual(annotation.ignoredIsolatedTypes.types, ['MarkdownNote'], 'but it is still reported, not hidden');
  assert.equal(annotation.verdict, 'refuted', 'the missing saver still refutes on its own merits');
});

test('a saver is a save-shaped name; output_node plus a media slot is only a question', () => {
  // comfyui-AICG3D's AICG3D_H3SequenceCombine has no "save" in its name, so it is listed in
  // OUTPUT_HINTS after reading the pack's source (h3easy/nodes.py:12289 writes into
  // folder_paths.get_output_directory()). The flag alone cannot carry that conclusion:
  // KJNodes' ImageAndMaskPreview subclasses SaveImage and redirects it to the temp directory,
  // and rgthree's RgthreeImageComparer subclasses PreviewImage behind a name matching no pattern.
  const aicgDefs = { AICG3D_H3SequenceCombine: { output_node: true, output: ['VIDEO', 'STRING'], input: { required: {} } },
    ImageAndMaskPreview: { output_node: true, output: ['IMAGE', 'MASK'], input: { required: { image: ['IMAGE'] } } },
    RgthreeImageComparer: { output_node: true, output: ['IMAGE'], input: { required: { image1: ['IMAGE'] } } },
    PreviewImage: { output_node: true, output: ['IMAGE'], input: { required: { images: ['IMAGE'] } } },
    Reroute: { output_node: false, input: { required: {} } } };
  const page = { nodes: [node(195, 'AICG3D_H3SequenceCombine'), node(300, 'PreviewImage')], linkCount: 2 };
  const result = auditGraph({ page, defs: aicgDefs });
  const saver = result.checks.find(c => c.id === 'saver-present');
  assert.equal(saver.verdict, 'supported');
  assert.deepEqual(saver.evidence.map(item => item.nodeId), ['195']);
  assert.equal(saver.evidence[0].source, 'object_info.output_node');

  // The reviewer's reproduction: a temp-writing preview as the only terminal node used to answer
  // "会落盘". `ImageAndMaskPreview` carries the preview word, the comparer does not — both have to
  // end up as a question, not as a promise.
  for (const type of ['ImageAndMaskPreview', 'RgthreeImageComparer']) {
    const only = auditGraph({ page: { nodes: [node(7, type, { outputs: [{ name: 'images', type: 'IMAGE', links: [] }] })], linkCount: 0 }, defs: aicgDefs });
    const found = only.checks.find(c => c.id === 'saver-present');
    assert.notEqual(found.verdict, 'supported', type + ' declares output_node with an image output and writes nothing to the output folder');
    assert.equal(found.verdict, 'unresolved');
    assert.match(found.hint, /type:"output"/);
  }

  const previewOnly = auditGraph({ page: { nodes: [node(300, 'PreviewImage')], linkCount: 0 }, defs: aicgDefs });
  const previewCheck = previewOnly.checks.find(c => c.id === 'saver-present');
  assert.equal(previewCheck.verdict, 'unresolved',
    'a preview claims output_node: true but drops no file — it is not a saver, and "preview only" is a legitimate state, not a defect');
  assert.deepEqual(previewCheck.evidence.map(item => item.nodeId), ['300']);
  assert.match(previewCheck.evidence[0].note, /浏览器/);

  // An explicit false from the server outranks a name that looks like a saver.
  const declaredFalse = auditGraph({ page: { nodes: [node(1, 'Reroute')], linkCount: 0 }, defs: aicgDefs });
  assert.equal(declaredFalse.checks.find(c => c.id === 'saver-present').verdict, 'refuted');
});

test('a websocket display node is not believed as a file saver', () => {
  // custom_nodes/websocket_image_save.py: SaveImageWebsocket declares OUTPUT_NODE = True with
  // RETURN_TYPES = () and pushes the image over the progress websocket — it writes no file, so the
  // save-shaped name promised an output that get_image could never find.
  // The other half of this test matters more: on this machine six save-shaped types report an empty
  // output list and five of them genuinely write files (a ComfyUI saver returns only a `ui` dict),
  // so "no output slots" cannot be the rule — that version traded one false positive for five
  // false negatives, which the live /object_info scan caught before it shipped.
  const defs = { SaveImageWebsocket: { output_node: true, output: [], input: { required: { images: ['IMAGE'] } } },
    SaveImageWithAlpha: { output_node: true, output: [], input: { required: { images: ['IMAGE'] } } },
    SaveImageDataSetToFolder: { output_node: true, output: [], input: { required: { images: ['IMAGE'] } } } };
  const ws = auditGraph({ page: { nodes: [node(4, 'SaveImageWebsocket')], linkCount: 0 }, defs });
  const saver = ws.checks.find(c => c.id === 'saver-present');
  assert.equal(saver.verdict, 'unresolved', 'a websocket display node is reported, not believed');
  assert.match(saver.evidence[0].note, /不写文件/);
  for (const type of ['SaveImageWithAlpha', 'SaveImageDataSetToFolder']) {
    const real = auditGraph({ page: { nodes: [node(5, type)], linkCount: 0 }, defs });
    assert.equal(real.checks.find(c => c.id === 'saver-present').verdict, 'supported', type + ' writes files despite an empty output list');
  }
});

test('a display node that declares output_node does not count as a file saver', () => {
  // ShowText|pysssss has OUTPUT_NODE = True and a STRING output. Treating the flag alone as
  // "writes a file" would promise disk output on a graph that only prints text.
  const displayDefs = { ShowText: { output_node: true, output: ['STRING'], input: { required: {} } } };
  const result = auditGraph({ page: { nodes: [node(9, 'ShowText')], linkCount: 0 }, defs: displayDefs });
  assert.equal(result.checks.find(c => c.id === 'saver-present').verdict, 'refuted');
  // It is still an execution root, so a gap on its dependency path is not excused.
  const wired = auditGraph({ page: { nodes: [node(9, 'ShowText', { inputs: [{ name: 'text', type: 'STRING', link: 7 }] }),
    node(10, 'MissingNode', { outputs: [{ name: 'text', type: 'STRING', links: [7] }] })], linkCount: 1 }, defs: displayDefs });
  assert.equal(wired.checks.find(c => c.id === 'definitions-known').verdict, 'unresolved');
});

test('a bypassed saver is not counted as persistence', () => {
  // graphToPrompt drops BYPASS nodes, so a mode-4 SaveVideo will not write anything.
  const saverDefs = { SaveVideo: { output_node: true, output: ['VIDEO'], input: { required: {} } } };
  const result = auditGraph({ page: { nodes: [node(1, 'SaveVideo', { mode: 4 })], linkCount: 0 }, defs: saverDefs });
  assert.equal(result.checks.find(c => c.id === 'saver-present').verdict, 'refuted');
});

test('a value cut at the reply cap is unresolved, never refuted', () => {
  const longLabel = '很长的枚举值'.repeat(60) + '…';
  const defsLong = { Widget: { input: { required: { choice: [['短值']] } } } };
  const canvas = auditParams({ page: { nodes: [node(1, 'Widget', { widgets: [{ name: 'choice', kind: 'dom', value: longLabel }] })] }, defs: defsLong });
  assert.equal(canvas.checks.find(c => c.id === 'param-values').count, 0, 'a truncated canvas value cannot be judged');
  assert.equal(canvas.checks.find(c => c.id === 'param-values-unverified').count, 1);
  assert.equal(canvas.verdict, 'unresolved');

  const serialized = auditParams({ page: { nodes: [node(1, 'Widget', { widgets: [{ name: 'choice', kind: 'dom', value: '显示值' }] })],
    serializedInputs: { '1': { choice: '裁剪后的前缀…' } }, serializedTruncated: ['1.choice'] }, defs: defsLong });
  assert.equal(serialized.checks.find(c => c.id === 'param-values').count, 0, 'a truncated submission is not a violation');
  assert.match(serialized.checks.find(c => c.id === 'param-values-unverified').evidence[0].likely, /截断上限/);
});

// ---------------------------------------------------------------- param audit

test('a combo whose option list is server-filled is not judged against an empty set', () => {
  const comboDefs = {
    SaveVideo: { input: { required: { format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto' }, { key: 'mp4' }] }] } } },
    HypernetworkLoader: { input: { required: { hypernetwork_name: ['COMBO', { options: [] }] } } }
  };
  const page = { nodes: [node(1, 'SaveVideo', { widgets: [{ name: 'format', kind: 'dom', value: 'prores' }] }),
    node(2, 'HypernetworkLoader', { widgets: [{ name: 'hypernetwork_name', kind: 'dom', value: 'something.data' }] })] };
  const result = auditParams({ page, defs: comboDefs });
  assert.equal(result.checks.find(c => c.id === 'param-values').count, 0,
    'no serialized evidence means the mismatch cannot be called a definite failure');
  assert.equal(result.verdict, 'unresolved');
  const values = result.checks.find(c => c.id === 'param-values-unverified');
  assert.equal(values.count, 1, 'only the value the definition really rules out is reported');
  assert.equal(values.evidence[0].nodeId, '1');
  assert.deepEqual(values.evidence[0].accepted, ['auto', 'mp4']);
});

test('param audit separates definite failures from values that need serialized evidence', () => {
  const page = { nodes: [node(1, 'KSampler', { widgets: [{ name: 'seed', kind: 'plain', type: 'number', value: 99 },
    { name: 'steps', kind: 'plain', type: 'number', value: 20 }] }),
  node(2, 'CheckpointLoaderSimple', { widgets: [{ name: 'ckpt_name', kind: 'dom', type: 'combo', value: '稳定1.5（推荐）', shown: ['稳定1.5（推荐）', 'SD2'] }] })] };
  const result = auditParams({ page, defs });
  assert.equal(result.verdict, 'refuted');
  const values = result.checks.find(c => c.id === 'param-values');
  assert.equal(values.count, 1, 'the out-of-range seed is the only definite failure');
  assert.deepEqual(values.evidence.map(item => item.widget), ['seed']);
  assert.equal(values.evidence[0].value, 99);
  assert.deepEqual(values.evidence[0].accepted, [0, 9], 'steps=20 is inside 1..50 so it is not reported');
  const unverified = result.checks.find(c => c.id === 'param-values-unverified');
  assert.equal(unverified.count, 1, 'the localized label has no serialized evidence, so it stays unresolved');
  assert.deepEqual(unverified.evidence.map(item => item.widget), ['ckpt_name']);

  const localized = auditParams({ page: { nodes: [page.nodes[1]] }, defs: { ...defs, CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd1.safetensors']] } } } } });
  assert.equal(localized.verdict, 'unresolved', 'a localized label alone must not refute');
  const flagged = localized.checks.find(c => c.id === 'param-values-unverified').evidence.find(item => item.widget === 'ckpt_name');
  assert.deepEqual(flagged.accepted, ['sd1.safetensors'], 'the reply carries the authoritative options');
  assert.match(flagged.likely, /序列化|前端/);

  const filtered = auditParams({ page, defs, filter: 'Checkpoint' });
  assert.equal(filtered.checkedNodes, 1);
  assert.equal(filtered.checks.find(c => c.id === 'param-values-unverified').count, 1);

  const withNotes = auditParams({ page: { nodes: [...page.nodes, node(99, 'MarkdownNote', { widgets: [{ name: 'text', kind: 'plain', value: '备注' }] })] }, defs });
  assert.equal(withNotes.checks.find(c => c.id === 'uncheckable').verdict, 'supported', 'unwired annotation nodes are not open questions');
  assert.deepEqual(withNotes.ignoredUncheckable.types, ['MarkdownNote']);
  assert.equal(withNotes.checks.find(c => c.id === 'param-values').count, 1, 'the real violation is still reported');
  assert.equal(withNotes.checks.find(c => c.id === 'param-values-unverified').count, 1, 'and the open question rides along');
});

test('a localized label whose serialized value is accepted is supported with a note, not a failure', () => {
  // The page converts 稳定1.5（推荐） to sd1.safetensors at queue time. The serialized prompt is
  // the evidence that this run works; with that evidence the audit must not leave the workflow
  // looking broken, because the tool instructions tell the model to repair anything unresolved.
  const page = { nodes: [node(2, 'CheckpointLoaderSimple', {
    widgets: [{ name: 'ckpt_name', kind: 'dom', type: 'combo', value: '稳定1.5（推荐）' }] })],
  serializedInputs: { '2': { ckpt_name: 'sd1.safetensors' } } };
  const result = auditParams({ page, defs });
  assert.equal(result.verdict, 'supported');
  assert.equal(result.checks.find(c => c.id === 'param-values').verdict, 'supported');
  assert.equal(result.checks.find(c => c.id === 'param-values-unverified').verdict, 'supported');
  assert.equal(result.convertedValues.count, 1, 'reported as information, not as an open question');
  const item = result.convertedValues.evidence[0];
  assert.equal(item.value, 'sd1.safetensors', 'the submitted value is what the evidence reports');
  assert.equal(item.canvasValue, '稳定1.5（推荐）');
  assert.equal(item.source, 'graphToPrompt');
  assert.match(item.likely, /前端已在排队时转换/);
  assert.match(result.convertedValues.note, /不要为了让体检更好看/);

  // The same rule applied to a range: the serialized number is the truth, so a canvas value
  // outside the range that serializes inside it is not a violation.
  const numeric = { nodes: [node(1, 'KSampler', { widgets: [{ name: 'seed', kind: 'plain', type: 'number', value: 99 }] })],
    serializedInputs: { '1': { seed: 3 } } };
  assert.equal(auditParams({ page: numeric, defs }).verdict, 'supported');
});

test('a serialized value outside the domain is a question, not a verdict — but a range is', () => {
  // Why the combo half cannot be refuted from /object_info alone: a node that declares
  // `VALIDATE_INPUTS(self, **kwargs)` skips ComfyUI's own enumeration check, and 26 such
  // definitions exist on this machine (10 with the kwargs form). Refuting one tells the model to
  // "repair" a canvas value that queues fine — which is how a working localized enum gets broken.
  // The numeric half stays definite: the server enforces min/max on a serialized number.
  const page = { nodes: [node(2, 'CheckpointLoaderSimple', {
    widgets: [{ name: 'ckpt_name', kind: 'dom', type: 'combo', value: '稳定1.5（推荐）' }] })],
  serializedInputs: { '2': { ckpt_name: '不存在.safetensors' } } };
  const result = auditParams({ page, defs });
  assert.equal(result.verdict, 'unresolved', 'an open question must not read as a hard failure, nor as a clean pass');
  const item = result.checks.find(c => c.id === 'param-values-unverified').evidence[0];
  assert.equal(item.value, '不存在.safetensors', 'the reply names the value the queue would receive');
  assert.equal(item.canvasValue, '稳定1.5（推荐）');
  assert.match(item.likely, /VALIDATE_INPUTS/);
  assert.match(item.likely, /先 run/);

  // Serialized evidence also makes a numeric violation definite even when the canvas agrees.
  const numeric = { nodes: [node(1, 'KSampler', { widgets: [{ name: 'seed', kind: 'plain', type: 'number', value: 3 }] })],
    serializedInputs: { '1': { seed: 120 } } };
  const outOfRange = auditParams({ page: numeric, defs });
  assert.equal(outOfRange.verdict, 'refuted');
  assert.equal(outOfRange.checks.find(c => c.id === 'param-values').evidence[0].value, 120);
});

// ---------------------------------------------------------------- audit tool wiring

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-audit-'));
  return new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
}
const panel = (id, sessionId) => ({ id, sessionId, ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });

test('audit pulls page facts and one object_info per distinct node type', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  const asked = [];
  rt.command = async (sessionId, action) => { asked.push(['command', action]); return {
    linkCount: 1, nodes: [node(1, 'KSampler', { widgets: [{ name: 'seed', kind: 'plain', type: 'number', value: 3 }] })] }; };
  rt.request = async path => { asked.push(['request', path]); return { KSampler: defs.KSampler }; };

  const graph = await callComfyTool(rt, 'audit', { op: 'graph' }, { dshSessionId: 'A' });
  assert.equal(graph.structuredContent.op, 'graph');
  assert.ok(['refuted', 'unresolved', 'supported'].includes(graph.structuredContent.verdict));
  assert.equal(graph.structuredContent.nodeCount, 1);
  assert.deepEqual(asked.filter(a => a[0] === 'request'), [['request', '/object_info/KSampler']], 'one lookup per distinct type');

  const params = await callComfyTool(rt, 'audit', { op: 'params', filter: 'KSampler' }, { dshSessionId: 'A' });
  assert.equal(params.structuredContent.op, 'params');
  assert.equal(params.structuredContent.checkedNodes, 1);

  await assert.rejects(callComfyTool(rt, 'audit', { op: 'nonsense' }, { dshSessionId: 'A' }), /op 只能是 graph \/ params/);
  await assert.rejects(callComfyTool(rt, 'audit', {}, {}), /需要当前对话身份/);
});

test('audit stays read-only and the census declares itself as such', () => {
  const audit = MCP_TOOLS.find(tool => tool.name === 'audit');
  assert.ok(audit);
  assert.equal(audit.annotations.readOnlyHint, true, 'audit must stay exempt from the write lease');
  assert.deepEqual(audit.inputSchema.properties.op.enum, ['graph', 'params', 'writes']);
  // The census verdict means writability, not runnability; reading it the other way would tell a
  // caller a workflow is broken when it only has controls the plugin cannot touch.
  assert.match(audit.description, /可写性普查/);
  assert.match(audit.inputSchema.properties.op.description, /能写、哪些不能/);
});

test('a serialized field that missed the truncated-name list is still not refuted', () => {
  // The reviewer's 41-field reproduction: `serializedTruncated` is what keeps a value cut at the
  // reply cap out of the comparison, so a list that filled up early used to let the next field be
  // judged on its 4 KB prefix — a definite "提交会被拒绝" on a value nobody truncated on purpose.
  // Two things close it: the bridge raises the name list far above any real graph, and an
  // out-of-domain serialized value is a question rather than a verdict.
  const widgets = Array.from({ length: 41 }, (_, index) => ({ name: 'f' + index, kind: 'combo', type: 'combo', value: '稳定1.5（推荐）' }));
  const defs = { Widget: { input: { required: Object.fromEntries(widgets.map(widget => [widget.name, [['权威值']]])) } } };
  const nodes = [{ id: '3', type: 'Widget', title: '', mode: 0, widgets, inputs: [], outputs: [] }];
  const serialized = Object.fromEntries(widgets.map(widget => [widget.name, 'L'.repeat(4096) + '…']));
  const listed = widgets.slice(0, 40).map(widget => '3.' + widget.name);
  const violations = paramViolations(nodes, defs, { '3': serialized }, listed);
  assert.equal(violations.bad.length, 0, 'no field, including the 41st outside the list, may be refuted');
  assert.equal(violations.unverified.length, 41, 'all of them are open questions about what the queue received');
});

test('the param audit refuses a canvas that cannot produce a prompt', () => {
  // R7-5: the page now answers `promptFailed` whether or not it worked, and an older page that says
  // nothing is not judged for a fact it never reported.
  const nodes = [{ id: '195', type: 'AICG3DPromptSegmentSplit', title: '', mode: 0,
    widgets: [{ name: 'text', kind: 'plain', type: 'string', value: '镜1' }], inputs: [], outputs: [] }];
  const failed = auditParams({ page: { nodes, promptFailed: true, serializedError: 'Attempted to access LGraph reference…', serializedInputs: null }, defs: {} });
  assert.equal(failed.verdict, 'refuted', 'no prompt means nothing can be submitted');
  const refused = failed.checks.find(item => item.id === 'prompt-serializable');
  assert.equal(refused.verdict, 'refuted');
  assert.match(refused.hint, /definitions/);
  assert.match(refused.hint, /load_workflow/);
  assert.match(refused.evidence[0].note, /LGraph/, 'the page error travels as evidence');

  const worked = auditParams({ page: { nodes, promptFailed: false, serializedInputs: { 195: { text: '镜1' } } }, defs: {} });
  assert.equal(worked.checks.find(item => item.id === 'prompt-serializable').verdict, 'supported');

  const silent = auditParams({ page: { nodes }, defs: {} });
  assert.equal(silent.checks.find(item => item.id === 'prompt-serializable'), undefined,
    'a page that never reported the fact gets no verdict about it');
});

test('the write census classifies every control as writable, conditional, or impossible', () => {
  // Facts arrive exactly as `audit_writes` reports them: flags, no values, no graph (round 7 request —
  // a caller should learn what the plugin cannot write BEFORE it tries, which is the honest answer to
  // the R6-6 request for a properties write channel).
  const flag = (name, extra = {}) => ({ name, kind: 'plain', hasSetter: false, hasGetter: false,
    serializes: true, inOptions: null, optionCount: null, step: null, wired: null, mirror: false, props: [], ...extra });
  const node = (id, type, widgets, extra = {}) => ({ id: String(id), type, title: '', mode: 0,
    subgraph: null, widgetCount: widgets.length, widgets, shadowDocs: [], ...extra });
  const SUB = 'a67caa28-5f85-4917-8396-36004960dd30';
  const page = { workflowPath: 'workflows/H3.json', serializable: true, subgraphCount: 1, nodes: [
    node(1, 'KSampler', [flag('seed'), flag('mode', { inOptions: false, optionCount: 2 }), flag('denoise', { step: 0.01 })]),
    node(198, 'AICG3D_H3SelectedVideoContext', [flag('prompt', { wired: 377 })]),
    node(309, '忽略多组孤海', [flag('guhai_ig', { kind: 'shadowed', serializes: false, props: ['guhai_ig_filter', 'guhai_ig_active_set'] })]),
    node(5, 'SomeVueNode', [flag('mode', { kind: 'dom' })]),
    node(189, 'AICG3D_H3Loader', [flag('media_state', { kind: 'hidden', serializes: false, mirror: true })]),
    node(107, 'AICG3D_H3SequenceSegment', [flag('inline_media_state', { kind: 'hidden', serializes: false })]),
    node(111, 'ShowText|pysssss', []),
    node(77, SUB, [flag('noise_seed')], { subgraph: SUB })
  ] };
  const result = auditWrites({ page, defs: {} });

  assert.equal(result.controls, 9, 'a node without controls is not counted as a control');
  assert.equal(result.blocked, 3, 'wired input, properties-backed, and a display component with no setter');
  assert.equal(result.conditional, 4, 'enum-domain, quantized, no mirror, subgraph proxy');
  assert.equal(result.pendingNodes, 1, 'the not-built-yet node is reported separately');
  assert.equal(result.writable, 2, 'seed and the mirrored hidden state go through untouched');
  assert.equal(result.verdict, 'refuted', 'the three-state contract keeps its meaning: something must be routed elsewhere');

  const blockedIds = result.blockedItems.map(item => item.note && [item.nodeId, item.widget].join('.'));
  assert.deepEqual([result.blockedItems[0].nodeId, result.blockedItems[1].nodeId, result.blockedItems[2].nodeId], ['198', '309', '5']);
  assert.match(result.blockedItems[0].note, /连线/);
  assert.deepEqual(result.blockedItems[1].properties, ['guhai_ig_filter', 'guhai_ig_active_set'],
    'a control whose state lives in properties is named with the keys that hold it — no write channel is pretended');
  assert.match(result.blockedItems[2].note, /setValue/);
  assert.equal(blockedIds.length, 3);

  assert.equal(result.byReason['wired-input'], 1);
  assert.equal(result.byReason['properties-backed'], 1);
  assert.equal(result.byReason['dom-no-setter'], 1);
  assert.equal(result.byReason['pending-build'], 1);
  const conditionalKeys = result.conditionalItems.map(item => [item.nodeId, item.widget].join('.'));
  // The pending node rides in the same list (with no `widget`), which is why `conditional` and
  // `pendingNodes` are counted apart above.
  assert.deepEqual(conditionalKeys, ['1.mode', '1.denoise', '107.inline_media_state', '111.', '77.noise_seed']);
  assert.match(result.conditionalItems[0].note, /force:true/);
  assert.match(result.conditionalItems[1].note, /step=0\.01/);
  assert.match(result.conditionalItems[2].note, /面板/);
  assert.match(result.conditionalItems[3].note, /延迟重建|等几秒/, 'a node with no controls yet is called out as maybe-too-early');
  assert.match(result.conditionalItems[4].note, /definitions/, 'the proxy caveat is stated before the write, not only after');
  assert.ok(result.checks.some(check => check.id === 'writes-blocked' && check.verdict === 'refuted'));
  assert.ok(result.checks.some(check => check.id === 'writes-conditional' && check.verdict === 'unresolved'));

  // A canvas the plugin can fully write says so without padding, and a filtered census stays small.
  const clean = auditWrites({ page: { nodes: [node(1, 'KSampler', [flag('seed')])], workflowPath: 'p' }, defs: {} });
  assert.equal(clean.verdict, 'supported');
  assert.equal(clean.writable, 1);
  assert.equal(clean.blockedItems.length, 0);
  const scoped = auditWrites({ page, defs: {}, filter: 'ShowText' });
  assert.equal(scoped.nodeCount, 1, 'filter narrows the census to the node asked about');
});
