# F5 dr-ui：设计系统

2026-11-07 起，分支 `claude/f5-ui-254e54`。代码在 `next/crates/dr-ui`，样张程序是它的 `examples/gallery`，截图在 [f5/](f5/)。第二个里程碑（同日）把 F6 外壳用底层件拼的几样收了进来：Panel Tab 用的推进版多选一、cell 的悬停环、数值滑块和数字框、图标按钮的读屏名字、能拖的药丸组。第三个里程碑（11-08）：单行输入的组字改用 F4 拆出来的共用 crate `gpui-ime`，失焦一律「清掉 + 让系统丢弃」；标签坞整个做成了组件 `TabDock`（小点长成药丸、其余药丸让位、拖离药丸行时原位收拢）。第四个里程碑（同日，main `15299820` 之后）给书架、作品主页和章节页出了三样：没有边框、字号字重跟着外面的字走的单行输入（`TextField::bare`），同样没有边框、自动换行、按内容长高的多行输入 `TextArea`（回车换段，或者对标题来说回车就是提交），悬停变危险色的图标按钮（`PanelIconButton::danger`）；还查了 GPUI 读屏树的缓存视图问题 G7，dr-ui 碰不到。第五轮（同日，main `1652a95e` 之后）：对话框的「点 ✕」和「点外面的雾」分成两个回调；界面文字有了按中文规则换行的文字元素 `text::wrapped`（「，」「。」不落行首）；章节页的章首章末（M03）做成了新 crate `dr-view-page`，见 [m03-page.md](../modules/m03-page.md)，dr-ui 为它加了页面的字号间距令牌 `tokens::page`、带图标的紧凑 cell、多行输入的「↓ 到底」事件。第六轮（同日，main `60d510a6` 之后，先合进了 F4e 第四批）：章节页接上 F4 的幕扉页数据和构想页；翻页叠化把进度交给页面（`PageTurn::with_level`）；带框的多行输入（`TextArea::framed`）；色标和取色器（`ColorSwatch`，点开系统自己的取色板，和旧版一样）；书架的封面、写作热力图和近 30 天砂条（M25）做成新 crate `dr-view-shelf-art`，见 [m25-shelf-art.md](../modules/m25-shelf-art.md)。第七轮（同日，main `2eb865fa` 之后）：界面语言的数字写法（分组、紧凑的「12.3万」）收成 `dr_i18n::number` 一份；字海、整窗等待、首次运行和导览（M24）做成新 crate `dr-view-sea`，内置样书做成新 crate `dr-samples`，见 [m24-sea.md](../modules/m24-sea.md)。

M15 旧模块收尾增加 `TextArea::wrap_punctuation()`：窄格会裁切行尾悬挂标点，因此可选择退到合法断点换行，保留完整字形，不做压缩。只有情节格子启用；普通多行框、`text::wrapped` 和正文默认行为不变。测量、绘制、光标及选区使用同一份断行结果，见 [M15 第四轮](../modules/m15-plot.md)。

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

- 顶上一行切换页面（令牌 / 控件 / 输入 / 浮层 / 砂笔 / 过渡）和外观（浅 / 深）。外观是程序里强制切换的，不改系统设置。
- 控件页右边把同一组玻璃固定在静止、悬停、按下、选中四种状态并排摆着（左边无色、右边故事线颜色），方便对照；下面是设置里的四个数值（字号、行距、段间距、纸张宽度，范围照外壳的设置注册表）和一行停用的，滑块和数字框联动。左边的控件都能真按。
- 输入页左边是作品主页的头：书名就是一个无边框单行输入，点进去原地改；下面的本书简介是无边框多行输入，两段。右边是章节页的头：标题是会换行的多行输入（回车不换行），下面是空着的梗概（显示占位字），再下面是正文第一段。左下角是一张书卡的角落，指着字纸篓它变成危险色。
- 浮层页的「⋯」开关一个真正浮起的菜单，「林岚」那一行停 220 ms 出悬停卡，「删除这本书…」打开对话框，「通知」让通知药丸淡入淡出。
- 砂笔页的几行是 `SandCell`：指着出一圈取自身颜色的流动细玻璃，点一行，砂笔框从记号旁起笔画一圈；「未归属」打不开，没有环。「换一组」让读数滑到新长度。
- 过渡页：药丸之间点来点去看水波；药丸可以拖着换位置，其余药丸按弹簧让出空位，拖到离药丸行一行高以外时它原来的位置收拢（第六章是预览：空心记号）。左边三个圆钮翻页，右边是侧栏的 Panel Tab：方块跟着面板一起推进，再点一次当前的标签收起面板。最下面是标签坞：平时一排砂笔记号（分屏标签是并排两个，类型变化处空得宽些，打开的那个大一号），指上去每个记号原地长成药丸，离开 260 ms 后收回；左边的锁按下后常开，药丸同样能拖着换位。

截图和测量都在离屏模式下跑，不弹窗口，也不需要录屏权限（截完用 `crates/dr-ui/script/shrink-pngs.py <目录>` 压成 256 色，约原来的五分之一）：

```bash
cargo run -p dr-ui --features capture --example gallery -- --capture <目录>
```

```bash
cargo run --release -p dr-ui --features capture --example gallery -- --bench <文件.json>
```

## 截图

都是 2 倍像素、压成了 256 色（24 张共 1.5 MB，最大一张 104 KB），内容全是合成的。截图时时钟停住，所以流动和转圈停在某一刻；「过渡进行中」两张是触发后 140 ms（砂笔框是 260 ms）的那一帧；控件页截图时指针停在「字号」的圆钮上，所以它周围有一圈圆玻璃；输入页截图时章节标题正在组字（行尾带下划线的 deng ta，光标在它后面），指针停在书卡的字纸篓上。

256 色的调色板用八叉树取，不用中位切分：上一轮用中位切分，调色板几乎全花在桌面和稿纸的灰上，几像素宽的故事线颜色（紫、绿、黄）被并成了同一种蓝，第一个里程碑截图里的章节记号和筛选片颜色是错的，第二个里程碑全部重截过。第三个里程碑只重截了过渡页（多了标签坞，药丸拖离行时会收拢）。第四个里程碑全部重截：顶上多了「输入」一页，每张的页面切换行都变了；页面本身除了新的输入页没有改动。第五轮只重截了浮层页和对话框（悬停卡摘要、对话框副标题改按中文规则换行，摘要末尾的「。」现在悬挂在「旧港」后面，不再单独落到下一行），别的页面沿用。第六轮只重截了输入页：左边多了带框的多行输入，右下多了三个色标（故事线的短横、类目的折角、写出值的砂笔团）。

