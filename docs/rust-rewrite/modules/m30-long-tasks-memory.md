# M30：长任务、记忆、上下文与主动建议

> 2026-11-19（格式 5 计划与工作记忆模型工具注册）：应用内帮手在 `CompanionTools` 上注册四个绑定当前会话的模型工具——`read_task_plan`、`update_task_plan`、`read_working_memory`、`edit_working_memory`（实现位于 `dr-agent/src/long_task/tools.rs`、`dr-agent/src/memory/tools.rs` 与 `dr-view-agent/src/tools.rs`）。`AgentTools` 保持仅含 `tool_search` 与 `call_tool`，继续与入站 MCP 共用同一份作者工具目录；四个长任务／工作记忆工具既不在 MCP 目录暴露，也在执行入口校验当前聊天会话的 request chain，外部 `ExternalScope` 直接调用一律拒绝。主动建议继续走无工具单请求，不设 `submit_project_checkin` 伪工具。应用重启维持不自动续跑（作者 2026-11-19 确认）：恢复本机日志与计划后等待作者手动点「继续」。详见文末「计划与工作记忆模型工具接入（2026-11-19）」。

交回状态：分支 `codex/m30-long-tasks-memory`；本节对应 M30 机制提交（`git log --oneline --grep="finish M30"` 可定位）。冻结的工具接入、主页插槽及真实供应商验收见下文。

2026-11-09，轨道 3。接续 11-08 的未提交工作，按
通用内核分轨（`handoff/kernel-v3-split.md`，已随过程文档清理删除，在 git 历史里）收窄为运行时机制。

## 做了什么

- 每次作者请求有本机持久的 request chain；分片运行沿用原请求、补充、计划、约束和证据。每轮上限现在是保存进度的边界，不再伪装成工具错误。停止先撤销续跑授权，再等待已进入工具的结算。
- 计划命令、步骤和 exactly-once 回执写在同一个 `local_state` 事务中。任务修订冲突拒绝；一个步骤执行中；重复声明执行中不改开始时间。整书范围由当前兼容适配器枚举，增删、改名、重排必须对齐后才能完成。
- 完成依据来自本机已落盘的 F3 回执与成功读取观察，不信模型给的回执字符串。修改必须匹配目标且一次写入只能完成一个步骤；审阅必须覆盖当前版本全部段落，每条结论的引文要在原文中。后续修改使旧审阅不能完成任务。
- 续跑授权只存在于 controller 内存；两次自动分片没有真实进展就停，改计划标题或修订号不算进展。重启恢复日志与计划，但不自动调用模型。提问、外部确认、工具失败、上下文容量不足都暂停。
- 上下文保留原请求、作者补充、约束和一个下一步；普通历史按完整调用／结果组裁剪。保存源覆盖和投影哈希，历史本身不改、不删。超过容量的固定上下文停止分片，不静默截断作者要求。它是有界索引，不是文学摘要。
- Project Memory 直接读写现有 F3 memory 条目，活动正文拼成 `PROJECT_MEMORY.md`，不另造同步文档。工作记忆是本机分块 Markdown，有修订 CAS、完整性校验、分页、作者编辑及内部幂等编辑接口；不设跨书个人记忆。
- 建议生成使用一次无工具模型请求，最多四张卡，关闭联网搜索、自动重试及供应商自动续接；到实际传输 worker 退出才释放关闭屏障。（整理卡切到新格式时已去掉，作者 2026-11-17 定了不加回来，见下面「建议卡回作品主页」。）
- （已过时，2026-11-17 HC：）帮手空对话临时承载建议卡与唯一「主动建议」开关，面板打开／窗口重新激活尝试生成。现在卡在作品主页、开关在设置，见下面一节；每书每设备 90 分钟节流照旧。同一面板可编辑项目记忆／工作记忆、手动继续保存的运行（照旧）。

## 建议卡回作品主页（HC，2026-11-17）

