# next/ canonical v3 切换

2026-11-10 实施、11-11 完成源验收与守卫独立复核，任务 7，从 `main` 的 `93a43a3f` 实施（源 `codex/switch-v3` `b10d7ac1`，整合 `codex/batch-70` `2ae27b00`，本地产品合入 `main` `ad97a43c`）。本文记录最终切换范围；历史模块文档中“v2.2 不动／两套并存”的叙述只描述切换前阶段，以本页和当前源码为准。不推送、不发版。

## 做了什么

普通书架新建直接调用 `project.create`，生成真实 canonical v3 文档、小说模板和根；没有 `book.create` 注册别名。普通、preferred、直接打开和系统／正文链接都只接受真实 v3。旧书不做就地补版本、修复或删除，首选旧书可以略过并选择有效 v3 书；显式旧书打开被拒。书架编辑读取同一 v3 元数据，字数来自真实文稿树的正文模块；已有正文索引未就绪显示 pending，尚未创建的空正文为 0。

`dr-model` 将共享记录拆入 `shared`，旧源格式记录拆入 `import_v1`；`dr-doc` 的共享字段、素材、资源和快照原值操作拆入 `catalog`，v3 不再委托旧 BookView／BookTxn。保留实际 v3 编辑器、模块和滚动身份、IME、带版本守卫的局部写、原子条目快照、失败草稿与跨书资源守卫。Project Memory、事实、关系和 prose 管线仍是共享能力，迁到 v3 的同一记录与模型工具权威检查；不是删除共享能力来消除旧依赖。

旧固定章／构想／幕／要素／分类／故事线命令、cache、页面、模型工具和旧 Markdown watcher 已移除。`dr-view-ideas` 不再是工作区成员，其 canonical 通用条目显示、脚本和导航消费者移到 `dr-view-elements`。G1 的 17 条真实挂载 release 契约完整保留，Patches 只是迁到 `patches.rs`。新格式单本归档、同步协议和 v3 场景继续保留。未增分享、Markdown 文件夹、立绘或布局设计。

缓存的整书标签返回时在实际渲染中完成正文焦点交接，保留同一编辑器和阅读位置；对应整书写入／Undo／模块链接往返／重开契约保留。表格纯 v2 宽松写分支已移除，v3 的观察版本和接受输入收据始终检查。另修正一次实际刷新问题：接受自身 CAS 写只推进准入版本，不能代表格子显示已经追上该提交；格子必须消费这次更新。挂载编辑器补齐公用位置链接通知、实体和素材导航事件，保留旧壳层相同的目标存活检查。共享关系、事实和 Project Memory 的历史逆操作使用选定原始 CRDT 容器的 diff，并在脱离副本上验证完整原值后才写入活动文档；不把原子字符串、原子 map、富文本或列表重建成另一种表示。无法保留树身份时整次拒绝且不写入。旧 bare-link 逆操作遇到 module／block／未知属性会在整批写入前拒绝，保留原标记；丰富链接仍走现有带版本的正文协议。

## App 开发库重新导入

GUI 的 `Options.v3` 是非可选 `MappingChoices`，默认空选择也必须过同一 v3 preflight。普通界面可选源文件夹和显式 choices JSON；结构化 `V3Pending {code, source}` 留在 Ready 对话框。CLI 默认导入也使用此路径，`--v3` 只作为已有调用的兼容标记，不再选择另一套持久格式。

导入总是明确新目标 `reimport-v3-<id>`。活动库仍在普通界面使用，独立 worker 用没有 deriver 的 store 导入，关闭后再独立重建 v3 索引并关闭；之后才短暂执行统一 release／受控切换。不会在同一路径重新打开一个 store 绕锁，不取消已有活动 deriver 拒绝规则，不把长导入藏进无法取消的 release curtain。

取消等本书完成后停止；退出请求立即停止并等待真实 worker 退出。未完成目标和 choices 持久保存，重启提示续导；同一目标只接受完全相同 choices。成功打开新库后才登记本机首选；晚到 worker 发现活动库已被改变就保留完成的新目标并恢复原库，不覆盖后来选择。原 0.1 库、旧开发库、原 receipts 和未使用目标均保留。

