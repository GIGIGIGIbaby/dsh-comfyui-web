# AGENTS.md

[简体中文](AGENTS.md) | [English](AGENTS.en.md)

给在本仓库里动手的 AI 代理。这里只写要求，不写背景故事。

---

## 这份文件与伴随 PR 的关系

本文件与 #10 的功能改动已一起合并，适用于 0.5.13 及以后的版本。

| 伴随 PR | 内容 |
| --- | --- |
| #10 `feat/tool-face-hardening` | 运行时改动的归并总入口（#6/#7/#8 各自开过的分支已作为「被取代」关闭，并入此处）：`update_nodes` 通过控件自己的 setter 写入并回 `via` / `verified` 证明写进去了；画布写租约——同一时刻只让一个对话写共享画布；`doctor` 一次判定环境可用、错误信息带下一步；`audit(op=graph\|params\|writes)`——这张图能不能跑、我的值服务器会不会拒、以及这台画布上到底有哪些控件是本插件写得动的 |

环境检查先用 `doctor`；需要定位连接问题时，再查 `server_info` 的具体字段。

---

## §1 先读什么

| 要改什么 | 先读 |
| --- | --- |
| 工具清单、参数、描述文案 | `lib/tool-definitions.js`（`MCP_TOOLS` + `MCP_INSTRUCTIONS`） |
| 工具调用的总入口、错误封装 | `lib/mcp.js`（`callComfyTool`） |
| 注入到 ComfyUI 页面里执行的脚本 | `bridge.js`（在浏览器里跑，改完必须刷新 ComfyUI 页面） |
| 画布读写、桥接握手、HTTP 代理 | `lib/runtime.js` |
| 插件装配、`mcp__comfyui__*` 注册 | `lib/index.js`、`lib/host.js` |
| 回复投影（超大返回只回摘要） | `lib/projection.js` |
| 生成任务跟踪与完成通知 | `lib/generation.js`、`lib/completion-job.js` |

改动前先看 `test/` 里对应的 `*.test.mjs`：这些测试就是当前行为契约，不要为了让新代码通过而改断言（除非断言本身是错的，且在 commit 里说明理由）。

---

## §2 「装好了」的判据

三条同时满足才算装好，缺一条都不能对用户说「已安装 / 已修好」。

先调 `doctor`，要求 `kind === "ok"`，且没有失败项（`failedChecks` 可以缺省）。下面的连接字段用于排查失败原因。

**1. 服务与面板都连上了。** 调 `server_info`，要求：`connected: true`；`clients` 至少一项，且该项 `ready: true`、`allowAI: true`、`connected: true`；`heartbeatAgeMs` 是秒级数字（几秒以内说明页面还在轮询）。

**2. 页面里的脚本与插件同版本。** `server_info.bridgeVersion` / `bridgeProtocol` 是宿主启动时从 `package.json` 和 `bridge.js` 读进来的；`syncClients[]` 是各面板上报的实况。取与本对话 `clients[]` 同一 `clientId` 的那一项，要求 `bridgeVersion` 等于 `server_info.bridgeVersion`、`refreshRequired` 为 `false`。`refreshRequired` 只挂在 `syncClients[]` 上（`clients[]` 没有这个字段），判定的是页面汇报的 `bridgeProtocol` 与宿主不一致；它为 `true` 说明页面还跑着旧脚本，**必须刷新 ComfyUI 页面**（面板里的「刷新」即可），只重启 dsh 不够。它不看版本号，版本要自己比。

**3. 真的读得出来、也写得进去。**

```text
list_nodes { filter: "<节点类型>", detail: "values" }   → 能拿到该节点的 widgets（名称、类型、当前值）
update_nodes { changes: [{ nodeId: "<id>", widget: "<name>", value: <新值> }] }
  → 回 changed[]，其中 verified 为 true；after 等于提交值或回执明确说明的量化值
list_nodes { filter: "<节点类型>", detail: "values" }   → 回读，值确实变了
```

三条不满足时先修环境（重启 dsh、刷新页面、在面板里打开 MCP 开关），**不要跳过体检直接改画布**。

---

