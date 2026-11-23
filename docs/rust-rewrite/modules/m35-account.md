# M35 账号与登录

交回状态：2026-11-09，M35 账号与登录已完成，待合入 `main`。

## 做了什么（大白话）

1. **没有配官方服务地址的构建默认纯本地运行**：启动、读书架、打开设置都不发任何网络请求，欢迎页账号步骤、用户菜单的登录项和「设置 → 账号」的云端登录区都不显示，侧栏和书架左下角永远显示「本地」。
2. **首次启动欢迎选择**：配了 Hosted 服务地址且设备尚未选择过时，在首次运行流程（`dr_view_sea::first_run`）的选 Markdown 文件夹之前先出欢迎卡片，提供「邮箱登录」和「先在本机使用」。选「先在本机使用」直接进入本地书库；选「邮箱登录」打开登录弹窗。
   - **同意条款只占一行**（2026-11-13，与 0.1 的 `ConsentLine` 一致）：欢迎卡最下面一行淡字「继续即视为同意相关条款」，不再整段写故障报告说明。这一行放在欢迎卡上，是因为选本地继续的人也会经过这一页，而官方版没登录也会发故障报告。「相关条款」带下划线、比周围的字深一档；指着它，或者按它（鼠标、Enter / 空格、读屏的「按下」都行），浮出 dr-ui 的悬停卡：卡里一句话是故障报告说明（`preAlphaGuide.crashReports`），卡底两行「服务条款」「隐私政策」带外链记号，按了在系统浏览器里打开；构建没给服务条款链接时没有那一行。卡朝下展开，不盖住上面的继续方式。
   - 这一行只在欢迎卡上：登录弹窗不管从哪里打开（欢迎卡的「邮箱登录」、账户菜单、设置）都没有它。0.1 当天试过把它也放进登录流程，随即退回（`2e4ae6fbd`），新版照最后的定法。
   - 句子按 `{{terms}}` 占位拆成前后两段，中间放可悬停的词，九种语言占位位置各不相同（`auth.legal.consent`、`auth.legal.consentTerms`、`auth.legal.terms`、`auth.legal.privacy`）。
   - 链接在构建时给：`DRIFTING_TERMS_URL`（不给就没有服务条款那一行）、`DRIFTING_PRIVACY_URL`（不给就指仓库的 `PRIVACY.md`），对应 0.1 的 `VITE_TERMS_URL` / `VITE_PRIVACY_URL`。正式版的发布工作流（M42）要和 `DRIFTING_API_BASE_URL` 一起设成 `https://drifting.cc/terms`、`https://drifting.cc/privacy`。
3. **四种登录、注册与找回方式**：
   - **邮箱 + 密码登录**：未验证邮箱返回 `EMAIL_NOT_VERIFIED` 时直接跳到 6 位验证码核验页；
   - **邮箱注册 + 6 位验证码验证**：支持重发验证码及 30 秒倒计时；邮件配额用尽或投递失败时明确提示作者仍可先在本机写作；
   - **邮箱 6 位验证码直接登录**（免密）；
   - **忘记密码**：发 6 位验证码并用新密码重置；
   - **Google OAuth 登录**：当服务端 `GET /api/auth/providers` 声明支持 `google` 时显示按钮，生成 256 位随机 `state` 与 PKCE S256 `challenge` 落盘到 `<数据目录>/native-oauth-state.json`（有效期 10 分钟），用系统浏览器打开 `/api/auth/oauth-redirect/google`，通过 `drifting://auth/callback`（或开发 scheme `drifting-next-dev://auth/callback`）收一次性 `code`，在后台向 `/api/auth/native-exchange` 换取会话令牌。即使弹窗关掉或应用冷启动收到深链也能完成登录。
