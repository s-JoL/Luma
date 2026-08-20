# AIGC workspace

工作区只保留两项能力：**Luma**（对话 / 智能体 / 图像与视频工作台）与 **ComfyUI**（本地生成后端）。
Luma 通过 `comfy-workflow` adapter 调用本机 ComfyUI（`127.0.0.1:8188`）。

## 目录

- `luma/` — Luma 全栈服务：HTTP API、Web 前端、Agent、工具、SQLite 数据与自带运行时。
  从 [`luma/docs/00-product.md`](luma/docs/00-product.md) 读起。
- `ComfyUI/` — ComfyUI Desktop 的共享模型、输入与输出目录。
- `workflows/` — 本地图像生成与编辑工作流的可读导出，供在 ComfyUI 里手动打开参考。
  Luma 自己跑的图在 `luma/data/workflows/`，由 `comfy-workflow` adapter 读取。
- `run/` — 当前 ComfyUI 进程的日志。

## 启动

**Windows**：双击即可，三个脚本都只操作 `luma/`：

| 脚本 | 作用 |
| --- | --- |
| `一键启动-Luma.cmd` | 重建前端、后台拉起服务、顺带把 ComfyUI 预热起来、开 Cloudflare 隧道、打印访问码 |
| `一键关闭-Luma.cmd` | 停止服务、隧道、MCP 子进程与 ComfyUI |
| `显示-Luma访问码.cmd` | 从加密保险箱里读出访问码 |

ComfyUI 冷启动要一分钟左右，启动脚本让它和前端构建并行跑，不会拖慢 Luma 本身；
它没起来时 Luma 照常可用，只是需要本地后端的那个生成工具会失败，并在错误里说明
该启动什么。

启动脚本会自动停掉上一个实例，重复运行是安全的。只想本机跑、不开隧道时：

```powershell
powershell -ExecutionPolicy Bypass -File luma\scripts\start.ps1 -Local
```

单独管理 ComfyUI：`luma\scripts\comfy.ps1` 启动（已在跑就直接返回），
`luma\scripts\stop.ps1 -IncludeComfy` 关闭。

**macOS / Linux**：同一组脚本的 POSIX 版本，用 `bash` 调，不依赖执行位。

```bash
bash luma/scripts/start.sh --local     # 只听 127.0.0.1，不开隧道
bash luma/scripts/stop.sh
bash luma/scripts/show-code.sh
```

这里没有 ComfyUI 预热：`comfy.ps1` 知道 Windows 上 Desktop 装在哪，POSIX 上没有
对应的启动器，ComfyUI 由人自己开。Node 也不同——见下面的「依赖」。

## 地址

- 本机：<http://127.0.0.1:8090/>
- 公网：走 Cloudflare Tunnel，域名由各自部署决定，隧道配置在 `luma/runtime/cloudflared/config.yml`（未纳入版本控制）。
- ComfyUI 保持私有，只监听 `127.0.0.1:8188`，不对外暴露。

登录需要访问码，并可在「设置 → 安全」里开启 TOTP 两步验证。隧道与鉴权见
[`luma/docs/01-architecture.md`](luma/docs/01-architecture.md)。

## 提示词

系统提示词随仓库发布，不是运行时才生成的：全局提示词与工具提示词都在
`luma/src/server/prompts/defaults.ts`，作为首次启动的种子写入数据库。
默认的全局提示词是一套成人向创作人设，clone 下来即生效；改在「设置 → 提示词」，
或直接改这个文件后重建数据库。

记忆、文件库、对话与 provider 密钥都只存在本机 `luma/data/`（已被 `.gitignore` 排除），
不随仓库分发。

## 依赖

Node 24 以上（服务端用 `node:sqlite`）。

Windows 开发机上它随仓库一起装在 `luma/runtime/`，连 cloudflared 一起，约 150 MB，
未纳入版本控制，系统 PATH 上不需要另外装 Node。那份构建是 Windows 的，所以在
macOS 和 Linux 上 `scripts/common.sh` 会跳过它，改用 PATH 上的 Node 24；
`runtime/`、`run/`、`ComfyUI/` 都按机器安装，仓库里没有它们不等于哪里坏了。