## §3 改完 / 装完的规矩

先看改动落在哪一层再动手，四层各自加载，不要一律重启 dsh：

| 改了什么 | 最小动作 | 怎么验证 |
| --- | --- | --- |
| `client.js`（面板 UI） | 刷新 dsh 网页。它就是浏览器加载的那份 bundle：`package.json` 的 `./client` 导出直接指向该文件，仓库里没有构建步骤，页面加载时读的就是磁盘上这份 | 面板上出现新文案 / 新行为；不用重启 dsh |
| `lib/*.js`、`cordis.patch.yml`、`package.json` 的 `dsh` 字段或 `version` | 让宿主重新加载插件；没有重载入口时重启 dsh。这些模块只在插件加载时 `import` 一次，`version` 也只在启动时读入 | 启动日志无报错；`server_info` 的 `bridgeVersion` 已是新版本号，改动后的工具 / 字段可见 |
| `bridge.js`（注入 ComfyUI 页面的脚本） | 先重启 dsh，再刷新 ComfyUI 页面。宿主启动时把它读进内存，之后 `/__dsh_comfyui/bridge.js` 发的都是内存里那份，只刷新页面换不掉；页面里已在跑的旧脚本也只有刷新才会重跑 | `server_info` 返回的 `syncClients[]` 中，同一 `clientId` 那一项的 `bridgeVersion` 等于 `server_info.bridgeVersion`，`refreshRequired` 为 `false` |
| `comfy-extension.js`（写进 ComfyUI 扩展目录的加载脚本） | 重启 dsh 重写该文件，再刷新 ComfyUI 页面；用 `customNodesDir` 时装的是自定义节点，要重启 ComfyUI | `clients[]` 里有本对话的条目，`ready` / `allowAI` / `connected` 均为 `true` |

面板里的「刷新」只重载内嵌的 ComfyUI iframe；在普通浏览器里另开的 ComfyUI 标签页要各自刷新页面，否则它们上报的还是旧脚本。

- **版本与协议的三处同步校验**：版本只修改 `package.json` 的 `version`，宿主把它注入 `bridge.js` 的版本占位符或 bootstrap，页面不再硬编码版本。只有桥接协议发生不兼容变化时，才同时更新 `bridge.js` 的 `bridgeProtocol` 与 `lib/runtime.js` 的 `BRIDGE_PROTOCOL`。按上表重新加载并刷新页面后检查握手。
- **超时不等于取消**：旧操作未结束或回滚完成前，桥接会拒绝后续写入并暂停跨页同步，`list_nodes` / `list_workflows` / `list_edits` 仍可检查。等待结束后重新读取状态；一直不结束则刷新页面，并核对已发送到服务端的请求。不要在等待期间手动修改画布。
- **不要用「服务端下发的 bridge.js 与磁盘文件不一致」判定跑的是旧代码**：`lib/runtime.js` 在提供该脚本时会把占位 token 替换成真实 token，字节差是正常的。判断版本请看 `server_info` 的 `bridgeVersion`，或 `GET /__dsh_comfyui/bootstrap` 返回的 `bridgeVersion` / `bridgeProtocol`。
- **每次重启 dsh，桥接 token 都会变**：`<DSH_HOME>/comfyui/connection.json` 里的 token 随之更新，不要复用上一次的 token 调 MCP。
- **改完跑测试**：`npm test`（= `node --test test/*.test.mjs`）必须全绿。只在某条测试确实过时、且 commit 里写清理由时改断言。
- **写操作要看回执再下结论**：`update_nodes` 的 `after` 与你提交的值不一致、或节点/控件报不存在时，不要向用户报告「已改好」；先 `list_nodes` 取真实 `nodeId` 与控件名，再重发。
- **临时探针脚本用 `scripts/tmp-*` 或仓库根 `.tmp-*` 命名，用完删掉**，不要提交。验证时若生成了临时工作流文件（例如 `save_as_workflow` 用的验证副本），验证完一并删除。
- **文档里引用的工具名必须在 `lib/tool-definitions.js` 里存在**：桥接动作名与对外工具名不一定相同，写文档前对照 `MCP_TOOLS` 核对，别让代理去调一个还没注册的名字。

