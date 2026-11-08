# M27：帮手运行时核心

2026-11-08。任务书见 [handoff/m27-agent-runtime.md](../handoff/m27-agent-runtime.md)。本模块只做模型无关的本机运行时；模型接入、工具生成、面板分别由 M28、M29、M31 接上。

## 做了什么

- 新增无 GPUI 依赖的 `dr-agent`。模型驱动输出文字、思考、签名及回放数据、完整工具调用、用量；运行时把每个事件先记进本机日志，再供调用方读取。
- 普通对话、调用工具后继续、向作者提问、回答、中途插话、当前工具后停止、立即中止都走同一个状态机。测试驱动按脚本输出，可以停在指定位置等测试放行；不连真模型或官方服务。
- 写书仍走 F3 的命令，带 `Actor::Agent { session, turn, call }`。F2 把更新与结算记录放在同一事务，M27 读取真实结算记录附在工具结果上。失败的写入也可能有已提交部分，不能根据返回错误推断「什么都没写」。
- 新增每个对话一篇只追加的 Loro 文档。它是已持久化日志的对话投影；本机没有另一张消息表。中途崩溃后重放，不会重复消息，也不会重新执行工具。
- 新增 F2 迁移 `0007_agent_runtime`，存本机会话和有序事件；删除对话文档或彻底清除书时，相应日志一起删除。原来的结算记录事务与生命周期不变。

## 定下的事

1. **每个打开的库一个 Runtime，可以克隆。** `Runtime::new` 拒绝为同一个库建第二个运行时，避免恢复流程把仍在运行的会话当成崩溃，也让工具调度器始终共享。一个 run 对应一次作者请求；后续请求开启新 session，沿用 conversation id。每次插话应用时，当前 session 的 turn 增加。
2. **日志先落盘，投影随后写。** 本机事件和同步对话是两个恢复边界，不假装跨文档原子。稳定的 `session:seq` 是投影记录 id；投影失败或两步之间崩溃，`recover()` 重放补齐。书的更新和结算记录仍严格同一事务。
3. **只把对话内容放进同步文档。** 作者消息、助手完整或未完成的消息、工具结果；思考签名和 opaque replay 字段随助手消息保留。权限请求、控制指令、运行状态、本机结算行号不进入同步文档。工具输出自身应由 M29/M32 做隐私与内容筛选。
4. **不分权限档。** 本机读写和删除直接进入执行器。只有 `PaidImage` 和 `ExternalPlugin` 在执行前提问。一次许可绑定 session、turn、call、随机请求 id，以及日志中的完整参数；执行前重新核对冻结的工具描述和 revision。动态插件改变实现或 schema 必须改变 revision，执行器也必须执行该 revision 或拒绝。
5. **中止不等于撤销。** 模型流、未进入的调用、只读调用和作者等待可以取消；已进入的写入必须等到它的 future 结束并核对结算，再进入 `Aborted`。`RunHandle::join/finish` 返回后不得还有工具继续写。已写入的内容由 `history.undo_agent` 撤销。
6. **停止与插话都有明确边界。** 插话先持久化、按接收顺序在下一次模型调用前应用；不会打断正在提交的工具。停止会完成当前已开始的调用组，取消批次里其余未开始的工具；流式输出期间没有工具在执行时直接停止。控制调用同步只做非阻塞投递，返回的 future 等待持久确认；自然结束先关闭邮箱作为裁定点，尚未持久确认的竞态请求明确得到 `Closed`，不与终态存储共用锁。
7. **有界并发，写入有屏障。** 相邻、无需许可的读工具组成一组，默认最多四个并行。写工具单独运行，不能穿过前一组读；后续读也不能穿过写。同一 Runtime 的不同 runs 共享组锁，组间保守串行。M29 仍负责 F3 操作级并发、作用域和修订 CAS；这里没有复制整套工具清单。
8. **不默认限制模型轮数。** `max_model_rounds` 默认 `None`，只有作者明确提供限制才停止；没有隐藏的输出 token 上限。[M28](m28-model-providers.md) 已将模型、能力和迭代上限移到每次 `Start` 接收的不可变 `RunConfig`，同一个驱动按该快照分派提供商。

