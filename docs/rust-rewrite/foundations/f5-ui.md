# F5 dr-ui：设计系统

2026-11-07 起，分支 `claude/f5-ui-254e54`。代码在 `next/crates/dr-ui`，样张程序是它的 `examples/gallery`，截图在 [f5/](f5/)。

## 一句话

旧客户端的「砂笔 + 素玻璃」搬到了 GPUI 上，做成一个 crate：令牌、字体、两种材料、全部基础组件和三种共享过渡。外壳（F6）和以后所有界面都只从这里取东西，自己不写颜色、字号、时长，也不自己画玻璃。

- **玻璃**按决定 D2 用「遮盖」：GPU 铺上玻璃纹理，再用底色盖住中间，只留一圈边；流动只挪纹理。底下不是平色的地方自动退回均匀细线。
- **砂笔**图标和记号是内嵌在 SVG 里的白色位图，画的时候上色；选中时画出的砂笔框沿路径现画。
- **字体**是构建产物，不进 git：脚本从钉住版本的上游下载、校验、合成，放在被忽略的 `next/.cache/fonts`；正式包把它们拷进 `.app` 的 Resources。中文字形和拉丁字形在同一个字体文件里，界面上任何一个字都不靠系统回退。
- **不操作时一帧都不画**：所有动画都只在动的时候要下一帧，静下来就停。

## 怎么看

在 `next/` 里。第一次先生成字体（要 Python 3 和 fontTools 4.60.1，下载约 95 MB，在这台机器上要 2–5 分钟；之后不用再跑，除非 `provenance.json` 变了）：

```bash
python3 -m pip install fonttools==4.60.1
```

```bash
python3 crates/dr-ui/script/build-fonts.py
```

然后：

```bash
cargo run -p dr-ui --example gallery
```

缺字体时样张不开窗口，直接在终端里说该跑哪条命令、找过哪些位置。

- 顶上一行切换页面（令牌 / 控件 / 浮层 / 砂笔 / 过渡）和外观（浅 / 深）。外观是程序里强制切换的，不改系统设置。
- 控件页右边把同一组玻璃固定在静止、悬停、按下、选中四种状态并排摆着（左边无色、右边故事线颜色），方便对照；左边的控件都能真按。
- 浮层页的「⋯」开关一个真正浮起的菜单，「林岚」那一行停 220 ms 出悬停卡，「删除这本书…」打开对话框，「通知」让通知药丸淡入淡出。
- 砂笔页点一行，砂笔框从记号旁起笔画一圈；「换一组」让读数滑到新长度。
- 过渡页：药丸之间点来点去看水波，左边三个圆钮翻页，右边多选一推动面板。

截图和测量都在离屏模式下跑，不弹窗口，也不需要录屏权限（截完用 `crates/dr-ui/script/shrink-pngs.py <目录>` 压成 256 色，约原来的三分之一）：

```bash
cargo run -p dr-ui --features capture --example gallery -- --capture <目录>
```

```bash
cargo run --release -p dr-ui --features capture --example gallery -- --bench <文件.json>
```

## 截图

都是 2 倍像素、压成了 256 色（16 张共 1.6 MB），内容全是合成的。截图时时钟停住，所以流动和转圈停在某一刻；「过渡进行中」两张是触发后 140 ms（砂笔框是 260 ms）的那一帧。

| 页面 | 浅色 | 深色 |
| --- | --- | --- |
| 令牌 | [tokens-light](f5/tokens-light.png) | [tokens-dark](f5/tokens-dark.png) |
| 控件 | [controls-light](f5/controls-light.png) | [controls-dark](f5/controls-dark.png) |
| 浮层（菜单、悬停卡、空状态、加载、通知） | [floating-light](f5/floating-light.png) | [floating-dark](f5/floating-dark.png) |
| 对话框 | [dialog-light](f5/dialog-light.png) | [dialog-dark](f5/dialog-dark.png) |
| 砂笔（图标、记号、读数） | [sand-light](f5/sand-light.png) | [sand-dark](f5/sand-dark.png) |
| 砂笔框画到一半 | [sand-drawing-light](f5/sand-drawing-light.png) | [sand-drawing-dark](f5/sand-drawing-dark.png) |
| 过渡 | [motion-light](f5/motion-light.png) | [motion-dark](f5/motion-dark.png) |
| 过渡进行中（水波、翻页、推进） | [motion-midway-light](f5/motion-midway-light.png) | [motion-midway-dark](f5/motion-midway-dark.png) |

## 用法

