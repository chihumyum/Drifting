# M30：长任务、记忆、上下文与主动建议

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
- 正在看时卡和 × 都点不了，和正在开始的那张卡一样：看一眼占着这本书唯一的建议操作，点了只会报错、× 了又回来。主页自己让 Agent 看、还没看到「正在看」那一下，点卡、× 也一样不理，不出字。
- 没看成那一行冒号后面：请求没成（controller 记的是 `suggestion request did not complete`）写现成的「请求失败（provider 不可用或网络问题）」（`settings.byokProvider.requestFailed`）；别的原样。原型画的是「请求超时」。
- 一张卡从上到下：它指着的条目（灰色的条目记号加名字，没有就不画）、标题、细节、「交给 Agent」；右上角 ×（读屏叫「忽略」）。整张卡是一个按钮，素玻璃静止态，字都是字的颜色。
- 点卡：开一段新对话，右栏打开、停在 Agent、选中这段对话，主页不动；卡留着，「交给 Agent」变「查看对话」，再点是打开同一段对话。那段对话已经没了时，右栏照样打开到 Agent，什么都不选，卡照旧（原型没画，最保守的做法）。开始期间卡点不了、× 也不掉（数据层也留着正在开始的卡）；开始失败时卡下面一行「没能开始：…」，冒号后面是 controller 的原话（没有现成的字：`proactive suggestions are disabled`、`suggestions disabled`、`suggestion is no longer available`、`suggestion operation already running`、Agent 库正在关的那句、模型连接给的原因），卡还能点。× 就没了，不问、不能撤回，重开主页、重开项目也不回来。
- 「主动建议」开关在设置 → 智能 → Agent 那一页最后一行（`agent.proactive_suggestions`，只管这台电脑，默认开，没有说明文字），主页和 Agent 栏里都没有。关掉：主页上什么都不画，正在看的停下；停下不算没看成，不出那一行，这一次也不算进 90 分钟（App 关掉时停下的一样）。打开：下次主页露出来时看。开发库里原来存在设备记忆的旧值不搬（没发布过）。
- Agent 栏空对话里不再有卡和开关，打开面板、窗口激活都不再让 Agent 看；「项目记忆」「工作记忆」两颗按钮照旧。
- 0.1 那张 App 自己算的「把上次写的整理进要素」卡、整理结果卡、主页对话框都不做；铃铛里「整理」那一类通知（`Source::Organize`、`notifications.organize.source`）删了。写书模板写给 Agent 的话没改，Agent 看完出的卡里照样可以提整理。

**接法。**
- 卡：`dr_view_agent::home_cards::HomeCards`（`new(workspace, cx)`、`drawn`、`shown`），应用初始化处交给 `dr_view_home::set_agent_cards`（`app/drifting/src/main.rs`，[M02](m02-home.md) 最上面一节）。主页在前面时调 `shown`；`HomeCards` 在 controller 和模型连接都就绪以后才调 `trigger_suggestions`（应用一打开就落在主页时，controller 还在初始化，看的请求先记着，就绪时补上）。
- 读卡：`suggestions`；controller 的唤醒信号到了就后台重读，只留最近一次看完的卡（`created_ms == last_checkin_ms`）。controller 在一次看开始时（`begin_checkin` 之后）多发一次唤醒，主页才知道「正在看」。`HomeCards` 等着自己让看的那一次 `trigger_suggestions` 做完，那之前点卡、× 不理。
- controller 的其他补丁（2026-11-17 审阅修补，不改生成）：「主动建议」关掉或 App 关掉时停下的那一次走 `ProactiveStore::cancel_checkin`（不记错，`last_attempt_ms` 放回开始前的值）；是不是作者停的看 controller 另记的标记（`SuggestionStop::stop` 只在这两处设），不看取消信号，因为请求自己失败时也会把取消信号设上。请求没成仍是 `fail_checkin`，原话是常量 `CHECKIN_REQUEST_FAILED`；`set_proactive_enabled` 值没变时什么都不做、不唤醒；`has_conversation(book, conversation)` 给「查看对话」先看那段对话还在不在。
- 点卡：`Open` 的卡调 `open_suggestion`（系统提示词照面板的写法），成了以后把这段对话记成这本书的当前对话（工作区的书记忆 `agent.conversation`），调外壳新加的 `Workspace::reveal_companion` 把右栏打开到 Agent（铺满着时先退出铺满，照 `reveal_library`），已经在的 Agent 面板选中这段对话（`AgentPanel::show_card_conversation`）。`Started` 的卡先在后台问 `has_conversation`：还在就直接打开那段对话，不再请求；没了就只 `reveal_companion`，不记、不选。
- ×：`dismiss_suggestion`，界面上先拿掉，存储随 controller 的写入。
- 开关：设置登记表一条 `SettingDef`（`registry::AGENT_PROACTIVE`，`Kind::Switch`、`Scope::Device`）；`HomeCards` 绑定 controller、每次看之前把它交给 `set_proactive_enabled`，设置变化时只在这一项变了才交（别的设置写入，比如书的布局，不再让每个 Agent 面板和卡重读数据库）。场景里写在设置文件 `device` 下（`dr-cli/scenarios/k5-shared-preview.json`），不在 `device.modules`。

