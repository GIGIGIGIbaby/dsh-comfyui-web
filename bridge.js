(() => {
  'use strict';
  if (window.__DSH_COMFYUI_BRIDGE_ACTIVE__) return;
  window.__DSH_COMFYUI_BRIDGE_ACTIVE__ = true;
  const bridgeProtocol = 6;
  // The host knows its own version; a literal here drifts the moment the package is
  // re-versioned locally, and `doctor` would then blame the page for a bookkeeping gap. The
  // served path substitutes the single occurrence below; the extension path reads it from
  // bootstrap. A copy that went through neither reports `null`: a version check that compares the
  // placeholder against a package version is permanently red, and the cure it offered ("刷新页面")
  // cannot fix an injection that never happened.
  const bootstrap = window.__DSH_COMFYUI_BOOTSTRAP__ || {};
  const versionLiteral = '__DSH_BRIDGE_VERSION__';
  const bridgeVersion = bootstrap.bridgeVersion
    || (versionLiteral === '__DSH_BRIDGE_' + 'VERSION__' ? null : versionLiteral);
  let token = bootstrap.token || __DSH_BRIDGE_TOKEN__;
  const bridgeBase = bootstrap.bridgeBase || location.origin;
  const query = new URLSearchParams(location.search);
  const embedded = !!(query.get('dsh_client') && query.get('dsh_session') && window.parent !== window);
  let warnedWeakUUID = false;
  const warnWeakUUID = reason => {
    if (warnedWeakUUID) return;
    warnedWeakUUID = true;
    console.warn('[dsh-comfyui-bridge] Falling back to Math.random UUID generation:', reason);
  };
  const randomHex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  const randomUUID = () => {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    let bytes;
    try {
      if (typeof globalThis.crypto?.getRandomValues === 'function') {
        bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      }
    } catch (error) { warnWeakUUID(error?.message || 'crypto.getRandomValues failed'); }
    if (!bytes && !warnedWeakUUID) warnWeakUUID('Web Crypto is unavailable');
    const hex = bytes ? [...bytes].map(b => b.toString(16).padStart(2, '0')) : Array.from({ length: 16 }, randomHex);
    hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0');
    hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
    return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
  };
  const clientId = embedded ? query.get('dsh_client') : randomUUID();
  const sessionId = embedded ? query.get('dsh_session') : 'comfyui-external';
  let parentOrigin;
  if (embedded) { try { parentOrigin = new URL(document.referrer).origin; } catch { return; } }
  let allowAI = embedded; let visible = true; let busy = false;
  let revision = 0; let lastFingerprint; let initialized = false; let syncPath;
  let localAuthority = true, editSequence = 0, acknowledgedEditSequence = 0, applyingRemote = false;
  const synchronization = { loaded: 0, published: 0, deferred: 0, conflicts: 0 };
  let pointerHeld = false;
  const heldKeys = new Set();
  function manualEditing() {
    if (document.visibilityState === 'hidden' || document.hasFocus?.() === false) return false;
    return pointerHeld || heldKeys.size > 0 || !!document.activeElement?.matches?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  }
  const histories = new Map(); const completed = new Map();
  // Every checkpoint stores a whole serialized graph, so an unbounded history is what slowly
  // eats the localStorage ComfyUI also keeps its drafts in. These two numbers are the budget the
  // bridge enforces on itself; when it trims, the reply says so instead of failing the write.
  const HISTORY_BUDGET = 1_500_000;
  const HISTORY_MAX = 20;
  const CONFLICT_KEY = 'dsh.comfyui.sync-conflict';
  const CONFLICT_BUDGET = 2_000_000;
  const commandQueue = []; let handlingCommands = false, commandStream, reconnectTimer;
  // How many commands this page has had to write off as unreturnable. Reported with the heartbeat so a
  // stuck pack setter is visible from the server side instead of only felt as a timeout (R7-7).
  let stalledCommands = 0;
  const appOf = () => window.comfyAPI?.app?.app;
  const apiOf = () => window.comfyAPI?.api?.api;
  const activeWorkflowOf = app => {
    const workflow = app?.extensionManager?.workflow?.activeWorkflow;
    return workflow && typeof workflow === 'object' ? workflow : null;
  };
  const rootGraphOf = app => app?.rootGraph || app?.graph;
  function graphReady(app) {
    return !!(rootGraphOf(app) && app.canvas && !app.configuringGraph &&
      !window.comfyAPI?.changeTracker?.ChangeTracker?.isLoadingGraph &&
      activeWorkflowOf(app));
  }
  function diagnostics() {
    const app = appOf();
    const tabs = app?.extensionManager?.workflow?.openWorkflows;
    return { bridgeProtocol, bridgeVersion, ready: graphReady(app), allowAI,
      visible: visible && document.visibilityState !== 'hidden',
      hasActiveWorkflow: !!activeWorkflowOf(app), workflowTabs: Array.isArray(tabs) ? tabs.length : null,
      stalledCommands, synchronization: { ...synchronization } };
  }
  const notify = data => { if (embedded) window.parent.postMessage({ source: 'dsh-comfyui', clientId, ...data }, parentOrigin); };
  window.addEventListener('message', event => {
    if (!embedded || event.source !== window.parent || event.origin !== parentOrigin || event.data?.source !== 'dsh-comfyui-parent' || event.data.clientId !== clientId) return;
    const changed = allowAI !== (event.data.allowAI === true) || visible !== (event.data.visible === true);
    allowAI = event.data.allowAI === true; visible = event.data.visible === true;
    if (changed) send('state', {}).catch(() => {});
  });
  const send = async (path, data) => {
    const r = await fetch(bridgeBase + '/__dsh_comfyui/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify({ clientId, sessionId, ...diagnostics(), ...data }) });
    if (r.status === 403) {
      const next = await (await fetch(bridgeBase + '/__dsh_comfyui/bootstrap')).json();
      token = next.token; revision = 0; initialized = false;
      throw new Error('正在重新连接 ComfyUI 桥接');
    }
    if (!r.ok) throw new Error(await r.text()); return r.json();
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  function snapshot(app) { return clone(rootGraphOf(app).serialize()); }
  function fingerprint(workflow) {
    const clean = clone(workflow);
    // Each browser owns its workflow identity and local revision. Sharing them
    // makes native loaders normalize the graph differently on every page.
    delete clean.id; delete clean.revision;
    if (clean.extra) delete clean.extra.ds;
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify(stable(clean));
  }
  // `graph.serialize()` on a canvas that holds subgraph proxies without their definitions dies with a
  // litegraph internals sentence ("Attempted to access LGraph reference that was null or undefined") that
  // reads like a dead bridge. Say what broke and what fixes it (fourth-round R4-E aftermath).
  function readGraph(app) {
    try { return snapshot(app); }
    catch (error) {
      throw new Error('当前画布无法序列化（' + ((error && error.message) || error) + '）。常见原因是图里留有子图代理节点、但工作流数据里没有 definitions——这种状态下 get_workflow、audit(op=params)、run 都用不了，而体检看不出问题。修法：用 load_workflow 传入该工作流磁盘文件的完整 JSON（包含 definitions）整图替换。',
        { cause: error });
    }
  }
  // True when the canvas can still be serialized — the single check that separates a working tab from
  // one whose subgraph definitions went missing. Never call `graphToPrompt` for it: packs that patch
  // serialization would take a side effect from what is supposed to be a listing.
  function canSerialize(app) { try { rootGraphOf(app).serialize(); return true; } catch { return false; } }
  // `graphToPrompt()` is a different call from `serialize()`, and a canvas can survive one and not the
  // other (round 7, R7-5). Explain it in the same words as the serialization failure, because the cure
  // is the same and a bare litegraph sentence reads like a dead bridge.
  async function buildPrompt(app) {
    try { return (await app.graphToPrompt()).output; }
    catch (error) {
      const detail = (error && error.message) || error;
      if (/无法序列化/.test(String(detail))) throw error;
      throw new Error('页面没能把当前图转成执行用的 prompt（' + detail + '）。画布能序列化不代表它能提交：'
        + '常见原因仍是图里留有子图代理节点、而工作流数据缺少 definitions。修法：用 load_workflow 传入该工作流磁盘文件的完整 JSON（包含 definitions）整图替换，或 F5 刷新该页面。',
        { cause: error });
    }
  }
  // The same question where a broken canvas is the expected input rather than an error to report.
  function readGraphOrNull(app) { try { return snapshot(app); } catch { return null; } }
  async function replaceCurrentWorkflow(app, workflow) {
    if (!graphReady(app)) throw new Error('ComfyUI 当前工作流正在载入，请稍后再试');
    const active = activeWorkflowOf(app);
    // Never use loadGraphData's null/string fallback: it creates temporary tabs.
    if (!active) throw new Error('ComfyUI 当前工作流尚未就绪，请稍后再试');
    const data = clone(workflow);
    // The id only keeps this tab's own identity, and a canvas we are about to repair may be exactly the
    // one that cannot be read — so ask for it and do not let a broken graph block the fix.
    let localId = null;
    try { localId = snapshot(app).id; } catch {}
    if (localId != null) data.id = localId;
    else delete data.id;
    const ds = app.canvas.ds;
    const view = ds ? { scale: ds.scale, offset: Array.from(ds.offset) } : null;
    try {
      const loaded = await app.loadGraphData(data, false, false, active,
        { checkForRerouteMigration: false, silentAssetErrors: true });
      if (loaded === false) throw new Error('ComfyUI 未能载入工作流');
    } finally {
      if (view && app.canvas.ds) { app.canvas.ds.scale = view.scale; app.canvas.ds.offset[0] = view.offset[0]; app.canvas.ds.offset[1] = view.offset[1]; }
      app.graph.setDirtyCanvas(true, true);
    }
  }
  // A restored graph that cannot be serialized leaves the tab half-dead: `get_workflow`, `audit(op=params)`
  // and `run` all fail on it while `doctor` still reports ok, because nothing checked the canvas after our
  // own restore (fourth-round R4-E). Verify it immediately and put the previous graph back rather than
  // answer `restored:true` for a tab the user can no longer use.
  async function keepCanvasUsable(app, previous) {
    let failure = null;
    try { rootGraphOf(app).serialize(); } catch (error) { failure = error; }
    if (!failure) return;
    const detail = failure?.message || String(failure);
    if (previous) {
      try { await replaceCurrentWorkflow(app, previous); }
      catch { throw new Error('恢复出来的画布无法序列化（' + detail + '），退回恢复前的图也失败了：请用 load_workflow 从磁盘整图替换。'); }
      throw new Error('恢复出来的画布无法序列化（' + detail + '）——通常是这条快照缺少 definitions 一类的顶层字段。已退回恢复前的画布，本次恢复没有生效。');
    }
    throw new Error('恢复出来的画布无法序列化（' + detail + '），且恢复前的画布也无法序列化，无法自动退回：请用 load_workflow 从磁盘整图替换。');
  }
  function selectSyncWorkflow(app) {
    const owner = activeWorkflowOf(app);
    if (!owner?.path) return null;
    // Reactive wrappers may change while the same workflow stays active.
    // Only a different path starts a new synchronization identity.
    if (owner.path !== syncPath) {
      syncPath = owner.path; revision = 0; initialized = false; lastFingerprint = undefined;
      lastGraphVersion = null; localAuthority = true; editSequence = acknowledgedEditSequence = 0; forceSync = true;
    }
    return owner;
  }
  function localEdit(beforeChange = false) {
    const app = appOf();
    if (applyingRemote || !graphReady(app) || !selectSyncWorkflow(app)) return;
    // Discard passive loader changes before a real gesture, not after it.
    if (!localAuthority && beforeChange) {
      lastFingerprint = fingerprint(snapshot(app)); lastGraphVersion = graphVersionOf(app);
    }
    localAuthority = true; editSequence++; forceSync = true;
  }
  async function syncWorkflow(app, { check = true } = {}) {
    const owner = selectSyncWorkflow(app);
    if (!owner) return;
    const path = owner.path;
    // Detecting a change costs a whole serialize + fingerprint pass. When the graph has
    // not moved we still send the sync — that POST is how this tab pulls other tabs'
    // edits — but with an empty body, so the idle heartbeat carries no payload.
    // A graph counter alone is not proof of an edit: custom nodes also bump it
    // from timers, preview updates and delayed sizing after a remote load.
    const pendingLocalEdit = editSequence > acknowledgedEditSequence;
    const push = forceSync || !initialized || (pendingLocalEdit && check && graphChanged(app));
    const sentVersion = graphVersionOf(app);
    let workflow, current;
    if (push) { workflow = snapshot(app); current = fingerprint(workflow); }
    // Keep a baseline even before the first exchange finishes. A user can edit
    // while the initial pull is waiting or deferred by an active input field.
    if (!initialized && lastFingerprint === undefined) lastFingerprint = current;
    const changed = workflow !== undefined && current !== lastFingerprint;
    const publishing = !!workflow && localAuthority && (!initialized || (changed && pendingLocalEdit));
    const sentEditSequence = editSequence;
    // Consume only the force flag present at request time; an event arriving while
    // awaiting the network must still force the next reconciliation.
    forceSync = false;
    let update;
    // A forced reconciliation is not a local edit. In particular, do not publish
    // browser-specific defaults introduced by a previous graph load on focus/SSE resume.
    try {
      if (publishing) synchronization.published++;
      update = await send('sync', { workflowKey: path, revision, ...(publishing
        ? { workflow, fingerprint: current, seedOnly: !initialized && editSequence === acknowledgedEditSequence } : {}) });
    }
    catch (error) { forceSync = true; throw error; }
    // A manual workflow switch can finish while the network request is pending.
    // Defer the response rather than applying it to the new tab or a loading graph.
    if (!graphReady(app) || activeWorkflowOf(app)?.path !== path) return;
    let loadedRemote = false;
    if (update.workflow) {
      // Text widgets can change before the change tracker advances its counter.
      // Check the actual graph before every destructive remote replacement.
      const liveFingerprint = fingerprint(snapshot(app));
      const editedWhileWaiting = editSequence > acknowledgedEditSequence && liveFingerprint !== (current ?? lastFingerprint);
      // Do not overwrite an edit made after this request's snapshot. Retry with
      // that edit and the original revision so normal conflict recovery sees it.
      if (editedWhileWaiting) { forceSync = true; synchronization.deferred++; return; }
      if (update.conflict && changed && editSequence > acknowledgedEditSequence) {
        const backed = rememberConflict(update.workflow);
        notify({ warning: '另一页也修改了工作流，已保留本页编辑；'
          + (backed ? '另一页版本已备份到浏览器（dsh.comfyui.sync-conflict），正在重新同步。'
            : '另一页版本没能备份（浏览器存储写不进去），正在重新同步。') });
        // Keep the unsent local edit and retry against the revision just observed.
        // An idle page has no changed content, so it cannot win this retry.
        revision = update.revision; initialized = true; forceSync = true; synchronization.conflicts++;
        return;
      }
      if (fingerprint(update.workflow) !== liveFingerprint) {
        if (manualEditing()) { forceSync = true; synchronization.deferred++; return; }
        // An existing unsaved native draft is not permission to overwrite either
        // page. Preserve it on joining; the next actual edit establishes authorship.
        if (!initialized && !embedded && owner.isModified === true && editSequence === acknowledgedEditSequence) {
          localAuthority = false; lastFingerprint = liveFingerprint; lastGraphVersion = graphVersionOf(app);
          revision = update.revision; initialized = true; return;
        }
        applyingRemote = true;
        try { await replaceCurrentWorkflow(app, update.workflow); loadedRemote = true; synchronization.loaded++; }
        finally { applyingRemote = false; }
      }
      // Keep this page a receiver until a genuine user gesture or an MCP write.
      // A timeout cannot cover custom-node normalization occurring much later.
      localAuthority = false; acknowledgedEditSequence = editSequence;
      lastFingerprint = fingerprint(snapshot(app));
    } else if (workflow) {
      lastFingerprint = current;
      if (publishing) acknowledgedEditSequence = sentEditSequence;
    }
    if (!update.workflow && update.revision === 0 && !publishing) {
      localAuthority = true; forceSync = true; initialized = false; return;
    }
    // A version observed AFTER awaiting a response may include unsent local edits.
    // Loading a remote graph may normalize node data and bump the local counter.
    // That is the new local baseline, not an edit to echo back to the other page.
    lastGraphVersion = loadedRemote ? graphVersionOf(app) : sentVersion;
    revision = update.revision; initialized = true;
  }
  // Keep lightweight cross-tab sync responsive. Only the backup command poll is
  // throttled while SSE is open; idle sync does not serialize an unchanged graph.
  const FAST_POLL_MS = 400, IDLE_POLL_MS = 4000;
  let lastGraphVersion = null, forceSync = true, lastCommandPoll = -Infinity;
  const streamAlive = () => !!commandStream && commandStream.readyState === (EventSource.OPEN ?? 1);
  const graphVersionOf = app => {
    try {
      const graph = rootGraphOf(app);
      if (!graph) return null;
      if (typeof graph.version === 'function') return graph.version();
      // Current front-ends expose the counter as graph._version (a getter backed by
      // their change tracker, bumped from incrementVersion()); reading it is free.
      return Number.isFinite(graph._version) ? graph._version : null;
    } catch { return null; }
  };
  function graphChanged(app) {
    const version = graphVersionOf(app);
    // An unseen version baseline means we have no evidence yet: serialize.
    if (version != null) return lastGraphVersion === null || version !== lastGraphVersion;
    // Builds without a counter still flip isModified from their change tracker; an
    // absent signal (fakes, exotic builds) is treated as "changed" and behaves as before.
    return activeWorkflowOf(app)?.isModified !== false;
  }
  async function poll() {
    // A command in flight must not silence the heartbeat. Round 7 lost 11.6 minutes to exactly this
    // coupling: the loop was stuck on one await, the early return stopped every later `poll`, the
    // server-side `seen` stopped moving only because SSE stayed open — so the transport said
    // `connected:true` while the page answered nothing. "Is this page alive?" and "is this page busy?"
    // have to be separate facts, which is what the cheap state POST below reports.
    if (handlingCommands && !busy) send('state', {}).catch(() => {});
    if (busy || handlingCommands) { setTimeout(poll, FAST_POLL_MS); return; } busy = true;
    try {
      const ready = graphReady(appOf());
      if (ready) await syncWorkflow(appOf());
      if (!streamAlive() || Date.now() - lastCommandPoll >= IDLE_POLL_MS) {
        const response = await send('poll', {});
        lastCommandPoll = Date.now();
        commandQueue.push(...response.commands || []);
      }
      notify({ ready, allowAI });
    } catch (e) { notify({ ready: false, error: e.message }); }
    finally { busy = false; handleCommands(); setTimeout(poll, FAST_POLL_MS); }
  }
  const historyPrefix = 'dsh.comfyui.history.';
  const historyKey = app => historyPrefix + encodeURIComponent(location.origin + ':' + sessionId + ':' + activeWorkflowOf(app).path);
  const charCount = value => String(value ?? '').length;
  // Two different questions, two different stores: writing a snapshot only needs setItem, while
  // counting what this origin holds needs an enumerable store. Conflating them turned "the page
  // has a localStorage we cannot enumerate" into "storage is full".
  function historyStore() {
    try { const store = globalThis.localStorage; return store && typeof store.setItem === 'function' ? store : null; } catch { return null; }
  }
  function storageStore() {
    try { const store = globalThis.localStorage; return store && typeof store.length === 'number' && typeof store.key === 'function' ? store : null; } catch { return null; }
  }
  function listStorageKeys(prefix) {
    const store = storageStore(); const keys = [];
    if (!store) return keys;
    for (let index = 0; index < store.length; index += 1) {
      const key = String(store.key(index));
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }
  // What the store actually pays for: the serialised entry, so a patch is measured as a patch.
  function historyCharsOf(history) {
    const size = list => (Array.isArray(list) ? list : []).reduce((total, item) => total + charCount(JSON.stringify(item)), 0);
    return size(history?.undo) + size(history?.redo);
  }
  // What the same history would cost as full graphs — the number that makes the encoding visible to
  // the caller instead of a char count whose meaning changed.
  function historyFullCharsOf(history) {
    let total = 0;
    for (const list of [history?.undo, history?.redo]) {
      for (let i = 0; i < (Array.isArray(list) ? list.length : 0); i += 1) {
        try { total += charCount(JSON.stringify(list[i].workflow || workflowAt(list, i))); } catch {}
      }
    }
    return total;
  }
  // Oldest checkpoints go first: undo needs the newest one, and a snapshot the user cannot reach
  // is worth less than a store that can still accept the front-end's own drafts.
  function trimHistory(history, budget = HISTORY_BUDGET) {
    let dropped = 0;
    // The oldest entries go first. Dropping the head takes the anchor with it, so the new head is
    // materialised back into a full graph before anything else is measured.
    // Undo drops its oldest step (the anchor moves forward); redo drops its newest, which is also
    // the end of its chain and needs no re-anchoring at all.
    while (history.undo.length > 1 && historyCharsOf(history) > budget) { dropOldest(history.undo); dropped += 1; }
    while (history.redo.length > 1 && historyCharsOf(history) > budget) { history.redo.pop(); dropped += 1; }
    return dropped;
  }
  // History keys are scoped by origin + session + workflow path, so every new DSH session leaves
  // the previous one's megabytes behind with nobody to delete them. That is the difference between
  // a store that stays usable and one that makes the front-end report 保存工作流草稿失败 forever.
  function pruneOwnStorage(keepKey) {
    const store = storageStore(); const removed = []; let chars = 0;
    if (!store || typeof store.removeItem !== 'function') return { removed, chars };
    const mine = encodeURIComponent(location.origin + ':' + sessionId + ':');
    const drop = key => {
      if (key === keepKey) return;
      // A read that throws must not abort a write that already succeeded on the canvas: this
      // path runs inside the catch of a failed setItem, so it is already the last resort.
      try {
        const size = charCount(store.getItem(key));
        store.removeItem(key);
        removed.push({ key, chars: size }); chars += size;
      } catch {}
    };
    // The per-client spelling is dead code: nothing ever read those keys back, so they were one
    // full graph per page load. The canonical slot is different — the conflict notice promises the
    // other page's version is recoverable from the browser, and `draftStorage` reports its size, so
    // deleting it here would make that sentence false the first time the store gets tight.
    for (const key of listStorageKeys(CONFLICT_KEY)) if (key !== CONFLICT_KEY) drop(key);
    // Another session's history is only expendable when its own timestamps say it is old. Under
    // pressure the provably-old records go; a record that is fresh, or whose age cannot be
    // established, is not the price of this store being full. If the space is still missing the
    // caller reports `stored: false` and says what to close — losing someone's checkpoints to
    // avoid one red toast trades a small annoyance for real data.
    const cutoff = staleThreshold();
    for (const key of historyKeysOfOthers(store, mine, keepKey)) {
      const stamp = stampOfRecord(readRecord(store, key));
      if (stamp !== null && stamp < cutoff) drop(key);
    }
    return { removed, chars };
  }
  // History keys are per session, so every new DSH conversation leaves the previous one's graphs
  // behind forever. The write path reclaims them under pressure; this constant is what the audit
  // calls "stale", so the caller can see the megabytes before they become a failed draft save.
  const HISTORY_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
  const staleThreshold = () => Date.now() - HISTORY_MAX_AGE;
  // A timestamp we can act on. Absence is not evidence of age: history records written before
  // 0.5.12 carry no top-level `savedAt`, and reading that as "expired" deleted other sessions'
  // fresh checkpoints the moment the page loaded. `time` on a checkpoint is written by
  // `checkpoint()` and is the next best evidence, so a legacy record can still age out honestly.
  const usableStamp = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
  function stampOfRecord(record) {
    const stored = usableStamp(record?.savedAt);
    if (stored !== null) return stored;
    let newest = null;
    for (const list of [record?.undo, record?.redo]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const at = usableStamp(entry?.time ?? entry?.at ?? entry?.savedAt);
        if (at !== null && (newest === null || at > newest)) newest = at;
      }
    }
    return newest;
  }
  const parseRecord = text => { try { return JSON.parse(text || 'null'); } catch { return null; } };
  // One hostile key — a value another extension wrote in a shape this origin cannot read, or a
  // key the browser refuses to expose — must not stop the sweep from dating the records after it.
  const readRecord = (store, key) => { try { return parseRecord(store.getItem(key)); } catch { return null; } };
  const historyKeysOfOthers = (store, mine, keepKey) => listStorageKeys(historyPrefix)
    .filter(key => !key.includes(mine) && key !== keepKey);
  // A snapshot left by a session whose tab closed days ago will never be read again, and it sits in
  // the same quota ComfyUI needs for its own drafts. Removing those on load is what keeps the store
  // usable across sessions; anything younger is left alone because the user may switch back to it.
  function pruneStaleStorage() {
    const store = storageStore(); const removed = []; let chars = 0;
    if (!store || typeof store.removeItem !== 'function') return { removed, chars };
    const mine = encodeURIComponent(location.origin + ':' + sessionId + ':');
    const drop = key => {
      // Measuring the value happens on somebody else's record, and a store that throws on one
      // unreadable key must not abort the whole sweep — the caller only catches, so the remaining
      // keys would silently never be reclaimed.
      try {
        const size = charCount(store.getItem(key));
        store.removeItem(key);
        removed.push({ key, chars: size }); chars += size;
      } catch {}
    };
    const cutoff = staleThreshold();
    for (const key of listStorageKeys(historyPrefix)) {
      if (key.includes(mine)) continue;
      // Only a positive timestamp older than the retention window justifies deleting another
      // session's snapshots. A record we cannot date is kept: the cost of a few stale megabytes
      // is a budget we can reclaim under pressure, the cost of guessing wrong is someone's work.
      const stamp = stampOfRecord(readRecord(store, key));
      if (stamp !== null && stamp < cutoff) drop(key);
    }
    return { removed, chars };
  }
  // Conflict backups used to be one key per clientId and never read back, so they accumulated one
  // full graph per page load. One overwritten slot, stamped with the time it was taken and read back
  // by `list_edits` (conflictFacts) — a backup nothing can report on is not a backup.
  function rememberConflict(workflow) {
    const store = historyStore(); if (!store?.setItem) return false;
    try {
      const text = JSON.stringify({ savedAt: Date.now(), workflow });
      if (charCount(text) > CONFLICT_BUDGET) { store.removeItem?.(CONFLICT_KEY); return false; }
      store.setItem(CONFLICT_KEY, text);
      // Drop the per-client keys written by older bridges so they stop occupying the quota.
      for (const key of listStorageKeys(CONFLICT_KEY)) if (key !== CONFLICT_KEY) store.removeItem?.(key);
      return true;
    } catch { return false; }
  }
  // Whether the slot the conflict notice promises actually holds anything, measured from the one
  // key that is read back. The workflow itself is never returned here: a whole graph in a read-only
  // reply is the payload shape this plugin spent a release eliminating.
  function conflictFacts() {
    const store = historyStore();
    let text = null;
    try { text = store?.getItem?.(CONFLICT_KEY) ?? null; } catch { return { present: false, unreadable: true }; }
    if (!text) return { present: false };
    const record = parseRecord(text);
    const graph = record?.workflow ?? record;
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes.length : undefined;
    return { present: true, key: CONFLICT_KEY, chars: charCount(text),
      ...(usableStamp(record?.savedAt) !== null ? { savedAt: usableStamp(record.savedAt) } : {}),
      ...(nodes !== undefined ? { nodes } : {}),
      note: '这是另一页冲突时存下的图，不会自动覆盖当前画布；要取回它需要一次显式动作（load_workflow 需要先拿到内容）。' };
  }
  // ---------------------------------------------------------------- undo history: one chain, not N copies.
  // A checkpoint used to be a full `graph.serialize()` — on the H3 canvases that live here that is
  // ~135 KB per AI write, so 11 checkpoints ate 1.49 MB of a ~5 MB quota and `trimHistory` began
  // eating the oldest undo steps while the user still wanted them. Consecutive checkpoints differ by
  // the few widgets one call touched, so the anchor keeps the full graph and every later entry keeps
  // only what moved. Reconstruction walks forward from the anchor, and a conversion is committed only
  // when the rebuilt graph is byte-identical to the full snapshot it replaced: a compression that
  // cannot be proven lossless is a corruption waiting to happen.
  const nodeIdOf = node => String(node?.id);
  function sameJson(a, b) { try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); } catch { return false; } }
  // Key order is not meaning. A rebuilt graph that carries the same fields in another order loads the
  // same canvas, so the lossless test compares canonicalised JSON; requiring byte order would just
  // refuse to compress for no reason.
  function canonicalJson(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    return JSON.stringify(value ?? null);
  }
  function jsonEqual(a, b) { try { return canonicalJson(a) === canonicalJson(b); } catch { return false; } }
  // Reserved patch keys: everything else in a patch is a workflow field, whatever it is called.
  const PATCH_RESERVED = new Set(['nodes', 'removed', 'dropped']);
  function diffWorkflow(previous, next) {
    const remaining = new Map((previous?.nodes || []).map(node => [nodeIdOf(node), node]));
    const patch = { nodes: {}, removed: [] };
    const dropped = [];
    for (const node of next?.nodes || []) {
      const key = nodeIdOf(node);
      const old = remaining.get(key);
      if (!old || !sameJson(old, node)) patch.nodes[key] = node;
      remaining.delete(key);
    }
    for (const key of remaining.keys()) patch.removed.push(key);
    // Every remaining top-level key goes in whole when it differs — not a whitelist of the ones we
    // happened to think of. The whitelist version dropped `definitions`: a canvas that still holds
    // subgraph proxies but lost their definitions cannot be serialized at all, so one undo turned the
    // tab into a half-dead state while `doctor` stayed green (fourth-round R4-E, P0). `last_node_id`
    // and `last_link_id` were the same bug one size down (R4-D).
    const previousKeys = new Set(Object.keys(previous || {}));
    const nextKeys = new Set(Object.keys(next || {}));
    for (const key of new Set([...previousKeys, ...nextKeys])) {
      if (key === 'nodes' || PATCH_RESERVED.has(key)) continue;
      if (previousKeys.has(key) && !nextKeys.has(key)) { dropped.push(key); continue; }
      if (!sameJson(previous?.[key], next?.[key])) patch[key] = next?.[key] ?? null;
    }
    // A key that disappears has to be said out loud: `patch[key] = undefined` does not survive JSON,
    // and writing `null` would put back a key the real graph does not have.
    if (dropped.length) patch.dropped = dropped;
    return patch;
  }
  function applyWorkflowPatch(previous, patch) {
    const removed = new Set(patch?.removed || []);
    const replaced = patch?.nodes || {};
    // Order is preserved and new nodes appended: some packs key widgets off array position, so a
    // reordered merge would load a different-looking canvas.
    const merged = (previous?.nodes || []).filter(node => !removed.has(nodeIdOf(node)));
    for (const [id, node] of Object.entries(replaced)) {
      const index = merged.findIndex(existing => nodeIdOf(existing) === id);
      if (index >= 0) merged[index] = node; else merged.push(node);
    }
    const next = { ...previous, nodes: merged };
    for (const [field, value] of Object.entries(patch || {})) {
      if (PATCH_RESERVED.has(field)) continue;
      next[field] = value;
    }
    for (const field of patch?.dropped || []) delete next[field];
    return next;
  }
  // The state of entry `index`, rebuilt forward from whichever entry still holds a full graph.
  function workflowAt(list, index) {
    let state = null;
    for (let i = 0; i <= index; i += 1) {
      const entry = list?.[i];
      if (!entry || typeof entry !== 'object') throw new Error('撤销链在第 ' + (i + 1) + ' 项缺失，无法重建');
      if (entry.workflow) { state = entry.workflow; continue; }
      if (!entry.patch) throw new Error('撤销链在第 ' + (i + 1) + ' 项既无快照也无增量，无法重建');
      if (!state) throw new Error('撤销链的开头是增量，缺少可重建的锚点');
      state = applyWorkflowPatch(state, entry.patch);
    }
    if (!state || !Array.isArray(state.nodes)) throw new Error('撤销快照重建结果不是工作流');
    // Cloned at the exit, shared inside: `loadGraphData` may mutate what it is handed, and the stored
    // chain must never be the object a page just edited.
    return clone(state);
  }
  // Whenever the head of a chain moves, the new head has to become a full anchor. The order is the
  // whole point: the successor can only be materialised while its parent is still in the list, so
  // anchoring happens before the drop, never after (after is unrecoverable by construction).
  function anchorHistoryHead(list) {
    if (!Array.isArray(list) || !list.length) return list;
    if (!list[0].workflow) {
      try { list[0] = { ...list[0], workflow: workflowAt(list, 0) }; delete list[0].patch; }
      catch { list.shift(); return anchorHistoryHead(list); }   // a head with no anchor anywhere is not restorable
    }
    return list;
  }
  // Remove the oldest entry, handing the anchor forward first.
  function dropOldest(list) {
    if (!Array.isArray(list) || !list.length) return;
    if (list.length > 1) {
      try { list[1] = { ...list[1], workflow: workflowAt(list, 1) }; delete list[1].patch; } catch {}
    }
    list.shift();
    anchorHistoryHead(list);
  }
  // The cap drops from the head too, one entry at a time for the same reason.  is the
  // checkpoint the current command is about to restore: evicting the step the user asked for is how
  // a restore of the oldest survivor used to answer 「没有该快照」 — one entry over the cap costs
  // nothing, deleting the only copy of a graph costs the undo.
  function capHistory(list, max, keepId) {
    while (Array.isArray(list) && list.length > max) {
      if (keepId && list[0] && list[0].id === keepId) break;
      dropOldest(list);
    }
    return list;
  }
  // Rewrite redundant full snapshots as patches against their predecessor, entry by entry, keeping the
  // whole one whenever the rebuild does not match byte for byte.
  function compactHistoryList(list) {
    let saved = 0;
    for (let i = 1; i < list.length; i += 1) {
      const entry = list[i];
      if (!entry?.workflow) continue;
      const previous = workflowAt(list, i - 1);
      const patch = diffWorkflow(previous, entry.workflow);
      const candidate = { ...entry, patch }; delete candidate.workflow;
      let rebuilt = null;
      try { rebuilt = workflowAt([...list.slice(0, i), candidate], i); } catch {}
      if (rebuilt && jsonEqual(rebuilt, entry.workflow)) {
        saved += charCount(JSON.stringify(entry)) - charCount(JSON.stringify(candidate));
        list[i] = candidate;
      }
    }
    return saved;
  }

  function historyOf(app) {
    const key = historyKey(app);
    if (!histories.has(key)) {
      let saved;
      try { saved = JSON.parse(globalThis.localStorage?.getItem?.(key) || 'null'); } catch {}
      // v1 records are full-graph chains and stay readable; v2 is the delta chain. An old bridge
      // fails its own `version === 1` test on a v2 record and starts a clean history, which is the
      // safe direction: it cannot restore a graph it would misread.
      const known = Array.isArray(saved?.undo) && Array.isArray(saved?.redo) && (saved.version === 1 || saved.version === 2);
      const history = known
        ? { version: 2, undo: saved.undo, redo: saved.redo, ...(saved.expectedHash ? { expectedHash: saved.expectedHash } : {}) }
        : { version: 2, undo: [], redo: [] };
      // Chains written before the field-generic encoder carry deltas that were built from a whitelist
      // of top-level keys, so every one of them is suspect in exactly the way R4-E is: restoring such a
      // step hands the canvas a graph with subgraph proxies but no `definitions`. Their full snapshots
      // are still sound, so keep those and retire the patches that predate `codec:'fields'` rather than
      // leave a known-lossy step one `restore_edit` away.
      if (known && saved.codec !== 'fields') {
        for (const list of [history.undo, history.redo]) {
          const before = list.length;
          list.splice(0, list.length, ...list.filter(entry => entry?.workflow));
          history.legacyPatchesDropped = (history.legacyPatchesDropped || 0) + (before - list.length);
        }
      }
      history.codec = 'fields';
      for (const list of [history.undo, history.redo]) { anchorHistoryHead(list); compactHistoryList(list); }
      trimHistory(history);
      histories.set(key, history);
    }
    return histories.get(key);
  }
  // Returns what actually happened instead of throwing: a full localStorage must not roll back a
  // canvas write that succeeded, and the caller has to be able to tell the two apart.
  function saveHistory(app, history) {
    const key = historyKey(app);
    const outcome = { stored: null, dropped: trimHistory(history), pruned: null };
    const store = historyStore();
    history.savedAt = Date.now();
    if (store) {
      const write = () => store.setItem(key, JSON.stringify(history));
      outcome.stored = true;
      try { write(); }
      catch { outcome.pruned = pruneOwnStorage(key); try { write(); } catch { outcome.stored = false; } }
    }
    histories.set(key, history);
    return outcome;
  }
  function historyNote(outcome) {
    if (!outcome) return null;
    const note = {};
    if (outcome.stored === false) note.stored = false;
    if (outcome.dropped) note.dropped = outcome.dropped;
    if (outcome.pruned?.removed?.length) note.pruned = { keys: outcome.pruned.removed.length, chars: outcome.pruned.chars };
    if (note.stored !== false && !note.dropped && !note.pruned) return null;
    note.note = note.stored === false
      ? '浏览器 localStorage 已满：这次撤销快照只留在内存里，刷新页面后 list_edits 会少掉它（画布写入本身成功）。根治办法是清理设置里的工作流草稿（关掉 Comfy.Workflow.Persist），或换一个干净的浏览器配置。'
      : '浏览器存储吃紧：已回收 ' + (note.pruned?.chars ?? 0) + ' 字符的旧快照' + (note.pruned ? '（' + note.pruned.keys + ' 个键）' : '') + '，并丢弃本工作流最早的 ' + (note.dropped ?? 0) + ' 个撤销点；画布写入正常，list_edits 里能回退的步数变少。';
    return note;
  }
  // FNV-1a over the canonical fingerprint: enough to answer 「did the canvas move」 without shipping it.
  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return String(hash >>> 0);
  }
  function graphHash(app) {
    return hashText(fingerprint(readGraph(app)));
  }
  // `parent` is the state the previous entry of the same list describes; with none, this entry is the
  // anchor. The node count is recorded on the entry because a patch does not carry a node list, and
  // `list_edits` must not rebuild eleven graphs just to print eleven numbers.
  function checkpoint(app, label, parent) {
    const workflow = snapshot(app);
    const entry = { id: randomUUID(), time: Date.now(), label, nodes: (workflow.nodes || []).length };
    const patch = parent ? diffWorkflow(parent, workflow) : null;
    // Prove the delta at the moment it is created, not only when the chain is compacted later. The
    // write path used to trust `diffWorkflow` blind: a field the encoder did not know about was
    // silently missing from the patch, and the loss only surfaced as an unserializable canvas after
    // an undo. Anything that cannot be rebuilt exactly is stored whole instead — the chain costs a
    // little space, the user keeps a truthful undo.
    // With the field-generic encoder no fixture can reach the fallback: every difference a JSON graph
    // can express is a key the patch carries. Treat it as a construction guard; if it ever fires, the
    // entry shows up as `encoded:"full"` in `list_edits`, which is the observable trace.
    if (patch && jsonEqual(applyWorkflowPatch(parent, patch), workflow)) entry.patch = patch;
    else entry.workflow = workflow;
    return entry;
  }
  function workflowStore(app) {
    const store = app.extensionManager?.workflow;
    if (!store?.getWorkflowByPath || !store?.createNewTemporary) throw new Error('此 ComfyUI 前端未提供工作流标签页接口，请更新前端');
    return store;
  }
  function describeWorkflow(store, workflow) {
    return { path: workflow.path, name: workflow.filename || workflow.path,
      active: workflow === store.activeWorkflow, open: store.openWorkflows?.some(w => w.path === workflow.path) === true,
      saved: workflow.isPersisted === true, modified: workflow.isModified === true };
  }
  async function workflowData(app, workflow) {
    if (workflow === activeWorkflowOf(app)) return snapshot(app);
    const loaded = workflow.isLoaded ? workflow : await workflow.load();
    if (!loaded?.activeState) throw new Error('无法读取该工作流');
    return clone(loaded.activeState);
  }
  async function openWorkflow(app, workflow, data) {
    const retained = activeWorkflowOf(app), previous = snapshot(app);
    try {
      const loaded = await app.loadGraphData(data, true, true, workflow,
        { checkForRerouteMigration: false, silentAssetErrors: true });
      if (loaded === false || activeWorkflowOf(app)?.path !== workflow.path) throw new Error('ComfyUI 未能打开工作流');
    } catch (error) {
      if (retained) await app.loadGraphData(previous, true, true, retained,
        { checkForRerouteMigration: false, silentAssetErrors: true });
      throw error;
    }
  }
  // A widget whose value is not the source of truth: DOM widgets own their own state,
  // hidden widgets are driven by a panel, and a serialize:false widget never reaches the
  // prompt at all. Writing `widget.value` on those looks like success and is not.
  // Only the options pair marks a real DOM widget. Native Combo/Number/Text/Boolean widgets
  // also expose prototype.setValue, so "has setValue" alone classified every native control
  // as DOM — which is what made list_nodes report kind:"dom" for node 195 mode and made the
  // write path believe it was talking to a frontend-owned control.
  function widgetKind(widget) {
    if (widget.type === 'button') return 'button';
    if (typeof widget.options?.setValue === 'function' || typeof widget.options?.getValue === 'function') return 'dom';
    if (widget.type === 'hidden' || widget.hidden === true || widget.options?.hidden === true) return 'hidden';
    if (widget.serialize === false || widget.options?.serialize === false) return 'shadowed';
    return 'plain';
  }
  const widgetSetter = widget => widget.options?.setValue || widget.setValue || null;
  // Native ComfyUI widgets read the second argument: BaseWidget.setValue(e, { e, node, canvas }).
  // Calling one with the value alone throws "Cannot destructure property 'e' of 'undefined'"
  // from inside the frontend bundle — the exact failure every combo/number/toggle/text write
  // used to hit. DOM widgets take the value and ignore the rest, so one call shape fits both.
  const writeContext = (app, node) => ({ e: null, node, canvas: app.canvas || {} });
  function widgetReadback(widget) {
    try { return typeof widget.options?.getValue === 'function' ? widget.options.getValue() : widget.value; }
    catch { return widget.value; }
  }
  // Some packs keep a structured document in node.properties and render their editor from
  // it, so a freshly written value is ignored until that shadow is dropped — the same
  // order of operations the packs use for their own "fill this in" buttons. Reading them is
  // harmless; deleting one without being able to attribute it to this widget is not.
  const shadowDocs = node => Object.entries(node.properties || {})
    .filter(([, value]) => value && typeof value === 'object' && Array.isArray(value.parts)).map(([key]) => key);
  // Attribution has two tiers. Declared: the key is named in the widget's own options, or equals
  // the widget's name — that is the pack telling us. Undeclared: two independent proofs are
  // required, because a cleared document cannot be un-cleared (reviewer's P2-1). The key has to
  // name this control as a whole token, AND the document text has to be identical to the value
  // being replaced. The H3 pack keeps `widget.value === doc.text` on every sync of its own
  // (`syncPromptFromEditor` writes both), so a real prompt document passes; `video_reference` on
  // the same node shares the `reference` token but its value is a boolean, so it cannot claim the
  // 5k-character prompt document the way pure token matching used to allow.
  const tokens = text => String(text).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const docText = doc => {
    if (typeof doc?.text === 'string') return doc.text;
    if (!Array.isArray(doc?.parts)) return null;
    return doc.parts.map(part => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('');
  };
  // A document that is only a text mirror can be kept in step with a write. Anything else (mention
  // or dialogue parts, which is how AICG3D carries `<Picture n>` references) has no representation
  // for an arbitrary new string, and rewriting it would silently drop the references the queue
  // needs — so those are reported, never rewritten. Note the pack's own sync writes both `text`
  // and the single text part, which is why `text` is the field to compare.
  const plainTextDoc = doc => {
    if (!Array.isArray(doc?.parts) || !doc.parts.length) return false;
    // Every part has to be plain text. A single-part requirement was the round-5 complaint (R5-F):
    // AICG3D keeps a multi-paragraph plain prompt as several text parts, and the strict shape said
    // "this write will be reverted" about a document that in fact resyncs and persists.
    const everyText = doc.parts.every(part => typeof part === 'string'
      || (part && typeof part === 'object' && (part.type ?? 'text') === 'text' && typeof part.text === 'string'));
    if (!everyText) return false;
    const joined = doc.parts.map(part => (typeof part === 'string' ? part : part.text)).join('');
    // `text` is the field the pack's own sync compares, so when the document carries one it must agree
    // with its parts: a doc whose `text` says more than its parts is holding something else.
    return typeof doc.text !== 'string' || doc.text === joined;
  };
  function shadowDocFor(node, widget, currentText = '') {
    const declared = [widget.options?.shadowDoc, widget.options?.serializedWidget,
      widget.options?.widgetName, widget.name].filter(key => typeof key === 'string' && key !== '');
    const name = String(widget.name || '').toLowerCase();
    const candidates = [];
    for (const [key, doc] of Object.entries(node.properties || {})) {
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.parts)) continue;
      const claimed = declared.includes(key)
        || (name !== '' && tokens(key).includes(name) && currentText !== '' && docText(doc) === currentText);
      if (claimed) candidates.push({ key, value: doc });
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
  // A hidden original widget and the DOM widget that replaced it hold the same value; writing
  // through the visible one is what makes the editor and the archive agree. Ownership has to be
  // confirmed — matching current values made two empty widgets interchangeable and sent a write
  // into an unrelated field (reviewer's reproduction). Same name is LiteGraph's own convention
  // for `addDOMWidget(name, …)`; packs that swap widgets record the name in options.
  const ownsWidget = (other, name) => other.name === name
    || other.options?.serializedWidget === name || other.options?.widgetName === name;
  function writeTarget(node, widget) {
    if (widgetKind(widget) !== 'hidden' && widgetKind(widget) !== 'shadowed') return { widget, reroutedFrom: null, resolved: true };
    const owners = (node.widgets || []).filter(other => other !== widget && widgetSetter(other) && ownsWidget(other, widget.name));
    // Two claimants is the case that must not be guessed at: either could be the editor.
    if (owners.length > 1) return { widget, reroutedFrom: null, resolved: false };
    // No claimant means nobody replaced this widget. Writing it in place is not a guess about
    // ownership — it is the addressed control — and refusing it would break every pack that
    // hides a control without putting an editor on top of it.
    if (owners.length === 0) return { widget, reroutedFrom: null, resolved: true };
    return { widget: owners[0], reroutedFrom: widget.name, resolved: true };
  }
  const unresolvedTarget = widget => ({ resolved: false,
    hint: `控件 ${widget.name} 同时被多个前端组件声明为自己，无法安全确定写入目标；本次没有写入。` });
  // The front-end persists every graph change as a localStorage draft; when the origin's
  // quota is full the write itself fails and the user gets a toast the tool side can neither
  // see nor dismiss. A silent page-wide side effect deserves a number in the reply: measure
  // the keys ComfyUI uses for drafts so a caller can tell "full" from "normal".
  function draftStorage() {
    const facts = { available: false, usedChars: 0, keys: [], persistSetting: null, blocking: null,
      ownChars: 0, bridgeHistoryChars: 0, conflictChars: 0, conflictKeys: 0, ownKeys: [], totalChars: 0,
      staleChars: 0, staleKeys: 0, staleAfterMs: HISTORY_MAX_AGE, unavailable: false, unreadableKeys: 0 };
    try {
      const store = storageStore();
      if (!store) {
        facts.blocking = '当前页面没有可枚举的 localStorage';
        return facts;
      }
      facts.available = true;
      const mine = encodeURIComponent(location.origin + ':' + sessionId + ':');
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        let value = '';
        // Same reason as the sweep: a key that throws on read is one unreadable key, not a
        // reason to report nothing about the store the user is asking about.
        try { value = store.getItem(key) ?? ''; } catch { value = ''; facts.unreadableKeys = (facts.unreadableKeys ?? 0) + 1; }
        const chars = charCount(value);
        // The bridge owns keys in the same quota. Counting only ComfyUI's drafts answered
        // "how full is the store" with a number that could be near zero while the store was full.
        if (String(key).startsWith(historyPrefix)) {
          facts.bridgeHistoryChars += chars;
          const current = String(key).includes(mine);
          // A snapshot from another session is not necessarily junk: the user may switch back to
          // it. Only one old enough that its tab cannot still be open is worth reporting as stale.
          let stale = false;
          if (!current) {
            // Same rule as the prune: a snapshot is reported stale only when its own timestamps
            // say so. A legacy record with no `savedAt` is unknown, not expired.
            const stamp = stampOfRecord(parseRecord(value));
            stale = stamp !== null && stamp < staleThreshold();
          }
          if (stale) { facts.staleChars += chars; facts.staleKeys += 1; }
          if (facts.ownKeys.length < 40) facts.ownKeys.push({ key: String(key), kind: 'history', chars, current, ...(stale ? { stale: true } : {}) });
          continue;
        }
        if (String(key).startsWith(CONFLICT_KEY)) {
          facts.conflictChars += chars; facts.conflictKeys += 1;
          if (facts.ownKeys.length < 40) facts.ownKeys.push({ key: String(key), kind: 'conflict', chars });
          continue;
        }
        // Every draft family starts here: Draft.v2, DraftIndex.v2, DraftOrder, Drafts. The
        // persistence switch shares the prefix but is a flag, not a payload — counting its 4
        // characters would make the number describe something else than the store's size.
        if (!String(key).startsWith('Comfy.Workflow.') || key === 'Comfy.Workflow.Persist') continue;
        facts.keys.push({ key, chars });
        facts.usedChars += chars;
      }
      facts.ownChars = facts.bridgeHistoryChars + facts.conflictChars;
      facts.totalChars = facts.usedChars + facts.ownChars;
      facts.persistSetting = store.getItem('Comfy.Workflow.Persist');
      // `available` only proves the store could be enumerated. Private-browsing and some embedded
      // webviews hand back a readable store that rejects every write, which is exactly the case
      // doctor warns about — so warn on evidence, not on an absence that can never occur.
      if (typeof store.setItem === 'function') {
        try { store.setItem('dsh.comfyui.storage-probe', '1'); }
        catch (error) {
          facts.unavailable = true;
          facts.blocking = 'localStorage 可读但写不进（' + (error.message || String(error))
            + '）：草稿与撤销历史无法落盘，画布改动只活在当前页面。';
        }
        // Cleaning up is its own risk: a store that allows writes but throws on removal must not
        // be reported as read-only because of a leftover 1-byte key.
        try { store.removeItem?.('dsh.comfyui.storage-probe'); } catch {}
      }
    } catch (error) { facts.blocking = error.message || String(error); }
    return facts;
  }
  // ComfyUI runs some parameter changes through the node's own autofill driver: writing a
  // prompt can rewrite downstream widgets a few hundred milliseconds later, so a reply that
  // lists only the node we touched reads as "nothing else moved".
  // The graph keeps its links in a Map keyed by link id (graph.links.get(id)) — not the plain
  // object older litegraph versions exposed. Reading graph.links[id] on a Map silently yields
  // undefined for every id, which is why a node with four outgoing links reported no downstream
  // nodes at all. This one helper is also what audit_graph counts, so both agree with the
  // serialized workflow instead of always answering 0.
  const linkTable = graph => (graph?.links || null);
  const linkById = (graph, linkId) => {
    const table = linkTable(graph);
    if (!table) return null;
    if (typeof table.get === 'function') return table.get(linkId) ?? null;
    if (Array.isArray(table)) return table.find(item => item && (item.id === linkId || item[0] === linkId)) ?? null;
    return table[linkId] ?? null;
  };
  const linkCount = graph => {
    const table = linkTable(graph);
    if (!table) return 0;
    if (typeof table.size === 'number') return table.size;
    if (Array.isArray(table)) return table.length;
    return Object.keys(table).length;
  };
  // litegraph exposes the wiring per slot through node.getOutputNodes(slot), which works whether
  // the graph keeps links in a Map or a plain object. Ask it first and only fall back to the link
  // table when the node object is too old to have it.
  const downstreamOf = (app, node) => {
    const graph = app.graph || {};
    const found = [], seen = new Set();
    const push = target => {
      if (!target || seen.has(String(target.id))) return;
      seen.add(String(target.id));
      found.push(target);
    };
    const outputs = node.outputs || [];
    // Both answers are merged instead of one shadowing the other. The slot API reads the
    // global link registry, which a graph loaded through loadGraphData can lag behind; the
    // link table can be empty on a graph that has not been wired the old way yet. An empty
    // answer from either one is not evidence that the node has no downstream nodes.
    if (typeof node.getOutputNodes === 'function') {
      outputs.forEach((output, slot) => {
        let peers = null;
        try { peers = node.getOutputNodes(slot); } catch { peers = null; }
        if (Array.isArray(peers)) for (const peer of peers) push(peer);
      });
    }
    for (const output of outputs) for (const linkId of output.links || []) {
      const link = linkById(graph, linkId);
      push(link?.target_id != null ? graph.getNodeById?.(link.target_id) : null);
    }
    return found;
  };
  const widgetSnapshot = node => {
    const map = {};
    for (const widget of node.widgets || []) {
      try { map[widget.name] = widgetReadback(widget); } catch { map[widget.name] = widget.value ?? null; }
    }
    return map;
  };
  // graphToPrompt() is what the queue would receive: it runs the front-end's own widget
  // conversion (localized combos, DOM editors). Reporting it beside the canvas values is what
  // lets the audit tell "this label converts at queue time" from "this value really is invalid".
  // Strings are capped like widget values so one long prompt cannot flood the reply.
  // Strings are capped well above any realistic enum (4 KB) so the audit compares the real
  // submitted value; anything longer is listed in `serializedTruncated` and never judged.
  const SERIALIZED_CAP = 4096;
  const promptValue = value => {
    if (typeof value === 'string') return value.length > SERIALIZED_CAP ? value.slice(0, SERIALIZED_CAP) + '…' : value;
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return value;
    let text = '';
    try { text = JSON.stringify(value); } catch { text = String(value); }
    return text.length > SERIALIZED_CAP ? text.slice(0, SERIALIZED_CAP) + '…' : text;
  };
  const promptInputs = async app => {
    try {
      const prompt = await app.graphToPrompt();
      const map = {}, truncated = [];
      for (const [nodeId, entry] of Object.entries(prompt?.output || {})) {
        const inputs = {};
        for (const [name, value] of Object.entries(entry?.inputs || {})) {
          const shown = promptValue(value);
          if (typeof shown === 'string' && shown.length > SERIALIZED_CAP && shown.endsWith('…')) truncated.push(nodeId + '.' + name);
          inputs[name] = shown;
        }
        map[nodeId] = inputs;
      }
      // The names are short and the list is what keeps a cut value from being judged: a
      // smaller bound here would let field 41 onward be refuted on its prefix.
      return { serializedInputs: map, promptFailed: false,
        ...(truncated.length ? { serializedTruncated: truncated.slice(0, 500) } : {}) };
    } catch (error) {
      // A page that cannot produce a prompt cannot run either, and that fact must not be reported only
      // when some value happens to be out of the authoritative domain (round 7, R7-5: `param-values`
      // came back `supported / count 0` next to this same error).
      return { serializedInputs: null, promptFailed: true, serializedError: String(error?.message || error) };
    }
  };
  const diffSnapshot = (before, after) => {
    const changed = [];
    for (const [name, previous] of Object.entries(before)) {
      if (!Object.prototype.hasOwnProperty.call(after, name)) continue;
      if (String(previous ?? '') !== String(after[name] ?? '')) changed.push({ widget: name, before: previous ?? null, after: after[name] ?? null });
    }
    return changed;
  };
  // The autofill driver is debounced (~400ms in the front-end), so the read-back above can be
  // true and still get overwritten later. Watch the wired-down nodes across that window and
  // report what actually moved instead of promising the canvas stood still.
  const SETTLE_MS = 600;
  const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

  // A failed write has to say which step failed and what to try instead; a bare
  // "Cannot destructure property 'e' of 'undefined'" tells the caller nothing.
  const writeHint = (kind, node, widget) => {
    // Only the document attributable to THIS widget is ever touched; listing every `parts`
    // document here would suggest the write cleaned things it deliberately left alone.
    const shadow = shadowDocFor(node, widget);
    const base = kind === 'dom' || kind === 'shadowed' || kind === 'hidden'
      ? '该控件由前端组件自己持有状态（kind=' + kind + '），写控件回读不一致就代表没写进去。'
      : '控件回读值与提交值不一致，面板可能拒绝了这次写入（kind=' + kind + '）。';
    const paths = [];
    if (shadow) paths.push('写它的 shadow 源 node.properties[' + JSON.stringify(shadow.key) + ']（这一次已尝试清除这一份并重试，仍失败就说明文档格式有额外约束）');
    paths.push('用该节点包自带的写入入口（例如 AICG3D 的 globalThis.AICG3D_H3.setPromptText(node, value, {notifyGraphChange:false, preserveNodeSize:true})），它才会同步刷新 UI 与 properties');
    paths.push('或改磁盘上的工作流 JSON，再用 load_workflow（workflowJson 传字符串）+ save_workflow 整图替换');
    return base + ' 可行路径：' + paths.map((p, i) => '(' + (i + 1) + ') ' + p).join('；') + '。不要重试同一调用。';
  };
  // The quantization a Float widget applies to its own input: LiteGraph's `onFloatValueChange` rounds
  // to `options.round` (which `useFloatWidget` derives from `step` unless the pack set a round), so
  // writing 0.999 to a step-0.01 control lands on 1 and the read-back differs from the request by half
  // a step. That is the panel accepting the value in its own granularity, not refusing it — rounds 5
  // (R5-A) and 6 (R6-5) both saw it reported as `verified:false / needs_input`, and Float noise like
  // 1.5000000000000002 is the same story one decimal further out.
  const stepOf = widget => [widget?.options?.round, widget?.options?.step2, widget?.options?.step]
    .find(size => typeof size === 'number' && size > 0);
  // One rule for both read-backs — straight after the write and after the settle wait — otherwise a
  // quantized value verifies once and then comes back as 「被改回去了」.
  function readsBack(widget, after, value) {
    if (String(after ?? '') === String(value)) return { verified: true };
    if (typeof after !== 'number' || typeof value !== 'number' || !Number.isFinite(after) || !Number.isFinite(value)) return { verified: false };
    const step = stepOf(widget);
    const tolerance = step ? step / 2 : Number.EPSILON * Math.max(1, Math.abs(after)) * 4;
    if (Math.abs(after - value) > tolerance) return { verified: false };
    return { verified: true, quantized: step ? { requested: value, applied: after, step }
      : { requested: value, applied: after, note: '浮点末位差异，画布存的是四舍五入后的值' } };
  }
  // Which `node.properties` keys plausibly hold this control's real state: every token of the widget
  // name appears in the key. `guhai_ig` → `guhai_ig_filter` / `guhai_ig_active_set` match; an unrelated
  // `active_set` on another control does not. Used only to tell the caller WHERE the value lives — the
  // bridge never writes these keys (R6-6: no properties channel, by the maintainer's decision).
  function propertyKeysFor(node, name) {
    const needle = tokens(name);
    if (!needle.length) return [];
    return Object.keys(node.properties || {}).filter(key => {
      const hay = tokens(key);
      return needle.every(token => hay.includes(token));
    });
  }
  // The visible panel that renders a data-only control. Name matching (`ownsWidget`) is the first
  // guess, and for AICG3D's素材库 it is not enough: the hidden `media_state` is rendered by a DOM
  // widget called `h3_media_loader`, whose own `getValue` reads the hidden one — so the evidence that
  // two controls show the same value is the value itself. An empty value is not evidence (that is how
  // two unrelated editors used to be treated as interchangeable), and no candidate is reported as
  // such rather than guessed at: a segment node's panel is only created when the user expands it.
  function panelMirror(node, widget) {
    const doms = (node?.widgets || []).filter(other => other !== widget && widgetKind(other) === 'dom'
      && typeof other.options?.setValue === 'function');
    if (!doms.length) return null;
    const byName = doms.find(other => ownsWidget(other, widget.name));
    if (byName) return byName;
    let current;
    try { current = String(widgetReadback(widget) ?? ''); } catch { return null; }
    if (!current) return null;
    return doms.find(other => {
      try { return String(other.options?.getValue?.() ?? other.value ?? '') === current; } catch { return false; }
    }) || null;
  }
  function writeWidget(app, node, widget, value) {
    const setter = widgetSetter(widget), kind = widgetKind(widget);
    // An undeclared document is claimed by proving it mirrors this widget, and the text it mirrors
    // is the value the widget held BEFORE this write — after `apply()` the widget carries the new
    // value and the document still carries the old one, so reading it later could never match.
    let valueBefore = '';
    try { valueBefore = String(widgetReadback(widget) ?? ''); } catch {}
    const apply = () => {
      if (setter) setter.call(widget, value, writeContext(app, node));
      else { widget.value = value; widget.callback?.(value, app.canvas, node); }
    };
    // Record which step blew up so the caller gets "阶段：调用控件 setter" instead of
    // an anonymous TypeError, plus the node/widget it happened on.
    let stage = 'call-setter';
    const fail = error => {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.stage = stage; wrapped.nodeId = String(node.id); wrapped.widget = widget.name;
      wrapped.widgetKind = kind; wrapped.hint = writeHint(kind, node, widget);
      throw wrapped;
    };
    try { apply(); } catch (error) { fail(error); }
    // A hidden/shadowed/dom widget is not serialized as-is even when its own value assignment
    // "sticks": a document can decide what the queue carries, or what the panel shows next time it
    // repaints. Those kinds go through the document stage even on a matching read-back; any other
    // kind only when its read-back disagrees.
    const shadowAware = kind === 'hidden' || kind === 'shadowed' || kind === 'dom';
    let cleared, synced, diverged;
    try {
      if (typeof value === 'string' && (shadowAware || String(widgetReadback(widget) ?? '') !== value)) {
        stage = 'clear-shadow-docs';
        // One attributable document, kept aside: a retry that still does not verify restores it,
        // so a failed write leaves the node exactly as it found it.
        const shadow = shadowDocFor(node, widget, valueBefore);
        if (shadow) {
          // A DOM control that already took the value owns a live editor rendered from the
          // document. Deleting the model of a control that answered would trade a good write for a
          // blank panel, so when the document is nothing but a text mirror the write is copied into
          // it instead — the shape the pack itself keeps in sync
          // (comfyui-AICG3D h3easy/nodes.py:660, minimax_h3_easy_ui_v4.js:4351). A document with
          // mention parts cannot be mirrored from a plain string, so it is left alone and reported:
          // the queue has the new text, the editor will show the old one until the pack resyncs.
          const sticks = String(widgetReadback(widget) ?? '') === String(value);
          if (kind === 'dom' && sticks && plainTextDoc(shadow.value)) {
            node.properties[shadow.key] = { ...shadow.value, text: value, parts: [{ ...shadow.value.parts[0], text: value }] };
            synced = [shadow.key];
          } else if (kind === 'dom' && sticks) {
            diverged = [shadow.key];
          } else {
            delete node.properties[shadow.key];
            // A retry that throws must not leave the node missing its document: restore first,
            // then let the caller see the failure. Deleting and walking away is the exact
            // data loss the review asked to rule out.
            try { apply(); }
            catch (error) { node.properties[shadow.key] = shadow.value; throw error; }
            if (String(widgetReadback(widget) ?? '') === String(value)) cleared = [shadow.key];
            else node.properties[shadow.key] = shadow.value;
          }
        }
      }
    } catch (error) { fail(error); }
    stage = 'read-back';
    let after;
    try { after = widgetReadback(widget); } catch (error) { fail(error); }
    app.graph.setDirtyCanvas(true, true);
    const read = readsBack(widget, after, value);
    const verified = !!read.verified, quantized = read.quantized;
    // A hidden control holds the value the queue carries; the panel the user sees is a separate DOM
    // widget whose own `setValue` is what repaints it (comfyui-AICG3D h3easy: `h3_media_loader`
    // `setValue: value => { media_state.value = value; mediaLoaderRender(node) }`). Data agreement is
    // not visual agreement: round 5 wrote `media_state`, verified it, and the素材库 kept showing the
    // old picture until the tab was reopened.
    let panelRefreshed;
    if (verified && (kind === 'hidden' || kind === 'shadowed')) {
      const mirror = panelMirror(node, widget);
      if (!mirror) panelRefreshed = 'no-dom-mirror';
      else { try { mirror.options.setValue(value); panelRefreshed = true; } catch { panelRefreshed = false; } }
    }
    // A document this widget cannot claim is left in place — deleting an unattributable one is
    // the irreversible mistake — but it is also the reason a verified read-back may still not be
    // what the queue carries. Naming the survivors turns a silent no-op into a visible question.
    // A pack may keep its own private copy of the same value in `node.properties` (AICG3D writes
    // `minimax_h3_inline_media_state` and `media_loader_state` alongside the widget). Those are not the
    // queue's source of truth — measured: `mediaLoaderState` only falls back to the property when the
    // widget is empty, and `media_loader_state` has no reader at all — so we do not touch them, but a
    // caller who compares the node's properties against the canvas after a write deserves to know which
    // copies are now stale (round 5, R5-E).
    let propertiesStale;
    if (verified && typeof valueBefore === 'string' && valueBefore && valueBefore !== String(value)) {
      propertiesStale = Object.entries(node.properties || {})
        .filter(([key, held]) => typeof held === 'string' && held === valueBefore && key !== widget.name)
        .map(([key]) => key);
      if (!propertiesStale.length) propertiesStale = undefined;
    }
    const remaining = shadowAware && !cleared && !synced ? shadowDocs(node) : [];
    return { kind, via: setter ? (widget.options?.setValue ? 'dom-setter' : 'native-setter') : kind === 'plain' ? 'value+callback' : kind,
      verified, after, cleared, synced, diverged, panelRefreshed, ...(quantized ? { quantized } : {}),
      ...(propertiesStale ? { propertiesStale } : {}),
      ...(remaining.length ? { shadowDocsRemaining: remaining } : {}),
      ...(verified ? {} : { hint: writeHint(kind, node, widget) }) };
  }
  // Writing one widget can make the pack rewrite the nodes wired below it (AICG3D's prompt
  // editor refills segments ~400ms after a change). Snapshot those nodes first, let the
  // debounce land, then diff: a reply that only lists the node we touched reads as "nothing
  // else moved", which is exactly the false success the tool face is supposed to prevent.
  function watchDownstream(app, targets) {
    const watched = [];
    for (const node of targets) for (const target of downstreamOf(app, node))
      watched.push({ node, peer: target, id: String(target.id), type: target.type, widgets: widgetSnapshot(target) });
    return watched;
  }
  async function followUpWrite(app, edits, outcomes, watched) {
    const report = {};
    // No wiring below the touched nodes means no cascade to wait for — but only for a plain
    // parameter. A pack-driven control (hidden / shadowed / dom, or one whose document survived)
    // is exactly the kind an editor takes back a few hundred milliseconds later, and skipping the
    // re-read there would verify a value the page already removed.
    const needsSettle = watched.length > 0 || outcomes.some(outcome =>
      outcome.kind !== 'plain' || outcome.cleared || outcome.shadowDocsRemaining);
    if (!needsSettle) return report;
    await settle(SETTLE_MS);
    const late = [];
    outcomes.forEach((outcome, index) => {
      const edit = edits[index];
      let after; try { after = widgetReadback(edit.widget); } catch { after = edit.widget.value; }
      if (String(after ?? '') !== String(outcome.after ?? '')) {
        const read = readsBack(edit.widget, after, edit.value);
        outcome.after = after; outcome.verified = !!read.verified;
        if (read.quantized) outcome.quantized = read.quantized;
        late.push({ nodeId: String(edit.node.id), widget: edit.widget.name, value: after, now: outcome.verified ? 'accepted' : 'overwritten' });
      }
    });
    const cascaded = [];
    for (const entry of watched) {
      const after = widgetSnapshot(entry.peer);
      for (const change of diffSnapshot(entry.widgets, after))
        cascaded.push({ fromNodeId: String(entry.node.id), nodeId: entry.id, type: entry.type, ...change });
    }
    report.settledMs = SETTLE_MS;
    if (late.length) report.lateChange = late;
    if (cascaded.length) {
      report.cascaded = cascaded;
      report.cascadedNote = '等待 ' + SETTLE_MS + 'ms 让前端防抖落定后，下游节点被联动改写 ' + cascaded.length + ' 处（' + [...new Set(cascaded.map(item => item.nodeId))].map(id => 'node ' + id).join('、') + '）。这不在本批 changes 里，是节点包自己的 autofill 行为：如果这些下游值本来是手调的，写回去。';
    }
    return report;
  }
  const optionHint = values => {
    const shown = values.slice(0, 12).map(v => JSON.stringify(v)).join(', ');
    return ' 画布上的可选项是 [' + shown + (values.length > 12 ? ` …共 ${values.length} 项` : '') + ']，用其中之一的原文提交。';
  };
  // A rejected call is a validation fact, not a page-side crash: it deserves a hint that
  // names the next call. Without this every "节点不存在" came back with the generic
  // "page threw an exception, read the stack" advice, which sends the model hunting for a
  // stack trace that does not exist.
  const fail = (message, hint) => { const error = new Error(message); error.hint = hint; return error; };
  // A caller that sends {edits: [...]} to update_nodes gets told the field it actually sent —
  // "changes must be an array" alone reads like the value was wrong, not the key name.
  const argNameHint = (args, expected) => {
    const given = Object.keys(args || {}).filter(key => !expected.includes(key) && !['clientId', 'sessionId'].includes(key));
    return given.length ? '（收到的是 ' + given.join(' / ') + '，应改用 ' + expected.join(' / ') + '）' : '';
  };
  // Predict whether update_nodes can make this widget stick, before the caller spends a write
  // on it. 'ok' = plain value write; 'risky' = a DOM/panel-owned control whose setter may throw
  // or silently disagree (call it, then trust only verified); 'no' = button/no widget.
  function nodes(app) {
    return (app.graph._nodes || []).map(n => ({ id: String(n.id), type: n.type, title: n.title, mode: n.mode,
      widgets: (n.widgets || []).filter(w => w.type !== 'button').map(w => ({ name: w.name, type: w.type, value: w.value ?? null,
        ...(widgetKind(w) === 'plain' ? {} : { kind: widgetKind(w) }),
        ...(Array.isArray(w.options?.values) ? { choices: w.options.values } : {}),
        ...(typeof w.options?.min === 'number' ? { min: w.options.min, max: w.options.max ?? null } : {}),
        // The granularity the panel applies to its own numbers. Without it a caller cannot tell a
        // refused write from a quantized one, and 0.999 into a step-0.01 control reads as a failure
        // (rounds 5/6: R5-A, R6-5). `round` is what LiteGraph actually rounds to; `step` is the hint
        // the pack declared.
        ...(stepOf(w) !== undefined ? { step: w.options?.step ?? null, round: stepOf(w) } : {}) })),
      inputs: (n.inputs || []).map((i, slot) => ({ name: i.name, type: i.type, slot, link: i.link ?? null })),
      outputs: (n.outputs || []).map((o, slot) => ({ name: o.name, type: o.type, slot, links: o.links || [] })) }));
  }
  // The content a save writes is `changeTracker.activeState`, not the canvas: the front-end's
  // `ComfyWorkflowWithChangeTracker.save()`/`saveAs()` both do `this.content = JSON.stringify(this.activeState)`
  // before hitting the disk, and `activeState` is only refreshed by `captureCanvasState()` — which
  // early-returns on four conditions (graph not ready, a pending before-change, a state restore, a
  // loading flag). A node that rebuilds its widget in a `requestAnimationFrame` after `onConfigure`
  // (`ShowText|pysssss`, ~3.5s on this machine) can therefore stay missing from `activeState` for the
  // whole session: round 6 measured `save_as_workflow` writing a file where that node's `widgets_values`
  // had vanished entirely, while an in-place `save_workflow` of the same canvas kept it.
  // So: give the page a frame to finish its deferred widgets, let the tracker do its own thing, and if
  // the state that would be written still is not the canvas, put the canvas there. It is the same value
  // `captureCanvasState` would have assigned (`clone(rootGraph.serialize())`).
  // Round 7's P0 (R7-7): this await had no way to lose. `requestAnimationFrame` does not fire in a
  // hidden tab, so a `save_*` while the page was in the background never resolved, `handlingCommands`
  // stayed true, and every later command — plus the heartbeat, which is gated on the same flag —
  // queued forever (11.6 minutes measured, `server_info` still saying `connected:true`). Anything that
  // waits on a browser callback has to lose that wait on purpose, and the reply has to say which branch
  // it took.
  const FRAME_WAIT_MS = 150;
  // A save that cannot settle its own state is worse than a slow one, so the wait is bounded twice over:
  // the race above for the normal case, and a watchdog here that answers `'watchdog'` if even the
  // 150 ms timer somehow never ran.
  async function waitOneFrame() {
    if (typeof window.requestAnimationFrame !== 'function') return 'no-frames';
    // Ask the page first: a background tab does not run animation frames at all, so waiting for one is
    // waiting for nothing. Bounded by the race below for the rarer visible-but-throttled case.
    if (document.visibilityState === 'hidden') return 'stalled';
    // A save is never worth freezing a tab for, so the frame wait is bounded by the command watchdog as
    // well: `clearTimeout` can be missing on an exotic page, and an un-cleared 150 ms timer must not be
    // the reason `handlingCommands` never releases.
    let timer;
    const outcome = await Promise.race([
      new Promise(resolve => window.requestAnimationFrame(() => resolve('frame'))),
      new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), FRAME_WAIT_MS); }),
      new Promise(resolve => setTimeout(() => resolve('watchdog'), FRAME_WAIT_MS * 10))
    ]);
    if (timer != null && typeof clearTimeout === 'function') clearTimeout(timer);
    return outcome;
  }
  // Round 7, R7-6/R7-4: `ShowText|pysssss` rebuilds its display widget inside `onConfigure` +
  // `requestAnimationFrame`, and that only runs on a full `loadGraphData` — switching tabs back does not
  // re-run it. So the live canvas can be holding a node with NO `widgets_values` key at all, and the next
  // ordinary save writes a file where that node's value has vanished (`save_as_workflow` answered
  // `{saved:true}` while doing exactly that). The signature is unambiguous when compared against the
  // same tab's own history: the node had non-empty `widgets_values` and now has none, and with no widget
  // on screen there is nothing the user could have edited. Keep the last value the tab itself knew
  // instead of writing a hole, and say which nodes were kept.
  function preserveDroppedWidgets(canvas, tracker) {
    const sources = [tracker?.activeState, tracker?.initialState, ...(((tracker?.undoQueue || []).slice()).reverse())]
      .filter(state => Array.isArray(state?.nodes));
    if (!sources.length || !Array.isArray(canvas?.nodes)) return [];
    const kept = [];
    for (const node of canvas.nodes) {
      const live = node?.widgets_values;
      if (Array.isArray(live) && live.length) continue;
      const source = sources.find(state => (state.nodes || []).some(held =>
        String(held?.id) === String(node?.id) && Array.isArray(held?.widgets_values) && held.widgets_values.length));
      if (!source) continue;
      const held = (source.nodes || []).find(item => String(item?.id) === String(node?.id));
      node.widgets_values = clone(held.widgets_values);
      kept.push({ nodeId: String(node.id), type: node.type, chars: charCount(JSON.stringify(held.widgets_values)) });
    }
    return kept;
  }
  // Settle the deferred widgets and make sure the state a save is about to serialize IS the canvas
  // before anything hits the disk (R6-1: `save_as_workflow` wrote a file where ShowText's
  // `widgets_values` had vanished; R6-2: switching tabs lost it the same way).
  async function refreshActiveState(app) {
    const frame = await waitOneFrame();
    let canvas = null;
    try { canvas = rootGraphOf(app).serialize(); } catch { return { ok: false, frame, reason: '画布当前无法序列化，保存的是标签页自己持有的状态' }; }
    const tracker = activeWorkflowOf(app)?.changeTracker;
    if (!tracker) return { ok: false, frame, reason: '该前端的工作流没有 changeTracker，保存走的是它自己缓存的内容' };
    try { tracker.prepareForSave?.(); } catch {}
    const preserved = preserveDroppedWidgets(canvas, tracker);
    let matches = false;
    try { matches = JSON.stringify(tracker.activeState ?? null) === JSON.stringify(canvas); } catch {}
    if (matches) return { ok: true, frame, ...(preserved.length ? { preserved } : {}) };
    try { tracker.activeState = clone(canvas); }
    catch { return { ok: false, frame, reason: '标签页缓存的图状态无法更新，保存的内容可能比画布旧', ...(preserved.length ? { preserved } : {}) }; }
    return { ok: true, frame, takenFromCanvas: true, ...(preserved.length ? { preserved } : {}) };
  }
  // Round 7 (R7-8) and round 6 (R6-3): a subgraph proxy node and the copy of that subgraph in
  // `definitions.subgraphs[].nodes[]` are two stores of the same widget values. Writing the proxy updates
  // the proxy and the queue; neither ComfyUI's save nor anything we do reconciles the definition copy, so
  // the file ends up holding two conflicting values for the same slot (measured on this machine: proxy
  // `77.noise_seed = 777777777` while `definitions[a67caa28…].nodes[86].noise_seed` stayed
  // `432262096973490`). The mapping is readable from the data — a proxy node's `type` IS the subgraph id,
  // and the inner node keeps the exposed widget under the same name — and the claim is only made when the
  // definition copy held exactly the value this write replaced. Nothing is rewritten here: this is the
  // "record it honestly" half of the answer the sixth round asked for.
  function staleDefinitionCopies(app, results) {
    let graphData = null;
    try { graphData = rootGraphOf(app).serialize(); } catch { return []; }
    const subgraphs = (graphData?.definitions?.subgraphs || []).filter(item => Array.isArray(item?.nodes));
    if (!subgraphs.length) return [];
    const found = [];
    for (const { edit, outcome } of results) {
      if (!outcome?.verified) continue;
      const sub = subgraphs.find(item => item.id === edit.node.type);
      if (!sub) continue;
      const name = edit.reroutedFrom || edit.widget.name;
      for (const inner of sub.nodes) {
        const held = inner?.widgets_values_named?.[name];
        if (held === undefined) continue;
        if (String(held) !== String(edit.before ?? '')) continue;   // not the slot this write replaced
        if (String(held) === String(outcome.after ?? '')) continue; // already in step
        found.push({ nodeId: String(edit.node.id), widget: name, subgraphId: sub.id,
          subgraphName: sub.name || null, innerNodeId: String(inner.id), innerType: inner.type || null,
          definitionValue: held ?? null, canvasValue: outcome.after ?? null });
      }
    }
    return found;
  }
  async function executeAction(command) {
    const app = appOf(); const args = command.args || {};
    if (!allowAI) throw new Error('此面板已关闭 AI 操作');
    if (!graphReady(app)) throw new Error('ComfyUI 工作流尚未就绪');
    switch (command.action) {
      case 'save_workflow':
      case 'save_as_workflow': {
        const store = workflowStore(app), active = activeWorkflowOf(app);
        if (!store.saveWorkflow || !store.saveAs) throw new Error('当前 ComfyUI 前端没有工作流保存接口');
        const name = args.name;
        if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.+$/.test(name))) throw new Error('请提供有效的工作流文件名称');
        // Settle the deferred widgets and make sure the tab's cached state IS the canvas before anything
        // is written to disk (R6-1: save_as lost ShowText's value; R6-2: switching tabs lost it too).
        const stateRefresh = await refreshActiveState(app);
        const targetPath = name ? (active.directory || active.path.slice(0, active.path.lastIndexOf('/'))) + '/' + name.replace(/\.json$/i, '') + '.json' : active.path;
        // Which workflow object the bytes on disk came from. The saveAs path switches the tab to the copy
        // before writing it, so `active` is no longer the thing that was saved by the time the hashes are
        // taken — pairing the old tab's cached state with the new tab's canvas reported `canvasMatchesSaved:
        // false` on a save that had just written that exact canvas (round 8, caught live).
        let savedWorkflow = active;
        if (targetPath === active.path) {
          if (command.action === 'save_as_workflow') throw new Error('另存时请使用一个新的文件名称');
          await store.saveWorkflow(active);
        } else {
          await store.syncWorkflows?.();
          if (store.getWorkflowByPath(targetPath)) throw new Error('同名工作流已存在，请使用其他名称；不会覆盖已有文件');
          if (command.action === 'save_workflow' && !active.isPersisted) {
            const history = historyOf(app);
            if (!store.renameWorkflow) throw new Error('当前 ComfyUI 不支持工作流重命名保存');
            await store.renameWorkflow(active, targetPath); saveHistory(app, history);
            await store.saveWorkflow(active);
          } else {
            const target = store.saveAs(active, targetPath);
            savedWorkflow = target;
            try { await openWorkflow(app, target, await workflowData(app, target)); target.changeTracker?.prepareForSave(); await store.saveWorkflow(target); }
            catch (error) {
              if (activeWorkflowOf(app) !== active) await openWorkflow(app, active, await workflowData(app, active));
              if (!target.isPersisted) await store.closeWorkflow?.(target); throw error;
            }
          }
        }
        // Two hashes, never the graph: which moment actually hit the disk. A pack that refills its own
        // parameters after the load (AICG3D measured at ~300 ms) can move the canvas behind this save, so
        // `{saved:true}` alone is not an answer to 「保存的是哪一刻」 (round 5, R5-H).
        let savedStateHash = null, canvasHash = null;
        try { savedStateHash = hashText(fingerprint(savedWorkflow.changeTracker?.activeState ?? null)); } catch {}
        try { canvasHash = hashText(fingerprint(readGraph(app))); } catch {}
        return { saved: true, workflow: describeWorkflow(store, store.activeWorkflow),
          savedStateHash, canvasHash, canvasMatchesSaved: savedStateHash !== null && savedStateHash === canvasHash,
          // Three separate facts, each with its own wording: the value the tab could not see on screen
          // was kept (R7-6), the page was in the background so deferred widgets never built (R7-4/R7-7),
          // and the state could not be reconciled at all (R6-1).
          ...(stateRefresh.preserved ? {
            saveStatePreserved: stateRefresh.preserved,
            saveStatePreservedNote: '这些节点在画布上一个控件都没有（前端延迟重建的控件在切标签路径上不会重跑），但本标签页自己记得它们的值——已按记得的值写进文件，没有留成空洞（R7-6）。要让画布真的显示出来，把这个标签切到前台或刷新页面。'
          } : {}),
          ...(stateRefresh.frame === 'stalled' ? {
            deferredFrame: 'stalled',
            deferredNote: '页面此刻在后台：requestAnimationFrame 在 ' + FRAME_WAIT_MS + 'ms 内没跑，延迟重建的控件本次没有机会建出来。把该标签切到前台再保存更稳。'
          } : {}),
          ...(stateRefresh.ok ? {} : { saveStateWarning: '落盘的内容取自标签页缓存的图状态而非实时画布（' + stateRefresh.reason + '）：如果画布上有节点把自己的值存在延迟重建的组件里，这类值可能没进文件。' }) };
      }
      case 'edit_graph': {
        if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 100) throw new Error('operations 必须包含 1–100 项');
        const graph = app.graph, aliases = new Map(), changed = [];
        const nodeOf = id => { const node = aliases.get(String(id)) || graph.getNodeById(id); if (!node || node.graph !== graph) throw new Error('节点不存在：' + id); return node; };
        const position = value => { if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) throw new Error('position 必须是两个有限数字'); return value; };
        for (const operation of args.operations) {
          if (operation.op === 'create_node') {
            const node = window.LiteGraph?.createNode(operation.nodeType);
            if (!node) throw new Error('节点类型不存在：' + operation.nodeType);
            if (operation.ref && (aliases.has(operation.ref) || graph.getNodeById(operation.ref))) throw new Error('新节点 ref 重复：' + operation.ref);
            if (operation.position) node.pos = position(operation.position);
            if (operation.title) node.title = operation.title;
            graph.add(node); if (operation.ref) aliases.set(operation.ref, node);
            changed.push({ op: operation.op, ref: operation.ref || null, nodeId: String(node.id) });
          } else if (operation.op === 'delete_node') {
            const node = nodeOf(operation.nodeId); graph.remove(node); changed.push({ op: operation.op, nodeId: String(node.id) });
          } else if (operation.op === 'move_node') {
            const node = nodeOf(operation.nodeId); node.pos = position(operation.position); changed.push({ op: operation.op, nodeId: String(node.id) });
          } else if (operation.op === 'connect') {
            const from = nodeOf(operation.fromNodeId), to = nodeOf(operation.toNodeId);
            if (!Number.isInteger(operation.fromSlot) || !from.outputs?.[operation.fromSlot] || !Number.isInteger(operation.toSlot) || !to.inputs?.[operation.toSlot]) throw new Error('连接插槽不存在，请先 list_nodes');
            const link = from.connect(operation.fromSlot, to, operation.toSlot);
            if (!link) throw new Error('连接失败，插槽类型不兼容');
            changed.push({ op: operation.op, linkId: link.id });
          } else if (operation.op === 'disconnect') {
            const node = nodeOf(operation.nodeId);
            if (!Number.isInteger(operation.toSlot) || !node.inputs?.[operation.toSlot]) throw new Error('输入插槽不存在');
            node.disconnectInput(operation.toSlot); changed.push({ op: operation.op, nodeId: String(node.id) });
          } else throw new Error('未知节点操作：' + operation.op);
        }
        app.graph.setDirtyCanvas(true, true); return { changed, nodes: nodes(app) };
      }
      case 'bind_image': {
        const node = app.graph.getNodeById(args.nodeId), found = node?.widgets?.find(widget => widget.name === args.widget);
        if (!found || found.type === 'button') throw new Error('目标图片参数不存在，请先 list_nodes 获取准确 nodeId/widget');
        const { widget, reroutedFrom, resolved } = writeTarget(node, found);
        // An owner that cannot be confirmed is a refused request, decided before anything is
        // written: guessing would put the value into a control the caller never addressed.
        if (!resolved) throw fail('无法确定控件 ' + args.widget + ' 的写入目标', unresolvedTarget(found).hint);
        // The option list is a mutation of the node too, so it waits until ownership is
        // settled — and it is taken back when the write did not land, or a refused attempt
        // would leave a value on the canvas that nothing ever chose.
        const options = widget.options;
        const hadValue = Array.isArray(options?.values) && options.values.includes(args.value);
        if (Array.isArray(options?.values) && !hadValue) options.values.push(args.value);
        const outcome = writeWidget(app, node, widget, args.value);
        if (!outcome.verified && !hadValue) {
          const added = options.values.indexOf(args.value);
          if (added >= 0) options.values.splice(added, 1);
        }
        return { nodeId: String(node.id), widget: widget.name, value: outcome.after, via: outcome.via, verified: outcome.verified,
          ...(outcome.quantized ? { quantized: outcome.quantized } : {}),
          ...(outcome.panelRefreshed !== undefined ? { panelRefreshed: outcome.panelRefreshed } : {}),
          ...(reroutedFrom ? { requestedWidget: reroutedFrom, rerouted: true } : {}),
          ...(outcome.cleared ? { shadowDocsCleared: outcome.cleared } : {}),
          ...(outcome.synced ? { shadowDocsSynced: outcome.synced } : {}),
          ...(outcome.shadowDocsRemaining ? { shadowDocsRemaining: outcome.shadowDocsRemaining } : {}) };
      }
      case 'list_edits': {
        const history = historyOf(app);
        return { workflowPath: activeWorkflowOf(app).path, checkpoints: [...history.undo].reverse().map(item => ({
          checkpointId: item.id, time: item.time, label: item.label,
          nodes: item.nodes ?? (item.workflow?.nodes || []).length,
          // Which half of the chain this entry is: the anchor keeps the graph, the rest keep a patch.
          encoded: item.workflow ? 'full' : 'delta', chars: charCount(JSON.stringify(item))
        })), canRedo: history.redo.length > 0,
          // Say out loud when the canvas cannot be serialized: `get_workflow`, `audit(op=params)` and
          // `run` all need `graph.serialize()`, and a canvas whose subgraph definitions went missing
          // cannot do it — a state `doctor` used to call fine (fourth-round R4-E). Read-only probe, and
          // no clone: `graphToPrompt` is not called here because it can have page-side side effects
          // (fourth-round observation R4-F).
          serializable: canSerialize(app),
          // Undo depth is capped on purpose; say so instead of letting "only 3 checkpoints" look
          // like a bug, and show the chars this workflow currently occupies.
          // `workflowHistoryChars`, not `historyChars`: `draftStorage` reports the sum over every
          // session's snapshots under that name, and the two numbers differ by an order of magnitude
          // on the same canvas (third-round observation 1).
          workflowHistoryChars: historyCharsOf(history), workflowFullChars: historyFullCharsOf(history),
          budget: HISTORY_BUDGET, maxCheckpoints: HISTORY_MAX,
          // The conflict notice tells the user the other page's version is backed up in the browser.
          // A promise nothing can read back is not a backup, so measure the slot here — its size,
          // age and node count, never the graph itself, which would flood the reply.
          conflictBackup: conflictFacts(),
          // Say which steps were retired and why: 「少了几步」 with no explanation reads as a new bug,
          // while the truth is that a known-lossy delta from the old encoder is not restorable.
          ...(history.legacyPatchesDropped ? {
            legacyPatchesDropped: history.legacyPatchesDropped,
            legacyNote: '这条链上有 ' + history.legacyPatchesDropped + ' 个撤销点由本插件旧版的增量编码写下，缺少 definitions 一类顶层字段，恢复它们会让画布无法序列化，因此已剔除；完整快照不受影响。想回到更早的状态请用 load_workflow 读磁盘文件。' } : {}) }
        ;
      }
      case 'restore_edit': {
        const history = historyOf(app);
        const index = history.undo.findIndex(item => item.id === args.checkpointId);
        if (index < 0) throw new Error('当前工作流没有该快照，请先 list_edits');
        let workflow;
        try { workflow = workflowAt(history.undo, index); }
        catch (error) { throw new Error('该快照无法重建（' + error.message + '）：没有改动画布。可以用 list_edits 换一个快照，或 load_workflow 从磁盘整图替换。'); }
        const previousGraph = readGraphOrNull(app);
        await replaceCurrentWorkflow(app, workflow);
        await keepCanvasUsable(app, previousGraph);
        return { restored: true, checkpointId: history.undo[index].id, nodes: nodes(app) };
      }
      case 'list_workflows': {
        const store = workflowStore(app);
        await store.syncWorkflows?.();
        return { activePath: store.activeWorkflow?.path,
          open: (store.openWorkflows || []).map(w => describeWorkflow(store, w)),
          saved: (store.persistedWorkflows || []).map(w => describeWorkflow(store, w)) };
      }
      case 'switch_workflow': {
        const store = workflowStore(app);
        const workflow = store.getWorkflowByPath(args.path);
        if (!workflow) throw new Error('工作流不存在，请先 list_workflows 获取准确 path');
        if (workflow !== activeWorkflowOf(app)) await openWorkflow(app, workflow, await workflowData(app, workflow));
        return { switched: true, workflow: describeWorkflow(store, store.activeWorkflow) };
      }
      case 'new_workflow': {
        const store = workflowStore(app);
        const source = args.sourcePath ? store.getWorkflowByPath(args.sourcePath) : activeWorkflowOf(app);
        if (!source) throw new Error('源工作流不存在，请先 list_workflows');
        const data = await workflowData(app, source);
        data.id = randomUUID(); delete data.revision;
        const name = args.name || (source.filename || 'Workflow').replace(/\.json$/i, '') + ' (Copy)';
        if (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.+$/.test(name)) throw new Error('请使用不含路径分隔符的工作流名称');
        const workflow = store.createNewTemporary(name.replace(/\.json$/i, '') + '.json', data);
        try { await openWorkflow(app, workflow, data); }
        catch (error) { await store.closeWorkflow?.(workflow); throw error; }
        return { created: true, sourcePath: source.path, workflow: describeWorkflow(store, store.activeWorkflow) };
      }
      case 'list_nodes': {
        // filter also matches the node id: "回读 node 195" is the most common lookup, and an
        // id that silently matched nothing (filter only searched type/title) reads as
        // "the node is gone" when it is right there.
        const needle = args.filter ? String(args.filter).toLowerCase() : null;
        const list = nodes(app);
        const hit = needle ? list.filter(n => (n.type + ' ' + n.title + ' ' + n.id).toLowerCase().includes(needle)) : list;
        // The active workflow path rides along: usage notes are keyed by it, and asking the
        // page for the path separately would cost a second round trip on every read.
        return { nodes: hit, nodeCount: list.length, workflowPath: activeWorkflowOf(app)?.path ?? null, ...(needle && !hit.length ? {
          filterHint: 'filter 同时匹配类型 / 标题 / 节点 id，' + JSON.stringify(args.filter) + ' 一个都没命中。当前画布 ' + list.length + ' 个节点，id 是 [' + list.slice(0, 20).map(n => n.id).join(', ') + (list.length > 20 ? ' …' : '') + ']。'
        } : {}) };
      }
      // `includePrompt:false` skips `graphToPrompt()`: packs that patch serialization (AICG3D does) pay
      // a serialization side effect on every read, and a read-only listing should not cause one
      // (fourth-round observation R4-F). The default stays `true` so existing callers see no change.
      case 'get_workflow': {
      // Round 7, R7-5: three tools serialize the graph (`get_workflow` after `readGraph`, the structural
      // audit, and every guard that uses `canSerialize`) while `run`, `audit(op=params)` and the default
      // path here build a prompt with `graphToPrompt()`. A canvas with subgraph proxies but no
      // `definitions` passes the first group and dies in the second, and the caller got a bare litegraph
      // sentence. Same advice as `readGraph`, so the two faces of "half-dead" cannot be mistaken for a
      // dead bridge. The default stays `true` (fourth-round observation R4-F).
      const workflow = readGraph(app);
      if (args.includePrompt === false) return { workflow, prompt: null, promptSkipped: true };
      return { workflow, prompt: await buildPrompt(app) };
    }
      case 'update_nodes': {
        const changes = args.changes;
        const force = args.force === true;
        if (!Array.isArray(changes) || !changes.length || changes.length > 500) throw fail('changes 必须是包含 1–500 项的数组' + argNameHint(args, ['changes']),
          '参数名是 changes，每项结构 {nodeId, widget, value}（nodeId 用 list_nodes 取到的 id）：改好参数名后整批重发，画布尚未改动。');
        const ids = (app.graph._nodes || []).map(n => n.id);
        const edits = changes.map(change => {
          const node = app.graph.getNodeById(change.nodeId);
          if (!node) throw fail('节点不存在：' + change.nodeId,
            '当前画布只有 ' + ids.length + ' 个节点，id 是 [' + ids.slice(0, 20).join(', ') + (ids.length > 20 ? ' …' : '') + ']：先用 list_nodes（可带 filter 按类型/标题过滤）取真实 id，不要复用上一次或别的页面的 nodeId。');
          const found = (node.widgets || []).find(w => w.name === change.widget);
          if (!found || found.type === 'button') {
            const names = (node.widgets || []).filter(w => w.type !== 'button').map(w => w.name);
            // "no such widget" is a lie about a node that has not finished building: `ShowText|pysssss`
            // creates its display widget in a `requestAnimationFrame` after `onConfigure` (measured at
            // ~3.5 s on this machine), so a write aimed at it right after a load came back
            // `widget-not-found` and read like "this node cannot be changed" (round 6, R6-4).
            if (!names.length) throw fail('可编辑参数不存在：' + change.nodeId + '.' + change.widget,
              '节点 ' + change.nodeId + '（' + node.type + '）此刻一个控件都没有。两类原因：(1) 该包的显示控件是在 onConfigure 之后用 requestAnimationFrame 才建出来的（ShowText|pysssss 就是这样，本机实测约 3.5 秒），先 list_nodes 看它是否已出现控件、再等几秒重发同一条写入；(2) 这个节点本来就没有可写控件（注释/显示类，值由上游在运行时填）。等过一次仍为空就按 (2) 处理，换目标节点。');
            throw fail('可编辑参数不存在：' + change.nodeId + '.' + change.widget,
              '节点 ' + change.nodeId + '（' + node.type + '）的可写控件名是 [' + names.join(', ') + ']：用其中之一，或先 list_nodes detail=values 看清 name。');
          }
          const { widget, reroutedFrom, resolved } = writeTarget(node, found);
          if (!resolved) throw fail('无法确定控件 ' + change.widget + ' 的写入目标', unresolvedTarget(found).hint);
          const current = widgetReadback(widget);
          const kindOf = value => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
          if (typeof current === 'number' && (typeof change.value !== 'number' || !Number.isFinite(change.value))) throw fail(widget.name + ' 必须是数字', widget.name + ' 当前是数字 ' + current + '，提交的是 ' + kindOf(change.value) + ' ' + JSON.stringify(change.value) + '：传裸数字，别传字符串或对象。');
          if (typeof current === 'string' && typeof change.value !== 'string') throw fail(widget.name + ' 必须是文本', widget.name + ' 当前是文本，提交的是 ' + kindOf(change.value) + '：传字符串（枚举值也要传原文）。');
          if (typeof current === 'boolean' && typeof change.value !== 'boolean') throw fail(widget.name + ' 必须是布尔值', widget.name + ' 当前是布尔 ' + current + '，提交的是 ' + kindOf(change.value) + '：传 true/false，别传 0/1 或字符串。');
          // `force` (R6-7) relaxes the two domain guards only — the canvas option list and the declared
          // range — because a workflow can legitimately hold a value the canvas no longer offers
          // (measured: `control_after_generate = "default"` is disk-legal and canvas-illegal, and without
          // a force there was no way to put it back except a whole-graph reload). The type check stays:
          // that is a malformed request, not an unfriendly enum. A forced value is still the queue's
          // problem to accept, so the reply says `forced` and `audit(op=params)` will keep flagging it.
          if (!force && Array.isArray(widget.options?.values) && !widget.options.values.includes(change.value)) throw fail(widget.name + ' 的值不在可选项中；' + optionHint(widget.options.values), '当前值是 ' + JSON.stringify(current) + '，可选值见错误正文；若可选项看起来像本地化显示名，说明该 pack 在提交时做转换，改用服务端值即可，确需写列表外的值才传 force:true（会照写，但队列校验不一定接受）。');
          if (!force && typeof change.value === 'number' && ((widget.options?.min != null && change.value < widget.options.min) || (widget.options?.max != null && change.value > widget.options.max))) throw fail(widget.name + ' 超出节点允许的范围', widget.name + ' 允许范围是 [' + (widget.options?.min ?? '-∞') + ', ' + (widget.options?.max ?? '+∞') + ']，当前值 ' + current + '，提交值 ' + change.value + '。要越界写就得传 force:true，但前端会自己夹回或拒绝，先看这个范围是不是节点包写错了。');
          const sameName = (node.widgets || []).filter(w => w.name === change.widget).length;
          // Recorded whether or not `force` was used, so a receipt can say what was written outside the
          // legal domain instead of leaving the caller to remember which values were unusual.
          const outsideOptions = Array.isArray(widget.options?.values) && !widget.options.values.includes(change.value);
          const outOfRange = typeof change.value === 'number'
            && ((widget.options?.min != null && change.value < widget.options.min) || (widget.options?.max != null && change.value > widget.options.max));
          return { node, widget, reroutedFrom, sameName, value: change.value, before: clone(current), outsideOptions, outOfRange };
        });
        // Snapshot the wired-down nodes before the first write, then read the canvas again once
        // the pack's autofill debounce has landed. A batch of pure parameters touches nothing
        // below it, and the wait is skipped entirely.
        const watched = watchDownstream(app, edits.map(edit => edit.node));
        const results = edits.map(edit => ({ edit, outcome: writeWidget(app, edit.node, edit.widget, edit.value) }));
        const followUp = await followUpWrite(app, edits, results.map(entry => entry.outcome), watched);
        const unverified = results.filter(entry => !entry.outcome.verified);
        const shadowed = results.filter(entry => entry.outcome.shadowDocsRemaining);
        const duplicated = results.filter(entry => entry.edit.sameName > 1);
        // N5-b: an input slot that carries a link does not use the widget value at all —
        // `graphToPrompt()` writes the reference ["<node>", <slot>] into `prompt[nodeId].inputs`.
        // Writing such a widget therefore verifies on the canvas and changes nothing in the queue.
        // The reviewer's node 198 is exactly this: `prompt` is wired to a PrimitiveStringMultiline.
        const wiredInputs = results.map(({ edit }) => {
          const slot = (edit.node.inputs || []).find(input => input.name === (edit.reroutedFrom || edit.widget.name));
          return slot && slot.link != null ? { nodeId: String(edit.node.id), widget: edit.widget.name, linkId: slot.link } : null;
        }).filter(Boolean);
        // N8: with a rich reference document the write is valid for exactly one serialization. The
        // pack patches `app.graphToPrompt` to re-sync the widget from the editor DOM
        // (minimax_h3_easy_ui_v4.js:3328 → syncPromptFromEditor at :4343), and the editor was
        // rendered from the old document — measured on this machine: the value survived 3 s of
        // silence, then a `get_workflow(mode=full)`/`audit(op=params)` triggered a serialize and
        // ~1.4 s later the widget was back to the old 5104-character text. The settle cannot catch
        // that (it is not a debounce), so the limit has to be stated where the write is answered.
        const revertedWrites = results.filter(entry => entry.outcome.diverged).map(({ edit, outcome }) => ({
          nodeId: String(edit.node.id), widget: edit.widget.name, docs: outcome.diverged,
          note: '该控件的值由节点包自己的编辑器持有：本次写入只在下一次序列化前有效，'
            + 'pack 的 graphToPrompt 补丁会用编辑器现状把值同步回旧文档。要持久改就写文档本身（该包自带写入口）或用 load_workflow 整图替换。'
        }));
        const warnings = [], nextSteps = [];
        if (unverified.length) {
          warnings.push(unverified.length + ' 项写入后回读与提交值不一致（verified:false）：该控件的状态由前端组件自己持有，写控件不会生效，别把它当成改好了。每条 changed 里的 hint 给出了可执行的替代路径。');
          nextSteps.push(...unverified.map(({ edit }) => 'node ' + edit.node.id + '.' + edit.widget.name + ' → 读该条 hint，别重复同一调用'));
        }
        if (wiredInputs.length) {
          warnings.push(wiredInputs.length + ' 项写进了画布控件，但同名输入槽上有连线（wiredInputs，changed[].inputIsWired=true）：提交时队列里走的是连线来源的值，本次写入不会进队列。');
          nextSteps.push(...wiredInputs.map(item => 'node ' + item.nodeId + '.' + item.widget + ' → 值来自连线 ' + item.linkId + '，改连线另一端的节点，或断开该输入'));
        }
        const unattributed = shadowed.filter(entry => !entry.outcome.diverged);
        if (unverified.length === 0 && shadowed.length) {
          const causes = [];
          if (unattributed.length) causes.push(unattributed.length + ' 份无法确认属于这个控件，所以没有删除');
          const mirrored = shadowed.length - unattributed.length;
          if (mirrored) causes.push(mirrored + ' 份属于刚写的控件、但内含 @引用/对话结构，纯文本没法镜像（见 revertedWrites）');
          warnings.push('写完后节点上仍有与提交值不同步的引用文档（changed[].shadowDocsRemaining）：' + causes.join('；')
            + '。跑一次 run + get_image/audit(op=params) 看提交值；要持久改就用该包自带的写入入口或 load_workflow 整图替换。');
          nextSteps.push(...shadowed.map(({ edit, outcome }) => 'node ' + edit.node.id + '.' + edit.widget.name
            + ' → 文档 ' + outcome.shadowDocsRemaining.join(', ')
            + (outcome.diverged ? ' 属于本控件但含结构，别用纯文本覆盖它' : ' 未归属，别改写控件名去猜它')));
        }
        // 「写好了」and 「用户看得见」are different facts (round 5, R5-C/R5-D): the data layer can hold
        // the new value while the panel the user is looking at still shows the old picture. Report the
        // second dimension instead of letting a verified write answer a question it cannot ask.
        const panelItems = state => results.filter(entry => entry.outcome.panelRefreshed === state)
          .map(({ edit }) => ({ nodeId: String(edit.node.id), widget: edit.widget.name }));
        const panels = { refreshed: panelItems(true), refreshFailed: panelItems(false), noVisiblePanel: panelItems('no-dom-mirror') };
        if (panels.refreshed.length || panels.refreshFailed.length || panels.noVisiblePanel.length) {
          panels.note = 'refreshed=同节点的可见面板已按新值重绘；noVisiblePanel=该节点此刻没有展开的面板（AICG3D 的素材库与段落面板要用户点开才创建），值已进队列，面板打开时会读新值；refreshFailed=找到了面板但它的 setValue 抛错——数据层仍是新值，面板要用户手动重开。';
          if (panels.refreshFailed.length) {
            warnings.push(panels.refreshFailed.length + ' 处面板刷新失败（panels.refreshFailed）：画布与队列已是新值，但用户眼前的面板还是旧内容，别把它当成没写进去而重发同一批。');
            nextSteps.push(...panels.refreshFailed.map(item => 'node ' + item.nodeId + '.' + item.widget + ' → 让用户重开该面板即可，数据不必重写'));
          }
        }
        // The second store of the same value (R7-8): reported, never rewritten.
        const definitionsStale = staleDefinitionCopies(app, results);
        if (definitionsStale.length) {
          warnings.push(definitionsStale.length + ' 处写的是子图代理控件：画布与队列已用新值，但 definitions 里同一槽位还是这次写掉的旧值（definitionsStale）。'
            + '保存到磁盘的文件会同时存在两份矛盾的值——重新加载时以代理 widget 为准（实测会自愈），但直接读这个 JSON 的外部工具读到的是旧值。');
          nextSteps.push(...definitionsStale.map(item => 'node ' + item.nodeId + '.' + item.widget
            + ' → definitions[' + (item.subgraphName || item.subgraphId) + '].nodes[' + item.innerNodeId + '].' + item.widget
            + ' 仍是 ' + JSON.stringify(item.definitionValue) + '；要消除分叉就整图替换（load_workflow 传两份值都改好的 JSON），只改代理控件不会同步它'));
        }
        // `force` was asked for and at least one value really sits outside the canvas options or the
        // declared range: say so once, plainly, because the canvas accepting it is not the same as the
        // queue accepting it (R6-7).
        const forcedItems = results.filter(entry => entry.edit.outsideOptions || entry.edit.outOfRange);
        if (force && forcedItems.length) {
          warnings.push(forcedItems.length + ' 项是 force 写进非法域的（changed[].outsideOptions / outOfRange）：画布照写了，'
            + '但提交时的服务端校验或前端自己的夹取可能不认这个值。run 前用 audit(op=params) 复核，别把它当长期状态。');
          nextSteps.push(...forcedItems.map(({ edit }) => 'node ' + edit.node.id + '.' + edit.widget.name
            + ' → 要长期保留就改磁盘工作流 JSON 后 load_workflow 整图替换，或让该节点包把选项/范围补全'));
        }
        return {
          changed: results.map(({ edit, outcome }) => ({
            nodeId: String(edit.node.id), widget: edit.widget.name,
            ...(edit.reroutedFrom ? { requestedWidget: edit.reroutedFrom, rerouted: true } : {}),
            ...(edit.sameName > 1 ? { sameNameWidgets: edit.sameName } : {}),
            before: edit.before, after: outcome.after, via: outcome.via, verified: outcome.verified,
            ...(outcome.quantized ? { quantized: outcome.quantized } : {}),
            ...(outcome.panelRefreshed !== undefined ? { panelRefreshed: outcome.panelRefreshed } : {}),
            ...(outcome.propertiesStale ? { propertiesStale: outcome.propertiesStale } : {}),
            ...(outcome.cleared ? { shadowDocsCleared: outcome.cleared } : {}),
            ...(outcome.synced ? { shadowDocsSynced: outcome.synced } : {}),
            ...(outcome.diverged ? { shadowDocsDiverged: outcome.diverged } : {}),
            ...(outcome.shadowDocsRemaining ? { shadowDocsRemaining: outcome.shadowDocsRemaining } : {}),
            ...(edit.outsideOptions ? { outsideOptions: true } : {}),
            ...(edit.outOfRange ? { outOfRange: true } : {}),
            ...(wiredInputs.some(item => item.nodeId === String(edit.node.id)
              && item.widget === (edit.reroutedFrom || edit.widget.name)) ? { inputIsWired: true } : {}),
            ...(outcome.hint ? { hint: outcome.hint } : {})
          })),
          ...(wiredInputs.length ? { wiredInputs } : {}),
          ...(panels.note ? { panels } : {}),
          ...(definitionsStale.length ? { definitionsStale } : {}),
          ...(force && forcedItems.length ? { forceUsed: true, forcedCount: forcedItems.length } : {}),
          ...(revertedWrites.length ? { revertedWrites } : {}),
          ...followUp,
          // One sentence per cause actually present, joined — never one clause describing a set with
          // two different reasons. The batch wording used to contradict the per-item notes in the
          // same reply (third-round N11: node 107 diverged, node 198 unattributed, and the batch said
          // "无法确认属于这个控件" for both).
          ...(warnings.length ? { warning: warnings.join(' '), nextSteps } : {}),
          // LiteGraph renames a duplicate (`prompt#1`), so two widgets literally sharing one name
          // means a pack built them another way and which one the panel shows cannot be known from
          // here. Writing the first is what the page's own lookups do, so the write stays — but a
          // `requestedWidget` equal to the asked-for name used to make a reroute indistinguishable
          // from an in-place write, so both facts are now reported.
          ...(duplicated.length ? { ambiguousTargets: duplicated.map(({ edit }) => ({
            nodeId: String(edit.node.id), widget: edit.widget.name, sameName: edit.sameName,
            note: '该节点上有 ' + edit.sameName + ' 个同名控件，写入的是数组里的第一个；面板显示的是不是它无法从数据判断。'
          })) } : {})
        };
      }
      case 'load_workflow': {
        if (!args.workflow || !Array.isArray(args.workflow.nodes) || !Array.isArray(args.workflow.links)) throw new Error('请提供普通 ComfyUI 工作流 JSON（包含 nodes、links），不是 API prompt');
        await replaceCurrentWorkflow(app, args.workflow);
        return { loaded: true, nodes: nodes(app) };
      }
      case 'undo':
      case 'redo': {
        const history = clone(historyOf(app));
        const source = command.action === 'undo' ? history.undo : history.redo;
        if (!source.length) throw new Error('当前工作流已切换或没有可' + (command.action === 'undo' ? '撤销' : '重做') + '的 AI 修改');
        if (history.expectedHash && history.expectedHash !== graphHash(app)) throw new Error(
          '画布在上一次工具写入之后又变了，所以「按顺序撤销」的基准已经不成立。变的人不一定是你：可能是网页上的手动修改，也可能是节点包在加载或序列化之后自己重填了参数（本机实测 AICG3D 的段落解析在加载后约 0.3 秒重写 prompt/秒数/种子，且无视 auto_fill=false）。撤销链本身没有坏——用 list_edits 看快照，再用 restore_edit 明确指定要回到哪一步。');
        const before = readGraph(app);
        // The reverse step goes onto the opposite list; its parent is that list's current tail, so
        // both chains stay rebuildable forward from their own anchor.
        const target = command.action === 'undo' ? history.redo : history.undo;
        const reverse = checkpoint(app, command.action, target.length ? workflowAt(target, target.length - 1) : null);
        try {
          const index = source.length - 1;
          const restoredWorkflow = workflowAt(source, index);
          source.pop();
          await replaceCurrentWorkflow(app, restoredWorkflow);
          // Same guard as `restore_edit`: an undo that hands back a canvas which cannot be serialized
          // is worse than no undo, and the failure used to surface only as the next tool call dying.
          await keepCanvasUsable(app, before);
          target.push(reverse); anchorHistoryHead(target);
          history.expectedHash = graphHash(app); saveHistory(app, history);
        } catch (error) { await replaceCurrentWorkflow(app, before).catch(() => {}); throw error; }
        return { restored: true, nodes: nodes(app) };
      }
      case 'audit_graph': {
        // Only the value audit needs the serialized prompt; a structural check would pay a full
        // graph serialize for evidence it never reads.
        const serialized = args?.op === 'params' ? await promptInputs(app) : {};
        return {
          nodes: (app.graph._nodes || []).map(node => ({
            id: String(node.id), type: node.type, title: node.title || '', mode: node.mode ?? 0,
            widgets: (node.widgets || []).map(widget => ({
              name: widget.name, kind: widgetKind(widget), type: widget.type,
              value: typeof widget.value === 'string' && widget.value.length > 200 ? widget.value.slice(0, 200) + '…' : widget.value ?? null,
              ...(Array.isArray(widget.options?.values) ? { shown: widget.options.values.slice(0, 40) } : {})
            })),
            inputs: (node.inputs || []).map(input => ({ name: input.name, type: input.type, link: input.link ?? null })),
            outputs: (node.outputs || []).map(output => ({ name: output.name, type: output.type, links: output.links || [] })),
            shadowDocs: shadowDocs(node)
          })),
          // The serialized prompt is the only evidence of what the queue would actually carry.
          ...serialized,
          linkCount: linkCount(app.graph),
          // Whether the graph still serializes. A canvas holding subgraph proxies without their
          // `definitions` fails here, and every downstream tool (`get_workflow`, `audit(op=params)`,
          // `run`) with it — the structural audit alone cannot see that, so state it as a fact (R4-E).
          serializable: canSerialize(app),
          workflowPath: activeWorkflowOf(app)?.path ?? null,
          // The canvas autosaves itself into localStorage; when that quota is full the front-end
          // throws a toast and stops persisting for the rest of the session. The tool side cannot
          // prevent it, so it measures it and lets doctor judge it.
          draftStorage: draftStorage()
        };
      }
      // The capability census (round 7 request): what this plugin can and cannot write on THIS canvas,
      // said before a caller tries. Only flags travel — no values, no graphs — so a 177-control workflow
      // costs a few KB. Judgment lives in `lib/audit.js` where it can be tested; the page just reports.
      case 'audit_writes': {
        let subgraphIds = [];
        try { subgraphIds = (rootGraphOf(app).serialize()?.definitions?.subgraphs || [])
          .map(item => String(item?.id)).filter(id => id !== 'undefined'); } catch {}
        return {
          nodes: (app.graph._nodes || []).map(node => ({
            id: String(node.id), type: node.type, title: node.title || '', mode: node.mode ?? 0,
            subgraph: subgraphIds.includes(String(node.type)) ? String(node.type) : null,
            widgetCount: (node.widgets || []).length,
            widgets: (node.widgets || []).map(widget => {
              const options = widget.options || {};
              const list = Array.isArray(options.values) ? options.values : null;
              const kind = widgetKind(widget);
              const slot = (node.inputs || []).find(input => input.name === widget.name);
              return { name: widget.name, kind,
                hasSetter: typeof options.setValue === 'function', hasGetter: typeof options.getValue === 'function',
                serializes: options.serialize !== false,
                inOptions: list ? list.includes(widget.value) : null, optionCount: list ? list.length : null,
                step: stepOf(widget) ?? null,
                wired: slot && slot.link != null ? slot.link : null,
                mirror: (kind === 'hidden' || kind === 'shadowed') ? !!panelMirror(node, widget) : false,
                props: propertyKeysFor(node, widget.name) };
            }),
            shadowDocs: shadowDocs(node)
          })),
          workflowPath: activeWorkflowOf(app)?.path ?? null,
          serializable: canSerialize(app), subgraphCount: subgraphIds.length
        };
      }
      case 'graph_fingerprint': {
        // The cheap answer to 「存的是哪一刻的图」: two hashes, never the graph. A save writes the tab's
        // cached state, and a pack that refills parameters after the save moves the canvas again — the
        // caller has to be able to tell the two moments apart (round 5, R5-H).
        const tracker = activeWorkflowOf(app)?.changeTracker;
        let saved = null, canvas = null;
        try { saved = fingerprint(tracker?.activeState ?? null); } catch {}
        try { canvas = fingerprint(readGraph(app)); } catch { return { ok: false, error: 'unserializable' }; }
        return { ok: true, savedHash: saved ? hashText(saved) : null, canvasHash: hashText(canvas),
          canvasMatchesSaved: saved !== null && saved === canvas, visible: document.visibilityState !== 'hidden' };
      }
      case 'run': {
        const api = apiOf();
        if (!api?.queuePrompt) throw new Error('当前 ComfyUI 前端没有 queuePrompt 接口');
        const prompt = await app.graphToPrompt();
        const result = await api.queuePrompt(0, prompt);
        return { submitted: true, ...result };
      }
      default: throw new Error('未知面板操作：' + command.action);
    }
  }
  async function execute(command) {
    if (command.expiresAt && Date.now() > command.expiresAt) throw new Error('此指令已经过期，未执行；请恢复连接后读取当前状态再操作');
    const writes = ['update_nodes', 'bind_image', 'load_workflow', 'edit_graph', 'restore_edit'];
    if (!writes.includes(command.action)) return executeAction(command);
    const app = appOf();
    if (!allowAI || !graphReady(app)) return executeAction(command);
    const before = snapshot(app), history = clone(historyOf(app)), pending = clone(history);
    // The new entry diffs against the state its predecessor describes, so a parameter write costs
    // the widgets it touched, not another copy of the graph.
    const parent = pending.undo.length ? workflowAt(pending.undo, pending.undo.length - 1) : null;
    pending.undo.push(checkpoint(app, command.action, parent)); capHistory(pending.undo, HISTORY_MAX, command.args?.checkpointId); pending.redo = [];
    // The pre-write and post-write saves can both reclaim keys; the reply has to report the total,
    // or a write that pruned its way through looks like it reclaimed nothing.
    const reclaimed = [];
    const keep = outcome => { if (outcome?.pruned?.removed?.length) reclaimed.push(outcome.pruned); return outcome; };
    const merged = outcome => reclaimed.length
      ? { ...outcome, pruned: { removed: reclaimed.flatMap(item => item.removed), chars: reclaimed.reduce((sum, item) => sum + item.chars, 0) } }
      : outcome;
    let stored = keep(saveHistory(app, pending));
    try {
      const result = await executeAction(command);
      pending.expectedHash = graphHash(app); stored = keep(saveHistory(app, pending));
      const note = historyNote(merged(stored));
      return note && result && typeof result === 'object' ? { ...result, historyStore: note } : result;
    } catch (error) {
      if (fingerprint(snapshot(app)) !== fingerprint(before)) await replaceCurrentWorkflow(app, before);
      saveHistory(app, history); throw error;
    }
  }
  // A page-side exception used to reach the caller as one bare message with no stack,
  // which made "which pack line exploded" unanswerable from the tool side. Report the
  // stack plus the command target, capped so a long traceback cannot flood the caller.
  function commandTarget(command) {
    const args = command.args || {};
    const target = { action: command.action };
    const first = Array.isArray(args.changes) ? args.changes[0] : null;
    if (first) { target.nodeId = first.nodeId; target.widget = first.widget; }
    if (args.nodeId != null) target.nodeId = args.nodeId;
    if (typeof args.widget === 'string') target.widget = args.widget;
    if (typeof args.filter === 'string') target.filter = args.filter;
    return target;
  }
  function commandError(command, error) {
    const e = error instanceof Error ? error : new Error(String(error));
    const reply = { id: command.id, error: e.message || String(e), ...commandTarget(command) };
    if (e.stack) reply.stack = String(e.stack).slice(0, 4000);
    if (e.stage) reply.stage = e.stage;
    if (e.widgetKind) reply.widgetKind = e.widgetKind;
    if (e.hint) reply.hint = e.hint;
    // Third-round N10: this used to assert "a page exception — read the stack, it is probably a
    // custom node setter", but the majority of unhinted failures are ordinary business refusals
    // (a workflow path that does not exist, a missing node) with no stack and no setter involved.
    // A hint that names the wrong cause sends the model to fix something that was never broken, so
    // the fallback states what it actually knows and puts the two branches in check order.
    else reply.hint = '这条失败没有分类提示。先按错误正文判断是哪一类：说「不存在/不可选/超出范围/需要 X」的是校验拒绝，改正参数再发一次；'
      + '带 stack 且指向前端或自定义节点包 setter 的才是页面异常，那种情况别重复同一调用，改用该包自带的写入入口或整图替换（load_workflow）。';
    // Round 7, observation 2: a failed write used to answer with nothing about the tab's state, so the
    // caller could not tell 「画布根本没动」 from 「动了，只是回执死了」 — which matters most for the save
    // path, where the file may already be written. The tab's own flag is the honest answer either way.
    if (['update_nodes', 'bind_image', 'load_workflow', 'undo', 'redo', 'restore_edit', 'edit_graph',
      'save_workflow', 'save_as_workflow'].includes(command.action)) {
      try { reply.dirtyMarked = activeWorkflowOf(appOf())?.isModified === true; } catch {}
    }
    return reply;
  }
  // The front-end decides "this tab has unsaved changes" from mouse, keys and LiteGraph's canvas
  // events — `ChangeTracker.init()` hooks `keydown/keyup/mouseup`, `processMouseUp`,
  // `ContextMenu.close`, and the `litegraph:canvas` before/after-change pair. A bridge write touches
  // none of them, so the canvas changed while the tab still said 「已保存」 and nothing warned before a
  // tab switch or page close (round 5, R5-B). Three APIs, in the order the page itself uses:
  //   graph.incrementVersion()  — LGraph's own counter (`_version`), what serialization compares;
  //   canvas.emitAfterChange()  — the `litegraph:canvas` event ChangeTracker listens to; only `after`
  //     is emitted on purpose, because `captureCanvasState()` returns while `changeCount > 0`, so a
  //     `before` without its matching `after` would wedge the tracker for the session;
  //   tracker.captureCanvasState() — the belt to that brace: it recomputes `activeState` and sets
  //     `isModified` from `graphEqual(initialState, activeState)`.
  // Each is optional and each is guarded: an older front-end without the API, or a tracker belonging to
  // another tab (its inactive-call path only console.errors), must never fail a write that worked.
  function markCanvasDirty(app) {
    let versioned = false, tracked = false;
    try {
      const graph = rootGraphOf(app);
      if (typeof graph?.incrementVersion === 'function') { graph.incrementVersion(); versioned = true; }
      if (typeof app.canvas?.emitAfterChange === 'function') app.canvas.emitAfterChange();
    } catch {}
    try { app.graph?.change?.(); } catch {}
    try {
      const tracker = activeWorkflowOf(app)?.changeTracker;
      if (typeof tracker?.captureCanvasState === 'function') { tracker.captureCanvasState(); tracked = true; }
    } catch {}
    return { versioned, tracked };
  }
  // One command must never own the queue. Round 7 froze the whole bridge for 11.6 minutes on a single
  // await that could not be woken (R7-7), and the loop's only defence had been "this code never hangs".
  // It does not need to be a hang to hurt: a pack setter that spins, or a `loadGraphData` that never
  // resolves, produces the same dead tab. So: race the body against a watchdog, answer the caller with
  // what is actually known ("it may still have completed — re-read before repeating it"), and keep the
  // queue moving. A body that finishes after its deadline is discarded rather than published, because
  // the caller already moved on and a surprise sync is how a late save would overwrite the user's graph.
  const COMMAND_TIMEOUT_MS = 25000;
  const STALLED = Symbol('stalled');
  async function runCommandBody(command) {
    let previousAuthority, commandEditSequence;
    try {
      if (graphReady(appOf())) await syncWorkflow(appOf());
      const writesCanvas = ['update_nodes', 'bind_image', 'load_workflow', 'undo', 'redo', 'restore_edit', 'edit_graph', 'save_workflow', 'save_as_workflow', 'switch_workflow', 'new_workflow', 'run'].includes(command.action);
      if (writesCanvas && allowAI && graphReady(appOf())) {
        previousAuthority = localAuthority; localEdit(true); commandEditSequence = editSequence;
      }
      const result = await execute(command);
      if (command.abandoned) return { id: command.id, result, abandoned: true };
      // A write must always be published, whatever the counter says about it.
      if (writesCanvas) {
        // Tell the page its own tab is now dirty before publishing, so the tab badge, the
        // leave-page warning and the next `graphChanged` all see this write (R5-B). What gets
        // reported is the front-end's own answer — `isModified` — not whether our calls ran.
        const marks = markCanvasDirty(appOf());
        const saved = command.action === 'save_workflow' || command.action === 'save_as_workflow';
        const modified = activeWorkflowOf(appOf())?.isModified === true;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          result.dirtyMarked = saved ? false : modified;
          if (!saved && !modified) result.dirtyNote = marks.tracked
            ? '标签页没有标为「未保存」，通常是这次写入与已保存的内容本来就相同；要落盘仍需 save_workflow。'
            : '这个前端没有变更追踪接口，标签页不会显示「未保存」：画布内容已改，切标签或关页面前请先 save_workflow。';
        }
        forceSync = true; await syncWorkflow(appOf());
      }
      return { id: command.id, result };
    }
    catch (e) {
      if (commandEditSequence !== undefined && commandEditSequence === editSequence) localAuthority = previousAuthority;
      return commandError(command, e);
    }
  }
  async function settleCommand(command) {
    let timer = null;
    const work = runCommandBody(command);
    const outcome = await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve(STALLED), COMMAND_TIMEOUT_MS);
      // A watchdog timer must not be the reason a page cannot go idle: it is cleared on the normal path.
      if (timer && typeof timer.unref === 'function') timer.unref();
    })]);
    // `typeof` first: a page (or a fake) without `clearTimeout` must not turn a finished command into a
    // ReferenceError inside the loop.
    if (timer != null && typeof clearTimeout === 'function') clearTimeout(timer);
    if (outcome !== STALLED) return outcome;
    command.abandoned = true;
    stalledCommands += 1;
    work.then(late => { if (late?.result !== undefined) completed.set(command.id, late); }).catch(() => {});
    return commandError(command, new Error('这条 ' + command.action + ' 在 ' + Math.round(COMMAND_TIMEOUT_MS / 1000)
      + ' 秒内没有返回，已按超时收尾。注意它可能仍在页面里执行完（保存类动作尤其可能已经落盘），所以不要立刻重发同一个动作：'
      + '先 list_workflows / get_workflow / list_edits 复核当前状态。反复卡在同一条通常是页面里有等不到的浏览器回调（后台标签页的 requestAnimationFrame 不触发），F5 刷新该页面即可恢复；本桥接的其余命令不会被它堵住。'));
  }
  async function handleCommands() {
    if (busy || handlingCommands) return;
    handlingCommands = true;
    try {
      while (commandQueue.length) {
        const command = commandQueue.shift();
        let reply = completed.get(command.id);
        if (!reply) {
          reply = await settleCommand(command);
          if (reply) completed.set(command.id, reply);
          if (completed.size > 200) completed.delete(completed.keys().next().value);
        }
        await send('result', reply);
      }
    } catch (e) { notify({ ready: false, error: e.message, stack: String(e?.stack || '').slice(0, 2000) }); }
    finally { handlingCommands = false; }
  }
  async function connectCommands() {
    if (typeof EventSource !== 'function') return;
    clearTimeout(reconnectTimer); commandStream?.close();
    try {
      const response = await fetch(bridgeBase + '/__dsh_comfyui/bootstrap');
      const data = await response.json();
      if (!response.ok || data.bridgeProtocol !== bridgeProtocol) throw new Error('同步代码已更新，请刷新 ComfyUI 页面');
      if (token !== data.token) { token = data.token; initialized = false; revision = 0; }
      const stream = commandStream = new EventSource(bridgeBase + '/__dsh_comfyui/commands?' + new URLSearchParams({ token, clientId, sessionId, bridgeProtocol }));
      stream.onopen = () => { forceSync = true; send('state', {}).catch(() => {}); };
      stream.onmessage = event => { try { commandQueue.push(...JSON.parse(event.data).commands || []); handleCommands(); } catch {} };
      stream.onerror = () => { stream.close(); reconnectTimer = setTimeout(connectCommands, 2000); };
    } catch (error) { notify({ ready: false, error: error.message }); reconnectTimer = setTimeout(connectCommands, 2000); }
  }
  document.addEventListener?.('pointerdown', event => { if (event.isTrusted) { pointerHeld = true; localEdit(true); } }, true);
  document.addEventListener?.('pointermove', event => { if (event.isTrusted && pointerHeld) localEdit(); }, true);
  for (const name of ['pointerup', 'pointercancel']) document.addEventListener?.(name, event => { if (event.isTrusted) { pointerHeld = false; localEdit(); } }, true);
  document.addEventListener?.('keydown', event => { if (event.isTrusted) { heldKeys.add(event.code || event.key); localEdit(true); } }, true);
  document.addEventListener?.('keyup', event => { if (event.isTrusted) { heldKeys.delete(event.code || event.key); localEdit(); } }, true);
  document.addEventListener?.('drop', event => { if (event.isTrusted) localEdit(true); }, true);
  document.addEventListener?.('paste', event => { if (event.isTrusted) localEdit(true); }, true);
  document.addEventListener?.('wheel', event => { if (event.isTrusted) localEdit(true); }, { capture: true, passive: true });
  for (const name of ['input', 'change']) document.addEventListener?.(name, event => { if (event.isTrusted) localEdit(); }, true);
  document.addEventListener?.('focusout', () => { forceSync = true; }, true);
  const clearInteraction = () => { pointerHeld = false; heldKeys.clear(); };
  window.addEventListener('blur', clearInteraction);
  document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') clearInteraction(); forceSync = true; send('state', {}).catch(() => {}); handleCommands(); });
  window.addEventListener('pagehide', () => { commandStream?.close(); clearTimeout(reconnectTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { forceSync = true; connectCommands(); } });
  try { pruneStaleStorage(); } catch {}
  connectCommands();
  poll();
})();