```rust
gpui_platform::application()
    .with_assets(dr_ui::Assets::new())            // 图标、砂笔、玻璃纹理
    .run(|cx| {
        dr_ui::init(cx)?;                         // 注册字体、主题设置、输入框快捷键；缺字体时返回错误
        dr_ui::theme::force_appearance(None, cx); // None = 跟随窗口（系统）
        // …
    });
```

- 应用自己的资源用 `Assets::with_fallback(自己的 AssetSource)` 接在后面。
- `init` 找不到字体时返回 `fonts::FontsMissing`，它的文字就是给人看的说明（跑哪条命令、找过哪里），应用应当显示它并停下，而不是带着系统字体继续。
- 视图里取主题：`let t = dr_ui::Theme::of(window, cx);`，然后 `t.palette.ink(2)`、`t.scale.body`。
- 谁画了一块平色，谁就声明它：`glass::surface(Ground::flat(p.page), div().bg(p.page.solid())…)`。里面所有玻璃和砂笔自动知道自己的底色。

## 组件清单

都在 `dr_ui::components`，除了 `TextField` 是一个实体（`dr_ui::input`），其余都是 `RenderOnce`，拿 id 和几个参数就能用；需要记住状态的（玻璃三态、开关的滑动、水波、悬停卡的计时）各自存在 GPUI 的 keyed state 里，调用方不用管。

| 组件 | 材料与样子 | API 要点 |
| --- | --- | --- |
| `Button` | 主按钮：常驻强调色选中玻璃、强调色字，不填色；次按钮：静止细线；文字按钮：无玻璃，悬停加深字；危险：危险色细线和字 | `Button::new(id, 文字).primary()/.text()/.danger().icon(Icon).small().busy(bool).disabled(bool).full_width().on_click(…)` |
| `IconButton` | 圆形玻璃，28 px、图标 16 px；单独放有静止细线，放在长药丸里静止时看不见，浮起时垫不透明稿纸色 | `.in_tray()/.floating()/.selected(bool)/.tone(Tone::Accent)/.disabled(bool)` |
| `PanelIconButton` | 面板 header 的朴素图标按钮：无玻璃，悬停加深并垫一层桌面色 | `.accent()` 给「新建」 |
| `Switch` | 胶囊玻璃轨道：关时一条细线，开时整条晕上静止的强调色玻璃；圆钮是稿纸色（深色为浅墨），不沾色，180 ms 滑过去 | `Switch::new(id, on).on_change(\|on, w, cx\| …).tint(颜色).disabled(bool)` |
| `ScopeToggle` | 一个永远不变的词，直角；关时细线，开时选中玻璃 | `ScopeToggle::new(id, "当前", on).on_change(…).disabled(bool)` |
| `Chip` | 一组各自独立的开关：等宽字、2 px 圆角，名字前一道故事线砂笔短横（关着时淡到 35%），后面是数量；数量为 0 时字和线都淡一半 | `Chip::new(id, 名字, on).color(颜色).count(n).on_change(…)` |
| `Segmented`（多选一） | 并排几个字，底下一块无圆角的玻璃方块（不透明稿纸底 + 选中玻璃），换选时沿 520 ms 的弹簧滑过去，纹理随滑过的距离流动 | `Segmented::new(id, ["全部","批注","TODO"], i).on_change(…).disabled(bool)` |
| `PillGroup`（药丸组） | 玻璃药丸（静止细线、悬停流动），换选中时选中的晕像一道水波从旧药丸推到新药丸：每跨一颗多 70 ms（最多 4 颗），中途变宽、变淡、边变软，途经的药丸按自己的颜色亮起又退去；新药丸在水波到达前保持细线，到达后自己的晕再晕开 | `PillGroup::new(id, vec![Pill::new("第一章").mark(Kind, 颜色)], i).on_change(…)` |
| `Select`（下拉） | 触发器是一块单行输入框：当前项的记号、名字、末尾一笔折；展开是菜单外壳的列表，与触发器同宽、不窄于 240，当前项中等字重带勾 | `Select::new(id, vec![Choice::new(图标或记号, 名字)], i).on_change(…).disabled(bool)` |
| `Menu` / `MenuItem` | 桌面色不透明底、16 px 圆角、静止细玻璃边、浮起投影；宽 240 / 320 / 420；每行左图标右文字，悬停时这一行沿自己的圆角流出发丝玻璃环，字色不变；分组用 0.5 px 发丝线 | `Menu::new(id).width(MenuWidth::Wide).item(MenuItem::new(id, 图标, 文字).checked(b).danger()).separator(&t).section("写作状态", &t)` |
| `HoverCard` / `CardBody` / `CardAction` | 停 220 ms 出卡，离开有 220 ms 宽限；点对象、所在列表滚动都收起；卡宽 248、一个字号、只有标题加粗；能按的东西在卡底部一行一个，危险项在最后一节 | `HoverCard::new(id, 对象元素, \|w, cx\| CardBody::new(id, 标题).mark(…).count(…).summary(…).section(vec![CardAction…]))` |
| `overlay::float` / `Dialog` | 只有一个浮层层、一个定位函数（见下面的「浮层」）；对话框是直角桌面色、半像素墨线加投影，背后蒙一层桌面色薄雾 | `overlay::float(Place, Layer, 元素)`；`Dialog::new(id, 标题).eyebrow(…).subtitle(…).body(…).action(…).on_close(…)` |
| `NotificationPill` | 浮在工作上的一张不透明稿纸色小片，静止细玻璃线、小圆角；160 ms 上移 3 px 浮入，离开整块淡出 | `NotificationPill::new(id, 文字).icon(Icon).danger().action(Button).shown(bool)` |
| `EmptyState` | 一句平实的话（次级墨、居中、不斜体），上面是缺的那类东西的空心记号或这个地方的淡图标，下面可跟一个文字按钮和「从哪里开始」的快捷键行 | `EmptyState::new(id, 话).mark(Kind)/.icon(Icon).action(Button).hint(动作, 快捷键)` |
| `Loading` / `Progress` | 缺角圆相 0.9 s 一圈，等待超过 240 ms 才出现、再 0.16 s 淡入；块级 20 px 字在下，行内 14 px；进度是 1 px 轨道加 2 px 强调色填充，不知道总量时一小段来回走 | `Loading::new(id).inline().label(…)`；`Progress::new(Some(0.6) / None)` |
| `TextField`（单行输入） | 稿纸色片加静止细玻璃线，悬停流动，光标在里面时是静止的选中玻璃；搜索框前有搜索图标、框尾有等宽读数 | `cx.new(\|cx\| TextField::new(id, window, cx).placeholder(…).icon(Icon::Search))`，订阅 `FieldEvent::{Changed, Submitted, Cancelled, Blurred}` |

