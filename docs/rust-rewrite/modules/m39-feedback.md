# M39 反馈与崩溃跟进

2026-11-08，客户端部分。计划见 [modules.md 的 M39](../modules.md)。由 F7 这一路做：请求和脱敏在 `next/crates/dr-platform/`（`feedback.rs`、`diagnostics.rs`、`sanitize.rs`），对话框是新 crate `next/crates/dr-view-feedback/`，外壳（dr-shell）只加了挂接点，应用入口注册一行。服务端那一半（存、发邮件给维护者）是托管服务早就有的接口，这里不动。

## 做了什么（大白话）

1. **能写反馈了。** 一个对话框：写你想说的话（多行，回车换行），留个回信邮箱（选填），下面一个开关「附上脱敏诊断摘要」，默认开着，点「预览」能看到要发的摘要原文。在写话的框里按 ⌘↩（Windows 上 Ctrl+Enter）或点「发送」就发出去；发完左下角是完成的墨印加「已发送」，只剩「关闭」。右上角的 ✕ 总能关；点对话框外面的雾，只有还没写字时才关，免得一下子丢了写的话（第三轮改的，和旧版一样）。
2. **发到哪儿，和旧版一模一样。** 有托管服务的正式版，发到服务端同一个接口（`POST /api/diagnostics/v1/feedback`，格式 `drifting.feedback` 第 1 版），登录了就带上会话；服务端收下后给维护者发邮件，回信地址是作者填的那个。没有托管服务的构建（公开源码默认就是）、开发构建、或者发送失败，都改成「用邮件发送」：打开作者的邮件程序，收件人 `support@drifting.cc`，正文就是同一段话、版本号，以及（附上的话）摘要。
3. **崩溃之后会问一句。** 上次崩溃并且报告已经发出去了，下次打开过两秒，通知中心里出现「上次出了故障」。点它打开同一个对话框：标题上方是故障时间，输入框提示「当时在做什么」，发出去的话会注明是哪一次崩溃。「忽略」把这条通知收掉；发出去也收掉；直接关掉对话框，通知还留着。每次崩溃只问一次。
4. **摘要里没有你的稿子。** 摘要只有版本、平台、芯片架构、同步的计数和错误代号、更新的状态，以及一段「隐私承诺」；没有正文、没有凭据、没有书名或任何 id、没有完整路径、没有原始错误文字。错误代号不是干净的标识符就换成 `redacted-error`。崩溃上报和这里共用一套脱敏规则，现在逐条照旧版来（见下）。
5. **应用打开库时带上了这台设备的身份**（监管会话同批交的另一件事，M07 的待协调 1）。写作日从此真正存进书目文档，见文末「设备身份」。

## 定下的事

### 照旧版的地方

- **接口、字段、校验全照 `services/diagnostics/feedback.ts`**：正文去掉首尾空白、最多 5000 字；邮箱选填，填了就必须是一个干净的地址（不能带空格、尖括号、逗号分号、反斜杠，顶级域两个字母以上，最长 254），挡住在地址里夹带邮件头；摘要只有确实是摘要格式的 JSON 才附；`kind` 是 `feedback` 或 `crash-follow-up`；字段名和顺序一样。
- **摘要格式不升版本**：`drifting.sanitized-diagnostics` 第 2 版，字段一个不少、顺序一样。新版还没有同步和在跑的更新服务，这两段先按旧版「本机库、更新空闲」时的值填（`authorityStatus: local`、`phase: idle`），以后同步和 M42 的更新服务接进来时填真实值（`SyncSnapshot`、`UpdateSnapshot`）。
- **诊断专用安装 id**：`diag-<随机 uuid>`，和同步的安装 id、写作日的设备键都无关；放在应用数据目录的 `diagnostics-installation-v1`，第一次发反馈时才生成（旧版也是用到才生成），不是一启动就写。
- **反馈不看「自动发送故障诊断」开关**：那个开关只管不问就发的崩溃报告；反馈是作者主动发的。
- **开发构建默认走邮件**：要对着本机的服务验收，设 `DRIFTING_CRASH_REPORTS_IN_DEV=1` 再加 `DRIFTING_DEV_API_BASE_URL=http://127.0.0.1:<端口>`（只在开发构建认）。正式版的服务地址只在构建时由 `DRIFTING_API_BASE_URL` 给，公开构建不设。地址只认 `https://`，`http://` 只认本机（`127.0.0.1`、`localhost`、`::1`）。

