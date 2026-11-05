# AI Provider 与 BYOK 设置

## 产品契约

Drifting 只有一个凭据管理入口：**设置 → 模型与 API**。每个 provider 对应一条系统安全存储记录：

| Provider  | Keychain id      | 当前消费者    |
| --------- | ---------------- | ------------- |
| DeepSeek  | `byok.deepseek`  | General Agent |
| Anthropic | `byok.anthropic` | General Agent |
| OpenAI    | `byok.openai`    | General Agent |
| ChatGPT 订阅（实验） | `oauth.openai-codex`（仅原生可读） | General Agent `openai-codex`、设定图生成 |

密钥不进入 Zustand/localStorage，不同步到其他设备（Hosted 的[偏好同步](hosted-sync/preferences.md)不带密钥，也不带 Agent 的服务商、模型与推理选择），也不在 General Agent 面板中重复编辑。唯一的例外是 Agent 面板的首次引导（[agent-runtime/agent-onboarding.md](agent-runtime/agent-onboarding.md)）：空对话里没有可用路由时，它可以就地**新增**一个 Key——先写入 Keychain、跑一次与「测试连接」相同的直连测试，通过才保留并把对话框切到该 provider，失败即删除；也可以就地发起 ChatGPT 设备码登录，或直接选中已有凭据的 provider。编辑、重新测试、查看来源与断开仍只在「模型与 API」。旧版 General Agent 的 `byok.agent.anthropic` 会在第一次读取 Anthropic 凭据时迁移到 `byok.anthropic`，确认写入后删除旧条目。

ChatGPT 订阅是实验性、不受支持的路由：设置页的「ChatGPT 订阅」行只驱动 OpenAI Codex 设备码登录并读取非敏感账号状态，OAuth token 全程在原生 Rust 侧读写、刷新与注入，`secure_storage` 拒绝 renderer 访问 `oauth.` 前缀。它不是 BYOK provider，也不进入 BYOK 密钥选择器。只要该登录有效，General Agent 页面就视为已有可用凭据并允许进入 composer；实际发送仍使用 composer 当前明确选择的 provider，不做静默 fallback。OpenAI 未对第三方应用开放该路径，用量计入作者本人的 ChatGPT 套餐，随时可能失效，不构成任何发布声明。

同一登录还承载实验性的要素设定图生成（`codex_images.rs` → Codex 后端 `images/generations`，`gpt-image-2`）：生成结果先进本机收件箱，作者保留时才成为素材；生图单独计量，`quality`/`size` 被服务端忽略。见 [image-generation.md](image-generation.md)。

## ChatGPT 订阅模型发现

General Agent 在发现有效登录或账号变化后刷新目录；打开模型菜单和菜单打开时窗口重新获得焦点按有效期刷新，恢复联网强制重新验证；与三家 API Key 列表一样没有手动刷新按钮。原生 `codex_models_list` 复用现有 Codex OAuth 凭据和固定 `https://chatgpt.com/backend-api/codex/models` 路由；`client_version` 与 OAuth User-Agent 统一读取 [`src-tauri/codex-compatibility.json`](../src-tauri/codex-compatibility.json)，目前的兼容基线为 `0.166.0`。这与 Drifting 的应用版本独立，不能继续使用开发占位值 `0.0.0`。请求拒绝重定向，限制为 30 秒、8 MiB；401 只刷新凭据后重试一次。renderer 只收到模型名称、标识、能力字段和刷新有效期，不接收 token、ETag、原始目录或其中的 instructions。

目录保留服务端 `visibility: list` 模型的顺序和名称，不用 `supported_in_api` 过滤订阅模型。上下文和推理档位跟随目录，包括 `minimal` / `ultra`；没有 `none` 的推理模型不能关闭推理，不支持的 summary / verbosity 参数不会发送。缺少上下文元数据时采用 32,768 token 本地输入规划回退；目录没有提供的输出上限记为 `null`（未知），不能用预留量冒充模型能力。

General Agent 的上下文窗口直接使用所选模型声明的长度，不设置额外的 200K／1M 产品上限，也不提供 Standard／Max 开关。BYOK 使用模型配置中的声明；ChatGPT 订阅使用账号模型目录的 `context_window`，缺失时保守回退到 32,768 token。旧的 Max 偏好在设置加载时移除。输出预留、工具开销和安全余量在模型窗口内部计算，不改变窗口本身。

General Agent 默认不设置单次或累计输出上限；摘要压缩也不再默认设置 1,024 token 上限。OAuth 请求不发送 `max_output_tokens`，由模型和服务端结束生成。API Key Responses 和 OpenAI-compatible driver 只转发调用方明确设置的输出限制；Anthropic Messages 必须填写 `max_tokens`，未指定时使用所选模型已声明的最大值。上下文规划保留 8,192 token 输入余量，但它不进入生成请求、不截断长回答，也不因超过某个 profile 的输出值而拒绝默认请求。

