# M28 模型接入

交回状态：分支 `codex/m28-model-providers`；最后实现提交 `ded56ed8`（本行交回记录单独提交）；真实账号验收由作者进行，界面接线交 M31。

2026-11-08。实现 [M28 任务书](../handoff/m28-model-providers.md)，接在 [M27](m27-agent-runtime.md) 的进程内驱动接口上。没有新增运行时类型，也不经过旧版 Tauri。

## 做了什么（大白话）

- DeepSeek、Anthropic、OpenAI API Key 和 ChatGPT 订阅四条路线共用一个 HTTP 客户端、一个 SSE 解析器；OpenAI 和 ChatGPT 共用 Responses 协议适配器。
- 每次运行开始时保存模型、提供商、思考档位、模型能力、系统指令及作者选择的迭代上限。运行中改设置只影响下一次运行。插话形成新的作者回合，迭代计数重新开始；没有设置上限时不暗加上限。
- 模型列表从提供商获取，按凭据和地址隔离缓存，最长五分钟。获取失败时返回旧版内置清单和失败类别，不悄悄更换已选择的模型。Anthropic、DeepSeek 的能力元数据和 ChatGPT 的目录元数据能冻结进本次运行；OpenAI 仅提供 id 时，不把估算值冒充提供商发布的上限。
- API Key 和订阅令牌经 F7 钥匙串读取。保留 `byok.openai`、`byok.anthropic`、`byok.deepseek`、`oauth.openai-codex` 及旧 Anthropic 键迁移。开发环境仍用当前开发身份的服务名，不能越过身份隔离去读日常应用的凭据。
- ChatGPT 设备码登录、轮询、换取令牌、刷新和退出登录全部由同一个客户端完成。取消登录或退出后，旧的后台钥匙串写入不能把令牌复活。

## 定下的事

**重试只发生在事件交给运行时之前。** 有工具的响应先完整解析、检查终止、用量和工具参数，再发布事件；网络、限流和无效样本最多六次，间隔从 250 毫秒递增到 4 秒并抖动，`Retry-After` 最多采纳 60 秒。没有工具的纯文字响应逐步显示，失败后不重播已经显示的内容。丢弃流或中止运行会取消 HTTP 请求和退避等待。

**思考回放是提供商的原始数据。** 保留签名、加密内容、引用和原始顺序，不自行拼造思考内容。只在同一 session、同一作者回合、最后一条作者消息之后原样发送；历史回合或切换提供商时投影成可移植文字和完整工具调用／结果。活动工具循环缺少必须的思考回放时失败，不补空签名。

**联网搜索只用原生工具。** Responses 使用 `web_search` 和 `external_web_access: true`；Anthropic 使用 `web_search_20250305`、`max_uses: 5`；DeepSeek 不发送搜索工具。原生搜索不进入本地工具执行器。Anthropic 返回与搜索有关的 400 时移除搜索后重试，并把降级状态保留到当前工具循环结束，避免改变签名绑定的工具列表。已有活动签名回放时若服务端后来拒绝搜索，直接返回不支持，不更改已绑定的工具列表。`pause_turn` 最多续四次，保留每一段消息边界、内容顺序和累计用量；达到限制后不再通过一般重试重新启动这组续接。

**输出上限不混同上下文上限。** Responses 只转发作者显式给出的输出上限，ChatGPT 订阅完全不发送该字段。Messages 要求 `max_tokens`，优先用显式值和冻结的模型元数据，缺少时沿用旧版的模型清单／兜底值。不会用规划器的输入余量当输出上限。

## 请求、响应和 M27 事件

| 路线 | 请求映射 | 响应与回放 |
| --- | --- | --- |
| DeepSeek | Chat Completions；原生 `thinking`、`reasoning_effort`；工具结果用 `tool_call_id` | `content` → `TextDelta`，`reasoning_content` → `ThinkingDelta`；按工具索引拼接完整 JSON；保留整条 assistant 消息，等 finish、usage、`[DONE]` 齐全再完成 |
| Anthropic | Messages；adaptive thinking 和 effort；合并相邻工具结果；缓存断点沿用旧版 | block 增量 → 文字／思考事件；签名 → `ThinkingSignature`；每段完整 assistant 内容进入 `Replay`，包含 redacted thinking、搜索加密结果、引用和工具调用 |
| OpenAI | Responses；`store: false`；函数工具显式 `strict: false`，保留可选参数 | summary → 思考，output text → 文字；函数参数完成后生成 `ToolCall`；完整有序 output 进入 `Replay`，保留 encrypted reasoning |
| ChatGPT | 同 Responses，设备码 OAuth 与旧 Codex 请求头；不加输出上限 | 同上；终止输出为空时仅从唯一、连续的 `output_item.done` 索引重建；有缺口或重复则失败 |

原生搜索的 `ProviderTool` 记录 id、搜索／打开网页、开始／完成／失败及可用的查询或 URL。传输层从活动回放补回查询，跨暂停和模型轮次仍保留搜索词；面板按 id 合并活动。它与本地 `ToolProposed`／`ToolFinished` 分开，不占本地工具写入或审批路径。

