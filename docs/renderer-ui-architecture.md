# Renderer UI architecture

## Current status

桌面 UI 已从应用入口和可复用 feature 中隔离到独立的 `shells/desktop` 路径。当前改动的目标是建立双壳结构的依赖方向，**没有实现移动端 UI，也不把桌面组件改成带大量 `isMobile` 分支的响应式万能组件**。

```text
App.tsx
├── app/effects                 全局外观、语言、生命周期副作用
├── app/AppRoutes.tsx           鉴权、onboarding 与项目路由
└── shells/desktop
    ├── DesktopAppShell         桌面 UI 状态与组合根
    ├── DesktopWorkspace        topbar / sidebars / editor / dock
    ├── DesktopOverlayHost      settings / search / super views / dialogs
    ├── navigation              ui-store + router 的桌面适配器
    └── views                   指针和画布密集型桌面实现

app/providers/ProjectRuntimeProvider
└── SQLite / Yjs / sync / Agent / use cases（与 shell 无关）

features
├── workspace/navigation        shell-neutral 导航端口
├── settings / agent / library  可组合内容与桌面呈现适配器
├── comments / stats            领域内容、模型与小型展示组件
├── entities/hover              实体预览领域组件
└── graph                       无 UI store 的投影与布局模型
```

## Dependency rules

依赖只允许向下流动：

1. `App.tsx` 只组合 effects、routes 和全屏状态，不拥有项目工作区细节。
2. `ProjectRuntimeProvider` 拥有项目启动、数据库、Yjs、同步、Agent bridge 和写作统计等运行时生命周期；shell 只消费已经建立的运行时。
3. `shells/desktop` 可以依赖共享 feature、use case、store 和 UI primitive，并负责桌面键盘、指针、浮层、dock 与多栏布局。
4. `features` 不得依赖 `shells/desktop`、`store/ui-store` 或旧的 `useProjectNavigation`。需要导航时只消费 `WorkspaceNavigator` 端口。
5. `components/ui` 放置无业务 store 的呈现 primitive。依赖实体仓库的 `EntityHoverCard` 已迁入 `features/entities/hover`；旧路径只保留兼容导出。
6. 历史入口允许暂时保留薄 re-export，但不得重新承载实现。架构测试对这些文件设置了行数上限。

这些规则由 `src/renderer/architecture/renderer-boundaries.test.ts` 和 ESLint 的 restricted imports 共同保护。

## Desktop-only ownership

以下实现明确属于桌面，不应被未来的移动壳直接 import：

- `DesktopWorkspace`、`DesktopOverlayHost`、桌面全局快捷键与 UI store 导航适配器；
- `DesktopStoryGraphView`、`DesktopSuperElementView`、`DesktopSuperMemoMaterialView`；
- `DesktopBottomTimeline` 和 `ElementCardPopover`；
- `DesktopSettingsModal`、`DesktopAgentPanel`、`DesktopCommentRail`、`DesktopEditorRoutes`。

Graph、Super Element 和 Timeline 仍是较大的高内聚交互控制器。它们已整体迁入桌面路径，避免移动端被其鼠标、拖拽、快捷键和空间画布状态耦合；可复用计算分别下沉到 `story-graph-model.ts`、`super-element-category-model.ts`、现有 timeline selectors/hooks 与 domain 模块。后续若修改这些控制器，应优先继续提取纯计算或独立视觉块，不应把桌面状态回流到共享 feature。

### 2026-08-08 桌面交互收敛

