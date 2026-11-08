# M42 自动更新（客户端）

2026-11-08，客户端部分，F7 这一路做（第四轮）。计划见 [modules.md 的 M42](../modules.md)。检查、下载、验签、安装的底层在 F7 的 `next/crates/dr-platform/src/update/`（第一轮做的，这一轮补了本机 HTTP、截断和停滞、签名绑定版本、更新文件夹），界面和调度是新 crate `next/crates/dr-view-update/`；外壳（dr-shell）只加了设置「关于」里一行的挂接点，应用入口注册一行。发布流水线、真签名、旧版最后一版都没动；旧版那头只写了设计（见文末）。

## 做了什么（大白话）

1. **自己会查。** 打开 App 后 10 秒查一次，之后只要开着，每 3 小时查一次（旧版也是 3 小时）。设置 › 关于里多了一行「新版本」，按钮「检查更新」，点了马上查。
2. **查到新版本，就在后台下好、验好。** 下到应用数据目录里的 `updates/`，下完先验签名（minisign，和旧版同一把钥匙），再核对签名里写的文件名就是这个版本号。都过了，通知中心出现「Drifting 0.2.1 可以更新」，下面一个按钮「重启以更新」；设置那一行写「Drifting 0.2.1 已下载并通过签名校验，退出时安装」，按钮也变成「重启以更新」。
3. **退出时换。** 作者照常退出（⌘Q、菜单、Windows 关最后一个窗口）时，先等书都存好，然后 macOS 把 App 原地换成新版，Windows 启动安装器（被动模式，自己等旧进程退干净）。点「重启以更新」走的是同一条退出路，换完再把新版打开。新版第一次打开时，通知中心说一次「已更新到 Drifting 0.2.1」。
4. **不对的一律不装，而且会说。** 下面这些情况，下载的东西一点都不留，当前版本照常用：

   | 情况 | 设置那一行说 | 通知中心 |
   | --- | --- | --- |
   | 签名不对、别的钥匙签的 | 下载的更新没有通过签名校验，已丢弃 | 也说（每个版本每次启动一次） |
   | 降级：旧版本冒充新版本号（签名里的文件名或 App 里写的版本对不上） | 下载的更新不是它标明的版本，可能是旧版本，已拒绝 | 也说 |
   | 降级：更新服务提供的版本比这一版还旧 | 已是最新版本。更新服务提供的 x 比这一版旧，不会安装 | 不说（什么都没下） |
   | 半截下载：连接断了、停了 60 秒没动静、比说好的长度短 | 更新没有下载完整，已丢弃。下次检查时会重新下载 | 不说（下次自动再下） |
   | 断网、连不上 | 暂时无法检查更新，可能是网络不通（旧版原话） | 不说（和旧版一样，自动检查失败不打扰） |
   | 服务器出错、清单坏了 | 更新服务暂时出了问题，稍后再试 | 不说 |
   | 不是 Drifting 的包 | 下载的更新不是 Drifting，已丢弃 | 也说 |
   | 退出时没换成（App 所在的文件夹写不进去） | — | 下次打开时说：上次退出时没能装上 Drifting x：所在的文件夹不能写入 |

5. **开发版不更新。** 没有编进更新公钥的构建（所有本地和 CI 构建）不查，设置那一行写旧版那句「这个构建没有内置更新签名公钥，不能检查更新」。要试整条路，开发版设 `DRIFTING_DEV_UPDATE_MANIFEST`（本地文件或本机 `http://127.0.0.1:<端口>/…`）和 `DRIFTING_DEV_UPDATER_PUBLIC_KEY`。

## 定下的事

### 和旧版不一样的地方

- **下载不问，安装在退出时。** 旧版查到新版本先在通知里说「可以更新」，作者点「安装并重启」才下载、存盘、安装、马上重启。这一轮按派发改成：查到就在后台下好验好，退出时装，想马上用就点「重启以更新」。理由：下载和验签都在后台、不碰作者的库；安装放在退出时，作者不会在写到一半时被打断；下好的包验过签名才留下，退出时只差一次原地替换。
- **每次启动都查。** 旧版在启动时只有离上次自动检查超过 3 小时才查（用 `localStorage` 记时间）。新版按计划「启动时检查」，每次启动后 10 秒查一次。只多一个几 KB 的清单请求；下好还没装的那个版本不会重下（见下）。
- **启动后等 10 秒。** 不挤开窗、开库和崩溃跟进（2 秒）这段时间。
- **下好还没装就重开了**（崩溃、系统注销），下次检查发现还是那个版本，就用已经下好的文件，先用这次清单里的签名重新验一遍，验过就不再下载。

