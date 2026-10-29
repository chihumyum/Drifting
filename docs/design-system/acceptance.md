# 验收

## 守护测试

设计系统的文档与实现由静态结构测试一起守着：测试断言的文字可以出现在本目录任何一篇里（`src/renderer/components/design-system-docs.test-support.ts` 把它们合起来读），改写文档时保留这些契约，或在同一次改动里更新测试。

```bash
pnpm exec vitest run src/renderer/components/workspace-surface-language.acceptance.test.ts src/renderer/components/project-dashboard-scroll.acceptance.test.ts src/renderer/components/workspace-titlebar-alignment.acceptance.test.ts src/renderer/components/left-sidebar-tab-density.acceptance.test.ts src/renderer/components/leftBars/element-panel-no-category-footer.acceptance.test.ts src/renderer/components/leftBars/element-panel-compact-index.acceptance.test.ts src/renderer/components/leftBars/left-sidebar-outer-sort.acceptance.test.ts src/renderer/shells/desktop/entity-create/desktop-universal-create.acceptance.test.ts src/renderer/features/settings/desktop/desktop-settings-section-navigation.acceptance.test.ts
pnpm exec vitest run src/renderer/components/menu-surface-style.acceptance.test.ts
pnpm exec vitest run src/renderer/lib/theme.test.ts src/renderer/components/accent-color-preference.acceptance.test.ts
pnpm test:renderer-architecture
pnpm exec vitest run src/renderer/lib/sidebar-tabs.test.ts src/renderer/lib/sidebar-pane-events.test.ts src/renderer/store/ui-store.sidebar-tabs.test.ts src/renderer/lib/layout-geometry.test.ts src/renderer/shells/desktop/desktop-sidebar-tabs.acceptance.test.ts src/renderer/store/agent-chat-preparation.integration.test.ts
pnpm exec vitest run src/renderer/lib/sand-frame.test.ts src/renderer/components/ui/sand-glass-materials.test.ts src/renderer/lib/glass-wave.test.ts src/renderer/hooks/useGlassWave.test.ts src/renderer/components/ui/glass-slider-scope-toggle.test.ts src/renderer/features/graph/chapter-lane-drag.pointer.test.ts src/renderer/features/agent/agent-glass.render.test.ts src/renderer/components/editor/entity-editor-glass.acceptance.test.ts
pnpm exec vitest run src/renderer/components/editor/paper-tools-sand-glass.acceptance.test.ts src/renderer/components/editor/outline-rail-model.test.ts src/renderer/components/editor/scroll-marker-model.test.ts src/renderer/store/ui-store.bottom-dock.test.ts
node scripts/run-tab-reorder-acceptance.mjs --check
```

所有侧栏 Tab 的视图隔离契约与合成数据验收见 [sidebar-panel-isolation](../qa/sidebar-panel-isolation.md)。

Agent 双栏隔离使用合成 repository/transport 的真实 store 验收：`pnpm exec vitest run src/renderer/store/agent-chat-views.integration.test.ts`。覆盖独立草稿、并行准备、同会话去重、异步加载、删除、停止/授权/追加指令目标、消息投影、自动续接和外部任务导航。此证据不代表真实模型或原生窗口验收。

## 行为证据

