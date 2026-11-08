# F4c 输入：查找替换、选择扩展、读屏、Windows

2026-11-08。F4 编辑引擎的输入子线（[f4-editor.md](f4-editor.md)「下一轮怎么拆」的 F4c 一行，和「GPUI 补丁台账」的 G4）。代码在 `next/crates/gpui-prose/src/input/`（MIT OR Apache-2.0，不依赖任何 `dr-*`），`editor.rs` 只加了一个字段、一行注册和一处视图包装（见「改了 editor.rs 的哪几行」）。

## 一句话

编辑器能查找替换了：一章（或编辑器里的整本书）里所有命中、前后跳、逐个或全部替换，全部替换是一次撤销；区分大小写、全字（中文按 ICU 词典分词）两个选项；命中随编辑、撤销、别人的写入自动更新，「当前项」就是选区。双击后拖动按词扩展、三击后拖动按段扩展。正文作为一个多行文本框交给读屏（AccessKit），整章可读、选区读得到也设得进去，在真窗口里用进程内探针核过；GPUI v1.27 刚接上 AccessKit，有两个坑：缓存视图会把读屏节点弄丢（`gpui-prose` 已绕开，另存补丁 G7），系统问「焦点在哪」时答的是窗口而不是正文（要改 GPUI，补丁 G8 只存文件）。Windows 上组字中失焦时用 IMM32 让输入法丢弃（台账 G4，不用改 GPUI），键位有 Windows 一套（Ctrl、Home/End、Ctrl+↑↓ 按段、F3）。

第三轮（2026-11-08）：通览全书里选区能跨章了——拖选、⇧ 加方向键、⇧ 点击都能越过章界，复制把各章的部分用换行接起来；删除不合并章、不搬字，每章在自己的会话里删自己那段，这几步记成一组，⌘Z 仍只撤光标那一章的最新一步，但同一次删除在别章的部分（还没被后来的改动盖住的）一起回来。素材笔记里的列表能打了：回车续项、空项回车退出、项首退格变回段落、Tab / ⇧Tab 改层级、⌘↩ 勾任务（走点任务框的同一条路）、段首 `- ` / `1. ` / `[ ] ` 变列表（章节里不会）。

