# 表面、形状、颜色与字号

## 表面层级

Drifting 的主工作区采用“单层桌面，只有一张抬起的稿纸”的结构。这个约束只重组表面层级与几何形态，不重新定义现有配色：`--paper-deep`、`--paper`、`--surface`、`--page`、`--rule` 与 ink tokens 仍然是颜色来源。2026-10-28 起桌面色值改为“更接近”的一组：浅色 `--paper-deep: 40 9% 94.5%`、`--paper: 42 14% 97%`、`--page: 45 30% 99.5%`（稿纸更白、侧栏与稿纸更近），深色 `--paper-deep: 220 6% 11.5%`、`--paper: 220 6% 12.5%`；token 名与使用位置不变。

1. **Workspace plane**：编辑器周围区域、左右栏与可选的 Bottom Timeline dock 共同组成一张连续桌面；没有标题栏、文档 Tab 栏、editor top bar 或底部状态栏。它们全部使用从 editor 稿纸外侧提取的不透明 `--workspace-ui-bg: hsl(var(--paper-deep))`；一级模块不再用不同底色假装处于不同高度。
2. **Manuscript page**：`.page` 使用现有 `--page` 与 `--page-elevation`，圆角上限由 `--workspace-corner-radius: 2px` 控制。无论左右栏是否打开，它始终是主界面唯一抬起的一级工作面。
3. **Borders and internal levels**：细灰黑 `--workspace-border` 只表达左右栏与 Bottom Timeline 的一级模块边界。三方交点没有渐变、阴影或额外装饰。侧栏局部层级只在 Tabs 与 panel header 之间保留一条完整的 `0.5px` hairline；左右栏显示双列时，两列之间也用同一条 `--workspace-local-border` hairline，同时保留较宽的透明拖拽热区。panel header 直接衔接 content，不再重复画第二条线，侧栏 footer 顶线则再弱一级。Bottom Timeline header 保持 `--workspace-ui-bg`，幕/叙事时 rail 使用稍浅的 `--paper`，故事线轨道使用 `--page`；幕边界、时间点和相邻故事线轨道的静态 guide 使用 header 的 `--workspace-ui-bg`，厚度统一为 `0.5px`。
4. **Floating layers**：菜单、悬停卡、对话框、全局搜索、稿纸内查找条与通知中心是从桌面掀起的一块：侧栏同色的不透明 `--workspace-ui-bg`、直角、`0.5px` 墨色 hairline 加浮起投影（`--menu-surface-*`）。它们整体没有玻璃。下拉菜单与悬停卡例外（2026-10-31）：同样的桌面底与浮起投影，但是 `16px` 圆角，边是静止的细玻璃线而不是 hairline，菜单的行左右缩进 `6px`、每行以图标开头，见 [interaction.md](interaction.md)。选区浮条不在其中：它是浮在稿纸上的玻璃长药丸，和稿纸工具栏同一种，不带投影（2026-10-29）。对话框与全局搜索背后不压暗，只蒙一层桌面颜色的薄雾。

因此普通编辑状态只出现一块抬起的一级工作面：稿纸。左右栏、时间线、稿纸角上的按钮与稿纸顶边的标签记号都不是额外的“岛”。

**投影只有三处**：稿纸（`--page-elevation`）、浮层（`--menu-surface-shadow`，对话框、全局搜索与查找条也用它）、拖在手里的药丸副本（一层浅投影，表示被拿起来）。玻璃控件、卡片与 cell 都不靠投影、上浮或缩放表达可点击。

投影的颜色是 `--shadow-ink`：浅色是墨色，深色是黑。深色里墨色近白，拿它画投影会在浮层底下发出一圈白光，像在发光而不是被掀起（2026-10-29 深色复核）。深色下浮层投影加深到 62%、药丸副本 40%，因为黑投影落在深底上比墨投影落在纸上淡；`0.5px` 的边线与内嵌细线仍用墨色。各处自己的浮起投影（实体卡片弹层、关系类型建议、图片菜单、快照弹窗、关系边弹层、素材舞台与笔记浮条）也用 `--shadow-ink`。

