# M09 快照历史

2026-11-08，第一个里程碑。计划见 [modules.md 的 M09](../modules.md)。界面在 `next/crates/dr-view-history/`，后端是 F3 的 `history.points`、`history.preview`、`history.restore_point`（`next/crates/dr-workspace/src/commands/points.rs`，说明见 [f3-workspace.md 第四轮](../foundations/f3-workspace.md)），历史点本身是 F2 的历史标签。外壳里只挂了一处入口。

## 做了什么（大白话）

1. **章节稿纸右下角的 ⋯ 菜单里有「历史快照…」。** 点它，工作区上方浮起一个对话框，照旧版 `EntitySnapshotHistoryModal`：
   - 上面一行小字「历史快照 · 30 天」，标题是「章节 · 这一章的名字」；
   - 下面是这一章的历史点，新的在前，每个点一行：时间（等宽小字，今年的写「11/08 14:05」，往年的前面加年份）、当时的字数、当时这一章的标题、当时正文的前两行；
   - 一个点都没有时，显示旧版那句「暂无快照。编辑正文后系统会按约 15 分钟一次的节奏自动留存。」
2. **点一行就能预览。** 那一行变成静止的选中玻璃，下面展开当时的全文（H1/H2/H3 加粗，正文用稿纸的字体），最多 240 像素高，可以滚动。再点一次收起。这是新加的：旧版只看得到前两行。
3. **恢复要再确认一次。** 每行右边是「恢复…」；点了以后原地变成「取消」和「确认覆盖当前版本」。确认后按钮显示「恢复中…」，这时对话框关不掉。恢复完，列表下面写「已恢复到所选版本。恢复前的状态已自动存为新快照。」，列表重新读一遍，最上面多出一个点（恢复前的样子）。失败就写「恢复失败：原因」。
4. **恢复的是正文和这一页自己的字段**（按实体恢复）：正文回到那个点；章节的标题、梗概、写作状态也回到当时的值；书里别的东西不动。要素当时的名字或别名现在已经被别的要素占了，就不改名字和别名（照旧版）；章节当时的标题现在被另一章占了，就照新版的规矩加后缀（「雨 2」）。
5. **能撤销。** 恢复是作者的一个命令：对象级撤销一步撤回正文和字段，重做再来一次。编辑器自己的撤销不会撤到它。
6. **浅色深色都看过。** 截图在 [m09/](m09/)：`history-*` 是三天前那个点展开了预览，`history-confirm-*` 是点了「恢复…」以后。

## 定下的事

| 事 | 怎么定的 | 理由 |
| --- | --- | --- |
| 快照存在哪 | 不另存，用 F2 的历史标签（每个标签记着正文和书目当时的版本） | F2 已经照旧版的规则打点、修剪；另存一份就是两套历史 |
| 多久一个、留多久 | F2 的规则：写作时最多每 15 分钟一个，关闭时一个，帮手每轮动手前一个，恢复时一个；一小时内全留，一天内每小时一个，再往前每天一个，30 天后删掉 | 和旧版一样；旧版 TypeScript 那份会把恢复前的点在同一个小时里修剪掉，F2 用的是旧版 Rust 移植的修正（一小时内全留） |
| 列表里显示什么 | 时间、字数、当时的标题、前 120 个字（界面截成两行） | 照旧版；旧版不显示「为什么打的这个点」，这里也不显示（数据里有 `kind`，以后要可以加） |
| 预览放哪 | 点哪一行就在哪一行下面展开 | 旧版是一列，没有预览区；在原地展开不用改布局，宽度照旧 520 |
| 恢复前先存一份 | 先给现在的版本打一个 `restore` 点，再恢复 | 旧版的提示语就是这么说的 |
| 入口在哪 | 章节 ⋯ 菜单的「历史快照…」，以及右栏统计标签最底下的同名按钮（M20 加的，调同一个 `open_history`） | 监管会话定的；旧版唯一的入口在右栏统计面板底部 |
| 别的页面 | 对话框不分种类：要素、故事线、分类、素材笔记的正文都能用，标题前面写「要素 ·」之类 | 它们的 ⋯ 菜单还没做，做的时候各加一项 |

## 接口

```rust
// 外壳（dr-shell）里的挂接：workspace/corner.rs 的菜单项和 open_history，
// workspace/mod.rs 的一个字段、一行渲染。
ws.open_history("node:<id>".into(), "章节名", window, cx);   // 打开；HistoryEvent::Close 时收起
let dialog = cx.new(|cx| HistoryDialog::new(lib, doc, name, locale, platform, cx));
// HistoryEvent::Restored { doc } —— 恢复成功（改动本来也会从 F3 的总线到达）

// 不依赖 GPUI 的部分（dr_view_history::model）
model::kind_key("element:…")      // 标题前面的种类：章节 / 要素 / 故事线 / 类目 / 笔记
model::stamp(ts_ms, now_ms)       // 「MM/DD HH:mm」，往年加「YYYY/」，按这台设备的时区

// 测试和截图直接驱动
dialog.select(point_id, cx); dialog.ask_restore(point_id, cx); dialog.restore(point_id, cx);
```

截图：`cargo run -p dr-shell --features capture --example history-capture -- ../docs/rust-rewrite/modules`（在 `next/` 下跑，要先建好字体，见 F5）。书是 dr-testkit 的《慢钟》，第一章三天里加了几行字、改了一次名，造出几个历史点。

## 改动的文件

```text
next/crates/dr-view-history/               新 crate：对话框（dialog.rs）、不依赖 GPUI 的部分（model.rs）、截图例子
next/crates/dr-shell/Cargo.toml            加依赖一行
next/crates/dr-shell/src/workspace/mod.rs  一个字段、初始化、渲染各一处
next/crates/dr-shell/src/workspace/corner.rs  ⋯ 菜单加「历史快照…」，加 open_history
next/crates/dr-i18n/keys.txt               snapshotHistory 用到的 8 个键和 kind.*、rightSidebar.stats.snapshotButton、common.wordsCount
next/crates/dr-i18n/locales/*.json         sync-locales.py 生成
```

## 待协调

- **F5（dr-ui）**：界面文字（GPUI 自己的换行）不避头尾，摘录里「，」会落到行首（截图里能看到）。稿纸正文走 prose-linebreak 没有这个问题；要不要给界面文字也接上避头尾，由 F5 定。
- **F6（dr-shell）**：要素、故事线、分类、素材的 ⋯ 菜单做出来时，各加一项「历史快照…」，调 `open_history`。
- **M07 / M20（统计）**：已加。统计标签最底下的「历史快照…」调 `open_history`（章节、构想、故事线、要素、类目、笔记素材都有；旧版的悬停提示没有搬）。见 [m20-stats.md](m20-stats.md)。
- **M27–M34（帮手）**：旧版恢复后会清掉这一页「帮手刚改过」的标记和活动点；墨色显现做好以后，在 `HistoryEvent::Restored` 时清。

## 没做的

- 旧版恢复素材笔记时会核对笔记里的任务行和待办（M19 的事）。
- 新建一章时，存储层给正文打第一个点的那一刻书目里还没有这一章（写入顺序是先正文后书目），那个点没有「当时的标题」，列表里就空着标题。
- 性能没测：`history.points` 要载两份副本、逐个检出，heavy 种子上的耗时等机器空闲时量。


## v3 完整条目快照安全阶段正式交回（2026-11-10）

**做了什么：**本轮交回当前 v3 模块、正文和元数据的完整快照安全阶段。v3 使用书内
不可覆写的 `entry_checkpoints` 清单，格式 1 带校验和、
内容指纹、书 frontier 和全部登记正文 frontier；与冻结的 v2.2 prose 历史分开。
读取和恢复都校验书、条目、清单和所有历史版本；恢复强制使用 preview 返回的
`expected`，在保留全部 holder 时重验所有版本，并在 SQLite 提交内复核完整正文
登记清单和所属书。正文、书目和 before 点一起成功或一起回滚。原始元数据和记录
用按条目限定的 CRDT 差异恢复，正文整份回到历史状态；其他条目、共享模板和时间线
视图不回滚。共享模板的历史定义只供预览。每个 `BodyPreview` 同时返回纯文本和 `raw_state`，
覆盖隐藏正文根及所有富文本属性，界面也保留这份原始预览。新正文的旧状态为空，before 点保留其
恢复前实际内容；对象撤销／重做也消费同一有守卫恢复命令。即使本机 journal 写入
失败，before 点仍可在重开后实际恢复。书和正文落盘前还比较完整类型化原始值；
无法保真恢复的容器使整批报错，不能靠改节点 id 或丢未来字段取得表面成功。

