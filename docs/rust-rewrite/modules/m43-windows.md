# M43 Windows 版（补齐）

**交回状态**：已完成（2026-11-09，分支 `codex/track4-account-sync`）。

在 F7 已有 Windows 平台底座（NSIS 安装器、Credential Manager 分片钥匙串、深链接、单实例命名管道、自动更新交接）的基础上，补齐 Windows 通知区驻留与菜单、arm64 安装包与 CI 矩阵、Windows 字体回退顺序，以及供作者在 Windows 11（含 ARM 虚拟机）逐项执行的实机验收清单。

## 实现概览

### 1. 通知区驻留与唤醒（`next/crates/dr-platform/src/tray.rs`）

- **菜单文案校验与多语言（`TrayLabels`、`valid_label`）**：
  - 沿用旧版 `src-tauri/src/windows_tray.rs` 的规则：单行、非空、不超过 80 个字符（`MAX_LABEL_CHARS = 80`）、不含任何控制字符。
  - `TrayLabels::for_locale` 内置全部九种界面语言的「打开 Drifting」与「退出 Drifting」默认文案（如简体中文 `打开 Drifting` / `退出 Drifting`、繁体中文 `打開 Drifting` / `結束 Drifting`、英文 `Open Drifting` / `Quit Drifting` 等），并支持在界面语言切换时通过 `TrayController::set_labels` 动态更新。
- **关窗与唤醒状态机（`TrayState`、`WindowCloseDecision`、`TrayCommand`）**：
  - 点窗口关闭，不管窗口里是一本书还是全部项目，在 Windows 下都返回 `WindowCloseDecision::HideToTray`：刷盘后把主窗口原样藏进通知区，叫回来还是藏起来时的样子，后台 Agent 任务、Hosted 同步和本地 MCP 桥接继续运行。作者 2026-11-20 定（「都按照你的推荐来」）：和 macOS 2026-11-14 起红灯直接关窗一个意思；原先「开着书时先回全部项目、再点一次才收进通知区」那一步去掉了，`WindowCloseContext` 和 `ReturnToShelf` 随之删除；
  - 没有通知区图标时（见下一条）返回 `WindowCloseDecision::QuitProcess`，经刷新屏障落盘后退出；
  - 左键单击通知区图标（`on_left_click`）、点击右键菜单「打开 Drifting」（`on_menu_open`）、或第二次启动把参数经命名管道转交过来（`on_second_instance_launch` / `notify_second_instance`）走同一条 `TrayCommand::RestoreWindow` 路径把窗口叫回前台；
  - 点击右键菜单「退出 Drifting」（`on_menu_quit`）发出 `TrayCommand::QuitApp` 并把状态置为 `quitting`，经刷新屏障落盘后退出进程。
- **Win32 原生通知区实现与无任务栏降级（`#[cfg(windows)] mod windows_impl`）**：
  - 直接使用工作区已锁定的 `windows 0.62`（`Win32_UI_Shell`、`Win32_UI_WindowsAndMessaging`、`Win32_System_LibraryLoader`），不向 `Cargo.lock` 引入额外第三方 crate；
  - 在 GPUI 跑 Win32 消息循环的主线程上创建不显示的顶层隐藏窗口（既接收 `Shell_NotifyIconW` 回调，也接收 Explorer 广播的 `TaskbarCreated`），并调用 `Shell_NotifyIconW(NIM_ADD)` 注册通知区图标；
  - 当会话不存在 Explorer 通知区（如无头 `windows-arm64` CI、Server Core 或 Explorer 尚未启动）导致 `NIM_ADD` 返回 `FALSE` 时，`TrayController::install` 仍保留隐藏消息窗口并将 `has_notification_icon()` 置为 `false`：此时关窗退化为 `WindowCloseDecision::QuitProcess`（经刷新屏障正常退出，绝不把窗口藏进无法唤回的不可见状态），待 Explorer 广播 `TaskbarCreated` 后自动补注册图标并恢复 `HideToTray`。收到 `TaskbarCreated` 时先 `NIM_DELETE` 再 `NIM_ADD`：这条广播也会发给图标还在的窗口，不先删的话重复注册会失败，被当成「没有通知区」，下一次在全部项目页关窗就变成退出；
  - 窗口过程处理 `WM_LBUTTONUP`（左键唤醒）、`WM_RBUTTONUP` / `WM_CONTEXTMENU`（按当前语言弹出两项菜单）、`WM_COMMAND`（打开 / 退出）与 `TaskbarCreated`，将命令推入 `TrayController` 队列并触发主线程 `waker`；析构时仅在图标已注册时调用 `Shell_NotifyIconW(NIM_DELETE)`，随后 `DestroyWindow` 清理句柄。

