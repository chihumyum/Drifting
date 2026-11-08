# M43 Windows 版（补齐）

先读 [README.md](README.md) 的共用约定，再读 [f7-platform.md](../foundations/f7-platform.md)：F7 已经做了 Windows 的大部分，这一份在它的基础上补齐。

## 已经有的（F7）

- NSIS 安装器：`next/script/bundle-windows.ps1`、`next/script/windows/drifting.nsi`、`check-windows-installer.ps1`。安装位置、卸载项、注册表和旧版 Tauri 安装器一样；CI 里装一遍、升级一遍、卸一遍。
- 钥匙串（Windows 上长令牌自动拆开存）、深链接、单实例（第二次启动把链接转给已经开着的那个）。
- 自动更新在 Windows 上交给安装器。
- 发布工作流草稿：`next/script/release-next.draft.yml`，放在 `.github/workflows` 外面，不会跑。

## 要补的

1. **通知区**：在 Windows 上关掉书架窗口只是藏起来，程序留在通知区，后台的帮手和同步接着跑；点图标、或者再启动一次就回来；菜单里的「退出」才真正结束。
   - 做法 F7 写好了（f7-platform.md 第 235 行起）：用 `tray-icon` crate，在 GPUI 跑 Win32 消息循环的主线程上建图标，菜单点击从事件通道读，转进应用。
   - 旧版是 `src-tauri/src/windows_tray.rs`。
2. **arm64 的安装包**：现在的安装器出 x64。加 arm64，CI 里两种都出、都装一遍。
3. **字体回退**：界面字体和中文正文在 Windows 上缺字时的回退顺序，照旧版 `docs/windows.md`。在 F5 的 `dr-ui` 字体加载那里实现，改动尽量小。
4. **Windows 上真跑的清单**：深链接、单实例、钥匙串、安装器、通知区、字体。写成作者能照着在虚拟机里点的步骤。

**不在这份里**：
- Windows 输入法的组字丢弃（IMM32 的 `ImmNotifyIME`）归 F4c；
- 微软拼音的真机验收要作者在虚拟机里做；
- 签名到正式发布时再定（决定 D10）。

## 新版放哪、接哪

- 通知区：外壳的退出流程归 F6（`dr-shell` 的 `quit.rs`、窗口关闭的处理）。可以单开一个小 crate 放托盘，只在外壳里加挂接点。
- CI：改 `.github/workflows/next.yml` 加 arm64 的出包和安装检查。只改文件，不推送；推送和在 CI 上实际跑由作者决定。
- 本机能做到交叉编译检查就行：`cargo check --target x86_64-pc-windows-msvc`，arm64 用 `aarch64-pc-windows-msvc`。缺工具链组件、要装东西时先问作者，不要自己装。

## 完成标准

- 通知区：能单测的部分单测，交叉编译能过。
- arm64 安装包的脚本和 CI 步骤写好。
- 字体回退有测试。
- Windows 实机清单写进文档。
