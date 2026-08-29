# Workspace surface language

Drifting 的主工作区采用“单层桌面，只有一张抬起的稿纸”的结构。这个约束只重组表面层级与几何形态，不重新定义现有配色：`--paper-deep`、`--paper`、`--surface`、`--page`、`--rule` 与 ink tokens 仍然是颜色来源。

## Surface roles

1. **Workspace plane**：`AppTopbar`、编辑器周围区域、左右栏、底部时间线 dock 与 `BottomStatusBar` 共同组成一张连续桌面。它们全部使用从 editor 稿纸外侧提取的不透明 `--workspace-ui-bg: hsl(var(--paper-deep))`；一级模块不再用不同底色假装处于不同高度。
2. **Manuscript page**：`.page` 使用现有 `--page` 与 `--page-elevation`，圆角上限由 `--workspace-corner-radius: 2px` 控制。无论左右栏是否打开，它始终是主界面唯一抬起的一级工作面。
3. **Borders and internal levels**：细灰黑 `--workspace-border` 只表达顶栏、左右栏、Bottom Timeline 与 Bottom Status Bar 的一级模块边界。三方交点没有渐变、阴影或额外装饰。侧栏局部层级只在 Tabs 与 panel header 之间保留一条完整的 `0.5px` hairline；右栏达到双列阈值后，两列之间也用同一条 `--workspace-local-border` hairline，同时保留较宽的透明拖拽热区。panel header 直接衔接 content，不再重复画第二条线，侧栏 footer 顶线则再弱一级。Bottom Timeline header 保持 `--workspace-ui-bg`，幕/叙事时 rail 使用稍浅的 `--paper`，故事线轨道使用 `--page`；幕边界、时间点和相邻故事线轨道的静态 guide 使用 header 的 `--workspace-ui-bg`，厚度统一为 `0.5px`。

因此普通编辑状态只出现一块抬起的一级工作面：稿纸。标题栏、左右栏、Tab 栏、时间线与 footer 都不是额外的“岛”。

## Accent color

- `--accent`、`--accent-foreground` 与 `--ring` 是 renderer 的共享交互强调色契约。未自定义时，它们继续分别由 `:root` 与 `.dark` 的内置 palette 提供，不产生 inline override。
- 外观设置中的 `accentColor` 是可同步的六位 Hex 偏好；`null` 表示恢复当前浅色/深色主题的内置强调色。运行时必须先把 Hex 转成 HSL triplet，再写入 root token，因为现有消费者会组合 `hsl(var(--accent) / alpha)`。`--accent-foreground` 自动选择黑/白高对比前景，`--ring` 与 accent 同步；中性的 `--accent-border` 仍由主题 palette 管理。
- 编辑器 `caretColor`、Entity Link 的上下文/分类颜色、Storyline 与 Category 颜色都是独立语义，不跟随全局 accent。当前设置覆盖共享 renderer（包括移动 WebView UI），不宣称同步 iOS/Android 原生 system tint。

## Geometry and ownership

- `App.tsx` 只负责应用级 effects/routes；桌面工作区由 `DesktopAppShell` 组合为 `AppTopbar + app-row + BottomStatusBar`，`app-row` 内是 `Sidebar(left) + app-mid + Sidebar(right)`。
- `app-mid` 只拥有 `workspace-stage` 与可选的 `workspace-dock`；`BottomStatusBar` 位于三栏之外。
- footer 横跨整个窗口底部，左右栏与中间编辑列共同停在它上方，形成一条连续的全宽基线。
- 左右栏与 Bottom Timeline 不通过 z 轴高低区分；模块所有权只由外边界普通 hairline 表达。三方交点不再绘制任何渐变或阴影。
- 左右栏宽度与 Bottom Timeline 高度仍由各自现有的单轴 handle 独立调整；不实现同时改变三个区域的三向 resize，也不为不存在的能力绘制提示。
- 顶层工作面使用直角或最多 `2px` 圆角。更大的圆角不用于页面模块、栏、dock 或内容列表容器。
- Settings 与三个 Super Views 使用同样的平面化 shell：边缘对齐、无 shell gap、无 shell 圆角或阴影，以分隔线表达区域边界。