4. **每个账号独立书库，本地书库永远保留**：
   - `<数据目录>/libraries.json` 维护本地书库（`id: "local"`，路径 `library/`）和各账号书库（`id: "account-<SHA-256(user.id)前16字节hex>"`，路径 `libraries/account-<hex>/`；登录时导入过 0.1 的账号改指导入的目录，见下文「登录状态下导入 0.1 的库」）；
   - 登录账号 A 切到 A 的书库，退出登录切回本地书库，换登账号 B 切到 B 的书库，各书库文件互不覆盖；
   - 内置示例书（《慢钟》等）只在本地书库首次打开时写入，账号书库保持空白留给 M36 恢复云端项目；
   - 离线启动或会话令牌过期（401 `NeedsReauth`）时**不踢回本地书库**，继续打开上次的账号书库离线写作。
5. **个人资料与改密**：在「设置 → 账号」里支持修改显示名（`1..=80` UTF-16 码元）、选择头像图片（JPG/PNG/WebP ≤ 5 MiB，自动居中裁成 256×256 并在 `#141210` 底色上合成为 ≤ 128 KiB 的 JPEG Data URL）或移除头像、修改密码（校验当前密码，新密码 ≥ 8 字节，成功后轮换本机令牌并使其他设备下线）。

## 登录状态下导入 0.1 的库（2026-11-20）

