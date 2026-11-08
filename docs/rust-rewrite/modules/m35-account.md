# M35 账号与登录

交回状态：2026-11-09，M35 账号与登录已完成，待合入 `main`。

## 做了什么（大白话）

1. **没有配官方服务地址的构建默认纯本地运行**：启动、读书架、打开设置都不发任何网络请求，欢迎页账号步骤、用户菜单的登录项和「设置 → 账号」的云端登录区都不显示，侧栏和书架左下角永远显示「本地」。
2. **首次启动欢迎选择**：配了 Hosted 服务地址且设备尚未选择过时，在首次运行流程（`dr_view_sea::first_run`）的选 Markdown 文件夹之前先出欢迎卡片，提供「邮箱登录」和「先在本机使用」。选「先在本机使用」直接进入本地书库；选「邮箱登录」打开登录弹窗。
3. **四种登录、注册与找回方式**：
   - **邮箱 + 密码登录**：未验证邮箱返回 `EMAIL_NOT_VERIFIED` 时直接跳到 6 位验证码核验页；
   - **邮箱注册 + 6 位验证码验证**：支持重发验证码及 30 秒倒计时；邮件配额用尽或投递失败时明确提示作者仍可先在本机写作；
   - **邮箱 6 位验证码直接登录**（免密）；
   - **忘记密码**：发 6 位验证码并用新密码重置；
   - **Google OAuth 登录**：当服务端 `GET /api/auth/providers` 声明支持 `google` 时显示按钮，生成 256 位随机 `state` 与 PKCE S256 `challenge` 落盘到 `<数据目录>/native-oauth-state.json`（有效期 10 分钟），用系统浏览器打开 `/api/auth/oauth-redirect/google`，通过 `drifting://auth/callback`（或开发 scheme `drifting-next-dev://auth/callback`）收一次性 `code`，在后台向 `/api/auth/native-exchange` 换取会话令牌。即使弹窗关掉或应用冷启动收到深链也能完成登录。
4. **每个账号独立书库，本地书库永远保留**：
   - `<数据目录>/libraries.json` 维护本地书库（`id: "local"`，路径 `library/`）和各账号书库（`id: "account-<SHA-256(user.id)前16字节hex>"`，路径 `libraries/account-<hex>/`）；
   - 登录账号 A 切到 A 的书库，退出登录切回本地书库，换登账号 B 切到 B 的书库，各书库文件互不覆盖；
   - 内置示例书（《慢钟》等）只在本地书库首次打开时写入，账号书库保持空白留给 M36 恢复云端项目；
   - 离线启动或会话令牌过期（401 `NeedsReauth`）时**不踢回本地书库**，继续打开上次的账号书库离线写作。
5. **个人资料与改密**：在「设置 → 账号」里支持修改显示名（`1..=80` UTF-16 码元）、选择头像图片（JPG/PNG/WebP ≤ 5 MiB，自动居中裁成 256×256 并在 `#141210` 底色上合成为 ≤ 128 KiB 的 JPEG Data URL）或移除头像、修改密码（校验当前密码，新密码 ≥ 8 字节，成功后轮换本机令牌并使其他设备下线）。

## 定下的事

- **分层**：协议、状态机、OAuth PKCE、书库注册表与本机假服务全部放在服务层 crate `next/crates/dr-account`（`Layer::Services`，不依赖 GPUI）；界面弹窗、首次运行步骤、设置页与书库切换挂接放在界面层 crate `next/crates/dr-view-account`（`Layer::Interface`）。
- **凭据按服务源隔离**：会话令牌通过 `dr_platform::SecretStore` 存在 `dr_platform::secrets::keys::hosted_session(origin)` 下；`<数据目录>/hosted-profile.json` 只存脱敏的展示资料（显示名、邮箱、头像 Data URL、服务源），绝不存令牌。
- **并发请求防覆盖**：`SessionTokenStore` 维护单调递增的会话代数（`revision`），后台 `get-session` 刷新若跨越了用户的登录、退出或改密，旧请求返回时通过 `capture_if_revision` 自动丢弃，不会把已退出的会话写回。
- **深链兼容**：OAuth 回调统一走 `drifting://auth/callback`，`dr_platform::DeepLinks` 对 `auth/` 路径同时接受构建自身的 scheme（如 `drifting-next-dev`）和正式的 `drifting`，而 `open/` 仍严格只认构建自身的 scheme，避免开发版与正式版互相抢书。

## 接口

```rust
// 服务层（dr-account）：
let config = dr_account::HostedConfig::for_build(&identity);
let svc = dr_account::AccountService::new(config, data_dir, identity.url_scheme, secrets)?;
let state = svc.bootstrap(); // 启动时后台校验 get-session + providers

// 界面层（dr-view-account）：
dr_view_account::init(dr_view_account::Service::for_build(&identity, data_dir), cx);
dr_view_account::open_auth_dialog(window, cx);
dr_view_account::sign_out(cx);
dr_view_account::apply_account_state(state, cx);
```

## 外壳里的挂接点

