# M03 章节页：章首与章末

## 内核 v5 DW：不编号，页头不看进不进成书（2026-11-15 夜里）

- App 不再给任何条目编号（作者：「所有正文APP都不编号。作者自己有需求自己编。」）：`PageInfo` 没有 `number`，页眉第一项一律是模板名（`folio_label`），键 `nodeEditor.folio.chapter`、`nodeEditor.folio.chapterNumber` 删了。下面 T3 那一节说的章号随之不再显示。
- 页头（`chrome`）不再跟着「第一篇进成书的正文」：给内容条目（模板 `linkable`、有字段模块）的第一篇正文（`dr_editor::v3::carries_page_head`）；构想、要素的正文不进成书以后照旧有页头，故事线、文件夹的「说明」和笔记照旧没有。`PageKind::Chapter` 是成书里的条目带页头的那一篇（成书从根读，构想下面的章也是）。

## 内核 v5 T3：章号对齐成书起点，关了成书时隐藏章号（2026-11-15）

- 页眉（`dr-view-page/src/head.rs`、`v3.rs`）的章号与通览位置统一走 `BookStructureV3::book_sequence()`（随 `BookRoot::{Entry, View, Lane}` 切换，和整书字数、成稿导出严格一致；回归见 `dr-view-page/tests/v3.rs`）。
- 项目关掉「成书」（`project.book.is_none()`）时，页眉隐藏「第 N 章」与页眉字数，章末原来收起 ⁂ 的「标为完成 / 新建下一章」动作（⁂ 2026-11-17 整个去掉了，章末不再跟着成书变）。

2026-11-08，F5 这一路做（分支 `claude/f5-ui-254e54`，从 main `1652a95e`；第二轮从 main `60d510a6` 加上 F4e 第四批：幕扉页的序号和章数字数、构想页的章首）。代码在新 crate `next/crates/dr-view-page`，它实现 `dr-editor` 的 `PageChrome`（F4e 留的章首、章末位置，见 [f4e-editor.md](../foundations/f4e-editor.md)）。输入框、⁂ 菜单的 cell、页面上的字号间距都来自 dr-ui（F5，见 [f5-ui.md](../foundations/f5-ui.md)）。外壳只加了挂接点，逐条列在下面。M03 里工具栏的 ⋯ 菜单是 F6 做的，不在这里。

## 旧模块收尾：构想页的分组路径（2026-11-08）

- 构想页页眉补上旧版已有的「构想 · 组 - 子组 · 字数」，分组前沿用 `DriftGroup` 记号；不在分组里时不画这一项。路径写法来自 `NodeEditorView.tsx` 的 `driftGroupChain`，没有新增文案或导航。
- 页保持打开时，改组名、移动构想、删除分组后路径跟着外壳的书目快照更新。只读 `PageHost.workspace` 的 `Book.ideas` / `idea_groups`；没有扩展 `PageInfo`、没有加查询，也不改 F3、F4c 或 M16 的转换流程。
- 契约在 `dr-view-page/tests/idea_group_path.rs`：用 `dr_testkit::samples::a_q`，核对两层路径、改名、移出与移回、删除子组和父组，以及章节不显示构想组。真实窗口场景是 `dr-cli/scenarios/idea-group-path.json`，由调试桥读取实际界面路径并核对变化。
- 真窗口浅色、深色各 25/25 步通过，场景退出时关闭应用；[浅色](m03/page-idea-group-light.png)、[深色](m03/page-idea-group-dark.png)是展示库《慢钟》中已有构想的实际窗口。
- 验证基线为 main `f5ca535b`，交回分支 `codex/legacy-m03-group-path`。`cargo test -p dr-view-page --locked` 8 项通过；全工作区 `fmt --check`、`clippy --all-targets --locked -- -D warnings`、`test --locked`（1675 通过、22 忽略）、`cargo xtask check` 和根目录 `pnpm public:check` 全过。xtask 的既有性能证据过时提示与 12 条依赖维护/健全性 notice 保留，audit 为 0 vulnerabilities；本轮没有重跑空闲机器性能测量。
- 这个里程碑只补构想页分组路径。（当时留着的「⁂ 的键盘框架」「帮手审阅」两样，随 ⁂ 去掉不用做了，见下一条。）
- **章末 ⁂ 去掉了**（作者 2026-11-16：「移除章末⁂的功能。」「连记号去掉」，[kernel-v5.md](../kernel-v5.md) 第 15 节第 34 条；2026-11-17 做，任务书 EM）。章末不再画 ⁂，也不再展开「标为完成／改回草稿」「新建下一章」，键盘进出 ⁂ 和「帮手审阅」都不做了。章末现在只有空章提示和页面底下的留白（80 px）；原来 ⁂ 占的那 80 px 高度跟着没有了。写作状态是这一章「章节信息」里的一个字段，在条目页上改。`dr-editor` 的 `page::set_finished`、`page::new_chapter_after` 还在、有自己的测试，但现在没有界面调它们。下文讲 ⁂ 的地方都改成了现状，截图是去掉之前的。