### 什么时候装、装多久

- 安装在退出钩子里，`dr_view_update::init` 在 `main` 里最后注册，所以它排在书库关闭、导入收尾、统计写盘这些钩子后面：先存，再换。⌘Q 时外壳先把 App 藏起来（F7 第三轮建议、F6 已做），所以换包这一下作者看不到冻住的窗口。
- **系统发起的退出**（注销、关机、Dock 的退出）不走钩子，GPUI 只给退出回调 200 ms，不够解压。这时不装，下载的文件留着，下次打开再提示，下次正常退出时装。
- 换包要多久：见下面「实测」。

### 降级

三层：

1. 清单里的版本不比当前新，就不算更新，什么都不下（`Offer::Current` / `Offer::Older`）。
2. **签名绑定版本**：`tauri signer sign` 和 `update-tool sign` 都把文件名写进 minisign 的受信注释（也被签名覆盖），发布文件名都带 `_<版本>_`（`Drifting_0.2.1_aarch64.app.tar.gz`、`Drifting_Next_0.2.1_windows_x64-setup.exe`）。下载验签时要求受信注释里的文件名带上清单说的版本，否则拒绝：拿一个签过名的旧包、配一份改了版本号的清单，过不去。这对发布流水线是一条约束：**签名时的文件名必须带版本**；签完再改名不要紧（草稿工作流就是先签再复制成 `Drifting_<版本>_aarch64.app.tar.gz`，原名也带版本）。
3. macOS 换包前再看 App 自己的 `CFBundleShortVersionString` 等于清单版本的 `主.次.修订`（`bundle-mac` 就是这么写的），不等就不换。

### 断网和半截下载

- 下载停 60 秒没收到一个字节算中断（`fetch::STALL_TIMEOUT`；reqwest 阻塞客户端的超时是每次等待的上限，不是整个下载的上限，网慢但一直在收没关系）；连接中途断了、收到的比服务器说的长度短，都算中断。
- 中断时写了一半的 `.partial` 立即删掉；崩溃留下的 `.partial` 下次启动清掉，下载时也会被覆盖，从不当成下好的文件。
- 断网时自动检查只在设置那一行留话，不进通知中心（旧版一样）；3 小时后再查。

### 什么进通知中心

- 进：下好待装（带「重启以更新」）；文件本身不对的拒绝（签名、版本、别的 App）——重试不会自己好，作者该知道；上次退出时装上了（新版说）或没装上（旧版说）。
- 不进：查到没有新版本、断网、服务器出错、半截下载——这些下次自动会好，全写在设置那一行。
- 同一个版本的同一种拒绝，一次启动只说一次（服务器上挂着坏包时，不会每 3 小时冒一条）。

### 更新文件夹

`<应用数据>/updates/`：下好的包（只留最新的一个）、`installed.json`（退出时装了哪个版本和说明，新版读一次就删）、`install-failed.json`（哪个版本没装上、为什么，读一次就删；那个版本已经不比当前新就不说）。启动时清掉 `.partial` 和不比当前新的包。正式版和旧版共用 `cc.drifting.client` 数据文件夹（F7 待协调 3），旧版那里没有 `updates/`，不冲突。

## 接口

```rust
// dr-platform（F7，不依赖 GPUI）
Updater::check() -> Result<Offer, UpdateError>;            // Newer(Available) | Current | Older(Version)
Updater::download(&available, dir, progress) -> Result<Downloaded, UpdateError>; // 验签 + 版本绑定；已下好的验过就复用
Downloaded::replace_bundle(bundle);                         // 还核对 App 自己的版本
Downloaded::installer_launch(args).without_relaunch();     // Windows：退出时装、不重开
UpdateError::problem() -> Problem;                          // Offline / Server / Interrupted / Signature / Version / WrongApp / NeedsAdmin / Local / Unavailable
update::UpdateFetch::new(policy, user_agent, stall);       // HTTPS；AllowLocal 下加本地文件和本机 http
update::Downloads::{in_data, clean, keep_only, record_installed, take_installed, record_failure, take_failure};
relaunch::after_exit(bundle);                               // macOS：等本进程退出再 open -n（照旧版 macos_relaunch.rs）
update::fetch::fake_server::FakeServer;                     // 测试用：127.0.0.1 上的假 GitHub Releases（test-support）
update::signature::test_keys::TestKey;                      // 测试用：一次性密钥对（test-support）

// dr-view-update（M42）
dr_view_update::init(Service::for_build(identity, Some(data_dir), version), cx);  // main 里最后注册
dr_view_update::Updates::{status, waiting, check, restart};
dr_view_update::snapshot(cx) -> UpdateSnapshot;            // 反馈摘要里的更新状态（M39 待协调 5 的一半）
dr_view_update::install_on_quit(cx);                        // 退出钩子本身
```