| 页面 | 浅色 | 深色 |
| --- | --- | --- |
| 令牌 | [tokens-light](f5/tokens-light.png) | [tokens-dark](f5/tokens-dark.png) |
| 控件 | [controls-light](f5/controls-light.png) | [controls-dark](f5/controls-dark.png) |
| 输入（无边框的单行和多行输入、标题组字中、悬停变危险色的字纸篓） | [inputs-light](f5/inputs-light.png) | [inputs-dark](f5/inputs-dark.png) |
| 浮层（菜单、悬停卡、空状态、加载、通知） | [floating-light](f5/floating-light.png) | [floating-dark](f5/floating-dark.png) |
| 对话框 | [dialog-light](f5/dialog-light.png) | [dialog-dark](f5/dialog-dark.png) |
| 砂笔（图标、记号、读数） | [sand-light](f5/sand-light.png) | [sand-dark](f5/sand-dark.png) |
| 砂笔框画到一半 | [sand-drawing-light](f5/sand-drawing-light.png) | [sand-drawing-dark](f5/sand-drawing-dark.png) |
| 过渡 | [motion-light](f5/motion-light.png) | [motion-dark](f5/motion-dark.png) |
| 过渡进行中（水波、翻页、推进） | [motion-midway-light](f5/motion-midway-light.png) | [motion-midway-dark](f5/motion-midway-dark.png) |
| 拿在手里的药丸（拿起 150 ms 后，副本还在追指针；拿到行外一行高以上，它原来的位置正在收拢） | [motion-drag-light](f5/motion-drag-light.png) | [motion-drag-dark](f5/motion-drag-dark.png) |
| 标签坞长出药丸（指上去 120 ms：玻璃快长到宽度，字还没出来，记号在玻璃下散开） | [motion-dock-grow-light](f5/motion-dock-grow-light.png) | [motion-dock-grow-dark](f5/motion-dock-grow-dark.png) |
| 标签坞里拖着第三章越过两颗（150 ms，那两颗正按弹簧往左让位） | [motion-dock-reorder-light](f5/motion-dock-reorder-light.png) | [motion-dock-reorder-dark](f5/motion-dock-reorder-dark.png) |

## 用法

```rust
gpui_platform::application()
    .with_assets(dr_ui::Assets::new())            // 图标、砂笔、玻璃纹理
    .run(|cx| {
        dr_ui::init(cx)?;                         // 注册字体、主题设置、单行和多行输入的快捷键；缺字体时返回错误
        dr_ui::theme::force_appearance(None, cx); // None = 跟随窗口（系统）
        // …
    });
```

- 应用自己的资源用 `Assets::with_fallback(自己的 AssetSource)` 接在后面。
- `init` 找不到字体时返回 `fonts::FontsMissing`，它的文字就是给人看的说明（跑哪条命令、找过哪里），应用应当显示它并停下，而不是带着系统字体继续。
- 视图里取主题：`let t = dr_ui::Theme::of(window, cx);`，然后 `t.palette.ink(2)`、`t.scale.body`。
- 谁画了一块平色，谁就声明它：`glass::surface(Ground::flat(p.page), div().bg(p.page.solid())…)`。里面所有玻璃和砂笔自动知道自己的底色。

## 组件清单

都在 `dr_ui::components`，除了 `TextField` 和 `TextArea` 是实体（`dr_ui::input`），其余都是 `RenderOnce`，拿 id 和几个参数就能用；需要记住状态的（玻璃三态、开关的滑动、水波、悬停卡的计时）各自存在 GPUI 的 keyed state 里，调用方不用管。

