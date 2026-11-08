# F4 编辑引擎：gpui-prose

2026-11-07 起。代码在 `next/crates/gpui-prose`（Drifting 自己的那一层在 `next/crates/dr-editor`，AGPL，见「第三轮」），加两个小 crate `next/crates/gpui-ime`（组字规则，只用标准库）和 `next/crates/prose-linebreak`（中文断行，只依赖 `icu_segmenter`），三个都是 `MIT OR Apache-2.0`。`gpui-prose` 依赖 `gpui`（和它自带的 `sum_tree`）、`loro`、这两个小 crate，默认特性 `icu` 另加 ICU4X 分词，不依赖任何 `dr-*`。计划见 [foundation.md 的 F4 一节](../foundation.md#f4-编辑引擎gpui-prose-与-dr-editor)，正文格式见 [loro-schema.md](../loro-schema.md)，起点是 [P0-B 探针](../spikes/p0-b-editor.md)。

## 第四轮（F4e 第二批：交互）

章首、章末给宿主留的位置和页的数据（M03），@ 选择器、斜杠菜单、自动人物链接和断链修复、选区浮条，以及 F6 提的三件，记在 [f4e-editor.md](f4e-editor.md)。

## 第三轮（F4e：dr-editor）

### 一句话

Drifting 的正文能在新版里编辑并落盘了：新的 AGPL crate `next/crates/dr-editor` 把 `gpui-prose` 接到 F3 的工作区上，作者打的每个字都是 `dr-doc` 的一次事务、经 F3 的编辑会话写进 F2 的持有者、提交前先落盘，搜索、字数、派生索引跟着变；Agent 的命令改了打开的这一章，编辑器当成「别人的改动」看到，作者的撤销不碰它。真正的 `dr-doc` 文本源过了 `gpui-prose` 的整套一致性检查，在 16 组 × 120 步随机编辑下和 `LoroSource` 逐字一样；两张样式表逐键一致。第一批扩展做了人物链接的样子、Markdown 输入规则（含中文字后紧跟 `**`）、TODO 标记识别；`cargo run -p dr-editor --example edit` 在 showcase 种子上开一章编辑，`-- --check` 不开窗口做一遍「编辑 → 关库 → 重开 → 核对」。

### 大白话

- **写入走工作区。** 编辑器的文本源 `SessionSource` 套在 F3 的 `ProseSession` 上：每次编辑在持有者的写入任务里开 `dr-doc` 的事务（回车挪块 ID、粘贴给新 ID、标记不落在换行上，都是 `dr-doc` 那一份规则），来源 `user`，一次提交，落盘以后才发事件，所以工作区的缓存、搜索索引、字数都看得见。撤销、重做是会话的 `ProseUndo`（合并间隔 0，只撤 `user`）。编辑器自己把一阵连打合成一步，这一点不变。
- **读和锚点在持有者线程上。** 读全文、读一段、建锚点、解析锚点，都用 F2 的 `DocHandle::read` 放到持有者线程上、在两次写入之间做，所以永远看不到半个提交；解析锚点可能隐式提交，也只能放在那里（F3 的规矩）。正文按原样读（`to_delta`），用 `gpui-prose` 的读法，规则就是 schema 的规则。
- **别人的改动。** 文本源订阅正文：作者的、Agent 命令的、同步导入的、修复的提交，都进同一个队列，插入的字带着标记，所以打字从不回读一段。Agent 改动打开的这一章时，工作区的 `Prose` 事件在持有者线程上到达，视图把它挪到主线程，编辑器把队列折进镜像。
- **一个并发的坑，补上了。** 别的线程也在写这篇文档，编辑器「先取事件、再读一段」之间如果插进一次提交，那次提交会被算两遍。`gpui-prose` 的 trait 加了两个有默认值的方法：`resync`（读全文并丢掉到此为止的事件，一步完成）和 `needs_resync`。`SessionSource` 在持有者线程上数「推进了几个事件、编辑器取走了几个」，读的时候发现多了就标记，编辑器随即整篇对一遍，只把不同的段落换掉（选区在别处的不动）。`LoroSource` 是单线程的，用默认实现。有测试。
- **对拍抓到 `LoroSource` 三处和 `dr-doc` 不一样，都照 `dr-doc` 改了。** 随机编辑加到 16 组 × 120 步以后，和真正的 `dr-doc` 比出三处：① 把段落属性设成它本来的值（比如已经是引文的段再设引文），`LoroSource` 照样写一次，作者的撤销栈多了一步「什么也不变」的撤销；现在值没变就不写。② 清掉行内标记时 `dr-doc` 连换行一起清，`LoroSource` 跳过换行；现在一样了。③ 在斜体字后面粘贴两段，新换行从 Loro 的延续规则里沾上了斜体，第二段开头的字跟着变斜体；`dr-doc` 写换行时会把行内标记拿掉（标记不落在换行上），现在 `LoroSource` 也拿掉了，粘贴和逐字打出来的结果一样。`gpui-prose` 里照 `dr-doc` 写的测试用文本源也同步改了这三处。
- **样式表只由 `dr-doc` 配。** `dr-editor` 不调 `gpui_prose::schema::configure`。`gpui-prose` 把样式表导出成常量 `STYLE_TABLE` 和默认规则 `DEFAULT_EXPAND`（`configure` 现在也设默认规则，和 `dr-doc` 一样：以后新增的标记默认不延续）；`dr-editor` 的测试拿 `dr-doc` 的 `STYLE_TABLE` 对 `gpui_prose::schema::style_config()` 逐键比，再用 `dr-doc` 的 `style_table_mismatches` 比一遍。
- **人物链接的样子。** `entity:<id>` 标记的字用链接色加细下划线；目标已经删掉或进了废纸篓，就变成灰字、只留下划线。目标在不在，查 F3 的目录（`BookCatalog`，和位置链接同一套），按目标缓存，书一变就清掉。还没链上的名字（`dr-text` 匹配器找到的）要画成建议，等 F4d 的画层接口（见待协调）。
- **Markdown 输入规则。** 照旧版：`**粗**`、`__粗__`、`*斜*`、`_斜_`、`~~删~~` 在打出收尾记号时变成标记、记号消失，接着打的字不带这个标记；被标的字不能以空格开头或结尾。中文没有空格，所以 `他把**吸铁石**拍在桌上` 也认；单个 `*`、`_` 和 `__` 前面仍要是空格或非单词字符，`snake_case`、`a*b*c` 不会误伤。段首的 `# `、`## `、`### ` 变 H1/H2/H3，`> ` 变引文。机制在 `gpui-prose`（扩展的新钩子 `input_rule`，规则的结果作为单独的一步撤销，⌘Z 能把原样的 Markdown 找回来），规则在 `dr-editor/src/rules.rs`，是纯函数。
- **TODO 标记。** 照旧版的规则：段首（可有空白）是 `TODO`（不分大小写）或 `待办`，后面至少一个空格、`:` 或 `：`，其余是任务。编辑器每次改动后重新找一遍，变了就发 `ChapterEditorEvent::TodoMarkers`（带段落的块 ID）。把它们投成待办要 F3 的命令（见待协调）。
- **给 F6 的接入点。** `ChapterEditor` 是一个 GPUI 视图：`ChapterEditor::open(ws, book, "node:<id>", settings, window, cx)`，放进稿纸区就是它本身；`switch_to(doc)` 换一章（或构想、要素的正文）；`set_settings(EditorSettings::from_values(|k| Some(Settings::read(cx).get(k))), cx)` 读编辑器设置（`dr-editor` 不依赖 `dr-shell`，键名和外壳注册表的一样）；`set_base_style` 换主题颜色。事件：`Edited`、`TodoMarkers`、`AnchorsChanged`。
- **例子。** `cargo run -p dr-editor --example edit`：库放在开发版数据目录里单独的 `dr-editor-example` 文件夹（不碰程序的 `library`），第一次运行写入 showcase 种子；窗口底下一行显示书的字数和 `--search` 的命中数，每秒从工作区读一次，F2 在文档空闲后补索引，所以打完字一两秒就变。关掉再开，字还在。`-- --check` 不开窗口：在第一章末尾打「编辑器检查」，关库、重开，核对正文、搜索、字数，再删掉、核对删掉也落盘了。本机跑过：正文落盘、搜索命中 1、字数 71000 → 71005（每个汉字一个字）、删掉后复原。
- **基准。** 新的 `cargo run --release -p dr-editor --example editor-bench` 在 F8 的种子（Lite：20 章、16.5 万字）上量 Drifting 真正的写入路径，写成 F8 格式的证据 [f4-m3-editor-bench.json](../acceptance/f4-m3-editor-bench.json)（`cargo xtask check` 认得，算新鲜）。窗口和上屏那一套（`prose-bench`）这一轮没搬，理由见「下一轮怎么拆」。

**测量（写入路径，[f4-m3-editor-bench.json](../acceptance/f4-m3-editor-bench.json)）。** F8 的 Lite 种子（20 章、165316 字，最长一章 22005 字），release 构建，测量时一分钟负载 10.64（别的会话在编译，仅供参考；F8 的格式记下了负载）。p50 / p95：

| 项 | 预算 | 数字 | 说明 |
| --- | --- | ---: | --- |
| 打一个字（经会话写入、落盘、事件回到镜像） | 中位数 ≤ 2 ms | 0.40 / 7.12 ms | 第二轮 `LoroSource` + 单独 SQLite 的同一项中位数 0.026 ms；多出来的是持有者线程的往返和 `dr-store` 的落盘，仍远在预算内 |
| 撤销一步 | — | 5.61 / 13.32 ms | 一步一项，每项是持有者的一个写入任务 |
| 打开一章（持有者从 SQLite 冷开） | ≤ 80 ms | 2.49 / 5.45 ms | |
| 再开同一章（持有者已开） | — | 0.33 / 0.91 ms | |
| 全书 20 章逐章打开 | ≤ 200 ms | 24.4 ms | 一个线程依次开；窗口里会并行 |
| Agent 的命令（`prose.replace`） | — | 1.55 / 3.01 ms | 命令本身，含落盘 |
| 编辑器把它折进镜像 | — | 0.015 / 0.028 ms | 事件里带着标记，不回读 |

**旧证据。** 这一轮改了 `gpui-prose` 的源码（输入规则钩子、`set_style`、`resync`、上面三处），第二轮的 `f4-*.json`（无窗口、窗口、上屏、空闲、里程碑清单）的源码指纹因此对不上，`prose-bench check` 会报过期；`cargo xtask check` 把它们算作「旧格式，由自己的程序检查」，不算失败。它们和基准搬家、空闲重测一起重跑（见「下一轮怎么拆」），这一轮没有在高负载下再跑一遍。

### 第三轮：要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 用 `dr-doc` 的 `ProseTxn` / `ProseUndo` 实现 `ProseSource`：写入在持有者的写闭包里，读走 `DocView`，锚点的 `get_cursor_pos` 在读闭包里；样式表只由 `dr-doc` 配，逐键对拍；打开分工照待协调 5 | 完成（读和锚点用 `DocHandle::read`，即持有者线程上的读闭包，比 `DocView::with_doc` 更严，见「大白话」） | `dr-editor/src/source.rs`、`convert.rs`；`tests/source.rs`：`the_session_source_passes_the_conformance_suite`、`the_session_source_behaves_like_the_built_in_one`、`the_style_tables_agree_key_by_key`、`a_commit_between_events_and_a_read_resyncs_the_mirror` |
| 2 | 经过 F3：编辑器作为工作区的参与者打开正文；Agent 写入走命令层，编辑器只当「别人的改动」看到；撤销带回的锚点经 `AnchorsChanged` 写回书目 | 前两件完成；锚点读出来了、撤销后的新锚点作为事件交出，**写回书目缺 F3 的命令**（待协调 F3-1） | `tests/source.rs`：`an_agents_command_reaches_the_editor_as_someone_elses_change`；`tests/editor.rs`：`typing_persists_through_the_workspace`、`an_agents_command_shows_up_in_the_open_editor` |
| 3 | 人物链接的显示（`style_run`，名字来自 F3 目录 / `dr-text` 匹配器）、Markdown 输入规则（含中文字后的 `**`）、TODO 标记识别 | 完成；未链接名字的「建议」显示等 F4d 画层 | `links.rs`、`rules.rs`（4 个测试）、`todo.rs`（3 个测试）；`tests/editor.rs`：`markdown_after_a_chinese_character_becomes_bold`、`headings_from_markdown`、`chapters_switch_and_todo_markers_are_found`；`gpui-prose` 的 `input_rules_apply_as_their_own_step` |
| 4 | `cargo run -p dr-editor --example edit`：showcase 建库（开发 profile 目录），开一章编辑，关掉重开内容还在，搜索和字数跟着变 | 完成 | `examples/edit.rs`；`-- --check` 的输出见上 |
| 5 | 给 F6 留接入点：视图怎么放进稿纸区、怎么切换章节、设置从 `Settings::read(cx)` 读 | 完成 | `view.rs`（`ChapterEditor`）、`settings.rs`；`tests/editor.rs`：`settings_change_the_editor_style`、`chapters_switch_and_todo_markers_are_found` |
| 6 | 基准搬进 `dr-editor`（或单独的基准 crate），语料换成 `dr_testkit::seed` | 写入路径的基准做了（新、F8 格式）；窗口和上屏那一套下一轮和空闲重测一起搬 | `examples/editor-bench.rs`、[f4-m3-editor-bench.json](../acceptance/f4-m3-editor-bench.json) |
| — | 新 crate 进 members、登记进 `xtask` 的层（界面层）、`cargo xtask check` | `dr-editor` 早已在 `LAYERS` 里登记为界面层；`cargo xtask check` 全过 | — |

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

映射到 `dr-doc`：`Replace` = `ProseTxn::delete` + `insert_paragraphs` + `set_style` / `clear_style`；`Delete` = `delete`；`Split` = `split`；`SetBlockAttr` = `set_block_attrs` / `set_heading`；`Mark` / `Unmark` = `set_style` / `clear_style` / `link_entity` / `unlink_entity`；撤销 = `ProseUndo::undo` / `redo`，每次拿回一个 `Committed` 交给存储；`undo_items` 是这次编辑里作者的提交数（合并间隔 0，一次提交一项；`SessionSource` 从正文订阅里数），`ProseUndo` 的撤销栈不设上限。都在 `dr-store` 的写闭包里做。

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

### 第三轮给 `gpui-prose` 加的

- `ProseSource::resync` / `needs_resync`（有默认值）：别的线程也写文档的文本源用它们保证「读」和「事件」对得上。
- `text::{read_paragraphs, change_of}`：给套在别人持有的 `LoroDoc` 上的文本源用的读法和事件换算（`dr-editor` 用）。
- `ProseExtension::input_rule(&Typed) -> Option<InputRule>`：输入规则的钩子；`InputRule::Mark { open, inner, close, key, value }` / `InputRule::Block { prefix, key, value }`，作为单独一步撤销应用。
- `ProseEditor::set_style`（换字号、行距、纸宽、颜色，全部重排）、`CursorLayer::set_color`。
- `schema::STYLE_TABLE`、`schema::DEFAULT_EXPAND`；`schema::configure` 现在也设默认规则。

### M05（通览全书）给 `gpui-prose` 加的

只动排版层和 `editor.rs` 里新加的两个方法，详见 [m05-book.md](../modules/m05-book.md#对-gpui-prose-的改动)：

- `Book::set_acts` / `act_opening` / `acts`：幕从第几章开始、叫什么，渲染层据此画幕的扉页（F4d）。
- `BookPos`、`BookRange`、`Book::split_range`、`Book::text_in`：全书里的位置和范围，给以后的跨章选区（F4b）。
- `ProseEditor::undo_in(chapter)` / `redo_in(chapter)`：只撤、只重做某一章，全书模式里 ⌘Z 撤光标所在的章。

### Drifting 的编辑器（`dr-editor`，F4e，AGPL）

| 项 | 说明 |
| --- | --- |
| `SessionSource::open(&ws, doc_id)` | `gpui-prose` 的文本源：写入、撤销经 F3 的 `ProseSession`，读、锚点在 F2 持有者线程上；`with_foreign_writes()` 只给测试 |
| `ChapterEditor::open(ws, book, doc_id, settings, window, cx)` | 稿纸上的编辑器视图；`switch_to(doc_id)`、`set_settings`、`set_base_style`、`editor()`（里面的 `ProseEditor`）、`todo_markers()`、`plain_text()` |
| `ChapterEditorEvent` | `Edited`、`TodoMarkers(Vec<TodoMarker>)`、`AnchorsChanged(Vec<(批注 id, EncodedAnchor)>)` |
| `EditorSettings::from_values(get)` / `.style(&base)` | 外壳设置（键名同 `dr-shell` 的注册表）到 `ProseStyle` |
| `DriftingExtension::new(targets)` | 人物链接的样子（`LinkTargets`，`BookCatalog` 实现了它）加 Markdown 输入规则；`invalidate()` 在书变了时清缓存 |
| `rules::markdown_rule(&Typed)` | Markdown 输入规则（纯函数） |
| `todo::parse(text)` / `todo::markers(paragraphs)` | TODO 标记 |
| `anchors::{comment_anchors, encode, decode}` | 读一篇正文上的批注锚点；`gpui-prose` 与书目文档之间的锚点编码 |
| `convert::{apply, OwnedEdit, entity_link, entity_value}` | `gpui-prose` 的编辑（原始键值）到 `dr-doc` 类型化事务 |
| `BookEditor::open(ws, book, settings, window, cx)` | 全书视图（M05）：每章一个会话、一个滚动区；`jump_to`、`reveal_line`、`reading_position` / `restore`、按章撤销。见 [m05-book.md](../modules/m05-book.md#给-f6-的用法) |

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

1. 关掉别的编译、测试和 `pnpm dev`，等一分钟负载降到 2 以下（`sysctl -n vm.loadavg` 的第一个数）。`prose-bench` 在每次测量前后各取一次负载，高于 2 就把证据标成仅供参考（`conditions.reference_only`）。
2. 窗口要在内建屏上、不被挡住；测量时别动键盘鼠标（每次约一分钟，窗口会弹到最前面）。
3. 在 `next/` 下，Zed 官方 GPUI：

   ```bash
   cargo build --release -p dr-editor --example prose-bench
   ./target/release/examples/prose-bench present --write
   ./target/release/examples/prose-bench idle --write
   ./target/release/examples/prose-bench window --write
   ```

   （2026-11-08 起程序在 `dr-editor`，语料是 F8 的重型种子，证据写成 F8 格式的 `f4e-m2-prose-bench-<子命令>.json`；旧的 `f4-*.json` 留作历史。）

4. 打了 G1：照下面「本机 fork 怎么用」临时把 `[patch]` 指到 fork（fork 打上 `next/patches/gpui/0001-*.patch`；量 G2 再打 `0002-*.patch`），重新构建，设 `PROSE_BENCH_GPUI` 写明用的补丁，然后：

   ```bash
   PROSE_BENCH_GPUI=g1 ./target/release/examples/prose-bench idle --write      # f4e-m2-prose-bench-idle-g1.json
   PROSE_BENCH_GPUI=g1 ./target/release/examples/prose-bench present --write   # f4e-m2-prose-bench-present-g1.json
   PROSE_BENCH_GPUI=g1-g2 GPUI_PRESENT_NOW_DIRECT=1 ./target/release/examples/prose-bench present --write
   ```

   量完删掉 `[patch]` 一节、还原 `Cargo.lock`，确认 `grep gpui-fork Cargo.toml Cargo.lock` 没有输出。
5. `cargo xtask check`（证据新鲜），再把本节的表换成新数字。

`present` 每个配置录一次约 30 秒的 Instruments。`xctrace` 偶尔会卡住，这一轮遇到两种：目标进程卡在启动阶段（半小时），以及 `xctrace` 还没启动目标就停住（18 分钟）。每次录制限时 180 秒、超时自动重录（最多三次），管得住前一种；后一种限时不起作用，要手动结束那个 `xctrace record` 进程，`prose-bench` 会接着重录。手动结束后紧接着的那次录制可能一个按键都对不上（这一轮遇到过），证据里 `matched` 是 0 就重跑那一项。

## GPUI 补丁台账

GPUI 的 fork 由 F4 负责（D1：需要挂补丁时再开 fork）。现在工作区仍然指向 Zed 官方 `v1.27.0`，补丁只存成文件，`main` 不依赖任何本机路径。

| # | 补丁 | 状态 | 改哪里 | 规模 | 设计 | 上游 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | 空闲时停掉刷新时钟 | **已写、本机 fork 上量过**：`next/patches/gpui/0001-macos-stop-idle-display-link.patch` | `gpui_macos/src/window.rs` | +94 行 | v1.27 的 GPUI 已经有「平台空闲时停帧、有事时唤醒」的接口（`PlatformWindow::frame_waker`，网页端在用），macOS 没实现。补丁：macOS 实现 `frame_waker`；显示链接每一拍记下这一拍有没有画（`draw` 置位）、有没有新的需求（唤醒置位），连续 6 拍（120 Hz 下 50 ms）两样都没有就停掉显示链接。GPUI 在窗口变脏、要下一帧回调、节流重试时都会调唤醒；唤醒时在主队列的下一轮重新启动显示链接，**并且当场画这一帧**（不等重启后的第一拍，不开 CA 事务）。第一版只重启不当场画，量出来每次停顿后的第一个按键要多等将近一拍（按键到交出画面中位数 4.6 → 14.7 ms），所以改成当场画。唤醒可能发生在持有窗口状态锁的平台回调里，所以唤醒本身不拿锁，只置标志、排到主队列 | 高：Zed 自己也省电，接口是现成的。先在 Drifting 用一段时间，再提 PR |
| G2 | 输入后立即绘制（不经 CA 事务、不重启显示链接） | **实验，量过，不挂**：`next/patches/gpui/0002-experiment-present-now-direct.patch`，环境变量 `GPUI_PRESENT_NOW_DIRECT=1` 才生效 | `gpui_macos/src/window.rs` 的 `displayLayer:` | +20 行 | 现在的「改完立刻画」走 `setNeedsDisplay:` → `displayLayer:`，GPUI 在这条路上开 `presentsWithTransaction`、停掉再启动显示链接，造成长尾。实验让 `displayLayer:` 直接画、不开事务、不动显示链接。结果：有了 G1 以后，G2 的「立刻画」中位数 25.0、p95 33.3 ms，和只开 G1、不开「立刻画」（25.0 / 36.1 ms）差不多；只有 G2 才能去掉「立刻画」的长尾（不开 G2 时 p95 137 ms）。**第一轮的结论：不需要 G2**，G1 当场画醒来的那一帧已经拿到了好处。两轮都是在高负载下量的，这个结论等空闲时重测再确认 | 中：要先证明有用；正式版应该是单独的「输入后立即画」入口，不改 `displayLayer:`（它也管窗口缩放时的同步绘制） |
| G3 | 丢弃组字的接口 | 未做 | `gpui/src/platform.rs` 加 `PlatformWindow::discard_marked_text`；macOS 调 `[NSTextInputContext discardMarkedText]`，Windows 调 `ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` | 约 30 行 | 现在由程序的 `PlatformHooks` 自己调（macOS 十来行 objc）。有了接口，`PlatformHooks::discard_marked_text` 可以删 | 中 |
| G4 | Windows 组字丢弃（IMM32） | **第四轮实现已合，不改 GPUI；Windows 实机待验**（第二十二批） | HWND 的 IMM 上下文取消并释放；输入开始时装平台钩子，`GetFocus` 判断迟到输入，空上屏不删选区；同窗失焦和窗口失活都丢弃组字 | 见 `input/system_ime.rs`、`input/ime.rs` | 五项模拟回调测试；交付方做过 x86_64 交叉类型检查。本批没有运行真实微软拼音；TSF 经 IMM 兼容层的实际时序、ARM 检查仍待做 | — |
| G5 | 中文斜体合成倾斜 | 未做，不急 | `gpui_macos` 的字形光栅化加倾斜变换 | 待估 | 苹方没有斜体字形，现在中文斜体画成正体 | 低 |
| G6 | 中文断行 | 不需要 | — | — | 上游 #64624（ICU UAX #14）不在 v1.27.0；即使升级，编辑器自己断行仍更合适（悬挂、以后两端对齐） | 已在上游 |
| G7 | 缓存视图里的正文从读屏树里掉出去 | **已写、在 Zed main 上验证过，未挂**：`next/patches/gpui/0003-a11y-draw-views-uncached.patch` | `gpui/src/view.rs` | +13 −2 行 | 别处一重画（比如光标闪烁），缓存视图被原样回放、不走预绘制，就不交读屏节点，焦点退回窗口。补丁：读屏连着时缓存视图一律不走缓存（和检查器取元素时一样）。`gpui-prose` 已绕开：读屏连着时正文不走缓存（`input::a11y::editor_view`）。`dr-ui` 别的缓存视图也会碰到。见 [f4c-input.md](f4c-input.md) | **已报** [zed-industries/zed#66690](https://github.com/zed-industries/zed/issues/66690)（2026-11-08，附补丁和不依赖 Drifting 的复现程序；没开 PR） |
| G8 | 系统问焦点元素时答成窗口 | **已写、在 Zed main 上构建验证过，未挂**：`next/patches/gpui/0004-macos-a11y-subclass-first-responder.patch`（对 v1.27.0；对 main 的版本只差一行注释，贴在 issue 里） | `gpui_macos/src/window.rs` 的 `a11y_init` | +11 −7 行 | AccessKit 子类化的是窗口的内容视图，GPUI 的第一响应者却是它自己的视图；系统从第一响应者问焦点，答成窗口。补丁：改用 `SubclassingAdapter::new` 子类化 GPUI 的视图。绕不开，必须改 GPUI。读屏的焦点元素应是正文。见 [f4c-input.md](f4c-input.md) | **已报** [zed-industries/zed#66691](https://github.com/zed-industries/zed/issues/66691)（2026-11-08，同上） |
| G9 | 视图缓存也看不透明度 | 未做，不急（F4e 第二批） | `gpui/src/view.rs` 的 `ViewElementCacheKey` 加上画的时候的元素不透明度，不一样就不复用 | 约 5 行 | 缓存视图重放上一帧时连当时的不透明度一起，放在叠化里的编辑器会停在头几帧的淡色。`gpui-prose` 已绕开：`ProseEditor::element_at_opacity` 由宿主传不透明度，变了就重画。见 [f4e-editor.md](f4e-editor.md) | 中：Zed 自己的淡入淡出也会碰到 |

**本机 fork 怎么用**（只在测量时临时用，不提交）：fork 是 Zed `v1.27.0`（`c84af5b`）的本地克隆，放在家目录下单独的文件夹，没有远端。临时在 `next/Cargo.toml` 末尾加一节 `[patch."https://github.com/zed-industries/zed"]`，把锁文件里来自 Zed 仓库的 20 个 crate（`gpui`、`gpui_macos`、`gpui_platform`、`collections`、`sum_tree`、`scheduler` 等，见 `Cargo.lock` 里 `source = "git+https://github.com/zed-industries/zed?tag=v1.27.0"` 的那些）都指到 fork 的路径；只换 `gpui_macos` 一个不行，它的依赖会变成第二份 `gpui`。量完删掉这一节、还原 `Cargo.lock`。以后正式挂补丁时，把 fork 推到 GitHub 上一个仓库，`[patch]` 改成指向那个仓库的固定提交（D1）。

## 待协调

1. **按键上屏的预算（监管会话已定）。** 拆成两条，`benchmarks.md` 已改：「按键到交出画面」照旧 16 / 8.3 ms，发布档靠 G1；「按键到真正显示」只记录。G1 正式挂上要开可推送的 GPUI fork，发布档前由作者定；这之前补丁只存成文件，`present_now` 关。两轮的上屏都是在高负载下量的（第二轮的证据标了仅供参考），G1、G2 好不好、「按键到真正显示」的最终数字，由作者或监管会话找机器空闲时照「测量 / 重测上屏」重测。
   - **TextEdit 参照还没量，要作者点头一件事。** 量法：`prose-bench` 加一个子命令，打开 TextEdit 的一个空文档、把它的窗口放到最前，往它的进程发按键（`CGEventPostToPid`）并在每次按键前打 `os_signpost`，在 Instruments 下录约 30 秒；TextEdit 不用 Metal，没有我们用的那张「显示」表，所以用 Core Animation 的提交（`Commit` 信号）加 WindowServer 的帧交换（`displayed-surfaces-interval`）来对，并用同样的方法再量一次 `gpui-prose`，两边口径一致。要点头的是：这半分钟 TextEdit 会挡在作者的窗口前面，而且往别的程序发按键多半要给终端开「辅助功能」权限。这两件都超出了这一轮的约定（不接管屏幕、不改系统设置），所以没做。
2. **文本源 trait（F1 的约定，第二轮定稿，第三轮由 `dr-editor` 实现）。** 定稿的样子见「文本源」一节。第三轮加了两个有默认值的方法 `resync` / `needs_resync`（别的线程也写这篇文档时不重复算提交，见第三轮「大白话」）。`dr-editor` 的 `SessionSource` 过了一致性检查。剩下：
   - **给 F1 的小建议**：`dr-doc` 的 `ProseEvent` 里插入不带标记（`TextChange::Insert { text }`）。`dr-editor` 现在直接订阅正文的 Loro 事件拿到标记；如果 `TextChange::Insert` 加一个可选的 `marks`，就可以改用 `dr-doc` 的事件。不急。（F1 第四轮已做：`TextChange::Insert` 带上了新字的 `marks`，dr-editor 可以改用它。）
   - **每次按键的查询**照约定用 F4a 自己的索引，不调 `ProseView::paragraph_at` / `paragraph_by_id`。
3. **样式表只能有一份（给 F1，第三轮做完）。** Drifting 里文档由 `dr-doc` 配，`dr-editor` 不调 `gpui_prose::schema::configure`；`dr-editor` 的 `the_style_tables_agree_key_by_key` 逐键比较两张表（含默认规则）。以后谁改表，两边一起改、升 schema 版本，这条测试会提醒。
4. **锚点的编码和语义（给 F1）。** `gpui_prose::Anchor` 存两个 `Cursor::encode()`：`start` 是第一个被锚字符上的 `Side::Left`，`end` 是最后一个被锚字符上的 `Side::Right`，和 loro-schema v0「锚点」一节、P0-C 的 `anchor.rs` 一样。`dr-doc` 读写书目文档里的 `anchor` 字段时用同样的编码，`dr-editor` 在两边之间原样搬字节。撤销带回的锚点通过 `EditorEvent::AnchorsChanged` 交给宿主写回书目文档（这是本机作者的操作，要同步出去，和「替换光标只存本机缓存」不同）。
5. **打开文档的分工（给 F1/F2，第二轮后）。** `gpui-prose` 不再打开 Drifting 的文档：创世、对等方 ID、时间戳、样式表、块 ID 修复都是 `dr-doc` / `dr-store` 的事，`dr-editor` 把已经打开的文档包成文本源交给编辑器（`ProseDoc::open`）。自带的 `LoroSource` 只给独立使用者和测试，它自己配样式表、修块 ID（来源 `repair`）。`ProseDoc` 和文本源都是 `Send`，可以在后台线程打开。
6. **组字逻辑合到一处（给 F5）。** 规则已经在 `next/crates/gpui-ime`（只用标准库，MIT OR Apache-2.0）：`LineComposer` 是从 `dr-ui` 的 `Composer` 搬过来的，接口照旧（`replace`、`replace_and_mark`、`unmark`、`discard`、UTF-16 换算、编辑键），差别有三处：失焦（`blur`）改成丢弃，这是作者定的规则，测试 `blur_discards_the_composition`；字素边界由调用方传入（实现 `gpui_ime::Boundaries`，`dr-ui` 用 `unicode-segmentation` 包一层就行）；类型名叫 `LineComposer`。F5 下一个里程碑把 `dr-ui/src/input/compose.rs` 换成 `gpui_ime::LineComposer`，失焦时同时调系统的 `discardMarkedText`。编辑器用的是同一个 crate 里的 `Overlay`。
7. **Agent 写入的入口（第三轮做完）。** Drifting 里 Agent 只经 F3 的命令写；`SessionSource` 拒绝作者以外的来源（`ProseEditor::agent_write` 留给单独使用 `gpui-prose` 的人），Agent 的提交作为事件到达编辑器（测试 `an_agents_command_shows_up_in_the_open_editor`）。`SessionSource::with_foreign_writes` 只给测试和替身工具用。
8. **派生数据不从编辑器推回去（监管会话定的）。** 旧版的大纲、字数、引用是编辑器组件每 400 ms 防抖推回去的（`entity-editor-session.ts`）。新版 `gpui-prose` 只改 Loro 文档，没有任何「把内容推回去」的回调；派生数据由 `dr-store` 按 Loro 的变化自己算。编辑器的事件（`EditorEvent`）都不带正文：`Edited` 只给界面用（比如工具栏状态），`AnchorsChanged` 是撤销改了锚点本身（锚点存在正文之外，见第 4 条）。
9. **断行规则共用（给以后建 `dr-text` 和改 PDF 导出的会话）。** 已经是独立的 crate `next/crates/prose-linebreak`（只依赖 `icu_segmenter`）。PDF 导出改用它时，行末用 `Overflow::Squeeze`，行内用 `punctuation_squeeze`。
10. **快捷键（给 F6）。** 键位现在由 `bind_keys` 绑在 `ProseEditor` 上下文里；F6 的快捷键注册表接管时，动作名（`prose_editor::ToggleBold` 等）保持不变。
11. **F3（dr-workspace），第三轮提出的：**
    1. **锚点写回书目缺一条命令**（最要紧）。撤销带回的批注锚点由 `ChapterEditorEvent::AnchorsChanged` 交出（`(批注 id, EncodedAnchor)`，`dr-doc` 的编码），但没有命令能把它写进书目文档：`comment.update` 不改锚点。建议加 `comment.reanchor { book, id, anchor: { start, end } }`（字节用 base64 或数字数组），作者的操作、进日志、可撤销。另外 `comment.list` 只给 `anchored: bool`，`dr-editor` 现在在持有者线程上直接读书目文档拿锚点（`anchors::comment_anchors`，只读）；如果 F3 愿意，可以在 `CommentInfo` 里带上编码后的锚点，编辑器就改走查询。
    2. **TODO 标记投成待办**：编辑器找到标记（`TodoMarker`：段落、块 ID、任务）并在变化时发事件；投成待办（`CommentId::for_projection(Marker, doc, block)`，标记消失时处理旧的）需要一条命令，比如 `todo.project { doc, markers: [{block, task}] }`，按旧版 `useTodoAutoParse` 的规则建、改、留（离开该段才算写完由界面决定）。
    3. **作者身份的命令和编辑器共用一个撤销栈。** 会话的 `ProseUndo` 撤所有 `user` 来源的提交；如果作者从别处（命令面板、帮手代作者执行）用 `Actor::User` 的命令改了正开着的这篇正文，那次提交也进了这个栈，编辑器按自己的步数撤销时可能撤到它。建议：改正开着的正文的作者命令换一个不进编辑器撤销的来源（比如 `user:command`，它们有对象级撤销），或者经会话写。
12. **F4b（排版）**：`EditorSettings` 已经读进段首缩进（0/1/2 字）和打字机模式，`gpui-prose` 还不会排段首缩进、没有打字机滚动；做了以后在 `EditorSettings::style` 里接上。
13. **F4d（渲染，F4d 第一轮做完）**：建议链接和 TODO 标记都由画层画（`Look::Underline` 的砂粒点线、`Look::Ink` 的 TODO 色），不改正文。接法见 [f4d-render.md](f4d-render.md)。
14. **F6（外壳）接编辑器**：`workspace/stage.rs` 的只读页换成 `ChapterEditor`（`PageSlot` 换成 `ChapterEditor::open` / `switch_to`）；设置变了调 `set_settings(EditorSettings::from_values(|k| Some(Settings::read(cx).get(k))), cx)`，主题变了调 `set_base_style`；`take_reveal` 的行号交给 `editor().update(.., select)`；订阅 `ChapterEditorEvent`（`AnchorsChanged` 等 F3-1，`TodoMarkers` 等 F3-2）；编辑菜单的 `edit::{Undo, Redo, …}` 转给编辑器。`dr-editor` 不依赖 `dr-shell`。

## 下一轮怎么拆

`dr-editor` 接上以后，五条线可以并行：各改各的目录，共用文件 `gpui-prose/src/editor.rs` 每路只加字段和动作注册各一行。

| 子线 | 目录 | 下一轮的活 |
| --- | --- | --- |
| F4a 文本存储与索引 | `src/text/` | 复制粘贴的内部富文本格式（带标记和段落属性）与 Markdown 粘贴规则（`dr-editor` 的规则搬一份成粘贴版）；段落属性改动的快路径；`segment` 按段缓存 |
| F4b 排版与虚拟化 | `src/layout/`、`prose-linebreak` | 段首缩进和打字机滚动（设置已读进来，待协调 12）；两端对齐；行内标点挤压接进编辑器；跨章选区要的几何 |
| F4c 输入 | `src/input/`、`gpui-ime` | 第四轮已实现窗口失活、迟到输入和空上屏处理；后续为真实 Windows 输入法验收、dr-ui 对齐及 macOS 窗口自身 inputContext，见 [f4c-input.md](f4c-input.md)「下一步」 |
| F4d 渲染 | `src/render/` | 画层接口（待协调 13）：建议链接、TODO 标记、批注砂笔、查找高亮、Agent 改动显现；块样式（引用、缩进、对齐、分隔线） |
| F4e Drifting 扩展 | `crates/dr-editor` | 人物链接的 @ 选择和自动链接（`dr-text` 匹配器，经会话写）、断链修复；斜杠菜单；章末 ⁂；选区浮条；Agent 改动显现；接上 F3 的 `comment.reanchor` 和 TODO 投影（待协调 11） |
| 基准 | `dr-editor/examples/prose-bench` | 已搬（F4e 第二批，见 [f4e-editor.md](f4e-editor.md#测量)）；剩下空闲重测：`window`、`present`、`idle` 在新语料上还没跑过 |

GPUI 补丁 G1 什么时候正式挂上，由作者在发布档前定（需要一个可推送的 fork 仓库）。挂上以后 `EditorOptions` 不用改。

## 已知限制

- 中文斜体画成正体（见 G5）。
- 复制粘贴只有纯文本；粘贴的多段一律按回车规则拆开（第一段并进光标所在段）。
- 选区不能跨章（接口 `BookRange` 已经留好，见 [m05-book.md](../modules/m05-book.md)）。
- 列表（只在素材笔记里）由 F4d 画出样子：圆点、序号、任务框，见 [f4d-render.md 第三轮](f4d-render.md#第三轮全书视图列表来源悬停卡)；项与项挨紧、代码块和提示框的样子见[第四轮](f4d-render.md#第四轮段距跟着块走代码块和提示框)（每段的字号、留白、收进由 `ProseEditor::para_set` 一处算，估高度和真画同用）；列表的输入（回车续项、Tab 改层级、Markdown 快捷写法）归 F4c；引用、缩进、对齐、分隔线由 F4d 画出（居中、右对齐的多行段落，输入法候选窗和上下移动还按第一行的偏移算，等 F4b 加每行偏移）。
- 真输入法的手测清单沿用 [P0-B](../spikes/p0-b-editor.md#待作者手测)，命令换成 `cargo run --release -p dr-editor --example prose-bench -- chapter`（`PROSE_BENCH_IME_LOG=1` 打印输入法调用）。
