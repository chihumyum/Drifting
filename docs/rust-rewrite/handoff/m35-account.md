# M35 账号与登录

先读 [README.md](README.md) 的共用约定。账号这一组（M35–M38）以这份为地基。

## 要做的

**登录方式**
- 邮箱加密码、验证码登录、注册、找回密码。
- Google 登录：打开系统浏览器，PKCE，回调 `drifting://auth/callback`，再换取令牌。
  - 登录按钮由服务端声明：`/api/auth/providers`。
  - 跳转：`/oauth-redirect/:provider`；换令牌：`/native-exchange`。
  - 应用冷启动时、或者登录对话框已经关掉了，回调也要能完成登录。
- 头像、改密码、退出登录。

**按账号分库**（作者 2026-11-02 定，不同账号的数据必须隔离）
- 每个账号一个书库，未登录时用「本机库」。
- 主动退出登录：回到本机库。账号库留在磁盘上，重新登录同一个账号原样回来，没传完的改动那时再传。
- 会话过期、断网都不算退出，仍写原来的库。
- 第一次在这台电脑登录某个账号：本机库的书**从不自动带入**，账号库从云端开始。想带过去，作者自己导出、导入（M41 的 `.driftingbook`）。

**服务端**：服务端是单独运营的私有服务，这个仓库里没有它的代码。客户端只认版本化的网络契约。契约以旧版客户端的调用为准：
- `src/renderer/lib/auth-client.ts`
- `docs/hosted-sync/native-session.md`
- `docs/hosted-sync/account-libraries.md`
- `docs/hosted-sync/account-settings.md`

## 旧版

- `src/renderer/features/auth/*`（约 2.1k 行）：登录对话框、流程、退出、原生 OAuth
- `src/renderer/lib/auth-client.ts`
- Rust 可以复用：`src-tauri/src/library_registry.rs`，用 `libraries.json` 记每个库属于谁、当前用哪个

## 新版放哪、接哪

- 新 crate `next/crates/dr-account`：会话、令牌、账号和库的登记，不依赖 GPUI。界面单开 `dr-view-account`，或者放进 `dr-account` 的一个特性里。
- 令牌放钥匙串：F7 的 `dr_platform::secrets`，键名沿用旧版。
- 深链接：F7 的 `dr_platform::deep_link`，用 `drain_matching("drifting://auth/callback")` 取回调。
- 换库：F6 的 `dr_shell::library::replace` 已经能在应用里把一个库换成另一个（M41 恢复备份就用它）。按账号分库就用这个。库目录放在 F7 的开发档案和数据目录规则下面。
- 入口在书架左下角：账号格子和账户菜单在 `dr-view-shelf` 的 `rail_foot`、`account_menu`，M01 那一路负责；`dr-shell` 的 `account.rs` 有头像和菜单。只在这几处挂入口，要改它们的结构就写进「待协调」。
- HTTP：工作区已有 `reqwest`。
- 服务地址：编译时配置，默认不带。公开源码构建默认只有本机模式（AGENTS.md「Repository boundary」）。

## 完成标准

- 对着本机假服务跑通：
  - 注册、登录、验证码、找回密码、退出；
  - Google 的 PKCE 往返，假服务模拟换令牌；
  - 回调在冷启动时也能完成。
- 分库的几种情况都有测试：登录换库、退出回本机库、重新登录回原库、第一次登录不带入本机的书、会话过期不换库。
- 测试不连真服务，也不用真 Google。
