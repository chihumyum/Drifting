# Mobile device acceptance runbook

## Two development entry points

在仓库根目录运行：

```bash
pnpm mobile:ios:dev
pnpm mobile:android:dev
```

两个命令都会调用 Tauri mobile dev 流程：构建原生 debug 包、安装并启动应用，同时保持
Vite/Rust 的开发监听。未指定目标时，Tauri 优先使用已经连接的设备，否则显示可用模拟器供选择。
进程必须保持运行；退出命令会同时结束 dev server。移动入口会从 `5173–5193` 自动选择空闲的
Vite 端口，因此可以和已经占用 `5173` 的桌面开发进程并行运行。

dev 包默认连接 Mac 局域网 IPv4 地址上的本地后端，例如 `http://192.168.31.28:3000`，并启用正常认证和
proxy AI transport。脚本不会把 `localhost` 交给真机；它会把检测到的 API origin 精确加入本次 Tauri
dev CSP，并在原生构建前检查本地后端是否可访问。若调用前已经显式设置同名环境变量，脚本会保留你的值。

先在一个独立终端启动本地数据库与 Server，并保持进程运行：

```bash
pnpm server:up
```

再在第二个终端运行 iOS 或 Android dev 命令。若 3000 端口未启动、只监听 loopback 或被防火墙阻断，
移动命令会在开始原生构建前给出错误。

## First-time setup

公共前置条件：在仓库根目录完成 `pnpm install`，Rust target 和 Tauri mobile target 已安装。本仓库的
iOS/Android 工程已在 `src-tauri/gen` 初始化，不要重复运行 init 命令。

### iOS

- 安装并启动过 Xcode，在 Xcode 中登录 Apple ID；Tauri 源配置和生成的 Xcode 工程已有 development team 配置。
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
pnpm mobile:ios:dev
```

Android 使用同样写法。不要为真机填 `http://localhost:3000`。如果页面无法连接，先检查两端网络、
macOS 防火墙、server bind address 和手机的本地网络权限。

## Manual acceptance checklist

每个平台至少跑一次模拟器和一次真机；以下结果由人工记录，不能由 build 或静态测试替代：

1. 冷启动能进入登录页；登录、注册、OTP/密码重置入口与键盘收起行为正常。
2. 输入框聚焦时不发生页面缩放；键盘不遮挡当前字段和主操作按钮。
3. 登录后书架能滚动、搜索/筛选；新建和编辑 Sheet 不越过安全区，删除确认可取消。
4. 设置页沿用桌面 Settings 的视觉语言，能从无额外图标的列表进入详情、返回、纵向滚动和保存；header 顶部无异常留白，重启后持久化项仍正确。
5. 旋转、刘海/圆角、Home indicator、Android navigation bar 下没有不可操作的控件。
6. 杀进程后重开、前后台切换、短暂断网恢复时，不出现白屏或重复导航。
7. 打开项目后进入单纸张移动工作区；正文只有一张完整 paper，桌面左右栏和 tab chrome 不应出现。
8. 上半区双指向内捏合时 paper 向上半区等比缩小、底部工具区从底边连续进入；下半区双指向内捏合时向下半区缩小、顶部结构区从顶边连续进入。普通幅度停靠 panel，继续大幅捏合直接进入 overview。正文单指滚动、选区和输入不能触发缩放；反向外张应回到单纸编辑态。
9. 轻点底部 paper cluster 进入 overview；普通上下划过不应改变 paper 缩放状态。按住 cluster 约 280ms 出现武装反馈后，再上下拖动才能连续预览缩放，松手按阈值停靠或复位。缩小态内容仍能滚动、选区与编辑；横滑时同一 flex row 内的全部可见 paper 同步移动，松手 `scroll-snap` 到最近页，切回后恢复该 paper 上次的滚动位置。上下 panel 的细线边界 handle 应连续调整 panel 高度和 paper 比例，跨过半屏立即展平为全屏，反向拖动可收回或关闭。
10. paper overview 可以激活、关闭、全部关闭，并通过卡片拖动在二维网格中重排所有 paper；关闭按钮位于每张卡片右上角，不能出现上下排序箭头。overview 还能进入三个 Super View、通览全书、设置和书架；从设置返回时恢复原工作区 URL。
11. Super View 内 header 可直接横向切换三个视图，关闭后回到 paper workspace；WebView 本身不应随双指缩放整个页面，元素全景的自有画布应绕双指中点平滑缩放并保持平移；实体打开和共享浮层不得溢出 viewport。
12. 顶部结构区的章节、元素、灵感必须复用桌面面板主体：章节和灵感纵向滚动，元素保持桌面分类/网格能力；点 cell 先出现只读 Sheet，点 backdrop 只关闭且不得穿透。底部工具区以顶部横排 tab 切换 TODO、素材库、统计、Agent、时间线和情节，最右侧是桌面同源用户头像菜单；时间线可切书序/叙序，情节网格的输入、行列操作与 TSV 粘贴写入当前 node 的 `plotGridJson`，切纸再返回后仍存在。

自动化说明：macOS UI 自动化可以覆盖登录、书架、项目打开、cluster 轻点、overview、设置和普通按钮/滑动。Apple Simulator 的宿主拖拽在 WebView 中可能合并中间的 `pointermove`；cluster 以 `pointerup` 最终位移为提交依据，纯状态机测试覆盖方向、阈值和收回逻辑，但仍需手工拖动确认连续动画。Apple Simulator 的自动化接口不提供可编排的双指触控，因此第 8 项必须在 Simulator 中按住 Option 手工 pinch，或使用真机验收；单元测试不替代触摸验收。

## Historical Simulator evidence

2026-08-08 曾在 `iPhone 17 Pro / iOS 26.1` Simulator 上通过当时版本的登录、
书架、工作区、overview、panel、Super View、设置和返回链路。该记录早于当前
Sheet、gesture、paper row、scroll restoration、pinch 和 canvas 改造，只能证明
旧 checkout 的主链路，不能关闭当前清单中的任何真机或新交互项目。完整原始记录
保留在 Git 历史中。

调试 WebView：iOS 使用 Safari 的 Develop 菜单（真机还需启用 Web Inspector）；Android 在 Chrome
打开 `chrome://inspect`，选择 `cc.drifting.client` 对应的 WebView。

完成清单前，只能表述为“dev 包已安装/启动”或“某项手工验收通过”，不能表述为移动端整体已验收。
