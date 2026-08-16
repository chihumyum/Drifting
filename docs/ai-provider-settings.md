# AI Provider 与 BYOK 设置

## 产品契约

Drifting 只有一个凭据管理入口：**设置 → 模型与 API**。每个 provider 对应一条系统安全存储记录：

| Provider  | Keychain id      | 当前消费者             |
| --------- | ---------------- | ---------------------- |
| DeepSeek  | `byok.deepseek`  | Copilot、General Agent |
| Anthropic | `byok.anthropic` | Copilot、General Agent |
| OpenAI    | `byok.openai`    | Copilot、General Agent |
| Google    | `byok.google`    | Copilot                |

密钥不进入 Zustand/localStorage，不参与偏好同步，也不在 Copilot 或 General Agent 面板中重复编辑。旧版 General Agent 的 `byok.agent.anthropic` 会在第一次读取 Anthropic 凭据时迁移到 `byok.anthropic`，确认写入后删除旧条目。

## 路由归属

- Copilot 在自己的设置中选择 `copilotByokProvider + copilotByokModel`；运行时从全局 Keychain 取得对应 key。切换 provider 会清空上一个 provider 的 model id，并在下一次调用前重建 client，不能把旧 provider 的模型或凭据带进新路由。
- General Agent 的 `agentProvider + agentModel + reasoning/context` 只在右侧对话框的 composer 配置菜单中选择。设置页保留 Agent memory、MCP 和 usage 等持久管理面。
- standalone Shadow CI、Element Arc 与 Goal Evolve 已于 2026-08-05 移除；它们不再拥有 provider route 或独立凭据消费者。

General Agent 当前认证 DeepSeek、Anthropic、OpenAI 三种多轮 tool protocol。Google 虽然统一管理凭据，但在其 Agent Runtime tool loop 完成认证前只供 Copilot 选择。

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
```

离线验收覆盖设置入口唯一性、direct route、provider/model 切换、output language、完整本地 prompt builder、退役 hosted endpoint 缺席、旧 Keychain 条目迁移，以及 provider adapter conformance。四家 provider 的真实付费 endpoint、原生设置页视觉与物理设备交互仍是手工/付费验收边界。