**测试**（合成模型流 `ScriptedDriver`，回环地址，不调真实模型）：`dr-view-agent/tests/home_cards.rs`——主页露出来看一次（单次请求、无工具），三张卡两列按顺序排，第一张指着改过的那一章；90 分钟内主页再露出来只记一次打开、不再请求；点卡开对话、右栏停在 Agent 这段对话、主页不动、卡留着、请求带卡的指示；面板换到新对话后再点卡回到同一段、不再请求；× 以后界面和存储里都没了，主页再露出来也不回来；开始失败（controller 不让开）时卡下面那一行、卡还是 `Open`，再点成了；设置里那一项是开关、只管这台电脑、默认开、在 Agent 页最后一行、没有说明；开关关着打开项目不看、不记打开、主页上什么都没有，打开以后不立刻看、下次主页露出来才看，再关上主页上什么都没有、卡留在存储里；没连模型时不请求、主页上什么都没有（存储里有上次的卡也不画）；正在看时那一行在卡上面、上一次的卡还在，看完换成这一次的；看失败时失败那一行在、卡还在，冒号后面是现成的「请求失败…」；看完零张卡时主页上什么都没有；打开 Agent 面板、窗口激活而主页不在前面时不让 Agent 看，空对话里项目记忆那一行下面隔一格就是空对话的第一行（中间没有卡和开关）。2026-11-17 审阅修补加的：正在看时点卡不开始、× 不拿掉卡（主页和存储都在），看完以后新卡能点；看到一半关掉「主动建议」不记错、不算进 90 分钟，再打开没有失败那一行，下次主页露出来就看；只摆最近一次看完的卡（以前点过的看完以后不摆、存储里还在，这一次点过的写「查看对话」）；别的设置写入不唤醒 controller 的订阅者，开关变了唤醒一次；「查看对话」的对话没了时右栏打开到 Agent、什么都不选、卡照旧；× 以后换个项目再回来也不回来。「什么都没发生」的判断都等一个确定的信号（`HomeCards::settled`：自己让看的那一次做完、读卡做完、没有卡在开始；面板那边是 controller 的 `active_count`），不再等几帧；点卡以后数模型请求也先等 `active_count` 回到 0（卡变成「已开始」时运行才刚登记，请求是运行自己的线程随后发的）。`dr-agent/tests/proactive.rs` 的 `a_cancelled_checkin_keeps_no_error_and_does_not_count` 测数据层的停下。主页那一侧见 [M02](m02-home.md)。

**真窗口**（副屏，合成模型流）：`next/crates/dr-view-agent/scenarios/home-cards.json`，只跑例程 `home-cards-acceptance`（临时 showcase 库《慢钟》、进程内的候选 Key、回环地址，不连真实服务）：

```bash
cargo build -p drifting --example home-cards-acceptance --features debug-bridge --locked
cargo drifting workspace scenario crates/dr-view-agent/scenarios/home-cards.json \
  --app target/debug/examples/home-cards-acceptance --out <输出目录>
```

打开项目落在主页、三张卡两列在「继续写」下面、主页和 Agent 栏都没有「主动建议」开关；点卡右栏停在 Agent 那段对话、主页不动、卡变「查看对话」；× 掉一张；设置里搜「主动建议」关掉，主页上什么都没有、下面的块上移；再打开卡回来；深色再开一次。2026-11-17 跑过 55 步、0 pending，截图（浅色、深色）在作者机器的验收日志目录里，不进仓库。

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

## 内核 v5 · 建议卡出错的原因（2026-11-18 作者定的）

kernel-v5 第 15 节第 52 条，作者「全照建议」，由 [v5-followups.md](../handoff/v5-followups.md) 的 HC2 做：查看出错时不再只存一句 `suggestion request did not complete`，存原因的种类（连不上模型、改动太多装不下、回复读不出来），主页照种类写中文；书库里存着的旧英文原因一律显示「出错了」。开始出错的原因也分种类（卡已经不在、主动建议关着、另一张正在开始、别的）。
