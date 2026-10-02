# AI Provider 与 BYOK 设置

## 产品契约

Drifting 只有一个凭据管理入口：**设置 → 模型与 API**。每个 provider 对应一条系统安全存储记录：

| Provider  | Keychain id      | 当前消费者             |
| --------- | ---------------- | ---------------------- |
| DeepSeek  | `byok.deepseek`  | Copilot、General Agent |
| Anthropic | `byok.anthropic` | Copilot、General Agent |
| OpenAI    | `byok.openai`    | Copilot、General Agent |
| Google    | `byok.google`    | Copilot                |
| ChatGPT 订阅（实验） | `oauth.openai-codex`（仅原生可读） | General Agent `openai-codex` |

密钥不进入 Zustand/localStorage，不参与偏好同步，也不在 Copilot 或 General Agent 面板中重复编辑。旧版 General Agent 的 `byok.agent.anthropic` 会在第一次读取 Anthropic 凭据时迁移到 `byok.anthropic`，确认写入后删除旧条目。

ChatGPT 订阅是实验性、不受支持的路由：设置页的「ChatGPT 订阅」行只驱动 OpenAI Codex 设备码登录并读取非敏感账号状态，OAuth token 全程在原生 Rust 侧读写、刷新与注入，`secure_storage` 拒绝 renderer 访问 `oauth.` 前缀。它不是 Copilot provider，也不进入 BYOK 密钥选择器。只要该登录有效，General Agent 页面就视为已有可用凭据并允许进入 composer；实际发送仍使用 composer 当前明确选择的 provider，不做静默 fallback。OpenAI 未对第三方应用开放该路径，用量计入作者本人的 ChatGPT 套餐，随时可能失效，不构成任何发布声明。

## ChatGPT 订阅模型发现

General Agent 在登录或账号变化、composer 挂载、打开模型菜单、窗口重新获得焦点和恢复联网时，自动请求当前账号的模型目录；菜单也提供「刷新模型」。原生 `codex_models_list` 复用现有 Codex OAuth 凭据和固定 `https://chatgpt.com/backend-api/codex/models?client_version=0.0.0` 路由，使用当前原生 host 的开发客户端版本身份。请求拒绝重定向，限制为 30 秒、8 MiB；401 只刷新凭据后重试一次。renderer 只收到模型名称、标识和能力字段，不接收 token、原始目录或其中的 instructions。

目录保留服务端 `visibility: list` 模型的顺序和名称，不用 `supported_in_api` 过滤订阅模型。上下文和推理档位跟随目录，包括 `minimal` / `ultra`；没有 `none` 的推理模型不能关闭推理，不支持的 summary / verbosity 参数不会发送。缺少上下文元数据时采用 32,768 token 本地输入规划回退；目录没有提供的输出上限记为 `null`（未知），不能用预留量冒充模型能力。

General Agent 的上下文窗口直接使用所选模型声明的长度，不设置额外的 200K／1M 产品上限，也不提供 Standard／Max 开关。BYOK 使用模型配置中的声明；ChatGPT 订阅使用账号模型目录的 `context_window`，缺失时保守回退到 32,768 token。旧的 Max 偏好在设置加载时移除。输出预留、工具开销和安全余量在模型窗口内部计算，不改变窗口本身。

General Agent 默认不设置单次或累计输出上限；摘要压缩也不再默认设置 1,024 token 上限。OAuth 请求不发送 `max_output_tokens`，由模型和服务端结束生成。API Key Responses 和 OpenAI-compatible driver 只转发调用方明确设置的输出限制；Anthropic Messages 必须填写 `max_tokens`，未指定时使用所选模型已声明的最大值。上下文规划保留 8,192 token 输入余量，但它不进入生成请求、不截断长回答，也不因超过某个 profile 的输出值而拒绝默认请求。

明确指定的限制与已知模型规格冲突属于配置错误；压缩失败、熔断或第一次调用前无法容纳的上下文属于失败，不触发自动续接。完整合成 tool-loop 覆盖新目录模型与重启后未加载的模型，通过实际 Responses driver 验证读取工具、结果回传、每次 16,384 token 用量及自然结束；两次请求均无输出上限。更广的预算和续接审计见 [执行控制审计](agent-runtime/execution-control-audit.md)。

缓存只在当前进程内保留，运行时复用期限为五分钟，菜单或账号事件可强制刷新。同一账号更新失败保留最后一次成功目录，首次失败使用内置列表；退出和账号变化清空旧目录，迟到的旧请求不能覆盖新状态。已选择的新模型 id 在重启、目录失败或模型退役后仍保留，服务端拒绝时显式报错，不静默换成旧模型。API Key provider 的静态认证列表不受影响。