作者 2026-11-17 在整窗原型上选完、说了迁（kernel-v5 第 15 节第 46、47 条，任务书 HC）。没改建议生成：卡的数据、点卡、×、触发都走 controller 现成的接口。

**作者会看到的。**
- 打开项目落在作品主页（或关掉最后一个标签、点项目主页、窗口回到前台而主页在前面）时，Agent 看一眼最近的改动；同一个项目在同一台电脑上 90 分钟最多一次，「主动建议」关着或没连模型时什么都不跑。看完的卡排在主页「继续写」下面、新建那一行上面，两列，一张卡一格，没有小标题、不能收起。开着、没开成书的项目一样；编辑模板的工作区里不出卡、不看。
- 正在看时卡上面一行转圈的记号加「Agent 正在看你最近的改动……」，上一次的卡照旧摆着，看完再换；没看成时一行「没能看完最近的改动：…」，卡照旧。看完没卡、关着、没连模型时这一处什么都不画。
- 主页只摆最近一次看完的那几张卡（最多四张，点过的也在、写「查看对话」）；以前那几次点过的卡，新的一次看完以后主页上就不摆了，存储里照旧留着（存储最多 12 张，没改）。原型没画，2026-11-17 审阅修补时按「这一次看完再换」「Started 的卡留着」最保守地定的，等作者看。
- 正在看或有一张卡正在开始时，所有卡和 × 都点不了（HC2）。从接下查看请求开始，包括算 90 分钟和读取最近改动的时间，都会出「正在看」那一行。
- 没看成时按原因写「连不上模型」「最近的改动太多，一次看不完」「模型的回复读不出来」，其余原因和旧英文原因写「出错了」（HC2）。
- 一张卡从上到下：它指着的条目（灰色的条目记号加名字，没有就不画）、标题、细节、「交给 Agent」；右上角 ×（读屏叫「忽略」）。整张卡是一个按钮，素玻璃静止态，字都是字的颜色。
- 点卡：开一段新对话，右栏打开、停在 Agent、选中这段对话，主页不动；卡留着，「交给 Agent」变「查看对话」，再点是打开同一段对话。那段对话已经没了时，右栏照样打开到 Agent，什么都不选，卡照旧（原型没画，最保守的做法）。开始失败时卡框外的下方显示「没能开始：…」，原因是「这张卡已经不在了」「主动建议关着」「另一张卡正在开始」或「出错了」。卡的读屏名用「标题，交给 Agent」或「标题，查看对话」（HC2）。× 就没了，不问、不能撤回，重开主页、重开项目也不回来。
- 「主动建议」开关在设置 → 智能 → Agent 那一页最后一行（`agent.proactive_suggestions`，只管这台电脑，默认开，没有说明文字），主页和 Agent 栏里都没有。关掉：主页上什么都不画，正在看的停下；停下不算没看成，不出那一行，这一次也不算进 90 分钟（App 关掉时停下的一样）。打开：下次主页露出来时看。开发库里原来存在设备记忆的旧值不搬（没发布过）。
- Agent 栏空对话里不再有卡和开关，打开面板、窗口激活都不再让 Agent 看；「项目记忆」「工作记忆」两颗按钮照旧。
- 0.1 那张 App 自己算的「把上次写的整理进要素」卡、整理结果卡、主页对话框都不做；铃铛里「整理」那一类通知（`Source::Organize`、`notifications.organize.source`）删了。写书模板写给 Agent 的话没改，Agent 看完出的卡里照样可以提整理。

