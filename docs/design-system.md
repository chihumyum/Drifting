# Workspace surface language

Drifting 的主工作区采用“单层桌面，只有一张抬起的稿纸”的结构。这个约束只重组表面层级与几何形态，不重新定义现有配色：`--paper-deep`、`--paper`、`--surface`、`--page`、`--rule` 与 ink tokens 仍然是颜色来源。

## Surface roles

1. **Workspace plane**：`AppTopbar`、编辑器周围区域、左右栏、底部时间线 dock 与 `BottomStatusBar` 共同组成一张连续桌面。它们全部使用从 editor 稿纸外侧提取的不透明 `--workspace-ui-bg: hsl(var(--paper-deep))`；一级模块不再用不同底色假装处于不同高度。
2. **Manuscript page**：`.page` 使用现有 `--page` 与 `--page-elevation`，圆角上限由 `--workspace-corner-radius: 2px` 控制。无论左右栏是否打开，它始终是主界面唯一抬起的一级工作面。
3. **Borders and internal levels**：细灰黑 `--workspace-border` 只表达顶栏、左右栏、Bottom Timeline 与 Bottom Status Bar 的一级模块边界。三方交点没有渐变、阴影或额外装饰。侧栏局部层级只在 Tabs 与 panel header 之间保留一条完整的 `0.5px` hairline；左右栏显示双列时，两列之间也用同一条 `--workspace-local-border` hairline，同时保留较宽的透明拖拽热区。panel header 直接衔接 content，不再重复画第二条线，侧栏 footer 顶线则再弱一级。Bottom Timeline header 保持 `--workspace-ui-bg`，幕/叙事时 rail 使用稍浅的 `--paper`，故事线轨道使用 `--page`；幕边界、时间点和相邻故事线轨道的静态 guide 使用 header 的 `--workspace-ui-bg`，厚度统一为 `0.5px`。

因此普通编辑状态只出现一块抬起的一级工作面：稿纸。标题栏、左右栏、Tab 栏、时间线与 footer 都不是额外的“岛”。

## Accent color

- `--accent`、`--accent-foreground` 与 `--ring` 是 renderer 的共享交互强调色契约。未自定义时，它们继续分别由 `:root` 与 `.dark` 的内置 palette 提供，不产生 inline override。
- 外观设置中的 `accentColor` 是可同步的六位 Hex 偏好；`null` 表示恢复当前浅色/深色主题的内置强调色。运行时必须先把 Hex 转成 HSL triplet，再写入 root token，因为现有消费者会组合 `hsl(var(--accent) / alpha)`。`--accent-foreground` 自动选择黑/白高对比前景，`--ring` 与 accent 同步；中性的 `--accent-border` 仍由主题 palette 管理。
- 编辑器 `caretColor`、Entity Link 的上下文/分类颜色、Storyline 与 Category 颜色都是独立语义，不跟随全局 accent。当前设置覆盖共享 renderer（包括移动 WebView UI），不宣称同步 iOS/Android 原生 system tint。

## Desktop typography

