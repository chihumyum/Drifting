# P6：产品可用 Agent 闭环验收

> 这是 P6 当时 checkout 的历史验收记录。当前工具数量、context、长任务和待办边界以
> [`agent-capabilities.md`](agent-capabilities.md) 与
> [`CURRENT_STATUS.md`](CURRENT_STATUS.md) 为准。

日期：2026-07-31

## 结论

这一阶段完成了 Drifting 内置 Agent 从“runtime 骨架”到“可在真实 App 链路中稳定读工具并流式回答”的闭环：

- DeepSeek 文本与并行工具调用均走真实流式传输。
- Agent Panel 通过现有 transport、legacy projector 和 transcript reducer 增量显示文本，结束时正确收尾。
- 工具 schema 每轮最多暴露 8 个；明确目录、命名素材、已接受元素演变等请求使用最窄工具。
- 缺必填参数、非 JSON 参数、畸形流、缺失 finish/usage、半截工具调用全部 fail closed，不再被伪造成 `{}` 或成功日志。
- 结果分页、重复读取抑制、重复失败熔断和最终回答预算均由 runtime 结构化状态控制，不信任模型文本 marker；并行长结果按各自 `resultRef` 独立收尾。
- 项目名称、事实和真实 dispatcher 元数据均校验 `projectId`，避免切书竞态泄漏上一项目。

这不是“已对标 Claude Code”的声明。当前退出条件是 Drifting 产品内的 DeepSeek Agent 读/写基础设施、工具循环和 Panel 流式链路可用；多 provider 认证、provider reasoning state 重放、原生设备视觉手验和更广泛长任务智能仍是后续阶段。

## 真实根因

App 日志显示的 `{}` 有两类：

1. `list_nodes`、`get_overview` 等空 schema 工具本来就应使用 `{}`。
2. 真正错误的是模型在约 30 个同时暴露的 schema 中选中 `read_node` 一类必填参数工具，却没有给 `node`；此外，completion-only fallback 会把不可 JSON 序列化的 provider 参数静默改成 `{}`。

同时，部分 read result 含可选 `undefined`，进入严格 portable persistence 前未归一化，导致“工具实际读成功、runtime 却记录失败”。旧 completion 路径也只在整段完成后一次性投影文本，所以 Panel 看起来突然跳出结果。

## 本阶段实现

### 模型与协议

- `DeepSeekProvider.stream()` 保留完整工具历史、schema、并行 call index、usage 和 finish reason。
- `LLMClient` 在 interceptor `after()` 之前校验完整 terminal topology；错误只进入 `onError()`。
- 严格 Agent 请求要求稳定且唯一的 call id、非空工具名、连续 call index、合法 JSON object 参数，以及与工具拓扑一致的 `tool_calls` finish reason。
- completion-only provider 的 BigInt、循环引用、`undefined`、函数、Symbol、NaN/Infinity 等参数直接失败，不再降级为 `{}`。
- 文本首段立即显示，后续以 24ms / 256 字符上限合并；工具参数按 provider fragment 立即增量转发。

### Runtime 与工具选择

- `agentToolSearch` 新安装和 v20 升级默认 `auto`，每轮最多 8 个认证工具；该偏好已进入跨设备同步。
- 显式目录请求成功后直接合成；命名素材固定使用 `read_material`；已接受的元素演变固定使用 `get_element_patches`。
- 显式跨项目读取不暴露数据工具，模型只能拒绝；handler 仍独立执行项目隔离。
- 待分页状态只由真实工具结果的 `truncated` / `resultRef` 驱动；某个最终页的 `truncated:false` 只关闭自己的 ref，所有 ref 完成后才撤下分页工具。
- 普通重复读取只抑制紧邻上一批；自包含目录请求才使用 turn 内累计覆盖，避免把未版本化读结果长期当缓存。
- 只有本轮实际暴露了工具时，才为最终 synthesis 预留最多 2048 个 output/total token；明确无工具的直接回答拿到完整额度，工具回合在预算临界时提前进入无工具回答。
- 两轮完全相同的全失败工具批次后强制合成，避免空参数/错误参数无限重试。

### 产品链路

- `projectName` 作为 canonical author-visible 字段进入 Agent start protocol，绝不从 opaque `projectId` 猜书名。
- `get_project_brief` / `get_overview` 只有在 `currentProject.id === ctx.projectId` 时读取项目元数据。
- 设置页和 Composer 隐藏当前 driver 不支持的 thinking/effort 控件；状态兼容字段保留，runtime 仍强制关闭 reasoning。
- live product canary 经过 `DriftingAgentModelDriver → LocalGeneralAgentTransport → LegacyAgentEventProjector → applyEvent`，不再只验证裸 `AgentRuntime`。

## 验收证据

确定性验收：

- `pnpm --dir client test:agent-runtime`：34 files / 293 tests passed。
- `pnpm --dir client test`：94 files / 589 tests passed。
- `pnpm typecheck`：Core 与 Server 通过。
- `pnpm lint`：0 errors；仅保留仓库既有 warnings。
- production renderer Vite build：通过；仅保留既有 CSS highlight、dynamic import 和 chunk-size warnings。

真实 DeepSeek product canary：

- `list-current-chapters`：2 iterations，唯一工具 `list_nodes@1:ok`，下一轮 schema 为空，27 个 Panel 文本增量。
- `introduce-current-novel`：2 iterations，唯一工具 `get_overview@1:ok`，下一轮 schema 为空，30 个 Panel 文本增量。
- 两个场景均验证 Panel 中工具卡 `running → ok`、assistant `streaming:true → false`。

22 场景 × 3 次真实模型 corpus：

- 65 / 66 通过（98.48%），read 59 / 60（98.33%）。
- input 204,956；output 9,503；总计 214,459 tokens。
- median 1,867ms；p95 6,389ms；max 9,224ms。
- unauthorized write、cross-project、unknown tool、fixture mutation 均为 0。
- 唯一 miss 是一次元素演变场景的过度读取；随后加入确定性窄路由，独立 3 次回归全部只调用一次 `get_element_patches` 并通过。

机器可读结果见 `p6-product-canary-summary.json`。凭据、prompt、answer 和原始 provider error 均未写入该文件。

## 尚未宣称完成

- 用户仍需在真实 App 中目测 Panel 的动效节奏；自动验收证明了增量事件与状态收尾，不等于原生视觉验收。
- production driver 当前只认证 DeepSeek；LLMClient/driver seam 已对 completion-only provider fail closed，但 Anthropic、OpenAI、Gemini 等尚未做 live certification。
- provider reasoning state 尚未跨工具轮重放，因此 thinking UI 被有意隐藏。
- corpus 通过率不是通用智能保证；长任务规划、subagent、shell/code editing、MCP/plugin 生态仍是与 Claude Code 的主要距离。
