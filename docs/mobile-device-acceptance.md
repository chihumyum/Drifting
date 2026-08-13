# Mobile device acceptance runbook

## Two development entry points

在仓库根目录运行：

```bash
pnpm mobile:ios:dev
pnpm mobile:android:dev
```

仅使用模拟器进行 Agent 前端调试时，改用：

```bash
pnpm mobile:ios:debug -- --device <simulator-udid>
pnpm mobile:android:debug -- --device <emulator-serial>
```

这两个 Debug 入口会同时启动 `pnpm drifting frontend` 的本地观测、输入和证据工具；Android
通过真实 CDP 操作 WebView，iOS 通过明确标记为 `synthetic-dom` 的 DEV-only renderer bridge。
完整命令与安全边界见 [`frontend-debug.md`](frontend-debug.md)。这套工具能验收 DOM/renderer
状态、WebView 级输入、日志、网络摘要和 Simulator 截图，但不能替代本清单中的原生键盘、
安全区、系统弹窗、后台行为、真实多指或真机触摸验收。

两个命令都会调用 Tauri mobile dev 流程：构建原生 debug 包、安装并启动应用，同时保持
Vite/Rust 的开发监听。未指定目标时，Tauri 优先使用已经连接的设备，否则显示可用模拟器供选择。
进程必须保持运行；退出命令会同时结束 dev server。移动入口会从 `5173–5193` 自动选择空闲的
Vite 端口，因此可以和已经占用 `5173` 的桌面开发进程并行运行。

dev 包默认使用 local-only 模式：不要求账号、不启用同步，并让 BYOK AI 直连所选模型提供商。
若显式启用网络服务，脚本不会把 `localhost` 交给真机；它会把检测到或指定的 API origin 精确加入
本次 Tauri dev CSP，并在原生构建前检查该服务是否可访问。

需要联调兼容服务时，先在独立终端启动该服务，再显式关闭 local-only：

```bash
VITE_LOCAL_ONLY_MODE=false \
VITE_API_BASE_URL=http://192.168.1.20:3000 \
API_BASE_URL=http://192.168.1.20:3000 \
pnpm mobile:ios:dev
```

若服务未启动、只监听 loopback 或被防火墙阻断，移动命令会在开始原生构建前给出错误。

## First-time setup

公共前置条件：在仓库根目录完成 `pnpm install`，Rust target 和 Tauri mobile target 已安装。本仓库的
iOS/Android 工程已在 `src-tauri/gen` 初始化，不要重复运行 init 命令。

### iOS

- 安装并启动过 Xcode，在 Xcode 中登录 Apple ID；签名团队应在本机 Xcode 配置，不提交到仓库。
- 模拟器：先在 Xcode 的 Devices and Simulators 中安装所需 runtime。
- 真机：USB 连接 iPhone，信任这台 Mac，开启 Developer Mode；首次运行时允许 Drifting 访问本地网络。
- Mac 与 iPhone 应位于可以互访的同一网络。公司/访客 Wi-Fi 若隔离设备，可改用个人热点或 Xcode 的设备网络地址。

### Android

- 安装 Android Studio、SDK platform、platform tools、emulator 和 NDK。
- 脚本按 `NDK_HOME` → `ANDROID_NDK_HOME` → Android SDK 下最高已安装版本的顺序选择 NDK。
- 模拟器：先在 Android Studio Device Manager 创建并启动 AVD，也可以让 Tauri 的目标菜单选择它。
- 真机：开启 Developer options 与 USB debugging，连接后执行 `adb devices`，确认状态是 `device` 而不是 `unauthorized`。

## Pick a target explicitly

把 Tauri 显示的设备/模拟器名称作为最后一个参数：

```bash
pnpm mobile:ios:dev -- "iPhone 16 Pro"
pnpm mobile:android:dev -- "Pixel_9_API_36"
```

iOS 真机若需要在 Xcode 中处理 signing 或选择设备：

```bash
pnpm mobile:ios:dev -- --open --host
```

Android Studio 对应入口：

```bash
pnpm mobile:android:dev -- --open --host
```

使用 `--open` 时不要结束终端中的 Tauri 进程。Vite 已读取 CLI 提供的 `TAURI_DEV_HOST`，会监听真机
可访问的局域网地址，并把 HMR WebSocket 指回同一地址。

## Override the detected API

脚本通常会优先选择 Wi-Fi 的 `en0` 私网地址。VPN、多网卡或特殊模拟器环境下若选择不正确，可以显式覆盖：

```bash
VITE_API_BASE_URL=http://192.168.1.20:3000 \
API_BASE_URL=http://192.168.1.20:3000 \
VITE_LOCAL_ONLY_MODE=false \
pnpm mobile:ios:dev
```

