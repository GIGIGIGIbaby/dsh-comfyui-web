// Two-phase canvas writes: decide what `update_nodes` can actually make stick BEFORE
// touching the canvas, and say so in a shape the model can act on.
//
// Why this exists: the page used to be the only judge, so an unwritable control came back as
// an exception ("节点不存在", "值不在可选项中") or — worse — as `verified:false` buried inside a
// success-shaped reply. A caller that fires a batch of six changes and gets one exception
// learns nothing about the other five, and a caller that gets `verified:false` tends to retry
// the same call. Both are the classic "the tool said yes, the canvas said no" failure.
//
// The rule borrowed from RunningHub's two-phase submit: if anything in the batch is provably
// unwritable, write NOTHING, and answer with `status:"needs_input"` plus one line per
// blocked change saying what to pass instead. The page keeps its own validation as a backstop
// (it holds the live widget, we hold the server's definitions); this layer only adds the
// checks the page cannot make, because they need /object_info.

import { defInputs } from './audit.js';

const kindOf = value => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
// Verdicts `force: true` is allowed to override: both are domain judgments, and the canvas can hold a
// value the tool face refuses while the file and the queue accept it (or the reverse). Type and
// resolution failures are not in this set — those are malformed requests.
const FORCIBLE = new Set(['value-not-in-server-options', 'out-of-range']);
const FALLBACK_ROUTE = '改磁盘上的工作流 JSON，再 load_workflow（workflowJson 传字符串）+ save_workflow 整图替换，这条路线不经过控件 setter。';

/** Resolve one change against the page's node list. Page-side facts only — no server call. */
function resolve(change, nodes) {
  const nodeId = String(change?.nodeId ?? '');
  const node = nodes.find(candidate => String(candidate.id) === nodeId);
  if (!node) return { code: 'node-not-found', nodeId, widget: change?.widget ?? null };
  const widget = (node.widgets || []).find(candidate => candidate.name === change.widget);
  if (!widget) return { code: 'widget-not-found', node, nodeId, widget: change?.widget ?? null };
  return { node, nodeId, widget: change.widget, fact: widget };
}

/** Compare a submitted value against the server's definition of that input.
 *  `canvasChoices` wins ties: some packs show localized labels on the canvas and convert them
 *  back at queue time, so a value the canvas itself offers is legal to write even when it is
 *  not one of the server's raw options. Blocking that would break a working path. */
function judgeValue(fact, spec, value) {
  const canvas = Array.isArray(fact?.choices) ? fact.choices : [];
  if (!spec || spec.kind === 'connect') return null;
  if (spec.kind === 'combo') {
    // An empty option list means "the server fills it at run time", not "nothing is legal".
    if (!Array.isArray(spec.options) || !spec.options.length) return null;
    if (spec.options.includes(value) || canvas.includes(value)) return null;
    return { code: 'value-not-in-server-options', accepted: spec.options.slice(0, 20) };
  }
  if (spec.kind === 'int' || spec.kind === 'float') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { code: 'wrong-type', expected: 'number', got: kindOf(value) };
    }
    const low = spec.min !== undefined ? spec.min : -Infinity;
    const high = spec.max !== undefined ? spec.max : Infinity;
    if (value < low || value > high) {
      return { code: 'out-of-range', accepted: [Number.isFinite(low) ? low : null, Number.isFinite(high) ? high : null] };
    }
    return null;
  }
  if (spec.kind === 'boolean' && typeof value !== 'boolean') {
    return { code: 'wrong-type', expected: 'boolean', got: kindOf(value) };
  }
  if (spec.kind === 'string' && typeof value !== 'string') {
    return { code: 'wrong-type', expected: 'string', got: kindOf(value) };
  }
  return null;
}