### 脱敏规则，逐条照旧版

`dr_platform::sanitize` 现在按 `crash-sanitize.ts` 的顺序做（之前 F7 只搬了后半段）：

1. `Bearer <令牌>` → `Bearer [redacted]`；`sk-…`/`sk_…` 形状的密钥、JWT → `[credential]`；`api_key=`、`access_token:`、`password=`、`secret`、`authorization` 后面的值 → `[redacted]`；
2. 邮箱 → `[email]`；网址保留路径，问号和井号后面 → `[redacted]`；
3. 家目录（`/Users` 或 `/home` 下面那一层，以及本进程自己的家目录，Windows 靠这条）→ `~`；
4. 连续 12 个以上的中日韩字符（连同中文标点）→ `[text]`；40 字以上的引号内容 → 引号里换成 `[text]`；连续 13 个以上的词 → `[text]`；
5. 空白压成一个空格，最长 300 字，超出用 `…` 截断。

另外 `report_token`（版本、平台、语言、指纹只留 `A-Z a-z 0-9 : . _ -`）和 `error_code`（摘要里的错误代号）也照旧版。崩溃上报（Sentry 的消息、异常值）自动用上了这套更全的规则。旧版单测里的例子逐个搬成了 Rust 单测，结果一致。

### 新版自己的地方

- **崩溃指纹**：旧版的 `related.kind` 只认 `render-failure` 和 `native-panic`。新版没有渲染层，崩溃都是原生的（Rust panic 或系统级崩溃），一律填 `native-panic`，不往服务端塞新值；`fingerprint` 填 `native-panic:crash:<崩溃 id>`，崩溃 id 就是 F7 打在 Sentry 事件上的 `drifting.crash_id` 标签，维护者按它在 Sentry 里找到那一次。`reportId` 填空（旧版 Sentry 送达时也是空）。
- **写话框和关闭，第三轮起和旧版一样**（第一版等 dr-ui 时用过单行框、去掉过 ✕，见待协调 1、2）：
  - 写话的是 F5 的带框多行输入（`TextArea::framed(5)`，和书架、Project Home 同一个样子），至少五行高（旧版的 `min-height`）。回车换行，⌘↩ 发送；回信邮箱框里回车什么都不做，和旧版一样。
  - 外壳用 F5 的 `Dialog::on_close` / `on_mist`：✕ 总能关；点雾只在写话框里没有字（只有空格、换行也算没有）且不在发送中时才关（旧版的 `closeOnBackdrop`）。发完以后话还在框里，所以点雾也不关，用「关闭」或 ✕。
- **发送中**：「取消」灰掉，Esc 和点雾都不关，和旧版一样；只有 ✕ 能关。发送中点 ✕，对话框立刻关掉，话照样发出去，发到了照样收掉崩溃跟进的通知（旧版也是这样：关掉的是界面，请求还在走）。收通知这一步因此放在发送任务里做，不靠对话框还在。

## 接口

```rust
// dr-platform（不依赖 GPUI）
dr_platform::sanitize::{message, report_text, report_token, error_code, redact_home};
dr_platform::diagnostics::summary(&SummaryInput::current(version)) -> String; // 带缩进的 JSON + 换行
dr_platform::diagnostics::installation_id(Some(data_dir)) -> String;           // diag-<uuid>，用到才建
dr_platform::feedback::problems(message, email) -> Vec<Problem>;
dr_platform::feedback::payload(&draft, &sender, now) -> Payload;               // drifting.feedback v1
dr_platform::feedback::Delivery::for_build(identity) -> Delivery;             // Hosted(Endpoint) | Email
dr_platform::feedback::send(&endpoint, session, &payload) -> Result<(), SendError>; // 阻塞，别在主线程
dr_platform::feedback::email_url(&draft, &sender, subject) -> String;         // mailto:
dr_platform::feedback::fake_service::FakeService;  // 测试用：127.0.0.1 上的假服务（test-support 特性）

// dr-view-feedback
dr_view_feedback::init(Service::for_build(identity, Some(data_dir), version), cx);
dr_view_feedback::Service::set_session(Some(token), cx);   // 账户模块（M36）登录后调
dr_view_feedback::FeedbackDialog;                          // 对话框本身（测试读它的状态）

// dr-shell 的挂接点
dr_shell::actions::SendFeedback;                     // 任何地方派发它就打开对话框
dr_shell::dialogs::set_feedback(cx, make);           // 注册对话框（同 pages::set_shelf 的做法）
dr_shell::dialogs::FollowUpNotice { notice, crash_id, at };
Workspace::open_feedback(follow_up, window, cx);
Workspace::dialog: Option<AnyView>;
```