- **材料**：`sand-glass-materials.test.ts` 覆盖记号映射与章节印记的稳定性、忙碌/游离记号、cell 已选中时淡入而非重画、玻璃流动按距离推进并在静止后淡出以及减少动效时不动、选中态与按住态分开（按住在后、覆盖选中）以及水波层的样式约定。
- **水波**：`lib/glass-wave.test.ts` 覆盖水波从旧项出发、准确落在新项、途经各项依次亮起、远近决定时长、落定后进入 settle 再撤掉、按下选中的项不退回细线，以及减少动效时直接跳过；`hooks/useGlassWave.test.ts` 覆盖时间线水波只在同一泳道内流动、跨泳道不流动。
- **Panel Tab 与面板 header**：`workspace-surface-language.acceptance.test.ts` 覆盖 Panel Tab 玻璃方块与 Panel 推进共用时长和曲线、方块的几何与随距离流动、悬停任一 Tab 时整栏 Header 四边流动，以及面板 header 的放大与统一的图标按钮。
- **多选一与开关**：`glass-slider-scope-toggle.test.ts` 覆盖滑块没有轨道、方角、取稠密纹理并随移动流动，开关的同一个词与锁一样的玻璃状态。
- **Dock**：`desktop-universal-create.acceptance.test.ts` 覆盖锁与 `+` 在药丸滚动区之外、展开后滚到当前药丸；`node scripts/run-tab-reorder-acceptance.mjs` 在无头浏览器里按正常与减少动效两套跑药丸拖拽：邻居先让位、落位、取消、Escape、拖出药丸行收拢原位、拖回再让位、WebKit 松手前的假“离开窗口”不收拢、外部放下保留分屏数据，`--check` 校验证据与源码一致。
- **Agent 面板**：`features/agent/agent-glass.render.test.ts` 渲染真实的消息组件：Agent 工作时新出现的工具步骤带推波、从历史载入的不带，只读的步骤与任务清单悬停不变、能展开的步骤悬停流动，作者发出的话是对话框同款的圆角片，出错不垫底，请求授权的卡片与它的主按钮是等你处理的玻璃、主按钮排在最后，没有 `AgentGlassContext` 的移动端不带玻璃；`workspace-surface-language.acceptance.test.ts` 守着对话框的玻璃片、左下托盘、右下圆形按钮与「上提／弯杆上提」，以及 `materials.css` 里五种修饰的关键规则和 Dock 无色药丸取浅灰。
- **实体编辑器**：`components/editor/entity-editor-glass.acceptance.test.ts` 渲染桌面与移动端的 `KvEditor`（桌面每行是输入片、只读是静止细线、移动端没有玻璃），并守着各编辑器的移动端门控、页头的大记号与圆形玻璃色板、清单的 cell 行与 `GlassSlider`、关联卡与就地选择器、平的提及行、补丁卡与推波、对话框的菜单行与玻璃卡，以及 `entity-editors.css` 的桌面规则不垫底、没有投影、没有左侧竖条。
- **悬停卡**：`menu-surface-style.acceptance.test.ts` 覆盖没有右键菜单、所有对象的操作在悬停卡里、滚动列表时卡片收起而不是跟着走、滚动中滑到指针下的行不弹卡。
- **浮层、对话框与控件**：`menu-surface-style.acceptance.test.ts` 还覆盖对话框、全局搜索、查找条与通知中心共用菜单外壳且背后是桌面色薄雾、头尾不画线，键盘当前行是静止的环、命中不垫底，账户菜单的分组留白与两个多选一，桌面 `Button` 的玻璃映射与危险按钮只用危险色的字、危险确认先聚焦取消，单行输入框、下拉选择、整行开关、空状态、加载（`240ms` 后出现）与进度的定义，以及范围内每个对话框都改用共用外壳与控件。观感（薄雾浓淡、深色主题、WKWebView 里的玻璃）仍要目测。
- **时间线**：`chapter-lane-drag.pointer.test.ts` 覆盖时间线玻璃块在越过下一泳道中线前不换道、越过后吸附并落在所在泳道、以及弹簧跟随。
- **砂笔框**：`lib/sand-frame.test.ts` 覆盖同一种子画出同一笔、不同种子不同、笔迹从左侧中段起笔并最后画到顶边、笔触粗细不随格子高度变化，以及同一种子拖宽时左半边逐像素不变、右边一段随边缘平移；`sand-glass-materials.test.ts` 覆盖选中的 cell 带画布画框、未选中不带，以及画框不再依赖固定贴图。
- **稿纸工具**：`paper-tools-sand-glass.acceptance.test.ts` 覆盖大纲当前位置那一道归属色的短砂（取色由 `outline-rail-model.test.ts` 的 `outlineEntryColor` 覆盖）、上级加粗、不用强调色、幕用结构字、省略展开是菜单浮层；选区浮条是玻璃长药丸、格式条是 `body` 上的兄弟而不是子元素、格式是砂笔符号的圆形玻璃、长药丸按下不加深、移动端回退；滚动标记是按 key 固定的砂印（`scroll-marker-model.test.ts` 覆盖 `scrollMarkerSeal` 稳定且有变化）、悬停加深、离开淡出；情节规划与 Bottom Timeline 共用底部位置（`ui-store.bottom-dock.test.ts` 覆盖互斥与旧状态恢复）、只有获得焦点的编辑器把网格放进去、从顶边拖高、泳道纸条没有底色变化与强调色、移动端保留 hairline 表格；九枚格式符号的素材、`BrushIcon` 与生成脚本一致。真实 Chromium 里的选区浮条行为由 `src/renderer/performance/editor-selection-bar-scenarios.ts` 驱动，没有重新生成性能证据。

## 只能目测的部分

测试覆盖三栏贯通的工作区组合（无顶栏、Tab 栏、editor top bar 与 footer，Bottom Timeline 可开关）、固定在两角的玻璃侧栏开关、左栏底部的账户 cell、顶部的砂笔记号 Dock 与锁、右下角的时间线开关、就近的全书视图入口、稿纸右下角的横排玻璃工具栏、已移除的字数、红灯回书架、砂笔 cell 与类目砂笔框、桌面色菜单与悬停卡、玻璃静止态与玻璃轨 switch、要素 panel 已移除的 category footer、紧凑索引的持久化模式/header 摘要切换入口与 sort menu 分离/纯文字内容/流式宽度/方印记号与无底色卡片/嵌入标题的九宫格砂笔框/空 category 禁止展开/砂笔画框选中态/连续 group 节奏与未分组边界/category 常驻新增按钮的锚定双路径菜单与首要素建组语义，以及章节、构想、element group 的 inline 动态按钮、章节/要素内外层排序解耦及末尾虚拟组约束、Super header 切换、账户二级设置页、动作菜单与富内容 menu/popover 的共享外壳和危险项语义、不透明 macOS 窗口配置、左右栏与编辑器外侧的统一灰色 token、一级 surface classes、静态 Tab 文字与其下随 Panel 推进滑动的玻璃方块、侧栏默认状态、Settings/Super View shell 与本设计系统文档。TypeScript、Vitest、renderer build 与 Tauri 配置检查可以证明结构与打包成立，但不能替代 macOS 窗口控件几何、iOS 或 Android 上的视觉、触摸和动效验收；红灯回书架、透明拖动条与侧栏 Tab 行的窗口拖动边界、开关与红绿灯的对齐、Dock 的悬停形变、砂笔画框与玻璃流动的观感仍需要在真实窗口中目测。

开发期的观感检查在合成数据的 layout harness（`.local-data/layout-harness`，本地文件，不入库）里用无头 Chrome 截图，必要时用 Playwright 的 WebKit 补测悬停与点击；但两者都不等于 macOS 的 WKWebView：WKWebView 对溢出的滚动区做异步合成，原生拖拽也只能在真实窗口里走。
