# F6 dr-shell：外壳（第一个里程碑）

2026-11-07 起，分支 `claude/f6-shell-80c9fb`，从整合分支 `claude/f-batch2-integrate` 开工。代码在 `next/crates/dr-shell`、`next/crates/dr-i18n`，应用入口 `next/app/drifting`。计划见 [foundation.md 的 F6](../foundation.md#f6-dr-shell)。

## 一句话

稿纸四周的那一圈搬到了 GPUI 上：三栏、两侧抽屉、稿纸顶上的标签坞、分栏、Super View 舞台、设置、通知、快捷键、退出流程，外加读旧版九种语言文案的 `dr-i18n`。面板里的内容和编辑器还没接，先用一本合成的「替身书」把导航走通。

最要紧的是三件「只留一份」：

- **「现在打开的是什么」只有一份。** 旧版存在 URL、标签树、选中状态三处，靠 322 行代码来回同步。新版只有一个导航模型：标签树加它自己的历史栈。稿纸上显示哪页、侧栏哪一格画砂笔框、前进后退去哪，都是从它读出来的。
- **快捷键只有一张表。** 所有按键都走 GPUI 的动作和键位表，没有一处直接听按键。默认键位照搬旧版，**没有 ⌘S**（提交即落盘）。旧版设置里列出的 11 个可以改键，改了立刻生效、存进设置文件。
- **设置只有一张表。** 每个设置声明一次：键、类型、默认值、范围（本机 / 账号 / 书）、分区、文案键、搜索词。设置面板、设置搜索、存储时的校验都从这张表生成。

## 怎么看

在 `next/` 里。字体是构建产物（见 [f5-ui.md](f5-ui.md)），缺了先跑 `python3 crates/dr-ui/script/build-fonts.py`。

```bash
cargo run -p drifting
```

在一个 worktree 里想和别的开发实例隔开，加 `DRIFTING_PROFILE=<名字>`（F7）。`DRIFTING_APPEARANCE=dark` 只在这次运行里强制深色，不改设置也不改系统。

截图和测量都在离屏模式下跑，不开窗口、不要录屏权限，内容全是替身书：

```bash
cargo run -p dr-shell --features capture --example shell-capture -- --capture <目录>
```

```bash
cargo run --release -p dr-shell --features capture --example shell-capture -- --bench <文件.json>
```

截图直接写成 256 色的 PNG（和 dr-ui 的 `shrink-pngs.py` 一样的效果，但不需要 Pillow，用的是 GPUI 图像栈里已经有的 `color_quant` 和 `png`），16 张共 2.0 MB。

打包：`script/bundle-mac` 现在会把字体拷进 `.app` 的 `Contents/Resources/fonts`（F5 要求的那一步），缺字体时停下并说明怎么生成。

## 截图

2 倍像素、1280×800、256 色，内容是替身书。截图时时钟停住；「过渡进行中」是触发后 140 ms 的那一帧（右栏面板推进 265 ms、左栏抽屉 420 ms、稿纸翻页 180 ms 同时在走）。离屏截图里没有 macOS 的红绿灯（那是系统画的）。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 日常：左栏章节、右栏素材库、锁住的标签坞（三个标签，林岚是预览） | [workspace-light](f6/workspace-light.png) | [workspace-dark](f6/workspace-dark.png) |
| 两侧收起、标签坞静止成一排记号、稿纸左右分栏 | [split-light](f6/split-light.png) | [split-dark](f6/split-dark.png) |
| 左栏够宽，自动分成两半，各有一行标签 | [halves-light](f6/halves-light.png) | [halves-dark](f6/halves-dark.png) |
| Super View 舞台（要素全景，内容占位） | [super-view-light](f6/super-view-light.png) | [super-view-dark](f6/super-view-dark.png) |
| 设置（从注册表生成：外观、编辑器……） | [settings-light](f6/settings-light.png) | [settings-dark](f6/settings-dark.png) |
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
  - 删了某个对象（以后由 F3 的删除事件触发）用 `forget`：关掉它的标签、从历史里去掉。
  - 存盘时只存标签树和激活的是哪个；恢复时去掉已经不存在的目标，历史从恢复后的那一页重新开始。
- **位置链接**（`nav::location`，照旧版 `location-link.ts`）：认三种写法——文档里的 `drifting:chapters/雨夜/prose.md#L12-L18`、系统转来的 `<协议>://open/<书>/chapters/id-<id>/prose.md#L3`、相对投影目录的 `../../chapters/id-x/prose.md#L5-7`。文档里永远是 `drifting:`；系统那种用本构建注册的协议（开发版 `drifting-next-dev`），所以链接只会落到注册它的那一个程序。解析是纯函数，找对象经一个 `Catalog` trait（现在是替身书实现，以后是 F3 的查询）；名字重复、找不到、别的书，各报各的原因。行号原样交给编辑器（`take_reveal`，用一次就没），换算成块是编辑器的事（第 N 块从第 2N+1 行开始）。
- **系统深链接**：F7 的 `DeepLinks` 在哪个线程收到链接就在哪个线程叫醒我们；`set_waker` 往一个通道里发信号，主线程上的任务收到后把窗口叫到前面、取出 `open/` 开头的链接、逐个打开。窗口开之前就排队的链接，开窗时一并处理。`auth/` 留给登录。

### 3. 布局

- **三栏从窗口顶边贯通到底边**，没有横贯的栏。左右栏、稿纸四周是同一张桌面色；稿纸是唯一抬起的一块（稿纸色、2 px 圆角、稿纸投影）。
- **侧栏像抽屉**：两个侧栏开关固定在窗口两个上角（28 px 圆形玻璃、新月砂笔图标，开着是实心的月牙、收着是空心的；收着时浮在桌面上、垫不透明底色和静止细线），侧栏从它下面滑出、收回，走「结构性开合」420 ms。新布局两侧默认收起，只突出稿纸。
- **宽度**：拖内侧边缘改宽（6 px 宽的把手）；最窄是一行标签的宽度（标签文字现量 + 各 10 px 内边距 + 两端各 6 px，靠窗口边的那一半再加上开关和它的空位）；最宽是窗口的 60%，并且给稿纸留至少 420 px。
- **一半与两半**（`panes`，照旧版 `sidebar-tabs.ts`）：宽到放得下两行标签加一根发丝线，就自动分成两半，右半打开顺序里的下一个标签；点某一半里已选中的标签关掉这一半，只剩一半时再点就收起整个侧栏；宽的时候手动收回一半会被记住（`keep_single`），之后变窄再变宽也不自动分，直到作者按「恢复双栏」；重新分出来的一半从上次关掉的那一边进来。
- **标签**：左栏 章节 / 要素 / 构想，右栏 审阅 / 素材库 / 统计 / 帮手（文案跟界面语言走）。标签字下面是一块玻璃方块，换标签时它和面板一起走「重冰推进」265 ms、同一刻落地；面板本身用 dr-ui 的 `Push` 被整块推开。
- **面板**这一轮是占位：章节、要素、构想、素材库四个面板列出替身书的内容（砂笔记号 + 名字，悬停时一圈发丝玻璃，选中时画砂笔框），单击开预览、双击留下；面板头一行是读数（「2 条故事线 · 6 章」）和全书视图的入口（章节旁是通览全书，要素旁是要素全景，审阅和素材库旁是审阅与素材）。统计面板头的读数直接从导航模型读出当前是什么（「本章 · 详细统计」）。审阅、帮手留空，等各自的模块。
- **左栏底部**是账户一格：名字（现在是「本地」）、作品主页（鸟居）、通知中心（风铃）。
- **稿纸**：当前页是章节时，显示替身书里一段合成的文字（只读），排版直接用编辑器设置里的字号、行距、段间距、段首缩进和纸张宽度，所以这几个设置现在就能看到效果。换页时原地叠化（dr-ui 的 `PageTurn`，180 ms）。

### 4. 标签坞与 Super View 舞台

- **标签坞**在稿纸顶边居中、和红绿灯同一中线。静止时是一排砂笔记号（类型变化处留宽一点的间隔，预览的记号是空心的，分栏是两个相连的记号）；指针移上去（或按了锁）就是一排玻璃药丸：记号 + 名字，当前那颗是静止的选中玻璃，预览的名字是斜体（中文斜体 GPUI 画成正体，见 F4 的 G5）。左端是锁，右端是 `+`（回作品主页，主页露着时 `+` 是选中的）。指针离开 260 ms 后收回成记号。
- 药丸上：单击激活，双击留下预览，中键关掉，悬停时末尾出现一个 ×；分栏药丸的两半各自可点、各自有 ×，关掉一半另一半成为整个标签。
- **拖动**：拖起的药丸是一份静止的副本，带一层浅投影（三处投影之一）。放到另一颗药丸上就占它的位置；拖着的时候稿纸分成左右两半，放到哪半就和当前页分栏、拖来的那页在那一侧。
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
- **控件按类型生成**，照 F5 定的约定：开关 → `Switch`；不超过 4 个选项 → `Segmented`；更多或语言 → `Select`；有范围的数值 → 一减一加两颗圆钮夹着等宽读数（dr-ui 还没有 `GlassSlider`，见「待协调」）。
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

- `⌘Q` 和菜单的「退出」走 `quit::request`：等当前这次派发结束（派发时窗口被借出去了），依次跑 `before_quit` 登记的钩子（以后 F2/F3 的落盘、交接、同步的最后一推），把每个打开的工作区的布局写进设置，写设置文件，最后 `cx.quit()`。
- GPUI 的退出回调（总共只等 200 ms）里**只**调 `CrashReporting::flush(100 ms)`。
- 系统发起的退出（注销、在程序坞里退出）不经过第一步。正文本来就是提交即落盘；设置在改动后 300 ms、布局 500 ms 写盘，所以最多丢这么一小段布局改动。

### 9. 只用 dr-ui

- `Application::with_assets(dr_ui::Assets::new())`，启动调 `dr_ui::init`；缺字体时把它的说明打到终端和日志、退出，不带着系统字体继续。
- 外壳里没有自己的颜色、字号、时长：全是 dr-ui 的令牌、组件和过渡；画平色的地方（桌面、稿纸、设置的两栏、通知面、拖动的药丸）都用 `glass::surface` 声明了底色。
- 有三样东西 dr-ui 现在没有，外壳用 dr-ui 的底层件拼了，建议挪进 dr-ui（见「待协调」）：侧栏标签行（`PanelTabs`）、cell 的悬停环、数值步进。
- 开发包带上了字体（`bundle-mac`）。

### 10. 测试与测量

见下两节。

## 接口

给以后的模块和 F3 / F8：

```rust
// app/drifting/src/main.rs 里的顺序（F7 那几步在前面，没动）
let settings = SettingsFile::open(&dirs.data);                  // 先读：故障诊断的同意要交给 crash::init
let app = application().with_assets(dr_ui::Assets::new());
app.run(|cx| {
    dr_ui::init(cx)?;                                           // 字体、主题设置、输入框键位
    dr_shell::init(ShellInfo { app_name, bundle_id, version, url_scheme, forced_appearance },
                   Services { deep_links, crash_reports }, settings, cx);
    dr_shell::open_workspace(cx, probe::window_opened)?;
});
```

| 模块 | 给谁用 | 主要接口 |
| --- | --- | --- |
| `nav` | 所有要「打开某个东西」的模块 | `Target`、`Navigator::{open(target, Open::PREVIEW / KEEP), open_at(target, lines), promote, activate, cycle, close, close_side, reorder, split_with, focus_side, go_home, back, forward, forget, current, is_selected, page, take_reveal}`、`Navigator::restored` |
| `nav::location` | 帮手回复、正文里的链接、深链接 | `parse(href, scheme) -> Option<LocationLink>`、`resolve(&link, &dyn Catalog) -> Result<(Target, Option<Lines>), LinkError>`、`line_to_block`、`trait Catalog`（F3 实现） |
| `workspace` | 各面板、F8 的调试桥 | `Workspace::{open, open_link, toggle_left, toggle_right, toggle_super_view, open_settings, dismiss, top_layer, layout}`、`with_workspace(cx, f)`、`title_of(book, target, cx)`、`BookLayout` |
| `keymap` | 想加快捷键的模块 | 在 `REGISTRY` 加一行（动作名、默认键、上下文、要不要列进设置）；`apply(&overrides, cx)`、`display(keys, os)`、`portable(keystroke, os)`、`conflict(...)` |
| `settings` | 想加设置的模块、M37 偏好同步、M10 导入映射 | 在 `registry::REGISTRY` 加一项；`Settings::{read(cx), update(cx, \|file\| …), flush(cx), locale(cx)}`；`SettingsFile::{get, bool, str, number, set, reset, is_changed, key_bindings, set_key_binding, layout, set_layout, save}` |
| `notifications` | 同步、分享、整理、Markdown 文件夹、更新 | `Notifications::post(Source::…, 文字, cx)`、`post_at`、`remove`、`clear`、`items`、`unread` |
| `quit` | F2 / F3 / 同步 / 更新 | `quit::before_quit(cx, \|cx\| …)`：退出前要做完的事登记在这里；`quit::request(cx)` |
| `strings` | 所有界面 | `t(cx, key)`、`tf(cx, key, &[("count", &3)])`、`tp(cx, plural_key, n, &[])` |
| `dr_i18n` | 不在 GPUI 里的地方（导出、命令行） | `I18n::new(Locale, Platform)`、`.t / .fmt / .plural / .contains`、`Locale::{ALL, code, native_name, match_tag, detect, from_system}`、`keys::…` |

## 测量

M3 Pro，release 构建。离屏的帧时间是「重新渲染 + 排版 + 绘制」一整帧的 CPU 时间，1280×800、2 倍屏，内容是替身书，原始数据 [f6/bench.json](f6/bench.json)，用上面的 `--bench` 重跑。**测的时候别的会话在编译，一分钟负载 约 24**，长尾偏高，中位数可信。

| 项 | 结果 | 对照 [benchmarks.md](../benchmarks.md) |
| --- | --- | --- |
| 冷启动到外壳首帧，直接运行可执行文件（负载约 20，7 次） | 中位数 **353 ms**（最短 276 ms）：其中进程启动到 AppKit 就绪 164 ms 是系统和 GPUI 的，就绪到首帧 147 ms 是外壳的（读设置、装字体和键位、建工作区 110 ms，第一次排版和绘制 39 ms） | 发布档「冷启动到书架」≤ 300 ms，从可执行文件开始运行算起：**超了，要在空闲时重测**。P0-A 的空窗口在负载 6–8 时是 242–315 ms，同样条件下外壳自己那一段约多 50–60 ms |
| 同上，经 `open` 启动（`script/measure-startup-mac --runs 7`，负载 46） | 中位数 1165 ms（`open` 到首帧），进程里 main 到首帧 1079 ms | 负载太高，只作记录；Launch Services 那一段不计入预算 |
| 日常布局静止时要的帧 | **0**：没有在动的东西就不出帧 | 「不操作时 CPU ≈ 0」 |
| 日常布局整页重画一帧 | p50 0.44 ms、p95 0.55 ms、最大 0.67 ms | 发布档每帧 8.3 ms |
| 切标签（翻页叠化进行中的每一帧） | p50 0.99 ms、p95 3.2 ms、最大 4.3 ms；新页在切换的那一帧就有，叠化结束后不再要帧 | 发布档：1 帧 / ≤ 50 ms |
| 侧栏推入、收起（420 ms 每一帧） | p50 0.71 ms、p95 1.7 ms、最大 2.8 ms；结束后不再要帧 | 发布档：不掉帧 |
| 侧栏面板推进（265 ms） | p50 0.52 ms、p95 1.5 ms、最大 3.0 ms | — |
| Super View 首开 | p50 1.1 ms、最大 3.4 ms | 发布档：最差帧 ≤ 100 ms |
| 设置首开 | p50 1.4 ms、最大 1.6 ms | — |

## 测试

`cargo test -p dr-i18n -p dr-shell` 跑 51 个测试：

- **dr-i18n**（9 个）：每种语言每个键都有字、Windows 覆盖层、插值、按 CLDR 选复数形（英语、法语、日语、巴西葡语）、`indent_one` 这种不是复数、语言标签匹配、搜索的规整；拷贝和旧版逐条一致；文档里的例子。构建本身就是那几条编译期检查。
- **dr-shell 单元**（31 个）：导航模型的预览 / 留下 / 分栏 / 关闭 / 历史 / 上限 / 重排 / 删除 / 恢复 / 链接行号；位置链接的三种写法、各种畸形、行到块、按名字和 id 找、重名和别的书；侧栏两半的自动分、手动收回被记住、关掉侧栏、按目标显露；宽度的上下限；设置注册表的键唯一和默认值合法、按类型校验；设置文件的分区往返、越界收回、坏文件挪开、改键、恢复默认；快捷键默认值（没有 ⌘S、两个系统都能解析）、改键与清空、录制的可移植写法、冲突；菜单。
- **dr-shell 在 GPUI 测试平台上**（10 个）：按键经键位表到达动作（⌘[ ⌘] ⌘⌥← ⇧⌘] ⌘W ⌘N ⌘⌥2）；Esc 一层一层关（通知 → 设置 → Super View），⌘[ 先关 Super View；改键立刻生效、旧键失效、存进文件；侧栏开合；深链接在主线程打开对应的页和行、文档里的链接按名字打开、别的书不跳；布局按书存下、新窗口恢复；设置生效（深色、字号、语言换成英语后右栏是「Agent」）并在 300 ms 后写盘；退出前跑钩子、写盘；每种状态都画得出来；Super View 盖着时动标签的键不生效。
- **孤儿检查**（1 个）：清单里每个键都被外壳的代码用到了。

## 和旧版不一样的地方

- **「上下两格」按 workspace.md 做成左右两半。** foundation.md 写的是「宽度够时可以分成上下两格」，但设计规范（workspace.md「Persistence and responsive behavior」）写的是宽度够时分成左右两个半栏、各有一行标签，宽度触发的也只能是左右分。按规范做了。
- **「侧栏推入，用冰曲线」按 motion.md 拆成两种。** 侧栏开合是「结构性开合」420 ms；面板之间切换才是「重冰推进」265 ms。
- **侧栏收起时面板不保活。** 收起后再打开，面板的滚动位置等局部状态从头开始（旧版保活是为了 WebKit 的切换开销，GPUI 没有这个问题，但滚动位置值得保，见「下一步」）。
- **标签坞的「小点长成药丸」动画、拖拽时的弹簧跟手和让位、拖离药丸行时原位收拢没有做。** 现在是记号和药丸直接切换，拖着的是 GPUI 自己的拖动副本（跟手、不落后）。药丸的水波也没有（`PillGroup` 有水波但不能拖，见「待协调」）。
- **菜单仍是英文。** P0-A 的坑 6：GPUI 只把标题恰好是「Window」的菜单当窗口菜单，翻译了窗口列表就没了。
- **没有工具提示。** 旧版图标按钮的 title 提示没搬（规范不让自己加提示句），开关、窗口按钮、通知的 × 只给读屏软件标了名字（`aria_label`）。
- **账户 cell 只有「本地」**：账号（M35）、字数（M07）还没有。

## 已知限制

- 面板内容、编辑器、帮手、时间线、沉浸写作、查找、全局搜索、书架都还没有：对应的快捷键已经绑好、动作已经注册，按下去现在只记一行调试日志。
- 稿纸是只读的替身文字；中文禁则（句号落到行首）是 GPUI 的换行，等 F4 的排版。
- 离屏截图里没有红绿灯；Windows 的标题栏按钮只编译过，没在 Windows 上跑。
- 测试平台的调度器只允许它自己的线程，所以「深链接从别的线程叫醒主线程」那一段只在真程序里走到，测试里是在测试线程上推的。

## 待协调

1. **F5（dr-ui）**——建议挪进 dr-ui 的三样，外壳现在用 dr-ui 的底层件拼的：
   - `PanelTabs`（`workspace/panel_tabs.rs`）：和 `Segmented` 一样的玻璃方块，但走「重冰推进」265 ms，而且点已选中的那一项也要回调（关掉这一半）。可以给 `Segmented` 加 `.motion(PUSH)` 和 `.report_selected()`。
   - cell 的悬停环：`glass_box(Kind::Hidden, Spec::new(tone, 2).rim(3))` 加 `SandFrame`，F5 文档「下一步」第 1 条已经提过。
   - 数值滑块 `GlassSlider`：设置里的字号、行距、段间距、纸张宽度现在是一减一加两颗圆钮。
   - 另外：`IconButton` / `PanelIconButton` 需要 `.label(文字)` 给读屏软件（现在外壳在外面包一层 `div` 标）；`tokens::motion::dwell` 缺标签坞收回的 260 ms（`DOCK_COLLAPSE_DELAY`，现在写在 `workspace/mod.rs`）；`PillGroup` 要能拖（每颗药丸的 `on_drag` / `on_drop`），标签坞才能用上水波；标签坞本身（小点长成药丸、拖动的弹簧）可以整个做成 dr-ui 的一个组件。
2. **F3（dr-workspace）**：
   - 实现 `nav::location::Catalog`（按组和名字 / id 找对象），替身书 `stand_in.rs` 就可以删了；面板的数据也从 F3 的查询来。
   - 删除（进回收站）事件来了，外壳调 `Navigator::forget` 关掉对应的标签（simplifications.md「合成一份」第一行说的「关掉标签由 F6 订阅删除事件来做」）。
   - 退出前要落盘、交接的，用 `quit::before_quit` 登记。
3. **F4（编辑器）**：
   - 键位：格式类 8 个（`prose_editor::ToggleBold` 等）已经由外壳的注册表绑在 `ProseEditor` 上下文里，名字没变；接入以后 `gpui_prose::bind_keys` 里这 8 个可以去掉（留着也只是重复绑定，不冲突）。移动、删除类仍由 `gpui-prose` 绑。
   - 编辑器要处理 `edit::{Undo, Redo, Cut, Copy, Paste, SelectAll}`（菜单走它们，P0-A）。注意 GPUI 里不带上下文的键位优先级最高，`⌘Z` 会先派发 `edit::Undo`，编辑器不处理才轮到 `prose_editor::Undo`。
   - 位置链接的行号：打开页面后调 `Navigator::take_reveal(target)` 取一次，按「第 N 块从第 2N+1 行开始」滚过去。
   - 编辑器设置（字号、行距、段间距、纸张宽度、段首缩进、打字机模式、自动沉浸）从 `Settings::read(cx)` 读，键名见 `settings::registry`。
4. **F7**：故障诊断的同意开关做好了（默认开，设置 → 隐私）；**首次启动时那一句说明**（旧版 `preAlphaGuide.crashReports`，F7 要求加一句「原生崩溃会带上崩溃时程序内存里的一小段」）属于首次体验（M-首次体验），这一轮没做。Windows 上 `set_app_identity` 也还没调（等 Windows 实测）。更新界面（M42）可以用 `Notifications::post(Source::Update, …)` 和设置的「更新」一节。
5. **F8**：调试桥可以直接调 `with_workspace` 和 `Workspace` 的公开方法；截图和测量的写法见 `examples/shell-capture.rs`，以后并进 `dr-testkit`。启动器给每个 worktree 设 `DRIFTING_PROFILE` 以后，设置文件也就分开了。
6. **监管会话**：
   - 菜单本地化要先给 GPUI 打个小补丁（按位置而不是按「Window」这个标题认窗口菜单），这一轮菜单保持英文。
   - `next/README.md` 的开发开关表可以加 `DRIFTING_APPEARANCE` 现在的含义（只强制这一次运行，不写设置），我没改那个文件。
   - `progress.md` 的 F6 一行等合并时更新。

## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1 | dr-i18n：九种语言、复数、插值、编译期检查、Windows 覆盖层 | 完成 |
| 2 | 窗口与导航：一个导航模型、位置链接、深链接 | 完成 |
| 3 | 布局：三栏、抽屉、两半、左右栏标签、占位面板、只读稿纸 | 完成；面板内容占位 |
| 4 | 标签坞与 Super View 舞台 | 完成主体；小点长成药丸、弹簧拖动、水波未做 |
| 5 | 快捷键注册表、改键、默认键位（无 ⌘S） | 完成 |
| 6 | 设置注册表、文件存储、面板与搜索、按书的本机布局 | 完成；外观、语言、编辑器、隐私为真实分区 |
| 7 | 通知中心，崩溃跟进接 `take_follow_up` | 完成；其余来源占位 |
| 8 | 退出流程 | 完成 |
| 9 | 只用 dr-ui，开发包带字体 | 完成；三样组件建议挪进 dr-ui |
| 10 | 测试、截图、测量 | 完成 |

## 下一步建议

1. **接 F3**：替身书换成真查询（面板内容、`Catalog`、删除事件），这时外壳就能打开真书。
2. **接编辑器（F4e / dr-editor）**：稿纸换成编辑器，`take_reveal` 接到滚动，格式快捷键和编辑菜单接通。
3. **标签坞做完**：和 F5 一起把它做成组件（小点长成药丸 340 ms、弹簧跟手和让位、拖离收拢、水波），同时把 `PanelTabs` 和 cell 环挪进 dr-ui。
4. **侧栏面板保活**：收起、切走再回来时保留滚动位置和局部状态（按「书 × 侧栏 × 半栏 × 标签」存，workspace.md 有规则）。
5. **作品主页、书架、首次体验**：主页现在只是书名；书架和关窗回书架（红灯）、首次说明（含故障诊断那一句）一起做。
6. **冷启动**：机器空闲时重测（`script/bundle-mac && script/measure-startup-mac --runs 9`，以及直接运行可执行文件）。仍超 300 ms 的话，先看外壳那 110 ms：启动时整张键位表清空重绑一遍并重建菜单、首帧现量两侧标签的宽度、读设置和建语言规则；必要时先画出窗口再装其余。
7. **Windows 实测**：标题栏药丸、Snap 布局、`set_app_identity`、托盘（M43）。

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
| `crates/dr-shell/src/workspace/` | 工作区根（`mod.rs`）、窗口边角与拖动区（`chrome.rs`）、侧栏（`sidebar.rs`）、标签行（`panel_tabs.rs`）、标签坞（`dock.rs`）、稿纸（`stage.rs`）、Super View（`super_view.rs`） |
| `crates/dr-shell/src/stand_in.rs` | 替身书（合成内容），F3 接上后删 |
| `crates/dr-shell/tests/`、`examples/shell-capture.rs` | GPUI 测试平台上的行为测试、孤儿键检查；离屏截图与测量 |
| `app/drifting/src/main.rs` | 入口：F7 的顺序不变，加上读设置、装 dr-ui、交给外壳；P0-A 的占位窗口、标题栏、菜单、外观模块已删（搬进了 dr-shell） |