### 浮层

旧客户端有四套浮层外壳（悬停卡 `HoverCardShell`、图上点开能展开成编辑器的卡 `EntityCardPopoverShell`、菜单 `AnchoredPopover`、按点位弹出的 `ContextMenuSurface`）加 `Modal`，定位函数四个，共约 2.4k 行。dr-ui 只有一个浮层层和一个定位函数：

- `overlay::float(Place, Layer, 元素)`：用 GPUI 的 `deferred` 画在整个窗口之上（相当于旧版 portal 到 `body`、`position: fixed`），`Layer` 是 `Popover` < `Dialog` < `Notice`。
- `Place` 有三种锚：`Place::Rect { rect, align, gap }`（贴着一个矩形：下方，按起点 / 居中 / 终点对齐，下面放不下就翻到上面）、`Place::Point(点)`（左上角对着这个点，碰到窗口边就往左、往上翻）、`Place::Center`（窗口正中）。不管哪种都留在窗口里 8 px 以内。
- 落在哪里由纯函数 `overlay::place(place, 内容尺寸, 窗口尺寸)` 算，`components/overlay.rs` 的测试守着：下方、翻到上方、贴边、按点翻转、居中。
- 菜单、悬停卡、下拉列表、对话框都走它；以后图上点开的卡（要素全景、故事图谱）用 `Place::Point` 或 `Place::Rect`，能展开成编辑器只是卡里的内容变大，不另起外壳。悬停的停留和宽限沿用 `tokens::motion::dwell`，数值与旧版 `src/renderer/lib/motion.ts` 相同。
- `ContextMenuSurface` 主要是手机长按菜单，新版不做右键菜单，不搬。

### 给设置注册表用的控件约定

设置面板以后由一张声明式注册表驱动（键、类型、默认值、范围、分区、文案键、搜索词），所以取值的控件都是同一个形状，能按类型批量生成：

```rust
控件::new(id, …, 当前值)          // id 直接用设置的键
    .on_change(|新值, window, cx| …)
    .disabled(bool)
```