### 2. arm64 安装包、内置字体打包与 CI（`next/script/`、`.github/workflows/next.yml`）

- **`next/script/bundle-windows.ps1` 与 `next/script/windows/drifting.nsi`**：
  - 支持 `-Target x86_64-pc-windows-msvc`（产物后缀 `_windows_x64-setup.exe`）与 `-Target aarch64-pc-windows-msvc`（产物后缀 `_windows_arm64-setup.exe`），以及未传 `-Target` 时按构建机 `PROCESSOR_ARCHITECTURE` 自动识别 `x64` / `arm64`。
  - 自动检测 `DRIFTING_FONTS_DIR` 或 `next/.cache/fonts` 下的 6 个内置字面与 `OFL-1.1.txt`，传入 `/DFONTS_DIR` 由 NSIS 安装到 `$INSTDIR\fonts\`（与 `dr_ui::fonts::candidates()` 在 Windows 安装包下查找 `exe_dir.join("fonts")` 的路径对齐），卸载时一并清理 `$INSTDIR\fonts`。
- **`next/script/check-windows-installer.ps1` 与 `.github/workflows/next.yml`**：
  - `check-windows-installer.ps1` 新增可选 `-Target` 参数，校验生成的安装包架构后缀与内置字体文件安装／卸载；
  - `.github/workflows/next.yml` 矩阵拆分为 `macos`（`macos-26`）、`windows-x64`（`windows-latest`，`x86_64-pc-windows-msvc`）和 `windows-arm64`（`windows-11-arm`，`aarch64-pc-windows-msvc`），在两台 Windows 构建机上分别构建对应架构的 NSIS 安装包并完整跑一遍静默安装、`/P /UPDATE` 原地升级、自定义目录安装与卸载检查。
  - 2026-11-20（F7 第五轮）：`next.yml` 在格式检查、Clippy、测试之前就打开发身份的安装包（`bundle-windows.ps1 -BuildProfile debug`，构建机自己的架构）并作为运行产物上传，名字是 `drifting-next-windows-arm64-<提交号前 8 位>`、`drifting-next-windows-x64-<…>`（macOS 的 `.dmg` 是 `drifting-next-macos-<…>`），留 7 天，传完就能下，不用等两个小时的测试。下面的清单用的就是它。

### 3. Windows 字体回退顺序（`next/crates/dr-platform/src/fonts.rs`）

- 照 `docs/windows.md` 定义四类排版角色（`FontRole::{Ui, Structure, Prose, Index}`）在 Windows 与 macOS 上的字体栈与回退顺序：
  - **正文与结构衬线（`Prose` / `Structure`）**：`Drifting Serif` → `Noto Serif SC` → `Songti SC` → `SimSun` → `Microsoft YaHei`。确保缺字时优先回退到自带的 `Noto Serif SC`，而不是直接退到点阵感明显的 `SimSun`（宋体），仅当罕见扩展汉字不在 `Noto Serif SC` 中时才由 `SimSun` 兜底。
  - **界面无衬线（`Ui`）**：`Drifting Sans` → `Noto Sans SC` → `Microsoft YaHei UI` → `Microsoft YaHei` → `Segoe UI` → `SimHei`，系统无衬线显式指向微软雅黑，且绝不回退到 `SimSun`。
  - **索引等宽（`Index`）**：`Sarasa Mono SC` → `Cascadia Mono` → `Consolas` → `Microsoft YaHei UI` → `Microsoft YaHei`。

## 第一次在干净的 Windows 上装和启动（2026-11-21）

监管会话在作者的 Windows 11 ARM 虚拟机（Parallels，系统版本 10.0.26300，没装过 Visual C++ 运行库，旁边装着 0.1.0-alpha.12）里做的，用的是 `next` 工作流第一次上传的 ARM64 安装包（提交 `bd87aed4`，debug 构建）。命令从 Mac 上用 `prlctl exec --current-user` 发进去，窗口靠虚拟机截屏看。这是新版第一次在真的 Windows 上启动。

### 查到的问题

| # | 现象 | 原因 | 怎么处理 |
| --- | --- | --- | --- |
| 1 | **程序起不来**，没有窗口、没有日志，退出码 `0xC0000135` | `drifting.exe` 动态链接 `VCRUNTIME140.dll`，干净的 Windows 没有这个库。CI 的机器自带，所以一直是绿的。0.1 没这个问题（Tauri 静态链接） | `next/.cargo/config.toml` 让 Windows 静态链接 C 运行库（Zed、Tauri 都这么做）；新脚本 `script/check-windows-standalone.ps1` 读程序的导入表，有 VC++ 运行库就失败，`next.yml` 和发布工作流草稿都跑它 |
| 2 | 补上运行库以后启动就 panic：`failed to initialize DirectX … (os error 3)` | 只有 debug 构建会这样：GPUI 的 Windows 后端开着调试断言时，启动时从**构建机上的源码路径**读着色器源码现编，换一台机器路径不存在。优化构建把着色器预编进程序里，不受影响 | 给验收用的 Windows 安装包改成 `dist` 档（和正式发布同一档），单独一个任务 `windows-installer` 打，装上、启动一遍再上传；debug 的那份不再上传 |
| 3 | 从通知区唤回、第二次启动、深链接唤起时，日志里每次几条 `RefCell already borrowed`（GPUI 的 `window.rs`） | `dr-platform` 的托盘代码在 GPUI 的一次更新里同步调 `ShowWindow`、`SetForegroundWindow`，系统当场把激活、显示这些消息送回窗口过程，GPUI 这时拿不到自己的状态，只能把这一刻的回调丢掉 | 改成 `ShowWindowAsync`（GPUI 自己的 `activate` 也是这么做的），前置交给调用处本来就有的 `Window::activate_window`。交叉 Clippy 过了，**没在 Windows 上重验** |
| 4 | 下面清单第五节第 1 条要找的日志行 `dr-ui fonts from …` 不存在 | 日志文件里没有这一行，macOS 的日志文件里也没有 | 那一条改成看窗口里的字 |

为了当天接着往下验，在虚拟机里临时做了两件事（都不是修复）：把 Edge 自带的 ARM64 `vcruntime140.dll` 拷到安装目录里；把 GPUI 的三个着色器源文件放到程序要找的那个路径上。装修好的包之前要先清掉。

### 验过的（在上面两处临时处理之后）

| 项 | 结果 |
| --- | --- |
| 静默安装（`/S`），没提权的普通用户 | 过，退出码 0。第一次用了 199 秒，之后原地更新 35 秒 |
| 安装目录里的 `drifting.exe`、`uninstall.exe`、6 个字体和 `OFL-1.1.txt`，开始菜单快捷方式，「已安装的应用」里的条目，厂商键，`drifting-next-dev` 协议键 | 全对（清单第一节第 2、3 条） |
| 旁边的 0.1 | 没动：「已安装的应用」里还是 `Drifting 0.1.0-alpha.12`，`cc.drifting.client` 里最新的文件还是两天前的 |
| 启动 | 窗口出来了：字海、首次引导的卡片、左上角的窗口按钮药丸、语言下拉都画出来；数据在 `%LOCALAPPDATA%\cc.drifting.next.dev`，样书写进去了 |
| 单实例（第二节第 1 条） | 过：第二个进程自己退出（退出码 0），还是一个进程，窗口到最前 |
| 深链接（第二节第 3 条） | 过：送到了运行着的那个进程，日志只记「收到 1 条」，不记参数 |
| 关窗收进通知区、再启动唤回（第二节第 2 条、第四节第 1 条的一半） | 过：关窗后进程还在、窗口不可见；再启动一次窗口回来并在最前。通知区图标本身没法用脚本看 |
| 程序开着时原地更新（`/P /UPDATE`，第一节第 4 条） | 过：35 秒，旧进程被结束，开始菜单和桌面快捷方式都在 |

### 修好的包重验（同一天，提交 `9163529b`）

`windows-installer` 任务第一次跑就出了包（ARM64 的 `dist` 构建，安装包 58.6 MiB，程序 104.5 MB）。

- **CI 的机器上**（windows-11-arm）：装上以后导入表里没有 VC++ 运行库（34 个库），程序启动，30 秒后窗口还在。所以这一步从「只对加载失败报错」收紧成了「30 秒内退出就失败」。
- **作者的虚拟机上**：先清掉上面两处临时处理（安装目录里的 `vcruntime140.dll`、照构建机的路径放的着色器源码；`System32` 里确实没有这个库），再装新包：
  - 静默安装 22 秒（debug 包第一次是 199 秒）。
  - **什么都不加就能启动**，窗口出来，日志里没有错误。
  - 关窗收进通知区、再启动唤回、深链接唤起：都对，窗口回到最前；日志里 `RefCell already borrowed` 这次是 **0 条**（上一轮每次唤回 1 到 5 条）。
- 新版留在虚拟机里（开发身份，装在 0.1 旁边），等作者点下面这些。
- 2026-11-21 早上又装了一次 `main` 的 `c07480863`（CI 的 arm64 `dist` 安装包；多了 HEIC / AVIF 的 WIC 解码、0.1 设置带过来、导入的默认处理等）：在上一版上面静默安装 54 秒，启动后回到上次那本书（《阿Q正传（示例）》的作品主页），画面正常；没试 HEIC / AVIF 图片本身。看到两处观感上的事，留给作者看 Windows 时定：泳道名在 Windows 上是斜的（代码里给了斜体，Windows 给没有斜体字形的字合成了一个，macOS 不合成，所以 Mac 上一直是正的；标签页的「预览」斜体同理）；时间钉挨得近时标签叠在一起（两个平台都这样，示例书的第一屏就能看到；当天改成到下一枚钉就用省略号收住，这个安装包里还没有）。

- 2026-11-21 下午装了 `main` 的 `30cb94dfa`（CI 的 arm64 `dist` 安装包，在上一版上面静默安装 20 秒），看「资料库打不开」那一页：先把开发版的测试资料库三个文件备份，把数据库换成一小段文字，启动。窗口整页是「没能打开资料库」「资料库没有改动。」「资料库文件已损坏，请提交反馈，先别删这个文件夹。」，按钮是「在文件资源管理器中打开」「提交反馈」「退出 Drifting」，窗口自己的三颗按钮在左上角，画面正常；那个文字文件应用一个字节没动。看完把三个文件原样放回（哈希和备份时一样）、删掉备份，再启动回到《阿Q正传（示例）》的作品主页。同一次看到时间钉的标签已经是省略号、不再叠字。没点的：这一页上的三颗按钮（「在文件资源管理器中打开」会在作者的桌面上开窗口）。

### 还要作者在虚拟机里点的

新的包（2026-11-21 下午的 `30cb94dfa`）已经装在虚拟机里（开始菜单里的 Drifting Next）：双击安装时不弹 UAC、安装界面的语言；通知区图标、左键和菜单、菜单语言、「退出」；微软拼音打字；凭据管理器；字体和整体观感。卸载、从 0.1 原位升级（第一节第 5、6 条）也还没做。

## Windows 实机／虚拟机验收清单

供作者在 Windows 11（含 Apple Silicon 上的 Windows 11 ARM 虚拟机或 x64 实机）上按步骤点验。**`0.2.0` macOS 和 Windows 一起发（作者 2026-11-20 定），这份清单挡发布。** 开发身份的安装包从 GitHub 上 `next` 工作流那次运行的产物里下（`windows-installer` 任务打的 `drifting-next-windows-arm64-<提交号>`，解压出 `Drifting_Next_<version>_windows_arm64-setup.exe`；`dist` 档，和正式发布同一档）；第一节最后一条要正式身份的安装包，见那一条。

### 一、安装器与升级（x64 与 arm64）
1. **首次普通用户安装**：双击 `Drifting_Next_<version>_windows_arm64-setup.exe`（ARM 虚拟机）或 `x64-setup.exe`（x64 机器），确认无需管理员权限（不弹 UAC），界面语言随系统显示简体中文或英文。
2. **安装目录与字体文件**：安装完成后检查 `%LOCALAPPDATA%\Drifting Next\` 下有 `drifting.exe`、`uninstall.exe` 以及 `fonts\` 目录（内含 6 个 `.ttf` 字体文件与 `OFL-1.1.txt`），开始菜单已生成 `Drifting Next` 快捷方式。
3. **注册表与卸载项**：在「设置 › 应用 › 已安装的应用」能看到 `Drifting Next`；注册表 `HKCU\Software\drifting\Drifting Next` 记录了安装目录，`HKCU\Software\Classes\drifting-next-dev\shell\open\command` 指向 `"%LOCALAPPDATA%\Drifting Next\drifting.exe" "%1"`。
4. **原地更新保留快捷方式**：在 PowerShell 运行 `.\Drifting_Next_<version>_windows_<arch>-setup.exe /P /UPDATE`，确认只显示进度条、自动覆盖可执行文件，且不重置已有快捷方式。
5. **卸载保留作者数据**：运行 `%LOCALAPPDATA%\Drifting Next\uninstall.exe`，确认程序目录、开始菜单快捷方式和注册表协议键被清理，但 `%LOCALAPPDATA%\cc.drifting.next.dev\` 下的书库与日志完好保留。
6. **从 0.1 最后一版原位升级到 `0.2.0`，书库和登录都还在**（要正式身份的安装包 `Drifting_0.2.0_windows_arm64-setup.exe`：发布工作流草稿里的，或私有测试仓库跑出来的；会读写这台虚拟机上正式版 Drifting 的数据，先拍快照，别在日常用的 Windows 上做）：
   - 先装 0.1 最后一版（现在是 `0.1.0-alpha.12` 的 `Drifting_0.1.0-alpha.12_windows_arm64-setup.exe`），新建一本书写几段字、登录 Hosted 账号、在设置里存一个测试 API Key，把开始菜单里的 Drifting 固定到「开始」，然后关掉；
   - 运行 `0.2.0` 的安装包升级（和 0.1 更新器一样的参数：`.\Drifting_0.2.0_windows_arm64-setup.exe /P /R /UPDATE`；草稿 Publish 之后也可以在 0.1 的「设置 › 更新」里点「安装并重启」，走真正的自动更新）；
   - 确认：装进的还是 `%LOCALAPPDATA%\Drifting\`，「已安装的应用」里只有一个 Drifting、版本 `0.2.0`；开始菜单的固定还在；升级完新版自己打开；
   - 新版里：「导入 · Drifting 0.1」找得到那本书，导入后字一个不少；不用重新登录；API Key 还在（设置里显示已保存）；在浏览器里打开一个 `drifting://` 链接会跳进新版；
   - 数据文件夹：`%LOCALAPPDATA%\cc.drifting.client\` 里 0.1 的 `libraries.json`、`databases\`、`libraries\` 修改时间没变；新版的书库和设置在 `%LOCALAPPDATA%\cc.drifting.client.v2\`。

### 二、单实例与深链接（`single_instance` + `deep_link`）
1. **单实例唤醒**：先启动 `Drifting Next`，再在终端运行一次 `%LOCALAPPDATA%\Drifting Next\drifting.exe`，确认第二个进程立即退出，不会开出第二个窗口，且已运行的窗口被切到前台。
2. **关窗收进通知区后再次启动唤醒**：点左上角关闭按钮让窗口收进通知区（在书里、在全部项目里都一样），再从开始菜单或终端启动一次 `Drifting Next`，确认收起的主窗口立即恢复显示并获得焦点，还是收起前那一页。
3. **协议深链接唤醒与投递**：在 `Win + R` 或浏览器地址栏输入 `drifting-next-dev://auth/callback?nativeState=test-state&handoff=test-code`，确认运行中的（或隐藏在通知区的）`Drifting Next` 被唤起并收到该深链接，日志中不打印完整敏感参数。