供 K6 在本安全阶段与显式目录排除同批正式合入后消费的公共调用是
`Workspace::run::<commands::v3::snapshots::Create>(&actor, EntryIn { book, entry })`，
等价的 JSON 命令为 `entry_snapshot.create {book, entry}`，返回 `Outcome<Point>`。
Actor 可以是 `Actor::agent(session, turn, call)`；在每轮首次写某条目之前等待成功，
失败就停止该条目的写入。可用 `Workspace::call_guarded` 带书和所有已物化正文的
观察版本：所有 guard 在同一 reservation 内先验；缺省正文和未物化登记行只在同一
提交中初始化；如果调用方显式观察了只读模板正文，复制缺省正文前也校验该模板
版本。未提供模板 guard 时，读取已被 reservation 固定的当前模板正文。正文登记
来自库的完整清单，不能只列当前模板的可见模块。Create 自己
会追加书内清单，因此 `Point.book_version` 是打点前的历史版本，不能充作下一次
Agent 写入的当前书 guard；Create 成功后重新读取写入所需观察版本。这里不改 K6
的工具或写入代码。恢复只允许作者，JSON 为
`entry_snapshot.restore {book, entry, point, expected}`；`expected` 原样来自
`entry_snapshot.preview {book, entry, point}`，冲突后重新预览和确认，不自动重试。
新登记但尚未初始化的当前正文会明确拒绝预览／恢复，请先保存一份当前完整快照，
不能由只读预览悄悄初始化正文。

**检查结果：**永久测试已覆盖多正文、隐藏／未来字段、真实容器类型与富文本标记、
隐藏关系／归属、后来增加正文、并发恢复、陈旧书／正文版本、跨书和损坏清单、
书／正文 staging 故障、SQL 后段失败、重开一致、journal 故障后的 before 恢复及
自动点保留。对话框测试验证预览不恢复、再次确认、失败保留原文／预览、显式新预览
再提交、模态焦点与 busy 时拒绝关闭。原稿纸／统计历史入口在 v3 下使用同一完整
条目对话框，旧单正文恢复方法不能绕过它；关闭后回到原输入。副屏隔离 profile 的
真窗口 `entry-snapshot.json` 为 72/72、0 pending，核对两正文确认恢复、before 找回、
原焦点继续输入和退出重开；机器证据为约定外部日志目录的
`g1-window-smoke-final/result.json` 与 `secondary-display.json`，首三轮失败原样保留。
最终源码检查为 fmt、workspace all-targets Clippy（-D warnings）、workspace test
2198／0 失败／22 忽略、xtask check（含 audit）、public:check 全通过，编译并发 3、
测试单线程；受检源码为 `a9ec87b026b7bc5fbb83c08d343569adfcd96b56`。
最终提交相对该源码只有模块／协调文档及 main `07fd3c15` 协调记录变化，`next/`
无差异；本轮沿用原日志，不新增或覆盖验收证据。细节见 G1 本轮安全阶段交回段。
原始树身份不能保真的形态只验了原子拒绝，
不能写成该形态恢复通过。registry 证据由
`INSTA_UPDATE=always cargo test -p dr-workspace --test registry --locked` 生成，
不手改生成证据；原有 Agent 目录快照另外由
`INSTA_UPDATE=always cargo test -p dr-agent-tools --test catalog --locked` 生成，
只增加五个注册命令的排除行，不改 K6 实现。旧 `entry-boundary.json` 继续是反例，不是本次正向验收。

**待协调：**G1／K1 继续处理引擎身份技术限制：Loro 1.17.1 的 apply_diff／
revert_to 会重建被删除的普通子容器／树节点身份，作者 node_ref 可悬空，公开 JSON
导入也不能任意复用旧创建 id。当前实现先在 atomic staging 精确校验；无法保真就
在首次真实提交之前整批报错，书／多正文／before 点的当前值与版本及重开状态均
不变。这一安全拒绝经整合者独立只读复核确认，可作为本阶段正式交回边界，后续由
G1／K1 技术协调，不升级为需要作者决定的设计，不阻塞本轮 handback 前移。仍不
宣称所有未知表示可恢复，不放宽原值断言、不修改固定 Loro 依赖或吞掉错误。
本阶段交回不表示 G1 全部完成或 autopilot 终点达成。
周期和退出已有 F2/M09 的明确方案，本次沿用，未另造产品：周期最多每 15 分钟一次，关闭时补点，自动点按旧分层保留；显式 before 恢复点不修剪。
K6 在本次接口正式合入后接首次写入前打点；按 overnight 的新协调，新增 Spec
须与 K6 显式目录排除同批接收。`entry_snapshot.*` 是宿主公共调用，不直接作为
模型工具开放，本组不改 K6 实现。F6 的库替换若还同时 drain Agent／字段
写入，需要最后一个写入之后的统一 checkpoint 阶段；本次正常退出的最后扫描已
单独接线，但不声称库替换 after-drain 顺序已完成。before-release 快照失败阻止
正常释放；末次 before-quit 扫描的现有回调不能向宿主返回错误，失败只记日志，
最终可失败的 after-drain 阶段仍需 F6 接口。输入、保存、恢复、并发、跨书
等正确性照常检查；截图目检、heavy、性能预算和样式打磨全部暂缓，不计为通过。


### G1 保存排空续段（2026-11-10，正式交回）

**做了什么：**在 G1 自有 `dr-view-page::settlement` 登记当前库的已接受写入，接既有
`release::before_release`／`after_release`。释放同步冻结新写入，异步收集挂载输入的
最后草稿、合并已排队保存，并等待真实持久化和前台确认；只等 G1 自己的当前库任务，
不在 UI 线程 join。覆盖 typed fields、KV、patch 的保存／新增／删除、planner 的
文本／结构／尺寸及本机比例，以及正文／整书页头的 v3 标题和梗概。失败、冲突及
无效输入保留原草稿并拒绝释放，恢复后允许继续输入和显式重试；写入中或保存失败时 Esc 也保留待重试输入，不把已接受任务当作可取消的本地草稿。不会因 blur 清掉
草稿或拿刷新后的版本替旧草稿授权。字段保留原显示值基线，KV／patch 保留已有的
逐字段合并，网格采用完整原网格比较加 CAS，任何并发网格改动均保守拒绝自动覆盖。
所有任务捕获原库句柄，登记自身不持有库；旧库保存不能转投新库。复用既有九语言
错误／重试文案，没有新增翻译键或手改生成证据；v2.2 保存分支和旧客户端不变。

**检查结果：**新增永久回归使用真实 v3 Tiny、真实模块页面和控件、shell 的普通
库替换／退出流程。当前专项 17 项通过，含第一笔保存延迟期间继续输入、释放等待
合并后的最后一笔、期间 UI 任务继续、晚到输入被拒、持久化失败保留草稿、相同数量
并发变化不覆盖、无效日期、失败后显式重试、两库隔离及重开；页头另 5 项新增退出／
冲突／取消回归通过；保存确认后的取消不把陈旧页面资料再次反写进书。已有字段陈旧快照回归保持，修复保存确认后旧快照抹掉显示值的问题，
并补后来的外部值仍可刷新。F2 单文档 append 失败本来会保留未落盘操作等待原 origin
重试：故障回归精确比较整份 durable raw state，不把 live holder 读值误当落盘，也不
放宽任何作者值。首轮测试屏障／测试时钟问题、F6 v3_home 保留反例和全部失败日志
均保留；有效模块回归通过真实 v3 registry／导航挂载，不采用不可见 Home 假装挂载。
对源码 `70f4d77e90693335366c8651e85c72632cdd358a`，以并发 3、测试单线程完成
fmt、workspace all-targets locked Clippy（-D warnings）、workspace locked test
**2249 通过／0 失败／22 忽略**、xtask check（含 audit）和根 public，均通过。
审计为 0 vulnerabilities／12 notices；保留 19 stale／15 legacy 测量提示，未把它们
当成本轮性能验收。之后 Rust、Cargo 和锁文件未变，只调整冒烟脚本及交回文档。
`next/crates/dr-cli/scenarios/g1-before-release.json` 的新构建副屏隔离流程为
**89/89、0 pending**：四类真实输入、聚焦字段直接退出、close 点预览及重开读回；
机器结果在约定外部日志目录 `g1-before-release-smoke-6/result.json`。两次启动 PID
75640／75970 的 CG 全局收据均在副屏；同目录 `snapshot-data-and-display-check.json`
再精确核对最终快照里的字段、KV、补丁和网格四项值。`environment.ndjson` 保留输入
期间的 app.info／状态。前五轮记录均保留：第一轮命令缺 workspace、第二轮文案
标签错误、第三／四轮视口及滚动点错误，第五轮点击后没有输入焦点；活跃窗口／节点
坐标已核对，未冒称环境原样重跑。最终通过文字区点击、等帧及明确焦点／全选断言
完成。冒烟修订只涉及脚本，其间产品源码和数据断言未变。原 82fca0b4 的 2198／0／22 与 72/72 证据
另存，不冒充本段检查。没有截图目检、heavy 或样式／流畅度验收。

