# F4d 渲染：画层、块样式、沉浸淡出、滚动条刻度

2026-11-08。F4 编辑引擎的渲染子线，代码在 `next/crates/gpui-prose/src/render/`（MIT OR Apache-2.0，只依赖 gpui 和 loro，不碰任何 `dr-*`）。第二轮（同一天）把画层接进了 Drifting，代码在 `next/crates/dr-editor/src/decor/`，见文末[「第二轮：接进 Drifting」](#第二轮接进-drifting)；第三轮接进全书视图、给列表画了样子，见[「第三轮」](#第三轮全书视图列表来源悬停卡)；第四轮让段距跟着块走（列表收紧）、给代码块和提示框画了样子，见[「第四轮」](#第四轮段距跟着块走代码块和提示框)；第五轮做的是 [M19 的图片和 PDF 查看器](../modules/m19-materials.md)；审阅面板是 [M18](../modules/m18-review.md)。总的架构、文本源和别的子线见 [f4-editor.md](f4-editor.md)；计划见 [foundation.md 的 F4 一节](../foundation.md#f4-编辑引擎gpui-prose-与-dr-editor)。

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
| `ProseEditor::set_find_look(Option<Wash>, cx)` | 查找命中的画法（第二轮加）：编辑器自己读 F4c 的 `find_matches` / `find_current` 画，当前项用 `Strength` 的加深那一档；`None` 不画 |
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
| TODO 关键字（段首的 `TODO：`） | `todo-marks` | `Ink(TODO 色)` | — | — |
| 跳到原文、点刻度、刚写下 | 同上 | `Emphasis::Drawn(新的 n)` | — | — |
| 指着 Review 卡 | 同上 | `Emphasis::Hot` | — | — |
| 查找命中 / 当前项 | 不是组：`set_find_look` | `Wash::flat(强调色, 0.16 / 0.34)`，当前项用加深那一档 | — | — |
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

`cargo run --release -p dr-editor --example prose-bench -- capture <目录> [--textures <目录>]`（在 `next/` 下；基准程序已由 F4e 搬进 `dr-editor`）离屏画（GPUI 的测试平台、macOS 的字体系统、Metal 画进纹理），不开窗口、不需要录屏权限。正文是合成的；贴图默认是程序里现画的合成砂粒，`--textures` 指向一个放着 `hl.png`、`hl-hot.png`、`ul.png`、`blob-0..5.png` 的目录就用那里的（截图用的是 dr-ui 自己的砂笔贴图，代码不依赖 dr-ui）。压成 256 色（`crates/dr-ui/script/shrink-pngs.py`）。

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

下面这张表是第一轮在旧的合成语料上量的，证据 [f4-decor.json](../acceptance/f4-decor.json) 现在算旧格式。基准搬进 `dr-editor` 以后，命令是 `cargo run --release -p dr-editor --example prose-bench -- decor --write`，语料换成 F8 的重型种子（最长的一章），证据写成 F8 格式 [f4e-m2-prose-bench-decor.json](../acceptance/f4e-m2-prose-bench-decor.json)，由 `cargo xtask check` 核对；那一份的数字和第三轮的分析见文末[「第三轮」](#第三轮全书视图列表来源悬停卡)。

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
3. **F4e（dr-editor）接画层：** 第二轮做完了，见[下面](#第二轮接进-drifting)。
4. **F5（dr-ui）：动效时长有两份。** `gpui-prose` 不能依赖 dr-ui，`render::motion` 抄了 dr-ui `tokens::motion::sand` 的几个时长（0.3 / 0.24 / 0.38 + 0.12 s）和沉浸的 0.24 s。建议 `dr-editor` 加一条测试逐个对这两份，改一边会被提醒。
5. **F6（外壳）：** 沉浸写作时只对获得焦点的那个编辑器调 `set_paragraph_focus(true)`（还没接）。主题变了换颜色、块样式已经接上（第二轮的 `set_decor_looks`）；只改「减少动效」还传不到编辑器，见第二轮待协调 2。
6. **给监管会话（合并）：** `gpui-prose/src/editor.rs` 只加了四行：`paint` 字段、初始值 `paint: Default::default()`、`sync_chapter` 循环里的 `self.paint.follow(chapter, set, self.own_edit, cx);`、`render` 里列表之后的 `.child(self.scroll_ticks(cx))`。`ParagraphElement` 加了几个 crate 内字段（外面没人构造它）。`gpui-prose` 的开发依赖 `gpui_platform` 打开了 `test-support`（基准程序要它的离屏渲染器），基准程序的源码指纹清单（`report.rs`）加了新文件。
7. **空闲重测**：「测量」里的数字是负载 4.9 下量的，等一分钟负载降到 2 以下，在 `next/` 下重跑一次、把表换掉：

   ```bash
   cargo run --release -p dr-editor --example prose-bench -- decor --write
   ```

8. **`f4-editor.md` 里过时的两句（给监管会话，合并时改）：**「已知限制」里「块样式里只有 H1/H2/H3 有样子」；待协调 13（F4d 的画层接口）现在有了，指到本文。本子线只建了本文，没有改 `f4-editor.md`。

## 第二轮：接进 Drifting

2026-11-08，第二轮。画层现在画的是 Drifting 真的东西：批注和 TODO 的砂笔、Agent 改动的墨色、人物链接的干笔下划线、建议链接、TODO 关键字、查找命中、滚动条刻度。代码在 `next/crates/dr-editor/src/decor/`（`mod.rs` 交装饰和发命令，`looks.rs` 颜色和贴图，`ledger.rs` Agent 改动的账本，`focus.rs` 和审阅面板共用的高亮状态）；`gpui-prose` 只多了查找那一层。审阅面板见 [M18](../modules/m18-review.md)。

### 大白话

- **每个章节编辑器自己管自己的装饰。** `ChapterEditor` 打开或换篇时带一个 `Decor`，它自己读批注、算链接、跟 Agent 的写入、发 F3 命令；外壳只给颜色（`set_decor_looks(DecorLooks)`，主题变了再给一次）。颜色按 dr-ui 的调色板和砂笔规则：浅色把颜色乘进稿纸色（`Palette::sand_on`），深色提亮、浓度再乘 0.72；Agent 的绿、紫、蓝是旧版 `comments-review.css` 的那三个色。贴图是 dr-ui 的 `hl`、`hl-hot`、`ul`、`blob-0..5`，一个线程建一次、所有编辑器共用。

| 组 | 画什么 | 从哪来 | 什么时候重交 |
| --- | --- | --- | --- |
| `comments` | 每条没解决的批注、TODO 的干笔砂（`Touch::POINT`，刻度横跨整条） | F3 的 `comment.anchors`，在文档的持有者线程上把锚点解析成范围 | 书里的批注变了；指着卡、跳到原文、换颜色时用编辑器手上挪过的范围再交一次 |
| `agent` | Agent 新加的字绿、改写的字紫、别的编辑器（Markdown 文件夹）写的字蓝；指针碰到就淡回墨色 | `ledger::AgentMarks`（下面） | 账本变了 |
| `links` | 人物链接的干笔下划线（链到已删除的东西是灰的），`style_run` 不再画 GPUI 的细下划线 | 正文上的实体标记 | 停手 150 ms 后；书的实体变了 |
| `suggestions` | 还没链上的名字，一串砂粒 | `dr_text::autolink::book_link_names` + `LinkMatcher`（不含这篇自己的实体，已经链上的不算） | 同上 |
| `todo-marks` | 段首 `TODO`、`待办` 关键字换成 TODO 色 | `todo::markers` | 同上 |
| 查找 | F4c 的命中平涂强调色，当前项更深 | `gpui-prose` 自己读 `find_matches` / `find_current`（`set_find_look(Some(Wash))`），每打一个字不用宿主重交 | — |

- **解析和编辑器对得上。** 锚点在持有者线程上解析，Agent 的写入可能正好落在中间：解析看到的是写入后的文档，编辑器还没折进那次写入（或者反过来）。现在持有者线程上数着这篇文档推了多少次改动（`source::EventCount`），解析时一起记下，回到主线程和编辑器已经折进的次数（`SessionSource::taken`）比：对不上就 20 ms 后重新解析，最多 8 次。
- **再交一次用编辑器手上的范围。** 批注交给编辑器以后，打字、撤销、Agent 的写入都由编辑器挪；以后再交（指着卡、跳到原文、换颜色）先从编辑器读回现在的范围（`decoration_range`），编辑器已经丢掉的（字被删光）就不再交。第一版这里用的是载入时的范围：截图里 Agent 在前面加了 9 个字，一指卡片，砂笔就退回 9 个字之前。
- **Agent 改动的账本。** Agent 每次写正文，dr-store 都留一条结算记录，带写之前、写之后两个版本。账本（每个库一个）拿到新记录，在持有者线程上比较两个版本（Loro 的 diff，去掉前后相同的字），每一段新字记成一处：只是加进来的算「新加」，替换了别的字的算「改写」，只有空白的不记。每处是两个 Loro 光标，所以之后怎么编辑都跟着字走，重启也找得回来，章节开着没开着都一样。别的编辑器写的字（M40 Markdown 文件夹的来源 `mirror`）从工作区的正文事件里来，记成「外部」。
- **「看过」存在哪：库目录里的 `agent-marks.json`，只在这台设备上。** 格式 `{"v":1,"last_settlement":…,"docs":{"<文档>":[{"id","kind","start","end"}]}}`（光标是 base64）。指针碰到一处，它就从文件里删掉，所以「看过」就是「不在单子上了」；字被编辑掉的、被更新的 Agent 改动盖住的旧记号也一起删。还记着最后取过的结算记录，重启不重复、不漏。一个库第一次见到时从最新那条记录往后算，以前的 Agent 改动不上色。选这个办法是因为最小：不改 Loro 结构、不加迁移、不进同步；看没看过本来就是这台设备上的事。 要跨设备时怎么放，F1 第五轮评估过（只评估、没做）：记号每台设备从同步来的历史里自己算，只同步「看过」，放在每本书一篇单独的小文档里，见 [f1-model-doc.md 的待协调](f1-model-doc.md#待协调) 第 8 条。
- **不按 origin 前缀认作者。** 墨色只来自结算记录，只有 Agent 的写入才留结算记录，所以作者的命令（`user:command`）、作者自己打字都不会上色；蓝色只认 `mirror` 这一个来源。
- **F3 第三轮的两条命令由编辑器自己发**（以前外壳只打日志）：
  - `AnchorsChanged`（撤销把字带回来、旧光标找不到它们了）→ 每条 `comment.reanchor`，同一个锚点重复发没关系；
  - TODO 标记变了、光标从一个标记段移到别的段、编辑器失去焦点 → `todo.project`，每次给全清单；`editing` 只在编辑器有焦点时填光标所在段（正在打的那条先不投），失焦时不填。
- **审阅面板和正文的高亮**走 `focus::ReviewFocus`（全局）：`point_cards`（指着哪些卡 → 砂笔 `Hot`）、`point_prose`（指针停在哪些砂笔上 → 卡亮）、`jump`（跳到哪条 → 编辑器把光标放到它开头、交 `Drawn(n)`）、`settle`（编辑器发 `Settled` 后清掉）。点刻度也是 `jump`。

### 共用文件里改的地方（只加字段和挂钩）

| 文件 | 改了什么 |
| --- | --- |
| `dr-editor/src/view.rs` | `ChapterEditor` 加字段 `decor`；`open` 里 `Decor::new(…)`；`switch_to` 里 `self.decor.rebind(…)` |
| `dr-editor/src/links.rs` | `dry_underline` 开关（`set_dry_underline`）：开着时 `style_run` 不画链接的细下划线；`alive(kind, id)` 给装饰判断链接的目标还在不在 |
| `dr-editor/src/source.rs` | `EventCount`、`SessionSource::event_count()`、`taken()`（crate 内） |
| `dr-editor/src/lib.rs`、`Cargo.toml` | `pub mod decor;`；依赖 `dr-ui`（颜色和贴图） |
| `gpui-prose/src/render/{state,items}.rs` | 查找层：`set_find_look`，画的时候读 F4c 的命中 |

### 测试

- `dr-editor/tests/decor.rs`（GPUI `TestAppContext`、真库，8 项）：批注画在锚点上、新写的出现、解决的消失、前面打字跟着挪；打开时 Agent 正好在写，批注仍落在原来的字上；Agent 写入以后指着卡、跳到原文再交，砂笔留在挪过的位置（这一项去掉修复会失败）；跳到原文画出来并把光标放过去；Agent 改动上色、写进 `agent-marks.json`、碰掉以后文件里也没了；链接、建议、TODO 关键字的范围；TODO 标记在光标离开、失焦时投成 TODO（失焦时 `editing` 为空）；撤销带回的字重新锚定并存进书目文档。
- `dr-editor/src/decor/ledger.rs`：两版比对分出新加和改写；账本文件写了再读一样。
- `gpui-prose/src/render/tests.rs`：`find_matches_are_drawn_with_the_current_one_stronger`。

### 待协调（第二轮）

1. ~~F6：⌘F 查找条~~：F6 已做；第三轮在外壳的查找测试里确认了高亮画得出来（当前项 0.34、其余 0.16）。
2. ~~F6：只改「减少动效」传不到编辑器~~：监管会话合并时已改（减少动效变了也重给 `DecorLooks`）。沉浸写作的 `set_paragraph_focus` 还没接（上面待协调 5）。
3. **M40（Markdown 文件夹）：** 蓝色的外部改动按 `mirror` 来源的正文事件记，`next/` 里还没有镜像，没在真的流程里跑过。
4. **TODO 只在标记变了、光标离开、失焦时投。** 别的设备同步来的 `TODO:` 段，要等这一章在本机打开并动过才投；要不要打开时就投一次，看 M18 下一个里程碑。
5. **Agent 改动的「看过」不跨设备。** 一台设备上碰掉了，另一台还是彩色的；要同步就得进书目文档，那是一次 Loro 结构的改动（F1）。
6. ~~M05（全书视图）：画层还只接在单章编辑器上~~：第三轮做完，见下。M05 要的「幕的扉页」还没做（F4e 建议由 F6 在章首挂接点里画，见 f4e-editor.md 待协调 1）。

## 第三轮：全书视图、列表、来源悬停卡

2026-11-08，第三轮。监管会话这一轮的六件事：全书视图接画层、有装饰时打字变慢、删掉空着的 `shifts`、列表的样子、M18 的下一个里程碑（见 [m18-review.md](../modules/m18-review.md)）、文档里的旧基准命令。

### 大白话

- **全书视图也画。** `Decor` 改成两层：编辑器手里一个小把手（`Decor`，只管把宿主自己的 TODO 标记事件转过去），真正干活的是一个独立的实体 `Layers`，里面每章一份（`Part`：这一章的文档、批注、有没有交过 Agent 墨色、链接要不要重找）。单章编辑器就是一章，`BookEditor` 是全书每章一份。批注、Agent 墨色、刻度、链接、建议、TODO 关键字、TODO 投影、撤销后重新锚定都按章走；点刻度或审阅卡跳到的批注在哪一章，光标就落到哪一章。
- **一次读全书的批注。** 原来每篇文档单独调一次 `comment.anchors`；现在直接在持有者线程上读一遍书目文档，拿到所有没解决的批注（带种类）和每条 TODO 的完成状态，再只对有批注的章各解析一次锚点。版本核对（第二轮）照旧按章做。
- **全书的链接一片一片找。** 一章的链接、建议在主线程上找（要看编辑器手上的字）；全书 165 万字一次找完会卡一帧，所以从光标所在的章开始、每片约 6 万字，片与片之间让出一帧。打字只把那一章标成要重找。
- **外壳给全书视图也交颜色**（`BookEditor::set_decor_looks`，打开时、主题或减少动效变了时）。
- **有装饰时打字一帧变慢不是画层每次按键都重算。** 把一次按键拆开量（负载 9–17，只作参考）：画层在「改」里只挪 1000 处装饰的范围，0.012–0.02 → 0.027–0.035 ms；画一帧 0.18 → 0.26–0.29 ms（p50）。p95 的三四倍落在「经会话写入、事件回来」那一步，那段代码不碰画层；一帧不画也照样有尾巴；4800 键的几次对照里带装饰的 p95 是 1.3–4.0 ms、不带的是 2.1–4.3 ms，谁高谁低每次都变。`sample` 看到量的时候库打开时的过期索引重建线程（`index-rebuild`）还在跑、和写入抢锁，等它建完（约 2 秒）再量，不带装饰的 p95 降到约 2.1 ms。给基准的建议（等索引重建完再量、把写入和画分开报、多打几键）写在共享笔记 `f4d-typing-with-decorations.md`，基准归 F4e。
- **`shifts` 删了。** 对齐、缩进现在由排版自己放（F4b），段落元素里那个总是空的「每行右移」连同按行拆的点击记录一起去掉，一段一条记录。
- **列表有样子了**（列表只在素材笔记里有，dr-doc 在章节里会丢掉这些属性）：
  - 每级往里收 1.5 个字，记号在第一行左边：第 0 级实心圆点，第 1 级空心圈，第 2 级小方块，再往下循环；
  - 有序列表画「1.」「2.」，序号沿着同一级相邻的项往上数，中间夹着更深的项不断号，别的段落一隔就从 1 重新数；
  - 任务是一个小方框，勾上了是强调色底、稿纸色的勾，字变淡、划一道线；
  - 链了 TODO 的任务项不看自己的 `checked`，看那条 TODO 完成了没有（`ProseExtension::task_done`；dr-editor 的 `DriftingExtension` 由画层喂进全书 TODO 的状态）；
  - 点方框：编辑器发 `DecorationEvent::TaskClicked`，光标不动；dr-editor 接到以后，链了 TODO 的就 `comment.update` 完成或重开那条 TODO，没链的就翻转 `checked`（自己一步撤销）；
  - 颜色来自 dr-ui：记号用第二档墨，方框用分隔线色，勾上用强调色，勾上后的字用淡墨；
  - 列表的输入（回车续项、空项回车退出、Tab 改层级、`- ` `1. ` `[ ] ` 快捷写法）归 F4c，分工写在共享笔记 `f4d-lists-for-f4c.md`。

### 接口变化

| 项 | 说明 |
| --- | --- |
| `gpui_prose::render::{ListItem, ListMark}`、`BlockLook::list` | 列表项和它的记号（`Bullet`、`Ordered(n)`、`Task { done }`）、层级 |
| `BlockStyle::{list_step, list_ink, task_box, task_done, task_tick, task_done_ink}` | 列表的步长和颜色 |
| `ProseExtension::task_done(todo) -> Option<bool>` | 链了 TODO 的任务项显示什么 |
| `DecorationEvent::TaskClicked { chapter, line }` | 点了任务框 |
| `render::paint::TextPaint`：去掉 `shifts` | 对齐归排版 |
| `dr_editor::decor::Layers`、`ChapterEditor::decor_layers()`、`BookEditor::{set_decor_looks, decor_layers}` | 画层实体 |
| `DriftingExtension::set_todos` | 全书 TODO 的完成状态 |

### 共用文件里改的地方

| 文件 | 改了什么 |
| --- | --- |
| `dr-editor/src/book.rs` | `BookEditor` 加字段 `decor`；`open` 里 `Decor::for_book(…)`；`reload` 里 `rebind_book(…)` |
| `dr-editor/src/convert.rs` | `set_block_attr` 认 `list`、`list_level`、`checked`、`todo`（原来只认引用、分隔线、缩进、对齐、标题） |
| `dr-editor/src/links.rs` | `DriftingExtension` 加 TODO 状态表和 `task_done` |
| `gpui-prose/src/extension.rs` | `task_done`（有默认实现） |
| `dr-shell/src/workspace/editors.rs` | 全书视图打开时、主题或减少动效变了时交 `DecorLooks`；两种视图都订阅 `CommentRequested` |
| `dr-shell/src/workspace/review.rs` | 撰写框在两种视图里都能开（`⌘⌥M` 和浮条） |

### 测试

- `dr-editor/tests/decor.rs` 新加两项，共 10 项：`the_whole_book_draws_every_chapters_layers`（全书三章各自的批注、第三章的 Agent 墨色、新写的批注出现在第一章、跳到 TODO 光标落到第三章、第二章打 `TODO ` 投到第二章）；`task_items_tick_their_box_or_their_todo`（素材笔记里：链了 TODO 的任务项跟着 TODO 的状态，点没链的框打上勾，点链了的框重开那条 TODO）。原来的 8 项在改成按章的 `Layers` 以后照样过。
- `gpui-prose`：`list_items_are_numbered_set_in_and_tasks_tick`（序号、深的项不断号、段落一隔重新数、两种任务状态、缩进的距离、点方框发事件且光标不动）、`blocks::tests::list_items_are_set_in_by_level`。去掉 `shifts` 以后 `gpui-prose` 全部测试照样过。
- `dr-shell/tests/workspace.rs`：查找栏那一项加了高亮的断言；新加 `a_comment_is_written_in_the_whole_book`（全书视图里选中第三章开头两个字，⌘⌥M，写字，⌘↵，批注落在第三章那两个字上，全书视图画出它）。

### 截图

在 [m18/](../modules/m18/)，由 `m18-capture` 画：`book-*.png` 是全书视图里的批注砂笔、Agent 墨色和刻度，`list-*.png` 是素材笔记里的三种列表（第二级是空心圈，任务里一项自己勾上、一项跟着已完成的 TODO、一项没勾）。

### 待协调（第三轮）

1. **F4c：列表的输入**，见上和共享笔记。~~代码块、提示框还没有样子~~：第四轮画了。
2. ~~**列表项之间的间距**用的是段落间距~~：第四轮收紧到旧版的 0.15 个字，高度估算也知道了块样式。
3. **F4e：基准**：`prose-bench decor` 的打字一项建议等索引重建完再量、把写入和画分开报（共享笔记）。`gpui-prose` 渲染层的源码这一轮改了，`f4e-m2-prose-bench-decor.json` 的指纹会算过期，到下一个里程碑重测。
4. **幕的扉页**（M05）还没画。

## 第四轮：段距跟着块走、代码块和提示框

2026-11-08。

### 大白话

- **段距跟着块走。** 原来每段的上下留白只看它是正文还是 H1/H2/H3，块样式只管左右收进多少。现在编辑器每段先算一份「这段怎么放」（`ProseEditor::para_set`：字号、行高、上下留白、换行时的首行缩进和两端对齐、左右收进多少），离屏排版、输入法重新排、整篇的高度估算和真画的段落元素都从这一份取，所以估的高度和画出来的一样（测试里每个一行的段落估算值等于量出来的值）。
- **列表收紧。** 列表项下面紧跟着还是列表项（哪一级都算），两项之间只留 0.15 个字（旧版素材笔记 `li + li` 的间距），最后一项照常留段距。列表项不再吃首行缩进。
- **代码块**（只在素材笔记里，每行一段，`code_block` 是语言、可为空）：相邻的代码行连成一块（语言不同也连，照 loro-schema 的说法）；整块铺一层纸色更深的底（旧版的 `--paper-deep`）、小圆角，上下左右各留一圈（旧版 10 / 12 px，按正文字号折成 0.65 / 0.75 个字），字换成等宽字体（Drifting 用 dr-ui 的索引字体 Sarasa Mono SC，`ProseStyle::mono_family`），小一号（0.84）、行更紧（1.55）；行与行之间不留段距；不首行缩进、不两端对齐、不挤压标点。
- **提示框**（同样只在笔记里，`callout` 是种类）：相邻同种的段连成一个框；整框铺一层很淡的强调色、外加一圈淡强调色细边，四周留白（旧版 10 / 14 px）；框里的段与段之间 0.4 个字；左边不画竖条。细边每段画自己那一截：一个画了圆角上边、往下伸出去的框，再裁到这一段的高度，所以中间的段只露出两条竖边，最后一段露出圆角下边。
- **一个来源。** 外壳原来自己有一份块样式（引文底色是第一档墨 0.04），画层另有一份（纸色更深 0.5，照旧版），打开时外壳那份后到、把列表的颜色盖掉了，换主题时又是画层那份后到。现在两边都用 `dr_editor::decor::block_style(palette)`：引文、分隔线、列表、代码块、提示框的颜色和圆角（dr-ui 的 `radius::MD`）一处定。
- **dr-editor 写得进代码块和提示框了。** `convert.rs` 的 `set_block_attr` 原来对这两个键只打警告不写。
- **打字带装饰的基准，重新看了一遍。** F2 第六轮（还在 F2 的分支上）让库打开时的补建索引等别的写入停 500 ms 才写，所以第三轮建议的「先等索引建完再量」在它合进来以后就不需要了。把这一轮和 F2 第六轮合在一个临时目录里跑了两次 `prose-bench decor`（不写证据），机器不空（负载 24–27，别的会话在编译），**只作参考**：打字一帧 p50 不带装饰 0.91–1.10 ms、带 1000 处装饰 1.04–1.50 ms；p95 两次一次带装饰高（5.42 对 2.50 ms）、一次不带装饰高（5.67 对 3.53 ms），还是和第三轮一样随负载翻来翻去。空闲时的一次还欠着。数字和给基准的建议在共享笔记 `f4d-typing-with-decorations.md`。

### 接口变化

| 项 | 说明 |
| --- | --- |
| `ProseEditor::{para_set, para_metrics}`、`layout::ParaSet { metrics, setting, look }`、`ParaSet::narrowing()` | 一段怎么放；替掉了 `row_setting` |
| `BlockLook::{list_below, code, code_above, code_below, callout, callout_above, callout_below, inset_right}` | 和上下邻段连没连成一块、右边收进多少 |
| `BlockStyle::{list_gap, code_wash, code_ink, code_size, code_line_height, code_pad, code_inset, callout_wash, callout_edge, callout_pad, callout_inset, callout_gap, block_radius}` | 列表间距、代码块和提示框的样子；单位是正文字号的几个字 |
| `ProseStyle::mono_family` | 代码块的字体，默认 Menlo |
| `set_block_style` | 现在也让高度重新估一遍（收进和留白都算排版） |
| `dr_editor::decor::block_style(&Palette)` | Drifting 的块样式，外壳和画层共用 |

### 共用文件里改的地方

| 文件 | 改了什么 |
| --- | --- |
| `gpui-prose/src/editor.rs` | 整篇估高度、离屏排版改用 `para_set`；`line_runs` 换成 `paragraph_runs`（代码行换等宽字） |
| `gpui-prose/src/render/items.rs` | `display` 的字样、`paragraph` 的字号行高留白取 `para_set`（两处，各一两行） |
| `gpui-prose/src/input/ime.rs` | 重新排时的字号取 `para_metrics` |
| `dr-editor/src/convert.rs` | `set_block_attr` 认 `code_block`、`callout` |
| `dr-shell/src/workspace/editors.rs` | `block_style(theme)` 改成调 dr-editor 那份；`base_style` 交等宽字体 |
| `dr-ui/src/components/overlay.rs` | `Place::Beside { rect, gap }`（M18 的来源卡，见 [M18 第三个里程碑](../modules/m18-review.md#第三个里程碑)） |
| `dr-ui/src/components/hover_card.rs` | `HoverCard::beside()`、`CardBody::quote(text, note)` |
| `dr-i18n/keys.txt` | 加 `commentRail.snapshot.changed`（旧版「已删除/改动」） |

### 测试

- `gpui-prose`：`lists_code_and_callouts_take_their_own_gaps`（相邻列表项 0.15 个字、最后一项段距、两项之间的实际距离；代码块的字号行高、两端留白、中间不留、收进、等宽字体；只有普通正文段吃首行缩进、代码不两端对齐不挤压；提示框两端留白、中间 0.4 个字、两边收进、换行宽度窄了两边的留白；十段每段的估算高度等于量出来的高度）。原来的块样式、列表测试照样过。
- `dr-editor/tests/decor.rs`：`code_blocks_and_callouts_are_written_in_notes`（素材笔记里设成代码行和提示框，编辑器认出来、笔记的文档里存下了这两个键）。

### 截图

`list-*.png`（[m18/](../modules/m18/)）换成了第四轮的：列表项挨紧，下面是一个三行的代码块和一个两段的提示框。

### 待协调（第四轮）

1. **F4c：** 代码块和提示框的输入（回车在代码块里续行、空行退出；进出提示框；代码里的 Tab）归输入一侧，块样式这边只管画。
2. **代码块不横向滚动。** 旧版 `pre` 超宽时横向滚；新版照段落换行。笔记里的代码多是短行，先这样。
3. **行内代码**（`code` 标记）还没有样子（旧版纸色更深的底、等宽小一号），属于标记到字样那一层，下一轮可以一起做。
4. **章节里的引文底色变了一点。** 块样式合成一份以后，打开章节时引文的底色从外壳那份（第一档墨 0.04）换成画层那份（纸色更深 0.5，旧版素材笔记的值），比之前略深；原来换一次主题以后就已经是这一份。要哪一份请外壳定，改 `dr_editor::decor::block_style` 一处就行。

## 第五轮：M19 的图片和 PDF 查看器

这一轮做的是模块，不是画层：图片和 PDF 素材的整页（缩放、平移、翻页、区域批注），PDF 用 hayro 渲染（为什么不用 pdfium-render 也在那里）。全部写在 [m19-materials.md](../modules/m19-materials.md)。和这条子线有关的只有一处：dr-ui 的 `SandFrame` 多了 `.rest` 和 `.seed`，区域批注的干框用它（见 [f5-ui.md](f5-ui.md)）。
