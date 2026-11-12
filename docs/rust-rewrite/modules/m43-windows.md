# M43 Windows 版（补齐）

**交回状态**：已完成（2026-11-09，分支 `codex/track4-account-sync`）。

在 F7 已有 Windows 平台底座（NSIS 安装器、Credential Manager 分片钥匙串、深链接、单实例命名管道、自动更新交接）的基础上，补齐 Windows 通知区驻留与菜单、arm64 安装包与 CI 矩阵、Windows 字体回退顺序，以及供作者在 Windows 11（含 ARM 虚拟机）逐项执行的实机验收清单。

## 实现概览

### 1. 通知区驻留与唤醒（`next/crates/dr-platform/src/tray.rs`）

- **菜单文案校验与多语言（`TrayLabels`、`valid_label`）**：
  - 沿用旧版 `src-tauri/src/windows_tray.rs` 的规则：单行、非空、不超过 80 个字符（`MAX_LABEL_CHARS = 80`）、不含任何控制字符。
  - `TrayLabels::for_locale` 内置全部九种界面语言的「打开 Drifting」与「退出 Drifting」默认文案（如简体中文 `打开 Drifting` / `退出 Drifting`、繁体中文 `打開 Drifting` / `結束 Drifting`、英文 `Open Drifting` / `Quit Drifting` 等），并支持在界面语言切换时通过 `TrayController::set_labels` 动态更新。
- **关窗与唤醒状态机（`TrayState`、`WindowCloseContext`、`WindowCloseDecision`、`TrayCommand`）**：
  - 书内点窗口关闭（`WindowCloseContext::BookOpen`）返回 `WindowCloseDecision::ReturnToShelf`，退回书架而不隐藏窗口；
  - 书架上点窗口关闭（`WindowCloseContext::OnShelf`）在 Windows 下返回 `WindowCloseDecision::HideToTray`，刷盘后把主窗口藏进通知区，后台帮手任务、Hosted 同步和本地 MCP 桥接继续运行；
  - 左键单击通知区图标（`on_left_click`）、点击右键菜单「打开 Drifting」（`on_menu_open`）、或第二次启动把参数经命名管道转交过来（`on_second_instance_launch` / `notify_second_instance`）走同一条 `TrayCommand::RestoreWindow` 路径把窗口叫回前台；
  - 点击右键菜单「退出 Drifting」（`on_menu_quit`）发出 `TrayCommand::QuitApp` 并把状态置为 `quitting`，经刷新屏障落盘后退出进程。
- **Win32 原生通知区实现（`#[cfg(windows)] mod windows_impl`）**：
  - 直接使用工作区已锁定的 `windows 0.62`（`Win32_UI_Shell`、`Win32_UI_WindowsAndMessaging`、`Win32_System_LibraryLoader`），不向 `Cargo.lock` 引入额外第三方 crate；
  - 在 GPUI 跑 Win32 消息循环的主线程上创建隐藏消息窗口（`HWND_MESSAGE`）并调用 `Shell_NotifyIconW(NIM_ADD)` 注册通知区图标；
  - 窗口过程处理 `WM_LBUTTONUP`（左键唤醒）、`WM_RBUTTONUP` / `WM_CONTEXTMENU`（按当前语言弹出两项菜单）和 `WM_COMMAND`（打开 / 退出），将命令推入 `TrayController` 队列并触发主线程 `waker`；析构时调用 `Shell_NotifyIconW(NIM_DELETE)` 与 `DestroyWindow` 清理句柄。

### 2. arm64 安装包、内置字体打包与 CI（`next/script/`、`.github/workflows/next.yml`）