**待协调：**本段先交可独立接收的 before_release 写入排空，不表示 G1 全部完成或
切换终点达成。F6 可失败的 `after_drain` 与 mirror 最后扫描尚未收到正式 main 接口
通知；G1 的 `capture_on_close` 迁移、正常库替换最终 checkpoint、两处真实
`register_editor` 登记仍等正式接口后续接，不消费 WIP，不改 F6／G2／G4／K6。
另已向整合者报告 F6 `Workspace::let_go_of_library` 未释放 `v3_home`：真实两库替换
在写入排空后仍因旧 workspace clone 被持有而拒绝，精确复现见约定外部日志目录
`g1-drain-f6-blocker.md`。G1 的实际模块页回归使用 F6 已释放的 editors/modules 路径。
旧快照阶段的未知容器／树身份限制仍按 82 的首次真实提交前整批安全拒绝，后续归
G1／K1 技术协调。上述均不放进待作者；布局／样式、截图目检、heavy、性能和流畅度
仍明确暂缓，不计为通过。本段没有删除任何旧测试或变更既有公共接口行为。

### G1 编辑器、v3 链接与最终 checkpoint 接线（2026-11-10，正式阶段交回）

**做了什么：**消费正式 F6 编辑器登记 `3712d13f`、after_drain `8cfdd74e`、K1
链接 `a3676ea9`，并合入正式 G4 导入回滚 `39416a46` 和快照归档修复 `582b48c9`，
未消费活动 WIP。两个 G1 maker 登记 renderer 真正持有的 BodyModule／WholeBook
编辑器：加载时 None、重载后当前实例，同正文多标签保持独立，原标题焦点、G2 大纲、
滚动和草稿仍由 renderer 维护。正文与表格的版本化链接保留 Entry＋module／Material
及 block 范围，点击完成前复核来源库／书；OS 富剪贴采用带类型的原始 mark 编码，
保留 Binary、整数、浮点 bits、未知字段／kind。复制只读已显示镜像；粘贴／剪切在
holder 内校验原观察，坏格式、容器引用、过深或不支持的表示在写前明确拒绝并保留
输入。多格键入用本次已接受输入的精确 frontier 结算；选区观察只能由同一成功写入
的精确 frontier 确认推进，不能 fresh 读取后授权旧范围。冲突保留本方已接受输入与
对方值并反馈失败，正常替换仍一次撤销。保留 AutomaticHistory::finish 的
before_release，最终 capture_on_close 迁入 fallible 后台 after_drain：所有生产者
及 Markdown 排空后才捕获原库；失败阻止释放、保留真实页头输入并恢复服务／重试。
未改 F6／K1 既有 API 行为、G2／G4／K6 产品实现或旧客户端，没有删除旧测试。

**检查结果：**新增 14 项永久契约（剪贴／多格 8、真实挂载 4、生产生命周期 2）
覆盖原始 mark／范围外数据、保存与 Undo／Redo／重开、同正文双标签、真实全局查找、
选区批注、通览重载、换书拒旧导航、最后生产者之后的 close 点及作者恢复、存储失败
阻止替换且保留真实页头输入并重新允许编辑。固定 aa212 经真实 v3 material-note
GPUI 输入复现多格替换红色，保留 `g1-typed-over-red-1.log`；三项绿测同时保护正常
替换、输入前及输入后清理前的同数量并发，未降低原始值、焦点和一次撤销断言。
Registry 原测试／生成器 16 项通过，无手改生成证据。完整受检 Rust／Cargo 源码为
`93dcf93e47ac69b65b1482bc3ec75816cea5b86c`，jobs=3、测试单线程、
DR_UI_REQUIRE_FONTS=1、独立 target；fmt、workspace all-targets locked Clippy
（-D warnings）、完整 workspace locked test **2315 通过／0 失败／22 忽略**、
xtask check（含 audit）及根 public 全通过，机器清单 `g1-wiring-final-3.json`。
审计 972 locked crates、0 vulnerabilities／12 notices；19 stale／15 legacy 测量
提示保留，未算性能通过。随后仅修改场景与交回／协调文档，Rust／Cargo 与该源码
完全等价；最终另核场景解析契约、fmt、xtask（含 audit）、public 和 diff --check。
预构建 dr-cli 直调 `g1-wiring.json` 的新构建隔离副屏主流程 **53/53、0 pending**，
结果 `g1-wiring-smoke-9/result.json`；PID 65906／66011 的 CG 全局收据均在副屏，
合法 profile 为 g1-wiring-9。`snapshot-data-and-display-check.json` 精确核对 close
点标题、两份正文清单及第二正文全文；场景验证 OS 剪贴、查找、module 批注、首正文
页头原生全选输入、退出保存、带守卫恢复与重开读回。前轮全部保留并分类：第 1 轮
Cargo 锁前取消且无 App；第 2 轮 handled 响应数组，第 3／5／6 轮非首正文页头与
AX／debug 观测定位错误，第 7 轮多期望末尾换行，第 8 轮误用 entry/title 而非
metadata/title，均为脚本错误。第 4 轮被并行 workspace 构建覆盖为无 bridge 二进制，
有瞬时哈希／feature 证据，原场景只原样重跑一次；未将其他失败冒充环境。
首轮全套 `g1-wiring-final-1` 由整合者主动中断，不算通过；第 2 轮 fmt 失败后已修。
旧 905 的 2249／0／22、89/89 与 82 的安全阶段证据另存，不充当本段结果。

**待协调：**这是 G1 既定接线的正式阶段交回，不宣称 G1 全部完成或 autopilot 终点
达成。F6 的真实 Home 持库释放另有正式修复 `7d673090`，整合者已接收；本候选未追合，
含真实 Home 的两库替换最终组合由 F6／整合者验收，G1 不跨改或冒称已通过。G4 的
`582b48c9` 已在本候选完整测试内，不再等待其旧归档修复。G1／K1 后续技术能力仍包括
无法保真嵌套树的身份恢复；当前继续在首次真实提交前整批原子拒绝，原值、版本、
before 点及重开不变，不宣称任意未来表示受支持，不升级为待作者设计。富剪贴跨文档
整段替换／剪切明确拒绝并保留源输入；单文档多段落及单元格／网格路径已有契约。
K6 首次写前快照消费归 K6。布局、样式、截图目检、heavy、性能与流畅度明确暂缓，
不记为通过；没有改 progress.md、0.1 客户端或原 WIP。


### G1 普通通览跨章剪贴修复（2026-11-10）

**做了什么：**恢复真实 v3 BookEditor／Assist 的跨章 Cut 和应用内 Copy 后的跨章
Paste，保留各章只替换自己的选中范围、粘贴写入起点章及一次成组 Undo／Redo。
只新增 `DocHandle::atomic_user(handles, book_id, edit, installed)`、
`ProseSession::edit_atomic(sessions, edit)` 和 `ProseEditor::edit_group`；原单文档
签名、命令 atomic 的 Command-only 限制、旧编辑分支和 Loro pin 保持。
按 id 预留全部 holder，在任何副本写入前统一校验显示源原观察，再在副本转换。
新作者路径只接受已存在文本容器的编辑：直接使用带类型的 TextDelta／LoroValue，
核对完整值、raw 标记以及第二份独立副本的确定性操作字节；隐藏非文本写入、新容器
或无法保真重放均在 SQL 前拒绝。一次 SQLite 事务复核书归属并追加**重放实际生成的
操作**，随后在仍预留的 live holder 执行同一确定文本计划，核对操作字节／版本；
各 session 的既有 UndoManager 正常收到 Local user 事件，全部安装后才确认／公告。
不再用 Import＋补 checkpoint：Import 会把旧输入的 Undo 当远端变化变换，后补计数
无法撤回该变换；已移除本轮在途的弱 Undo 登记／人工 checkpoint。返回值中的文本位置
和原始值有效，staging 的操作 id／版本不是提交回执。编辑器成功后才记录各章组号、
Undo 和删除锚点；首章空片段用仅宿主的空组 marker 连接其余章，不制造正文写入或
消费旧步骤，后续 typing 另起一步。失败保留原值、选区、输入和焦点，显示既有九语
失败提示。Entry＋module＋block 和 Binary raw 沿用无损编码；未新增 v2.2 测试、
删除旧测试、改命令目录或其他负责方既有 API。