## 大白话

每一章的正文上面和下面多了旧版章节页上的东西，跟着正文一起滚动：

- **章首**
  - **页眉**：「第 N 章 · 故事线 · 字数」，故事线前面是它颜色的砂笔短横；小号等宽字、最淡的墨，下面一条虚线。
  - **标题**：一个看不出边框的大字输入框（页面的正文字体，42 px），太长会换行。回车，或者光标在最后时按 ↓，光标进正文开头；Esc 放回原来的标题；离开输入框时存下。清空了再离开不会存，框里显示回原标题；和别的章重名时 F3 会加「 2」。
  - **梗概**：同样没有边框，比正文小 2 px、次一档的墨，可以写几段。离开时存下（可以清空），Esc 放回原来的。
  - **分隔线**，然后是正文。
  - **通览全书**里，开一幕的那一章上面先画这一幕的扉页，照旧版：结构字的「第一幕」（中文用汉字数字，十、十一、二十一……，一百起写阿拉伯数字；别的语言用罗马数字，"Act IV"），下面幕名，一笔干笔，再下面等宽小字「9 章 · 3.3k 字」（字数除以一千、四舍五入到一位小数，0 也写「0.0k」）。上下留大片空白。章数和字数是 F4 给的，作者一打字就跟着变。
- **章末**
  - **空章提示**：正文是空的时候，在第一行下面淡淡地写两列：H1 `#`、H2 `##`、H3 `###`、全局搜索、时间线和它们现在的快捷键（跟着键位设置变）。打一个字就消失。
  - ~~**⁂**（砂笔的三尊石）和它展开的两个动作「标为完成／改回草稿」「新建下一章」~~：2026-11-17 去掉了，见上面「章末 ⁂ 去掉了」。
  - ~~**新建下一章**（新章紧跟在这一章后面、打开并选中标题）~~：随 ⁂ 去掉。别的新建入口调 `focus_new_title`，新条目打开时标题照样拿到光标、全选。
- **构想页**：和章节页一样的章首，页眉写「构想 · 字数」，标题（占位是「无标题构想」）和梗概同样可改、同样的键，存进构想自己（F4 的 `page::rename`、`set_synopsis` 认得构想，走 `idea.update`）。章末只有空页提示（⁂ 2026-11-17 去掉了）。要素、类目、故事线页归 M11、M13，这里不管。

存标题、梗概、改状态、新建章节都经 `dr-editor` 的 `page::*` 在后台线程做，界面上的数字和名字等编辑器拿到 F3 的新数据再变。

## 截图

在 `next/` 下跑（要先建好字体，见 F5）：

```bash
cargo run -p dr-view-page --features capture --example page-capture -- ../docs/rust-rewrite/modules
```

真的外壳、离屏画，书是 dr-testkit 的展示库里的《慢钟》（它自带分幕），截图程序用 F3 的命令在第一章后面加了一章空章、加了一条构想。2 倍像素，压成 256 色。

