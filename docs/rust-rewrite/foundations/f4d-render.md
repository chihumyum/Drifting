# F4d 渲染：画层、块样式、沉浸淡出、滚动条刻度

2026-11-08。F4 编辑引擎的渲染子线，代码在 `next/crates/gpui-prose/src/render/`（MIT OR Apache-2.0，只依赖 gpui 和 loro，不碰任何 `dr-*`）。总的架构、文本源和别的子线见 [f4-editor.md](f4-editor.md)；计划见 [foundation.md 的 F4 一节](../foundation.md#f4-编辑引擎gpui-prose-与-dr-editor)。

## 一句话

宿主（Drifting 里是 `dr-editor`）现在可以在正文上「只画不改」：按组交给编辑器一批装饰（批注的砂笔、TODO、查找命中、人物链接的干笔下划线、还没链上的名字、Agent 改动的彩色墨字），编辑器把它们画在字下面、字上面或字本身上，打字、撤销、别的设备和 Agent 的改动都让它们跟着字走，从不为它们重新排版；出现、消失、加深、沿行重画都有过渡。块样式（引文、缩进 0–8、居中和右对齐、分隔线，H1/H2/H3 一视同仁）、沉浸写作的段落淡出、滚动条上的刻度也都做了。一章 2 万字放 1000 处装饰，滚动每帧多约 0.1 ms、打一个字多约 0.16 ms（都不到 0.5 ms，预算 16 ms；负载 4.9 下量的，等空闲重测）。

## 大白话

- **装饰是「一段字 + 一种画法」。** 宿主说「第 0 章 `comments` 这一组现在是这些」，编辑器拿新单子按 id 和旧单子对：还在的保留状态、换上新范围；新来的淡入；不在了的淡出。纹理（砂笔贴图）和颜色全由宿主给，`gpui-prose` 自己一种颜色、一张贴图都没有。
- **三种画法，两层。** 字下面一层是「铺」（`Wash`：批注那道干笔荧光、查找命中的平涂）；字上面一层是「划」（`Underline`：人物链接那道干笔下划线、建议链接的一串砂粒）；还有「换墨」（`Ink`：Agent 写的字是绿或紫，外部改动是蓝，TODO 关键字是 TODO 色）。批注的砂笔真的垫在字下面画，所以字永远在砂上面、保留自己的颜色，用不着旧版的混合模式。
- **跟着字走，不重排。** 装饰的范围用整章的字符偏移记着；编辑器每折进一批改动（`sync_chapter` 里那一行），就把每处装饰的头尾挪一遍：在它前面打字它往后挪，在它里面打字它变长，正好在它开头或结尾打字不算进去，它的字被删光就收成空的、不画（等宿主下次重新交）。挪的是数字，段落的排版一点不动；画的时候从已经排好的行里取位置。
- **过渡都在编辑器的时钟上。** 时长是 Drifting 的动效词汇：整块淡入淡出 0.3 s，浓度变化（指着它的卡）0.24 s，作者自己的动作（跳到原文、刚写下）让这道笔沿着行从左往右重画一遍（第一行 0.38 s，每多一行加 0.12 s，一口气缓出）；Agent 的字被指针碰到后 0.3 s 退回墨色。只有正在变的时候才要下一帧，静下来一帧都不画；「减少动效」时一切直接到位。时间取 GPUI 执行器的时钟，所以测试和离屏截图能把过渡停在半路。
- **指针。** 三种：不理指针；「指着」（停 0.12 s 算指着，这道笔加深，编辑器发 `Pointed` 让宿主点亮那张卡；扫过、拖选都不算；人物链接的加深不用等，`Touch::HOVER`）；「碰到就走」（Agent 改动：指针移上去，或者指针不动、正文从它底下滚过去，都算碰到，连两帧之间扫过的那一段路也算，正文一帧跳了超过半屏只算落点；碰到的那处 0.3 s 淡掉，编辑器发 `Touched`，宿主记下「看过了」，跨重启保留归宿主）。碰掉的装饰在宿主跟上之前再交一次也不会回来。
- **作者自己选中的批注**（`Emphasis::Drawn(n)`）画完一遍以后保持指着卡时的样子，直到作者在正文里点一下或打字；编辑器这时把它放回静止并发 `Settled`。同一个 n 再交一次不重画，换个 n 才重画。
- **块样式。** 读每段 `\n` 上的属性（loro-schema v0）：引文整段往里收一格、铺一层底色、换一档墨，相邻的引文连成一块（底色穿过段间的空隙），左边不画竖条；缩进整段右移 `层数 × 2 字` 并按缩进后的宽度换行；居中、右对齐逐行挪；分隔线是空段落中间一道短细线。H1/H2/H3 吃这些属性和正文完全一样。颜色和步长由宿主经 `BlockStyle` 给。
- **对齐和点击。** 居中、右对齐的每一行挪的距离不同。命中测试读本帧的记录，所以对齐的多行段落每行记一条（各带自己的偏移），点在哪一行就按那一行算；单行或每行挪得一样的段落还是一条记录。输入法候选窗和上下移动现在按段落第一行的偏移算，要 F4b 在排版里加「每行偏移」才能完全对上（待协调 1）。
- **沉浸写作。** `set_paragraph_focus(true)` 以后，光标所在段以外的字淡到原来的 0.26（旧版 `hsl(var(--ink-1) / 0.26)`）；光标换段时，离开的那段 0.24 s 淡下去、进入的那段同时亮起来。只动字的颜色，装饰和选区不变。
- **滚动条刻度。** 装饰带 `Tick` 就在右边 12 px 的条上有一颗：批注横跨整条（6 px），Agent 改动在三条细道里（3.4 px）。位置用编辑器自己的高度表（和滑块同一张），不为它们排整本书；每颗按 id 固定取宿主给的六枚砂印之一、转一个固定角度；随装饰淡入淡出，指着加深，点它滚到那里（上方留三分之一屏）并发 `TickClicked`。
- **`editor.rs` 只动了四行**：`paint` 字段、它的初始值、`sync_chapter` 里每批改动调一次 `follow`、`render` 里加一层刻度。别的都在 `render/` 里。

## 画层接口（给 `dr-editor`）

### 交装饰

| 项 | 说明 |
| --- | --- |
| `ProseEditor::set_decorations(chapter, group, Vec<Decoration>, cx)` | 换掉这一章这一组；按 id 对新旧，见「大白话」 |
| `ProseEditor::clear_decorations(cx)` | 一下全清，不淡出（换了一本书） |
| `ProseEditor::decoration_range(chapter, group, id)` | 它现在在哪（编辑以后挪过的范围） |
| `ProseEditor::painted_decoration(chapter, group, id) -> Option<PaintedDecoration>` | 上一帧画在哪：它盖住的字逐行的窗口坐标、浓度、画到哪儿了；给悬停卡定位，也给测试 |
| `Decoration::new(id, range, look).touch(…).emphasis(…).tick(…)` | 一处装饰：范围是整章的字符偏移，和选区一样 |
| `Look::Wash(Wash)` | 字下面：`Wash::sand(贴图, 指着时的贴图, 颜色, Strength::new(静止, 加深))`，`Wash::flat(颜色, …)` 平涂；`reach` 是两边伸出字外多少 |
| `Look::Underline(Underline)` | 字上面：`Underline::sand(贴图, 颜色, …)` 干笔下划线（7 px），`Underline::dotted(颜色, …)` 一串砂粒 |
| `Look::Ink(颜色)` | 字本身换墨，淡入淡出时在原色和它之间过渡 |
| `SandTexture::from_png(key, bytes)` / `from_svg(key, w, h, 元素)` | 宿主的贴图：白色 alpha 蒙版，画的时候上色。比行短从笔头截取（起点按 id 和行定种子、每次一样），最后 12 px 是笔自己的干尾；比行长按四分之一一档拉长整笔 |
| `Touch::None` / `Touch::POINT`（停 0.12 s）/ `Touch::HOVER`（立刻）/ `Touch::Point { rest }` / `Touch::Fade` | 指针做什么 |
| `Emphasis::Rest` / `Hot`（指着它的卡、当前查找项）/ `Drawn(n)`（作者的动作选中它） | 宿主给的状态 |
| `Tick { color, lane: TickLane::Span / Lane(0..=2) }` | 滚动条刻度 |
| `ProseEditor::set_tick_seals(Vec<Rc<SandTexture>>)` | 刻度用的砂印（Drifting：`blob-0..5`）；不给就是圆点 |

### 事件（`EventEmitter<DecorationEvent>`，和 `EditorEvent` 并列）

| 事件 | 什么时候 |
| --- | --- |
| `Pointed { ids: Vec<(章, DecorationKey)> }` | 指针停在这些装饰上（空：都离开了） |
| `Touched { chapter, key }` | 一处 `Touch::Fade` 被碰到，正在淡掉 |
| `Settled { chapter, key }` | 一处 `Drawn` 回到静止（作者点了正文或打了字） |
| `TickClicked { chapter, key }` | 作者点了它的刻度，编辑器已经滚过去 |

### 块样式、沉浸、动效

| 项 | 说明 |
| --- | --- |
| `ProseEditor::set_block_style(BlockStyle)` | `indent_step`（字，默认 2）、`quote_inset`（字，默认 1）、`quote_wash`、`quote_ink`、`rule`、`rule_width`（版心的几分之几，默认 0.3） |
| `ProseEditor::block_look(chapter, line) -> BlockLook` | 这一段的块样式（缩进层数、引文、对齐、分隔线、左边收进多少） |
| `ProseEditor::set_paragraph_focus(bool)` / `paragraph_focus()` | 沉浸写作的段落淡出，`render::FOCUS_DIM` = 0.26 |
| `ProseEditor::set_reduce_motion(bool)` | 减少动效 |
| `render::motion::{FADE, SHIFT, DRAW, DRAW_PER_ROW, POINT_REST, TOUCH_FADE, TICK_IN, FOCUS_SHIFT}` | 时长（和 dr-ui 的 `tokens::motion` 同值；`gpui-prose` 不能依赖 dr-ui，所以抄了一份，见待协调） |
| `render::paint::{TextPaint, paint_text}` | 带对齐、换墨、淡出的逐字形绘制；旧的 `paint_layout` 还在 |

### Drifting 的各项怎么交

数值来自 [materials.md 的「砂笔进正文」](../../design-system/materials.md) 和 [components.md](../../design-system/components.md)：

| 东西 | 组 | 画法 | 指针 | 刻度 |
| --- | --- | --- | --- | --- |
| 批注锚点 | `comments` | `Wash::sand(hl, hl-hot, 批注色, 0.27 / 0.61)` | `Touch::POINT` | `Span`，批注色 |
| TODO 锚点 | `comments` | `Wash::sand(hl, hl-hot, TODO 黄, 0.29 / 0.66)` | `Touch::POINT` | `Span`，TODO 色 |
| TODO 关键字（段首的 `TODO：`） | `todo` | `Ink(TODO 色)` | — | — |
| 跳到原文、点刻度、刚写下 | 同上 | `Emphasis::Drawn(新的 n)` | — | — |
| 指着 Review 卡 | 同上 | `Emphasis::Hot` | — | — |
| 查找命中 / 当前项 | `find` | `Wash::flat(强调色, 0.16 / 0.34)`，当前项 `Hot` | — | 可选 |
| 人物链接 | `links` | `Underline::sand(ul, 实体色, 0.7 / 0.95)` | `Touch::HOVER` | — |
| 建议链接（`dr-text` 匹配器找到、还没链上） | `suggestions` | `Underline::dotted(实体色, 淡)` | 可选 | — |
| Agent 新增 / 改写 / 外部改动 | `agent` | `Ink(绿 / 紫 / 蓝)` | `Touch::Fade` | `Lane(0 / 1 / 1)` |

浅色主题的砂笔颜色要按 dr-ui 的 `sand_on`（在稿纸色上预先相乘）给，深色主题提亮、再乘 0.72 的浓度；`gpui-prose` 只是照给的颜色和浓度画。

## 测试

全部用 GPUI 的 `TestAppContext`（`render/tests.rs`，以及各文件里的单元测试，共 31 项；`gpui-prose` 全部 85 项、基准程序 5 项都过）：

| 测试 | 管什么 |
| --- | --- |
| `decorations_follow_typing_and_other_writes` | 前面打字往后挪、开头结尾打字不算进去、中间打字变长、Agent 写入也挪、字删光就不画 |
| `a_composition_shows_outside_a_decoration_it_starts_at` | 拼音标在装饰开头时显示在装饰外面 |
| `a_wash_covers_each_row_and_fades_in` | 跨行的批注逐行画；淡入、加深、淡出都是过渡，不一帧切换 |
| `a_drawn_decoration_is_drawn_along_its_rows_then_settles` | `Drawn` 沿行画出、同号不重画、打字或点正文后回静止并发 `Settled` |
| `reduced_motion_lands_at_once` | 减少动效直接到位 |
| `underlines_inks_and_sand_textures_paint` | 贴图下划线、点线、换墨都画出来；指着链接立刻加深 |
| `touching_an_agent_change_lets_it_go` | 一下扫过（中间没有事件落在字上）也算碰到；淡掉以后宿主重交也不回来 |
| `the_prose_scrolling_under_a_still_pointer_touches` | 指针不动、正文滚过去也算碰到 |
| `resting_on_a_comment_points_at_it` | 停够 0.12 s 才算指着；离开立刻放开；拖选不算 |
| `indents_and_quotes_move_the_text_in`、`a_rule_is_one_line_tall_and_headings_take_block_styles_too` | 缩进、引文收进的距离，点击落在对的字上；H2 也吃缩进 |
| `alignment_moves_rows_and_clicks_follow` | 居中、右对齐逐行挪，点击按挪过的位置算 |
| `immersive_writing_fades_all_but_the_caret_paragraph` | 别的段淡到 0.26，换段时一起过渡，关掉复原 |
| `ticks_sit_at_their_paragraphs_and_a_click_scrolls_there` | 刻度按段落的位置排，点它滚过去并发事件 |
| `state::tests::*`、`sand::tests::*`、`motion::tests::*`、`blocks::tests::*`、`element::tests::*`、`paint::tests::*`、`ticks::tests::*`、`items::tests::*` | 范围怎么挪、按 id 替换、碰掉的不回来；贴图截取和拉长、PNG 读尺寸、base64；缓动；属性到块样式；线段和方框相交、沿行画到哪；换墨；刻度命中；字符偏移一次换成字节 |

## 截图

`cargo run --release -p gpui-prose --example prose-bench -- capture <目录> [--textures <目录>]` 离屏画（GPUI 的测试平台、macOS 的字体系统、Metal 画进纹理），不开窗口、不需要录屏权限。正文是合成的；贴图默认是程序里现画的合成砂粒，`--textures` 指向一个放着 `hl.png`、`hl-hot.png`、`ul.png`、`blob-0..5.png` 的目录就用那里的（截图用的是 dr-ui 自己的砂笔贴图，代码不依赖 dr-ui）。压成 256 色（`crates/dr-ui/script/shrink-pngs.py`）。

都是 2 倍像素（2200 × 1640），压缩后共 1.1 MB，最大一张 419 KB。截图时时钟停住，过渡停在说明里写的那一刻。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 各种装饰都静止：批注（第二段那处是「指着它的卡」）、TODO 关键字和 TODO 砂笔、人物链接的干笔下划线、「老秦」的建议点线、查找命中（第二个「灯」是当前项）、Agent 新增 / 改写 / 外部改动的绿紫蓝墨字；右边是刻度 | [decorations-light](f4d/decorations-light.png) | [decorations-dark](f4d/decorations-dark.png) |
| 同一处批注被「跳到原文」：沿行重画到 0.2 s（第一行画完、第二行画到一半） | [drawing-light](f4d/drawing-light.png) | [drawing-dark](f4d/drawing-dark.png) |
| 全部装饰淡入到 0.05 s（约四成浓度） | [fading-in-light](f4d/fading-in-light.png) | [fading-in-dark](f4d/fading-in-dark.png) |
| 块样式：两段相邻的引文连成一块、缩进一级和两级、分隔线、居中、右对齐、缩进的 H2、居中的 H3 | [blocks-light](f4d/blocks-light.png) | [blocks-dark](f4d/blocks-dark.png) |
| 沉浸写作：光标在第四段，其余淡到 0.26 | [immersive-light](f4d/immersive-light.png) | [immersive-dark](f4d/immersive-dark.png) |
| 基准用的 2 万字合成章节带 1000 处装饰（下面「测量」的那一份），右边刻度很密 | [dense-light](f4d/dense-light.png) | — |

深色的颜色是截图程序里随手配的，不是 Drifting 的令牌；真正的颜色由 `dr-editor` 按 dr-ui 的调色板给。

## 测量

`cargo run --release -p gpui-prose --example prose-bench -- decor --out ../docs/rust-rewrite/acceptance/f4-decor.json`，证据在 [f4-decor.json](../acceptance/f4-decor.json)（`prose-bench check` 认得它的源码和语料指纹）。

量法：离屏的 GPUI 窗口 1100 × 820，F4 基准一直用的 2 万字合成章节（含一段 5000 字的长段落）。「一帧」是编辑器重新渲染、排版、绘制一整帧的 CPU 时间（和窗口基准的「每帧工作」同一个意思，不含 GPU）。带装饰的那一份有 1000 处：400 处批注砂笔（带指着时的贴图和刻度）、300 处干笔下划线、120 处建议点线、120 处查找命中、60 处 Agent 墨字（带刻度），都已静止。滚动是从头到尾每帧 48 px；打字是在章中间一个字一个字打 120 个，每键算「改 + 一帧」。不带和带装饰交替各跑三轮，所以机器忙的时候两边一样受影响。

**测量时一分钟负载 4.9（2 以下才算空闲），证据标了「仅供参考」，最终数字等空闲重测。** 本轮开发中途负载在 15–400 之间（别的会话在编译），那时量的数字都没有留。

| 项 | 预算 | 不带装饰 p50 / p95 | 带 1000 处 p50 / p95 | 多出来 |
| --- | --- | ---: | ---: | --- |
| 滚动一帧 | 每帧工作 p95 ≤ 16.7 ms | 0.148 / 0.364 ms | 0.232 / 0.478 ms | 约 0.1 ms |
| 打一个字（改 + 一帧） | 按键到交出画面 p95 ≤ 16 ms | 0.295 / 0.323 ms | 0.456 / 0.490 ms | 约 0.16 ms |
| 一次交齐四组 1000 处装饰 | — | — | 0.88 ms | — |

一屏（加上下各约一屏半的预画区）画到 42 处装饰。

**第一版慢了五倍，改了四处才到这里**（都在 `render/` 里）。第一版量出来带装饰的滚动 p50 / p95 是不带的 5 倍、打字 3.5 倍（负载 50，所以绝对值不可比，倍数可比）。用 macOS 的 `sample` 看热点，依次改了：

1. **每段分三层画。** GPUI 给每个图元排先后要查一棵边界树，砂笔垫在字下以后整行的字都和它重叠，这棵树的剪枝失效，每个字形都要多查很久（占了主线程两成）。现在每段画成「字下 / 字 / 字上」三个 `paint_layer`，每层只进树一次，层内按图元种类排（方块先于字形）。这一处让不带装饰的段落也少了逐字形的排序。
2. **字符偏移一次换完。** 每处装饰都从段首数字符换字节，5000 字的长段落上有约 250 处装饰，就是几十万次。现在一段里所有头尾先收齐、排好，沿文字走一遍。
3. **只算看得见的行，字形位置建表。** 原来每处装饰把段落每一行都问一遍，`x_for_index` 又是从段首逐字形找；现在二分找到装饰覆盖的行、只算视野内（上下各多一行）的，每段先建一张「字节 → x」表二分查。
4. **刻度不跟着每帧重算。** 刻度的位置缓存到「在哪一段」，每帧只按高度表取比例；段内打字不改行号，也不让刻度重算。

## 和旧版的差别、取舍

- **砂笔垫在字下面画，不用混合模式。** 旧版 WebKit 里垫在字下会被链接的下划线挡住，只好叠在字上用 `multiply` / `screen`；GPUI 没有混合模式，但编辑器自己逐字形画，先画砂再画字就行，字和链接下划线都在砂上面。浅色主题「乘进稿纸」的效果由宿主预先算好颜色（dr-ui 的 `sand_on`）。
- **Agent 字退回墨色是连续的 0.3 s**，旧版因为 `::highlight()` 只能换颜色、不能过渡，才分成「62% → 墨色」两步。
- **截取处的干尾用笔自己的末端**（把贴图最后 12 px 接在行尾），不像 dr-ui 的读数那样铺一层底色渐变：这样不必知道底下是什么颜色，两道砂笔交叠时也不会互相遮。
- **刻度只按段落顶端定位**，不细到段内哪一行；一章几百段，条上 1 px 也就一两段，看不出差别。
- **只画视野里的行。** 一处装饰跨到屏幕外的行不算、不画、不进本帧记录（`painted_decoration` 只给看得见的部分）；沿行重画的进度也只在看得见的行之间分。跳到原文时它本来就在视野里。
- **装饰范围收成空的就不画**，不猜它该在哪；宿主按自己的节奏（旧版是 150 ms 防抖）从 Loro 光标重新解析、重交。

## 待协调

1. **F4b（排版）：每行偏移。** 对齐现在靠「对齐的多行段落每行记一条记录」让点击对上；输入法候选窗（`input/ime.rs` 的 `bounds_for_range`）和上下移动（`input/movement.rs` 的 `goal_x`）读的是段落第一条记录或不带偏移的排版，所以居中、右对齐的多行段落里候选窗会偏、上下移动的列会错开。建议 F4b 给 `ProseLayout` 加 `set_row_offsets(&[Pixels])`（从 `row_x` 里减掉），渲染层在排版后调它，`point_for_byte`、`byte_in_row`、`x_range`、`selection_rects` 就都带上偏移；那时渲染层改回每段一条记录、去掉自己的 `shifts`，F4c 不用改。
2. **F4b：高度估算和 `line_layout` 不知道块样式。** `editor.rs` 的 `estimate_line` / `estimate_all` 按整版心宽估高，`line_layout`（没画过的段落现排）也按整版心宽换行；缩进、引文的段落其实更窄。估算只影响滚动条的准度，`line_layout` 影响上下移动进入屏幕外的缩进段落时落在哪个字。建议这两处减去 `ProseEditor::block_look(chapter, line).inset`。
3. **F4e（dr-editor）接画层：**
   - 贴图：`SandTexture::from_png("dr-ui/sand/hl", SandMask::Hl.png())` 等，一次建好、`Rc` 共享；颜色按 dr-ui 的砂笔颜色规则（浅色预乘稿纸、深色提亮再乘 0.72）。
   - 批注、TODO：在持有者线程上把锚点解析成范围（`anchors::comment_anchors` 已有），按上面的表交 `comments` 组；批注变了、或者自己按节奏重解析后重交。
   - 人物链接：现在 `style_run` 给链接字加了 GPUI 的细下划线；换成 `Underline::sand(ul, …)` 装饰时把 `style_run` 里的下划线去掉，免得画两道。建议链接用 `dr-text` 的匹配器找出没链上的名字，交 `suggestions` 组（这是待协调 13 要的「建议」显示）。
   - TODO 标记：`todo::markers` 找到的段，关键字交 `Ink(TODO 色)`，任务那段在投成待办以后作为批注锚点画。
   - Agent 改动：命令写入后按改动交 `agent` 组；`Touched` 时把它记成看过（跨重启保留），之后不再交。
   - 事件：`Pointed` → 点亮审阅卡；`Settled` → 清掉「选中的批注」；`TickClicked` → 选中这条批注（交 `Drawn(n+1)`）。
4. **F5（dr-ui）：动效时长有两份。** `gpui-prose` 不能依赖 dr-ui，`render::motion` 抄了 dr-ui `tokens::motion::sand` 的几个时长（0.3 / 0.24 / 0.38 + 0.12 s）和沉浸的 0.24 s。建议 `dr-editor` 加一条测试逐个对这两份，改一边会被提醒。
5. **F6（外壳）：** 沉浸写作时只对获得焦点的那个编辑器调 `set_paragraph_focus(true)`；`ThemeSettings::reduce_motion` 变了调 `set_reduce_motion`；主题变了连同 `set_block_style` 一起换颜色。
6. **给监管会话（合并）：** `gpui-prose/src/editor.rs` 只加了四行：`paint` 字段、初始值 `paint: Default::default()`、`sync_chapter` 循环里的 `self.paint.follow(chapter, set, self.own_edit, cx);`、`render` 里列表之后的 `.child(self.scroll_ticks(cx))`。`ParagraphElement` 加了几个 crate 内字段（外面没人构造它）。`gpui-prose` 的开发依赖 `gpui_platform` 打开了 `test-support`（基准程序要它的离屏渲染器），基准程序的源码指纹清单（`report.rs`）加了新文件。
7. **空闲重测**：「测量」里的数字是负载 4.9 下量的，等一分钟负载降到 2 以下，在 `next/` 下重跑一次、把表换掉：

   ```bash
   cargo run --release -p gpui-prose --example prose-bench -- decor --out ../docs/rust-rewrite/acceptance/f4-decor.json
   ```

8. **`f4-editor.md` 里过时的两句（给监管会话，合并时改）：**「已知限制」里「块样式里只有 H1/H2/H3 有样子」；待协调 13（F4d 的画层接口）现在有了，指到本文。本子线只建了本文，没有改 `f4-editor.md`。