## 改了外壳（dr-shell）的地方

只加挂接点：

- `settings::registry`：「关于」里版本号下面加一行 `about.update`（`RowAction::Updates`，标签是旧版的「新版本」）。
- `settings::set_updates_row(cx, make)`：M42 给出这一行的说明文字和按钮；没注册时（测试、截图、不能更新的平台）这一行不出现。

M39 的反馈对话框改了一行：摘要里的更新状态改用 `dr_view_update::snapshot`（之前是固定的「空闲」）。

## 测试

全部对着本机的假服务（`127.0.0.1` 上的假 GitHub Releases）和临时生成的密钥对，装在临时文件夹里合成的 App 上；不连任何真服务，不用真签名密钥，重开只记下来、不真开。

- `dr-platform`（单元测试）：本地文件和本机 HTTP 两条路走完查、下、验、换；重定向只能留在本机；截断（`CutShort`）、停滞（`Stall`，0.5 秒超时）、连不上、503、坏 JSON；篡改、别的钥匙、别的 App；旧包冒充新版本号（签名名字不对 → 下载时拒；App 版本不对 → 换包前拒）；同版本、旧版本不下载；重开后复用已下好的文件、不再请求服务器；残留 `.partial` 不会被当成下好的；更新文件夹清理和两份便条只读一次；重开助手真的等进程退出才执行（用假 `open` 和一个子进程测）。
- `dr-view-update`（GPUI 测试平台，11 个）：
  - 查到新版本 → 下好验好 → 通知中心「可以更新」带「重启以更新」→ 点按钮：存盘、换包、重开（记录到）→ 新版启动说「已更新到」；
  - 启动后 10 秒才查、之后每 3 小时一次；自动检查失败只在设置里说；普通退出也装、不重开；
  - 重开后不重下；
  - 坏签名：拒绝、什么都不留、设置和通知中心都说、再查也只说一次、退出时什么都不装；
  - 旧包冒充新版本：拒绝并说；
  - 清单版本比当前旧：不下载（服务器只被问过清单）、设置里说「不会安装」；
  - 半截下载和停滞：拒绝、不留文件、不进通知中心；之后好的下载照常；
  - 断网：设置里说网络不通；
  - App 版本不对的包：退出时不换、原样留着，下次启动说没装上；
  - 不能更新的构建：不请求、设置里说旧版那句、没有按钮；
  - 反馈摘要里的更新状态跟着变（`ready` 带版本、`error`）。
  - 工作区里打开设置，「关于」连同这一行画得出来，查之前、查到之后各画一次。

## 实测

用上一轮 `--dist` 打的真更新包（66.7 MiB，解开 124 MiB），在本机用一次性密钥签名、写本地清单，`update-tool apply` 装进复制出来的 `Drifting Next.app`（别的会话在编译，负载约 100）：

- 下载（本地复制）、验签、核对签名里的版本：127–285 ms；
- **退出时换包**（解压、核对、两次改名、删旧包）：1.2 / 1.7 / 2.9 秒，主要是把 124 MiB 写到盘上；换完 `codesign --verify --strict` 通过，包旁边不留东西。

⌘Q 时 App 先藏起来，这一两秒作者看不到。细节在 [f7-platform.md](../foundations/f7-platform.md)「第四轮」。

## 旧版那头的交接（只写设计，没动 0.1 客户端）

总设计在 [f7-platform.md 的「交接设计」](../foundations/f7-platform.md)（两份清单、顺序、保持不变的东西）。这里是 M42 定下的、旧版最后一版发布时要做的具体改动，和新版这边要守住的约定。

### 旧版最后一版（0.1.x）要改的

1. **`src-tauri/src/app_update.rs` 的更新地址从一个改成两个，顺序不能反**：

   ```rust
   const UPDATE_ENDPOINTS: [&str; 2] = [
       "https://github.com/chihumyum/Drifting/releases/latest/download/update.json",
       "https://github.com/chihumyum/Drifting/releases/latest/download/latest.json",
   ];
   // update_check 里：.endpoints(UPDATE_ENDPOINTS.iter().map(|u| u.parse()).collect::<Result<_, _>>()?)
   ```

   `tauri-plugin-updater` 2.10.1 依次请求：返回非 2xx（GitHub 上还没有 `update.json` 时是 404）或网络出错就试下一个，拿到能解析的清单就停。所以 GPUI 版发布前，最后一版读到的是 `latest.json`（指向它自己，不更新）；GPUI 版发布后，读到 `update.json`，升到 GPUI 版。对应的单测 `endpoint_is_the_latest_published_release_manifest` 改成断言两条地址和顺序。
