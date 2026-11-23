# M28 模型接入

交回状态：分支 `codex/m28-model-providers`；最后实现提交 `ded56ed8`（本行交回记录单独提交）；真实账号验收由作者进行，界面接线交 M31。

2026-11-08。实现 M28 任务书（`handoff/m28-model-providers.md`，已随过程文档清理删除，在 git 历史里），接在 [M27](m27-agent-runtime.md) 的进程内驱动接口上。没有新增运行时类型，也不经过旧版 Tauri。

> 2026-11-16（LM 本地模型）：多了第五条路线 `Provider::Local`，接本机或局域网里 OpenAI 兼容的模型服务（Ollama、LM Studio、llama.cpp 这类）。界面按作者定稿（原型第 3 版）由 M31 画，见本页末「自定义服务」一节；自定义 API Key（接网上的服务）作者当时定了不做。
>
> 2026-11-24（CA 自定义服务地址）：作者 11-23 改了主意，11-24 在整窗原型「第五版 网上的地址」上照推荐定完（[chihumyum/Drifting#3](https://github.com/chihumyum/Drifting/issues/3)）。同一条路线也收网上的第三方服务（中转站、聚合服务），只认 `https` 和 OpenAI 兼容的 Chat Completions；界面上这一格改叫「自定义服务」。见本页末一节。

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
- `HttpClient::new()`：应用持有一份，传给 `ProviderDriver`；`raw()` 给模型目录和 OAuth 复用，`spawn()` 让 GPUI 调用方把网络任务放进共享执行器。不要为每家另建客户端。它的两个客户端（云端、登录、目录用的和本机模型长等待用的）都加了 `dr_platform::proxy::system()`（NP，2026-11-24）：四家提供商、订阅登录和网上的自定义服务（CA）走系统设的代理，本机和局域网的模型服务（`local` 认成本机和局域网的地址）一律直连，每个请求各自判断。见 [F7「第六轮」](../foundations/f7-platform.md#第六轮联网跟着系统代理走np2026-11-24)，回归 `tests/system_proxy.rs`。
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

## 图片（CM4a，2026-11-24）

作者消息带的图片（存法、上限、哪些随请求走见 [M27「图片」](m27-agent-runtime.md#图片cm4a2026-11-24)）怎么写进各家的请求、哪些模型算看得了图。各家写法照各自官方文档（2026-11-24 查）：Anthropic 的 [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) 与 [List Models](https://platform.claude.com/docs/en/api/models/list)；OpenAI 的 [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) 与 [List models](https://developers.openai.com/api/reference/resources/models/methods/list)；ChatGPT 订阅的模型清单字段照 OpenAI 开源的 Codex 客户端（`codex-rs/protocol/src/openai_models.rs` 的 `input_modalities`）；Ollama、llama.cpp、LM Studio 照各自仓库或网站的文档。

**写法**（`src/images.rs` 先把一条作者记录分成「字」和「随请求走的图片」，各家再写成自己的样子；没有图片的消息照旧，一个字节都不变）：

| 路线 | 有图片时作者消息的 `content` |
| --- | --- |
| Anthropic Messages | 先图片后字：`{"type":"image","source":{"type":"base64","media_type":…,"data":…}}` 每张一块，再一块 `{"type":"text"}`（字是空的就不写这块，Anthropic 不收空的文字块）。缓存断点照旧打在最后一块上 |
| OpenAI Responses、ChatGPT 订阅 | 先字后图片：`{"type":"input_text"}`，每张一个 `{"type":"input_image","image_url":"data:<mime>;base64,…"}`，`detail` 不写（默认 `auto`） |
| 本地模型（Chat Completions） | 先字后图片：`{"type":"text"}`，每张一个 `{"type":"image_url","image_url":{"url":"data:<mime>;base64,…"}}`（Ollama 两种写法都收；llama.cpp、LM Studio 收这种） |
| DeepSeek | 没有图片的写法：每张都是一行字 |

没随请求走的图片（模型看不了图，或这台设备没有字节、超了一次请求的上限）在作者的字后面各成一行英文给模型：`[The author attached an image (PNG, 640×400 px) here. The current model cannot view images, so it was not sent.]` 或 `… It is not included in this request.]`，让模型知道那里有过一张图。

**哪些模型算看得了图**：只按各家模型清单接口给的能力字段认，清单没说的当看不了（`ModelInfo.image_input`、`LocalModel.image_input`，`None` 即否；冻结进 `RunConfig.capabilities.image_input`）：

| 路线 | 怎么认 | 现在的结果 |
| --- | --- | --- |
| Anthropic | 清单每行 `capabilities.image_input.supported` | 清单说能的能；清单没取到（只有内置清单）时不能，所以带图发送前界面先取一次清单（M31） |
| OpenAI API Key | `/v1/models` 每行只有 `id`、`created`、`object`、`owned_by`、`shutdown_date`，没有能力字段 | **一律看不了**（照「没这个字段按最保守的认」）；要不要按 0.1 的做法认，见「等作者的事」 |
| ChatGPT 订阅 | 订阅清单每行 `input_modalities` 里有 `image` | 有的能；没有这个字段的不能（Codex 自己的客户端把没有字段当能看图，这里没跟） |
| DeepSeek | 清单没有能力字段；对话接口也不收图片 | 一律看不了（`RunConfig::sees_images` 对 DeepSeek 路线恒为否） |
| 本地：Ollama | `POST /api/show` 的 `capabilities` 里有 `vision` | 有的能，问过但没有的不能；只问前 64 个模型（照旧），其余不能 |
| 本地：LM Studio | `/api/v0/models` 每行 `type` 是 `vlm` | `vlm` 能、`llm` 不能 |
| 本地：llama.cpp | `/v1/models` 每行 `architecture.input_modalities` 里有 `image`；较旧的服务没有这个字段时看 `/props` 的 `modalities.vision` | 照它说的 |
| 本地：认不出的服务 | 行上有 `architecture.input_modalities` 就照它 | 没有就不能 |

内置清单（0.1 的那份，取清单失败时的兜底）一律不说能看图。设置里存的本地服务清单（`LocalServerModel.image_input`）只有这次改动以后问过的才有这个值，以前存的要等下一次重问清单（打开模型菜单时）。

**测试**（对着本机假服务，不连真服务）：`tests/transport.rs` 的 `each_protocol_writes_images_its_own_way`（Anthropic 看得了图有字、只有图、看不了图三种，OpenAI、ChatGPT 订阅、DeepSeek 各一种；对上面那张表逐字核对，base64 和发出去的字节一致，看不了图时请求里没有字节）；`tests/local.rs` 的 `what_each_server_says_about_images_is_what_counts`（Ollama 的 `vision`、LM Studio 的 `vlm`/`llm`、llama.cpp 的 `input_modalities` 和 `/props` 四种组合、认不出的服务）和 `a_local_model_that_sees_gets_image_url_parts`；`tests/auth_catalog.rs` 的 `only_a_list_that_says_so_makes_a_model_take_images`（Anthropic 说能、说不能、`capabilities: null`；OpenAI、DeepSeek 的清单和内置清单都不说；订阅清单 `input_modalities` 三种），各自冻结进运行配置后 `sees_images` 对得上。**没调过任何真实模型**：三家和订阅、本地软件的真实服务都没验过。

## 自定义服务（本地模型 LM 2026-11-16；网上的服务 CA 2026-11-24）

作者 2026-11-16 定稿、说「做」：Agent 能用本机或局域网里部署的模型。交回后的七处同日定（「都按你倾向的」），本模块跟着改了两处：滤完一个不剩不再当「没有清单」，「测试连接」真发一句。2026-11-23 作者改主意、把网上的第三方服务也放进来，2026-11-24 在原型「第五版 网上的地址」上五处都照推荐定（「自定义服务地址按照你的推荐来就行。」），定了的十处在下面和 M31 同名一节。代码里的名字（`Provider::Local`、`local::*`、`byok.local.*`）没改。

**大白话。** 作者在连接格里粘贴一个地址：本机或局域网的（比如 `http://localhost:11434`），App 去问这台服务有哪些模型，认出是哪种软件，把能用的模型放进模型菜单；网上的（比如 `https://api.example.com/v1`），App 照样问一次清单，确认服务在、Key 对，但不把清单列出来，让作者自己填模型名。发消息时走同一个 HTTP 客户端和 SSE 解析器，只是请求发到那台服务、用通用的 Chat Completions。

**能填什么地址。** 本机（`localhost`、`127.0.0.0/8`、`::1`）和局域网（`10/8`、`172.16/12`、`192.168/16`、`*.local`）`http` 或 `https` 都行；别处都算网上的（`Reach::Internet`），只收 `https`，`http` 是 `AddressError::NeedsHttps`。本机和局域网这一组除了 `*.localhost`（见待协调第 4 条）和 NP 的直连规则（`dr_platform::proxy::reach`）认的一样，所以网上的服务走系统代理、这一组直连。带用户名密码、查询串或 `#` 的不收（`Invalid`）。没写 `http://` 的当 `http://`（所以不写协议的网上地址是 `NeedsHttps`）；末尾的 `/` 和 `/v1` 去掉；标准端口（`http` 80、`https` 443）不写进 `display`。规则只有一份（`local::LocalAddress::parse`），传输层发请求前用同一条规则再查一次冻结进运行的地址（`local::validate_endpoint`：网上的不是 `https` 就拒），手改设置文件也放不宽。`local::on_the_internet` 是给表单用的：打出来的地址是不是网上的（`http` 也算），决定密钥框要不要自己出来。四家原来的端点检查（HTTPS 或本机）不变。

**问模型清单（`local::discover`）。** 先 `GET {base}/v1/models`：连不上 → `Unreachable`；401／403 → `Unauthorized`；别的回答但不是清单（404、500、不是 JSON、没有 `data` 数组）→ `NoList`，界面改问模型名；给了清单、但滤完一个不剩（只有嵌入模型和确知不会用工具的，或清单是空的）→ `NoToolModels`，界面写「这台服务上没有能用工具的模型」、不连上（作者 11-16 定，乙）。认软件看各自独有的接口：`/v1/models` 的行里 `owned_by` 是 `llamacpp` 是 llama.cpp；`GET /api/version` 回 `{"version":…}` 是 Ollama；`GET /api/v0/models` 的行带 `type`（`llm`／`vlm`／`embeddings`）是 LM Studio。认不出就没有名字。
- 上下文：Ollama 读 `POST /api/show` 的 `model_info["<架构>.context_length"]`，LM Studio 读 `max_context_length`，llama.cpp 读 `/props` 的 `default_generation_settings.n_ctx`（它实际开的大小），别的服务读行上的 `max_model_len`／`context_length`。前两种是模型上限、不是运行时实际开的大小，所以设置里能手改（M31）。
- 嵌入模型不进清单：Ollama 看 `capabilities` 里只有 `embedding`，LM Studio 看 `type == "embeddings"`，别的服务看名字里有没有 `embed`。
- 服务确知不支持工具的不进清单：只有 Ollama 的 `capabilities` 是数组且没有 `tools` 时算确知。LM Studio、llama.cpp 不报，就都留着。
- `/api/show` 最多问 64 个模型；清单最多 500 行；每个探测 5 秒、清单 10 秒超时。
- `local::check`：问一次 `/v1/models`，除 401／403 以外的任何回答都算服务在。它是「测试连接」的第一步：连不上就是「连不上这个地址」，被拒是「密钥无效」。第二步由 M31 发一句「Return exactly OK.」给这台服务现在选的模型，模型回了话、正常结束才算「可用」（作者 11-16 定，乙）。
- 网上的服务照样走 `discover`（认软件、读上下文的规则都一样，认出 Ollama 这类就照旧用软件名）；不把清单列出来是 M31 的事（`Probe::AskName`，清单留着给手填的模型名查上下文）。`discover`、`check` 现在收 `&HttpClient`（原来是 `&reqwest::Client`），请求地址都经 `HttpClient::destination`。
- **等候上限 `local::MODEL_WAIT` = 5 分钟。** 本地软件第一次用某个模型要先把它读进内存，大模型常要几十秒到几分钟，第一个字节之前什么都不发。所以「测试连接」等这一句最多 5 分钟（不用四家的 90 秒），过了就是请求失败那句；本地对话也走一个读超时 5 分钟的客户端（`HttpClient` 里给本地单独建的那个，连接超时、不重定向、不自动重发和共用的一样），四家照旧 90 秒。「连接」本身只问清单，照旧快。

**请求和响应（`chat.rs`）。** 形状同 DeepSeek 的 Chat Completions，但不带 DeepSeek 专有的 `thinking`、`reasoning_effort`，不发联网搜索，`tool_choice` 不写（默认 auto）；输出上限只在 `RunConfig.max_output_tokens` 明确给出时才发 `max_tokens`。以前的思考内容不发回去。响应宽松一些，但截断仍然失败：
- 思考：`reasoning_content` 或 `reasoning` 字段，或者正文开头（还没出现可见文字之前）的 `<think>…</think>`，都变成 `ThinkingDelta`，跨任意分块边界拆对；可见文字之后的 `<think>` 只是字。
- 工具调用：缺 `index` 时有 `id` 按 `id` 认，没有就接上一个；缺 `id` 时补成稳定的 `call_<序号>`；`arguments` 是对象也收、空串当 `{}`。较旧的服务用 `stop` 结束工具调用，也收。
- 用量可以没有（记 0）；`[DONE]` 前没有 `finish_reason`、`length` 截断、参数不是 JSON 对象、断流，都照旧失败、不发布事件。
- 不产生 `Replay`：本地模型没有要原样回放的签名或加密内容，历史一律按通用投影发送。

**Key。** 钥匙串里一个服务一条，`byok.local.<服务 id>`；服务 id 是 App 自己生成的不透明 id，不是地址。没存 Key 就不带 `Authorization`（不像三家那样按 401 失败）。`Credentials::local_candidate` 只在内存里试。Key 只发给存它的那一台：运行按路线里的服务 id 取 Key、发到同一条路线的地址；两个客户端都不跟重定向（`redirect::Policy::none()`），3xx 照失败处理，Key 不会跟到别的主机（`src/internet_tests.rs` 守住）。设置里「改地址」不打开密钥框时 Key 跟着这台服务去新地址，是 M31 11-16 定的（作者的选择，原型第五版照旧）。

**路线和配置。** `ModelRoute.local: Option<LocalRoute { server, base_url }>`，只有 `Provider::Local` 带它（`RunConfig::validate` 检查两边对得上）；旧的路线读出来照旧，序列化时不多写字段。地址和模型一起冻结进这次运行，运行中改设置只影响下一次。`catalog` 对 `Local` 没有内置清单（`bundled_models` 为空），本地的清单由 M31 存在本机。

**网上的服务怎么测（`test-support`）。** 假服务只能起在回环地址上，又只说明文 HTTP，网上的 `https` 地址走不到它。所以 `HttpClient` 在 `test-support` 特性下（和本 crate 自己的单元测试里）多一个 `with_stand_in(origin, stand_in)`：发往 `https://api.example.com` 的请求改发到回环上的假服务，像注入了一条域名解析；地址规则、`display`、名字、`validate_endpoint` 看到的仍是 `https://api.example.com`。只改「本地」这条路线的请求（`local::*` 和 `Provider::Local` 的对话），在 `validate_endpoint` 之后才换。特性只由别的 crate 的测试和验收例程打开（`dr-view-agent` 和 `app/drifting` 的 dev-dependency），不进任何正式构建；没打开时 `destination` 原样返回。本 crate 用到替身的测试放在 `src/internet_tests.rs`（单元测试，`cfg(test)` 就有替身）：本 crate 对自己的 dev-dependency 是依赖环，hot-reload 门禁不收。

**测试。** 全部对着本机假服务（`tests/local.rs`、`src/internet_tests.rs`），不连真实服务：
- `ollama_is_recognized_and_only_tool_models_are_offered`：认出 Ollama，gemma3（没有 tools）和嵌入模型不进清单，上下文读对，不带 Key 时没有 `Authorization`。
- `lm_studio_and_llama_cpp_are_recognized_by_their_own_endpoints`、`an_unknown_server_keeps_its_address_name_and_row_context`。
- `no_list_wrong_key_and_nothing_listening_are_told_apart`：`NoList`／`NoToolModels`／`Unauthorized`／`Unreachable` 分清（空清单、只有嵌入模型是 `NoToolModels`），`check` 对没有清单的服务也算可用。
- `an_ollama_with_only_models_without_tools_has_none_to_offer`：只装了 gemma3 和嵌入模型的 Ollama 是 `NoToolModels`，两个都问过 `/api/show`。
- `a_local_chat_goes_to_its_own_server_without_a_key_or_deepseek_fields`：走那台服务的 `/v1/chat/completions`，不落到四家的端点；`<think>` 成思考；存了 Key 才带 Bearer；工具调用照收。
- `plain_http_to_the_internet_or_a_route_without_a_server_is_refused_before_any_request`（CA 前叫 `a_route_off_this_network_…`，原来拒的是 `https://api.example.com` 和 `http://8.8.8.8:11434`；`https://api.example.com` 现在收了，换成不会有人应答的地址 `http://203.0.113.7:11434`、`ftp://…`、带用户名密码的）：缺服务的路线也在请求前拒绝；没人监听时按网络错误失败。
- `src/internet_tests.rs`（CA，单元测试，用替身）：`plain_http_to_the_internet_is_refused_before_any_request`：网上的 `http`、`ftp`、带用户名密码的地址在请求前拒绝，挂在这些地址上的替身一个请求都没收到。
- `a_service_on_the_internet_is_listed_and_chatted_with_over_https`（CA，同一文件）：`https://api.example.com/v1` 是 `Reach::Internet`、`display` 是 `api.example.com`；没 Key 是 `Unauthorized`，带 Key 问到清单（嵌入模型滤掉、`context_length` 读到）；对话发到它的 `/v1/chat/completions`、带 Bearer、不带推理和搜索字段。
- `a_key_goes_only_to_its_own_service_and_never_along_a_redirect`（CA，同一文件）：网上服务对清单和对话都回 307 指向另一台假服务：对话失败、清单是 `NoList`，另一台一个请求都没收到，发出去的只有这台自己的 Key；另一台自己的路线只带它自己的 Key。
- `tests/system_proxy.rs` 的 `providers_take_the_system_proxy_and_a_local_model_server_never_does`（NP 写的，CA 并进来以后加了一段）：假代理当系统代理重跑一遍，本机的模型服务直连；网上的自定义服务的清单（共用客户端）和对话（5 分钟那个客户端）都只到假代理（两条 `CONNECT api.example.com:443`），假代理自己拒掉，什么都没出这台机器。
- 单元测试：`local.rs` 的地址规则（本机、局域网、网上 `https`、网上 `http`、坏地址各一组，CA 前是「本机、局域网、网上被拒、坏地址」），`chat.rs` 的 `<think>` 逐字节分块、两种思考字段、缺用量、宽松的工具调用和各种截断，`credentials.rs` 的一服务一条 Key。

**待协调。**
1. **上下文小于约 7 万的本地模型，示例书第一句就发不出去。** 真窗口量到：示例书「慢钟」发第一句时整个请求 54,285 字节（系统指令 2,934、工具 2,664，其余是书的固定上下文和对话）。M27 `context.rs` 按一字节一单位估算，再留 8192 输出余量和一成余量，所以上下文 40960（Ollama 报给 qwen3:14b 的值）时这一句在发出前就被判成太长，面板出现现成的「继续此任务」，服务一个对话请求都没收到；131072 时正常。问不到上下文时的 32768 兜底也一样。中文一字三字节，估算比真实 token 数大不少；改估算会影响四家，本路没动，等监管会话或作者定。作者可以在设置里手填更大的上下文，但 Ollama 实际开的大小比填的小时会悄悄丢内容。
   - **2026-11-16 改了（监管会话定，PT4／LM 小修，同日又调一次）**：M27 改成按字的种类估 token（中文和别的非 ASCII 字一字 1.5 个、英文四个字母一个、数字一位一个、标点两个一个，四家和本地同一套，任何时候不超过原来的字节数），输出余量没给时是上下文的八分之一、最多 8192（40960 留 5120，32768 留 4096），见 [m27-agent-runtime.md](m27-agent-runtime.md)「请求有多长」。同一句话现在估约 2.3 万个；上下文 40960 和问不到上下文时的 32768 兜底都能发出去（`dr-view-agent/tests/local_context.rs`，真的驱动对着本机假服务；32768 那档富余约 2 100 个）。131072 和 1M 上下文只会比原来少省略。还没有的：在线服务因为超出上下文拒掉请求时，`dr-agent-providers` 没有单独的一类错误，也不会省略后重发。
2. 真实 Ollama、LM Studio、llama.cpp 由作者自己验；自动测试只用合成的假服务。
3. **网上的服务一家真的都没连过**（CA）：中转站、聚合服务在工具调用、流式分块、用量字段上的差别，要到真连上才知道；自动测试只对着回环上的替身。
4. **网上的服务走系统代理**（NP 的规则，`dr_platform::proxy`）：本机和局域网直连，别的走系统代理；网上的自定义服务的清单和对话都走代理（`tests/system_proxy.rs` 用假代理守住：`api.example.com` 的两次请求都是 `CONNECT api.example.com:443`）。直连规则和 `local` 的地址规则是两份：`dr_platform::proxy::reach` 还把 `*.localhost` 算本机，`local` 不算（它算网上的、要 `https`）；别的一样。合成一份要动 `local` 收哪些地址，这一路没动。
5. 网上的服务的对话和「测试连接」沿用本地的 5 分钟读超时（`local::MODEL_WAIT`，「测试连接」等候上限照旧），没另设。
