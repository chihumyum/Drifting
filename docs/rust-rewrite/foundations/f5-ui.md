# F5 dr-ui：设计系统

2026-11-07 起，分支 `claude/f5-ui-254e54`。代码在 `next/crates/dr-ui`，样张程序是它的 `examples/gallery`，截图在 [f5/](f5/)。第二个里程碑（同日）把 F6 外壳用底层件拼的几样收了进来：Panel Tab 用的推进版多选一、cell 的悬停环、数值滑块和数字框、图标按钮的读屏名字、能拖的药丸组。

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
- 控件页右边把同一组玻璃固定在静止、悬停、按下、选中四种状态并排摆着（左边无色、右边故事线颜色），方便对照；下面是设置里的四个数值（字号、行距、段间距、纸张宽度，范围照外壳的设置注册表）和一行停用的，滑块和数字框联动。左边的控件都能真按。
- 浮层页的「⋯」开关一个真正浮起的菜单，「林岚」那一行停 220 ms 出悬停卡，「删除这本书…」打开对话框，「通知」让通知药丸淡入淡出。
- 砂笔页的几行是 `SandCell`：指着出一圈取自身颜色的流动细玻璃，点一行，砂笔框从记号旁起笔画一圈；「未归属」打不开，没有环。「换一组」让读数滑到新长度。
- 过渡页：药丸之间点来点去看水波，药丸可以拖到别的药丸上换位置（第六章是预览：空心记号）；左边三个圆钮翻页，右边是侧栏的 Panel Tab：方块跟着面板一起推进，再点一次当前的标签收起面板。

截图和测量都在离屏模式下跑，不弹窗口，也不需要录屏权限（截完用 `crates/dr-ui/script/shrink-pngs.py <目录>` 压成 256 色，约原来的五分之一）：

```bash
cargo run -p dr-ui --features capture --example gallery -- --capture <目录>
```

```bash
cargo run --release -p dr-ui --features capture --example gallery -- --bench <文件.json>
```

## 截图

都是 2 倍像素、压成了 256 色（18 张共 1.1 MB），内容全是合成的。截图时时钟停住，所以流动和转圈停在某一刻；「过渡进行中」两张是触发后 140 ms（砂笔框是 260 ms）的那一帧；控件页截图时指针停在「字号」的圆钮上，所以它周围有一圈圆玻璃。

