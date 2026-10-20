// Judgment family: turn "the canvas looks fine" into a verdict the model can act on.
//
// Everything here is pure: the page supplies facts (bridge.js `audit_graph`), the plugin
// supplies the authoritative node definitions (`/object_info/<type>`), and this module
// answers "can this graph run, and are its values actually valid?" with three states —
// supported / refuted / unresolved — plus the evidence behind each.
//
// The param check exists because of a real failure: some packs replace a combo's
// `options.values` with localized display strings and convert them back at queue time, so
// the value on the canvas is NOT one of the server's authoritative options. That is legal
// until the front-end stops converting — the model needs to be told, not to guess.

const WIDGET_KINDS = new Set(['int', 'float', 'string', 'boolean', 'combo']);
const OUTPUT_HINTS = /saveimage|savevideo|saveanimated|saveaudio|videocombine|save_?file|apisave/i;
const PREVIEW_HINTS = /previewimage|previewaudio|videopreview|previewany|preview3d/i;

/** Normalize an /object_info class definition into { name: {kind, options, min, max, type} }.
 *  Inputs live under `def.input`, not at the top level: reading the wrong layer leaves the
 *  map empty, and an empty map makes every value check pass without looking at anything. */
export function defInputs(def) {
  const inputs = {};
  for (const group of ['required', 'optional']) {
    for (const [name, spec] of Object.entries(def?.input?.[group] || {})) {
      const tuple = Array.isArray(spec) ? spec : [spec];
      const first = tuple[0];
      const rest = (tuple[1] && typeof tuple[1] === 'object' && !Array.isArray(tuple[1])) ? tuple[1] : {};
      // Option lists arrive three ways: as the first element (classic combo), as `options`
      // (io.Combo, and V3 dynamic combos whose entries are { key, inputs }), or as `values`.
      // An empty list still means a widget — the server just fills it at run time — so it
      // must not be read as "no accepted values", which would flag every value on the canvas.
      const lists = [first, rest.options, rest.values].filter(Array.isArray);
      const isCombo = lists.length > 0;
      const entries = lists.flat();
      const options = isCombo && entries.length
        ? entries.map(entry => (entry && typeof entry === 'object' ? entry.key : entry)) : null;
      const label = isCombo ? 'COMBO' : typeof first === 'string' ? first : '';
      inputs[name] = {
        group,
        kind: isCombo ? 'combo'
          : (WIDGET_KINDS.has(String(label).toLowerCase()) ? String(label).toLowerCase() : 'connect'),
        ...(options ? { options } : {}),
        ...(typeof rest.min === 'number' ? { min: rest.min } : {}),
        ...(typeof rest.max === 'number' ? { max: rest.max } : {}),
        ...(rest.multiline !== undefined ? { multiline: rest.multiline } : {}),
        ...(!isCombo && label ? { type: label } : {}),
        hidden: rest.hidden === true
      };
    }
  }
  return inputs;
}

const check = (id, verdict, title, evidence = [], hint) => ({ id, verdict, title, count: evidence.length, evidence: evidence.slice(0, 25), ...(hint ? { hint } : {}) });
const overall = checks => checks.some(c => c.verdict === 'refuted') ? 'refuted'
  : checks.some(c => c.verdict === 'unresolved') ? 'unresolved' : 'supported';
// A node with nothing wired in AND nothing wired out cannot take part in the run at all,
// so a missing definition for it (Markdown notes, labels, isolated leftovers) is
// information rather than an open question. Requiring both sides keeps a saver from an
// unloaded pack — which does have inputs — from being silently excused.
const isolated = node => !(node.outputs || []).some(output => (output.links || []).length)
  && !(node.inputs || []).some(input => input.link != null);

/** Which nodes actually put a file on disk, and which only preview in the browser.
 *  The server's own `output_node` flag is the authority: a custom pack can name its saver
 *  anything (comfyui-AICG3D ships `AICG3D_H3SequenceCombine`, which matches no "save" pattern),
 *  so a name regex alone reported "结果不落盘" on a graph that does write files. The regex
 *  survives only as a fallback for types the server does not know (pure front-end nodes) and
 *  for definitions that predate the flag. Preview nodes claim `output_node: true` as well, so
 *  they are classified first — otherwise every preview would read as a saver. */
