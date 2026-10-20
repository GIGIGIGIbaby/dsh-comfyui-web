# AGENTS.md

[简体中文](AGENTS.md) | [English](AGENTS.en.md)

给在本仓库里动手的 AI 代理。这里只写要求，不写背景故事。

---

## 这份文件与伴随 PR 的关系

本文件是下面几项功能改动的配套文档，**单独成一个 PR 便于评审**：

| 伴随 PR | 内容 |
| --- | --- |
| `fix/dom-widget-write-verification` | `update_nodes` 通过控件自己的 setter 写入，并回 `via` / `verified` 证明写进去了 |
| `feat/write-lease` | 画布写租约：同一时刻只让一个对话写共享画布 |
| `feat/audit-family` | `audit(op=graph\|params)`：这张图能不能跑、我的值服务器会不会拒 |
| `feat/tool-face-hardening` | `doctor` 一次判定环境可用、错误信息带下一步 |

**合并建议**：

- 如果上面这些 PR 被合并了，**本 PR 推荐一起合并**——此时 §2 的判据应改用 `doctor`（见文末附录），比本文描述的 `server_info` 判据更强。
- 如果那些 PR 没有合并，**本 PR 只作为参考**：正文按当前 `main` 的实际工具面写，不会引用 `main` 上还不存在的工具。

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

**1. 服务与面板都连上了。** 调 `server_info`，要求：`connected: true`；`clients` 至少一项，且该项 `ready: true`、`allowAI: true`、`connected: true`；`heartbeatAgeMs` 是秒级数字（几秒以内说明页面还在轮询）。

**2. 页面里的脚本与插件同版本。** `server_info.bridgeVersion` / `bridgeProtocol` 是宿主启动时从 `package.json` 和 `bridge.js` 读进来的；`syncClients[]` 是各面板上报的实况。取与本对话 `clients[]` 同一 `clientId` 的那一项，要求 `bridgeVersion` 等于 `server_info.bridgeVersion`、`refreshRequired` 为 `false`。`refreshRequired` 只挂在 `syncClients[]` 上（`clients[]` 没有这个字段），判定的是页面汇报的 `bridgeProtocol` 与宿主不一致；它为 `true` 说明页面还跑着旧脚本，**必须刷新 ComfyUI 页面**（面板里的「刷新」即可），只重启 dsh 不够。它不看版本号，版本要自己比。

**3. 真的读得出来、也写得进去。**

```text
list_nodes { filter: "<节点类型>", detail: "values" }   → 能拿到该节点的 widgets（名称、类型、当前值）
update_nodes { changes: [{ nodeId: "<id>", widget: "<name>", value: <新值> }] }
  → 回 changed[]，其中 after 等于提交值
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

- **改版本号要三处同步**：`package.json` 的 `version`、`bridge.js` 里的 `bridgeVersion`、以及协议号（`bridge.js` 的 `bridgeProtocol` 与 `lib/runtime.js` 的 `BRIDGE_PROTOCOL`）。按上表重新加载并刷新页面对判据 2 才生效；任何一处漏掉，判据 2 永远不过。
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
1. 调 server_info 确认三件事：connected=true、clients 里有一项 ready/allowAI/connected 都为 true、
   同一 clientId 在 syncClients 里那一项的 refreshRequired=false（clients 上没有这个字段）。
   任一不满足就先修环境（重启 dsh、刷新 ComfyUI 页面、检查面板 MCP 开关），别急着改画布。
2. 读写节点参数一律用 list_nodes（filter 填节点类型）和 update_nodes；
   找不到节点就先用 list_nodes 取真实 nodeId，不要复用上一轮调用里的 id。
3. 写完用 list_nodes detail="values" 回读确认值真的变了，再向用户报告结果。

改 client.js 刷新 dsh 网页即可；改 lib/*.js 或 package.json 要重新加载插件（没有重载入口就重启 dsh）；
改 bridge.js 要重启 dsh 再刷新 ComfyUI 页面。
```

---

## 附录：合并伴随 PR 之后的差异

合并上表那几个 PR 后，工具面会多出以下能力，届时本文的判据应相应升级：

- **`doctor`**：一次调用判定「现在能不能用」，返回 `kind: "ok" | "fail"`，并逐项列出判据（MCP 开关、ComfyUI 是否可达、桥接页面是否活着、心跳、版本、AI 权限、写租约、画布能否执行、有无落盘节点、当前工作流、队列）。**§2 的判据 1～2 应改用 `doctor` 的 `kind === "ok"` 且 `failedChecks` 为空**，比逐字段读 `server_info` 便宜。
- **`update_nodes` 回 `via` / `verified`**：`verified: true` 表示写入后回读确认过；`verified: false` 表示该控件由前端组件自己持有状态、写控件没生效，回执里的 `hint` 会给出替代路径（写 shadow 源 / 用该包自带的写入入口 / 改磁盘 JSON 再 `load_workflow`）。**此时 §2 的判据 3 应改用 `verified`，并明确：`verified` 为 false 或缺失时不得报告「已改好」。**
- **`lease`**：画布写权在一段对话手里，其他对话的写操作会被拒。看到租约被占用时不要强行接管，先问用户。
- **`audit(op="graph"|"params")`**：改完参数或连线，先 `audit` 再 `run`；`verdict` 为 `refuted` 时先修再提交。
- **`list_nodes` 的 `kind` / `writable`**：能预判某个控件能不能被 `update_nodes` 写成功（`ok` / `risky` / `no`），`risky` 的多为前端自持状态的 DOM 控件。