## Command and status ownership

- `AppTopbar` 的固定顺序是当前 Project 名称、搜索、左栏 toggle、项目主页、通览全书、`SUPER`、文档 Tabs、通知、右栏 toggle 与账户。`SUPER` 右侧与通知铃铛左侧分别使用和顶栏底边相同的 `1px --workspace-border` hairline，明确分开导航、文档 Tabs 与账户命令区。Project 名称是只读的位置锚点，不兼任项目切换器；普通图标按钮统一使用 `26px` 热区和约 `16px` 图标，低频入口不再各自占用一枚顶栏图标。
- 通览全书是 Project Home 与 `SUPER` 之间的独立纯图标按钮：`GhostIconButton` 承载 IconoirPageFlip 图标，与其他顶栏图标共用 `26px` 方形热区，直接进入 All Chapters editor，并以图标颜色表达 hover 与 active。`SUPER` 仍是不带 chevron 或其他图标的纯大写英文触发器，但它不再弹出菜单：点击直接进入上次使用的 overview（`openLastSuperView`）；Element overview、Story graph 与 TODO & Materials 三个目的地改由共享 Super View header 的 `navigationSlot`（`DesktopSuperViewHeader`）就地切换。旧的 `SUPER` 菜单与四个自绘 Super View 图标都不再存在。
- 顶栏整行的 icon button、Tab close 与 `SUPER` hover 都只提高前景文字/图标颜色，不绘制额外底色；icon button 通过 `aria-pressed` / `data-active` 暴露当前目的地，选中态同样只把前景色提高到 `--ink-1`，不绘制底色、下划线或其他附加选中装饰。真正展开的 dropdown menu item 仍保留行级 hover 以表达当前指向。
- Copilot 从顶栏移入账户 dropdown 的二级设置页。打开账户菜单后可就地修改 quick settings，并可继续进入完整 Settings；退出二级页先返回账户菜单，不直接关闭整个 dropdown。
- `BottomStatusBar` 以只读状态为主，报告当前上下文对应的章节/故事线/全书字数、今日新增字数，以及同步状态和最近成功同步时间；原 editor top bar 不再重复显示字数。唯一的交互例外是 Bottom Timeline 展开/收起开关，因为它直接控制 footer 上方相邻的 dock。
- 通知入口仍留在 topbar，因为它会打开通知中心，属于操作入口而不是被动状态。footer 后续只接受无需点击即可理解、且与当前写作任务有关的短状态。
- footer 保持 `20px` 高度并使用全宽所有权；除 Timeline 开关外，不把低频设置或导航重新塞回底部角落。

## Component shape rules

- 通用圆角阶梯限定为 `1px / 2px / 3px`；`--radius`、`--radius-xs`、`--radius-sm`、`--radius-md` 与 `--radius-lg` 不再制造“软卡片”层级。
- button、tab、badge、tag、chip、menu row、popover、dialog、toast 和内容卡片使用直角或上述小圆角。`pill` 只保留为旧 API 名称，不再对应胶囊几何。
- 页面卡片不依靠 hover 上浮、scale 或大面积阴影表达可点击性；改用边框、背景 wash 与文字颜色。菜单和 modal 可以保留一层克制的投影，用来表达真实遮挡关系。
- 禁止 inset-left vertical accent bar。Graph tile 仍可用覆盖块面的低浓度语义 wash；Bottom Timeline 的故事线名称 rail 与桌面 UI 使用同一底灰，颜色只留给真正承载故事线语义的 marker 与 clip。幕/叙事时 rail 内及故事线轨道里的静态竖线统一取 header 的 `--workspace-ui-bg`；相邻故事线轨道之间也用同色 `0.5px` 横线分隔。
- 只有形状本身承担语义时才允许圆形或胶囊：头像、状态点、加载 spinner，以及 switch 的 track/thumb。滚动条 thumb 沿用平台可拖拽形状；普通图标按钮不因此自动获得圆形外壳。
- Plot Planner 是连续的 mini-Excel：单元格共享 hairline 网格，不是带 gap、阴影和 hover lift 的卡片集合。

