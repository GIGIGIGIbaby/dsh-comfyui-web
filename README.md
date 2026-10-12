# dsh-comfyui-web

在 dsh 里直接使用 ComfyUI，让 AI 通过 MCP 操作当前工作流。改提示词、调参数、运行生图，节点变化和生成预览都在同一个页面里看得见。

## 安装

需要已安装的 [dsh](https://github.com/deepseek-ai/deepseek-harness)、pnpm 和本机 ComfyUI。当前适配 dsh `0.2.0-rc.2`，Node.js 22 及以上。

```sh
dsh plugin --profile web add github:mangfufu/dsh-comfyui-web
```

<details>
<summary>首次安装时，填写 ComfyUI 前端目录</summary>

创建或编辑 `~/.dsh/comfyui/config.json`，将示例中的前端目录替换为本机实际路径。Windows 的 `~` 是用户目录；Linux 同样填写实际路径。

```json
{
  "url": "http://127.0.0.1:8188",
  "frontendExtensionsDir": "D:/ComfyUI/python/Lib/site-packages/comfyui_frontend_package/static/extensions"
}
```

首次安装或更新后，先保存工作流，再刷新已打开的 ComfyUI 原网页和 dsh 内的面板。

</details>

## 使用

### 1. 启动并打开

1. 先启动 ComfyUI。
2. 启动 `dsh web`，打开 `http://127.0.0.1:3080`。
3. 进入对话，点击右上角 **ComfyUI**。

![ComfyUI 嵌入 dsh 右侧面板](docs/images/comfyui-panel.png)

左边聊需求，右边改节点、看预览。手动编辑和 AI 操作都落在当前工作流上。

### 2. 确认连接地址

默认连接 `http://127.0.0.1:8188`。如果更换了端口，打开 **MCP 设置**，修改地址后点击 **保存并连接**。

![连接地址与 MCP 开关](docs/images/comfyui-settings.png)

MCP 默认开启，dsh 已自动接入。这里也能关闭 MCP，或复制配置给其他本机 AI 客户端使用。

### 3. 让 AI 操作工作流

直接在当前对话里告诉 AI：

> 读取当前工作流，优化正向提示词，保留现有模型和节点连接，生成一张图并查看效果。

![AI 修改提示词并生成图片](docs/images/comfyui-ai-preview.png)

提示词直接写入当前节点，右侧查看生成预览，左侧查看出图结果。AI 做了哪些修改，画布上实时可见。

AI 通过插件读取图片后，生成结果会显示在本次回复正文下方，收起工具过程后仍可查看。
多张图片同样按原比例显示，空间不够时自动换行，不会缩成小方块。

生成完成会自动通知原对话，正在进行的回复不会被强行中断。

想撤销就说「撤销刚才的修改」。界面大小用顶部 `− / +` 调整，点击 **刷新** 可重新加载 ComfyUI。

顶部 **图片对话中模糊** 开关默认关闭。开启后，点击模糊图先显示清晰图片，再点可查看大图；鼠标悬停时，左上角的灰色小眼睛可切换模糊/清晰。关闭开关后，图片正常显示，不出现模糊提示和小眼睛。只影响本插件返回到对话中的图片，开关会记住。

## 友情链接

[LINUX DO](https://linux.do/) · [插件介绍帖](https://linux.do/t/topic/3009797)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mangfufu/dsh-comfyui-web&type=Date)](https://www.star-history.com/?repos=mangfufu%2Fdsh-comfyui-web&type=date)
