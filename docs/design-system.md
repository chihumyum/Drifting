# Workspace surface language

Drifting 的主工作区采用“单层桌面，只有一张抬起的稿纸”的结构。这个约束只重组表面层级与几何形态，不重新定义现有配色：`--paper-deep`、`--paper`、`--surface`、`--page`、`--rule` 与 ink tokens 仍然是颜色来源。

## Surface roles

1. **Workspace plane**：`AppTopbar`、编辑器周围区域、左右栏、底部时间线 dock 与 `BottomStatusBar` 共同组成一张连续桌面。它们全部使用从 editor 稿纸外侧提取的 `--workspace-ui-bg: hsl(var(--paper-deep))`；一级模块不再用不同底色假装处于不同高度。
2. **Manuscript page**：`.page` 使用现有 `--page` 与 `--page-elevation`，圆角上限由 `--workspace-corner-radius: 2px` 控制。无论左右栏是否打开，它始终是主界面唯一抬起的一级工作面。
3. **Borders and internal levels**：细灰黑 `--workspace-border` 只表达顶栏、左右栏、Bottom Timeline 与 Bottom Status Bar 的一级模块边界。三方交点没有渐变、阴影或额外装饰。局部层级只使用弱于主接缝的完整 `0.5px` hairline 与相邻灰阶：侧栏 Tab、panel header 与 content 之间的线完整贯穿各自区域，但物理厚度低于一级模块的 `1px` 接缝；侧栏 footer 顶线再弱一级。Bottom Timeline header 保持 `--workspace-ui-bg`，幕/叙事时 rail 使用稍浅的 `--paper`，故事线轨道使用 `--page`。

因此普通编辑状态只出现一块抬起的一级工作面：稿纸。标题栏、左右栏、Tab 栏、时间线与 footer 都不是额外的“岛”。

## Geometry and ownership

- `App.tsx` 的工作区是 `AppTopbar + app-row`；`app-row` 内是 `Sidebar(left) + app-mid + Sidebar(right)`。
- `app-mid` 依次拥有 `workspace-stage`、可选的 `workspace-dock` 和 `BottomStatusBar`。
- footer 只占中间编辑列。左右栏打开后直接拥有各自的左下角和右下角，不再被全宽 footer 截断。
- 左右栏与 Bottom Timeline 不通过 z 轴高低区分；模块所有权只由外边界普通 hairline 表达。三方交点不再绘制任何渐变或阴影。
- 左右栏宽度与 Bottom Timeline 高度仍由各自现有的单轴 handle 独立调整；不实现同时改变三个区域的三向 resize，也不为不存在的能力绘制提示。
- 顶层工作面使用直角或最多 `2px` 圆角。更大的圆角不用于页面模块、栏、dock 或内容列表容器。
- Settings 与三个 Super Views 使用同样的平面化 shell：边缘对齐、无 shell gap、无 shell 圆角或阴影，以分隔线表达区域边界。

## Command and status ownership

- `AppTopbar` 承担导航与功能菜单。左栏 toggle 右侧依次放置项目主页、通览全书、元素全景、故事图谱与 TODO/素材库；右侧依次放置 Copilot、Shadow、通知、右栏 toggle 与账户。普通图标按钮统一使用 `26px` 热区和约 `16px` 图标，不再缩成 footer badge。
- `BottomStatusBar` 以只读状态为主，报告当前上下文对应的章节/故事线/全书字数、今日新增字数，以及同步状态和最近成功同步时间；原 editor top bar 不再重复显示字数。唯一的交互例外是 Bottom Timeline 展开/收起开关，因为它直接控制 footer 上方相邻的 dock。
- 通知入口仍留在 topbar，因为它会打开通知中心，属于操作入口而不是被动状态。footer 后续只接受无需点击即可理解、且与当前写作任务有关的短状态。
- footer 的 `20px` 高度和编辑列所有权保持不变；除相邻 Timeline 开关外，不把低频设置或导航重新塞回底部角落。

## Component shape rules