- **`next/script/bundle-windows.ps1` 与 `next/script/windows/drifting.nsi`**：
  - 支持 `-Target x86_64-pc-windows-msvc`（产物后缀 `_windows_x64-setup.exe`）与 `-Target aarch64-pc-windows-msvc`（产物后缀 `_windows_arm64-setup.exe`），以及未传 `-Target` 时按构建机 `PROCESSOR_ARCHITECTURE` 自动识别 `x64` / `arm64`。
  - 自动检测 `DRIFTING_FONTS_DIR` 或 `next/.cache/fonts` 下的 6 个内置字面与 `OFL-1.1.txt`，传入 `/DFONTS_DIR` 由 NSIS 安装到 `$INSTDIR\fonts\`（与 `dr_ui::fonts::candidates()` 在 Windows 安装包下查找 `exe_dir.join("fonts")` 的路径对齐），卸载时一并清理 `$INSTDIR\fonts`。
- **`next/script/check-windows-installer.ps1` 与 `.github/workflows/next.yml`**：
  - `check-windows-installer.ps1` 新增可选 `-Target` 参数，校验生成的安装包架构后缀与内置字体文件安装／卸载；
  - `.github/workflows/next.yml` 矩阵拆分为 `macos`（`macos-26`）、`windows-x64`（`windows-latest`，`x86_64-pc-windows-msvc`）和 `windows-arm64`（`windows-11-arm`，`aarch64-pc-windows-msvc`），在两台 Windows 构建机上分别构建对应架构的 NSIS 安装包并完整跑一遍静默安装、`/P /UPDATE` 原地升级、自定义目录安装与卸载检查。

### 3. Windows 字体回退顺序（`next/crates/dr-platform/src/fonts.rs`）

- 照 `docs/windows.md` 定义四类排版角色（`FontRole::{Ui, Structure, Prose, Index}`）在 Windows 与 macOS 上的字体栈与回退顺序：
  - **正文与结构衬线（`Prose` / `Structure`）**：`Drifting Serif` → `Noto Serif SC` → `Songti SC` → `SimSun` → `Microsoft YaHei`。确保缺字时优先回退到自带的 `Noto Serif SC`，而不是直接退到点阵感明显的 `SimSun`（宋体），仅当罕见扩展汉字不在 `Noto Serif SC` 中时才由 `SimSun` 兜底。
  - **界面无衬线（`Ui`）**：`Drifting Sans` → `Noto Sans SC` → `Microsoft YaHei UI` → `Microsoft YaHei` → `Segoe UI` → `SimHei`，系统无衬线显式指向微软雅黑，且绝不回退到 `SimSun`。
  - **索引等宽（`Index`）**：`Sarasa Mono SC` → `Cascadia Mono` → `Consolas` → `Microsoft YaHei UI` → `Microsoft YaHei`。

## Windows 实机／虚拟机验收清单

供作者在 Windows 11（含 Apple Silicon 上的 Windows 11 ARM 虚拟机或 x64 实机）上按步骤点验：

### 一、安装器与升级（x64 与 arm64）
1. **首次普通用户安装**：双击 `Drifting_Next_<version>_windows_arm64-setup.exe`（ARM 虚拟机）或 `x64-setup.exe`（x64 机器），确认无需管理员权限（不弹 UAC），界面语言随系统显示简体中文或英文。
2. **安装目录与字体文件**：安装完成后检查 `%LOCALAPPDATA%\Drifting Next\` 下有 `drifting.exe`、`uninstall.exe` 以及 `fonts\` 目录（内含 6 个 `.ttf` 字体文件与 `OFL-1.1.txt`），开始菜单已生成 `Drifting Next` 快捷方式。
3. **注册表与卸载项**：在「设置 › 应用 › 已安装的应用」能看到 `Drifting Next`；注册表 `HKCU\Software\drifting\Drifting Next` 记录了安装目录，`HKCU\Software\Classes\drifting-next-dev\shell\open\command` 指向 `"%LOCALAPPDATA%\Drifting Next\drifting.exe" "%1"`。
4. **原地更新保留快捷方式**：在 PowerShell 运行 `.\Drifting_Next_<version>_windows_<arch>-setup.exe /P /UPDATE`，确认只显示进度条、自动覆盖可执行文件，且不重置已有快捷方式。
5. **卸载保留作者数据**：运行 `%LOCALAPPDATA%\Drifting Next\uninstall.exe`，确认程序目录、开始菜单快捷方式和注册表协议键被清理，但 `%LOCALAPPDATA%\cc.drifting.next.dev\` 下的书库与日志完好保留。

### 二、单实例与深链接（`single_instance` + `deep_link`）
1. **单实例唤醒**：先启动 `Drifting Next`，再在终端运行一次 `%LOCALAPPDATA%\Drifting Next\drifting.exe`，确认第二个进程立即退出，不会开出第二个窗口，且已运行的窗口被切到前台。
2. **书架关窗隐藏后再次启动唤醒**：在书架页点左上角关闭按钮让窗口藏进通知区，再从开始菜单或终端启动一次 `Drifting Next`，确认隐藏的主窗口立即恢复显示并获得焦点。
3. **协议深链接唤醒与投递**：在 `Win + R` 或浏览器地址栏输入 `drifting-next-dev://auth/callback?nativeState=test-state&handoff=test-code`，确认运行中的（或隐藏在通知区的）`Drifting Next` 被唤起并收到该深链接，日志中不打印完整敏感参数。

