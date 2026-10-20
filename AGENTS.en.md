# AGENTS.md

[简体中文](AGENTS.md) | [English](AGENTS.en.md)

For AI agents working in this repository. Requirements only, no backstory.

---

## How this file relates to the accompanying PRs

This file documents the following changes, and ships as a **separate PR so it can be reviewed on its own**:

| Companion PR | What it adds |
| --- | --- |
| `fix/dom-widget-write-verification` | `update_nodes` writes through the widget's own setter and reports `via` / `verified` to prove the write stuck |
| `feat/write-lease` | a canvas write lease, so two conversations cannot stomp the live canvas |
| `feat/audit-family` | `audit(op=graph\|params)`: can this graph run, and will the server reject my values |
| `feat/tool-face-hardening` | `doctor` decides in one call whether the environment is usable; errors carry the next step |

**Merge advice:**

- If those PRs get merged, **this PR is worth merging together with them** -- §2's criteria should then move to `doctor` (see the appendix), which is stronger than the `server_info` criteria described here.
- If they do not get merged, **treat this PR as reference only**: the body is written against the tool face that actually exists on `main`, and never sends an agent after a tool `main` does not have.

---

## §1 What to read first

| Changing | Read first |
| --- | --- |
| tool list, arguments, description text | `lib/tool-definitions.js` (`MCP_TOOLS` + `MCP_INSTRUCTIONS`) |
| the single entry point for tool calls, error wrapping | `lib/mcp.js` (`callComfyTool`) |
| the script injected into the ComfyUI page | `bridge.js` (runs in the browser; reload the page after changing it) |
| canvas reads and writes, bridge handshake, HTTP proxy | `lib/runtime.js` |
| plugin assembly, `mcp__comfyui__*` registration | `lib/index.js`, `lib/host.js` |
| reply projection (oversized results come back as summaries) | `lib/projection.js` |
| generation tracking and completion notifications | `lib/generation.js`, `lib/completion-job.js` |

Read the matching `*.test.mjs` under `test/` before you change anything: those tests are the current behaviour contract. Do not edit an assertion just to make new code pass (unless the assertion itself is wrong, and the commit says why).

---

## §2 When it counts as installed

All three must hold. Until then, do not tell the user it is installed or fixed.

**1. The server and a panel are both connected.** Call `server_info` and require: `connected: true`; at least one entry in `clients` with `ready: true`, `allowAI: true` and `connected: true`; `heartbeatAgeMs` in the low seconds (that is the page still polling).