| 组件 | 材料与样子 | API 要点 |
| --- | --- | --- |
| `Button` | 主按钮：常驻强调色选中玻璃、强调色字，不填色；次按钮：静止细线；文字按钮：无玻璃，悬停加深字；危险：危险色细线和字 | `Button::new(id, 文字).primary()/.text()/.danger().icon(Icon).small().busy(bool).disabled(bool).full_width().on_click(…)` |
| `IconButton` | 圆形玻璃，28 px、图标 16 px；单独放有静止细线，放在长药丸里静止时看不见，浮起时垫不透明稿纸色 | `.in_tray()/.floating()/.selected(bool)/.tone(Tone::Accent)/.disabled(bool).label(文字)`；`label` 只给读屏软件（无障碍树里是叫这个名字的按钮），不画出来 |
| `PanelIconButton` | 面板 header 的朴素图标按钮：无玻璃，悬停时图标加深并垫一层墨色薄底；危险的（书卡上的字纸篓）平时一样，悬停时图标变危险色、薄底也是危险色 | `.accent()` 给「新建」，`.danger()` 给删除，`.label(文字)` 同上 |
| `Switch` | 胶囊玻璃轨道：关时一条细线，开时整条晕上静止的强调色玻璃；圆钮是稿纸色（深色为浅墨），不沾色，180 ms 滑过去 | `Switch::new(id, on).on_change(\|on, w, cx\| …).tint(颜色).disabled(bool)` |
| `ScopeToggle` | 一个永远不变的词，直角；关时细线，开时选中玻璃 | `ScopeToggle::new(id, "当前", on).on_change(…).disabled(bool)` |
| `Chip` | 一组各自独立的开关：等宽字、2 px 圆角，名字前一道故事线砂笔短横（关着时淡到 35%），后面是数量；数量为 0 时字和线都淡一半 | `Chip::new(id, 名字, on).color(颜色).count(n).on_change(…)` |
| `Segmented`（多选一，旧版的 `GlassSlider`） | 并排几个字，底下一块无圆角的玻璃方块（不透明稿纸底 + 选中玻璃），换选时沿 520 ms 的弹簧滑过去，纹理随滑过的距离流动。侧栏的 Panel Tab 是同一块方块：跟着面板走 265 ms 的重冰推进、同一刻落地，点当前的标签也回调（收起这一半），字用结构字、`label` 字号 | `Segmented::new(id, ["全部","批注","TODO"], i).on_change(…).disabled(bool)`；Panel Tab 加 `.motion(motion::PUSH).report_selected().font(Role::Structure).text_size(scale.label)` |
| `PillGroup`（药丸组） | 玻璃药丸（静止细线、悬停流动），换选中时选中的晕像一道水波从旧药丸推到新药丸：每跨一颗多 70 ms（最多 4 颗），中途变宽、变淡、边变软，途经的药丸按自己的颜色亮起又退去；新药丸在水波到达前保持细线，到达后自己的晕再晕开。药丸能拖：手里是一份静止的副本（稿纸底、选中玻璃、不加阴影），按刚度 150 的临界阻尼弹簧略落后地跟着指针、不越过它；在行上时其余药丸按同一条弹簧让出它会落下的空位（它的前缘越过下一格的一半就算过去，宽的分屏标签也能越过窄的）；拿到离行一行高以外，它原来的位置收拢、两边接上，在这之间晃不动；松手时每颗药丸从显示的位置弹进新位置，手里那颗从副本所在处弹回。拖动换序后选中跟着那颗药丸走，不推水波 | `PillGroup::new(id, vec![Pill::new("第一章").mark(Kind, 颜色).preview(b).loading(b).key(…).content(…)], i).on_change(…).draggable(\|i\| 载荷, \|载荷, 落到第几位, w, cx\| …).map_pill(\|i, pill, 元素\| 元素.on_mouse_up(…))`。落在药丸行上才回调，给的是它让出空位的那一位（落回原位不回调）；载荷是 GPUI 的拖动值，稿纸左右半边这类别处的落点用 `on_drop::<载荷>` 照样接得到，那时药丸弹回原位、组不回调。`map_pill` 给每颗药丸加组件自己不管的事件（双击固定预览、中键关闭）；`.on_lift(\|拿起, w, cx\| …)` 在拿起和松手时各告诉一次 |
| `TabDock`（标签坞） | 平时一排砂笔记号，一页一个（分屏标签两个并排、窄一点），类型变化处多空 8 px；打开的那页记号大一号；页面准备超过 240 ms 的记号外面一圈小小的流动玻璃。指上去、锁住、或自己的药丸在手里时，每个记号原地长成玻璃药丸（340 ms 的 Dock 药丸曲线：玻璃从记号的 20 px 宽长到自己的宽度，字在 45% 以后才淡入，记号在玻璃下放大散开）；离开后等 260 ms 收回，记号像砂一样落回来。锁和 `+` 由调用方给，只在打开时出现，不随药丸滚动。药丸就是 `PillGroup`：水波、拖动、让位、收拢、落位都一样 | `TabDock::new(id, vec![DockTab::new(Pill…)], 打开的那个).locked(b).leading(\|w, cx\| 锁).trailing(\|w, cx\| 加号).on_change(…).draggable(…).map_pill(…)`；分屏标签 `DockTab::new(pill).marks([DockMark::new(Kind, 颜色).hollow(b), …], 焦点在哪一半)`；`.held_open(b)` 给调用方在别的拖动时撑开它 |
| `SandCell`（列表 cell） | 侧栏的章节、要素、故事线，统计的跳转行，时间线泳道名：不垫底；指着时沿四边出一圈发丝流动玻璃（取自身颜色与无色玻璃各半），没有按下态；选中时环退去，砂笔从记号旁起笔绕它画一圈；打不开的行没有环。`.dense()` 是一小列动作里的一行（章末 ⁂ 的菜单）：22 px、等宽字、墨 3，宽度跟着字。`.lead(元素)` 把自己的东西放在最前面（素材库的展开箭头和图标、缩略图），`.subline(文字)` 在名字下面加一行淡字（素材的开头几个字或类型），行高跟着变（M19） | `SandCell::new(id, 名字).mark(Kind).color(颜色).hollow(b).font(Role::Structure).italic(b).selected(b).disabled(b).on_click(\|e, w, cx\| …)`，后面还能 `.child(…)` 放数量这类尾巴；`e.click_count()` 分单击、双击；动作行用 `.icon(Icon).dense()` |
| `Range`（数值滑块，旧版的 `GlassRange`） | 1 px 发丝轨，走过的部分是 2 px 墨线；圆钮就是 Switch 的圆钮；指着、拖着、键盘焦点在上面时，圆钮周围晕出一圈 24 px 的圆形玻璃并流动，拖住时加深。点轨道任一处跳过去、拖着走（拖出轨道两端停在端点）；方向键一格、Page Up / Down 十分之一、Home / End 到头。读屏软件看到的是带值和上下限的滑块，能增减 | `Range::new(id, 值, 最小, 最大).step(0.05).label(名字).wide().on_change(\|值, w, cx\| …).disabled(b)`，回调的值已经落在格上 |
| `NumberField`（数字框） | 滑块旁边的小号等宽单行输入框，单位作为读数写在框尾，框里上下两枚平面细笔折微调；停用时连同笔折一起停用 | `NumberField::new(id, 值, 最小, 最大).decimals(2).unit("px").label(名字).on_change(…).disabled(b)`。打字时只有在范围内的数才立即预览；回车或离开时越界的收回到端点、不是数就恢复原值；↑↓ 和笔折按最后一位（整数为 1）加减 |
| `Select`（下拉） | 触发器是一块单行输入框：当前项的记号、名字、末尾一笔折；展开是菜单外壳的列表，与触发器同宽、不窄于 240，当前项中等字重带勾 | `Select::new(id, vec![Choice::new(图标或记号, 名字)], i).on_change(…).disabled(bool)` |
| `Menu` / `MenuItem` | 桌面色不透明底、16 px 圆角、静止细玻璃边、浮起投影；宽 240 / 320 / 420；每行左图标右文字，悬停时这一行沿自己的圆角流出发丝玻璃环，字色不变；分组用 0.5 px 发丝线 | `Menu::new(id).width(MenuWidth::Wide).item(MenuItem::new(id, 图标, 文字).checked(b).danger()).separator(&t).section("写作状态", &t)` |
| `HoverCard` / `CardBody` / `CardAction` | 停 220 ms 出卡，离开有 220 ms 宽限；点对象、所在列表滚动都收起；卡宽 248、一个字号、只有标题加粗；能按的东西在卡底部一行一个，危险项在最后一节；`.beside()` 贴在对象旁边（侧栏里的卡用，F4d 第四轮）；`CardBody::quote(字, 附注)` 是一张稿纸色小纸条上的一段原文（旧版 `.hover-card__quote`） | `HoverCard::new(id, 对象元素, \|w, cx\| CardBody::new(id, 标题).mark(…).count(…).summary(…).section(vec![CardAction…]))` |
| `overlay::float` / `Dialog` | 只有一个浮层层、一个定位函数（见下面的「浮层」）；对话框是直角桌面色、半像素墨线加投影，背后蒙一层桌面色薄雾 | `overlay::float(Place, Layer, 元素)`；`Dialog::new(id, 标题).eyebrow(…).subtitle(…).body(…).action(…).on_close(…).on_mist(…)`。`on_close` 是右上角的 ✕（给了才有 ✕）；点雾默认和 ✕ 一样，给了 `on_mist` 就改走它（写了一半的话时不关：`.on_mist(\|w, cx\| if 没写字 { 关 })`；`\|_, _\| {}` 让雾不响应） |
| `NotificationPill` | 浮在工作上的一张不透明稿纸色小片，静止细玻璃线、小圆角；160 ms 上移 3 px 浮入，离开整块淡出 | `NotificationPill::new(id, 文字).icon(Icon).danger().action(Button).shown(bool)` |
| `EmptyState` | 一句平实的话（次级墨、居中、不斜体），上面是缺的那类东西的空心记号或这个地方的淡图标，下面可跟一个文字按钮和「从哪里开始」的快捷键行 | `EmptyState::new(id, 话).mark(Kind)/.icon(Icon).action(Button).hint(动作, 快捷键)` |
| `Loading` / `Progress` | 缺角圆相 0.9 s 一圈，等待超过 240 ms 才出现、再 0.16 s 淡入；块级 20 px 字在下，行内 14 px；进度是 1 px 轨道加 2 px 强调色填充，不知道总量时一小段来回走 | `Loading::new(id).inline().label(…)`；`Progress::new(Some(0.6) / None)` |
| `TextField`（单行输入） | 稿纸色片加静止细玻璃线，悬停流动，光标在里面时是静止的选中玻璃；搜索框前有搜索图标、框尾有等宽读数。`.bare()` 是无边框的：没有玻璃、底色、内边距和自己的高度，字体、字号、字重、行高、颜色都用外面的字的，放在页面上和旁边的字一模一样，只有光标、选区和占位字（墨 4）是自己的 | `cx.new(\|cx\| TextField::new(id, window, cx).placeholder(…).icon(Icon::Search))`，订阅 `FieldEvent::{Changed, Submitted, Cancelled, Blurred}`；原地改书名：`TextField::new(id, window, cx).bare().with_text(书名)`，外面包一层定好字体字号的 `div`；`select_all_text(cx)` 全选 |
| `TextArea`（多行输入） | 无边框，规则同 `.bare()` 的单行输入：字体字号颜色都跟外面；按自己的宽度自动换行，一行一行长高。断行用编辑器同一套中文规则（`prose-linebreak`：「。」和后引号不落行首、英文单词不拆、放不下的标点悬挂在行尾）。`.framed(行数)` 是带框的（旧版 `ui-field--area`）：和单行框一样的稿纸片加静止细玻璃线，光标在里面时是选中玻璃，内边距 8 × 12、圆角 16、界面正文字，至少几行高、随字长高，点框的内边距也进框 | `TextArea::new(id, window, cx).placeholder(…).with_text(…)`，事件同上；`.submit_on_enter()` 给会换行的标题：回车就是提交，粘贴和输入法送来的换行变成空格。⌘↵ / Ctrl+Enter 两种都提交，Esc 取消；`rows()` 是上一次排出来几行，`select_all_text(cx)` 全选；另一种事件 `AreaEvent::PastEnd`：光标已经在最后时再按 ↓（章节标题借它进正文）；表单的梗概 `.framed(3.0)`，本书简介 `.framed(4.0)` |
| `ColorSwatch`（色标与取色器，旧版的 `ColorPicker`） | 28 px 的圆形玻璃里一团这个颜色的砂笔（或这类东西自己的记号：故事线的短横、类目的折角），可以在旁边用等宽字写出 `#RRGGBB`。点一下打开系统自己的取色板，和旧版的 `<input type=color>` 一样：macOS 是共享的颜色面板（色轮、滑块、调色板；不关、拖着时颜色跟着变），Windows 是系统的颜色对话框 | `ColorSwatch::new(id, 颜色).mark(Kind::Storyline).label(读屏名).show_value().on_pick(\|颜色, w, cx\| …)`；存的时候用 `components::color::hex(颜色)`（`#rrggbb`），读用 `parse_hex`。测试里用 `color::set_color_picker(cx, \|当前, 回调, w, cx\| …)` 换掉系统的（测试窗口没有平台句柄，不换也什么都不开） |