Android 使用同样写法。不要为真机填 `http://localhost:3000`。如果页面无法连接，先检查两端网络、
macOS 防火墙、server bind address 和手机的本地网络权限。

## Manual acceptance checklist

每个平台至少跑一次模拟器和一次真机；以下结果由人工记录，不能由 build 或静态测试替代：

1. 冷启动能进入登录页；登录、注册、OTP/密码重置入口与键盘收起行为正常。
2. 输入框聚焦时不发生页面缩放；键盘不遮挡当前字段和主操作按钮。富文本进入编辑态时默认只显示圆形样式按钮，点击后展开正文、标题、引用和行内样式，再点同一按钮收起；操作样式时选区与键盘不能丢失。iOS 原生的上一个/下一个/完成表单切换栏不得与 Drifting 附件栏同时出现。
3. 登录后书架能滚动、搜索/筛选；新建和编辑 Sheet 不越过安全区，删除确认可取消。
4. 设置页沿用桌面 Settings 的视觉语言，能从无额外图标的列表进入详情、返回、纵向滚动和保存；header 顶部无异常留白，重启后持久化项仍正确。
5. 旋转、刘海/圆角、Home indicator、Android navigation bar 下没有不可操作的控件。
6. 杀进程后重开、前后台切换、短暂断网恢复时，不出现白屏或重复导航。
7. 打开项目后进入单纸张移动工作区；若持久化会话没有任何已打开 paper，默认先打开项目 Dashboard，而不是擅自进入第一章。正文只有一张完整 paper，桌面左右栏和 tab chrome 不应出现。
8. 上半区双指向内捏合时 paper 向上半区等比缩小、底部工具区从底边连续进入；下半区双指向内捏合时向下半区缩小、顶部结构区从顶边连续进入。普通幅度停靠 panel，继续大幅捏合直接进入 overview。正文单指滚动、选区和输入不能触发缩放；反向外张应回到单纸编辑态。
9. 轻点底部 paper cluster 进入 overview；cluster 必须位于 Home indicator 上方的舒适触控区，普通上下划过不应改变 paper 缩放状态。手指按住 cluster 约 160ms 出现武装反馈；Simulator 鼠标、触控板或外接指针应立即武装，但随后必须进入同一状态机。武装后锁定首次主方向：上下拖动连续预览缩放，panel 边界以手指位移 1:1 跟随，松手按阈值停靠或复位；左右拖动则以约 44px/张在已打开纸张间快速浏览，拖动期间全部保持静态快照，只有松手后选中纸张才挂载并解冻编辑器。缩小态内容仍能滚动、选区与编辑；从当前纸张正文任意位置横滑也必须驱动同一 flex row，不能只依赖左右邻纸露出的边缘。非焦点正文显示冻结的静态正文而不是 summary，横滑松手 `scroll-snap` 到最近页，点按左右邻纸也应直接切换，切回后恢复该 paper 上次的滚动位置。已露出的上下 panel 内按钮、列表和输入必须可以点击；细线边界 handle 应连续调整 panel 高度和 paper 比例，拖动期间不得提前跳成全屏，松手跨过半屏才展平为全屏，反向拖动可收回或关闭。聚焦纸张右上方的悬浮按钮应展开/收起 rail 菜单；菜单必须互斥切换共享 TOC Rail 和 Comment Rail，TOC 的五层结构、当前路径、折叠密度与点击定位完整可用，Comment Rail 的新建、定位原文、解决/重开、转 TODO/转回批注、例外标记、Copilot 接受/拒绝、快照和删除能力不得降级。
10. paper overview 可以激活、关闭、全部关闭，并通过卡片拖动在二维网格中重排所有 paper；关闭按钮位于每张卡片右上角，不能出现上下排序箭头。overview 还能进入三个 Super View、通览全书、设置和书架；从设置返回时恢复原工作区 URL。
11. Super View 内 header 可直接横向切换三个视图，关闭后回到 paper workspace；WebView 本身不应随双指缩放整个页面，元素全景的自有画布应绕双指中点平滑缩放并保持平移；实体打开和共享浮层不得溢出 viewport。
12. 顶部结构区的章节、元素、灵感必须复用桌面面板主体：章节和灵感纵向滚动，元素保持桌面分类/网格能力；点 cell 先出现只读 Sheet，点 backdrop 只关闭且不得穿透。底部工具区以顶部横排 tab 切换 TODO、素材库、统计、Agent、时间线和情节，最右侧是桌面同源用户头像菜单；时间线必须直接复用完整 `BottomTimeline`：书序/叙事切换、幕轨、叙事标记、未归属与未放置、打散、定位、跨故事线连线、缩放、绑定灵感和全部上下文操作都存在，轻点章节打开对应移动纸张，章节触控拖动会写回顺序/主故事线，长按章节、故事线、幕和标记打开与桌面同源菜单。情节网格的输入、行列操作与 TSV 粘贴写入当前 node 的 `plotGridJson`，切纸再返回后仍存在。

