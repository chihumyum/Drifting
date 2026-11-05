# 发布 Drifting

正式版只通过 GitHub Releases 分发：推送 `v<版本号>` tag，`.github/workflows/release.yml`
在 macOS 上构建、签名、公证，生成草稿 Release。作者检查草稿后点 **Publish**，
它就成为最新 Release；已安装的 App 从
`https://github.com/chihumyum/Drifting/releases/latest/download/latest.json` 发现它。

所以 **Publish 就是推送更新**。草稿、预发布（prerelease）都不会被已安装的 App 看到。

## 官方构建的内容

| 项 | 值 |
| --- | --- |
| 平台 | macOS 13+，Apple Silicon（`aarch64-apple-darwin`）；Windows 10/11 x64 与 ARM64（预览，见 [windows.md](windows.md)） |
| 构建机 | GitHub `macos-26`，Xcode 26.6（macOS 26 SDK）。用更早的 SDK 编译，新系统会给 App 画旧样式的标题栏，红绿灯比 App 设定的位置偏下 |
| 打包 | `Drifting_<版本号>_macos_arm64.dmg`（首次安装）、`.app.tar.gz` + `.sig`（自动更新）、`latest.json`、`SHA256SUMS.txt`、`sbom.spdx.json`；Windows 为 `Drifting_<版本号>_windows_<x64\|arm64>-setup.exe` + `.sig`（安装与自动更新同一个文件） |
| 图标 | macOS 打包前从 Icon Composer 源文件编译 `Assets.car`，支持浅色、深色、Clear 和 Tinted；旧系统保留 `.icns`。构建产物与 DMG 内的 App 都检查图标资产，见 `docs/qa/macos-app-icon.md` |
| 签名 | Developer ID Application 证书；App 和外层的 DMG 都用 App Store Connect API Key 公证并 staple（DMG 那一步在 Tauri 构建之后单独做）。Windows 安装包暂不做 Authenticode 签名，首次运行 SmartScreen 会提示；自动更新仍由同一把更新密钥签名校验 |
| Hosted | 连接 `vars.DRIFTING_HOSTED_ORIGIN`，开放注册；注册页链接 `https://drifting.cc/terms` 与 `https://drifting.cc/privacy` |
| 更新 | 启动时和开着时每 3 小时最多检查一次；有新版本时通知中心出现一条，铃铛留一个更新记号，打开通知中心才消失（重启前没打开过，启动时立刻重查、记号回来）；点开到 设置 › 更新，点一次「安装并重启」就下载、校验签名、保存全部本地修改、安装并重启；下载中和下载好待安装时不做自动检查 |

源码默认仍是纯本地构建（`pnpm dev`、`pnpm tauri:build`），不含 Hosted，也不能检查更新。

## 一次性准备

在仓库 **Settings › Secrets and variables › Actions** 里配置。`release` environment
会在第一次运行时自动创建；可以在 **Settings › Environments › release** 加上
“需要审核人”，让每次构建前都先等你批准。

### Variables

| 名称 | 值 |
| --- | --- |
| `DRIFTING_HOSTED_ORIGIN` | `https://api.drifting.cc` |
| `DRIFTING_UPDATER_PUBLIC_KEY` | 下面生成的更新签名**公钥**（`.pub` 文件的全部内容） |

### Secrets

| 名称 | 来源 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书导出的 `.p12`，`base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
| `KEYCHAIN_PASSWORD` | 任意随机字符串，只给 CI 临时钥匙串用 |
| `APPLE_API_ISSUER` | App Store Connect › 用户和访问 › 集成 › Issuer ID |
| `APPLE_API_KEY` | 同页 API Key 的 Key ID |
| `APPLE_API_PRIVATE_KEY` | 下载的 `AuthKey_<KeyID>.p8` 全文 |
| `TAURI_SIGNING_PRIVATE_KEY` | 下面生成的更新签名**私钥**文件全文 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成私钥时设的密码 |

1. **Developer ID 证书**：Xcode › Settings › Accounts › Manage Certificates › **+** ›
   *Developer ID Application*。在“钥匙串访问”里找到它，连同私钥导出为 `.p12`。
2. **公证 API Key**：App Store Connect › 用户和访问 › 集成 › App Store Connect API，
   新建一个 *Developer* 权限的 Key，下载 `.p8`（只能下载一次）。
3. **更新签名密钥**：在本机运行
   `pnpm tauri signer generate -w ~/.tauri/drifting-updater.key`，按提示设密码。
   私钥和密码只放进 GitHub Secrets 和你的密码管理器。**私钥丢失后，已安装的 App
   再也无法自动更新**，只能让用户手动下载新版。

## 每次发布

1. 在 `main` 上把 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`
   的版本改成同一个新版本号（如 `0.1.0-alpha.2`），并写好
   `docs/releases/<版本号>.md`。第一行 `# Drifting <版本号>` 之后的正文会原样显示在
   App 的更新提示和 设置 › 更新 里，写给用户看，保持简短。中英双语（2026-11-05 作者定）：先写中文条目和
   结尾提醒，空一行，再写同样内容的英文。App 按纯文本显示（保留换行，不渲染 Markdown），所以不要用标题或分隔线。
