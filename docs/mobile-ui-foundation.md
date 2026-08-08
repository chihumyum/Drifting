# Mobile UI foundation assessment

## Verdict

当前代码**具备开始开发移动端 UI 的架构基础，但不具备宣称移动端 UI 已完成的产品基础**。

桌面 UI 现在由 `shells/desktop/DesktopAppShell` 独立组合；共享项目运行时位于 `app/providers/ProjectRuntimeProvider`，feature 通过 `WorkspaceNavigator` 端口导航，不再直接依赖桌面 `ui-store`。Graph、Super Views 与 Bottom Timeline 等指针密集型实现也已经迁入 desktop 路径。这使未来新增平级 `MobileAppShell` 时不需要继续给桌面组件堆叠 `isMobile` 分支。

本次只完成结构隔离和代码级验收，没有开发移动端 shell。响应式缩窄仍不等于移动交互设计，现阶段不能把能编译、能在窄窗口显示或存在 touch handler 当作 iOS/Android 可用性证据。完整所有权和依赖规则见 [`renderer-ui-architecture.md`](renderer-ui-architecture.md)。

## What is already reusable

| Layer                  | Current evidence                                                                                                                           | Assessment                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Native target          | Tauri 项目包含 iOS/Android target、mobile capability、统一 renderer platform contract、SQLite、secure storage、deep link 与 lifecycle 边界 | 可以复用，不需要另起一套移动数据层          |
| Application runtime    | `ProjectRuntimeProvider` 集中项目启动、Yjs、同步、Agent 与 use case 生命周期；不依赖 desktop shell                                        | 可由 Desktop/Mobile 两个 shell 共同使用     |
| Navigation contract    | `WorkspaceNavigator` 隔离 feature 与 desktop router/ui-store；架构测试禁止 feature 反向依赖 desktop                                      | 移动端可以实现自己的导航 adapter            |
| Shell viewport         | `100dvh`、四向 safe-area tokens、移动端 sidebar overlay、中心列 `min-width: 0`                                                             | 能承载手机壳层，但还不是完成的移动导航      |
| Responsive entry pages | Sign-in、Dashboard、Project Picker、Settings 与 Agent context 有窄屏断点                                                                   | 登录和项目入口具备继续细化的基础            |
| Overlay primitives     | menu/popover portal 到 `body` 并固定定位；modal、menu、button、tab 已有共享 primitive                                                      | 可以演化为 sheet、action menu 与移动 dialog |
| Pointer groundwork     | 时间线已有 pinch handlers，部分 graph/material/editor 操作使用 Pointer Events                                                              | 说明输入层可扩展，但桌面专属动作仍很多      |
| Visual hierarchy       | 手机上可收起左右栏，主稿纸成为唯一核心工作面；打开工具时再覆盖出来                                                                         | 与单任务移动工作流方向一致                  |

## Missing product foundations

1. **移动信息架构**：手机不应同时展示三块工作面。需要明确“稿纸 / 左工具 / 右工具”的单屏导航、返回路径，以及 topbar/footer 在手机上的职责。桌面迁入 topbar 的 7 个工作区动作目前会在窄屏隐藏，尚缺恢复它们的 mobile action menu/sheet。
2. **触摸尺寸系统**：当前仍有大量 `20–36px` 的桌面密度控件；尚无统一的 coarse-pointer target token、`44/48px` 操作热区或相邻目标间距规则。
3. **软键盘与编辑器**：尚无围绕 `visualViewport`、IME 遮挡、selection/caret 滚动、键盘弹出后的 footer/dock 归位所形成的验收闭环。
4. **桌面动作替代**：right-click、double-click、hover-only reveal、精细 drag/drop 与鼠标滚轮缩放需要长按、显式菜单、拖拽手柄或移动专用流程。
5. **高密度模块策略**：Story Graph、Bottom Timeline、Plot Planner、全书编辑和多栏 review 不能只等比压缩；需要各自的移动简化视图或分步操作。
6. **真实设备证据**：仍需 iOS/Android 上的视觉、触摸、IME、旋转、安全区、后台恢复和性能验收。Web build、静态测试与 simulator compile 都不能替代这些检查。

## Recommended implementation order

1. 建立 mobile primitives：breakpoint/target tokens、`44/48px` 热区、mobile sheet、action menu、safe-area 与 keyboard inset utilities。
2. 重做 app shell：手机默认只显示稿纸，左右工具成为互斥 sheet；定义紧凑 topbar 与 editor-width footer。
3. 打通编辑主链：选章、写作、查找、评论、Copilot/General Agent review、保存与 IME。
4. 为 Graph、Timeline、Plot Planner 设计触摸优先的降维交互，而不是复刻桌面画布。
5. 在至少一台 iPhone 与一台 Android 真机上关闭视觉/触摸/键盘/恢复 acceptance，再扩大移动功能面。

## Acceptance boundary

本轮按约定只执行 TypeScript、lint、Vitest、renderer build 与能力清单检查；桌面 UI 由用户后续手工回归。本文档与静态测试只确认“可以开始开发”的结构前提。除非未来真实 iOS 与 Android 设备完成手工验收，不得把当前状态描述为 mobile-ready、touch-ready 或 mobile-native UX complete。

## Standalone mobile surfaces

### Milestone 1: authentication entry

原生 platform runtime 现在在 `/login` 与 `/register` 选择移动认证 presentation；桌面路由和项目工作区保持原样。移动认证复用既有登录、注册、OTP、密码重置、OAuth callback 和 session adoption 流程，但由 `shells/mobile/standalone/MobileAuthPage` 提供独立入口，并拥有 safe-area、`100dvh`、48px 操作热区和防止移动浏览器输入缩放的 16px 表单字号。

该里程碑只证明移动认证结构、打包和静态交互合同成立。软键盘、系统密码管理器、OTP 自动填充、OAuth deep link 和真实设备视觉仍需 iOS/Android 手工验收。