| 设置的类型 | 控件 | 值的类型 |
| --- | --- | --- |
| 开关 | `Switch` | `bool` |
| 只看当前 / 整个项目这类两态 | `ScopeToggle` | `bool` |
| 不超过 4 个选项的单选 | `Segmented` | `usize`（选项下标） |
| 超过 4 个、或选项是实体 | `Select` | `usize` |
| 一组各自独立的开关 | 每项一个 `Chip` | `bool` |
| 文字 | `TextField`（实体，订阅 `FieldEvent::Changed`，只报告提交后的文字） | `String` |
| 有范围的数值、颜色 | 数值滑块（`GlassSlider`）、色板还没做，见「下一步」 | — |

砂笔与玻璃的底层件（`dr_ui::sand`、`dr_ui::glass`）：

| 件 | 说明 |
| --- | --- |
| `sand::icon(Icon, 尺寸, 颜色)` | 132 个砂笔图标，`Icon` 是编译期枚举（从 `assets/icons/` 生成，测试守着两边一致） |
| `sand::thinking(…)` | 思考的星芒，六帧来回播，每帧 120 ms；停下时是整颗钝头星 |
| `KindMark` | 实体记号：章节圆印（按 id 取六枚之一）、要素方印、故事线短横、类目折角、构想小漩涡（不在分组里更淡）、构想分组、素材纸条、通览全书的强调色星号；空心版给 Preview。出现时从 0.8 倍淡入长大（0.3 s），`.shown(false)` 整块淡出 |
| `SandFrame` | 选中 cell 时画出的砂笔框：从记号旁起笔，60 ms 后沿路径 0.38 s 画完；挂上时已选中的直接显示画好的样子；取消选中整框 0.3 s 淡出。宽度变化时用同一个种子按新尺寸重算，左边不动 |
| `Readout` | 砂笔读数：一笔干笔，长度就是值；短值从笔的起头截取，最后 12 px 变干变细，后面铺一层散砂表示还没写到的部分；淡入 0.24 s，值改变 0.25 s 滑到新长度 |
| `glass::glass_box(id, Kind, Mode, selected, Spec, …)` | 自己做玻璃控件时用：一个带玻璃层、接好悬停和按下的 `div` |
| `glass::surface(Ground, 元素)` | 声明一块平色底，里面的玻璃和砂笔据此遮盖、叠色 |
| `Spec::filled(颜色)` | 自带不透明底的控件（输入框、浮起的按钮、开着的 chip、开关轨道）：中间按自己的底遮盖，圆角外按四周的底补回 |
| 不要给玻璃控件加 `opacity` | GPUI 的透明度乘到每个图元上，盖子一变淡，中间的纹理就透出来；要淡就淡内容和底色 |
| `glass::Kind` | `Hidden`（静止看不见）、`Rest`（静止细线）、`Surface`（卡片和长药丸：按下不加深、照样流动）、`Still`（只读：悬停不变） |
| `glass::Mode` | `primary`（常驻选中）、`waiting`（平时流动、悬停停）、`loading`（深一档、2.4 s 一圈地快流）、`disabled` |

过渡（`dr_ui::transitions`）：

| 件 | 说明 |
| --- | --- |
| `PageTurn` | 稿纸翻页：新页盖在旧页上 180 ms 原地淡入，旧页一直完整地留在下面，盖满才撤；中途再换页，正在淡入的那页停在下面完整显示，下一页从它已有的浓度接着淡入 |
| `Push` | 重冰推进：整块内容被推开、另一块进来，265 ms 先慢后快；新来的一块四边晕出发丝玻璃，落地后 340 ms 淡出；方向按序号左右 |
| 水波 | 在 `PillGroup` 里（见上） |

## 令牌

都是编译期常量，没有按名字查的表（`dr_ui::tokens`）。

- **颜色**（`Palette::LIGHT` / `Palette::DARK`）：桌面、稿纸、侧栏轨道、墨 1–6、发丝线、强调色、危险色、批注色、六种故事线色、无色玻璃、内晕提亮、投影墨和浓度、砂笔浓度与提亮。数值从 `src/styles/index.css`、`materials.css`、`desktop-typography.css` 原样搬来，HSL 在编译期换算成 sRGB，测试拿浏览器的换算结果对过。
- **字号**（`TypeScale`）：五档界面字号（最小 / 较小 / 标准 / 较大 / 最大），默认标准；正文、次要、说明、强调、标题、行高、控件高、列表行高、菜单行都按旧版的「基数 + 档位增量」算。
- **间距与圆角**：圆角只有 1 / 2 / 3 px，16 px 只给菜单、悬停卡和写字的片，菜单行 4 px；圆形玻璃 28 px、图标 16 px、托盘留白 4 px；菜单宽 240 / 320 / 420、悬停卡 248。
- **动效**（`tokens::motion`）：结构性开合 420 ms、重冰推进 265 ms、翻页 180 ms、Dock 药丸 340 ms、浮入 160 ms、推波 1.125 s、弹簧（刚度 150，归一到 520 ms）、玻璃（晕开 0.24 s、退回 0.28 s、按下 40 ms、15 s 流一块纹理、加载时 2.4 s）、水波、砂笔（画 0.38 s、每多一行 0.12 s、淡入淡出 0.3 s、浓度变化 0.24 s）、停留与宽限（悬停卡 220 / 220 ms、滚动静止 180 ms、加载 240 ms）。曲线是 `cubic-bezier` 的四个数，运行时用牛顿法求解；令牌页把五条曲线画出来对照。
- **减少动效**：`ThemeSettings::reduce_motion`（不设就跟 GPUI 的系统值），打开后所有过程直接到位。

