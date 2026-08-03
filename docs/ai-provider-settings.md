# AI Provider 与 BYOK 设置

## 产品契约

Drifting 只有一个凭据管理入口：**设置 → 模型与 API**。每个 provider 对应一条系统安全存储记录：

| Provider  | Keychain id      | 当前消费者                     |
| --------- | ---------------- | ------------------------------ |
| DeepSeek  | `byok.deepseek`  | Copilot、Shadow、General Agent |
| Anthropic | `byok.anthropic` | Copilot、Shadow、General Agent |
| OpenAI    | `byok.openai`    | Copilot、Shadow、General Agent |
| Google    | `byok.google`    | Copilot                        |

密钥不进入 Zustand/localStorage，不参与偏好同步，也不在 Copilot、Shadow 或 General Agent 面板中重复编辑。旧版 General Agent 的 `byok.agent.anthropic` 会在第一次读取 Anthropic 凭据时迁移到 `byok.anthropic`，确认写入后删除旧条目。

## 路由归属

- Copilot 在自己的设置中选择 `copilotByokProvider + copilotByokModel`；运行时从全局 Keychain 取得对应 key。
- Shadow 在自己的设置中选择 `shadowByokProvider + shadowByokModel`。review、arc、rule compile 和 evolve 共用该 route；provider/model 在一次运行开始后冻结。
- General Agent 的 `agentProvider + agentModel + reasoning/context` 只在右侧对话框的 composer 配置菜单中选择。设置页只保留 Agent memory、MCP 和 usage 等持久管理面。

Shadow/General Agent 当前认证 DeepSeek、Anthropic、OpenAI 三种多轮 tool protocol。Google 虽然统一管理凭据，但在其 Agent Runtime tool loop 完成认证前只供 Copilot 选择。

## 运行时边界

- General Agent 和 Shadow 多轮 leaf 共用 `DriftingAgentModelDriver` 与 canonical `AgentRuntime`。
- Shadow one-shot/arc 调用由 `buildShadowClient` 按显式 provider 构造 adapter，不按 key 存在顺序自动猜路由。
- 缺少所选 provider key 时 fail closed，并引导用户前往「模型与 API」；不会换用另一个 provider 或 hosted fallback。

## 机器验收

```bash
pnpm --dir client exec vitest run \
  src/renderer/lib/ai/provider-settings.acceptance.test.ts \
  src/renderer/lib/byok-keychain.test.ts \
  src/renderer/store/settings-store-agent.test.ts \
  src/renderer/lib/ai/client/providers/anthropic.test.ts
pnpm --dir client eval:agent:shadow-runtime
pnpm --dir client typecheck
```

离线验收覆盖设置入口唯一性、route 所有权、旧 Keychain 条目迁移、Shadow provider/model 原子归一化、Anthropic one-shot typed-tool adapter，以及三种 provider 的 deterministic driver conformance。Anthropic/OpenAI 真实付费 endpoint、原生设置页视觉与物理设备交互仍是手工/付费验收边界。