/** One blocked change, phrased as "what to send next" rather than "what went wrong". */
function blockedEntry(entry, verdict) {
  const node = entry.node;
  const target = entry.nodeId + '.' + (entry.widget ?? '?');
  const head = node ? target + '（' + (node.type || '?') + '）' : '节点 ' + entry.nodeId + ' 上的 ' + JSON.stringify(entry.widget ?? null);
  const current = entry.fact ? '当前画布值是 ' + JSON.stringify(entry.fact.value ?? null) + '。' : '';

  if (verdict.code === 'node-not-found') {
    return { target, nodeId: entry.nodeId, widget: entry.widget, code: verdict.code,
      reason: target + ' 不在当前画布上。',
      nextSteps: '先用 list_nodes（可带 filter）取真实 nodeId：id 是页面级的，刷新或换标签页就变了，不要复用上一次调用里的 id。' };
  }
  if (verdict.code === 'widget-not-found') {
    // A node with no controls at all is a different answer from a wrong name, and the MCP path is the one
    // callers actually read: the page-side hint (round 6, R6-4) never got here, so the two-phase plan
    // answered 「可写控件名是 []」 — which reads as "this node cannot be written" for a node whose widget
    // is only built a `requestAnimationFrame` after `onConfigure` (rounds 6/7, R6-4/R7-1).
    if (verdict.code === 'widget-not-found' && node && !(node.widgets || []).length) {
      return { target, nodeId: entry.nodeId, widget: entry.widget, code: 'widgets-not-built',
        reason: head + ' 此刻一个控件都没有。',
        accepted: [],
        nextSteps: '两种原因：(1) 这个包的控件是 onConfigure 之后用 requestAnimationFrame 才建出来的（ShowText|pysssss 本机实测约 3.5 秒），'
          + '先 list_nodes（带 filter 看这个节点）确认它已有控件，再等几秒重发同一条写入；(2) 它本来就没有可写控件（注释/显示类，值由上游在运行时填）——'
          + '等过一次仍然为空就按 (2) 处理，换真正的目标节点，别改控件名去猜。' };
    }
    const all = (node?.widgets || []).map(item => item.name);
    return { target, nodeId: entry.nodeId, widget: entry.widget, code: verdict.code,
      reason: target + ' 不存在。',
      accepted: all,
      nextSteps: '节点 ' + entry.nodeId + '（' + (node?.type || '?') + '）的控件名是 [' + all.join(', ') + ']，用其中之一；'
        + '要找的是按钮类控件的话，它不在这个列表里（按钮不是参数，用 run / save_workflow 这类动作）。' };
  }
  if (verdict.code === 'value-not-in-server-options') {
    const canvas = Array.isArray(entry.fact?.choices) ? entry.fact.choices.slice(0, 12) : [];
    return { target, nodeId: entry.nodeId, widget: entry.widget, code: verdict.code,
      reason: target + '：服务端权威可选项里没有 ' + JSON.stringify(verdict.value ?? null) + '，' + current,
      accepted: verdict.accepted,
      ...(canvas.length ? { canvasChoices: canvas } : {}),
      nextSteps: '传 accepted 里的原文；若画布显示的是本地化名而服务端要键名/文件名，说明该 pack 在提交时转换，直接写服务端值更稳。仍不行就走整图路线：' + FALLBACK_ROUTE };
  }
  if (verdict.code === 'out-of-range' || verdict.code === 'wrong-type') {
    return { target, nodeId: entry.nodeId, widget: entry.widget, code: verdict.code,
      reason: target + '：' + (verdict.got ? '这个控件要 ' + verdict.expected + '，收到 ' + verdict.got + '。' : '提交值超出服务端允许范围。') + current,
      ...(verdict.accepted !== undefined ? { accepted: verdict.accepted } : {}),
      nextSteps: verdict.code === 'wrong-type'
        ? '按 ' + verdict.expected + ' 传裸值（数字不要加引号，布尔用 true/false 而不是 0/1 或字符串）。'
        : '把值收进 accepted 范围再提交；范围来自 /object_info 的节点定义，不是页面猜的。' };
  }
  return { target, nodeId: entry.nodeId, widget: entry.widget, code: verdict.code, reason: target + ' 无法写入。', nextSteps: FALLBACK_ROUTE };
}

/** Decide, without touching the canvas, whether this batch can be written at all.
 *  `nodes` = the page's list_nodes payload; `defs` = raw /object_info entries by class type. */