## Menu surfaces

- 右键坐标、三点按钮、排序按钮、breadcrumb 与顶栏入口只决定菜单如何定位，不决定菜单长什么样。按钮锚定面继续由 `AnchoredPopover` portal 到 `body` 并使用 `position: fixed`；React 内的坐标锚定菜单优先使用 `ContextMenuSurface`。编辑器 selection menu、ActRail 与资料卡保留各自已有的生命周期 owner，但同样必须 portal 到 `body`、固定定位并使用共享视觉 primitive。
- 所有动作菜单使用 `.menu-surface`。外壳唯一来源是 `--menu-surface-bg`、`--menu-surface-border`、`--menu-surface-radius` 与 `--menu-surface-shadow`；宽度只能从 compact / standard / wide / panel / settings 五档中选择，对应 `180 / 220 / 280 / 360 / 420px`，窄视口再由浮层 primitive 的 viewport max-width 收缩，不为单个入口另写任意宽度。
- 普通行使用 `.menu-surface__item`，采用 `12.5px / 18px` UI 字体、`6px 8px` padding 和 `--radius-xs`。单行内容稳定为 `30px`；文本超过一行时允许正常换行，由内容按 `18px` 行高自然撑高，不截断为单行，也不把富表单强制压进固定 cell。
- section label、header、divider 与 accelerator 分别使用共享的小型层级。当前 breadcrumb 只以背景 wash 与字重显示当前项，不绘制 inset-left accent bar。
- 账户、Agent 配置/历史、关系类型管理、资料卡摘要和“未放置”内容不是普通动作列表。它们使用 `.menu-surface--rich` 保留表单、摘要、chip 或多列布局，但外壳 token、基础字号、hover wash、圆角阶梯与浮层层级仍与简单菜单一致；不为了视觉整齐把富交互压成 30px 动作行。
- App 自绘菜单受上述约束；可编辑器在没有非空 selection 或只读时回退的浏览器/系统原生 context menu 不属于 renderer 可定制范围。静态测试能证明 token、class 与 portal/fixed 路径已收敛，不能证明不同平台上的字体栅格化、阴影观感或系统原生菜单外观；这些仍由用户在实际窗口中目测验收。

## Tabs and motion

- 顶部文档 Tab 与左右栏 Panel Tab 都由自身绘制静态矩形选中态。
- 桌面 Universal 新建入口是一个紧跟已打开文档 Tab 列表末尾的 `+`，与 Tab 一起处于横向滚动条带内；零 Tab 时它位于条带起点。它不是贴住顶栏右缘的固定命令，也不占用既有文档 Tab 的宽度预算：空间不足时入口随条带自然溢出。默认和 hover 都保持未选中 Tab 的透明底与次级文字色，键盘 `focus-visible` 只保留克制的轮廓。
- Universal 新建先打开会话级“新建…”占位 Tab。该 Tab 使用普通静态矩形选中态，可切换、可关闭，但不可 preview、拖拽或 split；关闭未提交占位不产生实体。选择类型后，章节/灵感/元素只补齐现有归属，故事线/类目直接使用默认名称创建，最终由真实实体 Tab 原位替换。
- 左右栏的 Tab 行固定为紧凑的 `28px`；其下单行 panel header 以约 `26px` 为基准，不用大块上下 padding 制造空白。
- Panel Tab 的默认、hover 与 active 背景完全一致；只用暗淡文字与黑色文字的切换表达未选中和选中，不使用彩色 label、`border-bottom`、inset shadow 或其他下划线。
- 左栏三个 Panel Tab 使用互斥的响应式表示：可用宽度至少 `220px` 时只显示“章节 / 元素 / 灵感”等文字；更窄时只显示对应 glyph，并以 title/aria-label 保留名称。任何宽度都不同时并排图标与文字。
- 不存在跨 Tab 滑动的 pill indicator，也不为选中态测量 DOM 几何。
- 文档 Tab 切换和自动滚动是即时的；拖拽重排仍保留窄插入线，因为它表达 drop 位置而不是选中动画。
- 侧栏开合是工作区保留的结构性动效，时长为 `220ms`；`prefers-reduced-motion: reduce` 时禁用。

