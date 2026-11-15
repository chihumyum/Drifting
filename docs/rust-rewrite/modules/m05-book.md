# M05 通览全书

> 2026-11-15 夜里（内核 v5 DW）：整书视图的出发点是 `dr_model::v3::FlattenFrom`（`Root`、`Entry`、`View`、`Lane`），替掉下面说的 `BookRoot`；成书本身没有起点、一律从根读。`dr_editor::v3::flatten_from`（原 `flatten_book_root`）给出每个条目进成书的正文和带页头的那一篇（构想、要素的正文不进成书以后照旧在整书视图里），`book::flatten_position_key`（原 `book_root_position_key`）给的阅读位置键不变。见 [kernel-v5.md](../kernel-v5.md) 第 18 节「DW 交回」。

2026-11-08，第一个里程碑。计划见 [modules.md 的 M05](../modules.md#阶段-2写作闭环)，编辑器本身见 [f4-editor.md](../foundations/f4-editor.md)。代码在 `next/crates/dr-editor/src/book.rs`（`BookEditor`，AGPL）；`gpui-prose` 只动了排版层 `src/layout/book.rs` 和 `src/editor.rs` 里新加的两个方法（见「对 `gpui-prose` 的改动」）。测量证据在 [acceptance/m05-m1-book-bench.json](../acceptance/m05-m1-book-bench.json)（F8 的格式）。

## 做了什么（大白话）

1. **全书就是一个编辑器。** 旧版的全书模式里，只有聚焦的那一章挂着真正的编辑器，其余各章是渲染好的静态 HTML 行，点进去才换成编辑器。新版的 `BookEditor` 把每一章都作为一篇文档放进同一个 `gpui-prose` 编辑器：所有段落走同一套排版（GPUI 的 `list()` 只排看得见的段落，高度表记着其余段落的高度），章与章之间是章标题，任何一章的任何地方点下去就能写。
2. **每章各有各的会话。** 打开全书时，每一章开一个 F3 的编辑会话（第三轮的 `SessionSource`），写入、撤销、Agent 的改动都按章走，和单章编辑器是同一条路。100 章分到所有核上并行打开。
3. **撤销各归各的。** ⌘Z 撤的是光标所在那一章的最后一步，哪怕最后改的是别的章；这一章已经没有可撤的，就什么也不做，不会跑去撤别的章。做法：`gpui-prose` 加了 `undo_in(章)` / `redo_in(章)`，`BookEditor` 在自己的视图上截住撤销、重做两个动作，转给光标所在的章。
4. **幕。** 书目里的幕记成「这一幕从第几章开始、叫什么」，交给 `Book::set_acts`；渲染层用 `Book::act_opening(章)` 知道某一章前面要不要画这一幕的扉页。扉页长什么样是 F4d 画层的事（见「待协调」），数据已经在了。
5. **目录跳转和位置链接。** `jump_to(章)` 把那一章的标题滚到顶，光标放在章首。`reveal_line(章, 行号)` 按位置链接的行号定位（Markdown 投影里第 N 段从第 2N+1 行开始），把那一段滚到顶，光标放在段首。
6. **记住读到哪儿。** `reading_position()` 说出视图顶上是哪一段：哪一章、这一段的块 ID、段号、这一段已经滚出顶边多少像素。`restore()` 先按块 ID 找，所以前面加了段落也还能回到同一段；块 ID 没了再按段号找。宿主（F6）把它存进这本书的布局，下次打开回到原处。
7. **书变了，视图跟着变。** 工作区发来「书变了」的通知时：如果只是章名变了，就原地改标题，不重建；加章、删章、挪章、幕变了，就重建视图，并停在原来的阅读位置。Agent 改了任何一章（不只是光标所在的那章），那一章的改动到达后都会折进编辑器。
8. **跨章选区先不做，接口留好了。** 新加了三样：`BookPos { chapter, offset }` 和 `BookRange { start, end }` 表示全书里的位置和范围；`Book::split_range` 把一个跨章范围拆成每章一段；`Book::text_in` 取出范围里的文字，章与章之间用换行接起来。`BookEditor::selection()` 已经返回 `BookRange`，现在总在一章之内。F4b 以后做跨章选区，在这上面补几何和输入就行。
9. **基准不开窗口。** `cargo run --release -p dr-editor --example book-bench` 在 F8 的重型种子上量四项：打开全书、跳到末章、从头滚到尾、内存。重型种子是 100 章、约 165 万个字符（编辑器的字符数，含段落换行；就是 `benchmarks.md` 说的「150 万字」那一档）。
   - **为什么不开窗口：** 第一版开了真窗口，窗口被别的窗口挡住后系统不再给它发帧回调，程序空等了一个多小时。
   - **现在怎么跑：** 照 F4d 的 `prose-bench decor` 改成无窗口，用 GPUI 的测试平台，加上真实的 macOS 文字系统，Metal 画到离屏纹理上。
   - **两道保险：** 总超时默认 15 分钟（`--timeout` 秒数可改）；`--capture <目录>` 存两张图，用来核对画出来的是对的。
   - **用时：** 十几秒跑完。

**要作者定的事：没有。**

## 关键数字

[m05-m1-book-bench.json](../acceptance/m05-m1-book-bench.json)：M3 Pro，release，2026-11-08，重型种子（100 章、1 649 538 个字符），900 × 800 的无窗口画布。

- **机器很忙**：一分钟负载 18.7–19.1（别的会话在编译、测试），证据里程序自己标了 `reference_only`（负载超过 2 就标）。所有数字只供参考，最终数字等机器空闲时重测。
- **帧时间看两个数**：墙钟时间会把「这一帧被别的进程抢走 CPU 的时间」也算进去，所以另记了这一帧在主线程上实际用掉的 CPU 时间。

| 项 | 预算（探针档 / 发布档） | 数字 | 说明 |
| --- | --- | ---: | --- |
| 打开全书（冷，持有者从 SQLite 读） | ≤ 200 / 100 ms | 132 ms | 到第一帧画完。其中开 100 个会话和文档 129 ms，第一帧 0.34 ms |
| 再打开一次（工作区已热） | 同上 | 28–31 ms | |
| 跳到末章（从目录点最后一章，到字画出来） | ≤ 150 / 80 ms | 8.2 ms | 三次跳末章里最慢的一次；七次跳转都落在了目标章 |
| 从头一路滚到尾，帧 p95（墙钟） | ≤ 16.7 / 8.3 ms | 6.1 ms | 每帧滚半屏（400 px），共 3337 帧；p50 1.8 ms，最慢 31 ms |
| 同上，帧 p95（CPU） | — | 3.1 ms | p50 1.5 ms，最慢 4.1 ms |
| 滚完全书后的内存（整个进程） | ≤ 800 / 400 MB | 188 MB | 开书前 142 MB（工作区和 GPUI），开全书后 175 MB |

怎么看这几个数：

- **超过 16.7 ms 的帧是被抢了 CPU，不是编辑器慢。** 这一次墙钟超过 16.7 ms 的只有 2 帧，证据里记了它们在哪一章，CPU 时间分别只有 3.6 和 2.1 ms。调试时负载更高的几次有 20–65 帧超过，CPU 时间也都在 4.2 ms 以内。在这样的负载下，一帧被调度器抢走几十毫秒很常见。
- **内存。** 开全书多 33 MB，从头滚到尾再多 13 MB，排过的段落不会一直攒着。调试时几次跑出来最高的是 424 MB，那时种子生成器的一份副本还留在内存里（现在测量前先释放了），也在 800 MB 以内。
- **没算进去的部分**：GPU 的那一半、显示器的节拍、按键到上屏。这三样仍归 `prose-bench` 的上屏测量，等空闲重测，见 [f4-editor.md 的「重测上屏」](../foundations/f4-editor.md#重测上屏机器空闲时)。

**空闲时重测**：

```bash
# 在 next/ 下
cargo run --release -p dr-editor --example book-bench -- --write
```

## 给 F6 的用法

| 项 | 说明 |
| --- | --- |
| `BookEditor::open(ws, book, settings, window, cx)` | 全书视图（GPUI 视图，放进稿纸区就是它本身）。打开时每章一个会话，所有核并行 |
| `jump_to(doc, …)` | 目录点某一章：章标题滚到顶，光标在章首 |
| `reveal_line(doc, line, …)` | 位置链接（行号从 1 起，同 `dr-text` 的 Markdown 投影）：那一段滚到顶，光标在段首 |
| `reading_position(cx)` / `restore(&at, cx)` | 读到哪儿：`ReadingPosition { doc, block, paragraph, offset }`，可序列化成 JSON 存进书的布局 |
| `undo` / `redo` | 撤销、重做光标所在章；按键已经由视图截住，编辑菜单的撤销、重做调这两个 |
| `current_doc(cx)`、`chapter_docs()`、`chapter_of(doc)` | 光标在哪一章；全书的章（阅读顺序）；某一章在视图里排第几 |
| `selection(cx)` → `BookRange`、`text_in(range, cx)` | 选区和取字（跨章的接口已留） |
| `set_settings`、`set_base_style` | 同 `ChapterEditor` |
| `todo_markers()`、`plain_text(doc, cx)`、`editor()` | 各章的 TODO 标记；某章的文字；里面的 `ProseEditor` |
| `BookEditorEvent` | `Edited { doc }`、`TodoMarkers { doc, markers }`、`AnchorsChanged { doc, changes }`、`Reloaded`（书的章变了、视图重建了） |

## 对 `gpui-prose` 的改动

只动了排版层和编辑器里新加的方法，没有动输入（`src/input/`，F4c 在改）和渲染（`src/render/`，F4d 在改）。

- `src/layout/book.rs`：
  - **幕**：`Book::set_acts`、`act_opening`、`acts`；
  - **跨章的位置和范围**：`BookPos`、`BookRange`（`in_chapter`、`is_empty`、`chapter`）、`Book::split_range`、`Book::text_in`；
  - 两个测试：`ranges_split_per_chapter`、`acts_open_chapters`。
  - `layout/mod.rs` 多导出 `BookPos`、`BookRange`。
- `src/editor.rs`：只加了两个方法 `undo_in(chapter)` / `redo_in(chapter)`，其余行没改。

## 测试与证据

- `dr-editor/tests/book.rs`，五个测试都在真实的工作区上跑：
  - `every_chapter_in_one_scroll_with_its_acts`：三章一个滚动区；第二幕从第二章开始；在第二章打字只写第二章的文档。
  - `undo_stays_in_the_caret_chapter`：先改第一章，再改第二章，光标回到第一章按撤销，撤的是第一章；第一章撤完再按，第二章不动；按键（`Undo` 动作）也一样；重做。
  - `an_agent_writing_any_chapter_shows_up`：Agent 改了不在光标处的那一章，视图里也变了。
  - `lines_and_reading_positions`：位置链接的行号定位到段；阅读位置跳走再回来，回到同一段；跨章范围取字。
  - `the_view_follows_the_books_chapters`：改章名只改标题、不重建；加一章，重建并能看到新章。
- `gpui-prose` 的 `layout::book` 两个测试（见上）。
- 基准的证据 [m05-m1-book-bench.json](../acceptance/m05-m1-book-bench.json)：程序当场核对，跳转都落在目标章、滚到了最后一章的末尾，核对不过就不写证据。

## 要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 全书模式：多篇正文拼成一个滚动区，所有段落走同一套排版；章与章之间的分隔和章标题；跳到任意章；位置链接定位到行 | 完成 | `book.rs`；测试 1、4 |
| 2 | 在全书模式里直接编辑任意一章，每章各自的会话 / 文本源；切换章节时撤销栈各归各的 | 完成 | 测试 1、2、3 |
| 3 | 跨章选区先不做，接口留好 | 接口完成（`BookPos`、`BookRange`、`split_range`、`text_in`、`selection()`） | 测试 4、`ranges_split_per_chapter` |
| 4 | 基准：重型种子打开全书、从头滚到尾、跳末章、内存，对照全书档，标注负载 | 完成，四项都在探针档预算内；负载高，只供参考 | `examples/book-bench.rs`、证据 |
| — | modules.md 的「每幕有扉页」 | 数据完成，画扉页等 F4d | `acts_open_chapters`、测试 1 |
| — | modules.md 的「保留阅读位置」 | 完成（存哪儿由 F6 定） | 测试 4 |

## 待协调

1. **F4d（渲染）：幕的扉页。** `Book::act_opening(章)` 不为空时，在这一章的标题前画这一幕的扉页（幕名，留白多一些）。扉页最好作为章标题那一项的一部分来画，`list()` 的项数不变；它的高度要算进这一项的高度。（F4e 第二批以后也可以由 F6 在章首里画：`PageInfo::act_opening` 给出这章开头的幕，见 [f4e-editor.md](../foundations/f4e-editor.md)。）
2. **F4b / F4c：跨章选区。** 选区模型以后改成 `BookRange`：拖选、⇧ 加方向键越过章界、全选，复制用 `Book::text_in`；删除和替换按 `split_range` 拆成每章一步，每章写进自己的会话。这样一次跨章删除会在每章的撤销栈里各留一步，撤销时要不要一起撤，到时候再定。
3. **F6（外壳）：把全书视图放进去。**
   - 稿纸区的「全书」模式放 `BookEditor`；
   - 目录点章调 `jump_to`，`take_reveal` 的位置链接调 `reveal_line`；
   - 离开全书或关窗时把 `reading_position()` 存进这本书的布局，打开时 `restore()`；
   - 编辑菜单的撤销、重做调 `BookEditor::undo` / `redo`；
   - 订阅 `BookEditorEvent`：`AnchorsChanged` 和 `TodoMarkers` 现在带着章的 `doc`，等 F3 的命令。
4. **F3：** 和 F4e 第三轮一样，等 `comment.reanchor` 和 `todo.project`（[f4-editor.md 待协调 11](../foundations/f4-editor.md#待协调)）。接上以后全书视图和单章编辑器一起用。

## 没做的，和下一个里程碑建议

- **按需打开章节**：现在一次开全部章，冷开在高负载下约 132 ms。探针档 200 ms 够了，发布档 100 ms 可能要改成先开看得见的几章、其余在后台开。等空闲重测的数字出来再决定。
- **跨章选区**（F4b 之后）。
- **幕扉页的样子**（F4d）。
- **全书查找**是 M06。

## 代码位置

| 文件 | 内容 |
| --- | --- |
| `next/crates/dr-editor/src/book.rs` | `BookEditor`、`BookEditorEvent`、`ReadingPosition`；列章和幕、并行打开、跟随工作区事件、跳转、阅读位置、按章撤销 |
| `next/crates/dr-editor/src/anchors.rs` | `book_comment_anchors`：一次读出全书各章的批注锚点 |
| `next/crates/dr-editor/tests/book.rs` | 五个测试 |
| `next/crates/dr-editor/examples/book-bench.rs` | 全书基准（无窗口） |
| `next/crates/gpui-prose/src/layout/book.rs` | 幕、`BookPos`、`BookRange`、`split_range`、`text_in` |
| `next/crates/gpui-prose/src/editor.rs` | `undo_in`、`redo_in` |

## 内核 v4 · T7 整书视图（2026-11-13）

按 [kernel-v4.md](../kernel-v4.md) 第 7、9、14 节将全书视图升级为从任意开着「层级」开关的条目铺开的「整书视图」：

- **起点与铺开规则**（`dr-editor/src/book.rs`、`dr-editor/src/v3.rs`）：`BookEditor::prepare(ws, book, from)` / `BookEditor::open(ws, book, from, settings, window, cx)` 以任意活动且 `level == true` 的条目 `from`（如「书稿」「第一卷」「故事线」「设定」或作者刚打开「层级」开关的条目）为起点，直接调用数据层 `BookStructureV3::flatten(from, Flatten { in_book_only: true, include_members: true })`，不在视图层重复做判重或深度遍历。起点自身的 `in_book = true` 正文模块排在最前，随后深度优先依次铺开住处子条目（按成书顺序）与有效归属成员（`Membership`，按归属位置），每一层条目的成书正文都在它下面的条目之前；`in_book = false` 的说明正文（如 `mod-description`）不进入整书视图。起点被移入回收站或关掉「层级」开关时，`BookEditor::prepare` 返回错误，已打开的视图与外壳标签自动收起。
- **无成书正文条目的标题与层级渲染**：`FlatEntry.prose` 为空的条目（如「书稿」「第一卷」「故事线」或没有成书正文的组织条目）在 `BookSection`（`doc: None`）与 `SectionHeading` 中保留标题与相对深度 `depth`，无论位于开头、中间、末尾，还是整个子树全无成书正文，都在滚动区按 `depth` 缩进与字号层级画出标题，并在右栏大纲（`dr-shell/src/workspace/outline.rs`）中将 `depth > 0` 的中间层级标为一级大纲项。
- **路由与入口统一，收起旧入口**（`dr-shell`、`dr-view-page`、`dr-view-home`）：页面路由由单例 `Target::Book`（`"book"`）改为按起点条目寻址的 `Target::Book(EntryId)`（`"book:<id>"`），支持同时打开多个不同起点的整书视图标签（标签标题形如「`<条目名> · 整书视图`」）。所有 `entry.level == true` 的条目在公共条目卡（`dr-shell/src/v3/card.rs` 的 `entry-open-book`）与条目页顶部（`dr-shell/src/v3/page.rs` 的 `#v3-entry-open-book`）均提供「整书视图」（九语 `v3Shell.bookView`）入口。退役旧的 `workspace::ShowWholeBook` 动作、`⌘⌥2`（`secondary-alt-2`）快捷键、项目主页 `#v3-home-all` 按钮与无参 `"book"` 路由。
- **按起点记忆阅读位置**：`ReadingPosition` 新增 `at_title` 区分章节／前导层级标题项与正文段落；工作区布局将原单例 `book_position` 升级为 `book_positions: BTreeMap<String, SavedPosition>`（按 `from` 条目 ID 索引），各起点整书视图独立保存与恢复阅读位置。本轮按计划不做按视口分段加载文档。

永久回归见 `dr-editor/tests/book.rs`、`dr-shell/tests/v3.rs`、`dr-shell/tests/v3_editors.rs` 与 `dr-view-page/tests/mounted.rs`。

## 内核 v5 · T4 视图与泳道起点整书视图（2026-11-15）

按 [kernel-v5.md](../kernel-v5.md) 第 3、4、16 节与 `handoff/v5-tracks.md`（T4）支持从整张视图或视图中的一条泳道打开整书视图：

- **统一按 `BookRoot` 铺开成书序列**（`dr-editor/src/v3.rs`、`dr-editor/src/book.rs`）：`BookEditor::prepare(ws, book, from)` / `BookEditor::open(ws, book, from, settings, window, cx)` 直接接收 `BookRoot`（`Entry { entry }`、`View { view }`、`Lane { view, entry }`），委托数据层 `BookStructureV3::sequence(&from, true)` 生成扁平序列，不在编辑器或外壳重复做遍历、去重或刻度排序。
  - `BookRoot::View { view }`：以整张视图为起点，按视图内各泳道从上到下的顺序，每条泳道内按该视图刻度从左到右铺开各条目及其子树，跨泳道重复出现的条目只铺开第一次。
  - `BookRoot::Lane { view, entry }`：以指定视图中的一条有效泳道（`has_below == true`）为起点，先放泳道自身（含其 `in_book = true` 正文模块），再按该视图刻度顺序铺开泳道内各条目及其子树。
- **外壳路由、持久化与失效收起**（`dr-shell`、`dr-view-page/src/whole.rs`）：新增 `Target::BookView(TimelineViewId)`（键 `"book-view:<view>"`）与 `Target::BookLane { view, entry }`（键 `"book-lane:<view>/<entry>"`），与原有 `Target::Book(EntryId)` 并列挂载于 `whole.rs`，支持多标签并存、按各自键在 `book_positions` 中独立记忆阅读位置、同步右栏大纲标题层级。当对应视图被删除、泳道从视图移出，或泳道条目不再满足 `has_below`（同时关掉「层级」与「收别处的条目」或移入回收站）时，`BookEditor::prepare` 返回错误，已打开的整书视图标签自动收起。

永久回归见 `dr-editor/tests/book.rs`（含视图起点按泳道从上到下与刻度从左到右铺开且不重复、`BookRoot::Lane` 按该视图刻度铺开）与 `dr-view-page/tests/mounted.rs`（含挂载外壳打开 `Target::BookView` / `Target::BookLane` 及泳道关掉开关后自动关标签）。

## 内核 v5 · T5b 整书视图里放文件（2026-11-16）

大白话：整书视图和单章编辑器在「往正文里放文件」这件事上一样了（作者：「通览全书和单独章节的Editor功能应该是等价的。」）。之前整书视图的斜杠菜单列着「图片或 PDF…」，挑完文件什么也不发生；「从电脑选…」只把文件导进素材库；拖文件、⌘V 贴图、表格按表格复制剪切都没有。现在：

- **斜杠菜单的「图片或 PDF…」**：挑一个文件，嵌在打开菜单的那一章、光标处；「从电脑选…」的文件进素材库（同样的字节给回已有的那一个），再嵌进同一章。光标已经离开那一章时（选文件窗口开着的时候点到别处），嵌在那一章末尾。
- **从素材库或系统拖进来**：落点线跟着指针，在屏幕上看得见的段落之间找最近的缝；两章交界处离哪一章的段落近就落在哪一章。素材夹拖进来带上里面的文件。松手以后光标移到放进来的文件后面那一段。
- **⌘V**：剪贴板里的图、图片或 PDF 文件嵌在光标那一章；复制来的表格、两行两列以上的制表符文字变成表格。选中一张表格复制、剪切，照单章按表格放上剪贴板。
- **撤销**：每一次放文件都是那一章自己的一步，⌘Z 一步回去。整书视图的 ⌘Z 撤的是光标所在那一章（本页第 3 条），所以拖放以后光标跟到落点那一章，否则会去撤光标原来那一章的字。单章编辑器里拖放不动光标，这是两边唯一的差别。
- **斜杠菜单的行**：开着「格式快捷输入」的层级下面，单章的斜杠菜单不列「待办」「位置链接」，整书视图之前照列。现在整书视图每一章的斜杠菜单和这一章在单章编辑器里的一样（`Assist::set_chapter_notes`）。
- **链到文件的小记号**（核对时顺手查出来的）：正文链到素材库里的文件时，链好的字后面有一个小文件记号。这个记号是选区浮条那一层（`Assist`）拿到编辑器的扩展以后画的，单章给了、整书没给，所以整书视图里看不到。现在给了。

做法：单章的这几样原来都写在 `view.rs` 里、只认第 0 章。挪进 `dr-editor/src/prose_files.rs`，改成对「某一章」做（用那一章自己的 `NoteEmbeds`，写进那一章的文档）；后台导入完成后按文档重新找这一章，整书视图中途重建也不会放错。单章（`view.rs`）和整书（`book/files.rs`）都调它，不写两份。整书视图的落点只看列表里画出来的那些项（`ListState::bounds_for_item`），不扫全书的段落。

新的公开接口：`BookEditor::{insert_material(章, 文件), drop_asset_drag(拖的东西, (章, 缝)?), drop_external_paths(路径, (章, 缝)?), note_embeds(文档)}`、`Assist::{set_chapter_notes, pick_material_from_computer}`（后者原来是私有的，测试要调）。小文件记号带了一个调试选择器 `dr-editor-file-link-badge`（只在调试构建的测试里记下，测试靠它看记号画没画）。

核对整书和单章还有没有别的不等价（2026-11-16）：批注画层、浮条、复制时带上链接、高亮和行内代码的快捷键、撤销、查找、字数两边本来就是同一套代码；外壳那一层 `dr-shell/src/workspace/mounted.rs` 给两边接的是同一组事件（点开嵌入的文件、给嵌入写批注、框一块写批注、打字进沉浸）。拼写检查两边都没有；字段、键值表、媒体模块在整书视图里不显示是设计如此。除了上面几条，没有查出别的差距。

回归在 `dr-editor/tests/v5_files.rs`：

- `whole_book_slash_embeds_an_image_and_a_pdf_in_the_caret_chapter_undone_in_one_step`：斜杠插图进第二章、插 PDF 进第一章，另一章不动，素材库不多一格，各自一步撤销；「从电脑选…」的文件进素材库并嵌进菜单那一章。
- `whole_book_drops_library_files_and_folders_into_the_dropped_chapter`：素材库的文件拖进第二章两段之间，光标跟过去，一步撤销；素材夹拖进第一章带上里面的文件。
- `whole_book_file_dropped_at_a_chapter_boundary_lands_in_the_chapter_under_the_pointer`：真走一遍系统拖放事件，指针在第一章末段下面落在第一章末尾、在第二章首段上面落在第二章开头；同样的字节再拖一次不多一格。
- `whole_book_paste_puts_an_image_in_the_caret_chapter_and_reuses_the_same_bytes`：⌘V 贴图进光标那一章、叫「粘贴的图片 …」，一步撤销，文件留在素材库；同样的字节贴进另一章不多一格。
- `whole_book_copies_cuts_and_pastes_tables_as_a_chapter_editor_does`：制表符文字贴成表格；选中表格复制是表格、贴进另一章还是那张表；剪切拿走表格、放上剪贴板。
- `whole_book_slash_menu_matches_each_chapters_own_editor`：一章在开着格式快捷输入的卷里、一章不在，两章的斜杠菜单各自和单章编辑器里的一样。
- `whole_book_draws_the_file_mark_after_a_link_to_a_file`：在整书视图里用 `@` 链到一个文件，链接画在那一章，字后面画出小文件记号。

反证：把整书视图里接住插入、⌘V、复制剪切、系统拖放、按章的斜杠菜单和扩展这几处临时拿掉，上面除了拖素材库那一条（它直接调新接口）都会失败；放回去全过。

单章原有的放文件测试（`v5_files.rs`、`note.rs` 的表格和粘贴）照旧过，期望没动。
