# Shadow / General Agent 共享 Runtime

## 结论

Shadow Mode 的 semantic judge、`/goal evolve` critic 和受限 editor 现在都运行在 General Agent 的 canonical `AgentRuntime` 上。以后 provider tool-loop、上下文规划、reasoning replay、工具参数校验、取消、预算与终止策略只在 runtime/provider driver 层维护一套；Shadow 只保留自己的产品策略。

这不是把 Shadow 伪装成聊天 Agent。Shadow 的确定性外环（staleness、规则分组、依赖图、finding 落库、evolve 收敛）仍然归 Shadow；共享的是其中需要模型反复取证或编辑的 agent leaf。

## 分层

```text
Shadow review / evolve policy
  └─ lib/shadow/agent-runtime.ts
       ├─ 固定工具白名单（review 只读；evolve editor 只有两个写工具）
       ├─ 轮数 / tool-call 上界
       ├─ 显式 completion tool
       └─ trace / usage 映射
            ↓
Canonical AgentRuntime
  ├─ context planning / compaction boundary
  ├─ tool validation / execution / cancellation
  ├─ provider-neutral toolChoice + reasoning
  ├─ journal / deterministic reducer
  └─ structured completion boundary
            ↓
AgentModelDriver
  ├─ DeepSeek: OpenAICompatibleCompletionDriver
  ├─ Anthropic: AnthropicMessagesDriver
  └─ OpenAI: OpenAIResponsesDriver
```

General Agent 直接组装同一个 `AgentRuntime`。Shadow 的 `runShadowAgentRuntime` 只是 workload profile，不再包含 `client.complete()` 或 `for (round)` provider loop。

## Provider 路由

- BYOK Shadow 与 General Agent 都从全局 `byok.<provider>` Keychain 条目懒加载凭据；设置页只有「模型与 API」能写这些条目。
- 两者的多轮 leaf 共用 `DriftingAgentModelDriver`：DeepSeek 走 `OpenAICompatibleCompletionDriver`，Anthropic 走原生 Messages driver，OpenAI 走原生 Responses driver。provider/model 在一次 run/turn 开始后冻结。
- Shadow 的 rule compile、单次 semantic eval 与 arc stage 仍走轻量 `LLMClient` substrate；`buildShadowClient` 按 Shadow 的显式 route 构造 DeepSeek、Anthropic 或 OpenAI one-shot adapter，不再按“哪个 key 恰好存在”猜 provider。
- Google Key 仍在统一凭据页管理，但当前只供 Copilot 使用；Shadow/General Agent 的多轮 tool protocol 尚未认证 Google，因此它不会出现在这两个功能的模型列表里。
- Hosted Shadow 经 `ServerProxyProvider` 进入兼容 seam；当前 BYOK-only 产品不会静默回退到 hosted 或把模型 id 交给错误 endpoint。

## Structured completion

Shadow judge 必须调用 `submit_verdicts`，evolve editor 必须调用 `finish_edits`。`AgentRuntimeRunInput.completionTool` 统一处理：

1. 普通文字回答不能结束任务，runtime 会追加结构化提交提醒。
2. 最后一轮只暴露 completion tool，并通过 provider-neutral `toolChoice: { force: name }` 强制调用。
3. DeepSeek 最后强制轮关闭 reasoning，避免 forced tool choice 与 thinking 的协议冲突。
4. 只有成功校验并执行的 completion call 才写入 `completion_tool_accepted` journal event 并完成 turn。
5. 调用方从 `AgentRuntimeRunResult.completionTool.arguments` 取得类型化的最终 payload，不再从自由文本猜结果。

## Shadow 保留的边界

- review profile 只安装 `AGENT_READ_TOOLS + submit_verdicts`；未知工具由 runtime fail closed。
- evolve editor 只安装 `edit_block`、`edit_blocks`、`finish_edits`，写入仍走 `runAgentTool` 和 live Yjs / soft review 路径。
- Shadow leaf 不持久化聊天 history、不安装 MCP、不申请 General Agent durable grants；这些不是 advisory CI 所需能力。
- Shadow 的 finding、consulted dependency、job trace 和 evolve orchestration 仍使用既有 Shadow store/repository。

## 验收

机器门禁：

```bash
pnpm --dir client eval:agent:shadow-runtime
pnpm --dir client exec vitest run src/renderer/lib/ai/provider-settings.acceptance.test.ts
pnpm --dir client eval:shadow:live
pnpm --dir client typecheck
```

`shadow-shared-runtime.acceptance.test.ts` 会阻止 semantic judge 或 evolve editor 重新引入自己的 `client.complete()` / round loop；`provider-settings.acceptance.test.ts` 保证四种 Key 只出现在统一凭据面板、Copilot/Shadow 仍保留各自 route、General Agent 的 route 只在对话框选择；`completion-tool.test.ts` 则覆盖 prose-only 拒绝、最后一轮 forced completion、reasoning 关闭和 typed result。

`eval:shadow:live` 是显式付费 DeepSeek canary。它从 `private-service/.env` 隔离读取凭据，要求模型先调用 `read_canon`，把随机 nonce 随工具结果带进下一轮，再用 `submit_verdicts` 完成结构化裁决；因此能同时覆盖真实 endpoint、thinking tool-call 的 `reasoning_content` replay、工具结果回灌、schema 校验和 completion-tool 终止。短回答可能只产生一个可见 text delta，验收只要求它在 `turn_finished` 前被正确投影，不依赖 provider 任意的网络分块数量。

### 2026-08-02 真实付费端点记录

- General Agent：`pnpm --dir client eval:agent:canary` 通过。两个产品回合均在 2 iterations 完成，工具轨迹分别为 `list_nodes@1:ok` 和 `get_overview@1:ok`；总 token 为 `2179+161`、`2127+147`。
- Shadow：`pnpm --dir client eval:shadow:live` 通过。`deepseek-v4-flash` 在 2 iterations 完成 `read_canon → submit_verdicts`，总 token 为 `1373+362`，随机 nonce、冲突 verdict 与 `completion_tool_accepted` 均通过断言。
- 本机本轮只有 DeepSeek 付费凭据可用；Anthropic/OpenAI 未执行，不能计为真实端点已验收。三者的确定性 wire conformance 仍由离线 suite 覆盖。

未由离线验收覆盖：Anthropic/OpenAI 付费端点、付费 hosted 路由、原生 UI/长时间后台行为。它们仍需对应凭据与产品级验收。