登录时在「导入 Drifting 0.1」里导进来的书，进的是这个账号自己的书库（流程和规则在 [m10「登录状态下导入」](m10-import.md#登录状态下导入2026-11-20)）。账号这边改了三处：

1. **账号的书库可以换一次目录。** 导入先写进数据目录里一个新的 `reimport-v5-<uuid>/`，导完以后 `LibraryRegistry::adopt_for_account` 把 `libraries.json` 里这个账号那一行改指它：id 还是 `account-<SHA-256(user.id) 前 16 字节 hex>`，owner 还是 `Account { subject }`，只有 `path` 变。所以账号书库不一定在 `libraries/account-<hex>/` 了，以登记表为准；原来那个空目录留在磁盘上，不再登记。只能改当前打开着的那个账号、只能从它现在的目录改、只能改到数据目录里一个已经存在而且没登记过的子目录。改了以后退出再登录（`activate_account` 按 id 找到这一行）、冷启动（`settle_for_startup`）都打开新目录。
2. **`libraries.json` 的读改写加了一把进程内的锁**（`registry_lock`）。登录、退出、启动时的换库和导入的改指都先拿锁再读、改、存，免得后台刷新会话时用旧的内容把导入刚写的改指盖掉。
3. **`AccountService::reload_active_library`**：重读登记表，当前打开的是这个已登录用户的账号书库时，把状态里的 `active_library_dir` 换成登记表里的目录。界面这边是 `dr_view_account::follow_library_registry`：导入换库成功后调它，账号栏、「设置 → 账号」和同步监督就都认新目录；不启动偏好同步，也不再换一次库。

「每个账号独立书库」「登录不带入本机书库的书」不变：没登录时导入的照旧是新的本机书库（`Local`），和账号无关。

测试：`dr-account` 的 `an_account_library_moves_once_to_an_imported_directory_and_keeps_it`；整条路在 `dr-view-import/tests/account.rs`。

## 运营公告（2026-11-21）

0.1 从 `0.1.0-alpha.12` 起在通知中心显示 Drifting 服务的运营公告（account notices v1）：运营方发的维护时间、事故说明、对某位作者反馈的答复。切换以后运营方要靠它找到作者，所以新版照 0.1 接上了。契约以 0.1 的客户端和它的文档为准（[`docs/hosted-sync/notices.md`](../../hosted-sync/notices.md)、`src/renderer/features/notices/`），没有看也没有假设私有服务端的代码。

**协议。**

- `GET /api/account/v1/notices`，带账号的 Bearer 会话：回当前给这个账号的公告（旧的在前）、账号的已读线 `readThrough` 和 `refreshAfterSeconds`。每条有 `id`、`seq`（服务端每发一条加一，已读线就按它算）、`personal`（只给这一个账号）、`content`（`zh`、`en` 各一份 `title`、`body`）、`link`、`publishedAt`、`expiresAt`。
- `POST /api/account/v1/notices/read`，`{ "through": <seq> }`：把已读线抬到这里，回 `{ "readThrough": <seq> }`。服务端不往回挪，也不超过它发过的最新一条。
- 回 404 是服务端还没有这两条路（旧服务），不算错。除了已读线，什么都不告诉服务端；作者删掉了哪几条只记在本机。

**什么时候读（和 0.1 一样）。** 只在配了 Hosted 服务的构建里装上；账号「已连接」或「离线」时才读，没登录不读，本地版一个请求都不发。会话确认以后读一次（启动时、登录后、账号状态每次变化时）；窗口回到前台时读一次（离上次至少 15 秒）；之后窗口在前台时每隔 `refreshAfterSeconds` 读一次（默认 60 秒，夹在 15 秒到 1 小时之间），在后台时慢五倍、最多一小时。每 15 秒看一次到没到时候，所以公告一般一分钟内到；没有推送，App 没开就收不到。读失败按 1、2、4……最多 300 秒退避重试（随机抖动），不打扰作者；回 404 一小时后再问；会话被拒（401/403）五分钟后、或账号状态下次变化时再问，会话过期由账号状态去报。

**显示。**

- 每条公告是通知中心的一行。给所有账号的，来源写「公告」；只给这个账号的，写「消息」（0.1 的 `notifications.notice.personal`，经 `keys.txt` 原样从 0.1 的语言文件拷过来，九种语言都是 0.1 的原文，没有新文案）。
- 这一行的字是标题，下面几行是正文（保留正文的换行）。按界面语言选：中文界面（简体、繁体）用中文，其他界面用英文；只写了一种语言就用那一种。
- 只当纯文本：不解析任何标记，去掉控制字符和双向覆盖字符；标题是一行、最多 200 字，正文最多 2000 字，超出的截断、以「…」结尾；一次最多留最新的 20 条（通知中心总共留 50 条）；回包超过 1 MiB 整个不要。缺 `id`、`seq` 或没有字的条目丢掉，不显示半条；整个回包不对，就当这次读失败，列表和会话都不动。
- 时间用发布时间，比本机时间晚的按现在算。
- 日志和错误只写失败的种类和状态码，不写公告的字，也不写会话令牌。

**已读。**

- 通知中心的列表只在内存里。重启后服务端还在给的公告重新列出来，在账号已读线以下的进来就是已读。
- 通知中心打开时列着的，算这台设备读过；开着的时候进来的，关上时算读过。这一条对通知中心的所有来源都适用（和 0.1 的 `setCenterOpen` 一样）：外壳在通知中心打开和关上时都调 `Notifications::mark_read`（`dr_shell::workspace` 里的 `observe_self`，Esc、点外面、开设置或对话框盖上去，都算关上）。
- 读过的最新一条，或作者删掉的一条，把账号的已读线抬上去；账号的其他设备下次读时就当已读。一次只有一个已读请求在路上，失败了下次读的时候再发。
- 作者删掉的一条（行上的 ×，或「清空」）在这台设备上不再出现，直到服务端不再给它（设备记忆 `account.notices_dismissed`，按账号分开）。
- 运营方撤回的、过期的，下次读时从列表里拿掉，不当作作者删的。退出登录把这个账号的公告全拿掉；换一个账号，各看各的。

**和 0.1 不一样的地方。** 都是新版通知中心本来就没有的东西，按「不加界面」做了最接近的：

1. **带链接的公告不打开链接。** 0.1 点这一行用系统浏览器打开它的 `https:` 链接；新版通知中心的行只能打开书里的东西，不能开外部链接，所以链接只按 0.1 的规则解析（`AccountNotice::link`），不打开，这一行点了没反应。
2. **风铃上没有未读记号。** 0.1 有没读的公告时风铃换成名章；新版风铃本来就不显示未读（只在有同步问题时显示危险记号）。所以「读过」在新版里只影响账号的已读线，和重启后进来是不是已读，作者在界面上看不出来。
3. **别的设备读过的，这一行不变。** 0.1 把这一行单独标成已读；新版通知中心只有一个整体的「有没有未读」、没有每行各自的已读，所以只记下它读过、不再为它发已读请求。因为第 2 条，看不出区别。
4. **标题和正文在同一段字里**，标题在第一行（新版每行只有一段字）。
5. **「回到网络」不单独监听。** 0.1 听浏览器的 `online` 事件；新版没有这个事件。离线时照样按退避重试，账号状态从离线变回已连接时（`apply_account_state`）立刻读一次。

**代码。**

- `next/crates/dr-account/src/notices.rs`：解析和约束（`parse_account_notices`、`notice_link`、长度和条数上限）、`AccountService::read_notices` / `mark_notices_read`（没配服务、没会话时不发请求）。`client.rs` 的 `HostedClient::get_notices` / `mark_notices_read`：限着大小读回包，失败只带状态码。
- `next/crates/dr-account/src/fake_server.rs`：假服务的两条公告路由，照上面的契约（只给本账号的、已读线只升不降），测试用 `publish_notice`、`withdraw_notice`、`notice_read_through`、`set_notices_supported`（404）、`set_notices_failure`（如 500）、`set_notices_body`（原样回一段坏的或超大的字节）、`set_notices_refresh` 和 `requests_to`（某条路收到几次请求）。
- `next/crates/dr-view-account/src/notices.rs`：什么时候读、放进通知中心、已读线、删掉的记在本机；`init` 在配了服务时装上，`apply_account_state` 末尾告诉它账号变了。
- `next/crates/dr-shell/src/notifications.rs`：`Source::PersonalNotice`；`workspace/mod.rs`：通知中心关上时也读。

**测试。**

- `dr-account` 的 `notices::tests`（5 条）：只留格式对的条目、按 `seq` 排、同一个 id 只留一条、最多 20 条、刷新间隔夹住；纯文本清理和截断；链接规则；按界面语言选；坏回包的错误里没有回包的字。
- `dr-account` 的 `account_notices_are_read_for_the_signed_in_account_and_the_mark_only_rises`：本地版和没登录不发请求；只给一个账号的别的账号看不到；已读线只升不降、不超过最新一条；坏的、超大的、500 的回包报错，错误里没有回包的字；404 是 `Unsupported`；会话过期是 401 的 `Unauthorized`。
- `dr-view-account/tests/notices.rs`（7 条）：本地版一个请求都不发；没登录不读；登录后每条只列一次（后台每五分钟读一次，读几次都一样）、来源「公告」「消息」、按中文界面显示、打开通知中心才抬已读线；新来的不读不抬；撤回的下次读时拿掉、不算删掉；退出登录全拿掉、不再读；开着时进来的、关上以后才抬到它；重启后服务端还在给的重新列出来、已读的进来是已读、只列一次，删掉的不回来，删掉也算看过；坏的、超大的、500 的回包列表和会话都不动，失败后自己重试，服务好了就显示新的；404 一小时内不再问，401 五分钟内不再问，列着的不动。
- `dr-shell/tests/notifications.rs`：通知中心打开时读列着的，开着时进来的关上（Esc、开设置）时读，关着时进来的等下次打开。

**没验的。** 真实的 Hosted 服务（2026-11-20 从外面旁证过正式服务上公告接口在，没登录回 401；没有用真账号走过一遍）。真窗口里没看过这一行：现在没有通知中心的真窗口场景，F6 的离屏截图例子 `shell-capture` 在切到现行格式时删了，所以没有可以加公告的截图。窗口回到前台时读只在代码里：测试平台没有在前台的窗口，测试走的都是后台的间隔。

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
2. `next/app/drifting/src/main.rs`：在 `dr_view_sea::shell::init` 之前调用 `dr_view_account::init`，确保首次运行先出欢迎卡片再出 Markdown 文件夹卡片，并把当前会话令牌传给 `dr_view_feedback::Service::set_session`、账号邮箱传给 `set_account_email`（反馈对话框打开时先填它，2026-11-23）。
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
- `the_welcome_draws_with_its_consent_line`：欢迎卡画得出同意那一行；按「相关条款」立刻出卡，卡在这一行下面。
- `a_failed_library_swap_keeps_the_account_bar_on_the_open_library`：登录后换库被拒，账号栏和「设置 → 账号」仍是打开着的本地书库、弹出「没能切换书库」，里面的会话和 `libraries.json` 仍是新账号的；之后照同步监督的做法换库成功，账号栏跟上，且没有再启动偏好同步。
- `a_second_state_during_a_held_swap_waits_for_it_to_succeed` / `…_to_fail`：登录的换库还卡在释放书库时，又来一次同一账号的状态；账号栏照旧等着、不弹提示。放行后账号栏跟上、全程没有失败提示；拒绝后账号栏留在本地书库，只有第一次换库的那一条「没能切换书库」。
- `with_no_swap_pending_the_bar_shows_state_as_written`：没有在等换库时，直接写进 `Service.state` 的状态（不经 `apply_account_state`）账号栏照样显示，署名也跟着变。
- `consent::tests::every_language_splits_round_the_terms`：九种语言的同意句都恰好含一个占位，拆开再拼回与原句一致。

## 待协调

- 无阻塞项。M37 偏好同步与 M36 同步 v2 直接复用 `dr_account::AccountService` 的会话令牌与 `HostedClient`。
- **轨道 4（整合协调）**：`apply_account_state` 先更新账号展示，随后异步换库；换库失败或已有释放过程时，目前只记日志，旧库仍保留。请在后续会话状态接线时核对账号展示与实际打开书库的一致性及失败提示；本次没有据此认定数据丢失，也不扩成一轮界面复审。
  - **2026-11-20 修了最小的一版（作者定：照建议做最小的）。** 账号栏和「设置 → 账号」显示的是打开着的那个书库的账号（`dr_view_account::shown_account_state`：平时就是账号状态本身，只有在等换库时才留住开始等那一刻显示的账号，不另存一份常驻的副本）。`apply_account_state` 不用换库时立刻换过去；要换库时先不动，换成了才换；换库失败时账号栏留在原来的账号上，弹一条「没能切换书库」，日志照记。每次书库换完（包括同步监督 `app/drifting/src/sync.rs` 后来重试换成的那次），只要打开的书库正是账号要的那个，账号栏就跟上；跟上这一步不启动偏好同步。故意没做的：换库失败以后，账号模块里面的会话还是新账号的（令牌、资料缓存和 `libraries.json` 都不回滚），只是账号栏显示打开着的书库的账号；同步监督会一直重试换库，两者对不上时不启动同步。偏好同步照旧按里面的会话走。更大的那版改法（记一份「已生效」的账号状态、失败时回滚凭据、退出登录先换库）留在分支 `agy/shell-platform-playback-as-left`，没有采用。回归见 `dr-view-account` 的 `a_failed_library_swap_keeps_the_account_bar_on_the_open_library`。
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
- `next/crates/dr-view-account/src/`：`lib.rs`（全局服务、`WelcomeStep`、深链与实时换库）、`dialog.rs`（`AuthDialog` 四种认证流）、`consent.rs`（同意条款那一行和它的悬停卡）、`settings_view.rs`（`AccountSettingsView` 资料、头像与改密）。
- `next/crates/dr-shell/src/settings/registry.rs`：`terms_url()`、`privacy_url()`（构建时的条款链接）。
- `next/crates/dr-platform/src/deep_link.rs`：`auth/` 深链同时接受构建 scheme 与 `drifting://`。
- `next/app/drifting/src/`：`library.rs`（`open_active` 按 `libraries.json` 打开当前书库）、`main.rs`（接入 `dr_view_account::init`）。