第四轮（2026-11-08）：Windows 输入法里本机能做的部分。读了 GPUI v1.27 的 Windows 后端怎么把 IMM32 的组字交给编辑器，「组字中失焦就丢掉」在 Windows 上补全了两处：窗口整个没了键盘（切到别的程序）时，输入法抢先上屏的半截拼音不收、连组字一起丢掉；输入法「清空组字」的那条消息不再被当成「用空字替换」去删选中的字。都不用改 GPUI，没有新补丁。GPUI Windows 后端会发的几种调用用单元测试照发一遍；x86_64 的交叉检查通过，微软拼音的真机验收写成了手测清单（第 5 条）。

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
- **GPUI 的一个坑，先绕开了。** GPUI v1.27 只在「预绘制」时建读屏节点，而缓存视图被原样回放时不走预绘制——编辑器的正文是缓存视图（光标闪一下只重画光标那一层），于是**别处一重画（光标闪烁、侧栏、状态栏），正文就从读屏树里掉出去，焦点退回窗口**。`gpui-prose` 的做法：读屏软件连着时，`ProseEditor::element` 不走缓存（`input::a11y::editor_view`），每帧都画正文；没连着时照旧缓存。代价只在开着读屏时才有。根本的修法是让 GPUI 在读屏连着时不回放缓存视图（或者回放时连读屏节点一起回放），补丁 G7 已经写好存成文件（`next/patches/gpui/0003-a11y-draw-views-uncached.patch`，13 行），工作区仍指向官方 v1.27.0；它对 Drifting 外壳里别的缓存视图也有用。2026-11-08 在 Zed main（`b5cd310`）上用一个不依赖 Drifting 的小程序复现了这个坑，打上补丁后不再掉，报成了 [zed-industries/zed#66690](https://github.com/zed-industries/zed/issues/66690)。
- **GPUI 的第二个坑：系统问「焦点在哪」，答的是窗口。** AppKit 回答「现在焦点在哪个元素」（VoiceOver 切进程序时先问这个）是从窗口的第一响应者问起的；GPUI 的第一响应者是它自己的视图，而 AccessKit 动态子类化的是窗口的内容视图（GPUI 视图的父视图）。结果 AccessKit 自己知道焦点在文本框上，系统却答「窗口」。探针里把内容视图临时设成第一响应者，系统马上答「文本框」，说明就是这个原因。这一处 `gpui-prose` 绕不开（要改 GPUI 建适配器的那一行），补丁 G8 存成文件（`next/patches/gpui/0004-macos-a11y-subclass-first-responder.patch`：让 AccessKit 子类化 GPUI 的视图，11 行）。2026-11-08 在 Zed main（`b5cd310`）上打补丁构建验证过（对 main 只差一行注释）：同一个小程序问，系统答的焦点从「窗口」变成「文本框」；报成了 [zed-industries/zed#66691](https://github.com/zed-industries/zed/issues/66691)。两个补丁互不相干，各自只修自己那一处。不挂的话，VoiceOver 用户切到 Drifting 时多半不会自动落到正文上，要用 VO 键挪进去；挪进去以后读文字、读选区、改选区不受影响，但打字和挪光标时的即时播报依赖系统认定的焦点，可能也受影响——这要用真的 VoiceOver 才能确认（见「要作者手测的」）。
- **怎么验证的。**
  1. 单元测试用 AccessKit 自己的读法（`accesskit_consumer`，macOS 和 Windows 适配器用的就是它）读编辑器交出的树：全文、选区的 UTF-16 范围、每段一行、段尾光标落在换行上、表情是一个字、600 字的段落切成几段但仍是一行、读屏挪光标时编辑器的选区跟着变。
  2. `cargo run -p gpui-prose --example a11y-probe` 在本机开一个小窗口，在进程里向窗口要读屏子元素（VoiceOver 连上时也是这样唤醒 AccessKit 的），再像 VoiceOver 一样读那个 `AXTextArea`，约两秒后自己关掉。不用读屏软件、不用系统权限。结果见下面「测量」。
  3. 真用 VoiceOver 读：要作者手测（本轮约定不改系统设置），清单见「要作者手测的」。
- **没做到的。** 系统层面的焦点（上面的 G8）；组字中的拼音（读屏听到的是输入法自己的播报）；跨章选区在别的章里的部分（读屏看到的是光标这一章里被选中的那段）；书模式下只交出光标所在这一章。

### Windows

- **组字中失焦（台账 G4；第四轮补全）。** 规则和 macOS 一样（P0-B 定的，`gpui_ime::BLUR_RULE`）：组字中焦点离开，半截拼音直接丢掉、什么都不上屏，同时让系统输入法也丢掉。Windows 上让输入法丢掉的那一下是 IMM32 的 `ImmGetContext(hwnd)` → `ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` → `ImmReleaseContext`，macOS 上是 `[[NSTextInputContext currentInputContext] discardMarkedText]`，都在 `input::system_ime::SystemIme`。编辑器开始收输入时，宿主没有自己设 `PlatformHooks` 的话，编辑器自己装上它，所以 `dr-editor` 不用做什么就有了；GPUI 的测试窗口没有原生句柄，不装。**不用改 GPUI，没有新补丁。**
- **GPUI v1.27 的 Windows 后端怎么把输入法交给编辑器**（读的是 `gpui_windows` 的 `events.rs`）。它只说 IMM32；微软拼音这类基于 TSF 的输入法经 Windows 的 IMM32 兼容层进来。
  - `WM_IME_COMPOSITION` 带 `GCS_COMPSTR` → `replace_and_mark_text_in_range(None, 组字串, 光标..光标)`，光标是组字串里的 UTF-16 位置；带 `GCS_RESULTSTR` → `replace_text_in_range(None, 上屏的字)`；两样都带时先上屏、再开新的组字（日文输入法确认一个词、接着组下一个）。什么都不带（日文输入法按 Esc 清空，或者回应 `CPS_CANCEL`）→ `replace_text_in_range(None, "")`。
  - 普通按键是 `WM_CHAR` → `replace_text_in_range(None, 那个字)`；`unmark_text` 从来不调。
  - 候选窗：`WM_IME_STARTCOMPOSITION` 时放到 `bounds_for_range(选区)`，之后编辑器每次挪光标调 `invalidate_character_coordinates`，候选窗跟着走。
  - 每画完一帧，如果焦点所在的元素不再收文字，GPUI 发 `CPS_COMPLETE`（把组字上屏）并摘掉输入法上下文；只在这个窗口有键盘时发，因为上下文是整个线程共用的。
  - 输入法在 GPUI 正忙（比如正在画）时同步回调进来，GPUI 拿不到应用状态，直接丢掉这次调用，不会崩。
- **焦点在窗口里挪走（点查找栏、侧栏）。** GPUI 在画下一帧时发失焦事件：先装好新元素的输入处理者，再发失焦，画完才轮到它自己的 `CPS_COMPLETE`。编辑器的失焦处理在中间：丢掉组字、发 `CPS_CANCEL`；输入法同步回过来的「组字清空」被 GPUI 丢掉（正在画，而且处理者已经不是编辑器了）；随后 GPUI 的 `CPS_COMPLETE` 什么也找不到。不取消的话，上下文是整个线程共用的，半截拼音会跟到查找栏里。
- **整个窗口没了键盘（切到别的程序、点了 Drifting 的另一个窗口）（第四轮）。** GPUI 是异步知道的（收到 `WM_ACTIVATE` 后另排一个任务），编辑器的失焦要晚一帧才来（GPUI 把窗口失活也当成失焦发）。这一帧里输入法可能有两种做法，是哪一种要在真机上看：
  1. 焦点一走就把组字上屏。这次上屏先于失焦到达，而那时 `GetFocus()` 已经不是这个窗口了。编辑器把「窗口没有键盘时来的输入」当成迟到的：不写，连同组字一起丢掉，再发一次 `CPS_CANCEL`（`PlatformHooks::has_keyboard`，`SystemIme` 在 Windows 上就是 `GetFocus() == hwnd`；`ime.rs` 的 `input_is_late`）。
  2. 输入法把组字留着。随后的失焦把它取消。这里不像 GPUI 那样先看 `GetFocus()`：一帧之内没人能在别处开始新的组字，线程上下文里那段组字还是编辑器的；留着它，作者回来、或者在别的框里一打字，半截拼音又冒出来。
- **「上屏空字」不删东西（第四轮修的）。** 上面那条「什么都不带 → `replace_text_in_range(None, "")`」以前被当成「用空字替换」：组字是盖在选中的字上开始的，选中的字会被删掉、还多一步撤销；没在组字时会删掉选区（跨章选区也是）。现在：在组字就等于删光了组字（取消，原文不动，和删光拼音一样）；不在组字就什么都不做。输入法明说了范围的（`Some(范围)`）照旧替换。
- **组字中在正文别处点一下。** macOS 上 GPUI 先把鼠标交给输入法，输入法一般自己把组字上屏；Windows 后端不交，组字留在原处，光标挪到点的地方，接着打字组字还在原处长。这不是失焦，P0-B 的规则没管到，这一轮没改（见待协调 13）。
- **键位。** `KeyScheme::{Mac, Windows}`，`bind_keys` 按运行的平台选（Linux 用 Windows 那套）；`key_bindings(scheme)` 给出任一套的列表，F6 的快捷键注册表接管时用它。Windows 一套：Ctrl 代替 ⌘ 做命令，Ctrl+←/→ 按词（Mac 是 ⌥），Home/End 到屏幕行的头尾（换行处光标靠前一行），Ctrl+Home/End 到章首章尾，Ctrl+↑ 到段首（已在段首就到上一段段首）、Ctrl+↓ 到下一段段首（Word 的习惯），Ctrl+Backspace/Delete 删词，Ctrl+Y 和 Ctrl+Shift+Z 重做，Ctrl+Insert / Shift+Insert / Shift+Delete 复制粘贴剪切，F3 / Shift+F3 查找。Mac 一套另加 ⌥↑/⌥↓（到段首、段尾，已在就到上一段段首、下一段段尾）。仍然不绑任何单个可打印键（zed#59882 的规避照旧）。
- **本机只能做到编译检查和单元测试。** Windows 的真跑要等 CI 或作者的虚拟机。GPUI 的 Windows 后端会发的那几种调用，单元测试照样发一遍（`input/tests/windows_ime.rs`）；`cargo check --target x86_64-pc-windows-msvc` 在 Mac 上要绕过三处 C 构建（Loro 依赖的 `stacker`、`psm` 和 GPUI 的资源文件），命令见「检查」。

## 第三轮：跨章选区（2026-11-08）

通览全书（M05 的 `BookEditor`）里，选区可以从一章拖到另一章，⇧ 加方向键也能越过章界。每章仍是一份独立的文档、一个独立的 F3 会话，所以先定下面这套说法，再照它做。

**说法**

1. **选区。** 选区记两头：锚点（拖选的起点）在哪一章哪个位置，光标那头在哪一章哪个位置。两头在同一章时和以前完全一样；不在同一章时就是一个跨章选区，`Selection::book_range()` 给出 `BookRange`，`Book::split_range` 把它切成每章一段。
2. **复制。** 各章选中的部分按章的顺序接起来，章与章之间放一个换行（`Book::text_in`）。贴回去是几个段落。
3. **删除不合并章，也不搬字。** 跨章选区上按删除、剪切、打字、粘贴、回车，或者输入法开始组字，都先把选中的字删掉：起点所在章删到章末，中间整章被选中的章删空（章还在，标题、页面、批注都还在，只是正文空了），终点所在章删到选区终点为止。章与章的分界不动，终点那一章剩下的字留在终点那一章，不会接到起点那一章后面。删完光标落在起点；打字、粘贴的内容写在起点那一章。
4. **落到会话。** 每一章各做一步，写进那一章自己的 F3 会话，在那一章自己的撤销栈里留一步。几章之间没有共同的提交——它们本来就是几份文档。
5. **撤销。** 这几步记成一组。⌘Z 照旧只撤**光标所在那一章的最新一步**；如果这一步是某次跨章删除的一部分，同一次删除在别的章留下的那一步也一起撤回，前提是它在那一章里还是最新的一步。哪一章在删除之后又被作者改过，那一章的这一步就留在那一章自己的撤销栈里，等光标进了那一章再按 ⌘Z 才撤。重做同理。所以和 F4（M05）的「撤销只撤光标所在那一章」不矛盾：撤的仍是这一章的最新一步，只是这一步本来就跨了几章。
6. **一步还是两步，和章内一样。** 打字、粘贴替换跨章选区，删除和写进去的字是同一步（章内替换选区也是一步，⌘Z 一次全回来）；回车、输入法组字时，删除单独算一步（和章内跨段的选区一样）。
7. **格式。** 加粗、斜体、下划线、删除线、链接、H1/H2/H3 在跨章选区上也是每章一步、记成一组，撤销同上。加粗这类开关看整个选区：每一章的那段都已经有了才去掉，否则全加上。
8. **不跨章的。** ⌘A 仍只选光标所在那一章；查找的当前项、读屏交出的文字仍是光标那一章（读屏看到的选区是这一章里被选中的那部分）；拖选越过章界时，章标题、章首章尾的宿主区域不算正文，选区从上一章章末直接接到下一章章首。

**做法**

- `Selection` 多了一个字段 `anchor_chapter`（锚点所在章；`chapter` 仍是光标所在章），和 `start()` / `end()` / `book_range()` / `spans_chapters()` / `Selection::across(锚点, 光标)`。`range()` 对跨章选区只给光标处的空范围——外面还按「一章内」用 `range()` 的代码（字数统计、浮条）因此看到的是「没选东西」，不会拿错范围去切字；要整段文字用 `ProseEditor::selected_text()`，要每章的部分用 `selected_in(章)`。
- 移动：⇧←/→ 越过章末章首（章界算一步，像换行），⇧↑/↓ 进到上一章、下一章的行，⌥⇧←/→ 在章边上去找邻章的词（章界当空格）；不按 ⇧ 时 ←/→ 把跨章选区收到它的头或尾。鼠标拖选、⇧ 点击可以落在任何一章（`drag_to_in(章, 位置)`）；双击、三击后的拖动跨章时照旧整词、整段地长。
- 编辑：`input/span.rs` 把选区按 `split_range` 切开，每章「先断一下撤销步，再改」，改完给这一步打上同一个组号（`ProseDoc::tag_last_step`）。撤销（`undo`、`undo_in`）和重做先看这一章最新一步的组号，再把各章里最新一步是同一组号的一起撤或重做；组号跟着步走，撤到重做栈里也带着。没有共同提交，没有第二套撤销栈。
- 画：每章各画自己被选中的部分；一章的部分一直延伸到下一章时，这一章最后一段也画到段尾外面，和段落换行被选中时一样。
- 读屏和输入法只看光标那一章：输入法问「选中了什么」时答这一章里被选中的那部分；在跨章选区上打字、组字，一律先按上面的规则删掉整个跨章选区。

## 第三轮：列表的输入（2026-11-08）

列表只在素材笔记里有（dr-doc 在章节里不收列表），样子是 F4d 画的（记号、编号、任务框，[f4d-render.md](f4d-render.md)），这里是按键。代码在 `input/lists.rs`。

| 按键 | 做什么 |
| --- | --- |
| 在一项里回车 | 续一项：新的一项和这一项同级、同类（拆段时继承 `list`、`list_level`，F4a 的规则本来就这样）。任务的勾和挂着的 TODO 不继承，新任务是没勾的。在一项中间回车，后半段留着原来那一项的勾和 TODO（段落属性跟着段尾换行走）。 |
| 在空的一项里回车 | 退出列表：嵌套的项退一级，第 0 级的项变成普通段落。不新增段落。 |
| 在一项开头按退格 | 这一项变成普通段落，字不动；再按一次才和上一段接起来。 |
| Tab / ⇧Tab | 选区碰到的每一项进一级、退一级（0–8 级，到头就不动）；夹在中间的普通段落不动。选区一项都没碰到时编辑器不管，按键交还给宿主（再往下就是系统照常输入一个制表符，和以前一样）。 |
| ⌘↩（Windows：Ctrl+Enter） | 勾上或取消选区碰到的每个任务，走的是点任务框的同一条路：编辑器发 `DecorationEvent::TaskClicked { chapter, line }`，宿主去勾（没挂 TODO 的改 `checked`，挂了的改那个 TODO 的状态，dr-editor 已经接好）。一个任务都没碰到时按键交还给宿主。 |
| 段首打 `- `、`* `、`+ ` / `1. `（任何数字）/ `[ ] `、`- [ ] ` / `[x] ` | 变成圆点项 / 编号项 / 任务 / 勾好的任务，打的记号消失；⌘Z 一次把记号原样还回来。只在宿主打开时有效（`set_list_shortcuts(true)`）：dr-editor 只给素材笔记打开，章节里打 `- ` 永远是字。 |

每一种都是单独一步撤销。组字时这些键都归输入法。

## 要求和完成情况

| # | 要求 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 查找替换的选区模型：所有命中、前后跳、逐个或全部替换（全部替换一次撤销）；区分大小写、全字（中文 ICU）；命中随编辑更新；为跨章预留接口；只给命中范围和当前项 | 完成 | `input/find.rs`（5 个纯函数测试）；`input/tests.rs`：`find_steps_through_matches_and_goes_round`、`matches_follow_edits_and_other_writers`、`replacing_one_and_all_are_single_undo_steps`、`whole_words_and_case_in_the_editor`、`book_scope_crosses_chapters_and_the_end_is_reported` |
| 2 | 双击按词、双击拖动按词扩展、三击按段、三击拖动按段扩展 | 完成 | `input/mouse.rs`；`a_double_click_drag_extends_by_words`、`a_triple_click_drag_extends_by_paragraphs` |
| 3 | 读屏（AccessKit）：正文作为可读文本区域、光标和选区变化能读出；如实写能做到的程度 | 完成到「整章可读、选区可读可设」（第一轮一段一行，2026-11-08 起按屏幕行、带每字位置）；GPUI 的两个坑：缓存视图丢节点已绕开并另存补丁 G7，系统焦点答成窗口要靠补丁 G8（只存文件） | `input/a11y.rs`；`input/tests.rs` 的 `a11y` 模块（4 个测试，用 `accesskit_consumer` 读）；`examples/a11y-probe.rs` 的本机输出（「测量」） |
| 4 | Windows：IMM32 丢弃组字（G4）、Windows 键位；本机只能 `cargo check --target x86_64-pc-windows-msvc` | 完成；Windows 上没真跑 | `input/system_ime.rs`、`input/actions.rs`（`KeyScheme`）；`windows_keys`、`mac_keys_for_paragraphs_and_find`、`paragraph_moves`、`test_windows_get_no_system_input_method`；Windows 交叉检查（「检查」） |
| 5 | 失焦时组字：清掉 + 让系统丢弃 | 照旧，并且现在不设钩子也会通知系统 | `losing_focus_drops_the_composition`（原有）；`SystemIme` |
| 6 | 用 `TestAppContext` 模拟输入；真输入法仍由作者手测 | 完成；手测清单见下 | 上面的测试都在 `TestAppContext` 里跑，键位测试用 `simulate_keystrokes` |
| 7 | 第三轮：跨章选区（`BookRange`）——通览全书里拖选、⇧ 方向键跨章扩展、复制、删除跨章；先定删除怎么落到各章会话、撤销怎么算 | 完成；说法见「第三轮：跨章选区」，和 M05「撤销只撤光标所在那一章」不矛盾 | `input/selection.rs`、`input/span.rs`；`input/tests/across.rs`：`shift_arrows_and_drags_cross_chapters`、`what_each_chapter_shows_selected`、`copying_and_deleting_across_chapters`、`a_chapter_edited_since_keeps_its_part_for_its_own_undo`、`typing_pasting_and_enter_over_a_selection_across_chapters`、`formatting_a_selection_across_chapters`、`others_writes_move_both_ends`；dr-editor 的通览全书测试照跑 |
| 8 | 第三轮：列表的输入——回车续项、空项回车退出、Tab / ⇧Tab 改层级、任务框的勾（F4d 共享笔记里的分工：另有段首退格、Markdown 记号） | 完成 | `input/lists.rs`；`input/tests/lists.rs`：`enter_continues_a_list_and_an_empty_item_leaves_it`、`a_nested_empty_item_moves_out_a_level_at_a_time`、`a_new_task_starts_open`、`backspace_at_an_item_start_leaves_the_list`、`backspace_inside_an_item_deletes_as_always`、`tab_and_shift_tab_change_levels`、`command_enter_ticks_tasks_through_the_host`、`markdown_markers_make_items_where_the_host_allows_lists` |
| 9 | 第四轮：Windows 输入法里能交叉编译、能单测的部分——组字中失焦用 IMM32 的 `CPS_CANCEL` 丢掉（P0-B 的规则）；看清 GPUI v1.27 的 Windows 后端怎么接输入法、我们挂在哪；能不改 GPUI 就不改；x86_64 和 aarch64 交叉检查；微软拼音真机验收写成手测清单 | 完成，不改 GPUI；aarch64 交叉检查见「检查」；Windows 上没真跑 | `input/system_ime.rs`（模块说明写了 GPUI 的接法和挂点）、`input/ime.rs`（`input_is_late`、空上屏）、`platform.rs`（`has_keyboard`）；`input/tests/windows_ime.rs`：`the_messages_of_a_windows_input_method`、`a_cleared_composition_leaves_the_selection_it_was_to_replace`、`an_empty_insert_without_marked_text_changes_nothing`、`input_after_the_window_lost_the_keyboard_is_dropped`、`losing_focus_or_the_window_tells_the_input_method`；手测第 5 条 |

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
| `input::system_ime::SystemIme::for_window(window)` | macOS / Windows 的 `PlatformHooks`；编辑器开始收输入时自动装上，宿主也可以自己装 |
| `PlatformHooks::has_keyboard() -> bool`（默认 `true`） | 第四轮：窗口此刻有没有键盘；没有时来的输入算迟到，编辑器丢掉它和组字。`SystemIme` 在 Windows 上是 `GetFocus() == hwnd`，macOS 用默认 |
| `Selection { anchor_chapter, .. }`、`spans_chapters()`、`start()` / `end()` / `anchor_pos()` / `head_pos()`、`book_range()`、`reversed()`、`Selection::across(锚点, 光标)` | 第三轮：选区的两头可以在不同章。`range()` 对跨章选区是光标处的空范围 |
| `ProseEditor::select_across(锚点, 光标, …)`、`drag_to_in(章, 位置, cx)`、`selected_in(章) -> Option<(范围, 是否延伸到章外)>`、`selected_text()` | 设跨章选区；拖到别的章；每章被选中的部分（画选区用）；选中的文字（跨章时各章用换行接起来） |
| `ProseDoc::tag_last_step(组号)`、`last_step_group()`、`next_redo_group()` | 撤销组：跨章编辑在各章的那一步带同一个组号，撤销、重做时一起走 |
| `list_item_at(章, 段)`、`shift_list_level(±1, …) -> bool`、`toggle_tasks(cx) -> bool`、`set_list_shortcuts(bool)` | 列表：读一段是不是列表项；改层级；让宿主勾任务；Markdown 记号开关（默认关） |
| 动作 `IndentListItem`（Tab）、`OutdentListItem`（⇧Tab）、`ToggleTask`（⌘↩ / Ctrl+Enter） | 新动作；没碰到列表项、任务时交还给宿主（`cx.propagate()`） |

## 改了 editor.rs 的哪几行

- 字段 `input: crate::input::InputState` 和它的初始化（查找、拖动单位、读屏状态都在里面，以后 F4c 再加状态也只改 `InputState`）；
- `render` 里一行 `.map(|root| self.input_layer(root, window, cx))`：注册新动作、读屏的角色和节点（为此 `render` 的 `_window` 改名为 `window`，`gpui` 的导入加了 `prelude::FluentBuilder`、去掉了不再用的 `StyleRefinement`）；
- `ProseEditor::element` 里正文那个 `.child(...)` 换成 `crate::input::a11y::editor_view(editor, cx)`：读屏连着时不走缓存。F4d 若要在 `element` 里加画层，在它旁边加 `.child` 就行。

第三轮（跨章选区）又动了这些别的子线的地方：

- `editor.rs`（F4 主会话）：`undo_in` / `redo_in` 改调 `undo_grouped` / `redo_grouped`（带上同组的别的章）；`sync_chapter` 里别人的改动分别挪选区的两头（各在各的章）；`clamp_selection` 两头各按自己那一章夹；`edit()` 开头断言选区不跨章（跨章的编辑都走 `span.rs`，发布构建里退回光标）。
- `render/items.rs`（F4d）：段落的选区范围改从 `selected_in(章)` 来，跨章时每章画自己那段。
- `text/undo.rs`、`text/doc.rs`（F4a）：`Step` 多一个 `group` 字段和上面三个方法。
- `dr-editor`：`book.rs` 的 `BookEditor::selection()` 改成 `selection().book_range()`（以前总是一章内）、模块说明；`view.rs` 的 `editor_on` 给素材笔记打开 Markdown 列表记号（一处，按 `DocId::profile() == Note`）。

第四轮（Windows 输入法）别的子线的地方只动了一处：`editor.rs`（F4 主会话）的 `on_blur` 加一行 `log_ime`（组字中失焦时打一条 `blur: marked text dropped`，手测时分辨走的是哪条路）。其余都在 `input/` 和 `platform.rs`、例子 `examples/editor.rs`（加了下面一条「另一个文字框」和 `PROSE_IME_LOG`）。

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

本机 2026-11-08 跑过，通过（含 IMM32 那段代码、测试和例子）；第四轮加了 `GetFocus` 以后再跑一次，通过。

aarch64（Windows on ARM）是同一条命令，把三处 `x86_64` 换成 `aarch64`（`CFLAGS_aarch64_pc_windows_msvc`、`AR_aarch64_pc_windows_msvc`、`--target aarch64-pc-windows-msvc`）。`psm` 在不是 Windows 的机器上改用 GAS 写法的汇编（`aarch_aapcs64.s`），用 LLVM 编，不需要微软的 `armasm64`。要先有这个 target 的标准库：`rustup target add aarch64-pc-windows-msvc --toolchain 1.98.1`。本机 2026-11-08 没装；监管会话定了这一轮不装，留给作者定，见「下一步」第 1 条。

## 要作者手测的

1. **真输入法**：清单沿用 [P0-B 的「待作者手测」](../spikes/p0-b-editor.md#待作者手测)，命令换成 `cargo run --release -p dr-editor --example prose-bench -- chapter`（基准程序已搬进 `dr-editor`）（`PROSE_BENCH_IME_LOG=1` 打印输入法调用）。这一轮多测一项：**组字中点到别处**（比如别的窗口或查找栏）再回来，不应残留拼音，也不应把拼音上屏到别处。
2. **VoiceOver**（⌘F5 打开，测完再按 ⌘F5 关掉）：`cargo run -p gpui-prose --example editor`，点进正文：
   - 应读出「雨夜……文本区域」类的提示；VO+A 从光标读到章末；
   - ←/→ 逐字读、⌥←/⌥→ 逐词读（中文按词）、↑/↓ 读一行（屏幕上的那一行）；
   - ⇧→ 选字时读出所选的字；⌘A 后读出「全选」或所选内容；
   - 在别的地方点一下再回来、等光标闪几下，VoiceOver 不应报「窗口」或丢掉位置（这是 G7 那个坑，`gpui-prose` 绕开了）；
   - 用 VoiceOver 的文本转子（VO+U）或 VO+点按挪光标，编辑器的光标跟着走。
3. **跨章选区**（第三轮）：在 Drifting 里打开通览全书，
   - 从一章中间拖到后面某章中间，三章都应显示选区，中间那章整章高亮、上一章最后一段的选区一直画到段尾外；
   - ⇧→ 在章末一下进到下一章开头，⇧↓ 在章的最后一行进到下一章第一行；
   - ⌘C 后贴到别处，各章的部分之间是一个换行；
   - 按删除：中间的章空了但还在，前后两章各少一截、没有合到一起；⌘Z 一次全回来，⇧⌘Z 再删掉；
   - 删除之后到最后那章打几个字，回到第一章按 ⌘Z：前两章回来，最后那章的字和删掉的那截还在；光标进最后那章再按两次 ⌘Z，先撤打的字，再撤回那截。
4. **列表**（第三轮）：在素材里打开一篇笔记，
   - 段首打 `- `、`1. `、`[ ] ` 各变成圆点、编号、任务；⌘Z 一次记号原样回来；
   - 列表里回车续一项，空项回车退出（嵌套的先退一级），项首按退格变回普通段落；
   - Tab / ⇧Tab 改层级，不在列表里时 Tab 和以前一样；
   - 光标在任务上按 ⌘↩，勾上或取消，和点任务框一样（挂着 TODO 的，审阅里那条 TODO 跟着变）。
5. **Windows 和微软拼音**（第四轮写定；在作者的 Windows 虚拟机里做）。
   - **准备。** 在虚拟机里 `next/` 下跑 `cargo run -p gpui-prose --example editor`，要看输入法的每一次调用就在前面加 `PROSE_IME_LOG=1`（PowerShell：`$env:PROSE_IME_LOG=1`），记录打在终端里。窗口上面是正文，下面一条是「另一个文字框」。输入法切到微软拼音（设置里默认的那一套；有搜狗的话每一步再用搜狗来一遍）。Ctrl+Q 退出。
   - **普通组字。** 在正文里打 `nihao`：拼音带下划线出现在光标处，候选窗贴着光标；按空格选「你好」，上屏；Ctrl+Z 一次撤掉整个「你好」。打到一半按退格删光拼音：什么都不留，原文不动。打到一半按 Esc：拼音消失，原文不动。
   - **盖着选区组字。** 选中两个字再打 `ni`：选中的字先还在、拼音显示在它们的位置；按 Esc 取消：那两个字原样都在（第四轮修的，以前会被删掉）；再选中、打 `ni` 按空格：被选的字换成「你」。
   - **组字中点到窗口里别处。** 打 `zhong` 不选字，点下面的「另一个文字框」：正文里的拼音消失、不上屏；在「另一个文字框」里打一个字母，拼音从这个字母重新开始，不带着 `zhong`。在空白处（不是文字框的地方）点一下，同样不上屏。
   - **组字中切走整个窗口。** 打 `zhong` 不选字，Alt+Tab 切到记事本：
     - 记事本里不应出现 `zhong`；切回来，正文里没有 `zhong`，再打字时拼音从头开始。
     - 记下终端里切走那一刻打的是哪种：有 `late: the window has no keyboard, dropped`，说明微软拼音是「焦点一走就上屏」的那种，被编辑器拦下了；只有 `blur: marked text dropped`，说明它把组字留着、被随后的失焦取消了。两种都算对，记下来是为了知道 Windows 上实际走的是哪条路。
     - 用鼠标点任务栏、点桌面代替 Alt+Tab，各再来一次。
   - **组字中在正文里别处点一下。** 打 `zhong` 不选字，在正文另一段里点一下，再接着打 `guo`：记下拼音出现在哪里（原处还是新光标处）、最后上屏到哪里。这一条目前没有规定（见待协调 13），只记现象。
   - **候选窗位置。** 在窗口右边缘、最后一行附近组字：候选窗不跑出屏幕外太多、不盖住正在打的那行；滚动正文后再组字，候选窗跟着光标。
   - **别的输入。** Win+. 打开表情面板插入一个表情：插在光标处，一个表情是一个字（← 一下跨过去）。Win+V 剪贴板历史粘贴：照常粘贴。切换中英（Shift）后打英文：直接上屏。
   - **键位。** 逐个过一遍：Ctrl+←/→ 按词、Home/End 到屏幕行头尾、Ctrl+Home/End 到章首章尾、Ctrl+↑/↓ 按段、Ctrl+Backspace/Delete 删词、Ctrl+Z/Y 撤销重做、Ctrl+Shift+Z 重做、Shift+方向键选字。
   - **在 Drifting 里再来一遍。** 在 `next/` 的开发版（`cargo xtask dev`）里打开一章：组字中按 Ctrl+F 打开查找栏、点侧栏、切到别的程序，拼音都不应上屏，也不应跟进查找栏；先在查找栏里留一个词，回正文组字到一半再按 Ctrl+F：查找栏里原来的词还在、没被清掉（待协调 12 说的是这一处）。
   - **结果怎么报。** 哪一步不对，把终端里那一段 `[ime]` 记录连同用的输入法和版本一起贴回来。

## 下一步（第四轮之后，交给接手的人）

2026-11-08 停在提交 296f60ca 之后。按先后：

1. **aarch64 交叉检查（作者定装不装）。** 本机工具链 1.98.1 没有这个 target，要先装：`rustup target add aarch64-pc-windows-msvc --toolchain 1.98.1`。装好后跑「检查」里那条 x86_64 命令，把三处 `x86_64` 换成 `aarch64`（`CFLAGS_aarch64_pc_windows_msvc`、`AR_aarch64_pc_windows_msvc`、`--target aarch64-pc-windows-msvc`）。`psm` 的 armasm64：监管会话的消息里说要用桩顶过去，但读 `psm-0.1.32/build.rs` 的结果是不用——它只在主机是 Windows 时才用 MASM（`masm = msvc && HOST 含 windows`），在 Mac 上改编 GAS 写法的 `src/arch/aarch_aapcs64.s`，用 LLVM 就能编。真报了 `armasm64` 找不到，再在 scratchpad 放一个同名脚本，用 `llvm-mc -filetype=obj -triple aarch64-pc-windows-msvc` 出一个空的目标文件顶过去，不进仓库。`stacker` 那个 `windows.h` 桩照旧。
2. **微软拼音真机验收**（作者在虚拟机里做，手测第 5 条）。看「组字中切走整个窗口」那一步的日志：
   - 出现 `late: …` 且记事本、正文里都没有拼音：这条路走通了。
   - 只有 `blur: …` 且没有拼音残留：输入法把组字留着，也对。
   - 切走后正文里多了拼音、日志里没有 `late:`：说明输入法上屏时 `GetFocus()` 还是这个窗口，`has_keyboard` 拦不住。那就要在窗口失活的那一刻同步取消：在 `SystemIme` 里用 `SetWindowLongPtrW(hwnd, GWLP_WNDPROC, …)` 套一层窗口过程（旧的过程存在一张以 hwnd 为键的表里，用 `CallWindowProcW` 转回去，`WM_NCDESTROY` 时还原），收到 `WM_ACTIVATE`（`WA_INACTIVE`）或 `WM_KILLFOCUS` 时，如果 `ImmGetCompositionStringW(himc, GCS_COMPSTR, None, 0) > 0` 就先发 `CPS_CANCEL`，再交给 GPUI。不要用 comctl32 的 `SetWindowSubclass`（没有 v6 清单时它可能只按序号导出，程序会起不来）。不想套窗口过程的话，退路是照 G7、G8 的办法在 `next/patches/gpui/` 存一个补丁，在 `gpui_windows` 的 `handle_activate_msg` 里同步做同一件事；工作区仍指向官方 v1.27.0。
   - 「盖着选区组字、按 Esc」后选中的字没了：说明还有别的路径把空字当替换，带着 `[ime]` 日志查 `ime.rs` 的 `replace_text_in_range`。
3. **dr-ui 对齐（待协调 12、14，F5 的文件）。** `dr-ui/src/input/field.rs` 和 `area.rs` 的 `replace_text_in_range`：`range16` 是 `None` 且文字为空时，有组字就当删光组字（`replace_and_mark(None, "", None)`），没组字直接返回；`ime.rs` 的 `system_discard` 在 Windows 上去掉 `GetFocus() != hwnd` 就返回的那一句；两个框的三个输入入口在 `GetFocus() != hwnd` 时丢掉输入和组字（照 `gpui-prose` 的 `input_is_late`）。各补一个单元测试，照 `input/tests/windows_ime.rs` 的写法。
4. **编辑器的 macOS 那一段（待协调 14 第三点）。** `SystemIme` 的 macOS 分支改用窗口自己的视图的 `inputContext`（dr-ui `ime.rs` 的 `system_discard` 就是这样做的）。`PlatformHooks::discard_marked_text` 现在不带窗口，要么给它加一个 `&Window` 参数（`dr-editor/examples/prose-bench/platform.rs` 的 `MacHooks` 跟着改），要么在 `SystemIme::for_window` 时记下视图的指针；前一种更稳。
5. **组字中在正文别处点一下（待协调 13）。** 等作者定了做法，在 `input/mouse.rs` 的鼠标按下处理里，挪光标之前先处理组字：丢掉就调 `cancel_composition` 再调钩子的 `discard_marked_text`；上屏就照 `unmark_text` 写入，再发 `CPS_CANCEL` 让输入法丢掉它那份。
6. **台账（待协调 15）。** `f4-editor.md` 的 G4 一行、`progress.md` 的 F4 一行补上第四轮。

## 待协调

1. ~~**F4a：批量编辑（一次提交）。**~~ 2026-11-08 做完：`ProseSource::edit_batch`，全部替换一次提交；平方级的来源和 Loro 的最小复现见 [f4b-layout.md](f4b-layout.md)。
2. **F4d：画查找高亮。** 读 `find_matches(chapter)`（排好序，`Rc` 指针不变说明没变）和 `find_current()`；查找是否开着看 `find_query().is_some()`。另外 `ProseEditor::element` 里正文那一行换成了 `input::a11y::editor_view`，加画层时留着它。
3. ~~**F4b：按屏幕行读。**~~ 2026-11-08 做完：段落在预绘制时记下排版，读屏按屏幕行切、带每字位置（[f4b-layout.md](f4b-layout.md#读屏按屏幕行)）。
4. **F6（外壳）：** 查找栏是外壳的界面：⌘F / Ctrl+F、⌥⌘F / Ctrl+H 在外壳的上下文里绑；查找栏打字调 `set_find`，「下一个」「替换」「全部替换」调对应方法，订阅 `FindEvent`（`QueryChanged` 更新输入框；`PassedEnd` 时如果要跨章找，用 F3 的书目找下一章、`ChapterEditor::switch_to` 再 `find_first`）。快捷键注册表接管时用 `key_bindings(KeyScheme::native())` 的列表，动作名不变。
5. **F5：缓存视图的读屏节点。** 外壳和 `dr-ui` 里别的缓存视图也会遇到 G7：读屏连着时被回放的视图会从读屏树里掉出去。挂 G7 之前，要读屏的缓存视图可以照 `editor_view` 的办法在读屏连着时不缓存。
6. ~~**监管会话：G7、G8 要不要提上游、要不要挂。**~~ 2026-11-08 报了上游：G7 是 [zed-industries/zed#66690](https://github.com/zed-industries/zed/issues/66690)，G8 是 [zed-industries/zed#66691](https://github.com/zed-industries/zed/issues/66691)（只开 issue，没开 PR）；挂不挂还没定。原来的说明：两个都是 GPUI v1.27 刚合入 AccessKit 后的问题，`a11y-probe`（`--stock-cache` 看 G7）在本机就能复现；按「确定的上游 bug 可直接报」的规矩，查重后可以开 issue（本会话没有对外发任何东西）。G8 不挂，VoiceOver 进程序时落不到正文上；挂的时候和 G1 一起开 fork。
7. **F4 台账：** `f4-editor.md` 的「GPUI 补丁台账」加 G7、G8 两行，G4 改成「完成（不改 GPUI）」；「下一轮怎么拆」的 F4c 一行指向本文。`progress.md` 的 F4 一行同理。这几处不是本子线的文件，留给监管会话合并时改。
8. **F6 / M07：跨章选区的字数和浮条。** `dr-shell` 的 `report_selection`（选区字数）和 `dr-editor` 的选区浮条用的是 `sel.range()`，对跨章选区那是光标处的空范围：字数会显示 0、浮条不出来（不会拿错范围去切字）。要算跨章选区的字数，改用 `ProseEditor::selected_text()`。编辑菜单的「全选」仍只选光标那一章，要不要改成全书全选是产品决定。
9. **F4 主会话 / M05：** [m05-book.md](../modules/m05-book.md) 待协调第 2 条（跨章选区、撤销要不要一起撤）已按本文「第三轮：跨章选区」定下并做完，那一条可以划掉、指到这里；`BookEditor` 的模块说明已改。`editor.rs` 改了哪几行见「改了 editor.rs 的哪几行」。
10. **F4d：** 选区画法改从 `selected_in(章)` 来（`render/items.rs` 一处）；`f4d-lists-for-f4c.md` 里留给 F4c 的列表按键都做了。代码块、引注框（也是笔记专用）还没有样子，也就没做它们的按键。
11. **F2 / F3：跨章删除不是一个事务。** 每章是一次独立的会话写入，几章之间没有共同提交；中途某一章写失败（`SessionSource` 记一条错误日志，那一章原样不动、也不留那一步），别的章照样删了。删了的每一章那一步都在同一组里，⌘Z 能一起撤回来；要不要做成跨文档的事务，等 F3 的会话层有这个能力再说。
12. **F5（dr-ui）：输入法「清空组字」会删掉文字框里选中的字。** GPUI 的 Windows 后端把「组字清空」（`WM_IME_COMPOSITION` 不带标志：日文输入法按 Esc、回应 `CPS_CANCEL`）发成 `replace_text_in_range(None, "")`。dr-ui 的单行框、多行框照「用空字替换选区」处理（`LineComposer::replace(None, "")`），选中的字会被删掉。编辑器这一轮改成了「有组字就取消、没组字什么都不做」。dr-ui 不能改在 `LineComposer::replace` 里（剪切、删除自己也走 `replace(None, "")`），要改在两个框的 `replace_text_in_range` 入口：`range16` 是 `None`、文字是空的时候，有组字就当删光组字，没组字就返回。会碰到的场合：查找栏里原有的词被 Ctrl+F 选中，正好赶上编辑器失焦发的 `CPS_CANCEL` 的回声——回声同步回来的话 GPUI 会丢掉，碰不到；排队回来的才会，要真机看（手测第 5 条最后一项）。日文输入法在框里按 Esc 则一定会碰到。
13. **监管会话 / 作者：组字中在正文别处点一下怎么办。** macOS 上 GPUI 先把鼠标交给输入法，输入法通常自己把组字上屏；Windows 后端不交，组字留在原处。P0-B 的「失焦就丢掉」管不到这里（焦点没走）。三种做法：照旧（Windows 上组字留在原处）、和失焦一样丢掉、和 macOS 常见的一样把拼音原样上屏。编辑器这边哪一种都好做（鼠标按下时先处理组字再挪光标），等定了再做；先看手测里两边实际各是什么样。
14. **F5（dr-ui）：窗口失活时和编辑器不一致的两处，加上编辑器反过来该学的一处。**
    - dr-ui 的 `system_discard` 在 Windows 上先看 `GetFocus() == hwnd`，不是就不发 `CPS_CANCEL`。窗口失活引起的失焦晚一帧才到，那时 `GetFocus()` 已经不是这个窗口，所以输入法把组字留着的话，dr-ui 的框不会让它丢掉，作者回来一打字半截拼音又冒出来。编辑器不看 `GetFocus()`（理由见「整个窗口没了键盘」）。
    - 输入法在焦点一走就上屏的话，那次上屏先于失焦到达；dr-ui 的 `takes_input` 看的是 GPUI 的焦点，那一刻还在框上，会收下拼音。编辑器在 `has_keyboard`（Windows 上 `GetFocus() == hwnd`）为假时丢掉输入。
    - 反过来，macOS 上 dr-ui 用的是窗口自己的视图的 `inputContext`（切窗口后 `currentInputContext` 已经是别的窗口的），比编辑器的 `currentInputContext` 准。编辑器的 macOS 那一段这一轮没动（只做 Windows），下一轮可以照 dr-ui 改。
    - 这些最好收成一份共用的「系统输入法」小代码；`gpui-ime` 不带依赖放不进去，放在 `gpui-prose` 让 dr-ui 依赖也不合适（dr-ui 不依赖编辑器）。先各自对齐，真机结果出来再定。
15. ~~**F4 台账：** G4 一行和 `progress.md` 的 F4 一行补第四轮~~：第二十二批已更新，明确实现已合、Windows 实机验收待做。

