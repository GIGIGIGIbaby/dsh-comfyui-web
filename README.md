# dsh-comfyui-web

在 dsh 网页里使用 ComfyUI：编辑节点、预览生成，让 AI 直接操作当前工作流。

## 安装

先准备好 [dsh](https://github.com/deepseek-ai/deepseek-harness)、pnpm 和本机 ComfyUI。当前适配 dsh `0.2.0-rc.2`，Node.js 22 及以上。

```sh
dsh plugin --profile web add github:mangfufu/dsh-comfyui-web
```

在 `~/.dsh/comfyui/config.json` 中填写 ComfyUI 地址和前端目录；Windows 的 `~` 是你的用户目录。示例中的目录请换成自己机器上的实际路径：

```json
{
  "url": "http://127.0.0.1:8188",
  "frontendExtensionsDir": "D:/ComfyUI/python/Lib/site-packages/comfyui_frontend_package/static/extensions"
}
```

启动 ComfyUI，再启动 dsh：

```sh
dsh web
```

打开 `http://127.0.0.1:3080`，进入对话，点击顶部 **ComfyUI**。首次安装后，保存工作流并刷新已打开的 ComfyUI 原网页。

## 使用

- **MCP 设置**：默认开启，可开关 MCP、修改 ComfyUI 地址、复制其他 AI 客户端的配置。
- **刷新**：重新加载 ComfyUI 页面，刷新前保存工作流。
- **缩放**：点击 `− / +` 调整，点击百分比恢复 100%。可拖宽右侧面板或最大化。
- **同步**：在原网页或 dsh 面板修改工作流，另一页会同步更新。

直接在同一条 dsh 对话中告诉 AI：

> 读取当前工作流，把正向提示词改成一只橘猫，步数设为 20，先别生成。

> 运行当前工作流一次，查看生成结果。

> 撤销刚才的修改。

其他本机 AI 客户端：打开 **MCP 设置 → 其他 AI 客户端的 MCP 配置**，复制到该客户端，使用时保持 dsh 运行。

## 友情链接

[LINUX DO](https://linux.do/)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mangfufu/dsh-comfyui-web&type=Date)](https://www.star-history.com/?repos=mangfufu%2Fdsh-comfyui-web&type=date)