### 三、Windows 凭据管理器钥匙串（`secrets`）
1. **短密钥持久化**：打开「设置 › 模型」，填入一段测试用 DeepSeek API Key 并保存；打开 Windows「凭据管理器 › Windows 凭据」，确认存在 `cc.drifting.next.dev` 相关条目；完全退出并重开应用，确认密钥仍在。
2. **超长令牌自动分片读写（> 1200 字符）**：登录 Hosted 账号或使用超过 1200 字符的会话令牌后，在「凭据管理器」中确认生成了带分片头（含代数、分片数与 SHA-256）和多条分片凭据；完全退出并重开应用，确认登录态自动恢复且不会回退写明文文件。

### 四、通知区（系统托盘）
1. **点关闭一次就收进通知区**（作者 2026-11-20 定）：
   - 打开任意一本书进入条目页，点窗口左上角关闭按钮：确认窗口直接原样收起（不先退回全部项目），任务栏通知区（Windows 11 首次可能在 `^` 溢出面板中）留有 `Drifting Next` 图标，后台同步与本地 MCP 桥接继续工作；叫回来还是那本书的那一页；
   - 在全部项目页点关闭：同样收进通知区；
   - 没有通知区图标的会话（比如没有任务栏的环境）里点关闭：保存后退出，不会藏成叫不回来的窗口。