256 色的调色板用八叉树取，不用中位切分：上一轮用中位切分，调色板几乎全花在桌面和稿纸的灰上，几像素宽的故事线颜色（紫、绿、黄）被并成了同一种蓝，上一轮截图里的章节记号和筛选片颜色是错的。这一轮全部重截。

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
| 拿在手里的药丸（拿起 150 ms 后，副本还在追指针） | [motion-drag-light](f5/motion-drag-light.png) | [motion-drag-dark](f5/motion-drag-dark.png) |

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
| `IconButton` | 圆形玻璃，28 px、图标 16 px；单独放有静止细线，放在长药丸里静止时看不见，浮起时垫不透明稿纸色 | `.in_tray()/.floating()/.selected(bool)/.tone(Tone::Accent)/.disabled(bool).label(文字)`；`label` 只给读屏软件（无障碍树里是叫这个名字的按钮），不画出来 |
| `PanelIconButton` | 面板 header 的朴素图标按钮：无玻璃，悬停加深并垫一层桌面色 | `.accent()` 给「新建」，`.label(文字)` 同上 |
| `Switch` | 胶囊玻璃轨道：关时一条细线，开时整条晕上静止的强调色玻璃；圆钮是稿纸色（深色为浅墨），不沾色，180 ms 滑过去 | `Switch::new(id, on).on_change(\|on, w, cx\| …).tint(颜色).disabled(bool)` |
| `ScopeToggle` | 一个永远不变的词，直角；关时细线，开时选中玻璃 | `ScopeToggle::new(id, "当前", on).on_change(…).disabled(bool)` |
| `Chip` | 一组各自独立的开关：等宽字、2 px 圆角，名字前一道故事线砂笔短横（关着时淡到 35%），后面是数量；数量为 0 时字和线都淡一半 | `Chip::new(id, 名字, on).color(颜色).count(n).on_change(…)` |
| `Segmented`（多选一，旧版的 `GlassSlider`） | 并排几个字，底下一块无圆角的玻璃方块（不透明稿纸底 + 选中玻璃），换选时沿 520 ms 的弹簧滑过去，纹理随滑过的距离流动。侧栏的 Panel Tab 是同一块方块：跟着面板走 265 ms 的重冰推进、同一刻落地，点当前的标签也回调（收起这一半），字用结构字、`label` 字号 | `Segmented::new(id, ["全部","批注","TODO"], i).on_change(…).disabled(bool)`；Panel Tab 加 `.motion(motion::PUSH).report_selected().font(Role::Structure).text_size(scale.label)` |
| `PillGroup`（药丸组） | 玻璃药丸（静止细线、悬停流动），换选中时选中的晕像一道水波从旧药丸推到新药丸：每跨一颗多 70 ms（最多 4 颗），中途变宽、变淡、边变软，途经的药丸按自己的颜色亮起又退去；新药丸在水波到达前保持细线，到达后自己的晕再晕开。药丸能拖：手里是一份静止的副本（稿纸底、选中玻璃、不加阴影），按刚度 150 的临界阻尼弹簧略落后地跟着指针、不越过它；放到另一颗药丸上回调。拖动换序后选中跟着那颗药丸走，不推水波 | `PillGroup::new(id, vec![Pill::new("第一章").mark(Kind, 颜色).preview(b).loading(b).key(…).content(…)], i).on_change(…).draggable(\|i\| 载荷, \|载荷, 落到第几颗, w, cx\| …).map_pill(\|i, pill, 元素\| 元素.on_mouse_up(…))`。载荷是 GPUI 的拖动值，稿纸左右半边这类别处的落点用 `on_drop::<载荷>` 也接得到；`map_pill` 给每颗药丸加组件自己不管的事件（双击固定预览、中键关闭） |
| `SandCell`（列表 cell） | 侧栏的章节、要素、故事线，统计的跳转行，时间线泳道名：不垫底；指着时沿四边出一圈发丝流动玻璃（取自身颜色与无色玻璃各半），没有按下态；选中时环退去，砂笔从记号旁起笔绕它画一圈；打不开的行没有环 | `SandCell::new(id, 名字).mark(Kind).color(颜色).hollow(b).font(Role::Structure).italic(b).selected(b).disabled(b).on_click(\|e, w, cx\| …)`，后面还能 `.child(…)` 放数量这类尾巴；`e.click_count()` 分单击、双击 |
| `Range`（数值滑块，旧版的 `GlassRange`） | 1 px 发丝轨，走过的部分是 2 px 墨线；圆钮就是 Switch 的圆钮；指着、拖着、键盘焦点在上面时，圆钮周围晕出一圈 24 px 的圆形玻璃并流动，拖住时加深。点轨道任一处跳过去、拖着走（拖出轨道两端停在端点）；方向键一格、Page Up / Down 十分之一、Home / End 到头。读屏软件看到的是带值和上下限的滑块，能增减 | `Range::new(id, 值, 最小, 最大).step(0.05).label(名字).wide().on_change(\|值, w, cx\| …).disabled(b)`，回调的值已经落在格上 |
| `NumberField`（数字框） | 滑块旁边的小号等宽单行输入框，单位作为读数写在框尾，框里上下两枚平面细笔折微调；停用时连同笔折一起停用 | `NumberField::new(id, 值, 最小, 最大).decimals(2).unit("px").label(名字).on_change(…).disabled(b)`。打字时只有在范围内的数才立即预览；回车或离开时越界的收回到端点、不是数就恢复原值；↑↓ 和笔折按最后一位（整数为 1）加减 |
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
| 有范围的数值 | `Range` 加旁边的 `NumberField`，两个用同一个值、同一个回调（`step` 给滑块，`decimals` 给数字框，单位写在数字框尾） | `f64` |
| 颜色 | 色板还没做，见「下一步」 | — |

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
- **字号**（`TypeScale`）：五档界面字号（最小 / 较小 / 标准 / 较大 / 最大），默认标准；正文、次要、说明、强调、标题、行高、控件高、列表行高、菜单行都按旧版的「基数 + 档位增量」算。`label` 是侧栏 Panel Tab 的字号：小 / 标准 / 大分别 11.5 / 13 / 15 px（workspace.md）。
- **间距与圆角**：圆角只有 1 / 2 / 3 px，16 px 只给菜单、悬停卡和写字的片，菜单行 4 px；圆形玻璃 28 px、图标 16 px、托盘留白 4 px；菜单宽 240 / 320 / 420、悬停卡 248。
- **动效**（`tokens::motion`）：结构性开合 420 ms、重冰推进 265 ms、翻页 180 ms、Dock 药丸 340 ms、浮入 160 ms、推波 1.125 s、弹簧（刚度 150，归一到 520 ms）、玻璃（晕开 0.24 s、退回 0.28 s、按下 40 ms、15 s 流一块纹理、加载时 2.4 s）、水波、砂笔（画 0.38 s、每多一行 0.12 s、淡入淡出 0.3 s、浓度变化 0.24 s）、停留与宽限（悬停卡 220 / 220 ms、滚动静止 180 ms、加载 240 ms、指针离开后标签坞收回小点 260 ms 即 `dwell::DOCK_COLLAPSE`）。曲线是 `cubic-bezier` 的四个数，运行时用牛顿法求解；令牌页把五条曲线画出来对照。
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