## 事件和状态机

日志格式版本 `PROTOCOL_VERSION = 1`。`JournalEvent` 是 `{session, seq, turn, event}`；SQLite 中 `seq` 从 1 连续增加，每次追加校验上一条序号，旧序号写入会失败。

完整重放先验证首条 `Started` 的版本和连续序号，再创建或修复对话。增量读取每次点查首条版本，只解码游标后的事件，已经接收的前缀保持不可变。

| 事件组 | 事件 |
| --- | --- |
| 生命周期 | `Started`、`StateChanged`、`Failed`、`Recovered` |
| 对话 | `UserMessage`、`TextDelta`、`ThinkingDelta`、`ThinkingSignature`、`Usage`、`AssistantMessage` |
| 工具 | `ToolProposed`、`ToolStarted`、`ToolFinished` |
| 作者回答 | `QuestionAsked`、`Answered` |
| 两种许可 | `PermissionAsked`、`PermissionAnswered` |
| 控制 | `SteeringReceived`、`SteeringApplied`、`StopRequested`、`AbortRequested` |

`ToolProposed` 表示模型提出，`ToolStarted` 表示执行器即将进入；都不等于书已经改了。`ToolFinished.settlements` 才引用 F2 已持久化的实际写入。没有变更的写命令可能没有结算记录。

| 状态 | 下一步 |
| --- | --- |
| `Streaming` | 流式输出；结束后进入工具或完成；控制可以令其停止 |
| `RunningTools` | 完成本组，进入下一组、回答等待或下一次模型调用 |
| `AwaitingAnswer` | 正确 request 的回答成为当前工具结果，不重新执行该工具 |
| `AwaitingPermission` | 正确 request 的允许才进入工具；拒绝作为工具结果交给模型 |
| `Stopping` | 禁止启动下一调用；已进入的写入结算完毕后终止 |
| `Completed / Stopped / Aborted / Failed / Interrupted` | 终态；旧控制请求不能复活运行 |

回答错 session、turn、call 或 nonce 会得到 `StaleRequest`，不会消耗真实问题。所有控制确认在日志持久化之后发出；仅成功投递不代表已接受，调用方仍须等返回的 future。驱动必须以 `Finish(Complete|Tools)` 明确结束，连接突然结束是失败，不能算成功。流式文字与思考按 block index 合并；同一个 index 改变类型会报协议错误。

## 接口

```rust
let runtime = dr_agent::Runtime::new(ws.clone(), driver, tools, Options::default())?;
runtime.recover()?; // 库打开后，开始新运行前
let run = runtime.start(Start { book, conversation, input, config })?;
let control = run.control.clone();
control.steer(text).await?;
control.answer(request_id, answer_json).await?;
control.permit(request_id, true).await?;
control.stop_after_tool().await?;
control.abort().await?;
let terminal = run.finish().await?; // 或非 UI 线程里的 join()
```

- `Driver::stream(DriverRequest, Cancellation) -> BoxStream<Result<DriverEvent>>`：不能阻塞工作线程；丢弃流要取消 I/O。`DriverRequest` 带已同步的整个对话、当前 session/turn/round、冻结的工具描述和运行配置。分片 JSON 的组装归 M28，给运行时的是完整 `ToolCall`。M28 新增原生搜索活动、完整 wire 回放及错误类别，见其模块文档。
- `ToolExecutor::{descriptors, execute}`：执行返回 `Value` 或 `Question`。`ToolContext` 提供书、来源、取消标记、冻结描述和工作区；同步 F3 命令用 `workspace_call()` 转到独立工作线程，保持控制邮箱可响应。helper 拒绝把写命令标成读，并校验显式 `book`、`doc` 归属；它不是完整的 M29 对象作用域检查。
- `events(library, session, after_seq)`：读已提交事件；M31 按事件投出消息和当前请求。没有第二套 UI 消息存储。
- `conversation(library, id)`：读同步投影；文档模型接口与不变量见 [m27-conversation-schema.md](m27-conversation-schema.md)。
- `dr_store::agent`：会话的 `conversation` 保存完整 `conversation:<id>` 文档 id；`agent_append_event` 用 expected_seq 作 CAS，也能通过 `LocalTx` 和创建会话合在一次事务里。