### 浮层

旧客户端有四套浮层外壳（悬停卡 `HoverCardShell`、图上点开能展开成编辑器的卡 `EntityCardPopoverShell`、菜单 `AnchoredPopover`、按点位弹出的 `ContextMenuSurface`）加 `Modal`，定位函数四个，共约 2.4k 行。dr-ui 只有一个浮层层和一个定位函数：

- `overlay::float(Place, Layer, 元素)`：用 GPUI 的 `deferred` 画在整个窗口之上（相当于旧版 portal 到 `body`、`position: fixed`），`Layer` 是 `Popover` < `Dialog` < `Notice`。
- `Place` 有四种锚：`Place::Rect { rect, align, gap }`（贴着一个矩形：下方，按起点 / 居中 / 终点对齐，下面放不下就翻到上面）、`Place::Beside { rect, gap }`（贴在矩形旁边、顶边对齐：右边放不下而左边更宽就放左边，旧版的 `right-start`；F4d 第四轮为审阅卡的来源卡加的）、`Place::Point(点)`（左上角对着这个点，碰到窗口边就往左、往上翻）、`Place::Center`（窗口正中）。不管哪种都留在窗口里 8 px 以内。
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
| 文字 | `TextField`（实体，订阅 `FieldEvent::Changed`，只报告提交后的文字）；多行用 `TextArea` | `String` |
| 有范围的数值 | `Range` 加旁边的 `NumberField`，两个用同一个值、同一个回调（`step` 给滑块，`decimals` 给数字框，单位写在数字框尾） | `f64` |
| 颜色 | 色板还没做，见「下一步」 | — |

砂笔与玻璃的底层件（`dr_ui::sand`、`dr_ui::glass`）：

| 件 | 说明 |
| --- | --- |
| `text::wrapped(文字)` | 界面上的一段文字，按编辑器的中文规则换行（`prose-linebreak`：点号和后引号不落行首、英文单词不拆、放不下的标点悬挂）。字体、字号、颜色、行高跟外面；外面的 `text_center()`、`whitespace_nowrap()`、`line_clamp(n)`、`text_ellipsis()` 照样生效（或 `.max_lines(n)`），所以 `div().line_clamp(2).text_ellipsis().child(文字)` 改成 `.child(wrapped(文字))` 就行。悬停卡摘要、空状态那句话、对话框副标题已经用它 |
| `sand::icon(Icon, 尺寸, 颜色)` | 132 个砂笔图标，`Icon` 是编译期枚举（从 `assets/icons/` 生成，测试守着两边一致） |
| `sand::thinking(…)` | 思考的星芒，六帧来回播，每帧 120 ms；停下时是整颗钝头星 |
| `KindMark` | 实体记号：章节圆印（按 id 取六枚之一）、要素方印、故事线短横、类目折角、构想小漩涡（不在分组里更淡）、构想分组、素材纸条、通览全书的强调色星号；空心版给 Preview。出现时从 0.8 倍淡入长大（0.3 s），`.shown(false)` 整块淡出 |
| `SandFrame` | 选中 cell 时画出的砂笔框：从记号旁起笔，60 ms 后沿路径 0.38 s 画完；挂上时已选中的直接显示画好的样子；取消选中整框 0.3 s 淡出。宽度变化时用同一个种子按新尺寸重算，左边不动。`.rest(强度)`：没选中时留一道淡框，在几档强度之间淡入淡出（M19 的区域批注：平时 0.5、指着 0.8、已解决 0.28）；`.seed(种子)`：固定一笔，每次选中沿同一笔重画 |
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
- **章节页**（`tokens::page`）：稿纸上正文周围的东西，跟着纸、不跟界面字号：页眉 9.5 px、标题 42 px 行高 1.3、梗概比正文小 2 px 行高 1.5、⁂ 20 px 和它的 48 × 32 指针区、动作行 22 px、停 70 ms 才展开、展开 150 ms 收回 110 ms、悬停打开后 250 ms 内的点击不算、空章提示离第一行 96 px、幕扉页上 120 下 112 幕名 30 px 一笔 180 px。数都来自旧版的 `.page__*`、`chapter-end-menu.css`、`guide.css`、`all-chapters.css`。
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

## 输入框与组字

- 走 GPUI 的 `EntityInputHandler`。组字规则是 F4 拆出来的共用 crate `gpui-ime` 的 `LineComposer`（它原本就是从这里的 `Composer` 搬过去的，编辑器用同一个 crate 里的 `Overlay`），dr-ui 自己那份删了。dr-ui 只补两样：字素簇边界（`input::Graphemes`，`unicode-segmentation`），和让系统输入法丢弃拼音的那一下（`input/ime.rs`）。
- **组字期间的内容不提交**：拼音显示在框里（带下划线），但 `text()` 不含它，`FieldEvent::Changed` 只在提交后的文字变了时才发；组字中按回车是输入法的，不会触发提交。
- **失焦清掉，并让系统丢弃**（作者定的，和编辑器一致，`gpui_ime::BLUR_RULE`）：焦点离开、切到别的应用或窗口时，正在组的拼音直接丢掉，什么都不提交；同时告诉系统输入法也丢掉——macOS 是这个窗口自己的视图的 `[[view inputContext] discardMarkedText]`（不用 `currentInputContext`，切窗口时那已经是别的窗口的），Windows 是这个窗口还有键盘时的 `ImmNotifyIME(…, NI_COMPOSITIONSTR, CPS_CANCEL, 0)`。GPUI v1.27 没有这个接口，所以 dr-ui 直接调（`objc2`、`windows`，都是 GPUI 自己已经在编的版本）。测试或别的宿主可以用 `input::set_discard_marked_text(cx, |window| …)` 换掉这一下。
- **失焦之后输入法送来的字不收**：失焦到下一帧之间，窗口还会把输入法的调用转给这个框；这时框已经没有键盘，送来的字（比如输入法迟到的上屏）一律不收。
- 一行就是一行：粘贴和输入法送来的换行都变成空格。按字素簇移动和删除。
- 光标 530 ms 闪一次，只在有焦点时；失焦后计时器停掉。

无边框的两种（第四个里程碑）：