**检查结果：**首红 `af0c55c3` 的真实绘制／聚焦 Tiny BookEditor／Assist 路由中，
普通 Cut 和应用内普通 Copy→跨章 Paste 两项正文断言失败，外部无 metadata 对照
通过；`g1-cross-document-fix.red-1.*` 原件保留。章界空片段红
`boundary-red-1.*` 为 0／1，修 marker 后转绿。全套第一轮 f8cd 源 2376／0／22、
第二轮 d1ff 源 2378／0／22 及各自五门禁均通过；未被通知中断，但均早于后来发现的
旧输入 Undo 缺陷，不算最终通过。native-1 漏传 launch.book，在首次正文动作前失败，
属场景配置；native-2 在已正确加载书中，两次 Undo 的第二次未撤掉选区内较早的“新”，
属真实产品失败，不归因环境。原日志／瞬间 environment／CG 副屏证明均保留。
`old-typing-probe-1.*` 永久真实 GPUI 红同样 0／1，明确核焦点仍在、caret 仍首章，
排除仅窗口焦点解释。改为本地重放后 `g1-cross-document-undo-fix.green-2.*`：
10 项通览／session 回归及存储 atomic 11 项通过。保留普通操作、反向三章／整章、
bold／Entry＋module＋block＋Binary raw、范围外未知根、锚点、旧输入的两次 Undo／
Redo、较晚输入独立撤销、多 session、重开、同数量未见并发拒绝及第二份 SQL append
故障后原值／原版本／选区／重试断言；新增 Local 事件、SQL/live 完整操作字节相同和
隐藏非文本／新容器写前拒绝后 Undo／重开不变。早期测试编译与断言时机修正原件保留，
没有放宽原始值要求。最终源码 `aa403f52` 完成第三轮全套（fmt、Clippy、test **2380 通过／0 失败／22 忽略**、xtask、public，`g1-cross-document-fix.full-3.json`）及 74 步副屏主流程（74/74、0 pending，`g1-cross-document-fix.native-3/result.json`），正式指针 `handback/k4-g1` 已前移至 `aa403f52`；旧 ed6／full1／full2 不充当本次最终验收。

**待协调：**普通跨章路径必须按既定功能交回，不作为“未知格式”留待作者。
新增 User-only 原子文本接口的范围、staging 版本非提交回执和 Local 安装边界已明示；
原 F4c 各章成组撤销规则保持，没有另承诺失败时跨文档 Undo 的共同事务。无本应用
metadata 的外部纯文本仍走既有 F4c 路径并有对照契约。无法保真的剪贴表示可写前明确
拒绝；完整历史对无法保真嵌套树的已接首次真实提交前整批拒绝保持，后续技术能力归
G1／K1，不升级待作者设计。布局、视觉、heavy、性能和流畅度暂缓，不记为通过；
不宣称 G1 全部完成或 autopilot 终点。原作者树／WIP、progress.md、旧客户端不改。

### AutomaticHistory 定时周期与订前基线确定性修复（2026-11-12）

**根因：**与 F2 单文档 `history_label`（写入独立 SQLite 表、不推进 Loro `oplog_frontiers()`）不同，canonical v3 的完整条目快照（`entry_snapshot.capture`）将快照清单写入 `book:<id>` 文档的 `entry_checkpoints`，从而推进 `book:<id>` 的 `oplog_frontiers()`。此前 [`AutomaticHistory::start`](../../../next/crates/dr-view-history/src/automatic.rs) 存在两处时序问题：① 收到 `Message::Changed` 后未按 `dr_store::history::PERIODIC_INTERVAL_MS`（15 分钟）设置定时器，而是在后台线程立即对 `dirty` 调用 `capture(..., Periodic)`，首次无快照条目会当场向 `book:<id>` 提交写入；② 初始 `owners(&ws)` 在 `subscribe` 之后的后台线程里异步读取，若前台紧接 `start` 立刻执行 `entry.create` 或仅改动 `memberships`／`undo` 使 `changed.is_empty()`，旧回退分支 `dirty.extend(current.keys().cloned())` 会把整本书全部条目排入后台连续捕获，小概率与前台 `Book::load` 之后的受守卫写入（如 `dr-view-element-overview` 的 `drag_drop_onto_island_reuses_g2_prepare_drop_and_supports_undo`）撞上 `WritePreconditions` `stale observation`。

**做了什么：**
1. `AutomaticHistory::start` 在调用 `ws.library().subscribe(...)` **之前**同步记录各书 `loro_head` 的 `Frontiers`（轻量 SQLite 点查，不在 UI 线程重放 Loro 文档）；工作线程首次收到某书 `DocId::Book` 事件时用 `load_copy_at` 取订前版本建立精确基线，彻底移除 `changed.is_empty()` 全书标脏回退。
2. 工作线程引入 `PERIODIC_INTERVAL`（15 分钟，另供测试入口 `start_with_interval`）与 `recv_timeout` 截止时刻：`Message::Changed` 仅在内存中更新 `known`、`dirty` 与首次到期时间，绝不在前台交互当刻后台写 `book:<id>`；仅在周期到点时冲刷 `dirty`（失败项保留待下一轮），关库／换库经 `finish()` → `capture_on_close` 同步排空不变。
3. 新增两条确定性永久单测 `immediate_foreground_edits_enqueue_only_touched_entries_without_racing_book_head` 与 `periodic_cadence_captures_dirty_entries_after_interval_elapses`（通过工作线程 FIFO 通道栅栏核对，零重试、零放宽断言、零 `ignore`）。

### 自动快照点：一个条目变没变只看它自己，全书指纹一遍读完（2026-11-12）

起因是当天的老化实测（[spikes/history-aging.md](../spikes/history-aging.md) 的「顺带发现」第 1、2 条和文末「修复之后」）。

**做了什么（大白话）：**

1. **一个条目「变没变」，只看它自己拥有的东西。** 以前判断用的那份内容里有同级全部条目的有序列表，所以新建、删除、挪动一个条目，同级每个兄弟都算变了，各存一个自动快照点。现在判断只依赖四样：这个条目的元数据、它名下的记录、它的住处（父级）、它自己在同级里的位置。别的条目新建、删除、挪动，都不算它变了；它自己在同级里换顺序、换父级，算变了。
2. **「自己的位置」用的是树节点自己的位置键**（Loro 的 fractional index），不是「排第几」也不是「前一个是谁」：
   - 排第几、前一个是谁，都会跟着别的条目变；位置键只在这个条目自己被挪动时才换。
   - 唯一的例外是 Loro 自己的规则：两个兄弟的位置键相同（比如两台设备各自在同一层的末尾新建了一个条目）而又有条目要插到它们中间时，Loro 没有键可发，会给邻居重新发键。被重新发键的邻居自己的键确实变了，算变了一次。
   - 同一个条目 id 有两个树节点（两台设备各建了一个）时，元数据、父级、位置键都取读取方一直保留的那个节点（树 id 最小的），排序用的也正是它的键。树 id 本身不算进内容，所以另一台设备带着同样内容的节点同步过来，不算变。
3. **全书条目指纹一遍读完。** `AutomaticHistory` 每次涉及条目的书目变更之后要算全书每个条目的指纹；以前对每个条目各读一遍整本书（条目数的平方），现在一次遍历条目树和四个记录集合就算完。
4. **退出时的最后一遍只对有事可做的条目调命令。** `capture_on_close` 以前对库里每本书的每个条目各调一次 `entry_snapshot.capture`，而这个命令每调一次都要把整份书目文档复制一份来操作。现在先整本书比对一次（`entries_due_for_capture`），只对「命令会存点」的条目调命令。哪些条目会得到快照点不变：
   - 判断和命令用的是同一个内容指纹、同一份「最近一个有效快照点」；
   - 这个条目有登记了但还没内容的正文，或者按模板该有的正文还没建（命令会顺手建），照旧交给命令；
   - 书目和各篇正文从开着的持有者读，所以「上一次落盘失败、还留在内存里的修改」照旧算变了（命令会重试落盘，失败就挡住退出）；书目自己有没落盘的修改时，退回老办法逐个调命令。
5. **捕获命令自己也轻了。** `entry_snapshot.capture` / `create` 找「这个条目最近一个快照点」和修剪旧的自动点时，原来对书里每一个快照点都把全部快照点重读一遍，现在每份清单只读一次；命令里两处「读出全部条目再挑出这一个」改成只读这一个（标题和模板只看它自己）。行为不变，只是不再随书变大而成平方地变慢。
6. **恢复不受影响。** 恢复时把条目放回「相对仍然存在的历史邻居」的位置，兄弟顺序是从历史版本的书目里读的（`restore_book`），从来不靠指纹。预览里的 `raw_state` 仍然带 `siblings`，形状没变。
7. **以前存下的快照点照样能预览、恢复、导入。** 它们清单里的内容指纹是旧算法算的（带兄弟列表）。核对「历史内容与清单相符」时新旧两种指纹都认，所以已有的历史一个不丢；清单本身不改写。

