# M20 统计面板

2026-11-08，第一个里程碑。计划见 [modules.md 的 M20](../modules.md)。旧版是 `features/stats/*`（`EntityStatsContent`、`AllChaptersStats`、`MaterialStats`、`StatsPrimitives`）。新版在 M07 的「统计」标签里往下加，不另起面板：界面在 `next/crates/dr-view-stats/`（`detail.rs` 读数据，`sections.rs` 画），F3 加了三条只读查询，规则在 `dr-text` 的 `shape`。热力图是 M25，不在这里。

## 做了什么（大白话）

1. **统计标签跟着前台那一页，多出这一页自己的读数。** 从上到下：
   1. M07 的读数（最具体的那个字数、全书、今天）；
   2. **这一页自己的几节**（下面按页面种类列）；
   3. 「写作进度」（M07 的；打开故事线时先画这条线的章节状态，不列全书目标）；
   4. 打开「通览全书」时：分幕节奏、完成度、章节长度节奏；
   5. 「最近」（M07 的）；
   6. 最底下一个「历史快照…」按钮，打开 M09 的历史对话框（旧版唯一的入口就在这里；新版章节 ⋯ 菜单里也有）。
2. **各种页面的读数，照旧版：**
   - **章节 / 构想**：「章节坐标」（故事线带记号，没有就写类型；全书位置第 N 章；最近修改），「字数 · 节奏」（段落 / 句、对白比和一笔砂笔），「本章要素」（正文里链到的要素，按提及次数排，×N，点一行打开那个要素）。
   - **故事线**：「故事线坐标」（名字带记号、最近修改）；「写作进度」先画这条线的章节：完成是一笔饱满的砂，草稿是一笔干砂，下面一行「已完成 N 章 · 草稿 M 章（弃用 K）」，再是章节数和平均字数；「本线核心要素」（这条线各章提及最多的 8 个，多出来的写「还有 N 个要素出场较少」）。
   - **要素**：「要素坐标」（类目、名称、更新）；「被引用」（哪些章、构想、要素、素材的正文链到它，每行「N 处 · M 次」）；「引用其他」（它自己的正文链到了什么）。
   - **类目**：「类目坐标」（名字、要素数）；「健康度」（已出场 a / t 和一笔砂笔，平均出场 x.x 章 / 要素）；「未出场要素」（最多 20 个，多出来写「还有 N 个未出场」）；「故事线分布」（每条线有几个要素出场，没有主故事线的章节和构想归「漂浮 / 未归线」）。
   - **素材**：「素材坐标」（类型、更新）；笔记是「笔记概况」（字数、待办 d / t 已完成和一笔砂笔、未解决的批注与 TODO），图片和 PDF 是「文件」（格式、大小、尺寸、批注数）；「嵌入的素材」；「关联」。
   - **通览全书**：「分幕节奏」（每一幕一段砂笔并排，长短按字数；下面每幕一行「N章 · x.xk · p%」，点了在通览里跳到这一幕的第一章）、「完成度」（完成 / 草稿 / 待写三种砂并排，下面一行各几章，再一行完成的百分比）、「章节长度节奏」（每章一笔细砂笔，最长的满格，颜色是所在幕的颜色；指针停在一笔上，其余淡下去，下面换成「标题（N字）」；平时下面是最长和最短的两章；点一笔在通览里跳到那一章）。
3. **「提及」从派生索引来。** 正文里的要素链接（人物链接和它的兄弟）和嵌入的素材，dr-index 早就记进了 `reference` 表；新的 `mention.list` 按来源、目标、种类合并成行，带「几段、几次」，只留两头都活着的。
4. **段落、句子、对白比照旧版的规则算**（`lib/prose-stats.ts` 一字不改，写成 `dr_text::shape`）：
   - 去掉空白后不空的段落才算一段；
   - 一串「。！？…」算一句结束，一串「.!?」后面跟空白或段尾才算（`3.14` 不断句），有字没句号的段落也算一句；
   - 对白比 = 「」『』“”‘’ 和英文直双引号里的字 / 全部非空白字（直单引号是撇号，不算），每种引号各算各的，按 UTF-16 计数，和旧版读数一致。

截图在 [m20/](m20/)：章节、故事线、要素、类目、素材、通览全书六种浅色，章节和通览全书再各一张深色。只截了右栏（窗口拉高到能放下整个标签）。

## 定下的事