`Replay` 先进入本机日志，随 `AssistantMessage` 投影进会话文档；重放修复也保留它。搜索降级标志是回放元数据，不污染原始 wire items。`Usage` 保留输入、输出、缓存读取、缓存写入和推理 token；Anthropic 的 input 是未缓存输入，缓存读写单列，和旧版一致。

错误投影为 `Authentication`、`Quota`、`Network`、`Unsupported`，另有无效响应和取消。`Event::ModelFailed` 提供稳定类别给面板；HTTP 正文、Key 和令牌不进入错误文本、日志或会话。已知认证状态不会因为错误正文断流而变成可重试网络错误。

## 接口与外壳里的挂接点

- `dr_agent::Start.config: RunConfig`：启动时按值接收，工作线程及每次 `DriverRequest` 共享只读快照。`Configured` 事件保存这份配置。
- `catalog::ModelInfo::run_config(thinking)`：检查模型所支持的档位并冻结能力；调用方填入系统指令、显式输出上限及偏好中的 `max_model_rounds`。M37 后续同步偏好，不改变进行中的配置。
- `HttpClient::new()`：应用持有一份，传给 `ProviderDriver`；`raw()` 给模型目录和 OAuth 复用，`spawn()` 让 GPUI 调用方把网络任务放进共享执行器。不要为每家另建客户端。
- `Credentials::new(Arc<SecretStore>)`：由外壳当前身份创建 SecretStore。登录信息不放进 `RunConfig` 或会话。
- `ProviderDriver::new(http, credentials)`：作为 M27 唯一驱动实现，按请求内的 provider 分派。`oauth()`、`credentials()` 给 M31 连接流程使用；API Key 应先检验成功再保留。密钥管理的界面范围仍按 M31 任务书。
- `CatalogCache::list`／`list_chatgpt`：模型选择器读取目录，缓存隔离凭据、提供商、地址和订阅账号；ChatGPT 支持 ETag、304 及受五分钟限制的服务端缓存策略。
- M31 接真实窗口、连接按钮和设置。M28 没有新增 UI 文案、路由或应用启动代码。

## 验收

契约证据全部是 Rust 测试，不提交响应 JSON 或真实服务录音：

- 三个协议的合成流覆盖文字、思考、分片工具参数、搜索、错误、断流、签名／加密回放和未知扩展字段。
- 本机 HTTP 服务覆盖四条路线、请求头、跨字节分片、预发布重试、可见文字不重播、尾部损坏帧、取消、搜索降级、续接上限、跨轮工具列表和错误脱敏。
- 本机 OAuth 服务覆盖设备码、轮询、交换、刷新共用锁、取消、退出登录；钥匙串写入的取消竞态有独立回归。
- 模型目录覆盖列表解析、能力、分页、五分钟过期、凭据隔离、兜底、订阅 ETag 和缓存策略；能力快照拒绝不支持的档位。
- 测试专用系统钥匙串服务验证旧 `keyring` 写入 → F7 读取，及反向读取，包含旧 Key 名和 OAuth JSON；不读取作者现有服务项。该测试单独启用，结束后清理。
- M27 回归新增配置冻结、作者迭代上限、搜索活动及回放持久化；已有写入落盘、取消、崩溃修复和撤销测试继续运行。

本轮 macOS 验证通过：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（1586 通过、20 忽略）、`cargo xtask check`、`pnpm public:check`。M28 自身 49 项自动测试通过，另有 1 项测试专用系统钥匙串兼容测试单独启用并通过；M27 运行时回归 27 项通过。审计无漏洞，12 条现有依赖提示；14 份已有性能证据仍陈旧，本轮没有重测或刷新它们。未测试真实 API Key、订阅账号或模型可用性；不据此声称真实服务已验收。

## 与旧版的差异和待协调

1. 三种协议共享 Rust HTTP／SSE，不再经 renderer／Tauri 字节转发。ChatGPT 仍是实验订阅路线，其兼容版本、请求头和设备流程沿用旧客户端；不是官方第三方稳定接口声明。
2. 旧版活动回放放在驱动内存，新版随不可变会话消息持久化，发送时仍严格遵守活动回合边界；M36 随会话同步，本机事件日志不上传。
3. 模型路由和能力在 `Start` 时冻结，运行时不读界面全局设置。作者迭代上限已经接通，设置入口及账号同步分别交 M31／M37。
4. 本模块没有真实账号前置依赖；真实订阅登录、API 权限、提供商动态目录和联网搜索的现场验收由作者完成。Windows 的系统钥匙串实机验证交 M43；本轮只在 macOS 执行了系统兼容测试。

## 代码和依据

- `next/crates/dr-agent-providers/`：公共传输、SSE、错误、三个协议、目录、凭据和 OAuth。
- `next/crates/dr-agent/src/config.rs`、`protocol.rs`、`runtime.rs`：配置冻结、搜索事件、回放与错误投影。
- 行为标准：旧版 `runtime/drivers/`、`agent-provider-contract.ts`、`byok_models.rs`、`codex_models.rs`、`codex_oauth.rs` 和 [provider extension protocol](../../agent-runtime/provider-extension-protocol.md)。
- Responses 的增量、完成事件和终止输出形状也核对了 [OpenAI 官方流事件文档](https://developers.openai.com/api/reference/resources/responses/streaming-events)。