### 三、Windows 凭据管理器钥匙串（`secrets`）
1. **短密钥持久化**：打开「设置 › 模型」，填入一段测试用 DeepSeek API Key 并保存；打开 Windows「凭据管理器 › Windows 凭据」，确认存在 `cc.drifting.next.dev` 相关条目；完全退出并重开应用，确认密钥仍在。
2. **超长令牌自动分片读写（> 1200 字符）**：登录 Hosted 账号或使用超过 1200 字符的会话令牌后，在「凭据管理器」中确认生成了带分片头（含代数、分片数与 SHA-256）和多条分片凭据；完全退出并重开应用，确认登录态自动恢复且不会回退写明文文件。

### 四、通知区（系统托盘）
1. **书内关窗 vs 书架关窗**：
   - 打开任意一本书进入章节页，点窗口左上角关闭按钮：确认先退回书架，窗口保持打开；
   - 在书架页再次点左上角关闭按钮：确认窗口隐藏，任务栏通知区（Windows 11 首次可能在 `^` 溢出面板中）留有 `Drifting Next` 图标，后台同步与本地 MCP 桥接继续工作。
2. **左键单击与菜单「打开」恢复**：
   - 左键单击通知区图标：主窗口恢复显示并聚焦；
   - 再次在书架页关窗隐藏，右键通知区图标点「打开 Drifting」：主窗口同样恢复显示。
3. **菜单语言跟随界面语言**：在「设置 › 语言」把界面语言在简体中文、英文、日文之间切换，右键通知区图标，确认两项菜单文案随之变为对应语言的「打开 Drifting / 退出 Drifting」。
4. **菜单「退出」真正结束进程**：右键通知区图标点「退出 Drifting」，确认本地修改保存完毕后进程完全退出，通知区图标消失，任务管理器中不再有 `drifting.exe`。

### 五、字体与排版回退
1. **内置字体加载**：启动应用后检查日志有一行 `dr-ui fonts from ...`，界面无衬线（`Drifting Sans`）、正文衬线（`Drifting Serif`）和统计数字等宽字体（`Sarasa Mono SC`）与 macOS 视觉一致。
2. **中文正文与罕见字回退**：在正文中输入常规简体中文、拉丁斜体与粗体，以及罕见扩展汉字，确认常规中文与标点使用 `Drifting Serif` / `Noto Serif SC` 渲染（不退化为点阵宋体 `SimSun`），界面控件回退使用 `Microsoft YaHei` 而不混入宋体。

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

## 待协调

1. **外壳窗口关闭与托盘命令挂接（F6 `dr-shell`）**：
   - 按当时 `handoff/overnight.md`（已删）的轨道 4 规则，本分支不直接修改 `dr-shell`。合流后在 `dr-shell` 启动时调用 `dr_platform::tray::TrayController::install(&identity, TrayLabels::for_locale(locale.code()))`，把 `single_instance` 回调接到 `tray.notify_second_instance()`，在窗口关闭请求处按 `tray.handle_window_close(context)` 区分 `ReturnToShelf`、`HideToTray` 与 `QuitProcess`，并在界面语言变更时调用 `tray.set_labels(open, quit)`。
2. **`dr-ui` 角色字体挂载平台回退链（F5 `dr-ui`）**：
   - 按当时的 `handoff/kernel-v3-split.md`（已删），`dr-ui` 归轨道 2，本分支不直接修改 `next/crates/dr-ui/src/fonts.rs`。合流后可在 `dr_ui::fonts::Role::font` 中加一行 `f.fallbacks = Some(gpui::FontFallbacks::from_fonts(dr_platform::fonts::fallbacks_for(role).iter().map(|s| (*s).to_owned()).collect()));` 将 `dr_platform::fonts` 的 Windows/macOS 回退顺序挂入 GPUI `Font`。
3. **本机 `aarch64-pc-windows-msvc` rustup target 组件**：
   - 本机已安装 `x86_64-pc-windows-msvc` 并通过 `--target x86_64-pc-windows-msvc` 交叉编译检查；`aarch64-pc-windows-msvc` 组件本机未预装，遵照 `m43-windows.md`「缺工具链组件、要装东西时先问作者，不要自己装」未在本机自动安装，如需本机跑 arm64 交叉检查可执行 `rustup target add aarch64-pc-windows-msvc`。