导入历史目录先完整规划到内存，并在第一次目录写入前保存 `import-v3-replay` checkpoint：源／映射指纹、完整 Loro 操作、各历史 frontiers。续导重用完全相同的树根、组和操作；不在当前目录上重演历史，不删除 receipt，不改版本冒充升级。每个历史前缀实际写入后才给正文点记录相应 book frontiers。没有此 checkpoint 的旧半成品明确保留并拒绝续导，提示改用新目标。

`root_references` 是显式新根引用接线，解析到本次真实分配的根；模板允许列表和住处约束仍完整执行。JSON 中的空 choices 只有不触发未定策略且全部预检通过时才可用。内置样书继续用 v3 writer 与原 once-only 标记：Created／作者已删除样书不复活，缺映射策略明确 pending。

## 仍保留的源格式边界

- `dr-model::import_v1`、`dr-doc::import_v1`：0.1 历史回放和源快照适配，只在内存中供 importer／source builder 使用；不在 App 入口注册旧命令或提供旧页面。
- `dr-samples::{build,layout}`：有再分发许可的既有语料来源和源格式内存构造，转成 v3 后才写进 App。旧格式持久 fixture writer 已移到 `dr-testkit::seed::source_store`，产品 `dr-samples` 不再提供旧 `write_book`。
- `dr-testkit` 的 source fixture、历史基准和负向兼容探针保留旧源编码；普通 `seed:<preset>` 和明确 `seed:v3-<preset>` 都生成 canonical v3，退役 `seed-commands`。`legacy:sample-v3` 的 choices 只供显式合成验收，不是产品默认。
- 共享素材、资源、批注、关系、事实、Project Memory、历史／receipt DTO 和正文 codec 不因原来与旧模型同文件就删除。未知原值、并发和失败恢复仍由 canonical 契约约束。

## 机器可检查的证据

`cargo xtask check` 新增 `v3-cutover`：扫描产品 Rust 不能调用退役固定域命令、不能从非适配边界导入旧模型；检查退役路径不再出现；检查所有 crate 的场景不调用旧命令。registry 和 Agent catalog／Schema 快照由原测试生成器更新。

`dr-workspace/tests/cutover.rs` 验证默认 canonical 创建、共享能力还在且旧命令不可达、旧目录／正文拒开且原操作不变、旧 sync 载荷不能藏进新 v3 genesis。共享原子快照、内核、原子恢复、IME、跨书资源安全、新归档和 fake sync 契约保留。

`dr-view-import/tests/import.rs` 覆盖 GUI 的 prewrite pending、明确 choices、新目标／源全部文件 hash 与 mtime 不变、取消续导、退出排空、启动恢复、晚到 worker 与多窗口隔离。`dr-import-v1/tests/import.rs` 保留同目标 raw 原值完全相等及历史 frontiers，跨新目标只规范化合法新分配的身份和树内部坐标，正文操作字节照原样比较。

`state.get` 仅在已有 development bridge 增只读 `ime`，来自真实 `ProseEditor.composition()`；没有模拟组字写入口。`input.type` 只是提交普通字符，不能当平台组字证据。

`dr-sync --example v3-loopback` 是 development/test-only 长活 FakeSyncServer 与真实 SyncEngine 驱动器。App 闭库后才接管各隔离库，每次 sync 关闭库后回答；支持重复指定隔离 sandbox。它用于 App A 保存／退出 → 假服务往返 → App B 打开修改／保存 → A 收到重开的链，不接真服务，不改变网络协议，也不宣称生产 App 已有自动调度。

## 删除与迁移清单

主要删除的产品路径：`dr-workspace/src/cache.rs` 与固定域 `commands/{chapter,idea,element,storyline,relation,history,mention,patch,plot_grid,time_pin,template}.rs`；`dr-model/src/book.rs`、`dr-doc/src/book/` 的 App 运行时；`dr-shell/src/mirror.rs` 和 `workspace/chapter_sort.rs`；`dr-mirror` 的旧 layout／ledger／plan／service／sync；旧 home、ideas、elements、relations、timeline、stats 页面和 Markdown 分享入口。旧模型回放部分按前述适配边界搬迁，共享／v3 部分先抽出。

下列整文件是纯旧界面／旧命令测试或旧目录同步测试，已退役；源格式和共享安全契约不包含在这一许可中：