**接法。**
- 卡：`dr_view_agent::home_cards::HomeCards`（`new(workspace, cx)`、`drawn`、`shown`），应用初始化处交给 `dr_view_home::set_agent_cards`（`app/drifting/src/main.rs`，[M02](m02-home.md) 最上面一节）。主页在前面时调 `shown`；`HomeCards` 在 controller 和模型连接都就绪以后才调 `trigger_suggestions`（应用一打开就落在主页时，controller 还在初始化，看的请求先记着，就绪时补上）。
- 读卡：`suggestions`；controller 的唤醒信号到了就后台重读，只留最近一次看完的卡（`created_ms == last_checkin_ms`）。controller 接下查看或开卡的操作时唤醒订阅者。主页用当前项目的操作和已读到的状态更新提示，并用同一个忙态拦点卡和 ×。
- controller 的其他补丁（2026-11-17 审阅修补，不改生成）：「主动建议」关掉或 App 关掉时停下的那一次走 `ProactiveStore::cancel_checkin`（不记错，`last_attempt_ms` 放回开始前的值）；是不是作者停的看 controller 另记的标记（`SuggestionStop::stop` 只在这两处设），不看取消信号，因为请求自己失败时也会把取消信号设上。请求没成由 `fail_checkin` 存查看失败的种类；`set_proactive_enabled` 值没变时什么都不做、不唤醒；`has_conversation(book, conversation)` 给「查看对话」先看那段对话还在不在。
- 点卡：`Open` 的卡调 `open_suggestion`（系统提示词照面板的写法），成了以后把这段对话记成这本书的当前对话（工作区的书记忆 `agent.conversation`），调外壳新加的 `Workspace::reveal_companion` 把右栏打开到 Agent（铺满着时先退出铺满，照 `reveal_library`），已经在的 Agent 面板选中这段对话（`AgentPanel::show_card_conversation`）。`Started` 的卡先在后台问 `has_conversation`：还在就直接打开那段对话，不再请求；没了就只 `reveal_companion`，不记、不选。
- ×：`dismiss_suggestion`，controller 写入后更新主页；正在看或开卡时点 × 不先移走卡。
- 开关：设置登记表一条 `SettingDef`（`registry::AGENT_PROACTIVE`，`Kind::Switch`、`Scope::Device`）；`HomeCards` 绑定 controller、每次看之前把它交给 `set_proactive_enabled`，设置变化时只在这一项变了才交（别的设置写入，比如书的布局，不再让每个 Agent 面板和卡重读数据库）。场景里写在设置文件 `device` 下（`dr-cli/scenarios/k5-shared-preview.json`），不在 `device.modules`。

**测试**（合成模型流 `ScriptedDriver`，回环地址，不调真实模型）：`dr-view-agent/tests/home_cards.rs`——主页露出来看一次（单次请求、无工具），三张卡两列按顺序排，第一张指着改过的那一章；90 分钟内主页再露出来只记一次打开、不再请求；点卡开对话、右栏停在 Agent 这段对话、主页不动、卡留着、请求带卡的指示；面板换到新对话后再点卡回到同一段、不再请求；× 以后界面和存储里都没了，主页再露出来也不回来；开始失败（controller 不让开）时卡下面那一行、卡还是 `Open`，再点成了；设置里那一项是开关、只管这台电脑、默认开、在 Agent 页最后一行、没有说明；开关关着打开项目不看、不记打开、主页上什么都没有，打开以后不立刻看、下次主页露出来才看，再关上主页上什么都没有、卡留在存储里；没连模型时不请求、主页上什么都没有（存储里有上次的卡也不画）；正在看时那一行在卡上面、上一次的卡还在，看完换成这一次的；看失败时失败那一行在、卡还在，冒号后面按种类本地化（见 HC2）；看完零张卡时主页上什么都没有；打开 Agent 面板、窗口激活而主页不在前面时不让 Agent 看，空对话里项目记忆那一行下面隔一格就是空对话的第一行（中间没有卡和开关）。2026-11-17 审阅修补加的：正在看时点卡不开始、× 不拿掉卡（主页和存储都在），看完以后新卡能点；看到一半关掉「主动建议」不记错、不算进 90 分钟，再打开没有失败那一行，下次主页露出来就看；只摆最近一次看完的卡（以前点过的看完以后不摆、存储里还在，这一次点过的写「查看对话」）；别的设置写入不唤醒 controller 的订阅者，开关变了唤醒一次；「查看对话」的对话没了时右栏打开到 Agent、什么都不选、卡照旧；× 以后换个项目再回来也不回来。「什么都没发生」的判断都等一个确定的信号（`HomeCards::settled`：自己让看的那一次做完、读卡做完、没有卡在开始；面板那边是 controller 的 `active_count`），不再等几帧；点卡以后数模型请求也先等 `active_count` 回到 0（卡变成「已开始」时运行才刚登记，请求是运行自己的线程随后发的）。`dr-agent/tests/proactive.rs` 的 `a_cancelled_checkin_keeps_no_error_and_does_not_count` 测数据层的停下。主页那一侧见 [M02](m02-home.md)。

