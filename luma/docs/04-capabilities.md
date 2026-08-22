# 能力

部署级开关在 `PATCH /v1/capabilities`。关掉的东西，工具不会出现。

## 模型与供应商

`providers`：一个 `baseUrl` + 鉴权方式（`bearer` / `header` / `none`）。密钥进
保险箱 `provider:{id}`，界面只显示已配置。

`models` 一行是一个可调用的东西，用 `kind` 区分，不拆表：

| `kind` | 用途 |
|---|---|
| `chat` | 对话。`api_mode`：`openai-chat` / `openai-responses` / `anthropic-messages` / `google-generative` |
| `image` / `video` | 生成。见 `03-generation.md` |
| `embedding` / `rerank` | 检索用，不是对话模型 |

`GET /providers/:id/models` 去对方的 `/models` 拉清单，并兼探 `?type=image` /
`?type=video` / `?type=inpaint`。带类型的列表只有在它真的和全量清单不一样时才
信——否则一个忽略查询参数的 OpenAI 形网关会把全部对话模型标成图。行上的
`type`、`model_spec.constraints`（画幅、分辨率、`maxInputImages`、提示词上限）
覆盖 id 上的猜测。

生成行还会带上族的默认 `params`：OpenAI 形 Seedream 是 unified 改图（同一条
`/images/generations` 带参考图）；Venice 上若清单同时有 `foo` 和 `foo-edit`，
生图行会带上 `params.editModel`，列表里不再单独勾那个改图孪生。批量添加会把
这些 `params` 写进去，并填上当时还空着的默认生图 / 改图 / 视频（以及对话默认
模型）。设置里「模型」「工具与后端」「提供方」都能拉清单，前两页按种类过滤。

聊天走 `ModelRegistry`（pi-ai + 重试）；生成不走 pi-ai，走 generation adapters。

上下文长度写在 `models.context_window`，给压缩和预算用。CometAPI 这类聚合器的
`/models` 往往只给 id，不给窗口；这时用模型族的已知数字（Gemini 1M、Grok 4.6
500k），而不是再填一个统一的 256k。对方真返回了 `context_length` 就用对方的。
界面里仍可改。

Embedding 是能力配置里单独一组：`baseUrl`、模型、维度、切块大小，密钥槽
`embedding`。不是 `models` 表里的对话行。

### Gemini 走原生协议

`safetySettings` 只存在于 Gemini 自己的 `/v1beta/models/{model}:generateContent`。
实测过：同一个网关，OpenAI 兼容端点连**编造的** category 都回 200（字段被整个忽略），
原生端点对编造的 category 回 400（字段真的被读）。所以在兼容端点上是没有任何办法
关掉过滤的——一句普通请求也可能回 `finish_reason: content_filter`，而那不是这台
机器上任何人选择的策略。

于是 `google-generative` 是 gemini 的默认：目录发现按 model id 认它，种子迁移把
已有的 `openai-chat` gemini 行搬过去，`applyModelParameters` 在 `config.safetySettings`
里把五个类别全设成 `OFF`。这就是产品原则落到代码上的样子——过滤在上游网关或下游
组件里，Luma 不再叠一层（`00-product.md`）。行上的 `params.safetySettings` 可以覆盖，
包括改严。

用 `OFF` 而不是 `BLOCK_NONE`：新模型把 `BLOCK_NONE` 当"用默认值"处理，除非账号被
放行；`OFF` 是真的关掉那个类别。

## 记忆

表 `memories`：key → 完整句子。key 形如 `^[A-Za-z0-9_-]{1,64}$`，模型可以自造，
建议列表只是起点。

没有「搜记忆」工具。每轮把现有条目按 token 预算塞进系统提示。写工具
`set_memory` / `delete_memory` 仅在用户明确说「记住 / 忘掉」时用（提示词里写了
这条）。人也可以在 `/memory` 页面直接改。

## 文件与检索

图书馆是 `files`。上传文档按 sha256 去重并切块；手写笔记一样索引。图和视频
登记为资产，不走 RAG。

