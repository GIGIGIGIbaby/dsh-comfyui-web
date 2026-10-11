# dsh-comfyui-web

来回切换页面太麻烦了，直接把 ComfyUI 嵌入 dsh 网页端，通过 MCP 操控，实时预览每个操作。

## 安装

先准备好 [dsh](https://github.com/deepseek-ai/deepseek-harness)、pnpm 和本机 ComfyUI。当前适配 dsh `0.2.0-rc.2`，Node.js 22 及以上。

```sh
dsh plugin --profile web add github:mangfufu/dsh-comfyui-web
```

<details>
<summary>首次安装：配置 ComfyUI 目录</summary>

在 `~/.dsh/comfyui/config.json` 中填写 ComfyUI 前端目录。Windows 的 `~` 是你的用户目录，下面的路径请换成自己机器上的实际路径；Linux 同样填写实际目录。

```json
{
  "url": "http://127.0.0.1:8188",
  "frontendExtensionsDir": "D:/ComfyUI/python/Lib/site-packages/comfyui_frontend_package/static/extensions"
}
```

首次安装或更新插件后，保存工作流，刷新已打开的 ComfyUI 原网页和 dsh 内的 ComfyUI 面板。

</details>

## 使用

### 1. 打开 ComfyUI

1. 先启动 ComfyUI。
2. 启动 `dsh web`，打开 `http://127.0.0.1:3080`。
3. 进入对话，点击右上角 **ComfyUI**。

![在 dsh 右侧打开 ComfyUI 工作流界面](docs/images/comfyui-panel.png)

左边和 AI 对话，右边就是 ComfyUI。可以直接改节点、查看预览，不用在两个网页之间来回切换。

### 2. 确认连接地址

![ComfyUI 地址与 MCP 设置](docs/images/comfyui-settings.png)

地址默认是 `http://127.0.0.1:8188`。如果换了端口，打开 **MCP 设置**，重新填写地址，点击 **保存并连接**。

MCP 默认开启，dsh 内不用再单独配置。需要时可以关闭，也可以复制配置给其他本机 AI 客户端使用。

### 3. 直接下指令

在同一条对话里告诉 AI，例如：

> 读取当前工作流，优化正向提示词，把步数设为 20，生成一张图并查看结果。

![AI 修改工作流并生成图片，聊天与 ComfyUI 同时显示结果](docs/images/comfyui-ai-preview.png)

AI 通过 MCP 修改当前工作流，操作和生成预览都能在右侧实时看到，结果也可以直接在对话里查看。生成结束后会通知原对话，无需反复等待或查询，不会强行打断当前回复。

想撤销就说「撤销刚才的修改」。顶部的 `− / +` 可以调整界面大小，**刷新** 可以重新加载 ComfyUI 页面。

## 友情链接

[LINUX DO](https://linux.do/) · [插件介绍帖](https://linux.do/t/topic/3009797)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mangfufu/dsh-comfyui-web&type=Date)](https://www.star-history.com/?repos=mangfufu%2Fdsh-comfyui-web&type=date)