**定下的事：**

| 事 | 怎么定的 | 理由 |
| --- | --- | --- |
| 位置怎么表示 | 保留节点的位置键 | 只有条目自己被挪动时才变；不引用别的条目 |
| `entry_owned_raw_state` | 不动，仍带 `siblings` | 预览界面、页头和字段的保存、导出的往返测试都在读它；恢复比对时本来就先去掉 `siblings` |
| 另加的读取 | `BookViewV3::entry_change_state`（一个条目）和 `entry_change_states`（全书一遍） | 只加不改；两者同一段实现，测试逐条对过 |
| 已有快照点里的旧指纹 | 校验时两种指纹都认，清单不改写 | 已有的库里每个快照点存的都是旧算法的指纹（内容里带兄弟列表）。预览、恢复和 `.driftingbook` 导入核对「历史内容与清单相符」时，先算现在的指纹，不等再算旧的，有一个等于清单里的 `content_hash` 就算相符，都不等才拒绝（`snapshots::checkpoint_history_matches`，三处共用；旧算法留作只用于这项校验的私有函数）。清单格式（`format: 1`、字段、校验和）没有动 |
| 旧指纹的点和捕获 | 捕获时只比现在的指纹 | 最近一个点是旧指纹的条目，下一次自动捕获多存一个新点，之后照新规则走；不为省这一次去给每个条目算旧指纹（那又是平方）。导入时改写后的点一律写现在的指纹 |
| 旧版本的构建 | 不认新指纹的点 | 两台设备版本不一致时，旧的那台预览、恢复不了新的那台存的点（它只会算旧指纹）。这是有意接受的 |

**接口：**

```rust
// dr-doc
view.entry_change_state(&entry)   // Option<Value>：metadata、records、parent、position
view.entry_change_states()        // Vec<(EntryId, Value)>，按树的顺序，一次遍历
// dr-workspace（宿主调用，不是命令，不进 Agent 工具目录）
snapshots::entries_due_for_capture(&ws, book)  // 这本书里自动捕获有事可做的条目
snapshots::checkpoint_history_matches(&docs, &target, &content_hash)  // 历史内容与清单相符吗（新旧两种指纹都认）
snapshots::checkpoint_history_fingerprint(&docs, &target)             // 现在存的那种指纹（导入改写后的点用它）
```

