# AIGC workspace

工作区只保留两项能力：**Luma**（对话 / 智能体 / 图像工作台）与 **ComfyUI**（本地图像生成后端）。
Luma 通过 MCP 调用 ComfyUI，两者都跑在本机。

## 目录

- `luma/` — Luma 全栈服务：HTTP API、Web 前端、Agent、工具、SQLite 数据与自带运行时。
  详见 [`luma/docs/`](luma/docs/00-architecture.md)。
- `ComfyUI/` — ComfyUI Desktop 的共享模型、输入与输出目录。
- `workflows/` — 本地图像生成与编辑工作流的可读导出，供在 ComfyUI 里手动打开参考。
  Luma 的 MCP 已内联同等工作流，不读取这些文件。
- `run/` — 当前 ComfyUI 进程的日志。

## 启动

双击即可，三个脚本都只操作 `luma/`：

| 脚本 | 作用 |
| --- | --- |
| `一键启动-Luma.cmd` | 重建前端、后台拉起服务、顺带把 ComfyUI 预热起来、开 Cloudflare 隧道、打印访问码 |
| `一键关闭-Luma.cmd` | 停止服务、隧道、MCP 子进程与 ComfyUI |
| `显示-Luma访问码.cmd` | 从加密保险箱里读出访问码 |

ComfyUI 冷启动要一分钟左右，启动脚本让它和前端构建并行跑，不会拖慢 Luma 本身；
它没起来时 Luma 照常可用，只是本地图像工具会报「图片服务不可用」。

启动脚本会自动停掉上一个实例，重复运行是安全的。只想本机跑、不开隧道时：

```powershell
powershell -ExecutionPolicy Bypass -File luma\scripts\start.ps1 -Local
```

单独管理 ComfyUI：`luma\scripts\comfy.ps1` 启动（已在跑就直接返回），
`luma\scripts\stop.ps1 -IncludeComfy` 关闭。

## 地址

- 本机：<http://127.0.0.1:8090/>
- 公网：走 Cloudflare Tunnel，域名由各自部署决定，隧道配置在 `luma/runtime/cloudflared/config.yml`（未纳入版本控制）。
- ComfyUI 保持私有，只监听 `127.0.0.1:8188`，不对外暴露。

登录需要访问码，并可在「设置 → 安全」里开启 TOTP 两步验证。对外暴露的完整说明见
[`luma/docs/05-remote-access.md`](luma/docs/05-remote-access.md)。

## 提示词

系统提示词随仓库发布，不是运行时才生成的：全局提示词与工具提示词都在
`luma/src/server/prompts/defaults.ts`，作为首次启动的种子写入数据库。
默认的全局提示词是一套成人向创作人设，clone 下来即生效；改在「设置 → 提示词」，
或直接改这个文件后重建数据库。

记忆、文件库、对话与 provider 密钥都只存在本机 `luma/data/`（已被 `.gitignore` 排除），
不随仓库分发。

## 依赖

Luma 自带 Node 24 与 cloudflared，位于 `luma/runtime/`（未纳入版本控制，约 150 MB）。
系统 PATH 上不需要另外安装 Node。