## 改了外壳（dr-shell）的地方

F6 也在改 dr-shell，逐条列出，合并时好对：

1. **新文件 `src/dialogs.rs`**：注册「别的 crate 画的对话框」，现在只有反馈一个：`set_feedback`、`FollowUpNotice`、`Close`。照 `pages.rs` 的写法，没注册就什么都不开。
2. **`src/actions.rs`**：`workspace` 动作里加一个 `SendFeedback`（没有快捷键，不进快捷键注册表）。
3. **`src/lib.rs`**：`pub mod dialogs;`，模块说明加一行。
4. **`src/workspace/mod.rs`**：
   - `Workspace` 加字段 `pub dialog: Option<AnyView>`，`new` 里初始化为 `None`；
   - `covered()` 把对话框也算进去（对话框开着时，⌘W、切标签这些不作用到底下）；
   - 新方法 `open_feedback(follow_up, window, cx)`：先收起通知中心，再请注册的对话框画出来，交给它一个 `close`（清掉 `dialog`、焦点回到工作区）；
   - `on_actions` 里接 `SendFeedback` → `open_feedback(None, …)`；
   - 两处 `render`（平常的工作区和书架）各加一行 `.when_some(self.dialog.clone(), …)`，放在设置、搜索之后，Windows 标题栏按钮和通知中心之前；
   - `use` 里加 `SendFeedback` 和 `dialogs::{self, FollowUpNotice}`。
5. **`src/workspace/sidebar.rs` 的 `notification_center`**：带崩溃 id 的那一行（「上次出了故障」），文字部分可以点，点了 `open_feedback(Some(FollowUpNotice { … }))`；别的通知不变。书架上的铃铛用的是同一个函数，所以从书架点也行。`use` 里加 `crate::dialogs::FollowUpNotice`。

外壳原有的 `notifications::check_crash_follow_up`（F6 写的，开窗两秒后从 F7 取最新一次崩溃发通知）没改。

## 测试

- `dr-platform`：`sanitize`（旧版单测的例子原样搬来、密钥邮箱网址、令牌和错误代号）、`diagnostics`（字段和顺序与旧版一致、错误代号只留标识符、时间格式与 JavaScript 的 `toISOString` 一致、诊断 id 只建一次）、`feedback`（校验、载荷字段与旧版一致且不含稿件、附件和邮箱留空、崩溃跟进的 `related`、何时走邮件、`mailto:` 正文、对着本机假服务发出去：路径、`Authorization`、`Content-Type`、503 报错、没人听的端口算网络错误）。合计 dr-platform 单测 82 个。
- `dr-view-feedback/tests/dialog.rs`（GPUI 测试平台 + 本机假服务，7 个）：`SendFeedback` 打开、⌘↩ 发出、服务端收到的正文（带换行）和预览里的摘要逐字相同、带会话，发完点雾不关、点 ✕ 关；崩溃跟进发送失败（503）后改用邮件、邮件里有崩溃指纹、通知收掉；Esc 关掉通知还在、「忽略」收掉；写了字点雾不关、只有空格换行时点雾关；发送中点 ✕ 立刻关、话照样到了假服务、通知照样收掉；发送中 Esc 和点雾都不关，失败后点 ✕ 关、通知还在；空话（含只有换行）、坏邮箱时什么都不发；没有服务时直接交给邮件程序；没注册对话框时 `SendFeedback` 什么都不开。点雾、点 ✕ 都是真的鼠标点击（✕ 的位置随卡片高度变，测试从窗口顶上沿 ✕ 那一列往下点，碰到 ✕ 为止）。对话框和展开的摘要预览都真画了一帧。
- 全程不碰真服务：假服务只听 `127.0.0.1`，邮件程序是 GPUI 测试平台记下的网址。