- **`TextField::bare()`**：同一个单行输入，只是不画框。它不设字体、字号、行高和颜色，全从外面那层 `div` 继承（GPUI 的文字样式是一路往下传的，实体视图也在里面），高度就是外面的一行高；停用时字变成墨 4。作品主页的书名平时就显示在这个框里，不用「点了才换成输入框」。
- **`TextArea`**：多行，同样无边框、样式全跟外面。
  - 组字规则和单行的完全一样（同一个 `LineComposer`，组字中不报告、按键归输入法、失焦和切应用都丢弃并让系统丢弃、失焦后迟到的上屏不收）。`LineComposer::insert` 会把换行压成空格（它是一行的），所以多行输入自己拼换行。
  - **排版**：每段先不折行排一次（GPUI 的 `shape_line`），用 `prose-linebreak` 的 `break_rows` 按宽度定断点（`Overflow::Hang`，和编辑器一样），再把排好的整行按断点切开、一行一行画（`ShapedLine::cursor().take_until`）。高度在排版阶段就按宽度量出来（`request_measured_layout`），所以外面的布局知道它要几行。GPUI 自己的折行不避行首标点：最初用它的时候，样张里简介的「。」被单独折到了下一行行首；换成这套规则后它悬挂在行尾。
  - **键**：←→ 按字素簇；↑↓ 换行时记住起始的横向位置（一串上下键里一直对准它），第一行再按 ↑ 到开头、最后一行再按 ↓ 到结尾；Home / End（以及 ⌘← / ⌘→）到这一行的头尾，⌘↑ / ⌘↓（Windows 是 Ctrl+Home / Ctrl+End）到全文头尾；⇧ 加方向键选择；⌘A 全选；回车换段，`.submit_on_enter()` 的标题回车就提交；⌘↵ / Ctrl+Enter 提交，Esc 取消。按键都在自己的键上下文 `DrTextArea` 里。
  - **软换行处的光标**：一个位置既是上一行的末尾、又是下一行的开头。按 End、点在一行末尾之后、上下移到一行末尾时，光标留在上一行的末尾；其余时候在下一行开头。
  - 指针：单击放光标，双击选一个词（按 Unicode 词边界，汉字一个字一个词），三击选一整段；按住拖动选择；⇧ 单击扩展选区。
  - 输入法的候选窗贴着组字所在的那一行（`bounds_for_range` 按排好的行算）。

`tests/field.rs` 和 `tests/area.rs` 用 GPUI 的测试平台验证（它的占位字体每个字一样宽，0.6 em，所以断在哪里是确定的）。单行：组字中不报告、回车不提交；失焦丢掉拼音、不报告改动、只让系统丢弃一次（没在组字时失焦一次都不调）、失焦后迟到的上屏不收；切换应用同样丢掉；无边框的高度就是外面那一行（34 px 字、44 px 行高时是 44），带框的还是控件高度。多行：按宽度换行、一行一行长高、新段另起一行；↑↓ 对准起始的那一列，最后一行短时停在行尾、回来还找得到那一列，第一行再往上到开头、最后一行再往下到结尾，⇧↓ 向下选一行；软换行处 End 留在上一行，在下一行开头打的字落在下一行开头；回车换段、⌘↵ 提交、Esc 取消；标题回车提交、换行变空格、组字中回车不提交；失焦丢掉拼音、只让系统丢弃一次、迟到的上屏不收。

Windows 那段调用在这台 Mac 上编不了 dr-ui（GPUI 的构建脚本要 Windows 的资源编译器），单独抽出来对 `x86_64-pc-windows-msvc` 做过类型检查和 clippy，真正编译在 CI 的 Windows 上。真实输入法（系统拼音、搜狗、微信等）要按 [benchmarks.md](../benchmarks.md) 的输入法矩阵人工测，见「待协调」。

## 读屏与缓存视图（GPUI 的 G7）

F4c 发现 GPUI v1.27 的 G7：读屏软件连着时，一个缓存视图（`AnyView::cached`）在别处重画、自己被原样重放的那些帧里，不重新建它的无障碍节点，里面的东西就从读屏树里掉出去（光标一闪就掉）。`gpui-prose` 的绕法是读屏连着时编辑器不走缓存（`input::a11y::editor_view`）。

dr-ui 查过，**碰不到**：

- dr-ui 里没有一处 `.cached(…)`。组件都是 `RenderOnce`，每帧随所在的视图一起重建；`TextField`、`TextArea` 是实体视图，但作为子视图放进去时 GPUI 每帧都调它的 `render`，不缓存。所以按钮、滑块、药丸组、标签坞这些设了读屏角色和名字的，每帧都在树里。
- 整个 `next/` 里用缓存视图的只有编辑器（已绕开）和 `gpui-prose` 的探针、spike。外壳（`dr-shell`）和 `dr-view-*` 也没有。
- 以后谁要把一块放了 dr-ui 组件的界面做成缓存视图（比如为了性能缓存侧栏），照编辑器的做法：读屏连着时（`window.is_a11y_active()`）不调 `.cached(…)`，直接把实体当子视图放进去。GPUI 打了 F4 台账里的 `0003-a11y-draw-views-uncached.patch` 以后就不用管了。

另外一件相关的事：dr-ui 的两种输入框现在**还没有进读屏树**（没有角色，也没有把文字报给读屏），读屏软件看不到它们。要做就得像编辑器那样把文字切成 AccessKit 的文字段，见「下一步」。

## 测量

M3 Pro，release 构建，1280×800 的样张、2 倍屏。帧时间是离屏（Metal 画进纹理）测的「重新渲染 + 排版 + 绘制」一整帧的 CPU 时间，原始数据在 [f5/bench.json](f5/bench.json)，用上面的 `--bench` 重跑。第四个里程碑重测（多了输入页），**这一次机器很忙**：别的会话在编译，一分钟负载约 24（之后升到 60 以上，没法再测），所以绝对数都偏高，控件页连着重画的中位数从 0.94 ms 变成 1.4 ms，而控件页这一轮一行没改。能看的是同一次里各页的相对大小和「静止时要几帧」：新的输入页整页重画中位数 0.18 ms，是六页里最轻的；六页静止时要的帧都是 0。表里记的是这一次，上一轮（负载约 4–5）的数在括号里。这次测量是在修好面板图标按钮的悬停之前跑的，那处只改了输入页角落两个小按钮的图标怎么上色。

第三个里程碑那一轮说过：按每秒 60 帧的节拍取样的几项（悬停、按下、松开、加载圈）对机器状态很敏感（帧与帧之间隔 16 ms 时降频），一行没改的「加载圈在转」也会差一倍。

| 项 | 结果 | 对照 [benchmarks.md](../benchmarks.md) |
| --- | --- | --- |
| 静止时要的帧 | 六页都是 **0**：没有在动的东西就不出帧；悬停、按下结束以后也回到 0。输入框有焦点时光标每 530 ms 闪一次，就是每 530 ms 一帧 | 「不操作时 CPU ≈ 0」 |
| 真实窗口静止时的 CPU | 第二个里程碑量的：**0.0%**（停在控件页，`top` 每 2 秒一次、共 11 次，窗口测完关掉）；P0-A 的空窗口 0.0–1.3%。第三、四个里程碑没再开真实窗口，离屏六页静止时要的帧都是 0 | 探针档 ≤ 1% |
| 整页重画一帧 | p50 0.18–1.4 ms（六页，控件页最重；输入页最轻，0.18 ms，p95 0.31 ms），p95 ≤ 3.4 ms（0.28–0.94 ms，p95 ≤ 1.5 ms） | 发布档每帧 8.3 ms |
| 悬停流动 | 每帧 p50 1.6 ms（2.5）；纹理 15 s 才走一块（每秒 10 px），所以只按约 30 帧/秒重画，约占一个核的 5%（8%），见上面关于节拍取样的说明。快的移动（按下、晕开、水波、加载时 2.4 s 一圈的流动、标签坞长出和让位）照常每次刷新都画 | — |
| 按下（40 ms 加深） | 每帧 p50 1.5 ms（2.2） | — |
| 松开并离开 | 每帧 p50 1.5 ms（1.8），0.28 s 后停帧 | — |
| 加载圈和来回走的进度线在转 | 每帧 p50 1.5 ms（0.90），每次刷新 | — |
| 找到并注册字体 | 1.3 ms（0.9；文件映射进内存，CoreText 按需读页，不在启动时读 72 MB） | 冷启动 ≤ 300 ms |
| 首帧 | 1.5 ms（0.9；离屏，不含开窗口） | — |
| 体积 | 字体不编进可执行文件：样张 release 15.7 MB（P0-A 的空程序 8.9 MB），字体 72 MB 在缓存或应用包的 Resources 里，映射进内存按需读；静止时常驻 68 MB | — |