打包时由打包脚本调用 `crates/dr-ui/script/install-fonts <Resources 目录>`，把字体和许可证拷进包里；`bundle-mac` 已经这样做了。

### 许可

合成出来的是 OFL 所说的「修改版」，所以换了名字（不用 Source 这个保留字体名），保留全部上游版权声明，仍按 OFL 1.1 发布（`assets/fonts/OFL-1.1.txt`，和字体一起拷进包里），不并入客户端的 AGPL。旧客户端界面用到的字体都有再分发权，没有因为许可放不进来的。

旧客户端正文默认用系统宋体（`ui-serif`、Songti SC），系统字体不能打包；新版正文默认用 Drifting Serif。作者以后在设置里选系统字体时，按名字显式指定那一款，同样不靠回退。

## 素玻璃怎么画

- **控件玻璃**（`glass/paint.rs` 的 `paint_cover`）：照 P0-D 的乙。纹理（`glass-thick.png`，150 px 一块）包成单色 SVG，GPU 按当前颜色和强度铺满控件；再用底色盖住中间：一块内缩 1 px 的实色留下那条 1 px 的边，一块柔边阴影做内晕的渐隐；圆角外面用四周的底色补回去。流动就是挪纹理的位置。
- **底下不平的地方**（图片、字海、压在正文上的东西）传 `Ground::Uneven`，自动退回丙：均匀 1 px 边加一层内阴影，浓度按纹理平均透明度折算。
- **菜单和悬停卡的边**照旧版的做法：预先着好色的 `glass-ring.png` 铺在一层内缩 1 px 的不透明桌面色下面，露出来的就是一圈细线。纹理按 150 px 一块平铺，GPUI 会把一块图的圆角压到这块宽高的一半以内，所以平铺的网格挪到离原点最近、又不落在四边各 32 px 带子里的位置，每个 16 px 的圆角都整个落在一块里。上一轮没这样做，网格线碰巧落在角附近时，悬停卡右下角圆角外会露出一小块方角（上一轮的浮层截图里有）。
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

M3 Pro，release 构建，1280×800 的样张、2 倍屏。帧时间是离屏（Metal 画进纹理）测的「重新渲染 + 排版 + 绘制」一整帧的 CPU 时间，原始数据在 [f5/bench.json](f5/bench.json)，用上面的 `--bench` 重跑。第二个里程碑重测（控件页多了五组数值、砂笔页换成 `SandCell`），测的时候别的会话在编译（一分钟负载约 10）；同一时段另一次跑到负载高峰，悬停那一项中位数跳到 11 ms，重跑两次都回到 1.3–1.4 ms，记的是安静的那次。