export function outputNodes(nodes, defs) {
  const savers = [], previews = [];
  for (const node of nodes) {
    if (node.mode === 2) continue;                                        // muted on purpose
    const entry = { nodeId: node.id, type: node.type, title: node.title };
    if (PREVIEW_HINTS.test(node.type)) { previews.push({ ...entry, source: 'preview-type' }); continue; }
    const declared = defs[node.type]?.output_node;
    // An explicit `false` from the server outranks the name: trust the definition, not the label.
    const source = declared === true ? 'object_info.output_node'
      : declared === false ? null
      : OUTPUT_HINTS.test(node.type) ? 'type-name-fallback' : null;
    if (source) savers.push({ ...entry, source });
  }
  return { savers, previews };
}

/** Node ids that take part in the run: the output nodes plus everything joined to them by a
 *  wire, however many hops away. ComfyUI resolves required inputs through the selected output
 *  nodes, so an unwired leftover branch is not necessarily an execution error — only a gap on
 *  this set is. A link id is all both ends of a wire carry (the origin lists it in
 *  `outputs[].links`, the target in `inputs[].link`), so pairing by id recovers the edge from
 *  the page facts alone, without the graph's link table. */
function executionReach(nodes, defs) {
  const outputs = outputNodes(nodes, defs);
  const ends = new Map();
  const attach = (linkId, nodeId) => {
    if (linkId == null) return;
    const key = String(linkId);
    const list = ends.get(key) || [];
    if (!list.includes(nodeId)) list.push(nodeId);
    ends.set(key, list);
  };
  for (const node of nodes) {
    const id = String(node.id);
    for (const input of node.inputs || []) attach(input.link, id);
    for (const output of node.outputs || []) for (const linkId of output.links || []) attach(linkId, id);
  }
  const peers = new Map();
  for (const list of ends.values()) {
    for (const id of list) {
      if (!peers.has(id)) peers.set(id, new Set());
      for (const other of list) if (other !== id) peers.get(id).add(other);
    }
  }
  const roots = [...outputs.savers, ...outputs.previews].map(entry => String(entry.nodeId));
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    for (const peer of peers.get(queue.shift()) || []) if (!seen.has(peer)) { seen.add(peer); queue.push(peer); }
  }
  return seen;
}

/** Required connectable inputs with nothing wired into them. */
function danglingInputs(nodes, defs) {
  const found = [];
  for (const node of nodes) {
    if (node.mode === 2 || node.mode === 4) continue;                     // muted / bypassed on purpose
    const def = defs[node.type];
    if (!def) continue;
    const inputs = defInputs(def);
    for (const slot of node.inputs || []) {
      const spec = inputs[slot.name];
      if (!spec || spec.group !== 'required' || spec.kind !== 'connect' || slot.link != null) continue;
      found.push({ nodeId: node.id, type: node.type, title: node.title, input: slot.name, needs: spec.type });
    }
  }
  return found;
}

/** The value the page would actually submit for one widget, when graphToPrompt() succeeded.
 *  That serialization runs the front-end's own conversion, so its value is the truth and the
 *  canvas value is only a display label. No entry means no evidence — not "same as canvas". */
function submittedValue(serialized, nodeId, name) {
  const inputs = serialized?.[String(nodeId)];
  return inputs && Object.prototype.hasOwnProperty.call(inputs, name)
    ? { known: true, value: inputs[name] } : { known: false };
}

/** Widgets whose current value the server's own definition would reject.
 *  Returns definite violations (`bad`) apart from values the canvas shows but the submission
 *  cannot be judged on (`unverified`): a localized label with no serialized evidence may still
 *  convert at queue time, so it is a question, not a failure. */