`Runtime` 自己开一个后台线程跑 futures，不要求 GPUI 或某一种 async runtime。生产 driver 若依赖 Tokio，应由 M28 自己持有 executor，不能假设这里已有 Tokio 上下文。

## 崩溃与恢复

- F2 原子事务中途进程死亡：书的更新与结算记录一起存在或一起不存在。没有一个只有新正文、没有结算的状态。
- 事务已经提交、`ToolFinished` 还没写：恢复按 session/turn/call 找到结算，补一条 `Interrupted` 工具结果；不重调工具。没有结算也不推断外部插件「肯定没做事」，仍交还作者决定。
- 模型流中途死亡：从最后一轮尚未封口的 delta、思考签名、用量与工具提议重建 `complete: false` 的助手消息。未结束调用补中断结果。
- 已经终止的会话只修复投影，不再加恢复事件。重复 `recover()` 不增加消息或结算。
- 旧问题、许可和已接收但尚未应用的插话保留在本机日志；恢复不会自动获得许可、重跑请求或继续写书。M31 要把中断状态与未应用插话显现出来，作者可发起新运行。
- 磁盘写日志失败时，即使正在处理中止指令，也会等已进入的写入结束。若连失败事件也写不下，当前调用返回错误，下一次启动按非终态日志恢复。

## 与旧版的对照

| 旧版 | 新版 |
| --- | --- |
| `protocol.ts` / `transport.ts` 的驱动与接缝 | `Driver` 流；仅进程内一种实现，不保留 sidecar/remote |
| `agent-authored-journal`、`chat-journal-*` 及消息存储 | 本机追加事件日志；UI 从事件推导；同步的是只追加 Loro 对话 |
| 执行控制审计中的问题、插话、两种停止 | 本机邮箱、持久化确认、严格 request identity、写入结算后终态 |
| Yjs/旧表适配和结算层 | F3 同一命令语义 + F2 Loro 更新/结算原子事务 |
| 待审/拒绝写入和权限档 | 不引入；直接写入，历史按来源撤销 |
| 驱动各自调用工具 | 统一工具合同、读组/写屏障、只为插件和付费生图提问 |

没有搬旧数据模型适配，没有新增退役产品，也没有新增界面文案。

## 外壳里的挂接点

本次不改应用入口或界面。M31 在库打开后创建一个 Runtime、先 recover；新聊天创建 ConversationId，后续作者消息沿用它。面板读取日志并把控制送给对应 run；切库、退出前中止并等所有 run 完成，再释放 Runtime、关工作区。不能在 GPUI 主线程调用阻塞的 `join()`。

丢弃 `RunHandle` 会请求中止，避免遗留一个永远等回答的工作线程；这只发出信号，确保写入已经停妥仍要等待 `finish/join`。

M31 接入换库与退出后补充了资源释放边界：只读 future 可取消，但已交给 OS 线程的
`ToolContext` 可能仍持有工作区。线程必须保留整个 context，私有执行 lease 随之释放。
服务先冻结新运行并等待所有 run/start 完成，再等待 `Runtime::drain_tools()`，最后
释放库；这不改变只读调用取消或 `RunHandle` 的完成语义。真实 M29 与 `workspace_call`
读取的阻塞／关闭回归在 `dr-view-agent/tests/lifecycle_read.rs`。

## 测试与证据

测试使用 `dr_testkit::seed::Tiny` 的书和正文、合成模型事件，契约在测试里断言，不提交 JSON 证据，不测忙碌机器上的性能。

