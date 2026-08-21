# 架构

一个 Node 进程，两份 SQLite，数据全在 `data/`。Web 静态包和 `/v1` 由同一进程
送出。没有 Python 服务、没有 Postgres、没有独立的 MCP 监督进程。

## 进程

```
luma (node)                                :8090
├── http         /v1 + dist/ 静态包
├── agent        Runtime → pi Agent
├── generation   adapters + job 队列
├── capabilities 记忆 / 文件检索 / 搜索 / 编码 / skills / MCP
├── rag          extract → chunk → embed → 检索
└── store        node:sqlite
```

入口：`src/server/main.ts`。`scripts/start.ps1`（Windows）/ `start.sh`（macOS、
Linux）重建前端、拉起进程、可选开 Cloudflare 隧道并打印访问码。`-Local` 只听
`127.0.0.1`，不开隧道。预热 ComfyUI 只有 Windows 那条路做：`comfy.ps1` 知道
Desktop 装在哪，POSIX 上没有对应的启动器，ComfyUI 由人自己开。

环境变量：`LUMA_ROOT`、`LUMA_DATA_DIR`、`LUMA_HOST`（默认 `127.0.0.1`）、
`LUMA_PORT`（默认 `8090`）、`LUMA_TRUST_PROXY`。

Node 要 24 以上（`node:sqlite`）。`luma/runtime/node` 是随开发机装的 Windows
构建，gitignored，不在系统 PATH 上；`scripts/common.sh` 先问它版本再用它，所以
在 macOS 和 Linux 上它会被跳过，改用 PATH 上的 Node 24。`runtime/`、`run/`、
`ComfyUI/` 都是按机器安装的，仓库里没有不等于哪里坏了。

## 目录

```
data/
├── luma.sqlite      应用状态
├── sessions.sqlite  pi 的会话树（单独文件，避免和设备 session 表撞名）
├── master.key       32 字节，0600，解 secrets
├── files/           上传与手写文档
├── skills/          <name>/SKILL.md
├── workflows/       ComfyUI API 格式图；加一个 workflow 是加文件，不是发版
└── assets/          生成的图和视频、sidecar、缩略图

runtime/             自带 Node 与 cloudflared，gitignored
run/                 pid 与日志
dist/                Vite 打好的 Web 包
```

运行时只写 `data/` 和 `run/`。删 `data/` 等于出厂。

ComfyUI 保持私有，只听 `127.0.0.1:8188`。Luma 通过 `comfy-workflow` adapter
调它，不把它暴露到公网。

## 鉴权

单用户。首次启动生成访问码（Crockford base32），进加密保险箱，启动时打印。
可选 TOTP。

`POST /v1/auth/token` 换 token。token 哈希进 `sessions` 表；响应里同时给 JSON
和 HttpOnly cookie（`SameSite=Strict`）。之后 Bearer 或 cookie 都行。用 cookie
做非安全方法时必须同源（`Sec-Fetch-Site` / `Origin`），这样 `<img src="/v1/images/…">`
能过，CSRF 不能。

空闲 30 天、硬上限 180 天。7 天后可轮换。改访问码、开关 TOTP、踢会话要 step-up
（再提交访问码，已开 TOTP 还要验证码）。失败次数按来源计，不按整站计。

公网：Cloudflare Tunnel 或 Tailscale。隧道前要设 `LUMA_TRUST_PROXY=1`，否则
所有请求看起来都来自 127.0.0.1，限流和 HTTPS 判断会坏。ComfyUI 不走隧道。

## 两份数据库

**`sessions.sqlite`** 是对话的真相：pi 的 entry 树、lane、压缩点。编辑/重试是
把 lane 移到某条 entry 的父节点，被放弃的枝留在树上。

**`luma.sqlite`** 是应用状态。其中 `messages` 是当前枝的投影，给客户端读；
`seq` 对客户端，`entry_id` 指回树上的点。rewind 之后整表重投影。

密钥只写不读：`secrets` 表是 AES-GCM 密文，HTTP 只回答「有没有」。

下面的 `CREATE TABLE` 列名必须和 `src/server/store/schema.sql` 一致
（`scripts/audit-doc-schema.ts` 会核对）。类型在文档里从简。