## Dense content and semantic controls

- 侧栏中的高密度 TODO/资料列表使用 `.workspace-list` 与 `.workspace-list-row`：cell 不绘制 border，保留 `2px` 小圆角和略浅于 panel 的灰色底，彼此留出小间距；hover/focus 只轻微提高底色，不增加阴影或位移。以后左右栏新增的卡片型条目也必须直接复用这套背景与 `--workspace-cell-hover-bg`，不另造中性色、边框或 hover wash。
- 左栏的章节、元素与漂流 cell 选中态复用顶部文档 Tab 的 `--surface` 背景，并以 `--ink-1` 文字和现有字重表达焦点；不再使用蓝色 `--accent` wash。紧凑元素卡的选中态只使用该高亮底色，不绘制 category 色或中性双层 border；键盘 `focus-visible` 轮廓仍独立保留。hover 与 TODO/Library card 共用 `--workspace-cell-hover-bg` 的轻微提亮，不再叠加黑色 wash。
- 章节 panel 的全书/故事线视图切换与元素 panel 的紧凑索引/名称列表切换都使用 header 左侧的纯文本摘要。章节无论是否按故事线分组，都固定显示故事线数与章节总数；元素始终显示类目数与元素总数。文字本身是点击区域，只以文字颜色变化表达 hover/focus，不绘制 switch、底框或背景；显示模式不进入排序菜单。
- 章节 panel 按故事线分组时，“未归属”复用普通故事线组的 header、计数、折叠与新增章节交互，并固定追加在全部真实故事线之后；其章节继续服从故事线内排序，左侧 label 使用与组头一致的 `--ink-4` 中性灰，不留透明空槽。它与其他组共用同一个滚动容器，不再使用独立的底部 footer、展开抽屉或高度状态。
- 章节与元素 panel 的排序菜单把内外两层作为独立偏好：故事线内章节使用阅读/叙事顺序，外层故事线使用持久化的 `orderKey` 故事线顺序或名称顺序；类目内元素与外层类目分别选择名称/创建时间。不要按子项数量或最近更新自动排列外层容器，避免写作过程中整栏频繁跳位。“未归属”与“未分类”始终固定在真实故事线/类目之后；已有元素排序偏好迁移时同时初始化新的外层类目偏好，之后两者独立持久化。
- 元素 panel 不再设置 category footer、横向 chip 导航或独立高度状态。category header、元素 cell 与“未分类”组全部留在同一个纵向滚动面内；sticky header 负责持续表达当前结构，不在底部重复一套可视 category 状态。
- `GroupHeaderCell` 的新增动作使用紧随 label/count 的共享 inline slot：category 的 `+` 在紧凑索引中常驻，并作为唯一的 category 创建入口打开锚定菜单，菜单打开期间触发器继续可见，再分流到“新建元素”和“新建分组”；章节故事线与一级灵感 group 继续在当前 header hover/focus 时显示；element group 与二级灵感 group 也把动态 `+` 放在各自 label/count 之后。显隐选择器只命中当前 header，父 group hover 不得连带揭示后代按钮。element group 不是独立实体，而是 element 的 `groupName`；因此“新建分组”必须输入名称并同时创建、打开首个 element，不制造无法持久化的空 group。
- 元素 panel 提供可持久化的“紧凑索引 / 名称列表”两种纯文字显示模式，由 header 左侧“X 类 · XX 元素”摘要直接往返切换。紧凑索引中，展开的 category 以自身颜色的 `1px` 细框包住全部内容；顶边不是完整横线，而是由 category 文本 label 两侧分别发出，并由 sticky header 同层的竖向接缝连接左右边与底边，label 使用普通 `--chrome-bg` 切开中段，整个容器保持透明且不叠加色洗。label 前的固定 disclosure hit area 在展开时显示与同层 `+` 一致的普通前景色 `−`，点击收起后同一位置变成 category 色方块，点击再展开；真实 category 的文本 label 单击进入 editor、双击固定 tab，不再兼任折叠。没有 element 的 category 永远保持不可展开的方形色块，但文本 label 仍可进入 editor；通过创建菜单加入第一个 element 后才获得彩框。具名 element group 在彩色 category 框内再以低对比度的 `1px --rule` 中性细线框住其文字卡片，不增加底色；连续具名 group 不加额外 margin，其间距与 group label 到下方卡片的距离相同，只有最后一个具名 group 与随后未分组卡片之间增加语义间距。未分组元素不画 group 框。文字卡片直接复用素材库/TODO 卡片的无边框 `.workspace-list-row` 背景、圆角和 hover token，不再定义独立卡片色；选中时只切换到 `--surface` 高亮。紧凑卡片与旧名称列表的 element label 共同复用 `.element-panel-item-label`：`--font-sans`、`12.5px`、常态字重 `400`、`1.35` 行高与 `-0.005em` 字距，选中时统一升为 `500`，两种视图不得分别定义另一套字号或字重。卡片使用 wrapping flex flow：名称估算宽度决定其初始 `flex-basis`，同行剩余空间由卡片共同吸收，因此短名称可在一行容纳更多项、长名称获得更多阅读空间，最后一行也不遗留固定方块造成的空洞；栏宽不足时自然退回单列。完整名称直接显示并允许换行，Agent 活动只占末端小状态标记。
- 标签、状态 chip、菜单、popover、dialog 和预览内容保持小圆角；头像、状态点、spinner 与 switch 可以保留其语义形状。它们不计作一级页面模块，也不应被无差别的全局 `border-radius: 0` 误伤。
- 不使用 inset-left vertical accent bar；强调状态继续使用背景 wash、细分隔线、字重或语义颜色。

