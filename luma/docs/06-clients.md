# 客户端

两个前端，同一个 `/v1`。谁也没有私有端点。新能力先在服务端出现。

## Web

`src/web/`。Vite 打到 `dist/`，生产里由 Node 同进程送出；开发时 Vite `:3100`
把 `/v1` 代理过去。

五栏：

| 栏 | 路径 | |
|---|---|---|
| 对话 | `/`、`/c/:id` | 转写、流式、附件（图与文档）、编辑/重试、继续、停止、审批 |
| 创作台 | `/studio` | schema 表单、job 队列、砌体图库（图+视频）、血缘 |
| 文件 | `/files` | 图书馆、笔记、检索、预览 |
| 记忆 | `/memory` | key/value、token 预算 |
| 设置 | `/settings/…` | 供应商、对话模型、生成后端与 MCP、能力、提示词、安全 |

`api.ts`：Bearer + cookie；SSE 失败两次改长轮询；`followRun` / `watchJob`。
对话地址放在 URL 里，避免移动浏览器杀后台后丢掉当前会话。

创作台提交走 `POST /jobs` + `watchJob`。表单来自 `/studio/tools` 的 adapter
schema，没有 MCP 旁路。表单只渲染字段的 `title`：schema 里的 `description` 是
写给模型的（包括后端自己的提示词建议），印给人看等于把别人的说明书摆在读者面前。

冷启动拉不到 bootstrap 时给一屏可重试的错误，不是空白；已经有快照时刷新失败只
提示，因为手上那份是旧的而不是没有。

## iOS

`luma/ios/`。SwiftUI，最低 iOS 18。一个 Universal app：iPhone 底栏五栏（对话 /
创作台 / 文件 / 记忆 / 设置），iPad 左侧目的地轨 + 对话分栏。

要 18 是为了滚动：转写靠 `onScrollGeometryChange` / `onScrollPhaseChange` 判断
读者是不是还跟在末尾，靠 `defaultScrollAnchor(.bottom)` 让长对话一进来就在底部。
这些都是 18 的 API，用 17 能做的近似（`GeometryReader` 探针加手势猜测）在流式
过程中会误判成「人要往回读」而停住自动跟随。

Core 层（`APIClient`、`EventStream`、`LiveTurn`、markdown）按 `/v1` 的事件
模型写。不要在 App 里镜像一份转写数据库。服务端是真相；手机最多缓存缩略图。
后台被杀之后用 `lastSeq` + `after=` 续，不要假定 SSE 还活着。

SSE 要按**字节**解析，不能用 `bytes.lines`。Foundation 的 `AsyncLineSequence`
不发空行，而空行是一帧 SSE 的唯一结束标志——于是没有任何一帧被派发过，整段回答
要等 run 结束、流被当成断线、`settle()` 重读消息日志才一次性出现。看起来像"网络
卡"，其实是从来没流式过。`SSEParser` 保留空行，同时处理 LF/CRLF/CR、忽略
`id:`/`retry:`/注释行、合并多条 `data:`；`SSEParserTests` 里有一条专门在"只在流
结束时才派发"这个边界上失败，因为这个 bug 编译干净、读起来也对。

首帧不进节流。50 ms 的合批对第二帧之后是对的，对第一帧就是白等一个 tick。同理
`live` 在空快照时要保持 nil，否则「正在思考」会被整个首 token 延迟（这台机器上
实测 2.07 秒）压住不显示。

| 栏 | 做什么 |
|---|---|
| 对话 | 访问码（及 TOTP）登录、列表、流式转写、工具块、引用、审批、编辑自己那条消息、composer（相册/文件附件）、断线时的连接提示 |
| 创作台 | `/studio/tools` 出表单，默认选设置里绑的生成后端，`POST /jobs` + job SSE，图库磁贴 |
| 文件 | 同一套 `files` 行：筛选、检索、笔记、上传、缩略图 |
| 记忆 | `/memory` 快照、编辑、token 预算 |
| 设置 | 提供方增删改与密钥、对话模型增删改（启用/固定/设默认、从提供方拉列表批量添加）、默认生图/改图/视频后端、能力（搜索后端、嵌入与重建索引、记忆上限、代码工作目录）、提示词（含命名模型）；MCP 增删改与重连；安全（访问码、TOTP 登记/关闭、踢设备）；bootstrap 快照 |

视频在三处都能播（转写、图库、文件库），走同一个组件。`AVURLAsset` 收不了
`URLRequest`，所以 token 通过 `AVURLAssetHTTPHeaderFieldsKey` 传；播放器还要盯
`AVPlayerItem.status`，被拒的请求没有别的地方会说。

安全那几个写操作要 step-up：失败回 `step_up_required` / `bad_step_up` 时就地再问
一次访问码，并把用过的那个清掉。

密钥只提交，不回读。提供方、对话模型、MCP 都能在 App 里增删改，不必回网页。写操作集中在
`SettingsStore`：它自己读 `/providers`、`/models`、`/mcp/servers`、`/capabilities`，因为
`bootstrap` 是启动那一刻的快照、而且只留下能跑的行，管理页要连停用的和缺密钥的一起看见；
每次写完再刷一遍 `bootstrap`，否则切换器还挂着刚被删掉的模型。同一时刻只允许一个写请求，
按钮自己转圈——这些都是隔着隧道的往返，一个既不动也不拒绝的按钮会被按第二次。

生成后端只在 App 里选默认（生图/改图/视频三个槽）。加生成模型、改 ComfyUI 工作流绑定仍然用
网页：那块 `params` 是 adapter 自己的 schema，`PATCH` 又是合并语义，只渲染一部分字段的表单
一保存就会把没渲染的抹掉。

创作表单由服务端 schema 渲染，工具顺序跟 `/studio/tools`（默认后端优先）。新 adapter 不应迫使
App 发版——唯一的例外是 `API_MODES`：那张表决定跑哪个 adapter，随服务端一起发布，`/v1` 上没有
任何路由把它送出来，所以 `SettingsAdmin.swift` 里镜像了一份，新接口模式要在那儿补一行。

`Luma.xcodeproj` 由 `project.yml` 生成、不入版本控制：XcodeGen 把目录展开成一条条
文件引用，所以新增文件之后要跑 `xcodegen generate`，否则它根本不参与编译。

## 共同规则

- 用 bootstrap 决定开关和模型列表，不要把供应商写进客户端。
- 创作表单由服务端 schema 渲染。新 adapter 不应迫使 App 发版。
- 密钥只提交，不回读。
- 不在客户端做内容过滤、提示词拼装、检索或工具路由。
- 分享一张自己的图到相册，是「这台设备的人把文件拿走」；不是做分发产品。
  没有「导出对话为 PDF」这类需求。
