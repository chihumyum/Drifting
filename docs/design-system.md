# Workspace surface language

Drifting 的主工作区采用“单层桌面，只有一张抬起的稿纸”的结构。这个约束只重组表面层级与几何形态，不重新定义现有配色：`--paper-deep`、`--paper`、`--surface`、`--page`、`--rule` 与 ink tokens 仍然是颜色来源。2026-10-28 起桌面色值改为“更接近”的一组：浅色 `--paper-deep: 40 9% 94.5%`、`--paper: 42 14% 97%`、`--page: 45 30% 99.5%`（稿纸更白、侧栏与稿纸更近），深色 `--paper-deep: 220 6% 11.5%`、`--paper: 220 6% 12.5%`；token 名与使用位置不变。

## Sand and glass

界面只有两种材料，其余一律是平的：**玻璃是手按的东西**（控件、浮起的面板、移动中的面板边缘），**砂笔是作者留下的痕迹**（每类实体的记号、选中时画出的框、高亮与下划线）。两者都是 `src/assets/design/` 里的白色 alpha mask，在 CSS 中着色；生成脚本与来源见 `scripts/design-assets/` 与 `ASSET_PROVENANCE.md`。共享样式在 `src/styles/materials.css`。

- **玻璃（方案 C）**：控件只有一圈由 `glass-thick.png` 纹理切出的边（`--glass-clear`，浅 `#B4B6AE` / 深 `#6B6D67`）。从不填色、不下沉、不反色。`.glass` 静止时隐藏边，`.glass--rest` 静止时显示；悬停时纹理缓慢流动；按下或处于开启态（`aria-pressed` / `aria-expanded` / `.is-on`）时边变浓、变宽并停止流动。`.glass--surface` 用于卡片：只借用流动的边，按下不变浓。浮起的面（菜单、Dock 药丸、工具栏）使用共享半透明 `--glass-fill`（稿纸色 80%）加 `1.6px` 模糊，不扭曲底下的文字；菜单整体没有玻璃边，只有被悬停的行流出玻璃。
- **按钮层级**：工作区级控件是圆形玻璃——左右侧栏开关、双栏按钮、Project Home、通知、Dock 的锁与 `+`、时间线开关、稿纸工具栏里的每个按钮，以及进入全书视图的入口（通览全书、要素全景、TODO 与素材库、全屏故事图谱）。面板 header 里的普通低层按钮（排序、新建、折叠、显示模式）保持朴素：悬停只加深前景，不出现玻璃框。左右栏 Panel Tab 也只加深文字。
- **会流动的线**：侧栏贴向稿纸的边、Tab 行下沿、账户 cell 上沿、双栏分隔线、Bottom Timeline 顶边与泳道分隔线静止时都是 hairline。面板滑开、收起或被拖宽时，这些线按面板实际移动的距离推动玻璃纹理（`--flow`），强度跟随速度（`--flowa`），停下后整体淡出（`lib/glass-flow.ts`，`.flow-line`）。
- **砂笔记号**：凡是能出现在顶部 Dock 里的实体都有固定记号，在左栏、Dock、Review 分组与时间线泳道名里一致（`KindMark`）：章节＝圆印（按章节 id 固定取六枚之一），要素＝方印，故事线＝短横，要素类目＝折角，构想＝小漩涡（不在分组里的更淡），素材＝竖直纸条，通览全书＝强调色的粗钝星号。颜色取故事线或类目颜色；没有归属时用中性墨色。批注、TODO 与文件夹不进 Dock，因此没有记号。浅色主题以 `multiply` 叠色，深色主题提亮 14%。砂笔出现与消失都要过渡，不允许一帧切换。
- **砂笔图标**（`BrushIcon`）：按钮与菜单里的图标用同一支砂笔画成 96px 白色蒙版，`currentColor` 着色，单色、一两笔成形；不复刻 Lucide，按文化意象重画，16px 下仍要一眼认出，没有投影、高光或立体感。章末 ⁂＝三尊石（静态章末记号同用），展开后的三项：标为完成＝搁笔、改回草稿＝提笔、新建下一章＝新芽、Agent 审阅＝以眼为头的纸人式神（眼为实墨、瞳孔留白）；Dock 的锁＝锁（收回小点时锁梁弹起），新建＝两笔十；用户菜单：Copilot＝地藏，主题浅／深／系统＝空圆相／墨团／太极，语言＝「文」，设定＝法轮，键盘快捷键＝活字，导入＝书匣纳垂露，书架＝立书，登录／登出＝箭头进／出门框。生成脚本是 `scripts/design-assets/brushicons.py`，固定种子。10–16px 的基础动作用细笔（同一支笔，墨更足，颗粒只留在边上，不撒散砂）：关闭＝平直斜叉，返回／前进＝「く」头加杆，展开箭头＝一笔折（四个方向由同一笔转出），勾选＝批阅一勾，减号＝平横，加载＝缺角圆相（CSS 转动），删除＝字纸篓里一个叉，编辑＝斜持的毛笔，搜索＝圆相加粗柄，复制＝叠纸，停止＝实心方印，文件夹＝书帙（合／开／加）。桌面渲染层已不再使用 lucide（暂停中的移动端除外）。对象与状态同样用细笔：文本＝卷角的字纸，新批注＝批注角上加十，恢复／刷新＝一笔回旋，排序＝算筹，完成／警告／停止＝墨印里刻白勾、白「！」、白斜划，云＝祥云，清单＝方框清单（加入清单＝第三行换成十），便签＝浮签，语音输入＝竹筒，图片＝月洞窗（添加＝角上十），清除＝拂尘，分享＝风筝，叠放＝叠纸，叙事图＝枝，存为文件＝导入那滴垂露倒过来、从书匣里升出，作品主页「最近」＝茶尚温，卡片／列表视图＝四方小印／三条实墨，作品简介＝摊开的书，Project Memory＝结绳。已有图标直接复用：新建＝两笔十，更多＝三颗墨点，放大＝全屏，评论＝批注，AI 与 Agent 标记＝式神，设定类标题＝法轮，作品主页的「概览」＝经折装、「结构与设定」＝枯山水耙纹、「故事线模板」＝竹简，书架页「全部作品」＝立书；Debug 面板不放图标。图标默认 `display: block`，需要转动或另加类名时用 `className` 与 `style`。
- **Cell 语法**（`SandCell`）：左栏的章节、要素、构想、故事线标题，以及素材库条目，记号始终显示；悬停时整圈轮廓变成一条故事线/类目颜色的 hairline 流动玻璃（同一张纹理切出的一个环，四边粗细一致）；单击打开预览 Tab 时，砂笔从记号出发绕 cell 画一圈框，离开时整框淡出后再复位；双击固定 Tab 不改变 cell 外观。面板构建时已选中的 cell 直接淡入框而不重画。