- `crates/dr-mirror/tests/folder.rs`
- `crates/dr-mirror/tests/service.rs`
- `crates/dr-testkit/tests/seed_commands.rs`
- `crates/dr-view-elements/tests/pages.rs`
- `crates/dr-view-elements/tests/panel.rs`
- `crates/dr-view-elements/tests/storyline.rs`
- `crates/dr-view-home/tests/home.rs`
- `crates/dr-view-ideas/tests/ideas.rs`
- `crates/dr-view-page/tests/idea_group_path.rs`
- `crates/dr-view-relations/tests/relations.rs`
- `crates/dr-view-stats/tests/detail_library.rs`
- `crates/dr-view-timeline/tests/timeline.rs`
- `crates/dr-workspace/tests/footprint.rs`

`dr-shell/tests/{workspace,m06_m07}.rs` 是迁移到 `dr-view-page/tests/shell_*.rs`，以真实 canonical 页面挂载集成，不能计成删测试。MCP 的真实本地传输、权限、断连／关闭排空与清理失败契约和 testkit 的 Workspace CAS／后台重建契约也用 canonical 种子继续运行；MCP 旧 selective undo 片段改为真实作者完整快照恢复，不重开模型恢复入口。导出对话框使用通用分组和 trashed 条目，统计模板排除使用真实 v3 template module。纯旧 chapter-list 滚动测试删除，v3 模块／条目滚动身份和多页编辑器契约保留。旧 `dr-export/tests/book_file.rs` 的 v2 布局／digest 用例由 canonical v3 归档往返覆盖；损坏／foreign／0.1／newer 拒绝无写入和不可变 conversation payload 仍在同一测试文件。

单函数的旧固定域覆盖退役：自动新要素全书回填与要素创建 picker、自动标题后缀／幕分区／故事时间重排／旧模板正文 fallback、旧 Agent selective undo、Markdown 分享、旧专题 starters／storyline 行。共享素材／批注／TODO／Project Memory／事实／关系、编辑会话 Undo、原始历史恢复和原子数据安全已保留或改用 canonical v3 测试；不以名称里含 chapter 或旧目录名作为删除理由。

旧截图示例 `dr-shell/examples/{shell-capture,m06-m07-capture,m18-capture,history-capture}.rs` 和 `dr-editor/examples/page-capture.rs` 同时退役；它们依赖已删固定域命令，历史 PNG 保留。`edit`／`editor-bench`／`book-bench`／`prose-bench` 的默认生成改为已有 canonical v3 路径；本轮不运行 heavy 或改写历史测量。

旧固定域场景已删，所有已有 v3 场景保留；含创建旧书的混合场景拆成真实 v3 前缀，不删除其 canonical 正确性断言。删掉的旧场景：

- `crates/dr-cli/scenarios/bottom-panel.json`
- `crates/dr-cli/scenarios/elements.json`
- `crates/dr-cli/scenarios/history.json`
- `crates/dr-cli/scenarios/idea-group-path.json`
- `crates/dr-cli/scenarios/ideas.json`
- `crates/dr-cli/scenarios/import.json`
- `crates/dr-cli/scenarios/page-chrome.json`
- `crates/dr-cli/scenarios/plot-paste.json`
- `crates/dr-cli/scenarios/plot-punctuation.json`
- `crates/dr-cli/scenarios/relations.json`
- `crates/dr-cli/scenarios/review-current-associations.json`
- `crates/dr-cli/scenarios/review.json`
- `crates/dr-cli/scenarios/timeline-create.json`
- `crates/dr-cli/scenarios/writing-loop.json`
- `crates/dr-view-page/scenarios/v2-chrome.json`