- `dr-agent/tests/runtime.rs`：普通轮次、签名思考回放、跨 run 对话上下文、真实 F3 工具写入与来源撤销、投影缺失与结算后崩溃恢复、重复恢复、流异常结束。
- `dr-agent/tests/controls.rs`：提问及过期回答、权限拒绝及过期许可、插件 revision 改变、插话、当前写工具后停止、中止等待写结算、读工具并发与写屏障、结束后的控制拒绝；与完成竞态的插话只有持久确认或明确拒绝两种结果。
- `dr-view-agent/tests/control_delivery.rs`：阻塞真实 Completed 追加调用中的 F2 存储通知时，控制与 close 立即返回，窗口快捷键仍响应；关闭 future 继续等待，放行后真实换库成功。
- `dr-agent/tests/settlement.rs`：写入后重开、按来源撤销；删除直接执行，按 F3 的界面语义让批注暂时浮置，撤销恢复原绑定。
- `dr-agent/tests/crash.rs`：F8 子进程试验台，F2 更新行已插入、结算还没插入的事务中途强杀六次，核对正文、更新行、结算的 before/after frontiers 及重开结果。
- `dr-agent/tests/failure.rs`：日志写入失败与正在进行的写入同时发生，终态必须等真实写入结算。
- `dr-agent/tests/errors.rs`：协议错误与驱动 panic 后保留已落盘输出、关闭未执行调用、释放活动登记；同库单 Runtime、跨书误用对话无副作用、丢弃 run 自动中止。
- `dr-agent/tests/protocol.rs`：未知或缺失协议版本、断裂序号在投影前拒绝；只读库可以读取已有对话。
- F1 的对话测试：确定创世、追加、相同事件幂等、并发合并、冲突 id、删除/篡改/重排拒绝、未知 payload 保留。
- F2 日志测试：重开、有序 CAS、竞争写入、失败事务不发通知、安全迁移、清除、导入验证回调。
- F3/索引/导出回归：对话不会被正文操作或全文索引误读；远端导入校验只追加；`.driftingbook` 保存对话历史 payload，不把工具结果中的历史 id 当作可执行引用重写。

2026-11-08，macOS 独立 worktree 的最终检查：

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --all --check` | 通过 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo test --workspace --locked` | 通过；日志汇总 1536 passed、19 ignored，包含 M27 的 26 项测试 |
| `cargo xtask check` | 全部门禁通过；审计 0 vulnerabilities、12 notices |
| 仓库根 `pnpm public:check` | 通过 |

全量检查先发现旧备份测试在模拟旧库时没有去掉新增表，已补齐夹具并验证恢复后日志表可用；还发现新 worktree 没有字体，补入并校验六个生成字体与 `provenance.json` 的固定 SHA-256 后，全量重跑通过。字体留在忽略的 `.cache/fonts`，不入库。门禁把 14 份既有测量报告标为过期，本次没有在繁忙机器上重测或提交性能数字；12 条审计提示来自未改变版本的既有锁定依赖。

## 待协调