行为由测试守着：`cargo test -p dr-ui` 跑 76 个测试。单元测试 51 个（第六轮加了颜色的十六进制往返 1 个），其中有浮层定位的 5 个、滑块和数字框的取整与读写 3 个、Panel Tab 的推进时长和手里药丸的弹簧 2 个、菜单圆角不跨两块纹理 1 个、拖动让位与落位和药丸长出的 6 个（`components/reorder.rs`：前缘过半格就让位、宽的越过窄的、离行远了收拢、落下后各自的位置、弹簧中途改方向不跳、长出时宽度只增不减且字最后出来）、标签坞 2 个、字素边界和失焦规则 2 个、多行输入双击选词三击选段 1 个。GPUI 测试平台上的行为测试 25 个：
- 悬停卡 200 ms 时没出、230 ms 时出了，离开后 200 ms 还在、230 ms 走了；滚动收起、指针不动不会重新弹出、真正移动后才弹；
- 单行输入组字中不报告、回车不提交；失焦丢掉拼音、只让系统丢弃一次、迟到的上屏不收；切应用丢掉；无边框的高度是外面的一行；
- 对话框：不给 `on_mist` 时点雾和点 ✕ 都关；给了就各走各的，点卡片里面两个都不调；
- 界面文字：十个字宽的栏里第十一个是「，」时它悬挂、不另起一行，第十一个是汉字时才换行；`max_lines`、外面的 `line_clamp` + `text_ellipsis`、不换行、分段的高度都对；
- 多行输入（7 个）：按宽度换行并长高、上下键对准同一列、软换行处的 End 和 Home、回车换段与提交取消、标题回车提交且不换行、失焦丢掉拼音（细节见「输入框与组字」）；带框的是三行高的稿纸片、随字长高、点内边距进框；
- 翻页叠化告诉页面它的透明度：静止时 1，翻页时底下那页 1、新页从 0 起，中途在 0 和 1 之间，翻完回到 1；
- 色标：点一下按色标的颜色打开取色器，拖过的每个颜色都回到调用方；停用时不开；
- 点当前的 Panel Tab 只有 `report_selected` 时才回调；
- 滑块按下跳到指针处、拖出两端停在端点、松手后不再跟、方向键和 End 生效、到头再按不算改变；
- 数字框打「2」不预览、打成「24」预览、越界不预览而回车收回到 28、↓ 减一、乱打后离开保持原值；
- 药丸拖到第三颗的位置上换位；
- 标签坞：平时是记号，指上去展开，离开 200 ms 还开着、260 ms 后收回，锁住常开；自己的药丸在手里时拿到行外也不收，拿回行上在第三颗处松手换位，松在行上不收；松在行外什么都不动、坞等完 260 ms 收回。

## 和旧版不一样的地方

旧版为 WebKit 做的性能补丁一律不搬：避开暂停动画样式税的 `lib/glass-awake.ts`、隐藏常驻的标签页、输入法查询的 `TextInputLookupStop` 之类。新版照它们背后的视觉规格做（玻璃平时静止、悬停才流动），性能问题在 GPUI 上本来就不存在：静止时不出帧。

下面几条是 GPUI 的限制逼出来的，按「最克制」取了做法：

- **玻璃不能整体变淡。** GPUI 的 `opacity` 是乘到每个图元上的，遮盖法的「底色盖子」一变淡，中间的纹理就透出来。所以停用的输入框、开关不再整块变淡，而是字变浅、玻璃退回淡细线；通知药丸淡入淡出的那 0.16–0.3 s 里，边临时换成均匀细线。
- **翻页叠化时新页的字略淡于底色。** 同样因为没有整组透明：新页的底色和字各自按同一浓度画，叠化中途字会比底色稍浅一点，180 ms 内看不出来。
- **水波的软边是阶梯。** 没有渐变遮罩，软边用 5 级不同浓度的竖条拼出来。
- **悬停卡的「滚动收起」**看的是对象自己的位置有没有动：它所在的任何一层滚动了就收起。卡片自己内容滚动时只会重新定位的那条，等有长内容的悬停卡时再做。
- **多选一放不下时收成单个 tab** 还没做，见「下一步」。
- **拖着的药丸不加阴影。** 旧版拖动时手里是一份静止的药丸副本按弹簧跟手，这一份照做了（刚度、不回弹都一样）；它浮在什么上面都有可能，所以玻璃边退回均匀细线、不遮角，按设计规则也不加投影（旧版那份副本有一层投影）。
- **让位用的是「按弹簧曲线缓动」，和旧版一样**，不是真的物理弹簧：中途改目标时从当前位置重新起一段 520 ms。旧版为 WebKit 松手前那个假的 `dragleave` 等 150 ms 的做法不用搬：GPUI 的拖动没有这个事件。
- **拖动时贴着两端不会自动滚动药丸行**（旧版贴边 40 px 内每秒最多滚 600 px），药丸多到放不下时要先滚好再拖，见「下一步」。
- **记号散开没有模糊。** 旧版药丸长出时，原来的记号放大成 2.8 × 1.6 倍、模糊 1.4 px、淡出；GPUI 不能模糊一个元素，这里只放大和淡出。
- **GPUI 拖动时什么都不算「指着」**（它的悬停在有拖动时一律为假）。所以标签坞自己记着「药丸在手里」来保持打开，松手时当作刚离开：等 260 ms，指针还在坞上就不收。别的东西在拖时（比如以后从侧栏拖一章过来）要撑开它，调用方传 `.held_open(…)`。
- **名字**：旧版的 `GlassSlider` 是多选一，在这里叫 `Segmented`；数值滑块旧版叫 `GlassRange`，这里叫 `Range`。F6 文档和监管里说的「数值滑块 `GlassSlider`」就是 `Range`。
- **多行输入照旧版的 `textarea` 做，有几处不一样**：旧版靠浏览器，有撤销、⌥← / ⌥→ 按词移动、⌥⌫ 按词删；这里都还没有（单行输入也没有），见「下一步」。旧版书名是 `<input>`、章节标题和梗概是自动长高的 `<textarea>`、标题用 JS 去掉换行；这里分别是 `TextField::bare()`、`TextArea::submit_on_enter()`、`TextArea`。旧版的保存时机（失焦时存、Esc 恢复原值）在宿主，组件只发事件。
- **面板图标按钮的悬停加深之前没生效。** 它的图标在建元素时就按父元素的字色定了颜色，那时还不知道指针在不在上面，所以悬停时只有底色变、图标不变深。现在把悬停色直接挂在图标上（GPUI 的 `svg` 在画的时候才取颜色），加深和危险色都生效了。
- **数字框的停用、读屏**：数字框整体是读屏里的「数值调节框」（SpinButton），上下限和当前值都报给读屏；两枚笔折本身没有单独的名字（旧版有「增大 / 减小某项」的读屏文案，要文案键，等 F6 的文案表）。

## 待协调