export function paramViolations(nodes, defs, serialized) {
  const bad = [], unverified = [], converted = [], unknown = [], ignored = new Set();
  for (const node of nodes) {
    const def = defs[node.type];
    if (!def) {
      if (isolated(node)) ignored.add(node.type);
      else unknown.push({ nodeId: node.id, type: node.type, title: node.title, reason: 'object_info 里没有该类型' });
      continue;
    }
    const inputs = defInputs(def);
    for (const widget of node.widgets || []) {
      const spec = inputs[widget.name];
      if (!spec || spec.kind === 'connect') continue;
      const value = widget.value;
      if (value === null || value === undefined) continue;
      const submitted = submittedValue(serialized, node.id, widget.name);
      const truth = submitted.known ? submitted.value : value;
      const evidence = (accepted, likely) => ({
        nodeId: node.id, type: node.type, title: node.title, widget: widget.name, value: truth,
        accepted, widgetKind: widget.kind,
        ...(submitted.known ? { canvasValue: value, source: 'graphToPrompt' } : {}),
        likely
      });
      if (spec.options && !spec.options.includes(value)) {
        const accepted = spec.options.slice(0, 20);
        if (!submitted.known) {
          unverified.push(evidence(accepted, '画布显示值不在服务端权威域内，但没有序列化证据说明提交的是什么：前端可能在排队时转换（本地化枚举常见如此）。先 run 看回执，不要把画布值当 API 值改写。'));
        } else if (spec.options.includes(submitted.value)) {
          // The submitted value is legal, so the queue will accept it. The canvas string is a
          // display layer, not a value to repair: report it as information, not as an open question.
          converted.push(evidence(accepted, '画布值只是显示层；序列化后的提交值在权威域内，前端已在排队时转换，本次能正常跑。只有绕过前端直接提交 API prompt 时才会用到画布值，那时要写权威值。'));
        } else {
          bad.push(evidence(accepted, '序列化后的提交值也不在服务端权威域内（前端没有转换它），提交会被拒绝。'));
        }
      } else if (typeof truth === 'number' && ((spec.min != null && truth < spec.min) || (spec.max != null && truth > spec.max))) {
        bad.push(evidence([spec.min ?? null, spec.max ?? null],
          submitted.known ? '序列化后的提交值超出服务端允许范围' : '超出服务端允许范围'));
      }
    }
  }
  return { bad, unverified, converted, unknown, ignoredTypes: [...ignored] };
}

export function auditGraph({ page, defs }) {
  const nodes = page?.nodes || [];
  // A missing wire only blocks when the node is on the way to an output node. Unreachable
  // leftovers are reported as advice: they are not part of what the submission executes.
  const reachable = executionReach(nodes, defs);
  const unwired = danglingInputs(nodes, defs);
  const dangling = unwired.filter(item => reachable.has(String(item.nodeId)));
  const unusedIncomplete = unwired.filter(item => !reachable.has(String(item.nodeId)));
  const bypassed = nodes.filter(node => node.mode === 2 || node.mode === 4)
    .map(node => ({ nodeId: node.id, type: node.type, title: node.title, mode: node.mode, meaning: node.mode === 2 ? 'muted' : 'bypass' }));
  const shadowed = nodes.filter(node => (node.shadowDocs || []).length)
    .map(node => ({ nodeId: node.id, type: node.type, title: node.title, shadowDocs: node.shadowDocs,
      hiddenPrompt: (node.widgets || []).some(widget => widget.kind === 'hidden' || widget.kind === 'shadowed') }));
  const outputs = outputNodes(nodes, defs);
  const hasSaver = outputs.savers.length > 0;
  const hasPreview = outputs.previews.length > 0;
  const missingDefs = [...new Set(nodes.filter(node => !defs[node.type] && !isolated(node)).map(node => node.type))];
  const ignoredIsolated = [...new Set(nodes.filter(node => !defs[node.type] && isolated(node)).map(node => node.type))];

  const checks = [
    check('dangling-required-input', dangling.length ? 'refuted' : 'supported', '必填输入是否全部接上', dangling,
      dangling.length ? '这些输入在产物节点的依赖链上且必填，当前没有连线；提交时 ComfyUI 会拒绝执行这条链。用 edit_graph 的 connect 接上。' : undefined),
    check('bypassed-nodes', bypassed.length ? 'unresolved' : 'supported', '是否有被静音/旁路的节点', bypassed,
      bypassed.length ? '静音/旁路可能是故意的；确认这些节点不参与本次生成再提交。' : undefined),
    check('shadowed-widgets', shadowed.length ? 'unresolved' : 'supported', '是否有控件的值被前端文档接管', shadowed,
      shadowed.length ? '这些节点上存在带 parts 的引用文档：直接写 prompt 控件可能不生效，写入后请看回执的 verified 字段。' : undefined),
    check('saver-present', hasSaver ? 'supported' : (hasPreview ? 'unresolved' : 'refuted'), '产物是否会落盘',
      hasSaver ? outputs.savers : [{ note: hasPreview ? '只有预览节点，结果不落盘' : '既没有保存节点也没有预览节点',
        ...(hasPreview ? { previews: outputs.previews } : {}) }],
      hasSaver ? undefined : hasPreview
        ? '画布上只有预览节点（' + outputs.previews.map(node => node.type).join('、') + '）：浏览器里能看到，但 get_image 拿不到文件。要留档就接一个 SaveImage/SaveVideo。'
        : '画布上没有任何产物节点（object_info 里 output_node=true 的节点）。接一个 SaveImage/SaveVideo 再接 run，否则跑完没有文件。'),
    check('definitions-known', missingDefs.length ? 'unresolved' : 'supported', '节点类型是否都能查到权威定义',
      missingDefs.map(type => ({ type })),
      missingDefs.length ? '这些类型在 /object_info 里查不到：要么 pack 没加载或被禁用，要么是纯前端定义的节点'
        + '（注释类、Use Everywhere 的 SetNode/GetNode），后者的参数本来就不由服务端校验，写入仍可按控件名进行。' : undefined)
  ];
  // workflowPath travels with the verdict: the doctor's "is this graph saved" check reads it,
  // and leaving it out made that check fail forever on a perfectly saved graph.
  return { verdict: overall(checks), nodeCount: nodes.length, linkCount: page?.linkCount ?? null,
    workflowPath: page?.workflowPath ?? null,
    ...(unusedIncomplete.length ? { unusedIncomplete: { nodes: unusedIncomplete,
      note: '这些节点不在任何产物节点（output_node=true）的依赖链上，不参与本次运行；必填输入缺线只是画布上的半成品，不影响提交。要跑它们时再接线。' } } : {}),
    ...(ignoredIsolated.length ? { ignoredIsolatedTypes: { types: ignoredIsolated,
      note: '这些类型没有服务端定义，但输入输出都没接线（注释、标签类），不参与本次运行，故不计入未决项。' } } : {}),
    checks };
}