export function planWrites({ changes, nodes = [], defs = {}, force = false }) {
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length) {
    return { status: 'needs_input', blocked: [], planned: [],
      summary: 'needs_input: changes 为空，没有要写的项（画布未改动）。',
      nextSteps: '传 changes:[{nodeId, widget, value}, …]；nodeId 与控件名先用 list_nodes 取。' };
  }
  // No node list means we cannot judge anything — an empty canvas and an unreadable one look
  // the same from here. Refusing would turn "I could not see" into "you are wrong", so hand the
  // decision back to the page, which always has the live widget.
  if (!Array.isArray(nodes) || !nodes.length) return { status: 'unknown', planned: [], blocked: [], changes: list };
  const blocked = [], planned = [];
  for (const change of list) {
    const entry = resolve(change, nodes);
    if (entry.code) { blocked.push(blockedEntry(entry, { code: entry.code })); continue; }
    const spec = defInputs(defs[entry.node.type])[entry.widget];
    const verdict = judgeValue(entry.fact, spec, change.value);
    // `force` relaxes the domain judgments only — the server's option list and the declared range —
    // because a workflow can legitimately hold a value the canvas no longer offers (R6-7: a disk-legal
    // `control_after_generate = "default"` had no way back except a whole-graph reload). A wrong JSON
    // type stays blocked: that is a malformed request, not an unfriendly enum.
    if (verdict && !(force && FORCIBLE.has(verdict.code))) { blocked.push(blockedEntry(entry, { ...verdict, value: change.value })); continue; }
    const kind = entry.fact.kind || 'plain';
    planned.push({ nodeId: entry.nodeId, widget: entry.widget, value: change.value,
      widgetKind: kind, risk: kind === 'plain' ? 'low' : 'high', ...(force && verdict ? { forced: verdict.code } : {}) });
  }
  if (blocked.length) {
    const lines = blocked.map(item => '  - ' + item.target + ': ' + item.reason);
    return {
      status: 'needs_input', blocked, planned,
      note: '整批未写入，画布没有被修改（two-phase：先判定再落笔）。',
      summary: 'needs_input: update_nodes 的 ' + blocked.length + '/' + list.length + ' 项改动无法用工具写成（画布未改动）。\n'
        + 'blocked:\n' + lines.join('\n')
        + '\n收集正确的值后重发整批；每行都给了下一条可执行的路。'
    };
  }
  return { status: 'ready', planned, blocked: [] };
}

/** Post-write envelope: never let an unverified change read like a success.
 *  A batch where half the changes verified is `partial`, not `written`. */