1. `next/app/drifting/src/library.rs`：`open_active` 在启动打开书库前读取 `<数据目录>/libraries.json` 的当前激活书库路径（无记录时默认 `<数据目录>/library`）。
2. `next/app/drifting/src/main.rs`：在 `dr_view_sea::shell::init` 之前调用 `dr_view_account::init`，确保首次运行先出欢迎卡片再出 Markdown 文件夹卡片，并把当前会话令牌传给 `dr_view_feedback::Service::set_session`。
3. `next/crates/dr-shell/src/account.rs`：通过 `set_hook` 注入当前账号显示名、状态行、裁切后的圆形头像（`RenderImage`）和登录/退出菜单项；通过 `set_auth_link_handler` 接收 `auth/` 深链。
4. `next/crates/dr-shell/src/settings/registry.rs` 与 `panel.rs`：新增 `Section::Account`（排在外观之前）与 `"account.hosted"` 模块行（`dr_shell::settings::set_module_row`）。

## 测试

在 `next/` 下运行 `cargo test -p dr-account -p dr-view-account -p dr-shell -p dr-platform --locked`：

- `local_only_mode_makes_zero_network_requests`：未配置服务源时零网络请求，状态保持 `SignedOut` 与本地书库。
- `email_sign_up_verification_and_password_sign_in_round_trip`：邮箱注册、未验证拦截、6 位验证码核验、退出、密码重登全链路。
- `email_otp_sign_in_and_password_reset_round_trip`：免密验证码登录、忘记密码验证码重置、旧密码失效与新密码登录。
- `google_oauth_pkce_live_and_cold_start_and_replay_protection`：PKCE S256 挑战生成、冷启动从磁盘恢复 `native-oauth-state.json` 完成交换、重放或篡改 `state` 拒绝。
- `account_library_isolation_preserves_local_and_each_account_separately`：本地书库 → 账号 A → 本地书库 → 账号 B → 账号 A 往返切换，各库 Loro 文档互不污染。
- `session_expiry_and_offline_startup_keep_account_library_open`：离线启动为 `Offline`、令牌过期为 `NeedsReauth`，均保持当前账号书库打开。
- `profile_update_avatar_crop_and_password_change_rotate_token`：显示名校验、头像裁切为 256×256 JPEG Data URL、移除头像、改密轮换令牌。

## 待协调

- 无阻塞项。M37 偏好同步与 M36 同步 v2 直接复用 `dr_account::AccountService` 的会话令牌与 `HostedClient`。
- **轨道 4（整合协调）**：`apply_account_state` 先更新账号展示，随后异步换库；换库失败或已有释放过程时，目前只记日志，旧库仍保留。请在后续会话状态接线时核对账号展示与实际打开书库的一致性及失败提示；本次没有据此认定数据丢失，也不扩成一轮界面复审。
- **轨道 4 / 作者**：本批证据来自合成账号、本机假服务与 GPUI 契约；真实 Hosted、浏览器 OAuth／深链及跨平台系统钥匙串仍留给后续授权验收。

## 交回

- **包含段落**：M35 账号与登录（`dr-account`、`dr-view-account`、首次运行欢迎步、外壳账号菜单与设置页挂接、多账号独立书库切换）。
- **对 `dr-shell`、`dr-view-shelf` 的改动清单**：
  - `next/crates/dr-shell/src/account.rs`：新增 `AccountViewInfo`、`AccountMenuAction`、`set_hook`、`set_auth_link_handler`、`display_name`、`menu_aria_label`，支持渲染用户头像 `RenderImage` 与底部登录/退出项。
  - `next/crates/dr-shell/src/workspace/sidebar.rs`：左下角账号按钮改调 `account::display_name(cx)` 与 `account::menu_aria_label(cx)`。
  - `next/crates/dr-shell/src/workspace/mod.rs`：`drain_deep_links` 增加 `drain_matching("auth/")` 转发给 `account::handle_auth_link`。本批样书触发位于新增的 `dr-view-account::init`，不是这个文件的改动。
  - `next/crates/dr-shell/src/settings/registry.rs`、`panel.rs`：新增 `Section::Account`、`"account.hosted"` 挂载点并更新分组；`set_module_row` / `open_section` 复用 main 既有接口，`settings/mod.rs` 未改。
  - `next/crates/dr-view-shelf/src/view.rs`：书架左下角账号按钮改调 `dr_shell::account::display_name(cx)` 与 `dr_shell::account::menu_aria_label(cx)`。
- **检查结果**：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`、`cargo xtask check`、`pnpm public:check` 全部通过。
- **待协调**：无。

## 代码位置

- `next/crates/dr-account/src/`：`endpoint.rs`（服务源配置）、`profile.rs`（资料、头像裁切、密码规则）、`session.rs`（令牌存储、并发代数、脱敏资料缓存）、`oauth.rs`（PKCE S256 与深链解析）、`library_registry.rs`（多账号书库目录与隔离）、`client.rs`（HTTP 客户端与 `AccountService`）、`fake_server.rs`（本机回环假服务）、`lib.rs`（集成测试）。
- `next/crates/dr-view-account/src/`：`lib.rs`（全局服务、`WelcomeStep`、深链与实时换库）、`dialog.rs`（`AuthDialog` 四种认证流）、`settings_view.rs`（`AccountSettingsView` 资料、头像与改密）。
- `next/crates/dr-platform/src/deep_link.rs`：`auth/` 深链同时接受构建 scheme 与 `drifting://`。
- `next/app/drifting/src/`：`library.rs`（`open_active` 按 `libraries.json` 打开当前书库）、`main.rs`（接入 `dr_view_account::init`）。