自动化说明：macOS UI 自动化可以覆盖登录、书架、项目打开、cluster 轻点、overview、设置和普通按钮/滑动。当前驱动无法向 iPhone Simulator 的 WKWebView 合成可用的拖动序列；需要自动检查底栏时，可在仅供验收的构建中设置 `VITE_MOBILE_SIMULATOR_BOTTOM_PANEL_ACCEPTANCE=true`，让 cluster 轻点直接展开全屏底栏。该默认关闭的开关只提供面板导航入口，不覆盖、不替代 160ms 武装、连续预览或松手阈值验收。Apple Simulator 的宿主拖拽也可能合并中间的 `pointermove`，所以连续动画仍需人工观察。Apple Simulator 的自动化接口不提供可编排的双指触控，因此第 8 项必须在 Simulator 中按住 Option 手工 pinch；单元测试不替代触摸验收。

底栏自动验收构建示例（不得用于发布包）：

```bash
VITE_MOBILE_SIMULATOR_BOTTOM_PANEL_ACCEPTANCE=true \
pnpm tauri ios build --debug --target aarch64-sim --no-sign --archive-only --ci
```

## 2026-08-13 iOS Simulator spot check

本轮按任务要求只使用 `iPhone 17 Pro / iOS 26.1` Simulator，不使用真机。当前 checkout 已完成：dev 包构建、安装与启动；清空项目纸张会话后再次进入项目会打开 Dashboard；Dashboard 和正文避开顶部状态栏；轻点 paper cluster 可以进入 overview；普通按钮导航可以从 Dashboard 进入正文。富文本聚焦后已验证圆形样式按钮、展开/收起，以及执行粗体时键盘和编辑焦点保持；重新构建并安装 iOS archive 后，又分别聚焦登录页邮箱和密码输入框，确认原生上一个/下一个/完成表单导航栏均不再出现，系统 `Passwords` 自动填充建议保持可用。另用 local-only QA 章节验证了 46px 浮动按钮、同一按钮展开/收起、TOC/Comment 互斥切换、H1/H2/H3 目录触控定位、锚定与实体评论、触控原文高亮、转 TODO/转回、键盘 `visualViewport` 跟随、Rail 打开时 paper cluster 让位，以及 Comment 展开时按钮移到对侧；删除、Copilot 接受/拒绝等破坏性或需要 Provider 的操作未在这份 fixture 中逐项执行，但仍复用共享 Comment Rail 路径并由静态契约覆盖。

同日又用上述默认关闭的底栏验收开关重建并安装 archive，在 Simulator 专用数据库中补入 6 章、2 条故事线和一条跨故事线关系。全屏底栏实际显示并可点击 `书序/叙事`、2 个幕、`Start` 时间标记、主线/回声线/未归属 3 条 lane、未放置计数、跨故事线虚线、打散和定位；`显示/隐藏未归属` 可切换，打散会把重叠章节横向展开，定位会把当前章节滚入视口，点按 `独行` 会将该移动纸张设为当前项。`Start` 标记和第二幕均通过时间线 UI 创建并持久化，fixture 其余章节和故事线仅写入 Simulator 本地数据库，不进入仓库或用户正式数据。长按菜单、章节触控拖动写回、cluster/pinch 连续动画及本轮新增的长按横向快速切纸仍受上述 Simulator 自动化限制；这些部分当前只有状态机、共享 use case 和源码交互契约证据，不能记录为手工触控验收通过。

## Historical Simulator evidence

2026-08-08 曾在 `iPhone 17 Pro / iOS 26.1` Simulator 上通过当时版本的登录、
书架、工作区、overview、panel、Super View、设置和返回链路。该记录早于当前
Sheet、gesture、paper row、scroll restoration、pinch 和 canvas 改造，只能证明
旧 checkout 的主链路，不能关闭当前清单中的任何真机或新交互项目。完整原始记录
保留在 Git 历史中。

调试 WebView：iOS 使用 Safari 的 Develop 菜单（真机还需启用 Web Inspector）；Android 在 Chrome
打开 `chrome://inspect`，选择 `cc.drifting.client` 对应的 WebView。

完成清单前，只能表述为“dev 包已安装/启动”或“某项手工验收通过”，不能表述为移动端整体已验收。