- **顺序**：这一页自己的几节放在 M07 的读数下面、「写作进度」上面；全书的三节（分幕节奏、完成度、章节长度节奏）放在「写作进度」下面。旧版的「全书概览」（总字数、章节数、平均每章、已写 / 目标）和 M07 的读数、「写作进度」重复，不再单列。章节的「全书位置」从「写作进度」挪进了「章节坐标」，和旧版一样。
- **「本章字数」不再单列**：标签最上面就是这一章的字数（M07），旧版在「字数 · 节奏」里又写了一遍。
- **段落、对白从文档本身读**（Loro，和旧版读活的正文一样），提及从索引读。索引落后几百毫秒，标签在索引写完以后会再读一次。
- **一段引文的每一段各算一段**：旧版整个引用块算一段，新版文档里引用是段落的属性，没有「块」。
- **构想没有「最近修改」以外的时间**：书目文档不记 `updated_at`（simplifications.md 第一节第 13 条），各页的「最近修改 / 更新」都是这一页正文最新一次存下的时间；没有正文的（图片、PDF 素材）不显示。旧版素材的「创建」时间新版没有记，不显示。
- **时间格式**照旧版 `formatDateTime`：今年的写「MM/DD hh:mm」，别的年份前面加年。本机时区：macOS / Linux 按那个时刻的偏移（`localtime_r`），Windows 按现在的偏移（夏令时切换前后的旧时间可能差一小时）。
- **要素链到一段补丁（patch）的提及不列**：新版没有补丁的页面可开，旧版这一行也只是一个类型标签。
- **素材的「关联」只列从素材出发的关系**（旧版 `MaterialStats` 同样），一个目标只列一次。
- **幕的颜色**：幕自己存了颜色用它的，没存按在书里的位置轮流用六种故事线颜色（旧版 `--story-1…6`）；幕的记号是按幕 id 选的圆印（旧版 `mark="chapter" seed={act.id}`）。
- **干砂、散砂**：旧版用点阵遮罩画「干」和「散」两种砂。新版干砂是同一笔砂笔压淡到一半，散砂就是砂笔的散粒轨道（`Readout` 值为 0），没有另画遮罩。章节长度节奏的细砂笔用 dr-ui `Readout` 新加的 `height(4.0)`。
- **空的时候**写旧版的那句话（「正文尚未 @ 提及任何要素。」等），文案全是旧版搬来的，没有新加说明文字；行上也不加悬停提示（旧版有「打开「…」」「跳到「…」」两种 title，不搬）。
- **正文模板不算书的正文**：要素模板、章节模板（`template:category:<id>` / `template:storyline:<id>`）的字不进今天写的字、全书字数和任何读数。字数都按章节读（F3 的 `book.word_counts`），模板也不在索引里（dr-index 交空结果），所以不用另加判断；`recorder_library.rs` 里写了一段模板确认今天的字不动。
- **点一行**：交给外壳打开那一页；通览全书里点幕或章节，给的是位置链接，外壳在通览里就地跳过去（`open_link` 的 `reveal_in_book`），不在通览时打开那一章。

## 改了 F3

三条新的只读查询，能力清单快照已更新，`tests/commands.rs` 里各有测试：

| 查询 | 做什么 |
| --- | --- |
| `mention.list` | 正文的提及：某一页的正文链到了什么（`from`）、什么链到了某一页（`to`）、或整本书的（都不给）；可再按目标种类筛（`to_kind`）。每行 `from`、`to`、`kind`（`link` 链接 / `embed` 嵌入）、`blocks`（几段）、`count`（几次），提及最多的在前；只留两头都活着的 |
| `prose.shape` | 一篇正文的段落数、句数、对白比（0–1）、清单项和勾了几项、嵌入的素材（按顺序） |
| `asset.get` | 一个资源记下的种类、格式、字节数、像素宽高（素材「文件」一节） |

dr-store 加了 `Library::references_in_book(book)`（整本书的引用行，`mention.list` 不给 `from`/`to` 时用）。`reference` 表没有按书的索引，这条是全表扫描，见下面的测量。

## 接口

```rust
// 外壳（dr-shell）：统计标签那一支多给一个 Hooks（一处挂接）。
RightTab::Stats => dr_view_stats::panel(&pane_id, &book_id, current_target, locale, platform, Some(hooks), cx)

pub struct Hooks {
    pub act: Rc<dyn Fn(StatsAction, &mut Window, &mut App)>,      // 一行被点了
    pub marks: Rc<dyn Fn(&NavTarget) -> (sand::Kind, Option<Rgb>)>, // 某一页的记号和颜色（外壳的 Book::mark）
}
pub enum StatsAction {
    Open { target: NavTarget, link: Option<String> }, // 先试位置链接，不成再打开这一页
    History { doc: String, name: String },             // M09 的 open_history
}

// 只读数据，后台线程调（测试和别的模块也能用）：
dr_view_stats::detail::load(&ws, &book, &target) -> Result<Option<Loaded { name, doc, detail: Detail }>>
// Detail::{Page, Storyline, Element, Category, Material, Book}
StatsView::detail() / hooks()   // 读当前读数（测试用）
```

