# Agent

对话回合只有一条路：Luma 的 `Runtime` 包着 pi 的低层 `Agent` / `agentLoop`。
没有第二套 chat loop。创作台的 job、标题补全、压缩摘要都是一次性调用，不是
agent 循环。

包：`@earendil-works/pi-agent-core`、`pi-ai`、`pi-session-backend-sqlite-node`。
不用 pi 的 `AgentHarness`——session 和 HTTP 生命周期由 Luma 自己握。

## 分工

pi 提供：循环本身、session 树、`buildSessionContext`、压缩算法、FTS、skills
加载、bash 工具、LLM 流式。

Luma 提供：`Runtime`（开跑 / 停 / 续 / 转向）、把树投影成 `messages`、审批、
profile 门控、标题、把历史图片收成 id、按窗口修剪、把 provider 错误写成能读的
中文、装配工具。循环本身通过 `LoopFactory`（默认 `createPiLoop`）接到 Runtime。
Runtime 交给 factory 的是 `LoopStart`（系统提示、模型、工具、历史、流式、审批
门），订阅的是 `LoopEvent`。pi 的构造选项、队列策略和 `AgentEvent` 留在
`createPiLoop` 里。换引擎就是再写一个 `LoopFactory`。

## 一次 run

入口：`POST /v1/conversations/:id/runs`。一个对话同时只能有一个 run。
`Idempotency-Key` 让超时重试不会开第二次。

1. 解析模型与 profile（能力、提示词、生成模型、MCP 过滤）。
2. 附件：图成本轮多模态 part + 持久 `image_ref`；非图进文件库并可检索。
3. 拼系统提示（全局 / 工具 + 记忆 / 文件清单 / 搜索 / skills 目录）。
4. 按固定顺序装配工具（顺序稳定是为了 prompt cache）：文件检索、联网搜索、
   编码、生成、MCP、记忆、skills；历史里有图且模型吃图时再加 `view_image`。
   发给模型之前把每个工具 schema 的非字符串 enum 收成字符串（Gemini 要求）。
5. 需要的话先压缩（可被 stop 打断）。
6. `loop.prompt(text, media)` 或 `loop.continue()`。
7. 订阅 `LoopEvent`：写入 session 树、投影 `messages`、写入 `events`、经 EventBus
   推 SSE。
8. 结束：标题、`run.completed|failed|cancelled`、过期本 run 的待审批、剪 delta。

编辑 / 重试：body 带 `fromSeq`，先 rewind 再当普通 run。被放弃的枝留在树上，
投影只展示当前枝。rewind 之后客户端必须从 `after=-1` 重拉转写，不能增量续。

继续：`POST .../continue`。若树上最后一条已经是 user 或 toolResult，静默
`continue()`；否则插入一句「继续，接着上面写，不要重复。」——停掉的回合常常
停在 assistant 消息上，pi 不能从那里接着吐。

停止：abort 信号 + `agent.abort()`。

转向：`POST .../steer` → `agent.steer`。pi 在当前这一轮跑完之后、下一次模型调用
之前把它插进去，所以这一轮不会被打断，而是多跑一轮把它算进去——不管上一轮调没调
工具都一样。插进去的那句话作为一条 user 消息进 session 树并投影到 `messages`，
所以重连的客户端看得见答案为什么转了向。没有在跑的 run 时 409。两个前端都还
没有入口。

## 模型看到的上下文

`buildSessionContext`：最新压缩点 + 之后的条目。压缩点展开成摘要 + 保留的尾部。

然后 Luma `transformContext`：限制工具结果体积 → 按 token 预算剪旧回合 →
`describeRefs`（历史图变成一行文字，像素只有 `view_image` 才加载）。转写和
事件里从不存 base64。

压缩失败不当成功：记错误，本轮继续，靠修剪兜底。摘要器的输入也要先
`describeRefs`，否则它看不到图曾经在。

## 审批

替代模型自己标 `confirm: true`。`beforeToolCall` 看结构，不看命令黑名单：

- 每次 `bash_tool`
- `delete_path` / `move_path`
- 覆盖已有文件的 `write_file`

写入 `approvals`，推 `tool.approval.required`，最多等 15 分钟。超时或取消 =
拒绝，永不默认同意。拒绝以工具结果返回（中文说明），不抛错，模型可以改主意。

## 工具从哪来

`Runtime.start` 里按开关 push，没有中央注册表。部署能力 AND profile 布尔值。
profile 不能发明部署关掉的能力。skills 没有部署开关，只看 profile（或没有
profile）。MCP 看已连接且启用的服务器，profile 可再按 id 过滤。

详见 `04-capabilities.md` 和 `03-generation.md`。