1. **F1 审核（第十九批已合）**：`DocKind::Conversation`、追加模型及不变量见单独的结构说明。为了让新种类能完整运行，本分支给正文分派补了明确的非正文分支，没有扩大书目/正文模型。
2. **F2 审核迁移 0007（第二十批已合）**：此前迁移未改；hash 门禁已登记。`LibraryOptions.validate_import` 是无模型依赖的回调，F3 安装对话验证器；同步更新走 holder 线程先验证后导入。新增的事务内暂停/检查点仅供 F8 强杀试验，默认关闭。（F2 已审，见第 8 条。）
3. **M28（第二十批已合）**：已实现 driver 和不可变的每次运行配置，见 [m28-model-providers.md](m28-model-providers.md)。原要求：按 `complete` 处理未完成消息；保留签名思考的原始 replay；输出 token/模型配置由 adapter 持有。当前一个 Runtime 绑定一个 driver，接多模型时应扩展不可变的每次运行路由/配置，不能在每轮读取可能被界面改过的全局设置；真实服务手测留给作者。
4. **M29**：从注册表生成工具描述和 schema，处理名称解析、所有参数的书作用域、修订 CAS、上下文筛选；保证只读工具没有副作用，写 future 结束时所有写入都已结束；不要绕过 Actor 或自己重试未知写入。
5. **M31 / F6**：面板投影与运行生命周期挂接、插话未应用提示、中断继续入口。此模块没有 UI 验收要求，也不注册应用 init。
6. **M32 / M33**：插件 revision 稳定性、外部结果内容筛选、付费图片请求使用两种许可合同；没有全局「以后都允许」状态。
7. **M36**：按 `DocInfo.book_id` 把 conversation 文档随书同步；只传 Loro 字节，不能上传本机日志表、权限或结算行号。导入使用 F3 安装的验证回调，不能跳过只追加约束。
8. **F2 审核结果**（2026-11-08，F2 第七轮）。大白话：迁移、事务、清除的做法都对，F2 顺手改了四处小地方，另有几条意见留给 M27、F1、M36。
   - **迁移 `0007` 合规矩**：开库前拍安全快照、门禁 `PINNED` 已登记、只有基线的旧库升级测试和旧备份的升级夹具都覆盖到它，不用改。`agent_event` 对 `agent_session` 的外键是库里第一条外键：没有级联，`forget` 先删事件再删会话，没问题；以后动这两张表要记得外键检查开着。
   - **事务边界没问题**：建会话和追加事件能在同一个 `LocalTx` 里，按序号比较后再写，排在同一把写锁后面，并发写不会分叉；提交后才发事件，回滚什么都不发。每条增量单独一个写事务也不贵：F2 量了 2 万条（`dr-store/tests/agent.rs` 里默认不跑的 `measure_journal_appends`，release，负载 40 多，只作参考），每条中位 0.016 ms、p99 0.15 ms，日志每条约 151 字节；整库读回 2 万条 7 ms。
   - **F2 改了的四处**（各有测试，拿掉改动测试就失败）：
     1. 清除一篇文档时，按会话记下的对话 id 删日志，不再看文档的种类名是不是 `conversation`（dr-store 不认种类名）。
     2. 一本书的最后一篇文档被清除时，这本书各篇文档上的 Agent 结算记录一起删：书已经没了，撤销不了，摘要里可能还引着原文。只删一篇、书还在时，结算照旧留着（会话还要显示）。
     3. `agent_sessions(Some(书))` 改成走 `agent_session_by_book`：原来 `?1 IS NULL OR book_id = ?1` 的写法会扫全表再排序。
     4. 导入验证回调 panic 时，这次导入被拒（`StoreError::Invalid { what: "import" }`），什么都不导入，持有者照常工作；回调万一往文档里写了东西，单独存成 `outside` 一行，不混进导入那一行。
   - **给 M27 的意见**（没改）：
     - `recover()` 每次开库都把所有会话（包括早就结束的）的日志从头读一遍，还打开每个会话的对话文档。一次请求一个会话，常用的作者一年会有上万个，开库会越来越慢。建议只重放没结束的会话；要判断「结束了、投影也齐了」，可以向 F2 要一条「每个会话的最后一条事件」的查询，一条 SQL 就够。
     - 日志只增不减。一段两千字的回答大约百来条增量、十几 KB。会话结束、`AssistantMessage` 封口以后，那些增量就重复了；可以结束时删掉，或者定个保留期。要做的话 F2 给一个「删某会话某段序号」的接口，序号不复用。
     - 事件的键：插入是 `<会话>/<序号>`，清除时是整个 `<会话>`。监听方按表名分就行，别解析键。
     - 日志在库里，所以跟着整库备份走；在另一台电脑上恢复备份后，没结束的会话会被 `recover()` 标成中断，这是对的。
   - **给 F1、M36（第二十批按 F1 第七轮校正）**：旧的全快照比较已被替换。现在在文档 fork 上试导入并检查新增操作；删除记录、修改身份或缺少因果依赖都会拒绝。被拒的更新不存、不推进同步游标；缺依赖时先补齐再重送，非法操作要显示同步阻塞，不能静默跳过。仍可批量传输来减少 fork 和校验次数。F3 目前把这些错误都包装成 `what: "conversation import"`，M36 不能据此判定永久错误，需和 F1/F3 协调稳定分类。以 [对话结构说明](m27-conversation-schema.md) 的同步约定为准。

## 代码位置

- `next/crates/dr-agent/src/`：`protocol.rs`、`driver.rs`、`tools.rs`、`control.rs`、`runtime.rs`、`journal.rs`。
- `next/crates/dr-model/src/conversation.rs`、`dr-doc/src/conversation.rs`：同步对话结构。
- `next/crates/dr-store/src/agent.rs`、`migrations/0007_agent_runtime.sql`：本机日志。
- F3、dr-index、dr-export 中的新文档种类分派，以及相应回归测试。