## Product terminology

- Element 的中文产品名称统一为“要素”，覆盖桌面与移动界面、编辑器提及菜单、设置、Agent 说明与回复、语音上下文及导出关系标签；英文继续使用 Element / Elements。
- 内部 `element` 标识、数据库字段、工具名称和 `/elements` 路径保持稳定，不迁移已有标题或作者正文。Agent 继续接受旧中文名称作为输入别名。DOM/JSX 技术术语与历史验收证据保留原文。
- 现有 `element-panel-compact-index.acceptance.test.ts`、`element-panel-no-category-footer.acceptance.test.ts` 和 Agent 工具选择验收覆盖新文案及新旧输入兼容。

## Surface roles

1. **Workspace plane**：编辑器周围区域、左右栏与可选的 Bottom Timeline dock 共同组成一张连续桌面；没有标题栏、文档 Tab 栏、editor top bar 或底部状态栏。它们全部使用从 editor 稿纸外侧提取的不透明 `--workspace-ui-bg: hsl(var(--paper-deep))`；一级模块不再用不同底色假装处于不同高度。
2. **Manuscript page**：`.page` 使用现有 `--page` 与 `--page-elevation`，圆角上限由 `--workspace-corner-radius: 2px` 控制。无论左右栏是否打开，它始终是主界面唯一抬起的一级工作面。
3. **Borders and internal levels**：细灰黑 `--workspace-border` 只表达左右栏与 Bottom Timeline 的一级模块边界。三方交点没有渐变、阴影或额外装饰。侧栏局部层级只在 Tabs 与 panel header 之间保留一条完整的 `0.5px` hairline；左右栏显示双列时，两列之间也用同一条 `--workspace-local-border` hairline，同时保留较宽的透明拖拽热区。panel header 直接衔接 content，不再重复画第二条线，侧栏 footer 顶线则再弱一级。Bottom Timeline header 保持 `--workspace-ui-bg`，幕/叙事时 rail 使用稍浅的 `--paper`，故事线轨道使用 `--page`；幕边界、时间点和相邻故事线轨道的静态 guide 使用 header 的 `--workspace-ui-bg`，厚度统一为 `0.5px`。

因此普通编辑状态只出现一块抬起的一级工作面：稿纸。左右栏、时间线、稿纸角上的按钮与稿纸顶边的标签记号都不是额外的“岛”。

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
- 桌面列表行为 `32 / 34px`，panel header 最小高度为 `28 / 30px`，侧栏 footer 为 `24 / 26px`；Super View 底部 inset 同源。左右栏顶部的 Panel Tab 行同时承载窗口控件，与窗口控件行同高 `42px`。菜单使用 `20 / 22px` 行高并允许多行撑高；设置表单在窄窗口堆叠。
- 文档 Tab 的隐藏测量节点与可见标签使用同一字号变量，并在字号变动后重新分配宽度。

验收入口和界限见 [桌面字号验收](qa/desktop-typography.md)。

## Geometry and ownership

- `App.tsx` 只负责应用级 effects/routes；桌面工作区（`DesktopWorkspace`）只有一个 `app-row`：`Sidebar(left) + app-mid + Sidebar(right)`，三栏从窗口顶边贯通到底边。没有 `AppTopbar`、文档 Tab 栏、editor top bar 或 `BottomStatusBar`。
- `app-mid` 拥有：透明、不占布局高度的窗口拖动条（`WorkspaceCornerControls`）、`workspace-stage` 与可选的 `workspace-dock`（Bottom Timeline，装在 `TimelineDrawer` 里滑入滑出）。`workspace-stage` 的顶边承载居中的文档 Dock（`WorkspaceTabDock`）；右下角是每个编辑器自己的角落（`.editor-corner`）：右侧编辑器 pane 的角落先放时间线开关（`TimelineToggle`），再放工具栏，没有可见编辑器时由 stage 自己显示同一个开关（`StageTimelineToggle`）；时间线打开时右下角的控件随稿纸下沿停在时间线上方。稿纸直接延伸到窗口顶边并从拖动条下方滚过。左右侧栏开关（`WorkspaceSidebarToggles`）固定在整个窗口的两个上角，叠在三栏之上。
- 左右栏宽度与 Bottom Timeline 高度仍由各自现有的单轴 handle 独立调整。
- 顶层工作面使用直角或最多 `2px` 圆角。更大的圆角不用于页面模块、栏、dock 或内容列表容器。
- Settings 与三个 Super Views 使用同样的平面化 shell：边缘对齐、无 shell gap、无 shell 圆角或阴影，以分隔线表达区域边界。

