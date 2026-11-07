# M03 章节页：章首与章末

2026-11-08，F5 这一路做（分支 `claude/f5-ui-254e54`，从 main `1652a95e`）。代码在新 crate `next/crates/dr-view-page`，它实现 `dr-editor` 的 `PageChrome`（F4e 留的章首、章末位置，见 [f4e-editor.md](../foundations/f4e-editor.md)）。输入框、⁂ 菜单的 cell、页面上的字号间距都来自 dr-ui（F5，见 [f5-ui.md](../foundations/f5-ui.md)）。外壳只加了挂接点，逐条列在下面。M03 里工具栏的 ⋯ 菜单是 F6 做的，不在这里。

## 大白话

每一章的正文上面和下面多了旧版章节页上的东西，跟着正文一起滚动：

- **章首**
  - **页眉**：「第 N 章 · 故事线 · 字数」，故事线前面是它颜色的砂笔短横；小号等宽字、最淡的墨，下面一条虚线。
  - **标题**：一个看不出边框的大字输入框（页面的正文字体，42 px），太长会换行。回车，或者光标在最后时按 ↓，光标进正文开头；Esc 放回原来的标题；离开输入框时存下。清空了再离开不会存，框里显示回原标题；和别的章重名时 F3 会加「 2」。
  - **梗概**：同样没有边框，比正文小 2 px、次一档的墨，可以写几段。离开时存下（可以清空），Esc 放回原来的。
  - **分隔线**，然后是正文。
  - **通览全书**里，开一幕的那一章上面先画这一幕的扉页：幕名居中，下面一笔干笔，上下留大片空白。
- **章末**
  - **空章提示**：正文是空的时候，在第一行下面淡淡地写两列：H1 `#`、H2 `##`、H3 `###`、全局搜索、时间线和它们现在的快捷键（跟着键位设置变）。打一个字就消失。
  - **⁂**（砂笔的三尊石）：平时是最淡的墨，这一章标为完成后是强调色。指针在上面停 70 ms（或者点一下），它缩小淡去，两个动作从它那一行展开成一列：「标为完成」（完成后是「改回草稿」）和「新建下一章」，各带一个砂笔图标；指着哪个，它四周出一圈流动的细玻璃。移开就收回 ⁂。悬停打开后 250 ms 内的点击不算（那一下是点在 ⁂ 上的）。
  - **新建下一章**：新章紧跟在这一章后面（不跨幕，草稿，不在任何故事线上，名字是「新章节」）。在单章页面里，它在新标签页打开，标题已经拿到光标、全选，直接打字就是改名；在通览全书里，新章出现在滚动里，它的标题同样拿到光标。
- **构想页**：保留编辑器自己的标题行，章末有 ⁂（不带菜单）和空页提示。要素、故事线等别的页面不加东西。

存标题、梗概、改状态、新建章节都经 `dr-editor` 的 `page::*` 在后台线程做，界面上的数字和名字等编辑器拿到 F3 的新数据再变。

## 截图

在 `next/` 下跑（要先建好字体，见 F5）：

```bash
cargo run -p dr-view-page --features capture --example page-capture -- ../docs/rust-rewrite/modules
```

真的外壳、离屏画，书是 dr-testkit 的展示库里的《慢钟》（它自带分幕），截图程序用 F3 的命令在第一章后面加了一章空章。2 倍像素，压成 256 色。

| 内容 | 浅色 | 深色 |
| --- | --- | --- |
| 章首：页眉、标题、梗概、分隔线 | [page-head-light](m03/page-head-light.png) | [page-head-dark](m03/page-head-dark.png) |
| 空章：提示，⁂ 展开成两个动作 | [page-empty-light](m03/page-empty-light.png) | [page-empty-dark](m03/page-empty-dark.png) |
| 通览全书：幕的扉页「卷一 回乡」在第一章上面 | [page-book-light](m03/page-book-light.png) | [page-book-dark](m03/page-book-dark.png) |

## 外壳和别处的挂接点（逐条）

1. **`dr-shell/src/pages.rs`**：新的 `set_page_chrome(cx, |PageHost, window, cx| Rc<dyn PageChrome>)`，和 `set_shelf`、`set_home` 一个样子；`PageHost { workspace, library, book, editor }` 给 chrome 用（`editor` 是 `PageEditorRef::Doc` / `Book`，弱引用）；`make_chrome` 只在 crate 里用。
2. **`dr-shell/src/workspace/editors.rs` 的 `editor_prepared`**：编辑器建好以后，如果有人注册了 chrome，就造一个 `set_chrome` 装上（单章和全书都装）；为此多 clone 了一份 `library`。外壳别的地方没动。
3. **`app/drifting`**：依赖加 `dr-view-page`，`main.rs` 在 `dr_view_home::init` 后面调 `dr_view_page::init(cx)`。
4. **`dr-i18n/keys.txt`**：加了旧版的 13 个键（页眉、标题和梗概的占位、⁂ 的动作、空章提示），`locales/` 由 `script/sync-locales.py` 重新生成。
5. **`next/Cargo.toml`**：成员和依赖各一行。