## 字体

旧客户端界面用的字体都是 SIL OFL 1.1，可以再分发：

| 角色 | 旧客户端（CSS 字体栈） | 新版的 | 字重 | 每个文件 |
| --- | --- | --- | --- | --- |
| 界面、实体 | Source Sans 3 + Noto Sans SC | **Drifting Sans** | 400 / 500 / 600 | 约 10 MB |
| 结构、正文默认 | Newsreader + Noto Serif SC | **Drifting Serif** | 400 / 700 | 约 14 MB |
| 索引 | Sarasa Mono SC | Sarasa Mono SC（原样） | 400 | 13.4 MB |

为什么要「合成」字体，而不是照 CSS 那样一个字体栈：

- **GPUI 在 macOS 上不能回退到它从内存里载入的字体。** 它的回退列表交给 CoreText，而 CoreText 只认系统里注册过的字体，所以「Source Sans 3，缺字找 Noto Sans SC」这条路在自带字体之间走不通，缺的中文会掉到系统字体上——正是 Zed 已知的那个问题（斜体乱码、非 400 字重回退失败）。
- **GPUI 只在几个静态字面之间挑字重**，可变字体永远画默认那一档。
- 所以每个字族是几个静态字面，每个字面里同时有拉丁和中文字形：拉丁取原来的 Source Sans 3 / Newsreader，其余全部取 Noto，界面上任何一个字都不靠回退。

### 字体是构建产物，不进 git

72 MB 的字体一旦进了公开仓库的历史就删不掉，所以仓库里只有「配方」：

- **钉住的来源**（`next/crates/dr-ui/assets/fonts/provenance.json`，入库）：每个上游文件的地址、SHA-256 和版本。
  - Source Sans 3 3.052、Newsreader 1.003、Noto Sans SC 2.004、Noto Serif SC 2.003：google/fonts 仓库某一个提交（`86aced91`）里的完整可变字体。Noto Serif SC 和旧客户端是同一个版本。
  - Sarasa Mono SC 1.0.43：上游发布页的 `SarasaMonoSC-TTF-Unhinted-1.0.43.7z`，取其中的 Regular，原样使用。它的哈希和旧客户端记下的一致。
  - 还记了每个生成出来的字体文件的 SHA-256。
- **生成脚本**（`next/crates/dr-ui/script/build-fonts.py`，fontTools 4.60.1）做五件事：
  1. 下载并核对哈希，下载过的留在缓存里重用；
  2. 把可变字体在目标字重上切成静态字面（Newsreader 取 16 pt 的光学尺寸，从 2000 缩到 1000 单位）；
  3. 拉丁和中文合并成一个文件，把中文的基线表（BASE）放回去；
  4. 改名，并把时间戳固定，所以同样的输入总得到同样的字节；
  5. 和 `provenance.json` 里记的结果对一遍，对不上就报错。改了某个来源时加 `--update` 重新记录。
- **输出**在 `next/.cache/fonts`，`next/.gitignore` 忽略它。7z 用系统的 `tar`（bsdtar 能读 7z）打开，没有就用 `7z`。本机从零下载、生成过两次，字节完全一致。

### 程序怎么找到字体

`dr_ui::init` 在启动时按顺序找第一个六个字面都在的文件夹：

1. 环境变量 `DRIFTING_FONTS_DIR`；
2. macOS 应用包里的 `Contents/Resources/fonts`；
3. 可执行文件旁边的 `fonts`（以后装好的 Windows 应用）；
4. 在工作区里构建的东西（应用、样张、测试都在 `next/target/` 下）：工作区的 `.cache/fonts`。

找到后把文件映射进内存交给 GPUI：按需读页，启动时不用读 72 MB。一个都找不到时不退回系统字体，而是返回错误。错误的文字写明跑哪条命令、找过哪几个位置。

