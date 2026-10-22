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
// Names that end in a file the user can open. `sequencecombine` is not a generic word: it is
// comfyui-AICG3D's `AICG3D_H3SequenceCombine`, verified in that pack's own source
// (h3easy/nodes.py:12289 writes into folder_paths.get_output_directory()) — the class exists only
// to be listed here because `output_node: true` cannot prove a file lands anywhere.
const OUTPUT_HINTS = /saveimage|savevideo|saveanimated|saveaudio|videocombine|sequencecombine|save_?file|apisave/i;
// Types that declare themselves output nodes and display pixels without writing a file. Each entry
// is read from its own source, not inferred from a name: `SaveImageWebsocket` returns nothing and
// pushes the image through the progress websocket (custom_nodes/websocket_image_save.py:33
// `update_absolute(step, n, ("PNG", img, None))`, `RETURN_TYPES = ()`).
// This is a deny-list on purpose. Measured against this machine's `/object_info`, SIX save-shaped
// types report an empty output list — SaveImageWithAlpha, SaveImageJPG_GH, SaveImageDataSetToFolder,
// SaveImageTextDataSetToFolder, DecodeAndSaveVideo and SaveImageWebsocket — and five of them really
// do write files, because a ComfyUI saver returns only a `ui` dict. Treating "no output slots" as
// "no file" would have traded one false positive for five false negatives.
const NOT_SAVERS = /websocket/i;
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
 *  A save-shaped type name is the only positive evidence a client can get: `output_node: true`
 *  says the server executes the node, not that it writes to the output folder. KJNodes'
 *  `ImageAndMaskPreview` subclasses `SaveImage` and redirects it to the temp directory
 *  (nodes/image_nodes.py:1480 `get_temp_directory()`), and rgthree's `RgthreeImageComparer`
 *  subclasses `PreviewImage` under a name that matches no preview pattern — both declare
 *  `output_node` with an image output, and both leave nothing for `get_image` to find.
 *  So a node that is `output_node` + media but not save-shaped and not preview-named is
 *  `uncertain`: reported, never used to answer "会落盘". Custom packs whose saver we have
 *  verified by reading their source belong in OUTPUT_HINTS, not in this third bucket; the ones
 *  verified to write nothing belong in NOT_SAVERS (see the measurement recorded there — an empty
 *  output list is NOT the test, because five genuine savers on this machine declare one). */
export function outputNodes(nodes, defs) {
  const savers = [], uncertain = [], previews = [], roots = [];
  // What the queue actually executes: every node the server marks as an output, plus the
  // file savers a pack may hide behind a name the server does not know. Bypassed (mode 4) and
  // muted (mode 2) nodes are dropped by graphToPrompt, so they cannot be an execution root.
  for (const node of nodes) {
    if (node.mode === 2 || node.mode === 4) continue;
    const entry = { nodeId: node.id, type: node.type, title: node.title };
    const declared = defs[node.type]?.output_node;
    const named = OUTPUT_HINTS.test(node.type);
    const preview = PREVIEW_HINTS.test(node.type);
    // `output_node: true` alone does not mean "writes a file": ShowText-style display nodes
    // declare it too. A candidate has to terminate in a media type — the page's slot types when
    // it has them, the server definition otherwise — before it is worth asking about.
    const slotTypes = (node.outputs || []).map(output => String(output?.type || ''));
    const defTypes = Array.isArray(defs[node.type]?.output) ? defs[node.type].output.map(String) : [];
    const media = [...slotTypes, ...defTypes].some(type => /^(video|image|audio|file|animatedimage|webp|png|gif)$/i.test(type));
    const displayOnly = NOT_SAVERS.test(node.type);
    if (preview || displayOnly) previews.push({ ...entry, source: preview ? 'preview-type' : 'display-only',
      note: displayOnly ? '通过 websocket/面板显示，不写文件' : '只在浏览器里显示，不写文件' });
    if (declared === true || named || preview) roots.push({ ...entry, source: declared === true ? 'object_info.output_node' : (named ? 'type-name-fallback' : 'preview-type') });
    if (named && declared !== false && !displayOnly) savers.push({ ...entry, source: declared === true ? 'object_info.output_node' : 'type-name-fallback' });
    else if (declared === true && media && !preview && !displayOnly) uncertain.push({ ...entry, source: 'uncertain-type', reason: 'object_info 标了 output_node 且输出是媒体类型，但类型名不含保存语义' });
  }
  return { savers, uncertain, previews, roots };
}