## 测量（只作参考）

heavy 种子（一本书、100 章、150 万字、正文里 22 057 行引用），release，每种页面读 15 次取中位数和最大值。测的时候机器上同时有三十多个编译进程，负载 56–111，数字只能看量级：

| 页面 | p50 | 最大 |
| --- | ---: | ---: |
| 章节 | 5.2 ms | 132 ms |
| 故事线 | 74 ms | 184 ms |
| 要素 | 0.6 ms | 1.5 ms |
| 类目 | 11 ms | 28 ms |
| 通览全书 | 1.3 ms | 158 ms |
| `mention.list` 整本书 | 687 ms | 1 006 ms |

- 都在后台线程读，标签先显示 M07 的读数，这一页的几节读完再出来；不挡打字。
- **故事线和类目不用整本书的查询**：第一次实现时它们都读整本书的引用（全表扫描），要 410 ms 左右；改成每章一次（按来源文档的索引）、每个要素一次（按目标的索引）以后是上面的数。整本书的 `mention.list` 留给帮手和以后的全书视图用，慢的原因是没有按书的索引（见「待协调」3）。

## 测试

- `dr-text`：`shape` 的三个单元测试（空文本、断句、对白比含跨段引号和撇号）。
- `dr-workspace/tests/commands.rs`：`mentions_go_out_and_come_in`（出、入、整本书、按种类、移进最近删除的章和要素不再出现）、`prose_has_a_shape`、`asset.get` 加在素材测试里。
- `dr-view-stats/tests/recorder_library.rs`：作者改一章，今天的字记下来；再写一段要素模板，今天的字和全书字数都不变。
- `dr-view-stats/tests/detail_library.rs`：真实库上的合成小书（三章、一幕、一条故事线、一个类目三个要素、正文链接），六种页面的读数各一个测试，再加「页面没了读不出」。
- `dr-shell/tests/m06_m07.rs`：统计标签在外壳里读出这一章的读数；点一行打开那一页；「历史快照」打开 M09 的对话框；通览全书读出分幕和状态。

## 待协调

1. **F6（外壳）**：构想、要素、故事线、类目、素材页还没有 ⋯ 菜单，统计标签底部的「历史快照…」是这些页面唯一的历史入口（旧版也只有这一个入口）。
2. **F5（dr-ui）**：加了 `Readout::height`（一行，默认 7 不变）。干砂、散砂现在是近似画法（压淡、只画散粒），要和旧版一模一样得给 `Readout` 加点阵遮罩，归 F5 定。
3. **F2（dr-store）**：`reference` 表没有按书的索引，整本书的 `mention.list` 是全表扫描（统计标签已经不用它了，帮手可能用）。库里书多、链接多了以后加一条 `reference(book_id)` 索引（新迁移，归 F2）。
4. **M18（审阅）**：素材的「未解决的批注与 TODO」用 `comment.list`（状态 open、目标是这条素材）数，和审阅标签同一个来源；审阅以后改了「未解决」的定义要一起改。
5. **进度表**：`progress.md` 的 M20 一行等合进 main 时由监管会话写。

## 代码位置

```text
next/crates/dr-text/src/shape.rs                     段落、句子、对白比（0.1 prose-stats.ts 的规则）
next/crates/dr-store/src/index.rs                    references_in_book
next/crates/dr-workspace/src/commands/mention.rs     mention.list、prose.shape
next/crates/dr-workspace/src/commands/material.rs    asset.get
next/crates/dr-view-stats/src/detail.rs              各种页面的读数（后台读）
next/crates/dr-view-stats/src/sections.rs            画：坐标、节奏、提及列表、砂笔并排、章节长度节奏
next/crates/dr-view-stats/src/panel.rs               标签的顺序，读数的加载
next/crates/dr-view-stats/src/clock.rs               本机时间（「最近修改」）
next/crates/dr-ui/src/sand/mod.rs                    Readout::height
next/crates/dr-shell/src/workspace/sidebar.rs        统计标签那一支：Hooks
next/crates/dr-shell/examples/m06-m07-capture.rs     截图（加了 m20）
next/crates/dr-i18n/keys.txt                         M20 的文案键（从旧版搬）
```

## K4 G4：接线待协调（开工核对）

