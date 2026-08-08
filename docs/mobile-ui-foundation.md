# Mobile UI foundation assessment

## Verdict

当前代码已经具备独立的移动端产品路径：认证、书架、全局设置和 paper workspace 都由 mobile shell 组合，共享项目运行时、领域组件和数据层，不再把桌面 shell 压窄后当作移动端。paper session、上下文 panel、overview 和 Super View 路由已经实现并通过静态门禁与 iOS Simulator 主链路验收。

桌面 UI 现在由 `shells/desktop/DesktopAppShell` 独立组合；共享项目运行时位于 `app/providers/ProjectRuntimeProvider`，feature 通过 `WorkspaceNavigator` 端口导航，不再直接依赖桌面 `ui-store`。Graph、Super Views 与 Bottom Timeline 等指针密集型实现也已经迁入 desktop 路径。这使未来新增平级 `MobileAppShell` 时不需要继续给桌面组件堆叠 `isMobile` 分支。

这仍不等于“移动端全部真机完成”：双指 pinch、连续 cluster/panel 拖动、IME、安全区、前后台恢复和 Android 尚保留人工边界。完整所有权和依赖规则见 [`renderer-ui-architecture.md`](renderer-ui-architecture.md)，逐项设备证据见 [`mobile-device-acceptance.md`](mobile-device-acceptance.md)。

## What is already reusable

| Layer                  | Current evidence                                                                                                                           | Assessment                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Native target          | Tauri 项目包含 iOS/Android target、mobile capability、统一 renderer platform contract、SQLite、secure storage、deep link 与 lifecycle 边界 | 可以复用，不需要另起一套移动数据层          |
| Application runtime    | `ProjectRuntimeProvider` 集中项目启动、Yjs、同步、Agent 与 use case 生命周期；不依赖 desktop shell                                         | 可由 Desktop/Mobile 两个 shell 共同使用     |
| Navigation contract    | `WorkspaceNavigator` 隔离 feature 与 desktop router/ui-store；架构测试禁止 feature 反向依赖 desktop                                        | 移动端可以实现自己的导航 adapter            |
| Shell viewport         | `100dvh`、四向 safe-area tokens、移动端 sidebar overlay、中心列 `min-width: 0`                                                             | 能承载手机壳层，但还不是完成的移动导航      |
| Responsive entry pages | Sign-in、Dashboard、Project Picker、Settings 与 Agent context 有窄屏断点                                                                   | 登录和项目入口具备继续细化的基础            |
| Overlay primitives     | menu/popover portal 到 `body` 并固定定位；modal、menu、button、tab 已有共享 primitive                                                      | 可以演化为 sheet、action menu 与移动 dialog |
| Pointer groundwork     | 时间线已有 pinch handlers，部分 graph/material/editor 操作使用 Pointer Events                                                              | 说明输入层可扩展，但桌面专属动作仍很多      |
| Visual hierarchy       | 手机上可收起左右栏，主稿纸成为唯一核心工作面；打开工具时再覆盖出来                                                                         | 与单任务移动工作流方向一致                  |

## Remaining product acceptance gaps

1. **连续触摸手势**：上下半区 pinch、cluster 拖动、panel handle 和缩小态横滑仍需 Simulator 手工或真机验收；状态机测试只证明方向和阈值。
2. **软键盘与编辑器**：仍需围绕 `visualViewport`、IME 遮挡、selection/caret 滚动和键盘弹出后的 cluster 归位形成 iOS/Android 真机闭环。
3. **高密度模块深层操作**：Story Graph、Timeline、Plot Grid 和 Agent 已可进入，但实体编辑、长按替代、画布触控和 TSV/IME 写入仍需逐项设备回归。
4. **真实设备证据**：仍需 iOS/Android 上的旋转、安全区、后台恢复、断网恢复和性能验收。Web build、静态测试与 Simulator 主链路不能替代这些检查。

## Remaining acceptance order

1. 在 Simulator 手工关闭 pinch、cluster、panel handle、缩小态横滑和画布触控清单。
2. 在一台 iPhone 上关闭编辑 IME、安全区、前后台与断网恢复清单。
3. 在 Android 模拟器和一台 Android 真机上重复导航、手势、IME 与系统栏验收。
4. 根据设备结果再决定 Graph、Timeline、Plot Grid 是否需要进一步的移动专用降维界面。

## Acceptance boundary

