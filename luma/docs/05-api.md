# HTTP

所有能力都是 `/v1` 上的端点。Web 和 iOS 只许走这里。下面按代码里的路由列出，
字段以 `src/shared/types.ts` 和各 `routes/*.ts` 为准。

前缀 `/v1`。除健康检查和登录外全部要鉴权。

## 公开

| 方法 | 路径 | |
|---|---|---|
| GET | `/health` | `{ ok, version }` |
| GET | `/auth/challenge` | 是否要 TOTP、是否锁住 |
| POST | `/auth/token` | `{ accessCode, totp?, deviceName? }` → token + cookie |
| POST | `/auth/logout` | 作废当前会话 |

## 启动包

| GET | `/bootstrap` | 模型、供应商、默认值、profile、能力、MCP 状态、提示词、记忆建议 key、上传上限 |

客户端冷启动先拉这个。

## 对话

| 方法 | 路径 | |
|---|---|---|
| GET | `/conversations` | `limit`、`cursor`=`updatedAt` |
| POST | `/conversations` | 开一个；解析模型/profile |
| GET | `/conversations/search` | 跨对话搜转写 |
| GET/PATCH/DELETE | `/conversations/:id` | 详情含 `activeRun.resumeSeq` |
| GET | `/conversations/:id/messages` | `after=` 增量，或 `limit`/`before` 分页 |
| POST | `/conversations/:id/runs` | `{ text, attachments?, modelId?, fromSeq? }`。`Idempotency-Key`。202 `{ runId, seq }`，`seq` 是本 run 产生事件之前的水位，续流用它，不要用 0 |
| POST | `/conversations/:id/continue` | 接着写 |
| POST | `/conversations/:id/stop` | 中止 |
| POST | `/conversations/:id/steer` | 往进行中的 run 插一句：当前这一轮跑完后插入并多跑一轮（见 `02-agent.md`）。没有在跑的 run 时 409 |
| GET | `/runs/:id` | 状态 |
| GET | `/runs/:id/events` | SSE；`Last-Event-ID` 或 `after=`。`?mode=poll` 长轮询。事件 `seq` 单调，已应用的丢掉 |
| GET | `/conversations/:id/approvals` | 待批（`status=all` 看全部） |
| GET | `/approvals` | 全局待批 |
| POST | `/approvals/:id` | `{ approved }` |

Run 事件包括 `message.delta/start/end`、工具、`tool.approval.*`、
`context.compacted`、`conversation.title`、`job.progress`、终端 `run.*`。

手机后台会掐 SSE：切到 `mode=poll` 做一轮，记下 `lastSeq`，回来再用 `after=`
续。编辑/重试之后从 `after=-1` 整段重拉。

## 生成

| 方法 | 路径 | |
|---|---|---|
| GET | `/studio/tools` | 生成操作（含 schema）。只有 adapter 模型 |
| GET | `/studio/gallery` | `{ items: GeneratedAsset[], total, offset, limit }` |
| POST | `/studio/run` | 与 `POST /jobs` 同一份 body，同步等到结束，返回 job 行 |
| GET | `/jobs` | 可按 `status`、`conversationId` 滤 |
| POST | `/jobs` | 提交，202 返回 job 行 |
| GET | `/jobs/:id` | 整行状态 |
| POST | `/jobs/:id/cancel` | |
| GET | `/jobs/:id/events` | SSE 推同一行；没有事件日志，不用 `Last-Event-ID` |

新客户端走 `/jobs` + gallery 的 `GeneratedAsset`。`POST /studio/run` 是同步
等待的同一形状，不是另一套返回。

## 文件与媒体

| 方法 | 路径 | |
|---|---|---|
| GET | `/files` | `kind`、`source`、`q`、分页 |
| POST | `/files` | multipart。文档 sha256 去重；图/视频登记为资产 |
| POST | `/files/notes` | 建一篇 markdown |
| GET/PUT | `/files/:id/text` | 读改文本 |
| GET | `/files/:id`、`/files/:id/content` | 元数据 / 字节 |
| DELETE | `/files/:id` | |
| POST | `/files/:id/reindex` | |
| POST | `/files/search` | RAG |
| GET | `/images/:imageId` | 字节；`?w=320|640|1280` 缩略图 |
| GET | `/videos/:videoId` | 字节，Range |
| GET | `/images/:id/provenance`、`/videos/:id/provenance` | |

## 记忆 / 设置 / 安全

记忆：`GET /memory`，`PUT/DELETE /memory/:key`。

供应商：`GET/POST /providers`，`PATCH/DELETE /providers/:id`，
`PUT/DELETE /providers/:id/key`，`GET /providers/:id/models`（拉它的在线目录）。

模型：`GET/POST /models`，`PATCH/DELETE /models/:id`，`POST /models/bulk`，
`PUT /models/default`。

能力：`GET/PATCH /capabilities`，`PUT/DELETE /capabilities/secrets/:name`
（`tavily` | `embedding`）。

提示词：`GET /prompts`、`/prompts/defaults`，`PUT /prompts`。

MCP：`GET/POST /mcp/servers`，`PATCH/DELETE /mcp/servers/:id`，
`POST /mcp/reconnect`。

Profile：`GET/POST /profiles`，`PATCH/DELETE /profiles/:id`，
`PUT /profiles/default`。

安全：`GET /security`；`PUT /security/access-code`；
`POST /security/totp` → `POST /security/totp/confirm`，`DELETE /security/totp`；
`DELETE /security/sessions/:id`，`POST /security/sessions/revoke-others`。
写操作要 step-up 头 `x-luma-access-code`（及 `x-luma-totp`）。

## 约定

- 错误：`{ error: { code, message } }`。`message` 给人看，也给模型看；不要吞
  成泛泛的失败。
- 密钥出不来。界面只显示已配置。
- 分页：转写用 `after`/`before`（seq），列表用 `cursor`（时间戳），文件和图库
  用 `offset`。
- 媒体 URL 同源，靠 cookie 鉴权，这样 `<img>` / `<video>` 不必带 Bearer。
