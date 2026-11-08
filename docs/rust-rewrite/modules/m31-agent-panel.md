# M31 帮手面板与改动显现

交回状态：`codex/m31-agent-panel`；首次实现 `ef63d4f9`，生命周期与登录修复 `f6840cc7`；第二十三批反馈修复 `21ad1134`；第二十七批关系导航、可见卡片确认及取消边界修复 `925597e4`；已合入 M29 `44357606`；全套检查与真实窗口验收通过；F4 逐字覆盖接口与真模型手测仍待后续。

2026-11-08。实现 [M31 任务书](../handoff/m31-agent-panel.md)，接在
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
  完整星芒；推理标题和运行状态用同一套，减少动态效果时静止。
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

`CompanionTools` 组合 M29 的 `AgentTools` 和 `ask_user`。后者返回 M27 的
`ToolOutput::Question`，作者回答继续同一次工具调用；没有另建 CRUD 清单，也没有在
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

1. **F4：写入时逐字覆盖显现。** 当前 F4d 接收已经提交的 Agent 收据，计算新增／改写
   的范围并画墨色；它没有向 M31 提供逐字揭示新文本、覆盖旧字或播放期间光标与布局处理
   的公共接口。M31 已验证提交后的三类墨色和指针淡出，没有修改 F4 所属的绘制代码。
   需要 F4 提供受正文提交边界约束的播放接口，再由真实 Runtime 写入测试验证；不能
   通过延迟实际持久写入来模拟动画。
2. 真模型连接和真实 ChatGPT 登录留给作者手测；自动化仅使用本机假服务。M32 MCP、
   M30 长任务和 M33 生图不在本模块另开产品入口，继续组合共享 Runtime 的工具和控制。
3. M29 审查修复 `4d55f081`／`44357606` 已随本分支合入：排除隐藏级联删除和两项
   构想转换，拒绝指定关系 id，更新目录及 `chapter.create` 修订回归。第二十七批的
   `note_tasks.project` 内部维护命令已预先排除；该命令和 M19 消费者尚未进当前 main，
   来源传播和三个 Agent 元数据入口的投射回归仍须在 M19 集成时验证，见 M29 文档。
4. **其他元数据对象的定位入口。** 当前 M29 真实开放的 effect 中，以下对象还没有
   可复用的公开定位接口；暂不显示假导航或整书回退。需要对应模块提供准确的 owner／
   目标查询、展开定位与显示确认，再接入“本轮改动”：
   - M04／M14 的 `act`、`time_pin`：时间线按 id 定位；M16 的 `idea_group`：组路径展开。
   - M19 的 `material_folder`：素材树定位；M17 的 `relation_type`：类型管理定位。
   - M15／F6 的 `plot_grid`：打开其节点并显示实际规划表；M11 的 `patch`：查找确切
     要素并定位补丁卡；M11／M13 的 `template_field`：确认模板 owner 并定位字段。
   - 项目设定中的 `fact`：字段定位；M30 的 `memory`：记忆条目定位。
   关系本身的改动现已提供真实端点入口；本项不另建关系详情页或第二套路由。
5. **模板正文的精确定位。** `template:category:<id>` 与 `template:storyline:<id>`
   都是独立正文，F3／M09 支持它们的历史；缺的是 F6／M11／M13 按模板 owner 和 doc
   定位实际编辑器的公开接口。故事线页已有内嵌章节模板，但没有精确展开／滚动定位
   接口，分类模板也没有现成导航目标。本轮暂不为模板收据生成当前必失败的改动或历史
   按钮，不把模板冒充所属分类／故事线的正文。真实 F3 模板写入收据的回归同时确认
   `history.points` 可读、无无效 UI 入口；待 owner 提供定位及显示确认后再开放。

## 代码位置

- `next/crates/dr-view-agent/src/panel.rs`：面板、提问／许可／搜索卡、输入、改动导航。
- `src/controller.rs`、`src/hub.rs`、`src/state.rs`：库级服务、外壳生命周期、持久记录投影。
- `src/connection.rs`、`src/connection_view.rs`、`src/settings.rs`：连接测试、模型选择、设置。
- `src/onboarding.rs`、`src/data.rs`、`src/tools.rs`、`src/prompt.rs`：首次引导、起手请求数据、
  运行时提问工具、以当前书为界的系统指令。
- `next/crates/dr-shell/src/release.rs`、`library.rs`、`quit.rs`：统一异步释放边界。
- `next/crates/dr-view-agent/tests/`、`next/crates/dr-shell/tests/release.rs`：上述契约与集成测试。