| 内容 | 浅色 | 深色 |
| --- | --- | --- |
| 章首：页眉、标题、梗概、分隔线 | [page-head-light](m03/page-head-light.png) | [page-head-dark](m03/page-head-dark.png) |
| 空章：提示（截图是去掉 ⁂ 之前的：图里的 ⁂ 和两个动作现在没有了；截图程序已经不在，等视觉打磨那一轮重截） | [page-empty-light](m03/page-empty-light.png) | [page-empty-dark](m03/page-empty-dark.png) |
| 构想页：页眉「构想 · 字数」、标题、梗概 | [page-idea-light](m03/page-idea-light.png) | [page-idea-dark](m03/page-idea-dark.png) |
| 通览全书：幕的扉页「第一幕 / 卷一 回乡 / 9 章 · 3.3k 字」在第一章上面 | [page-book-light](m03/page-book-light.png) | [page-book-dark](m03/page-book-dark.png) |

## 外壳和别处的挂接点（逐条）

1. **`dr-shell/src/pages.rs`**：新的 `set_page_chrome(cx, |PageHost, window, cx| Rc<dyn PageChrome>)`，和 `set_shelf`、`set_home` 一个样子；`PageHost { workspace, library, book, editor }` 给 chrome 用（`editor` 是 `PageEditorRef::Doc` / `Book`，弱引用）；`make_chrome` 只在 crate 里用。
2. **`dr-shell/src/workspace/editors.rs` 的 `editor_prepared`**：编辑器建好以后，如果有人注册了 chrome，就造一个 `set_chrome` 装上（单章和全书都装）；为此多 clone 了一份 `library`。外壳别的地方没动。
3. **`app/drifting`**：依赖加 `dr-view-page`，`main.rs` 在 `dr_view_home::init` 后面调 `dr_view_page::init(cx)`。
4. **`dr-i18n/keys.txt`**：加了旧版的 13 个键（页眉、标题和梗概的占位、⁂ 的动作、空章提示），`locales/` 由 `script/sync-locales.py` 重新生成。
5. **`next/Cargo.toml`**：成员和依赖各一行。
6. 新建条目打开前，把它的 `Target::key()`（`entry:<id>`）交给 `dr_view_page::focus_new_title`，然后用 `Open::KEEP.at_title()` 固定打开。条目页头第一次画出来时取走意图，把键盘交给标题并全选。没有正文模块的条目也走同一个页头。

没装 chrome 的地方（外壳自己的测试、截图）照旧画编辑器自己的标题行。

## 测试

`cargo test -p dr-view-page`，真的工作区（临时库）、真的编辑器、GPUI 测试平台：

- 标题里打字后回车：键盘到了正文，离开时标题存进了 F3；
- 构想页：标题和梗概离开时存进构想；
- Esc 放回原标题；清空再离开不存，框里回到原标题；
- 梗概离开时存下；
- 章末只画页面底下的留白：写了字的一章，章末那一块正好是 80 px 高，没有记号、没有动作；空的一章多出空章提示（`the_end_draws_only_the_room_under_the_text`）。刚建的一章（别的新建入口调 `focus_new_title`）打开时标题拿到焦点、全选（`a_chapter_just_made_opens_with_its_title_selected`）。

另有千分位、幕序号（汉字数字和罗马数字）、「x.xk」的单元测试。测试窗口要先激活：GPUI 只在活动窗口里报焦点变化，不激活就收不到失焦。

## 和旧版不一样的地方

- **页眉里没有幕和状态。** 旧版的页眉就是「第 N 章 · 故事线 · 字数」，完成与否原来看 ⁂ 的颜色（⁂ 2026-11-17 去掉了，现在看「章节信息」里的写作状态）；`PageInfo` 也只在开幕那一章带幕名。
- **幕扉页的字距。** 旧版「第一幕」和幕名有字距（`letter-spacing`），GPUI 做不了。
- **构想页的分组路径已补齐**（旧模块收尾）：沿用旧版的「构想 · 组 - 子组 · 字数」。
- **没有 ⁂**（2026-11-17 起）：旧版章末的 ⁂ 和它的菜单（标为完成、新建下一章、帮手审阅）新版都没有，作者定的。
- ~~**⁂ 和动作之间的变换没有模糊**~~：⁂ 去掉了，不再适用。
- **页眉下的点线是虚线**（GPUI 只有实线和虚线）。
- **空章提示没有 240 ms 的淡入。**

