# M03 章节页：章首与章末

2026-11-08，F5 这一路做（分支 `claude/f5-ui-254e54`，从 main `1652a95e`；第二轮从 main `60d510a6` 加上 F4e 第四批：幕扉页的序号和章数字数、构想页的章首）。代码在新 crate `next/crates/dr-view-page`，它实现 `dr-editor` 的 `PageChrome`（F4e 留的章首、章末位置，见 [f4e-editor.md](../foundations/f4e-editor.md)）。输入框、⁂ 菜单的 cell、页面上的字号间距都来自 dr-ui（F5，见 [f5-ui.md](../foundations/f5-ui.md)）。外壳只加了挂接点，逐条列在下面。M03 里工具栏的 ⋯ 菜单是 F6 做的，不在这里。

## 旧模块收尾：构想页的分组路径（2026-11-08）

- 构想页页眉补上旧版已有的「构想 · 组 - 子组 · 字数」，分组前沿用 `DriftGroup` 记号；不在分组里时不画这一项。路径写法来自 `NodeEditorView.tsx` 的 `driftGroupChain`，没有新增文案或导航。
- 页保持打开时，改组名、移动构想、删除分组后路径跟着外壳的书目快照更新。只读 `PageHost.workspace` 的 `Book.ideas` / `idea_groups`；没有扩展 `PageInfo`、没有加查询，也不改 F3、F4c 或 M16 的转换流程。
- 契约在 `dr-view-page/tests/idea_group_path.rs`：用 `dr_testkit::samples::a_q`，核对两层路径、改名、移出与移回、删除子组和父组，以及章节不显示构想组。真实窗口场景是 `dr-cli/scenarios/idea-group-path.json`，由调试桥读取实际界面路径并核对变化。
- 真窗口浅色、深色各 25/25 步通过，场景退出时关闭应用；[浅色](m03/page-idea-group-light.png)、[深色](m03/page-idea-group-dark.png)是展示库《慢钟》中已有构想的实际窗口。
- 验证基线为 main `f5ca535b`，交回分支 `codex/legacy-m03-group-path`。`cargo test -p dr-view-page --locked` 8 项通过；全工作区 `fmt --check`、`clippy --all-targets --locked -- -D warnings`、`test --locked`（1675 通过、22 忽略）、`cargo xtask check` 和根目录 `pnpm public:check` 全过。xtask 的既有性能证据过时提示与 12 条依赖维护/健全性 notice 保留，audit 为 0 vulnerabilities；本轮没有重跑空闲机器性能测量。
- M03 仍未全部完成：⁂ 的键盘框架留给作者定设计；帮手审阅由 M30 接。这个里程碑只补构想页分组路径。

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
  - **⁂**（砂笔的三尊石）：平时是最淡的墨，这一章标为完成后是强调色。指针在上面停 70 ms（或者点一下），它缩小淡去，两个动作从它那一行展开成一列：「标为完成」（完成后是「改回草稿」）和「新建下一章」，各带一个砂笔图标；指着哪个，它四周出一圈流动的细玻璃。移开就收回 ⁂。悬停打开后 250 ms 内的点击不算（那一下是点在 ⁂ 上的）。
  - **新建下一章**：新章紧跟在这一章后面（不跨幕，草稿，不在任何故事线上，名字是「新章节」）。在单章页面里，它在新标签页打开，标题已经拿到光标、全选，直接打字就是改名；在通览全书里，新章出现在滚动里，它的标题同样拿到光标。
- **构想页**：和章节页一样的章首，页眉写「构想 · 字数」，标题（占位是「无标题构想」）和梗概同样可改、同样的键，存进构想自己（F4 的 `page::rename`、`set_synopsis` 认得构想，走 `idea.update`）。章末有 ⁂（不带菜单，构想没有完成和下一章）和空页提示。要素、类目、故事线页归 M11、M13，这里不管。

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
| 空章：提示，⁂ 展开成两个动作 | [page-empty-light](m03/page-empty-light.png) | [page-empty-dark](m03/page-empty-dark.png) |
| 构想页：页眉「构想 · 字数」、标题、梗概 | [page-idea-light](m03/page-idea-light.png) | [page-idea-dark](m03/page-idea-dark.png) |
| 通览全书：幕的扉页「第一幕 / 卷一 回乡 / 9 章 · 3.3k 字」在第一章上面 | [page-book-light](m03/page-book-light.png) | [page-book-dark](m03/page-book-dark.png) |

## 外壳和别处的挂接点（逐条）

1. **`dr-shell/src/pages.rs`**：新的 `set_page_chrome(cx, |PageHost, window, cx| Rc<dyn PageChrome>)`，和 `set_shelf`、`set_home` 一个样子；`PageHost { workspace, library, book, editor }` 给 chrome 用（`editor` 是 `PageEditorRef::Doc` / `Book`，弱引用）；`make_chrome` 只在 crate 里用。
2. **`dr-shell/src/workspace/editors.rs` 的 `editor_prepared`**：编辑器建好以后，如果有人注册了 chrome，就造一个 `set_chrome` 装上（单章和全书都装）；为此多 clone 了一份 `library`。外壳别的地方没动。
3. **`app/drifting`**：依赖加 `dr-view-page`，`main.rs` 在 `dr_view_home::init` 后面调 `dr_view_page::init(cx)`。
4. **`dr-i18n/keys.txt`**：加了旧版的 13 个键（页眉、标题和梗概的占位、⁂ 的动作、空章提示），`locales/` 由 `script/sync-locales.py` 重新生成。
5. **`next/Cargo.toml`**：成员和依赖各一行。
6. **新建入口（M02 等）**：打开新章节或构想前，调 `dr_view_page::focus_new_title(doc, cx)`，然后用外壳的 `Open::KEEP.at_title()` 打开；章首第一次画出来时取走这个意图，把键盘交给标题框并全选。沿用 ⁂ 的同一套 `NewTitles`，不另造聚焦机制。