**真窗口**（副屏，合成模型流）：`next/crates/dr-view-agent/scenarios/home-cards.json`，只跑例程 `home-cards-acceptance`（临时 showcase 库《慢钟》、进程内的候选 Key、回环地址，不连真实服务）：

```bash
cargo build -p drifting --example home-cards-acceptance --features debug-bridge --locked
cargo drifting workspace scenario crates/dr-view-agent/scenarios/home-cards.json \
  --app target/debug/examples/home-cards-acceptance --out <输出目录>
```

打开项目落在主页、三张卡两列在「继续写」下面、主页和 Agent 栏都没有「主动建议」开关；点卡右栏停在 Agent 那段对话、主页不动、卡变「查看对话」；× 掉一张；设置里搜「主动建议」关掉，主页上什么都没有、下面的块上移；再打开卡回来；深色再开一次。2026-11-17 跑过 55 步、0 pending，截图（浅色、深色）在作者机器的验收日志目录里，不进仓库。

## 本轮边界（2026-11-09 初次交回；工具已于 2026-11-19 注册）

> 注：本节保留 2026-11-09 机制提交时的边界记录；格式 5 下的四个会话级模型工具（`read_task_plan`、`update_task_plan`、`read_working_memory`、`edit_working_memory`）已于 2026-11-19 在 `CompanionTools` 注册，见文末小节。

**（2026-11-09 当时状态）没有新增工具，也没有扩 M29 目录。** 原稿中的任务计划／工作记忆工具当时未注册；建议生成不用伪工具提交结果。
`long_task::Store::apply` 和 `memory::edit_once` 当时先作为宿主内部 API 落地，现有 M29 `memory.*` 仍负责项目记忆。

因此本轮完成的是机制与宿主接口：模型自主建立／维护计划、自动整理工作记忆的工具接入，留给 v3 的通用工具方案。不能让提示词要求调用不存在的工具，也不能据此宣称旧版整套 M30 产品已迁完。当前单轮超限可由作者显式继续；宿主已建的计划可自动分片。

## 接口与生命周期

