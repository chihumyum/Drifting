# 发布 Drifting

正式版只通过 GitHub Releases 分发：推送 `v<版本号>` tag，`.github/workflows/release.yml`
在 macOS 上构建、签名、公证，生成草稿 Release。作者检查草稿后点 **Publish**，
它就成为最新 Release；已安装的 App 从
`https://github.com/chihumyum/Drifting/releases/latest/download/latest.json` 发现它。

所以 **Publish 就是推送更新**。草稿、预发布（prerelease）都不会被已安装的 App 看到。

## 官方构建的内容

| 项 | 值 |
| --- | --- |
| 平台 | macOS 13+，Apple Silicon（`aarch64-apple-darwin`） |
| 打包 | `.dmg`（首次安装）、`.app.tar.gz` + `.sig`（自动更新）、`latest.json`、`SHA256SUMS.txt`、`sbom.spdx.json` |
| 签名 | Developer ID Application 证书，App Store Connect API Key 公证并 staple |
| Hosted | 连接 `vars.DRIFTING_HOSTED_ORIGIN`，开放注册；注册页链接 `https://drifting.cc/terms` 与 `https://drifting.cc/privacy` |
| 更新 | 启动后每天最多检查一次；有新版本时通知中心出现一条，点开到 设置 › 更新；下载和安装都要用户确认；安装前先保存全部本地修改 |

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
   App 的更新提示和 设置 › 更新 里，写给用户看，保持简短。
2. 本地运行 `pnpm release:check v<版本号>`，再跑 `pnpm lint`、`pnpm typecheck`、`pnpm test`。
3. 推送提交和 tag：`git tag v<版本号> && git push origin main v<版本号>`。
4. 等 **Release** 工作流结束。`verify` 失败不会构建；`build` 会核对签名、Gatekeeper、
   公证 staple 和 DMG 挂载后的 App。
5. 在 GitHub 打开草稿 Release，下载 DMG，在一台干净的 Mac 上走一遍下面的冒烟检查。
6. 没问题就点 **Publish release**。已安装的 App 在下次启动（或在 设置 › 更新 里手动检查）时收到更新。

发现问题时：草稿直接删掉、修好后用新版本号重新打 tag。已发布的版本不要改文件；
要撤回就把它改回草稿，用户会停留在前一个已发布版本。

## 冒烟检查

- DMG 能打开，拖进“应用程序”后首次启动没有 Gatekeeper 拦截。
- 首次启动不需要账号，书架上能新建项目、写字，退出重开内容还在。
- 注册新账号能收到验证码邮件，登录后本地项目上传、云端项目下载正常。
- 设置 › 隐私、设置 › 关于 里的链接能打开 drifting.cc 和 GitHub 页面。
- 从上一个已发布版本升级：通知中心出现新版本提示，下载、安装、自动重启后出现
  “已更新到”通知，项目、素材、账号和模型密钥都还在。

## 检查脚本

`scripts/check-release.mjs`（`pnpm release:check`）核对：三处版本号一致且是 SemVer、
tag 等于 `v<版本号>`、发布说明存在、打包仍生成更新签名产物、App 轮询的更新地址正确、
所有 GitHub Action 都钉在完整 commit SHA 上。`pnpm ci:contract:check` 核对 CI 与发布
工作流的结构。