- **F6（外壳）换用 `TabDock`**（F6 下一轮做，dr-ui 这边已经有了；第二个里程碑列的那几样 F6 已经换完）：
  - `workspace/dock.rs` 的 `dock()` 换成 `TabDock::new("dock", 标签, ws.nav.active_index())`：每个标签 `DockTab::new(现在的 pill(…))`，分屏标签加 `.marks([两半的 DockMark::new(kind, 颜色).hollow(preview)], 焦点在哪一半)`；`.locked(ws.dock_locked)`，`.leading(…)` 放锁的 `IconButton`，`.trailing(…)` 放 `+`，`.on_change`、`.draggable`、`.map_pill` 原样搬过去。外面那层定位（标题栏高度、避开两个上角的 `lead` / `trail`）留在外壳。
  - 悬停和收回交给组件：`Workspace` 里的 `dock_hovered`、`dock_collapse`、`hover_dock()` 可以删，`kind_group` 换成 `dr_ui::components::dock::kind_family`。外壳现在用 `cx.has_active_drag()` 撑开药丸行；组件自己的药丸在手里时已经会撑开，只有别的拖动（以后从侧栏拖条目）也要药丸时才传 `.held_open(cx.has_active_drag())`。
  - `draggable` 的回调意思变了一点：现在是「落在药丸行上、它让出空位的那一位」，不再是「落在哪颗药丸上」，落回原位不回调；松在稿纸左右半边照旧由稿纸的 `on_drop::<DockDrag>` 接，药丸弹回原位。`ws.nav.reorder(from, to)` 不用改。
  - 外壳待协调第 3 条第一项（`PillGroup` 收尾那几帧要帧）是提醒，不用改；那段过渡本来就短，结束就停帧。
- **F4（编辑器）与组字**：dr-ui 已改用 `gpui-ime`。两处请 F4 看一眼：
  - 编辑器只在失焦时丢弃拼音；dr-ui 的输入框切到别的应用或窗口（窗口不再是活动窗口）时也丢弃。要不要统一，由 F4 定；dr-ui 这样做是因为切应用回来时框里留着一段没人管的拼音最难懂。
  - macOS 上，GPUI 在把鼠标按下交给界面之前，先交给输入法的 `handleEvent:`。点别处的时候，有的输入法会在这一下自己把拼音（或当前候选）上屏，这时框还有焦点，上屏的字会被收下，失焦规则管不到。编辑器也一样。要真实输入法矩阵确认；如果要拦，得在 GPUI 里改（F4 的 GPUI 补丁台账）。
- **M01、M02、M03 接入新的输入组件**（各模块自己做，用法写在共享笔记 `f5-ui-interface.md`）：
  - M02 原地改书名：`TextField::bare()` 一直显示在书名的位置，外面那层定好 34 px 的正文字体；`Submitted` 存并失焦，`Cancelled` 放回原名并失焦，`Blurred` 存（旧版就是失焦存）。本书简介换成 `TextArea`。
  - M03 章节页：标题用 `TextArea::submit_on_enter()`，`Submitted` 时存并把光标放进正文开头（`gpui-prose` 那边的接口）；梗概用 `TextArea`。新建章节时标题全选用 `select_all_text`。标题最后一行按 ↓ 现在是到结尾，要不要改成进正文，由 M03 定，dr-ui 可以加一个回调。
  - M01 书卡的字纸篓：`PanelIconButton::new(…, Icon::Trash).danger()`。
- **F6 的快捷键**：`keymap::apply` 清空后调的 `dr_ui::input::field::bindings()` 现在也包含多行输入的键（各在自己的键上下文里），外壳不用改；以后可以改调同一份的新名字 `dr_ui::input::bindings()`。
- **界面文字的中文禁则（M09 等）**：GPUI `v1.27.0` 的换行不避行首标点（M09 历史快照的摘录里「，」落在行首）。dr-ui 的 `text::wrapped` 按编辑器的规则换行，并认外面的 `line_clamp` / `text_ellipsis`；dr-ui 自己的悬停卡摘要、空状态那句话、对话框副标题已经换上。各模块把多行的界面文字从 `.child(文字)` 改成 `.child(dr_ui::text::wrapped(文字))` 即可，已知的几处：
  - M09 `dr-view-history/src/dialog.rs` 的摘录（`line_clamp(2)`）；
  - M02 `dr-view-home/src/view.rs` 845 行附近（`line_clamp(2)`）；
  - M01 `dr-view-shelf/src/view.rs` 1076 行附近（`line_clamp(2)`）。
  
  不想逐处改的话，根本的修法是给 GPUI 的 `LineWrapper` 打补丁接上同一套规则（F4 的 GPUI 补丁台账）。
- **F6：翻页叠化交给页面，删掉 `repaint_turning`。** `stage.rs` 的 `PageTurn::new` 换成 `PageTurn::with_level(id, 页键, \|键, 透明度, w, cx\| …)`，把透明度一路传到编辑器：章节和全书编辑器自己画 `ProseEditor::element`，要 F4 给 `ChapterEditor` / `BookEditor` 一个「这一帧在这个透明度下画」的入口（里面换成 `ProseEditor::element_at_opacity`）。翻页那几帧每帧都会重画一次，翻完再按 1 画一次，所以缓存视图不会留在开头那帧的淡色。
- **M01：表单梗概和本书简介换成 `TextArea::framed`**，删掉 `dr_view_shelf::frame::area`（M02 的本书简介 `.framed(4.0)`）。
- **M11 类目、M13 故事线：色标换成 `ColorSwatch`**（`.mark(Kind::Category)` / `.mark(Kind::Storyline)`，`on_pick` 里 `category.update` / `storyline.update` 写 `color::hex(颜色)`）。设置里的强调色、光标色、实体链接分类色以后也用它（`.show_value()`）。
- **F7（平台）：取色器的系统调用放在 dr-ui 里。** 和输入法的「丢弃拼音」一样，GPUI 没有取色面板的接口，dr-ui 直接在窗口的平台句柄上调：macOS 用运行时注册的小类接 `NSColorPanel` 的动作，Windows 的 `ChooseColorW` 在单独线程上开、以窗口为主人（和 GPUI 开文件对话框一样）。Windows 那段只在本机单独做了类型检查（gpui 的 Windows 构建脚本在 Mac 上跑不了），要 CI 真编译；工作区的 `windows` 依赖为它加了 `Win32_UI_Controls_Dialogs`。F7 以后要把平台对话框收到 dr-platform，可以连它一起搬。
- **F7：反馈对话框加回 ✕ 和点雾。** `Dialog::new(…).on_close(关).on_mist(\|w, cx\| 没写字时才关)`：✕ 总是关，点雾只在消息框是空的时候关（旧版的 `closeOnBackdrop`）。
- **F7（打包）与字体**：已接上。`next/script/bundle-mac` 拷完可执行文件后调用 `crates/dr-ui/script/install-fonts "$APP/Contents/Resources"`（缺字体时它报错并说明怎么生成）；以后的 Windows 安装包同样把字体放进可执行文件旁边的 `fonts/`。
- **CI**：`next.yml` 在编译前生成字体并缓存，缓存键是 `provenance.json` 和生成脚本的哈希（每个平台各一份）；测试步骤设了 `DR_UI_REQUIRE_FONTS=1`。Windows 上用 `tar` 还是 `7z` 解 7z 没有实测；dr-ui 新加的 Windows 输入法调用也是第一次在 CI 上真正编译。
- **右键**：dr-ui 没有任何右键菜单组件，也没拦截右键。

## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1 | 令牌：颜色、字号、间距、圆角、动效 | 完成 |
| 2 | 字体，中文显式指定 | 完成：构建产物，不进 git；应用包里怎么放见「待协调」 |
| 3 | 组件：按钮、开关、分段、筛选片、药丸与水波、下拉、菜单、悬停卡、浮层与对话框、通知药丸、空状态、加载 | 完成；多选一窄时收起未做 |
| 4 | 单行输入（组字状态机独立） | 完成最小可用版；没有撤销、按词移动（多行输入有双击选词） |
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
| 5 | 组字换成 `gpui-ime` | 第三个里程碑完成 |
| — | 修了上一轮的两处毛病：悬停卡、菜单的圆角外偶尔露出方角；截图压缩把故事线颜色压成了一种蓝 | 完成 |

第三个里程碑（11-08）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | 单行输入改用 `gpui-ime` 的 `LineComposer`，删掉 dr-ui 的 `Composer` | 完成；dr-ui 只留字素边界和系统那一下 |
| 2 | 失焦统一为「清掉 + 让系统丢弃」 | 完成：macOS `discardMarkedText`、Windows `ImmNotifyIME(CPS_CANCEL)`；失焦后迟到的上屏不收；Windows 那段只在本机做了类型检查，CI 上真编译 |
| 3 | F6 第二个里程碑待协调里给 F5 的：标签坞整个做成组件（小点长成药丸、其余药丸让位、拖离收拢） | 完成：`TabDock`；`PillGroup` 有了让位、收拢、落位弹簧和长出；另一条是提醒，不用改 |

第四个里程碑（11-08，从 main `15299820`）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | 无边框的单行输入，字号字重跟着外面的字走（M02 原地改书名，以后章节标题） | 完成：`TextField::bare()` |
| 2 | 无边框的多行输入（本书简介、章节梗概、自动换行且回车进正文的章节标题） | 完成：`TextArea`，`.submit_on_enter()` 给标题；中文断行用 `prose-linebreak` |
| 3 | 悬停时变危险色的图标按钮（书卡的字纸篓） | 完成：`PanelIconButton::danger()`；顺手修了面板图标按钮悬停加深不生效 |
| 4 | 查 G7：缓存视图里的元素从读屏树掉出去 | dr-ui 没有缓存视图，碰不到；写了以后谁要缓存时怎么做 |
| 5 | 组件放进样张，用法写进共享笔记 | 完成：样张多了「输入」页；共享笔记 `f5-ui-interface.md` |

第五轮（11-08，从 main `1652a95e`）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | 对话框分开「点 ✕」和「点雾」 | 完成：`Dialog::on_mist`；不给时点雾和 ✕ 一样（已有的对话框不变） |
| 2 | 界面文字换行避头尾 | 完成：`text::wrapped`，dr-ui 自己的多行文字已换；各模块的几处见「待协调」 |
| 3 | M03 章首章末 | 完成：新 crate `dr-view-page`，见 [m03-page.md](../modules/m03-page.md)；dr-ui 加了 `tokens::page`、`SandCell::icon` / `dense`、`AreaEvent::PastEnd` |

第六轮（11-08，从 main `60d510a6`，先合进了 F4e 第四批 `87206943`，监管说下一批对一遍）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | M03 接上 F4 的 `ActPage` 和构想页 | 完成：扉页「第一幕 / 幕名 / 干笔 / 9 章 · 3.3k 字」，构想页的标题和梗概；见 [m03-page.md](../modules/m03-page.md) |
| 2 | `PageTurn` 把叠化进度交给子元素 | 完成：`PageTurn::with_level`；外壳和编辑器那头见「待协调」F6 |
| 3 | 带框的多行输入 | 完成：`TextArea::framed(行数)` |
| 4 | 取色器 | 完成：`ColorSwatch`，点开系统的取色板（macOS 在本机真开过一次、颜色回得来；Windows 单独做了类型检查） |
| 5 | M25 书架封面与写作热力图 | 完成：新 crate `dr-view-shelf-art`，十四种画风逐行照旧版移植并和旧版逐张对照，热力图、近 30 天砂条、换画风按钮；见 [m25-shelf-art.md](../modules/m25-shelf-art.md)。放进书架是 M01 的事 |

第七轮（11-08，从 main `2eb865fa`）：

| # | 内容 | 状态 |
| --- | --- | --- |
| 1 | `format::compact` / `grouped` 挪进 dr-i18n | 完成：`dr_i18n::number`，书架、书架的画、作品主页、导入、故事线页、统计、页眉都改用它；统计的 `grouped` 带正负号，包了一层；要素面板不再需要依赖书架 |
| 2 | M24 字海、加载与首次体验 | 完成组件和流程：新 crate `dr-view-sea`（字海、整窗等待、首次运行、样书落位、导览）、`dr-samples`（两本内置样书，从测试工具里搬出来，种子摘要不变）；见 [m24-sea.md](../modules/m24-sea.md)。放进外壳和书架要 F6 开登记口、M01 改书架，接法写在那份文档里 |

## 下一步建议

1. F6 下一轮换用 `TabDock`（见「待协调」）；M01、M02、M09 把多行界面文字换成 `text::wrapped`。
2. 输入框还差的：撤销、按词移动和删除（⌥← / ⌥→ / ⌥⌫）、进读屏树（角色加文字段，参照编辑器的 `input/a11y.rs`）。
3. 标签坞还差的几样：关掉一个标签时它的药丸缩回记号宽、两边合拢（旧版 `dock-leave.ts`）；按可用宽度分配药丸宽度（旧版 120–320 px 按比例）；拖着贴近两端时自动滚动；键盘焦点落在记号上时也长出药丸。
4. 补完 `Segmented` 放不下时收成单个 tab、`Select` 多于 8 项时的搜索框、多选一的交接键（Super View 切换器用）；设置注册表的颜色项用 `ColorSwatch`。
5. 玻璃控件的键盘焦点（`focus-visible` 与悬停同效）要等 F6 定下焦点和快捷键框架后一起做；`Range` 已经这样做了（键盘焦点在上面时晕出圆玻璃）。
6. 输入法矩阵第 8 项（单行输入）请作者手测：标题、搜索、设置三种框，加上多行的简介和会换行的标题，各在系统拼音、搜狗、微信输入法下组字、选中替换、组字中点别处和切应用；看点别处时拼音是被丢掉还是被输入法自己上屏了（见「待协调」F4 第二条），以及多行里候选窗是不是贴着组字的那一行。

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
| `src/components/` | 组件；`dock.rs` 是标签坞，`reorder.rs` 是拖动让位、落位和药丸长出的几何与时间（纯函数） |
| `src/text.rs` | 按中文规则换行的界面文字（`wrapped`），以及多行输入共用的分段排版 |
| `src/input/` | 单行输入（`field.rs`，含无边框的 `bare`）、多行输入（`area.rs`：排版、断行、上下移动、软换行处的光标）；`ime.rs` 是 `gpui-ime` 之外的两样：字素边界、让系统丢弃拼音 |
| `src/transitions.rs` | 翻页（`with_level` 把透明度交给页面）、推进 |
| `src/components/color.rs` | 色标和系统取色器（macOS `NSColorPanel`、Windows `ChooseColorW`） |
| `src/anim.rs` | 补间、截图时冻结时钟、只在动的时候要下一帧 |
| `examples/gallery/` | 样张、离屏截图与测量 |
| `tests/` | 单行和多行输入、悬停卡、取值控件（Panel Tab、滑块、数字框、拖药丸）、标签坞、对话框的两个关闭回调、界面文字换行、翻页透明度、色标的行为测试 |