## 待协调

1. ~~**F6：「新建下一章」后打开并全选标题。**~~ 外壳已提供 `Open::KEEP.at_title()`，⁂ 新建下一章已使用；外壳跳过正文聚焦，章首取走 `NewTitles` 意图后聚焦并全选标题。别的新建入口可以复用上面的 `focus_new_title` 接口。
2. **F6：装了 chrome 的章节页不用再 `set_title`。** 章首代替了编辑器的标题行，外壳在 `editor_prepared` 里调的 `set_title` 对章节页已经多余（无害）。
3. ~~**F6：键盘进出 ⁂**~~：⁂ 去掉了（2026-11-17），不用做。
4. ~~**F4（dr-editor）：**~~（F4e 第四批已做，见 [f4e-editor.md](../foundations/f4e-editor.md#第四批2026-11-08-夜)；dr-view-page 已照下面的用法接上：扉页、构想页的标题和梗概。F4 的分支在 F5 分支里先合了进来，见 f5-ui.md 第六轮。）
   - ~~`PageInfo` 加这一章所在的幕、幕的序号、章数和字数，扉页才能画「第一幕」和「N 章 · x 千字」；~~
     - **字段**：全书视图里，开一幕的那一章的 `PageInfo::act_page` 是 `Some(ActPage { name, ordinal, chapters, words })`。别的章是 `None`，单章页面上也是 `None`。
     - **序号**：`ordinal` 照旧版 `deriveActSegments`，数书里所有的幕，空幕和书首的幕也算。
     - **章数和字数**：`chapters` 是这一幕到下一幕之前的章数。`words` 是这些章的字数（prose-metrics 的规则，和页眉一样），作者一打字就跟着变，编辑器会请宿主重画那一章的章首。
     - **旧版的写法**：序号是「第{n}幕」（中文用汉字数字，1–99，十、十一、二十一……，超出用阿拉伯数字；英文用罗马数字 "Act IV"）。下面一行是「{N} 章 · {x.x}k 字」：字数除以一千保留一位小数，0 也写「0.0k」，英文 "{N} chapters · {x.x}k words"。旧版里没有「千字」这个写法。这两样格式由 dr-view-page 拼。
   - ~~构想页的标题和梗概要 `idea.update` 的动作（现在的 `page::rename` / `set_synopsis` 只改章节），有了以后构想页也可以用这里的章首。~~
     - `page::rename(lib, book, doc, title)` 和 `page::set_synopsis(lib, book, doc, text)` 现在认得构想页（`node:<构想 id>`），走 `idea.update`，规则和章节一样：去掉首尾空白，空标题不存，没变不写。
     - 构想页的 `PageInfo` 是 `kind: PageKind::Idea`，带 `title`、`synopsis` 和 `status`（`drifting` / `resting`）。所以 dr-view-page 可以照章节页接管构想页的标题和梗概。构想页没有 ⁂ 的完成和新建下一章（`set_finished` / `new_chapter_after` 仍只对章节）。
5. ~~**M30（Agent）：** ⁂ 菜单里的「帮手审阅」。~~ ⁂ 去掉了（2026-11-17），这个入口不做。
6. ~~**F4（dr-editor）：** 构想页的页眉要构想所在的组。~~ 已在本模块补齐：直接读外壳已有的书目快照并监听更新，不必扩展 `PageInfo`。

## 内核 v4 · 统一条目页眉与章末（T1，2026-11-13）

按 `kernel-v4.md` 第 9、14 节去掉按固定模板 id（如章节／构想模板 id）区分页面的分支：

- **`PageKind` 收为两种**：在成书序列（`BookStructureV3::manuscript`）里拿到编号 `ordinal` 的主成书正文为 `PageKind::Chapter`（页眉写「第 N 章」）；其余主成书正文一律为 `PageKind::Other`（页眉写条目当前模板名，无模板时写「条目」）。标题为空时的占位文案统一拼模板名（「无标题<模板名>」，无模板时写「无标题条目」）。
- **颜色与路径**：`PageInfo::color` 与外壳 `BookV3::appearance` 一致，优先取条目自身颜色角色字段值，其次模板色，最后取开关开着的有效泳道颜色；条目有自身颜色且不带有效泳道线标时，页眉前沿展示该颜色记号。非成书条目的分组路径沿当前开着「层级」开关的上层住处链拼接。
- **角色驱动的梗概与章末动作**：模板声明了摘要角色字段（`summary_field`）时才渲染梗概框并参与退出排空；模板声明了状态角色字段（`status_field`）时 ⁂ 才提供「标为完成／改回草稿」，成书条目始终保留「新建下一章」（沿用当前条目的模板 id，不硬编码内置章节模板）；这半句 2026-11-17 起不再适用，⁂ 去掉了，状态角色字段只是条目页上的一个字段。`in_book = false` 的说明正文与同一条目的第二篇起的正文不挂接章首章末（`page.chrome = false`）。

## 内核 v5 · T5 条目页媒体模块（2026-11-15）

按 [kernel-v5.md 第 6 节](../kernel-v5.md#6-正文只有一种格式档) 与 `v5-tracks.md` 的 T5（任务书 2026-11-18 删了，最后一版 `git show 64563601b:docs/rust-rewrite/handoff/v5-tracks.md`），在 `next/crates/dr-view-page/src/media.rs` 实现条目页媒体模块（`ModuleKind::Media`）：

- **三种摆法与单条目覆盖**：「大图」（`featured`：主舞台大图或 PDF 首页、下方行内说明、底部缩略图切换条与末尾 `+`）、「网格」（`grid`：三列卡片、下方行内说明）、「列表」（`list`：缩略图、文件名、行内说明、右侧种类与页数）。默认读模板摆法；指针移入模块时标题行右侧露出摆法切换与 `+`，切换摆法写 `module.set_arrangement` 仅覆盖当前条目（可一键「恢复模板默认」清回 `None`），不改模板本身。
- **说明、悬停卡与拖放调序**：每项的 `caption` 支持行内编辑（走 `media.set` 落盘，空说明仅在指针悬停该项时露出「说明」占位）。每项挂 `248px` 悬停卡（打开、在素材库里找到、从这里拿走；批注行留给 T6）。左上角拖动手柄支持模块内拖动调序（`media.reorder`），接收从右栏素材库拖入的 `dr_ui::AssetDrag` 或系统外部文件拖入；`+` 打开 `340px` 挑文件小窗（搜索、素材夹筛选、三列缩略图、「从电脑选…」），已在当前媒体模块里的文件灰显禁选，确保同一文件在同一媒体模块只出现一次。
- **缺失占位与「用在」砂框**：文件本身或其所在素材夹进入最近删除（或文件被永久清除）时，该项渲染为虚线占位（图标、删除线文件名、可恢复时的「恢复」按钮与「从这里拿走」；祖夹被删时点击「恢复」一并恢复祖夹与文件）。从素材库或查看器点「用在」跳到媒体项时，滚入视口并绘制 `SandFrame` 砂框动画。永久回归见 `dr-view-page/tests/v5_media.rs`。

## 内核 v5 · 空着的「说明」和新条目的标题（2026-11-18 作者定的）

kernel-v5 第 15 节第 53、54 条，作者「全照建议」。

- **空着的「说明」只留一行高**（[v5-followups.md](../handoff/v5-followups.md) 的 SF）：按模块的「进成书」开关认，不进成书的正文空着时一行高、写了字往下长；进成书的照旧至少 160。原来一律 160。
- NE 让新建的条目打开时选中标题。左栏卡和条目页两块中的「新建」直接建立「未命名」。`NewTitles` 按条目识别标题聚焦意图，正文模块加载时让出首次焦点。回车保存改名，有正文时光标进第一篇正文。无正文条目、整段选区和替换标题见 `dr-view-elements/tests/v5_kb_keyboard.rs`。