明确指定的限制与已知模型规格冲突属于配置错误；压缩失败、熔断或第一次调用前无法容纳的上下文属于失败，不触发自动续接。完整合成 tool-loop 覆盖新目录模型与重启后未加载的模型，通过实际 Responses driver 验证读取工具、结果回传、每次 16,384 token 用量及自然结束；两次请求均无输出上限。更广的预算和续接审计见 [执行控制审计](agent-runtime/execution-control-audit.md)。

缓存只在当前进程内保留。Rust 用凭据与账号的不可逆摘要隔离最近一次目录及 ETag；后续请求发送 `If-None-Match`，304 复用已投影的模型，不重新解析空 body。`Cache-Control: max-age` 与 `Age` 决定 renderer 的复用期限，上限五分钟；`no-cache` 每次重新验证，`no-store` 不保留原生目录或 ETag，并返回零复用期。无缓存控制时默认五分钟。同一账号更新失败保留最后一次成功目录，下次自动重试；菜单不显示目录的更新时间或失败状态，与三家 API Key 列表一致；首次失败使用内置列表。退出、完成新登录及凭据身份变化清空旧缓存；原生与 renderer 的 generation 都拒绝迟到的旧请求。已选择的新模型 id 在重启、目录失败或模型退役后仍保留；新目录缺少它时显示提示，发送被拒绝时显式报错，不静默换成旧模型。API Key provider 的模型列表见下一节。