## 形状语法

形状表达这个东西是什么，而不是为了好看。

| 形状 | 给谁用 |
| --- | --- |
| 圆形 | 单独存在的工作区级玻璃按钮（侧栏开关、锁、`+`、时间线开关、全书视图入口、稿纸工具栏里的按钮、选区浮条格式条里的符号）；Agent 对话框里的停止、补充、发送与托盘里的按钮；圆形砂印；头像、状态点、加载转圈、Switch 圆钮 |
| 胶囊 | 一排玻璃控件合成的一条：Dock 药丸、稿纸工具栏长药丸、选区浮条与它的格式条、素材笔记的清单与表格浮条（以及里面的短药丸）、Agent 对话框左下的托盘、Switch 轨道 |
| 大圆角 `16px` | 作者写字的那张片：Agent 对话框，以及记录里作者已经发出的话（同一张稿纸色圆角片）；浮起的下拉菜单与悬停卡（2026-10-31，边是静止细玻璃线） |
| 直角方块 | 垫在一排文字下表示选中的玻璃方块（Panel Tab 方块、筛选滑块、范围开关）；对话框、全局搜索与查找条；悬停卡里的行（下拉菜单与悬停卡本身是 `16px` 圆角，下拉菜单里的行是 `4px` 圆角） |
| 小圆角 `1–3px` | 其余一切：按钮、单行输入框与下拉选择的触发器、标签、chip、popover、toast、内容卡片、时间线章节块（`1px`）、稿纸（`2px`） |

- 通用圆角阶梯限定为 `1px / 2px / 3px`（大圆角只给上表那几处；下拉菜单里缩进的行是 `4px`，作者在菜单原型上定的）；`--radius`、`--radius-xs`、`--radius-sm`、`--radius-md` 与 `--radius-lg` 不再制造“软卡片”层级。顶层工作面使用直角或最多 `2px` 圆角，更大的圆角不用于页面模块、栏、dock 或内容列表容器。
- 圆形与胶囊只给上表列出的玻璃控件与语义形状；面板里的普通图标按钮不因此获得圆形外壳。滚动条 thumb 沿用平台形状。
- 页面卡片不依靠 hover 上浮、scale 或大面积阴影表达可点击性；改用边框、背景 wash、文字颜色或玻璃边。
- 禁止 inset-left vertical accent bar；强调状态使用背景 wash、细分隔线、字重、语义颜色或玻璃。Graph tile 仍可用覆盖块面的低浓度语义 wash；Bottom Timeline 的故事线名称 rail 与桌面 UI 使用同一底灰，颜色只留给真正承载故事线语义的 marker 与 clip。幕/叙事时 rail 内及故事线轨道里的静态竖线统一取 header 的 `--workspace-ui-bg`；相邻故事线轨道之间也用同色 `0.5px` 横线分隔。
- Plot Planner 是一张连续的网格，不是带 gap、阴影和 hover lift 的卡片集合。桌面上它和 Bottom Timeline 共用稿纸下面同一个 Bottom Panel（同一份高度与 header 行），画成这一章自己的小时间线：泳道名在桌面色的栏里，泳道是稿纸白、之间是桌面色 `0.5px` 线，每格是一张带静止细玻璃线的纸条（见 [components.md](components.md)）。暂停中的移动端保留共享 hairline 网格的 mini-Excel。

## 强调色