[官方 Sign in with ChatGPT 模型说明](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) 使用注册应用的 `api.openai.com/v1/models` 路由；本次延续仓库既有 Codex 设备码路由，没有迁移 OAuth 客户端或推理端点。新目录的真实账号联网与 UI 验收尚未完成，合成验收不表示所有列出的模型均已通过付费 tool-loop 测试。

## 路由归属

- Copilot 在自己的设置中选择 `copilotByokProvider + copilotByokModel`；运行时从全局 Keychain 取得对应 key。切换 provider 会清空上一个 provider 的 model id，并在下一次调用前重建 client，不能把旧 provider 的模型或凭据带进新路由。
- General Agent 的 `agentProvider + agentModel + reasoning` 只在右侧对话框的 composer 配置菜单中选择。设置页保留 Agent memory、MCP 和 usage 等持久管理面。
- standalone Shadow CI、Element Arc 与 Goal Evolve 已于 2026-08-05 移除；它们不再拥有 provider route 或独立凭据消费者。

General Agent 当前认证 DeepSeek、Anthropic、OpenAI 三种多轮 tool protocol，另有复用 OpenAI Responses 契约的实验性 `openai-codex` 订阅路由。Google 虽然统一管理凭据，但在其 Agent Runtime tool loop 完成认证前只供 Copilot 选择。

## 运行时边界

- Copilot 的七个结构化 prompt 都是 renderer-local `PromptDef`。输入校验、prompt 构建、model/output-language 解析、provider 调用和输出 schema 校验均在客户端完成；Inline Ask 也通过同一 author-selected client 直连 provider。
- `buildCopilotLLMClient` 只接受明确选择的 provider，缺 key 时 fail closed，不搜索“第一个可用 key”，也不读取 `VITE_AI_TRANSPORT=proxy`。默认 local-only build 中，Copilot 不调用 `/api/ai/run`、BYOK relay 或 Inline Ask hosted stream。
- 「测试连接」是显式用户动作。DeepSeek、Anthropic、Google 使用各自 direct adapter；OpenAI 使用固定 origin 的原生 Responses transport，测试时 API key 不进入 renderer JavaScript。仅浏览设置页只查询 key 是否存在，不解密 key。
- General Agent 通过 provider-neutral canonical `AgentRuntime` 执行多轮工具调用。
- 缺少所选 provider key 时 fail closed，并引导用户前往「模型与 API」；不会换用另一个 provider 或 hosted fallback。
- direct BYOK client 在构建和每次请求前都会检查 `canUseByokProvider()`；General Agent 的 provider router 也会在创建或复用 driver 前复查，离线时不会触发 provider/native transport。
- OpenAI Responses 请求由原生 Tauri host 发起；DeepSeek 与 Anthropic 保留各自已认证的 provider driver。

`ServerProxyProvider` 只保留为 compatible hosted operator 的显式 contract seam；它同时要求 hosted build capability 与 proxy flag。public local-only build 的 `canUseHostedService()` 为 false，且 renderer-local Copilot factory 不会选择该 adapter。

## 机器验收

```bash
pnpm exec vitest run \
  src/renderer/lib/agent/codex-model-catalog.test.ts \
  src/renderer/lib/agent/runtime/runtime-context-planning.test.ts \
  src/renderer/lib/agent/runtime/drivers/openai-responses-driver.test.ts \
  src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.test.ts \
  src/renderer/lib/ai/provider-settings.acceptance.test.ts \
  src/renderer/lib/ai/local-copilot-boundary.acceptance.test.ts \
  src/renderer/lib/ai/run-structured.test.ts \
  src/renderer/lib/ai/test-provider-connection.test.ts \
  src/renderer/lib/ai/client/build-default-client.test.ts \
  src/renderer/lib/copilot/runtime.test.ts \
  src/renderer/lib/byok-keychain.test.ts \
  src/renderer/store/settings-store-copilot.test.ts \
  src/renderer/store/settings-store-agent.test.ts \
  src/renderer/lib/ai/client/providers/anthropic.test.ts
pnpm agent:capabilities:check
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml --locked codex_
cargo test --manifest-path src-tauri/Cargo.toml --locked openai_responses
```

离线验收覆盖设置入口唯一性、direct route、provider/model 切换、output language、完整本地 prompt builder、退役 hosted endpoint 缺席、旧 Keychain 条目迁移，以及 provider adapter conformance。四家 provider 的真实付费 endpoint、原生设置页视觉与物理设备交互仍是手工/付费验收边界。