| 项 | 结果 | 对照 [benchmarks.md](../benchmarks.md) |
| --- | --- | --- |
| 静止时要的帧 | 五页都是 **0**：没有在动的东西就不出帧；悬停、按下结束以后也回到 0 | 「不操作时 CPU ≈ 0」 |
| 真实窗口静止时的 CPU | **0.0%**（停在控件页，`top` 每 2 秒一次、共 11 次，窗口测完关掉）；上一轮 0.0–0.7%，P0-A 的空窗口 0.0–1.3% | 探针档 ≤ 1% |
| 整页重画一帧 | p50 0.24–0.95 ms（五页，控件页最重），p95 ≤ 1.1 ms | 发布档每帧 8.3 ms |
| 悬停流动 | 每帧 p50 1.3 ms；纹理 15 s 才走一块（每秒 10 px），所以只按约 30 帧/秒重画，约占一个核的 **4%**（上一轮 3%：控件页内容多了，整页重画跟着重了）。快的移动（按下、晕开、水波、加载时 2.4 s 一圈的流动）照常每次刷新都画 | — |
| 按下（40 ms 加深） | 每帧 p50 1.3 ms | — |
| 松开并离开 | 每帧 p50 1.3 ms，0.28 s 后停帧 | — |
| 加载圈和来回走的进度线在转 | 每帧 p50 0.71 ms，每次刷新 | — |
| 找到并注册字体 | 0.9 ms（文件映射进内存，CoreText 按需读页，不在启动时读 72 MB） | 冷启动 ≤ 300 ms |
| 首帧 | 1.2 ms（离屏，不含开窗口） | — |
| 体积 | 字体不编进可执行文件：样张 release 15.7 MB（P0-A 的空程序 8.9 MB），字体 72 MB 在缓存或应用包的 Resources 里，映射进内存按需读；静止时常驻 68 MB | — |

行为由测试守着：`cargo test -p dr-ui` 跑 55 个测试。单元测试 46 个，其中有浮层定位的 5 个、滑块和数字框的取整与读写 3 个、Panel Tab 的推进时长和手里药丸的弹簧 2 个、菜单圆角不跨两块纹理 1 个。GPUI 测试平台上的行为测试 9 个：
- 悬停卡 200 ms 时没出、230 ms 时出了，离开后 200 ms 还在、230 ms 走了；滚动收起、指针不动不会重新弹出、真正移动后才弹；
- 单行输入组字中不报告、回车不提交、失焦提交、切应用提交；
- 点当前的 Panel Tab 只有 `report_selected` 时才回调；
- 滑块按下跳到指针处、拖出两端停在端点、松手后不再跟、方向键和 End 生效、到头再按不算改变；
- 数字框打「2」不预览、打成「24」预览、越界不预览而回车收回到 28、↓ 减一、乱打后离开保持原值；
- 药丸拖到另一颗上换位。

## 和旧版不一样的地方

旧版为 WebKit 做的性能补丁一律不搬：避开暂停动画样式税的 `lib/glass-awake.ts`、隐藏常驻的标签页、输入法查询的 `TextInputLookupStop` 之类。新版照它们背后的视觉规格做（玻璃平时静止、悬停才流动），性能问题在 GPUI 上本来就不存在：静止时不出帧。

下面几条是 GPUI 的限制逼出来的，按「最克制」取了做法：

