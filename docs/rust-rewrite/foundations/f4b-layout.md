# F4b 排版：段首缩进、标点挤压、两端对齐、每行偏移、打字机滚动（附 F4a 批量编辑）

2026-11-08。F4 编辑引擎的排版子线（[f4-editor.md](f4-editor.md)「下一轮怎么拆」的 F4b 一行，加上 F4d 提的「每行偏移」「减去缩进」和 F4c 提的「读屏按屏幕行」），以及 F4a 的一件事：文本源的「一批编辑一次提交」。由 F4c 会话接着做。代码在 `next/crates/gpui-prose/src/layout/`（MIT OR Apache-2.0，不依赖任何 `dr-*`）；为了让画出来的和算出来的是同一个位置，F4d 的渲染层和 `editor.rs` 也改了几处，逐条列在「改了别的子线的哪些地方」。

## 一句话

段落现在按「怎么排」排好再画：正文段首可以缩进 0/1/2 字；相邻的全角标点挤掉半格（「。」」只占一个半字）；可以两端对齐，悬挂的标点留在版心外；居中、右对齐的每一行各挪各的。所有位置（光标、点击、选区、装饰、字形、输入法候选窗、上下移动）都由排版层的同一张表回答，所以对齐的多行段落里候选窗和上下移动也对上了。打字机滚动是单独的开关：打字和挪光标时，光标那一行停在视窗的中线上。读屏现在按屏幕行读，每个字都有屏幕位置。F4a：文本源加了「一批编辑一次提交」，全部替换变成一次提交、一项撤销，400 处替换的撤销从 2.6 秒降到 27 毫秒；撤销慢是 Loro 本身的问题（每撤一项都把这篇文字的全部历史重放一遍，连撤 N 项是平方级），最小复现在 `next/spikes/loro-undo-quadratic`，2026-11-08 报成了 [loro-dev/loro#1263](https://github.com/loro-dev/loro/issues/1263)。

## 大白话

### 一段字怎么排

排版层以前只做两件事：按中文规则断行，标点挂在行尾。现在一段字排好以后，`ProseLayout` 手里有一张「每个字放在哪」的表（`RowSetting` 决定怎么排），别的地方都只问它：

- **段首缩进。** 作者设置里的 0/1/2 字（`EditorSettings::paragraph_indent`），只给正文段，标题不缩，和旧版 `p { text-indent }` 一样。第一行从缩进处开始、也窄这么多；空段落的光标就停在缩进处。块缩进（引文、Tab 缩进那几层）照旧是整段右移，和段首缩进叠加。
- **标点挤压。** 用 `prose-linebreak` 的 `punctuation_squeeze`，规则和 PDF 导出同一份：全角的点号或后括号后面紧跟另一个标点，挤掉它右边的空白半格；前括号紧跟在前括号后面，挤掉它左边的空白半格。「他说：“好。”」里「：」和「。」各窄半字。只挤字体真给了一整格宽的标点（有的字体把“”排成西文窄引号，那就不挤）。挤压在断行之前做，所以一行能多放一点。左半格被挤掉的前括号画的时候左移半格，光标停在它的墨迹前面，看起来和右半格被挤掉的一样自然。默认开（`ProseStyle::squeeze`）。
- **两端对齐。** 打开以后（`ProseStyle::justify`，默认关），左对齐段落除最后一行外，每行把剩下的宽度平均分到字与字之间（西文单词内部不拉开，只拉开空格和中文的字距），行尾悬挂的标点仍在版心外面，行尾的空格不算。一行如果要拉开超过一个字宽（长单词被挤到下一行的那种），就不拉，免得字距难看。
- **每行偏移。** 居中、右对齐的每一行按自己的空余挪，挪的距离记在排版里（F4d 原来在渲染层每行记一条记录来对齐点击，现在一段一条记录）。光标、点击、选区、装饰的框、字形的位置都从排版取，所以输入法问「光标在哪」、↑/↓ 找「同一列」时，在居中、右对齐的多行段落里也对得上（F4d 的待协调 1）。

### 打字机滚动

单独一个开关（`ProseStyle::typewriter = Some(位置)`，`dr-editor` 的「打字机模式」设置打开时是 0.5，旧版的默认值）。作者打字、挪光标（凡是编辑器要「把光标露出来」的时候）时，光标那一行的中线停在视窗高度的这个比例上。做法：段落在预绘制时向列表要求「露出一个和视窗一样高的框」，框放在「露出它就正好把光标挪到那条线上」的位置，GPUI 的列表在同一帧里滚好，不闪。鼠标点击不跟着滚（点哪儿就是哪儿）。最后一段后面留出「线以下那部分视窗高度 + 24 px」的空白（旧版的做法），最后一行也能滚到线上。已经在线上一像素以内就不动。

顺手修了一个旧问题：光标跳到很远、从没画过的段落时（查找的下一个、跳到章尾），GPUI 列表按它量过的高度去「露出」那一段，没量过的段落按零算，结果停在半路，光标在屏幕外、也没有段落能再要求滚动。现在跳得比列表预先排的范围还远时，直接把那一段放到顶上，再由它自己的自动滚动（或打字机滚动）放到该在的位置（`editor.rs` 的 `reveal_cursor`）。

### 高度估算和屏幕外的排版

F4d 的待协调 2：滚动条用的高度估算和「没画过的段落现排」（上下移动进入屏幕外的段落时用）原来都按整个版心宽，现在减去块缩进、算上段首缩进，和画出来的那一段同样换行（测试 `estimates_and_off_screen_layouts_take_the_block_inset_off`：同一段字，编辑器自己排出来的行数和画出来的一样）。

### 读屏按屏幕行

F4c 上一轮的读屏是「一段一行」。现在段落在预绘制时把这一帧的排版记进帧缓存（GPUI 先让子元素预绘制、再问编辑器要读屏子节点，时机正好），读屏层拿它把画着的段落按屏幕行切：每行一个文本段、各算一行，带这一行的屏幕范围和每个字的位置、宽度（缩进、对齐、挤压、两端对齐都算在内）。于是 VoiceOver 按 ↑/↓ 读的是屏幕上的那一行，放大镜和 VoiceOver 的光标框能框住单个字。屏幕外的段落没有排版，照旧按至多 200 字切块、连成一行；组字中的那一段也照旧（屏幕上是拼音）。本机探针看到：一个折成三行的段落在 `AXTextArea` 里是三行，光标处那个字有自己的屏幕框（见「测量」）。

### 批量编辑（F4a）和撤销的平方级

- **一批编辑一次提交。** `ProseSource` 加了 `edit_batch(&[Edit], origin)`：几次编辑在同一个提交里做，作者撤销栈里只多一项。默认实现逐个提交（对，但慢），自带的 `LoroSource`、测试用的 `dr-doc` 式文本源、`dr-editor` 的 `SessionSource`（一个 `dr-doc` 事务、一次 `ProseSession::edit`）都按一次提交实现了。`ProseDoc::edit_batch` 在上面记批注锚点：批里的删除按位置从前往后记，撤销时 Loro 也是按文档顺序把字插回来，对得上；所以批要按「从后往前、不重叠」给（全部替换就是这样）。一致性检查加了 `batch_rules`（一次提交一项撤销、一次撤销全回来、一次重做全回去、批量删除的锚点撤销后回到原处），三种文本源都过。
- **全部替换**改用它：一章一次提交、一步撤销、一项 Loro 撤销。400 处替换以后撤销从 2593 ms 降到 27 ms。
- **平方级是谁的。** 两样都有：我们原来一处一提交，N 项撤销就要连撤 N 次；而 Loro 的 `UndoManager` 每撤一项，都把这篇文字从空版本起的全部操作重放约两遍（`undo()` 里两次检出：退回时 `build_full_crdt_tracker` 从头重建，回到最新版本时再逐个操作重放，合计约占撤销时间的 95%）。所以代价跟这篇文字历史里「合不成一段」的片段数走，和撤销栈长短无关：在一处连着打字，历史只有一段，撤最新一项一直约 0.2 ms；每个字都打在开头（每个字自成一段），撤最新一项 1000 字 0.5 ms、16000 字 7 ms，栈封顶 10 项也一样；每次撤销又往历史里添一笔删除，所以连撤 N 项总是平方级（4000 项 11 s）。「测量」里的复现把 N 处替换分散在 N 段、文档也随 N 变大，三样一起涨，所以当初看着像栈长（撤最新一项 50 项时 0.28 ms、800 项时 1.6 ms；连撤 50 项 34 ms、800 项 4.6 s）。同样 N 处改动放在一个提交里，撤一次只要 0.7–8.7 ms，大体线性，所以改成一次提交就绕开了。Loro 那一半等上游：2026-11-08 照「复现、查重、确认不是误用」报成 [loro-dev/loro#1263](https://github.com/loro-dev/loro/issues/1263)，Loro 1.17.1 和 main 3bc97da 一样；同一原因外人已提了 PR loro-dev/loro#1217（保留重建好的追踪器，之后每次撤销只补新操作），没合，我们也没跑过。复现：`cargo run --release -p loro-undo-quadratic-spike`（纯 Loro，不依赖我们任何代码），issue 里另有一份更小的。注意 Loro 的撤销栈默认只留 100 项，复现里调到了 10 万项，和 `gpui-prose` 一样；不调的话 100 项以后的撤销会悄悄没有（`gpui-prose` 一直是调过的；`dr-doc` 的 `ProseUndo` 原先没调，2026-11-08 改成不设上限）。

## 要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 段首缩进 0/1/2 字，在 `EditorSettings::style` 接上 | 完成 | `layout/paragraph.rs`、`layout/setting.rs`；`dr-editor/src/settings.rs`；测试 `the_first_row_is_indented_and_narrower`、`body_paragraphs_take_the_first_line_indent`、`values_are_read_clamped_and_defaulted` |
| 2 | 打字机滚动，单独一个开关 | 完成（`ProseStyle::typewriter`；`dr-editor` 的打字机模式打开时 0.5） | `layout/setting.rs` 的 `typewriter_bounds`、`render/element.rs` 预绘制；测试 `typewriter_scrolling_keeps_the_caret_on_its_line`、`the_typewriter_box_puts_the_caret_on_the_line` |
| 3 | 两端对齐 | 完成（`ProseStyle::justify`，默认关；外壳的设置项见待协调） | 测试 `justified_rows_reach_the_column_edge`、`justified_rows_end_at_the_column_edge` |
| 4 | 行内标点挤压，用 `punctuation_squeeze` | 完成（默认开） | 测试 `squeezing_takes_the_blank_halves_off` |
| 5 | `ProseLayout` 加每行偏移，输入法候选窗和上下移动对上 | 完成：对齐由排版做，渲染层一段一条记录 | 测试 `centred_and_right_rows_move_with_their_room`、`the_candidate_window_and_vertical_moves_follow_aligned_rows`；F4d 的 `alignment_moves_rows_and_clicks_follow` 改成新模型 |
| 6 | 高度估算和 `line_layout` 减去缩进 | 完成（并算上段首缩进） | 测试 `estimates_and_off_screen_layouts_take_the_block_inset_off`、`estimates_count_the_first_line_indent` |
| 7 | 读屏按屏幕行交出 | 完成（带每字位置；屏幕外照旧切块） | `input/a11y.rs`；测试 `painted_paragraphs_are_read_row_by_row`；探针 |
| F4a-1 | 文本源「一批编辑一次提交」，全部替换改用它 | 完成 | `text/source.rs` 的 `edit_batch`、`text/doc.rs` 的 `ProseDoc::edit_batch`、`LoroSource`、`drdoc_style.rs`、`dr-editor/src/source.rs`；一致性检查 `batch_rules`（三种文本源都过） |
| F4a-2 | 再量 400 处替换后的撤销 | 2593 → 27 ms | 「测量」 |
| F4a-3 | 查清平方级是谁的；是 Loro 的就在 `next/spikes/` 准备最小复现，不提 issue | 两样都有，见上；复现已备，2026-11-08 报成 loro-dev/loro#1263 | `next/spikes/loro-undo-quadratic` |

## 接口

| 项 | 说明 |
| --- | --- |
| `layout::RowSetting { first_indent, align: RowAlign::{Left, Center, Right}, justify, squeeze }` | 一段怎么排（不含宽度） |
| `ProseLayout::set(line, text, wrap, setting)`、`shape_set(text, size, runs, wrap, setting, window)`；`ProseLayout::new` / `shape` 照旧（左对齐、不缩进不挤压） | 排一段 |
| `ProseLayout::x_at(row, byte)`、`glyph_x(row, index, shaped_x)`、`row_offset(row)`、`row_stops(row)`、`setting()` | 排好的位置（相对文字原点，已含缩进、对齐、挤压、两端对齐）；`point_for_byte`、`byte_in_row`、`byte_for_point`、`x_range`、`selection_rects` 都改成这个口径 |
| `ProseLayout::row_x(row)` | 含义变了：去掉挤压、加上缩进以后的「未换行 x」（只给要和 GPUI 的原始字形位置对照的地方用） |
| `ProseEditor::row_setting(chapter, line) -> (RowSetting, inset)` | 编辑器里一段该怎么排、块缩进多少；画、现排、估高、候选窗都用它 |
| `layout::{typewriter_bounds, typewriter_tail, estimate_indented}` | 打字机滚动的框和尾部空白；算上段首缩进的估高 |
| `ProseStyle::{first_line_indent, justify, squeeze, typewriter}` | 新的四个样式项，默认 0、关、开、关 |
| `ProseSource::edit_batch(&[Edit], origin) -> EditResult`（有默认实现）、`EditResult::merge`、`ProseDoc::edit_batch` | 一批编辑一次提交 |
| `dr_editor::settings::TYPEWRITER_POSITION`（0.5） | 打字机模式的那条线 |

## 改了别的子线的哪些地方

- **F4d 的渲染层**（F4d 自己提的「渲染层改回每段一条记录、去掉自己的 shifts」）：`render/element.rs`：排版改用 `shape_set`（带 `RowSetting`），不再自己算每行的 `shifts`（字段留着、为空），装饰的每行范围改问 `layout.x_at`（`GlyphXs` 删了），预绘制时多记一份 `prepainted`、打字机滚动请求另一种自动滚动框，最后一段在打字机模式下多留尾部空白；新字段 `setting`、`typewriter`、`last`。`render/paint.rs`：字形位置改问 `layout.glyph_x`（一行）。`render/frame.rs`：`FrameCache::prepainted`。`render/items.rs`：给段落元素填这三个新字段。`render/tests.rs`：`alignment_moves_rows_and_clicks_follow` 改成一段一条记录、从排版取每行起点，并加了一项「点在挪过的最后一行上」。
- **`editor.rs`**：`estimate_all` / `estimate_line` / `line_layout` 用 `row_setting`（减块缩进、算段首缩进）；`reveal_cursor` 远跳时把段落放到顶上（见「打字机滚动」）；导入换了 `shape_set`。
- **`style.rs`**：`ProseStyle` 加四个字段。
- **`input/ime.rs`**（本会话自己的）：候选窗重排时沿用画出来那一段的 `RowSetting`。
- **`text/`**（F4a）：`source.rs`、`loro_source.rs`、`drdoc_style.rs`、`doc.rs`、`conformance.rs`。
- **`dr-editor`**：只动了两处——`src/source.rs`（`SessionSource::edit_batch`，文本源那一处）和 `src/settings.rs`（`EditorSettings::style` 接上段首缩进和打字机模式，这是要求 1 指定的地方）。
- **工作区**：`next/Cargo.toml` 的 members 加了 `spikes/loro-undo-quadratic`（按字母序），`Cargo.lock` 跟着变。

## 测量

M3 Pro，release；这几天机器一直很忙，负载都标出来了，**全部仅供参考**。

**撤销全部替换**（`gpui-prose` 自带的 `LoroSource`，`replace_all_costs`，负载 29）：

| 命中数 | 全部替换 | 撤销（一次提交） | 同样的替换分成 N 次提交时，文本源撤销本身 |
| ---: | ---: | ---: | ---: |
| 50 | 1.6 ms | 2.5 ms | 44 ms |
| 100 | 1.7 ms | 4.9 ms | 603 ms |
| 200 | 27.1 ms | 8.2 ms | 1768 ms |
| 400 | 27.6 ms | 26.9 ms | 7492 ms |

（上一轮同一项，编辑器经 N 次提交撤销：400 处 2593 ms。）`dr-editor` 的 `SessionSource` 走同样的一次提交，一致性检查里过了，但这一轮没单独量它的撤销时间。

**Loro 本身**（`cargo run --release -p loro-undo-quadratic-spike`，Loro 1.17.1，负载约 30–70）：

| N | N 次提交连撤 N 项 | 每项 | 一次提交撤一次 | 栈里 N 项时撤最新一项 |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 34.0 ms | 0.68 ms | 0.71 ms | 0.28 ms |
| 100 | 142.9 ms | 1.43 ms | 2.14 ms | 0.28 ms |
| 200 | 445.1 ms | 2.23 ms | 3.37 ms | 0.47 ms |
| 400 | 1300.7 ms | 3.25 ms | 5.03 ms | 0.94 ms |
| 800 | 4604.6 ms | 5.76 ms | 8.71 ms | 1.57 ms |

**排一段的代价**（2000 字的一段，GPUI 的字形缓存已热，只量断行和放置，`setting_costs`，负载 76）：左对齐不缩进 0.101 ms；段首缩进 + 挤压 + 两端对齐 0.112 ms；居中 0.085 ms。

**读屏探针**（`cargo run -p gpui-prose --example a11y-probe`，本机真窗口）：示例加了一段会折成三行的长段落，整章 93 个字；`AXTextArea` 报 6 行（标题、两段短的、长段的三行），光标处的字有自己的屏幕框（正文字约 18×31 点，标题字约 28×39 点，光标在段尾换行上时宽 0）。别处重画不丢、读屏挪光标、系统焦点（G8）和上一轮一样。

## 检查

照 [f4c-input.md 的「检查」](f4c-input.md#检查)，这一轮多跑了 `cargo clippy -p dr-editor -p loro-undo-quadratic-spike --all-targets --locked -- -D warnings` 和全工作区的 `cargo test --workspace --locked --no-fail-fast`。

## 要作者手测的

1. **排版观感**：`cargo run -p gpui-prose --example editor`（或在新版里打开一章）。看标点挤压（「：“」「。”」「”，」这类连在一起的标点），段首缩进 1、2 字（设置里改），两端对齐（目前只能在代码里打开，见待协调），居中、右对齐的多行段落点击和 ↑/↓ 是否落在对的字上，输入法候选窗在居中段落里是否贴着光标。
2. **打字机模式**：设置里打开，在长章节中间打字、按 ↑/↓、用查找跳到很远的地方，光标那一行应停在视窗中线；在章末打字最后一行也能到中线；用鼠标点不跳。
3. **VoiceOver**（上一轮的清单之外）：在折行的长段落里按 ↑/↓，读的应是屏幕上的那一行；VoiceOver 的光标框应框住单个字。

## 待协调

1. **F6（外壳）：两端对齐的设置项。** 外壳的设置注册表没有「两端对齐」，`gpui-prose` 已经支持（`ProseStyle::justify`）。要不要给作者这个开关、默认开还是关，由 F6 / 作者定；加的话 `EditorSettings` 读一个新键（比如 `editor.justify`），在 `style()` 里一行接上。打字机模式的位置（旧版 25–75%）也不在注册表里，现在固定 0.5。
2. **F4d：** 渲染层改了的地方列在上面，都按 F4d 自己的建议做的；F4d 下一轮动 `element.rs` 时注意排版现在负责对齐（`shifts` 字段为空，留着只是为了少改动，可以删）。挤压默认开，截图、视觉基线里连着的标点会窄半字。
3. **F4 主会话：** `reveal_cursor` 改了远跳的做法（见「打字机滚动」），查找、跳转、`select` 都受益；如果别处依赖「远跳时停在视窗底部」，要告诉我。
4. ~~**监管会话：** Loro 撤销栈越长、撤一项越慢，复现已备（`next/spikes/loro-undo-quadratic`），没报上游；和 G7、G8 一起等作者在时定。复现顺带说明了 Loro 的撤销栈默认只留 100 项。~~ 2026-11-08 报成 [loro-dev/loro#1263](https://github.com/loro-dev/loro/issues/1263)；代价跟的是文字的历史，不是栈长（见「批量编辑和撤销的平方级」）。
5. **F2/F3：** `SessionSource::edit_batch` 在一次 `ProseSession::edit` 里做多个 `dr-doc` 操作；如果中途一个操作失败，事务里已做的那部分怎么处理，和单个编辑一样取决于 F3 的持有者写入（没有新问题，记一笔）。
