# M31 帮手面板与改动显现

> 2026-11-24（CM4a 图片）：Agent 栏的输入框收图片：拖到 Agent 那一栏的任何地方、或在输入框里 ⌘V，发出去以前在输入框上方看得到小图、每张旁边一个去掉的按钮；发出去的那条消息上也看得到。看不了图的模型不被问，Agent 在对话里照实说一句。见本页末「图片（CM4a）」，运行时与各家写法见 [M27](m27-agent-runtime.md#图片cm4a2026-11-24)、[M28](m28-model-providers.md#图片cm4a2026-11-24)。

> 2026-11-21（0.1 的旧对话）：导入时存下的 0.1 Agent 对话在「历史」里新对话下面一节「Drifting 0.1」，打开只读、没有输入那一块；「历史」顶上一个搜索框新旧一起搜。作者定的三甲、四甲、五甲。见本页末「0.1 的旧对话」。

> 2026-11-19（格式 5「本轮改动」全量对齐、项目记忆定位与停止竞态测试修正）：`dr-view-agent/src/data.rs` 移除残留的旧格式种类分支，按格式 5 的 15 个 `CollectionV3` 根容器与正文收据补齐「本轮改动」定位：`DocId::Body` 保留具体 `module` 使多正文条目直达被改模块；修复归属键 `<host>|<member>` 的竖线解析、`timeline_view` 的 `book-view:<id>` 跳转以及历史恢复 `templates` 到 `Target::Template` 的映射；补齐 `patch`／`plot_grid`（打开所属条目并滚到对应模块）、`time_pin`（打开所在时间线视图）、`meta`（回作品主页）与 `memory`（打开项目记忆子页并经 `ProjectMemoryView::reveal` 等待目标条目实际绘入视口，切书／关栏／切换子页自动取消）；仍无独立定位入口的 `fact`、`asset_folder`、`relation_type` 与模板默认正文 `template:<tpl>/<mod>` 保持不出现假按钮、不回退整书。`CompanionTools` 同批挂入 M30 的四个会话级计划与工作记忆工具。另修复 `tests/controller.rs` 中 `stop_revokes_continuation_before_a_held_slice_returns` 在 Windows x64 下流式阶段收到停止后立即丢弃 `Step::Wait` 接收端导致的 `oneshot::send` 竞态断言，拆分为流式持锁停止与已进入工具屏障停止两段确定性验证。

> 2026-11-17（HC 建议卡回作品主页）：空对话里不再有建议卡和「主动建议」开关（`panel/continuity.rs` 只剩项目记忆、工作记忆和继续保存的运行）；面板打开、跟着换书、窗口重新激活都不再让 Agent 看（原来 `panel.rs` 三处 `trigger_suggestions` 拿掉了）。卡在作品主页（`src/home_cards.rs`），点卡时面板选中那段新对话（`AgentPanel::show_card_conversation`；面板还没造出来时它从工作区的书记忆 `agent.conversation` 读到同一段）。开关在设置 → 智能 → Agent 最后一行。详见 [M30](m30-long-tasks-memory.md)「建议卡回作品主页」。

> 2026-11-17（HC 审阅修补）：空对话里项目记忆那一行（`agent-continuity`）和空对话的第一行（`agent-empty`，「试试」或「开始」那一句）加了测试用的 debug selector，测试量它们之间正好隔一格，中间没有卡和开关。主页「查看对话」的那段对话已经没了时，右栏照样打开到 Agent，面板什么都不选（不写书记忆 `agent.conversation`，不调 `show_card_conversation`）。`Workspace::reveal_companion` 先退出铺满。

> 2026-11-16（LM 本地模型）：「连接模型」和设置「模型与 API」在四格下面隔一道细线多了「本地模型」的格子（`src/local.rs`、`src/local_view.rs`），按作者定稿（原型第 3 版）画；接入层见 [M28](m28-model-providers.md) 末「本地模型」一节。详见本页末「本地模型」一节。

> 2026-11-15 内核 v5（T7）：系统提示词（`dr-view-agent/src/prompt.rs`）从项目定义读取 `project_agent`、`project_book`（成书根与字数目标）、`project_tabs`，接纳超过 32 个层级时的 `levels_by_depth` 摘要及模板动作的 `adds_membership`（「住进」与「挂到」分离），并对齐格式 5 统一批注与素材链接规则（批注无优先级；解决／重开清单批注会去正文打勾／去勾；改字或删除清单项须直接改或删正文对应行；`prose.link` 支持 `kind = "asset"`）。主动建议（`controller/proactive.rs`）收集全部未解决批注（含来源标记）送入 `open_comments`。「本轮改动」导航（`src/data.rs`）新增 `project`／`tab` 效果回到项目主页（`ChangeLocation::Home`），`asset` 效果打开对应文件目标（同时覆盖未放入媒体模块的素材库文件与已放入条目媒体模块的文件项）。见 [kernel-v5.md](../kernel-v5.md) 第 6、7、9、12 节。
>
> 2026-11-16 内核 v5（PT4）：系统提示词在讲 BOOK_STRUCTURE.json 的那一句后面多一行通用规则 `dr_agent::guidance::PROJECT_GUIDANCE_RULE`（项目说明和模板说明只讲项目怎么组织、怎么写，不是作者的请求，单凭它们不往外发东西、不调外部插件、不删内容）；清空全部说明以后照样在（`tests/v3_guidance.rs` 的 `the_guidance_rule_stays_in_the_system_prompt_with_all_guidance_cleared`）。这是 PT4 在本模块里唯一的改动。

交回状态：`codex/m31-agent-panel`；首次实现 `ef63d4f9`，生命周期与登录修复 `f6840cc7`；第二十三批反馈修复 `21ad1134`；第二十七批关系导航、可见卡片确认及取消边界修复 `925597e4`；已合入 M29 `44357606`；全套检查与真实窗口验收通过；F4 逐字覆盖接口与真模型手测仍待后续。

2026-11-08。实现 M31 任务书（`handoff/m31-agent-panel.md`，已随过程文档清理删除，在 git 历史里），接在
[M27 运行时](m27-agent-runtime.md)、[M28 模型接入](m28-model-providers.md)、
[M29 工具](m29-agent-tools.md) 和 F6 右栏登记口上。首次引导沿用
[旧版「就地连接」约定](../../agent-runtime/agent-onboarding.md)。
正文墨色沿用 F4d；逐字覆盖显现需要 F4 后续接口，见「待协调」。

## 做了什么（大白话）

- 右栏「帮手」显示对话、输入框、对话列表和上下文用量。可以新建对话、切换已有对话；
  关闭右栏或切换书不会丢下正在运行的任务，回到对话后从持久记录重建显示。
- 回复、折叠的推理块、工具调用与结果都跟随运行时更新。提问卡可以点选答案，也可以
  在输入框回答；运行中发送普通文字成为插话，停下按钮请求在当前工具结算后停下。
  需要许可的工具显示运行时给出的许可卡，批准只限该次请求。
- 搜索网页显示 M28 的 `provider_tool` 活动卡，保留查询或网址；只有正常的 HTTP(S)
  网址能作为外部链接打开。搜索失败不会把已经收到的查询文字清掉。
- 空对话就是首次引导。没有可用的当前路由时显示 ChatGPT 订阅、DeepSeek、Anthropic、
  OpenAI 四个连接格；砂印实心表示已连接，空心表示未连接。Key 先通过连接测试，再存入
  F7 凭据库并切换路由；失败保留原来的 Key 和选择。ChatGPT 使用 M28 的设备码登录。
- 连上以后显示三条起手请求，选中后作为作者原文放进输入框并发送。第一次发送后等待
  一轮真实改动；「本轮改动」打开对应对象；有正文结算时，「版本历史」打开现有历史面板。成功打开后
  结束引导。设置可以重新显示首次引导。
- Key 连接成功后焦点回到对话框；Enter 发送，Shift+Enter 保留换行，输入法组合期间
  不提交。开始或控制请求正在等待时新写的草稿不会被旧请求的成功回调清掉。
- 面板只新增并测试 Key、选择已连接的路由或发起 ChatGPT 登录。修改、重测、删除 Key
  和退出 ChatGPT 账号放在设置的「模型与 API」。模型、思考程度和轮数限制也使用外壳的
  设置登记表；Key 和 OAuth token 不进入设置或对话。
- 思考记号直接用 `dr_ui::sand::thinking`：旧资源帧条每 120 ms 往返播放，结束时停在
  完整星芒；推理标题和运行状态用同一套。减少动态效果时也照常播放：它在说 Agent
  还在做事（作者 2026-11-16 定，「关闭动态效果」那一轮）。
- 真实运行时写入已经打开的编辑器后，F4d 从结算收据产生新增／改写墨色；Mirror 来源
  使用外部修改墨色。指针碰到相应范围才淡出，并记为本机已看过。

## 定下的事

**一个库只有一个帮手服务。** `AgentHub` 由外壳全局持有，`AgentController` 持有 M27 的
`Runtime`。每个对话同一时间只运行一个作者回合，不同对话可以同时运行；模型和工具仍走
M27 的调度、读写屏障和结算。面板不保管 `RunHandle`，也不直接发送对话模型请求。
连接测试是作者明确发起的独立操作，复用 M28 的同一驱动和 HTTP 客户端。

**界面状态可以重建。** `state::ChatState` 按连续的 journal 序号归约流式回复、提问、许可、
搜索活动、未消费的插话与结算引用。同步对话正文与本机 journal 投影按不可变事件 id 合并，
最终回复替换流式草稿，不另建一份界面对话数据库。对话列表同时包含收到的 conversation
文档和本机 session；读取必须带书 id，防止旧面板读取另一本文档的对话。

**恢复不重跑工具。** 服务打开时先执行 M27 的恢复，再接受新回合。中断状态、没有消费的
插话和已经结算的改动仍可显示。提问和许可绑定运行时完整的 `RequestId`，旧卡片不能回答
另一个等待请求。回合的上下文用量取最后一次模型报告，与该回合冻结的模型窗口上限比较，
不是把多轮请求的用量累加成上下文长度。

对话按持久消息原顺序显示，附属卡插在所属 session／turn 的最后一条消息之后；
同一回合的多次模型回复保留原序，同步来的消息也不依赖本机 run 才能显示。流式回复
和最终回复使用相同位置与折叠标识。推理、调用与结果标题有按钮角色、名称和展开状态，
可以通过 Tab／Shift+Tab 移动焦点、Enter／Space 切换，也接受辅助功能的 Click。

**换库与退出先结算。** F6 新增统一的 release hook：同步关闭新任务入口，异步取消并等待
所有已进入的开始、读取和写入，最后释放 `Runtime`／`Workspace` 的强引用。界面线程不做
`join`。所有 prepare future 都会等完，一个失败不会丢弃另一个还在结算的服务。
等待期间重复退出或换库被同一 gate 拦住。控制调用只同步投递到非阻塞邮箱，返回的
future 等待日志持久确认；完成先关闭邮箱，竞态中未确认的请求明确返回 Closed。
终态持久追加即使被阻塞，也不会让关闭准备或面板控制在界面线程等待一把存储锁。

取消读取可以立即结束模型回合，但执行 F3 读取的线程可能仍持有 `Workspace`。
`ToolContext` 的私有执行 lease 跟随线程；所有回合和开始请求结束以后，controller
再等待 `Runtime::drain_tools()`，然后才释放库。`workspace_call` 也明确保留整个
context，避免 Rust 的字段捕获把 lease 留在被取消的外层 future。

准备失败时保留当前库；换库完成或失败重开后，先把当前库放回 `Services`，再通知服务
重建，最后调用换库完成回调。成功退出不重建服务。换库还会清理已经画出的旧窗口帧，避免
旧帧的点击回调继续持有编辑器和库，导致 F3 关闭失败。

**凭据和偏好分开。** `agent.provider`、`agent.model`、`agent.thinking`、
`agent.max_model_rounds` 是账户范围的非秘密偏好；`agent.onboarding` 是设备记忆，
每本书的 `agent.conversation` 记住选中的对话。生产初始化使用 F7 完整的 `Identity`，
包括隔离开发实例的凭据服务名。测试使用内存凭据库和本机假服务。
已有且仍有效的记住会话会结束首次引导；显式重置不会被迁入规则覆盖。
起手请求使用 F3 的 `recent.list` 节点记录；字数索引未就绪时从 canonical 正文判断
章节是否有字，空态在书目更新或新建对话后重新读取，避免永久缓存初次的零字数。

**取消登录等待最终存储。** 每个登录界面只拥有自己发起的操作代次。取消、关闭设置、
帮手栏被隐藏或覆盖、释放界面及关闭窗口，均启动独立于界面任务的 OAuth `logout()`
屏障；原生凭据写入已经开始时，等待它和清除操作都完成再放开下一次登录。正常退出或
换库也等待同一屏障，不依赖界面任务的 Drop 恰好执行到清理代码。

**改动入口指向实际对象。** 正文收据可以提供正文目标和历史；元数据收据的
`book:<id>` 只是存储文档，导航只从同一 run 中明确包含该条收据的工具结果 effects 解析对象。恢复收据若缺少
精确 effects，不伪造整书导航。
书信息回到项目主页，要素等对象打开各自页面，批注定位到其目标和审阅卡；关系改动先
查询该书中仍可见的确切关系，再打开其实际端点，优先打开有 M17 关系区的要素页面。
历史恢复／撤回报告的集合复数名称规范化为相同对象类型。不存在、已删除或隐藏的对象
不猜测跳转；元数据收据不提供正文历史。后台解析后重新检查服务代次、书与对象，
成功打开后才结束首次引导。

批注导航只放宽遮住目标的筛选和范围，并展开已解决项；“当前”范围包含直接来源与
通用关联的并集，已经可见时保留该筛选。列表滚动到目标，等卡片实际绘制在可视区域内
才确认成功；仅加载或尚未挂载的面板不确认。绘制确认绑定书和请求代次，替换、切书、
读取失败、目标消失或释放界面都不会误结束引导。F6 通过已有的展开动画入口打开右栏，
避免状态已经打开而实际宽度仍为零。每次定位另有独立请求票据；切书、换对话／服务、
关闭右栏或隐藏其审阅标签会取消尚未显示的请求；再次点击改动时也立即取消前一请求，
以作者最后一次点击为准。旧读取和旧确认不能打开目标、减少新请求
的待处理计数或结束引导；审阅视图收到取消后不再调整筛选或滚回旧卡片。

**墨色不改正文。** 新增、改写和外部来源分别使用 F4d 既有的绿色、紫色、蓝色映射。
指针触碰只更新装饰和本机已读台账；正文的 Loro frontiers 不变。M31 不接管 F4 的绘制层，
也不把结束后的墨色淡入宣称为写入时逐字覆盖。

## 接口

`dr_view_agent::init(&Identity, &mut App)` 是应用入口。
`init_with`／`init_with_service` 注入驱动、工具和连接服务，供本机假驱动及调试桥验收使用；
这些入口同样经过正式的 controller 和 Runtime。

纯服务 `AgentController` 不依赖 GPUI 状态，主要接口是：

```rust
AgentController::new(workspace, driver, tools) // 先恢复；后台执行
controller.start(Start { /* 冻结的配置、书、对话和作者输入 */ })
controller.list(&book)
controller.snapshot(&book, &conversation)
controller.control(&session)
controller.subscribe(listener) // 只发唤醒信号，不能在回调中同步读服务
controller.close()            // 调用时即冻结；返回可等待的共享关闭边界
```

`list`、`snapshot`、`with_workspace_read` 和 `start` 可能等待 holder，均放在后台执行。
`close` 返回 `BoxFuture<'static, Result<(), String>>`，等待后旧 controller 的其他克隆
也不再持有库。面板只订阅唤醒信号，在前台收到信号后发起后台读取；书和服务切换用代次
丢弃过期的读取结果。

F6 的最小公共协议在 `dr_shell::release`：

```rust
before_release(cx, |cx| -> LocalBoxFuture<'static, Result<(), String>> { /* 冻结、结算 */ });
after_release(cx, |cx| { /* 从当前 Services 重建 */ });
is_releasing(cx);
```

`CompanionTools` 组合 M29 的 `AgentTools`、`ask_user` 以及 M30 绑定当前聊天会话的四个长任务计划／工作记忆工具（`read_task_plan`、`update_task_plan`、`read_working_memory`、`edit_working_memory`）。`ask_user` 返回 M27 的
`ToolOutput::Question`，作者回答继续同一次工具调用；没有另建作者域 CRUD 清单，也没有在
面板里绕过 M29 的读后写检查。

## 外壳里的挂接点

- `next/app/drifting/src/main.rs` 在外壳初始化后调用 `dr_view_agent::init`。
- `pages::set_companion` 提供右栏主体和头部；头部放对话列表、新建对话。
- `AgentHub` 登记 `before_release`／`after_release`；F6 的 `library::replace` 在
  `let_go` 以前准备，普通 `quit::request` 在原有退出 hooks 以前准备。
- 设置使用 `settings::set_module_row` 登记四个模型连接区、模型偏好和引导重置；
  模型选择器沿用 F5 的浮层组件，Key 输入复用安全输入模式。
- `settings::on_panel_closed` 通知被缓存的连接界面；`Workspace::companion_visible`
  按主体实体及所在栏判断可见性，避免另一个帮手栏仍打开时遗漏当前栏的取消。
- `Workspace::open_home`／`reveal_comment` 是改动导航的最小入口；M18 的
  `dr_view_review::reveal_comment(pane, book, comment, cx)` 返回
  `Option<oneshot::Receiver<bool>>`，先完成对应 pane 的加载、筛选调整与滚动，目标卡片实际绘制可见后
  才发出成功；缺失或读取失败为 false，替换请求、切书或释放视图会关闭旧 sender。
  外壳的同名入口另接收 `window`，使用现有的右栏展开动画；`Workspace::review_visible(pane)`
  用于取消已隐藏目标的等待，并在绘制确认后再次核对可见性。
- 「本轮改动」沿用外壳导航，「版本历史」沿用 `Workspace::open_history`。正文装饰
  直接复用 `dr_editor::decor::AgentMarks`，没有第二套墨色台账。

## 测试

测试语料取自 `dr_testkit::seed`，没有真实模型请求、真实 Key 或作者正文。

- `tests/state.rs`：流式块按原顺序重建，最终回复替换草稿；失败搜索保留查询，未知的
  对话 payload 不被丢弃。
- `tests/controller.rs`：真实 M27 假驱动经过流式回复、提问、搜索、完成，重建时不依赖
  面板；同步收到的对话可列出，中断控制可恢复；关闭立即拒绝新回合，取消所有运行，
  等待已进入的写入收据、被阻塞的读取以及正在 holder 中开始的回合。
- `tests/connection.rs`：同一 M28 驱动测试临时 Key，成功才保留；失败、不完整响应和
  空 Key 不破坏原凭据；GPUI 实体在测试完成前不切路由，成功后才切；设备登录取消
  不留 token；偏好范围和类型有断言。最终存储竞态使用无秘密参数的凭据检查点，
  在真实 I/O lease 内、代次检查后阻塞，覆盖按钮、隐藏、界面释放、窗口关闭、正常
  release 和连接服务释放；等待期间第二次登录被拒，结束后原路由与无关 Key 保留。
- `tests/control_delivery.rs`：真实终态追加中的 F2 post-commit 通知被阻塞时，五种控制和
  close 均立即返回，关闭屏障仍等待；真实窗口快捷键继续响应，放行后通过外壳换库
  释放 F3 并成功重开。
- `tests/transcript.rs`：两轮真实驱动覆盖旧搜索／问答卡、第二轮 User 和流式／最终回复
  的实际绘制顺序与位置，重开后不变；折叠状态保留，标题支持键盘操作。另有同一
  session 多 turn、多次模型回复和无本机 run 的同步消息顺序断言。GPUI 测试平台
  没有原生辅助功能适配器，真实 AX 角色与动作另由窗口场景验证。
- `tests/navigation.rs`：首轮仅改书信息或要素元数据时导航实际对象，不显示正文历史；
  元数据效果匹配对应收据；首轮只创建关系可打开实际端点并结束引导，删除关系后拒绝导航。
  真实 Agent 先改要素再按来源撤回，覆盖实际 F3 复数 effect 与恢复后的对象入口。
  批注回归驱动外壳窗口绘制，确认默认关闭的右栏真正展开后才结束引导。M18 另验证
  50 条以上列表中的浮动／已解决目标最终绘制框位于视口内、挂载前不确认、关联并集
  不误关“当前”筛选，以及首次加载、读取失败、目标缺失和请求取消。另有真实外壳
  回归：显示前切书（新书未打开审阅）、关闭栏、切换审阅标签均取消旧请求；之后新书
  或新发起的定位仍能正常确认。切书用例先在修复前复现了旧等待无法结束。
- `tests/panel.rs`：真实 GPUI 面板、键盘和 M27 驱动跑通 Enter 发送、Shift+Enter 换行、
  提问、回答、当前工具后停；切书后旧任务仍可回来控制；开始等待期间新草稿不被清空。
- `tests/hub.rs`：初始化未装入界面时就关闭，仍等待初始化并释放库；真实换库后从
  新 `Services` 重建服务，保留旧／新 controller 克隆也不阻止关闭。
- `tests/lifecycle_read.rs`：用 F2 文档加载检查点阻塞真实 M29 读取和 `workspace_call`
  读取；模型回合已记为 Aborted 时，关闭仍等待底层线程。放行后保留 controller 和
  driver 克隆也能关闭 F3。修复前的回归实际复现了残留引用导致的 `try_shutdown` 拒绝。
- `tests/visibility.rs`：多窗口设置的 Esc、dismiss 和关闭事件只通知对应窗口；真实缓存
  帮手主体随所在栏显隐。缩窄窗口自动合栏时会通知观察者，另一栏可见不会掩盖当前栏关闭。
- `src/data.rs`：未重建字数索引的 tiny 种子仍选有正文的章节，最近打开的第二章优先；
  外链只接受有主机的 HTTP(S) URL。
- `tests/onboarding.rs`：没有模型、状态未查明、已有对话、已连接三种状态的显示规则；
  只有发送后打开真实改动才结束引导；迁移／重置和三条起手请求的选择规则。
- `tests/ink.rs`：先打开真实 `ChapterEditor`，再用真实 Runtime、`CompanionTools` 和
  M29 做四次成功工具调用，其中两次正文写入各产生一条收据；Mirror 再产生外部来源。
  断言 New／Changed／External 的实际编辑器范围和非空绘制框，再模拟真实指针触碰，
  断言中途透明度、最终消失和本机 `agent-marks.json` 已读更新；正文版本不变。
  此测试验证语义、范围和淡出，不是像素色值比较，也没有逐字覆盖动画断言。
- `dr-shell/tests/release.rs`：五个 GPUI 测试覆盖全部服务都等完、重复请求被拦、准备失败
  保留原库、退出失败后可重试、换库成败后的恢复顺序和拒绝关闭时不执行磁盘任务。
  既有 `tests/workspace.rs` 的退出与真换库测试继续验证原行为。

真实窗口的可重跑场景为 `next/crates/dr-view-agent/scenarios/companion.json`：

```bash
cargo build -p drifting --example agent-acceptance --features debug-bridge --locked
cargo drifting workspace scenario crates/dr-view-agent/scenarios/companion.json \
  --app target/debug/examples/agent-acceptance --out target/acceptance/m31-companion-batch27
```

例程使用临时 tiny 种子库、内存凭据、本机回环短完成服务和 M27 假驱动；四家的
completion、catalog、OAuth 地址都指向回环。它不进入正式应用，也不默认开启调试桥。
本轮 **44 步、0 pending 全过**：四个连接格、遮罩输入、通过测试后显示起手请求并聚焦、
多行输入与发送、提问、回答、真正正文改写、紫色墨迹、网页搜索卡、首次改动入口、
版本历史、同一对话第二轮、退出码与连接文件清理。原生辅助功能树验证推理、调用和结果
三个标题的 Button 角色及名称，并实际派发 Click。截图在上述忽略的输出目录，检查了连接、
起手请求、提问、改写、历史及两轮卡片的真实绘制结果；没有将生成的结果 JSON 当作验收
契约提交。九语言发送提示改为 Enter／Shift+Enter，轮数说明只承诺当前已实现的停止行为；
源文案更新并重生成资源后，`pnpm locales:check` 的 9 种语言、18 份目录通过。

集成时还修正 F5 `TextField` 的安全输入和 `Select` 的单行截断；设置连接视图及定向
打开请求按窗口隔离。

合入 main 第二十五批、M29 审查修复和第二十三批 M31 反馈修复后的最终验证：`cargo fmt --all --check`、
全工作区 Clippy、`cargo xtask check` 与 `pnpm public:check` 均通过；全工作区测试以
`RUST_TEST_THREADS=2` 执行，**1793 通过、0 失败、22 忽略**（普通测试 1789 项、文档测试 4 项；独立 crash-report 验收另计且通过）。
`dr-view-agent` 的 47 项、`dr-view-review` 的 14 项全部通过，真实窗口最终场景重建后再次 44 步通过。
审计 943 个锁定 crate、0 漏洞、12 项已有提示；14 份已有测量过期，机器并行编译期间未重写测量数字。
本轮首次全量暴露假 HTTP 服务在 macOS 上继承监听 socket 非阻塞状态，偶发
`WouldBlock`；仅将接受的测试连接改为阻塞读取，连接与导航 18 项复验后重新运行完整
workspace 测试至退出码 0。上述最终统计包含该修复与“最后一次点击拥有导航”的取消边界。

## 待协调

**2026-11-09 转轨道 3：** 轨道 2 交付的公共播放入口见 [F4 公共播放接口](../foundations/f4-editor.md#轨道-2提交后的公共播放接口2026-11-09) 与 [F4e 接点](../foundations/f4e-editor.md#轨道-2公共播放接点2026-11-09)。`ChapterEditor`／`BookEditor` 的 `editor()` 可配置 `CommitPlaybackOptions::new("agent:")`；正文与回执先提交，播放只改变绘制。产品里何时启用及编辑器实体切换后的重新配置由帮手轨道消费；本批公共接口不等于 M31 产品已启用。按种类导航／定位扩展仍冻结。

1. ~~**F4：提供受提交边界约束的逐字覆盖公共接口及真实 Runtime 回归。**~~
   第三十一批由轨道 2 完成；原 F4d 三类墨色与指针淡出保留。条目页与整书页编辑器已由并行外壳／页面轨道接入 `CommitPlaybackOptions::new("agent:")` 提交后播放（正文与回执仍先落盘，播放只改变绘制）。
2. 真模型连接和真实 ChatGPT 登录留给作者手测；自动化仅使用本机假服务。M32 MCP、
   M30 长任务和 M33 生图不在本模块另开产品入口，继续组合共享 Runtime 的工具和控制。
3. M29 审查修复 `4d55f081`／`44357606` 已随本分支合入：排除隐藏级联删除，拒绝指定关系 id，并随格式 5 更新目录快照与守护回归。
4. **格式 5 元数据对象的定位覆盖与剩余缺口（2026-11-19 更新）。** 当前「本轮改动」按格式 5 的真实回执与同轮工具 `effects` 精确解析，已删除／已进最近删除的对象一律拒绝跳转、不伪造整书回退：
   - **已接通的定位入口**：条目正文 `body:<entry>/<module>` 打开 `Target::Entry { id, module: Some(module) }` 并提供同一模块的正文「版本历史」，同一条目改了几个正文模块就各有一个按钮（同一条目的元数据改动并入它的第一个按钮）；条目元数据 `entry`／`entries` 打开对应条目页；归属 `membership`／`memberships`（键 `<host>|<member>`）打开成员条目，成员已不在时不出跳转；补丁 `patch`／`patches` 与情节规划表 `plot_grid`／`plot_grids` 打开所属条目并滚向对应模块；条目模板定义 `entry_template`／`entry_templates`／`templates` 打开模板编辑器 `Target::Template(id)`；时间线视图 `timeline_view`／`timeline_views` 与时间钉 `time_pin`（反查所在存活视图）打开 `Target::BookView(id)`；文件 `asset`／`assets` 打开素材库里的这个文件 `Target::Material(id)`，素材库里没有这一项时打开摆着它的那一项；批注 `comment`／`comments` 走 `Workspace::reveal_comment`（等待卡片绘入视口后确认）；关系行 `relation_row`／`relations` 打开左右两组里第一个存活的端点条目页（不经 `Workspace::reveal_relation_row`），端点都不在时不出跳转；项目记忆 `memory` 打开面板项目记忆视图并等待 `ProjectMemoryView::reveal(id)` 绘入视口确认；书信息与项目定义 `meta`／`project`／`tab`／`tabs` 打开作品主页 `Workspace::open_home`。
   - **仍缺独立定位入口的对象**（暂不出假按钮）：事实表项 `fact`／`facts`（无独立页面或单条定位接口）、素材夹 `asset_folder`／`asset_folders`（`Target::Material` 当前只收 `AssetId` 文件身份，无空文件夹定位口）、关系类型定义 `relation_type`／`relation_types`（无独立类型管理路由；具体关系行改动已由 `relation_row` 定位）。待外壳或对应视图提供精确目标定位与显示确认后再接入。
5. **模板默认正文的精确定位（2026-11-19 更新）。** 格式 5 下条目模板自身的名称、模块定义与动作改动（`book:<id>` 上的 `entry_template`／`templates` 效果）已可打开 `Target::Template(id)`；而模板默认正文 `DocId::Template`（`template:<template>/<module>`，新建该模板条目时复制进去的初始正文）是独立 Loro 正文文档，目前外壳的 `Target::Template(TemplateId)` 与 `Workspace::open_history` 尚无按 `<template>/<module>` 直接定位默认正文编辑器或历史面板的公开参数。因此 `template:<template>/<module>` 收据暂不生成改动或正文历史按钮，也不冒充普通条目正文；`src/data.rs` 的回归同时确认 `history.points` 可读且不暴露无效 UI 入口。

## 代码位置

- `next/crates/dr-view-agent/src/panel.rs`：面板、提问／许可／搜索卡、输入、改动导航；`src/images.rs`：输入框里的图片和小图（CM4a，见「图片（CM4a）」）。
- `src/panel/old.rs`、`next/crates/dr-import-v1/src/agent_archive.rs`：「历史」的搜索框和 0.1 的旧对话（见「0.1 的旧对话」）。
- `src/controller.rs`、`src/hub.rs`、`src/state.rs`：库级服务、外壳生命周期、持久记录投影。
- `src/connection.rs`、`src/connection_view.rs`、`src/settings.rs`：连接测试、模型选择、设置。
- `src/onboarding.rs`、`src/data.rs`、`src/tools.rs`、`src/prompt.rs`：首次引导、起手请求数据、
  运行时提问工具、以当前书为界的系统指令。
- `next/crates/dr-shell/src/release.rs`、`library.rs`、`quit.rs`：统一异步释放边界。
- `next/crates/dr-view-agent/tests/`、`next/crates/dr-shell/tests/release.rs`：上述契约与集成测试。

## 内核 v5（T6）：风·林·火·山思考动画与批注派发桥（2026-11-15）

- Agent 栏处处（「思考中…」行与展开思考过程标题）随 `dr_ui::sand::thinking` 换用 68 帧「风·林·火·山」砂笔帧条（`icons/thinking.png`，8 fps 顺序循环，「已思考」静止在第 57 帧山），替代原星芒帧条。
- 新增 `dr-view-agent/src/review_bridge.rs`，向 `dr-view-review::agent_bridge` 登记批注派发桥：支持把批注连同可选补充说明发进新对话或续接 `comment.agent_conversation` 记录的既有对话（读写工具权限、系统提示词不变），实时向审阅栏推送会话运行/完成状态驱动卡片右下角风车动画；从风车或悬停卡打开批注对话时，面板左上角显示返回审阅按钮（`v3Review.backToReview`）。契约测试：`dr-view-agent/tests/comment_handoff.rs`。详见 [M18](m18-review.md)。

## 自定义服务（本地模型 LM 2026-11-16；网上的服务 CA 2026-11-24）

作者 2026-11-16 两轮选完、说「做」；交回后的七处同日又定（原话「都按你倾向的」）。定稿笔记在监管会话的共享笔记 `local-models-final.md`（文末「第四版：交回后的七处」），原型第 5 版「第四版定稿」。四格（`PROVIDERS`）一点没动，这一格另外画。

2026-11-23 作者把网上的第三方服务也放进这一格（[chihumyum/Drifting#3](https://github.com/chihumyum/Drifting/issues/3)），2026-11-24 对整窗原型（<https://claude.ai/artifact/643qk6p8rs2ig3CyxbDdvK> 页头「版本」里的「第五版 网上的地址（11-23）」）五处答「自定义服务地址按照你的推荐来就行。」这一格从此叫「自定义服务」。代码里的名字（`Provider::Local`、`local_servers`、`LocalConnectionView`、设置行 `models.local`）没改。

**作者会看到的。**
- Agent 面板没有能用的模型时：「连接模型」下面照旧四格，接着一道细线，再下面是「自定义服务」。还没连过时是一格空心的「自定义服务」，右边「未连接」；点开在下面展开地址框（等宽字，淡字照旧 `http://localhost:11434`）、「连接」「取消」「加 Key」。本机和局域网的地址点「加 Key」才出密钥框（淡字「粘贴密钥...」）；**地址框里是网上的地址时，密钥框直接出现在地址框下面，「加 Key」不出**，改回本机地址又收起来（框里已经打了字的就留着）。框里 Enter 就是连接，Esc 收起。
- 点「连接」以后：网上的地址填了 `http://`（或者没写协议）→「网上的地址要用 https」，不发任何请求；没回应 →「连不上这个地址」；要 Key 却没填对 →「密钥无效」；本机和局域网的服务问到了清单、但滤完一个不剩（只有嵌入模型和确知不会用工具的）→ 不连上，表单下面写「这台服务上没有能用工具的模型」，格子照旧「未连接」；问不到模型清单 → 换成「模型名」框加「添加」（和「取消」），添一个就算连上。**网上的服务一律换成「模型名」框**（清单照样问一次，确认服务在、Key 对，但不列出来）。连上以后照现有做法选中它的第一个模型，面板切到对话。
- 连上以后每个服务一格：名字是认出来的软件名（Ollama、LM Studio、llama.cpp），认不出就用地址（主机名，非标准端口才带端口，比如 `api.example.com`、`api.example.com:8443`；网上的服务基本都是这样）；名字重了，后连的那台用地址。右边是等宽的「主机:端口」。
- 输入框上面的模型菜单每行「<格子名> · <模型>」，比如「Ollama · qwen3:14b」「api.example.com · example-chat-large」。嵌入模型、服务确知不支持工具的模型不进菜单，设置里也不列。选中这一格的模型时推理强度那一栏不出，没有联网搜索。
- 设置「模型与 API」：四行下面隔一道细线，每个服务一块：格子；「改地址」「加 Key」（填过就是「编辑密钥」）「测试连接」「断开」。「测试连接」发一句，等的时候按钮转圈，模型真回了才显示「可用」；Key 被拒是「密钥无效」，服务关着是「连不上这个地址」，模型没在等候上限内回话或退回请求是现成的「请求失败（provider 不可用或网络问题）」。模型清单列名「上下文」，每行一个数字框：淡字是问到的值，问不到是 32768；填了以它为准。手填的模型行尾有 ×，这个服务的清单是手填的（网上的服务都是），最后一行是「模型名」框加「添加」。最后一行「＋ 自定义服务」再加一个。「改地址」一台已经存过 Key 的服务，密钥框照旧收着、Key 留着；没存过 Key 的网上服务，密钥框自己出来，空着连接不算去掉 Key。
- 服务没开的时候没有特别的状态：格子照旧算连着，模型照旧在菜单里；发消息时对话里出现现成的请求失败。

**定下的事。**
- **CA 定了的十处（作者 2026-11-23、11-24）。** 1 和本地模型同一处、同一种格子；2 网上的地址只收 `https`，本机和局域网照旧 `http`、`https` 都行，带用户名密码、查询串或 `#` 的照旧不收；3 只认 OpenAI 兼容的 Chat Completions；4 选中这种服务的模型时不出推理强度、没有联网搜索；5 地址清单只存在这台设备上；6 空着的那一格、设置最后一行改叫「自定义服务」（「＋ 自定义服务」），地址框淡字照旧；7 网上的地址时密钥框直接出现在地址框下面，本机和局域网照旧收着；8 网上的地址填了 `http://` 时是「网上的地址要用 https」（「只能填本机或局域网地址」这句删了）；9 连上以后的名字：认得出软件的用软件名，认不出的用主机名；10 网上的服务连上时不列模型清单，出「模型名」框手填，本机和局域网照旧问到多少列多少。原型里照现成做法补的：设置里「改地址」一台存过 Key 的服务，密钥框照旧收着、Key 留着；自动出来的空密钥框不算「去掉 Key」。监管会话补的：手填的模型名在这台服务的清单里找得到时，上下文用清单里那一行的值（连接时手填的、设置里「添加」的都是；设置里添加时再问一次清单），找不到照旧 32768；网上的地址走系统代理、本机和局域网直连（归 NP）。
- **清单只存在这台设备上。** 服务清单在设置文件的设备记忆 `agent.local_servers`（地址、名字、有没有 Key、是不是手填、每个模型问到的上下文和作者填的上下文），选中的是哪台在 `agent.local_server`。账户范围的偏好只多了一个取值：`agent.provider = "local"`，`agent.model` 照旧是模型名。作者说过本地服务清单在偏好同步（M37）之前别跟账号走，网上的服务也一样（CA 第 5 条）；换电脑时跟过去的如果是这一格的模型，那台电脑上没有这台服务，就当没连上，回到连接格。设备记忆里网上的服务以前读的时候会被丢掉（地址规则不收），现在留着；`http://` 的网上地址照旧丢掉。
- **Key 只进钥匙串**，`byok.local.<服务 id>`；设置里只记有没有。新服务和「改地址」不打开密钥框就不动 Key；「编辑密钥」打开的框是空的，留空点连接就是去掉 Key（作者选甲），但要先确认这台服务不用 Key 也能问到清单，被拒就照旧显示「密钥无效」、Key 留着。
- **连接只问清单；「测试连接」发一句（作者 11-16 定，乙）。** 「连接」只问 `/v1/models`（认软件、读上下文和工具能力），要快。「测试连接」先问一次清单（连不上、Key 被拒当场知道），再像四家那样发一句「Return exactly OK.」（输出上限 1024，和四家给会思考的模型的一样），模型回了话、正常结束才算「可用」。本地第一次加载大模型常要几十秒到几分钟，所以等候上限是 M28 的 `local::MODEL_WAIT`（5 分钟），不用四家的 90 秒。发给这台服务现在选的那个模型：选中的路线就在这台上，就是选中的模型；不在（选的是三家或另一台），就是这台清单上的第一个。「断开」或重连这台时，还在等的测试停掉。
- **选中本地模型时推理强度不出，原来的档位留着。** 本地运行一律不带推理强度（冻结的配置里是 off）；`agent.thinking` 不被改写，切回三家时还是作者原来选的档位。
- **模型菜单打开时顺带重问清单**，和四家一样最多五分钟一次；问不到就留着原来的清单（「没开的时候」选甲）。重问保留作者填的上下文。手填的服务不重问（网上的服务都是手填的，所以从不重问）。
- 设置「Agent」里的服务商下拉也列出本地服务（按格子名），模型下拉列这台服务的模型；选中本地模型时推理强度那一行整行不出，和输入框上面一致（作者 11-16 定，乙）。行是用 `dr_shell::settings::set_module_row_when` 登记的：返回 `None` 时连标签一起不画。

**接口。** `Connections` 多了 `local_servers`、`local_server`、`selected_local`、`put_local`、`select_local`、`disconnect_local`、`test_local`、`add_local_model`、`remove_local_model`、`set_local_context`、`load_local_catalogs`；`ConnectionService` 多了 `probe_local`、`apply_local_key`、`test_local`、`relist_local`、`forget_local_key`（`src/local.rs`）和 `with_local_test_wait`（测试用短的等候上限）；`Connections::local_test_model` 是「测试连接」发给哪个模型。`ConnectionView::new_companion` 是面板用的（四格加这一格），`ConnectionView::new` 只有四格。`LocalConnectionView::new(connections, settings, …)` 画这一格；设置登记在 `models.local`（`dr-shell` 注册表加了这一行，`agent.provider` 的取值加了 `local`）。CA 改的：`LocalFailure::NotLocal` 换成 `NeedsHttps`；`Probe::NoList` 换成 `Probe::AskName { software, known }`（问不到清单，或者是网上的服务；`known` 是网上服务清单里的模型，给手填的名字查上下文）；`LocalServer::on_the_internet`；`FormState` 多了 `key_shown`（密钥框在不在，`key_open` 仍是作者自己点开的），`LocalConnectionView::form_state` 现在收 `&App`；`Connections::add_local_model` 对网上的服务会在后台再问一次清单、找到就填上问到的上下文。

**测试。** `tests/local_models.rs`（GPUI 加本机假服务）：
- `connecting_selects_the_first_tool_model_and_freezes_its_server`：连上选中第一个能用工具的模型；不支持工具的、嵌入模型不进；冻结的配置带服务地址、推理 off、不发搜索、上下文是问到的；清单进设备记忆、账户偏好只有 `local` 和模型名；菜单行「Ollama · qwen3:14b」；不出推理强度；第二台 Ollama 用地址作名字；下次启动读回同样的清单和选择。
- `the_form_reports_plain_http_to_the_internet_unreachable_and_a_refused_key`（CA 前叫 `…_not_local_…`，第一种错误原来是 `https://api.example.com/v1` →「只能填本机或局域网地址」，现在是 `http://api.example.com/v1` →「网上的地址要用 https」）：三种错误；Key 通过后才存；「编辑密钥」清空但服务要 Key 时 Key 留着；「改地址」不开密钥框时 Key 留着。
- `emptying_the_key_removes_it_when_the_server_needs_none`、`without_a_model_list_the_form_asks_for_a_model_name`（手填、再添、× 掉最后一个就断开）、`settings_context_test_and_disconnect`（填的上下文优先、清空回到问到的；测试连接「可用」和关掉服务后的「连不上」；服务没开照旧算连着；断开删 Key）、`choosing_a_cloud_model_keeps_its_reasoning_level`、`the_service_probes_keys_and_refuses_plain_http_to_the_internet_before_asking`（CA 前叫 `…_refuses_the_internet_…`，原来拒 `https://api.example.com`，现在拒 `http://api.example.com`）、`the_account_keeps_local_as_a_provider_and_nothing_else`。
- CA（网上的服务是 `https://api.example.com` 的回环替身，M28「网上的服务怎么测」）：`an_address_on_the_internet_shows_the_key_field_by_itself`（不连网：网上的 `https`、`http`、不写协议的地址密钥框自己出来、「加 Key」按钮不在；本机、局域网 `https`、`*.local` 收着；框里有字就一直在；中文「网上的地址要用 https」「自定义服务」）、`a_service_on_the_internet_asks_for_a_model_name_and_takes_its_context`（没 Key「密钥无效」；在自己出来的框里填 Key 后问到清单、但出「模型名」框，什么都没连上、没发对话；填清单里有的名字，上下文是清单给的；名字是 `api.example.com`、手填、有 Key、Key 只进钥匙串；冻结的配置推理 off、不搜索；菜单行「api.example.com · example-chat-large」；设置里再添一个清单里有的名字后台填上上下文、清单里没有的留默认；打开模型菜单不重问；「测试连接」带 Key 发给选中的模型）、`changing_the_address_of_a_service_keeps_its_key`（存过 Key 的网上服务「改地址」密钥框收着、「加 Key」在，连接带着存的 Key、又问模型名，Key 留着；不要 Key 的网上服务 `api.example.com:8443` 名字带端口，「改地址」时框自己出来，空着连接不加 Key、也不删）。
- `src/local.rs` 单元测试（CA 改的）：存的清单原来连 `https://api.example.com` 也丢掉，现在留着、`http://api.example.com` 丢掉；名字规则加了网上的主机名和端口、认出软件照旧用软件名。
- 作者 11-16 定的三处：`a_list_with_no_tool_model_stays_unconnected_and_says_why`（只有 gemma3 和嵌入模型：不连上、出新字、不出「模型名」框、没发对话；问不到清单的照旧问模型名）、`the_agent_settings_page_has_no_reasoning_row_for_a_local_model`（设置面板里推理强度那一行在 DeepSeek 时有、选中本地模型时整行没有、切回来又有）、`testing_a_connection_waits_for_the_model_to_answer`（「测试连接」真发了一个对话请求，假服务把回答压着时一直是等候中、放开后才「可用」；发的是这台上选中的模型，选三家时是这台的第一个；对话回 401 是「密钥无效」；服务关掉是「连不上这个地址」）、`a_model_that_does_not_answer_in_time_fails_the_test`（注入 300 毫秒的等候上限，模型不回话是请求失败那句）。
- `src/local.rs` 单元测试：存的清单里过不了地址规则的条目丢掉、名字规则、重问保留上下文、上下文框只收 1 到 1 亿的数字、`KeyChange` 的调试输出不带 Key。

**原型没画的七处，作者 11-16 定（原话「都按你倾向的」）。**
1. 面板「连接模型」里没有「＋ 本地模型」：连着的本地格子点了就选中、回对话；要再加一台去设置里加。（照原样）
2. 「改地址」不打开密钥框时，已存的 Key 留着、跟着去新地址；要换或去掉照旧点「编辑密钥」。（照原样）
3. 「测试连接」时 Key 被拒，显示现成的「密钥无效」，别的不动。（照原样）
4. 问到了清单、滤完一个不剩：不连上，表单下面写「这台服务上没有能用工具的模型」，格子照旧「未连接」，不转手填框；问不到清单的照旧转「模型名」框。（改了）
5. 设置「Agent」页：选中本地模型时推理强度那一行整行不出。（改了）
6. 「＋ 本地模型」是加号图标加「本地模型」；地址框淡字 `http://localhost:11434` 九种语言一样、不进翻译。（照原样）
7. 「连接」只问清单；「测试连接」发一句，等模型真回了才说「可用」，等的时候转圈。（改了）

另有一处没问作者、照现在：上下文框只收数字，空着就是没填；填 0 或超过 1 亿当没填。

**CA 原型没画、照最保守的做法先做的。**
- 逐字打本机地址时，打到一半（比如只打了 `l`、`http://l`）会被当成网上的地址，密钥框闪出来再收起；原型的地址判定也是这样。粘贴整条地址时不闪。
- 网上的服务问到了清单、但滤完一个不剩（只有嵌入模型）：照原型推荐那一项的逻辑，一样出「模型名」框，不说「这台服务上没有能用工具的模型」。
- 网上的服务「改地址」或「编辑密钥」后点连接，又问一次模型名，原来手填的那几个换成新填的这一个（问不到清单的本地服务现在就是这样，原型网上的服务也是这样）。
- 设置里给网上的服务「添加」模型名时，后台再问一次清单查上下文（清单不存）；问不到就留默认。
- 单标签主机名（`http://intranet`）、IPv6 链路本地地址照旧不算局域网，所以现在算网上的、要 `https`。

**CA 的真窗口。** 场景 `next/crates/dr-view-agent/scenarios/custom-service.json`，调试桥例程 `custom-service-acceptance`（tiny 种子书库、内存里的 Key、`https://api.example.com` 的回环替身，运行走真的模型传输层到替身）：

```bash
cargo build -p drifting --example custom-service-acceptance --features debug-bridge --locked
cargo drifting workspace scenario crates/dr-view-agent/scenarios/custom-service.json \
  --app target/debug/examples/custom-service-acceptance --out <输出目录> --yes
```

面板里点开「自定义服务」、填网上的地址（密钥框自己出来）、不带 Key 连接被拒、填 Key 连接、出「模型名」、填一个、连上、发一句收到替身的回答；设置「模型与 API」搜「自定义服务」看那一块、点「测试连接」；设置「Agent」的服务商下拉是 `api.example.com`。

验收记录（2026-11-24，`DRIFTING_WINDOW_DISPLAY=secondary`，在合进 CM4a、CM1、PF 之前的 CA 提交上）：**49 步、0 pending 全过**，九张图逐张看过，和原型「第五版」选推荐项的样子一致；截图是记录，不进仓库。合进 `main` 以后屏幕已经睡了，没有重跑。

**11-16 三处修改里原型没画、按最保守的做法先做的。**
- 「测试连接」发给哪个模型：选中的路线在这台服务上就发选中的模型，否则发这台清单上的第一个（原型的「测试连接」不分模型）。
- 清单是空的（`data: []`，比如刚装好、一个模型都没拉的 Ollama）也算「问到了清单、滤完一个不剩」，出「这台服务上没有能用工具的模型」，不转手填框（原型的模拟世界里每台都有模型）。
- 「测试连接」的等候上限是 5 分钟（`local::MODEL_WAIT`）；本地对话的读超时也放到这么长（四家仍是 90 秒），不然模型第一次加载时连真对话也会在 90 秒没字节时断掉。
- 测试时模型没在上限内回话，或回了别的错误（模型不存在、服务端 500），都是请求失败那句；只有清单那一步连不上才是「连不上这个地址」。

## 0.1 的旧对话（2026-11-21）

导入 0.1 时，作者在 0.1 里和帮手的对话原样只读地存进了新库旁边的 `import-v1/receipt.sqlite`（`archive_agent_*`，[m10「帮手对话、本机状态和回执」](m10-import.md#帮手对话本机状态和回执)），一直没有地方看。作者 2026-11-21 在原型「退役 0.1 前的几处空白」第二页回了「都按推荐做」：三甲（「历史」里新对话下面一节「Drifting 0.1」）、四甲（打开的旧对话没有输入那一块）、五甲（「历史」顶上一个搜索框，新旧一起搜），连同清单页规则没管到的 6–10 条。原型的笔记和源码在监管会话的共享笔记 `retire-gaps-proto.md`、`retire-gaps-proto-v1/`。

**作者会看到的。**
- 导入过 0.1 的书，Agent 栏点「历史」：先是这本书的新对话，隔一点是小标题「Drifting 0.1」和个数（导入对话框的眉题，不翻译），点小标题收起、再点展开（照素材库的小节），下面是这本书在 0.1 里的对话，最新的在上，没有标题的写现成的「未命名」。这台电脑的书库旁边没有存档，或者存档里没有这本书的对话，就没有这一节。
- 点一个旧对话：头上是返回箭头和标题（照「回审阅」的样子，箭头读作「返回」）；第一行小字「Drifting 0.1 · 日期」（0.1 里最后改动那天，本机时区）；下面照新对话的样子：你的话在框里，Agent 的话是正文，「思考过程」照旧能折叠，读写工具是一行灰字（0.1 的工具名，比如 `read_chapter`），点不了，没有「本轮改动」；0.1 在对话里显示过的出错照新对话的样子（红字）。没有输入那一块：没有用量、模型、强度、输入框、发送，也没有项目记忆、工作记忆那一行。点返回回到「历史」，刚才的搜索还在。
- 「历史」顶上一个搜索框，只有放大镜，没有提示字（照全书搜索）。打字停 90 毫秒后搜：新旧对话一起搜标题和每句话（你的话、Agent 的话；工具名和思考过程不搜），不分大小写。结果照样分两组，先新对话，再「Drifting 0.1」（这时小标题不能收起）；每条是标题（命中的字加深加粗、不垫底色），下面一行是现成的「用户」或「Agent」和命中那句话前后几个字；框尾「几个 · 几处」；一个都没有写「没有找到匹配项」。点一条打开那个对话：旧对话直接停在命中的那一轮；新对话照旧打开在最下面（新对话的视图是一整块滚动，要停在某一轮得改它的结构，这次没改）。搜索框也是新对话第一次能搜（规则 9）。
- 旧对话只在导入的那台电脑上（存档在书库旁边，不同步，规则 6）；0.1 里删掉的对话不列（规则 7）；旧对话不能删、不能改名、不能接着聊（规则 8：没有这些按钮，任何键都不会发出去）；对话跟着书走，只在这本书打开时列，书不在库里就哪里都看不到，书从最近删除里恢复了就回来（规则 10）。

**怎么读存档（`dr_import_v1::agent_archive`）。** 读存档的这一层放在导入器里（存档的格式是它定的），只读：`Archive::open(书库根目录)` 用只读、`query_only` 打开，从来不写；没有存档是 `Ok(None)`，文件头不对或比文件头说的页数短（截断）是 `Error::Damaged`，这时没有这一节，日志里一行原因，不带对话里的任何字。接口：`Archive::conversations(书) -> Vec<Conversation>`（编号、标题、最后改动时间，不读正文）、`Archive::turns(书, &Conversation) -> Option<Vec<Turn>>`、`Archive::search(书, 词, &取消标志) -> Vec<Found>`；`find_all`、`find_in` 是两边共用的找字规则。
- **列哪些：照 0.1 自己的 Agent 面板**（`agent-conversation-repo.ts` 的 `listByProject`）：这本书的、`source = 'chat'`（外部 MCP 客户端的会话 0.1 也不列）、没删的，按最后改动倒序；0.1 接着别的设备的对话聊时会分出一支新的，旧的那支有且只有这一个没删、已就绪、从它的最后一轮分出来的孩子时，0.1 不列旧的，这里也不列。为了这一条，导入器从这一版起把 `agent_chat_branch` 也搬进存档（存档从 7 张表变 8 张，`tables.rs` 去向改为 `agent-archive`，丢失检查跟着按行数核对）；以前导入的存档没有这张表，两支都列。
- **一轮是什么：0.1 显示的那份。** 0.1 把画出来的对话原样存在 `messages_json`（`AgentChatMessage`）：`user`、`assistant`、`thinking`、`tool`（只取工具名）、`error` 各是一轮；计划清单 `todos` 和用量 `usage` 不算。`messages_json` 是空的（0.1 只在运行日志里有）时，照 0.1 同步时的读法（`visibleMessages`）从 `agent_runtime_message` 读这段对话指定的那次运行（没有指定就是最新的一次）：作者的话、助手的文字／思考／工具调用，工具结果不显示。0.1 的运行事件流没进存档，所以不按事件重放。
- **大存档。** 存档是 `CREATE TABLE … AS` 整表复制的，没有索引：列表只读对话表的几个小列；打开一个对话按行号读那一行（行号对不上时再按编号找）；搜索在后台线程上逐个对话读，新的一次搜索把上一次的取消标志立起来，读完当前这个对话就停；打开的旧对话用 GPUI 的 `list`，只排屏幕上看得见的那几轮（测试里 120 轮的对话停在最后一轮时，最上面几轮根本没排）。新对话的搜索也在后台，逐个读快照。

**面板里（`src/panel/old.rs`）。** 列表按书读一次（换书、换库重读），不在主线程上读；「历史」的头、旧对话的头都在 `PanelHead`。打开旧对话时 `send` 直接返回，输入那一块整个不画。供测试的入口：`AgentPanel::old_conversations`、`old_conversation`、`open_old_conversation`、`close_old`、`show_history`、`history_shown`、`history_search`、`set_history_query`、`history_results`、`old_scroll_top`。F5 的 `TextField` 加了两个只读的 `meta()`、`placeholder_text()`（测试看框尾计数和没有提示字）。

**照现成做法补的（原型没画或和现有组件对不上的）。**
- 记忆那一行（项目记忆、工作记忆）照旧在「历史」的最上面，搜索框紧接在它下面，是「历史」这张单子的第一行；原型没画记忆那一行。
- 「历史」里新对话的行原来是居中的文字按钮，现在和旧对话、搜索结果一样，是靠左的一行（原型就是这样画的）。
- 搜索时「Drifting 0.1」那一节不能收起，读屏读作标题；平时是能按的按钮。
- 旧对话里的「思考过程」照新对话能折叠（原型没画思考）；出错照新对话是红字。
- 0.1 在列表里标题相同的几条后面加过编号的后六位，这里不加（接着聊分出的那支只列一条，别的同名很少见）。

**测试。**
- `dr-import-v1/tests/agent_archive.rs`：合成 0.1 库（`tests/common/conversations.rs`：有标题、没标题、0.1 里删了的、带工具调用和思考和出错的、接着别的设备聊出一支的、只在运行日志里的、120 轮的长对话、外部 MCP 的、不在这个库里的书的，字都是中文）走一遍导入器写出存档，再读：按书列、顺序、删掉的／外部的／被替换的那支／别的书的都不列；每一种一轮读对、长对话 120 轮；搜标题、作者的话、Agent 的话，不分大小写，工具名搜不到，只在这本书里，取消立刻停；读完存档字节和修改时间都没变；没有分支表的旧存档两支都列；截断一半、换成一段字的文件都是「坏了」。`a_library_without_an_archive_has_no_old_conversations`：没有存档、存档里没有帮手表都是没有。`src/agent_archive.rs` 单元测试：找字、0.1 的显示格式、第一处命中。`src/tables.rs` 加了一条：存档搬的表和去向表里写 `agent-archive` 的一致。
- `dr-view-agent/tests/old_conversations.rs`（真的面板和头，同一个合成库导入后打开，新对话用脚本模型）：有这一节、小标题和个数、能收起再展开；删掉的、被替换的、外部的、别的书的不在；打开旧对话后没有发送、用量、记忆那一行，头上是返回和标题、没有「历史」「新对话」；在输入框里打字回车、直接调 `send` 都没发出任何请求；按工具那一行什么都不变；返回后「历史」原样。没有存档的库没有这一节、搜索框照在。搜索框没有提示字；「精神胜利法」同时找到新对话和旧对话、框尾计数和全书搜索同一句；新对话里 Agent 的话也找得到；`todo` 找到 `TODO`；找不到时写「没有找到匹配项」、框尾空；连着两次搜只留后一次；点旧的命中停在命中那一轮（长对话的最后一轮在屏幕上、第一轮没排）；点新的命中打开那个新对话。

**真窗口。** 场景 `next/crates/dr-view-agent/scenarios/old-conversations.json`，用调试桥例程 `old-conversations-acceptance`（这个配置的书库、脚本模型、本机回环的连接测试、内存里的 Key）：

```bash
cargo build -p drifting --example old-conversations-acceptance --features debug-bridge --locked
DRIFTING_WINDOW_DISPLAY=secondary cargo drifting workspace scenario crates/dr-view-agent/scenarios/old-conversations.json \
  --app target/debug/examples/old-conversations-acceptance --out <输出目录> --yes
```

合成 0.1 库（`legacy sample-v3-conversations`）走全部项目的普通导入，打开书，连上脚本模型问一句，「历史」里找到「Drifting 0.1」和各条、找不到不该有的，打开一个旧对话确认没有发送、没有「历史」「新对话」、思考能折、工具名不是按钮，返回，在搜索框搜「精神胜利法」新旧都找到、分组、不相干的不在，点旧的命中再返回；第二次启动在导入后的库上用深色把三张图再截一遍。

验收记录（2026-11-21，副屏）：**88 步、0 pending 全过**。浅色、深色各三张（「历史」带「Drifting 0.1」一节、打开的旧对话、搜索结果）逐张看过，和原型第二页甲甲甲一致；截图是记录，不进仓库。导入换库以后右栏回到「审阅」，场景先点右栏的「Agent」；连上脚本模型以后焦点没有自己进输入框，场景照 `companion.json` 点「发送」上方进去；搜索框不在辅助功能树里（`ui.focus` 也够不着），场景点「工作记忆」下方 42 像素进去。

**没做的。** 新对话从搜索结果打开时不停在命中那一轮（见上）；旧对话里命中的字不加深；从批注「交给 Agent」记下的 0.1 对话编号（`comment.agent_conversation`）打开时不会去找存档里的那段旧对话。

## 图片（CM4a，2026-11-24）

依据 [custom-modules.md](../custom-modules.md) 第 16 节第 1 条：「丢一张草图或截图」要 Agent 栏先能收图片；模型看不了图片时，Agent 在对话里照实说这个模型看不了图片、请换一个能看图的，不另加界面。建模块的工具不在这一路（CM4b）。原型没画这一块，样子只用现有组件，拿不准的都选了最朴素的，列在交回报告的「等作者的事」。

**作者会看到的。**
- 把图片文件拖到 Agent 那一栏的任何地方（对话、输入框、按钮上都行，照设计稿第 8 节「拖进 Agent 那一栏」；拖着经过时整栏底色稍深），或在输入框里 ⌘V 一张复制的图片（比如截图）或复制的文件，输入框上方出现一排 48 像素的小图，每张右边一个「×」（读作「移除图片」），点了就去掉。同一张图再放一次还是一张。只收 PNG、JPEG、WebP；一张最多 7 MB、边长最多 8000 像素；一条消息最多 4 张。超了或格式不对，在对话下面那行出错的红字里说（「只能发送 PNG、JPEG 或 WebP 图片。」「图片太大：每张最多 7 MB，边长最多 8000 像素。」「一条消息最多带 4 张图片。」），能发的照样加进去。
- 剪贴板上有字时 ⌘V 照旧贴字，不收图（有的程序复制一段字时也放一张图）；剪贴板上有文件时收文件。
- 可以只发图片不写字。发出去以后那几张小图离开输入框；对话里作者那条消息的框里，字的上面一排 64 像素的小图。这台设备上没有字节的（比如同步来的对话）是一个空的方块带一个图片记号。
- 看得了图的模型（Anthropic 的清单说能的模型；ChatGPT 订阅的清单说能、或者那一行没说的模型；OpenAI API Key 的所有模型；本地服务说能的模型）照常回答。选的是 Anthropic 或 ChatGPT 订阅、模型菜单还没打开过（手里只有内置清单）时，带图片的消息先去取一次这家的模型清单再发（这期间发送按钮是忙的）；清单取不到就按看不了处理。
- 看不了图的模型：作者的消息照常进对话（带着图片），Agent 回一句「现在用的模型看不了图片。请换一个能看图的模型再发。」（按界面语言，九种语言都有），不发请求。
- 正在运行时输入框里的字照旧是插话或回答，图片留在输入框里，等下一条新消息一起发。
- 换书或点「新对话」时，输入框里的图片和字一起清掉。

**做法。** `AgentPanel` 多了 `attached`（输入框里的图片：`images::Attached { image: ImageRef, bytes }`）和按摘要缓存的小图 `thumbs`。读文件、认格式、解出小图（`images::check`/`check_file`/`thumbnail`，最长边 192 像素）都在后台线程；比上限大的文件不整个读，只读文件头判断是「太大」还是「格式不对」。粘贴在输入框外面一层用 `capture_action` 先接住 `dr_ui::input::field::Paste`，按上面的规则决定自己收还是让输入框贴字。发送时 `AgentController::start_job_with_images` 把字节交给运行时（`Runtime::start_with_images`），连同按界面语言给的那一句；对话里的小图由 `AgentController::read_image` 从本机读、在后台解。小图在辅助功能树里是 `Image`，名字「图片」；去掉按钮是 `Button`「移除图片」。

**接口**（只加不改）：`AgentPanel::{attach_bytes, attach_paths, remove_attached, attached, thumb, error}`；`AgentController::{start_with_images, start_job_with_images, read_image}`；`Connections::live_catalog`（带图片的消息发送前取一次清单）；`MessageContent::User` 多了 `images`（不认识的记录占位为 `None`）；`LocalServerModel.image_input`（存在设备记忆里，重问清单时更新）。新的界面文字在 `dr-i18n` 的 `own/*.json` 的 `agentImages`（`image`、`remove`、`unsupported`、`tooLarge`、`tooMany`、`unseen`），九种语言。

**测试**（`tests/attachments.rs`，真的 GPUI 面板、合成种子库、脚本模型、dr-testkit 的合成图片）：
- `paste_and_drop_attach_images_and_text_pastes_as_text`：剪贴板上的图片进输入框不进字、小图画出来；剪贴板上的字照旧贴字、图片还在；同一张再贴还是一张；拖进一张 PNG 和一张 HEIC，PNG 进来、HEIC 不进且出错的那行说格式；拖到发送按钮上、拖到输入框上面的对话里也都收（整栏都收）；去掉一张。
- `the_limits_are_said_before_anything_is_sent`：8001 像素宽、大于 7 MiB 的都说太大；拖五张不同的进四张、说最多四张；没有任何请求。
- `a_model_that_cannot_see_is_not_asked_and_the_agent_says_so`：DeepSeek 路线带图发送，脚本模型没被调用，对话里作者消息带一张图、Agent 回那一句，输入框清空，对话里那张小图画出来。
- `a_local_model_that_sees_gets_the_bytes_and_one_that_does_not_is_told`：本地服务说能看图的模型收到只有图片的消息和它的字节；同一对话换成没说能看图的模型再发一张，模型没被再问。
- `anthropics_live_list_is_asked_before_an_image_goes`：选 Anthropic、只有内置清单时带图发送，先问了本机假清单（说这个模型能看图），请求带着那张图。
- `src/local.rs`：重问清单时能不能看图跟着新清单走。

**真窗口。** 场景 `next/crates/dr-view-agent/scenarios/agent-images.json`，例程 `agent-images-acceptance`（临时 tiny 种子库、内存里的合成 Key、一个本机回环服务扮 Anthropic 和 DeepSeek：Anthropic 的清单说模型能看图，它的 Messages 接口把收到的每张图解出来、回「收到 N 张图片：宽×高」；真的模型驱动发请求）：

```bash
cargo build -p drifting --example agent-images-acceptance --features debug-bridge --locked
DRIFTING_WINDOW_DISPLAY=secondary cargo drifting workspace scenario crates/dr-view-agent/scenarios/agent-images.json \
  --app target/debug/examples/agent-images-acceptance --out <输出目录> --yes
```

第一次启动在 Anthropic 上：右栏展开、等它滑完，把例程写在书库旁的合成草图（640 × 400）拖到发送按钮上，输入框上方出现「图片」和「移除图片」，写一句话回车；假服务只在请求真带着图片时多回一段思考，所以「思考过程」出现就说明图片随请求到了，回的那句「收到 1 张图片：640×400」在截图上；输入框里的图片走了、消息里的图片在。第二次启动在 DeepSeek 上：拖进同一张、只发图片，没有请求发出去，对话里那一句在截图上、图片在。辅助功能树里没有普通文字，回答的字只能看截图。

验收记录（2026-11-24，副屏）：**38 步、0 pending 全过**，三张截图（放进输入框、Anthropic 回「收到 1 张图片：640×400」、DeepSeek 时 Agent 那一句）逐张看过。现成的 `companion.json` 同日 44 步全过。

真窗口里查出来的两件事（都不是这一路的代码，记在这里）：
- 右栏刚点开时还在滑动，这时按辅助功能树给的位置拖进文件会落空（按钮的 `ui.press` 先停一下再点，不受影响；`input.drop` 不停）。场景在展开后等 1.5 秒。
- GPUI 只要最后一次输入是键盘，就不认鼠标「悬停」（`Hitbox::is_hovered` 在键盘模式下恒为否），而从访达拖进窗口的文件事件不会把模式改回鼠标。所以作者在输入框里打完字、没动鼠标就直接从别处拖进文件时，这次拖放会被忽略；在窗口里动一下鼠标以后再拖就收下了（调试桥上对 Agent 栏实测过这两种；GPUI 的 `on_drop` 都靠悬停，按代码看全 App 的拖放都一样，素材库也是，没实测）。要不要修是 GPUI 那层的事。

## CM3：「打开工作台」那张卡（2026-11-24）

工具结果里带着 `custom_modules`（CM4b：建、改、改名、另存一份，或者往条目模板里放进了一个之前没有的）时，那条结果下面每个模块一张卡：名字、「我的模块」、「打开工作台」（打开它的工作台药丸）。出错的结果不出卡。代码 `panel.rs` 的 `module_cards`；测试 `tests/module_card.rs`（脚本模型建一个模块，点卡开药丸）。
