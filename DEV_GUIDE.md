# Drifting 开发指南

Drifting 是 Tauri 2 + Rust + React + Vite 客户端。仓库默认构建为
local-only：不需要账号或 Drifting 托管服务，项目保存在本地 SQLite/Yjs，
AI 使用作者自行配置的 BYOK provider。

完整的工具链版本、平台前置条件与架构入口见 [README.md](README.md) 和
[文档索引](docs/README.md)。

## 启动桌面开发环境

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 等同于本地模式的 `pnpm tauri:dev`。开发数据库写入
`.local-data/databases/`，不会要求先启动服务器。

在 macOS 上，`pnpm dev` 会通过 Cargo runner 在每次原生重编译后、启动应用前，
使用本机第一个未撤销的 `Apple Development` identity 签名 debug 二进制，并固定
code identifier 为 `cc.drifting.client.dev`。这避免 ad-hoc 签名的 cdhash 变化导致
Keychain 每次重新授权。若机器上有多个有效 identity，可在本机 shell 中设置
`DRIFTING_MACOS_DEV_SIGNING_IDENTITY` 明确选择；不要把证书或私钥提交到仓库。
首次把旧 ad-hoc Keychain 条目授权给稳定签名时，macOS 仍可能要求一次确认。
没有开发证书的贡献者仍可启动应用，但会退回 Cargo 默认签名并显示警告。

```bash
pnpm macos:dev-signing:check
```

常用检查：

```bash
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## 桌面与移动端构建

```bash
pnpm tauri:build
pnpm tauri:build:debug
pnpm mobile:ios:dev
pnpm mobile:ios:device:debug -- --device "<设备名称或 identifier>"
pnpm tauri:ios:build
pnpm mobile:android:dev
pnpm tauri:android:build
```

本地构建没有 `DRIFTING_UPDATER_PUBLIC_KEY` 时，以及所有 debug 构建，桌面启动器
会关闭 updater 产物生成；这不影响 `.app` bundle，可用于验证 macOS 权限声明。
macOS 本地 bundle 同时沿用经过撤销检查的 Apple Development identity，避免 ad-hoc
签名让麦克风与 Keychain 授权随每次构建漂移。
真机 iOS Debug 安装命令会内嵌 renderer、校验签名与 bundle identifier，并通过 `devicectl`
原位更新 App；它不启动 Vite dev server，不卸载旧 App，也不重置设备上的应用数据。
受保护的正式发布环境提供 updater 公钥后，启动器把它写入仅在构建期间存在的临时
Tauri 配置并继续生成签名 updater 产物，公钥不会落入仓库文件。

iOS/Android 的设备选择、服务覆盖与手工验收边界见
[mobile-device-acceptance.md](docs/mobile-device-acceptance.md)。构建或测试通过不等于
物理设备上的触摸、输入法、后台恢复和保存面板已经验收。

## 本地数据

默认本地书库数据库名为 `drifting-library.db`。桌面生产数据目录通常为：

- macOS：`~/Library/Application Support/cc.drifting.client/databases/`
- Windows：`%LOCALAPPDATA%/cc.drifting.client/databases/`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/cc.drifting.client/databases/`

iOS 与 Android 使用各自的应用容器。不要提交 `.local-data/`、数据库、素材、
Keychain/Keystore 凭据或真实稿件。关系型 Markdown 导出的能力与限制见
[local-data-export.md](docs/local-data-export.md)，本地图片/PDF 所有权边界见
[local-assets.md](docs/local-assets.md)。

`0.1.0-alpha.1` 已冻结首个公开 SQLite/domain/checkpoint 兼容基线：此后每个公开
`0.1.x` 版本必须按顺序升级更早的公开 `0.1.x` 数据，已发布的迁移不可改写。当前
基线的数据库应予保留；只有基线之前的 pre-Alpha 开发库不属于受支持的迁移人群，
应备份后重置，不要为其添加 fallback read、双写或搬运器。这项规则以
[AGENTS.md](AGENTS.md) 的 `Public Alpha compatibility policy` 与
[docs/alpha-release-contract.md](docs/alpha-release-contract.md) 为准。

## 网络与兼容服务

默认值由 `src/renderer/lib/config.ts` 定义，标准桌面/移动构建脚本也会显式设置：

```text
VITE_LOCAL_ONLY_MODE=true
VITE_REQUIRE_AUTH=false
VITE_AI_TRANSPORT=direct
```

`LOCAL_ONLY_MODE` 只关闭 Drifting-compatible hosted service。网络按
`hosted-service`、`personal-cloud`、`byok-provider`、`external-content` 与
`agent-extension` 分类；用户明确选择的 BYOK provider、URL 元数据/预览及已配置的远程
Agent extension 仅在设备在线时可用。Personal-cloud 同步只使用独立 capability
和 SyncEngine authority，不存在 hosted sync 开关。公开仓库不包含兼容服务实现；需要自建服务的 operator 应先阅读
[official-service.md](docs/official-service.md)，并自行配置 API origin、CSP、隐私政策与
凭据。

可选 Google Drive 同步以 Google 登录作为跨设备访问 authority：新设备登录同一
Google 账号后自动发现 Project。同步对象通过 HTTPS 写入该账号的
`appDataFolder`，并受到 Google 自身的存储保护，但 Drifting 不对 Google 做端到端
加密；Google 可以处理稿件、元数据和素材内容。该流程没有恢复码、二维码或应用管理的
Project 内容密钥。当前源码/模拟器/构建检查也不等于真实账号与物理设备验收，完整边界见
[trusted-cloud Google Drive contract](docs/sync-engine/trusted-cloud-google-drive.md)。

BYOK Key 只能通过应用内“设置 → 模型与 API”写入系统安全存储，不要放进
`VITE_*` 构建变量或源码。

## 更多入口

- [贡献与提交检查](CONTRIBUTING.md)
- [当前 Agent 能力](docs/agent-runtime/acceptance/CURRENT_STATUS.md)
- [SyncEngine 架构与验收索引](docs/sync-engine/README.md)
- [原生平台已知限制](src-tauri/UNSUPPORTED.md)