```sql
CREATE TABLE meta (
  key, value
)

CREATE TABLE settings (
  key, value, updated_at
)

CREATE TABLE secrets (
  name, iv, tag, ciphertext, updated_at
)

CREATE TABLE sessions (
  token_hash, device, created_at, last_seen, expires_at
)

CREATE TABLE providers (
  id, name, base_url, auth, enabled, sort_order, created_at, updated_at
)

CREATE TABLE models (
  id, provider_id, name, model, enabled, pinned, agent_tool, reasoning, input,
  context_window, max_tokens, thinking_level, thinking_level_map, api_mode,
  kind, ops, params, librechat_compat, system_prompt, temperature, top_p,
  pricing, compat, sort_order, created_at, updated_at
)

CREATE TABLE mcp_servers (
  id, title, enabled, command, url, args, env, headers, sort_order,
  created_at, updated_at
)

CREATE TABLE conversations (
  id, title, model_id, archived, created_at, updated_at
)

CREATE TABLE messages (
  id, conversation_id, seq, role, content, entry_id, created_at
)

CREATE TABLE runs (
  id, conversation_id, status, model_id, error, created_at, updated_at
)

CREATE TABLE events (
  seq, run_id, conversation_id, type, data, created_at
)

CREATE TABLE approvals (
  id, run_id, conversation_id, tool_name, action, summary, detail, status,
  created_at, updated_at
)

CREATE TABLE memories (
  key, value, tokens, updated_at
)

CREATE TABLE files (
  id, name, mime, bytes, disk_path, sha256, conversation_id, source,
  embedding_status, embedding_error, page_count, width, height, created_at
)

CREATE TABLE chunks (
  id, file_id, idx, page, text
)

CREATE TABLE embeddings (
  chunk_id, file_id, model, dim, vector
)

CREATE TABLE image_assets (
  image_id, mime, width, height, provider, model, parent_image_ids, created_at
)

CREATE TABLE video_assets (
  video_id, mime, width, height, duration_ms, poster_image_id, provider, model,
  parent_image_ids, created_at
)

CREATE TABLE jobs (
  id, kind, op, model_id, model_name, conversation_id, status, progress, note,
  params, sources, assets, error, provider_job_id, created_at, started_at,
  finished_at, updated_at
)
```

`chunks_fts` 是 FTS5 虚表，跟 `chunks` 同步，不单独建业务表。

几个关系：

- `files` 是图书馆。文档按 sha256 去重并走 RAG；图和视频是 `img_` / `vid_`
  id，进图库，不切块。
- `image_assets` / `video_assets` 是血缘（模型、父图、时长、封面）。字节在
  `assets/files`。
- `jobs` 一行就是一次生成的全部状态。客户端读这一行，不重放事件。
  `conversation_id` 可空、不是外键：创作台的活不属于某段对话，删对话不能把
  还在图书馆里的作品记录一起删掉。
- `events` 是 run 的增量日志，客户端用 `Last-Event-ID` / `after=` 续。流式
  delta 在 run 结束后约 120 秒剪掉。

## 配置

没有 `.env` 业务配置。能在界面改的都在 `settings` JSON 和表行里。提示词种子在
`src/server/prompts/defaults.ts`，第一次启动写入，之后人拥有。

## 怎么验

三层，越往下越贵：

| 命令 | 要什么 | 管什么 |
|---|---|---|
| `npm run typecheck` | 无 | 类型 |
| `npm run audit` | 无：不联网、不开端口、不碰 `data/` | 十三个静态检查：死导出、文档与 `schema.sql` 对齐、工具 schema 收窄、提示词装配顺序、发给供应商的 payload 形状、markdown 管线、session 树与压缩、鉴权与限流、skills、生成 adapter 与 job 队列（假后端）、搜索 adapter（假后端）、编码工具、审批 |
| `npm run e2e` | 一个跑着的实例 + 一个聊天模型 | 三十几项真实 HTTP 验收：登录、流式、续流、幂等、停止、编辑/重试/继续、记忆、文件检索、审批、分页、搜索、错误信封、job 队列 |

`audit` 里每个脚本自己造数据、自己收拾，所以它是改完随手跑的那一层。`e2e` 打的是
`audit-db.ts --clone` 出来的那份克隆（8095、`data-audit`、`AUDITCODE`），不是 8090
上的真实实例。

可选的东西一律 skip，不是 fail：没有搜索密钥、本地 ComfyUI 没启动、没配视频
模型，都跳过。只有一个聊天密钥的机器也应该跑出全绿。

故意留在链外、要手动跑的：

| 脚本 | 为什么在链外 |
|---|---|
| `audit-models.ts` | 每个已配置的对话模型真跑一轮，要密钥要花钱 |
| `verify-generation-live.ts` | 真出图/出视频，看一眼质量用的，花钱 |
| `security-check.ts` | 暴力破解的减速曲线本身就是几十秒，还会留下冷却计数 |
| `audit-bisect.ts`、`audit-db.ts`、`reclaim-db.ts`、`tidy.ts`、`access-code.ts` | 工具，不是断言 |

`LUMA_E2E_VIDEO=1` 才会真渲染一段视频；`LUMA_E2E_STUB=1` 强制用
`stub-openai.ts` 顶替模型，`LUMA_E2E_LIVE=1` 强制用真模型。