## Persistence and responsive behavior

- 新状态默认收起左右栏，使首次进入时只突出稿纸。
- 已持久化的用户侧栏开合状态继续被尊重；这次调整不强制覆盖现有偏好。
- Header、左右栏、编辑器外侧、Bottom Timeline 与 `BottomStatusBar` 在所有平台都直接使用不透明 `--workspace-ui-bg`。macOS 也不再启用透明窗口、`windowEffects` 或 `macOSPrivateApi`；Tauri 窗口配置显式保持 `transparent: false`，renderer 不再加载单独的原生材质样式。这样三处灰色底色来自同一个普通颜色 token，不依赖桌面壁纸、窗口激活状态或系统材质变化。
- macOS 红绿灯固定为 `x: 18, y: 22`，基础配置、macOS 覆盖配置与运行时校正必须保持一致。renderer 顶栏高 `42px`，同排图标与文字按钮高 `26px` 并通过 `align-items: center` 共用中心线；`y: 22` 是针对原生 overlay 坐标系校准后的偏移。
- 桌面顶栏在红绿灯（其他桌面平台为普通 leading inset）之后持续显示当前 Project 名称。macOS leading inset 固定为 `94px`，在第三个红绿灯之后留下独立呼吸空间。名称直接订阅已发布的 `currentProject.name`，重命名后即时更新；整个名称槽是返回书架的语义按钮，默认显示单行、可省略的项目名，hover 或键盘 focus 时原地切换为返回书架。按钮始终保留项目名决定的原始占位，最大不超过 `min(220px, 22vw)`、最小为同排控件高度 `26px`，切换内容不得推动搜索、导航或文档 Tabs；内部 container 按实际槽宽决定文案，低于 `54px` 只显示返回箭头，足够宽时显示箭头与本地化“书架”短标签，完整动作与项目名由 `title`/`aria-label` 暴露。按钮显式退出 Tauri drag region，名称左右的空白仍属于父级窗口拖动面。左侧 section 使用 intrinsic width，命令组禁止收缩，因此后续控件紧跟实际项目名而不是对齐固定栏宽；移动端不复用这一桌面标识，账户菜单中的书架入口继续作为冗余路径。
- Project Home 自己拥有垂直滚动：`.dash` 必须以 `width/height: 100%` 受当前 shell 约束，并使用 `overflow-y: auto`。桌面 Home 保留完整 workspace chrome，但不绘制 Tab 外观；移动 Home 是 paper row 之外的独立 safe-area surface，仅增加项目级 Back、paper overview 和继续当前 paper 入口。隐藏的只是 scrollbar chrome，不是滚动能力。
- 移动端仍保留安全区 padding。侧栏保持 overlay 行为，但表面角色与桌面一致。桌面 topbar 的左右 command groups 在窄屏暂时隐藏；移动端必须用独立的 action menu/sheet 恢复这些能力，不能据此宣称功能等价。
- Super View overlay 停在全宽 `BottomStatusBar` 上方；工作区入口已经迁到 topbar。