## Command and status ownership

工作区布局在 2026-10-27 重构为“三栏贯通、没有横贯的栏”：

- **侧栏开关常驻两角**。左栏开关在左上角（macOS 在 `94px` 红绿灯 inset 处），右栏开关在右上角：各是一个 `28px` 圆形玻璃按钮（新月砂笔图标：该侧栏展开时月牙是实墨，收起时是空心），固定不动，侧栏像抽屉一样从它下面滑出、收回（`420ms`）。侧栏展开时，该栏第一（左）/最后（右）个半栏的 Tab 行在开关下方留一个同宽空位（`SidebarHeaderChrome` 内的 `SidebarToggleSlot`，`data-sidebar-header-chrome`），并计入侧栏最小宽度。Tab 行高等于窗口控件行高 `--window-titlebar-height`，本身也是窗口拖动面。全局搜索没有按钮，只用快捷键。
- **账户在左栏底部**。头像与名字（打开账户菜单）、Project Home（鸟居）与通知（风铃）组成左栏底部的一个 cell（`WorkspaceAccountCell`），横跨双栏；Home 与通知是圆形玻璃按钮。账户菜单与通知中心从这里向上展开。左栏收起时这个 cell 不显示——左栏是主要工作区，预期大多时候常驻。
- **标签页在稿纸顶部**。文档 Tab 栏移除，已打开的文档是稿纸顶边居中的一排砂笔记号（与红绿灯、侧栏开关同一中线 `y = 21px`；Preview 是空心记号，只留沿形状边缘的一圈砂，由 `hollowgen.py` 从实心记号生成），类型变化处留出较宽间隔；分屏标签是相连的两个记号。悬停或键盘聚焦时玻璃落在记号上：每个记号原地长成药丸，砂迹在玻璃下散开淡去，药丸的玻璃边取该记号的颜色，随后出现标题和关闭按钮（沿用原宽度分配、拖拽排序、右键菜单与双击固定）。药丸行左端是锁（按下后无人悬停也保持药丸），右端是 Universal 新建 `+`；两者不随药丸横向滚动。一侧侧栏收起时整行避开两个上角。
- **时间线开关在稿纸右下角**。Bottom Timeline 开关（`⌘J`，`aria-pressed` 表示打开）是稿纸右下角单独的圆形玻璃按钮，在稿纸工具栏左侧，紧挨但不并入工具栏；分屏时只出现在右侧 pane 的角落；打开后时间线从稿纸下方滑上来，可拖高度。
- **全书视图在对应实体旁边**。通览全书在章节面板头部、要素全景在要素面板头部、TODO 与素材库在素材库面板工具栏、全屏故事图谱在 Bottom Timeline 头部、项目主页在左栏底部的账户 cell；这些入口都是圆形玻璃按钮。`SUPER` 触发器与底部视图行移除，Super View header 内的切换器保留；某侧栏收起时，其面板里的入口随之隐藏，快捷键仍可用。
- **稿纸的操作留在稿纸上**。editor top bar 与面包屑移除；情节规划、要素图片、大纲、引用链接、批注（带数量）与三点菜单组成 `.editor-bar` 横排玻璃药丸，药丸内每个按钮是圆形玻璃并使用砂笔图标，停在每个编辑器 pane 的右下角（右侧 pane 的工具栏左边是时间线开关），分屏时各有一组，不被侧栏收走。三点菜单向上展开。
- **字数暂时移除**。原桌面左下角的当前上下文字数与今日字数已移除（`WorkspaceWordCount` 删除）；统计面板仍提供字数。
- **红灯关闭项目**。项目打开时，窗口关闭按钮不再关窗：renderer 通过 `window_set_close_returns_to_shelf` 打开开关后，Rust 端拦下 `CloseRequested` 并发出 `drifting:close-to-shelf`，renderer 回到书架；书架上的关闭按钮仍按原流程 flush 并关窗。`⌘W` 关当前标签，`⇧⌘W`（`closeProject`）关项目回书架。项目名不再常驻显示。
- **轻重分工**。Bottom Timeline 承担日常的轻量结构操作；调整故事线之间的相对关系、幕边界、时间点和叙事顺序等较重的操作在故事图谱 Super View 中进行。章节 panel 保持按故事线分组的列表。
- Copilot 在账户 dropdown 的二级设置页。

## Component shape rules

- 通用圆角阶梯限定为 `1px / 2px / 3px`；`--radius`、`--radius-xs`、`--radius-sm`、`--radius-md` 与 `--radius-lg` 不再制造“软卡片”层级。
- button、tab、badge、tag、chip、menu row、popover、dialog、toast 和内容卡片使用直角或上述小圆角。`pill` 只保留为旧 API 名称，不再对应胶囊几何。
- 页面卡片不依靠 hover 上浮、scale 或大面积阴影表达可点击性；改用边框、背景 wash 与文字颜色。菜单和 modal 可以保留一层克制的投影，用来表达真实遮挡关系。
- 禁止 inset-left vertical accent bar。Graph tile 仍可用覆盖块面的低浓度语义 wash；Bottom Timeline 的故事线名称 rail 与桌面 UI 使用同一底灰，颜色只留给真正承载故事线语义的 marker 与 clip。幕/叙事时 rail 内及故事线轨道里的静态竖线统一取 header 的 `--workspace-ui-bg`；相邻故事线轨道之间也用同色 `0.5px` 横线分隔。
- 只有形状本身承担语义时才允许圆形或胶囊：头像、状态点、加载 spinner、switch 的 track/thumb，以及玻璃材料的工作区级控件（圆形按钮、Dock 药丸、稿纸工具栏药丸）。滚动条 thumb 沿用平台可拖拽形状；面板里的普通图标按钮不因此自动获得圆形外壳。
- Plot Planner 是连续的 mini-Excel：单元格共享 hairline 网格，不是带 gap、阴影和 hover lift 的卡片集合。

