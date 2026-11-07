# F4 编辑引擎：gpui-prose

2026-11-07 起。代码在 `next/crates/gpui-prose`，加两个小 crate `next/crates/gpui-ime`（组字规则，只用标准库）和 `next/crates/prose-linebreak`（中文断行，只依赖 `icu_segmenter`），三个都是 `MIT OR Apache-2.0`。`gpui-prose` 依赖 `gpui`（和它自带的 `sum_tree`）、`loro`、这两个小 crate，默认特性 `icu` 另加 ICU4X 分词，不依赖任何 `dr-*`；Drifting 自己的扩展 F4e 以后在 `dr-editor`。计划见 [foundation.md 的 F4 一节](../foundation.md#f4-编辑引擎gpui-prose-与-dr-editor)，正文格式见 [loro-schema.md](../loro-schema.md)，起点是 [P0-B 探针](../spikes/p0-b-editor.md)。

## 第二轮（F4a）

### 一句话

编辑器不再拥有 Loro 文档了：读、写、撤销都经过新的 `ProseSource` trait，`gpui-prose` 自带一个最小实现 `LoroSource`；照 `dr-doc` 的做法另写的一个测试用文本源跑过同一套一致性检查，并且在同样的随机编辑下和自带的实现逐字一样，说明 trait 够 `dr-editor` 用。段落位置改用 SumTree 索引，打字不再重建整篇的前缀数组。组字规则和断行各拆成了一个独立的小 crate。这一轮的上屏、窗口和无窗口测量都是在别的会话编译、测试时量的，证据里自动标了「高负载、仅供参考」，不拿来判 G1、G2 的好坏；上屏的最终数字等机器空闲时由作者或监管会话重测，步骤在「测量 / 重测上屏」。

### 大白话

- **谁拥有文档。** 以前编辑器自己拿着 `LoroDoc`，往里写字时套用自己那一份回车、并段的规则。现在文档归「文本源」：编辑器只说「在这里替换成这段字」「在这里回车」「撤销一项」，规则由文本源执行。Drifting 里文本源会是 `dr-doc`（规则只有那一份），由 `dr-editor` 接上；单独用 `gpui-prose` 的人用自带的 `LoroSource`。
- **怎么证明 trait 够用。** 写了一套一致性检查（`text::conformance`）：回车、并段、粘贴挪块 ID 的规则，撤销分阵、Agent 的写入不进作者撤销、撤销带回批注，再加随机编辑后「编辑器看到的」和「重新读出来的」逐段一致。另照 `dr-doc` + `dr-store` 的样子写了一个测试用文本源：文档归一个持有者、只能在它的写闭包里改；事件照 `dr-doc` 的 `ProseEvent`，插入的字不带标记；撤销排除 `dr-model` 排除的那些来源；回车、并段的规则按 `dr-doc` 的 `ProseTxn` 重新写了一遍，不调 `gpui-prose` 自己的。它过了同一套检查，和自带的文本源在 16 组 × 120 步的随机编辑下文字、段落属性、标记、块 ID 怎么挪、撤销步数都一样。故意改坏它的一条规则，两项检查都会报错。以后 `dr-editor` 用真正的 `dr-doc` 实现 trait 时，开 `conformance` 特性跑同一套检查。
- **批注的事仍在编辑器里。** 文本源的每次编辑报告删掉了哪几段，撤销以后的事件里能看出插回了哪段，编辑器照旧在插回的字上重建锚点（监管会话同意的取舍）。
- **段落索引。** 每段一项放进 SumTree（GPUI 自带的 B 树，Apache-2.0），同时累计段数、字符数、UTF-16 单元数和字节数。找光标所在段、某段从第几个字开始都是对数时间；打一个字只改一项。块 ID 到段号另有一张表，只在段落增减或块 ID 变了时重建，打字不碰。
- **组字一处。** `gpui-ime` 里有两样：编辑器用的「覆盖层」（拼音盖在文档上、确认才写入、和 UTF-16 坐标的换算），以及从 F5 搬来的单行输入框的组字器。失焦一律「清掉 + 让系统丢弃」（作者已定）；F5 原来是失焦时把拼音提交，搬过来时改了，并加了测试。字素边界由调用方传进来，所以这个 crate 不需要 Unicode 表。`dr-ui` 改用它由 F5 做（待协调 6）。
- **断行一处。** `prose-linebreak` 就是上一轮的 `layout::linebreak` 原样搬出去，`gpui-prose` 依赖它；以后 `dr-text` 和 PDF 导出也依赖它。
- **打开时只读一遍全文。** 改成文本源以后，`LoroSource` 打开时检查块 ID 要读一遍全文，编辑器建镜像又读一遍；读全文是打开的主要开销，所以检查时读到的段落留给紧接着的第一次读取，文档只要有任何变化（哪怕没提交）就不用它（测试 `the_opening_read_is_reused_only_while_current`，故意去掉版本核对它会报错）。
- **证据自己标负载。** `prose-bench` 在每次测量前后各取一次一分钟负载，最高值不低于 2（这台 12 核的机器）就在证据里写 `conditions.reference_only: true` 和一句说明，`prose-bench check` 会列出这些文件。Instruments 的录制限时 180 秒，目标进程卡在启动阶段（这一轮遇到过一次）就自动重录，最多三次。上屏证据里的预算也改成了新口径：16 ms 只对「按键到交出画面」，「按键到真正显示」只记录。
- **按键上屏的预算**照监管会话的决定拆成两条，`benchmarks.md` 已改：「按键到交出画面」照旧 16 / 8.3 ms（发布档靠 G1）；「按键到真正显示」只记录。G1 仍只存成补丁文件，`present_now` 保持关。
- **TextEdit 参照这一轮没量**：要让 TextEdit 的窗口在最前面待半分钟，还要往它那里发按键（很可能要给终端开「辅助功能」权限），这两件事都超出了这一轮约定的边界（不接管屏幕、不改系统设置）。量法和要作者点头的事写在待协调 1。

**测量（仅供参考）。** 这一轮的测量都是在别的会话编译、测试时做的（一分钟负载 8–24），证据都标了「高负载、仅供参考」，逐项见「测量」，最终数字等机器空闲时重测。能说的只有三点：

- 改成文本源、加了段落索引以后，没有哪一项差得离谱。贴着 16 ms 的两项都是「下一拍」口径（按键到交出画面 p95 16.2 ms、组字 16.5 ms），P0-B 和第一轮也在这条线上下。
- 中途发现打开文档时全文被读了两遍（块 ID 检查一遍、建镜像一遍），量出来冷开单章从 0.89 变成 1.10 ms；改成只读一遍以后是 0.94 ms，全书单线程 78.7 ms（第一轮 74.3）。
- 同一份代码两次测量能差很多（G1 下光标闪烁的空闲 CPU 两次是 0.61% 和 0.06%），所以 G1、G2 谁快谁慢这一轮不下结论。

### 第二轮：要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 合 `main`，照待协调 2 定稿 `ProseSource`：编辑器不再拥有 `LoroDoc`，写入、撤销经 trait；自带最小实现；锚点留在 `gpui-prose`；照 `dr-doc` 规则写对拍 | 完成 | `text/source.rs`、`text/loro_source.rs`、`text/conformance.rs`、`text/drdoc_style.rs`；测试 `conformance_on_the_built_in_source`、`conformance_on_a_dr_doc_style_source`、`dr_doc_style_source_matches_the_built_in_one` |
| 2 | SumTree 段落索引（UTF-8 / UTF-16 / 标量 / 段数 + 块 ID 到段号），替掉前缀数组 | 完成 | `text/index.rs`；测试 `locate_and_start`、`splice_and_set`、`first_bid_wins`；随机测试每步核对索引 |
| 3 | 组字合成 `gpui-ime`（只依赖标准库），`gpui-prose` 依赖它；失焦统一为清掉 + 让系统丢弃；`dr-ui` 改用写进待协调 | 完成 | `next/crates/gpui-ime`（10 个测试，含 `blur_discards_the_composition`）；待协调 6 |
| 4 | 断行拆成 `prose-linebreak`（只依赖 `icu_segmenter`） | 完成 | `next/crates/prose-linebreak`（6 个测试，开不开 `icu` 都过） |
| 5 | 改 `benchmarks.md` 的按键上屏两行；量一次 TextEdit；G1 仍只存补丁、`present_now` 关 | 预算两行已改；TextEdit 没量（理由见上和待协调 1）；G1、`present_now` 照办；上屏数字高负载、仅供参考，空闲时重测 | `benchmarks.md`「预算」；「测量 / 重测上屏」 |

机器可查的汇总在 [f4-milestone-2.json](../acceptance/f4-milestone-2.json)。

## 第一个里程碑

### 一句话

第一个里程碑做完了：探针变成了正式 crate `gpui-prose`，按四条子线分好了目录；块 ID、撤销带锚点、按词和按字素移动、行内标记都补上了；断行改成编辑器和 PDF 能共用的纯函数模块。按键上屏第一次用 Instruments 量到了「真正出现在屏幕上」：GPUI 原样是中位数 25–31 ms、p95 约 36 ms，P0-B 的 13 ms 只量到 GPUI 交出画面。GPUI 的「空闲停时钟」补丁在本机 fork 上做出来了：不闪光标时空闲 CPU 从约 0.7% 降到 0，打字还更快（按键到交出画面中位数 5.9 → 2.1 ms）。工作区仍指向 Zed 官方 `v1.27.0`。

### 大白话

**这一轮做了什么。**

- **正式 crate。** 探针的五个文件拆成了「文本 / 排版 / 输入 / 渲染」四层，每层一个目录。下一轮四条子线可以各开一个会话，各改各的目录。
- **段落有了身份证（块 ID）。** 每段结尾的换行符上记着一个块 ID。回车、并段、跨段删除、粘贴都照 loro-schema v0 的规则让 ID 跟着文字走；两台设备同时在同一段末尾回车造成的重号，读的时候修好，两边修出来一样。
- **撤销能把批注带回来。** 删掉一段带批注的文字再撤销，批注会重新锚在恢复的文字上，并告诉宿主「这个锚点换了」，让它写回书目文档。Loro 的撤销合并间隔仍是 0，同一阵连打由编辑器自己合成一步（绕开 Loro #1228/#1245）。
- **按词、按字移动。** ⌥←/⌥→、⌥⌫ 按词，中文的词来自 ICU 的词典（「我们｜今天｜去｜公园」）；双击选词也一样。方向键和退格按字素簇走：一个家庭表情 👨‍👩‍👧（五个码位）、一面国旗 🇨🇳 都是一步。
- **加粗、斜体、下划线、删除线、链接。** ⌘B/⌘I/⌘U/⌘⇧X；有选区就切换选区，没选区就记下来、作用于接下来打的字。链接用蓝色加下划线。人物链接（`entity:<id>`）留了扩展点，样子由 F4e 定。
- **组字中失焦**照作者定的保持「清掉」：编辑器丢弃拼音，再让系统输入法丢弃。

**上屏到底多快。** P0-B 量的「上屏」是 GPUI 交出这一帧之后的下一个刷新节拍，以为那时字已经在屏幕上了。这次用 Instruments（`xctrace`，Metal System Trace）看真正显示的时刻：GPUI 交出画面后，还要等 WindowServer 合成、再等屏幕刷新，又多出两到三个刷新周期（交出 → 显示的中位数 21–27 ms）。所以：

- GPUI 原样：按键到字出现在屏幕上，中位数 25–31 ms，p95 约 36 ms（几次测量，机器负载不同；证据 [f4-present.json](../acceptance/f4-present.json) 是在别的会话正编译时测的：31.4 / 36.5 ms）；
- 「改完立刻画」（探针里的 `present_now`，走 GPUI 的 `displayLayer:`）：中位数快 2–6 ms，但长尾明显变差（p95 54–137 ms，每次都有一成左右的按键要多等好几个周期）。**结论：不开。** `EditorOptions::present_now` 默认关；
- 打了补丁 G1（见下）以后不开「立刻画」：中位数 25.0、p95 36.1 ms，按键到交出画面只要 2.1 ms。

旧版（WebKit）同一项是用另一种方法量的（29–32 ms 到「第二帧」），也不是真正上屏，不能直接比。**用「真正上屏」量，16 ms 这条线 GPUI 过不了，8.3 ms 任何经过 WindowServer 合成的窗口都过不了**，这件事要重新定预算的口径，见「待协调」第 1 条。

**空闲 CPU。** GPUI 窗口开着时每秒醒 120 次等刷新，不管有没有事做。补丁 G1 让它连续 6 拍（50 ms）没事做就停掉刷新时钟，有事时重新启动，并且当场画这一帧。结果：光标不闪、或者窗口不在前台时，空闲 CPU 从约 0.7% 降到 0.00%；光标闪烁时 0.85% → 0.58%（闪烁本身每秒要画两次）。第一版补丁只重启不当场画，量出来每次停顿后的第一个按键都要多等将近一拍，所以改成了当场画。

**和 P0-B 比有没有退步。** 窗口里的各项（按键交出画面、打字 CPU、打开单章和全书、滚动每帧的工作、跳转、内存、候选窗查询）都持平或更好。数字更差的三项都和这次测量时机器很忙（一分钟负载 19–76，别的会话在编译）有关，都在预算内：滚动的帧间隔 p95 11.4 ms（P0-B 9.4）、单章空闲 CPU 1.17%（P0-B 0.88%，P0-B 已记这项在 0.7–1.4% 之间晃）、组字文字到交出画面 p95 17.0 ms（P0-B 16.7，结构下限就是两拍）。真正的格式代价只有一处：每段多了块 ID，Loro 第一次读出全文（`to_delta`）的工作量翻了一倍，整本书单线程打开从 39 ms 变成约 70 ms；编辑器现在用所有核并行打开各章，窗口里打开全书 29 ms，比 P0-B 的 47 ms 快。逐项见「测量」。

### 要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 建 `gpui-prose`，按 F4a–F4d 分模块，只依赖 gpui + loro，对外 API 写进本文 | 完成 | `cargo check -p gpui-prose --no-default-features` 只编 gpui + loro；本文「对外 API」 |
| 2 | 块 ID、段尾回车挪 ID；撤销项带批注锚点；撤销合并间隔 0、编辑器自己合并 | 完成 | `text/tests.rs`：`enter_moves_block_ids_with_the_text`、`joins_keep_the_right_block_id`、`pasted_paragraphs_get_fresh_ids`、`concurrent_enters_are_repaired_the_same_way`、`undo_brings_a_deleted_anchor_back`、`undo_restores_partially_deleted_anchors`、`undo_restores_anchors_across_merged_backspaces`、`anchor_restore_survives_remote_edits`、`undo_merges_within_interval`；随机测试 `mirror_follows_random_edits_undo_and_imports` |
| 3 | 按词移动和双击选词（ICU）、字素簇移动、行内标记渲染与切换（人物链接留扩展点） | 完成 | `input/tests.rs`：`option_arrows_move_by_chinese_words`、`double_click_selects_a_word`、`arrows_and_backspace_step_over_whole_clusters`、`bold_toggles_on_a_selection_and_at_the_caret`、`links_render_with_their_own_run`；`text/segment.rs` 的测试 |
| 4 | 用 Instruments 量准上屏时间；量准前默认 GPUI 原节奏 | 完成：量法和结果在 [f4-present.json](../acceptance/f4-present.json)；默认仍是原节奏 | 见「测量」 |
| 5 | 组字中失焦保持清掉 | 完成（沿用并保留测试） | `losing_focus_drops_the_composition` |
| 6 | GPUI 补丁台账；空闲停时钟在本机 fork 上试、给出前后对比、补丁存进 `next/patches/gpui/` | 完成；工作区仍指向 Zed 官方 `v1.27.0` | 「GPUI 补丁台账」；[f4-idle-stock.json](../acceptance/f4-idle-stock.json)、[f4-idle-patched.json](../acceptance/f4-idle-patched.json) |
| 7 | 编辑器档各项重跑、和 P0-B 比不能退步 | 完成，一项说明见下 | [f4-headless.json](../acceptance/f4-headless.json)、[f4-window.json](../acceptance/f4-window.json) |
| 8 | （监管会话追加）断行写成不依赖 GPUI 的纯函数模块，和 PDF 导出的规则对齐 | 完成 | `layout/linebreak.rs` 的测试；「中文断行：编辑器和 PDF 的统一规则」 |
| 9 | （监管会话追加）不设计「把内容推回去」的回调 | 完成 | `EditorEvent` 不带正文；待协调 8 |
| 10 | （F1 的约定）编辑器经「文本源」trait 写入、接 `dr-doc` 的撤销 | 记进待协调 2，下一轮 F4a 第一件事；理由见那一条 | — |

机器可查的汇总在 [f4-milestone-1.json](../acceptance/f4-milestone-1.json)。

## 架构

### 分层（子线和目录一一对应）

| 目录 | 子线 | 内容 | 主要文件 |
| --- | --- | --- | --- |
| `src/text/` | F4a 文本存储与索引 | 文本源 trait 和自带的 Loro 实现、一致性检查、段落镜像与 SumTree 索引、块 ID 规则、行内标记、作者撤销、锚点、分词与字素 | `source.rs`、`loro_source.rs`、`conformance.rs`、`doc.rs`、`index.rs`、`mirror.rs`、`blocks.rs`、`marks.rs`、`undo.rs`、`anchor.rs`、`segment.rs` |
| `src/layout/` | F4b 排版与虚拟化 | 段落几何（行、命中、选区矩形）、高度估算与高度表、多篇拼成一个滚动区；断行规则在 `prose-linebreak` crate | `paragraph.rs`、`heights.rs`、`book.rs` |
| `src/input/` | F4c 输入 | 动作与键位、选区、`EntityInputHandler`、移动、编辑、鼠标；组字规则在 `gpui-ime` crate | `actions.rs`、`selection.rs`、`composition.rs`、`ime.rs`、`movement.rs`、`editing.rs`、`mouse.rs` |
| `src/render/` | F4d 渲染 | 标记到文字样式、段落元素、逐行绘制与装饰、本帧记录、光标层、列表项 | `runs.rs`、`element.rs`、`paint.rs`、`frame.rs`、`cursor.rs`、`items.rs` |
| `src/` 根 | 公用 | `ProseEditor` 的状态与每帧（`editor.rs`）、格式常量（`schema.rs`）、样式与选项（`style.rs`）、平台钩子、扩展点 | `editor.rs`、`schema.rs`、`style.rs`、`platform.rs`、`extension.rs`、`lib.rs` |

- **`ProseEditor` 的行为分在各层的文件里**：`input/movement.rs` 写 `impl ProseEditor { fn move_word … }`，`render/items.rs` 写 `fn paragraph …`。Rust 允许同一类型的 `impl` 分在多个文件里，所以并行会话改各自的目录，不碰同一个文件。
- **`editor.rs` 是唯一的共用文件**：结构体字段、`edit()`、`sync_chapter()`、`render()` 里的动作注册。下一轮谁要加字段或动作，在这里只加一行，冲突小。
- `text/` 不依赖 GPUI 的窗口，可以无窗口测试（`text/tests.rs` 全部无窗口）。
- 两个小 crate 和 `gpui-prose` 同一许可：`gpui-ime`（`overlay.rs` 编辑器的组字覆盖层、`line.rs` 单行组字器、`units.rs` 位置换算）和 `prose-linebreak`（`lib.rs`）。

### 正文格式

就是 loro-schema v0 里「正文文档」的 `body` 部分：

- 一篇正文一个扁平的 `LoroText`（根键 `body`），每段以 `\n` 结尾，全文永远以 `\n` 结尾；
- 段落属性（`bid`、`heading` 1–3、`quote`、`indent`、`align`、`rule`、列表等）是打在 `\n` 上的标记，`ExpandType::None`；
- 行内标记（`bold`/`italic`/`underline`/`strike` 为 `After`，`link`、`highlight`、`code`、`entity:<id>`、`embed` 为 `None`）打在其他字符上，跨段时按段切开，不打在 `\n` 上；
- 样式表在 `schema::style_config()`，每个 `LoroDoc` 导入或编辑前都要配上（`schema::configure`）。

读的时候照 v0 的容错规则：只认 `\n` 上的段落属性、忽略 `\n` 上的行内标记、末尾缺 `\n` 时最后一段当没有 ID。

### 文本源

`ProseSource`（`text/source.rs`）是编辑器和文档之间唯一的口子：

| 方法 | 做什么 |
| --- | --- |
| `read_all()`、`read(range)` | 读段落：文字、`\n` 上的段落属性、行内标记的分段（按读取规则：段落属性只认 `\n`，标记不认 `\n`）。`read` 的范围从段首开始、到某个 `\n` 之后或全文末尾结束 |
| `take_events()` | 取走自上次以来的改动：本机编辑、撤销重做、导入。每个事件是 retain / insert / delete 的序列，坐标是改之前的（Quill 式，和 `dr-doc` 的 `ProseEvent` 一样）。插入可以带「这段新字的标记」，带了编辑器就不回读这一段（自带实现带，`dr-doc` 现在不带） |
| `edit(Edit, origin) -> EditResult` | 一次编辑一次提交。`Edit` 有六种：`Replace`（换成一段字，里面的 `\n` 都按回车处理，可以给新字加减标记）、`Delete`、`Split`（回车）、`SetBlockAttr`、`Mark`、`Unmark`。规则全在实现里。`EditResult` 给回新字的范围、光标位置、删掉的几段（改之前的坐标）和这次提交往作者撤销栈里压了几项 |
| `undo_item()`、`redo_item()` | 撤销 / 重做 Loro 撤销栈里的一项。编辑器按阵把几项合成作者的一步，一次撤销调几次 |
| `anchor(range)`、`resolve(&Anchor)` | 建锚点、解析锚点 |
| `import(bytes)` | 可选：自己导入远端更新的文本源实现它；Drifting 的同步在别处导入，导入后宿主调 `ProseEditor::refresh_chapter` |

映射到 `dr-doc`：`Replace` = `ProseTxn::delete` + `insert_paragraphs` + `set_style` / `clear_style`；`Delete` = `delete`；`Split` = `split`；`SetBlockAttr` = `set_block_attrs` / `set_heading`；`Mark` / `Unmark` = `set_style` / `clear_style` / `link_entity` / `unlink_entity`；撤销 = `ProseUndo::undo` / `redo`，每次拿回一个 `Committed` 交给存储；`undo_items` 用 `ProseUndo::undo_count` 前后相减。都在 `dr-store` 的写闭包里做。

### 段落镜像

编辑器排版用的是一份「段落镜像」：每段的文字、段落属性、行内标记的分段（`Span`，按 UTF-8 字节）、长度和版本号，外加一棵 SumTree 段落索引（`text/index.rs`：段数、字符数、UTF-16 单元数、字节数，每项是一段加它的 `\n`）和块 ID 到段号的表。镜像和索引只靠文本源的事件更新：自己打字、撤销重做、远端导入、Agent 写入走同一条路；每处结构变化当场改索引的对应项，打字只改一项。

- **结构**（插入、删除、拆段、并段）直接从事件的增量折进去；
- **打字的快路径**：一段之内插字或删字时，事件本身带着新字的标记，分段原地挪动，不回读 Loro；
- **其余情况**（设格式、回车、并段、远端改格式，以及事件没带新字标记的插入）把受影响的段标成「待回读」，这一批事件折完以后经文本源读这几段，读的时候套用容错规则。

随机测试 `mirror_follows_random_edits_undo_and_imports`（24 个种子 × 120 步：打字、删除、回车、设标题、设引用、加减标记、撤销、重做、远端改字改格式）每一步都把镜像和重新读出来的结果逐段比较（文字、段落属性、标记分段），核对索引，并检查块 ID 不重复、全文以 `\n` 结尾。一致性检查里的随机脚本对任何文本源做同样的事。

### 块 ID

照 v0 的写入规则（`text/blocks.rs`）：

- **回车**：新 `\n` 永远插在光标处。段尾回车，原段的 ID 和属性挪到新 `\n`，旧 `\n` 结束新的空段，拿新 ID、只继承引用缩进对齐列表提示框；段首回车，上面的空段拿新 ID；段中回车，前半段拿新 ID 并继承标题等，后半段留原 ID。
- **并段和跨段删除**：起点所在段吸收终点所在段剩下的文字，保留起点段的 ID 和属性；删掉的正好是几个整段时，后面那段原样不动。
- **粘贴**：粘进来的每个换行都按一次回车处理，所以每段拿新 ID。
- **新 ID** 是那个 `\n` 自己的操作 ID，写成 `"{counter}@{peer}"`。
- **修复**：打开文档时和导入远端更新后，第一个保留，重复或缺失的写上自己 `\n` 的操作 ID（被占用就加 `/1`、`/2`）。修复提交的来源是 `repair`，不进作者的撤销。

这些规则全部直接读写 Loro，不读镜像，所以在一次提交里连着做好几步（粘贴多段）也是对的。

### 行内标记

- `ProseDoc::mark` / `unmark` / `toggle_mark` / `set_link`，跨段自动切开。
- 编辑器：有选区时 ⌘B 等切换选区（全有则去掉，否则全加）；没选区时记成「待用标记」，下一次输入（包括输入法确认）在同一次提交里给新字加上或去掉。光标一动就清掉。
- 渲染：加粗换字重（正文 600，标题 700），斜体换字形，下划线、删除线自己画（编辑器逐字形绘制，不经 GPUI 的整行绘制），链接用链接色加下划线。
- 扩展点：`ProseExtension::style_run(marks, &mut RunStyle, style)`，F4e 用它给人物链接上色；点击时用 `ProseEditor::marks_at(chapter, offset)` 查。

已知：中文字体没有斜体字形，斜体的中文现在画成正体（WebKit 会合成倾斜）。要合成倾斜得改 GPUI 的字形绘制，记进台账，不急。

### 撤销

- 每篇正文一个 Loro `UndoManager`，合并间隔 0，排除来源前缀 `agent:`、`seed`、`genesis`、`import`、`mirror`、`repair`（`UndoConfig` 可改）。
- 编辑器把 Loro 的单项按「阵」合成作者的一步：从这一步第一次编辑起 500 ms 内的都算一步；回车、输入法确认、粘贴、设格式、移动光标都另起一步。撤销一次连续弹出这一步的所有项。全书模式里一个跨章的栈记住每一步落在哪章。
- **锚点**：删除前，编辑器看哪些锚点的边落在要删的文字里，把「边相对删除起点的偏移」记进这一项。撤销这一项后，从这次撤销的事件里找出「插回来的那一段」（长度相同的那次插入），按偏移在新字上重建光标，更新本地的锚点，并发 `EditorEvent::AnchorsChanged` 让宿主写回。重做再删掉时锚点照常收起，再撤销又会带回来。中间有远端改动也对（有测试）。找不到对得上的插入时（远端在同一处插了字，插入被拆开），锚点保持收起，不猜。
- Loro #1229（撤销自己的格式改动会连带抹掉别人对同一键的改动）绕不开，等上游。

### 组字

和 P0-B 一样：拼音只显示不写 Loro；确认时一次写入；组字中 ⌘Z 忽略；拼音删光就取消；别人的改动挪动组字位置；失焦清掉并调用 `PlatformHooks::discard_marked_text`。

规则在 `gpui-ime`：`Overlay`（拼音的位置、被替换的长度、拼音、输入法的选区；`begin` / `mark` / `retarget` / `follow` / `target`）和 `Marked16`（输入法眼里的文字和已提交文字之间的 UTF-16 换算）。编辑器的 `Composition` 就是 `Overlay` 加所在章。`gpui-ime` 里还有单行输入框用的 `LineComposer`（从 F5 的 `Composer` 搬来，失焦改成丢弃）。

### 排版、虚拟化、渲染

沿用 P0-B：编辑器自己按中文禁则断行（悬挂标点），GPUI 只排字形、画单个字形；`list()` 虚拟化，屏幕外段落高度后台估算，滚动条和按像素跳转用编辑器自己的高度表；正文是缓存视图，光标单独一层。新增：

- 文字样式（`TextRun`）由段落的标记生成，组字时把拼音拼进去并加下划线；
- 绘制时按样式画背景、字形颜色、下划线、删除线，只画看得见的行；
- 命中测试、上下移动落点都对齐到字素边界；
- 光标闪烁可以关（`EditorOptions::cursor_blink = None`）。

### 中文断行：编辑器和 PDF 的统一规则

旧版有两套断行：PDF 导出（`src-tauri/src/manuscript_export/pdf/layout.rs`）用 UAX #14（`unicode-linebreak`）加标点挤压；P0-B 的编辑器用手写的禁则表加标点悬挂。第一个里程碑把编辑器的断行写成了**不依赖 GPUI 类型的纯函数**：输入段落文字、每个字形簇的起点 x 和总宽，输出每行的字节范围、起点、悬挂宽度和挤压宽度；第二轮把它拆成了独立的 crate `prose-linebreak`（只依赖 `icu_segmenter`），`gpui-prose` 依赖它（`gpui_prose::layout::linebreak` 是它的重新导出），以后 `dr-text` 和 PDF 导出也依赖它。

| 方面 | 旧版 PDF 导出 | P0-B 编辑器 | 统一后（`linebreak`） |
| --- | --- | --- | --- |
| 断行机会 | UAX #14 | 手写禁则表（CJK 两边可断，拉丁词不拆） | UAX #14（ICU4X 的 `LineSegmenter`，strict 档；`gpui-prose` 已经依赖 ICU4X）加中文修订；不开 `icu` 特性时退回手写表 |
| 「，。、；：？！」和后括号放行首 | UAX #14 已禁 | 表里禁 | 都禁 |
| 引号 “ ” ‘ ’ | UAX #14 把它们都归为 QU，分不清前后：可能让 ” 放到行首、“ 留在行末，也会在「……”」后面不许断 | 表里：” 不放行首，“ 不放行末 | 中文修订：” ’ 不放行首、“ ‘ 不放行末（照 GB/T 15834、W3C clreq）；全角字旁边，“ 前、” 后允许断 |
| 小假名、「ー」「々」放行首 | 允许（UAX #14 默认档） | 不允许 | 不允许（strict 档） |
| 「——」「……」 | 不拆（UAX #14） | 不拆（表） | 不拆 |
| emoji 组合序列、组合附加符号 | 不拆 | 会在 ZWJ 两边断 | 不拆 |
| 行末放不下的点号 | **挤压**：压掉全角闭号的空白半格，够就留在本行；压了也放不下就提前断 | **悬挂**：伸出版心 | 同一个函数，`Overflow` 参数选：编辑器 `Hang`，印刷 `Squeeze` |
| 行内相邻标点挤压（「。」」压半格） | 有 | 没有 | 规则在 `punctuation_squeeze`；PDF 用，编辑器下一轮（F4b）接，要同时改命中测试和光标位置 |
| 两端对齐 | 有 | 没有 | 编辑器下一轮（F4b） |

**取的统一规则**：断行机会一律「UAX #14 strict + 中文修订」；行内标点挤压一律按 PDF 现在的规则。只有行末溢出这一处按媒介分：编辑器悬挂，因为挤压或提前断会在作者打出一个逗号时让前面的字跳到下一行；印刷挤压，因为两端对齐的版面里悬挂的点号会伸出版心。两种做法 clreq 都列为可接受。测试 `opportunities_follow_uax14_and_the_chinese_tailoring`、`rows_hang_a_comma_in_the_editor`、`rows_squeeze_or_break_earlier_in_print`、`rows_keep_opening_quotes_with_what_follows`、`squeeze_inside_a_row` 钉住这些规则。

## 对外 API

「v0 稳定」= 下一轮各子线只加不改；改了要在本节记一笔、同步通知用的人。「可能变」= 下一轮预计会动。

### 文本层（`gpui_prose::text`，F4a）

| 项 | 说明 | 稳定性 |
| --- | --- | --- |
| `ProseSource`（`read_all`、`read`、`take_events`、`edit`、`undo_item`、`redo_item`、`anchor`、`resolve`、可选 `import`、`as_any`）；`Edit`、`EditResult`、`SourceEvent`、`SourceChange`、`SourceParagraph`、`MarkOverride` | 文本源，见「文本源」一节 | v0 稳定（加方法时给默认实现） |
| `LoroSource::{new, with_undo, empty, from_snapshot, from_paragraphs, loro, text, repair_block_ids}` | 自带的文本源：一个本地 `LoroDoc`，v0 写入规则 | v0 稳定 |
| `text::conformance::{run_all, same_behaviour, consistent, enter_rules, join_rules, paste_rules, undo_rules, mark_rules, anchor_rules, random_edits}`（特性 `conformance`） | 给文本源实现者的一致性检查，出错返回 `Err(说明)` | v0 稳定（会加检查） |
| `ProseDoc::open(Box<dyn ProseSource>)` / `open_with(…, &UndoConfig)`；便捷的 `new` / `from_snapshot` / `from_paragraphs` / `from_loro` / `from_loro_with`（都用 `LoroSource`） | 打开一篇正文 | v0 稳定 |
| `source()`、`source_mut()`、`source_as::<T>()`、`loro_source()` | 拿回文本源 | v0 稳定 |
| `lines()`、`line(ix)`、`visible_lines()`、`line_by_bid(bid)`、`line_start`、`locate`、`line_of`、`len_chars`、`len_utf16`、`max_cursor`、`offset_to_utf16`、`offset_from_utf16`、`slice`、`plain_text` | 读镜像和索引；位置一律按 Unicode 标量；都只要 `&self` | v0 稳定 |
| `Line { text, block, kind, spans, chars, utf16, rev }`、`BlockAttrs`、`BlockKind`、`Marks`、`Span` | 一段的样子 | v0 稳定（字段只加不减） |
| `replace`、`replace_styled`、`delete`、`split`、`join_backward`、`set_kind`、`set_block_attr`、`mark`、`unmark`、`toggle_mark`、`set_link`、`range_has_mark`、`marks_before` | 编辑：经文本源，一次调用一次提交 | v0 稳定 |
| `import(bytes)`、`drain()`、`take_changes() -> Vec<ChangeSet>` | 导入（文本源支持时）、把文本源的事件折进镜像、取走变化（`LineSplice`、`TextOp`） | v0 稳定 |
| `checkpoint()`、`undo()`、`redo()`、`can_undo`、`can_redo`、`undo_count`、`UndoConfig` | 作者撤销（按阵分组在编辑器，单项撤销在文本源） | v0 稳定 |
| `set_anchor`、`add_anchor`、`remove_anchor`、`anchor(id) -> Resolved`、`anchors()`、`take_anchor_changes()`；`Anchor::{new, point, encode, decode, resolve}` | 锚点（经文本源建和解析）；编码是两个 `Cursor::encode()` | v0 稳定 |
| `ParagraphIndex`、`ParagraphExtent` | SumTree 段落索引 | 可能变（F4b 要按高度查时会加维度） |
| `text::segment::{…}` | 一段之内的字素和词 | 可能变（F4c 可能改成带缓存的版本） |
| `ORIGIN_USER`、`ORIGIN_AGENT_PREFIX`、`ORIGIN_REPAIR` | 来源 | v0 稳定 |

### 排版层（`gpui_prose::layout`，F4b）

| 项 | 说明 | 稳定性 |
| --- | --- | --- |
| `layout::linebreak::{break_opportunities, break_rows, Overflow, Row, punctuation_squeeze, can_break_between, NO_START, NO_END, advance_em}` | 中文断行，纯函数（文字和宽度进、断点和悬挂/挤压出），不依赖 GPUI | v0 稳定（以后挪到共享的小 crate，见待协调 9） |
| `Book { chapters }`、`Chapter { title, doc }`、`Item` | 多篇正文拼成一个滚动区 | v0 稳定 |
| `ProseLayout`、`Affinity`、`shape`、`column`、`HeightIndex`、`estimate_height`、`BlockMetrics` | 段落几何和高度 | 可能变（F4b 两端对齐、行内混排字号时会动） |

### 编辑器（`gpui_prose::ProseEditor`）

| 项 | 说明 | 稳定性 |
| --- | --- | --- |
| `ProseEditor::new(book, style, window, cx)`、`with_options(…, EditorOptions, …)` | 建编辑器 | v0 稳定 |
| `ProseEditor::element(&entity, cx)` | 嵌入用的元素（缓存视图 + 光标层） | v0 稳定 |
| `bind_keys(cx)`、`KEY_CONTEXT`、`input::actions::*` | 默认键位与动作 | 可能变（F6 的快捷键注册表接管后，键位从那里来） |
| `book()`、`book_mut()`、`selection()`、`composition()`、`style()`、`options()`、`options_mut()`、`list_state()`、`heights()` | 读状态 | v0 稳定 |
| `select(chapter, range, …)`、`jump_to_chapter`、`scroll_by_estimate`、`scroll_y`、`press_enter`、`press_backspace`、`paste_text`、`toggle_mark(key, …)`、`set_link(url, …)`、`mark_active(key)`、`undo`、`redo`、`word_range_at`、`marks_at` | 宿主和测试驱动编辑器 | v0 稳定 |
| `agent_write(chapter, range, text, session, cx)`、`import_remote(chapter, bytes, cx)`、`refresh_chapter(chapter, cx)` | 别人的写入；文本源在编辑器外变了以后调 `refresh_chapter`；选区和组字跟着挪 | `agent_write` 可能变（F3 的命令总线定下 Agent 写入的入口后改成走它） |
| `EditorEvent::{Edited, SelectionChanged, AnchorsChanged}`（`EventEmitter`） | 通知宿主 | v0 稳定（只加变体） |
| `set_platform_hooks(Rc<dyn PlatformHooks>)`：`discard_marked_text`、`present_now` | 平台钩子 | 可能变（打了「丢弃组字接口」补丁后 `discard_marked_text` 可删） |
| `set_extension(Rc<dyn ProseExtension>)`：`style_run` | 扩展点 | 可能变（F4e 会加：输入规则、装饰层、浮条位置） |
| `ProseStyle`、`EditorOptions { present_now, cursor_blink, ime_log }` | 样式与选项 | 可能变（F5 的令牌接进来后换成从令牌来） |
| `after_next_paint`、`painted_lines` | 给基准用 | 可能变 |

### 格式（`gpui_prose::schema`）

`BODY`、`block::*`（`ALL`、`INHERITED_ON_SPLIT`、`INHERITED_AT_END`）、`inline::*`（`entity_key`、`entity_target`）、`style_config()`、`configure()`。和 loro-schema v0 一致，改动跟着 schema 升版本。

## 测量

机器：M3 Pro（12 核，36 GB），macOS 27.0.1，窗口在 120 Hz 内建屏上，release 构建，GPUI = Zed 官方 `v1.27.0`（另注明的除外）。测法见 [benchmarks.md 的「编辑器档的测法（F4）」](../benchmarks.md#编辑器档的测法f4gpui-prose)。

| 项 | 预算 | P0-B | 第一轮 | 第二轮（仅供参考） | 说明 |
| --- | --- | ---: | ---: | ---: | --- |
| 按键到交出画面（程序内探针，下一拍）p95 | ≤ 16 ms（发布档 ≤ 8.3，靠 G1） | 16.6 ms | 15.8 ms | 16.2 ms |  |
| 　同上，「改完立刻画」p95 | — | 15.6 ms | 15.7 ms | 14.8 ms | 探针档的上限值 |
| 按键到交出画面（Instruments）p50 | — | 没量 | 5.9 ms | 6.0 ms |  |
| **按键到真正显示（Instruments）** p50 / p95 | 记录 | 没量 | 31.4 / 36.5 ms | 33.2 / 46.0 ms | 交出 → 显示 p50 27.0 ms（第二轮） |
| 　同上，「改完立刻画」p50 / p95 | — | 没量 | 25.0 / 65.0 ms | 24.9 / 56.2 ms |  |
| 单次按键的写入（中位数） | ≤ 2 ms | 0.025 ms | 0.025 ms | 0.026 ms | Loro 0.014 + SQLite 0.012（第二轮） |
| 打字时的 CPU（每秒 8 字，60 s） | ≤ 15% | 2.67% | 2.03% | 2.26% |  |
| 不操作时的 CPU：全书 / 不聚焦 / 单章 | ≤ 1% | 1.28 / 1.10 / 0.88% | 0.66 / 0.78 / 1.17% | 0.64 / 0.68 / 0.72% | 每次 30 s，0.7–1.4% 之间晃（P0-B 已记） |
| 打开 2 万字章节（中位数） | ≤ 80 ms | 12.9 ms | 12.9 ms | 13.4 ms |  |
| 打开全书（中位数） | ≤ 200 ms | 46.6 ms | 29.0 ms | 22.5 ms | 各章并行导入 |
| 全书快速滚动：每帧工作 p95 / 帧间隔 p95 | ≤ 16.7 ms | 2.4 / 9.4 ms | 1.9 / 11.4 ms | 1.4 / 12.6 ms |  |
| 跳到末章（最差一次） | ≤ 150 ms | 15.4 ms | 13.2 ms | 13.4 ms |  |
| 滚完全书后的内存 | ≤ 800 MB | 258.5 MB | 259.9 MB | 283.5 MB |  |
| 组字：候选窗位置查询 p95 | ≤ 16 ms | 0.25 ms | 0.16 ms | 0.17 ms |  |
| 组字：文字到交出画面 p95 | ≤ 16 ms | 16.7 ms | 17.0 ms | 16.5 ms | 下一拍口径，结构下限两拍 |
| 冷开全书的 Loro 文档：单线程 / 所有核 | 记录 | 38.6 / — ms | 74.3 / 14.7 ms | 78.7 / 14.9 ms |  |
| 冷开单章（无窗口） | — | 0.49 ms | 0.89 ms | 0.94 ms |  |
| 带 500 处人物链接、200 段加粗的单章：打开 / 链接里打一个字 | — | 没量 | 3.71 / 0.005 ms | 3.69 / 0.007 ms |  |

空闲 CPU，GPUI 补丁 G1 前后（单章、窗口可见，每项 30 s，[f4-idle-stock.json](../acceptance/f4-idle-stock.json) / [f4-idle-patched.json](../acceptance/f4-idle-patched.json)；括号里是第一轮）：

| 情形 | Zed 官方 v1.27.0 | 打了 G1 |
| --- | ---: | ---: |
| 聚焦，光标闪烁 | 0.74%（0.85%） | 0.06%（0.58%） |
| 聚焦，光标不闪 | 0.75%（0.69%） | 0.00%（0.00%） |
| 不聚焦 | 0.67%（0.67%） | 0.00%（0.00%） |

打了 G1 以后的真正上屏（[f4-present-patched.json](../acceptance/f4-present-patched.json)）：原节奏 p50 / p95 24.4 / 40.6 ms、按键 → 交出 p50 1.1 ms；「改完立刻画」24.4 / 73.8 ms。

加上实验补丁 G2（`displayLayer:` 不开事务、不重启显示链接，[f4-present-direct.json](../acceptance/f4-present-direct.json)）：「改完立刻画」p50 / p95 24.9 / 43.0 ms，按键 → 交出 p50 1.1 ms。

**第二轮的数字都是高负载下量的，仅供参考。** 测量前后取到的一分钟负载最高值（12 核，2 以下才算空闲）：无窗口 8.23，窗口 19.59，Instruments（官方）9.08，Instruments（G1）12.01，Instruments（G1 + G2）11.74，空闲（官方）11.33，空闲（G1）23.31。这些证据文件里 `conditions.reference_only` 是 `true`。不能拿它们比较 G1、G2 的好坏，也不能和第一轮逐项比快慢（第一轮测量时负载也在 5–76 之间）。同一份代码两次测量能差很多：这一轮 G1 下光标闪烁的空闲 CPU 两次量出 0.61% 和 0.06%，滚完全书的内存 248 和 284 MB。它们只说明在很忙的机器上没有哪一项差得离谱：两项「下一拍」口径的 p95（按键 16.2、组字 16.5 ms）贴着 16 ms 的线，P0-B 和第一轮也在这条线上下；其余都在预算内。

对上的按键（其余按键在 Instruments 的显示表里找不到对应记录，负载高时会这样）：G1 立刻画 146 / 160。

### 重测上屏（机器空闲时）

这一轮的上屏和空闲 CPU 都是在别的会话编译、测试时量的，证据里自动标了「高负载、仅供参考」（`conditions.reference_only: true`）。上屏的最终数字由作者或监管会话找机器空闲的时候重测，步骤：

1. 关掉别的编译、测试和 `pnpm dev`，等一分钟负载降到 2 以下（`sysctl -n vm.loadavg` 的第一个数）。`prose-bench` 在每次测量前后各取一次负载，最高值不低于 2 就把证据标成仅供参考；`prose-bench check` 会把这样的文件列出来，但不算失败。
2. 窗口要在内建屏上、不被挡住；测量时别动键盘鼠标（每次约一分钟，窗口会弹到最前面）。
3. 在 `next/` 下，Zed 官方 GPUI：

   ```bash
   cargo build --release -p gpui-prose --example prose-bench
   ./target/release/examples/prose-bench present --out ../docs/rust-rewrite/acceptance/f4-present.json
   ./target/release/examples/prose-bench idle --out ../docs/rust-rewrite/acceptance/f4-idle-stock.json
   ./target/release/examples/prose-bench window --out ../docs/rust-rewrite/acceptance/f4-window.json
   ```

4. 打了 G1：照下面「本机 fork 怎么用」临时把 `[patch]` 指到 fork（fork 打上 `next/patches/gpui/0001-*.patch`；量 G2 再打 `0002-*.patch`），重新构建，设 `PROSE_BENCH_GPUI` 写明用的补丁，然后：

   ```bash
   ./target/release/examples/prose-bench idle --out ../docs/rust-rewrite/acceptance/f4-idle-patched.json
   ./target/release/examples/prose-bench present --out ../docs/rust-rewrite/acceptance/f4-present-patched.json
   GPUI_PRESENT_NOW_DIRECT=1 ./target/release/examples/prose-bench present --out ../docs/rust-rewrite/acceptance/f4-present-direct.json
   ```

   量完删掉 `[patch]` 一节、还原 `Cargo.lock`，确认 `grep gpui-fork Cargo.toml Cargo.lock` 没有输出。
5. `./target/release/examples/prose-bench check ../docs/rust-rewrite/acceptance/f4-*.json`，再把本节的表换成新数字。

`present` 每个配置录一次约 30 秒的 Instruments。`xctrace` 偶尔会卡住，这一轮遇到两种：目标进程卡在启动阶段（半小时），以及 `xctrace` 还没启动目标就停住（18 分钟）。每次录制限时 180 秒、超时自动重录（最多三次），管得住前一种；后一种限时不起作用，要手动结束那个 `xctrace record` 进程，`prose-bench` 会接着重录。手动结束后紧接着的那次录制可能一个按键都对不上（这一轮遇到过），证据里 `matched` 是 0 就重跑那一项。

## GPUI 补丁台账

GPUI 的 fork 由 F4 负责（D1：需要挂补丁时再开 fork）。现在工作区仍然指向 Zed 官方 `v1.27.0`，补丁只存成文件，`main` 不依赖任何本机路径。

| # | 补丁 | 状态 | 改哪里 | 规模 | 设计 | 上游 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 空闲时停掉刷新时钟 | **已写、本机 fork 上量过**：`next/patches/gpui/0001-macos-stop-idle-display-link.patch` | `gpui_macos/src/window.rs` | +94 行 | v1.27 的 GPUI 已经有「平台空闲时停帧、有事时唤醒」的接口（`PlatformWindow::frame_waker`，网页端在用），macOS 没实现。补丁：macOS 实现 `frame_waker`；显示链接每一拍记下这一拍有没有画（`draw` 置位）、有没有新的需求（唤醒置位），连续 6 拍（120 Hz 下 50 ms）两样都没有就停掉显示链接。GPUI 在窗口变脏、要下一帧回调、节流重试时都会调唤醒；唤醒时在主队列的下一轮重新启动显示链接，**并且当场画这一帧**（不等重启后的第一拍，不开 CA 事务）。第一版只重启不当场画，量出来每次停顿后的第一个按键要多等将近一拍（按键到交出画面中位数 4.6 → 14.7 ms），所以改成当场画。唤醒可能发生在持有窗口状态锁的平台回调里，所以唤醒本身不拿锁，只置标志、排到主队列 | 高：Zed 自己也省电，接口是现成的。先在 Drifting 用一段时间，再提 PR |
| G2 | 输入后立即绘制（不经 CA 事务、不重启显示链接） | **实验，量过，不挂**：`next/patches/gpui/0002-experiment-present-now-direct.patch`，环境变量 `GPUI_PRESENT_NOW_DIRECT=1` 才生效 | `gpui_macos/src/window.rs` 的 `displayLayer:` | +20 行 | 现在的「改完立刻画」走 `setNeedsDisplay:` → `displayLayer:`，GPUI 在这条路上开 `presentsWithTransaction`、停掉再启动显示链接，造成长尾。实验让 `displayLayer:` 直接画、不开事务、不动显示链接。结果：有了 G1 以后，G2 的「立刻画」中位数 25.0、p95 33.3 ms，和只开 G1、不开「立刻画」（25.0 / 36.1 ms）差不多；只有 G2 才能去掉「立刻画」的长尾（不开 G2 时 p95 137 ms）。**第一轮的结论：不需要 G2**，G1 当场画醒来的那一帧已经拿到了好处。两轮都是在高负载下量的，这个结论等空闲时重测再确认 | 中：要先证明有用；正式版应该是单独的「输入后立即画」入口，不改 `displayLayer:`（它也管窗口缩放时的同步绘制） |
| G3 | 丢弃组字的接口 | 未做 | `gpui/src/platform.rs` 加 `PlatformWindow::discard_marked_text`；macOS 调 `[NSTextInputContext discardMarkedText]`，Windows 调 `ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` | 约 30 行 | 现在由程序的 `PlatformHooks` 自己调（macOS 十来行 objc）。有了接口，`PlatformHooks::discard_marked_text` 可以删 | 中 |
| G4 | Windows 组字丢弃（IMM32） | 未做，下一轮（F4c） | 不改 GPUI 也能做：程序层拿到 HWND，`ImmGetContext` → `ImmNotifyIME(…, CPS_CANCEL)` → `ImmReleaseContext` | 约 20 行 | 先写成 `PlatformHooks` 的 Windows 实现；G3 合了以后挪进 GPUI | — |
| G5 | 中文斜体合成倾斜 | 未做，不急 | `gpui_macos` 的字形光栅化加倾斜变换 | 待估 | 苹方没有斜体字形，现在中文斜体画成正体 | 低 |
| G6 | 中文断行 | 不需要 | — | — | 上游 #64624（ICU UAX #14）不在 v1.27.0；即使升级，编辑器自己断行仍更合适（悬挂、以后两端对齐） | 已在上游 |

**本机 fork 怎么用**（只在测量时临时用，不提交）：fork 是 Zed `v1.27.0`（`c84af5b`）的本地克隆，放在家目录下单独的文件夹，没有远端。临时在 `next/Cargo.toml` 末尾加一节 `[patch."https://github.com/zed-industries/zed"]`，把锁文件里来自 Zed 仓库的 20 个 crate（`gpui`、`gpui_macos`、`gpui_platform`、`collections`、`sum_tree`、`scheduler` 等，见 `Cargo.lock` 里 `source = "git+https://github.com/zed-industries/zed?tag=v1.27.0"` 的那些）都指到 fork 的路径；只换 `gpui_macos` 一个不行，它的依赖会变成第二份 `gpui`。量完删掉这一节、还原 `Cargo.lock`。以后正式挂补丁时，把 fork 推到 GitHub 上一个仓库，`[patch]` 改成指向那个仓库的固定提交（D1）。

## 待协调

1. **按键上屏的预算（监管会话已定）。** 拆成两条，`benchmarks.md` 已改：「按键到交出画面」照旧 16 / 8.3 ms，发布档靠 G1；「按键到真正显示」只记录。G1 正式挂上要开可推送的 GPUI fork，发布档前由作者定；这之前补丁只存成文件，`present_now` 关。两轮的上屏都是在高负载下量的（第二轮的证据标了仅供参考），G1、G2 好不好、「按键到真正显示」的最终数字，由作者或监管会话找机器空闲时照「测量 / 重测上屏」重测。
   - **TextEdit 参照还没量，要作者点头一件事。** 量法：`prose-bench` 加一个子命令，打开 TextEdit 的一个空文档、把它的窗口放到最前，往它的进程发按键（`CGEventPostToPid`）并在每次按键前打 `os_signpost`，在 Instruments 下录约 30 秒；TextEdit 不用 Metal，没有我们用的那张「显示」表，所以用 Core Animation 的提交（`Commit` 信号）加 WindowServer 的帧交换（`displayed-surfaces-interval`）来对，并用同样的方法再量一次 `gpui-prose`，两边口径一致。要点头的是：这半分钟 TextEdit 会挡在作者的窗口前面，而且往别的程序发按键多半要给终端开「辅助功能」权限。这两件都超出了这一轮的约定（不接管屏幕、不改系统设置），所以没做。
2. **文本源 trait（F1 的约定，这一轮做完）。** 定稿的样子见「文本源」一节，和上一轮草案的差别：读是 `read_all` / `read(range)` 返回段落（不把 `LoroText` 交出去，因为 `dr-doc` 不暴露它）；撤销是 `undo_item` / `redo_item` 一次一项，按阵分组留在编辑器；`EditResult` 带 `undo_items`，让编辑器知道这次提交压了几项。剩下给 F4e 和 F1 的：
   - **`dr-editor` 的实现（F4e）**：用 `dr-doc` 的 `ProseTxn` 和 `ProseUndo` 实现 `ProseSource`，写入都放进 `dr-store` 文档持有者的写闭包，读走 `DocView`，锚点的 `get_cursor_pos` 放进读闭包；开 `gpui-prose` 的 `conformance` 特性，测试里跑 `conformance::run_all`，再和 `LoroSource` 跑 `conformance::same_behaviour`。`gpui-prose` 里的 `text/drdoc_style.rs` 是照这个形状写的样板。
   - **给 F1 的小建议**：`dr-doc` 的 `ProseEvent` 里插入不带标记（`TextChange::Insert { text }`），编辑器只好每打一个字就回读这一段。如果 `TextChange::Insert` 加一个可选的 `marks`（Loro 的事件本来就有），`dr-editor` 就能把它传给 `SourceChange::Insert.marks`，打字不必回读。不急，回读一段约几微秒。
   - **每次按键的查询**照约定用 F4a 自己的索引，不调 `ProseView::paragraph_at` / `paragraph_by_id`。
3. **样式表只能有一份（给 F1）。** Loro 不把样式表存进文档，同一个文档配两次时后配的覆盖先配的。Drifting 里文档由 `dr-doc` 配（`dr-editor` 不要再调 `gpui_prose::schema::configure`）；`gpui_prose::schema::style_config()` 和 loro-schema 一致，留给 `LoroSource` 和对拍用。建议 `dr-editor` 的测试逐键比较两张表，以后谁改表，两边一起改、升 schema 版本。
4. **锚点的编码和语义（给 F1）。** `gpui_prose::Anchor` 存两个 `Cursor::encode()`：`start` 是第一个被锚字符上的 `Side::Left`，`end` 是最后一个被锚字符上的 `Side::Right`，和 loro-schema v0「锚点」一节、P0-C 的 `anchor.rs` 一样。`dr-doc` 读写书目文档里的 `anchor` 字段时用同样的编码，`dr-editor` 在两边之间原样搬字节。撤销带回的锚点通过 `EditorEvent::AnchorsChanged` 交给宿主写回书目文档（这是本机作者的操作，要同步出去，和「替换光标只存本机缓存」不同）。
5. **打开文档的分工（给 F1/F2，第二轮后）。** `gpui-prose` 不再打开 Drifting 的文档：创世、对等方 ID、时间戳、样式表、块 ID 修复都是 `dr-doc` / `dr-store` 的事，`dr-editor` 把已经打开的文档包成文本源交给编辑器（`ProseDoc::open`）。自带的 `LoroSource` 只给独立使用者和测试，它自己配样式表、修块 ID（来源 `repair`）。`ProseDoc` 和文本源都是 `Send`，可以在后台线程打开。
6. **组字逻辑合到一处（给 F5）。** 规则已经在 `next/crates/gpui-ime`（只用标准库，MIT OR Apache-2.0）：`LineComposer` 是从 `dr-ui` 的 `Composer` 搬过来的，接口照旧（`replace`、`replace_and_mark`、`unmark`、`discard`、UTF-16 换算、编辑键），差别有三处：失焦（`blur`）改成丢弃，这是作者定的规则，测试 `blur_discards_the_composition`；字素边界由调用方传入（实现 `gpui_ime::Boundaries`，`dr-ui` 用 `unicode-segmentation` 包一层就行）；类型名叫 `LineComposer`。F5 下一个里程碑把 `dr-ui/src/input/compose.rs` 换成 `gpui_ime::LineComposer`，失焦时同时调系统的 `discardMarkedText`。编辑器用的是同一个 crate 里的 `Overlay`。
7. **Agent 写入的入口（给 F3）。** 现在是 `ProseEditor::agent_write`（来源 `agent:<会话>/<轮>`，不进作者撤销）。F3 的命令总线定下来以后，Agent 写入应该走命令层写 `ProseDoc`，编辑器只通过 `import_remote` 一类的「别人的改动」路径看到它。
8. **派生数据不从编辑器推回去（监管会话定的）。** 旧版的大纲、字数、引用是编辑器组件每 400 ms 防抖推回去的（`entity-editor-session.ts`）。新版 `gpui-prose` 只改 Loro 文档，没有任何「把内容推回去」的回调；派生数据由 `dr-store` 按 Loro 的变化自己算。编辑器的事件（`EditorEvent`）都不带正文：`Edited` 只给界面用（比如工具栏状态），`AnchorsChanged` 是撤销改了锚点本身（锚点存在正文之外，见第 4 条）。
9. **断行规则共用（给以后建 `dr-text` 和改 PDF 导出的会话）。** 已经是独立的 crate `next/crates/prose-linebreak`（只依赖 `icu_segmenter`）。PDF 导出改用它时，行末用 `Overflow::Squeeze`，行内用 `punctuation_squeeze`。
10. **快捷键（给 F6）。** 键位现在由 `bind_keys` 绑在 `ProseEditor` 上下文里；F6 的快捷键注册表接管时，动作名（`prose_editor::ToggleBold` 等）保持不变。

## 下一轮怎么拆

文本源 trait 已经落地，四条子线和 F4e 可以分给并行会话了：各改各的目录，共用文件 `editor.rs` 每路只加字段和动作注册各一行。

| 子线 | 目录 | 下一轮的活 |
| --- | --- | --- |
| F4a 文本存储与索引 | `src/text/` | 复制粘贴的内部富文本格式（带标记和段落属性）与 Markdown；段落属性改动的快路径（设标题不必回读整段）；`segment` 按段缓存；配合 F4e 让 `dr-editor` 的文本源过一致性检查 |
| F4b 排版与虚拟化 | `src/layout/`、`prose-linebreak` | 两端对齐；行内标点挤压接进编辑器（命中测试和光标一起改）；行内不同字号；打字机滚动；跨章选区要的几何；拖选到窗口外时的自动滚动节奏 |
| F4c 输入 | `src/input/`、`gpui-ime` | Windows：IMM32 丢弃组字（台账 G4）、Windows 键位；跨章选区；查找替换的选区模型；双击后拖动按词扩展、三击后按段扩展；读屏（AccessKit，GPUI v1.27 已带） |
| F4d 渲染 | `src/render/` | 画层接口：字下面、字上面各一层，给批注砂笔、查找高亮、Agent 改动显现用；块样式（引用、缩进、对齐、分隔线）；沉浸写作的段落淡出；滚动条标记；中文斜体（台账 G5） |
| F4e Drifting 扩展 | 新建 `crates/dr-editor`（AGPL） | 先做 `dr-doc` 上的 `ProseSource` 并跑一致性检查（待协调 2）；然后人物链接的 @ 选择、自动链接、断链修复、样式（经 `style_run`）；斜杠菜单；Markdown 输入规则（含中文字后紧跟 `**`）；TODO 标记；章末 ⁂；选中文字时的横向浮条；Agent 改动显现；接 `dr-doc` 的锚点读写（待协调 4） |

GPUI 补丁 G1 什么时候正式挂上，由作者在发布档前定（需要一个可推送的 fork 仓库）。挂上以后 `EditorOptions` 不用改。

## 已知限制

- 中文斜体画成正体（见 G5）。
- 复制粘贴只有纯文本；粘贴的多段一律按回车规则拆开（第一段并进光标所在段）。
- 选区不能跨章。
- 块样式里只有 H1/H2/H3 有样子；引用、缩进、对齐、列表的属性会被正确保存和继承，但还没画出来。
- 真输入法的手测清单沿用 [P0-B](../spikes/p0-b-editor.md#待作者手测)，命令换成 `cargo run --release -p gpui-prose --example prose-bench -- chapter`（`PROSE_BENCH_IME_LOG=1` 打印输入法调用）。