**检查结果：**修复前后的数字在 [spikes/history-aging.md 的「修复之后」](../spikes/history-aging.md#修复之后2026-11-12)（高负载下量的，只看数量级和同一轮里的比例）。永久测试：

- `dr-doc`（`v3/tests.rs`）：全书一遍和逐条目读出的一致，且等于「`entry_owned_raw_state` 去掉 `siblings`、加上位置键」；兄弟新建、挪动、进回收站、搬走、删除（含子条目上提）都不改变一个条目的内容，它自己换顺序、换父级、改内容、改名下记录会变；两台设备各建一个节点时两边读到的一样，相遇前后都不变；两个兄弟位置键相同、第三个插到中间时，被 Loro 重新发键的邻居只有位置变了，再远的条目不变。
- `dr-workspace`（`snapshots.rs` 里的单测）：兄弟新建、挪动、进回收站、搬走、被直接删掉节点以后，对没动过的条目再捕获，返回的还是原来那个点；条目自己换顺序、换父级各得一个新点；恢复把条目放回历史邻居之间（前一个历史邻居还在就排在它后面，不在了就排在后一个历史邻居前面，从别的父级恢复时回到原来的父级和位置）。恢复这一条在改之前的指纹算法下同样通过。旧指纹：把一个点照旧算法改存（指纹用保留的旧函数算、连同校验和写进清单）以后，它的预览和现在存的点逐项相同，恢复出来的结果也相同；内容指纹两种都对不上的点仍然在写入之前被拒绝；最近一个点是旧指纹的条目，没变时下一次 close 捕获恰好多一个点，再下一次不再多，旧的那个点仍然能预览。
- `dr-export`（`tests/book_file_v3_snapshots.rs`）：带旧指纹点的 `.driftingbook` 能导入，导入后的点能预览、内容和源库里的一样，并且带的是现在的指纹（没变的条目再捕获不多存）。这条测试里的旧指纹是照旧算法用公开的读取接口另算的，不经过保留的那个私有函数。原有的「内容指纹被清空的清单在导入写入之前被拒绝」那条断言没有动，照旧通过。
- `dr-view-history`（`automatic.rs`）：兄弟新建、挪动、进回收站、恢复以后，工作线程的脏集合里只有那个兄弟，退出时别的条目一个点都不多；条目自己换顺序、换父级，脏集合里只有它，退出时只有它多一个 close 点；最后一遍跳过的条目和「逐个调命令会原样返回最近一个点」的条目完全一致（改标题、改正文、新建、挪动、模板加一个正文模块各验一次）；持有者没能落盘的正文在退出时照旧算变了，落盘失败照旧挡住退出。
- `dr-testkit`（`tests/aging.rs`）：在小种子的书目和它老化 40 天以后的书目上，全书一遍和逐条目读出的逐条一致；老化步骤照新规则走（兄弟不得快照点，新建和被挪的条目自己得），开关 `sibling_checkpoints` 重现旧规则，两种走法其余提交一条不差。
- 一次性的核对（不是永久测试）：用修之前的构建（提交 `843b7ed4f`）在小种子上真的存出来的两个快照点，拿现在的代码打开那份库，两个点都能预览，改名以后能恢复回去，没变的条目再捕获恰好多一个点。说明保留的旧算法和当时的实现逐字节一致。
- 有意改了期望的既有测试只有一条：`immediate_foreground_edits_enqueue_only_touched_entries_without_racing_book_head` 原来断言「在顶层新建一个章节后，所有顶层条目都变脏」，现在断言只有新建的和被编辑的条目变脏。另外 `book-aging` 钉住的小种子形状跟着老化步骤变了（30 天里快照点 328 → 256，被连带的 93 → 0，其余种类的提交数一个没变）。

**待协调：**

- 退出时的最后一遍，每个「有事可做」的条目仍然是一次命令（重型种子上约 11 毫秒：`dr-store` 的原子写入先给书目和这个条目的每篇正文各复制一份，命令再读、比、存清单）。每个条目都还没有快照点的第一次退出因此仍要几秒（633 个条目 6.8 秒），数字见「修复之后」。要再快得让一次原子写入覆盖多个条目，那要动命令的形状（多一个命令就要进 Agent 工具目录的排除表）或 `dr-store`，不在这一轮。
- 周期捕获（15 分钟一次）对每个脏条目同样各付一次命令；兄弟连带去掉以后脏条目只剩真正动过的那几个。
- 最后一遍为了读到「持有者还没落盘的修改」，会把这本书每篇有快照点的正文的持有者打开读一下版本再关上（和原来每个条目调命令时做的一样，只是不再复制）。`dr-store` 要是能不开持有者就问出「这篇文档现在开着没有、内存里的版本是多少」，这一步可以省掉。

## 清单挪出书目文档（2026-11-13，[kernel-v4.md](../kernel-v4.md) §8，T6）

- 快照点清单不再写进 `book:<id>` 的 `entry_checkpoints`，改在这本书的 `checkpoints:<书>` 文档里（根映射同名，清单格式、校验和、内容指纹都不变）。存点、修剪只写它；恢复的「恢复前那个点」也写它。上面几节说「书内清单」「写入 `book:<id>` 推进它的版本」的地方，都换成这篇文档：存点不再推进书目的版本，也不再发书目事件，而是发自己的 `WsEvent::Checkpoints`。
- **打开着的历史对话框自动刷新（T6）。** `EntryHistoryDialog`（`dr-view-history/src/v3.rs`）订阅当前书的 `WsEvent::Checkpoints`，按 `checkpoints:<书>` 的 `seq` 合并连续通知、在后台任务空闲时重读列表：对话框开着时外部（自动周期捕获、Agent 动手前打点、另一处入口）存了新点或修剪了旧的自动点，列表自己刷新；当前展开预览的那个点如果还在就保留预览，如果被修剪掉了就清掉选中和预览。`writing_day.record`（`WsEvent::Stats`）和别的书的快照事件不会唤醒它（`dr-view-history/src/v3_tests.rs`）。
- 原子性不变：存点和恢复仍是一个原子事务，预留「书目 + 这个条目的全部正文 + 清单文档」，清单文档建书时就建好。书目只读（读版本和条目状态算指纹）。回执和预览的 `expected` 只含书目和正文。恢复时在预留的拷贝上再确认一次要恢复的点还在、清单没变。
- 上面第 7 条「旧指纹两种都认」删掉了：新格式的库里没有旧指纹的点（v3 的书原样拒开，开发库从 0.1 重新导入，0.1 不产生条目快照点），`checkpoint_history_matches` 只认现在的指纹，两条只为旧指纹存在的测试也删了。

## 内核 v4 收尾（2026-11-13）

快照预览里每篇正文只按模块名显示一遍，不再另以 `body:<条目>/<模块>` 加原始 JSON 再显示一遍（`preview_sections`，测试 `v3_tests.rs` 的 `preview_shows_each_body_once_by_its_module_name`）。

## 升到 Loro 1.18.0 核对（2026-11-19）

升到 `loro = "=1.18.0"` 后核对：被删掉再通过 `apply_diff` 恢复的普通（非 mergeable）子容器与嵌套 `LoroTree`，按上游契约（#1187）仍会生成新的容器和节点身份，因此 `dr-doc`（`restore_shared_records_at`）与 `dr-workspace`（`snapshots.rs`）在首次提交前整批原子拒绝的保护原样保留；PR #1217 保留完整追踪器的优化同样惠及完整历史文档上的重复 `checkout`。

## 导入后第一次退出：一批一次写入，后台先补第一个点（2026-11-21）

**起因（大白话）：** 库刚导入（或刚建好、刚同步下来一本书）时，没有一个条目有自动快照点。退出时的最后一遍（`capture_on_close`）要给每个条目存第一个点，以前是每个条目一次 `entry_snapshot.capture`：每次都把整份书目和整份清单文档复制一份，再把全书的条目从头走三遍找这一个。重型种子（现在 698 个条目）一次退出要 6 秒，负载高时 18 到 26 秒。退出流程在「先存好再藏窗口」这一步不设时限：窗口一直在屏幕上，盖着一层看不见的挡板（`release::input::curtain`），不响应输入，存完才藏起来退出。东西不会丢（每个点各自是原子的；强制退出时已存的留着，剩下的下次退出照样补），但作者在新程序里的第一次退出看起来就是卡死了。

**量了什么**（release，M3 Pro 12 核；那一夜机器上有别的编译，负载写在表头；毫秒数看量级和同一轮里的比例）：

| 重型种子写进新库、一个快照点都没有（负载 18→10） | 改之前 | **改之后** |
| --- | ---: | ---: |
| 第一次 `capture_on_close`（698 个条目都存第一个点） | 6,003 ms | **242 ms** |
| 　其中的写入次数（`checkpoints:` 的提交） | 698 | **11** |
| 外壳真正走的第一次退出：`AutomaticHistory::finish`，再加排空以后那一遍 | 约 6.1 s（上一行加一遍空扫，推算） | **401 ms**（281 + 120） |
| 以后每次退出（没有要存的），两遍空扫 | 约 0.2 s | 230 ms（122 + 108），没变 |
| 后台补完第一个点以后的第一次退出 | 不适用 | **212 ms**，和以后每次一样 |

改之前时间花在哪（改之前的构建用 `sample` 采样；每个条目平均约 9 ms）：

1. **复制**：原子写入先给书目、清单文档和这个条目的每篇正文各复制一份（持有者线程上导出快照再导入）。书目和清单每个条目都复制一次，清单还越存越大。
2. **把全书走三遍找一个条目**：命令在预留前读一次条目（`entry_raw`），存点时再读一次标题，算内容指纹时再读一次（`entry_change_state`）；每一次都要把整棵条目树的每个节点读一遍，所以合起来是条目数的平方，约占主线程三分之一。
3. 每个条目一次文档清单查询、一次 SQLite 事务、一次持有者安装和广播。

正文的复制和校验本来就是每篇一次，批量以后也不变（一批里每个条目约 0.2 ms）。

**改了什么：**

1. **一次原子写入带多个条目**（`dr-workspace` 的 `snapshots::CapturePlan::capture`；宿主调用，不是注册命令，不进 Agent 工具目录，不记日志）。书目、清单文档、这一批每个条目的每篇正文（和要复制的模板正文）一起预留；清单只读一遍；每个条目的点、修剪和缺的默认正文都在同一个 SQLite 事务里，要么都存上，要么一个都没有。`dr-store` 为此加了 `DocHandle::atomic_scoped_many`：同一本书的几个范围（每个条目一个 `body:<条目>/`），每个范围照旧核对「这个前缀下的文档都预留了、都属于这本书」；`atomic_scoped` 就是只有一个范围的情形，行为不变。
2. **全书只读一遍**（`CapturePlan::read`）：书目的版本，每个条目（定它有哪些正文、取标题）和它的变化状态，模板，一次读完。书目版本不变就一直用，变了先重读；预留以后再核对一次版本，对不上就整批拒绝（`Conflict`，什么都不存），和命令一样。
3. **退出时的最后一遍**：仍然先整本书比对一次（`entries_due_for_capture`），再 64 个条目一批（`CAPTURE_BATCH`）写。698 个条目是 11 次写入。
4. **后台先补第一个点**（`AutomaticHistory` 的工作线程）：启动 30 秒后（`FIRST_POINTS_DELAY`），列出每本书里还没有快照点的条目（`snapshots::entries_without_checkpoint`），8 个一批（`BACKGROUND_BATCH`）写，两批之间隔 50 ms；作者在打字（`Origin::User` 的提交）时，下一批至少再等 2 秒。失败的一批 5 秒后重试，共三次，还不行就留给周期捕获和退出。退出时还没补到的，最后一遍照样补（它们仍然「有事可做」）。这些点的 `reason` 是 `periodic`：开着书时自动存的，和周期点一样参与修剪；界面不显示种类。
5. **周期捕获**（15 分钟一次）也按书分批，8 个一批；失败的一批留在脏集合里下一轮再来，和原来逐个失败时一样。

**为什么点还是原来的点：**

- 每个条目存的清单和命令逐字段相同：书目版本、每篇正文的版本、标题、内容指纹（同一个 `fingerprint`；变化状态取自 `entry_change_states`，前面一节已测过它和逐条目的 `entry_change_state` 一致）、格式和校验和。命令的规矩照搬：最近一个点内容相同就不存；周期捕获在最近一个点不到 15 分钟、又没有缺的正文时不存；修剪用同一个 `thinning_plan`（抽成 `thin`，命令和批量共用）；书里没有的条目跳过，和以前退出时跳过命令的「没找到」一样。
- 预览、恢复不经过这些代码，照旧从历史版本读；批量存的点能预览、能恢复（测试）。
- 原子：一批要么全存，要么全不存。崩溃、强制退出、SQL 写失败都不会留下半个点，也不会留下登记了却没内容的正文；没存上的条目下次还是「没有快照点」或「有事可做」，后台或退出会补上（测试）。退出时一批失败照旧挡住退出并报错，前面写好的批留着。

**改之后的数字**（同一轮，负载 16→10）：

| 项 | 数 |
| --- | ---: |
| 全书读一遍（plan） | 17 ms |
| 一次写入，8 个条目（后台用的大小，88 次） | p50 5.0 ms，p95 6.4 ms，最长 42 ms |
| 一次写入，64 个条目（退出用的大小，11 次） | p50 18 ms，p95 54 ms |
| 后台补完 698 个条目（作者没在打字） | 5.6 s（88 次写入，大半是两批之间的 50 ms） |
| 按键到提交（gpui-prose 文字层经 `SessionSource` 写进最长那一章），没有后台 | p50 0.18 ms，p95 0.41 ms，最长 1.1 ms |
| 同上，后台补点、而且故意不让路（打字时照写） | p50 0.16 ms，p95 0.40 ms，最长 5.0 ms |
| `Book::load`，没有后台 / 后台补点不让路 | p50 26.5 / 26.4 ms，p95 48 / 33 ms |

后台补点不让路时，打字的中位数和 p95 不变；最长的一下多了约 4 ms，是那一下正好碰上写入在预留这一章（一次写入 5 ms 左右）。平时作者打字时后台不写（让 2 秒），碰不上。开书（`Book::load`）没有变慢。按键量的是存储一侧的提交，不含排版和上屏。

改到一半时量过一轮（负载 15→10，写入里还在读全书）：第一次退出 646 ms，一次写入 8 个条目 27 ms，其中 14 ms 是在预留期间把全书的变化状态算一遍。把全书的读取挪到写入之外、读一次反复用以后，降到上表。

**接口（只加不改）：**

```rust
// dr-store
DocHandle::atomic_scoped_many(&handles, Origin::Command, &scopes, &new_documents, |docs| …)
// dr-workspace（宿主调用，不是命令）
snapshots::CapturePlan::read(&ws, book)?          // 全书读一次
plan.capture(&ws, &entries, CaptureReason::Close) // 一次原子写入，BTreeMap<条目, Point>
snapshots::capture_entries(&ws, book, &entries, reason) // 自带一次 plan
snapshots::entries_without_checkpoint(&ws, book)  // 还没有快照点的条目，树的顺序
snapshots::CAPTURE_BATCH                           // 64
// dr-view-history
AutomaticHistory::start_with(ws, Cadence { interval, first_points, gap, quiet })
// start / start_with_interval 照旧；后台补点用默认的 30 秒
```

**检查结果**（永久测试）：

- `dr-store`（`tests/atomic.rs`）：几个范围一起提交；第二个范围下有没预留的文档时整笔拒绝、什么都不写；新文档不在任何范围下时拒绝；两本书的范围、空范围拒绝。
- `dr-workspace`（`snapshots.rs` 单测）：一批存的点和命令逐字段相同、预览相同，命令随后认为没事可做，点能恢复，章节缺的第二篇正文在同一次写入里建好；没变的条目两种原因都不多存，周期捕获在 15 分钟内不存（和命令对过），关闭时只给变了的存，书里没有的条目跳过，plan 在书目变了以后自己重读；修剪和命令一样（一个条目用命令、一个用批量，各删掉同一小时里较早的那个）；批量在存了第一个清单以后、或建了第一篇正文以后出错，清单一个不留、正文一篇不登记，重开库也一样，再来一次全部存上。
- `dr-view-history`（`automatic.rs`）：第一次退出给每个条目一个 close 点，`checkpoints:` 的提交数等于条目数除以 64 向上取整（小种子 28 个条目：1 次；临时改回每个条目一次写入时这条测试失败，28 对 1），再退出一个提交都没有；两份相同种子的库，一份批量、一份逐个调命令，文档集合相同，每个条目一个点，点里的内容逐项相同；后台补点一步 8 个，步数是条目数除以 8 向上取整，补完以后每个点就是命令此刻会给的点，退出不再写；补到一半，下一批 SQL 写失败、进程不做最后一遍就没了（模拟崩溃），重开库后前一批的点完整、能预览，失败那批没有登记任何正文，剩下的下次补上、前面的点不变，补的点能恢复；打字把下一批推到至少 quiet 之后（测试里放大到 2 小时），命令写入不推；按定时自己跑完、停下。原有的十条测试没改，照旧通过。

**怎么复现：** `cd next && cargo run --release -p history-aging-spike -- close quit`（`close` 是 11-12 那张表；`quit` 是这一节：外壳的退出顺序、两种批大小、带打字和 `Book::load` 的后台补点）。只打到屏幕，不写证据。

**没做的、没验的：**

- **没试过真实导入的库。** 量的是种子直接写进新库（和导入后「一个点都没有」的状态相同）；0.1 导入器写正文的方式（比如登记了还没内容的正文多不多）可能让批量多建几篇默认正文，没核对。**Windows 没量。**
- **导入时就把第一个点存好**，这一轮没做（`dr-import-v1` 当晚另有人在改）。要做的话：导入写完、`dr-view-import` 的 `flow.rs` 为重建索引开的那个 `Workspace` 还开着时，对每本书 `CapturePlan::read`，把 `entries_without_checkpoint` 按 `CAPTURE_BATCH` 分批 `plan.capture(&ws, batch, CaptureReason::Close)`，再 `try_shutdown`；失败只记日志、不让导入失败（后台和退出会补）。重型书约 0.25 秒，算在导入进度里。有了后台补点，这一步只省下「导入完马上退出」那一次的补点。
- **以后每次退出仍是两遍空扫，约 0.2 秒**（`AutomaticHistory::finish` 一遍，排空以后一遍），大半是 `entries_due_for_capture` 为了读到「持有者里还没落盘的版本」把每篇有快照点的正文打开一次。上面「自动快照点：一个条目变没变只看它自己」一节的待协调已经记了：`dr-store` 能不开持有者就问出开着的文档的内存版本，这一步就能省掉。
- 后台补点的 30 秒、8 个一批、50 ms、2 秒是按上面的数定的，没在真窗口里数过帧。

## 导入的 0.1 快照历史（2026-11-21）

导入以前只把 0.1 的快照历史写成存储层的标签，条目的「快照历史」里看不到。现在每一行有正文版本的 0.1 历史，导入时写成一个条目快照点（[m10「0.1 的快照历史进条目的『快照历史』」](m10-import.md#01-的快照历史进条目的快照历史2026-11-21)）。对话框和三个命令都没改：

- 点的种类是 `import`（`entry_snapshot.create` 给导入者存的点就叫这个），不是自动点，不参加修剪，多旧都留着；界面照旧不显示种类。
- 时间是 0.1 那一行的时间，排在新版自己存的点下面。后台补第一个点不碰这些条目；退出时内容和最近一个 0.1 点一样，就不再多存。
- 恢复一个导入的点，带回这一行的正文和 0.1 当时记的字段；0.1 没记的东西就是导入时的样子。点里记的住处已经不在（要素在 0.1 里的旧分组，现在没有要素了）：原来在写之前拒绝；2026-11-24 起照下一节，要素留在现在住的地方，别的照常恢复。
- 新加一个公开函数 `snapshots::checked_checkpoint`：三个命令验清单用的那套规则，导入核对自己写的点时用。

## 恢复时原来住的地方没了：留在现在的地方（2026-11-24，SR）

**依据**：作者 2026-11-23「都按推荐」，推荐是「原来的位置没了就留在现在的位置」，对所有快照点都这样，不只是从 0.1 导入的（[progress.md](../progress.md)「等作者的事」第 16 条，任务书 [handoff/resume-1123.md](../handoff/resume-1123.md) 的 SR）。

**做了什么（大白话）：**

- 快照点记着条目当时住在哪个条目下面。恢复时那个条目已经不能放它了：被删了（在最近删除里，或者已经永久删除，或者像导入的 0.1 分组那样书里本来就没有了），或者它的「层级」关了。以前恢复在动手之前整个拒绝，对话框显示「恢复失败」。现在照常恢复：正文、标题、字段、名下的记录都回到那个点，条目留在它现在住的地方、现在的先后位置，树上的节点一动不动。
- 恢复仍是一条原子命令，恢复前照旧先存一个「恢复前」的点，一步能撤。撤销就是恢复那个点：条目本来就在现在的地方，撤销以后还在原处、原位置。
- 原来住的地方还在、还能放条目时照旧：搬回去，排在仍然在的历史邻居旁边（上面「一个条目变没变只看它自己」一节第 6 条）。
- 预览照常；界面没改：对话框只在失败时显示原因，这种情况不再失败。命令的入参、出参和摘要都没变。
- 代码：`dr-workspace/src/commands/v3/snapshots.rs` 的 `restore_book`。`dr-doc` 没改：`restore_entry_owned_at` 本来就只写元数据和名下记录，不碰树。

**还会拒绝的**（都在第一次真正写入之前，什么都不改）：

| 情况 | 报什么 | 在哪 |
| --- | --- | --- |
| 不是作者在恢复（Agent、MCP、导入） | `entry snapshot restoration is an author operation` | `Restore` |
| 点找不到；清单坏了、不是这个条目的、带着别的条目的正文 | 找不到 / `checkpoint format or owner mismatch` / `foreign body` | `point`、`checked_point` |
| 点记的文档找不到、属于别的书；历史内容和清单的指纹对不上 | 找不到 / `belongs to another book` / `does not match its manifest` | `load_point` |
| 条目有登记了还没内容的正文 | `uninitialized body documents` | `initialized_handles` |
| 预览以后书或正文变了，或调用方的守卫不符；预览以后点被修剪或改了 | `entry changed since preview` / `checkpoint was removed or changed since preview` | `Restore` |
| 点里的正文文档现在没了；正文的历史没法不换容器身份地还原；后来加的正文清不空 | `checkpoint body is missing` / `body history cannot be restored …` / `later body cannot be cleared …` | `Restore` |
| 点里没有这个条目；条目已经永久删除 | 找不到 | `restore_book` |
| **条目现在在最近删除里，点是它进去以前的**（恢复会让它回来），而原来住的地方和现在住的地方都放不了它（比如和住处一起进了最近删除） | `V3-LEAF-NO-CHILDREN … does not exist or is trashed`（或 `switch off`） | `restore_book`（`check_parent_is_level`） |
| 点里这个条目的「层级」关着，而现在它下面住着活的条目 | `restoration would leave entries under an entry whose switch is off` | `restore_book` |
| 点里它名下的记录现在属于别的条目 | `record now belongs to another entry` | `restore_book` |
| 恢复以后它的名字或别名和别的自动链接条目撞了 | `V3-AUTOLINK-NAME-UNIQUE` | `restore_book`（`changes_ok`） |
| 元数据或名下记录没法不换容器身份地还原（含不认识的 CRDT 容器） | `entry history cannot be restored …` / `unsupported CRDT container` | `restore_book`、`dr-doc` 的 `restore_entry_owned_at` |

加粗的一行和「住在哪」有关：是「留在现在的地方」也站不住的那一种，照旧拒绝（任务书没说到，按最保守的做法；作者 2026-11-24 答「都按照你的推荐来。」，推荐是照旧拒绝）。原来住的地方还在、但现在住在这个条目下面（搬回去会成环）的，原来也在这张表里，2026-11-24 起不再拒绝，见下一节。照 kernel-v5 第 16 节，最近删除里的条目不能点开、悬停卡上只有「恢复」「永久删除」，平常从界面走不到这一行（没在真窗口里核对过）。

**挂在哪（这一轮没改，查清的；已永久删除的那一种 2026-11-24 改了，见下一节）**：恢复把点里这个条目名下的挂名记录（它挂在别处的、别处挂在它上面的）和主归属原样写回，不看挂的目标现在怎样，也不因此拒绝。目标现在：

- 在最近删除里：记录写回，读作没挂（`membership.list` 不列）；目标恢复以后又挂上。
- 关了「收别处的条目」：记录写回，读作没挂；再打开又挂上。
- 已经永久删除：记录写回，指着一个书里没有的条目，永远读作没挂。`entry.purge` 去掉的这一行因此回到书里，不会再自己消失。`entry.get` 的 `primary` 是存着的值，会显示那个 id；挂名的查询都会滤掉。
- 还在、还收：挂回去（点以后摘掉的名，恢复会挂回来）。

视图里的位置（刻度）是书的，不属于条目，恢复不动它。以上是用一个临时探针在合成库上查的，没进仓库。要不要改是作者的事。

**测试：**

- `dr-workspace`（`snapshots.rs` 的单测）：`restore_leaves_an_entry_where_it_lives_when_its_place_then_is_deleted`：章在一个分组里时存点，之后改了字、挪到书稿开头，分组进最近删除、再永久删除，两种情况各恢复一次：标题、梗概、正文回到点里的，住处和先后位置是恢复前的，一步撤销回到恢复前。`…_when_its_place_then_holds_no_entries`：同样，分组的「层级」关了；分组的开关不跟着恢复。`restore_still_refuses_a_cycle_or_a_life_where_nothing_can_hold_the_entry`：上表加粗的两种照旧拒绝，书目和清单文档的版本都不变（2026-11-24 成环的那一半挪进下一节的新测试，这一条改名 `restore_still_refuses_a_life_where_nothing_can_hold_the_entry`）。前两条在改之前的代码上失败，第三条改前改后都过。
- `dr-import-v1`（`tests/history_checkpoints.rs`）：`restoring_a_point_whose_0_1_group_is_gone_keeps_the_element_where_it_lives`：导入的要素旧点（0.1 分组「未庄」已经没有了）能恢复：正文、名字、别名、梗概、事实回到那一行，住处和同级的先后不变，多一个「恢复前」的点，一步撤销回到恢复前。原来 `restoring_an_imported_point_brings_back_its_prose_and_fields_and_keeps_the_state_before` 末尾断言「拒绝、什么都没改」的那一段删掉，由这一条代替。

**真窗口**：`crates/dr-cli/scenarios/import-history.json` 在章的恢复后面加了导入要素的那一种（0.1 分组已经没有了）：从悬停卡打开快照历史、预览、确认恢复，对话框显示恢复成功，字和字段是那一行的，住处不变。副屏、合成 profile，76 步全过（见 [m10 的「真窗口」](m10-import.md#真窗口)）。

## 恢复时成环也留在原地；挂着的目标已经永久删除时跳过（2026-11-24，S2）

**依据**：SR 交回时留下的两件事（[progress.md](../progress.md)「等作者的事」第 21 条 SR (a)(b)），作者 2026-11-24 答「都按照你的推荐来。」（任务书 [handoff/resume-1123.md](../handoff/resume-1123.md) 的 S2 第 5 处）。

**做了什么（大白话）：**

- **成环也留在原地。** 点里记的住处还在、还能放条目，但它现在住在这个条目下面（比如「上卷」当时住在「下卷」里，后来把「下卷」挪进了「上卷」）：搬回去会让条目住到自己下面。以前整个恢复拒绝；现在和「原来住的地方没了」同一个规矩：正文、标题、字段、名下的记录回到那个点，条目留在现在住的地方、现在的先后位置，住在它下面的也都不动。恢复前照旧存一个点，一步能撤。
- **挂着的目标已经永久删除时跳过。** 点里记着这个条目挂在哪些条目上、哪些条目挂在它上面（挂名记录），还有它的主归属。恢复时，另一端已经永久删除（或者这本书里本来就没有）的挂名记录不写回，主归属指着这样一个条目的也不写回：这两样都保持恢复前的样子（永久删除时它们已经被一起去掉了）。另一端在最近删除里、或者关了「收别处的条目」的，照旧写回（它们还能回来，回来以后又挂上）；另一端还在、还收的照旧挂回去。这样恢复以后书里不会有指着不存在条目的记录。
- 别的拒绝原因照旧（上一节的表）。界面没改；命令的入参、出参和摘要都没变。

**代码：**

- `dr-workspace/src/commands/v3/snapshots.rs` 的 `restore_book`：点里的住处现在放不了它（`check_parent_is_level`）**或者**搬回去会成环（`check_entry_move`）都算「留在原地」。在第一次写之前算出要跳过的：点里这个条目名下的挂名记录，按记录的键（`宿主|成员`）看两端，除它自己以外有一端不在现在的书里（最近删除里的还算在）的；条目 id 是不透明的字符串，所以只要键是 `宿主|成员` 的写法，另一端不管长什么样（比如测试里的 `missing-host`），书里没有就跳过；键不是这种写法的记录读不出两端，照旧原样写回；点里的主归属不在现在的书里时，主归属也跳过。写完以后比对「恢复后的原始状态和点里的一样」时，跳过的这几样按恢复前的值比。
- `dr-doc` 只加不改：`BookTxnV3::restore_entry_owned_at_except(id, old, keep, keep_primary)`，`keep` 里点名的名下记录（集合和键）两边的值都不碰，`keep_primary` 时元数据里的 `primary` 不碰；原来的 `restore_entry_owned_at` 等于什么都不跳过的它。

**测试**（除注明的以外是 `snapshots.rs` 的单测）：

- `restore_leaves_an_entry_where_it_lives_when_its_place_then_lies_below_it`：「上卷」住在「下卷」里时存点，之后改名、挪到书稿开头、再把「下卷」挪进「上卷」；恢复：标题回到点里的，两个条目的住处和那里的先后都不变，多一个「恢复前」的点；一步撤销回到恢复前。它代替了原来 `restore_still_refuses_a_cycle_or_a_life_where_nothing_can_hold_the_entry` 里断言「成环拒绝、什么都没写」的那一半（那条改名 `restore_still_refuses_a_life_where_nothing_can_hold_the_entry`，剩下的「最近删除里、两个住处都放不了」照旧拒绝）。
- `dr-workspace` `tests/entry_snapshots.rs` 的 `future_container_types_rich_marks_hidden_memberships_and_shared_templates_roundtrip_exactly`（改了期望）：原来点里有一条宿主是书里没有的 `missing-host` 的挂名记录，带一个不认识的字段，断言恢复以后它原样回来。现在这条按新规矩不写回，期望里去掉它；另加一条宿主在书里、但不收别处条目的挂名记录（同样读作没挂、带不认识的字段），断言它原样回来，「看不见的挂名和不认识的字段原样往返」照旧守着。
- `restore_skips_memberships_and_a_primary_host_deleted_for_good`：章 b 挂在三个条目上（主归属是第一个），它自己也收了两章；存点以后改字、摘掉几处挂名，第一个宿主和它收的一章永久删除，第二个宿主进最近删除，第三个宿主关了「收别处的条目」。恢复：标题回到点里的；挂名记录写回了第二、第三个宿主和还在的那一章的，两条另一端永久删除的没写回；主归属仍是空的；书里所有挂名记录的两端、所有条目的主归属都是书里有的条目；一步撤销回到恢复前（挂名、主归属、字和住处）。