## Menu surfaces

- 右键坐标、三点按钮、排序按钮与窗口控件只决定菜单如何定位，不决定菜单长什么样。按钮锚定面继续由 `AnchoredPopover` portal 到 `body` 并使用 `position: fixed`；React 内的坐标锚定菜单优先使用 `ContextMenuSurface`。编辑器 selection menu、ActRail 与资料卡保留各自已有的生命周期 owner，但同样必须 portal 到 `body`、固定定位并使用共享视觉 primitive。
- 所有动作菜单使用 `.menu-surface`。外壳唯一来源是 `--menu-surface-bg`、`--menu-surface-border`、`--menu-surface-radius` 与 `--menu-surface-shadow`；宽度只能从 compact / standard / wide / panel / settings 五档中选择，对应 `180 / 220 / 280 / 360 / 420px`，窄视口再由浮层 primitive 的 viewport max-width 收缩，不为单个入口另写任意宽度。
- 菜单是浮起的半透明面：共享 `--glass-fill`（`--menu-surface-bg`）、`1.6px` 模糊、直角（`--menu-surface-radius: 0`）、无实线边框，菜单整体没有自己的玻璃边，也不扭曲底下的文字；流动玻璃只出现在被悬停的那一行。
- 普通行使用 `.menu-surface__item`，桌面采用 `14px / 20px`（较大档 `16px / 22px`）UI 字体，共享移动 fallback 为 `12.5px / 18px`，`6px 14px` padding、直角，左右贴齐菜单边缘。桌面单行内容至少为 `32px`；文本超过一行时允许正常换行，由所选档位的行高自然撑高，不截断为单行，也不把富表单强制压进固定 cell。行不填色：悬停时该行四边一整圈变成 hairline 流动玻璃（与侧栏 cell 的悬停环同一做法，同一张纹理切出，四边粗细一致）；在行之间移动只淡出旧行、淡入新行的环。
- section label、header 与 accelerator 分别使用共享的小型层级；分组之间用 `8px` 空白代替分隔线（divider 保留为空白）。当前项只以字重显示，不绘制 inset-left accent bar。
- 账户、Agent 配置/历史、关系类型管理、资料卡摘要和“未放置”内容不是普通动作列表。它们使用 `.menu-surface--rich` 保留表单、摘要、chip 或多列布局，但外壳 token、基础字号、hover wash、圆角阶梯与浮层层级仍与简单菜单一致；不为了视觉整齐把富交互压成 30px 动作行。
- App 自绘菜单受上述约束；可编辑器在没有非空 selection 或只读时回退的浏览器/系统原生 context menu 不属于 renderer 可定制范围。静态测试能证明 token、class 与 portal/fixed 路径已收敛，不能证明不同平台上的字体栅格化、阴影观感或系统原生菜单外观；这些仍由用户在实际窗口中目测验收。

## Tabs and motion