- Bottom Timeline 与 Storyline Graph 不再分别定义章节落点、故事线迁移和原生拖放初始化。`features/graph/chapter-lane-drag.ts` 是两种桌面投影共用的纯策略与写入编排；它为 WebKit `DataTransfer` 写入真实 payload，并统一本书、未归属、抽屉和真实故事线的落点语义。
- `components/ui/RelationKindField.tsx` 统一两个关系创建流程的自由输入与类型建议。建议层通过 `AnchoredPopover` portal 到 `body` 并使用 viewport fixed 坐标，modal 的 `overflow` 不再参与裁切。
- Library 卡片仍复用 `EntityRelationPicker`，但选择器展开期间卡片解除局部高度上限；Library panel 是该流程唯一的纵向滚动 owner。
- `DesktopSuperViewHeader` 是桌面 Super View 切换的唯一入口。工作区 `SUPER` 直接进入 `lastActiveSuperView`（首次默认为 Element），三个横向选项只存在于 Super header；共享 `SuperViewHeader` 本身仍不依赖 UI store。
- 通览全书使用 Iconoir `PageFlip` 图标；Super/Settings 返回与共享 Drift Panel 关闭均使用真实 SVG icon，并保留 title/ARIA 文本而不渲染 glyph 文本。

对应机器验收覆盖 `chapter-lane-drag.test.ts`、`workspace-surface-language.acceptance.test.ts`、`menu-surface-style.acceptance.test.ts` 与 renderer boundary tests。拖拽手感、视觉位置与真实数据回归仍属于用户手工验收边界。

## Reusable UI and feature pieces

未来的 `MobileAppShell` 可以复用：

- `ProjectRuntimeProvider`、全部 domain/use case/repository/Yjs/sync 能力；
- `DialogContent` 的 header/body/actions 内容结构；移动端只需提供 sheet surface；
- Settings 的 primitives 和各 rail panel 内容；
- Library 的 `LibraryItemCard`、`TodoCard`、preview 和 compose dialogs 的内容逻辑；
- Agent composer config、message views 和运行时；
- comments 的 rail model、snapshot content 与统一 anchor/review 数据；
- stats 的 `AllChaptersStats`、`EntityStatsContent` 与 `StatsPrimitives`；
- entity hover 的内容模型、graph/category 的纯投影与布局模型。
- `RelationKindField`、关系/素材卡片内容以及其他无桌面 store 的小型输入 primitive；移动端可以换用 sheet host，而不复制输入与筛选逻辑。

“可以复用”不代表移动端必须原样呈现。卡片和内容组件可被 sheet、全屏页或单列导航重新编排；桌面 modal、hover、right-click 和多栏 host 不属于复用合同。

## Large-file decomposition completed

- `App.tsx` 收敛为 66 行，项目运行时和桌面组合根独立。
- Settings 从单文件拆为 modal 导航、共享 primitives 和六组 panel。
- Agent 拆出 composer/config 与 message/thinking/tool views。
- Library/TODO 拆为 panel、card、preview、dialogs、media helper；旧 `MemoMaterialPanel.tsx` 仅为兼容 barrel。
- Right sidebar 的 stats 拆为 host、全书统计、实体统计与展示 primitives。
- Comments 拆出 snapshot modal、排序/激活/分歧模型和桌面 adapter。
- Editor routes 通过 desktop adapter 集中桌面页面选择，编辑器内容和 Yjs 写入路径保持不变。
- Graph、Super Views、Timeline 的完整交互实现迁入 desktop views；历史文件仅兼容导出。
- 原单体 `index.css` 按基础/editor、comments/review、entity editors、desktop shell 分层，并保持原 cascade 导入顺序。

## CSS ownership

| File | Ownership |
| --- | --- |
| `src/styles/index.css` | tokens、reset、共享 primitive 与 editor 基础 |
| `src/styles/comments-review.css` | comments、TOC、inline review 与 review cards |
| `src/styles/entity-editors.css` | entity editors、relations、metadata 与编辑器领域表面 |
| `src/styles/desktop-shell.css` | desktop shell 几何、三栏工作区和全屏状态 |

新增样式应进入最窄的所有权文件。移动壳不得覆盖 `desktop-shell.css` 来模拟另一套布局，而应拥有独立入口和样式文件。

## Code-level acceptance

本阶段只要求静态与构建正确性，验收命令为：

```bash
pnpm typecheck
pnpm --dir client lint
pnpm --dir client test
pnpm --dir client exec vite build
pnpm --dir client agent:capabilities:check
```

代码级通过不等于 UI 视觉回归通过。桌面视觉、交互手感和真实数据工作流由用户在本阶段结束后手工回归；本文也不据此宣称移动端已完成或 mobile-ready。