- `--accent`、`--accent-foreground` 与 `--ring` 是 renderer 的共享交互强调色契约。未自定义时，它们继续分别由 `:root` 与 `.dark` 的内置 palette 提供，不产生 inline override。
- 外观设置中的 `accentColor` 是可同步的六位 Hex 偏好；`null` 表示恢复当前浅色/深色主题的内置强调色。运行时必须先把 Hex 转成 HSL triplet，再写入 root token，因为现有消费者会组合 `hsl(var(--accent) / alpha)`。`--accent-foreground` 自动选择黑/白高对比前景，`--ring` 与 accent 同步；中性的 `--accent-border` 仍由主题 palette 管理。
- 编辑器 `caretColor`、Entity Link 的上下文/分类颜色、Storyline 与 Category 颜色都是独立语义，不跟随全局 accent。当前设置覆盖共享 renderer（包括移动 WebView UI），不宣称同步 iOS/Android 原生 system tint。
- 强调色在材料里只出现在：开着的 Switch 轨道、通览全书的星号记号、完成的章末 ⁂、面板 header 的“新建”图标。故事线与类目颜色由各自的记号、cell 环与玻璃边承载。

## 桌面字号

桌面 UI 遵循 [Apple Typography](https://developer.apple.com/cn/design/human-interface-guidelines/typography) 的可读性、语义层级与可放大原则。Apple 的 macOS 默认/最小值是 13pt/10pt；下面是针对中文写作界面选择的 CSS px 档位，不把 pt 机械换算成 CSS px，也不把最小值用作常用文字的默认值。

- `desktop-typography.css` 在 `html[data-shell-mode='desktop']` 定义 body / secondary / caption / emphasis / heading，标准档分别为 `14 / 13 / 12 / 15 / 16px`，较大档各增加 `2px`。保留现有 UI 字体。字号角色覆盖桌面导航、侧栏列表、菜单、设置、Agent/Review 工具、搜索和时间线 UI；图形 glyph、内容标题与稿件排版保留各自语义。
- 外观 → 界面字号提供“较小 / 标准 / 较大”，默认标准，立即生效并保存在此设备的 `settings-storage.interfaceTextSize`；缺失/非法值回落到标准。“较小”使用各组件调整前保留的字号 fallback，例如菜单 `12.5px`、侧栏标签 `11.5px`、状态栏 `10px`、设置说明 `12px`；不是统一减去 `2px`。该档保留标准档的控件留白、行高和改善后的对比度。移动 shell 不显示该选项，共享组件的原字号作为 CSS fallback；这不是接入原生 Dynamic Type 的声明。
- Agent 对话跟随同一界面字号设置：较小／标准／较大档的用户消息、回复、输入框和代码为 `12 / 14 / 16px`，思考与工具说明为 `11.5 / 13 / 15px`，时间与用量为 `10.5 / 12 / 14px`，Markdown 标题为 `13.5 / 16 / 18px`。消息正文和输入框行高为 `1.4`；输入框在字号变化后重新测量高度，长代码块横向滚动，用量栏允许换行。双栏同时响应同一设置，共享消息组件在移动端保留原字号 fallback。
- 正文继续由 `--editor-font-size` 与编辑器偏好控制；UI 档位不更改正文、Yjs、数据库或字体来源。变量位于 HTML 根节点，让 portal 到 body 的菜单得到同样字号。
- 常读辅助文字使用 `--ui-text-muted`。当前浅色/深色状态栏样本对比度为 `4.93:1 / 8.58:1`，不通过缩小、减淡文字同时压低层级。不要将此局部样本视为全产品对比度认证。
- 桌面列表行为 `32 / 34px`，panel header 最小高度为 `32 / 34px`（基础控件高度加 `4px`，正好放下整书视图的圆形玻璃入口）的 1.25 倍（`--panel-header-scale`，即 `40 / 42.5px`），有没有这个入口的 panel 一样高，行内文字与按钮垂直居中；侧栏 footer 为 `24 / 26px`。桌面 Super View 没有底部 inset（`--super-view-bottom-inset: 0px`），覆盖整个窗口：窗口底边不再有横贯的状态栏，留出的那一条只会露出下面的工作区。左右栏顶部的 Panel Tab 行同时承载窗口控件，与窗口控件行同高 `42px`。菜单使用 `20 / 22px` 行高并允许多行撑高；设置表单在窄窗口堆叠。
- 文档 Tab 的隐藏测量节点与可见标签使用同一字号变量，并在字号变动后重新分配宽度。

验收入口和界限见 [桌面字号验收](../qa/desktop-typography.md)。
