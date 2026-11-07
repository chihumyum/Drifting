# F6 dr-shell：外壳（第一、二、三个里程碑，M03）

2026-11-07 起，分支 `claude/f6-shell-80c9fb`。第一个里程碑从整合分支 `claude/f-batch2-integrate` 开工；第二个里程碑从 main `4c477ea0`（F3 第二个里程碑、F5 第二个里程碑已合）接着做；第三个里程碑（11-08）从 main `a039863f`（dr-editor、F5 的 `TabDock` 已合）接着做。代码在 `next/crates/dr-shell`、`next/crates/dr-i18n`，应用入口 `next/app/drifting`。计划见 [foundation.md 的 F6](../foundation.md#f6-dr-shell)。

## 一句话

稿纸四周的那一圈搬到了 GPUI 上：三栏、两侧抽屉、稿纸顶上的标签坞、分栏、Super View 舞台、设置、通知、快捷键、退出流程，外加读旧版九种语言文案的 `dr-i18n`。第二个里程碑起，外壳打开的是**真的书**：面板列表从 F3 的查询来，别处（帮手、另一台设备）删了东西，对应的标签自己关掉。第三个里程碑起，**在 App 里打开一本书就能写字**：稿纸上是 F4 的编辑器，打的字、回车、撤销都经 F3 落盘，关掉 App 再开都在，搜索和字数跟着变。

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

截图直接写成 256 色的 PNG（和 dr-ui 的 `shrink-pngs.py` 一样的效果，但不需要 Pillow，用的是 GPUI 图像栈里已经有的 `color_quant` 和 `png`），18 张共 3.3 MB，最大一张 383 KB。

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
| Super View 舞台（要素全景，内容占位） | [super-view-light](f6/super-view-light.png) | [super-view-dark](f6/super-view-dark.png) |
| 设置（从注册表生成：外观、编辑器……；数值是滑块加数字框） | [settings-light](f6/settings-light.png) | [settings-dark](f6/settings-dark.png) |
| 设置搜索「字号」 | [settings-search-light](f6/settings-search-light.png) | [settings-search-dark](f6/settings-search-dark.png) |
| 通知中心（崩溃跟进、Markdown 文件夹的复数文案、更新） | [notifications-light](f6/notifications-light.png) | [notifications-dark](f6/notifications-dark.png) |
| 过渡进行中 | [motion-midway-light](f6/motion-midway-light.png) | [motion-midway-dark](f6/motion-midway-dark.png) |

## 做了什么

### 1. dr-i18n：文案

- **来源**：旧版 `src/renderer/locales/*.json`（九种语言）和 `locales/windows/*.json`（Windows 覆盖层）。外壳只搬真正用到的键：清单在 `crates/dr-i18n/keys.txt`（一行一个，`前缀.*` 取整棵子树，复数键不写后缀），`script/sync-locales.py` 按清单从旧版拷出子集到 `crates/dr-i18n/locales/`。现在 129 条清单、每种语言约 130 个字符串。**阶段 7 删旧代码时，这份拷贝就成为来源**，脚本删掉；在那之前，`tests/source.rs` 逐条比对拷贝和旧版，旧版改了文案测试就报「重跑脚本」。
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
| `workspace` | 各面板、F8 的调试桥 | `Workspace::{open, open_link, toggle_left, toggle_right, toggle_super_view, open_settings, dismiss, top_layer, layout, on_library_events, editor_of(target), run_command(name, input, cx)}`、字段 `library`、`book_id`、`book`、`editors`（每个打开标签的 `PageEditor { doc, editor: Option<Entity<ChapterEditor>>, loading, failed }`）、`pages`（只剩通览全书的只读页 `PageSlot`）、`with_workspace(cx, f)`、`title_of(book, target, cx)`、`BookLayout`、`EditorLook::size_of(heading)` |
| `workspace::editors` | 以后要在稿纸上加东西的模块（批注栏、大纲栏、沉浸写作） | `editor_settings(cx) -> EditorSettings`（设置文件里的编辑器设置）、`base_style(&theme) -> ProseStyle`（主题的颜色和正文字体）、`forward_edit_actions(el)`（编辑菜单的命令转给里面的编辑器）、`PAGE_GUTTER`、`TITLE_SIZE`；`pub use dr_editor::{ChapterEditor, ChapterEditorEvent, EditorSettings}` |
| `keymap` | 想加快捷键的模块 | 在 `REGISTRY` 加一行（动作名、默认键、上下文、要不要列进设置）；`apply(&overrides, cx)`、`display(keys, os)`、`portable(keystroke, os)`、`conflict(...)` |
| `settings` | 想加设置的模块、M37 偏好同步、M10 导入映射 | 在 `registry::REGISTRY` 加一项；`Settings::{read(cx), update(cx, \|file\| …), flush(cx), locale(cx)}`；`SettingsFile::{get, bool, str, number, set, reset, is_changed, key_bindings, set_key_binding, layout, set_layout, last_book, set_last_book, save}` |
| `notifications` | 同步、分享、整理、Markdown 文件夹、更新 | `Notifications::post(Source::…, 文字, cx)`、`post_at`、`remove`、`clear`、`items`、`unread` |
| `quit` | F2 / F3 / 同步 / 更新 | `quit::before_quit(cx, \|cx\| …)`：退出前要做完的事登记在这里；`quit::request(cx)` |
| `strings` | 所有界面 | `t(cx, key)`、`tf(cx, key, &[("count", &3)])`、`tp(cx, plural_key, n, &[])` |
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

- 打的 8 个字（「编辑器验收」5 个、「第二段」3 个）都算进了字数，搜索马上找得到；重开以后标签停在第一章、字都在；删掉以后字数和搜索都回到原样。
- 打字、回车、再打字，⌘Z 按两次就回到原样：编辑器把连着打的字并成一步（F4 的规则）。

### 离屏（第三个里程碑）

原始数据写成测量证据 [acceptance/f6-m3-shell-bench.json](../acceptance/f6-m3-shell-bench.json)（第二个里程碑那份 `f6-m2-shell-bench.json` 删了），输入的指纹多了 dr-editor 和 gpui-prose。**测的时候一分钟负载约 28**（别的会话刚编完东西，之前一直在 100–400），证据里记着负载，所以下面只看中位数、p95 和最大值都不作数。

| 项 | 第三个里程碑（负载约 28） | 第二个里程碑（负载约 5） |
| --- | --- | --- |
| 打一个字：经编辑器的输入入口（会话写入、落盘） | 中位数 0.51 ms | — |
| 打一个字后的那一帧（整窗重画，编辑器只重排那一段） | 中位数 2.4 ms | — |
| 第一页打开（后台开会话 + 主线程建编辑器，离屏） | 82 ms（含第一次从 SQLite 读那一章，负载高） | 一页正文读出约 20–25 ms |
| 日常布局静止时要的帧 | **0**（光标闪烁是编辑器自己的定时器，不算外壳要的帧） | 0 |
| 日常布局整页重画一帧 | 中位数 2.7 ms | 中位数 0.70 ms |
| 切标签（叠化、坞的水波；翻页期间编辑器每帧重画） | 中位数 3.5 ms；结束后不再要帧 | 中位数 2.9 ms |
| 侧栏推入、收起 | 中位数 2.9 ms；结束后不再要帧 | 中位数 2.7 ms |
| 侧栏面板推进 | 中位数 1.3 ms | 1.6 ms |
| Super View 首开 | 中位数 1.4 ms | 1.7 ms |
| 设置首开 | 中位数 4.7 ms | 3.5 ms |

- 整页重画的中位数从 0.7 变成 2.7 ms：一半是负载，一半是稿纸上现在是编辑器（外壳的重画不排正文，正文是缓存视图，没变就照旧画上一帧的）。机器空闲时再量一次。
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

`cargo test -p dr-i18n -p dr-shell` 跑 60 个测试：

- **dr-i18n**（9 个）：每种语言每个键都有字、Windows 覆盖层、插值、按 CLDR 选复数形（英语、法语、日语、巴西葡语）、`indent_one` 这种不是复数、语言标签匹配、搜索的规整；拷贝和旧版逐条一致；文档里的例子。构建本身就是那几条编译期检查。
- **dr-shell 单元**（34 个）：导航模型的预览 / 留下 / 分栏 / 关闭 / 历史 / 上限 / 重排 / 删除 / 恢复 / 链接行号；位置链接的三种写法、各种畸形、行到块、按名字和 id 找、重名和别的书；侧栏两半的自动分、手动收回被记住、关掉侧栏、按目标显露；宽度的上下限；设置注册表的键唯一和默认值合法、按类型校验；设置文件的分区往返、越界收回、坏文件挪开、改键、恢复默认；快捷键默认值（没有 ⌘S、两个系统都能解析）、改键与清空、录制的可移植写法、冲突；菜单；章节印章和旧版 `sealOf` 一致、颜色按作者存的十六进制读；角落菜单的三种写作状态和 F3 的一致。
- **dr-shell 在 GPUI 测试平台上**（16 个）：按键经键位表到达动作（⌘[ ⌘] ⌘⌥← ⇧⌘] ⌘W ⌘N ⌘⌥2）；Esc 一层一层关，⌘[ 先关 Super View；改键立刻生效、旧键失效、存进文件；侧栏开合；设置生效并在 300 ms 后写盘；退出前跑钩子、写盘；每种状态都画得出来；Super View 盖着时动标签的键不生效。下面 8 个在一个用 dr-testkit 生成的《慢钟》库上跑（每个测试一个临时库）：
  - **M03**：角落 ⋯ 菜单的那两条命令把第一章的写作状态改掉（F3 的事件回来、列表跟着变）、把第二章放进废纸篓（标签关掉）；⌘⇧↩ 进沉浸写作、Esc 回来、再按两次一进一出；
  - **第三个里程碑的验收**（`a_chapter_written_in_the_app_is_kept`）：打开第一章，编辑器拿到键盘；经输入法用的入口打「钟停了。」、按回车（经键位表）、再打「夜里」，F3 存下的段落是「钟停了。」「夜里推开…」；⌘Z（编辑菜单的键，转给编辑器）撤到原样、⌘⇧Z 重做回来；打开第二章再 ⌘[ 回来，还是同一个编辑器、字都在；字数正好多 5、搜索「钟停了」从 0 到 1；走退出流程、关窗、放掉库（核对工作区、编辑器和里面的 `ProseEditor` 都放掉了，库的锁能再拿到），在另一个应用里重开同一个库和设置文件：页面停在第一章，编辑器里字都在，字数和搜索不变；
  - 面板列出 F3 的数据（书名、24 章按阅读顺序、4 条故事线、3 个类目、24 个要素、4 条构想、素材），章节的记号带主故事线的颜色，四个面板都画得出来；
  - 一页在它的编辑器里打开（第一章第一段的文字、标题行是章名）、素材笔记的 H2、通览全书只读页的 24 个章名；
  - **经 F3 把一章放进废纸篓（就像帮手或另一台设备那样），事件从持有者线程到主线程，那一章的标签关掉、列表少一章**；
  - 深链接按 id 打开、编辑器打开后把光标放到 L5 那一段（第三段，行号被取走），文档里的链接按章名经 F3 的目录打开，别的书不跳；
  - 布局按真书的 id 存、记住上次打开的书，新窗口在同一个库上恢复书、标签和页；
  - 退出流程跑 F3 的 `before_quit` 以后库还能用。
- **孤儿检查**（1 个）：清单里每个键都被外壳的代码用到了。

测试平台的调度器只认它自己的线程。用到真库的测试调 `allow_parking()`，让 F3 线程上的事件能叫醒主线程（Zed 自己用到真 I/O 的测试也这样），等事件时最多等 5 秒。

## 和旧版不一样的地方

- **「上下两格」按 workspace.md 做成左右两半。** foundation.md 写的是「宽度够时可以分成上下两格」，但设计规范（workspace.md「Persistence and responsive behavior」）写的是宽度够时分成左右两个半栏、各有一行标签，宽度触发的也只能是左右分。按规范做了。
- **「侧栏推入，用冰曲线」按 motion.md 拆成两种。** 侧栏开合是「结构性开合」420 ms；面板之间切换才是「重冰推进」265 ms。
- **章节面板只有故事线视图（有故事线时）和平铺（没有时）**，旧版的排序菜单、只看主故事线、折叠、行尾字数还没有，是 M-章节面板的事；悬停卡同理。
- **侧栏收起时面板不保活。** 收起后再打开，面板的滚动位置等局部状态从头开始（旧版保活是为了 WebKit 的切换开销，GPUI 没有这个问题，但滚动位置值得保，见「下一步」）。
- **每个打开的标签各有一个编辑器，不是一个编辑器换着章节用。** F4 的接入说明写的是 `ChapterEditor::open` / `switch_to`；外壳只用了 `open`：翻页叠化的 180 ms 里新旧两页要同时画，同一个编辑器画不了两份；各自一个，换回来时光标、滚动和撤销步数都还在。标签关掉就放下它的编辑器（测试核对了关窗以后编辑器和里面的 `ProseEditor` 都放掉了、库能再打开）。
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
   - 编辑器交出来的两样还没有命令接：撤销带回的批注锚点（`ChapterEditorEvent::AnchorsChanged`，要 `comment.reanchor`）和 TODO 标记（`TodoMarkers`，要 `todo.project`），F4 文档「待协调」11 写了细节；外壳在 `workspace/editors.rs` 的 `on_editor_event` 留了 TODO，命令一到就接。
   - 刚生成（或刚导入）的库第一次打开时，后台补建索引会让第一次查询等约 0.5 s（showcase：233 篇文档）。能不能让查询不排在补建后面，或者补建在导入那一步就做掉（M10 的导入也会遇到）。
2. **F2 / M10**：新库放在应用数据目录的 `library/` 子目录里（正式版的数据目录就是 0.1 的，0.1 自己的数据库在它的根上）。这是外壳现在的约定，库的位置最终由 F2 / M10 定，定了改 `app/drifting/src/main.rs` 的 `LIBRARY_DIR` 一处。库打不开时的恢复界面也归 F2 / 首次体验。
3. **F5（dr-ui）**：
   - `PillGroup` 选中的药丸在水波结束、或加载结束时，玻璃要再走一段「收尾」，这段时间仍要帧（真窗口会一直出帧，没问题）。离屏测量时要记得帧与帧之间让任务跑，不然看起来像停不下来（见「测量」）。只是提醒，不用改。
   - **页面上的无框多行输入**（M03 要）：章节标题自动换行、回车进正文，梗概也是几行的字。dr-ui 现在只有单行的玻璃输入框（`TextField`），页面上的标题和梗概要一个没有框、按页面字体排、自动长高的多行输入（组字照 `gpui-ime`）。
4. **F4（编辑器 / dr-editor、gpui-prose）**：
   - **`ChapterEditor::open` 返回 `Result`，却只能在 `cx.new` 里调。** GPUI 建实体的闭包不能失败，外壳现在先在后台线程开好这篇文档的会话（顺便把 SQLite 读取挪出主线程），会话拿着文档时再在 `cx.new` 里开编辑器；理论上只剩持有者线程或库已经关掉时才会失败，那时外壳 `panic`。请给一个不会失败的构造，比如 `ChapterEditor::with_session(session, …)`（接已经开好的 `SessionSource`），或者 `ChapterEditor::open_entity(…) -> Result<Entity<ChapterEditor>>`。
   - **章首、章末挂接点**（M03 要，最要紧）：旧版章节页的页眉（「第 N 章 · 故事线 · 字数」）、可改的标题、梗概、分隔线都在正文上面、跟着正文滚动；章末有 ⁂（标为完成 / 改回草稿、新建下一章）；空章有提示。gpui-prose 的列表里每章只有一个标题行（`Item::Title`，字号 `title_size`、字重写死 BOLD、上边距 56 写死）和段落，宿主放不进自己的东西。建议 `ProseExtension`（或 `ProseEditor`）加两个钩子：章首用宿主给的元素代替标题行、章末追加一个宿主给的元素，都在列表里、跟着滚动、按实际高度量。有了它外壳就能照旧版做页眉和 ⁂。
   - `bind_keys` 用的是 `cmd-`，Windows 上要 `secondary-`（或者移动、删除这些键也交给外壳的注册表）。
   - **标题行不认页边距。** 段落按 `column(可用宽, max_width, gutter)` 排，标题行是 `min(可用宽, max_width)` 居中。外壳把交给编辑器的 `page_width` 设成正文的宽（纸宽减两边 64 px）来对齐，栏比纸宽设置窄时标题仍往左偏一点（1280 宽、两侧栏都开时约 20 px）。建议标题行也用 `column`。
   - **缓存视图会留住祖先的不透明度。** `ProseEditor::element` 是 `cached` 视图，没被通知就重放上一帧，连当时的不透明度一起；放在 F5 的 `PageTurn` 叠化里，编辑器停在头几帧的淡色。外壳在翻页期间每帧通知编辑器重画来绕开（见「测量」）。更好的办法在 F4 或 F5：比如 `PageTurn` 结束时通知子视图，或编辑器在祖先不透明度变了时不复用。
   - 格式键（⌘B、⌘1…）`bind_keys` 和外壳注册表里各有一份，同一个动作同一个上下文，不冲突；以后可以从 `bind_keys` 里删掉。
5. **F7**：首次启动时故障诊断的那一句说明仍属于首次体验；Windows 上 `set_app_identity` 仍等实测。
6. **F8**：外壳的测量证据是 `acceptance/f6-m3-shell-bench.json`，由 `examples/shell-capture.rs --bench` 写；截图和测量的离屏写法可以并进 dr-testkit。`cargo xtask dev` 可以加一个 `--seed <预设>`，把「先生成库再启动」并成一步（现在是两条命令，见「怎么看」）。
7. **监管会话**：
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

## 下一步建议

1. **M03 章节页与稿纸工具栏、M04 章节面板与大纲栏**（这一轮接着做，见各自的小节）。
2. **作品主页、书架、首次体验**：主页现在只有书名；书架（换书、红灯回书架）、首次说明（含故障诊断那一句）、库打不开时的恢复界面一起做。书架做了以后 `DRIFTING_BOOK` 可以删。
3. **面板做全**（M-章节 / M-要素 / M-构想 / M-素材库）：悬停卡、排序、折叠、行尾读数、新建和改名；侧栏收起再打开时保留滚动位置（按「书 × 侧栏 × 半栏 × 标签」存）。
4. **标签坞做完**：和 F5 一起做成组件（小点长成药丸 340 ms、让位、拖离收拢）。
5. **冷启动**：机器空闲时再测一次（`script/bundle-mac && script/measure-startup-mac --runs 9`，以及直接运行可执行文件）；建窗口那 90 ms 里有一部分是运行时编译 Metal 着色器（`runtime_shaders`），发布包预编译以后会少。
6. **Windows 实测**：标题栏药丸、Snap 布局、`set_app_identity`、托盘（M43）。

## 代码位置

| 位置 | 内容 |
| --- | --- |
| `crates/dr-i18n/keys.txt`、`script/sync-locales.py`、`locales/` | 要搬的键、拷贝脚本、拷出来的九种语言和 Windows 覆盖层 |
| `crates/dr-i18n/build.rs`、`src/lib.rs`、`tests/source.rs` | 生成键常量和表、编译期检查；运行时（复数、插值、语言匹配）；和旧版比对 |
| `crates/dr-shell/src/nav/mod.rs`、`nav/location.rs` | 导航模型；位置链接 |
| `crates/dr-shell/src/panes.rs` | 侧栏的一半与两半、宽度上下限 |
| `crates/dr-shell/src/keymap.rs`、`actions.rs`、`menus.rs` | 快捷键注册表；动作；菜单栏（从 P0-A 搬来） |
| `crates/dr-shell/src/settings/` | 注册表（`registry.rs`）、文件（`store.rs`）、面板与搜索（`panel.rs`）、全局与生效（`mod.rs`） |
| `crates/dr-shell/src/notifications.rs`、`quit.rs`、`appearance.rs`、`strings.rs` | 通知中心；退出流程；外观（含 macOS 原生那一侧）；文案全局 |
| `crates/dr-shell/src/book.rs` | 打开的书：F3 列表的快照、一页的正文、F3 目标与外壳目标的对应、`Catalog` 适配 |
| `crates/dr-shell/src/workspace/` | 工作区根（`mod.rs`：状态、读书目、F3 事件、沉浸写作）、每个标签的编辑器（`editors.rs`）、稿纸右下角（`corner.rs`）、窗口边角与拖动区（`chrome.rs`）、侧栏（`sidebar.rs`）、标签坞（`dock.rs`）、稿纸（`stage.rs`）、Super View（`super_view.rs`） |
| `crates/dr-shell/tests/`、`examples/shell-capture.rs` | GPUI 测试平台上的行为测试（含《慢钟》库上的 6 个）、孤儿键检查；离屏截图与测量（写测量证据） |
| `app/drifting/src/main.rs`、`probe.rs`、`check.rs` | 入口：F7 的顺序不变，加上读设置、在线程上开库、装 dr-ui、交给外壳；启动探针多了 `library_opened`、`shell_ready`；开发构建的真窗口自检 `DRIFTING_CHECK` |