- `dr_agent::long_task::{Store, Command, ChainSnapshot, Continuation}`：计划、修订、结构对齐、证据及续跑决策。状态属于本机 `agent.task.*`；没有改 F1 文档结构或 F2 迁移。
- `Runtime::{start_continuation,start_resume}`、`State::Checkpointed`：独立分片；生成的续跑提示保存为版本化扩展记录，模型接入会投影，作者消息列表隐藏。
- `ToolContext::observe_read`：只给本地成功读取的执行管线。M29 原目录不变，`prose.read` 成功后绑定规范段落和 frontier；观察与 ToolFinished 同事务保存。
- `dr_agent::context`：固定事实、完整组裁剪、检查点验证及宿主历史分页读取。
- `dr_agent::memory`：`project / load / read_page / edit / replace / clear / edit_once`；读写都验证书仍存在且未回收。
- `AgentController::{start_job,resume_job,stop_conversation,task_view,workspace_job}`：在返回 future 前预留关闭租约，独立 worker 持有至 ACK；取消等待者不丢已接受的操作。
- `AgentController::{suggestions,trigger_suggestions,open_suggestion,dismiss_suggestion,set_proactive_enabled}`：模型任务与本机游标均由 controller 拥有，不依赖面板存活。（`skip_organize` 随整理卡去掉了。）作品主页的建议卡（`dr_view_agent::home_cards`，HC）是它们现在唯一的调用方。
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
2. **已做（HC，2026-11-17）**，见上面「建议卡回作品主页」。原来的记录：（作者 2026-11-16 定：建议卡放回作品主页，任务书 HC；章末 ⁂ 上的「交给 Agent 审阅」随 ⁂ 的功能去掉不做了，[kernel-v5.md](../kernel-v5.md) 第 15 节第 34、41 条。2026-11-17 在整窗原型上定了样子：主页「继续写」下面两列，「主动建议」开关挪进设置 → 智能 → Agent，Agent 栏空对话里不再放卡，点卡右栏停在那段新对话；0.1 那张 App 自己算的整理卡去掉，不加回来，第 46、47 条。）M02 主页插槽仍未提供：先放空对话，可有一张整理卡及最多四张模型卡，纵向自适应；点击开普通读写会话，× 只跳过对应卡／批次。真正的主页打开／激活触发由插槽 owner 调同一 controller API。
3. 章末审阅与待办入口属于冻结界面的接线，保留普通读写语义，等 v3，不在 `dr-view-page`／`dr-view-review` 增加新的按种类入口。
4. 工作记忆不自动升到跨书层。超大固定上下文会明确暂停；无文学摘要或静默删除。真实付费调用由作者验收。

## 代码位置

`next/crates/dr-agent/src/{long_task,memory,proactive,context.rs,evidence.rs}`；
`dr-agent-providers/src/{conversation.rs,transport.rs}`；
`dr-agent-tools/src/evidence.rs`；
`dr-view-agent/src/{controller,project_memory.rs,working_memory.rs,panel/continuity.rs,home_cards.rs}`；
主页那一侧 `dr-view-home/src/agent_cards.rs`。

## 小说模板的临时边界（轨道 3 第二项）

当前小说专用的项目指导、H1/H2/H3 规则、check-in 提示、正文整理提示以及 onboarding 提示词绑定统一在 `dr-agent/src/novel_template.rs`；文件旁明确写了 v3 将它们移入小说模板。通用作者控制／工具诚实性／冲突规则仍在面板的通用 system prompt 组装处，机制不自行假定小说语义。既有翻译正文保留原本的本地化单一来源，由集中登记的键引用，不复制、手改生成翻译文件。当前 v2.2 数据适配器的种类字符串是读写映射，不是提示词，也未扩充。

`novel_starters_keep_existing_translations` 与已有 onboarding／proactive 契约覆盖模板搬移；工具冻结断言保持三个内建入口。M30 机制提交：`5b97462b`。

轨道 3 全量复核补充：原生 onboarding 保留生成 Key 的类型适配，契约逐项核对集中模板的键名，防止与唯一翻译来源漂移；移除未呈现的暂停状态／记忆说明所对应的冗余翻译登记，没有修改翻译正文。

统一条目（内核 v4，T3，2026-11-13）补充：`dr-agent/src/evidence.rs` 的 `capture_settlements` 在核对步骤写入目标时显式跳过 `checkpoints:<book>`、`stats:<book>` 等非书目／非正文侧文档回执，避免写前自动 `entry_snapshot` 打点产生的侧文档回执在长任务证明阶段触发 `WrongKind`，同时保持对 `book:<id>` 与正文文档目标的严格核对。`dr-view-agent` 主动建议的 `checkin_project` 同步改走 `Workspace::read_book_v3` 活文档读取，避免大书历史重放。