不变量清单同步切换：共享规则改指实际 canonical 契约，完整快照指向原子恢复／并发拒绝测试；以下固定产品规则只列为明确退役，不计成通过中的运行契约：NODE-KIND-STATUS、CHAPTER-HAS-ORDER、DRIFT-NO-ORDER、CHAPTER-NO-GROUP、GROUP-EXISTS、ORDERS-FINITE、ORDER-TIES、MEMBERSHIP-SET、MEMBERSHIP-LIVE、PRIMARY-IS-MEMBER、ALIASES-SET、ELEMENT-CATEGORY、PORTRAIT、ELEMENT-NAME-UNIQUE、TITLE-SUFFIX、CATEGORY-LAYOUT、PATCH-BLOCK-NEEDS-NODE、PATCH-OWNER、TREE-DEPTH、ACT-PIN-DRIFT、DIV-DRIFT-BINDINGS、DIV-CATEGORY-ELEMENTS、DIV-STORYLINE-MEMBERSHIP、DIV-DUP-TITLE、DIV-DUP-CATEGORY、DIV-DUP-ELEMENT。清单仍逐项检查每个活动契约的测试函数存在，未跳过该门禁。

## 待作者／待协调

只保留三个窄产品策略：M10 22 `act_binding` 的关系类型和方向；23 `unaffiliated` 的住处和完整 EntryTemplate（含 home）；25 每种关系类型的 source／target 模板列表。缺项 prewrite 返回对应 structured pending；不把 fixture choices 塞进默认。其余幕转分组、章／构想树和摆放、归属／主归属／时间钉、24 字段模板、27 颜色沿用已定映射。28–31 以真实预检与已有写入能力为准，不笼统扩成新的作者设计。

M10 的三个技术缺口已补齐（夜间队列第 2 项）：28 旧 `entityLink`（`material`／`library_item`、显式 `module`／`targetModule`、带容器跨度重映射的 `targetBlockId`／`targetEndBlockId`）在当前正文、模板与快照历史中经 `ProseTxn::link_entity_v3` 无损写入 `EntityLinkV3`；29 `FieldDef` 新增可选 `default_value`，经 `entry_template.put` 校验并在 `entry.create` 初始化新条目字段值，导入器在当前书目与历史 `elementTemplateKvJson` 回放中无损保留非空字段默认值；30 带标记与链接的旧表格单元经 `ProseTxn::set_table_cell_runs_v3` 与 `TableWriter::remove_cell` 在 `Prose`／`Note` 两种 profile、模板与历史版本间无损导入与往返。真正损坏或超出 profile 的链接／单元格内容仍 prewrite 结构化拒绝并保持源库零修改。31 的 App v3 样书与索引已接通，importer 活动 deriver 拒绝规则保留，通过闭库新目标流程满足。22、23、25 三个作者策略保持原样 pending。

v3 Markdown 文件夹（待定方案见 [m40-markdown-folder-v3.md](modules/m40-markdown-folder-v3.md)）、分享链接和界面设计／性能打磨仍按原授权边界暂缓。当前 SyncEngine 没有生产 App 自动调度，loopback 窗口链不覆盖它。源格式或未来表示无法无损迁移时继续 prewrite 拒绝，保留原数据；这不等于完成全部未来表示扩展。

## 检查结果

2026-11-10 最终 Rust 实现 `31fed908b533a1be82ed44d5e4942eed4ccc9a4f` 的自动检查；其后 `6fdc97ce6`、`8dcf77446`、`4464555ab` 只修正本次窗口场景的等待和入口断言，Rust／Cargo 源码完全相同。外部 `switch-v3-final-checks.json` 记录完整日志的 hash、运行终点和被检查的源树；后续文档／场景门禁另记，不冒称重新执行过完整测试。

| 检查 | 实际结果 | 外部完整日志 |
| --- | --- | --- |
| `cargo fmt --all --check` | 通过 | `switch-v3-final-fmt6.log` |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 | `switch-v3-final-clippy8.log` |
| `cargo test --workspace --locked` | 2203 通过、0 失败、20 忽略，含 doctests | `switch-v3-final-test6.log` |
| `cargo xtask check`（含 audit） | 12 门禁通过；972 锁定 crates、0 漏洞、12 依赖提示 | `switch-v3-final-xtask5.log` |
| 根 `pnpm public:check` | 通过 | `switch-v3-final-public4.log` |

首轮及随后失败日志均保留，已修复对应问题；第五次完整测试在编译中因发现共享素材链接 writer 接错而主动中断，未记作通过或环境重试。原 registry／catalog／Schema 生成器实际运行，快照没有手编辑。历史性能证据未重测或改写；evidence 门禁显示 20 stale／15 legacy，不能称本阶段性能通过。