---

## §4 给用户的一段提示词

把下面这段直接粘给新的会话即可：

```text
你在维护 dsh-comfyui-web 插件。动手前先做三件事：
1. 先调 doctor，要求 kind=ok；失败时用 server_info 确认三件事：connected=true、clients 里有一项 ready/allowAI/connected 都为 true、
   同一 clientId 在 syncClients 里那一项的 refreshRequired=false（clients 上没有这个字段）。
   任一不满足就先修环境（重启 dsh、刷新 ComfyUI 页面、检查面板 MCP 开关），别急着改画布。
2. 读写节点参数一律用 list_nodes（filter 填节点类型）和 update_nodes；
   找不到节点就先用 list_nodes 取真实 nodeId，不要复用上一轮调用里的 id。
3. 写完检查 changed[].verified=true，再用 list_nodes detail="values" 回读确认，之后向用户报告结果。

改 client.js 刷新 dsh 网页即可；改 lib/*.js 或 package.json 要重新加载插件（没有重载入口就重启 dsh）；
改 bridge.js 要重启 dsh 再刷新 ComfyUI 页面。
```

---

## 附录：合并伴随 PR 之后的差异

以下能力已随 #10 合并，正文的判据已采用这些回执：

- **`doctor`**：一次调用判定「现在能不能用」，返回 `kind: "ok" | "fail"`，并逐项列出判据（MCP 开关、ComfyUI 是否可达、桥接页面是否活着、心跳、版本、AI 权限、写租约、画布能否执行、有无落盘节点、当前工作流、队列）。**§2 的判据 1～2 应改用 `doctor` 的 `kind === "ok"` 且 `failedChecks` 为空**，比逐字段读 `server_info` 便宜。
- **`update_nodes` 回 `via` / `verified`**：`verified: true` 表示写入后回读确认过；`verified: false` 表示该控件由前端组件自己持有状态、写控件没生效，回执里的 `hint` 会给出替代路径（写 shadow 源 / 用该包自带的写入入口 / 改磁盘 JSON 再 `load_workflow`）。**此时 §2 的判据 3 应改用 `verified`，并明确：`verified` 为 false 或缺失时不得报告「已改好」。**
- **`lease`**：画布写权在一段对话手里，其他对话的写操作会被拒。看到租约被占用时不要强行接管，先问用户。
- **`audit(op="graph"|"params"|"writes")`**：改完参数或连线，先 `audit` 再 `run`；`verdict` 为 `refuted` 时先修再提交。`graph` 判结构（画布能否序列化、必填连线是否缺失——只算产物节点的依赖链上缺失的那些、有没有落盘节点），`params` 按 `object_info` 判值，`writes` 是下面那份可写性普查。
- **`audit(op="writes")` 是普查，而 `list_nodes` 已经不再预判**：页面按控件报事实（有没有 setter、会不会序列化、这个输入槽是否被连线占用、是不是子图代理节点、控件还没建出来、写回去会被量化到多少），工具把每个控件判成写得动 / 有条件 / 写不了，并给出原因。`list_nodes` 以前那个 `writable: ok|risky|no` 字段已经删掉了：服务器会不会接受某个值，本来就无法从画布推出来，一个看起来很确定的标签只会让代理跳过普查。
- **`update_nodes(force: true)`** 只放宽两项确实「不友好」的判定——画布没提供的枚举值、以及超出声明范围的数字；JSON 类型错误照旧拒绝。被 force 写进去的项会标上 `changed[].outsideOptions` / `outOfRange`，回执给出 `forceUsed` / `forcedCount`。画布接受这个值不等于队列会接受，run 之前要用 `audit(op="params")` 复核。
- **`update_nodes(saveAfterWrite: true)`** 走前端自己的保存路径，并回答「落盘的是哪一刻」：`saved.savedStateHash`（真正被序列化出去的那份状态）、`canvasHashAtSave`，以及保存之后另取指纹算出的 `driftedAfterSave`。节点包在加载后重填自己的参数是常态，所以单一个 `{saved: true}` 说明不了任何事。