- 顶部文档药丸与左右栏 Panel Tab 都由自身绘制静态选中态：当前药丸是按下态的玻璃。
- 分屏文档 Tab 的左右两侧分别保留 Preview／固定态：Preview 标题为斜体，双击某侧标题只固定该侧。打开新 Entity 时只替换获得焦点的 Preview；若该侧已固定，则保留整个分屏，使用普通顶层 Preview 位。切换焦点不改变状态，另一侧的 Preview 不参与替换。详见 [分屏 Preview 契约](editor/split-tab-preview.md)。
- 左右栏 Panel Tab 统一使用 `label` 文字样式：相同 UI 字体、`500` 字重、保留原始大小写；小／标准／大字号分别为 `11.5 / 13 / 15px`。单侧横向 padding 为 `10px`；Tab 之间不额外留 gap，整行两端各留 `6px`，恢复双栏按钮前也不额外留 gap。
- 桌面 Universal 新建入口是展开后的标签片末尾的 `+`：一个圆形玻璃按钮，与左端的锁一样贴住药丸行两端（`position: sticky`），药丸横向滚动时它们不动；小点状态下两者都不显示。宽度分配为它们各预留 `35px`。
- Universal 新建先打开会话级“新建…”占位 Tab，默认是斜体 Preview，与实体 Tab 共用一个预览位；打开时替换已有实体 Preview，随后打开其他新实体 Preview 会替换未固定的占位。切换到 Home 或已打开的 Tab 只改变焦点。双击占位 Tab 后固定，保留已选类型与归属；提交创建前也会自动固定，保护后台结果和失败重试。该 Tab 使用普通静态矩形选中态，可切换、可关闭，但不可拖拽或 split；固定后仍仅保留在当前会话，关闭未提交占位不产生实体。选择类型后，章节/构想/要素只补齐现有归属，故事线/类目直接使用默认名称创建，最终由真实实体 Tab 原位替换。
- 左右栏的桌面 Tab 行与窗口控件行同高 `42px`；其下单行 panel header 最小高度为 `28 / 30px`，不用大块上下 padding 制造空白。Review 的类型/范围筛选和 Agent 的会话/工具动作都属于这一级 header，必须复用 `workspace-panel-header-row` 与同一套小字号纯文字控件，不能在 Tab 下再造一层大标题或带框按钮栏。
- Panel Tab 的默认、hover 与 active 背景完全一致；只用暗淡文字与黑色文字的切换表达未选中和选中，不使用彩色 label、`border-bottom`、inset shadow 或其他下划线。
- 左右栏 Panel Tab 始终显示完整标题，不再按宽度切换为图标或缩写。桌面两侧统一按“完整标签总宽度 + `12px × (Tab 数量 − 1)` + 两端各 `6px`”计算单栏及每半栏最小宽度；左右栏不另设固定像素下限。标签增减、中英文切换、界面字号和字体加载都会重新测量。超长 Agent 待查看计数不推宽侧栏，可横向滚动或通过键盘聚焦访问。鼠标拖拽、键盘调节、恢复已存比例和窗口缩放共用当前测量值，不强制缩小已保存的宽栏。
- 不存在跨 Tab 滑动的 pill indicator，也不为选中态测量 DOM 几何。
- 文档 Tab 切换和自动滚动是即时的；拖拽重排仍保留窄插入线，因为它表达 drop 位置而不是选中动画。
- 桌面完整 Settings 左侧 Section 点击后直接定位到目标内容，不播放纵向滚动动画，避免 scroll-spy 沿途快速切换左栏选中态；用户手动滚动右侧内容时仍由 scroll-spy 同步当前 Section。这个即时定位约束只属于桌面完整 Settings，不改变移动设置页及其他共享滚动面的行为。
- 桌面完整 Settings 的分类下增加二级目录，始终全部展开，不提供折叠操作；搜索匹配一级分类、二级标题及已显示的设置项名称、说明和提示正文，忽略大小写并归一化空白；正文命中保留所属分类与分组，点击结果即时定位。没有二级标题的面板及面板开头的说明也可命中一级分类；隐藏内容和输入框的值不参与搜索。子项直接取自已挂载、可见的设置分区标题，随语言与条件内容更新，不复制一份分区文案或显示未提供的功能。点击子项即时定位，手动滚动同步两级当前项；选中态通过背景与字重表达，不绘制左侧强调竖线。键盘可逐项聚焦、激活，当前项提供 `aria-current`。`desktop-settings-section-navigation.acceptance.test.ts` 覆盖搜索、索引更新与定位行为；`node scripts/run-settings-search.mjs` 生成真实浏览器中的正文搜索、动态内容与跳转证据，`--check` 校验证据与源码一致；实际 Tauri 窗口观感另行验收。
- 侧栏开合、侧栏单双栏切换与 Bottom Timeline 开合是工作区保留的结构性动效，时长均为 `420ms`，移动中各自的线条流出玻璃。分成双栏时，中线从新半栏那一侧推入；合成单栏时，被关掉的半栏留下一块空白占位向外收起，中线随之推出（`DesktopSidebarLayout`），不会一帧跳变；`prefers-reduced-motion: reduce` 时禁用滑动与玻璃流动。
- 切换侧栏 Tab 时，半栏的内容像一块被用力推开的大冰块整体移走：新 Tab 在左就向右推，在右就向左推，新内容从另一侧跟着进来；两者走同一条先慢后快的曲线（`--ice-push`，`560ms`），像一条连在一起的带子（`DesktopSidebarLayout` 的 `SidebarPaneSlides`）。Tab 行本身不动。
- Bottom Timeline 的章节是有重量的玻璃块：静止时是稿纸底色加故事线颜色的玻璃边，占满泳道高度；拖动时只有手里这一块移动，横向是临界阻尼的弹簧（略落后于手、不回弹），跨泳道时停在原泳道，直到指针越过下一泳道的中线才一次吸附过去并带极轻微的回弹，放下的位置就是它所在的泳道（`chapter-lane-drag.ts` 的 `weighted`）。泳道名前是故事线的砂笔短横；时间线上不再画砂笔笔记。

## Dense content and semantic controls