## Acceptance

静态结构契约由以下测试保护：

```bash
pnpm exec vitest run src/renderer/components/workspace-surface-language.acceptance.test.ts src/renderer/components/project-dashboard-scroll.acceptance.test.ts src/renderer/components/workspace-titlebar-alignment.acceptance.test.ts src/renderer/components/left-sidebar-tab-density.acceptance.test.ts src/renderer/components/leftBars/element-panel-no-category-footer.acceptance.test.ts src/renderer/components/leftBars/element-panel-compact-index.acceptance.test.ts src/renderer/components/leftBars/left-sidebar-outer-sort.acceptance.test.ts src/renderer/shells/desktop/entity-create/desktop-universal-create.acceptance.test.ts
pnpm exec vitest run src/renderer/components/menu-surface-style.acceptance.test.ts
pnpm exec vitest run src/renderer/lib/theme.test.ts src/renderer/components/accent-color-preference.acceptance.test.ts
pnpm test:renderer-architecture
```

测试覆盖 footer 的 DOM、状态职责与唯一 Timeline 开关、元素 panel 已移除的 category footer、紧凑索引的持久化模式/header 摘要切换入口与 sort menu 分离/纯文字内容/流式宽度/素材库与 TODO 的无边框卡片背景复用/label 两侧 category 边框及 sticky 接缝/收起色块形变/空 category 禁止展开/纯背景选中态/连续 group 节奏与未分组边界/category 常驻新增按钮的锚定双路径菜单与首元素建组语义，以及章节、灵感、element group 的 inline 动态按钮、章节/元素内外层排序解耦及末尾虚拟组约束、topbar command ownership、当前 Project 名称的桌面位置锚点、原地返回书架状态、实际宽度标签与不压缩命令组约束、Super 菜单、账户二级设置页、动作菜单与富内容 menu/popover 的共享外壳和危险项语义、不透明 macOS 窗口配置、顶栏与左右栏的统一灰色 token、一级 surface classes、静态 Tab、已移除的滑动 indicator、侧栏默认状态、Settings/Super View shell 与本文档。TypeScript、Vitest、renderer build 与 Tauri 配置检查可以证明结构与打包成立，但不能替代 macOS titlebar 几何、iOS 或 Android 上的视觉、触摸和动效验收；新增返回按钮的 native hover/focus、点击命中、项目名截断与窗口拖动边界仍需要在真实窗口中目测。

Renderer 的桌面/共享所有权规则记录在 [`renderer-ui-architecture.md`](renderer-ui-architecture.md)；移动端起点、缺口和设备验收边界记录在 [`mobile-ui-foundation.md`](mobile-ui-foundation.md)。