内核 v5（T7，2026-11-15）补充：`dr-agent/src/evidence.rs` 的 `book_entities` 补齐 `templates`、`meta`、`project`、`tabs`、`assets`、`asset_folders`、`relation_types`、`facts`、`memory`，使 `book:<id>` 上所有格式 5 命令回执均产出精确的 `WriteProof` 目标，同时 `DocId::Layout(_)` 侧文档写入继续静默跳过（`LAYOUT-DOC-QUIET`）。`dr-agent/src/proactive/delta.rs` 定下格式 5 的 `DeltaMode` 规则：文本素材已并入普通条目正文（`DocId::Body`），产品代码不按内置模板 id 特判，所有未删除条目的正文在 `AllProse` 与 `LocalAuthorBodies` 下均参与，两种模式仅按修改来源区分（`AllProse` 含本机作者、Agent 与远端同步；`LocalAuthorBodies` 仅含本机作者）。主动建议 check-in 上下文（`CheckinContext::open_comments`）与系统提示词同步改为统一批注模型（收集全部未解决批注并附来源 `origin`，不再保留旧待办措辞，项目说明从 `project.agent` 读取）。

## 内核 v5 HC2 · 建议卡的失败、忙态和读屏名（2026-11-18）

依据 [kernel-v5](../kernel-v5.md) 第 15 节第 51、52 条和「替作者定的」最后一组。

- **失败的原因**。`dr-agent::proactive` 在收模型流和核对上下文时返回 `CheckinFailure`。`ProactiveStore::fail_checkin` 在原本的本机建议状态里写下种类，旧字符串仍可读取并显示「出错了」。开卡返回 `SuggestionStartError`，主页用界面语言写出原因。作者关开关或正常退出仍走取消路径。
- **一组卡一起锁**。`dr-view-agent` 的 controller 接下查看请求时登记忙态，读改动和检查时间间隔时就能画「Agent 正在看你最近的改动……」。开一张卡期间，同组的卡和 × 一起点不动，× 用现有按钮的禁用墨色。卡上正常操作的读屏名包含标题和动作。
- **验收**。`dr-view-agent/tests/home_cards.rs` 用合成资料覆盖失败提示、旧书库中的英文、落下查看票据前的忙态、开始一张卡时的连点和忽略。`tests/v3_guidance.rs` 核对装不下时写入的原因和没有向模型发请求。`dr-view-agent/scenarios/home-cards-hc2.json` 用上文例程验证超时、上下文装不下和真实连点，并核对「交给 Agent」「查看对话」两种读屏名。

### HC2 合并验收

合并树 `8631926ac` 的全套检查通过，Rust 工作区 3117 项通过、0 失败、21 项原有忽略。macOS 副屏的 HC2 场景 27 步、旧 HC 场景 57 步均通过，用合成模型核对网络超时、上下文超限、开卡时点别张卡与关闭按钮、读屏名及打开对话。后续合进的 NE 验收文档通过受影响的仓库检查，产品代码一致。

## 计划与工作记忆模型工具接入（2026-11-19）

