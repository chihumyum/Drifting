# F6 dr-shell：外壳（第一至第十轮，M03、M04、M05 接入、M08、M26 外壳部分）

2026-11-07 起，分支 `claude/f6-shell-80c9fb`。第一个里程碑从整合分支 `claude/f-batch2-integrate` 开工；第二个里程碑从 main `4c477ea0`（F3 第二个里程碑、F5 第二个里程碑已合）接着做；第三个里程碑（11-08）从 main `a039863f`（dr-editor、F5 的 `TabDock` 已合）接着做；第四轮（11-08）从 main `7444ff65`（M01/M02 书架与作品主页、M06/M07 搜索与字数、F4c 输入、F4d 画层、M05 全书视图已合）接着做；第十轮（11-09）从 main `75491374`（第十七批）接着做；第九轮（11-08）从 main `0f9b86b0`（第十五、十六批）接着做；第八轮（11-08）从 main `2eb865fa`（第十三批）接着做，中途合了 main `4e40ee20`（第十四批，F4 第五批）；第七轮（11-08）从 main `77a957d3`（第十二批）接着做；第六轮（11-08）从 main `60d510a6`（第十一批）接着做；第五轮（11-08）从 main `1652a95e`（第十批：F4e 第二批、F4d 画层与 M18、F3 第四轮与 M09、F7 设备与 M39、F8 调试桥、M10 导入界面）接着做。代码在 `next/crates/dr-shell`、`next/crates/dr-i18n`，应用入口 `next/app/drifting`。计划见 [foundation.md 的 F6](../foundation.md#f6-dr-shell)。

## 一句话

稿纸四周的那一圈搬到了 GPUI 上：三栏、两侧抽屉、稿纸顶上的标签坞、分栏、Super View 舞台、设置、通知、快捷键、退出流程，外加读旧版九种语言文案的 `dr-i18n`。第二个里程碑起，外壳打开的是**真的书**：面板列表从 F3 的查询来，别处（帮手、另一台设备）删了东西，对应的标签自己关掉。第三个里程碑起，**在 App 里打开一本书就能写字**：稿纸上是 F4 的编辑器，打的字、回车、撤销都经 F3 落盘，关掉 App 再开都在，搜索和字数跟着变。

### 第十轮：沉浸写作的外壳部分（M26）（大白话）

照 m26-immersive.md「给 F6 的接口」做，新文件 `workspace/immersive.rs`：

- **编辑器跟着进出。** 进出沉浸时，所有开着的编辑器（分栏的两页都算、新打开的也算）都调 `set_immersive`，打字机滚动在沉浸中强制打开；每一帧对一遍，所以新编辑器不会漏。段落淡出照旧只给拿着键盘的那个。
- **打字时自动进入。** 订阅稿纸上编辑器的 `WritingTyped`（只认作者亲手打的字），设置「打字时自动沉浸」开着、还没在沉浸就进入，光标留在原处。
- **打字进入的，点稿纸外面就退出。** 窗口捕获阶段听按下：不在稿纸上、也不在出口上，就退出，这一下照常落下。悬停卡、对话框、通知这些层开着时不算。用一炷香或 ⌘⇧↩ 进入的不会这样退出。打开全窗视图、回书架也结束沉浸。
- **顶边露出。** 指针到窗口顶边 56 px 内，红绿灯和标签点回来（标签点照常能换文档）；按一个不带修饰键的键、或者指针离开窗口，都收走。
- **出口。** 稿纸右下角（右 16 px，和工具栏同一条中线），指针靠近才出来：一炷香（选中），左边是这一次写了多少字（`+N`，这本书在这台设备上今天的净增字数，和左栏「今日」同一来源，进入时记起点），下面是今日那笔砂往每日目标长（目标在进入时后台读）。
- **macOS 红绿灯。** 沉浸时把三个按钮的透明度设成 0。改透明度时 AppKit 会把标题栏重排、丢掉自定的位置，所以同一个主线程回合里先记下三个按钮和容器的位置，改完立刻放回去（`chrome::set_traffic_lights_hidden`）。为此工作区的 `objc2-app-kit` 多开了 `NSView`、`NSWindow`、`NSButton`、`NSControl`、`objc2-core-foundation` 几个特性，dr-shell 加了 `raw-window-handle`。
- 一炷香照旧在工具栏药丸右边；批注和大纲 rail 照进入前的样子，不碰。
- 顺手：`SuperViewPage.head_end` 的注释改对了。关系线图例在内容区右上角（作者 2026-11-03 定的），由视图画在正文里，不放头部；M22 的群岛 / 关系切换器放 `head_start`（计数左边）没变。
- 没做：减少动效时控件的淡出（出口用的是悬停时直接显示，没有过渡）；同步云在沉浸中不呼吸（同步云还没做）。

### 第九轮：本机值、编辑故事线、按书记忆收进库里、Markdown 文件夹、字海和导览的登记口（大白话）

- **（插队）全窗视图和帮手的登记口，给 Codex 做的模块用。**
  - `pages::add_super_view(cx, SuperView, |&SuperViewHost, &mut Window, &mut App| SuperViewPage)`：故事图（M21）、要素全景（M22）、审阅与素材（M23）各自登记正文。`SuperViewHost { workspace, library, book_id, book }`；`SuperViewPage::new(正文).head_start(视图).head_end(视图)`：`head_start` 放在舞台头部左边「返回」后面（M22 的群岛 / 关系切换在计数左边），`head_end` 放在头部最右，给视图自己的控件用。关系线图例不放这里：作者 2026-11-03 定的是在内容区右上角，由视图画在正文里（第十轮改正了注释）。舞台第一次给这本书显示某个视图时问一次，留着用，换书、换库时重做；谁也没登记的视图照旧是一张空纸。测试用 `Workspace::super_view_content(view)` 看做出来的东西。
  - `pages::set_companion(cx, |WeakEntity<Workspace>, &mut Window, &mut App| LeftPanel)`：右栏「帮手」标签（M31）的头和正文，照 `add_left_panel`：每个半栏第一次显示这个标签时问一次，留着用；头放在标签那一行，正文铺满半栏。没登记时照旧空白。
  - `pages::set_library(cx, |WeakEntity<Workspace>, &mut Window, &mut App| LeftPanel)`：右栏「素材库」标签（M19）的头和正文，写法和 `set_companion` 一样（每个半栏第一次显示时问一次，留着用；换书时放掉）。没登记时外壳照旧自己列素材夹和素材。测试 `a_module_draws_the_library_tab`。

- **模块的本机值。** 设置文件的「本机」一段里多了一个 `modules` 小格子：`SettingsFile::device_memory` / `Settings::set_device_memory`。放的是模块要在这台设备上记、但又不是设置（面板里没有一行、注册表不管）的东西。书架的画风（`shelf.cover_style`，旧版 `shelf:cover-style`）已经改成存在这里，重开还在。
- **「编辑故事线」。** 章节的 ⋯ 菜单和悬停卡在写作状态后面多了一节「编辑故事线」：每条故事线一行（带它颜色的记号），这一章在上面就打勾，点一下放上去或拿下来。规则照旧版：按「主线在前」的顺序加在后面或拿掉，剩下的第一条就是主线；一次 `chapter.update` 写完，一步撤销。
- **悬停卡让模块在前面加行。** `page_hover_card` 的最后一个参数改成 `CardRows { lead, before_danger }`：`lead` 放在页面自己的行上面（M14 的「转移至未归属」「在此故事线中新建章节」），`before_danger` 放在删除一类前面。
- **按书的本机记忆收成一处：F2 的 `local_state`。** 之前有两处：M15 的宽高比在 `local_state`，外壳的 `book_memory` 在设置文件的布局里。收进 `local_state`（范围 `shell`，键 `memory:<书>:<模块的键>`，行上记着书），理由：
  - 彻底删书时，F2 在同一个事务里把挂在这本书上的行一起删掉；设置文件里的条目没人删，会一直留着。
  - 换库时，它跟着库走：恢复的备份带着它自己的记忆，恢复前副本里也有当时的；设置文件跨库共用，换库后对不上。
  - 多窗口时，两个窗口读写的是库里同一行；设置文件里的布局是每个窗口各存一份，后写的盖掉先写的。
  - 设置文件留给「布局」（标签、侧栏、底部面板这些窗口的样子）和全机的值。
  
  `book_memory` 的用法不变：书打开时在后台把这本书的记忆读进来，读完以前 `book_memory_ready()` 是假的，读完工作区通知一次；读的这段时间里模块写的值以模块的为准。时间线等读完再套用它记的东西。设置文件里旧的 `modules` 条目不再读（开发期的数据，没有迁）。
- **Markdown 文件夹（M40）。** 外壳新文件 `mirror.rs`：库开着、选了文件夹、没关掉时启动 `dr-mirror`；改了位置或开关就停了再按新的起；换库和退出前先过最后一遍、写完还没写的再停，都在关库之前。合并不了的文件，每个文件每个原因发一条通知（章名，下一行是原因），点了打开这一章（别的书的话先打开那本书）；同一个文件同一个原因只发一次，合并好了或原因变了就撤掉；另存到 `.drifting/preserved` 的按个数发一条。设置「本地数据」照旧版加了两行：「Markdown 文件夹」（关着时是主按钮「开启」，开着时是「在访达中打开」）、位置（「所有项目 · 未选择位置」时「选择文件夹」是主按钮，旁边是危险按钮「关闭 Markdown 文件夹」，先问一句）。位置和开关是本机值（`markdown.folder`、`markdown.disabled`），不同步。
- **字海、首次运行、导览（M24）的登记口。** `pages::set_backdrop`、`set_first_run`、`set_guide`，外壳不依赖 dr-view-sea；dr-view-sea 新加 `shell::init` 把三样登记进来，应用调一次。
  - 字海是窗口根的第一个子元素，书架和工作区都在它上面。书架开着时按住字海（页面）；从书架打开书时按住「等待」，整个窗口只露字海，直到前面那一页好了（最多 2 秒；过了 240 ms 露了面就至少再停 600 ms），同一帧里把书架那一个也放开；换库时也按住「等待」，新库装回去才放。
  - 最后一个放开后字海退潮几秒：这几秒里工作区不铺桌面色（根、稿纸四周、底部面板），两侧栏和底部面板用 `on_sea` 包成躺在字海上的素玻璃。
  - 首次运行：这台设备第一次打开时，书架上面先盖一层首次运行，它说可以了才在下面画书架；走完记下本机值 `first_run.done`。M40 选文件夹那一步接上了（这台设备还没选、也没关的时候才出现）。
  - 导览：书的工作区第一次露出来时开始（这台设备看过就不开），图层是工作区根的最后一个子元素，全窗视图盖着时收起。外壳标了这些控件：左栏面板标签、两侧栏关着时的开关、要素面板头上的全窗视图入口、竹子（时间线开关）、鸟居、风铃；右栏的「帮手」标签现在只能整行标（分段控件还不能单独标一段，见「待协调」）。「看过了」存在本机值 `guides.seen`。设置「外观 → 引导 → 第一次打开书时的导览 · 重新显示」。
- 沉浸写作的外壳部分（第七项）这一轮没碰，等 F4 的接口说明。

### 第八轮：底部面板、按书记住、换库交还、恢复前副本、悬停卡给模块（大白话）

- **底部面板。** 稿纸下面、两侧栏之间的一块地方，一次只放一样：时间线（M14），或者前面这一章的情节规划（M15）。默认 180 高，上沿能拖：拖住的那一点一直在指针下面，最低 180（时间线泳道多时以它要的高度为准），最高给稿纸留 240。开、关和侧栏一样滑（420 ms），收起时还画着刚才那一块；一本书第一次画出来时不滑。
- **开关。** ⌘J 和稿纸角上的竹子（在工具托盘左边，分栏时只在右边那页）开关时间线；情节规划的按钮在工具托盘第一个，只在章节或构想在前面时出现。打开情节规划，时间线让位；⌘J 又把时间线换回来、情节规划收起。别的页面在前面时情节规划让开，回到章节或构想再出来，作者的选择留着；沉浸写作时整块收起。开没开、哪一块、多高，跟这本书的布局一起存在本机（`BookLayout.bottom`）。只有登记了的模块才有对应的开关。
- **给模块的登记口：`pages::add_bottom_panel(cx, BottomPane, make)`。** 照 `add_left_panel` 的样子：时间线每个窗口、每本书做一次（面板开始滑出时就做，边滑边读），情节规划每换一个章节或构想做一个（时间线换上来时放掉）；换库时全部放掉重做。模块给 `BottomPanel { view, min_height, refresh }`：`min_height` 是拖的时候最低能到多高，`refresh` 在书目快照变了时叫（情节规划用它在改名后换标题）。时间线和情节规划的 `init` 我顺手写了（dr-view-timeline、dr-view-plot 各加一个 `init`，应用里调用）。
- **时间线按书记住。** 外壳给模块一个按书存的小地方：`Workspace::book_memory(key)` / `set_book_memory(key, value, cx)`，存在这本书的本机布局里（`BookLayout.modules`），不进书。时间线把「书序还是叙事时、未归属开没开、缩放、横向滚动」存在 `timeline` 下（`dr_view_timeline::kept::Kept`）：换书各用各的，重开还在；滚动在滚轮停下 400 ms 后存。
- **审 M10 改的外壳三处。** 通知带按钮（`NoticeAction`）、`with_workspace` 先找活跃窗口、`dialogs::show_in`：做法都对，留着。改了两处：
  - 在对话框自己的按钮里关它时（M41 备份对话框的「关闭」「完成」就是这么调的），GPUI 正把这个窗口借出去处理这次点击，`hide` 再去改它会失败；以前是悄悄失败，对话框关不掉。现在外壳的 `workspace::update_workspace` 先试着马上改，窗口正忙就等这次点击结束再改；`show`、`show_in`、`hide`、`with_workspace`、`with_workspace_in` 都走它。
  - 通知上的按钮点了，不再连带触发整行的点击（崩溃回访那一行整行能点）。
- **换库关不掉就交还。** `library::replace` 改用 F3 的 `try_shutdown`：还有别人拿着库时，F3 把工作区原样交回，外壳就不跑替换任务，窗口接着用原来的库，对话框听到「关不掉」。F3 连原样都开不回来时，照旧从目录再开一次。
- **「打开恢复前副本」。** 设置「本地数据」里「恢复…」旁边一个淡按钮（旧版文案 `settings.sync.backup.openSafety`），在访达里打开 M41 恢复前存副本的文件夹，没有就先建，和旧版一样。文件夹在哪由 F2 说了算：dr-store 加了 `Library::pre_restore_dir(root)`。
- **悬停卡给模块。** `dr_shell::workspace::page_hover_card(id, el, target, ws, extra, cx)`：就是章节面板那张卡（名字、字数、故事线、梗概，下面是和 ⋯ 菜单一样的动作），模块自己的行（比如时间线的「转移至未归属」）排在删除一类前面。在模块自己的视图里画的时候调（它要读工作区）。
- **退出顺序。** 照 F7 的建议，⌘Q 先把应用藏起来，再跑退出钩子：导入收尾最多两秒，窗口不再呆站在那里。由应用启动时调一次 `quit::hide_first(cx)` 打开（GPUI 的测试平台不会藏，测试和离屏截图不开）。
- 调试桥的窗口状态多了 `bottom: {pane, height}`；真窗口场景 `crates/dr-cli/scenarios/bottom-panel.json`。
- **素材笔记（F4 第五批，合 main `4e40ee20` 后做）。** ⌘⇧H 的高亮键（`dr_editor::highlight::key_bindings()`）经 `keymap::add_bindings` 登记，改快捷键重建键位表后还在；点素材笔记里嵌入的素材（`MaterialOpened`）用预览标签打开那个素材，和旧版一样。
- 还没做：两块互换时旧版那种「往上推」的动画没画，直接换；时间线自己的片段还没用悬停卡（M14 下一轮）。

### 第七轮：链接、跨章选区、左栏给模块、侧栏记住滚动（大白话）

- **人物链接点了就打开。** F4 的编辑器发 `EntityLinkOpened`（单击一个还在的人物、地点……链接），外壳把它当预览打开（旧版也是预览标签）；节点按书目分成章节或构想，补丁、批注没有页面。
- **「已复制位置链接」。** 斜杠菜单的「位置链接」放进剪贴板时编辑器发 `PositionLinkCopied`，外壳在窗口下沿浮出一张小纸条（dr-ui 的 `NotificationPill`，带一个勾），1.6 秒后淡出。文案是新版自己的（`positionLink.copied`，九种语言）。小纸条是外壳的 `Workspace::toast(文字)`，别的地方要提示一句也能用。
- **跨章选区。** 全书里选区越过章界时，`range()` 只给光标处的空范围。外壳的选区字数改用 `selected_text()`，各章的部分都算进去；dr-editor 的选区浮条也在跨章选区上出来，放在光标那一章的那段上（光标那一章没选到字时放在锚点那一章）。加粗这类和 H1/H2/H3 本来就按章分别改；「引用」和「添加批注」只能写一章，跨章时变灰、点了没反应。⌘A 照旧只选光标那一章。
- **左栏给模块：`pages::add_left_panel`。** 和 `add_page_chrome` 一样登记：每个半栏第一次显示某个标签时问一遍，第一个答的算数，答案留着用。模块给 `LeftPanel { head, body }`：head 放进标签那一行的位置（行高、内边距和顶边的发丝线还是外壳的），body 铺满半栏、自己滚；登记了的标签不再画外壳自己的行。M11 的要素面板接上了（`dr_view_elements::init` 里登记，`make_panel`）。换库时这些面板放掉、重新做。
- **⋯ 菜单的行收 `RowIcon`。** `PageMenuItem.icon` 改成 dr-ui 的 `RowIcon`：砂笔图标（`Icon::Folder.into()`）或某种东西的记号（`RowIcon::Mark(Kind::Category, None)`），M11 的「更改类目」可以带类目记号。M11 那边这一轮自己去登记。
- **侧栏记住滚动和折叠（照 workspace.md）。** 每个半栏、每个标签的列表记住滚到哪里（按「书 × 侧栏 × 半栏 × 标签」，这次运行里有效）：侧栏收起再打开、换到别的书再换回来，列表还在原处。章节面板的折叠也改成按「书 × 半栏」记，两个半栏各折各的，换书再回来还在；都不写进文件。
- 顺手：真窗口自检读字数前也让 F2 先补完没建好的索引（`rebuild_stale_indexes`），和监管会话改测试的做法一样；不然 F2 等作者停手 500 ms 才补，自检读到的字数会不全。

### 第六轮：全书不再 panic、⋯ 菜单给模块、记住导出、章节面板折叠和悬停卡（大白话）

- **全书打开不会再崩。** 「全书」标签改成在后台跑 F4 的 `BookEditor::prepare`（列章、开每章的文档、读锚点），主线程上 `with_prepared` 建编辑器，这一步不会失败；原来那条 `panic` 删了。
- **「新建下一章」的标题拿光标是外壳认的意图。** `Open` 多了一个 `title`（`Open::KEEP.at_title()`）：这样打开的页，编辑器建好时外壳不把键盘给正文，让章首自己把光标放进标题、全选（dr-view-page 的 ⁂ 改用它）。以前靠的是焦点先后碰巧对上。装了章首（模块的 chrome）的页，外壳不再给编辑器设标题行，改名时也不设。
- **⋯ 菜单一份清单，模块能加行。** 页面能做的事列在一处（`workspace::page_actions`）：分享（章节、构想、要素、故事线、类目页都有，素材没有）和章节的导出成稿；章节的写作状态；模块加的行；历史快照…；最后是删除一类（章节的删除节点、模块标了危险的行）。稿纸角落的 ⋯ 和章节面板的悬停卡都读这一份。模块用 `pages::add_page_menu(cx, |target, host, cx| sections)` 加行（M11 的更改类目、更改分组、删除要素这样的）；行只是数据（图标、字、勾、危险、做什么），菜单先关再做。
- **导出记住的选择跨重启。** 作者名记在设置文件的账号值 `export.author`，每本书的格式、两个开关、改过的书名记在这本书的 `export` 一项。dr-view-export 看不到设置文件（外壳依赖它），所以外壳启动时把这些填进它的 `Prefs`，以后 `Prefs` 一变就写回文件。
- **自动要素链接、补丁出处。** 设置里「自动要素链接」变了，外壳调 F3 的 `Workspace::set_auto_links`（启动时也按设置调一次）。正文改过的章节或构想，在光标离开那一段、或正文失去键盘时（和编辑器自己的 `todo.project` 同一个时机），外壳调 F3 的 `patch.check_sources`，出处那段话没了的补丁标为失效，回来了的取消。
- **设置「本地数据」最上面加了「资料库备份 · 导出备份…」「从备份恢复 · 选择备份…」两行**（旧版的位置和文案），按钮先关设置、再派发 `workspace::BackupLibrary` / `workspace::RestoreLibrary`（dr-text 要的名字）。对话框在 dr-text 的 dr-view-transfer 里，`init` 里 `cx.on_action` 接这两个动作，用 `dialogs::show` 开。
- **换库（恢复备份用）：`dr_shell::library::replace(cx, job, done)`。** 外壳先让所有拿着库的东西放手：每个窗口的编辑器、书架、作品主页、搜索、快照历史、批注撰写框和订阅都放掉（布局先存好），统计先把写作日存完再停，统计和审阅两个标签放手，`Services` 里不再有库；问这件事的对话框留着。然后在后台让 F3 补完索引、关库（`Workspace::shutdown`，等最后几个拿着它的线程放手），库关着的时候跑 `job(根目录, 打开选项)`（选项里有这台设备的身份，`restore_staged` 要用），把它返回的库作为 F3 的工作区打开，装回 `Services`、自动要素链接、统计和审阅，每个窗口回到书架（没有书架时打开上次的书）。`job` 失败时，用同样的选项把原来的库重新打开、照样装回，`done` 收到失败的原因。库关不掉或者重开不了时，`done` 也会说明，窗口里就没有库了，要退出重开。`replace` 等当前这次派发结束才动手，在按钮回调里直接调就行。
- **大纲栏的「…」悬停出小菜单。** 指到「…」上，它折起来的标题列在旁边（离窗口最近的十个，和旧版一样），每个按自己那一级的字号；点一下跳过去。指针从「…」挪到菜单上不会关，离开两者 140 ms 后关。
- **章节面板按故事线看时能折叠。** 每条故事线那一行的右端是这一组的章数和一个箭头，点箭头折起或展开（点行本身照旧打开故事线）；「未归属」那一行点哪里都折。面板头上多了一把折扇：都展开时它画成合着的，按一下全部折起；有折起的时候画成打开的，按一下全部展开（旧版的画法）。折叠只在这个窗口里记着，不存。
- **章节面板的悬停卡。** 指在章节或故事线那一行上 220 ms，旁边出一张卡（dr-ui 的 `HoverCard`）：名字和记号、字数（故事线是「N 章 · Xk 字」）、章节的故事线（主线在前）、梗概，下面是 ⋯ 菜单里的那些行（写作状态是当场能改的选项）。
- **滚动条上的批注刻度**：F4d 已经在编辑器里画好了（批注横跨、Agent 改动三条细道，点刻度跳过去、审阅面板那张卡亮起），外壳这边不用再做什么。
- 顺手：设置「本地数据」里「数据使用」小标题出现两次（开关一次、诊断摘要又一次），改成连着的只出一次。
- 顺手：M10 第 14 句（`carries_on`）的措辞和别的几句对齐了（「导入」「资料库」；西、德、法、葡用和其他几句一样的祈使说法）。

### 第五轮：浮层收成一套、替换、排序（大白话）

- **选区浮条的「批注」。** F4 的选区浮条点「批注」时发 `CommentRequested { doc, range, text }`，外壳照 ⌘⌥M 的办法，在那段文字最后一行下面打开 M18 的撰写框（和 ⌘⌥M 共用 `show_composer`）。单章页和全书页都接了：全书里按 `doc` 找到是第几章。
- **浮层只留一套。** F7 的 `Workspace.dialog` 留下，M10 的 `pages::add_layer` 删了：模块要开模态对话框就 `dr_shell::dialogs::show(cx, view)`，关就 `dialogs::hide(cx, view_id)`（只关它自己那个，关掉后键盘还给稿纸）。导入对话框改成看自己的状态：不在空闲、选文件夹时就 `show`，回去了就 `hide`。原来那一层在空闲时也把（空的）导入视图画着，现在不画了，GPUI 的 `update_in` 就找不到它的窗口（它找的是实体上次画在哪个窗口里），选完文件夹后导入会停在「选文件夹」；所以导入里两处异步回调改成用开始时的那个窗口（`flow.rs`）。M09 的快照历史仍是自己的字段，也算模态。**模态开着时工作区的快捷键全停**（M10 问的，监管定的）：`Workspace::modal()` 为真时工作区不挂动作，⌘, 也不开设置；开对话框时通知中心和账户菜单先收起。
- **F4 交过来的几样。** 单章编辑器改成后台先开 `SessionSource`、主线程 `ChapterEditor::with_session`，不会失败了，原来那条 `panic` 删了（全书仍是 `BookEditor::open`，见「待协调」）。设置加了三行：编辑器「排版」下的「两端对齐」（新版自己的文案）；「流程」下的「输入行位置」（25–75 %，默认 50 %，打字机模式用；旧版的文案）和「自动要素链接」（默认开；旧版的文案），编辑器马上按新值排。翻页叠化里的 `element_at_opacity` **没用上**：F5 的 `PageTurn` 不把叠化进度交给画子元素的闭包，而单章、全书编辑器是自己调 `ProseEditor::element` 画的，外壳插不进不透明度，`repaint_turning` 留着（见「待协调」F4、F5）。
- **最近打开。** 前台的页面一换，外壳就调 F3 的 `recent.touch`（作品主页的「继续写」读它）；同一页不重复记，换书时清零。
- **⋯ 菜单人人有。** 稿纸右下角的 ⋯ 现在每种正文页都有（要素、构想、故事线、类目、素材也有），里面至少有「历史快照…」（M09）；章节的那份照旧多了写作状态和删除节点。
- **提交反馈。** 设置「关于」的「联系」下面加了「提交反馈」一行，账户菜单在「设置」上面也加了「提交反馈」，都派发 F7 的 `SendFeedback`（设置面板先关上）。
- **Esc 一层一层关**多了搜索面板这一层：通知 → 搜索 → 设置 → Super View。
- **查找栏加替换。** ⌥⌘F（Windows 是 Ctrl+H）打开带替换行的查找栏，查找栏上也多了一个切换替换行的按钮。替换框里按回车或点「替换」换掉当前这个、跳到下一个；「全部替换」把范围里的都换掉，是一步撤销（F4c 保证的）。查找栏开着替换行时宽 420，平时 372。
- **M10 的 13 句文案。** `dr-i18n` 加了新版自己的文案来源 `own/<语言>.json`：`sync-locales.py` 把它和从旧版拷来的合在一起，九种语言都要有，和旧版的键重名就报错（以后旧版删掉时，这里就是唯一的来源）。导入界面那 13 句按 m10 第 13 条的意思写了，短、直白，西语用 usted、德语用 du、法语用 vous、巴西葡语用 você，繁中用「資料庫」「匯入」，和旧版的口吻一致；有数字的几句按复数规则分单复数。`copy.rs` 里显示键名的占位删了。查找栏的替换框、两个按钮和「两端对齐」也走这里（一共 17 句）。
- **M04 的排序菜单和格子信息。** 章节面板头上（摘要右边、「全书」左边）加了排序按钮，菜单照旧版：
  - 全书看法：「排序章节」按阅读顺序（默认，只有这时显示幕）、按叙事顺序（没有叙事顺序的排最后）、按创建时间、按更新时间（新的在前）；
  - 按故事线看：「排序故事线内章节」按阅读 / 叙事顺序，「外层故事线」按故事线顺序 / 按字母，「多线章节」在每个所属分组显示 / 仅在主线分组显示；
  - 两种都有「单元格右侧」：显示日期（默认）、字数、字数和日期、都不显示。日期是这一章最后改动的那天，今年的写「11/08」，往年的写「25/11/08」；字数写「521」「1.2k」「12k」，和旧版一样。侧栏窄于 200 px 时不显示。
  - 选了什么按书存在本机布局里（`BookLayout.chapter_sort`，旧布局读出来是默认值）。同分时按 id 排，和旧版一样。

### 第四轮：接上各模块交回的事（大白话）

- **模块自己的键。** 书架对话框的 ⌘↵（Ctrl+↵）、搜索面板的 ↑↓ 改用 `keymap::add_bindings` 登记，改快捷键重建键位表时会一起装回；搜索面板自己读按键的那段删了。编辑器的键换成 F4c 的 `key_bindings(KeyScheme::native())`（Windows 有自己的一套：Ctrl、Home/End、F3）。
- **实时字数（M07）。** 编辑器每改一次，外壳把那篇文档的字数报给 `LiveWords`（只重数改了的段），选中文字时报选区的字数；标签关了，那篇的字数退回索引的数。全书视图里每章各报各的。
- **沉浸写作与画层（F4d）。** 沉浸时只有拿着键盘的那个编辑器让光标所在段以外的段落变淡；「减少动效」变了转给所有编辑器；主题变了，引文、分隔线的颜色（块样式）跟着换。
- **章内查找（F4c）。** ⌘F / Ctrl+F 在稿纸右上角（标签坞下面）出一条玻璃查找栏：输入框、「3 / 12」、上一个、下一个、关闭。打字就选中光标后面的第一个，Enter / ⌘G 下一个，⇧Enter / ⇧⌘G 上一个（Windows 是 F3 / ⇧F3），Esc 关掉、查询清掉、键盘还给稿纸。在全书里查全书。高亮全部命中由 F4d 画（它读 `find_matches`）；替换（⌥⌘F）第五轮做了。
- **账户菜单共用。** 书架那份搬进外壳（`dr_shell::account`）：头像、本地、主题三选一、界面语言、设置。书架的账号格子和工作区左栏底部新的账号格子打开的是同一个菜单，书架那边删了约 200 行重复的代码。
- **全书视图（M05）接进稿纸。** 「全书」标签现在是 `BookEditor`：每章就地编辑。外壳照单章的办法打开它（后台先把每章的会话开好，再在主线程建视图），⌘Z 经编辑菜单转到它，撤销的是光标所在那一章。大纲栏在全书页上多了幕和章两级（照旧版通览全书：幕 11 px、章 10.5 px），点幕或章调 `jump_to`。读全书时点到某一章的位置链接，就在全书里跳过去（`reveal_line`），不另开标签。阅读位置（段落的块 ID 加偏移）存进这本书的本机布局，关掉全书标签、退出时都存，再打开时 `restore`。通览全书那一页只读的旧实现删了。
- **审 M01 的接入点**（`pages.rs`、`workspace/mod.rs` 的书架部分、`stage.rs` 的 `home()`）：结构没问题，顺手改了两处：`book.rs` 里一段文档注释挂错了函数；换书时旧书各篇的实时字数要等下一本书读完才放掉，改成标签一关就放。另外记一条：`pages::home_of` 在画稿纸时写工作区的 `home` 字段（不在工作区自己渲染的时候，所以不会撞上），以后改成在工作区渲染前建好会更直白。

### M08 设置（第一批）

- **六节**：偏好下的外观、编辑器、语言、快捷键，控制下的「本地数据」，关于下的「关于 Drifting」。原来的「隐私」「更新」两节并了进去：故障诊断的开关在本地数据的「数据使用」下面，版本在关于里。
- **编辑器**：开头一块预览，用旧版的样例（一级标题加两段），按当前的字号、行距、段间距、段首缩进排；有设置改过时，标题右边出现「还原推荐样式」，一下把编辑器的设置都还原。
- **快捷键**：列表上面一行「所有动作 · 11」；「恢复全部默认」照旧。
- **本地数据**：开头「作品只保存在这台设备上。」和旧版那句说明；「数据使用」下面是「自动发送故障诊断」开关和「脱敏诊断摘要」（复制：版本、系统和架构、界面语言、有没有库和几本书、诊断开关；不含正文、id、路径，复制后那一行的说明换成「已复制」）；最后是旧版本地构建的那段说明。
- **关于 Drifting**：大字 Drifting 和「终极写作体验」；版本一行（版本 · 通道 Alpha · 引擎 GPUI + Loro + SQLite · 平台）；「致谢与许可」：开源依赖、源代码、客户端许可证、已知问题，按钮打开 GitHub 上的页面；「联系」：Alpha 支持、写信给团队（打开邮件）；最后一句标语。
- **搜索**：设置项照旧按名字、说明、选项、分组和附加搜索词找；这些不是设置的行（链接、诊断摘要、版本）按名字和说明找。什么都没找到时什么都不显示，和旧版一样。
- **没做的（旧版有）**：外观的强调色（要取色控件）、改动 reveal 动画（帮手模块）、导览重放（首次体验）；编辑器的字体来源、换行方式、Tab 缩进、光标颜色、人物链接高亮几项（多数要编辑器先支持；输入行位置、自动要素链接第五轮加了）；本地数据的备份与恢复、Markdown 文件夹、导出、回收站、导入（F2、M10 和各自的模块）；关于里的「字体」一行（旧版的说明对不上新版的字体）。「提交反馈」第五轮加了。没有放占位。主题的默认值旧版是浅色，新版注册表是跟随系统，没动。

### 第三个里程碑做了什么（大白话）

- **稿纸换成编辑器。** 章节、构想、要素、故事线、类目、素材的正文页都是 `dr-editor` 的 `ChapterEditor`。每个打开的标签有自己的编辑器，第一次显示那页时打开，标签关掉才放下：换到别的章再换回来，光标、滚动位置和撤销步数都还在；翻页叠化的 180 ms 里新旧两页也能同时画。打开分两半：先在后台线程让 F3 打开这篇文档的编辑会话（文档没开过时要从 SQLite 读，这是慢的那一半），再回主线程建编辑器视图（文档已经开好，不到 1 ms）。打开超过 240 ms，这一页的药丸流动。
- **打字经 F3 落盘。** 每打一个字都是 F3 编辑会话里的一次提交：先落盘、再进搜索索引和字数，再在 F3 的事件总线上通告（和命令的写入一样）。帮手或另一台设备改了这篇，编辑器自己把改动折进来。
- **标题在正文上面。** 编辑器自带的标题行显示这一页的标题（跟着正文滚动）；改了名（不管在哪改的），F3 的事件一到标题行就跟着变。
- **设置和主题马上生效。** 字号、行距、段间距、纸宽改了，所有打开的编辑器立刻重排；换浅色深色，字色、选区、光标跟着换。正文用 dr-ui 的正文字体（Serif），编辑器不铺自己的底色，底下就是稿纸（圆角也是稿纸的）。
- **键盘。** 打开一页时键盘交给那页的编辑器（侧栏的输入框、设置拿着键盘时不抢）；Settings 或 Super View 盖上时键盘从编辑器拿走（打字不会落进底下的稿纸），关上再还回去。编辑器自己的键（方向、删除、回车……）在 `ProseEditor` 上下文里绑；编辑菜单的 ⌘Z ⌘⇧Z ⌘X ⌘C ⌘V ⌘A 是不带上下文的键（菜单要显示它们），在 GPUI 里优先级最高，外壳在编辑器外面接住，再转给编辑器。格式键（⌘B ⌘1…）照旧在注册表里。
- **位置链接的行号**交给编辑器：光标放到那一段的开头，编辑器自己滚过去。
- **标签坞换成 F5 的 `TabDock`**：静止时一排记号（分屏的两个并排、打开的那页大一号、加载慢的外面一圈流动的玻璃），指上去每个记号原地长成药丸，离开等 260 ms 收回；拖动时其余药丸让位，拖离药丸行时原位收拢。悬停状态归组件自己管，外壳只给标签、锁、加号和点击、拖放做什么。
- **真窗口自检。** 开发构建加了 `DRIFTING_CHECK=editor`：真程序自己在真窗口里打字（经输入法用的那个入口）、按回车、⌘Z、⌘⇧Z、⌘[（经键位表），换章再回来，核对 F3 存下的段落、搜索和字数，然后走退出流程；`DRIFTING_CHECK=editor-verify` 重开后核对字还在，再删掉恢复原样。

### 第二个里程碑做了什么（大白话）

- **替身书删了，读真书。** 应用启动时在数据目录的 `library/` 里打开 F3 的工作区（在它自己的线程上开，和 AppKit 启动同时进行，约 2 ms），打开上次那本书。章节、要素、构想、素材库四个面板的列表，标签和稿纸上的名字、记号和颜色，都来自 F3 的查询；查询在后台线程跑，结果整份换进来。
- **稿纸显示真正文。** 当前页的正文用 F3 的 `prose.read` 读出（每段的纯文本和标题级别），只读地排在稿纸上：正文按编辑器设置的字号、行距、段间距、缩进；H1/H2/H3 按旧版 28 / 22 / 18 px 对 17 px 正文的比例，跟着字号设置一起缩放。只排屏幕上看得见的那些段（GPUI 的 `list`），通览全书一页 24 章也不卡。位置链接带的行号会让页面滚到那一段。
- **跟着 F3 的变化走。** 订阅了 F3 的事件总线：书目变了（改名、新建、挪动）就重读列表；某篇正文变了就重读那一页；东西进了废纸篓或被彻底删掉，不管是谁删的，`Navigator::forget` 关掉它的标签。退出时先跑 F3 的 `before_quit`（补齐索引、让文档收尾）。
- **位置链接经 F3 的目录找对象**（`BookCatalog`，三行适配），按名字或 id 都行。
- **换上 F5 的组件**：侧栏标签行是 `Segmented`（推进节奏、点已选中的也回调），cell 是 `SandCell`（选中时不出环，环是半色半玻璃），设置里的四个数值是 `Range` 滑块加 `NumberField` 数字框，图标按钮用 `.label()` 给读屏，标签坞收回用 `dwell::DOCK_COLLAPSE`，药丸是 `PillGroup`（有了水波和弹簧跟手的拖动副本，加载慢时药丸自己流动）。`panel_tabs.rs` 和自己画的拖动副本删了。
- **侧栏列表只排看得见的行**（`uniform_list`），几百章的书和十几章一样快。
- 冷启动在负载约 7 时重测：中位数 270 ms，在 300 ms 预算内。

### M03 章节页与稿纸工具栏（第一部分）

`modules.md` 的 M03 一部分做了，另一部分卡在编辑器没有给宿主留位置（见「待协调」F4、F5）。

- **稿纸右下角**（旧版的 `.editor-corner`）：一条玻璃托盘装着这一页的工具，右边单独一根一炷香。一直在，不跟着正文滚，站在稿纸旁边的桌面上（离栏的右边和底边各 16 px）。分屏时两页各有一个，一炷香只在右边那页。
  - **⋯（更多操作）**：章节的菜单。「写作状态」一节三行：草稿（提起的笔）、已完成（放下的笔）、已弃用（断笔），当前那个打勾；分隔线下是「删除节点」（危险色），把这一章放进废纸篓，标签经 F3 的事件自己关掉（和别人删的一样）。两样都经 F3 的命令（`chapter.update`、`chapter.trash`），作者身份、在后台线程跑，列表等 F3 的事件来了再变。菜单开在按钮上方、和按钮右边对齐（旧版的 top-end）。别的类型（要素、构想、素材……）的菜单跟各自的模块来，现在它们的角落只有一炷香。
  - **一炷香**：进入沉浸写作（⌘⇧↩，旧版的键）。M26 是沉浸写作本身；这里先做了最基本的：两侧栏、标签坞、侧栏开关、角落都收起来，只剩稿纸；Esc、再按一次 ⌘⇧↩，或者指到右下角时浮出来的那根一炷香，都能回来。「只有光标所在的段落不淡出」要 F4d 的画层，「开始打字就自动进入」是 M26 的设置，都没做。
- **还没做的**（都要编辑器在正文上面、下面给宿主留位置）：页眉（「第 N 章 · 故事线 · 字数」）、可改的标题（自动换行、回车进正文）、梗概、章末 ⁂（标为完成 / 改回草稿、新建下一章）、空章提示。标题现在显示在编辑器自己的标题行里（不能改）。

### M04 章节面板、幕与大纲栏（第一部分）

- **章节面板的两种看法。** 面板头上那行摘要（「4 条故事线 · 24 章」）就是开关，点一下在「按故事线」和「全书」之间切换（旧版也是点这行字；指上去字变深，读屏名字用旧版的两句提示）。没有故事线时只有全书。选哪种按书存在本机布局里。
- **全书看法里有幕。** 按阅读顺序列出所有章，每一幕从它的标题行开始（「第1幕 · 卷一 回乡」，旧版通览全书的「第{{n}}幕」加幕名，幕有颜色时标题带颜色），幕里的章缩进一级；第一幕之前的章不缩进。幕和章的归属是 F3 的 `act.list` 算的（按每一幕的起点切阅读顺序）。旧版的侧栏里没有幕，这是照 M04 的要求新加的。
- **拖动排序。** 章节格子可以拿起来（拿在手里的是 dr-ui 的药丸副本，弹簧跟手），放到另一章的格子上，它就挪到那里：从上往下放在那一章后面，从下往上放在前面（F3 的 `chapter.move`，作者身份、后台线程）；放到另一幕里的位置，它就进了那一幕。两种看法里都能拖，挪的都是全书的阅读顺序。旧版侧栏不能拖，章节排序在时间线上拖，这也是照 M04 新加的。
- **大纲栏**（旧版的 `EditorOutlineRail`）：稿纸左边的空白里，只有字，列出这一页的 H1、H2、H3（H1 9.5 px、H2 9 px、H3 8 px 等宽字，颜色一级比一级浅）。
  - 每个标题的位置是「它上面的内容占全文的比例」，不跟着滚动：整条是全页的缩略图。
  - 挤的时候互相让开 17 px，到底部再往回推。放不下时先只留顶层标题和正在读的那一支；还放不下，就以正在读的标题为中心开一个窗口，两头各折成一个「…」（读屏念「远处 N 个目录项」）。
  - 正在读的标题（视图顶上往下 80 px 那条线以上的最后一个）和它的上级用最深的墨、加粗；正文在屏幕上的那几节用次深的墨。
  - 点一个标题：光标放到它开头，它滚到视图顶上。
  - 角落托盘里的大纲按钮显示或隐藏它（按书存）；稿纸左边的空白窄于 196 px 时它自己不出来（两侧栏都开着时一般就没地方了）。
- **还没做的**：大纲栏「…」悬停展开的小菜单；滚动条上的批注和 Agent 改动刻度（要 F4d 的画层和审阅的数据）。排序菜单和格子右边的字数、日期第五轮做了。

最要紧的是三件「只留一份」：

- **「现在打开的是什么」只有一份。** 旧版存在 URL、标签树、选中状态三处，靠 322 行代码来回同步。新版只有一个导航模型：标签树加它自己的历史栈。稿纸上显示哪页、侧栏哪一格画砂笔框、前进后退去哪，都是从它读出来的。
- **快捷键只有一张表。** 所有按键都走 GPUI 的动作和键位表，没有一处直接听按键。默认键位照搬旧版，**没有 ⌘S**（提交即落盘）。旧版设置里列出的 11 个可以改键，改了立刻生效、存进设置文件。
- **设置只有一张表。** 每个设置声明一次：键、类型、默认值、范围（本机 / 账号 / 书）、分区、文案键、搜索词。设置面板、设置搜索、存储时的校验都从这张表生成。

## 怎么看

在 `next/` 里。字体是构建产物（见 [f5-ui.md](f5-ui.md)），缺了先跑 `python3 crates/dr-ui/script/build-fonts.py`。

开发期先给这个 checkout 的开发档案生成一个 showcase 库（F8 的种子：《慢钟》《阿Q正传》和六本书架用的书），再启动：

```bash
cargo drifting workspace scenario seed:showcase --library "$(cargo xtask dev --print-config | python3 -c 'import json,sys; print(json.load(sys.stdin)["dataDir"])')/library" --yes
```

```bash
cargo xtask dev
```

库在应用数据目录的 `library/` 里（正式版的数据目录就是 0.1 的，所以新库放在自己的子目录里，见「待协调」）。打开上次打开的那本书；第一次打开时取库里列出的第一本。`DRIFTING_BOOK=<书的 id 或书名>` 只在这次运行里指定打开哪本（比如 `DRIFTING_BOOK=慢钟`），书架做出来之前用它。`DRIFTING_APPEARANCE=dark` 只在这次运行里强制深色，不改设置也不改系统。没有库或库打不开时，窗口照样开，面板是空的。

真窗口自检（只在开发构建里有）：

```bash
DRIFTING_CHECK=editor cargo xtask dev
```

```bash
DRIFTING_CHECK=editor-verify cargo xtask dev
```

第一条在打开的书的第一章开头打「编辑器验收」、回车、「第二段」，⌘Z 撤到原样、⌘⇧Z 重做，打开第二章再 ⌘[ 回来，核对 F3 存下的段落、字数和搜索，然后走退出流程；第二条重开后核对字还在、删掉恢复原样、再退出。每一步在终端里打一行 `check: …`，最后是 `check passed` 或 `check failed: …`。窗口会出现在屏幕上一两秒，用完自己关。

截图和测量都在离屏模式下跑，不开窗口、不要录屏权限。内容是《慢钟》（dr-testkit 的样例，为 Drifting 写的原创小说），每次在临时目录里生成一个只有这本书的库，经 F3 读，和应用读的方式一样：

```bash
cargo run -p dr-shell --features capture --example shell-capture -- --capture <目录>
```

```bash
cargo run --release -p dr-shell --features capture --example shell-capture -- --bench <文件.json>
```

截图直接写成 256 色的 PNG（和 dr-ui 的 `shrink-pngs.py` 一样的效果，但不需要 Pillow，用的是 GPUI 图像栈里已经有的 `color_quant` 和 `png`），50 张共 11.0 MB，最大一张 445 KB。

打包：`script/bundle-mac` 现在会把字体拷进 `.app` 的 `Contents/Resources/fonts`（F5 要求的那一步），缺字体时停下并说明怎么生成。

## 截图

2 倍像素、1280×800、256 色，内容是《慢钟》。截图时时钟停住；「过渡进行中」是触发后 140 ms 的那一帧（右栏面板推进 265 ms、左栏抽屉 420 ms、稿纸翻页 180 ms 同时在走）。离屏截图里没有 macOS 的红绿灯（那是系统画的）。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 日常：左栏按故事线列章节（同一章在两条线下都出现，都画砂笔框，和旧版一样）、右栏素材库、锁住的标签坞（三个标签，沈知微是预览）、稿纸上是第一章的编辑器（标题行、人物链接的链接色和下划线；栏比纸窄时标题比正文往左偏一点，见「待协调」F4） | [workspace-light](f6/workspace-light.png) | [workspace-dark](f6/workspace-dark.png) |
| 两侧收起、标签坞静止成一排记号、稿纸左右分栏（第一章 / 通览全书） | [split-light](f6/split-light.png) | [split-dark](f6/split-dark.png) |
| 左栏够宽，自动分成两半（章节 / 要素按类目），稿纸是要素沈知微的正文 | [halves-light](f6/halves-light.png) | [halves-dark](f6/halves-dark.png) |
| 素材笔记「机械钟怎么走」在编辑器里：两个 H2 按编辑器字号排，粗体是正文里的标记 | [headings-light](f6/headings-light.png) | [headings-dark](f6/headings-dark.png) |
| 稿纸右下角：第一章的 ⋯ 菜单（写作状态，已完成打勾；删除节点），右边是一炷香 | [corner-menu-light](f6/corner-menu-light.png) | [corner-menu-dark](f6/corner-menu-dark.png) |
| 沉浸写作：只剩稿纸 | [immersive-light](f6/immersive-light.png) | [immersive-dark](f6/immersive-dark.png) |
| 章节面板的全书看法：三卷是三幕，各自的章缩进一级；角落托盘里多了大纲按钮 | [chapters-by-act-light](f6/chapters-by-act-light.png) | [chapters-by-act-dark](f6/chapters-by-act-dark.png) |
| 大纲栏：两侧收起，稿纸左边的空白里是素材笔记的两个 H2，正在读的那个加粗 | [outline-light](f6/outline-light.png) | [outline-dark](f6/outline-dark.png) |
| 查找栏：第一章里找「钟」，第 1 / 11 个被选中 | [find-light](f6/find-light.png) | [find-dark](f6/find-dark.png) |
| 查找栏的替换行（第五轮）：「钟」换成「铃」，替换 / 全部替换 | [find-replace-light](f6/find-replace-light.png) | [find-replace-dark](f6/find-replace-dark.png) |
| 章节面板的排序菜单（第五轮，按故事线看）：故事线内、外层故事线、多线章节、单元格右侧；格子右边是字数和日期 | [chapter-sort-light](f6/chapter-sort-light.png) | [chapter-sort-dark](f6/chapter-sort-dark.png) |
| 全书看法的排序菜单，按更新时间排（不显示幕） | [chapter-sort-book-light](f6/chapter-sort-book-light.png) | [chapter-sort-book-dark](f6/chapter-sort-book-dark.png) |
| 章节面板第一条故事线折起（第六轮）：每组右端是章数和箭头，面板头上的折扇画成打开的 | [chapter-fold-light](f6/chapter-fold-light.png) | [chapter-fold-dark](f6/chapter-fold-dark.png) |
| 指在「第二章」上的悬停卡（第六轮）：字数、故事线、梗概，下面是 ⋯ 菜单的那些行 | [chapter-card-light](f6/chapter-card-light.png) | [chapter-card-dark](f6/chapter-card-dark.png) |
| 要素页的 ⋯ 菜单（第六轮起最上面是「分享」，再是「历史快照…」） | [corner-menu-element-light](f6/corner-menu-element-light.png) | [corner-menu-element-dark](f6/corner-menu-element-dark.png) |
| 全书视图（M05）：一个编辑器装下 24 章；大纲栏列出三卷（幕）和各章 | [whole-book-light](f6/whole-book-light.png) | [whole-book-dark](f6/whole-book-dark.png) |
| 左栏底部的账号格子打开的账户菜单（和书架同一个；第五轮多了「提交反馈」） | [account-menu-light](f6/account-menu-light.png) | [account-menu-dark](f6/account-menu-dark.png) |
| 设置搜「本地数据」（第六轮起最上面是资料库备份、从备份恢复） | [settings-local-light](f6/settings-local-light.png) | [settings-local-dark](f6/settings-local-dark.png) |
| 设置搜「关于」（第五轮起「联系」下多了「提交反馈」） | [settings-about-light](f6/settings-about-light.png) | [settings-about-dark](f6/settings-about-dark.png) |
| 设置搜「输入」（第五轮）：打字机模式、输入行位置、自动要素链接 | [settings-input-light](f6/settings-input-light.png) | [settings-input-dark](f6/settings-input-dark.png) |
| Super View 舞台（要素全景，内容占位） | [super-view-light](f6/super-view-light.png) | [super-view-dark](f6/super-view-dark.png) |
| 设置（从注册表生成：外观、编辑器……；数值是滑块加数字框） | [settings-light](f6/settings-light.png) | [settings-dark](f6/settings-dark.png) |
| 设置搜索「字号」 | [settings-search-light](f6/settings-search-light.png) | [settings-search-dark](f6/settings-search-dark.png) |
| 通知中心（崩溃跟进、Markdown 文件夹的复数文案、更新） | [notifications-light](f6/notifications-light.png) | [notifications-dark](f6/notifications-dark.png) |
| 过渡进行中 | [motion-midway-light](f6/motion-midway-light.png) | [motion-midway-dark](f6/motion-midway-dark.png) |

底部面板（第八轮）是真窗口里拍的：带调试桥的开发版跑场景 `crates/dr-cli/scenarios/bottom-panel.json`（临时 profile、showcase 生成的《慢钟》），应用自己画出的窗口截图，缩到 1440×900，只有浅色。

| 画面 | 截图 |
| --- | --- |
| 第二章在前，稿纸下面是时间线（180 高，四条故事线泳道、卷一的幕轨），角上竹子、工具托盘、一炷香浮在面板上方 | [bottom-timeline](f6/bottom-timeline.png) |
| 托盘第一个按钮打开这一章的情节规划（空的 3 × 3），时间线让位 | [bottom-planner](f6/bottom-planner.png) |
| ⌘J 两次：时间线回来、再收起，稿纸回到整栏高 | [bottom-closed](f6/bottom-closed.png) |

## 做了什么

### 1. dr-i18n：文案

- **来源**：旧版 `src/renderer/locales/*.json`（九种语言）和 `locales/windows/*.json`（Windows 覆盖层）。外壳只搬真正用到的键：清单在 `crates/dr-i18n/keys.txt`（一行一个，`前缀.*` 取整棵子树，复数键不写后缀），`script/sync-locales.py` 按清单从旧版拷出子集到 `crates/dr-i18n/locales/`。现在 370 条清单，加上新版自己的 17 句（`own/`），简体中文 415 个字符串（英文多些，复数分两形）。**阶段 7 删旧代码时，这份拷贝就成为来源**，脚本删掉；在那之前，`tests/source.rs` 逐条比对拷贝和旧版，旧版改了文案测试就报「重跑脚本」。
- **编译期检查**：`build.rs` 把每个键生成一个常量，`leftSidebar.tabs.chapters` 是 `keys::left_sidebar::tabs::CHAPTERS`，引用不存在的键编不过。构建时还检查：九种语言键齐全、每条译文的 `{{占位}}` 和英文一致（复数各形只许用英文 `_other` 有的占位）、Windows 覆盖层只覆盖已有的普通键、两个键不会生成同一个名字。这就是 [simplifications.md 第六节第 8 条](../simplifications.md#六要在新工作区重建的规则)要的「文案完整」。
- **反方向的孤儿检查**：`dr-shell` 的 `tests/strings.rs` 检查清单里的每个键都被外壳的代码引用了，没人用的会报出来、要从 `keys.txt` 删掉。旧版积了约 220 个孤儿键，这里不再积。
- **复数**：i18next 的写法，`键_one`、`键_other` 等后缀按语言的 CLDR 规则选（`icu_plurals` 2.4，和 `icu_segmenter` 同一条版本线，数据编进程序）；缺哪一形就退回 `_other`。法语 0 算单数、日语只有 other，测试守着。旧数据里有 `settings.editor.indent` 旁边放着 `indent_one`（「一字符」）、`indent_two` 这种，看着像复数其实不是：词干本身也是键时，带后缀的一律当普通键。
- **插值**：`{{名字}}`，括号里可以有空格；没给的参数原样留着，不会悄悄消失。
- **Windows 覆盖层**：`I18n::new(语言, Platform::Windows)` 先查覆盖层（「Apple Silicon · macOS 13+」→「Windows 10/11 · x64 与 ARM64」这类），再查基础文案。平台是参数，所以 Mac 上就能测 Windows 的措辞。
- **语言匹配**照旧版 `matchUiLocale`：繁中按 Hant / TW / HK / MO 认，所有葡萄牙语都给巴西葡语，其余按主标签，认不出来的给英语。没存语言设置时跟系统首选语言（`sys-locale`）。
- `dr-i18n` 不依赖 GPUI；外壳里一个全局 `Strings` 包着它，换语言时整窗重画。

### 2. 窗口与导航

- **窗口**：沿用 P0-A 的做法——内容铺到窗口顶上、红绿灯在 (18, 14)、最小 1000×700、默认 1440×900、应用自己管标题栏拖动（按下后移动就 `start_window_move`，双击按系统设置缩放）。能拖窗口的是：两侧的标签行、稿纸顶上标签坞下面那条透明的带子、Super View 和设置的顶栏。Windows 上这些带子标成系统的拖动区，左上角是关闭 / 最小化 / 最大化三颗按钮的玻璃药丸（`windowCaption.*` 做读屏标签）。
- **导航模型**（`nav::Navigator`，纯 Rust，无 GPUI）：
  - 目标 `Target`：章、构想、故事线、要素、分类、素材、全书（全书每本书只有一个）。没有标签是激活的，就是作品主页。
  - 规则照旧版 `ui-store.ts`：已经开着的直接激活（分栏的哪一侧也算）；单击开**预览**，预览原地替换上一个预览；双击（或双击药丸）留下；激活的是分栏、而且聚焦那侧是预览时，新的预览替换那一侧；分栏不嵌套；全书总在顶层开；关掉当前标签就激活右边的，没有右边的就最后一个，都没了回主页。
  - **历史栈**只记「页」（主页或某个目标），连续相同的不重记，最多 100 条。后退去的页已经被关掉时，按预览重新打开。从中间往别处走，前面的就丢掉。
  - 选中状态**只读不存**：`is_selected(目标)` 就是「它是不是当前聚焦的那页」。分栏没聚焦的那一侧不算。
  - 删了某个对象用 `forget`：关掉它的标签、从历史里去掉。F3 的删除事件（`WsEvent::Removed`，不管谁删的、包括另一台设备同步来的）到了主线程就调它；书目读进来时，恢复出来的标签里已经不存在的也这样关掉。
  - 存盘时只存标签树和激活的是哪个；恢复时去掉已经不存在的目标，历史从恢复后的那一页重新开始。
- **位置链接**（`nav::location`，照旧版 `location-link.ts`）：认三种写法——文档里的 `drifting:chapters/雨夜/prose.md#L12-L18`、系统转来的 `<协议>://open/<书>/chapters/id-<id>/prose.md#L3`、相对投影目录的 `../../chapters/id-x/prose.md#L5-7`。文档里永远是 `drifting:`；系统那种用本构建注册的协议（开发版 `drifting-next-dev`），所以链接只会落到注册它的那一个程序。解析是纯函数，找对象经一个 `Catalog` trait（F3 的 `BookCatalog` 实现它，`book.rs` 里三行适配）；名字重复、找不到、别的书，各报各的原因。行号原样交给编辑器（`take_reveal`，用一次就没），换算成块是编辑器的事（第 N 块从第 2N+1 行开始）。
- **系统深链接**：F7 的 `DeepLinks` 在哪个线程收到链接就在哪个线程叫醒我们；`set_waker` 往一个通道里发信号，主线程上的任务收到后把窗口叫到前面、取出 `open/` 开头的链接、逐个打开。窗口开之前就排队的链接，开窗时一并处理。`auth/` 留给登录。

### 3. 布局

- **三栏从窗口顶边贯通到底边**，没有横贯的栏。左右栏、稿纸四周是同一张桌面色；稿纸是唯一抬起的一块（稿纸色、2 px 圆角、稿纸投影）。
- **侧栏像抽屉**：两个侧栏开关固定在窗口两个上角（28 px 圆形玻璃、新月砂笔图标，开着是实心的月牙、收着是空心的；收着时浮在桌面上、垫不透明底色和静止细线），侧栏从它下面滑出、收回，走「结构性开合」420 ms。新布局两侧默认收起，只突出稿纸。
- **宽度**：拖内侧边缘改宽（6 px 宽的把手）；最窄是一行标签的宽度（标签文字现量 + 各 10 px 内边距 + 两端各 6 px，靠窗口边的那一半再加上开关和它的空位）；最宽是窗口的 60%，并且给稿纸留至少 420 px。
- **一半与两半**（`panes`，照旧版 `sidebar-tabs.ts`）：宽到放得下两行标签加一根发丝线，就自动分成两半，右半打开顺序里的下一个标签；点某一半里已选中的标签关掉这一半，只剩一半时再点就收起整个侧栏；宽的时候手动收回一半会被记住（`keep_single`），之后变窄再变宽也不自动分，直到作者按「恢复双栏」；重新分出来的一半从上次关掉的那一边进来。
- **标签**：左栏 章节 / 要素 / 构想，右栏 审阅 / 素材库 / 统计 / 帮手（文案跟界面语言走）。标签行是 dr-ui 的 `Segmented`（结构字体、`label` 字号）：标签字下面的玻璃方块和面板一起走「重冰推进」265 ms、同一刻落地；点已选中的那个也回调（关掉这一半）。面板本身用 dr-ui 的 `Push` 被整块推开。
- **面板**（第二个里程碑起是真数据，来自 F3）：
  - 章节：有故事线时按故事线分组（旧版的「故事线视图」），一章在几条线上就在几条线下出现；不属于任何线的章节放在最后的「未归属」下。还没有故事线时按阅读顺序平铺。读数是「4 条故事线 · 24 章」，没有故事线时是「24 章」。
  - 要素：按类目分组，类目本身可以点开；没有类目的要素放在「未分类」下。
  - 构想：按构想分组（可以嵌套），组名是不可点的标题，不在组里的构想放在最后。构想的记号用所在组的颜色。
  - 素材库：先是素材夹（可以嵌套，不可点），每个下面是它的素材，然后是不在任何素材夹里的素材。
  - 每一行是 dr-ui 的 `SandCell`：砂笔记号 + 名字，指着时一圈半色半玻璃的发丝环，选中时画砂笔框、不出环；单击开预览、双击留下。章节的记号按 id 选六个印章之一（照旧版 `sealOf` 的算法），颜色是主故事线的颜色；要素是类目的颜色。颜色就是作者存的十六进制色。
  - 列表只排看得见的行（GPUI 的 `uniform_list`）。
  - 面板头：读数和全书视图的入口（章节旁是通览全书，要素旁是要素全景，审阅和素材库旁是审阅与素材），入口按钮有读屏名字。统计面板头的读数直接从导航模型读出当前是什么（「本章 · 详细统计」）。审阅、统计、帮手的内容等各自的模块。
- **左栏底部**是账户一格：名字（现在是「本地」）、作品主页（鸟居）、通知中心（风铃）。
- **稿纸**：显示当前页的正文（只读），经 F3 的 `prose.read` 读出：章节、构想、要素、故事线、类目、素材笔记各有自己的正文文档；通览全书依次读每一章，章名做小标题。排版用编辑器设置：正文字号、行距、段间距、段首缩进（只缩正文段，标题不缩）、纸张宽度；H1/H2/H3 是旧版 `.ProseMirror h1/h2/h3` 的 28 / 22 / 18 px 对 17 px 正文的比例，随字号缩放（默认字号下正好是旧版的大小），段间距照旧版对标题和正文一样。只排屏幕上的段（GPUI 的 `list`），改了编辑器设置就重新量。换页时原地叠化（dr-ui 的 `PageTurn`，180 ms）。还没读到的页先空着；读了超过 240 ms（`dwell::LOADING_DELAY`），它的药丸开始流动。

### 4. 标签坞与 Super View 舞台

- **标签坞**在稿纸顶边居中、和红绿灯同一中线。静止时是一排砂笔记号（类型变化处留宽一点的间隔，预览的记号是空心的，分栏是两个相连的记号）；指针移上去（或按了锁）就是一排玻璃药丸：记号 + 名字，当前那颗是静止的选中玻璃，预览的名字是斜体（中文斜体 GPUI 画成正体，见 F4 的 G5）。左端是锁，右端是 `+`（回作品主页，主页露着时 `+` 是选中的）。指针离开 260 ms 后收回成记号。
- 药丸是 dr-ui 的 `PillGroup`：单击激活（换药丸时有水波），双击留下预览，中键关掉，悬停时末尾出现一个 ×（读屏名「关闭标签页」）；分栏药丸的两半各自可点、各自有 ×，关掉一半另一半成为整个标签。锁和 `+` 有读屏名（「保持展开 / 收回小点」「新建实体」）。
- **拖动**：拖起的是 dr-ui 的 `DraggedPill`：一份静止的副本按弹簧跟手、不加投影。放到另一颗药丸上就占它的位置；拖着的时候稿纸分成左右两半，放到哪半就和当前页分栏、拖来的那页在那一侧。
- 指针离开后等 `dwell::DOCK_COLLAPSE`（260 ms）收回成记号。
- **Super View 舞台**：盖住整个窗口的一层，四边贴齐，下面的工作区点不到；顶栏有「返回」和三选一的切换器（故事图谱 / 要素全景 / 审阅与素材），之间切换时下面整块左右推开（方向按切换器里的左右），打开和关闭不推。内容占位，等 M21–M23。`⌘⌥3 / 4 / 5` 开关对应的视图，再按一次关掉；`⌘[` 先关 Super View 再后退，和旧版一样。
- **Esc 逐层退出**：最上面是浮着的东西（通知中心），然后是设置，然后是 Super View。设置的搜索框有焦点时，Esc 先清空搜索、再按一次关设置。Super View 或设置盖着时，`⌘W`、`⌘⌥←/→` 这些动标签的键不生效（旧版用 `inert` 做到的）。

### 5. 快捷键

- 一张注册表（`keymap::REGISTRY`），每条：存储 id、GPUI 动作名、默认按键（`secondary-` 在 macOS 是 ⌘、别处是 Ctrl）、生效的上下文、在设置里的文案。`keymap::apply` 清空键位表、按注册表和改键重新绑一遍，再重建菜单栏，所以改键立即生效、菜单上的快捷键也跟着变。
- **旧版设置里列出的 11 个可以改键**，默认值照搬：关闭当前标签 ⌘W、当前编辑器内查找 ⌘F、全局搜索 ⇧⌘F、后退 ⌘[、前进 ⌘]、上一个 / 下一个标签 ⌘⌥← / ⌘⌥→（另有旧版不列出的 ⇧⌘[ / ⇧⌘]）、底部时间轴 ⌘J、沉浸写作 ⌘⇧↩、新建 ⌘N、关闭项目 ⇧⌘W。**⌘S 不搬**：旧版的「保存当前编辑器」没有了。
- 旧版写死的 ⌘⌥1–5（作品主页、通览全书、三个 Super View）、Esc、⌘,，以及系统惯例（⌘Q、⌘H、⌥⌘H、⌘M、编辑菜单六项、Windows 上 Ctrl+Y 重做）也在表里，不可改。
- **编辑器的动作名不变**：`prose_editor::ToggleBold` 等 8 个格式键按名字绑在 `ProseEditor` 上下文里；只有编辑器链接进程序时（动作已注册）才绑，没链接就跳过。移动、删除这类键位仍由 `gpui-prose` 自己绑，它们是平台惯例，不进设置。
- **改键**：设置 → 快捷键，点某一行的键，按新的组合（Esc 取消）。录制时用 GPUI 的按键拦截器截下这一下，不让它触发任何动作。不带 ⌘ / Ctrl / ⌥ 的普通键（会打出字的）和单独的修饰键不收。和别的快捷键冲突时显示旧版那句「{键} 已被「{动作}」占用」、不改。存的时候把 ⌘（Mac）或 Ctrl（Windows）写成 `secondary-`，所以随账号同步到另一个系统也对。单条「恢复」和「恢复全部默认」都有。
- 显示格式照旧版 `formatAccelerator`：Mac 上 `⌘⇧F`，Windows 上 `Ctrl+Shift+F`。
- **GPUI 的一个坑**：不带上下文的键位在 GPUI 里优先级最高（它的深度算成整条上下文链的长度）。所以 `⌘W` 关窗口要写成只在「不在工作区里」时生效（`!Workspace`），否则它会抢在「关闭当前标签」前面。见「待协调」。

### 6. 设置

- **注册表**（`settings::registry::REGISTRY`）：现在 11 项真实设置。外观：主题（跟随系统 / 浅色 / 深色，账号）、界面字号（五档，本机）；语言：界面语言（九种，账号，默认跟系统）；编辑器：字号、行距、段间距、纸张宽度、段首缩进、打字时自动沉浸、打字机模式（账号，默认值照旧版 `EDITOR_STYLE_DEFAULTS`）；隐私：自动发送故障诊断（本机，默认开，照旧版）。「更新」一节只显示当前版本和平台（这一行的平台说明有 Windows 覆盖层）。快捷键一节从快捷键注册表生成。
- **控件按类型生成**，照 F5 定的约定：开关 → `Switch`；不超过 4 个选项 → `Segmented`；更多或语言 → `Select`；有范围的数值 → `Range` 滑块加 `NumberField` 数字框（同一个值、同一个回调；`step` 给滑块的刻度，小数位按刻度推：0.02、0.05 两位，1、10 整数；`unit` 显示在数字框末尾；两者都以设置名作读屏名）。
- **生效**：主题同时给 dr-ui（`force_appearance`）和系统那一侧（macOS 设本应用的 `NSAppearance`，红绿灯、菜单、关于窗口一起变）；界面字号给 dr-ui；语言换掉全局文案；故障诊断开关调 F7 的 `set_consent`（关掉立刻生效，打开下次启动生效，F7 的规则）。启动时 `main` 先读设置文件里的同意状态，再交给 `crash::init`。
- **存储**：`<应用数据目录>/settings.json`，分 `device`、`account`、`books.<书 id>` 三块。读的时候按注册表校验，类型不对或越界的按默认值读、但不删（可能是更新的版本写的），注册表不认识的键原样保留。写的时候先写旁边一个临时文件、刷盘、再改名替换，崩溃只会留下旧的或新的。读不了的文件挪到一边（`settings.json.unreadable-<时间>`），绝不覆盖。改设置后 300 ms 写盘。
- **按书的本机布局**（[loro-schema.md「不进书目文档的」](../loro-schema.md#不进书目文档的本机布局)）也存在这里：`books.<书 id>.layout` 里是标签树、两侧栏的开合 / 宽度 / 两半、标签坞的锁。布局改动 500 ms 后写进设置，退出前再写一次。
- **设置面板**：和 Super View 一样盖住整个窗口。左边是搜索框和「偏好 / 控制」两组分区，右边所有分区在一个滚动里；点左边直接跳到那一节，滚动时左边的当前项跟着走（静止的选中环）。右上角关闭，Esc 也关。
- **设置搜索**：在当前界面语言里匹配分区名、组名、每项的名字、说明、选项名和注册表里的搜索词（中英都有，比如「dark mode」「深色」），忽略大小写、合并空白；分区名命中就整节显示。
- **旧版的死设置不搬**：⌘S、已退役功能的选项、手机端的轨道之类，注册表里没有。

### 7. 通知中心

- 一个列表，来源：同步、读者评论、整理（Agent）、Markdown 文件夹、更新、崩溃跟进，名字都用旧版的 `notifications.*.source`。新的在上面，最多 50 条；每条有来源、相对时间（刚刚 / 3 分钟前 / 2 小时前，旧版的写法）、正文和 ×；顶上有「清空」。
- 从左栏底部的风铃往上弹出（下面放不下就翻到上面），是菜单那种 16 px 圆角、桌面色、静止细玻璃边、浮起投影的面；点外面收起。
- **崩溃跟进**接好了：窗口开了 2 秒以后调一次 F7 的 `take_follow_up()`，有就发一条「上次出了故障」（来源「Drifting」），带上崩溃 id，留给 M39 的反馈对话框。其余来源等各自模块调 `Notifications::post`。

### 8. 退出流程

- `⌘Q` 和菜单的「退出」走 `quit::request`：等当前这次派发结束（派发时窗口被借出去了），依次跑 `before_quit` 登记的钩子（现在登记了 F3 的 `Workspace::before_quit`：补齐打开文档的搜索索引、让每篇文档收尾；以后还有同步的最后一推），把每个打开的工作区的布局写进设置，写设置文件，最后 `cx.quit()`。
- GPUI 的退出回调（总共只等 200 ms）里**只**调 `CrashReporting::flush(100 ms)`。
- 系统发起的退出（注销、在程序坞里退出）不经过第一步。正文本来就是提交即落盘；设置在改动后 300 ms、布局 500 ms 写盘，所以最多丢这么一小段布局改动。

### 9. 只用 dr-ui

- `Application::with_assets(dr_ui::Assets::new())`，启动调 `dr_ui::init`；缺字体时把它的说明打到终端和日志、退出，不带着系统字体继续。
- 外壳里没有自己的颜色、字号、时长：全是 dr-ui 的令牌、组件和过渡；画平色的地方（桌面、稿纸、设置的两栏、通知面）都用 `glass::surface` 声明了底色。
- 第一个里程碑外壳自己拼的几样，第二个里程碑都换成了 F5 收进 dr-ui 的组件（`Segmented` 的推进模式、`SandCell`、`Range` + `NumberField`、按钮的 `.label()`、`dwell::DOCK_COLLAPSE`、能拖的 `PillGroup`），外壳里不再有手拼的玻璃控件。
- 开发包带上了字体（`bundle-mac`）。

### 10. 测试与测量

见下两节。

## 接口

给以后的模块和 F3 / F8：

```rust
// app/drifting/src/main.rs 里的顺序（F7 那几步在前面，没动）
let settings = SettingsFile::open(&dirs.data);                  // 先读：故障诊断的同意要交给 crash::init
let library = thread::spawn(|| dr_workspace::Workspace::open_dir(dirs.data.join("library"), version));
let app = application().with_assets(dr_ui::Assets::new());
app.run(|cx| {
    dr_ui::init(cx)?;                                           // 字体、主题设置、输入框键位
    dr_shell::init(ShellInfo { app_name, bundle_id, version, url_scheme, forced_appearance },
                   Services { deep_links, crash_reports,
                              library: library.join().ok(),     // F3 的工作区；没有也能开窗
                              book: env DRIFTING_BOOK },        // 开发期指定打开哪本
                   settings, cx);                               // 有库时登记 quit::before_quit → Workspace::before_quit
    dr_shell::open_workspace(cx, probe::window_opened)?;
});
```

| 模块 | 给谁用 | 主要接口 |
| --- | --- | --- |
| `nav` | 所有要「打开某个东西」的模块 | `Target`、`Navigator::{open(target, Open::PREVIEW / KEEP), open_at(target, lines), promote, activate, cycle, close, close_side, reorder, split_with, focus_side, go_home, back, forward, forget, current, is_selected, page, take_reveal}`、`Navigator::restored` |
| `nav::location` | 帮手回复、正文里的链接、深链接 | `parse(href, scheme) -> Option<LocationLink>`、`resolve(&link, &dyn Catalog) -> Result<(Target, Option<Lines>), LinkError>`、`line_to_block`、`trait Catalog`（F3 实现） |
| `book` | 各面板、稿纸 | `Book::{load(lib, id), load_any(lib, preferred), title, exists, mark, chapters_of, unaffiliated, chapter_titles}`（F3 列表的一份快照）、`PageText::load(lib, target, chapters)`（一页的段落：纯文本 + 标题级别）、`doc_of(target)`、`target(NavTarget)`、`color_of`、`seal_of`；`impl Catalog for BookCatalog` |
| `workspace` | 各面板、F8 的调试桥 | `Workspace::{open, open_link, toggle_left, toggle_right, toggle_super_view, open_settings, open_find, close_find, set_immersive, move_chapter, dismiss, top_layer, layout, on_library_events, editor_of(target), book_editor(), page_view(target), run_command(name, input, cx)}`、字段 `library`、`book_id`、`book`、`editors`（每个打开标签的 `PageEditor { doc, view: Option<PageView>, loading, failed }`；`PageView::{Doc(ChapterEditor), Book(BookEditor)}`）、`find`、`immersive`、`account_open`、`with_workspace(cx, f)`、`title_of(book, target, cx)`、`BookLayout`（含 `book_position`）、`EditorLook` |
| `workspace::editors` | 以后要在稿纸上加东西的模块（批注栏、沉浸写作） | `editor_settings(cx)`、`base_style(&theme)`、`block_style(&theme)`、`forward_edit_actions(el)`、`PageView::{prose, view}`、`SavedPosition`、`PAGE_GUTTER`、`TITLE_SIZE`；`pub use dr_editor::{BookEditor, ChapterEditor, …}` |
| `workspace::{find, outline, corner}` | 查找栏、大纲栏、稿纸角落 | `find::{FindBar, key_bindings}`（`FindBar::{set_query, step, status, set_replacing, set_replacement, replacement, replace_current, replace_all}`、字段 `replacing`）；`Workspace::{open_find, open_replace, close_find}`；`outline::{read(&PageView, cx), plan, jump_to}`；`corner::corner` |
| `workspace::chapter_sort` | 章节面板 | `ChapterSort { book, inner, outer, primary_only, meta }`（`BookSort`、`InnerSort`、`OuterSort`、`CellMeta`）、`sort_book`、`sort_inner`、`readout`、`compact_words`、`short_date`；字段 `Workspace::chapter_sort`、`BookLayout::chapter_sort` |
| `dialogs` | 要开模态对话框的模块（F7 反馈、M10 导入……） | `dialogs::show(cx, AnyView)`、`dialogs::show_in(window, cx, AnyView)`、`dialogs::hide(cx, EntityId)`（在哪里调都行，对话框自己的按钮里也行）；`Workspace::modal()`（对话框或快照历史开着，工作区快捷键停）；`workspace::{with_workspace, with_workspace_in, update_workspace, active_workspace}` |
| `pages`（底部面板） | 时间线（M14）、情节规划（M15） | `add_bottom_panel(cx, BottomPane::{Timeline, Planner}, \|&BottomHost, &mut Window, &mut App\| Option<BottomPanel>)`；`BottomHost { workspace, library, book_id, book, target }`；`BottomPanel::new(view).min_height(\|cx\| f32).on_refresh(\|host, cx\| …)`；`has_bottom_panel(pane, cx)`；`Workspace::{bottom_pane(cx), toggle_timeline, toggle_planner, bottom_height, set_bottom_height, bottom_view(pane)}`；`workspace::{BottomLayout, BottomResize}` |
| `workspace`（按书记住） | 想在本机按书记点什么的模块（时间线） | `Workspace::book_memory(key) -> Option<&Value>`、`book_memory_ready()`、`set_book_memory(key, Value, cx)`（F2 的 `local_state`，范围 `workspace::BOOK_MEMORY_SCOPE` = `shell`，键 `memory:<书>:<key>`，挂在书下） |
| `settings`（本机值） | 要在这台设备上记点什么、又不是设置的模块（书架画风、导览看过、Markdown 文件夹） | `SettingsFile::{device_memory, set_device_memory}`；`Settings::{device_memory(cx, key), set_device_memory(cx, key, Option<Value>)}`（设置文件 `device.modules`） |
| `pages`（全窗视图、帮手） | M21、M22、M23、M31 | `add_super_view(cx, SuperView, \|&SuperViewHost, &mut Window, &mut App\| SuperViewPage)`、`SuperViewPage { body, head_start, head_end }`；`set_companion(cx, \|WeakEntity<Workspace>, &mut Window, &mut App\| LeftPanel)`；`set_library(cx, \|WeakEntity<Workspace>, &mut Window, &mut App\| LeftPanel)`（M19 的素材库）；`Workspace::super_view_content(view)` |
| `pages`（M24） | dr-view-sea | `set_backdrop(cx, Backdrop { draw, hold, ebbing, on_sea })`、`SeaHold::{Surface, Loading}`；`set_first_run(cx, \|done, window, cx\| FirstRunPage { view, shows_shelf })`；`set_guide(cx, Guide { anchor, start, layer, reset })`；`anchor(id, el, cx)`、`anchors::*`；`Workspace::{ebbing, sea}`、`SeaState::{waiting, first_run_shows}`、`workspace::FIRST_RUN_DONE` |
| `mirror` | M40、首次运行 | `folder(cx)`、`is_on(cx)`、`is_running(cx)`、`set_folder(path, cx)`、`set_on(bool, cx)`、`restart(cx)`、`stop(cx)`、`ask_turn_off(cx)`、`ask_turn_off_then(cx, after)`；`notifications::Notifications::post_opening(source, text, Some((book, doc)), cx)` |
| `workspace`（悬停卡） | 自己画东西、要同一张页面卡的模块（M14 的片段和泳道名） | `page_hover_card(id, el, &target, &ws, CardRows { lead, before_danger }, cx)`；`PageMenuHost::of(&ws, cx)` |
| `pages`（⋯ 菜单） | 要在页面 ⋯ 菜单里加行的模块（M11） | `add_page_menu(cx, \|target, &PageMenuHost, &App\| Vec<PageMenuSection>)`；`PageMenuItem { id, icon: RowIcon, label, checked, danger, run: RunRow }`、`PageMenuHost { workspace, library, book_id, book }` |
| `pages`（整页） | 自己画一整页、不用正文编辑器的模块（M19 的图片和 PDF 素材） | `add_page_view(cx, \|&Target, PageViewHost, &mut Window, &mut App\| Option<ModulePage>)`；`ModulePage { view, focus }`、`PageViewHost { workspace, library, book_id, book }`；`Workspace::module_page(&Target)`。开编辑器前先问，答了的页存成 `PageEditor::module`，铺在桌面上、全宽、不画稿纸；在前面时 `focus` 拿键盘，和编辑器一样；关标签照旧放掉（[m19-materials.md](../modules/m19-materials.md)） |
| `pages`（左栏） | 自己画左栏某个标签的模块（M11 的要素面板） | `add_left_panel(cx, \|LeftTab, WeakEntity<Workspace>, &mut Window, &mut App\| Option<LeftPanel>)`；`LeftPanel { head: AnyView, body: AnyView }` |
| `workspace`（提示、侧栏状态） | 要提示一句的地方；测试 | `Workspace::toast(文字, cx)`；`folded_in(pane)`、`toggle_fold(pane, group, cx)`、`fold_all(pane, cx)`、`list_scroll(list)` |
| `workspace::page_actions` | ⋯ 菜单、悬停卡 | `page_actions(&ws, &host, &target, cx) -> Vec<PageMenuSection>`（分享与导出、写作状态、模块的行、历史快照、最后是删除一类） |
| `nav::Open` | 打开页面的人（dr-view-page 的 ⁂） | `Open::PREVIEW`、`Open::KEEP`、`Open::KEEP.at_title()`（这一页的编辑器打开时不拿键盘，交给章首的标题） |
| `actions` | dr-text 的备份、恢复对话框 | `BackupLibrary`、`RestoreLibrary`（`workspace::` 命名空间；设置「本地数据」的两个按钮派发） |
| `library` | dr-view-transfer（恢复备份） | `replace(cx, job: FnOnce(&Path, LibraryOptions) -> Result<dr_store::Library, String> + Send, done: FnOnce(Result<(), String>, &mut App))`（库关不掉时不跑 `job`，原来的工作区接着用，`done` 听到原因） |
| `settings::panel` | 设置「本地数据」 | `pre_restore_folder(cx) -> Option<PathBuf>`（恢复前副本的文件夹，没有就建） |
| `account` | 书架、工作区左栏 | `account::menu(id, anchor, close, window, cx)`、`account::avatar(size, window, cx)` |
| `keymap` | 想加快捷键的模块 | 在 `REGISTRY` 加一行（动作名、默认键、上下文、要不要列进设置）；模块自己上下文里的键（对话框的 ⌘↵、列表的 ↑↓，不是作者能改的快捷键）用 `add_bindings(cx, \|\| vec![KeyBinding::new(…)])`，`apply` 重建键位表时会一起重新绑上；`apply(&overrides, cx)`、`display(keys, os)`、`portable(keystroke, os)`、`conflict(...)` |
| `settings` | 想加设置的模块、M37 偏好同步、M10 导入映射 | 在 `registry::REGISTRY` 加一项；`Settings::{read(cx), update(cx, \|file\| …), flush(cx), locale(cx)}`；`SettingsFile::{get, bool, str, number, set, reset, is_changed, key_bindings, set_key_binding, layout, set_layout, last_book, set_last_book, save}` |
| `notifications` | 同步、分享、整理、Markdown 文件夹、更新 | `Notifications::post(Source::…, 文字, cx)`、`post_at`、`remove`、`clear`、`items`、`unread` |
| `quit` | F2 / F3 / 同步 / 更新 | `quit::before_quit(cx, \|cx\| …)`：退出前要做完的事登记在这里；`quit::request(cx)`；`quit::hide_first(cx)`（应用开：先藏起来再跑钩子） |
| `strings` | 所有界面 | `t(cx, key)`、`tf(cx, key, &[("count", &3)])`、`tp(cx, plural_key, n, &[])`；旧版没有的句子写进 `crates/dr-i18n/own/<语言>.json`（九种语言齐全、不和旧版重名、复数键带 `_one` / `_other`，中日韩写不带后缀的一个），再跑 `sync-locales.py` |
| `dr_i18n` | 不在 GPUI 里的地方（导出、命令行） | `I18n::new(Locale, Platform)`、`.t / .fmt / .plural / .contains`、`Locale::{ALL, code, native_name, match_tag, detect, from_system}`、`keys::…` |

## 测量

### 真窗口自检（第三个里程碑）

2026-11-08 凌晨，开发构建（`cargo xtask dev`，未优化），这个 checkout 的开发档案里那份 showcase 库，打开的是《慢钟》。机器很忙（一分钟负载 400 上下，别的会话在编译），所以只看对不对，不看快慢。

`DRIFTING_CHECK=editor`：

```text
check: book read; 71000 words, 「编辑器验收」 0 hits
check: first chapter open in its editor, focused
check: typed and Enter stored (21 paragraphs)
check: ⌘Z ×2 took it back
check: ⌘⇧Z ×2 brought it again
check: another chapter and back (⌘[), same editor, text kept
check: 71000 → 71008 words, 「编辑器验收」 0 → 1 hits
check: done in 0.6 s; quitting
check passed
```

`DRIFTING_CHECK=editor-verify`（同一个程序重开）：

```text
check: reopened on Some(Target(Chapter(NodeId("019a3f62-…"))))
check: the text came back after the restart
check: deleted again; 71008 → 71000 words, 0 hits
check passed
```

- M03、M04 做完以后在最后的构建上又跑了一遍（负载约 30），两步的输出和上面一样，都通过。
- 打的 8 个字（「编辑器验收」5 个、「第二段」3 个）都算进了字数，搜索马上找得到；重开以后标签停在第一章、字都在；删掉以后字数和搜索都回到原样。
- 打字、回车、再打字，⌘Z 按两次就回到原样：编辑器把连着打的字并成一步（F4 的规则）。

### 离屏（第三个里程碑起，这一份是第四轮做完后量的）

原始数据写成测量证据 [acceptance/f6-m3-shell-bench.json](../acceptance/f6-m3-shell-bench.json)（文件名沿用第三个里程碑的；第二个里程碑那份 `f6-m2-shell-bench.json` 已删），输入的指纹含 dr-editor 和 gpui-prose。**测的时候一分钟负载 19–30**（别的会话在编译），证据里记着负载，数字仅供参考，机器空闲时再量。

| 项 | 第四轮（负载 19–30） | 第三轮做完时（负载 25–33） | 第二个里程碑（负载约 5） |
| --- | --- | --- | --- |
| 打一个字：经编辑器的输入入口（会话写入、落盘） | p50 0.29 ms、p95 1.95 ms、最大 4.2 ms | p50 0.21 ms | — |
| 打一个字后的那一帧（整窗重画；现在还要报实时字数） | p50 1.32 ms、p95 4.56 ms、最大 19.6 ms | p50 0.90 ms | — |
| 第一页打开（后台开会话 + 主线程建编辑器） | 46 ms（含第一次从 SQLite 读那一章） | 39 ms | 一页正文读出约 20–25 ms |
| 全书打开（M05：24 章，后台先开会话） | 24 ms | — | 只读页读出约 8 ms |
| 日常布局静止时要的帧 | **0** | 0 | 0 |
| 日常布局整页重画一帧 | p50 0.92 ms、最大 2.9 ms | p50 0.86 ms | p50 0.70 ms |
| 全书一页整页重画 | p50 1.6 ms、最大 3.8 ms | 只读页 p50 0.82 ms | 只读页 p50 0.76 ms |
| 切标签（叠化、坞的水波；翻页期间编辑器每帧重画） | p50 2.3 ms、p95 5.5 ms、最大 6.7 ms；结束后不再要帧 | p50 2.4 ms | p50 2.9 ms |
| 侧栏推入、收起 | p50 1.6 ms、最大 5.3 ms；结束后不再要帧 | p50 2.0 ms | p50 2.7 ms |
| 侧栏面板推进 | p50 1.0 ms、最大 3.4 ms | p50 0.75 ms | p50 1.6 ms |
| Super View 首开 | p50 0.91 ms、最大 1.4 ms | p50 1.0 ms | p50 1.7 ms |
| 设置首开（多了编辑器预览） | p50 3.0 ms、最大 4.4 ms | p50 2.2 ms | p50 3.5 ms |

- 发布档每帧 8.3 ms：除了打字那一帧的最差一次（19.6 ms，负载 19–30 下 80 次里的一次；p95 4.6 ms），都在里面。机器空闲时重量，看这一次是不是负载。
- 打字那一行是 F6 的整条路：输入入口（F4 的编辑器 → F3 的会话 → 持有者线程上提交、落盘）再到整窗重画一帧，两样加起来中位数约 1.1 ms。F4 自己量的「打一个字」中位数 0.40 ms（负载 10），口径相近。
- **翻页叠化和缓存视图的坑。** 编辑器是 GPUI 的缓存视图：没被通知就照搬上一帧画好的东西，连当时的不透明度一起。翻页叠化时新页从透明慢慢变实，编辑器在头几帧按很淡的不透明度画了一次，之后没人通知它，就一直淡着（离屏截图里整页字发灰；真窗口里光标一闪才变实，没有光标的另一半分屏会一直淡）。外壳现在在翻页的 180 ms 里每帧通知屏幕上的编辑器重画，结束后再画一次（`editors.rs` 的 `repaint_turning`）。这是 F5 的叠化和 F4 的缓存视图碰在一起的地方，记在「待协调」。

### 离屏（第二个里程碑）

M3 Pro，release 构建。离屏的帧时间是「重新渲染 + 排版 + 绘制」一整帧的 CPU 时间，1280×800、2 倍屏，内容是《慢钟》经 F3 读出。原始数据按 F8 的约定写成测量证据（带机器、负载和输入的指纹，外壳、dr-ui、dr-workspace 或样例书变了会被报「过期」），用上面的 `--bench` 重跑。这一节是第二个里程碑的数字（那份证据已被第三个里程碑的替换），**测的时候一分钟负载约 5**。

| 项 | 第二个里程碑 | 第一个里程碑（替身书，负载约 24） | 对照 [benchmarks.md](../benchmarks.md) |
| --- | --- | --- | --- |
| 冷启动到外壳首帧，直接运行可执行文件，开着 showcase 库（9 次，负载约 7） | 中位数 **270 ms**，最短 194 ms。其中：main 到 GPUI 平台建好约 100 ms（F7 的崩溃上报、日志、单实例、读设置），到 AppKit 就绪再约 18 ms，装 dr-ui 和外壳约 15 ms，建窗口和工作区约 90 ms，第一次排版绘制约 45 ms。库在自己的线程上开，约 2 ms，AppKit 就绪时早已开好 | 中位数 353 ms（负载约 20） | 发布档「冷启动到书架」≤ 300 ms：**在预算内**，但负载约 7、不是空闲；9 次里有 2 次 540 ms 左右（平台建好之前就慢了，是机器忙） |
| 书目列表到达 | 离屏：窗口开好后约 3 ms（只有《慢钟》的库）。真程序：之后每次启动约 1.4 ms；**刚生成库后的第一次启动约 470 ms**（库在后台给 233 篇文档补建索引，和查询抢同一个锁），这段时间面板是空的 | — | — |
| 一页正文读出 | 第一章约 20–25 ms（第一次打开那篇文档）；通览全书 24 章 127 行约 8 ms | — | — |
| 日常布局静止时要的帧 | **0** | 0 | 「不操作时 CPU ≈ 0」 |
| 日常布局整页重画一帧 | p50 0.70 ms、p95 0.88 ms、最大 1.5 ms | p50 0.44 ms | 发布档每帧 8.3 ms |
| 通览全书一页整页重画 | p50 0.76 ms、最大 1.3 ms（只排屏幕上的段） | — | — |
| 切标签（翻页叠化、标签坞水波进行中的每一帧） | p50 2.9 ms、p95 4.3 ms、最大 5.0 ms；水波和选中玻璃收尾后不再要帧 | p50 0.99 ms（那时新页是空白合成文字，没有水波） | 发布档：1 帧 / ≤ 50 ms |
| 侧栏推入、收起（420 ms 每一帧） | p50 2.7 ms、p95 4.5 ms、最大 7.7 ms；结束后不再要帧 | p50 0.71 ms | 发布档：不掉帧 |
| 侧栏面板推进（265 ms） | p50 1.6 ms、最大 3.1 ms | p50 0.52 ms | — |
| Super View 首开 | p50 1.7 ms、最大 3.3 ms | p50 1.1 ms | 发布档：最差帧 ≤ 100 ms |
| 设置首开 | p50 3.5 ms、最大 4.7 ms | p50 1.4 ms | — |

- 动画中的帧比第一个里程碑重，是因为现在画的是真东西：两页真正文一起叠化、侧栏里几十个带玻璃的 cell、药丸的水波和设置里的滑块。都在 8.3 ms 以内。侧栏列表改成只排看得见的行之前，侧栏推入最差一帧是 9.9 ms。
- 离屏测量的一个坑：离屏的执行器只在被要求时才跑后台任务，只画不跑的话，读正文的任务一直挂着，药丸一直按「加载中」流动、新页一直空白，帧就一直在要。现在每帧之间都让任务跑一下，和真窗口一样。

## 测试

`cargo test -p dr-i18n -p dr-shell` 跑 117 个测试（其中 `tests/m06_m07.rs` 的 2 个是 M06/M07 会话写的）：

- **dr-i18n**（10 个）：每种语言每个键都有字、Windows 覆盖层、插值、按 CLDR 选复数形（英语、法语、日语、巴西葡语）、`indent_one` 这种不是复数、语言标签匹配、搜索的规整；拷贝和旧版逐条一致；文档里的例子。构建本身就是那几条编译期检查。
- **dr-shell 单元**（50 个）：导航模型的预览 / 留下 / 分栏 / 关闭 / 历史 / 上限 / 重排 / 删除 / 恢复 / 链接行号；位置链接的三种写法、各种畸形、行到块、按名字和 id 找、重名和别的书；侧栏两半的自动分、手动收回被记住、关掉侧栏、按目标显露；宽度的上下限；设置注册表的键唯一和默认值合法、按类型校验；设置文件的分区往返、越界收回、坏文件挪开、改键、恢复默认；快捷键默认值（没有 ⌘S、两个系统都能解析）、改键与清空、录制的可移植写法、冲突；菜单；章节印章和旧版 `sealOf` 一致、颜色按作者存的十六进制读；角落菜单的三种写作状态和 F3 的一致；大纲栏按比例排、挤时让开不出界、放不下时先留正在读的那一支再开窗口（「…」两头加起来一个不少）、正在读的是阅读线以上的最后一个；设置搜索找得到不是设置的行（「许可证」只剩那一行、「诊断」是开关和摘要、「关于」整节、没找到时什么都没有），每个信息行都有字、id 不重。
- **dr-shell 在 GPUI 测试平台上**（51 个）：按键经键位表到达动作（⌘[ ⌘] ⌘⌥← ⇧⌘] ⌘W ⌘N ⌘⌥2）；Esc 一层一层关，⌘[ 先关 Super View；改键立刻生效、旧键失效、存进文件；侧栏开合；设置生效并在 300 ms 后写盘；退出前跑钩子、写盘；每种状态都画得出来；Super View 盖着时动标签的键不生效；模块登记的键在改快捷键重建键位表后还在；还原推荐样式把编辑器设置都还原、诊断摘要有版本和系统而没有路径。下面 40 个在一个用 dr-testkit 生成的《慢钟》库上跑（每个测试一个临时库）：
  - **M05**：「全书」标签是一个 `BookEditor`，24 章；大纲栏有 3 个幕、24 个章；经大纲跳到第三章，打一个字写进第三章、⌘Z 在第三章撤回；读全书时点第五章的位置链接，就在全书里跳过去、不多开标签；阅读位置存进布局，关掉全书标签再打开回到那里；
  - **查找栏和实时字数**：打开第一章，统计拿到它的实时字数，打一个字多一个；⌘F 出查找栏，打「钟」有十几个命中、选中第一个，Enter 下一个、⇧Enter 回来，Esc 关掉、查询清掉、键盘回到稿纸；
  - **M04**：三卷是三幕、装下全部 24 章，全书看法画得出来；第一章放到第三章上就排到它后面、再放回第二章上就回到原样（经 F3，等 F3 的事件回来）；素材笔记的大纲是两个 H2（「四个部分」「常见毛病」），点第二个光标落到它开头；
  - **M03**：角落 ⋯ 菜单的那两条命令把第一章的写作状态改掉（F3 的事件回来、列表跟着变）、把第二章放进废纸篓（标签关掉）；⌘⇧↩ 进沉浸写作、Esc 回来、再按两次一进一出；
  - **第三个里程碑的验收**（`a_chapter_written_in_the_app_is_kept`）：打开第一章，编辑器拿到键盘；经输入法用的入口打「钟停了。」、按回车（经键位表）、再打「夜里」，F3 存下的段落是「钟停了。」「夜里推开…」；⌘Z（编辑菜单的键，转给编辑器）撤到原样、⌘⇧Z 重做回来；打开第二章再 ⌘[ 回来，还是同一个编辑器、字都在；字数正好多 5、搜索「钟停了」从 0 到 1；走退出流程、关窗、放掉库（核对工作区、编辑器和里面的 `ProseEditor` 都放掉了，库的锁能再拿到），在另一个应用里重开同一个库和设置文件：页面停在第一章，编辑器里字都在，字数和搜索不变；
  - 面板列出 F3 的数据（书名、24 章按阅读顺序、4 条故事线、3 个类目、24 个要素、4 条构想、素材），章节的记号带主故事线的颜色，四个面板都画得出来；
  - 一页在它的编辑器里打开（第一章第一段的文字、标题行是章名）、素材笔记的 H2、通览全书只读页的 24 个章名；
  - **经 F3 把一章放进废纸篓（就像帮手或另一台设备那样），事件从持有者线程到主线程，那一章的标签关掉、列表少一章**；
  - 深链接按 id 打开、编辑器打开后把光标放到 L5 那一段（第三段，行号被取走），文档里的链接按章名经 F3 的目录打开，别的书不跳；
  - 布局按真书的 id 存、记住上次打开的书，新窗口在同一个库上恢复书、标签和页；
  - 退出流程跑 F3 的 `before_quit` 以后库还能用。
- **第五轮加的**：模态对话框开着时 ⌘⌥4 和设置都不开、关掉后又开（`a_modal_dialog_turns_the_workspace_shortcuts_off`）；Esc 先关搜索面板再关 Super View；⌥⌘F 出替换行，替换一个少一个、全部替换换掉其余、关掉查找栏后一次 ⌘Z 全部回来；换前台页面后 F3 的 `recent.list` 第一条就是它；选区浮条的 `CommentRequested` 打开撰写框、保存后 `comment.list` 里有这一条且挂在那一章上；排序和格子读数在两种看法、四种读数下都画得出来，存进布局、旧布局读出来是默认值（后四个在《慢钟》库上）；排序的三种顺序和旧版一样、字数和日期的写法（`chapter_sort` 单元测试）；dr-editor 的两端对齐和输入行位置（25–75 % 收住）进了排版样式。
- **第七轮加的**：单击人物链接（`EntityLinkOpened`）把那个要素当预览打开、「位置链接」复制后出小纸条、过一会儿消失；全书里跨两章的选区算出的字数是两章那段的；模块登记的左栏标签每个半栏只做一次、换了标签不再问；章节列表滚下去、侧栏收起再打开还在原处。
- **第十轮加的**：「打字时自动沉浸」关着时打字不进入，开着时打字进入、编辑器开了打字机滚动，点稿纸外面退出、编辑器跟着退出；手动进入的点外面不退出；指针到顶边露出、按一个字母键收走；打开全窗视图结束沉浸（在《慢钟》库上）。
- **第九轮加的**：模块按书记的东西写进了 F2 的 `local_state`、行挂在书下，另一个工作区打开这本书读得回来；书架画风等本机值；一选文件夹，书就写到文件夹下面（正文目录出现），关掉就停、位置还记着，再开又起来；用替身登记字海、首次运行和导览：书架按住字海，首次运行盖在书架上、走完记下本机值，从书架打开书时按住「等待」、页面好了以后两个都放开，导览这本书只开始一次，左栏关着时它的开关被标出（后四个在《慢钟》库上）。单元测试：「编辑故事线」的放上、拿下、主线顺延、只剩一条、已删的故事线不算；Markdown 文件夹的通知同一个文件同一个原因只说一次、换了原因再说、合并好了撤掉、另存的按个数说；悬停卡模块的行在最前和删除之前。
- **第八轮加的**：底部面板没有模块登记时不出现；登记了先是时间线、180 高，⌘J 收起又回来，情节规划在章节前面时出来、时间线让位，全书页在前时让开、回到这一章又出来，⌘J 把时间线换回来，沉浸写作时收起，开关和高度在布局里；上沿拖高时拖住的点跟着指针、最低是模块给的 260、最高给稿纸留 240，松手后高度在布局里；模块按书记的东西进了设置文件里这本书的布局；在窗口自己的更新里（对话框按钮里）关对话框也关得掉；库还被别人拿着时换库不跑替换、原来的库接着用；「打开恢复前副本」的文件夹建好了、在库的安全快照目录下；模块在自己的视图里画页面悬停卡、指针停上去打开不出错；素材笔记里点嵌入的素材，那个素材在预览标签里打开，⌘⇧H 绑在编辑器的高亮上、重建键位表后还在（后七个在《慢钟》库上）。单元测试：模块的悬停卡行排在删除一类前面。别的 crate 里：时间线的设置按书记住、新做的时间线照着来（dr-view-timeline）；外壳的底部面板里打开的是前面这一章的情节规划、改名后标题跟着变（dr-view-plot）。
- **换库**（`the_library_is_swapped_under_the_running_app`）：开着一章的编辑器和搜索面板时换库，`job` 自己能打开那个库（说明它确实关上了），换完窗口重新读出书、搜索面板没了、能在新库里打开一章；`job` 失败时原来的库重新在用，`done` 收到原因。
- **第六轮加的**：以 `Open::at_title` 打开的页编辑器不拿键盘，照常打开的拿；页面动作的顺序（要素：分享 → 模块的行 → 历史快照 → 模块的删除；素材没有分享；章节：分享和导出 → 三种写作状态只勾一个 → … → 删除节点在最后），模块的行点了会跑，要素页的 ⋯ 画得出来；导出记住的选择写进设置文件、另一个应用用同一个文件启动后读得回来；「自动要素链接」关掉后 F3 的 `auto_links()` 跟着变，章节面板全部折起（故事线数 + 未归属）、再按一次全部展开、单个折起；在补丁出处那段话中间打一个字，光标还在那一段时补丁不变，离开那一段后补丁被标为失效（后五个在《慢钟》库上）。单元测试：「…」列出的十个、备份恢复两行在本地数据最上面、导出选择在设置文件里的存取、导出选择的 JSON 形状、素材不分享。
- **孤儿检查**（1 个）：清单里每个键都被外壳的代码用到了。

测试平台的调度器只认它自己的线程。用到真库的测试调 `allow_parking()`，让 F3 线程上的事件能叫醒主线程（Zed 自己用到真 I/O 的测试也这样），等事件时最多等 5 秒。

## 和旧版不一样的地方

- **「上下两格」按 workspace.md 做成左右两半。** foundation.md 写的是「宽度够时可以分成上下两格」，但设计规范（workspace.md「Persistence and responsive behavior」）写的是宽度够时分成左右两个半栏、各有一行标签，宽度触发的也只能是左右分。按规范做了。
- **「侧栏推入，用冰曲线」按 motion.md 拆成两种。** 侧栏开合是「结构性开合」420 ms；面板之间切换才是「重冰推进」265 ms。
- **章节面板的排序菜单和行尾读数照旧版做了**（第五轮）；折叠、悬停卡还没有，是 M-章节面板的事。「外层故事线按字母」只按小写比较，旧版用的是浏览器的 `localeCompare`（数字按大小、不分大小写和重音），中文书名两者一样，带数字的英文名可能排得不同。
- **侧栏收起时面板不保活。** 收起后再打开，面板的滚动位置等局部状态从头开始（旧版保活是为了 WebKit 的切换开销，GPUI 没有这个问题，但滚动位置值得保，见「下一步」）。
- **每个打开的标签各有一个编辑器，不是一个编辑器换着章节用。** F4 的接入说明写的是 `ChapterEditor::open` / `switch_to`；外壳只用了 `open`：翻页叠化的 180 ms 里新旧两页要同时画，同一个编辑器画不了两份；各自一个，换回来时光标、滚动和撤销步数都还在。标签关掉就放下它的编辑器（测试核对了关窗以后编辑器和里面的 `ProseEditor` 都放掉了、库能再打开）。
- **侧栏里的幕和拖动排序是新的。** 旧版侧栏没有幕、也不能拖（幕在时间线和通览全书里，排序在时间线上拖）；这一轮照 M04 的要求在全书看法里加了幕的标题行，章节格子能拖。
- **大纲栏的开关按书存在本机布局里**，旧版是全局设置 `outlineRailMode`。等设置注册表要收这一项时再挪。
- **章节页头（第 N 章 · 故事线 · 字数、可改的标题、梗概）和章末 ⁂ 还没有**：标题暂时显示在编辑器自带的标题行（粗体，旧版是 400 字重），见「待协调」F4、F5。
- **菜单仍是英文。** P0-A 的坑 6：GPUI 只把标题恰好是「Window」的菜单当窗口菜单，翻译了窗口列表就没了。
- **没有工具提示。** 旧版图标按钮的 title 提示没搬（规范不让自己加提示句），开关、窗口按钮、通知的 × 只给读屏软件标了名字（`aria_label`）。
- **账户 cell 只有「本地」**：账号（M35）、字数（M07）还没有。

## 已知限制

- 帮手、时间线、查找、全局搜索、书架都还没有（沉浸写作只有「只剩稿纸」）：对应的快捷键已经绑好、动作已经注册，按下去现在只记一行调试日志。审阅、统计面板是空的。
- 通览全书仍是只读页；`prose.read` 只给每段的纯文本和标题级别，所以那一页上引文块、列表、对齐、行内的粗斜体都按普通段落显示。在全书里直接写是 M05。
- 编辑器的事件里，`TodoMarkers`（TODO 标记投成待办）和 `AnchorsChanged`（撤销带回的批注锚点写回书目）只记日志：要 F3 的 `todo.project` 和 `comment.reanchor`，代码里留了 TODO。
- `gpui_prose::bind_keys` 的键写的是 `cmd-`，Windows 上编辑器的移动、删除键要等 F4 改成 `secondary-` 或交给外壳的注册表。
- 书目读进来之前（平时约 1 ms，刚生成库后第一次启动约 0.5 s），面板是空的、稿纸上是没有书名的主页，没有加载的样子。
- 打开哪本书：上次打开的，否则库里列出的第一本（按 id 排）；没有书架、也没有在界面里换书的地方。
- 库打不开（别的进程占着、迁移失败）时只写日志，窗口照开、没有书；恢复指引属于 F2 / 首次体验。
- 离屏截图里没有红绿灯；Windows 的标题栏按钮只编译过，没在 Windows 上跑。
- 「深链接从别的线程叫醒主线程」那一段只在真程序里走到，测试里是在测试线程上推的（F3 事件那一段测试里走的是真线程）。

## 待协调

第一、二个里程碑提的 F5 那几样（Panel Tab 的推进、cell 环、数值滑块、按钮读屏名、标签坞收回的时长、能拖的药丸组、整个标签坞）、F3 那几样（目录、删除事件、退出钩子）和 F4 的编辑器都已经做好、接上了。还剩：

1. **F3（dr-workspace）**：
   - `prose.read` 只给纯文本和标题级别。只读稿纸（以及以后的导出预览）想按段落属性排引文块、列表、对齐，需要它把段落属性也带出来（或者给一个按段的 `dr_text` 投影）。编辑器接上以后稿纸直接读文档，这一条就只剩导出预览要。
   - 刚生成（或刚导入）的库第一次打开时，后台补建索引会让第一次查询等约 0.5 s（showcase：233 篇文档）。能不能让查询不排在补建后面，或者补建在导入那一步就做掉（M10 的导入也会遇到）。
2. **F2 / M10**：新库放在应用数据目录的 `library/` 子目录里（正式版的数据目录就是 0.1 的，0.1 自己的数据库在它的根上）。这是外壳现在的约定，库的位置最终由 F2 / M10 定，定了改 `app/drifting/src/main.rs` 的 `LIBRARY_DIR` 一处。库打不开时的恢复界面也归 F2 / 首次体验。
3. **F5（dr-ui）**：
   - `PillGroup` 选中的药丸在水波结束、或加载结束时，玻璃要再走一段「收尾」，这段时间仍要帧（真窗口会一直出帧，没问题）。离屏测量时要记得帧与帧之间让任务跑，不然看起来像停不下来（见「测量」）。只是提醒，不用改。
   - **`PageTurn` 把叠化进度交给子元素**（见下面 F4 的「缓存视图」那条）。
4. **F4（编辑器 / dr-editor、gpui-prose）**：
   - `bind_keys` 用的是 `cmd-`，Windows 上要 `secondary-`（或者移动、删除这些键也交给外壳的注册表）。
   - **标题行不认页边距。** 段落按 `column(可用宽, max_width, gutter)` 排，标题行是 `min(可用宽, max_width)` 居中。外壳把交给编辑器的 `page_width` 设成正文的宽（纸宽减两边 64 px）来对齐，栏比纸宽设置窄时标题仍往左偏一点（1280 宽、两侧栏都开时约 20 px）。建议标题行也用 `column`。
   - **缓存视图会留住祖先的不透明度。** `ProseEditor::element` 是 `cached` 视图，没被通知就重放上一帧，连当时的不透明度一起；放在 F5 的 `PageTurn` 叠化里，编辑器停在头几帧的淡色。外壳在翻页期间每帧通知编辑器重画来绕开（见「测量」）。F4 给了 `ProseEditor::element_at_opacity`，但外壳用不上：`ChapterEditor` / `BookEditor` 自己调 `element` 画，外壳只拿到整个编辑器视图；`PageTurn` 也不把叠化进度交给画子元素的闭包。要两头各补一样：F5 的 `PageTurn` 把每一半当前的不透明度交给子元素（比如 `child(|opacity| …)`），F4 的两个编辑器接一个「画时的不透明度」（`set_drawn_opacity` 或 `element_at_opacity` 的同款）。补上以后 `repaint_turning` 就能删。
   - 格式键（⌘B、⌘1…）`key_bindings` 和外壳注册表里各有一份，同一个动作同一个上下文，不冲突；以后可以从 `key_bindings` 里删掉。
   - **大纲栏只和高度估算一样准。** 标签按「标题以上的高度 / 全文高度」排，没排过的段落用 F4b 的估算。全书视图里只有前几章真排过，后面的章估得偏矮，大纲栏下半部分的章就挤在一起（截图 `whole-book`）。估算准了（待协调 F4d-2 那一条）这里自然好；或者编辑器空闲时在后台把高度量完。
5. **F7**：首次启动时故障诊断的那一句说明仍属于首次体验；Windows 上 `set_app_identity` 仍等实测。「提交反馈」第五轮在设置「关于」和账户菜单里都接上了（派发 `SendFeedback`）。
   - **dr-text（备份与恢复）**：两个动作名照它的计划定了；换库用 `dr_shell::library::replace`（接法见上面「第六轮」和共享笔记）。dr-view-transfer 合进来以前，按钮只关掉设置。
   - ~~**F3（dr-workspace）**：`shutdown` 失败时把工作区交还~~：F3 第七轮给了 `try_shutdown`，外壳第八轮换上了，关不掉时原来的库接着用（`a_library_that_will_not_close_is_kept`）。
   - **F2（dr-store）**：外壳第八轮在 `backup.rs` 加了一个小函数 `Library::pre_restore_dir(root)`（恢复前副本的文件夹，`pre_restore_backups` 也改用它），请知悉。
   - **M41（导出）**：记住的选择第六轮跨重启了（`export_memory.rs`），`prefs.rs` 的模块文档顺手改了一句；m41-export.md「待协调」第 1、2 条可以划掉。
   - **M11（要素）**：⋯ 菜单的挂接点是 `pages::add_page_menu`，`PageMenuItem.icon` 第七轮起收 `RowIcon`（`MenuRow` 原样搬过来，`run` 里把 `host.workspace` 交给它）；左栏的要素面板第七轮已接上。要素页的提醒可以改走 `dialogs::show`。
   - **F5（dr-ui / dr-view-sea）**：分段控件（`Segmented`）要能把某一段单独交给导览标出来（右栏的「帮手」标签现在只能整行标）。dr-view-sea 这一轮外壳这边动了三处：新文件 `shell.rs`（登记）、`tour::ids` 改成转用外壳的 `pages::anchors`、`Cargo.toml` 加了 `serde_json`。首次运行的确认对话框默认焦点还没放在「取消」上（dr-ui 的按钮还不能拿焦点）。
   - **M01（书架）**：画风已经存进本机值（`dr_view_shelf::art::STYLE_KEY`，外壳这边改的）。m24-sea.md 里「M01（书架）」那几条（按下起波、样书落位）归书架。
   - **M02（作品主页）**：导览的「新建」那一步要主页自己用 `dr_shell::pages::anchor(anchors::HOME_CREATE, …)` 标出来。
   - **M40（Markdown 文件夹）**：挂接点 1–3 第九轮做了；首次运行那一步也接上了。通知点开别的书时只打开那本书，不定位到那一章。
   - **M14（时间线）**：底部面板、⌘J、竹子开关、按书记住第八轮都接上了（`dr_view_timeline::init`、`kept.rs`，这两处是外壳这边写进 dr-view-timeline 的）。片段和泳道名字的悬停卡用 `workspace::page_hover_card`（「转移至未归属」「回到未放置」这类放进 `extra`）。
   - **M15（情节规划）**：底部面板和工具托盘里的开关第八轮接上了（`dr_view_plot::init` 是外壳这边写的：按前面的章节或构想做一个，改名时 `set_title`）。按表记住宽高比可以用 `book_memory`（比如键 `plot`，里面按节点存）。
   - **M01（作品主页）**：作品主页自己在前台页面变了时调 `recent.touch`，外壳第五轮起也调（`touch_front`），现在一次打开记两遍（结果一样）。主页那份可以删。悬停卡现在只有章节面板有（章节和故事线），要素、构想、素材面板的卡跟各自的面板来，`page_actions` 可以直接用。
   - **产品（作者定）**：点批注刻度时，右栏没开或不在「审阅」，要不要自动打开审阅？现在不开（F4d 只让那张卡亮）。
6. **F8**：外壳的测量证据是 `acceptance/f6-m3-shell-bench.json`，由 `examples/shell-capture.rs --bench` 写；截图和测量的离屏写法可以并进 dr-testkit。`cargo xtask dev` 可以加一个 `--seed <预设>`，把「先生成库再启动」并成一步（现在是两条命令，见「怎么看」）。
7. **F5（dr-view-page）**：⁂ 新建下一章改用 `Open::KEEP.at_title()`（外壳认这个意图，不再靠焦点先后），`NewTitles` 照旧负责标题全选。外壳在 `editor_prepared` 里不再给装了 chrome 的页设标题行。键盘进出 ⁂ 仍等外壳的焦点框架。
8. **M10**：m10-import.md「待协调」第 13 条（13 句文案）和第 14 条（外壳里的那一层、对话框开着时快捷键停不停）第五轮都做了：文案在 `dr-i18n/own/`，那一层并进 `dialogs::show` / `hide`，快捷键停。第 14 条的「多窗口时应该找派发动作的那个窗口」M10 第五个里程碑做了：`with_workspace` 先找活跃窗口（`active_workspace`），加了 `with_workspace_in` 和 `dialogs::show_in`；通知也能带一个按钮（`NoticeAction`，M10 的「接着导入」）。这几处改在外壳里，请 F6 审（m10-import.md 待协调 20）。**第八轮审过**：三处做法都留下；外壳改了两处：对话框在自己的按钮里关（窗口正借出去处理这次点击）时以前会悄悄关不掉，现在经 `update_workspace` 等点击结束再关；通知的按钮点了不再连带触发整行。
   - **新版自己的文案来源**是 F6 定的（`dr-i18n/own/`）：以后各模块要旧版没有的句子，都写进这里，九种语言齐全。中日韩只写一句，其余五种语言有数字的句子要写 `_one` / `_other`。
9. **监管会话**：
   - 菜单本地化仍要先给 GPUI 打个小补丁，这一轮菜单保持英文。
   - `next/README.md` 的开发开关表可以加 `DRIFTING_APPEARANCE`、`DRIFTING_BOOK` 和「先生成 showcase 库」那一步，我没改那个文件。
   - `progress.md` 的 F6 一行等合并时更新。

## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1 | dr-i18n：九种语言、复数、插值、编译期检查、Windows 覆盖层 | 完成 |
| 2 | 窗口与导航：一个导航模型、位置链接、深链接 | 完成 |
| 3 | 布局：三栏、抽屉、两半、左右栏标签、占位面板、只读稿纸 | 完成；第二个里程碑起面板和稿纸是真数据 |
| 4 | 标签坞与 Super View 舞台 | 完成主体；小点长成药丸、弹簧拖动、水波未做 |
| 5 | 快捷键注册表、改键、默认键位（无 ⌘S） | 完成 |
| 6 | 设置注册表、文件存储、面板与搜索、按书的本机布局 | 完成；外观、语言、编辑器、隐私为真实分区 |
| 7 | 通知中心，崩溃跟进接 `take_follow_up` | 完成；其余来源占位 |
| 8 | 退出流程 | 完成 |
| 9 | 只用 dr-ui，开发包带字体 | 完成；手拼的几样第二个里程碑已换成 dr-ui 组件 |
| 10 | 测试、截图、测量 | 完成 |

第二个里程碑：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | 换用 F5 的新组件：`Segmented` 推进模式、`SandCell`、`Range` + `NumberField`、`.label()`、`dwell::DOCK_COLLAPSE`、`PillGroup` 拖动 | 完成；`panel_tabs.rs` 和自画的拖动副本删了 |
| 2 | 接 F3：目录、删替身书、四个面板的数据、删除事件关标签、退出钩子；开发期打开 showcase 库 | 完成 |
| 3 | 稿纸从 F3 读正文，H1/H2/H3 按编辑器字号 | 完成；只读，段落属性只有标题级别 |
| 4 | 冷启动重测 | 完成：270 ms（负载约 7，不是空闲） |
| — | 侧栏列表只排看得见的行 | 完成（顺手做的：侧栏推入最差一帧从 9.9 ms 降到 2–8 ms） |

第三个里程碑（目标：在 App 里打开一本书就能写字）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | 稿纸换成 `dr_editor::ChapterEditor`；设置变了 `set_settings`、主题变了 `set_base_style`；`take_reveal` 交给编辑器的 `select`；订阅 `ChapterEditorEvent` | 完成；每个标签一个编辑器（只用 `open`，没用 `switch_to`，理由见「和旧版不一样的地方」）；`AnchorsChanged`、`TodoMarkers` 等 F3 的命令，留了 TODO |
| 2 | 标签坞换用 F5 的 `TabDock` | 完成；外壳的悬停计时删了 |
| 3 | 验收：showcase 库里打开一章，打字、回车、撤销、换章再换回来、关掉重开都在，搜索和字数跟着变；测试 + 真窗口 | 完成：测试 `a_chapter_written_in_the_app_is_kept`；真窗口 `DRIFTING_CHECK=editor` / `editor-verify`（结果见「测量」） |
| — | 编辑菜单的命令转给编辑器、键盘跟着页面走、Settings 和 Super View 盖上时拿走键盘 | 完成 |

M03 章节页与稿纸工具栏（`modules.md`）：

| 内容 | 状态 |
| --- | --- |
| 稿纸右下角的工具托盘、⋯ 菜单 | 完成：章节的菜单（写作状态、删除节点）；别的类型的菜单跟各自的模块 |
| 写作状态 | 完成：⋯ 菜单里改，经 `chapter.update` |
| 沉浸写作入口（一炷香、⌘⇧↩） | 完成；沉浸写作本身只做了「只剩稿纸」，其余是 M26 |
| 页眉（第 N 章 · 故事线 · 字数）、标题自动换行与回车进正文、梗概、章末 ⁂、空章提示 | **没做**：等 F4 的章首 / 章末挂接点和 F5 的无框多行输入（「待协调」F4、F5） |

第四轮（11-08，监管会话的清单）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | M01 的 ⌘↵、M06 搜索面板的 ↑↓ 改用 `keymap::add_bindings`，去掉搜索面板自己读按键 | 完成 |
| 2 | M07 的实时字数：编辑器改动报给 `LiveWords` | 完成；选区字数也报，标签关了退回索引的数 |
| 3 | 沉浸写作只对拿键盘的编辑器 `set_paragraph_focus`；减少动效转给 `set_reduce_motion` | 完成；主题变了连块样式一起换 |
| 4 | 章内查找栏（F4c 的查找接口） | 完成：⌘F、Enter / ⇧Enter、⌘G / ⇧⌘G、Esc；替换没做，高亮等 F4d |
| 5 | 编辑器键位换成 `key_bindings(KeyScheme::native())` | 完成 |
| 6 | 审 M01 在 `pages.rs`、`workspace/mod.rs`、`stage.rs` 的接入点 | 完成；改了两处，记了一处（见「第四轮」小节） |
| 7 | 账户菜单挪进外壳共用 | 完成：`dr_shell::account`；书架和左栏账号格子用同一个 |
| 8 | M05 接进外壳：全书放 `BookEditor`、目录 `jump_to`、位置链接 `reveal_line`、阅读位置存布局、撤销重做 | 完成 |
| — | M08 设置第一批（外观、编辑器、语言、快捷键、本地数据、关于，可搜索） | 完成，没做的几行见 M08 小节 |

第五轮（11-08，监管会话的清单）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | 选区浮条的 `CommentRequested` 打开撰写框 | 完成；单章和全书都接 |
| 2 | 浮层收成一套；模态对话框开着时工作区快捷键停 | 完成：`dialogs::show` / `hide`，`pages::add_layer` 删了，`Workspace::modal()` |
| 3 | F4 交的：叠化里 `element_at_opacity`、`ChapterEditor::with_session`、`editor.auto_entity_links`、两端对齐和输入行位置 | `with_session` 和三项设置完成；`element_at_opacity` 没用上（理由见「待协调」F4），`repaint_turning` 留着 |
| 4 | 换前台页面时 `recent.touch`；别的页面的 ⋯ 菜单加「历史快照…」 | 完成 |
| 5 | 「提交反馈」：设置「关于」一行、账户菜单一项，派发 `SendFeedback` | 完成 |
| 6 | 搜索浮层进「Esc 一层层关」 | 完成 |
| 7 | 查找栏加替换（`replace_current` / `replace_all`） | 完成：⌥⌘F / Ctrl+H，全部替换一步撤销 |
| 8 | M10 的 13 句文案 | 完成：新版自己的文案来源 `dr-i18n/own/` |
| 9 | M04 剩下的：排序菜单、格子的字数和日期 | 完成 |
| 10 | M03 章首章末 | 不归这一轮：交给 F5 实现 F4 的 `PageChrome`，外壳等它交回再 `set_chrome`；「新建下一章后打开并全选标题」等 F5 交回后再做 |

第六轮（11-08，监管会话的清单）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | 全书改用 `BookEditor::prepare`（后台）+ `with_prepared`（主线程），去掉 panic | 完成 |
| 2 | 「打开时聚焦标题」的意图；装了 chrome 的页不再 `set_title` | 完成：`Open::at_title`，dr-view-page 改用它 |
| 3 | ⋯ 菜单让模块加行；构想、要素、故事线、类目页最上面加「分享」 | 完成：`pages::add_page_menu`、`page_actions` |
| 4 | 导出偏好跨重启 | 完成：`export.author` 和每本书的 `export` |
| 5 | 「自动要素链接」调 `set_auto_links`；正文停手后 `patch.check_sources` | 完成：光标离开段落、正文失去键盘时 |
| 6 | 设置「本地数据」的备份、恢复两行；换库的外壳函数 | 完成：派发 `BackupLibrary` / `RestoreLibrary`，对话框归 dr-text；`library::replace` |
| 7 | 滚动条批注刻度、大纲栏「…」悬停菜单、章节面板折叠和悬停卡 | 刻度 F4d 已做；其余三样完成 |

M04 章节面板、幕与大纲栏（`modules.md`）：

| 内容 | 状态 |
| --- | --- |
| 章节面板按故事线 / 看全书（摘要那行切换） | 完成 |
| 幕的分界 | 完成：全书看法里每一幕一个标题行，幕里的章缩进 |
| 拖动排序 | 完成：章节格子拖到另一章上，经 `chapter.move` |
| 大纲栏（H1/H2/H3，按比例排，挤时让开，放不下时收起） | 完成；「…」悬停展开的小菜单第六轮做了 |
| 排序菜单、格子信息（字数、日期） | 完成（第五轮）：全书 / 按故事线两套排序、多线章节、单元格右侧四选一，按书存 |
| 滚动条上的批注和 Agent 改动刻度 | 完成（F4d 在编辑器里画） |
| 折叠、悬停卡 | 完成（第六轮）：按故事线看时折叠，章节和故事线的悬停卡 |

## 下一步建议

1. **键盘框架**：Tab 进出 ⁂、侧栏列表的方向键、悬停卡的键盘打开（`HoverCardState::open_now`），一起做成外壳的焦点框架；等设计先定。
2. **底部面板两块互换时的「推」**（旧版 265 ms，从下往上推进来、边上的线泛玻璃），以及时间线泳道多到放不下时面板自己长高。
3. **作品主页、书架、首次体验**：主页现在只有书名；书架（换书、红灯回书架）、首次说明（含故障诊断那一句）、库打不开时的恢复界面一起做。书架做了以后 `DRIFTING_BOOK` 可以删。
4. **面板做全**（M-章节 / M-要素 / M-构想 / M-素材库）：悬停卡、排序、折叠、行尾读数、新建和改名；侧栏收起再打开时保留滚动位置（按「书 × 侧栏 × 半栏 × 标签」存）。
5. **标签坞做完**：和 F5 一起做成组件（小点长成药丸 340 ms、让位、拖离收拢）。
6. **冷启动**：机器空闲时再测一次（`script/bundle-mac && script/measure-startup-mac --runs 9`，以及直接运行可执行文件）；建窗口那 90 ms 里有一部分是运行时编译 Metal 着色器（`runtime_shaders`），发布包预编译以后会少。
7. **Windows 实测**：标题栏药丸、Snap 布局、`set_app_identity`、托盘（M43）。

## 代码位置

| 位置 | 内容 |
| --- | --- |
| `crates/dr-i18n/keys.txt`、`script/sync-locales.py`、`own/`、`locales/` | 要搬的键、拷贝脚本、新版自己的文案、合在一起的九种语言和 Windows 覆盖层 |
| `crates/dr-i18n/build.rs`、`src/lib.rs`、`tests/source.rs` | 生成键常量和表、编译期检查；运行时（复数、插值、语言匹配）；和旧版比对 |
| `crates/dr-shell/src/nav/mod.rs`、`nav/location.rs` | 导航模型；位置链接 |
| `crates/dr-shell/src/panes.rs` | 侧栏的一半与两半、宽度上下限 |
| `crates/dr-shell/src/keymap.rs`、`actions.rs`、`menus.rs` | 快捷键注册表；动作；菜单栏（从 P0-A 搬来） |
| `crates/dr-shell/src/settings/` | 注册表（`registry.rs`）、文件（`store.rs`）、面板与搜索（`panel.rs`）、全局与生效（`mod.rs`） |
| `crates/dr-shell/src/notifications.rs`、`quit.rs`、`appearance.rs`、`strings.rs` | 通知中心；退出流程；外观（含 macOS 原生那一侧）；文案全局 |
| `crates/dr-shell/src/book.rs` | 打开的书：F3 列表的快照、一页的正文、F3 目标与外壳目标的对应、`Catalog` 适配 |
| `crates/dr-shell/src/account.rs` | 共用的账户菜单和头像 |
| `crates/dr-shell/src/export_memory.rs` | 导出记住的选择：设置文件和 dr-view-export 的 `Prefs` 之间来回 |
| `crates/dr-shell/src/library.rs` | 换库：放手、关库（`try_shutdown`，关不掉就接着用原来的）、跑替换、装回新库（失败时装回原来的） |
| `crates/dr-shell/src/workspace/bottom.rs` | 稿纸下面的底部面板：显示哪块、开关、高度和拖动、滑动、模块的视图 |
| `crates/dr-shell/src/workspace/immersive.rs` | M26 沉浸写作的外壳部分：进出、打字进入、点外面退出、顶边露出、出口和字数、红绿灯 |
| `crates/dr-shell/src/workspace/sea.rs` | M24 在外壳里：字海按住和放开、整窗等待、退潮、首次运行、导览的开始和图层 |
| `crates/dr-shell/src/mirror.rs` | M40 Markdown 文件夹：起停、通知、关掉前的确认 |
| `crates/dr-shell/src/workspace/toast.rs` | 窗口下沿的小纸条（`Workspace::toast`） |
| `crates/dr-shell/src/workspace/` | 工作区根（`mod.rs`：状态、读书目、F3 事件、沉浸写作、挪章节、全书里的位置链接）、每个标签的编辑器（`editors.rs`：单章和全书、样式、键盘、实时字数、阅读位置）、查找栏和替换（`find.rs`）、章节面板的排序和格子读数（`chapter_sort.rs`）、页面能做的事（`page_actions.rs`：⋯ 菜单和悬停卡共用）、选区批注的撰写框（`review.rs`）、稿纸右下角（`corner.rs`）、大纲栏（`outline.rs`）、窗口边角与拖动区（`chrome.rs`）、侧栏（`sidebar.rs`）、标签坞（`dock.rs`）、稿纸（`stage.rs`）、Super View（`super_view.rs`） |
| `crates/dr-shell/tests/`、`examples/shell-capture.rs` | GPUI 测试平台上的行为测试（含《慢钟》库上的 6 个）、孤儿键检查；离屏截图与测量（写测量证据） |
| `app/drifting/src/main.rs`、`probe.rs`、`check.rs` | 入口：F7 的顺序不变，加上读设置、在线程上开库、装 dr-ui、交给外壳；启动探针多了 `library_opened`、`shell_ready`；开发构建的真窗口自检 `DRIFTING_CHECK` |