- **玻璃不能整体变淡。** GPUI 的 `opacity` 是乘到每个图元上的，遮盖法的「底色盖子」一变淡，中间的纹理就透出来。所以停用的输入框、开关不再整块变淡，而是字变浅、玻璃退回淡细线；通知药丸淡入淡出的那 0.16–0.3 s 里，边临时换成均匀细线。
- **翻页叠化时新页的字略淡于底色。** 同样因为没有整组透明：新页的底色和字各自按同一浓度画，叠化中途字会比底色稍浅一点，180 ms 内看不出来。
- **水波的软边是阶梯。** 没有渐变遮罩，软边用 5 级不同浓度的竖条拼出来。
- **悬停卡的「滚动收起」**看的是对象自己的位置有没有动：它所在的任何一层滚动了就收起。卡片自己内容滚动时只会重新定位的那条，等有长内容的悬停卡时再做。
- **多选一放不下时收成单个 tab** 还没做，见「下一步」。
- **拖着的药丸不加阴影，其余药丸不让位。** 旧版拖动时手里是一份静止的药丸副本按弹簧跟手，这一份照做了（刚度、不回弹都一样）；它浮在什么上面都有可能，所以玻璃边退回均匀细线、不遮角，按设计规则也不加投影。别的药丸按同一弹簧让出空位、拖离药丸行时原位收拢，属于标签坞本身，见「待协调」。
- **名字**：旧版的 `GlassSlider` 是多选一，在这里叫 `Segmented`；数值滑块旧版叫 `GlassRange`，这里叫 `Range`。F6 文档和监管里说的「数值滑块 `GlassSlider`」就是 `Range`。
- **数字框的停用、读屏**：数字框整体是读屏里的「数值调节框」（SpinButton），上下限和当前值都报给读屏；两枚笔折本身没有单独的名字（旧版有「增大 / 减小某项」的读屏文案，要文案键，等 F6 的文案表）。

## 待协调

- **F4（编辑器）与组字**：F4 第二轮会把组字逻辑拆成共用的小 crate `gpui-ime`；等它合进 main，`dr_ui::input::Composer` 换成它，这一轮没动。原来的说明：`Composer` 的接口（`replace` / `replace_and_mark` / `unmark` / `discard` / `blur`，进出都按 UTF-16，`Change::{None, Composing, Committed}`）建议 F4 直接复用；正文是多行、有格式，F4 需要的是同一套「组字中不提交、失焦提交、回车归输入法」的规则，再加上撤销把整个上屏的词算一步。合并时把 `Composer` 挪到一个两边都能依赖的位置（比如 `gpui-prose` 的输入模块），dr-ui 再依赖它。
- **GPUI 补丁**：GPUI 没有让输入法放弃当前组字的接口（macOS 的 `discardMarkedText`）。现在失焦时我们这边提交了，但输入法自己那边的候选窗状态要靠系统收拾；如果输入法矩阵测出残留，要在 F4 的 GPUI 补丁里加这个接口。
- **GPUI 断行的中文禁则**：截图里悬停卡摘要「旧港」后面的句号被挤到了下一行行首。GPUI `v1.27.0` 的换行没处理行首禁则标点，这一处属于 F4 的排版（正文更需要），dr-ui 的多行文字也会跟着受益。
- **F7（打包）与字体**：已接上。`next/script/bundle-mac` 拷完可执行文件后调用 `crates/dr-ui/script/install-fonts "$APP/Contents/Resources"`（缺字体时它报错并说明怎么生成）；以后的 Windows 安装包同样把字体放进可执行文件旁边的 `fonts/`。
- **CI**：`next.yml` 在编译前生成字体并缓存，缓存键是 `provenance.json` 和生成脚本的哈希（每个平台各一份）；测试步骤设了 `DR_UI_REQUIRE_FONTS=1`，字体缺了会让字体检查失败而不是跳过。这一段只能在 GitHub 上跑：本机跑通了同样的命令，Windows 上用 `tar` 还是 `7z` 解 7z 没有实测。
- **F6（外壳）换用这一轮的新组件**（F6 下一轮做，dr-ui 这边都已经有了）：
  - `workspace/panel_tabs.rs` 的 `PanelTabs` 换成 `Segmented::new(id, 名字, i).motion(motion::PUSH).report_selected().font(Role::Structure).text_size(theme.scale.label).on_change(…)`，删掉 `panel_tabs.rs`。
  - `workspace/sidebar.rs` 里手拼的 cell（`glass_box(Kind::Hidden, …rim(3.0))` 加 `KindMark` 加 `SandFrame`）换成 `SandCell`。注意两处行为差别：选中的 cell 指着时不再出环（旧版 `.sand-cell.is-selected > .cell-ring { opacity: 0 }`），环的颜色是自身颜色和无色玻璃各半（旧版 `--cell-line`），现在外壳直接用了满色。
  - `settings/panel.rs` 的数值（一减一加两颗圆钮夹读数）换成 `Range` 加 `NumberField`：`Kind::Number { min, max, step, unit }` 里 `step` 给 `Range::step`，`unit` 给 `NumberField::unit`，小数位按 `step` 推（0.02、0.05 → 2 位，1、10 → 整数）。
  - `chrome.rs`、`settings/panel.rs`、`sidebar.rs` 里给按钮包一层 `div().id(…).aria_label(…)` 的地方改成 `IconButton::label(…)` / `PanelIconButton::label(…)`。现在那一层其实进不了无障碍树：GPUI 只上报设了 `role` 的元素，那层 `div` 没有角色，按钮自己也没有，所以读屏软件现在听不到这些名字。Windows 标题栏按钮外面那层要留着放 `window_control_area`，名字挪到里面的 `IconButton`。
  - `workspace/mod.rs` 的 `DOCK_COLLAPSE_DELAY` 换成 `dr_ui::tokens::motion::dwell::DOCK_COLLAPSE`。
  - 标签坞（`workspace/dock.rs`）的药丸换成 `PillGroup`：每个标签一颗 `Pill`（`.key(标签的 key)` 防重名，`.preview(…)`，新页准备超过 240 ms 时 `.loading(true)`，分屏标签用 `.content(…)` 画两半和中间的短竖线），点击走 `on_change`，双击固定和中键关闭走 `map_pill`，拖动走 `.draggable(|i| DockDrag{…}, |drag, to, …| reorder)`；稿纸左右半边的 `on_drop::<DockDrag>` 不用改。手里的副本由 dr-ui 的 `DraggedPill` 画（按弹簧跟手），外壳的 `DragPill` 可以删掉——它现在用 `Spec::filled(page)` 加稿纸色平地，圆角外会盖出方形的白角。换上以后标签坞就有了水波；「小点长成药丸」、其余药丸让位、拖离行时收拢还没有，可以等标签坞整个做成 dr-ui 组件时一起做。
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