2. **左键单击与菜单「打开」恢复**：
   - 左键单击通知区图标：主窗口恢复显示并聚焦；
   - 再点一次关闭收进通知区，右键通知区图标点「打开 Drifting」：主窗口同样恢复显示。
3. **菜单语言跟随界面语言**：在「设置 › 语言」把界面语言在简体中文、英文、日文之间切换，右键通知区图标，确认两项菜单文案随之变为对应语言的「打开 Drifting / 退出 Drifting」。
4. **菜单「退出」真正结束进程**：右键通知区图标点「退出 Drifting」，确认本地修改保存完毕后进程完全退出，通知区图标消失，任务管理器中不再有 `drifting.exe`。

### 五、字体与排版回退
1. **内置字体加载**：（日志文件里没有 `dr-ui fonts from ...` 这一行，两个平台都没有，别找它；字体缺了程序会直接退出。）看窗口里的字：界面无衬线（`Drifting Sans`）、正文衬线（`Drifting Serif`）和统计数字等宽字体（`Sarasa Mono SC`）与 macOS 视觉一致。
2. **中文正文与罕见字回退**：在正文中输入常规简体中文、拉丁斜体与粗体，以及罕见扩展汉字，确认常规中文与标点使用 `Drifting Serif` / `Noto Serif SC` 渲染（不退化为点阵宋体 `SimSun`），界面控件回退使用 `Microsoft YaHei` 而不混入宋体。