- **工具边界与入站 MCP 隔离**。`dr-view-agent/src/tools.rs` 的 `CompanionTools` 在 `tool_search`、`call_tool`、`ask_user` 旁注册四个绑定当前聊天会话的模型工具：`read_task_plan`、`update_task_plan`（`dr_agent::long_task::tools`）与 `read_working_memory`、`edit_working_memory`（`dr_agent::memory::tools`）。`dr-agent-tools::AgentTools` 保持不变（仅含 `tool_search` 与 `call_tool`，目录仍严格由 `dr_workspace::registry()` 加书内模板动作投影），因此入站 MCP 不会发现或列出会话局部的计划与工作记忆工具；同时四个工具在执行端均先校验 `long_task::Store::chain_for_session(session)` 并核对 `context.book`，不建 request chain 的外部 `ExternalScope` 直接调用也会被明确拒绝。主动建议保持无工具单请求，不注册 `submit_project_checkin`。
- **格式 5 目标解析与编辑证明**。`long_task::Store` 支持按 `<条目 id 或标题>/<模块 id 或名称>` 混合解析正文模块目标；`whole_book` 计划完成提示统一按格式 5 成书序列（`book-sequence`）表述，结构变动（增删、改名、重排）后仍须先 `reconcile` 对齐才能 `complete`。`WorkKind::Edit` 步骤只认写到目标内容上的本机 `WriteProof`：`WriteProof` 另记一项 `content`（新增字段，旧记录读出来是 `None`），只收正文写入（`body:<entry>/<module>` 与所属的 `entry:<id>`）和条目模块内容的改动（该条目自身的字段、键值表、媒体，以及挂在它上面的补丁与情节规划表，记为 `entry:<id>`）。模块目标要求 `content` 里有它的正文 `body:<entry>/<module>`；条目目标要求 `content` 里有 `entry:<id>`，即改了它任一模块的内容（如 `module.put_patch`）。批注、点名该条目的关系行、归属、时间线泳道与摆放、标题等元数据只记在 `targets` 里（锚到该条目），不能完成编辑步骤。`content` 为 `None` 的旧证明按原规则核对（`targets` 含目标键：有唯一正文的目标是该正文、否则 `entry:<id>`）。证明 id 与命令哈希不变（测试 `dr-agent/src/long_task/tests.rs::edit_steps_need_content_writes_not_comments_relations_or_titles`）。
- **工作记忆投影、整理提示与冲突停止**。`CompanionTools::context_contributions` 注入非空 `WORKING_MEMORY.md` 时在 `source` 附带当前 `revision` 与估算 token 数；模型在首次创建或跨轮编辑时走 `read_working_memory` 分页读取，凭 `expected_revision` 调 `edit_working_memory` 做基于 `memory::edit_once` 的精确查找替换与追加（同 `call_id` 重放幂等）。同一回合内在 `WORKING_MEMORY.md` 上连续冲突两次返回 `ToolOutput::Stop`（`conflict_limit`）并停止本轮，避免盲目循环覆盖作者在面板中的编辑。工作记忆跨过 20k／40k／80k token 档位时，`PendingStart::run` 只在作者发起的新回合（`StartRequest::Author`，即 `start`／`start_job`）起点消费一次 `memory::take_notice` 并在本轮系统提示词追加整理说明；作者手动「继续」（`resume_job`）和自动续跑分片都不追加，缩回阈值以下后重新武装。整理说明在这一轮真正开始之前就已消费：若随后开始失败（续跑授权已撤销、运行时拒绝开始），这一档的提示就不再出现，直到档位变化（80k 以上每个作者回合都会提示）。
- **重启保持手动继续（作者 2026-11-19 定）**。重开书库或重启应用只恢复本机日志、会话状态与计划快照，绝不自动武装续跑或自动向模型发请求；未完成的长任务继续留在面板上由作者显式点「继续」（`AgentController::resume_job`）。
- **端到端契约**。`dr-view-agent/tests/m30_tools.rs` 覆盖：格式 5 整书审阅建计划与读写工作记忆、轮数上限检查点自动分片续跑、分片中保留钉住的工作记忆与下一步、第二片请求挂起时作者停下、计划仍是进行中且还有步骤，模拟重启后确认不开始运行、不自动发请求，再手动继续跑完书目变更对齐与完成、指定条目目标的 `module.put_patch` 编辑证明、工作记忆超 20k 档位单次整理提示、同回合两次 CAS 冲突停止，以及同 `AgentController` 上 `ExternalScope` 调用四个工具全部拒绝。`dr-view-agent/tests/local_context.rs` 同时验证新增四个工具 Schema 后，《慢钟》在 32768 兜底上下文窗口下首轮消息仍正常发出。