- 通用圆角阶梯限定为 `1px / 2px / 3px`；`--radius`、`--radius-xs`、`--radius-sm`、`--radius-md` 与 `--radius-lg` 不再制造“软卡片”层级。
- button、tab、badge、tag、chip、menu row、popover、dialog、toast 和内容卡片使用直角或上述小圆角。`pill` 只保留为旧 API 名称，不再对应胶囊几何。
- 页面卡片不依靠 hover 上浮、scale 或大面积阴影表达可点击性；改用边框、背景 wash 与文字颜色。菜单和 modal 可以保留一层克制的投影，用来表达真实遮挡关系。
- 禁止 inset-left vertical accent bar。Graph tile 仍可用覆盖块面的低浓度语义 wash；Bottom Timeline 的故事线名称 rail 与桌面 UI 使用同一底灰，颜色只留给真正承载故事线语义的 marker 与 clip。幕/叙事时 rail 内的边界线取故事线轨道的 `--page` 作局部反色，延伸到故事线轨道后仍使用灰色 `--rule`。
- 只有形状本身承担语义时才允许圆形或胶囊：头像、状态点、加载 spinner，以及 switch 的 track/thumb。滚动条 thumb 沿用平台可拖拽形状；普通图标按钮不因此自动获得圆形外壳。
- Plot Planner 是连续的 mini-Excel：单元格共享 hairline 网格，不是带 gap、阴影和 hover lift 的卡片集合。

## Tabs and motion

- 顶部文档 Tab 与左右栏 Panel Tab 都由自身绘制静态矩形选中态。
- Panel Tab 的默认、hover 与 active 背景完全一致；只用暗淡文字与黑色文字的切换表达未选中和选中，不使用彩色 label、`border-bottom`、inset shadow 或其他下划线。
- 不存在跨 Tab 滑动的 pill indicator，也不为选中态测量 DOM 几何。
- 文档 Tab 切换和自动滚动是即时的；拖拽重排仍保留窄插入线，因为它表达 drop 位置而不是选中动画。
- 侧栏开合是工作区保留的结构性动效，时长为 `220ms`；`prefers-reduced-motion: reduce` 时禁用。

## Dense content and semantic controls

- 侧栏中的高密度 TODO/资料列表使用 `.workspace-list` 与 `.workspace-list-row`：cell 保留简单的四边 border、`2px` 小圆角和略浅于 panel 的灰色底，彼此留出小间距；hover/focus 只轻微提高底色，不增加阴影或位移。
- 标签、状态 chip、菜单、popover、dialog 和预览内容保持小圆角；头像、状态点、spinner 与 switch 可以保留其语义形状。它们不计作一级页面模块，也不应被无差别的全局 `border-radius: 0` 误伤。
- 不使用 inset-left vertical accent bar；强调状态继续使用背景 wash、细分隔线、字重或语义颜色。

## Persistence and responsive behavior

- 新状态默认收起左右栏，使首次进入时只突出稿纸。
- 已持久化的用户侧栏开合状态继续被尊重；这次调整不强制覆盖现有偏好。
- 移动端仍保留安全区 padding。侧栏保持 overlay 行为，但表面角色与桌面一致。桌面 topbar 的左右 command groups 在窄屏暂时隐藏；移动端必须用独立的 action menu/sheet 恢复这些能力，不能据此宣称功能等价。
- Super View overlay 停在中心列 `BottomStatusBar` 上方；工作区入口已经迁到 topbar，左右栏的底角所有权不变。

## Acceptance

静态结构契约由以下测试保护：

```bash
pnpm --dir client exec vitest run src/renderer/components/workspace-surface-language.acceptance.test.ts
```

测试覆盖 footer 的 DOM、状态职责与唯一 Timeline 开关、topbar command ownership、一级 surface classes、静态 Tab、已移除的滑动 indicator、侧栏默认状态、Settings/Super View shell 与本文档。TypeScript、Vitest 和 renderer build 可以证明结构与打包成立，但不能替代 macOS、iOS 或 Android 上的视觉、触摸和动效验收。

移动端起点、缺口和设备验收边界记录在 [`mobile-ui-foundation.md`](mobile-ui-foundation.md)。
