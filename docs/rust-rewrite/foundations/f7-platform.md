# F7 dr-platform 与发布

2026-11-07 起，分支 `claude/f7-platform-48c76d`。代码在 `next/crates/dr-platform`，打包脚本在 `next/script`，CI 在 `.github/workflows/next.yml`。计划见 [foundation.md 的 F7](../foundation.md#f7-dr-platform-与发布)。

## 大白话

新版要像一个正经装在电脑里的程序那样过日子：出错能留下日志，崩溃了能告诉维护者，记得住作者的登录和 API Key，点网页里的 `drifting:` 链接能跳进来，只开一个，能自己更新。这些都和界面无关，放在一个不依赖 GPUI 的 crate `dr-platform` 里，每一块都能单独测试。

这一轮做完了七件事里能在本机做的部分：

| 件 | 现在能做什么 | 还差什么 |
| --- | --- | --- |
| 日志 | 开发时打到终端；装好的版本每天一个日志文件，留 14 天；GPUI 只走 `log` 的报错也接住了 | — |
| 崩溃上报 | Rust 崩溃记下来、下次启动再送；原生崩溃由一个旁路进程抓 minidump 立刻送；正文和个人路径发送前抹掉；崩溃后的「你当时在做什么？」留好了接口。第三轮：发出去的包剥掉符号、符号单独留一份，本机假收件端上证明了剥过的程序报上来的崩溃能还原出函数名和行号 | 发版前配 DSN 和上传符号的密钥；F6 做同意开关和首次说明 |
| 钥匙串 | 用的就是旧版的存法，旧版写的登录和 API Key 新版直接读得到，新版写的旧版也读得到；Windows 长令牌自动拆开存 | — |
| 深链接与单实例 | 链接统一进一个队列，各取各的前缀；Windows 第二次启动把链接转给已开的那个再退出；开发版用 `drifting-next-dev:`，不抢正式版的链接 | F6 接上「来了链接就把窗口叫到前面」 |
| 打包 | macOS 出 `.app`、`.dmg`、更新包 `.app.tar.gz`；Windows 有 NSIS 安装器，安装位置、卸载项、注册表和旧版 Tauri 安装器一样，CI 里装一遍、升级一遍、卸一遍 | 签名、公证、预编译着色器（发版前） |
| 自动更新 | 读清单、比版本、下载、用现有公钥的格式验签、macOS 原地换包、Windows 交给安装器；本地用自造的密钥对和本地文件从头到尾走通了。第四轮（M42）：启动后和每 3 小时自动查、设置里手动查，查到就后台下好验好，通知中心「重启以更新」，退出时换；坏签名、旧包冒充新版本、半截下载、断网都拒绝并说清楚，全对着本机假服务测过 | 旧版最后一版改更新地址（设计已写，见 [m42-update.md](../modules/m42-update.md)）；签名正式包上的交接演练 |
| 外部 Agent 的命令行 | 新程序认旧版写进 Codex、Claude Code 配置里的 `drifting --mcp --connection <文件>`，在入口最先分流，不开窗口、不拿单实例锁 | M32 实现桥接（发 GPUI 版的前提） |
| 设备身份（第二轮） | 应用打开库时带上这台设备的身份（和旧版同一个身份文件，换了机器算新设备），写作日真正存下来；开发 profile 各有一份 | — |
| 反馈与崩溃跟进（第二轮，M39） | 反馈对话框，可附脱敏诊断摘要，走旧版的接口；崩溃后通知中心里点「上次出了故障」问一句；没有服务时交给邮件程序。脱敏规则补全成旧版的整套。第三轮：多行写话框，✕ 总能关、写了字点雾不关，和旧版一样。第四轮：摘要里的更新状态接上了 M42 | 登录会话、摘要里的同步状态（见 [m39-feedback.md](../modules/m39-feedback.md) 待协调） |
| 发布流水线 | 草稿 `next/script/release-next.draft.yml`，不会被触发 | 交接时补全 |

**最要紧的三个发现**：

1. **GPUI 自带的凭据接口读不到旧版的条目。** macOS 上它存的是「互联网密码」而旧版是「通用密码」；Windows 上它把条目名前面加了 `zed:url=`；它还必须在应用跑起来以后才能用（测试碰不到），macOS 上读的时候可能弹密码框。所以没用它，直接按旧版的格式读写系统钥匙串，旧版、新版来回切都不丢。计划原来写的是「用 GPUI 自带的凭据接口」，监管会话审旧架构时也得出同样结论（simplifications.md 第 14 条，见「待协调」1）。
2. **交棒要分两份清单，否则老用户会跳过「交接」。** 现在所有旧版都去读 `latest.json`。如果新版发布时直接把 `latest.json` 指向新版，还停在 alpha.10 这类老版本的人会直接装上新版，他们的库没经过交接，导入时会被拦下，而旧程序已经被替换掉了。办法是：新版用一份新清单 `update.json`；`latest.json` 从此永远指向旧版最后一版。老用户先升到旧版最后一版（它每次启动、退出、装更新前都会交接），再由它去读 `update.json` 换成新版（见「交接设计」）。
3. **TLS 换成和旧版一样的 ring。** Sentry 默认带的 aws-lc 在 Windows ARM 构建机上没验证过，旧版用 ring 在两台 Windows 构建机上一直能编，所以统一用 rustls + ring。

## 接口

`dr-platform` 不依赖 GPUI。`app/drifting/src/main.rs` 按这个顺序接上：

```rust
let args: Vec<String> = std::env::args().skip(1).collect();
if let cli::Launch::Mcp(connection) = cli::parse(&args) { … return }   // 外部 Agent，最先分流
probe::start();
let platform = dr_platform::Identity::current();          // 现在永远是开发身份
let dirs = dr_platform::AppDirs::for_identity(platform).ok();
let crash_reports = dr_platform::crash::init(CrashConfig::for_build(platform, dirs.as_ref(), version, commit, consent));
                                                           // 必须第一个：在崩溃上报子进程里它不返回
dr_platform::logging::init(&LogConfig::for_build(dirs.as_ref().map(|d| d.logs.as_path())));
let Some(instance) = dr_platform::single_instance::acquire(platform, &args).primary() else { return };
let library = library::open(&dirs.data, version);          // 另一个线程：带设备身份打开库（app/drifting/src/library.rs）
let deep_links = DeepLinks::new(platform.url_scheme);
deep_links.push_args(&args);                               // Windows：链接是命令行参数
instance.listen(move |args| deep_links.push_args(args));   // Windows：后来的进程转过来的
app.on_open_urls(move |urls| deep_links.push_all(urls));   // macOS
dr_shell::init(info, Services { deep_links, crash_reports, library, .. }, settings, cx); // 给 F6
dr_view_feedback::init(Service::for_build(platform, Some(&dirs.data), version), cx);     // M39
```

| 模块 | 给谁用 | 主要接口 |
| --- | --- | --- |
| `cli` | app、M32 | `cli::parse(args) -> Launch::{App, Mcp(Result<PathBuf, _>)}`；`MCP_USAGE`、`MCP_ERROR_PREFIX`（旧版的报错写法） |
| `identity` | 全部 | `Identity { channel, bundle_id, product_name, executable, url_scheme, keychain_service, publisher }`；`DEVELOPMENT`、`RELEASE`、`Identity::current()` |
| `paths` | F2、F6 | `AppDirs { data, logs, crashes }`；`AppDirs::for_identity`、`AppDirs::under(root)`（测试和隔离运行） |
| `logging` | app | `LogConfig::for_build`、`logging::init`、`logging::installed()` |
| `crash` | app、F6、F2 | `crash::init(CrashConfig) -> CrashReporting`；`.status()`、`.set_consent(bool)`、`.take_follow_up() -> Option<CrashFollowUp>`、`.report_integrity(code)`、`.flush(timeout)` |
| `sanitize` | 任何要上报文字的地方 | `sanitize::message`、`report_text(text, max)`、`report_token`、`error_code`、`redact_home`（规则逐条照旧版 `crash-sanitize.ts`） |
| `diagnostics` | M39、设置 → 隐私 | `diagnostics::summary(&SummaryInput) -> String`（`drifting.sanitized-diagnostics` 第 2 版）；`installation_id(data)`；`iso_time` |
| `feedback` | M39 | `problems`、`payload`、`Delivery::for_build`、`send`、`email_url`；`fake_service::FakeService`（`test-support` 特性，测试用的本机假服务） |
| `secrets` | M35 账号、M37 帮手、扩展 | `SecretStore::for_identity(id)`；`.get/.contains/.set/.delete`；`SecretStore::in_memory()` 给别的 crate 测试；`secrets::keys::*` 旧版的键名 |
| `deep_link` | F6、M35、跳转链接 | `DeepLinks::new(scheme)`；`.push_all/.push_args`、`.drain_matching("auth/")`、`.set_waker(f)` |
| `single_instance` | app | `acquire(identity, args) -> Instance::{Primary, Forwarded, ForwardFailed}`；`Primary::listen(f)` |
| `update` | M42（`dr-view-update`） | `UpdaterConfig::for_build(identity, version)`；`Updater::new(config, UpdateFetch::new(policy, ua, stall))`；`.check() -> Offer::{Newer, Current, Older}`、`.download(&available, dir, progress) -> Downloaded`（验签并核对签名里的版本；已下好的验过就复用）；`Downloaded::replace_bundle(bundle)`（macOS，还核对 App 自己的版本）、`.installer_launch(args)[.without_relaunch()].spawn()`（Windows）；`UpdateError::problem()`；`Downloads`（更新文件夹和两张便条）；`update::running_bundle()`；`HttpFetch`、`LocalFetch`；`fetch::fake_server`、`signature::test_keys`、`install::test_bundles`（`test-support`） |
| `relaunch` | M42 | `relaunch::after_exit(bundle)`（macOS：等本进程退出再 `open -n`，照旧版 `macos_relaunch.rs`）；`open_arguments` |

两个只给发布和自测用的小程序（`examples/`，不进正式包）：

- `update-tool`：`keygen`（造一次性测试密钥对）、`sign`（用 `TAURI_SIGNING_PRIVATE_KEY` 签名，和 `tauri signer sign` 一样）、`verify`、`manifest`（写或合并清单）、`apply`（用本地文件把一次更新完整走一遍，只认开发身份的包）。
- `crash-probe`：在本机走一遍崩溃上报：正常退出、Rust 崩溃、原生崩溃、下次启动的跟进。DSN 是本机关着的端口上的占位地址，什么也发不出去。

## 身份

| | 开发版（现在所有 `next/` 构建） | 正式版（交接以后，和 0.1 一样） |
| --- | --- | --- |
| bundle id | `cc.drifting.next.dev` | `cc.drifting.client` |
| 名字 | Drifting Next | Drifting |
| 可执行文件 | `drifting` | `drifting` |
| 链接协议 | `drifting-next-dev:` | `drifting:` |
| 钥匙串服务 | `Drifting.cc.drifting.next.dev` | `Drifting` |
| Windows 厂商键 | `drifting` | `drifting` |

**开发版的 profile**（[simplifications.md](../simplifications.md) 第 17 条）：开发版设了 `DRIFTING_PROFILE=<名字>`（小写字母、数字、`-`，最多 32 个字符），数据和日志文件夹、钥匙串服务、Windows 单实例锁都会加上 `.<名字>`，两个 worktree 的开发版就不会抢同一把锁、打开同一个库。链接协议是包注册的，不跟着变。正式版忽略这个变量。F8 的启动器给每个 worktree 设一个。

`identity.rs` 的测试拿 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 对正式版身份，拿 `script/bundle-mac` 和 `script/windows/drifting.nsi` 对开发版身份，并保证脚本里没有正式版的 bundle id。旧代码删掉以后，前一半测试要跟着改。

## 日志

| | macOS | Windows |
| --- | --- | --- |
| 文件 | `~/Library/Logs/<bundle id>/drifting.YYYY-MM-DD.log` | `%LOCALAPPDATA%\<bundle id>\logs\drifting.YYYY-MM-DD.log` |
| 何时写文件 | 从 `.app` 里运行时 | 可执行文件旁边有 `uninstall.exe`（装过）时 |
| 默认级别 | 文件：Drifting 自己的 crate `info`，其他 `warn`；终端（开发时）：`warn` | 同左 |

- 位置照两边的惯例，也和 Tauri 的 `app_log_dir` 同名。
- `DRIFTING_LOG` 改级别，写法是 `tracing` 的目标语法（`debug`、`warn,dr_platform=trace`）；装好的版本设了它也会同时打到终端。`DRIFTING_LOG_FILE=1` 让开发版也写文件。
- 每天一个文件，留 14 个；同步写入，不经后台线程，崩溃前最后几行不会丢。
- GPUI 的报错只走 `log`（P0-A 的坑 2）：`tracing-log` 把 `log` 的记录接进来，过同样的级别过滤。
- 代码：`crates/dr-platform/src/logging.rs`。P0-A 的 `app/drifting/src/logging.rs` 已删。

## 崩溃上报

### 什么时候发

只有三件事都成立才发（`crash::decide`）：

1. **构建时带了 DSN**：`DRIFTING_SENTRY_DSN` 只在构建时读（`option_env!`），仓库和 CI 都不设，所以现在所有构建都不发。发布工作流从 `vars.DRIFTING_SENTRY_DSN` 传进来。
2. **是正式版**：开发版要再设 `DRIFTING_CRASH_REPORTS_IN_DEV=1`（运行时），和旧版一样。
3. **作者同意了**：开关和首次说明归 F6；现在 `main.rs` 传 `false`。旧版是默认开、首次启动在欢迎卡最后一行说明（`preAlphaGuide.crashReports`），F6 照做时说明里要加一句「原生崩溃会带上崩溃时程序内存里的一小段」（见下）。

作者中途关掉：立刻生效，连旁路进程正在送的原生崩溃也拦下（给它的作用域打一个 `drifting.consent=off` 的标签，`before_send` 看到就丢）。中途打开：下次启动生效，因为旁路进程只能在启动时起。

### 抓什么

- **Rust 崩溃（panic）**：我们自己的 panic hook 总会把它记到 `crashes/pending/<id>.json`，不管开没开上报：消息先过 `sanitize`，带调用栈和当时加载的镜像列表（服务端拿符号文件还原函数名要用）。GPUI 的回调不能展开，panic 通常直接中止进程，当场发不出去，所以和旧版一样**下次启动再发**；没开上报就直接删掉。最多攒 20 条。
- **原生崩溃**（段错误、`abort`、访问冲突）：Sentry 官方的 `minidump` 特性。开了上报才有：启动时把同一个可执行文件以 `DRIFTING_CRASH_REPORTER` 再起一个「Drifting Crash Reporter」旁路进程，主进程崩溃时它写 minidump 并当场上传。minidump 里有崩溃线程的栈内存，可能夹着当时正在处理的一小段文字；这一点要写进同意说明。
- **完整性事件**：`report_integrity("database-open-failed:corrupt")` 这类固定代码，给 F2 用。

### 发出去的是什么

`before_send` 把每个事件重新过一遍：消息和异常文字过 `sanitize`（规则逐条照旧版 `crash-sanitize.ts`：令牌、密钥、JWT、`password=` 这类值、邮箱、网址参数先抹掉；家目录换成 `~`；连续 12 个以上的中日韩字、40 字以上的引号段、13 个以上连续单词换成 `[text]`；截到 300 字。第二轮补上了前面几条，见 [m39-feedback.md](../modules/m39-feedback.md)）；调用栈和镜像路径里的家目录换成 `~`；去掉主机名、用户、请求、`extra`、模块列表和面包屑；不开会话、性能追踪和日志。

### 崩溃后的跟进（给 F6）

每送出一个崩溃，`crashes/followups/` 里留一条 `{ id, kind: panic|native, occurred_at, app_version }`，`id` 同时是 Sentry 事件上的 `drifting.crash_id` 标签。F6 在启动稳定后调一次 `take_follow_up()`：拿到最新的一条，其余的丢掉，所以每次崩溃最多问一次，和旧版一致。通知是 F6 的 `check_crash_follow_up`；点通知打开反馈对话框、把 `id` 带进反馈是 M39（第二轮做了，见 [m39-feedback.md](../modules/m39-feedback.md)）。原生崩溃的「已送出」是乐观的：旁路进程开始上传时就记下了。

### 符号文件（第三轮本机做完，上传未配密钥）

- **发出去的构建用 `dist` 档案**（`next/Cargo.toml`）：继承 `release`，加 `debug = "line-tables-only"` 和 `split-debuginfo = "packed"`。macOS 上 cargo 在可执行文件旁边生成 `drifting.dSYM`，Windows 上是 `drifting.pdb`。`release` 档案本身不动，基准测试照旧用它（加了行号表编得慢一点、链接时多跑一次 `dsymutil`，不该算进别人的测量）。
- **`script/bundle-mac --dist`**：用 `dist` 档案编，把 `.dSYM` 复制到包旁边的 `Drifting Next.app.dSYM`（不进包、不进 `.dmg` 和更新包），包里的可执行文件 `strip -S -x` 剥掉符号，再查一遍剥过的可执行文件和 `.dSYM` 的构建 UUID 相同，最后照常 ad-hoc 签名。Windows 是 `bundle-windows.ps1 -BuildProfile dist`，打印 `pdb=<路径>`，安装器不带它。
- **上传**：发布工作流把 `Drifting Next.app.dSYM` 和 `target/<三元组>/dist/drifting.pdb` 交给 `sentry-cli debug-files upload`（草稿里写好了路径，命令仍是 TODO）。只用 `SENTRY_AUTH_TOKEN`（secret）和 `SENTRY_ORG` / `SENTRY_PROJECT`（vars），都在 `release` 环境里。
- **Sentry 怎么对上号**：事件里每个加载的镜像带构建 UUID（`debug_meta.images[].id`）和加载地址，每帧带指令地址；Sentry 按 UUID 找到上传的 `.dSYM`，用「指令地址 − 加载地址」查函数和行号。剥符号不改 UUID，所以剥过的程序发出的事件能用没剥的那份符号还原。下面的本机测试就是照这条路走的。
- 实测见「第三轮」。

### 本机验证

`crash-probe`（第一轮，手动）：

- 正常退出：旁路进程跟着起、跟着退，系统崩溃报告里没有它（Zed 遇到的 ⌘Q 崩溃没有出现，但见「发版前」4）。
- 原生崩溃：旁路进程接住，记下 `kind: native` 的跟进。
- Rust 崩溃：记录里的正文换成了 `[text]`，28 帧调用栈、389 个镜像；下次启动送出、删掉记录、给出一条跟进。

`dr-platform/tests/crash_report.rs`（第三轮，自动，跟着 `cargo test` 跑；只在 macOS 上，别的平台报「跳过」）：本机 `127.0.0.1` 上起一个假的 Sentry 收件端，DSN 由测试按这个端口现拼，不从任何地方读。崩溃的程序是测试可执行文件的一份副本，`strip -S -x` 剥过符号，和发出去的包一样：

1. 带一段正文 panic：记录落在 `pending/`，里面没有正文；
2. 再启动一次：收件端收到一个信封（`POST /api/1/envelope/`，`X-Sentry-Auth` 里是测试的 key），事件是 `fatal`、`release`、`build.commit` 对、`drifting.crash_id` 等于跟进记录的 id，没有 `server_name`、`user`，整个信封里没有正文、没有家目录，异常文字是 `probe panic at 7 quoting prose: [text]…`；
3. 符号：剥过的程序自己叫不出 `probe_panic`（没有一帧的函数名里有它）；事件里可执行文件那个镜像的 UUID 等于没剥的那份（`dwarfdump --uuid`）；`atos -o <没剥的> -l <事件里的加载地址> <事件里的指令地址…>` 还原出 `probe_panic`，在 `crash_report.rs:93`，正是 panic 那一行。

加 `-- --native` 再测原生崩溃（`abort`）：旁路进程当场把事件和 minidump（以 `MDMP` 开头）一起送到收件端，事件的 `drifting.crash_id` 等于旁路进程写的 `kind: native` 跟进，minidump 的模块表里有同一个构建 UUID。默认不跑，因为每次原生崩溃 macOS 都会在作者的「诊断报告」里留一份崩溃记录。本机跑过一次：Rust 崩溃的事件 18 帧，原生崩溃的 minidump 180 KiB；连原生崩溃在内，测试本身 5–6 秒跑完（不算编译）。

## 钥匙串

### 存法（和旧版一字不差）

| | macOS | Windows |
| --- | --- | --- |
| 条目 | 通用密码，服务 `<service>`，账户 `<键>` | 通用凭据，目标 `<键>.<service>`，用户名 `<键>` |
| 值 | UTF-8 | UTF-16LE；超过 1200 个 UTF-16 单元拆成 `<键>#<代>.<序号>`，头条写 `drifting-chunks:v1:<代>:<份数>:<sha256>` |
| 服务名 | 正式版 `Drifting`；其他 `Drifting.<bundle id>` | 同左 |

- 这是旧版用 keyring 3.6（`apple-native`、`windows-native`）写的格式（`src-tauri/src/secure_storage.rs` 和 `secure_storage/chunked.rs`）。拆分格式整段照搬，旧版拆开存的长令牌新版能拼回来，反过来也一样。
- 读的时候跳过需要授权的条目、不弹框，和旧版一样。苹果说这一条只对「数据保护钥匙串」有效，登录钥匙串里访问列表不含本程序的条目仍会弹框；正式版保持同一个 bundle id 和同一个 Developer ID 团队，访问列表认的就是这两样，所以交接后不会弹。
- 键名照旧版（`secrets::keys`）：Hosted 会话 `drifting.hosted.v1.<API 源的 sha256>`；API Key `byok.<厂商>`（含语音用的 `byok.dashscope`），旧的帮手 Anthropic 键 `byok.agent.anthropic`；ChatGPT 订阅 `oauth.openai-codex`；扩展密钥 `drifting.mcp.…`；`sync.` 和 `oauth.` 开头的只给原生代码。
- 为什么不用 GPUI 的接口：见开头「最要紧的三个发现」1。
- 实现：macOS 直接调 Security 框架的 `SecItem*`（用 GPUI 已经在用的 `objc2-security`，不多一个 crate，读的写法和旧版用 `security-framework` 的那段一样），Windows 直接调 `CredReadW` / `CredWriteW`（GPUI 已在用的 `windows` 0.62），按 keyring 3.6 的格式读写；keyring 本身只作为测试依赖，扮演旧版。
- 没搬的：`NATIVE_ONLY_SECRET_PREFIXES`（`sync.`、`oauth.` 不让渲染层读）和 `local_lab_session`（调试用的本地假钥匙串）都只是挡 WebView 的，新版没有渲染层，不需要。

### 测试

- 平时跑的：键名规则、服务名规则、拆分格式（模拟 Windows 2560 字节上限：长令牌往返、宽字符、换代不留残片、写到一半失败保留旧值、缺片或被改直接报错、读旧版拆的）。
- 碰真钥匙串的三项（`tests/keychain.rs`，默认忽略）：**只用一次性的服务名 `Drifting.test.<随机>`**，绝不读、列举或改动作者的条目，结束时删干净。用 keyring 3.6 扮演旧版：旧版写、新版读；新版写、旧版读、改、删；9000 字的长令牌往返。macOS 本机跑过，三项都过；Windows 要在虚拟机或 CI 里手动跑：

  ```bash
  cargo test -p dr-platform --test keychain -- --ignored
  ```

## 深链接与单实例

| | macOS | Windows |
| --- | --- | --- |
| 协议注册 | `Info.plist` 的 `CFBundleURLTypes`（`bundle-mac` 写） | 安装器写 `HKCU\Software\Classes\<协议>`（GPUI 在 Windows 上注册不了） |
| 链接怎么进来 | GPUI 的 `on_open_urls` | 命令行参数 `drifting.exe "<链接>"` |
| 只开一个 | Launch Services 本来就管 | 互斥量 `Local\<bundle id>.instance`；后来的进程经命名管道 `\\.\pipe\<bundle id>.instance.<会话号>` 把参数转给先开的，然后退出 |

- **开发版的协议是 `drifting-next-dev:`**，正式版是 `drifting:`。开发版的包在本机打开后，Launch Services 只会把 `drifting-next-dev:` 交给它，作者装着的正式版照常收 `drifting:`。
- 链接全进 `DeepLinks` 队列：只收本协议的、8 KiB 以内、不含控制字符的；最多排 64 条；消费者按前缀取，`auth/` 给登录、`open/` 给跳转，和旧版的 `DeepLinkQueue` 一样。链接里可能有一次性登录码，所以日志只记条数。
- 命名管道：只收本机连接，用默认安全描述（只有本用户、管理员和 SYSTEM 能写），创建时带 `FILE_FLAG_FIRST_PIPE_INSTANCE`，别的进程抢不了名字；消息是不超过 64 KiB 的 JSON。后来的进程先调 `AllowSetForegroundWindow`，让先开的那个能把窗口提到前面。
- **不带窗口的启动不经过这里**：外部 Agent 用 `drifting --mcp --connection <文件>` 调这个可执行文件（[simplifications.md](../simplifications.md) 第 15 条，见下一节）。它在 `main` 的第一行就分流，不起崩溃上报的旁路进程、不拿单实例锁、不开窗口；否则 Windows 上它会被当成第二次启动，把参数转给窗口然后退出。
- 思路照 Zed 的 `windows_only_instance.rs`，那个文件是 GPL，只看了思路，代码是自己写的。
- Windows 部分本机只能 `cargo check --target x86_64-pc-windows-msvc --no-default-features`（带网络特性时 ring 的 C 代码在 Mac 上交叉编不了），clippy 也过了；真跑要等 CI 或作者的虚拟机。

## 外部 Agent 的命令行（MCP）

旧版把这条命令写进了作者 Codex、Claude Code 的配置（`src-tauri/src/mcp_server.rs` 的 `describe`，第 418 行起；搬家时用 `client_config::relocate` 改写，第 379 行起）：

```text
<可执行文件的绝对路径> --mcp --connection <应用数据目录>/mcp/connection-<id>.json
```

- 可执行文件路径交接后不变：macOS `…/Drifting.app/Contents/MacOS/drifting`，Windows `<安装目录>\drifting.exe`（正式版身份和安装器保证）。
- 参数规则照旧版 `run_stdio_cli`：第一个参数是 `--mcp` 才算；恰好是 `--mcp --connection <文件>` 时进桥接，其他写法报 `Usage: Drifting --mcp --connection <connection-file>`；所有错误都写成 `Drifting MCP: <原因>` 打到 stderr、以 1 退出。`dr_platform::cli` 实现了这套解析（有测试），`app/drifting` 的 `main` 在第一行分流，桥接本身 `run_mcp_bridge` 现在只返回「这个版本还没有 MCP 桥接」，由 M32 实现：读连接文件（`version: 1`）、连运行中的 Drifting、转发帧，和旧版 `local::cli` 一致。
- 本机冒烟：开发构建 `drifting --mcp --connection <不存在的文件>` 和 `drifting --mcp` 都立刻在 stderr 报错、以 1 退出，没开窗口、没留进程。
- 连接文件放在应用数据目录的 `mcp/` 下，正式版身份和旧版共用这个目录，M32 照旧版格式读即可；桥接要连的是一个开着的 Drifting，所以 Windows 上关窗后程序是否还在（见「Windows 托盘」）直接影响外部 Agent。
- Windows 正式包如果用 GUI 子系统（不弹控制台），被 Agent 以管道启动时标准输入输出照样能用，旧版就是这样；F6 加 `windows_subsystem` 时保持这一点。

## 退出时能做多少

- GPUI 在 macOS 只接了 `applicationWillTerminate`，`on_app_quit` 的回调总共只等 200 ms（`gpui/src/app.rs` 的 `SHUTDOWN_TIMEOUT`），而且 `app.run` 在 macOS 上不返回，`main` 里的变量不会被析构。退出时不能指望做重活。
- 对 F7 的影响：
  - **日志**：同步写，没有要冲的缓冲。
  - **崩溃上报**：panic 记录本来就落盘、下次启动再发，不受影响；运行中排队的事件（完整性事件、启动时补发的 panic）要在 F6 的退出回调里调 `CrashReporting::flush(Duration::from_millis(100))`，冲不完就丢，不重试。
  - **更新**：下载、验签、换包都在作者点「安装并重启」之后、发起退出之前做完；重开用的等待进程（等本进程退出后 `open -n <包>`，照旧版 `macos_relaunch.rs`）也在退出前起好。Windows 先 `InstallerLaunch::spawn` 再退出，安装器自己等旧进程退干净。
  - **单实例**：互斥量和管道由系统在进程结束时回收。
- 旧版退出前的刷新屏障（保存正文、交接、同步）要等几秒（原生总时限 5 s），新版的对应步骤（F2、F3）不能放进 `on_app_quit`，要由 F6 在发起退出之前自己跑完，再调 `cx.quit()`。这一条写进「待协调」。

### 导入中途退出等多久（M10 待协调 19，第三轮定）

M10 问：导入旧库时按 ⌘Q，退出钩子先请导入写完这本书、最多等 3 秒（`QUIT_WAIT_BOOK`），写不完就立刻停、再最多等 2 秒（`QUIT_WAIT_NOW`），一共最多 5 秒，要不要缩短。

**定：缩短到各 1 秒，一共最多 2 秒。** 请 M10 把两个常量都改成 `Duration::from_secs(1)`，m10-import.md 里「3 秒」「2 秒」的说法跟着改。

理由：

1. **等的时候窗口是冻着的。** 退出钩子在主线程上、`cx.quit()` 之前跑（dr-shell `quit::run`），这段时间窗口还在屏幕上，不重画、不响应点击。按了 ⌘Q 之后五秒没动静，看起来就是卡死了，作者多半会强制退出。
2. **多等换不来什么。** 立刻停下不丢东西：停下的那本书在回执里记 `importing`，下次再导这个库会接着导完，结果和一次导完逐字节相同（M10 的测试比过）。多等只是让这本书这次就完整，少一次「下次接着导」。
3. **3 秒本来也只够小书。** M10 第四个里程碑的实测（release，M3 Pro）：样书整库连拷贝和建索引约 1 秒；重型书光写正文、存库、资源文件就要约 2.9 秒（0.97 + 1.07 + 0.85），3 秒也不一定等得完。1 秒能等完大多数普通书的剩余部分；重型书两种设置下都会落到「立刻停」。调试版导重型书要几十秒，基本都会立刻停，这不要紧（见第 2 条）。
4. **立刻停 1 秒绰绰有余。** 「立刻停」在两篇正文之间、两个资源文件之间检查：写一篇正文约 1.6 ms（1.07 s / 679 篇），一个资源文件约 24 ms（0.85 s / 36 个，每个都落盘同步），1 秒是最慢一步的四十倍。万一还没停下，钩子记一条错误就照常退出；这和崩溃、系统直接结束进程一样安全：SQLite 事务回滚，回执里是 `importing`，下次接着导（M10 测过）。
5. **和别处的时限对齐。** GPUI 自己给退出回调 200 ms；F3 的 `Workspace::before_quit` 关文档是毫秒级。2 秒是这一串里唯一长的一段，只在导入正在跑时才会出现。

另外建议 F6（不急）：退出流程可以先把窗口藏起来（`cx.hide()`）再跑钩子，这样哪怕等 2 秒，作者看到的也是「已经退了」。

## Windows 托盘

旧版 `windows_tray.rs`：在 Windows 上关掉书架窗口只是藏起来，程序留在通知区，后台的帮手和同步接着跑；点图标或再启动一次就回来，菜单里「退出」才真正结束（和 macOS 关窗后留在 Dock 一样）。GPUI 的 Windows 后端没有托盘。

**建议：做，用 `tray-icon` crate（0.26，MIT/Apache-2.0，Tauri 底下用的就是它），归 F6，在阶段 2 写作闭环里补上。**

- 理由：外部 Agent 的 MCP 桥接、后台帮手和同步都要一个开着的程序。不做托盘，Windows 上关掉窗口就等于退出，外部 Agent 连不上，作者会以为 MCP 坏了；和 macOS 的行为也不一致。
- 做法：在主线程（GPUI 跑 Win32 消息循环的那个线程）建托盘图标，它靠同一个消息循环收消息；菜单点击从 `tray-icon` 的事件通道读，用一个 GPUI 前台任务转进应用。菜单两项「打开 Drifting」「退出 Drifting」，文案跟界面语言。
- 和 F7 的接口：第二次启动转来的参数（`single_instance`）要能把藏起来的窗口叫回来，这和托盘的「打开」走同一个动作。
- 在托盘做好之前，保持 P0-A 的行为：Windows 上关掉最后一个窗口就退出。

## 打包

### macOS

```bash
script/bundle-mac [--debug] [--dmg] [--archive]
```

- `.app`：P0-A 的做法，加上 `CFBundleURLTypes`（`<bundle id> <协议>`，和旧版的 `cc.drifting.client drifting` 同一写法），可执行文件的最低系统版本用 `MACOSX_DEPLOYMENT_TARGET=13.0` 和 `Info.plist` 对齐。
- `--dmg`：`<名字>_<版本>_macos_arm64.dmg`（和已发布的 DMG 同一种命名），里面是 App 和一个指向「应用程序」的链接；不签名、不公证；打完 `hdiutil verify`。
- `--archive`：更新包 `<名字>_<版本>_<架构>.app.tar.gz`，顶层只有一个 `.app` 文件夹，不带 AppleDouble 和扩展属性。Tauri 的更新器和我们的都会去掉顶层文件夹名、把内容换进已装的包里。
- 正式包还差：Developer ID 签名（加 hardened runtime）、公证并 staple、DMG 本身签名公证、正式版身份、预编译 Metal 着色器（见「发版前」）。

### Windows（NSIS）

```powershell
script/bundle-windows.ps1 [-BuildProfile release|debug] [-Target <triple>] [-SkipBuild]
```

`script/windows/drifting.nsi` 自己写的（没套 Tauri 的模板，参考了它写了哪些键），每一项都对着旧版 Tauri 安装器（`tauri.windows.conf.json`：`installMode: currentUser`，中英两种语言）：

| 项 | 值 |
| --- | --- |
| 权限 | 当前用户，不要管理员 |
| 安装位置 | `%LOCALAPPDATA%\<名字>`；之前装过（不管是 Tauri 装的还是我们装的）就用 `HKCU\Software\drifting\<名字>` 记下的那个 |
| 文件 | `drifting.exe`、`uninstall.exe` |
| 卸载项 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<名字>`：DisplayName、DisplayIcon、DisplayVersion、Publisher、InstallLocation、UninstallString、QuietUninstallString、MainBinaryName、NoModify、NoRepair、EstimatedSize、主页 |
| 协议 | `HKCU\Software\Classes\<协议>`，打开命令 `"<目录>\drifting.exe" "%1"` |
| 快捷方式 | 开始菜单 `<名字>.lnk`；安静/被动模式或完成页勾选时加桌面快捷方式；更新时不动已有的（保住作者的固定） |
| 参数 | `/S` 静默、`/P` 被动、`/UPDATE`、`/R` 装完启动、`/ARGS`、`/NS`、`/D=`，和 Tauri 更新器传的一样 |
| 正在运行 | 等旧进程退出（最多 10 秒）；被动/静默模式再结束本用户的同名进程，交互模式让作者点「重试」 |
| 卸载 | 删程序、快捷方式和上面这些键（协议只在还指向这里时删）；作者的库（`%LOCALAPPDATA%\<bundle id>`）和日志不删 |
| 签名 | alpha 期间不签（D10） |

CI（`next.yml` 的 Windows 任务，`script/check-windows-installer.ps1`）：用 debug 可执行文件打安装器，在构建机上静默安装到默认位置，逐项查文件、卸载项、厂商键、协议和开始菜单；再用 Tauri 更新器的参数 `/P /UPDATE` 装一遍；卸载后确认键都删了；最后预先写好厂商键再装，确认会装进记下的目录。本机没有 NSIS，这一段只有 CI 能验。

### CI 里新加的

- macOS：`bundle-mac --debug --dmg --archive`；用 `update-tool` 造一次性密钥对、签更新包、验签；挂上 DMG 查 App、「应用程序」链接和封签。
- Windows：上面的安装器检查。
- `actionlint`（带 shellcheck）通过，`node scripts/check-ci-contract.mjs` 照旧通过。没推送，CI 本身没跑过。

## 自动更新

### 格式（沿用旧版）

- 清单是 Tauri 的格式：`version`、`notes`、`pub_date`（RFC 3339，Tauri 读不了别的写法）、`platforms.<os>-<arch>.{url, signature}`；`<os>-<arch>-<bundle>` 的键优先。
- 签名是 minisign，按 Tauri 的包法：公钥和每个 `.sig` 都是 minisign 文本再做一次 base64。
- **公钥不在仓库里**，是 GitHub 仓库变量 `vars.DRIFTING_UPDATER_PUBLIC_KEY`；旧版在构建时用 `option_env!("DRIFTING_UPDATER_PUBLIC_KEY")` 编进去，新版用同一个变量名、同样的写法。没有它的构建（所有本地和 CI 构建）不能更新。
- 签名私钥也沿用 `secrets.TAURI_SIGNING_PRIVATE_KEY`（加密码），`update-tool sign` 读的就是 Tauri 的私钥格式。

### 新版自己怎么更新

1. `check`：读 `update.json`，只认比自己新的 SemVer 版本（预发布按 SemVer 排），一样的是 `Offer::Current`、更旧的是 `Offer::Older`，都不下载；正式版只收 HTTPS 地址；重定向不能离开 HTTPS。
2. `download`：边下边写到 `.partial`，最多 512 MiB，带进度；写完按流验签（要求预签哈希的 `ED` 签名，比 Tauri 严格，Tauri 签出来的都是这种），**再核对签名的受信注释里的文件名带着清单说的版本**（第四轮，防旧包冒充新版本号，见 [m42-update.md](../modules/m42-update.md)「降级」）；验不过就删掉，不留文件。连接中途断了、停 60 秒没动静、比服务器说的长度短，都算中断（第四轮），同样删掉。同一个版本已经下好的文件，重新验过就复用。
3. 安装：
   - macOS：在包旁边解压（同一个卷，改名是原子的），查 `Info.plist` 的 bundle id 和可执行文件，然后旧包挪开、新包挪进、删旧包；任何一步失败都把旧包放回去。拒绝绝对路径、`..`、多个顶层项、经由包里自带的符号链接写出去的项。目录不可写（标准用户的「应用程序」）时返回「需要管理员」，什么也不改（旧版会弹 AppleScript 要密码，这里先不做，见「待协调」）。之后由 F6 走正常退出、再用 `open -n <包>` 重开，和旧版 `macos_relaunch.rs` 一样。
   - Windows：用 Tauri 的参数 `/P /R /UPDATE /ARGS …` 启动安装器，然后退出。
4. 什么时候查、界面怎么提示、什么时候装：M42（第四轮，`dr-view-update`）。启动后 10 秒、之后每 3 小时（`update::CHECK_INTERVAL`，旧版的值）、设置里手动；查到就下，退出时装。

开发版默认不更新；设了 `DRIFTING_DEV_UPDATE_MANIFEST` 和 `DRIFTING_DEV_UPDATER_PUBLIC_KEY` 才会，而且只有开发版能读本地文件和本机的 `http://127.0.0.1` / `localhost` / `[::1]`（第四轮，`UrlPolicy::AllowLocal`）。

### 本机端到端

- 单元测试：自造密钥对，把一个合成的 `.app` 打成更新包、签名、写清单（`file://` 地址），走完查、下、验、换；另有篡改过的包、别的密钥签的包、别的 App 的包、同版本和旧版本、`http://`、`file://` 在正式策略下、空签名、坏 JSON、坏版本号。第四轮加了 `127.0.0.1` 上的假 GitHub Releases（`fetch::fake_server`）：本机 HTTP 走完一遍、截断、停滞、连不上、503、旧包冒充新版本号、重开后复用。
- 真包演练：`bundle-mac --archive` 打出的真更新包，`update-tool sign` 用一次性密钥签，`update-tool manifest --local` 写本地清单，`update-tool apply` 把它装进一份复制出来的 `Drifting Next.app`：旧包里多放的文件没了，换上的包 `codesign --verify --strict` 通过。全程没访问正式发布地址、没下载正式安装包。

## 交接设计

目标：已经装着 Tauri 版的人，什么都不用做，就变成 GPUI 版，书、设置、登录、API Key、`drifting:` 链接、开始菜单固定都还在。

### 保持不变的

| 东西 | 为什么要不变 |
| --- | --- |
| bundle id `cc.drifting.client` | Launch Services、钥匙串访问列表、麦克风等权限、数据文件夹 `~/Library/Application Support/cc.drifting.client`、日志文件夹都认它 |
| Developer ID 团队 | 钥匙串条目的访问列表认「bundle id + 团队」；换了团队，读登录和 API Key 会弹框 |
| `Drifting.app`、可执行文件 `drifting` | 旧更新器原地换包，换完用 `open -n` 重开 |
| Windows 安装位置、卸载项、厂商键 | 新安装器装进同一个目录、改写同一个卸载项，「应用和功能」里还是一个 Drifting |
| `drifting:` 协议 | 网页登录回调、跳转链接 |
| minisign 公钥和私钥 | 旧更新器只认这把钥匙签的包 |
| 钥匙串服务名 `Drifting` 和键名 | 新版直接读旧条目，不用搬 |
| 外部 Agent 的命令 `drifting --mcp --connection <文件>` | 已经写在作者的 Codex、Claude Code 配置里；可执行文件路径和参数都不能变，M32 实现桥接（见「外部 Agent 的命令行」） |

### 两份清单

| 文件 | 谁读 | 指向 |
| --- | --- | --- |
| `latest.json` | 旧版最后一版以前的所有 Tauri 版本（地址写死在它们里面） | 旧版最后一版。之后每次发新版都把这份原样再挂上（`releases/latest/download/` 总是指最新的那次发布） |
| `update.json` | 旧版最后一版、所有 GPUI 版本 | 最新的 GPUI 版 |

### 顺序

1. **发旧版最后一版（0.1.x）**：
   - 带上交接（已在 `main`，`src/renderer/services/v2-handoff`，见 `docs/v2-handoff.md`）：每次启动 20 秒后、每次退出、以及装更新之前（`update-service.ts` 在调原生安装前先跑 `flushLocalApplicationPersistence`，里面有交接这一步）都会把每篇正文从 Yjs 誊进缓存、在 `library_state` 记清单；
   - 改一处：`src-tauri/src/app_update.rs` 的更新地址从一个改成两个，先 `update.json` 后 `latest.json`（Tauri 的更新器依次试，前一个 404 就用后一个；GPUI 版发布以前 `update.json` 还不存在）。
   - 它自己的 `latest.json` 照常指向它自己。
2. **等**：让大多数人升到旧版最后一版，跑过至少一次交接。
3. **发第一个 GPUI 版（0.2.0）**：正式版身份、签名公证、同一把 minisign 钥匙；挂上 `update.json`（指向 GPUI 的包）和原样的 `latest.json`（仍指向旧版最后一版）。
4. **旧版最后一版发现 0.2.0**：作者点「安装并重启」→ 交接（刷新屏障里）→ Tauri 更新器验签 →
   - macOS：把 GPUI 的 `.app.tar.gz` 解开换进 `Drifting.app` → `open -n` 打开 GPUI 版；
   - Windows：用 `/P /R /UPDATE /ARGS` 跑 GPUI 的安装器 → 装进同一个目录 → 启动 GPUI 版。
5. **GPUI 版第一次启动**：发现旧库和交接清单，M10 导入（P0-E），钥匙串直接读。
6. **外部 Agent**：配置里的命令原样指向新的可执行文件，新程序认 `--mcp --connection`；连接文件的格式和位置照旧（M32）。M32 没做完以前不能发 GPUI 版，否则交接后外部 Agent 会断。

**跳过了旧版最后一版的人**（手动下了 0.2.0 的 DMG 或安装包）：导入时按 P0-E 默认拦住、给「仍然导入」。这时旧程序已经被换掉了，提示里的「用旧版最后一版打开一次」要给出旧版最后一版的下载链接（M10，见「待协调」）。

**旧更新器装新包的几处细节**（读的是 `tauri-plugin-updater` 2.10.1，旧版用的版本）：

- macOS：它要求更新包只有一个顶层文件夹，名字不要紧；目录不可写时它会弹 AppleScript 要管理员密码。装完它 `touch` 一下包。
- Windows：默认安装模式是 passive，传 `/P /R /UPDATE /ARGS <它自己的参数>`；用 `ShellExecuteW` 打开安装器后立刻退出进程，所以新安装器必须自己等旧进程退干净（已做）。
- 两边都用 `allow_legacy = true` 验签，新签名（`ED`）它照收。

## 发布流水线

`release.yml` 是为 Tauri 写的，不动。新版的草稿是 `next/script/release-next.draft.yml`：放在 `.github/workflows` 外面，GitHub 不会跑它。里面有 verify、macOS（证书导入、着色器、打包、签名公证、minisign 签名、符号上传、写 `update.json`、带上 `latest.json`、建草稿 Release）、Windows 两个架构（打包、minisign 签名、PDB 上传、在构建机上装一遍），没做完的步骤都标了 TODO。它沿用 `release.yml` 的全部变量和密钥，只新加 `vars.DRIFTING_SENTRY_DSN` 和 Sentry 上传用的三项。

## 发版前必须由作者做的事

1. **装 Metal Toolchain**（`xcodebuild -downloadComponent MetalToolchain`），然后让正式包关掉 GPUI 的 `runtime_shaders`、预编译着色器。我没装，按要求留给作者。
2. **在 Sentry 建好客户端项目**，把公开的 DSN 放进仓库变量 `DRIFTING_SENTRY_DSN`；上传符号用的 token 放进 `release` 环境的 secret。旧的 `drifting/drifting-client` 项目可以复用。
3. **确认 Developer ID 证书和团队与旧版相同**（钥匙串和权限都认它）。
4. **开上报前在签名的正式包上验一次 ⌘Q**：`crash-context` 0.6.3（sentry-minidump 依赖的版本）里有 Zed 遇到的同一个 bug（[minidump-writer#249](https://github.com/rust-minidump/minidump-writer/pull/249)：旁路进程释放端口的方式不对，⌘Q 时可能报「意外退出」）。本机未签名的探针正常退出时没有触发；如果正式包触发了，就给 `crash-context` 0.6 打补丁或等 sentry-minidump 升级。顺带验一下 hardened runtime 下旁路进程还能读崩溃进程的内存。
5. **在 Windows 虚拟机上**：装开发版安装器、`drifting-next-dev:` 链接拉起和转发、第二次启动只出一个窗口、真钥匙串测试（上面那条命令）。
6. **旧版最后一版**：改更新地址（见交接第 1 步）并发布，等一段时间再发 GPUI 版。

## 待协调

1. **计划改动（监管会话定）**：`foundation.md` 和 `research.md` 写的「凭据用 GPUI 自带的接口」改成「沿用旧版格式，自己读写系统钥匙串」，理由见开头。`main` 上监管会话已经同样定了（[simplifications.md](../simplifications.md) 第 14 条，写的是「沿用 keyring」）；合并时我把 `foundation.md` F7 一节的那一句改成了实际做法：直接调系统接口按 keyring 的格式读写，keyring 只在测试里扮演旧版。
2. **F6**：
   - 崩溃上报的同意开关（默认开）和首次说明，`set_consent`（`take_follow_up` 已接通知中心，反馈对话框第二轮做了）；
   - `DeepLinks::set_waker` 接到主线程：来了链接就把主窗口叫到前面、按前缀分发；
   - ~~更新界面（M42）：定时检查、下载进度、装完的重开~~：**第四轮 M42 做了**（`dr-view-update`，外壳只加了设置一行的挂接点）。剩下 macOS 目录不可写时要不要跟旧版弹 AppleScript 要密码，挪到 [m42-update.md](../modules/m42-update.md) 待协调 1；
   - Windows 上调 GPUI 的 `set_app_identity(bundle id, 名字)`，让通知和任务栏归到同一个应用；新装的开始菜单快捷方式没带 AppUserModelID（NSIS 不带插件做不到），更新时保留旧快捷方式所以不受影响。
3. **F2**：正式版和旧版共用数据文件夹 `~/Library/Application Support/cc.drifting.client`（Windows `%LOCALAPPDATA%\cc.drifting.client`），新库放进自己的子文件夹，旧文件一个都不写。`crashes/` 已被 F7 占用。完整性事件用 `report_integrity`。
4. **工作区（监管会话定）**：`runtime_shaders` 现在写在 `[workspace.dependencies]` 的 `gpui_platform` 上，所有成员都开着。正式包要关掉它，得改成各可执行文件自己的默认特性（发布时 `--no-default-features`）。动的是共用的 GPUI 依赖行，我没改。
5. **M32**：入口的分支已留好（`dr_platform::cli` + `main` 的 `run_mcp_bridge`），M32 实现桥接；它是发第一个 GPUI 版的前提。
6. **F6 的退出流程**：GPUI 的退出回调只有 200 ms，保存、交接、同步要在调 `cx.quit()` 之前跑完；退出回调里只调 `CrashReporting::flush(100 ms)`。Windows 托盘建议用 `tray-icon`（见「Windows 托盘」）。
7. **F8**：启动器给每个 worktree 设 `DRIFTING_PROFILE`。
8. **M10**：没交接的库被拦下时，提示里给旧版最后一版的下载链接（旧程序已经被替换了）。
9. **正式版身份怎么切换**：建议交接时给 `dr-platform` 加一个 `release-identity` 特性，只有发布工作流开它，`Identity::current()` 据此返回 `RELEASE`；`bundle-mac` 和 `bundle-windows.ps1` 加对应开关。现在照 `AGENTS.md` 不做。
10. **`next/README.md`**：改了「开发开关」表的 `DRIFTING_LOG` 一行，加了 `DRIFTING_LOG_FILE`、`DRIFTING_PROFILE`、`DRIFTING_CRASH_REPORTS_IN_DEV`、两个开发更新变量，和打包一节的 `--dmg`、`--archive`、Windows 脚本，以及目录表。
11. ~~**M10（第三轮）：导入中途退出的等待改成各 1 秒**~~：**M10 已改**（`dr-view-import/src/flow.rs` 的 `QUIT_WAIT_BOOK`、`QUIT_WAIT_NOW` 现在都是 1 秒）。理由见「退出时能做多少 → 导入中途退出等多久」。
12. ~~**F6（第三轮，不急）**：退出流程先藏窗口（`cx.hide()`）再跑退出钩子~~：**F6 第八轮做了**（`dr_shell::quit`）。

## 数字

M3 Pro，release 构建，机器负载 15–18（其他会话在编译）。

| 项 | P0-A | 现在 |
| --- | ---: | ---: |
| `.app` | 12.7 MiB | 18.4 MiB |
| 可执行文件 | 8.4 MiB（8,821,712 B） | 14.1 MiB（14,768,224 B）；`strip -x` 后 11.3 MiB |
| DMG | — | 10.5 MiB（11,011,130 B） |
| 更新包 `.app.tar.gz` | （zip 7.3 MiB） | 9.4 MiB（9,909,227 B） |
| `main` → 首帧，直接运行 | 0.24–0.32 s（负载约 8） | 0.30–0.84 s（负载 15–18，6 次） |

- 可执行文件多出的约 6 MB 是 Sentry（含 minidump 写入）、reqwest + tokio、rustls + ring 和平台验证器。
- 不带 DSN 时，启动时 F7 只读几个环境变量、建几个路径、装一个 panic hook，量不出差别；首帧时间和 P0-A 在高负载下的分布一致。带 DSN 时多起一个旁路进程，要在空闲机器上另测。
- 测试：`dr-platform` 67 个单元测试 + 1 个示例测试，另有 3 个默认忽略的真钥匙串测试（本机跑过）；`drifting` 13 个。

## 第二轮：设备身份、反馈与崩溃跟进

2026-11-08，监管会话交的两件事，详细都在 [m39-feedback.md](../modules/m39-feedback.md)：

- **设备身份**：`app/drifting/src/library.rs` 打开库时把 `dr_store::Device::open(<应用本机数据目录>)` 放进 `LibraryOptions::device`。身份文件和 `library/` 同级、不在库里面；开发构建的数据目录本来就不是正式版的，`DRIFTING_PROFILE` 再把每个 worktree 分开。身份文件坏了库照样打开，只是写作日不存。三个单测证明打开后 `writing_device()` 有值，真机用临时 profile 跑过一次。
- **M39 客户端**：`dr-platform` 加了 `diagnostics`、`feedback`，`sanitize` 补全成旧版整套；对话框是新 crate `dr-view-feedback`；外壳只加挂接点（`dialogs.rs`、`SendFeedback`、工作区的 `dialog` 栏位、通知行可点），逐条列在 m39-feedback.md。测试只对本机 `127.0.0.1` 上的假服务发。

## 第三轮：反馈对话框收尾、导入退出等待、符号与上报的本机验收

2026-11-08，监管会话交的三件事：

- **M39 对话框改用 F5 的 `on_mist`**：✕ 总能关（发送中点 ✕，对话框立刻关、话照样发出去、到了照样收掉通知）；写了字点雾不关，没写字才关；发送中 Esc 和点雾都不关，和旧版一样。顺带把写话框换成 F5 的多行输入框（回车换行、⌘↩ 发送、至少五行高），F5 的两条待协调都收掉了。外壳没再改。详见 [m39-feedback.md](../modules/m39-feedback.md)。
- **导入中途退出最多等多久**：定为各 1 秒、一共最多 2 秒，理由见「退出时能做多少 → 导入中途退出等多久」；常量是 M10 的，请 M10 改（待协调 11）。
- **F7 计划里的下一项：符号与上报验收**（「下一个里程碑建议」第 2 条里不连真 Sentry 的部分）：`dist` 档案、`bundle-mac --dist` / `bundle-windows.ps1 -BuildProfile dist`、草稿工作流指向新的符号路径，以及 `dr-platform/tests/crash_report.rs` 这条本机端到端测试（见「符号文件」「本机验证」）。

`bundle-mac --dist --dmg --archive` 实测（M3 Pro，负载 50–65，别的会话在编译）：

| 项 | 数 |
| --- | ---: |
| `dist` 档案冷编整个 App | 12 分 36 秒（负载高；整个脚本 13 分 54 秒） |
| 没剥的可执行文件 | 65.1 MiB（68,302,232 B），12.2 万个符号 |
| 包里剥过的可执行文件 | 46.6 MiB（48,823,584 B），1.2 万个符号；`__TEXT` 两者都是 42.7 MiB |
| 包旁边的 `.dSYM` | 253 MiB（只上传，不发） |
| `.app` / `.dmg` / 更新包 | 124 MiB / 67.8 MiB / 80.9 MiB；`.app` 里字体占 73 MiB |

- 剥过的可执行文件和 `.dSYM` 的构建 UUID 相同；拿没剥那份里 `dr_platform::crash::init` 的地址往后 64 字节，`atos -o "Drifting Next.app.dSYM" -l 0x100000000` 还原出 `crash.rs:201`，在 `init` 里面。
- 和第一轮「数字」一节比，可执行文件大了很多，是这几批加进来的代码（代码段本身 42.7 MiB），不是符号：剥掉的部分是 18.6 MiB。`release` 档案这次没有重编来比；行号表按说不改生成的代码。

## 第四轮：M42 自动更新的客户端

2026-11-08，监管会话交的事：启动时和设置里检查更新，下载验签，通知中心「重启以更新」、退出时替换，坏签名、半截下载、断网、降级都拒绝并提示；对着本机假服务验收，不碰真发布、不改 `.github/workflows`、不连真服务、不用真签名密钥；旧版那头只写设计。详细在 [m42-update.md](../modules/m42-update.md)，这里只记 F7 这层动了什么：

- `update::fetch`：`UpdateFetch`（按 `UrlPolicy` 选 HTTPS / 本地文件 / 本机 HTTP）；`HttpFetch::new(ua, HttpOptions { loopback, stall })`，停 60 秒算中断；`FetchError::Interrupted`、`Incomplete`；`is_loopback_http`；测试用的 `fake_server`。
- `update::signature`：验签返回受信注释（`Verified::signed_file`）；`test_keys` 给别的 crate 测试用。
- `update`：`Offer`、版本绑定（`UpdateError::VersionMismatch`）、复用已下好的文件、`Problem` 分类、`Downloads`（`store.rs`）。
- `update::install`：换包前核对 `CFBundleShortVersionString`（`InstallError::WrongVersion`）；`InstallerLaunch::without_relaunch`；`test_bundles`。
- `relaunch`：从旧版 `macos_relaunch.rs` 搬来的「等本进程退出再 `open -n`」。
- `update-tool`：`apply` 跟着 `Offer` 改；`verify` 打印签名里的文件名。

退出时换包要多久（本机演练：上一轮 `bundle-mac --dist --archive` 打的真更新包 66.7 MiB、解开 124 MiB，`update-tool sign` 用 scratchpad 里的一次性密钥签，`update-tool manifest --local` 写本地清单，`update-tool apply` 装进复制出来的 `Drifting Next.app`；依赖在开发档案里是 opt-level 2，和正式包差不多；别的会话在编译，负载约 100）：

| 步骤 | 三次 |
| --- | --- |
| 下载（本地复制）+ 验签 + 核对签名里的版本 | 285 / 187 / 127 ms |
| 换包（解压到包旁边、核对 bundle id 和版本、两次改名、删旧包），就是退出钩子做的事 | 1161 / 1703 / 2866 ms |

换完 `codesign --verify --strict` 通过，包旁边没有留下临时文件夹。换包主要花在把 124 MiB 写到盘上，负载高时会到 3 秒；⌘Q 时 App 先藏起来，作者看不到这段，「重启以更新」的重开助手等进程退出后才打开新版。要更快可以把解压挪到下载验签之后（包旁边先解好、退出时只剩两次改名），代价是包旁边要留一个隐藏的临时文件夹、崩溃后要清理；这一轮没做，记在 m42-update.md 待协调 6。

## 下一个里程碑建议

1. **交接里程碑**：旧版最后一版改更新地址并发布（改法已写在 [m42-update.md](../modules/m42-update.md)「旧版那头的交接」）；`release-identity` 特性和打包脚本开关；把草稿工作流补全、挪进 `.github/workflows`；在签名公证的正式包上把 Tauri → GPUI 在 macOS 和 Windows 上各真走一遍（用测试密钥对和一个私有的测试仓库或本地清单，不碰正式发布）。
2. **符号与上报验收（剩下要连 Sentry 的部分）**：本机部分第三轮做完了（见上）。剩下的要作者同意后做：接一个测试用的 Sentry 项目，`sentry-cli` 上传 `dist` 的 `.dSYM`，看一次 Rust 崩溃和一次 minidump 在 Sentry 里还原出函数名和行号；同时验「发版前」4 条（要签名的正式包）。
3. **Windows 实机**：虚拟机里过一遍深链接、单实例、钥匙串、安装器。