没装 chrome 的地方（外壳自己的测试、截图）照旧画编辑器自己的标题行。

## 测试

`cargo test -p dr-view-page`，真的工作区（临时库）、真的编辑器、GPUI 测试平台：

- 标题里打字后回车：键盘到了正文，离开时标题存进了 F3；
- Esc 放回原标题；清空再离开不存，框里回到原标题；
- 梗概离开时存下；
- ⁂ 的「标为完成」再按一次变回草稿（页面先收到 F3 的新状态）；「新建下一章」把新章放在这一章和下一章中间，叫「新章节」；打开它时标题拿到焦点、全选。

另有千分位的单元测试。测试窗口要先激活：GPUI 只在活动窗口里报焦点变化，不激活就收不到失焦。

## 和旧版不一样的地方

- **页眉里没有幕和状态。** 旧版的页眉就是「第 N 章 · 故事线 · 字数」，完成与否看 ⁂ 的颜色；`PageInfo` 也只在开幕那一章带幕名。
- **幕的扉页只有幕名和一笔干笔。** 旧版还有「第一幕」序号和「N 章 · x 千字」，`PageInfo` 现在没给（见「待协调」F4）；旧版的字距（`letter-spacing`）GPUI 做不了。
- **⁂ 菜单少了「帮手审阅」**，等 Agent 模块（M30）。键盘还打不开它（旧版能 Tab 到 ⁂ 再用方向键选）：等外壳的焦点框架，`PageEnd::open_actions` 和 `choose(EndAction)` 已经留好。
- **⁂ 和动作之间的变换没有模糊**（GPUI 不能模糊元素），只有缩放、淡入淡出和展开。
- **页眉下的点线是虚线**（GPUI 只有实线和虚线）。
- **空章提示没有 240 ms 的淡入。**

## 待协调

1. **F6：「新建下一章」后打开并全选标题。** dr-view-page 在单章页面里调了外壳现成的 `Workspace::open(Target::Chapter(…), Open::KEEP)`，并记下「这一章的标题要拿光标」；新页第一次画出时标题拿到焦点、全选（测试守着）。这能成立是因为外壳的 `focus_page` 在新编辑器建好时先把键盘给编辑器，章首第一次画在那之后，标题的焦点又放在这一帧画完以后。外壳以后如果改成晚一步再给编辑器焦点，就会抢走标题的。更稳的做法是外壳认这个意图，比如打开时带上「聚焦标题」，`focus_page` 遇到它就跳过。
2. **F6：装了 chrome 的章节页不用再 `set_title`。** 章首代替了编辑器的标题行，外壳在 `editor_prepared` 里调的 `set_title` 对章节页已经多余（无害）。
3. **F6：键盘进出 ⁂**（Tab 到 ⁂、方向键选、回车做），等外壳的焦点框架。
4. ~~**F4（dr-editor）：**~~（F4e 第四批已做，见 [f4e-editor.md](../foundations/f4e-editor.md#第四批2026-11-08-夜)）
   - ~~`PageInfo` 加这一章所在的幕、幕的序号、章数和字数，扉页才能画「第一幕」和「N 章 · x 千字」；~~
     - **字段**：全书视图里，开一幕的那一章的 `PageInfo::act_page` 是 `Some(ActPage { name, ordinal, chapters, words })`。别的章是 `None`，单章页面上也是 `None`。
     - **序号**：`ordinal` 照旧版 `deriveActSegments`，数书里所有的幕，空幕和书首的幕也算。
     - **章数和字数**：`chapters` 是这一幕到下一幕之前的章数。`words` 是这些章的字数（prose-metrics 的规则，和页眉一样），作者一打字就跟着变，编辑器会请宿主重画那一章的章首。
     - **旧版的写法**：序号是「第{n}幕」（中文用汉字数字，1–99，十、十一、二十一……，超出用阿拉伯数字；英文用罗马数字 "Act IV"）。下面一行是「{N} 章 · {x.x}k 字」：字数除以一千保留一位小数，0 也写「0.0k」，英文 "{N} chapters · {x.x}k words"。旧版里没有「千字」这个写法。这两样格式由 dr-view-page 拼。
   - ~~构想页的标题和梗概要 `idea.update` 的动作（现在的 `page::rename` / `set_synopsis` 只改章节），有了以后构想页也可以用这里的章首。~~
     - `page::rename(lib, book, doc, title)` 和 `page::set_synopsis(lib, book, doc, text)` 现在认得构想页（`node:<构想 id>`），走 `idea.update`，规则和章节一样：去掉首尾空白，空标题不存，没变不写。
     - 构想页的 `PageInfo` 是 `kind: PageKind::Idea`，带 `title`、`synopsis` 和 `status`（`drifting` / `resting`）。所以 dr-view-page 可以照章节页接管构想页的标题和梗概。构想页没有 ⁂ 的完成和新建下一章（`set_finished` / `new_chapter_after` 仍只对章节）。
5. **M30（Agent）：** ⁂ 菜单里的「帮手审阅」。
