# Workspace surface language

Drifting 的主工作区采用“一个平面，最多三块抬起的工作面”的结构。这个约束只重组表面层级与几何形态，不重新定义现有配色：`--paper-deep`、`--paper`、`--surface`、`--page`、`--rule` 与 ink tokens 仍然是颜色来源。

## Surface roles

1. **Workspace plane**：`AppTopbar`、编辑器周围区域、底部时间线 dock 与 `BottomStatusBar` 共用 `--paper-deep`。它们连续、无圆角、无外层阴影，不再分别模拟浮动卡片。
2. **Manuscript page**：`.page` 使用现有 `--page` 与 `--page-elevation`，圆角上限由 `--workspace-corner-radius: 2px` 控制。左右栏都收起时，它是主界面唯一抬起的一级工作面。
3. **Tool slabs**：左栏和右栏使用现有 `--chrome-bg`，贴住窗口侧边并延伸到底部。打开时只在朝向编辑器的一侧保留分隔线和轻微投影；关闭后宽度、分隔线与投影都归零。

因此普通编辑状态最多出现三块一级工作面：左工具栏、稿纸、右工具栏。标题栏、Tab 栏、时间线与 footer 都不是额外的“岛”。

## Geometry and ownership

- `App.tsx` 的工作区是 `AppTopbar + app-row`；`app-row` 内是 `Sidebar(left) + app-mid + Sidebar(right)`。
- `app-mid` 依次拥有 `workspace-stage`、可选的 `workspace-dock` 和 `BottomStatusBar`。
- footer 只占中间编辑列。左右栏打开后直接拥有各自的左下角和右下角，不再被全宽 footer 截断。
- 顶层工作面使用直角或最多 `2px` 圆角。更大的圆角不用于页面模块、栏、dock 或内容列表容器。
- Settings 与三个 Super Views 使用同样的平面化 shell：边缘对齐、无 shell gap、无 shell 圆角或阴影，以分隔线表达区域边界。

## Component shape rules

- 通用圆角阶梯限定为 `1px / 2px / 3px`；`--radius`、`--radius-xs`、`--radius-sm`、`--radius-md` 与 `--radius-lg` 不再制造“软卡片”层级。
- button、tab、badge、tag、chip、menu row、popover、dialog、toast 和内容卡片使用直角或上述小圆角。`pill` 只保留为旧 API 名称，不再对应胶囊几何。
- 页面卡片不依靠 hover 上浮、scale 或大面积阴影表达可点击性；改用边框、背景 wash 与文字颜色。菜单和 modal 可以保留一层克制的投影，用来表达真实遮挡关系。
- 禁止 inset-left vertical accent bar。Graph tile 与时间线 rail 的归属色改为覆盖整个块面的低浓度 wash，既保留语义，也不在左边挂装饰性色条。
- 只有形状本身承担语义时才允许圆形或胶囊：头像、状态点、加载 spinner，以及 switch 的 track/thumb。滚动条 thumb 沿用平台可拖拽形状；普通图标按钮不因此自动获得圆形外壳。
- Plot Planner 是连续的 mini-Excel：单元格共享 hairline 网格，不是带 gap、阴影和 hover lift 的卡片集合。

## Tabs and motion

- 顶部文档 Tab 与左右栏 Panel Tab 都由自身绘制静态矩形选中态。
- 不存在跨 Tab 滑动的 pill indicator，也不为选中态测量 DOM 几何。
- 文档 Tab 切换和自动滚动是即时的；拖拽重排仍保留窄插入线，因为它表达 drop 位置而不是选中动画。
- 侧栏开合是工作区保留的结构性动效，时长为 `220ms`；`prefers-reduced-motion: reduce` 时禁用。

## Dense content and semantic controls

- 侧栏中的高密度 TODO/资料列表使用 `.workspace-list` 与 `.workspace-list-row`：透明底、直角、行分隔，hover/focus 时才出现轻微 wash。
- 标签、状态 chip、菜单、popover、dialog 和预览内容保持小圆角；头像、状态点、spinner 与 switch 可以保留其语义形状。它们不计作一级页面模块，也不应被无差别的全局 `border-radius: 0` 误伤。
- 不使用 inset-left vertical accent bar；强调状态继续使用背景 wash、细分隔线、字重或语义颜色。

## Persistence and responsive behavior

- 新状态默认收起左右栏，使首次进入时只突出稿纸。
- 已持久化的用户侧栏开合状态继续被尊重；这次调整不强制覆盖现有偏好。
- 移动端仍保留安全区 padding。侧栏保持 overlay 行为，但表面角色与桌面一致。
- Super View overlay 停在中心列 `BottomStatusBar` 上方；底部入口保持可用，左右栏的底角所有权不变。

## Acceptance

静态结构契约由以下测试保护：

```bash
pnpm --dir client exec vitest run src/renderer/components/workspace-surface-language.acceptance.test.ts
```

测试覆盖 footer 的 DOM 所有权、一级 surface classes、静态 Tab、已移除的滑动 indicator、侧栏默认状态、Settings/Super View shell 与本文档。TypeScript、Vitest 和 renderer build 可以证明结构与打包成立，但不能替代 macOS、iOS 或 Android 上的视觉、触摸和动效验收。

移动端起点、缺口和设备验收边界记录在 [`mobile-ui-foundation.md`](mobile-ui-foundation.md)。