export function auditParams({ page, defs, filter }) {
  let nodes = page?.nodes || [];
  if (filter) {
    const needle = String(filter).toLowerCase();
    nodes = nodes.filter(node => (node.type + ' ' + (node.title || '')).toLowerCase().includes(needle));
  }
  const { bad, unverified, converted, unknown, ignoredTypes } = paramViolations(nodes, defs, page?.serializedInputs);
  const checks = [
    check('param-values', bad.length ? 'refuted' : 'supported', '控件值是否都在服务端权威域内', bad,
      bad.length ? '逐条给出 nodeId/widget/提交值/权威可选项。这里报的是序列化后仍不合法的值（没有序列化证据时才是画布值），可以直接按权威值改。' : undefined),
    check('param-values-unverified', unverified.length ? 'unresolved' : 'supported', '画布值与提交值是否已核对', unverified,
      unverified.length ? '这些画布值不在权威域内，而且没有序列化证据说明提交的是什么。先 run 看回执，不要为了让体检变绿而改值。' : undefined),
    check('uncheckable', unknown.length ? 'unresolved' : 'supported', '无法校验的节点', unknown)
  ];
  return { verdict: overall(checks), checkedNodes: nodes.length,
    // The queue will accept these: the front-end converts the canvas label into an authoritative
    // value at submit time. Informational, never a reason to repair a runnable workflow.
    ...(converted.length ? { convertedValues: { count: converted.length, evidence: converted.slice(0, 20),
      note: '这些画布值是显示层，序列化后的提交值合法；不要为了让体检更好看而改画布值。' } } : {}),
    ...(ignoredTypes.length ? { ignoredUncheckable: { types: ignoredTypes, note: '这些类型没有服务端定义，但输出未被任何节点使用（注释/标签类），不影响本次运行。' } } : {}),
    checks };
}

/** Compact model-facing envelope: verdict first, evidence after, never the whole graph. */
export function auditReply(body) {
  const text = JSON.stringify(body);
  return { content: [{ type: 'text', text }], structuredContent: body };
}
