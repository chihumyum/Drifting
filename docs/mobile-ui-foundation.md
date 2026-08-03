# Mobile UI foundation assessment

## Verdict

当前代码**具备开始开发移动端 UI 的架构基础，但不具备宣称移动端 UI 已完成的产品基础**。

这次 surface 重构让编辑器、左右工具栏与底部入口的所有权更清楚，也减少了依赖桌面浮岛间距的布局耦合；它是合适的移动端起点。不过，响应式缩窄并不等于移动交互设计。现阶段不能把能编译、能在窄窗口显示或存在 touch handler 当作 iOS/Android 可用性证据。

## What is already reusable

| Layer                  | Current evidence                                                                                                                           | Assessment                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Native target          | Tauri 项目包含 iOS/Android target、mobile capability、统一 renderer platform contract、SQLite、secure storage、deep link 与 lifecycle 边界 | 可以复用，不需要另起一套移动数据层          |
| Shell viewport         | `100dvh`、四向 safe-area tokens、移动端 sidebar overlay、中心列 `min-width: 0`                                                             | 能承载手机壳层，但还不是完成的移动导航      |
| Responsive entry pages | Sign-in、Dashboard、Project Picker、Settings 与 Agent context 有窄屏断点                                                                   | 登录和项目入口具备继续细化的基础            |
| Overlay primitives     | menu/popover portal 到 `body` 并固定定位；modal、menu、button、tab 已有共享 primitive                                                      | 可以演化为 sheet、action menu 与移动 dialog |
| Pointer groundwork     | 时间线已有 pinch handlers，部分 graph/material/editor 操作使用 Pointer Events                                                              | 说明输入层可扩展，但桌面专属动作仍很多      |
| Visual hierarchy       | 手机上可收起左右栏，主稿纸成为唯一核心工作面；打开工具时再覆盖出来                                                                         | 与单任务移动工作流方向一致                  |

## Missing product foundations

1. **移动信息架构**：手机不应同时展示三块工作面。需要明确“稿纸 / 左工具 / 右工具”的单屏导航、返回路径，以及 topbar/footer 在手机上的职责。
2. **触摸尺寸系统**：当前仍有大量 `20–36px` 的桌面密度控件；尚无统一的 coarse-pointer target token、`44/48px` 操作热区或相邻目标间距规则。
3. **软键盘与编辑器**：尚无围绕 `visualViewport`、IME 遮挡、selection/caret 滚动、键盘弹出后的 footer/dock 归位所形成的验收闭环。
4. **桌面动作替代**：right-click、double-click、hover-only reveal、精细 drag/drop 与鼠标滚轮缩放需要长按、显式菜单、拖拽手柄或移动专用流程。
5. **高密度模块策略**：Story Graph、Bottom Timeline、Plot Planner、全书编辑和多栏 review 不能只等比压缩；需要各自的移动简化视图或分步操作。
6. **真实设备证据**：仍需 iOS/Android 上的视觉、触摸、IME、旋转、安全区、后台恢复和性能验收。Web build、静态测试与 simulator compile 都不能替代这些检查。

## Recommended implementation order

1. 建立 mobile primitives：breakpoint/target tokens、`44/48px` 热区、mobile sheet、action menu、safe-area 与 keyboard inset utilities。
2. 重做 app shell：手机默认只显示稿纸，左右工具成为互斥 sheet；定义紧凑 topbar 与 editor-width footer。
3. 打通编辑主链：选章、写作、查找、评论、Copilot/Shadow review、保存与 IME。
4. 为 Graph、Timeline、Plot Planner 设计触摸优先的降维交互，而不是复刻桌面画布。
5. 在至少一台 iPhone 与一台 Android 真机上关闭视觉/触摸/键盘/恢复 acceptance，再扩大移动功能面。

## Acceptance boundary

本文档与静态测试只确认“可以开始开发”的结构前提。除非真实 iOS 与 Android 设备完成手工验收，不得把当前状态描述为 mobile-ready、touch-ready 或 mobile-native UX complete。
