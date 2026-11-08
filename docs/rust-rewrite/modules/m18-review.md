# M18 审阅：批注与 TODO

2026-11-08，第一个里程碑；同一天第二个里程碑（来源悬停卡、多行输入、全书视图里写批注，见[下面](#第二个里程碑)）和第三个里程碑（来源卡挪到卡旁边、加「原文」，见[下面](#第三个里程碑)）。计划见 [modules.md 的 M18](../modules.md)。审阅标签和批注撰写框在新 crate `next/crates/dr-view-review/`；正文上的那一半（批注砂笔、TODO 关键字、滚动条刻度、`TODO:` 投成 TODO、撤销后重新锚定）在 `dr-editor` 的 `decor` 模块，写在 [f4d-render.md 的第二轮](../foundations/f4d-render.md#第二轮接进-drifting)。两边通过 `dr_editor::decor::ReviewFocus` 说话。外壳里挂了七处，逐条列在下面。

## 做了什么（大白话）

1. **右栏「审阅」标签有内容了。** 上面一排三选一（全部 / 批注 / TODO），右边一个「当前」开关：开着列直接附着于当前对象或经通用关联指向它的批注/TODO（本轮收尾补齐后者），关着列全书的。下面按位置分组：每一章、每条构想、每个要素一组，组名是它的标题；最新的那条所在的组排最前，组里最新的在上；没挂在任何东西上的排在后面（「未挂载」），挂的东西已经删了的单独一组（「已删除」）。已解决的折在最底下「已解决（n）」里，点开才列。
2. **卡片。** 没有底色，只有一圈静止的素玻璃细线，指针进来时玻璃跟着漂；类型词（「批注」「TODO」）用批注色或 TODO 色，这是卡上唯一的颜色。锚在正文上的卡先引它锚着的原文（淡一档、缩进一点），下面是批注本身。右上角是一个箭头（跳到原文）和一个按钮：TODO 是一个圆，批注是「解决」/「重新打开」文字按钮。
3. **在原地编辑。** 双击卡上的正文，变成一张稿纸色的小纸片可以写（第二个里程碑起是 F5 的多行输入：回车换行、⌘↵ 存、Esc 放弃），写的是 F3 的 `comment.update`。
4. **完成 TODO 画上勾。** 点那个圆，`comment.update` 把它标成已解决，同时圆里从左到右画一道勾（0.38 s，和正文里砂笔沿行重画同一个时长）；撤回时勾退回去。卡随后挪进「已解决」。
5. **指着卡，正文里那道砂笔加深；指针停在正文的砂笔上，对应的卡亮起来。** 点箭头：外壳打开它所在的章节，编辑器把光标放到它开头（带进视野），这道砂笔沿着行重画一遍，直到作者在正文里点一下或打字。点滚动条上它的刻度也一样。
6. **批注撰写框跟着选区出现。** 正文里选中一段字按 ⌘⌥M（Windows 是 Ctrl+Alt+M），选区最后一行下面 8 px、和选区起点对齐处浮出一张平的卡：「批注 | TODO」二选一、一张稿纸色的小纸片（三行高，多行输入）、「取消」文字按钮和「保存」主按钮。回车换行、⌘↵（Ctrl+Enter）存、Esc 关，和旧版一样。存下的批注锚在选中的字上（`comment.create` 带 `range`），写下就算「选中」，正文里这道砂笔立刻沿行画出来。撰写框贴着窗口边时自动收进窗口里（留 12 px）。
7. **多段批注画成干笔砂痕。** 锚点跨好几段，每一行都铺一道干笔，行尾有笔自己的干尾，不是一整块矩形。这是 F4d 画层本来就会的，这次交上了真的锚点。
8. **`TODO:` 和 `待办:` 自动变成 TODO。** 段首写 `TODO`（不分大小写）或 `待办`，后面跟空格、`:` 或 `：`，这段的其余文字就是一条 TODO：关键字换成 TODO 色，光标离开这段（或编辑器失去焦点）时投成审阅里的一条 TODO（F3 的 `todo.project`），卡上的原文就是这一段。

## 定下的事

- **「当前」跟的是当前标签**（`ws.nav.current()`），不是光标所在的章。
- **完成 TODO、解决批注都只是改状态**，不删；已解决的随时可以「重新打开」。
- **快捷键 ⌘⌥M 只在正文里有效**（gpui-prose 编辑器的键位上下文），作用于有焦点的那个编辑器（单章或全书视图）的选区；没选中字时什么也不做。选区浮条上的「添加批注」（F4 的 `CommentRequested`）打开同一个撰写框。
- **审阅卡和正文的高亮走一个全局状态**（`ReviewFocus`：指着哪些卡、正文里指着哪些砂笔、最近一次「跳到」哪条），两边都只读写它，不互相持有。

## 外壳（dr-shell）里的挂接点

| 文件 | 改了什么 |
| --- | --- |
| `Cargo.toml` | 依赖 `dr-view-review`；加了截图示例 `m18-capture`（`capture` 特性） |
| `src/lib.rs` | `dr_view_review::init(services.library.clone(), cx)`；`keymap::add_bindings(cx, dr_view_review::bindings)`；退出前 `dr_view_review::release(cx)` |
| `src/workspace/sidebar.rs` | `RightTab::Review` 画 `dr_view_review::panel(…)`，给它一个 `Opener`（箭头调 `open_review_target`） |
| `src/workspace/mod.rs` | `mod review;`；`Workspace` 加字段 `composer: Option<review::Composer>`（初始 `None`）；根上 `.on_action(cx.listener(Self::on_new_comment))`；渲染里 `.children(self.composer_overlay())` |
| `src/workspace/review.rs`（新） | `open_review_target`（按 `NavTarget::key` 打开标签、关掉通览）、`on_new_comment`（找有焦点的编辑器，单章或全书）、`on_comment_requested`（浮条的「添加批注」）、`open_composer`（建撰写框、存完或取消后焦点回正文）、`composer_overlay`（`deferred(anchored())`，贴窗口边收进 12 px） |
| `src/workspace/editors.rs` | `decor_looks(theme, base)`；单章编辑器和全书视图建好时、主题或减少动效变了时 `set_decor_looks`；两种视图都订阅 `CommentRequested`；`TodoMarkers` / `AnchorsChanged` 两个事件只留调试日志（命令改由编辑器自己发） |
| `examples/m18-capture.rs`（新） | 截图 |

## 截图

`cargo run -p dr-shell --features capture --example m18-capture -- ../docs/rust-rewrite/modules`（在 `next/` 下；字体目录用 `DRIFTING_FONTS_DIR` 指过去）。离屏画整个外壳，书是 dr-testkit 的样例《慢钟》，打开第一章后让一个 Agent 用 `prose.replace` 改两处字。2 倍像素 2560 × 1600，压成 256 色，每张约 0.2–0.44 MB。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 审阅标签（全部、全项目）；正文里「她数了一遍，十七张。」是一条 TODO 的砂笔，第二段「，一下一下地」是 Agent 刚加的绿字，人物名是干笔下划线，「钟楼底下」是 Agent 改写的紫字 | [review-light](m18/review-light.png) | [review-dark](m18/review-dark.png) |
| 只看 TODO | [review-todo-light](m18/review-todo-light.png) | [review-todo-dark](m18/review-todo-dark.png) |
| 选中「没人来取的表」按 ⌘⌥M，撰写框在选区下面（多行的纸片） | [composer-light](m18/composer-light.png) | [composer-dark](m18/composer-dark.png) |
| 指针停在第二张卡（第十一章的一条批注）上：来源悬停卡贴在卡的左边（右边没地方）、顶边对齐，标题是第十一章，下面一张纸条是原文，再下面是编辑、解决、转 TODO、删除 | [source-light](m18/source-light.png) | [source-dark](m18/source-dark.png) |
| 通览全书：第一章的批注砂笔、Agent 的绿字和紫字、右边的刻度 | [book-light](m18/book-light.png) | [book-dark](m18/book-dark.png) |
| 素材笔记里的列表（F4d 第三轮）：圆点、第二级空心圈、序号、三种任务；第四轮起项与项挨紧（0.15 个字），下面一个代码块、一个提示框 | [list-light](m18/list-light.png) | [list-dark](m18/list-dark.png) |

## 数字

截图程序顺手量的（debug 构建，离屏，**只作参考**）。第一章 1039 字，第一个里程碑（负载 5.6）、第二个里程碑（负载 20）和第三个里程碑（负载 35–53，别的会话在编译）：

| 项 | 数 |
| --- | ---: |
| 打开到第一帧画上批注（锚点在持有者线程上解析） | 64.9 ms / 116.6 ms / 329.7 ms |
| Agent 写入到正文变色（结算记录 → 两版比对 → 光标 → 交装饰） | 13.8 ms / 20.3 ms / 84.1 ms |
| 换一次主题后交齐链接、建议、TODO 关键字、批注 | 2.54 ms / 4.86 ms / 8.57 ms |

第三个里程碑的数随负载涨了三四倍；这一轮在这几条路径上只多了排版时每段算一次 `para_set`，等空闲重测。

本轮更早几次在负载 27–50 下量到 128–382 ms、34–66 ms、3–20 ms，没有留。

## 测试

- `dr-view-review/tests/review.rs`（GPUI `TestAppContext`、真库）：
  - `the_tab_filters_scopes_and_groups_by_place`：三种筛选、「当前」只剩这一章、按位置分组未挂载在最后、别处新写的批注出现；
  - `a_todo_is_completed_and_a_body_edited_in_place`：完成 TODO 写进库并挪进已解决；双击编辑、回车存；
  - `the_arrow_opens_the_chapter_and_chooses_the_comment`：箭头交给外壳的是 `chapter:<id>`，`ReviewFocus` 记下跳到这条；
  - `the_composer_writes_a_comment_on_the_selection`：没选中不出撰写框；选中两字存成 TODO，锚在这两个字上，写下即选中；
  - `the_shortcut_is_a_keystroke_gpui_takes`：快捷键字符串 GPUI 认得（写错了会在启动时崩）；
  - `the_source_card_says_where_and_its_rows_act`：来源卡说出挂在哪一章、锚着的原文；没挂的说「项目级 · 未关联对象」；卡打开时读到原文快照、没改动；转 TODO、删除写进库。
- `dr-editor/tests/decor.rs` 的 `a_comments_original_passage_says_when_the_prose_changed`：原文是写批注时选中的字；别处改字不算改动，Agent 改了这几个字就算；没挂东西的批注没有原文。
- `dr-ui` 的 `overlay::tests::beside_goes_right_or_flips_left_top_aligned`：旁边的摆法右边放得下就放右边，放不下且左边更宽就翻到左边，顶边对齐，靠下时往上挪进窗口。
- `dr-shell/tests/workspace.rs` 的 `a_comment_is_written_in_the_whole_book`：全书视图里选中第三章开头两个字，⌘⌥M、写字、⌘↵，批注落在第三章那两个字上，全书视图画出它。
- `dr-view-review/src/model.rs`：筛选、范围、分组的顺序。
- 正文一侧的测试见 [f4d-render.md 第二轮](../foundations/f4d-render.md#第二轮接进-drifting)。

## 待协调

1. ~~浮条上的「添加批注」~~：第二个里程碑接上了（`CommentRequested` → `on_comment_requested`）。撰写框拿走焦点，浮条随之收起。
2. **M23（审阅与素材 ⌘⌥5）：** 列表、分组、卡片在 `dr_view_review::{model, panel}` 里，M23 的两列可以复用 `model::arrange` 和卡片。
3. ~~F5：多行输入框~~：第二个里程碑换上了 F5 的 `TextArea`。
4. **还没做的：** 「交给帮手」（TODO 交给 Agent）等帮手搬过来再做。旧侧栏未找到优先级编辑入口，不把它当既有功能缺口。~~原文~~、~~卡旁边~~ 第三个里程碑做了。
5. **原文的「已删除/改动」只比对选中的字。** 只存了段落快照、没存选中文字的批注（块级的 TODO）不比对，只显示快照；要比对得按块 ID 找回现在那几段（dr-doc 的段落视图能做，等需要时加）。

## 第二个里程碑

2026-11-08（F4d 第三轮的一部分）。

- **来源悬停卡。** 指针在一张审阅卡上停 220 ms，卡下浮出 dr-ui 的悬停卡（`HoverCard` + `CardBody`）：标题是它挂在的那一章、构想、要素（带那样东西自己的砂笔记号，章节按 id 取六枚印之一，和外壳一样），没挂的写「项目级 · 未关联对象」；锚了原文的下面一段是原文（没存下原文就说「没有保存原文摘录」）；卡底三组：编辑；解决或重新打开、转 TODO 或转批注；删除（危险色，F3 记了撤销）。正在原地编辑的那张卡不出悬停卡。
- **多行输入。** 在原地编辑和撰写框都换成 F5 的 `TextArea`，放在一张稿纸色、细线框的小纸片上；回车换行、⌘↵ 存、Esc 放弃。
- **全书视图里也能写批注。** ⌘⌥M 和浮条的「添加批注」在通览全书里都打开撰写框；批注写在选区所在那一章上（`CommentComposer::for_prose`，任何一个编辑器都行）。全书视图里也画批注、Agent 墨色和刻度（F4d 第三轮）。

## 第三个里程碑

2026-11-08（F4d 第四轮的一部分）。

- **来源卡贴在审阅卡旁边。** 和旧版一样（`right-start`）：顶边和卡对齐，放在卡右边；右边放不下、左边更宽就放左边。审阅在右栏，所以通常在卡的左边，盖住的是正文而不是审阅列表。dr-ui 的悬停卡加了 `HoverCard::beside()`，摆法 `Place::Beside` 归 dr-ui 统一的摆放规则（同样留 8 px 窗边、靠下时往上挪）。
- **原文。** 标题下面一张稿纸色的小纸条（旧版的 `.hover-card__quote`），正文字体、淡一档的墨：写批注时选中的那几个字；没存选中文字的，是批注当时跨过的那几段的快照（段与段空一行）。卡打开时才去后台读一次（书目文档里的批注、目标文档里锚点现在的字），读到的东西缓存 2 秒，卡再打开时过期就重读。现在锚着的字和当时不一样了（或者整段删了），纸条下面用索引字体写一行旧版的「已删除/改动」。
- 「交给帮手」等帮手搬过来再做。

## 代码位置

```text
next/crates/dr-view-review/src/
  lib.rs        init、release、panel、view、NewComment 和快捷键、Opener
  model.rs      筛选、范围、分组（不依赖 GPUI）
  panel.rs      审阅标签（ReviewView）：卡片、来源悬停卡、在原地编辑、完成的勾、跳到原文
  composer.rs   批注撰写框（CommentComposer）
next/crates/dr-editor/src/decor/   正文一侧（见 f4d-render.md 第二轮）
next/crates/dr-shell/src/workspace/review.rs   外壳的挂接
```


## 旧模块收尾：当前范围与来源刷新（2026-11-08）

对照旧 `ReviewPanel.tsx:135–170` 和 `domain/comment.ts` 的
`commentIdsRelatedToEntity` / `commentBelongsToEntity`：当前范围既看直接
目标，也看通用关联的 `comment → 当前结构对象`。此前 Rust 只比对直接目标，
未挂载 TODO 或在别处锚定的批注虽已关联，仍会从「当前」里消失。

本轮读取 F3 的内建通用关联，当前筛选取两种命中的并集，同一条只出现一次；
不把自定义关系或素材作为源的关系当成批注。关联只改变是否列入，分组和
跳转仍按批注实际所在位置。关系增删/类型变化、目标改名/删除都会刷新列表；
素材批注的来源也能读到标题、打开素材页并跟随改名。

保留 `model::arrange` 的旧签名，为调用方另加 `arrange_with_related`，不改
M23；卡片正文补上静态文本的无障碍标签，范围开关补复选状态和标签，
真窗口可点击「当前」并核对卡片是否出现/消失。
契约来自 `dr_testkit::samples::slow_clock`，覆盖关联动态增删、去重、来源
改名/删除和素材来源。窗口场景是 `review-current-associations.json`。
`cargo fmt --all --check`、全工作区 Clippy、全工作区测试（**1685 通过、
0 失败、22 忽略**）、`cargo xtask check` 与 `pnpm public:check` 均通过。
新增 1 项纯模型和 2 项 GPUI 契约通过。真实窗口场景 **33/33 步、0 待验**：
直接命中、两种关联命中、去关联消失、切回全书仍保留未挂载项，截图已检查，
最后正常退出。audit 0 漏洞、12 条既有提示；已有测量 stale 提示未手改。

**M18 仍未完成**：独立新建批注/TODO、关联选择器、按创建/更新时间排序、
平铺/分组、组折叠、本机偏好与窄栏工具行折叠仍在队列；帮手操作属于 M30/M31。