桌面 UI 遵循 [Apple Typography](https://developer.apple.com/cn/design/human-interface-guidelines/typography) 的可读性、语义层级与可放大原则。Apple 的 macOS 默认/最小值是 13pt/10pt；下面是针对中文写作界面选择的 CSS px 档位，不把 pt 机械换算成 CSS px，也不把最小值用作常用文字的默认值。

- `desktop-typography.css` 在 `html[data-shell-mode='desktop']` 定义 body / secondary / caption / emphasis / heading，标准档分别为 `14 / 13 / 12 / 15 / 16px`，较大档各增加 `2px`。保留现有 UI 字体。字号角色覆盖桌面导航、侧栏列表、菜单、设置、Agent/Review 工具、搜索和时间线 UI；图形 glyph、内容标题与稿件排版保留各自语义。
- 外观 → 界面字号提供“较小 / 标准 / 较大”，默认标准，立即生效并保存在此设备的 `settings-storage.interfaceTextSize`；缺失/非法值回落到标准。“较小”使用各组件调整前保留的字号 fallback，例如菜单 `12.5px`、侧栏标签 `11.5px`、状态栏 `10px`、设置说明 `12px`；不是统一减去 `2px`。该档保留标准档的控件留白、行高和改善后的对比度。移动 shell 不显示该选项，共享组件的原字号作为 CSS fallback；这不是接入原生 Dynamic Type 的声明。
- Agent 对话跟随同一界面字号设置：较小／标准／较大档的用户消息、回复、输入框和代码为 `12 / 14 / 16px`，思考与工具说明为 `11.5 / 13 / 15px`，时间与用量为 `10.5 / 12 / 14px`，Markdown 标题为 `13.5 / 16 / 18px`。消息正文和输入框行高为 `1.4`；输入框在字号变化后重新测量高度，长代码块横向滚动，用量栏允许换行。双栏同时响应同一设置，共享消息组件在移动端保留原字号 fallback。
- 正文继续由 `--editor-font-size` 与编辑器偏好控制；UI 档位不更改正文、Yjs、数据库或字体来源。变量位于 HTML 根节点，让 portal 到 body 的菜单得到同样字号。
- 常读辅助文字使用 `--ui-text-muted`。当前浅色/深色状态栏样本对比度为 `4.93:1 / 8.58:1`，不通过缩小、减淡文字同时压低层级。不要将此局部样本视为全产品对比度认证。
- 桌面列表和 Panel Tab 行为 `32 / 34px`，panel header 最小高度为 `28 / 30px`，footer 为 `24 / 26px`；Super View 底部 inset 同源。菜单使用 `20 / 22px` 行高并允许多行撑高；设置表单在窄窗口堆叠。原生 `42px` 标题栏位置不变。
- 文档 Tab 的隐藏测量节点与可见标签使用同一字号变量，并在字号变动后重新分配宽度。

验收入口和界限见 [桌面字号验收](qa/desktop-typography.md)。

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
- `BottomStatusBar` 以只读写作状态为主，报告当前上下文对应的章节/故事线/全书字数与今日新增字数；时间线开关与字数统计共同靠右，字数统计位于时间线按钮右侧。Google Drive 传输进度属于右上角通知中心，不占用 footer。原 editor top bar 不再重复显示字数。唯一的交互例外是 Bottom Timeline 展开/收起开关，因为它直接控制 footer 上方相邻的 dock。
- 通知入口仍留在 topbar，因为它会打开通知中心，属于操作入口而不是被动状态。footer 后续只接受无需点击即可理解、且与当前写作任务有关的短状态。
- footer 在桌面标准/较大字号下使用 `24 / 26px` 高度，移动 fallback 保持 `20px`并使用全宽所有权；除 Timeline 开关外，不把低频设置或导航重新塞回底部角落。

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
- 普通行使用 `.menu-surface__item`，桌面采用 `14px / 20px`（较大档 `16px / 22px`）UI 字体，共享移动 fallback 为 `12.5px / 18px`、`6px 8px` padding 和 `--radius-xs`。桌面单行内容至少为 `32px`；文本超过一行时允许正常换行，由所选档位的行高自然撑高，不截断为单行，也不把富表单强制压进固定 cell。
- section label、header、divider 与 accelerator 分别使用共享的小型层级。当前 breadcrumb 只以背景 wash 与字重显示当前项，不绘制 inset-left accent bar。
- 账户、Agent 配置/历史、关系类型管理、资料卡摘要和“未放置”内容不是普通动作列表。它们使用 `.menu-surface--rich` 保留表单、摘要、chip 或多列布局，但外壳 token、基础字号、hover wash、圆角阶梯与浮层层级仍与简单菜单一致；不为了视觉整齐把富交互压成 30px 动作行。
- App 自绘菜单受上述约束；可编辑器在没有非空 selection 或只读时回退的浏览器/系统原生 context menu 不属于 renderer 可定制范围。静态测试能证明 token、class 与 portal/fixed 路径已收敛，不能证明不同平台上的字体栅格化、阴影观感或系统原生菜单外观；这些仍由用户在实际窗口中目测验收。

## Tabs and motion

- 顶部文档 Tab 与左右栏 Panel Tab 都由自身绘制静态矩形选中态。
- 左右栏 Panel Tab 统一使用 `label` 文字样式：相同 UI 字体、`500` 字重、保留原始大小写；小／标准／大字号分别为 `11.5 / 13 / 15px`。单侧横向 padding 为 `10px`；Tab 之间不额外留 gap，整行两端各留 `6px`，恢复双栏按钮前也不额外留 gap。
- 桌面 Universal 新建入口是一个紧跟已打开文档 Tab 列表末尾的 `+`，与 Tab 一起处于横向滚动条带内；零 Tab 时它位于条带起点。它不是贴住顶栏右缘的固定命令，也不占用既有文档 Tab 的宽度预算：空间不足时入口随条带自然溢出。默认和 hover 都保持未选中 Tab 的透明底与次级文字色，键盘 `focus-visible` 只保留克制的轮廓。
- Universal 新建先打开会话级“新建…”占位 Tab，默认是斜体 Preview，与实体 Tab 共用一个预览位；打开时替换已有实体 Preview，随后打开其他新实体 Preview 会替换未固定的占位。切换到 Home 或已打开的 Tab 只改变焦点。双击占位 Tab 后固定，保留已选类型与归属；提交创建前也会自动固定，保护后台结果和失败重试。该 Tab 使用普通静态矩形选中态，可切换、可关闭，但不可拖拽或 split；固定后仍仅保留在当前会话，关闭未提交占位不产生实体。选择类型后，章节/构想/元素只补齐现有归属，故事线/类目直接使用默认名称创建，最终由真实实体 Tab 原位替换。
- 左右栏的桌面 Tab 行使用 `32 / 34px`；其下单行 panel header 最小高度为 `28 / 30px`，不用大块上下 padding 制造空白。Review 的类型/范围筛选和 Agent 的会话/工具动作都属于这一级 header，必须复用 `workspace-panel-header-row` 与同一套小字号纯文字控件，不能在 Tab 下再造一层大标题或带框按钮栏。
- Panel Tab 的默认、hover 与 active 背景完全一致；只用暗淡文字与黑色文字的切换表达未选中和选中，不使用彩色 label、`border-bottom`、inset shadow 或其他下划线。
- 左右栏 Panel Tab 始终显示完整标题，不再按宽度切换为图标或缩写。桌面两侧统一按“完整标签总宽度 + `12px × (Tab 数量 − 1)` + 两端各 `6px`”计算单栏及每半栏最小宽度；左右栏不另设固定像素下限。标签增减、中英文切换、界面字号和字体加载都会重新测量。超长 Agent 待查看计数不推宽侧栏，可横向滚动或通过键盘聚焦访问。鼠标拖拽、键盘调节、恢复已存比例和窗口缩放共用当前测量值，不强制缩小已保存的宽栏。
- 不存在跨 Tab 滑动的 pill indicator，也不为选中态测量 DOM 几何。
- 文档 Tab 切换和自动滚动是即时的；拖拽重排仍保留窄插入线，因为它表达 drop 位置而不是选中动画。
- 桌面完整 Settings 左侧 Section 点击后直接定位到目标内容，不播放纵向滚动动画，避免 scroll-spy 沿途快速切换左栏选中态；用户手动滚动右侧内容时仍由 scroll-spy 同步当前 Section。这个即时定位约束只属于桌面完整 Settings，不改变移动设置页及其他共享滚动面的行为。
- 桌面完整 Settings 的分类下增加二级目录，始终全部展开，不提供折叠操作；搜索匹配一级分类、二级标题及已显示的设置项名称、说明和提示正文，忽略大小写并归一化空白；正文命中保留所属分类与分组，点击结果即时定位。没有二级标题的面板及面板开头的说明也可命中一级分类；隐藏内容和输入框的值不参与搜索。子项直接取自已挂载、可见的设置分区标题，随语言与条件内容更新，不复制一份分区文案或显示未提供的功能。点击子项即时定位，手动滚动同步两级当前项；选中态通过背景与字重表达，不绘制左侧强调竖线。键盘可逐项聚焦、激活，当前项提供 `aria-current`。`desktop-settings-section-navigation.acceptance.test.ts` 覆盖搜索、索引更新与定位行为；`node scripts/run-settings-search.mjs` 生成真实浏览器中的正文搜索、动态内容与跳转证据，`--check` 校验证据与源码一致；实际 Tauri 窗口观感另行验收。
- 侧栏开合是工作区保留的结构性动效，时长为 `220ms`；`prefers-reduced-motion: reduce` 时禁用。

## Dense content and semantic controls

- 正文与 H1/H2/H3 共用设置页的「段间距」：段前为 0，段后统一按正文字号计算，不再随标题等级改变；设置预览同时展示三级标题。章节、通览全书、实体长文／模板及补丁使用同一规则，补丁和预览末块保留无段后留白的边界。见 [正文与标题间距](editor/block-spacing.md) 及其浏览器验收证据。
- 编辑器 → 排版 → 换行方式提供“稳定换行 / 优化排版”，对应 `stable / pretty`，立即生效并保存在本机 `settings-storage.editorTextWrap`。默认、旧设置缺失/非法值及“还原推荐样式”均使用稳定换行。章节／漂流正文、通览静态正文与活动编辑器、元素／札记／模板、补丁正文和设置预览共用 `--editor-text-wrap`，移动端也尊重该选择。稳定换行尽量填满各行，编辑后文时保留前文断行；优化排版允许浏览器调整整段断行。不插入换行字符，不改变 Yjs、导出或段落对齐。持久化与重置由 `settings-store-appearance.test.ts`、变量更新由 `editor-preferences.test.ts`、正文与预览的样式覆盖由 `mobile-editor-settings.acceptance.test.ts` 验证；真实 WebView 排版仍需窗口验收。
- 章节／漂流正文、通览全书、元素正文、故事线／类别札记及正文模板、补丁正文统一跟随编辑器设置的字体、字号、行距与段间距。字号和行距直接作用于实际 `.ProseMirror`，避免内部 `.prose` 样式覆盖外层继承；补丁末段仍不添加底部空白。手机正文直接使用相同设置，不再另设 `17px` 字号或 `1.72` 行距下限；设置面板自身的合法范围保持不变。标题、摘要和结构化字段保留各自的层级与布局。样式契约由 `src/renderer/features/settings/mobile-editor-settings.acceptance.test.ts` 验证，真实 WebView 观感仍需窗口／设备验收。
- 编辑器设置中的字号、行距、段间距、纸张宽度与打字机位置共用 `SettingsSlider`。手动输入只校验范围和数值类型，不对齐滑块步长；例如行距 `1.55`、段间距 `0.125 em`、纸张宽度 `721 px` 均原样保存与显示。合法值即时更新预览与偏好；数字框旁的上下箭头与键盘 ↑/↓ 从当前值微调，整数项每次 `1`、小数项每次 `0.01`，不吸附到步长刻度。允许临时留空或输入越界值，编辑期间不把这些值写入偏好；回车或失焦时，空值/无效输入恢复当前有效值，越界数值收敛到上下限，字号、纸张宽度和打字机位置保留已有整数语义。只有滑块拖动沿用原步长：字号 `12–28 px / 1`、行距 `1–2 / 0.02`、段间距 `0–2.5 em / 0.05`、纸张宽度 `480–1280 px / 10`、打字机位置 `25–75% / 1`。关闭打字机模式时滑块、数字框及箭头一起禁用，抵达上下限时对应箭头禁用。数字框保留单位、范围提示和可访问名称，移动端数字框与箭头触控区域至少 `44px` 高。边界、精度保留及连续微调由 `src/renderer/features/settings/settings-slider-value.test.ts` 验证；真实 WebView 观感与输入体验仍属窗口验收。
- 侧栏中的高密度 TODO/资料列表使用 `.workspace-list` 与 `.workspace-list-row`：cell 不绘制 border，保留 `2px` 小圆角和略浅于 panel 的灰色底，彼此留出小间距；hover/focus 只轻微提高底色，不增加阴影或位移。以后左右栏新增的卡片型条目也必须直接复用这套背景与 `--workspace-cell-hover-bg`，不另造中性色、边框或 hover wash。
- 左栏的章节、元素与漂流 cell 选中态复用顶部文档 Tab 的 `--surface` 背景，并以 `--ink-1` 文字和现有字重表达焦点；不再使用蓝色 `--accent` wash。紧凑元素卡的选中态只使用该高亮底色，不绘制 category 色或中性双层 border；键盘 `focus-visible` 轮廓仍独立保留。hover 与 TODO/Library card 共用 `--workspace-cell-hover-bg` 的轻微提亮，不再叠加黑色 wash。
- 章节 panel 的全书/故事线视图切换与元素 panel 的紧凑索引/名称列表切换都使用 header 左侧的纯文本摘要。章节无论是否按故事线分组，都固定显示故事线数与章节总数；元素始终显示类目数与元素总数。文字本身是点击区域，只以文字颜色变化表达 hover/focus，不绘制 switch、底框或背景；显示模式不进入排序菜单。
- 章节 panel 按故事线分组时，“未归属”复用普通故事线组的 header、计数、折叠与新增章节交互，并固定追加在全部真实故事线之后；其章节继续服从故事线内排序，左侧 label 使用与组头一致的 `--ink-4` 中性灰，不留透明空槽。它与其他组共用同一个滚动容器，不再使用独立的底部 footer、展开抽屉或高度状态。
- 章节与元素 panel 的排序菜单把内外两层作为独立偏好：故事线内章节使用阅读/叙事顺序，外层故事线使用持久化的 `orderKey` 故事线顺序或名称顺序；类目内元素与外层类目分别选择名称/创建时间。不要按子项数量或最近更新自动排列外层容器，避免写作过程中整栏频繁跳位。“未归属”与“未分类”始终固定在真实故事线/类目之后；已有元素排序偏好迁移时同时初始化新的外层类目偏好，之后两者独立持久化。
- 元素 panel 不再设置 category footer、横向 chip 导航或独立高度状态。category header、元素 cell 与“未分类”组全部留在同一个纵向滚动面内；sticky header 负责持续表达当前结构，不在底部重复一套可视 category 状态。
- `GroupHeaderCell` 的新增动作使用紧随 label/count 的共享 inline slot：category 的 `+` 在紧凑索引中常驻，并作为唯一的 category 创建入口打开锚定菜单，菜单打开期间触发器继续可见，再分流到“新建元素”和“新建分组”；章节故事线与一级构想 group 继续在当前 header hover/focus 时显示；element group 与二级构想 group 也把动态 `+` 放在各自 label/count 之后。显隐选择器只命中当前 header，父 group hover 不得连带揭示后代按钮。element group 不是独立实体，而是 element 的 `groupName`；因此“新建分组”必须输入名称并同时创建、打开首个 element，不制造无法持久化的空 group。
- 元素 panel 提供可持久化的“紧凑索引 / 名称列表”两种纯文字显示模式，由 header 左侧“X 类 · XX 元素”摘要直接往返切换。紧凑索引中，展开的 category 以自身颜色的 `1px` 细框包住全部内容；顶边不是完整横线，而是由 category 文本 label 两侧分别发出，并由 sticky header 同层的竖向接缝连接左右边与底边，label 使用普通 `--chrome-bg` 切开中段，整个容器保持透明且不叠加色洗。label 前的固定 disclosure hit area 在展开时显示与同层 `+` 一致的普通前景色 `−`，点击收起后同一位置变成 category 色方块，点击再展开；真实 category 的文本 label 单击进入 editor、双击固定 tab，不再兼任折叠。没有 element 的 category 永远保持不可展开的方形色块，但文本 label 仍可进入 editor；通过创建菜单加入第一个 element 后才获得彩框。具名 element group 在彩色 category 框内再以低对比度的 `1px --rule` 中性细线框住其文字卡片，不增加底色；连续具名 group 不加额外 margin，其间距与 group label 到下方卡片的距离相同，只有最后一个具名 group 与随后未分组卡片之间增加语义间距。未分组元素不画 group 框。文字卡片直接复用素材库/TODO 卡片的无边框 `.workspace-list-row` 背景、圆角和 hover token，不再定义独立卡片色；选中时只切换到 `--surface` 高亮。紧凑卡片与旧名称列表的 element label 共同复用 `.element-panel-item-label`：`--font-sans`、`12.5px`、常态字重 `400`、`1.35` 行高与 `-0.005em` 字距，选中时统一升为 `500`，两种视图不得分别定义另一套字号或字重。卡片使用 wrapping flex flow：名称估算宽度决定其初始 `flex-basis`，同行剩余空间由卡片共同吸收，因此短名称可在一行容纳更多项、长名称获得更多阅读空间，最后一行也不遗留固定方块造成的空洞；栏宽不足时自然退回单列。完整名称直接显示并允许换行，Agent 活动只占末端小状态标记。
- 元素 panel 的 category 标题在紧凑索引和名称列表中都将 Agent 状态放在名称右侧的元素数量位置：忙碌提示、category 自身的 `A` / `M`、子元素待查看数量按此顺序优先显示；没有 Agent 状态时恢复元素总数。左侧只保留折叠／类别颜色，不再额外插入 Agent 标识，故事线和漂流分组沿用原有位置。
- 标签、状态 chip、菜单、popover、dialog 和预览内容保持小圆角；头像、状态点、spinner 与 switch 可以保留其语义形状。它们不计作一级页面模块，也不应被无差别的全局 `border-radius: 0` 误伤。
- 不使用 inset-left vertical accent bar；强调状态继续使用背景 wash、细分隔线、字重或语义颜色。

## Persistence and responsive behavior

- 新状态默认收起左右栏，使首次进入时只突出稿纸。
- 已持久化的用户侧栏开合状态继续被尊重；这次调整不强制覆盖现有偏好。
- 桌面左右栏共享同一套分栏状态模型：实际栏宽达到“当前 Tab 行最小宽度 × 2 + `1px` 分隔线”时，保留当前面板在左，右半栏自动打开顺序中的下一个 Tab（末项循环到首项）。两侧最大宽度均为窗口的 `60%`，仍为正文保留至少 `420px`。最小宽度和双栏阈值共享同一测量来源，不再另设 `600px` 门槛。
- 双栏时，每半栏各有完整 TabRow：左侧栏各显示 3 个 Tab，右侧栏各显示 4 个 Tab；每行只控制其下方内容。点击其他 Tab 直接替换本半栏，不改变位置、不需要先取消，也不禁用另一半已打开的 Tab。两半允许同时显示同一个 Tab。
- 点击本半栏当前选中的 Tab 关闭这一半，保留另一半的实例与滚动/局部状态，并扩展为单栏；任意宽度下，点击唯一半栏当前的 Tab 则收起整个侧栏。单栏点击其他 Tab 直接切换；宽度足够时提供“恢复双栏”按钮，以当前内容和下一个 Tab 重新分栏。重新打开侧栏恢复原有选择，手动保留的宽栏单栏状态不会被同一区间内的 resize 或重启撤销。
- 缩到阈值以下时保留最近交互的半栏；再次跨入宽栏区间才自动补下一个。两侧半栏身份、Tab、焦点与内部拖拽比例独立持久化；关闭左半栏后，右半栏身份不变。旧单 Tab / Agent 偏好和前一版共享 TabRow 偏好会恢复为半栏选择，不丢弃已有设置。
- 每个桌面半栏的每种 Tab 以项目、侧栏、稳定半栏身份和 Tab 类型隔离视图状态。左栏的排序、显示模式、辅助信息、选中项、折叠与滚动，Review 的范围、排序、类型筛选与展开状态，以及 Library 的筛选和关联显示均独立；切 Tab、收窄或关闭后恢复时不借用另一半的状态。排序/显示偏好独立持久化，初值沿用已有偏好；折叠、选择、筛选与滚动在当前运行期保留。移动端和独立挂载的面板继续使用原有偏好。项目内容、Agent 活动与实际编辑结果继续共享。
- Review、素材库和统计继续跟随当前编辑内容，不提供单独选择或固定章节的控件。统计保留原有标题，分隔细线贯穿两半的 TabRow 和内容。
- 每个 Agent 半栏独立保存当前会话、输入草稿、历史选择和控制按钮的目标；第二个半栏首次打开 Agent 时从空白新对话开始，可同时运行不同对话。切 Tab、关闭半栏再打开或缩放时，状态跟随稳定半栏身份保留。若主动选择同一条历史对话，其消息与运行状态仍属于同一会话，草稿各自独立；同一会话只允许一个启动准备过程及一个运行中回合。模型设置、项目数据与会话历史列表继续共享。来自批注或 Review 的“打开 Agent”先确定目标 Agent 半栏，再加载会话，保持另一半内容和位置。
- Header、左右栏、编辑器外侧、Bottom Timeline 与 `BottomStatusBar` 在所有平台都直接使用不透明 `--workspace-ui-bg`。macOS 也不再启用透明窗口、`windowEffects` 或 `macOSPrivateApi`；Tauri 窗口配置显式保持 `transparent: false`，renderer 不再加载单独的原生材质样式。这样三处灰色底色来自同一个普通颜色 token，不依赖桌面壁纸、窗口激活状态或系统材质变化。
- macOS 红绿灯固定为 `x: 18, y: 22`，基础配置、macOS 覆盖配置与运行时校正必须保持一致。renderer 顶栏高 `42px`，同排图标与文字按钮高 `26px` 并通过 `align-items: center` 共用中心线；`y: 22` 是针对原生 overlay 坐标系校准后的偏移。
- 桌面顶栏在红绿灯（其他桌面平台为普通 leading inset）之后持续显示当前 Project 名称。macOS leading inset 固定为 `94px`，在第三个红绿灯之后留下独立呼吸空间。名称直接订阅已发布的 `currentProject.name`，重命名后即时更新；整个名称槽是返回书架的语义按钮，默认显示单行、可省略的项目名，hover 或键盘 focus 时原地切换为返回书架。按钮始终保留项目名决定的原始占位，最大不超过 `min(220px, 22vw)`、最小为同排控件高度 `26px`，切换内容不得推动搜索、导航或文档 Tabs；内部 container 按实际槽宽决定文案，低于 `54px` 只显示返回箭头，足够宽时显示箭头与本地化“书架”短标签，完整动作与项目名由 `title`/`aria-label` 暴露。按钮显式退出 Tauri drag region，名称左右的空白仍属于父级窗口拖动面。左侧 section 使用 intrinsic width，命令组禁止收缩，因此后续控件紧跟实际项目名而不是对齐固定栏宽；移动端不复用这一桌面标识，账户菜单中的书架入口继续作为冗余路径。
- Project Home 自己拥有垂直滚动：`.dash` 必须以 `width/height: 100%` 受当前 shell 约束，并使用 `overflow-y: auto`。桌面 Home 保留完整 workspace chrome，但不绘制 Tab 外观；移动 Home 是 paper row 之外的独立 safe-area surface，仅增加项目级 Back、paper overview 和继续当前 paper 入口。隐藏的只是 scrollbar chrome，不是滚动能力。
- 移动端仍保留安全区 padding。侧栏保持 overlay 行为，但表面角色与桌面一致。桌面 topbar 的左右 command groups 在窄屏暂时隐藏；移动端必须用独立的 action menu/sheet 恢复这些能力，不能据此宣称功能等价。
- Super View overlay 停在全宽 `BottomStatusBar` 上方；工作区入口已经迁到 topbar。

## Acceptance

所有侧栏 Tab 的视图隔离契约与合成数据验收见 [sidebar-panel-isolation](qa/sidebar-panel-isolation.md)。

Agent 双栏隔离使用合成 repository/transport 的真实 store 验收：`pnpm exec vitest run src/renderer/store/agent-chat-views.integration.test.ts`。覆盖独立草稿、并行准备、同会话去重、异步加载、删除、停止/授权/追加指令目标、消息投影、自动续接和外部任务导航。此证据不代表真实模型或原生窗口验收。

静态结构契约由以下测试保护：

```bash
pnpm exec vitest run src/renderer/components/workspace-surface-language.acceptance.test.ts src/renderer/components/project-dashboard-scroll.acceptance.test.ts src/renderer/components/workspace-titlebar-alignment.acceptance.test.ts src/renderer/components/left-sidebar-tab-density.acceptance.test.ts src/renderer/components/leftBars/element-panel-no-category-footer.acceptance.test.ts src/renderer/components/leftBars/element-panel-compact-index.acceptance.test.ts src/renderer/components/leftBars/left-sidebar-outer-sort.acceptance.test.ts src/renderer/shells/desktop/entity-create/desktop-universal-create.acceptance.test.ts src/renderer/features/settings/desktop/desktop-settings-section-navigation.acceptance.test.ts
pnpm exec vitest run src/renderer/components/menu-surface-style.acceptance.test.ts
pnpm exec vitest run src/renderer/lib/theme.test.ts src/renderer/components/accent-color-preference.acceptance.test.ts
pnpm test:renderer-architecture
pnpm exec vitest run src/renderer/lib/sidebar-tabs.test.ts src/renderer/lib/sidebar-pane-events.test.ts src/renderer/store/ui-store.sidebar-tabs.test.ts src/renderer/lib/layout-geometry.test.ts src/renderer/shells/desktop/desktop-sidebar-tabs.acceptance.test.ts src/renderer/store/agent-chat-preparation.integration.test.ts
```

测试覆盖 footer 的 DOM、状态职责与唯一 Timeline 开关、元素 panel 已移除的 category footer、紧凑索引的持久化模式/header 摘要切换入口与 sort menu 分离/纯文字内容/流式宽度/素材库与 TODO 的无边框卡片背景复用/label 两侧 category 边框及 sticky 接缝/收起色块形变/空 category 禁止展开/纯背景选中态/连续 group 节奏与未分组边界/category 常驻新增按钮的锚定双路径菜单与首元素建组语义，以及章节、构想、element group 的 inline 动态按钮、章节/元素内外层排序解耦及末尾虚拟组约束、topbar command ownership、当前 Project 名称的桌面位置锚点、原地返回书架状态、实际宽度标签与不压缩命令组约束、Super 菜单、账户二级设置页、动作菜单与富内容 menu/popover 的共享外壳和危险项语义、不透明 macOS 窗口配置、顶栏与左右栏的统一灰色 token、一级 surface classes、静态 Tab、已移除的滑动 indicator、侧栏默认状态、Settings/Super View shell 与本文档。TypeScript、Vitest、renderer build 与 Tauri 配置检查可以证明结构与打包成立，但不能替代 macOS titlebar 几何、iOS 或 Android 上的视觉、触摸和动效验收；新增返回按钮的 native hover/focus、点击命中、项目名截断与窗口拖动边界仍需要在真实窗口中目测。

Renderer 的桌面/共享所有权规则记录在 [`renderer-ui-architecture.md`](renderer-ui-architecture.md)；移动端起点、缺口和设备验收边界记录在 [`mobile-ui-foundation.md`](mobile-ui-foundation.md)。