/** Node ids that take part in the run: the output nodes plus everything they *depend on*, walked
 *  upstream hop by hop. ComfyUI resolves required inputs through the selected output nodes, so a gap
 *  only blocks execution when it sits on such a dependency chain — and a leftover branch does not
 *  become one merely because it shares a producer with a chain that does.
 *  A link carries its origin in `outputs[].links` and its target in `inputs[].link`, so the pair
 *  recovers a DIRECTED edge from the page facts alone, without the graph's link table. Pairing the
 *  two ends as peers instead (the first version did) makes every link bidirectional: the closure then
 *  swallows each producer's other consumers, and a sibling branch that feeds nothing was reported as
 *  a missing required dependency of the save node — the blocker raised in review on #10. */
function executionReach(nodes, defs) {
  const outputs = outputNodes(nodes, defs);
  const producers = new Map();   // linkId -> node ids that list it as an output
  const upstream = new Map();    // nodeId -> node ids it consumes from
  for (const node of nodes) {
    const id = String(node.id);
    for (const output of node.outputs || []) for (const linkId of output.links || []) {
      const key = String(linkId);
      if (!producers.has(key)) producers.set(key, []);
      if (!producers.get(key).includes(id)) producers.get(key).push(id);
    }
  }
  for (const node of nodes) {
    const id = String(node.id);
    const list = upstream.get(id) || [];
    for (const input of node.inputs || []) {
      if (input.link == null) continue;
      for (const producer of producers.get(String(input.link)) || []) {
        if (producer !== id && !list.includes(producer)) list.push(producer);
      }
    }
    if (list.length) upstream.set(id, list);
  }
  const seen = new Set(outputs.roots.map(entry => String(entry.nodeId)));
  const queue = [...seen];
  while (queue.length) {
    for (const producer of upstream.get(queue.shift()) || []) {
      if (seen.has(producer)) continue;
      seen.add(producer); queue.push(producer);
    }
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
function submittedValue(serialized, truncated, nodeId, name) {
  // A value the page cut at its cap is not evidence of anything: comparing the prefix to an
  // option list refuted long-but-valid enums. The bridge names the truncated fields.
  if (Array.isArray(truncated) && truncated.includes(String(nodeId) + '.' + name)) return { known: false, truncated: true };
  const inputs = serialized?.[String(nodeId)];
  return inputs && Object.prototype.hasOwnProperty.call(inputs, name)
    ? { known: true, value: inputs[name] } : { known: false };
}

/** Widgets whose current value the server's own definition would reject.
 *  Returns definite violations (`bad`) apart from values the canvas shows but the submission
 *  cannot be judged on (`unverified`): a localized label with no serialized evidence may still
 *  convert at queue time, so it is a question, not a failure. */
export function paramViolations(nodes, defs, serialized, truncated) {
  const bad = [], unverified = [], converted = [], unknown = [], ignored = new Set();
  const cutAtCap = value => typeof value === 'string' && value.length >= 201 && value.endsWith('…');
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
      const submitted = submittedValue(serialized, truncated, node.id, widget.name);
      const truth = submitted.known ? submitted.value : value;
      const evidence = (accepted, likely) => ({
        nodeId: node.id, type: node.type, title: node.title, widget: widget.name, value: truth,
        accepted, widgetKind: widget.kind,
        ...(submitted.known ? { canvasValue: value, source: 'graphToPrompt' } : {}),
        likely
      });
      if (spec.options && cutAtCap(value) && !submitted.known) {
        unverified.push(evidence(spec.options.slice(0, 20), '画布值超过了回执的截断上限，无法与权威域比对；缩短这个值或直接看该任务实际提交的 API prompt。'));
        continue;
      }
      if (submitted.truncated) {
        unverified.push(evidence(spec.options ? spec.options.slice(0, 20) : [], '序列化后的提交值超过了回执的截断上限，无法判定；不要因为这条去改画布值。'));
        continue;
      }
      if (spec.options && !spec.options.includes(value)) {
        const accepted = spec.options.slice(0, 20);
        if (!submitted.known) {
          unverified.push(evidence(accepted, '画布显示值不在服务端权威域内，但没有序列化证据说明提交的是什么：前端可能在排队时转换（本地化枚举常见如此）。先 run 看回执，不要把画布值当 API 值改写。'));
        } else if (spec.options.includes(submitted.value)) {
          // The submitted value is legal, so the queue will accept it. The canvas string is a
          // display layer, not a value to repair: report it as information, not as an open question.
          converted.push(evidence(accepted, '画布值只是显示层；序列化后的提交值在权威域内，前端已在排队时转换，本次能正常跑。只有绕过前端直接提交 API prompt 时才会用到画布值，那时要写权威值。'));
        } else {
          // Not a definite failure: a node that declares `VALIDATE_INPUTS(**kwargs)` skips
          // ComfyUI's own combo check, so a value outside the advertised set can still queue.
          // 26 such definitions exist on this machine, 10 of them the kwargs form — refuting
          // here tells the model to repair a workflow that runs.
          unverified.push(evidence(accepted, '序列化后的提交值也不在权威枚举里，但这不足以判定会被拒绝：带 VALIDATE_INPUTS(**kwargs) 的节点会跳过 ComfyUI 的枚举校验。先 run 看该节点的回执，再决定要不要改。'));
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
  const hasPreview = outputs.previews.length > 0;
  const missingDefs = [...new Set(nodes.filter(node => !defs[node.type] && !isolated(node)).map(node => node.type))];
  const ignoredIsolated = [...new Set(nodes.filter(node => !defs[node.type] && isolated(node)).map(node => node.type))];

  const checks = [
    // The precondition for the rest: the queue is built from `graph.serialize()`, so a canvas that
    // cannot produce one is not runnable however clean its wiring looks. Pages that do not report the
    // fact are not judged for it — an old bridge is not a broken canvas.
    ...(page?.serializable === undefined ? [] : [check('graph-serializable', page.serializable ? 'supported' : 'refuted',
      '画布能否序列化', page.serializable ? [] : [{ note: 'graph.serialize() 抛错' }],
      page.serializable ? undefined
        : '当前画布无法序列化，get_workflow / audit(op=params) / run 都会失败：最常见的原因是图里留有子图代理节点、但工作流数据里没有 definitions。修法是从磁盘读该工作流的完整 JSON（含 definitions）用 load_workflow 整图替换。')]),
    check('dangling-required-input', dangling.length ? 'refuted' : 'supported', '必填输入是否全部接上', dangling,
      dangling.length ? '这些输入在产物节点的依赖链上且必填，当前没有连线；提交时 ComfyUI 会拒绝执行这条链。用 edit_graph 的 connect 接上。' : undefined),
    check('bypassed-nodes', bypassed.length ? 'unresolved' : 'supported', '是否有被静音/旁路的节点', bypassed,
      bypassed.length ? '静音/旁路可能是故意的；确认这些节点不参与本次生成再提交。' : undefined),
    check('shadowed-widgets', shadowed.length ? 'unresolved' : 'supported', '是否有控件的值被前端文档接管', shadowed,
      shadowed.length ? '这些节点上存在带 parts 的引用文档：直接写 prompt 控件可能不生效，写入后请看回执的 verified 字段。' : undefined),
    check('saver-present', outputs.savers.length ? 'supported'
      : (outputs.uncertain.length || hasPreview) ? 'unresolved' : 'refuted',
      '产物是否会落盘',
      outputs.savers.length ? outputs.savers
        : [...(outputs.uncertain.length ? outputs.uncertain : []), ...(hasPreview ? outputs.previews : [])]
          .map(item => ({ ...item, ...(item.source === 'uncertain-type' ? { note: '类型本身无法判定是否写盘' } : {}) })),
      outputs.savers.length ? undefined : outputs.uncertain.length
        ? '这些节点被服务端标成产物节点且输出媒体类型，但类型名不含保存语义，无法确认它会写进输出目录（rgthree 的对比器、KJNodes 的 ImageAndMaskPreview 都只写到 temp/浏览器）。跑一次再看 history 的 outputs 里有没有 type:"output" 的文件；要留档就接一个 SaveImage/SaveVideo。'
        : hasPreview
          ? '画布上的产物节点只负责显示（' + outputs.previews.map(node => node.type).join('、') + '）：浏览器里能看到，但 get_image 拿不到文件。要留档就接一个 SaveImage/SaveVideo。'
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

/** Capability census: which controls can this plugin actually write, and which cannot.
 *  Verdicts here mean writability, not runnability — `supported` writes land in the queue,
 *  `unresolved` writes land with a caveat (a step, a stale sibling, a blind panel), `refuted` cannot
 *  be written at all through the tool face. It exists because the alternative was a `node.properties`
 *  write channel (round 6, R6-6): a channel that writes pack-private state with nothing to validate it
 *  against is more dangerous than telling the caller up front where the value really lives. */
export function auditWrites({ page, defs = {}, filter }) {
  let nodes = page?.nodes || [];
  if (filter) {
    const needle = String(filter).toLowerCase();
    nodes = nodes.filter(node => (node.type + ' ' + (node.title || '') + ' ' + node.id).toLowerCase().includes(needle));
  }
  const blocked = [], conditional = [];
  const reasons = {};
  const count = (key, entry) => { reasons[key] = (reasons[key] || 0) + 1; return entry; };
  let controls = 0;
  for (const node of nodes) {
    const inputs = defInputs(defs[node.type] || {});
    if (!(node.widgets || []).length) {
      // A node with no controls at all is not "unwritable": `ShowText|pysssss` and friends build their
      // widget inside a `requestAnimationFrame` after `onConfigure`, so a census taken right after a load
      // can be early rather than empty (rounds 6/7, R6-4/R7-1/R7-4).
      conditional.push(count('pending-build', { nodeId: node.id, type: node.type, title: node.title || '',
        note: '此刻一个控件都没有：可能是延迟重建（等几秒或把标签切到前台再探测），也可能本来就没有可写控件' }));
      continue;
    }
    for (const widget of node.widgets || []) {
      if (widget.kind === 'button') { controls += 1; continue; }   // not a parameter, never counted
      controls += 1;
      const base = { nodeId: node.id, type: node.type, title: node.title || '', widget: widget.name, kind: widget.kind };
      if (widget.wired != null) {
        blocked.push(count('wired-input', { ...base, linkId: widget.wired,
          note: '同名输入槽上有连线：队列取连线来源的值，写这个控件改不动队列' }));
        continue;
      }
      if (widget.serializes === false && !widget.hasSetter && (widget.props || []).length) {
        blocked.push(count('properties-backed', { ...base, properties: widget.props,
          note: '控件不参与序列化，真正的状态在 node.properties 里；本插件没有写 properties 的通道，'
            + '要用该包自带的写入口，或改磁盘工作流 JSON 后 load_workflow 整图替换' }));
        continue;
      }
      if (widget.kind === 'shadowed' && !widget.hasSetter) {
        blocked.push(count('shadowed-no-channel', { ...base,
          note: '序列化里没有这个控件（serialize:false）且没有 setter：写它不进队列' }));
        continue;
      }
      if (widget.kind === 'dom' && !widget.hasSetter) {
        blocked.push(count('dom-no-setter', { ...base,
          note: '值由前端组件自持，而这个组件没有暴露 setValue：写控件回读会不一致' }));
        continue;
      }
      const authority = inputs[widget.name];
      const caveats = [];
      if (widget.inOptions === false) {
        caveats.push({ code: 'value-outside-options', text: '画布当前值不在它自己的可选项里（磁盘合法、画布非法）：改成列表内的值不用 force，'
          + '要写列表外的值需要 update_nodes 的 force:true' });
      } else if (Array.isArray(authority?.options) && typeof widget.value === 'string'
        && !authority.options.includes(widget.value)) {
        caveats.push({ code: 'value-outside-server-options', text: '画布当前值不在服务端权威枚举里（本地化显示名或由 pack 在提交时转换时会这样）：'
          + '写入请用服务端值，确认要写非法值才用 force:true' });
      }
      if (widget.step) caveats.push({ code: 'quantized', text: '数值按 step=' + widget.step + ' 就近取整：写入值会落到最近的合法刻度（回执用 quantized 说明）' });
      if (node.subgraph) caveats.push({ code: 'subgraph-proxy', text: '这是子图代理控件：写入进画布和队列，但 definitions 里那份同名槽位不会同步'
        + '（落盘文件里两份值会并存，写入回执会点名 definitionsStale）' });
      if ((widget.kind === 'hidden' || widget.kind === 'shadowed') && !widget.mirror) {
        caveats.push({ code: 'no-panel-mirror', text: '没有可见面板镜像可刷新（素材库/段落面板要用户展开才创建）：值会进队列，用户眼前的面板可能还是旧的' });
      }
      // No `value` here on purpose: the census ships flags, so a caller who wants to rewrite the value
      // reads it from `list_nodes detail=values`.
      if (caveats.length) conditional.push(count(caveats.map(item => item.code).join('+'),
        { ...base, note: caveats.map(item => item.text).join('；') }));
    }
  }
  const checks = [
    check('writes-blocked', blocked.length ? 'refuted' : 'supported', '写不了的控件', blocked,
      blocked.length ? '按 note 分类处理：wired-input 改连线另一端的节点；properties-backed / shadowed-no-channel / dom-no-setter '
        + '要使用该节点包自己的写入口，或改磁盘 JSON 后 load_workflow 整图替换。别对着同一控件反复重发。' : undefined),
    check('writes-conditional', conditional.length ? 'unresolved' : 'supported', '能写但有条件的控件', conditional,
      conditional.length ? '这些能写，但要知道条件：量化、definitions 不同步、面板不刷新、枚举域。'
        + '列表外的非法值只有传 force:true 才写得进去。' : undefined)
  ];
  const conditionalControls = conditional.filter(item => item.widget).length;
  // The census is a map, not a log: a 177-control workflow must not flood the transcript. Each list is
  // capped, and the note names only the lists that were actually cut (it used to say 「8 条只列 30」).
  const truncated = ['blocked', 'conditional']
    .map(name => ({ name, list: name === 'blocked' ? blocked : conditional }))
    .filter(item => item.list.length > 30)
    .map(item => item.name + ' 共 ' + item.list.length + ' 条，只列了前 30 条');
  const totals = { verdict: overall(checks), workflowPath: page?.workflowPath ?? null,
    serializable: page?.serializable ?? null, subgraphCount: page?.subgraphCount ?? null,
    nodeCount: nodes.length, controls, writable: controls - blocked.length - conditionalControls,
    blocked: blocked.length, conditional: conditionalControls,
    // A node with no controls is a census finding but not a control, so it is counted separately.
    pendingNodes: conditional.length - conditionalControls,
    byReason: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    blockedItems: blocked.slice(0, 30), conditionalItems: conditional.slice(0, 30),
    ...(truncated.length ? { truncated: truncated.join('；') + '：用 filter 按节点 id 或类型细看。' } : {}),
    checks };
  return totals;
}

export function auditParams({ page, defs, filter }) {
  let nodes = page?.nodes || [];
  if (filter) {
    const needle = String(filter).toLowerCase();
    nodes = nodes.filter(node => (node.type + ' ' + (node.title || '')).toLowerCase().includes(needle));
  }
  const { bad, unverified, converted, unknown, ignoredTypes } = paramViolations(nodes, defs, page?.serializedInputs, page?.serializedTruncated);
  const checks = [
    // Round 7, R7-5: this call is the one that asks the page for `graphToPrompt()`, so it is also the
    // one that learns the graph cannot be turned into a submission. Reporting that only as the reason a
    // value could not be verified let `param-values` come back `supported / count 0` on a canvas that
    // could not run at all — a green verdict on a dead tab.
    ...(page?.promptFailed === undefined ? [] : [check('prompt-serializable',
      page.promptFailed ? 'refuted' : 'supported', '画布能否生成执行用的 prompt',
      page.promptFailed ? [{ note: String(page.serializedError || 'graphToPrompt 抛错').slice(0, 200) }] : [],
      page.promptFailed ? '页面没能把当前图转成 prompt，所以这条图现在提交不出去（画布能序列化不代表能出 prompt，两者是不同的调用）。'
        + '最常见的原因是图里留有子图代理节点、而工作流数据缺少 definitions：用 load_workflow 传入磁盘文件的完整 JSON（含 definitions）整图替换，或 F5 刷新该页面。'
        : undefined)]),
    check('param-values', bad.length ? 'refuted' : 'supported', '控件值是否都在服务端权威域内', bad,
      bad.length ? '逐条给出 nodeId/widget/提交值/权威可选项。这里报的是序列化后仍不合法的值（没有序列化证据时才是画布值），可以直接按权威值改。' : undefined),
    check('param-values-unverified', unverified.length ? 'unresolved' : 'supported', '画布值与提交值是否已核对', unverified,
      unverified.length ? (page?.serializedError
        ? '页面没能序列化当前图（' + String(page.serializedError).slice(0, 120) + '），所以这些值没有提交值可比：本轮结论只能是未决，硬失败在 prompt-serializable 那条里，不要当成只是数据没查到。修复序列化（通常是某个节点自定义的 serialize/onSerialize 抛错）后重新体检。'
        : '这些画布值不在权威域内，而且没有序列化证据说明提交的是什么。先 run 看回执，不要为了让体检变绿而改值。') : undefined),
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