还没做的验收：对话框在真窗口里的观感（字体、间距、玻璃）没截图，待作者看；对着真托管服务发一条要作者同意后再试。

## 待协调

1. ~~F5（dr-ui）：多行输入框~~：**已做**（F5 的 `TextArea`），第三轮换上了，见「新版自己的地方」。框现在是 F5 的 `TextArea::framed`（2026-11-08 由 M01 那一路和书架、Project Home 一起换过去，`dr-view-feedback` 不再依赖 `dr-view-shelf`）。
2. ~~F5（dr-ui）：对话框外壳分开「✕」和「点雾」~~：**已做**（F5 的 `Dialog::on_mist`），第三轮接上了。
3. ~~M01（书架账户菜单）和设置的「关于」：加「提交反馈」一项~~：**已做**（第十一批），两处都派发 `SendFeedback`。
4. **M36（账户）：登录后 `dr_view_feedback::Service::set_session(Some(令牌), cx)`，退出时传 `None`。** 回信邮箱默认填账户邮箱（旧版如此）也在那时加，对话框里留了 `contact_field()`。
5. **同步模块、M42（更新服务）：往摘要里填真实值**（`SummaryInput` 的 `sync`、`update`），设置 → 隐私的「复制摘要」到时也用 `diagnostics::summary`。
6. **M42（发布）：正式构建设 `DRIFTING_API_BASE_URL`**（和 `DRIFTING_SENTRY_DSN` 一样只在发布工作流里给）。不设，正式版的反馈也只走邮件。
7. **F6：** 外壳的改动见上一节（第三轮没再改外壳）；单行输入框 `set_text` 给带换行的字会 panic（GPUI 的 `shape_line`），调用方别传换行——反馈的写话框已换成多行框，不再涉及，记一笔给 F5/F6。

## 设备身份（M07 待协调 1）

- **做法**：`app/drifting/src/library.rs` 的 `open(data, version)`：`dr_store::Device::open(<应用本机数据目录>)` 放进 `LibraryOptions::device`，再在 `<数据目录>/library` 打开库。`main` 原来调 `Workspace::open_dir`，现在调它。
- **身份文件放哪**：应用本机数据目录，和 `library/` 同级、不在库里面：`sync-installation-v2.json`（和旧版同一个文件、同一个格式，交接后正式版身份找到的就是旧版那份，写作日里还是同一台设备）、`device-machine-v1.json`（这个身份属于哪台机器：macOS `IOPlatformUUID`、Windows `MachineGuid` 的加盐摘要，F2 已做）、`library-watermarks.json`。
- **开发 profile 隔离**：开发构建的数据目录是 `cc.drifting.next.dev`，永远不是正式版的；`cargo xtask dev` 在每个 worktree 设 `DRIFTING_PROFILE`，数据目录变成 `cc.drifting.next.dev.<profile>`，所以每个 worktree 各有一份设备身份，互不相同，也不和正式版共用。
- **身份读不出来时**（文件损坏，F2 不会自己改写它）：库照样打开，只是不带设备，写作日只数不存，日志里写明原因。不因为这个打不开书。
- **测试**：`app/drifting/src/library.rs` 三个单测——打开后 `writing_device()` 有值、等于这台设备的键、身份文件在数据目录而不在库目录、重开还是同一台；两个数据目录是两台设备；身份文件损坏时库照样打开、`writing_device()` 为空、坏文件原样不动。另外真机跑了一次：用临时 profile 启动应用，身份文件和机器绑定出现在该 profile 自己的数据目录、和 `library/` 同级，启动时不生成诊断 id；跑完删掉了这个临时 profile。

## 代码位置

```text
next/crates/dr-platform/src/
  sanitize.rs      脱敏规则（崩溃上报和反馈共用）
  diagnostics.rs   脱敏诊断摘要、诊断专用安装 id、ISO 时间
  feedback.rs      校验、载荷、送达方式、mailto、发送、本机假服务（测试用）
next/crates/dr-view-feedback/
  src/lib.rs       Service、init
  src/dialog.rs    FeedbackDialog
  tests/dialog.rs  对话框测试（GPUI 测试平台 + 本机假服务）
next/crates/dr-shell/src/dialogs.rs   挂接点（见「改了外壳的地方」）
next/app/drifting/src/library.rs      带设备身份打开库
```