**2. The script in the page matches the plugin.** `server_info.bridgeVersion` / `bridgeProtocol` are what the host read from `package.json` and `bridge.js` at startup; `syncClients[]` is what each panel reports. Take the entry whose `clientId` matches the `clients[]` entry for this conversation and require its `bridgeVersion` to equal `server_info.bridgeVersion` and its `refreshRequired` to be `false`. `refreshRequired` lives on `syncClients[]` only (`clients[]` has no such field) and compares the page's reported `bridgeProtocol` with the host's; when it is `true` the page is still running the old script and **the ComfyUI page has to be reloaded** (the panel's Refresh button does it); restarting dsh is not enough. It does not look at the version string, so compare versions yourself.

**3. It really reads and really writes.**

```text
list_nodes { filter: "<node type>", detail: "values" }   -> widgets for that node (name, type, current value)
update_nodes { changes: [{ nodeId: "<id>", widget: "<name>", value: <new value> }] }
  -> returns changed[], where after equals the value you sent
list_nodes { filter: "<node type>", detail: "values" }   -> read back; the value really changed
```

When one of the three fails, fix the environment first (restart dsh, reload the page, turn the MCP switch on in the panel). **Never skip the check and start editing the canvas.**

---

## §3 Rules after you change or install something

Find the layer the change lives in before touching anything. Each layer loads on its own -- do not restart dsh on reflex:

| Changed | Minimum action | What to verify |
| --- | --- | --- |
| `client.js` (panel UI) | Refresh the dsh web page. This file is the bundle the browser loads: `package.json`'s `./client` export points at it, there is no build step, and the page reads this file from disk when it loads it | The new label or behaviour shows up in the panel; no dsh restart needed |
| `lib/*.js`, `cordis.patch.yml`, or `package.json`'s `dsh` fields / `version` | Load the plugin again; when the host offers no reload entry, dsh must be restarted. These modules are imported once when the plugin loads, and `version` is read at startup | Startup log is clean; `server_info.bridgeVersion` is the new version, and the changed tool / field is visible |
| `bridge.js` (the script injected into the ComfyUI page) | Restart dsh first, then reload the ComfyUI page. The host reads the script into memory at startup and serves that copy from `/__dsh_comfyui/bridge.js`, so a page reload alone cannot pick up the new file; the old script already running in the page only re-runs on a reload | In `server_info`, the `syncClients[]` entry with the same `clientId` has a `bridgeVersion` equal to `server_info.bridgeVersion` and `refreshRequired` of `false` |
| `comfy-extension.js` (the loader written into ComfyUI's extension directory) | Restart dsh so the file is rewritten, then reload the ComfyUI page; with `customNodesDir` it is a custom node, so restart ComfyUI | `clients[]` has an entry for this conversation with `ready` / `allowAI` / `connected` all `true` |

The panel's Refresh button only remounts the embedded ComfyUI iframe; ComfyUI tabs opened in a normal browser must each reload the page, or they keep reporting the old script.

- **A version bump touches three places**: `package.json`'s `version`, `bridgeVersion` in `bridge.js`, and the protocol number (`bridgeProtocol` in `bridge.js` plus `BRIDGE_PROTOCOL` in `lib/runtime.js`). Criterion 2 only sees it after the reload and page refresh above; miss one and criterion 2 never passes.
- **Do not judge "old code is still running" from a byte difference between the served `bridge.js` and the one on disk**: `lib/runtime.js` substitutes a placeholder token with the real one when it serves that script, so the difference is expected. Read the version from `server_info`'s `bridgeVersion`, or from `GET /__dsh_comfyui/bootstrap` (`bridgeVersion` / `bridgeProtocol`).
- **The bridge token changes on every dsh restart**: the token in `<DSH_HOME>/comfyui/connection.json` is replaced, so do not reuse the previous token when calling MCP.
- **Run the tests after a change**: `npm test` (= `node --test test/*.test.mjs`) has to be green. Edit an assertion only when it is genuinely stale, and say why in the commit.
- **Report a write only from its receipt**: if `update_nodes` returns an `after` that differs from what you sent, or reports a missing node or widget, do not tell the user it is changed. Call `list_nodes` for the real `nodeId` and widget names, then resend.
- **Name throwaway probe scripts `scripts/tmp-*` or `.tmp-*` at the repo root, and delete them afterwards**; do not commit them. If verification created a temporary workflow file (for example a `save_as_workflow` copy), delete that too.
- **A tool name quoted in documentation must exist in `lib/tool-definitions.js`**: the bridge action name and the public tool name are not always the same. Check against `MCP_TOOLS` before writing docs, so no agent is sent after a name that was never registered.

---

## §4 A prompt to hand the user

Paste this into a fresh session as-is:

```text
You are maintaining the dsh-comfyui-web plugin. Before touching anything:
1. Call server_info and confirm three things: connected=true; one entry in clients has ready/allowAI/connected
   all true; the syncClients entry with the same clientId has refreshRequired=false (clients has no such field).
   If any of them fails, fix the environment first (restart dsh, reload the ComfyUI page, check the MCP switch
   in the panel) -- do not start editing the canvas.
2. Read and write node parameters with list_nodes (filter takes the node type) and update_nodes only;
   when a node is missing, get the real nodeId with list_nodes first. Never reuse an id from an earlier turn.
3. After writing, read the value back with list_nodes detail="values" and confirm it really changed before
   reporting the result to the user.

Changing client.js only needs a dsh page refresh; changing lib/*.js or package.json means loading the plugin
again (restart dsh when there is no reload entry); changing bridge.js needs a dsh restart and then a ComfyUI
page reload.
```

---

## Appendix: what changes once the companion PRs land

After the PRs in the table are merged, the tool face gains the following. Update this file's criteria accordingly at that point:

- **`doctor`**: decides "can I work right now" in one call, returning `kind: "ok" | "fail"` plus every criterion as a value (MCP switch, ComfyUI reachable, bridge page alive, heartbeat, version, AI permission, write lease, graph executable, disk output node, active workflow, queue). **§2 criteria 1-2 should then switch to `doctor`'s `kind === "ok"` with an empty `failedChecks`**, which is cheaper than reading `server_info` field by field.
- **`update_nodes` returns `via` / `verified`**: `verified: true` means the value was read back after writing; `verified: false` means the widget holds its own state in a front-end component and the write did not land, and the receipt's `hint` gives the alternative (write its shadow source, use the pack's own write entry point, or edit the JSON on disk and `load_workflow`). **§2 criterion 3 should then use `verified`, and state plainly that `verified: false` or a missing `verified` may not be reported as "changed".**
- **`lease`**: the canvas write right lives with one conversation; writes from others are refused. When the lease is taken, do not grab it by force -- ask the user first.
- **`audit(op="graph"|"params")`**: after changing parameters or links, run `audit` before `run`; when `verdict` is `refuted`, fix first and submit later.
- **`list_nodes`'s `kind` / `writable`**: predicts whether `update_nodes` can write a widget (`ok` / `risky` / `no`); `risky` ones are usually DOM widgets whose state a front-end component owns.