检索管道：extract（PDF / DOCX / 文本）→ chunk（默认 1500/150）→ embed →
`keyword`（FTS 三元组 + LIKE，RRF）/ `semantic`（余弦）/ `hybrid`。没有
embedding 密钥时块仍在，状态是 `indexed` 而不是失败，关键词还能搜；有向量之后
才是 `ready`。整句中文问句（「内部代号是什么」）会先去掉疑问尾再搜，仍落空则
用汉字 bigram，避免问句比库里的陈述多两三个字就零命中。

Agent 工具：`file_search`，可选 `file_ids` 限定到指定文件。HTTP：
`POST /files/search`。引用锚点沿用 LibreChat 的 `\ue202turnNfileK` 形。

### 随消息附上来的文档

**附件的正文直接进这一轮的上下文，模型不用检索就能读到。** 之前只在系统提示的
可检索清单里写一句「这个是刚附的」，结果模型照着那句去调 `file_search`——那是
全库检索——然后拿着别的文件的段落回答，问三个要点它总结了另一份文档。附件是问题
的一部分，不是要去库里找的东西。

所以现在：

- 正文按预算内联（单文件 8k token，一轮合计 20k），放在系统提示最末的
  「Documents attached to this message」段里，并明确写着不要对这些文件调
  `file_search`。
- 已内联的附件**从可检索清单里去掉**。列在那里就是一句指令，模型会服从。
- 超出预算的附件才留在清单里，并在附件段里说明用 `file_search` 加 `file_ids` 查
  剩下的部分。
- 那条 user 消息里留一个 `file_ref`（`file_id`、名字、mime、字节数），像图片留
  `image_ref` 一样。它让转写显示得出附件、让编辑重试能把文档再发一次。
- 只有当前这一轮带正文。后续轮次只剩 `[file ...]` 引用行，要再读就用
  `file_search` + `file_ids`——和历史图片同构：像素在发它的那一轮，之后是一行字
  加 `view_image`。

图片走另一条路，没变：base64 进本轮多模态 part，模型直接看见。

## 联网搜索

工具 `web_search`。接口是 `WebSearchAdapter` 注册表。现在两个实现：

| `provider` | 鉴权 |
|---|---|
| `tavily` | 密钥槽 `tavily` |
| `searxng` | 无密钥，`capabilities.web.baseUrl` 指向自托管实例 |

不认识的 id 回落到 Tavily。SearXNG 没有 extract 端点，工具只给摘要；Tavily 仍可
`read_pages`。

可并行搜图、搜新闻；`read_pages` 用 Tavily extract 拉前几条的正文。

## 编码

限制在 `capabilities.coding.workspace`（默认 Luma 根目录的上一级）。

| 开关 | 工具 |
|---|---|
| `read` | `read_file`、`glob_search`、`grep_search`、`list_directory` |
| `write` | `edit_file`、`write_file`、`move_path`、`delete_path`、`restore_file` |
| `shell` | `bash_tool`（pi 的 bash + `NodeExecutionEnv`） |

写入有文件锁和 `expect_revision`。覆盖/删除进 `data/coding-trash`。危险调用走
审批（`02-agent.md`）。手机上的角色是看着跑、点批准，不是在手机上编仓库。

## Skills

`data/skills/<name>/SKILL.md`，pi 的 `loadSkills`。目录进系统提示，`use_skill`
返回全文。仓库不带技能文件；目录为空则没有这个工具。

## MCP

`mcp_servers`：stdio（`command` + `args` + `env`）或远程（`url` + `headers`，
Streamable HTTP，失败再 HTTP+SSE）。

启动时 `McpPool.connect()`。启用的服务器变成 agent 工具，命名
`{原名}_mcp_{serverId}`。schema 会收窄成各家 function-calling 吃得下的子集。

MCP 的正当用途是接「还没有 Luma adapter 的工具」，不是再接一个 ComfyUI，也
不是创作台的第二条出图路径。创作台只列出 generation 模型。

环境变量展开：`AIGC_ROOT`、`PROJECT_ROOT`、`NODE_EXE`、`{PROVIDER}_API_KEY`。