2. **最后一版自己的 Release 不能带 `update.json` 文件**，只带 `latest.json`（指向它自己）。否则 GitHub 的 `latest/download/update.json` 会落在它身上。
3. 交接本身已经在 `main`（`v2-handoff`，安装前的存盘屏障里跑），不用再改。

### 新版这边要守住的（旧更新器读得懂）

- `update.json` 一直是 Tauri 的格式：`version`、`notes`、`pub_date`（RFC 3339）、`platforms.<os>-<arch>.{url, signature}`；签名用同一把 minisign 钥匙。旧更新器按 `<os>-<arch>-<安装器>` 再 `<os>-<arch>` 找，所以 `darwin-aarch64`、`windows-x86_64` 这些键要有。
- macOS 更新包只有一个顶层 `.app` 文件夹；Windows 安装器认 `/P /R /UPDATE /ARGS`，并且自己等旧进程退干净（第一轮已做）。
- 版本号比旧版最后一版大（`0.2.0` > `0.1.x`），旧更新器只按 SemVer 比大小。
- 签名文件名带版本（上面的约束），旧更新器不看这个，新版自己要。

### 回不去

新版拒绝比自己旧的版本，所以发了 GPUI 版以后，修问题只能往前发（`0.2.1`），不能靠更新退回 0.1。真要退，只能手动装旧版 DMG；旧版能不能打开新版写过的库是 F2/M10 的事，这里不承诺。

### 交接前的演练（要签名，留给作者）

在签名公证的正式包上，用测试密钥对和本地清单（或私有测试仓库）把「旧版最后一版 → GPUI 版」在 macOS 和 Windows 各走一遍（F7 下一个里程碑 1）。本轮没有签名、没碰发布，只在开发版上用本机假服务验了新版自己这一半。

## 待协调

1. **macOS 上 App 所在的文件夹写不进去时**（标准用户、`/Applications` 属于管理员）：旧版会弹 AppleScript 要管理员密码；这里不弹，记下来，下次打开时在通知中心说没装上。要不要跟旧版一样弹（在退出时、App 已藏起来以后弹框比较突兀），作者定。F7 待协调 2 里同一个问题。
2. **Windows**：本机没有 Windows，退出时启动安装器（不带 `/R`）、「重启以更新」带 `/R` 只有单元测试，没有在真机上跑过；安装器本身的升级路径在 CI 的 `check-windows-installer.ps1` 里测过（第一轮）。
3. **M39（反馈）**：摘要里的更新状态已经接上（`dr_view_update::snapshot`）；同步那一半还等同步模块。设置 › 本地数据「复制摘要」用的是外壳自己的简短摘要，没有更新状态，和 M39 待协调 5 一起改。
4. **发布（作者）**：正式构建要编进 `DRIFTING_UPDATER_PUBLIC_KEY`（发布工作流的 `vars`），不然正式版也不查更新；草稿工作流 `next/script/release-next.draft.yml` 已经这样写，没挪进 `.github/workflows`。
5. **界面截图**：设置「关于」里这一行和通知中心的「重启以更新」还没在真窗口里截图给作者看。
6. **换包能不能更快**：现在退出时才解压（负载高时 3 秒）。可以挪到下载验签之后，先在包旁边解好（隐藏文件夹），退出时只剩两次改名（毫秒级）；代价是包旁边多一个临时文件夹、崩溃后要清理、App 被挪走时要作废。要不要做，看真机上 ⌘Q 后进程多留一两秒是否碍事。

## 代码位置

- `next/crates/dr-platform/src/update/`：`fetch.rs`（`UpdateFetch`、本机 HTTP、中断与截断、假服务）、`signature.rs`（受信注释）、`install.rs`（App 版本核对、Windows 不重开）、`store.rs`（更新文件夹）、`mod.rs`（`Offer`、版本绑定、`Problem`）；`next/crates/dr-platform/src/relaunch.rs`
- `next/crates/dr-view-update/src/lib.rs`、`tests/updates.rs`
- `next/crates/dr-shell/src/settings/`（`registry.rs` 一行、`mod.rs` 挂接点、`panel.rs` 画这一行）
- `next/app/drifting/src/main.rs`（注册）
- `next/crates/dr-i18n/keys.txt`、`own/*.json`（九种语言的新句子：重启以更新、退出时安装、几种拒绝、没装上）
