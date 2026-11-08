# M30：长任务、记忆、上下文与主动建议

交回状态：分支 `codex/m30-long-tasks-memory`；本节对应 M30 机制提交（`git log --oneline --grep="finish M30"` 可定位）。冻结的工具接入、主页插槽及真实供应商验收见下文。

2026-11-09，轨道 3。接续 11-08 的未提交工作，按
[通用内核分轨](../handoff/kernel-v3-split.md) 收窄为运行时机制。

## 做了什么

- 每次作者请求有本机持久的 request chain；分片运行沿用原请求、补充、计划、约束和证据。每轮上限现在是保存进度的边界，不再伪装成工具错误。停止先撤销续跑授权，再等待已进入工具的结算。
- 计划命令、步骤和 exactly-once 回执写在同一个 `local_state` 事务中。任务修订冲突拒绝；一个步骤执行中；重复声明执行中不改开始时间。整书范围由当前兼容适配器枚举，增删、改名、重排必须对齐后才能完成。
- 完成依据来自本机已落盘的 F3 回执与成功读取观察，不信模型给的回执字符串。修改必须匹配目标且一次写入只能完成一个步骤；审阅必须覆盖当前版本全部段落，每条结论的引文要在原文中。后续修改使旧审阅不能完成任务。
- 续跑授权只存在于 controller 内存；两次自动分片没有真实进展就停，改计划标题或修订号不算进展。重启恢复日志与计划，但不自动调用模型。提问、外部确认、工具失败、上下文容量不足都暂停。
- 上下文保留原请求、作者补充、约束和一个下一步；普通历史按完整调用／结果组裁剪。保存源覆盖和投影哈希，历史本身不改、不删。超过容量的固定上下文停止分片，不静默截断作者要求。它是有界索引，不是文学摘要。
- Project Memory 直接读写现有 F3 memory 条目，活动正文拼成 `PROJECT_MEMORY.md`，不另造同步文档。工作记忆是本机分块 Markdown，有修订 CAS、完整性校验、分页、作者编辑及内部幂等编辑接口；不设跨书个人记忆。
- 建议生成使用一次无工具模型请求，最多四张卡，关闭联网搜索、自动重试及供应商自动续接；到实际传输 worker 退出才释放关闭屏障。整理卡由本机作者来源差分计算；作者点击才开普通读写会话，跳过消费所见批次，失败保留批次。
- 帮手空对话临时承载建议卡与唯一「主动建议」开关，面板打开／窗口重新激活尝试生成；每书每设备 90 分钟节流。同一面板可编辑项目记忆／工作记忆、手动继续保存的运行。

## 本轮边界

**没有新增工具，也没有扩 M29 目录。** 原稿中的任务计划／工作记忆工具未注册、未保留；建议生成也不用伪工具提交结果。
`long_task::Store::apply` 和 `memory::edit_once` 是宿主内部 API，不是模型可发现或调用的能力。现有 M29 `memory.*` 仍负责项目记忆。

因此本轮完成的是机制与宿主接口：模型自主建立／维护计划、自动整理工作记忆的工具接入，留给 v3 的通用工具方案。不能让提示词要求调用不存在的工具，也不能据此宣称旧版整套 M30 产品已迁完。当前单轮超限可由作者显式继续；宿主已建的计划可自动分片。

## 接口与生命周期

- `dr_agent::long_task::{Store, Command, ChainSnapshot, Continuation}`：计划、修订、结构对齐、证据及续跑决策。状态属于本机 `agent.task.*`；没有改 F1 文档结构或 F2 迁移。
- `Runtime::{start_continuation,start_resume}`、`State::Checkpointed`：独立分片；生成的续跑提示保存为版本化扩展记录，模型接入会投影，作者消息列表隐藏。
- `ToolContext::observe_read`：只给本地成功读取的执行管线。M29 原目录不变，`prose.read` 成功后绑定规范段落和 frontier；观察与 ToolFinished 同事务保存。
- `dr_agent::context`：固定事实、完整组裁剪、检查点验证及宿主历史分页读取。
- `dr_agent::memory`：`project / load / read_page / edit / replace / clear / edit_once`；读写都验证书仍存在且未回收。
- `AgentController::{start_job,resume_job,stop_conversation,task_view,workspace_job}`：在返回 future 前预留关闭租约，独立 worker 持有至 ACK；取消等待者不丢已接受的操作。
- `AgentController::{suggestions,trigger_suggestions,open_suggestion,skip_organize,dismiss_suggestion,set_proactive_enabled}`：模型任务与本机游标均由 controller 拥有，不依赖面板存活。
- `ProjectMemoryView::reveal`：按 memory id 滚动，绘制目标后 ACK；读取失败、目标移除、关闭／切书取消定位。

## 验收

契约在测试中断言，不提交生成 JSON：

- `dr-agent` 的 `long_task::tests`：CAS、重放、回滚、单执行步骤、重复执行、整书对齐、部分阅读／伪引文／旧版本拒绝、目标写入、重开、完整组上下文与检查点篡改。
- `dr-agent::memory::tests`：分块重开、并发 CAS、损坏拒绝、Unicode 分页、大文档保留、清空 ABA、幂等回执、书删除／回收、项目记忆作者与 Agent 共用。
- `dr-agent/tests/proactive.rs`：作者／Agent／远端来源、格式改动排除、有界批次不吃掉未显示文档、90 分钟、失败／恢复、卡片认领、无工具单请求与取消等待 EOF。
- `dr-agent-providers`：四路请求的无工具限制、隐藏记录投影、429／截断／401／暂停不偷偷重试、EOF 等待真实 worker。
- `dr-view-agent/tests/controller.rs`：两次无进展暂停、重启不武装、手动继续、停止撤销及取消等待者仍结算；沿用 M31 退出／工具写入屏障。

2026-11-09 定向验证：`cargo test -p dr-agent --locked --no-fail-fast` 的库／控制／恢复／协议／结算契约通过；主动建议和运行时在修正序列化及检查点断言后用 `cargo test -p dr-agent --test proactive --test runtime --locked` 重跑，14 项通过。`cargo test -p dr-agent-providers -p dr-agent-tools -p dr-view-agent --locked` 全部通过，真实 GPUI 面板、导航、退出及窗口墨迹契约包含在内；仅已有需真实凭据的认证测试忽略。全工作区门禁随轨道 3 最后一个提交统一记录。真实供应商、长文文学摘要质量不在合成测试结论内。

## 待协调

1. v3 提供项目结构及 Agent 描述后，替换当前 v2.2 的范围／来源适配器，接通宿主计划、工作记忆维护；本轮不新增按种类命令、字段或工具。
2. M02 主页插槽仍未提供：先放空对话，可有一张整理卡及最多四张模型卡，纵向自适应；点击开普通读写会话，× 只跳过对应卡／批次。真正的主页打开／激活触发由插槽 owner 调同一 controller API。
3. 章末审阅与待办入口属于冻结界面的接线，保留普通读写语义，等 v3，不在 `dr-view-page`／`dr-view-review` 增加新的按种类入口。
4. 工作记忆不自动升到跨书层。超大固定上下文会明确暂停；无文学摘要或静默删除。真实付费调用由作者验收。

## 代码位置

`next/crates/dr-agent/src/{long_task,memory,proactive,context.rs,evidence.rs}`；
`dr-agent-providers/src/{conversation.rs,transport.rs}`；
`dr-agent-tools/src/evidence.rs`；
`dr-view-agent/src/{controller,project_memory.rs,working_memory.rs,panel/continuity.rs}`。