本轮按约定只执行 TypeScript、lint、Vitest、renderer build 与能力清单检查；桌面 UI 由用户后续手工回归。本文档与静态测试只确认“可以开始开发”的结构前提。除非未来真实 iOS 与 Android 设备完成手工验收，不得把当前状态描述为 mobile-ready、touch-ready 或 mobile-native UX complete。

真机与模拟器的安装命令、调试方式和逐项人工检查见 [`mobile-device-acceptance.md`](mobile-device-acceptance.md)。该 runbook 只降低启动成本，不改变上述验收边界。

## Standalone mobile surfaces

### Milestone 1: authentication entry

原生 platform runtime 现在在 `/login` 与 `/register` 选择移动认证 presentation；桌面路由和项目工作区保持原样。移动认证复用既有登录、注册、OTP、密码重置、OAuth callback 和 session adoption 流程，但由 `shells/mobile/standalone/MobileAuthPage` 提供独立入口，并拥有 safe-area、`100dvh`、48px 操作热区和防止移动浏览器输入缩放的 16px 表单字号。

该里程碑只证明移动认证结构、打包和静态交互合同成立。软键盘、系统密码管理器、OTP 自动填充、OAuth deep link 和真实设备视觉仍需 iOS/Android 手工验收。

### Milestone 2: project shelf

`/` 在 mobile target 上进入 `MobileProjectShelfView`，桌面仍使用原 Project Picker。项目加载、搜索、过滤、字数进度、新建、编辑、删除和导航继续复用 `useProject` 与原控制器；移动 presentation 使用单列书籍列表、44/48px 操作热区、显式卡片操作区和底部表单 Sheet，不保留桌面 grid/list 切换或 hover-only 动作。

书架设置入口将在移动全局设置里程碑接通；本阶段不进入 `/project/:projectId`，也不建立移动工作区。静态验收不等于真机滚动、Sheet 手势或安全区视觉验收。

mobile target 打开项目时由 `MobileWorkspaceDeferredView` 明确停在工作区边界，不会错误落入 `DesktopAppShell`。该边界页不挂载 `ProjectRuntimeProvider`、编辑器或任何临时移动工作区；等用户提供新的工作区方案后再整体替换。

### Milestone 3: global settings

mobile target 的书架提供独立设置入口，`/settings` 使用列表 → 单面板的两层导航。列表和详情都复用桌面 Settings 的 `set-*` 平面、排版、分隔线与返回按钮语言，账户、订阅、外观、编辑器偏好、语言、模型、Copilot、密钥、同步、隐私和关于继续复用同一批 settings panels；移动 host 只负责 safe-area、可滚动内容容器、44px 操作热区、单列控制重排和 16px 表单输入。入口列表不再另造图标化设计语言，header 固定为桌面同款紧凑高度，详情页由独立 `set-main` 纵向滚动。

废纸篓、Agent memory、项目用量等依赖当前项目的页面不出现在工作区外设置中，也不会为了设置页面提前挂载 `ProjectRuntimeProvider`。它们与移动工作区方案一起延后。桌面 Settings modal、快捷键和 scroll-spy 行为保持不变。

### Milestone 4: viewport-safe overlays

全局 `ModalRoot` / `ModalCard` 现在把调用方传入的像 `560px` 这样的值解释为 preferred width，而不是不可收缩的实际宽度。dialog host 拥有明确的 `minmax(0, 1fr)` viewport containing block；移动端再扣除 safe-area 和 12px 最小边距，以 `100dvw` / `100dvh` 限制整体高度。`ModalBody` 独立滚动，header 与 actions 保持可见，actions 在窄屏换行并提供 48px 热区。Pre-Alpha 引导以及所有共享 modal 调用点因此走同一条路径。

Project Picker 的新建/编辑/删除 Sheet、Beta Closed dialog、Global Search、Comment Snapshot、Patch Create 和 Graph new-edge 等自定义浮层也完成了窗口宽度审计：固定数值只保留为上限，实际宽度不得超过 overlay 的可用内容区。Anchored popover 原本已 portal 到 `body` 并使用 viewport clamp，因此不另建一套移动定位逻辑。该阶段没有覆盖移动工作区；其当前实现见 Milestone 5。这些静态约束本身仍不代表工作区浮层已经通过真机触摸验收。

### Milestone 5: paper workspace shell