同一兼容协议下的新增模型通过刷新自动出现，无需逐个发版添加名称。[OpenAI 官方目录规范](https://learn.chatgpt.com/docs/model-catalogs) 说明目录与客户端版本及账号有关，并要求版本不变时仍刷新。新协议、参数或工具能力需要更新适配器并验证后升级兼容基线；不能自动把远端最新版本写入 manifest。`pnpm openai:catalog:check` 在普通 CI 离线检查 manifest；`pnpm openai:catalog:upstream` 只读比较上游稳定版、输出 JSON 报告。`Codex compatibility review` workflow 每周一 02:23 UTC 与手动触发时执行比较、保留报告，不写源文件、不创建 PR。维护者对照 `schemaTag` 检查公开上游类型、运行下方验收及明确选择的真实模型 canary，通过后一起更新版本和 `reviewedOn`。

[官方 Sign in with ChatGPT 模型说明](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) 使用注册应用的 `api.openai.com/v1/models` 路由；本次延续仓库既有 Codex 设备码路由，没有迁移 OAuth 客户端或推理端点。目录联网对比已确认版本参数影响 6.1 模型可见性；合成验收覆盖动态新模型的 Responses tool-loop，但不表示所有列出的模型均已通过真实推理或原生 UI 验收。

## API Key 模型列表

2026-11-05 之前，DeepSeek、Anthropic、OpenAI 三个 API Key provider 的可选模型是 [`agent-provider-contract.ts`](../src/renderer/lib/agent/runtime/agent-provider-contract.ts) 里写死的一份清单（DeepSeek V4 Flash/Pro、Claude Sonnet 5/Haiku 4.5、GPT-5.6 Sol/Terra/Luna），不向 provider 查询；原生 OpenAI 传输还只放行这三个 GPT-5.6 id，设置迁移与 merge 会把清单外的已存选择改回第一项。provider 发新模型后菜单不会出现，必须发版改清单。

现在三家都用 provider 自己的模型列表接口，以作者存的 Key 为准：

- 原生命令 `byok_models_list`（[`byok_models.rs`](../src-tauri/src/byok_models.rs)）从系统安全存储读 `byok.<provider>`（Anthropic 兼读旧的 `byok.agent.anthropic`），请求固定 origin：DeepSeek `GET https://api.deepseek.com/models`、OpenAI `GET https://api.openai.com/v1/models`、Anthropic `GET https://api.anthropic.com/v1/models`（`anthropic-version: 2023-06-01`，按 `after_id` 翻页）。拒绝重定向，20 秒、4 MiB 上限。Key、`owned_by`、微调 id（含 `:`）与 provider 错误正文都不过 IPC；renderer 只收到 id、展示名、创建时间和 provider 公布的规格：Anthropic Models API 的 `max_input_tokens`、`max_tokens`、adaptive thinking 与 effort 档位，DeepSeek 列表的 `name`、`context_window`、`max_output_tokens`、`effort.supported_levels` 与 `effort.default_level`。OpenAI 的列表只有 id、创建时间、所有者和停服日期。没有 Key 时返回 `BYOK_MODELS_MISSING_KEY`。
- [`byok-model-catalog.ts`](../src/renderer/lib/agent/byok-model-catalog.ts) 只在内存中缓存，五分钟内复用；打开对话框的模型菜单、菜单打开时窗口重新获得焦点按有效期刷新，恢复联网强制刷新。「模型与 API」里保存、替换或删除 Key（`byok:keys-changed`）会作废三家的列表，迟到的旧请求不能再发布。刷新失败保留上次成功的列表；从未成功、没有 Key、离线或不在原生 App 里时提供内置清单。
- 菜单顺序：provider 列出的内置模型按内置顺序在前（第一项是切换 provider 时的默认），其余按 provider 给出的创建时间从新到旧。OpenAI 列表包含该 Key 能访问的所有模型，Agent 只提供 GPT-5 及以后的文本模型，去掉带日期的快照和 audio、realtime、transcribe、tts、image、search、embedding、chat、codex、cyber、rosalind、research 等专用或需单独审批的系列；GPT-4 系列不接受 Agent 发送的 reasoning 参数，上一代 o 系列也不再提供。
- 模型规格：provider 公布的就用公布的。Anthropic 与 DeepSeek 列出的模型以列表里的上下文、输出上限与思考/effort 档位为准（DeepSeek 的思考始终可以关，默认档位取列表的 `default_level`），连内置模型也一样，provider 改规格不用发版。OpenAI 不公布规格：内置模型用内置的 wire profile（取自官方模型页），其余新模型按 128K 本地输入规划，推理保持开启、effort 只提供 low/medium/high，因为并非所有新模型都接受关闭推理。列表条目缺规格或列表还没到时同样按 128K 规划，Anthropic 缺输出上限时用 32K。这些都是模型的上限，没有哪家给“推荐值”；Drifting 不另设产品上限。
- 已存选择：符合该 provider id 形状（`deepseek-*`、`claude-*`、GPT-5 及以后的 `gpt-*`）的模型 id 在重启、列表未到或失败时保留，不再被改回第一项；发送时 provider 是能否使用的权威，拒绝会显式报错。路由器发现所选模型不在当前列表时，先刷新一次该 provider 的列表再建 driver。已退役的 `deepseek-v4-flash` 自动改为后继 `deepseek-flash`（DeepSeek 仍把旧 id 路由到 V4.1 Flash）。原生 OpenAI 传输对 API Key 路由与订阅路由一样只校验 id 形状。
- 新一代模型的请求差异由 profile 决定：GPT-6 Astra、GPT-6.1 Sol 不接受 `effort: none`，Claude Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1 不能关闭思考，这些模型的思考始终开启并原样回放思考块；Opus 5.5、Sonnet 5.5、Fable 5.1 对强制 `tool_choice`（`any`/`tool`）返回 400，driver 对它们和未知 Anthropic 模型改发 `auto`。「测试连接」对 Anthropic 不再发送 `temperature`、输出上限 1,024；OpenAI 对不能关推理的模型用最低档 effort、输出上限 1,024。

2026-11-05 的内置清单（离线兜底）：DeepSeek `deepseek-flash`、`deepseek-v4-pro`（官方列表：1,048,576 上下文、393,216 输出、effort low/high/max；此前内置的 200K 已过时）；Anthropic `claude-sonnet-5-5`、`claude-opus-5-5`、`claude-fable-5-1`、`claude-haiku-5-5`；OpenAI 与订阅兜底 `gpt-6-astra`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-luna`。旧的 Claude Sonnet 5、Haiku 4.5 与 GPT-5.6 三档仍保留 wire profile，供已存选择与列出时使用。

各 Key 的真实列表接口与菜单的原生视觉未做联网验收；离线验收用合成列表覆盖投影、过滤、排序、缓存、作废与已存选择。

## 路由归属

- General Agent 的 `agentProvider + agentModel + reasoning` 只在右侧对话框的 composer 配置菜单中选择。设置页保留 Agent memory、MCP 和 usage 等持久管理面。
- 模型菜单打开时检查四个服务商有没有可用凭据，与首次引导、签到用同一个判断（`canAgentProviderRun`）：API Key 只查是否存在（开发用 `.env` Key 或 Keychain 条目），不解密；ChatGPT 订阅看是否已登录。没有凭据的服务商，其模型行照常列出但置灰、不能选；已选中的模型即使没有凭据也照常显示当前标记。保存或删除 Key、登录状态变化、窗口重新获得焦点时重新检查；检查还没答复的服务商先按可选处理。
- standalone Shadow CI、Element Arc 与 Goal Evolve 已于 2026-08-05 移除；它们不再拥有 provider route 或独立凭据消费者。
- Copilot（元素抽取、元素补丁建议、滚动段落摘要、⇧⌘I 内联编辑与内联「问」）已于 2026-10-30 退役，主动 AI 功能改由 Agent 承担。它的 `copilot*` 偏好由设置迁移 v32 删除；Google 只被 Copilot 使用，随之从设置页、`BYOKProvider`、provider 适配器和 `@google/genai` 依赖中移除，已存的 `byok.google` Keychain 条目不再读取。退役前最后一个提交打了 tag `copilot-retired-2026-10-30`。

General Agent 当前认证 DeepSeek、Anthropic、OpenAI 三种多轮 tool protocol，另有复用 OpenAI Responses 契约的实验性 `openai-codex` 订阅路由。

联网搜索没有开关，用的都是厂商自带的搜索，由模型自己决定搜不搜：

- 选 OpenAI（API key）或 ChatGPT 订阅时，Agent 每次带工具的请求都附带 OpenAI 托管的 `web_search`，搜索在 OpenAI 服务器上完成，对话里显示为「搜索网页“…”」「打开网页 …」两类已完成的步骤卡。
- 选 Anthropic 时附带 Anthropic 服务器端的 `web_search_20250305`（每次请求最多搜 5 次），对话里显示为「搜索网页“…”」步骤卡。Anthropic 按次另收搜索费（每千次 10 美元），搜到的内容按输入 token 计费。组织管理员在 Claude Console 关掉了网页搜索、或所选模型不支持时，请求会被拒（400），Agent 就去掉这个工具重发，同一把 Key 和模型在本次运行期间不再带它。
- DeepSeek 暂无联网搜索。

契约见 [provider-extension-protocol.md](agent-runtime/provider-extension-protocol.md)。

## 运行时边界

- 「测试连接」是显式用户动作。DeepSeek、Anthropic 使用各自 direct adapter；OpenAI 使用固定 origin 的原生 Responses transport，测试时 API key 不进入 renderer JavaScript。测试模型取 General Agent 当前所选模型（同一 provider 时），否则取该 provider 模型目录的第一项。仅浏览设置页只查询 key 是否存在，不解密 key。
- General Agent 通过 provider-neutral canonical `AgentRuntime` 执行多轮工具调用。
- 缺少所选 provider key 时 fail closed：空对话就地显示连接行（首次引导），已开始的对话引导用户前往「模型与 API」；不会静默换用另一个 provider 或 hosted fallback——切换 provider 只发生在作者点了某一行之后。
- direct BYOK client 在构建和每次请求前都会检查 `canUseByokProvider()`；General Agent 的 provider router 也会在创建或复用 driver 前复查，离线时不会触发 provider/native transport。
- OpenAI Responses 请求由原生 Tauri host 发起；DeepSeek 与 Anthropic 保留各自已认证的 provider driver。

## 机器验收

生成的目录／原生传输验收见 [`agent-runtime/acceptance/openai-native-transport.json`](agent-runtime/acceptance/openai-native-transport.json)，由 `pnpm eval:agent:openai-native` 重建。

```bash
pnpm openai:catalog:check
pnpm exec vitest run \
  src/renderer/lib/agent/codex-model-catalog.test.ts \
  src/renderer/lib/agent/byok-model-catalog.test.ts \
  src/renderer/lib/agent/runtime/agent-provider-contract.test.ts \
  src/renderer/lib/agent/runtime/drivers/anthropic-messages-driver.test.ts \
  src/renderer/lib/agent/runtime/runtime-context-planning.test.ts \
  src/renderer/lib/agent/runtime/drivers/openai-responses-driver.test.ts \
  src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.test.ts \
  src/renderer/lib/ai/provider-settings.acceptance.test.ts \
  src/renderer/lib/agent/connect-agent-provider.test.ts \
  src/renderer/features/agent/onboarding/agent-onboarding.acceptance.test.ts \
  src/renderer/lib/ai/local-ai-boundary.acceptance.test.ts \
  src/renderer/lib/ai/retired-copilot.acceptance.test.ts \
  src/renderer/lib/ai/test-provider-connection.test.ts \
  src/renderer/lib/ai/client/build-default-client.test.ts \
  src/renderer/lib/byok-keychain.test.ts \
  src/renderer/store/settings-store-agent.test.ts \
  src/renderer/lib/ai/client/providers/anthropic.test.ts
pnpm agent:capabilities:check
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml --locked codex_
cargo test --manifest-path src-tauri/Cargo.toml --locked openai_responses
cargo test --manifest-path src-tauri/Cargo.toml --locked byok_models
```

离线验收覆盖设置入口唯一性、direct route、Copilot 路由退役、退役 hosted endpoint 缺席、旧 Keychain 条目迁移、API Key 模型列表的投影与缓存，以及 provider adapter conformance。三家 provider 的真实付费 endpoint、原生设置页视觉与物理设备交互仍是手工/付费验收边界。
