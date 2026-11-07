# F4c 输入：查找替换、选择扩展、读屏、Windows

2026-11-08。F4 编辑引擎的输入子线（[f4-editor.md](f4-editor.md)「下一轮怎么拆」的 F4c 一行，和「GPUI 补丁台账」的 G4）。代码在 `next/crates/gpui-prose/src/input/`（MIT OR Apache-2.0，不依赖任何 `dr-*`），`editor.rs` 只加了一个字段、一行注册和一处视图包装（见「改了 editor.rs 的哪几行」）。

## 一句话

编辑器能查找替换了：一章（或编辑器里的整本书）里所有命中、前后跳、逐个或全部替换，全部替换是一次撤销；区分大小写、全字（中文按 ICU 词典分词）两个选项；命中随编辑、撤销、别人的写入自动更新，「当前项」就是选区。双击后拖动按词扩展、三击后拖动按段扩展。正文作为一个多行文本框交给读屏（AccessKit），整章可读、选区读得到也设得进去，在真窗口里用进程内探针核过；GPUI v1.27 刚接上 AccessKit，有两个坑：缓存视图会把读屏节点弄丢（`gpui-prose` 已绕开，另存补丁 G7），系统问「焦点在哪」时答的是窗口而不是正文（要改 GPUI，补丁 G8 只存文件）。Windows 上组字中失焦时用 IMM32 让输入法丢弃（台账 G4，不用改 GPUI），键位有 Windows 一套（Ctrl、Home/End、Ctrl+↑↓ 按段、F3）。

## 大白话

### 查找替换

- **找的是什么。** 只在一段之内找（查询里有换行就什么也找不到，和旧版手机端的稿纸搜索一样）。默认不分大小写：两边都按 Unicode 转小写再比，命中的两端必须落在原文完整的字上（土耳其的 İ 转小写是两个字，查 `i` 不会只命中它的一半）。勾「全字」时，命中的两端都要落在词的边界上，词的切法和 ⌥←/⌥→ 一样是 ICU（中文按词典）：在「我们今天去公园」里找「公园」能找到，找「园」找不到；英文 `cat` 不会命中 `concatenate`。命中互不重叠，从左往右数。
- **当前项就是选区。** 「下一个」「上一个」就是把选区挪到那个命中上；选区正好盖住一个命中，它就是当前项（`find_current`），「3 / 12」里的 3 也从这里来。所以作者打字、撤销、Agent 或别的设备改了这一章，当前项跟着选区走，不用另外记；作者在别处点了一下，就没有当前项了，下一次「下一个」从光标往后找。查找栏一边打字一边找（`set_find`）时，从选区开头往后找第一个。
- **命中随编辑更新。** 命中是要用时才算的，按段的文字缓存：哪段文字没变，就直接用上次的结果，不再转小写、不再分词。缓存按文字内容查，不按地址：GPUI 的 `SharedString` 把 23 字节以内的短文字直接存在结构体里（七个汉字以内的短段落，对话里很常见），地址换了内容、内容换了地址都可能，最初按地址查就在「同样长度的短段落改了一个字」时用了旧结果，测试抓到了。打字只重找这一段；回车、并段、撤销、Agent 的写入都一样处理。画高亮是 F4d 的事：`find_matches(chapter)` 给排好序的命中范围，`find_current()` 给当前项。
- **替换。** 「替换」：选区正好是一个命中就把它换掉，再选中下一个；不是的话只选中下一个（先让作者看见要换的是哪个，这是常见做法）。「全部替换」：把范围里的命中从后往前换，同一章是一次提交（[f4b-layout.md](f4b-layout.md) 的「批量编辑」，2026-11-08 起）、作者的一步撤销，⌘Z 一次全部回来。替换上去的字沿用命中第一个字的格式：加粗的名字换完还是加粗，链到人物的名字换完还链着（改名就是这样用的）；命中前面那个字的格式（比如前面是加粗、命中不是）不会延续进来。替换后的文字里如果又含着查询（「阿明」换成「阿明哥」），不会被当成下一个命中。
- **跨章。** 选项 `scope` 有两档：`Chapter`（选区所在章，默认）和 `Book`（编辑器里的所有章，按顺序跨章找、绕回）。Drifting 一次只开一章（`ChapterEditor::switch_to`），编辑器手里没有的章节要宿主自己去开：把 `wrap` 关掉，找到头时 `find_next` 返回 `FindOutcome::PassedEnd`、同时发 `FindEvent::PassedEnd { forward }`，宿主换到下一章后调 `find_first(forward)` 接着找。整本书的命中计数（「全书 128 处」）用 F2/dr-text 的索引更合适，不在编辑器里算。
- **键位。** Mac：⌘G 下一个、⇧⌘G 上一个、⌘E 用选中的字查找（编辑器自己设好查询，再发 `FindEvent::QueryChanged` 让查找栏显示）。Windows：F3、Shift+F3。打开查找栏（⌘F / Ctrl+F）、替换栏（⌥⌘F / Ctrl+H）是宿主的界面，由宿主在自己的上下文里绑，编辑器不管。组字中这些操作都不做（和撤销一样，组字属于输入法）。

