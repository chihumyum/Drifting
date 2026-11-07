# M05 通览全书

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