没装 chrome 的地方（外壳自己的测试、截图）照旧画编辑器自己的标题行。

## 测试

`cargo test -p dr-view-page`，真的工作区（临时库）、真的编辑器、GPUI 测试平台：

- 标题里打字后回车：键盘到了正文，离开时标题存进了 F3；
- 构想页：标题和梗概离开时存进构想，⁂ 打不开动作；
- Esc 放回原标题；清空再离开不存，框里回到原标题；
- 梗概离开时存下；
- ⁂ 的「标为完成」再按一次变回草稿（页面先收到 F3 的新状态）；「新建下一章」把新章放在这一章和下一章中间，叫「新章节」；打开它时标题拿到焦点、全选。

另有千分位、幕序号（汉字数字和罗马数字）、「x.xk」的单元测试。测试窗口要先激活：GPUI 只在活动窗口里报焦点变化，不激活就收不到失焦。

## 和旧版不一样的地方

- **页眉里没有幕和状态。** 旧版的页眉就是「第 N 章 · 故事线 · 字数」，完成与否看 ⁂ 的颜色；`PageInfo` 也只在开幕那一章带幕名。
- **幕扉页的字距。** 旧版「第一幕」和幕名有字距（`letter-spacing`），GPUI 做不了。
- **构想页的分组路径已补齐**（旧模块收尾）：沿用旧版的「构想 · 组 - 子组 · 字数」。
- **⁂ 菜单少了「帮手审阅」**，等 Agent 模块（M30）。键盘还打不开它（旧版能 Tab 到 ⁂ 再用方向键选）：等外壳的焦点框架，`PageEnd::open_actions` 和 `choose(EndAction)` 已经留好。
- **⁂ 和动作之间的变换没有模糊**（GPUI 不能模糊元素），只有缩放、淡入淡出和展开。
- **页眉下的点线是虚线**（GPUI 只有实线和虚线）。
- **空章提示没有 240 ms 的淡入。**

## 待协调

1. ~~**F6：「新建下一章」后打开并全选标题。**~~ 外壳已提供 `Open::KEEP.at_title()`，⁂ 新建下一章已使用；外壳跳过正文聚焦，章首取走 `NewTitles` 意图后聚焦并全选标题。别的新建入口可以复用上面的 `focus_new_title` 接口。
2. **F6：装了 chrome 的章节页不用再 `set_title`。** 章首代替了编辑器的标题行，外壳在 `editor_prepared` 里调的 `set_title` 对章节页已经多余（无害）。
3. **F6：键盘进出 ⁂**（Tab 到 ⁂、方向键选、回车做），等外壳的焦点框架。
4. ~~**F4（dr-editor）：**~~（F4e 第四批已做，见 [f4e-editor.md](../foundations/f4e-editor.md#第四批2026-11-08-夜)；dr-view-page 已照下面的用法接上：扉页、构想页的标题和梗概。F4 的分支在 F5 分支里先合了进来，见 f5-ui.md 第六轮。）
   - ~~`PageInfo` 加这一章所在的幕、幕的序号、章数和字数，扉页才能画「第一幕」和「N 章 · x 千字」；~~
     - **字段**：全书视图里，开一幕的那一章的 `PageInfo::act_page` 是 `Some(ActPage { name, ordinal, chapters, words })`。别的章是 `None`，单章页面上也是 `None`。
     - **序号**：`ordinal` 照旧版 `deriveActSegments`，数书里所有的幕，空幕和书首的幕也算。
     - **章数和字数**：`chapters` 是这一幕到下一幕之前的章数。`words` 是这些章的字数（prose-metrics 的规则，和页眉一样），作者一打字就跟着变，编辑器会请宿主重画那一章的章首。
     - **旧版的写法**：序号是「第{n}幕」（中文用汉字数字，1–99，十、十一、二十一……，超出用阿拉伯数字；英文用罗马数字 "Act IV"）。下面一行是「{N} 章 · {x.x}k 字」：字数除以一千保留一位小数，0 也写「0.0k」，英文 "{N} chapters · {x.x}k words"。旧版里没有「千字」这个写法。这两样格式由 dr-view-page 拼。
   - ~~构想页的标题和梗概要 `idea.update` 的动作（现在的 `page::rename` / `set_synopsis` 只改章节），有了以后构想页也可以用这里的章首。~~
     - `page::rename(lib, book, doc, title)` 和 `page::set_synopsis(lib, book, doc, text)` 现在认得构想页（`node:<构想 id>`），走 `idea.update`，规则和章节一样：去掉首尾空白，空标题不存，没变不写。
     - 构想页的 `PageInfo` 是 `kind: PageKind::Idea`，带 `title`、`synopsis` 和 `status`（`drifting` / `resting`）。所以 dr-view-page 可以照章节页接管构想页的标题和梗概。构想页没有 ⁂ 的完成和新建下一章（`set_finished` / `new_chapter_after` 仍只对章节）。
5. **M30（Agent）：** ⁂ 菜单里的「帮手审阅」。
6. ~~**F4（dr-editor）：** 构想页的页眉要构想所在的组。~~ 已在本模块补齐：直接读外壳已有的书目快照并监听更新，不必扩展 `PageInfo`。