最终 47 步场景与本页证据补齐后，`switch-v3-final-fmt7.log`、`switch-v3-final-xtask6.log`（含 audit）和 `switch-v3-final-public5.log` 再次通过；后者扫描 5551 个公开候选。`switch-v3-final-scenarios1.log` 的 `the_shipped_scenarios_parse` 定向契约通过，核对所有保留场景仍能由正式解析器读取并正常结束。它不替代此前完整工作区测试，也没有额外运行 heavy 或外观验收。

全套测试结束后，使用本工作区自己的 target 重建 Debug App／CLI／loopback helper。`switch-v3-native-build4.log` 和 `switch-v3-native-helper-build1.log` 均通过；Debug App 链接器有 `__eh_frame` 超过 compact-unwind 16MB 的提示，未隐去，也未以此声称性能通过。所有命令使用 `CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1`。

2026-11-11 源真窗口验收，源码 `4464555abeb334729bf8ded8748670505034b0a7`；三个验收顺序运行，均先取得独占租约，使用合法独立 profile 和真实独立数据目录。每次窗口均用 PID 和 CG 全局 bounds 核对在副屏，不以 App 内部相对坐标代替。证据均在约定仓库外日志目录，以下是实际运行结果：

| 流程 | 实际结果 | 外部证据 |
| --- | --- | --- |
| 普通新建／编辑／重开／拒绝旧书／开发库重导 | 47 步通过，0 pending；普通 New book 创建真实 v3；正文输入保存重开；直接旧书返回 canonical admission 的 `invalid`，旧链接返回 `not_found`；空 choices structured pending 后，显式 fixture choices GUI worker 导入新目标，Done 返回书架，再经普通入口打开和编辑 | `switch-v3-native-main-4/{result.json,driver.log,source-and-target-proof.json}`；profile `sv3-main-4`，PID 62734／62791 |
| 源不变／新目标 | 原源库的数据库、资源和安装标记共 3 个文件的 SHA256、字节数、mtime 全部相同；原活动库保留，新目标是独立 `reimport-v3-<id>` 目录，打开的导入书实际 version=3 | 同上 `source-and-target-proof.json`，由验证脚本从实际结果生成 |
| 真实平台 IME | 已安装 Apple 拼音经真实系统按键产生 `ni hao` marked-text，range=0..0，selection 仍 0..0；组字中读取的持久正文和 version 均未变；空格提交恰好一次「你好」并推进 version，退出重开正文与精确 version 一致；原输入源恢复 | `switch-v3-native-ime-10/{events.ndjson,preedit.json,committed.json,reopened.json,manual-result.json}`；profile `sv3-ime-10`，PID 75109／75300 |
| App A → 假服务 → B → A | A 真窗口输入「甲」保存退出；同一个长活 FakeSyncServer 经真实 SyncEngine 上传 27／下载 27 文档；B 真窗口精确读到 A 的正文和 frontier，再输入「乙」保存退出；上传 2／下载 2 文档，A 重开精确读到 B 的正文和 frontier；helper 正常退出 | `switch-v3-native-sync-3/{events.ndjson,native-a-write.json,native-b-read.json,native-b-write.json,native-a-return.json,manual-result.json}`；profiles `sv3-sync-3-a`／`sv3-sync-3-b`，PID 70824／70884／70917 |

IME 证据来自本次未打包的真实 Debug App 和只读 `ProseEditor.composition()`，不是 `input.type`、模拟 marked-text 或本地 bundle 的准备结果。外部探针发送真实 CG 系统键盘事件并核对前台 PID，经本机已启用的 Control-Space 选择 Apple 拼音；单次等待完成输入步骤，避免轮询工具把 Codex 带回前台。`switch-v3-native-cleanup.json` 核对原输入源已恢复、租约空闲；所有验收 App 和假服务都已退出。

外部 `switch-v3-native-receipt.py` 从上述实际结果交叉核对 source、App hash、全部步骤、源文件清单、组字前后持久值、精确版本、传输数和每次 PID／副屏坐标，生成 `switch-v3-native-evidence.json` 并记录证据文件 hash。它只汇总已运行结果，不生成或手编辑仓库内的合同／性能 JSON。