- 正文与 H1/H2/H3 共用设置页的「段间距」：段前为 0，段后统一按正文字号计算，不再随标题等级改变；设置预览同时展示三级标题。章节、通览全书、实体长文／模板及补丁使用同一规则，补丁和预览末块保留无段后留白的边界。见 [正文与标题间距](editor/block-spacing.md) 及其浏览器验收证据。
- 编辑器 → 排版 → 换行方式提供“稳定换行 / 优化排版”，对应 `stable / pretty`，立即生效并保存在本机 `settings-storage.editorTextWrap`。默认、旧设置缺失/非法值及“还原推荐样式”均使用稳定换行。章节／漂流正文、通览静态正文与活动编辑器、要素／札记／模板、补丁正文和设置预览共用 `--editor-text-wrap`，移动端也尊重该选择。稳定换行尽量填满各行，编辑后文时保留前文断行；优化排版允许浏览器调整整段断行。不插入换行字符，不改变 Yjs、导出或段落对齐。持久化与重置由 `settings-store-appearance.test.ts`、变量更新由 `editor-preferences.test.ts`、正文与预览的样式覆盖由 `mobile-editor-settings.acceptance.test.ts` 验证；真实 WebView 排版仍需窗口验收。
- 章节／漂流正文、通览全书、要素正文、故事线／类别札记及正文模板、补丁正文统一跟随编辑器设置的字体、字号、行距与段间距。字号和行距直接作用于实际 `.ProseMirror`，避免内部 `.prose` 样式覆盖外层继承；补丁末段仍不添加底部空白。手机正文直接使用相同设置，不再另设 `17px` 字号或 `1.72` 行距下限；设置面板自身的合法范围保持不变。标题、摘要和结构化字段保留各自的层级与布局。样式契约由 `src/renderer/features/settings/mobile-editor-settings.acceptance.test.ts` 验证，真实 WebView 观感仍需窗口／设备验收。
- 编辑器设置中的字号、行距、段间距、纸张宽度与打字机位置共用 `SettingsSlider`。手动输入只校验范围和数值类型，不对齐滑块步长；例如行距 `1.55`、段间距 `0.125 em`、纸张宽度 `721 px` 均原样保存与显示。合法值即时更新预览与偏好；数字框旁的上下箭头与键盘 ↑/↓ 从当前值微调，整数项每次 `1`、小数项每次 `0.01`，不吸附到步长刻度。允许临时留空或输入越界值，编辑期间不把这些值写入偏好；回车或失焦时，空值/无效输入恢复当前有效值，越界数值收敛到上下限，字号、纸张宽度和打字机位置保留已有整数语义。只有滑块拖动沿用原步长：字号 `12–28 px / 1`、行距 `1–2 / 0.02`、段间距 `0–2.5 em / 0.05`、纸张宽度 `480–1280 px / 10`、打字机位置 `25–75% / 1`。关闭打字机模式时滑块、数字框及箭头一起禁用，抵达上下限时对应箭头禁用。数字框保留单位、范围提示和可访问名称，移动端数字框与箭头触控区域至少 `44px` 高。边界、精度保留及连续微调由 `src/renderer/features/settings/settings-slider-value.test.ts` 验证；真实 WebView 观感与输入体验仍属窗口验收。
- 侧栏中的高密度 TODO/资料列表使用 `.workspace-list` 与 `.workspace-list-row`：cell 不绘制 border，保留 `2px` 小圆角和略浅于 panel 的灰色底，彼此留出小间距。Review 卡片的底色在悬停时不变，改为借用流动的玻璃边（`.glass--surface`）。素材库条目是砂笔 cell：竖直纸条记号、悬停玻璃环、打开时画框。
- 左栏的章节、要素与构想 cell 遵循上文的 Cell 语法：记号常驻，悬停是 hairline 玻璃环，选中时砂笔画框并以 `--ink-1` 文字表达焦点；不再使用 `--surface` 或蓝色 `--accent` 底色，也不再用 hover wash。键盘 `focus-visible` 轮廓仍独立保留。
- 章节 panel 的全书/故事线视图切换与要素 panel 的紧凑索引/名称列表切换都使用 header 左侧的纯文本摘要。章节无论是否按故事线分组，都固定显示故事线数与章节总数；要素始终显示类目数与要素总数。文字本身是点击区域，只以文字颜色变化表达 hover/focus，不绘制 switch、底框或背景；显示模式不进入排序菜单。
- 章节 panel 按故事线分组时，故事线标题本身是一个 cell：左端是故事线颜色的砂笔短横（比其下章节的圆印更靠左），单击打开故事线 editor（选中时同样画框），末端的箭头负责折叠。“未归属”复用普通故事线组的 header、计数、折叠与新增章节交互，并固定追加在全部真实故事线之后；其章节继续服从故事线内排序，左侧 label 使用与组头一致的 `--ink-4` 中性灰，不留透明空槽。它与其他组共用同一个滚动容器，不再使用独立的底部 footer、展开抽屉或高度状态。
- 章节与要素 panel 的排序菜单把内外两层作为独立偏好：故事线内章节使用阅读/叙事顺序，外层故事线使用持久化的 `orderKey` 故事线顺序或名称顺序；类目内要素与外层类目分别选择名称/创建时间。不要按子项数量或最近更新自动排列外层容器，避免写作过程中整栏频繁跳位。“未归属”与“未分类”始终固定在真实故事线/类目之后；已有要素排序偏好迁移时同时初始化新的外层类目偏好，之后两者独立持久化。
- 要素 panel 不再设置 category footer、横向 chip 导航或独立高度状态。category header、要素 cell 与“未分类”组全部留在同一个纵向滚动面内；sticky header 负责持续表达当前结构，不在底部重复一套可视 category 状态。
- `GroupHeaderCell` 的新增动作使用紧随 label/count 的共享 inline slot：category 的 `+` 在紧凑索引中常驻，并作为唯一的 category 创建入口打开锚定菜单，菜单打开期间触发器继续可见，再分流到“新建要素”和“新建分组”；章节故事线与一级构想 group 继续在当前 header hover/focus 时显示；element group 与二级构想 group 也把动态 `+` 放在各自 label/count 之后。显隐选择器只命中当前 header，父 group hover 不得连带揭示后代按钮。element group 不是独立实体，而是 element 的 `groupName`；因此“新建分组”必须输入名称并同时创建、打开首个 element，不制造无法持久化的空 group。
- 要素 panel 提供可持久化的“紧凑索引 / 名称列表”两种纯文字显示模式，由 header 左侧“X 类 · XX 要素”摘要直接往返切换。紧凑索引中，展开的 category 被一圈该类目颜色的干砂笔框包住，框是九宫格切片（`frame-box.png`），任何尺寸下笔画粗细一致；标题嵌在框的上边：legend 以 `--workspace-ui-bg` 底切开上边，依次是折角记号、名称、计数／Agent 标记、legend 末端的固定 disclosure hit area（展开/收起箭头，悬停或收起时显示）与 `+`。真实 category 的文本 label 单击进入 editor、双击固定 tab，不兼任折叠；收起时框整体淡出。紧凑模式下 category 标题随内容滚动，不再 sticky。没有 element 的 category 不可展开，文本 label 仍可进入 editor。具名 element group 在框内以普通 hairline（`--workspace-local-border`）框住其卡片，不增加底色；连续具名 group 不加额外 margin，只有最后一个具名 group 与随后未分组卡片之间增加语义间距。未分组要素不画 group 框。每个要素卡是没有底色的砂笔 cell：方印记号、名称、悬停玻璃环、选中画框（`frame-tile.png`）。紧凑卡片与旧名称列表的 element label 共同复用 `.element-panel-item-label`：`--font-sans`、`12.5px`、字重 `400`、`1.35` 行高与 `-0.005em` 字距，选中不再加粗，两种视图不得分别定义另一套字号或字重。卡片使用 wrapping flex flow：名称估算宽度（含记号）决定其初始 `flex-basis`，同行剩余空间由卡片共同吸收；栏宽不足时自然退回单列。完整名称直接显示并允许换行，Agent 活动只占末端小状态标记。
- 要素 panel 的 category 标题在紧凑索引和名称列表中都将 Agent 状态放在名称右侧的要素数量位置：忙碌提示、category 自身的 `A` / `M`、子要素待查看数量按此顺序优先显示；名称列表没有 Agent 状态时恢复要素总数；紧凑网格不显示常驻总数，只有 Agent 未读改动时显示对应数量，全部已读后数量槽消失。左侧只保留折叠／类别颜色，不再额外插入 Agent 标识，故事线和漂流分组沿用原有位置。
- 紧凑 category 标题的记号、名称、计数／Agent 标记、展开箭头和新增按钮共用一段连续的 `--workspace-ui-bg` legend 底，砂笔框只出现在该段两侧，不穿过数字或按钮间隙；这些控件仍是独立点击区域，不嵌套 button。真实 category 名称 hover 使用共享延迟预览，紧凑标题的键盘 focus 也触发预览；离开、失焦或打开 editor 时关闭。预览只读取已加载的类目名称和要素数量，“未分类”不伪装成可预览的 category 实体。
- 标签、状态 chip、菜单、popover、dialog 和预览内容保持小圆角；头像、状态点、spinner 与 switch 可以保留其语义形状。它们不计作一级页面模块，也不应被无差别的全局 `border-radius: 0` 误伤。
- 不使用 inset-left vertical accent bar；强调状态继续使用背景 wash、细分隔线、字重或语义颜色。