第二个里程碑（收 F6 拼的件）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | `Segmented` 的 `.motion(…)`、`.report_selected()`（另加 `.font`、`.text_size`，Panel Tab 要结构字和 `label` 字号） | 完成 |
| 2 | cell 的悬停环做成组件 `SandCell` | 完成 |
| 3 | 数值滑块 `Range` 和旁边的数字框 `NumberField` | 完成 |
| 4 | `IconButton` / `PanelIconButton` 的 `.label()`；`dwell::DOCK_COLLAPSE`；`PillGroup` 能拖 | 完成；顺手给 `Button`、`Segmented`、`PillGroup`、`SandCell` 也设了读屏角色和名字 |
| 5 | 组字换成 `gpui-ime` | 等 F4 第二轮合进 main |
| — | 修了上一轮的两处毛病：悬停卡、菜单的圆角外偶尔露出方角；截图压缩把故事线颜色压成了一种蓝 | 完成 |

## 下一步建议

1. F6 下一轮换用新组件（见「待协调」）。
2. 补完 `Segmented` 放不下时收成单个 tab、`Select` 多于 8 项时的搜索框、多选一的交接键（Super View 切换器用）；给设置注册表补上色板，同样是 `new(id, 值).on_change(…).disabled(…)`。
3. 标签坞整个做成 dr-ui 组件：小点长成药丸、其余药丸按弹簧让位、拖离行时收拢。
4. 玻璃控件的键盘焦点（`focus-visible` 与悬停同效）要等 F6 定下焦点和快捷键框架后一起做；`Range` 已经这样做了（键盘焦点在上面时晕出圆玻璃）。
5. 输入法矩阵第 8 项（单行输入）请作者手测：标题、搜索、设置三种框各在系统拼音、搜狗、微信输入法下组字、选中替换、组字中点别处和切应用。

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
| `tests/` | 单行输入、悬停卡、取值控件（Panel Tab、滑块、数字框、拖药丸）的行为测试 |