基线 `10e97880` 的统计宿主在调用面板前把 v3 Entry/module 转成旧 Book 哨兵，
而 `book.word_counts`、`book.writing_days`、`writing_day.record` 拒绝 v3。
详见 [M06 的 K4 G4 接线清单](m06-search.md#k4-g4接线待协调开工核对)。
G4 的适配保留 v2.2；v3 全书只计成书层级下的活叶子正文，条目和素材范围独立。
不把空的旧查询结果当作 v3 的零字数，也不从视图直接写书目文档。

### 接口准备（2026-11-10，尚未功能交回）

新增 `v3_panel::panel(id, book, scope, locale, platform, open, cx)`，
`scope` 为 `v3::Scope::{Book, Entry { id, module }, Material(id)}`；`open` 返回
同一个 v3 范围，宿主直接映射外壳 Target。旧 `panel` 保持原路径。

`v3::load` 只读书的条目／模板和索引。全书从有效成书层级下的活叶子读取模板
当前正文模块，树上住处决定纳入，归属不重复计数，层级说明和模板正文不算入。
单条目可按模块看，保留的旧正文仍可单独看；素材独立读其正文。未创建的空正文
为零，已有但尚未索引的正文为待计数，不能因为另一篇有 live 数字就归零。
编辑器 live 数字仅替换同一个文档；切换目标后丢弃旧异步读取结果。

当前面板已有范围字数、全书字数、段落／句子／对白比、逐篇正文导航及目标进度。
写作日仍等 K2；M20 原有引用、素材文件信息等细节尚未全部接回，不作为完整
统计功能交回。`dr-view-stats/tests/v3.rs` 覆盖住处计数、回收恢复、live／待索引、
素材与非成书条目范围、非正文模块不回退全书，以及 GPUI 切换目标／释放。
搜索／统计两 crate 定向测试共 30 项通过；外壳仍未接 v3 面板，真窗口与 heavy
验收尚未运行。正式交回时另记完整检查和场景结果。

## K4 G4 搜索／统计接口批交回（2026-11-10）

本批随 `codex/k4-g4-book` 的搜索／统计接口一起交回，完整检查与首轮失败、
字体补齐和复验过程见 [M06 接口批交回](m06-search.md#k4-g4-搜索统计接口批交回2026-11-10)。
实现为 `78a8a314`，同步 main `ee372789`（第 57 批）；完整测试汇总 2090 通过、0 失败、22
忽略，fmt／workspace Clippy／xtask 含审计／public／九语言同步均通过。

`v3::load`、`v3::Scope` 和 `v3_panel::panel` 是本批提供的稳定接口；上面的
写作日、引用和素材细节仍在后续。右栏未接线，尚未完成真窗口或 heavy 验收，
不能把接口批记为统计产品功能完成。无外壳或 K2 修改，无 v3 书目写入。

## K4 G4 写作日与实时读数交回（2026-11-10）

已消费第 60 批 v3 写作日命令。记录器从成书层级下的活叶子、当前正文模块建立基线；
索引未齐时延后并随索引事件重试，归属不重复计入，素材与保留正文不计入。层级／模板变化
重读正文集合，回收和恢复只调整基线。面板接今日、近七日、连续天数、日目标及选中文字；
主页可订阅未刷盘的今日累计，打开时先建立写作基线。

`tests/v3.rs::writing_days_follow_only_manuscript_modules_and_survive_reopening` 与另外三项
v3 契约 **4/4** 通过，覆盖本地正文、非成稿排除、回收／恢复、落盘重读和日查询；统计 crate
全套通过。本轮最终 workspace **2176 通过／0 失败／22 既有忽略**，fmt／Clippy／xtask／public
和九语检查均通过（详见 M18）；副屏主流程 **23/23、0 pending** 见 M19，不沿用前批结果。

待协调：统计侧栏宿主由 G2 接入，本批不将独立组件测试当作侧栏窗口验收。没有为冻结
v2.2 新增或删除测试；统计实现提交为 `404207ce`。按 11-10 规则不做 heavy 测量或截图目检，
切换统一功能与数据正确性验收由整合者安排。

## 统一条目 v4 与小文档分流（2026-11-13，T6）

- **成书序列与 `in_book` 开关（[kernel-v4.md](../kernel-v4.md) §7）。** `v3::load_at` 直接读 `BookStructureV3::manuscript()`：不论条目自己的开关开着还是关着，只要它在成书序列里且带有 `in_book == true`（「计入字数和导出」打开）的正文模块，就按住处先序进入整书字数（条目自己的正文排在它下面条目的前面）；`in_book == false` 的说明或备忘模块只在单看该条目（`Scope::Entry`）时列出，不进 `book_words`、全书目标进度和写作日记录器。
- **事件隔离（[kernel-v4.md](../kernel-v4.md) §8）。** 面板订阅 `WsEvent::Book`、`WsEvent::Stats` 和正文索引更新，忽略 `WsEvent::Checkpoints`（`dr-view-stats/tests/quiet.rs`、`dr-view-home/tests/quiet.rs`）。