## Persistence and responsive behavior

- 新状态默认收起左右栏，使首次进入时只突出稿纸。
- 已持久化的用户侧栏开合状态继续被尊重；这次调整不强制覆盖现有偏好。
- 桌面左右栏共享同一套分栏状态模型：实际栏宽达到“当前 Tab 行最小宽度 × 2 + `1px` 分隔线”时，保留当前面板在左，右半栏自动打开顺序中的下一个 Tab（末项循环到首项）。两侧最大宽度均为窗口的 `60%`，仍为正文保留至少 `420px`。最小宽度和双栏阈值共享同一测量来源，不再另设 `600px` 门槛。
- 双栏时，每半栏各有完整 TabRow：左侧栏各显示 3 个 Tab，右侧栏各显示 4 个 Tab；每行只控制其下方内容。点击其他 Tab 直接替换本半栏，不改变位置、不需要先取消，也不禁用另一半已打开的 Tab。两半允许同时显示同一个 Tab。
- 点击本半栏当前选中的 Tab 关闭这一半，保留另一半的实例与滚动/局部状态，并扩展为单栏；任意宽度下，点击唯一半栏当前的 Tab 则收起整个侧栏。单栏点击其他 Tab 直接切换；宽度足够时提供“恢复双栏”按钮，以当前内容和下一个 Tab 重新分栏。这个按钮位于 Tab 行靠被关掉那一半的一头（关掉外侧半栏就在外侧一头，关掉内侧半栏就在内侧一头；从未手动关过时在右端，`splitEdge` 随侧栏状态持久化），重新分栏时新半栏也从这一侧推入。关掉半栏时，按钮随剩下半栏的 Tab 行一起推过去、淡入出现。如果双栏是宽度自动打开的、作者又手动关回单栏，侧栏会记住这个选择（`keepSingle`）：之后变窄再变宽也不再自动分栏，直到作者再次手动分栏。重新打开侧栏恢复原有选择，手动保留的宽栏单栏状态不会被同一区间内的 resize 或重启撤销。
- 缩到阈值以下时保留最近交互的半栏；再次跨入宽栏区间才自动补下一个。两侧半栏身份、Tab、焦点与内部拖拽比例独立持久化；关闭左半栏后，右半栏身份不变。旧单 Tab / Agent 偏好和前一版共享 TabRow 偏好会恢复为半栏选择，不丢弃已有设置。
- 每个桌面半栏的每种 Tab 以项目、侧栏、稳定半栏身份和 Tab 类型隔离视图状态。左栏的排序、显示模式、辅助信息、选中项、折叠与滚动，Review 的范围、排序、类型筛选与展开状态，以及 Library 的筛选和关联显示均独立；切 Tab、收窄或关闭后恢复时不借用另一半的状态。排序/显示偏好独立持久化，初值沿用已有偏好；折叠、选择、筛选与滚动在当前运行期保留。移动端和独立挂载的面板继续使用原有偏好。项目内容、Agent 活动与实际编辑结果继续共享。
- Review、素材库和统计继续跟随当前编辑内容，不提供单独选择或固定章节的控件。统计保留原有标题，分隔细线贯穿两半的 TabRow 和内容。
- 每个 Agent 半栏独立保存当前会话、输入草稿、历史选择和控制按钮的目标；第二个半栏首次打开 Agent 时从空白新对话开始，可同时运行不同对话。切 Tab、关闭半栏再打开或缩放时，状态跟随稳定半栏身份保留。若主动选择同一条历史对话，其消息与运行状态仍属于同一会话，草稿各自独立；同一会话只允许一个启动准备过程及一个运行中回合。模型设置、项目数据与会话历史列表继续共享。来自批注或 Review 的“打开 Agent”先确定目标 Agent 半栏，再加载会话，保持另一半内容和位置。
- 左右栏与编辑器外侧在所有平台都直接使用不透明 `--workspace-ui-bg`。macOS 也不再启用透明窗口、`windowEffects` 或 `macOSPrivateApi`；Tauri 窗口配置显式保持 `transparent: false`，renderer 不再加载单独的原生材质样式。这样三处灰色底色来自同一个普通颜色 token，不依赖桌面壁纸、窗口激活状态或系统材质变化。
- macOS 红绿灯固定为 `x: 18, y: 22`，基础配置、macOS 覆盖配置与运行时校正必须保持一致。窗口控件行高 `42px`（`--window-titlebar-height`），同排图标按钮高 `26px` 并通过 `align-items: center` 共用中心线；`y: 22` 是针对原生 overlay 坐标系校准后的偏移。macOS leading inset 固定为 `94px`：左上角的固定开关从这里开始，左栏展开时第一个半栏的 Tab 行也从这里开始并在开关下留出空位。侧栏开关是 `28px` 圆形玻璃，与红绿灯、Dock 共用窗口控件行的中线。
- Project Home 自己拥有垂直滚动：`.dash` 必须以 `width/height: 100%` 受当前 shell 约束，并使用 `overflow-y: auto`。桌面 Home 保留完整 workspace chrome，但不绘制 Tab 外观；移动 Home 是 paper row 之外的独立 safe-area surface，仅增加项目级 Back、paper overview 和继续当前 paper 入口。隐藏的只是 scrollbar chrome，不是滚动能力。
- 移动端仍保留安全区 padding。侧栏保持 overlay 行为，但表面角色与桌面一致。
- Super View 仍是覆盖整个窗口的 overlay，带自己的 header、返回与切换器。

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
pnpm exec vitest run src/renderer/components/ui/sand-glass-materials.test.ts src/renderer/features/graph/chapter-lane-drag.pointer.test.ts
```

砂笔与玻璃的行为证据：`sand-glass-materials.test.ts` 覆盖记号映射与章节印记的稳定性、忙碌/游离记号、cell 已选中时淡入而非重画、玻璃流动按距离推进并在静止后淡出以及减少动效时不动；`chapter-lane-drag.pointer.test.ts` 覆盖时间线玻璃块在越过下一泳道中线前不换道、越过后吸附并落在所在泳道、以及弹簧跟随。材质观感（纹理流动、砂笔画框、Dock 形变、模糊）只能在真实窗口中目测；开发期在合成数据的 layout harness 中以无头 Chrome 截图检查，但 Chrome 截图不等于 macOS WebKit 观感。

测试覆盖三栏贯通的工作区组合（无顶栏、Tab 栏、editor top bar 与 footer，Bottom Timeline 可开关）、固定在两角的玻璃侧栏开关、左栏底部的账户 cell、顶部的砂笔记号 Dock 与锁、右下角的时间线开关、就近的全书视图入口、稿纸右下角的横排玻璃工具栏、已移除的字数、红灯回书架、砂笔 cell 与类目砂笔框、玻璃菜单、要素 panel 已移除的 category footer、紧凑索引的持久化模式/header 摘要切换入口与 sort menu 分离/纯文字内容/流式宽度/方印记号与无底色卡片/嵌入标题的九宫格砂笔框/空 category 禁止展开/砂笔画框选中态/连续 group 节奏与未分组边界/category 常驻新增按钮的锚定双路径菜单与首要素建组语义，以及章节、构想、element group 的 inline 动态按钮、章节/要素内外层排序解耦及末尾虚拟组约束、Super header 切换、账户二级设置页、动作菜单与富内容 menu/popover 的共享外壳和危险项语义、不透明 macOS 窗口配置、左右栏与编辑器外侧的统一灰色 token、一级 surface classes、静态 Tab、已移除的滑动 indicator、侧栏默认状态、Settings/Super View shell 与本文档。TypeScript、Vitest、renderer build 与 Tauri 配置检查可以证明结构与打包成立，但不能替代 macOS 窗口控件几何、iOS 或 Android 上的视觉、触摸和动效验收；红灯回书架、透明拖动条与侧栏 Tab 行的窗口拖动边界、开关与红绿灯的对齐、Dock 的悬停形变、砂笔画框与玻璃流动的观感仍需要在真实窗口中目测。

Renderer 的桌面/共享所有权规则记录在 [`renderer-ui-architecture.md`](renderer-ui-architecture.md)；移动端起点、缺口和设备验收边界记录在 [`mobile-ui-foundation.md`](mobile-ui-foundation.md)。