### 双击、三击后拖动

照 macOS 和 Word 的习惯：双击选一个词，按住不放拖动，选区一个词一个词地长，始终保留第一次双击的那个词，另一头落在指针下那个词的远端，往回拖越过起点就反过来；三击选一段（不含段尾换行，和原来一样），拖动时一段一段地长。松开以后再拖就回到按字。Shift 点击照旧按字扩展。逻辑在 `click_at` / `drag_to` / `release`（鼠标事件和测试共用）。

### 读屏

- **读屏看到的是什么。** 编辑器的根元素是一个「多行文本框」（AccessKit 的 `MultilineTextInput`，macOS 上就是 `AXTextArea`），名字是章标题，里面是光标所在这一章的全部正文，选区就是编辑器的选区。AccessKit 的 macOS / Windows 适配器把它翻译成系统的文本接口（`AXNumberOfCharacters`、`AXStringForRange`、`AXSelectedTextRange`、行范围等），选区变了会发系统通知，所以 VoiceOver 能读整章、按字按词按行读、跟着光标和选区念；读屏软件自己挪光标（`setAccessibilitySelectedTextRange:`）时，编辑器的选区跟着变。
- **字和词。** AccessKit 的「字」是光标一步跨过的东西，所以按字素簇算（一家人的表情 👨‍👩‍👧 是一个字）；词的起点用编辑器自己的分词（ICU，中文按词典），按词读和 ⌥←/⌥→ 一致。
- **按屏幕行（2026-11-08 起）。** 这一帧画着的段落按屏幕行交出，每行一个文本段、带每个字的屏幕位置，见 [f4b-layout.md 的「读屏按屏幕行」](f4b-layout.md#读屏按屏幕行)。屏幕外的段落没有排版：AccessKit 把词的起点存成一个字节，一个文本段最多放 255 个字，所以按至多 200 字切块（尽量在词首切），用「同一行的下一段」连起来，读起来一段是一行。
- **只在读屏软件连着时做。** `Window::is_a11y_active()` 为假时什么都不建，开销是零。连着时每帧把这一章交出去；每段的切分和分词按段落文字缓存（同样按内容查），没变的段落不重算。
- **GPUI 的一个坑，先绕开了。** GPUI v1.27 只在「预绘制」时建读屏节点，而缓存视图被原样回放时不走预绘制——编辑器的正文是缓存视图（光标闪一下只重画光标那一层），于是**别处一重画（光标闪烁、侧栏、状态栏），正文就从读屏树里掉出去，焦点退回窗口**。`gpui-prose` 的做法：读屏软件连着时，`ProseEditor::element` 不走缓存（`input::a11y::editor_view`），每帧都画正文；没连着时照旧缓存。代价只在开着读屏时才有。根本的修法是让 GPUI 在读屏连着时不回放缓存视图（或者回放时连读屏节点一起回放），补丁 G7 已经写好存成文件（`next/patches/gpui/0003-a11y-draw-views-uncached.patch`，13 行），工作区仍指向官方 v1.27.0；它对 Drifting 外壳里别的缓存视图也有用。
- **GPUI 的第二个坑：系统问「焦点在哪」，答的是窗口。** AppKit 回答「现在焦点在哪个元素」（VoiceOver 切进程序时先问这个）是从窗口的第一响应者问起的；GPUI 的第一响应者是它自己的视图，而 AccessKit 动态子类化的是窗口的内容视图（GPUI 视图的父视图）。结果 AccessKit 自己知道焦点在文本框上，系统却答「窗口」。探针里把内容视图临时设成第一响应者，系统马上答「文本框」，说明就是这个原因。这一处 `gpui-prose` 绕不开（要改 GPUI 建适配器的那一行），补丁 G8 存成文件（`next/patches/gpui/0004-macos-a11y-subclass-first-responder.patch`：让 AccessKit 子类化 GPUI 的视图，11 行），没有在 fork 上构建验证。不挂的话，VoiceOver 用户切到 Drifting 时多半不会自动落到正文上，要用 VO 键挪进去；挪进去以后读文字、读选区、改选区不受影响，但打字和挪光标时的即时播报依赖系统认定的焦点，可能也受影响——这要用真的 VoiceOver 才能确认（见「要作者手测的」）。
- **怎么验证的。**
  1. 单元测试用 AccessKit 自己的读法（`accesskit_consumer`，macOS 和 Windows 适配器用的就是它）读编辑器交出的树：全文、选区的 UTF-16 范围、每段一行、段尾光标落在换行上、表情是一个字、600 字的段落切成几段但仍是一行、读屏挪光标时编辑器的选区跟着变。
  2. `cargo run -p gpui-prose --example a11y-probe` 在本机开一个小窗口，在进程里向窗口要读屏子元素（VoiceOver 连上时也是这样唤醒 AccessKit 的），再像 VoiceOver 一样读那个 `AXTextArea`，约两秒后自己关掉。不用读屏软件、不用系统权限。结果见下面「测量」。
  3. 真用 VoiceOver 读：要作者手测（本轮约定不改系统设置），清单见「要作者手测的」。
- **没做到的。** 系统层面的焦点（上面的 G8）；组字中的拼音（读屏听到的是输入法自己的播报）；跨章的选区（编辑器本来就没有）；书模式下只交出光标所在这一章。

### Windows

- **组字中失焦（台账 G4）。** 不用改 GPUI：`input::system_ime::SystemIme` 从窗口拿到原生句柄，Windows 上 `ImmGetContext(hwnd)` → `ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` → `ImmReleaseContext`，macOS 上 `[[NSTextInputContext currentInputContext] discardMarkedText]`。组字开始时，宿主没有自己设 `PlatformHooks` 的话，编辑器自己装上它，所以 `dr-editor` 不用做什么就有了（之前 `dr-editor` 没设钩子，macOS 上失焦时系统输入法其实没被通知，这次一并补上）；GPUI 的测试窗口没有原生句柄，不装。
- **和 GPUI 自己的行为怎么配合。** GPUI 的 Windows 后端在「焦点所在的元素不再接受文字」时发 `CPS_COMPLETE`（把组字上屏）。编辑器的失焦处理在那一帧的绘制里先跑，组字已经取消，GPUI 随后的 `COMPLETE` 什么也找不到；焦点挪到另一个文字框（比如查找栏）时 GPUI 什么都不发，而输入法上下文是整个线程共用的，不取消的话半截拼音会跟到那个框里——这正是要 `CPS_CANCEL` 的原因。
- **键位。** `KeyScheme::{Mac, Windows}`，`bind_keys` 按运行的平台选（Linux 用 Windows 那套）；`key_bindings(scheme)` 给出任一套的列表，F6 的快捷键注册表接管时用它。Windows 一套：Ctrl 代替 ⌘ 做命令，Ctrl+←/→ 按词（Mac 是 ⌥），Home/End 到屏幕行的头尾（换行处光标靠前一行），Ctrl+Home/End 到章首章尾，Ctrl+↑ 到段首（已在段首就到上一段段首）、Ctrl+↓ 到下一段段首（Word 的习惯），Ctrl+Backspace/Delete 删词，Ctrl+Y 和 Ctrl+Shift+Z 重做，Ctrl+Insert / Shift+Insert / Shift+Delete 复制粘贴剪切，F3 / Shift+F3 查找。Mac 一套另加 ⌥↑/⌥↓（到段首、段尾，已在就到上一段段首、下一段段尾）。仍然不绑任何单个可打印键（zed#59882 的规避照旧）。
- **本机只能做到编译检查。** Windows 的真跑要等 CI 或作者的虚拟机。`cargo check --target x86_64-pc-windows-msvc` 在 Mac 上要绕过三处 C 构建（Loro 依赖的 `stacker`、`psm` 和 GPUI 的资源文件），命令见「检查」。

## 要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 查找替换的选区模型：所有命中、前后跳、逐个或全部替换（全部替换一次撤销）；区分大小写、全字（中文 ICU）；命中随编辑更新；为跨章预留接口；只给命中范围和当前项 | 完成 | `input/find.rs`（5 个纯函数测试）；`input/tests.rs`：`find_steps_through_matches_and_goes_round`、`matches_follow_edits_and_other_writers`、`replacing_one_and_all_are_single_undo_steps`、`whole_words_and_case_in_the_editor`、`book_scope_crosses_chapters_and_the_end_is_reported` |
| 2 | 双击按词、双击拖动按词扩展、三击按段、三击拖动按段扩展 | 完成 | `input/mouse.rs`；`a_double_click_drag_extends_by_words`、`a_triple_click_drag_extends_by_paragraphs` |
| 3 | 读屏（AccessKit）：正文作为可读文本区域、光标和选区变化能读出；如实写能做到的程度 | 完成到「整章可读、选区可读可设」（第一轮一段一行，2026-11-08 起按屏幕行、带每字位置）；GPUI 的两个坑：缓存视图丢节点已绕开并另存补丁 G7，系统焦点答成窗口要靠补丁 G8（只存文件） | `input/a11y.rs`；`input/tests.rs` 的 `a11y` 模块（4 个测试，用 `accesskit_consumer` 读）；`examples/a11y-probe.rs` 的本机输出（「测量」） |
| 4 | Windows：IMM32 丢弃组字（G4）、Windows 键位；本机只能 `cargo check --target x86_64-pc-windows-msvc` | 完成；Windows 上没真跑 | `input/system_ime.rs`、`input/actions.rs`（`KeyScheme`）；`windows_keys`、`mac_keys_for_paragraphs_and_find`、`paragraph_moves`、`test_windows_get_no_system_input_method`；Windows 交叉检查（「检查」） |
| 5 | 失焦时组字：清掉 + 让系统丢弃 | 照旧，并且现在不设钩子也会通知系统 | `losing_focus_drops_the_composition`（原有）；`SystemIme` |
| 6 | 用 `TestAppContext` 模拟输入；真输入法仍由作者手测 | 完成；手测清单见下 | 上面的测试都在 `TestAppContext` 里跑，键位测试用 `simulate_keystrokes` |

## 接口概览

都在 `gpui_prose::input` 模块里。

| 项 | 说明 |
| --- | --- |
| `FindOptions { case_sensitive, whole_word, scope: FindScope::{Chapter, Book}, wrap }` | 默认：不分大小写、不限全字、选区所在章、绕回 |
| `ProseEditor::set_find(query, options, window, cx) -> FindOutcome` | 设查询（空串等于清掉），选中选区开头起的第一个命中 |
| `find_next` / `find_previous` / `find_first(forward)` | 跳到下一个、上一个、范围里第一个（或最后一个）；返回 `FindOutcome::{Found, Wrapped, PassedEnd, NotFound}` |
| `find_matches(chapter) -> Rc<[Range<usize>]>` | 这一章所有命中（标量偏移，排好序），给 F4d 画高亮 |
| `find_current() -> Option<FindHit>`、`find_status() -> FindStatus { total, current }` | 当前项（= 选区正好盖住的命中）、「3 / 12」 |
| `replace_current(text, …) -> bool`、`replace_all(text, …) -> usize` | 逐个替换（先选中再换）、全部替换（每章一次提交、一步撤销） |
| `use_selection_for_find`、`clear_find`、`find_query` | ⌘E；清掉；读回查询 |
| `FindEvent::{PassedEnd { forward }, QueryChanged(String)}` | `ProseEditor` 的第二种事件（`EventEmitter<FindEvent>`），给查找栏 |
| 动作 `FindNext`、`FindPrevious`、`UseSelectionForFind`、`MoveToParagraphStart`、`MoveToParagraphEnd`、`MoveToNextParagraph` 及三个 `SelectTo…` | 新动作，名字在 `prose_editor` 命名空间 |
| `KeyScheme::{Mac, Windows}`、`KeyScheme::native()`、`bind_keys_for(scheme, cx)`、`key_bindings(scheme)` | 两套键位；`bind_keys` 照旧（按平台） |
| `click_at(chapter, offset, click_count, shift, cx)`、`drag_to(offset, cx)`、`release()`、`paragraph_range_at`、`Granularity` | 鼠标的逻辑部分（事件处理和测试共用） |
| `a11y_text() -> A11yText`、`A11yText::assemble`、`ParagraphRuns`、`RUN_CHARS`、`input::a11y::editor_view` | 交给读屏的文字（测试和别的宿主可直接用）；视图包装 |
| `input::system_ime::SystemIme::for_window(window)` | macOS / Windows 的 `PlatformHooks`；编辑器在组字开始时自动装上，宿主也可以自己装 |

## 改了 editor.rs 的哪几行

- 字段 `input: crate::input::InputState` 和它的初始化（查找、拖动单位、读屏状态都在里面，以后 F4c 再加状态也只改 `InputState`）；
- `render` 里一行 `.map(|root| self.input_layer(root, window, cx))`：注册新动作、读屏的角色和节点（为此 `render` 的 `_window` 改名为 `window`，`gpui` 的导入加了 `prelude::FluentBuilder`、去掉了不再用的 `StyleRefinement`）；
- `ProseEditor::element` 里正文那个 `.child(...)` 换成 `crate::input::a11y::editor_view(editor, cx)`：读屏连着时不走缓存。F4d 若要在 `element` 里加画层，在它旁边加 `.child` 就行。

## 测量

M3 Pro，release，`gpui-prose` 自带的 `LoroSource`，2026-11-08 凌晨，测量时一分钟负载 14–35（别的会话在编译，仅供参考）。命令在测试的文档注释里（两个 `#[ignore]` 的计时测试：`costs_on_a_long_chapter`、`replace_all_costs`），每项 20 次（替换 3 次）取平均。

**一章 18 800 字、400 段**（每段都含一处「安娜」）：

| 项 | 时间 |
| --- | ---: |
| 设查询、全章第一次找（默认 / 全字） | 0.58 / 1.67 ms |
| 打一个字（没开查找） | 0.114 ms |
| 打一个字，再取命中（默认 / 全字） | 0.167 / 0.169 ms，其中取命中 0.059 / 0.069 ms |
| 什么都没变时取命中 | 0.057 ms |
| 读屏文字：第一次建（400 段全部切分、分词） | 1.91 ms |
| 读屏文字：打一个字后重建 / 没变时重建 | 0.23 / 0.22 ms |

**全部替换和它的撤销**：

| 命中数 | 全部替换 | 撤销（编辑器） | 其中文本源的 Loro 撤销本身 |
| ---: | ---: | ---: | ---: |
| 50 | 0.9 ms | 35 ms | 30 ms |
| 100 | 2.0 ms | 177 ms | 113 ms |
| 200 | 2.4 ms | 653 ms | 550 ms |
| 400 | 6.3 ms | 2593 ms | 1924 ms |

替换本身很快；**撤销是平方级的，几乎全花在 Loro 的 `UndoManager` 上**：同一步里的 N 项逐项撤销，每多一倍，时间约翻四倍（400 处要两秒多，界面这期间是卡住的）。**已解决（2026-11-08）**：全部替换改成一次提交，400 处的撤销 27 ms，见 [f4b-layout.md 的「测量」](f4b-layout.md#测量)。

**读屏探针**（`cargo run -p gpui-prose --example a11y-probe`，本机 macOS 27.0.1，窗口是键盘焦点窗口）：

| 步骤 | 读到的 |
| --- | --- |
| 唤醒后 | 有 `AXTextArea`，标题「雨夜」，27 个字，开头「第一章　雨夜⏎天色将晚，」，选区 0+0，光标在第 0 行 |
| 窗口里别的东西重画三次（正文不重画）后 | 文本框还在，内容不变 |
| 编辑器选中「将晚，」后 | 选区 9+3、选中的字「将晚，」、光标在第 1 行 |
| 用 `setAccessibilitySelectedTextRange:` 把光标放到 18 | 编辑器的选区变成 18..18（第二段段尾，在它的换行上） |
| 系统问焦点在哪（`[NSApp accessibilityFocusedUIElement]`） | **窗口**（AccessKit 自己答文本框；见 G8） |
| 临时把内容视图设成第一响应者后再问 | 文本框 |
| 加 `--stock-cache`（不绕开 G7）、别处重画三次后 | **文本框不见了**，只剩窗口；编辑器下一次重画才回来 |

这说明：整章可读、选区读得到也设得进去、别处重画不丢（绕开 G7 以后），这些在真窗口里和单元测试一致；系统焦点那一处（G8）不改 GPUI 做不到。没有用真的 VoiceOver 听过（要作者手测）。

## 检查

在 `next/` 下：

```bash
cargo fmt --all --check
cargo clippy -p gpui-prose -p gpui-ime --all-targets --locked -- -D warnings
cargo test -p gpui-prose -p gpui-ime --locked
cargo check -p gpui-prose --no-default-features
cargo xtask check
```

Windows 交叉检查（本机能做的只有这个）。Loro 经 `pest` 依赖的 `stacker` 要编一个包含 `windows.h` 的 C 文件，`psm` 要用 `lib.exe` 打包，GPUI 要用 `llvm-rc` 编资源；Homebrew 的 LLVM 有后两样，第一样用一个只声明一个函数的桩头文件骗过去（只做检查，不链接）：

```bash
mkdir -p /tmp/winstub && printf 'typedef void *PVOID;\nPVOID GetCurrentFiber(void);\n' > /tmp/winstub/windows.h
PATH="$PATH:/opt/homebrew/opt/llvm/bin" \
CFLAGS_x86_64_pc_windows_msvc="-I/tmp/winstub" \
AR_x86_64_pc_windows_msvc=/opt/homebrew/opt/llvm/bin/llvm-lib \
cargo clippy -p gpui-prose -p gpui-ime --target x86_64-pc-windows-msvc --all-targets --locked -- -D warnings
```

本机 2026-11-08 跑过，通过（含 IMM32 那段代码、测试和例子）。

## 要作者手测的

1. **真输入法**：清单沿用 [P0-B 的「待作者手测」](../spikes/p0-b-editor.md#待作者手测)，命令换成 `cargo run --release -p gpui-prose --example prose-bench -- chapter`（`PROSE_BENCH_IME_LOG=1` 打印输入法调用）。这一轮多测一项：**组字中点到别处**（比如别的窗口或查找栏）再回来，不应残留拼音，也不应把拼音上屏到别处。
2. **VoiceOver**（⌘F5 打开，测完再按 ⌘F5 关掉）：`cargo run -p gpui-prose --example editor`，点进正文：
   - 应读出「雨夜……文本区域」类的提示；VO+A 从光标读到章末；
   - ←/→ 逐字读、⌥←/⌥→ 逐词读（中文按词）、↑/↓ 读一行（屏幕上的那一行）；
   - ⇧→ 选字时读出所选的字；⌘A 后读出「全选」或所选内容；
   - 在别的地方点一下再回来、等光标闪几下，VoiceOver 不应报「窗口」或丢掉位置（这是 G7 那个坑，`gpui-prose` 绕开了）；
   - 用 VoiceOver 的文本转子（VO+U）或 VO+点按挪光标，编辑器的光标跟着走。
3. **Windows**（等能在 Windows 上跑）：键位逐个过一遍（Ctrl+←/→、Home/End、Ctrl+Home/End、Ctrl+↑/↓、Ctrl+Backspace、Ctrl+Z/Y、F3）；微软拼音、搜狗组字中点到别处，拼音应消失、不上屏。

## 待协调

1. ~~**F4a：批量编辑（一次提交）。**~~ 2026-11-08 做完：`ProseSource::edit_batch`，全部替换一次提交；平方级的来源和 Loro 的最小复现见 [f4b-layout.md](f4b-layout.md)。
2. **F4d：画查找高亮。** 读 `find_matches(chapter)`（排好序，`Rc` 指针不变说明没变）和 `find_current()`；查找是否开着看 `find_query().is_some()`。另外 `ProseEditor::element` 里正文那一行换成了 `input::a11y::editor_view`，加画层时留着它。
3. ~~**F4b：按屏幕行读。**~~ 2026-11-08 做完：段落在预绘制时记下排版，读屏按屏幕行切、带每字位置（[f4b-layout.md](f4b-layout.md#读屏按屏幕行)）。
4. **F6（外壳）：** 查找栏是外壳的界面：⌘F / Ctrl+F、⌥⌘F / Ctrl+H 在外壳的上下文里绑；查找栏打字调 `set_find`，「下一个」「替换」「全部替换」调对应方法，订阅 `FindEvent`（`QueryChanged` 更新输入框；`PassedEnd` 时如果要跨章找，用 F3 的书目找下一章、`ChapterEditor::switch_to` 再 `find_first`）。快捷键注册表接管时用 `key_bindings(KeyScheme::native())` 的列表，动作名不变。
5. **F5：缓存视图的读屏节点。** 外壳和 `dr-ui` 里别的缓存视图也会遇到 G7：读屏连着时被回放的视图会从读屏树里掉出去。挂 G7 之前，要读屏的缓存视图可以照 `editor_view` 的办法在读屏连着时不缓存。
6. **监管会话：G7、G8 要不要提上游、要不要挂。** 两个都是 GPUI v1.27 刚合入 AccessKit 后的问题，`a11y-probe`（`--stock-cache` 看 G7）在本机就能复现；按「确定的上游 bug 可直接报」的规矩，查重后可以开 issue（本会话没有对外发任何东西）。G8 不挂，VoiceOver 进程序时落不到正文上；挂的时候和 G1 一起开 fork。
7. **F4 台账：** `f4-editor.md` 的「GPUI 补丁台账」加 G7、G8 两行，G4 改成「完成（不改 GPUI）」；「下一轮怎么拆」的 F4c 一行指向本文。`progress.md` 的 F4 一行同理。这几处不是本子线的文件，留给监管会话合并时改。
