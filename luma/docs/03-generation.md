# 生成

图片和视频是一等能力，不是聊天的插件。一切能出像素或帧的东西走同一套接口：
四个操作、若干 adapter、一条 job 队列、一种给客户端的作品形状。

## 四个操作

```
text_to_image   提示词            → 图
image_to_image  提示词 + 1..n 图  → 图   （编辑）
text_to_video   提示词            → 视频
image_to_video  提示词 + 1 图     → 视频
```

一个 model 行能跑的操作，是三件事的交集：adapter 声明的 `runs`、行的 `kind`
（`image` / `video`）、行上的 `ops`。`ops` 为空时退回该品类的第一个操作——
从供应商目录批量加进来的行就是这样。

## Adapter

`models.api_mode` 选中 adapter：

| `api_mode` | 做什么 |
|---|---|
| `openai-images` | OpenAI 形 `/images/generations` 与 `/images/edits`（含 Ark/Seedream 的 unified JSON） |
| `venice-images` | Venice 原生 `/image/generate`、`/image/edit`、`/image/multi-edit`。目录里若有 `foo` + `foo-edit`，生图行带上 `params.editModel`，改图孪生不再单独勾 |
| `comfy-workflow` | 本机 ComfyUI。model = `data/workflows` 里一份图 + 行上的 bind/sizes/controls |
| `openai-videos` | OpenAI 形异步提交 → 轮询 → 下载。路径和完成态写在行的 `params` 里 |
| `venice-videos` | Venice `/video/queue` → `/video/retrieve`；完成时直接返回 MP4 或预签名下载地址 |

目录发现按 host 认协议，和聊天认 Anthropic / Gemini 一样：`venice.ai` 上的图像
行是 `venice-images`，别的网关上同一个 Seedream id 仍是 `openai-images`。Venice
的 `safe_mode` 默认会模糊结果，请求里关掉——过滤不在 Luma 里叠一层
（`00-product.md`）。

ComfyUI 不是特例：它是一个听 `127.0.0.1` 的图像/视频 API。workflow 是文件，
加一个不是发版。源图的字节在进 adapter 之前由 registry 一次解析完。

新后端 = 实现 `GenerationAdapter`（`schema` / `run` / 可选 `cancel`），登记进
`generation/index.ts`，再加对应 `api_mode` 的 model 行。

## 一份 schema，两个受众

`adapter.schema(spec, op)` 只有一份。

- 创作台用完整 schema 生成表单。
- 模型工具走 `forModel`：丢掉 `audience: "studio"` 的字段（采样器、精确像素、
  seed 这类模型判断不了的旋钮），再加上 `intent`（给人看的状态标签，提交前剥掉）。
  enum 里的数字收成字符串——Gemini / CometAPI 的 function calling 不接受
  `{ type: "integer", enum: [4, 8] }`。创作台表单仍用原来的数字。

缺的参数回落到 adapter 默认值或图里已有的值。部署级开关（水印、格式、`n`、
供应商自己的改写）不进 schema，写在 adapter 或 `params.extra`。

### 后端自己的提示词说明写在 schema 里

`prompt` 字段的 description 是 `params.promptHints`（ComfyUI 的图可以写在自己的
`luma` 声明里）。判断一句话该放哪，问它换个生成模型还成不成立：成立的是手艺，
归系统提示词（`prompts/defaults.ts`）；不成立的是这个后端的事，归 schema。
所以「一个镜头只讲一件事」在系统提示词里，而「这份 checkpoint 吃胶片和机身名」
在模型行上。`size` / `duration` 这类字段的 description 同理——取值有什么含义，
只有 adapter 知道。

全局提示词里不留某个模型专属的词表。它会教所有模型按那一个模型的口味写。

Agent 默认工具：`generate_image`、`edit_image`、`generate_video`，由设置里的
默认生图 / 改图 / 视频后端决定。没有指定时回落到已配置密钥的托管模型，而不是
「排序第一且无需密钥」的本地 Comfy——后者在 8188 没人听的时候会让对话里的生图
静默失败。创作台 `GET /studio/tools` 默认选这些绑定；没有绑定才按
keyed hosted → 本地 Comfy → 仍缺密钥。生成排在编辑和视频前面。
`agent_tool=true` 的行再额外挂名为 `_*_<slug>` 的工具。工具结果同时带
`image_id`/`video_id`（转写、`view_image`）和 `asset`（与图库同一个
`GeneratedAsset`）。

## Job

`Jobs` 是生成模型唯一的执行入口。状态机：

```
submit → queued → running → succeeded | failed | cancelled
```

一行 `jobs` 就是全部状态。重连读这一行，不重放事件。SSE `/jobs/:id/events`
只是更早把同一行推过来。

按 `api_mode` 分车道。`comfy-workflow` 并发 1，其余 3。提交时客户端可带
prompt id；Comfy 重试前先问后端认不认，避免同一张图排两次队。

重启：仍在排队的重新入队；带 `provider_job_id` 的托管视频去 `awaitVideo` 接着
等（不付第二次钱）；Comfy 做到一半的标失败（本地队列无法跨进程认领）。

Agent 工具：`submit` + `await`，abort 则 `cancel`。创作台：`POST /jobs`
（202 + SSE）。`POST /studio/run` 是同一份 `JobInput`，同步等到结束，返回
同一行 job（含 `GeneratedAsset[]`）。

MCP 不进创作台。第三方服务器只作为 agent 工具存在。

## 作品的形状

落盘之后，图和视频都是 `GeneratedAsset`：

```
id, assetId, kind: image|video, mime, width, height, name,
provider, model, parents, createdAt, durationMs, posterAssetId
```

- `files` 行让图书馆和图库看得见。
- `image_assets` / `video_assets` 行记血缘。
- 成功的 job 把同一形状快照进 `jobs.assets`。

`GET /studio/gallery` 列出图书馆里所有 `image/*` 和 `video/*`（含上传的），
LEFT JOIN 血缘表，返回 `GeneratedAsset[]`。视频不是二等公民：和图片同一格网、
同一种磁贴。kind 看 mime，不看 id 前缀。

字节：图是 `img_{32hex}.*` + JSON sidecar；视频是 `vid_{32hex}.*`，没有
sidecar（没有「编辑视频文件」这条路）。`GET /images/:id` 可带 `?w=` 缩略图；
`GET /videos/:id` 支持 Range。血缘在 `/images|videos/:id/provenance`。

父本只有图 id（`img_`）。视频不能当源。

## 还没对齐的地方

默认绑定优先于「哪个后端还活着」：绑了本机 ComfyUI 而它没启动，对话里的生图
就会失败，错误里说明该启动什么、或者去设置里换后端。这是故意的——悄悄换成
另一个模型会让人拿到一张不是自己要的风格的图。

视频只有 `LUMA_E2E_VIDEO=1` 时才跑真实渲染：一次几分钟且要花钱，不适合每次
跑测试都付一遍。
