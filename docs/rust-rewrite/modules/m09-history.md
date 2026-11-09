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