首轮窗口失败同样保留：main-1 的 symlink profile 被现有安全门拒绝，且场景在异步 entry 快照发布前导航；main-2 对正确旧书拒绝码的断言错误；main-3 错误等待导入后自动打开书，实际受控换库按既有协议回书架。仅修正 harness／场景，未绕锁、删源、放宽版本检查或自造自动打开行为。main-4 完整重跑后才计通过。

IME-1–9 的环境／探针失败和 sync-1–2 的前台焦点失败完整保留，未把普通拉丁字符当作组字。中间本地 Debug bundle 诊断曾因未复制既有字体停止，补齐后仍未证明组字；最终通过证据是 IME-10 的原 Debug App。焦点守卫实际捕获到 Codex 重新前台，未向其他 App 发送该次受阻输入；没有将这些失败批量宣称环境瞬时后反复原样重跑。同步最终完整三次窗口链在 sync-3 重做。

本源验收不代替守卫的独立复核，不覆盖生产自动同步、heavy／性能预算、截图目检、样式或流畅度；这几项未记通过。三个窄映射策略和 M10 28–30 的保守技术预检仍按前述待协调边界保留。

### 守卫独立复核与合入记录（2026-11-11）

- **整合修补：** 整合候选 `codex/batch-70` 在源 `b10d7ac1` 之上仅补一处启动就绪修复（`2ae27b00`：`dr-shell/src/book/v3.rs` 将条目与模块准备统一纳入字海开书等待门，避免开书落地后异步模块首次挂载竞态，并新增永久回归 `sea_opening_wait_prepares_v3_entry_modules_without_stalling`）。
- **全套 9 门禁独立重跑（`batch-70-full-2/results.json`）：** `CARGO_BUILD_JOBS=6 RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1` 下，`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked --no-fail-fast`（**2204 通过、0 失败、20 忽略**，含全部 17 条恢复注册的 `dr-shell::release_tests`）、`cargo xtask check`（13 门禁含 `v3-cutover` 扫描 686 个产品 Rust 文件与 `audit` 972 包 0 漏洞）、根 `pnpm public:check`、`pnpm ci:contract:check`、`pnpm agent:capabilities:check`、四份兼容验收与九语生成校验全部一次通过。
- **删测内容级核对与 8 项审查（`guardian-content-test-audit.json`、`guardian-switch-8point-audit.json`）：** 按函数体逐条审计 `main..codex/batch-70` 删除的 236 个测试函数，仅 2 条含 v3 词元且均为“v3 与 v2.2 并存”双断言（已由纯 canonical v3 用例替代），6 条共享命令调用均为旧固定域调用方且对应 v3 契约仍在 `v3_common.rs`、`dr-view-stats/tests/v3.rs`、`dr-workspace/tests/registry.rs`。`shelf_book`（`dr-workspace/src/commands/book.rs:152-164`）已核实：不存在或 `head == None` 记 `Some(0)`，已有提交而索引未追上 `head.seq` 时返回 `None`（pending），不把待建索引正文误计为 0 字。旧 Markdown watcher 在应用层零激活，外部文件与设置原样保留。
- **副屏真窗口独立验收：** 在冻结源码 `2ae27b00` 上独立跑通 `g-b70-m3` 全部 15 条 canonical v3 流程、`g-b70-switch-2`（普通新建 v3 书、输入重开、拒开非 v3 书与深链、EPUB 成稿导出校验、空 choices prewrite `V3Pending` 零目标写入且 `libraries.json` 字节不变、显式 choices 独立目录重导与源库 SHA-256／mtime 不变、重开读回）以及 `g-b70-sync-1`（窗口 A 写入退出 → `v3-loopback` 假服务同步 → 窗口 B 精确读回并写入退出 → 假服务同步 → 窗口 A 重开读回；`automaticAppSync: false`）。当前守卫宿主 `Antigravity` 未获 macOS 辅助功能／`CGPreflightPostEventAccess` 权限，外部 `CGEvent.post` 注入 `SCIM.ITABC` 按键被系统拦截（`g-b70-ime-1` 如实记录，未用 `input.type` 冒充系统组字；进程内 `gpui-ime`／`dr-editor` 组字契约与源 `sv3-ime-10` 证据保留）。
- **本地合入：** 已以 `--no-ff` 本地合入 `main`（`ad97a43c`）。