正式打包时由打包脚本调用 `crates/dr-ui/script/install-fonts <Resources 目录>`，把字体和许可证拷进包里，见「待协调」。

### 许可

合成出来的是 OFL 所说的「修改版」，所以换了名字（不用 Source 这个保留字体名），保留全部上游版权声明，仍按 OFL 1.1 发布（`assets/fonts/OFL-1.1.txt`，和字体一起拷进包里），不并入客户端的 AGPL。旧客户端界面用到的字体都有再分发权，没有因为许可放不进来的。

旧客户端正文默认用系统宋体（`ui-serif`、Songti SC），系统字体不能打包；新版正文默认用 Drifting Serif。作者以后在设置里选系统字体时，按名字显式指定那一款，同样不靠回退。

## 素玻璃怎么画

- **控件玻璃**（`glass/paint.rs` 的 `paint_cover`）：照 P0-D 的乙。纹理（`glass-thick.png`，150 px 一块）包成单色 SVG，GPU 按当前颜色和强度铺满控件；再用底色盖住中间：一块内缩 1 px 的实色留下那条 1 px 的边，一块柔边阴影做内晕的渐隐；圆角外面用四周的底色补回去。流动就是挪纹理的位置。
- **底下不平的地方**（图片、字海、压在正文上的东西）传 `Ground::Uneven`，自动退回丙：均匀 1 px 边加一层内阴影，浓度按纹理平均透明度折算。
- **菜单和悬停卡的边**照旧版的做法：预先着好色的 `glass-ring.png` 铺在一层内缩 1 px 的不透明桌面色下面，露出来的就是一圈细线。
- **浮起的玻璃**（工具条、浮着的侧栏开关、通知药丸）垫不透明的稿纸色。
- **状态**（`glass/state.rs`）：静止细线（强度 0.85、无内晕）→ 悬停 0.24 s 晕开、15 s 流一块纹理 → 按下 40 ms 内强度 ×1.7、内晕 ×1.3 并停止流动 → 松开 0.28 s 退回当时该在的状态；选中和悬停一样亮但静止，悬停也不让它流动；离开时流动停在原处不复位；按下覆盖选中。没有投影、顶边高光或上下不对称的边。
- **取样位置**：小块玻璃固定取纹理上最稠密的那块（-96, -132），大块玻璃在四个位置里轮换，和旧版一样。
- **深色**：内晕往白里提 45%。遮盖法里边和内晕只能用同一种颜色，取两者中间（P0-D 已说明，作者已看过）。

## 单行输入与组字

- 走 GPUI 的 `EntityInputHandler`。组字规则单独放在 `input/compose.rs`（`Composer`），里面没有 GPUI，F4 的编辑器可以直接用同一套。
- **组字期间的内容不提交**：拼音显示在框里（带下划线），但 `text()` 不含它，`FieldEvent::Changed` 只在提交后的文字变了时才发；组字中按回车是输入法的，不会触发提交。
- **失焦不留残局**：焦点离开、切到别的应用时，正在组的字按原样提交（和 AppKit 自己的输入框一样），不会留下一段还在组字状态的拼音。
- 一行就是一行：粘贴和输入法送来的换行都变成空格。按字素簇移动和删除。
- 光标 530 ms 闪一次，只在有焦点时；失焦后计时器停掉。

`tests/field.rs` 用 GPUI 的测试平台验证了这三条：组字中不报告、回车不提交；失焦提交；切换应用提交。真实输入法（系统拼音、搜狗、微信等）要按 [benchmarks.md](../benchmarks.md) 的输入法矩阵人工测，见「待协调」。

## 测量

M3 Pro，release 构建，1280×800 的样张、2 倍屏。帧时间是离屏（Metal 画进纹理）测的「重新渲染 + 排版 + 绘制」一整帧的 CPU 时间，原始数据在 [f5/bench.json](f5/bench.json)，用上面的 `--bench` 重跑。测的时候别的会话在编译（负载 11–56），最大值和 p95 偏高，中位数可信。