### 六、联网跟着系统代理走（2026-11-24 NP 加的）

新版从这一版起读 Internet 选项里的代理（[F7「第六轮」](../foundations/f7-platform.md#第六轮联网跟着系统代理走np2026-11-24)）。自动测试只走了代理环境变量那条路，读系统设置的那一段两个平台都没在测试里碰过，Windows 上只交叉编译过。

1. **开着系统代理时走代理**：在「设置 › 网络和 Internet › 代理 › 手动设置代理」里填一个代理（虚拟机里可以用宿主机上的代理软件，比如 `<宿主机地址>:7890`），从开始菜单打开 `Drifting Next`（不要从终端打开：终端可能带着代理变量），登录、同步一次；在代理软件的连接记录里能看到去 Hosted 服务的连接。
2. **例外和本机照旧直连**：在代理设置的例外里写上 Hosted 服务的域名，再同步一次，代理软件里不再出现那个域名（「请勿将代理服务器用于本地地址」那一格读不到，不用测）；本机或局域网的模型服务（「设置 › 模型 › 本地模型」填 `localhost` 或局域网地址）不管怎么设都连得上，代理软件里没有它。
3. **关掉系统代理不用重启**：关掉手动代理，不重启 App 再同步一次，连接不再经过代理软件。

## 测试与检查

- `CARGO_BUILD_JOBS=3 cargo test -p dr-platform --locked`：通过（含新增的 `tray::tests` 3 项与 `fonts::tests` 3 项）。
- `CARGO_BUILD_JOBS=3 cargo clippy -p dr-platform --no-default-features --target x86_64-pc-windows-msvc --locked -- -D warnings`：在 macOS 上对 Windows x64 目标交叉类型检查与 Clippy 零警告通过（覆盖 `#[cfg(windows)]` 下的 Win32 `Shell_NotifyIconW`、隐藏消息窗口与右键弹出菜单实现）。
- 2026-11-11 Windows 编译修复与全工作区交叉排查：`dr-ui/src/components/color.rs` 的 `#[cfg(windows)] mod system::pick` 改用 `cx.background_executor().spawn(...)`（钉选 GPUI `v1.27.0` 的 `gpui::App` 无 `background_spawn`）；`spikes/prose-spike` 将 `libc`、`objc2`、`raw-window-handle` 移入 `[target.'cfg(target_os = "macos")'.dependencies]` 并为 `src/bin/prose-spike` 加 `#[cfg(target_os = "macos")]` 守卫，使 `--target x86_64-pc-windows-msvc` 依赖图彻底不含 `objc2`／Apple 框架。macOS 本机在不安装 MSVC／Windows SDK／`llvm-rc` 的前提下运行 `cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc --locked --keep-going -- -D warnings`，纯 Rust 成员（`dr-model`、`prose-metrics`、`prose-linebreak`、`gpui-ime`、`dr-debug-protocol`、`dr-corpus`、`dr-platform --no-default-features`）零警告通过，仅剩 5 个第三方原生 C／汇编／RC 构建脚本依赖 Windows 工具链（`stacker`、`psm`、`libsqlite3-sys`、`ring`、`gpui` 的 `embed-resource`/`llvm-rc`），待推送后由 GitHub Actions Windows runner 跑完。

## 交回

- **包含段落**：M43 Windows 补齐（`dr-platform::tray` 通知区驻留／菜单／单实例唤醒、`dr-platform::fonts` Windows 字体回退顺序、`bundle-windows.ps1` + `drifting.nsi` + `check-windows-installer.ps1` + `.github/workflows/next.yml` 的 arm64 安装包与内置字体打包、Windows 实机／虚拟机验收清单）。连同已就绪的 M37 偏好同步与 M36 同步 v2 一起交回。
- **改动 `dr-shell`、`dr-view-shelf`、`dr-ui` 的地方**：**无**（`git diff main -- next/crates/dr-shell next/crates/dr-view-shelf next/crates/dr-ui` 为空；严格遵守当时的分轨文档 `handoff/overnight.md` 与 `handoff/kernel-v3-split.md`（都已随过程文档清理删除，在 git 历史里）的分轨范围，外壳与 `dr-ui` 的两处极小挂接点列于下方「待协调」）。
- **全套检查结果**：
  - `cargo fmt --all --check`：通过
  - `CARGO_BUILD_JOBS=3 cargo clippy --workspace --all-targets --locked -- -D warnings`：通过
  - `CARGO_BUILD_JOBS=3 cargo clippy -p dr-platform --no-default-features --target x86_64-pc-windows-msvc --locked -- -D warnings`：通过
  - `CARGO_BUILD_JOBS=3 cargo test --workspace --locked`：通过
  - `CARGO_BUILD_JOBS=3 cargo xtask check`：通过
  - `pnpm public:check` 与 `pnpm ci:contract:check`：通过
- **待协调**：见下节。

## 待协调（2026-11-19 合流收口）

1. ~~**外壳窗口关闭与托盘命令挂接（F6 `dr-shell`）**~~：**已接通（2026-11-19）**。新增 `dr_shell::tray`，在 `app/drifting/src/main.rs` 启动进入 `app.run` 后（确保先完成 GPUI 的 Win32 DPI 感知初始化）调用 `TrayController::install(platform, TrayLabels::for_locale(locale.code()))` 与 `dr_shell::tray::install`，将 `single_instance` 第二实例回调接到 `tray.notify_second_instance()`，在 `Workspace::should_close_window` 中按 `HideToTray`（Win32 `ShowWindow(SW_HIDE)`，保留后台 Agent、Hosted 同步与本地 MCP） / `QuitProcess` 处理关闭请求（macOS 关窗与 `--features debug-bridge` / `VisualTestContext` 行为保持不变），并在 `Settings` 语言切换时自动调用 `dr_shell::tray::sync_locale` 更新通知区菜单文案。永久回归见 `dr-platform` 的 `tray::tests` 与 `dr-shell/tests/tray.rs`。第二个实例在控制器装好之前到来时先记下、装好后补发；记下和装好在同一把锁里，不会丢在两步之间。
   - **只在 CI 上编译过的部分**：`dr-shell/src/tray.rs` 里取窗口句柄的那一段（`#[cfg(windows)]`）和 `app/drifting` 的 Windows 分支，本机没法交叉编译（要先编 GPUI 的 Windows 依赖），要等推送后看 Windows 的 CI。
2. ~~**`dr-ui` 角色字体挂载平台回退链（F5 `dr-ui`）**~~：**Windows 上已接通（2026-11-19）**。`dr_ui::fonts::Role::{fallbacks, font}` 与 `dr_ui::style::DrStyled::font_role` 在 Windows 上带上 `dr_platform::fonts::fallbacks_for` 的回退链（缓存的 `gpui::FontFallbacks`）；**macOS 不带**，Core Text 照旧自己选，画出来的字不变。macOS 那张回退表（`macos_fallbacks_for`）留着没用：要挂得先在真窗口里比过表情和生僻字，作者没要过。单元测试见 `dr-ui/src/fonts.rs` 的 `a_role_font_names_its_fallback_chain_on_windows_only`（Windows 那一半只在 Windows 的 CI 上跑）。
3. **本机 `aarch64-pc-windows-msvc` rustup target 组件**：
   - 本机已安装 `x86_64-pc-windows-msvc`，`dr-platform` 通过 `cargo clippy -p dr-platform --no-default-features --all-targets --target x86_64-pc-windows-msvc`（含测试代码）交叉检查；`aarch64-pc-windows-msvc` 组件本机未预装，遵照「缺工具链组件、要装东西时先问作者，不要自己装」未在本机自动安装，如需本机跑 arm64 交叉检查可执行 `rustup target add aarch64-pc-windows-msvc`。
