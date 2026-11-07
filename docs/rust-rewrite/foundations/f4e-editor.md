# F4e 第二批：编辑器的交互（dr-editor）

2026-11-08，分支 `claude/optimistic-goodall-6739a9`。这一批接在第三轮之后：第三轮（`dr-editor` 本身、文本源、第一批扩展）记在 [f4-editor.md 的「第三轮」](f4-editor.md#第三轮f4edr-editor)，全书模式记在 [m05-book.md](../modules/m05-book.md)。

- **代码**：`next/crates/dr-editor`（AGPL）。
- **`gpui-prose` 的改动**：只加了挂钩，见「对 `gpui-prose` 的改动」。
- **截图**：在 [f4e/](f4e/)，由 `cargo run -p dr-editor --example page-capture -- docs/rust-rewrite/foundations/f4e` 不开窗口画出来。

## 一句话

章节页的页眉、标题、梗概、章末 ⁂ 和空章提示，现在都在编辑器里留了位置，跟着正文滚动，外壳（F6）往里放自己的元素就行，数据和动作由 `dr-editor` 给；正文里有了 @ 选择器（含直接新建要素）、斜杠菜单、打字时的自动人物链接和断链修复，选中文字后浮出一条横向的格式条。F6 提的三件事（一个不会失败的构造、标题行按页边距排、渐变时不留住淡色）也做了。

## 大白话

1. **章首、章末留了位置（M03 卡在这里的那件事）。** 编辑器的滚动列表里，每章原来只有「标题行 + 段落」。现在宿主可以给两样东西：
   - **章首**：一个元素，代替编辑器自己的标题行。外壳在里面放页眉（「第 N 章 · 故事线 · 字数」）、可改的标题、梗概和分隔线。
   - **章末**：一个元素，放在这章最后一段后面。外壳在里面放 ⁂ 和它的两个动作，空章时再放空章提示。

   它们和段落一样是列表里的项：跟着滚动，只建看得见的，按实际高度量进高度表（滚动条、跳转都准）。在它们里面按下鼠标，编辑器不会挪光标、不会抢焦点，宿主的按钮和输入框照常用。单章和全书模式都有。
2. **页的数据和动作由 `dr-editor` 给。** 外壳实现一个 `PageChrome`（画章首、画章末），交给 `ChapterEditor::set_chrome` 或 `BookEditor::set_chrome`。编辑器为每一页准备好 `PageInfo`：第几章、标题、梗概、状态、主故事线（名字和颜色）、字数、是不是空章、（全书模式里）这章是不是一幕的开头。书目变了（改名、改状态、换故事线）、作者打了字（字数、空不空），编辑器都会更新这份数据，并请宿主重画。
   - 规则照旧版：N 是活着的章节在阅读顺序里排第几，幕不重新起算；故事线取主故事线，没有就取第一条；字数按 `prose-metrics` 的规则只数正文。
   - 动作也照旧版，在 `dr_editor::page` 里：
     - **改标题**：去掉首尾空白，空的不存（输入框显示回原标题），没变不写，重名由 F3 加「 2」；
     - **改梗概**：去掉首尾空白，可以清空；
     - **⁂ 的「标为完成 / 改回草稿」**：在 `finished` 和 `draft` 之间切换；
     - **「新建下一章」**：紧跟在这一章后面，不跨幕，草稿，不在任何故事线上，返回新章的文档 id，外壳打开它并聚焦、全选标题。
   - 标题框里按回车（或光标在末尾时按 ↓）调 `focus_body`：光标到正文开头，编辑器拿到焦点。
3. **F6 提的三件。**
   - **不会失败的构造**：`ChapterEditor::with_session(ws, book, doc, source, …)` 接外壳在后台线程开好的会话，可以直接放进 `cx.new`，不用再 `panic`。
   - **标题行按页边距排**：编辑器自己的标题行（没给章首时）现在和段落用同一个栏（两边各让出页边距，再居中、不超过纸宽），栏比纸窄时不再往左偏。
   - **渐变时不留住淡色**：GPUI 的缓存视图没被通知时，会照搬上一帧画好的东西，连当时的不透明度一起。新的 `ProseEditor::element_at_opacity(编辑器, 不透明度, cx)` 由宿主告诉编辑器它现在被画在多淡的地方：
     - 不透明度在变的那几帧，编辑器重新画；
     - 停下来以后，照常复用缓存。

     翻页叠化时外壳用它代替「每帧通知编辑器」。GPUI 对外不给读当前的不透明度，所以只能由宿主传进来；根本的修法是 GPUI 把不透明度算进缓存的判断，见「待协调」。
4. **@ 选择器。**
   - **触发**：打 `@`（或全角 `＠`）就弹出。行首、空格后、汉字后面都行，所以「他@叶」能用；`a@b.c` 这种邮箱写法不弹。
   - **候选**：要素名和别名（别名单独一行），再加章节和构想的标题，按包含关系筛（不分大小写），最多 30 行。没有哪个要素恰好叫这个名字时，最后一行是「创建要素「名字」」。
   - **按键**：↑↓ 换行（到头会绕回来），回车或点击选中，Esc 关掉（字留着），这个 @ 不再自己弹出。
   - **选中以后**：`@查询` 换成那个名字，链到它，后面加一个空格，算一步撤销。
   - **新建**：要素建在书的第一个分类里，然后链上。
5. **自动链接和断链修复。**
   - **自动链接**：作者停手半秒后，只看他打过字的段落（回车把一段拆成两段时，上面那半段也算）。名字按 dr-text 的匹配器找：原样、最长的优先、不重叠，一篇正文不链自己。
     - 已经链到同一个目标的不动；
     - 只链了一半的（链接被拆开了）补成整段；
     - 短名字链到别人、又被一个更长的名字整个盖住时，让给长名字。
     - 这些链接和那次打字算同一步撤销：按一次 ⌘Z，字和它的链接一起撤掉。
   - **断链修复**：作者的编辑把一个链接的字改得不再是它目标的名字或别名（比如从「约格」里删掉「格」），这段链接整段取下；改成同一目标的另一个别名的，链接留着。只看光标碰到的那个链接，所以本来就不是名字的旧链接（粘贴来的）不会被动。
   - **开关**：设置键 `editor.auto_entity_links`（默认开）关掉自动链接。
6. **斜杠菜单。**
   - **触发**：打 `/`（或 `／`）就弹出，查询到空格为止。
   - **候选**：正文、一级标题、二级标题、三级标题、引用、分隔线。按字筛，也认 `h1`、`quote`、`rule` 这类词。
   - **选中以后**：`/查询` 删掉，这一段改格式，算一步撤销。分隔线是单独的一段空段，光标落到它后面那一段。
   - **筛不出东西就不弹**：旧版会弹一个空菜单。
7. **选区浮条。**
   - **何时出现**：选中一段有字的文字，选区停下 180 ms（鼠标已松开）后浮出。位置在选区上方 8 px、居中；上面没地方就放到下面。
   - **按钮**：横向一条，正文、H1、H2、H3、引用 | 粗体、斜体、下划线、删除线 | 添加批注。
     - 旧版的「格式▾」二级弹层直接摊平在条上；
     - 「新建补丁」新版还没有。
     - 「添加批注」把选区的位置和文字交给宿主（`CommentRequested`），批注框是外壳的。
   - **何时消失**：一打字、选区一变（停下后再出来）、编辑器失去焦点、按 Esc，它就收起。
   - 只有这一条，不做右键菜单。
8. **画浮层用 dr-ui。** 选择器和斜杠菜单是 dr-ui 的 `Menu`（桌面色的板子、静止细玻璃边、浮起的阴影），浮条是同样的板子，里面放 dr-ui 的 `IconButton`，都经 dr-ui 的浮层放在窗口最上面，不会被裁掉。
9. **基准搬家**：见「测量」。

**要作者定的事：没有。** 和旧版不一样的地方都写在下面，理由也在。

## 截图

由 `examples/page-capture.rs` 不开窗口画：GPUI 的测试平台、macOS 的文字系统、Metal 画进离屏纹理。

- **章首、章末是示意**：样子是例子里的一个 `PageChrome`，正式的样子由 F6 定。
- **字体**：这台机器没有构建 dr-ui 的界面字体，菜单里的字是系统字体。
- **书**：书是合成的。

| 内容 | 图 |
| --- | --- |
| 章节页：页眉、标题、梗概、分隔线、正文（打字时自动链上的「约格」）、⁂ 和两个动作 | [page](f4e/page.png) |
| @ 选择器：名字、别名、「创建要素」 | [picker](f4e/picker.png) |
| 斜杠菜单 | [slash](f4e/slash.png) |
| 选区浮条 | [bar](f4e/bar.png) |
| 空章：提示（H1 #、H2 ##、H3 ###，外壳加的搜索和时间线）和 ⁂ | [empty](f4e/empty.png) |

## 给 F6 的用法

| 项 | 说明 |
| --- | --- |
| `PageChrome { head, end, head_estimate, end_estimate }` | 外壳实现：`head(&PageInfo, window, cx) -> Option<AnyElement>` 画在章首（代替标题行），`end` 画在章末；估计高度只在第一次画之前用 |
| `ChapterEditor::set_chrome(Some(Rc<dyn PageChrome>), cx)` / `BookEditor::set_chrome` | 装上；`None` 回到编辑器自己的标题行。全书模式在打开后马上装（列表会从头来） |
| `page_info()` / `BookEditor::page_info(doc)` | 这一页的 `PageInfo { doc, kind, number, title, synopsis, status, storyline, words, empty, act_opening }`，`finished()` |
| `page::{rename, set_synopsis, set_finished, new_chapter_after}` | 标题、梗概、⁂ 的动作，规则见上 |
| `page::EMPTY_HINTS` | 空章提示里编辑器知道的几行（H1 `#`、H2 `##`、H3 `###`）；搜索、时间线的键由外壳的键位表给 |
| `ChapterEditor::focus_body(window, cx)` / `BookEditor::focus_body(doc, …)` | 标题框的回车、末尾的 ↓ |
| `ChapterEditor::with_session(ws, book, doc, SessionSource, settings, window, cx)` | 不会失败的构造 |
| `ProseEditor::element_at_opacity(&editor, opacity, cx)` | 叠化里用，代替每帧通知 |
| `CommentRequested { doc, range, text }`（两个视图都发；单独的事件类型，已有的 `ChapterEditorEvent` 匹配不受影响） | 浮条的「添加批注」 |
| `EditorSettings::auto_entity_links`（键 `editor.auto_entity_links`） | 自动链接开关 |
| `assist()` | 选择器、浮条的状态（测试和外壳自己的检查用）；`assist::{trigger, BlockChoice, MenuRow, LINK_DELAY, BAR_DELAY}` |

## 对 `gpui-prose` 的改动

全是新加的，没改已有行为；共用文件里只加了字段、方法和匹配分支。

- **新文件 `src/slots.rs`**：
  - `ChapterSlots { head, end, head_estimate, end_estimate }`；
  - 章首、章末的列表项：按实际高度量进高度表，鼠标按下不往外传。
- **`src/layout/book.rs`**：
  - 新的项 `Item::End(章)`：只在宿主装了章首、章末时才有，否则项数和以前一样；
  - `Book::end_item`、`has_ends`。
- **`src/render/items.rs`**：
  - 标题项：有章首就画章首；
  - 新的 `Item::End` 分支；
  - 标题行加了页边距（和段落同一个栏）。
- **`src/editor.rs`**：
  - 字段 `slots`、`drawn_opacity`；
  - 方法：
    - `set_slots`、`slots_changed`、`focus_chapter_start`；
    - `element_at_opacity`；
    - `edit_chapter(章, HostStep::{Own, JoinLast}, …)`：宿主以作者身份改一章，要么单独一步撤销，要么并进上一步；
    - `caret_bounds`、`range_bounds`、`is_selecting`。
- **`src/text/doc.rs`、`src/text/undo.rs`**：`ProseDoc::join_last_step()`，下一次提交并进上一步撤销，不管隔了多久。
- **测试**：`slots.rs` 里三个，见下。

## 和旧版不一样的地方（有意的）

- **@ 在汉字后面也弹。** 旧版要求 @ 前面是空格，是 Tiptap 的默认值，没人选过它，中文句子里用不了。现在只排除 ASCII 字母和数字后面的 @（邮箱）。
- **自动链接只链作者打的字。** 旧版还会在打开文档时、别人（Agent、同步）写入后扫整篇，并以作者的名义写下链接。那样作者的撤销历史里会多出他没打过的字的链接。现在别人写的字该不该链，归他们自己的命令（F3 / M12，见「待协调」）。
- **自动链接和打字是同一步撤销。** 旧版用 `addToHistory:false`，链接不进历史；新版的撤销是按提交数的，链接写进去就得算在某一步里，所以并进触发它的那一步。效果相同：撤销打字时链接一起没了，不会单独多一步。
- **长名字盖过短名字的链接。** 旧版会在同一段字上叠两个不同目标的链接；新版让给长名字，不交叉。
- **斜杠菜单没有匹配时不弹。**
- **候选按码位排序。** 旧版用本地语言排序（中文按拼音）；新版暂时按码位排。要拼音顺序得加 ICU 的排序，以后再说。
- **浮条是一整条。** 旧版的「格式▾」二级弹层摊平在条上，少一次悬停；「新建补丁」新版还没有。

## 测试

- **`gpui-prose`（`src/slots.rs`）**：
  - `slots_take_the_title_row_and_follow_each_chapter`：章首代替标题行，章末跟在最后一段后面并随回车挪动；量到真实高度；点章首不挪光标；`focus_chapter_start` 把光标放到章首、拿到焦点。
  - `host_edits_undo_on_their_own_or_with_the_typing`：`JoinLast` 和打字一起撤，`Own` 单独撤。
  - `a_fading_editor_is_drawn_afresh_until_it_holds_still`：不透明度在变时重画，停下后复用缓存。
  - `layout::book` 的 `end_items_follow_each_chapter`。
- **`dr-editor/tests/page.rs`**（5 个）：页的数据跟着书目和打字变、宿主拿到的就是这份数据；改标题的旧规则；新建下一章的位置；空章和回车进正文；全书模式每章都有页，幕的开头有名字。
- **`dr-editor/tests/assist.rs`**（8 个）：
  - 打的名字自己链上，和打字一起撤；只链打过字的段落；
  - 名字被改坏后链接取下；
  - @ 选择器插入链接，撤销回到 `@查询`；
  - 选择器新建要素；
  - Esc 关掉后，这个 @ 不再弹出；
  - 斜杠菜单改标题级别、插分隔线；
  - 浮条在选区停下后出现，粗体、引用、批注都能用，一打字就收起。
- **单元测试**：`entity_links`（4 个：最长优先、补全拆开的链接、长名字盖短名字、断名字取链接、搜索）；`assist`（触发规则、斜杠的筛选）。

## 测量

这一批的交互本身没有新的预算项。数字来自搬家以后的基准程序。

**基准搬家。** `prose-bench` 从 `gpui-prose/examples/` 搬到了 `dr-editor/examples/prose-bench/`：

- **语料**：换成 F8 的重型种子（全书 100 章、约 165 万个字符；单章取最长的一章，22031 字、222 处人物链接）。
- **怎么打开**：经工作区会话（`SessionSource`）打开，和 Drifting 一样。
- **证据**：写成 F8 格式，`cargo xtask check` 核对。
- **超时和负载**：每个子命令都有总超时，负载超过 2 时程序自己标「仅供参考」。
- **去掉的子命令**：`milestone` 和 `check`，由 `cargo xtask check` 代替。
- **补丁版的证据**：打了 GPUI 补丁的那次（`PROSE_BENCH_GPUI=g1`），文件名带上补丁名，不覆盖原版的。
- **留在 `gpui-prose` 的**：`examples/editor.rs`，不依赖任何 `dr-*` 的小例子。

`window`、`present`、`idle` 要占屏，这一轮没跑，等空闲重测。

证据：[f4e-m2-prose-bench-headless.json](../acceptance/f4e-m2-prose-bench-headless.json)、[f4e-m2-prose-bench-decor.json](../acceptance/f4e-m2-prose-bench-decor.json)。M3 Pro，release，2026-11-08，一分钟负载 4.6–4.9（别的会话在编译），程序自己标了仅供参考。

| 项 | 预算 | 数字 | 说明 |
| --- | --- | ---: | --- |
| 打开全书（100 章的会话和文档，所有核） | ≤ 200 ms | 冷 52.8 ms，热 14–15 ms | 单线程热开 47.3 ms；镜像加索引约 33 MB |
| 打开最长的一章 | ≤ 80 ms | 冷 3.6 ms，热 0.43–0.48 ms | |
| 打一个字（经会话写入、落盘、事件回到镜像），p50 / p95 | 中位数 ≤ 2 ms | 0.30 / 0.34 ms | 同样的字打进内存里的 `LoroSource`：0.010 / 0.015 ms |
| 在人物链接中间打一个字，p50 / p95 / 最慢 | — | 0.32 / 4.5 / 322 ms | 打的字留在链接里（核对过） |
| 滚动一帧 p95（CPU，无装饰 → 1000 处装饰） | ≤ 16.7 ms | 0.157 → 0.248 ms | ×1.58 |
| 打字一帧 p95（编辑加整帧，无装饰 → 有装饰） | ≤ 16 ms | 2.37 → 8.93 ms | ×3.77 |

**两处值得看的：**

- **在人物链接中间打字，尾巴长。** 中位数和正文里一样，但 p95 是正文的十几倍，最慢一次 322 ms。插入和加链接本身只是两次 Loro 操作，多半是每次提交后的派生数据（链接的索引一类）在持有者线程上排在下一次写入前面。这要剖析，记进「待协调」。
- **有装饰时打字那一帧的 p95 变成约三到四倍。** 滚动只多一点。这是 F4d 画层的事，记进「待协调」。

## 要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 章首、章末的挂接点：页眉（第 N 章 · 故事线 · 字数）、可改的标题（自动换行，回车进正文）、梗概、章末 ⁂（完成或回到草稿，在后面新建一章）、空章提示；F6 接，`dr-editor` 给接口和编辑器里的位置 | 完成：位置（`ChapterSlots` / `PageChrome`）、数据（`PageInfo`）、动作（`page::*`）、回车进正文（`focus_body`）。标题和梗概的输入框是 F5 的无框多行输入（F6 已向 F5 提出），见「待协调」 | `slots.rs` 的测试、`tests/page.rs`、截图 |
| 2a | 接已打开会话的构造 | 完成 | `ChapterEditor::with_session`；`tests/page.rs` 用它打开 |
| 2b | 标题行按页边距排 | 完成 | `render/items.rs`（标题行用段落的栏） |
| 2c | 缓存画面不要连外层透明度一起沿用 | 完成（由宿主传不透明度；GPUI 补丁是根本修法） | `a_fading_editor_is_drawn_afresh_until_it_holds_still` |
| 3 | 人物链接的 @ 选择和直接新建要素（经会话写）、dr-text 匹配器做自动链接、断链修复 | 完成 | `tests/assist.rs`、`entity_links` 单元测试、截图 |
| 4 | 斜杠菜单 | 完成 | `the_slash_menu_turns_the_paragraph`、截图 |
| 5 | 选区浮条，横向，不做右键菜单 | 完成 | `the_selection_bar_shows_once_the_selection_settles`、截图 |
| 6 | `prose-bench` 搬进 `dr-editor`、语料换成 seed、证据改 F8 格式、`gpui-prose` 留一个不依赖 `dr-*` 的小例子 | 完成；占屏的三项（`window`、`present`、`idle`）在新语料上还没跑，等空闲重测 | `dr-editor/examples/prose-bench/`、[f4e-m2-prose-bench-headless.json](../acceptance/f4e-m2-prose-bench-headless.json)、[f4e-m2-prose-bench-decor.json](../acceptance/f4e-m2-prose-bench-decor.json) |

## 待协调

1. **F6（外壳）接上：**
   - 实现 `PageChrome`：页眉、标题框、梗概框、分隔线、⁂（悬停菜单照旧版 `ChapterEndOrnament`：标为完成 / 改回草稿、新建下一章、帮手审阅）、空章提示；在 `ChapterEditor::open` 之后 `set_chrome`。
   - 标题框回车、末尾 ↓ 调 `focus_body`；Esc 显示回原标题；失焦时 `page::rename` / `page::set_synopsis`。
   - 「新建下一章」调 `page::new_chapter_after`，打开新章，聚焦并全选标题。
   - 翻页叠化里用 `ProseEditor::element_at_opacity` 代替现在的 `repaint_turning`。
   - 外壳先在后台线程开会话，再用 `ChapterEditor::with_session`，不再 `panic`。
   - 订阅 `CommentRequested`，打开批注框。
   - 设置注册表加 `editor.auto_entity_links`（「自动要素链接」，默认开），变了调 `set_settings`。
   - 全书模式：`PageInfo::act_opening` 不为空时，在章首上面画这一幕的扉页（这样不用等 F4d 的画层，m05-book.md 待协调 1 可以由 F6 在章首里做）。
   - 浮层文字（「创建要素」「正文」「一级标题」…）现在只有中文，和旧版一样是写死的；外壳接 i18n 时可以给 `dr-editor` 一张词表。
2. **F5（dr-ui）：页面上的无框多行输入**（F6 已提）：标题和梗概的框，自动换行、按页面字体排、自动长高、组字照 `gpui-ime`。`dr-editor` 给的是数据和动作，框本身归 F5。
3. **F3：**
   - 别人写的字的自动链接：Agent 的 `prose.*` 命令、导入、Markdown 镜像合回时，按同一套规则（`dr_text::autolink`）在命令里链，进命令自己的撤销。编辑器只管作者打的字。
   - `comment.reanchor`、`todo.project` 照旧（这一轮由 F4d 接）。
4. **F4c：**
   - 「一批编辑一次提交」做好后，`dr-editor` 的宿主编辑可以合成一次提交。现在 `edit_chapter` 闭包里的每个 `ProseDoc` 操作各是会话的一次提交（插分隔线是三四次），撤销照样是一步。
   - 跨章选区以后，浮条和选择器按 `BookRange` 走。
5. **F4d：** 还没链上的名字（建议链接）的画法、TODO 标记的样子仍归画层。浮层和画层的悬停卡都在 dr-ui 的 `Popover` 层，同时出现时后画的在上面。
6. **在人物链接中间打字的长尾**（给 F2 / dr-index，或 F4a 剖析）：见「测量」。先确认是不是每次提交后的派生（链接索引）在持有者线程上排在下一次写入前面；是的话，派生挪到写入之后的空闲时做。
7. **有装饰时打字那一帧变慢**（给 F4d）：见「测量」。
8. **文档里的旧命令**（给各自的文档）：`f4d-render.md`（`decor`、`capture`）、`f4c-input.md`（手测命令）、`f8-testkit.md`（「基准换地方」那条已经做完）里还写着 `-p gpui-prose --example prose-bench` 和 `--out`。新写法是 `-p dr-editor --example prose-bench -- <子命令> --write`。`benchmarks.md` 和 `f4-editor.md` 已改。
9. **GPUI 补丁 G9（已记进台账，不急）：** 让视图缓存的判断也看元素的不透明度（`ViewElementCacheKey` 加一项）。有了它，`element_at_opacity` 就不需要宿主传值了。和 G1 一样，等可推送的 fork 再说。

## 下一轮怎么拆

| 子线 | 下一轮的活 |
| --- | --- |
| F4e 交互 | 选择器的拼音排序和拼音首字母筛选（要 ICU 排序或一张拼音表）；@ 选择器里的分组（要素 / 章节 / 构想分节）；章末 ⁂ 的帮手审阅；粘贴时的自动链接；斜杠菜单的「构想」「批注」等 Drifting 自己的条目（等对应模块） |
| F6 | 上面「待协调」1 |
| F5 | 无框多行输入 |