| 项 | 结果 | 对照 [benchmarks.md](../benchmarks.md) |
| --- | --- | --- |
| 静止时要的帧 | 五页都是 **0**：没有在动的东西就不出帧；悬停、按下结束以后也回到 0 | 「不操作时 CPU ≈ 0」 |
| 真实窗口静止时的 CPU | **0.0–0.7%**（`top` 每 2 秒一次、共 10 次）；同样条件下 P0-A 的空窗口 0.0–1.3%，这点余量是 GPUI 自己的 | 探针档 ≤ 1% |
| 整页重画一帧 | p50 0.2–0.8 ms（五页），p95 ≤ 1.0 ms | 发布档每帧 8.3 ms |
| 悬停流动 | 每帧 p50 0.95 ms；纹理 15 s 才走一块（每秒 10 px），所以只按约 30 帧/秒重画，约占一个核的 **3%**。快的移动（按下、晕开、水波、加载时 2.4 s 一圈的流动）照常每次刷新都画 | — |
| 按下（40 ms 加深） | 每帧 p50 0.99 ms | — |
| 松开并离开 | 每帧 p50 1.0 ms，0.28 s 后停帧 | — |
| 加载圈和来回走的进度线在转 | 每帧 p50 0.70 ms，每次刷新 | — |
| 找到并注册字体 | 0.9 ms（文件映射进内存，CoreText 按需读页，不在启动时读 72 MB） | 冷启动 ≤ 300 ms |
| 首帧 | 0.7–1.3 ms（离屏，不含开窗口） | — |
| 体积 | 字体不编进可执行文件：样张 release 15.7 MB（P0-A 的空程序 8.9 MB），字体 72 MB 在缓存或应用包的 Resources 里，映射进内存按需读；静止时常驻 82 MB | — |

行为由测试守着：`cargo test -p dr-ui` 跑 44 个测试，其中有浮层定位的 5 个，还有 GPUI 测试平台上的 5 个行为测试——悬停卡 200 ms 时没出、230 ms 时出了，离开后 200 ms 还在、230 ms 走了；滚动收起、指针不动不会重新弹出、真正移动后才弹；单行输入组字中不报告、回车不提交、失焦提交、切应用提交。

## 和旧版不一样的地方

旧版为 WebKit 做的性能补丁一律不搬：避开暂停动画样式税的 `lib/glass-awake.ts`、隐藏常驻的标签页、输入法查询的 `TextInputLookupStop` 之类。新版照它们背后的视觉规格做（玻璃平时静止、悬停才流动），性能问题在 GPUI 上本来就不存在：静止时不出帧。

下面几条是 GPUI 的限制逼出来的，按「最克制」取了做法：

- **玻璃不能整体变淡。** GPUI 的 `opacity` 是乘到每个图元上的，遮盖法的「底色盖子」一变淡，中间的纹理就透出来。所以停用的输入框、开关不再整块变淡，而是字变浅、玻璃退回淡细线；通知药丸淡入淡出的那 0.16–0.3 s 里，边临时换成均匀细线。
- **翻页叠化时新页的字略淡于底色。** 同样因为没有整组透明：新页的底色和字各自按同一浓度画，叠化中途字会比底色稍浅一点，180 ms 内看不出来。
- **水波的软边是阶梯。** 没有渐变遮罩，软边用 5 级不同浓度的竖条拼出来。
- **悬停卡的「滚动收起」**看的是对象自己的位置有没有动：它所在的任何一层滚动了就收起。卡片自己内容滚动时只会重新定位的那条，等有长内容的悬停卡时再做。
- **多选一放不下时收成单个 tab** 还没做，见「下一步」。

## 待协调

- **F4（编辑器）与组字**：`Composer` 的接口（`replace` / `replace_and_mark` / `unmark` / `discard` / `blur`，进出都按 UTF-16，`Change::{None, Composing, Committed}`）建议 F4 直接复用；正文是多行、有格式，F4 需要的是同一套「组字中不提交、失焦提交、回车归输入法」的规则，再加上撤销把整个上屏的词算一步。合并时把 `Composer` 挪到一个两边都能依赖的位置（比如 `gpui-prose` 的输入模块），dr-ui 再依赖它。
- **GPUI 补丁**：GPUI 没有让输入法放弃当前组字的接口（macOS 的 `discardMarkedText`）。现在失焦时我们这边提交了，但输入法自己那边的候选窗状态要靠系统收拾；如果输入法矩阵测出残留，要在 F4 的 GPUI 补丁里加这个接口。
- **GPUI 断行的中文禁则**：截图里悬停卡摘要「旧港」后面的句号被挤到了下一行行首。GPUI `v1.27.0` 的换行没处理行首禁则标点，这一处属于 F4 的排版（正文更需要），dr-ui 的多行文字也会跟着受益。
- **F7（打包）与字体**：`next/script/bundle-mac` 要在拷完可执行文件后调用 `crates/dr-ui/script/install-fonts "$APP/Contents/Resources"`（缺字体时它会报错并说明怎么生成），以后的 Windows 安装包同样把字体放进可执行文件旁边的 `fonts/`。应用现在还没接入 dr-ui，所以 `bundle-mac` 暂时不受影响；F6 接入以后，dev 包也要带上字体，否则从包里启动会报字体缺失（在工作区里 `cargo run` 不受影响）。
- **CI**：`next.yml` 在编译前生成字体并缓存，缓存键是 `provenance.json` 和生成脚本的哈希（每个平台各一份）；测试步骤设了 `DR_UI_REQUIRE_FONTS=1`，字体缺了会让字体检查失败而不是跳过。这一段只能在 GitHub 上跑：本机跑通了同样的命令，Windows 上用 `tar` 还是 `7z` 解 7z 没有实测。
- **F6（外壳）**：应用要在 `Application::with_assets` 里装 `dr_ui::Assets`、启动时调 `dr_ui::init`；外观开关可以直接用 `dr_ui::theme::force_appearance`（P0-A 的 `DRIFTING_APPEARANCE` 走 NSAppearance，那条路照旧，`Theme::of` 读窗口外观）。外壳里画平色的地方要用 `glass::surface` 声明底色。
- **右键**：dr-ui 没有任何右键菜单组件，也没拦截右键。

## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1 | 令牌：颜色、字号、间距、圆角、动效 | 完成 |
| 2 | 字体，中文显式指定 | 完成：构建产物，不进 git；应用包里怎么放见「待协调」 |
| 3 | 组件：按钮、开关、分段、筛选片、药丸与水波、下拉、菜单、悬停卡、浮层与对话框、通知药丸、空状态、加载 | 完成；多选一窄时收起未做 |
| 4 | 单行输入（组字状态机独立） | 完成最小可用版；没有撤销、双击选词、拖拽 |
| 5 | 砂笔：图标着色、记号、画框、读数，出现消失都有过渡 | 完成；类目的九宫格框（`frame-box.png`）留给用到它的视图 |
| 6 | 过渡：翻页叠化、重冰推进、药丸组水波 | 完成 |
| 7 | 样张，浅深色，离屏截图 | 完成 |
| 8 | 测量 | 完成，见上 |

## 下一步建议

1. F6 接入：用 `PageTurn` 翻稿纸、`Push` 推侧栏面板，侧栏 cell 需要的悬停环（`.cell-ring`）可以用 `glass_box` 加 `Spec::rim(3.0)` 做，建议 F6 起头时补进 dr-ui。
2. 补完 `Segmented` 放不下时收成单个 tab、`Select` 多于 8 项时的搜索框、`GlassSlider` 的交接键；给设置注册表补上数值滑块和色板，同样是 `new(id, 值).on_change(…).disabled(…)`。
3. 玻璃控件的键盘焦点（`focus-visible` 与悬停同效）要等 F6 定下焦点和快捷键框架后一起做。
4. 输入法矩阵第 8 项（单行输入）请作者手测：标题、搜索、设置三种框各在系统拼音、搜狗、微信输入法下组字、选中替换、组字中点别处和切应用。

## 代码位置

都在 `next/crates/dr-ui/`：

| 位置 | 内容 |
| --- | --- |
| `src/tokens/` | 颜色（`color.rs`）、字号间距圆角（`metrics.rs`）、动效（`motion.rs`） |
| `src/theme.rs` | 外观、主题设置、强制深浅色 |
| `src/fonts.rs`、`assets/fonts/`（`provenance.json`、`OFL-1.1.txt`）、`script/build-fonts.py`、`script/install-fonts` | 找字体与加载、钉住的来源与许可、生成脚本、拷进应用包 |
| `script/shrink-pngs.py` | 截图压成 256 色 |
| `src/assets.rs`、`assets/icons/`、`assets/sand/`、`assets/glass/` | 资源（从 `src/assets/design/` 拷来，来源见 `ASSET_PROVENANCE.md`）与 `AssetSource` |
| `src/glass/` | 玻璃的状态（`state.rs`）和画法（`paint.rs`），平色底的声明 |
| `src/sand/` | 图标、记号、砂笔框（`stroke.rs` 是旧版 `lib/sand-frame.ts` 的移植）、读数 |
| `src/components/` | 组件 |
| `src/input/` | 组字状态机（`compose.rs`）和单行输入（`field.rs`） |
| `src/transitions.rs` | 翻页、推进 |
| `src/anim.rs` | 补间、截图时冻结时钟、只在动的时候要下一帧 |
| `examples/gallery/` | 样张、离屏截图与测量 |
| `tests/` | 单行输入、悬停卡的行为测试 |