移动 target 打开项目后由独立 `MobileAppShell` 挂载共享 `ProjectRuntimeProvider`，不再进入 deferred 页面。移动壳层以持久化 paper session 代替桌面 tab store：章节、灵感、故事线、元素、元素分类、项目概览与通览全书共享同一套 `WorkspaceTarget` / `WorkspaceNavigator` 契约，但移动端独立负责打开、激活、关闭、重排、相邻切换和 URL 同步。feature 仍只请求 shell-neutral navigation，不读取移动或桌面 UI store。

编辑态只挂载一张完整 paper，避免在手机内存中同时保活多个 ProseMirror/Yjs editor；其余打开项只渲染轻量摘要。全部 paper 位于同一个原生横向 `flex` 滚动轨道，缩小态以 `scroll-snap` 停靠最近页，因此拖动时可见纸张作为同一 row 同步移动，不再使用“当前页退出、下一页补位”的分段动画。每张 paper 独立持久化 `scrollTop`，切回时恢复上次阅读/编辑位置。

双指向内捏合手势以上半区/下半区的起始中点判定揭示底部工具区/顶部结构区；中心死区与缩放阈值避免普通滚动和输入误触。普通幅度将对应 panel 连续带入并让 paper 等比缩小，继续捏合超过大幅度阈值则直接进入 paper overview。paper 缩小后原编辑器仍可滚动、选区和编辑。底部 paper cluster 轻点进入 overview，但垂直缩放拖动必须先长按 280ms 武装，普通划过不会改变 reveal state。上下 panel 的细线边界 handle 持续驱动 panel 高度与 paper 比例；越过半屏时立即展平为全屏，反向拖动可重新露出 paper 或关闭 panel。

顶部结构区保留窄竖排文字 tab 与 Project Dashboard 按钮，但内容主体直接复用桌面的 `ChapterPanel`、`ElementPanel`、`DriftPanel`：章节和灵感恢复从上到下的原列表，元素沿用桌面分类、分组和紧凑网格选项，不再维护一套移动专属 cell。移动 adapter 只把实体激活动作改为只读 Sheet；Sheet 展示摘要、故事线/分组、状态、字数、关联和更新时间，用户只有明确点击“插入一张纸”才会打开编辑器。Sheet 的 backdrop 吞掉完整 pointer/click 序列，轻点外侧只关闭 Sheet，不会穿透触发下面的 cell。

底部工具区使用顶部横排 tab，最右侧复用桌面 `UserAvatar` / `UserMenu`；不再显示左侧竖 rail 或额外说明标题。TODO、素材库、统计、Agent 继续复用既有业务组件，并保留可切书序/叙序的移动 timeline 与复用同一 `plotGridJson` 的情节网格。

Super View 从 overview 进入，复用共享画布/图数据与 desktop 实现，同时通过 `SuperViewNavigationContext` 注入移动端的打开、切换、关闭状态，避免依赖 desktop shell 的 Super View store。mobile target 从 viewport meta 与 WebKit `gesture*` 事件两层阻止 WebView 默认页面缩放，元素全景则以自己的 Pointer Events 双指状态机更新 canvas pan/zoom，不与宿主页面 zoom 竞争。overview 支持激活、关闭、全部关闭和网格内拖动重排 paper；每张卡片的关闭按钮位于右上角，不再使用上下箭头模拟二维网格排序。设置页记录工作区来源，关闭后返回原 paper URL；书架仍为工作区的独立边界。

设备回归补充了两项移动宿主约束：cluster 和 panel handle 的最终停靠直接根据 `pointerup` 位移计算，避免 WebKit 合并快速拖动的中间 `pointermove` 后误判为轻点；上下 context workspace 互斥可见，full-bottom panel 额外避让顶部安全区。Super View 页头在手机上把三个入口固定在第一行，视图自身控件在后续行横向滚动。元素全景与叙事结构图继续复用画布；非画布型 TODO/素材库复用同一业务组件，但在 mobile host 中改为上下堆叠。

机器验收覆盖 paper reducer、逐纸滚动位置、持久化归一化、路由解析、两段式只读 Sheet/backdrop 绑定、共享结构面板接线、横向 flex/scroll-snap 合同、panel 连续高度与半屏阈值、pinch 区域/幅度、overview 网格排序、WebView zoom guard 和 renderer import boundary；`pnpm --dir client typecheck`、定向 Vitest 与 renderer production build 是最低门禁。这些静态与状态机证据不能证明长按时长、原生惯性/停靠观感、双指画布缩放或 IME 在真机上已验收；原生多点触控仍需真机或 Simulator 手工按住 Option 验收。