export function writeEnvelope(result, changes = []) {
  const changed = Array.isArray(result?.changed) ? result.changed : [];
  // What the caller asked for, keyed by the same target the page answers with. The page reply
  // only carries what it read back, so without this the "requested vs readBack" pair — the whole
  // point of the envelope — would show the readback twice.
  const asked = changes.map(change => ({ key: String(change?.nodeId ?? '') + '\u0000' + (change?.widget ?? ''), value: change?.value }));
  const unverified = changed.filter(item => !item.verified);
  // The page reports *how* it wrote (`via`), not the widget kind: dom-setter / hidden /
  // shadowed are the ones whose state a frontend component owns, so those are the writes
  // that can look successful while the canvas keeps the old value.
  const frontendOwned = changed.filter(item => ['dom-setter', 'dom', 'hidden', 'shadowed'].includes(item.via));
  const envelope = {
    status: unverified.length ? (changed.length > unverified.length ? 'partial' : 'needs_input') : 'written',
    // The refusal path answers written:false, so the success path has to answer written:true —
    // otherwise a caller cannot branch on one key and has to read status strings.
    written: unverified.length === 0,
    changed
  };
  if (unverified.length) {
    envelope.unverified = unverified.map(item => ({
      nodeId: item.nodeId, widget: item.widget,
      ...(item.requestedWidget ? { requestedWidget: item.requestedWidget } : {}),
      requested: asked.find(entry => entry.key === String(item.nodeId) + '\u0000' + (item.requestedWidget ?? item.widget))?.value ?? null,
      readBack: item.after, via: item.via,
      reason: '写入已发出，但画布回读（readBack）与提交值不一致：该控件的状态由前端组件自己持有。',
      alternatives: [
        '写它的 shadow 源 node.properties（update_nodes 已尝试清除，仍失败说明文档格式还有额外约束）',
        '用该节点包自带的写入入口（AICG3D 的 globalThis.AICG3D_H3.setPromptText(node, value, {notifyGraphChange:false, preserveNodeSize:true}) 就是实例）',
        '改磁盘工作流 JSON → load_workflow（workflowJson 传字符串）→ save_workflow 整图替换'
      ],
      ...(item.hint ? { hint: item.hint } : {})
    }));
    envelope.summary = 'needs_input: ' + unverified.length + '/' + changed.length + ' 项没有真正写进画布（verified:false）。'
      + '已验证的项保留；未验证的项按 unverified[].alternatives 换路，不要重发同一调用。'
      + (result?.warning ? ' 页面侧说明：' + result.warning : '');
  }
  if (result?.warning && !envelope.summary) envelope.warning = result.warning;
  if (result?.nextSteps) envelope.nextSteps = result.nextSteps;
  // Third-round report N9: the page's settle evidence existed only in the raw page reply, so the
  // MCP envelope dropped it and every `settledMs`/`lateChange` assertion in the suite was reading
  // the page result instead of what the caller sees. The settle is part of the answer, not a detail.
  if (result?.settledMs !== undefined) envelope.settledMs = result.settledMs;
  if (Array.isArray(result?.ambiguousTargets) && result.ambiguousTargets.length) envelope.ambiguousTargets = result.ambiguousTargets;
  if (Array.isArray(result?.revertedWrites) && result.revertedWrites.length) envelope.revertedWrites = result.revertedWrites;
  if (Array.isArray(result?.wiredInputs) && result.wiredInputs.length) envelope.wiredInputs = result.wiredInputs;
  // Round 5 (R5-D) named the missing dimension: 「写进去了」 and 「用户看得见」 are different facts. The
  // page now answers both — `panels` for the visible mirror, `dirtyMarked` for the tab's own 「未保存」
  // badge — and an envelope that dropped them left the caller guessing from `verified` alone.
  if (result?.panels) envelope.panels = result.panels;
  if (result?.dirtyMarked !== undefined) {
    envelope.dirtyMarked = result.dirtyMarked;
    if (result.dirtyNote) envelope.dirtyNote = result.dirtyNote;
  }
  // Round 8 (live run): the page answered with these three and the envelope dropped them, so a caller
  // that force-wrote an out-of-range value could not tell from the structured reply whether force was
  // actually used, and a subgraph-proxy write lost the `definitionsStale` fork it had been warned about.
  // The prose survived (it rides in `warning`/`summary`); the machine-readable proof did not.
  if (result?.forceUsed) {
    envelope.forceUsed = true;
    if (typeof result.forcedCount === 'number') envelope.forcedCount = result.forcedCount;
  }
  if (Array.isArray(result?.definitionsStale) && result.definitionsStale.length) {
    envelope.definitionsStale = result.definitionsStale;
  }
  // The page waited out the front-end debounce and diffed the nodes wired below the ones we
  // touched. Reporting that separately is the difference between "node 195 changed" and
  // "node 195 changed and the pack rewrote 107/108/109 behind you".
  if (Array.isArray(result?.cascaded) && result.cascaded.length) {
    envelope.cascaded = result.cascaded;
    envelope.cascadedNote = result.cascadedNote
      ?? ('下游节点被联动改写了 ' + result.cascaded.length + ' 处，不在本批 changes 里：这是节点包自己的 autofill 行为，写回去或改用整图替换。');
  }
  if (Array.isArray(result?.lateChange) && result.lateChange.length) {
    envelope.lateChange = result.lateChange;
    const overwritten = result.lateChange.filter(item => item.now === 'overwritten');
    if (overwritten.length) {
      envelope.status = 'partial';
      envelope.written = false;
      envelope.summary = (envelope.summary ? envelope.summary + ' ' : '')
        + overwritten.length + ' 项在 ' + (result.settledMs ?? 600) + 'ms 后被前端防抖改写回去了（lateChange.now=overwritten）：先等一次读回稳定再改，或改用该包自带的写入入口。';
    }
  }
  if (frontendOwned.length) {
    envelope.note = '其中 ' + frontendOwned.length + ' 项是前端自持控件（via=' + [...new Set(frontendOwned.map(item => item.via))].join('/') + '）：只有 verified:true 才算写进去了。';
  }
  return envelope;
}
