# next/ canonical v3 切换

2026-11-10，任务 7，从 `main` 的 `93a43a3f` 实施。本文记录最终切换范围；历史模块文档中“v2.2 不动／两套并存”的叙述只描述切换前阶段，以本节和当前源码为准。本分支只交付实现与验收，整合者复核后本地合 main，不发布。

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

M10 的技术预检边界继续明确隔离：28 已有 `EntityLinkV3`／`link_entity_v3` typed writer，当前 importer 对旧素材／显式模块／特定正文块链接仍沿用 `v3-prose-link-writer-missing` 拒绝码；待接的是旧表示到该 writer 的无损适配，不是新的作者链接设计。29 非空字段默认值尚无 FieldDef 初值接口；30 旧表格单元带标记／链接仍缺无损转换；两者保留原来源并 prewrite 拒绝。31 的 App v3 样书与索引已接通，但 importer 活动 deriver 拒绝规则保留，通过闭库新目标流程满足。上述限制没有列入三个待作者策略，也没有为完成切换而删除预检。

v3 Markdown 文件夹、分享链接和界面设计／性能打磨仍按原授权边界暂缓。当前 SyncEngine 没有生产 App 自动调度，loopback 窗口链不覆盖它。源格式或未来表示无法无损迁移时继续 prewrite 拒绝，保留原数据；这不等于完成全部未来表示扩展。

## 检查结果

2026-11-10 最终实现组合的自动检查：

| 检查 | 实际结果 | 外部完整日志 |
| --- | --- | --- |
| `cargo fmt --all --check` | 通过 | `switch-v3-final-fmt6.log` |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 | `switch-v3-final-clippy8.log` |
| `cargo test --workspace --locked` | 2203 通过、0 失败、20 忽略，含 doctests | `switch-v3-final-test6.log` |
| `cargo xtask check`（含 audit） | 12 门禁通过；972 锁定 crates、0 漏洞、12 依赖提示 | `switch-v3-final-xtask5.log` |
| 根 `pnpm public:check` | 通过 | `switch-v3-final-public4.log` |

首轮及随后失败日志均保留，已修复对应问题；第五次完整测试在编译中因发现共享素材链接 writer 接错而主动中断，未记作通过或环境重试。原 registry／catalog／Schema 生成器实际运行，快照没有手编辑。历史性能证据未重测或改写；evidence 门禁显示 20 stale／15 legacy，不能称本阶段性能通过。

当前为自动检查通过的候选，真窗口主流程、真实平台组字和 App A/B/A 假服务链的本轮结果尚待实际运行，不能以准备的场景或脚本代替结果。