2. README 截图**只在作者说要截时才截**（2026-11-04 作者定），发版本身不截：那时跑
   `pnpm release:screenshots --readme`，截英文和中文浅色的书架、工作区和要素全景各三张，英文写进
   `docs/screenshots/`（README.md 显示），中文写进 `docs/screenshots/zh-CN/`（README.zh-CN.md 显示）；
   加 `--locale en` 或 `--locale zh-CN` 只重截一种语言，和当次改动一起提交。约一分钟，期间会把 App
   窗口调到最前，别动键盘和鼠标；见 [release-screenshots.md](release-screenshots.md)。不带
   `--readme` 则在 `out/screenshots/<版本号>/` 截中英文、浅色深色全部 12 张，不进仓库。
3. 本地运行 `pnpm release:check v<版本号>`，再跑
   `pnpm lint`、`pnpm typecheck`、`pnpm test`。
4. 推送提交和 tag：`git tag v<版本号> && git push origin main v<版本号>`。
5. 等 **Release** 工作流结束。`verify` 失败不会构建；`build` 会核对签名、Gatekeeper、
   公证 staple 和 DMG 挂载后的 App。`build-windows` 在 `windows-latest` 和
   `windows-11-arm` 上各出一个安装包，并在构建机上静默安装、打开，20 秒后 App 仍在运行才上传；Mac 草稿建好后，`release-windows` 把它们传进同一个
   草稿，并把 `windows-x86_64`、`windows-aarch64` 写进 `latest.json`。Windows 构建失败时
   Mac 草稿照样完整，可以只重跑失败的任务，或先发只有 Mac 的版本。
6. 在 GitHub 打开草稿 Release，下载 DMG，在一台干净的 Mac 上走一遍下面的冒烟检查。
7. 没问题就点 **Publish release**。已安装的 App 在下次启动时、开着的 App 在 3 小时左右内收到更新（也可在 设置 › 更新 里手动检查）。
8. Publish 之后重建并部署官网：首页的下载按钮按文件名直接下载最新 Release 的
   `Drifting_<版本号>_macos_arm64.dmg` 和 Windows 安装包，版本号取自 `package.json`。
   在 Drifting-Showcase 里运行
   `node <客户端>/scripts/design-assets/landing/build.mjs site`，跑它的测试后推送 main
   （推送就是部署）；见 `scripts/design-assets/landing/README.md`。

发现问题时：草稿直接删掉、修好后用新版本号重新打 tag。已发布的版本不要改文件；
要撤回就把它改回草稿，用户会停留在前一个已发布版本。

## 冒烟检查

- DMG 能打开，拖进“应用程序”后首次启动没有 Gatekeeper 拦截。
- 切换系统的浅色、深色、Clear 和 Tinted 图标外观，程序坞与 Finder 中的冰山图标跟随变化。
- 首次启动不需要账号，书架上能新建项目、写字，退出重开内容还在。
- 注册新账号能收到验证码邮件，登录后本地项目上传、云端项目下载正常。
- 设置 › 隐私、设置 › 关于 里的链接能打开 drifting.cc 和 GitHub 页面。
- 从上一个已发布版本升级：通知中心出现新版本提示，下载、安装、自动重启后出现
  “已更新到”通知，项目、素材、账号和模型密钥都还在。
- Windows：在 Windows 11（ARM 虚拟机也可以）装对应的 `-setup.exe`，不需要管理员权限；
  按 [windows.md](windows.md) 的手动验收清单走一遍，至少包括微软拼音输入、登录、退出重开。

## 检查脚本

`scripts/check-release.mjs`（`pnpm release:check`）核对：三处版本号一致且是 SemVer、
tag 等于 `v<版本号>`、发布说明存在、README 截图（`docs/screenshots/manifest.json`）的文件都在、都在 README 里（不要求是这个版本截的）、打包仍生成更新签名产物、App 轮询的更新地址正确、
构建脚本和过程宏不剥离、所有 GitHub Action 都钉在完整 commit SHA 上。
`pnpm ci:contract:check` 核对 CI 与发布工作流的结构。

最后一项对应 `src-tauri/Cargo.toml` 里的 `[profile.release.build-override] strip = "none"`。
release 默认会剥离调试信息，而 Xcode 27 的工具链剥离后的过程宏 dylib 加载不了
（报 `mis-aligned LINKEDIT string pool` 或 `can't find crate`），正式构建在编译 App
之前就会失败。构建脚本和过程宏只在构建机上运行，不剥离它们不影响发出去的 App，App
本身仍会剥离。
