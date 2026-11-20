# 新版第一次发布（0.2.0）交接清单

2026-11-20 写。新版（`next/`，Rust + GPUI）第一次正式发布、接替 0.1 时要做的事：哪些已经准备好了，哪些必须作者动手，按什么顺序，哪一步以后回不去。设计在 [f7-platform.md 的「交接设计」](foundations/f7-platform.md#交接设计) 和 [m42-update.md](modules/m42-update.md) 的「旧版那头的交接」；这一页只讲做法。

## 一句话

已经装着 0.1 的人什么都不用做：0.1 最后一版查到新版，先把书誊好（交接），再把自己换成新版；新版第一次打开时，从 0.1 的数据里导入书，登录和 API Key 直接读得到。为了这件事，新版要用 0.1 的「身份」（同一个 bundle id、同一把更新钥匙、同一个安装位置），而这个身份平时绝不能出现在开发构建里。

## 已经准备好的（不用作者动手）

| 件 | 现在是什么样 |
| --- | --- |
| 正式身份的开关 | `dr-platform` 有 `release-identity` 特性，打开后程序就是「Drifting」（`cc.drifting.client`、`drifting:` 链接、旧版的钥匙串）。只有打包脚本的 `--release-identity`（Windows 是 `-ReleaseIdentity`）会打开它，发布工作流用。平时所有构建、测试、CI 都还是开发身份「Drifting Next」。`cargo xtask check` 拦着别处打开它；它和调试桥、热重载放在一起编不过；`cargo xtask check-binary` 能从打好的程序里认出是哪个身份 |
| 新旧两版的数据文件夹 | 见下面「新版第一次打开时」。核实过会撞，已经修好：新版自己的东西放在 0.1 文件夹的**旁边**，0.1 的书库和登记表一个字节都不动 |
| 预编译着色器的开关 | `script/bundle-mac --precompiled-shaders`：不带 App 的默认特性编，Metal 着色器在编译时预编好，窗口第一次画的时候不用再现编。要先装 Metal Toolchain（作者的事，见第 2 步） |
| 发布工作流 | `next/script/release-next.draft.yml` 写全了：检查、macOS 打包签名公证、更新包签名、符号上传、带上 0.1 最后一版的 `latest.json`、Windows 两个架构、建草稿 Release，三个平台都打好以后才写进三个键齐全的 `update.json`。放在 `next/script` 里，GitHub 不会跑它，挪进 `.github/workflows` 就会跑（第 5 步） |
| 旧版那头 | 已经做了，而且已经发出去了：0.1.0-alpha.11 和 alpha.12 都带着交接和「先读 `update.json`、读不到再读 `latest.json`」（提交 `c788d72b2`）。0.1 的发布流程本来就只出 `latest.json`，不会出 `update.json` |
| 开发身份的安装包 | `next` 工作流每次运行都在跑测试之前打好 macOS 的 `.dmg` 和 Windows 两个架构的安装包，作为运行产物传上去（名字带平台和提交号，留 7 天），作者在虚拟机里实机验收用（见「Windows 这一半」） |
| 本机演练 | 开发身份的包上，用一次性密钥和本地清单走完「打包 → 签更新包 → 写清单 → 查到 → 下载验签 → 换包」，见文末「本机演练」 |

## 新版第一次打开时（数据文件夹）

正式身份下，系统给新版的数据文件夹就是 0.1 的那个（macOS `~/Library/Application Support/cc.drifting.client`，Windows `%LOCALAPPDATA%\cc.drifting.client`），而两版用同样的名字放书库：都有 `libraries.json`，账号的书库都叫 `libraries/account-<一串十六进制>/`，同一个账号算出来的名字一模一样。

改之前，用合成的 0.1 数据文件夹在临时目录里试过（测试 `next/app/drifting/src/data_folder_tests.rs`，留作负对照）：

- 一般的 0.1 用户（有 `libraries.json`）：新版读不懂 0.1 的登记表，账号服务起不来（App 会退到一个临时文件夹，登录状态等于丢了）；新版自己的书库、设置、设备身份等文件直接落在 0.1 文件夹的根上。
- 没有登记表的 0.1 文件夹：新版写一份自己格式的 `libraries.json`，还在 0.1 账号书库的文件夹里建自己的库；这之后「导入 Drifting 0.1」按 0.1 的规矩认为登记表坏了，一本旧书都找不到。

现在的做法（只改了 `dr-platform` 的路径和 App 入口用哪个文件夹）：

| | macOS | Windows |
| --- | --- | --- |
| 0.1 的文件夹：新版除了 `mcp/` 什么都不写，导入时从这里找旧书 | `~/Library/Application Support/cc.drifting.client` | `%LOCALAPPDATA%\cc.drifting.client` |
| 新版自己的东西：书库登记表、书库、设备身份、设置、下载的更新、崩溃记录 | `~/Library/Application Support/cc.drifting.client.v2` | `%LOCALAPPDATA%\cc.drifting.client.v2` |
| 两版共用、留在原处的 | 0.1 文件夹里的 `mcp/`（外部 Agent 的连接文件，路径已经写在作者的 Codex、Claude Code 配置里） | 同左 |
| 日志 | `~/Library/Logs/cc.drifting.client` | `%LOCALAPPDATA%\cc.drifting.client.v2\logs` |

为什么放在「旁边」而不是 0.1 文件夹「里面」的子文件夹：0.1 最常见的本地书库，它的根就是整个 0.1 文件夹；导入有一道保护，不许把导入结果放进来源书库的里面。放在里面的话，最常见的那种旧书库会被拒绝导入（也试过，报 `reimport requires a new destination`）。

顺带的好处：新版不碰 0.1 的书库和登记表，作者万一要手动装回 0.1，0.1 打开的还是它离开时的样子（只是看不到在新版里新写的东西）。

文件夹名 `cc.drifting.client.v2` 是替作者定的；**发了 0.2.0 以后就不能再改**（老用户的书在那里）。

## 发布顺序

| 步 | 谁 | 做什么 | 要什么 |
| --- | --- | --- | --- |
| 0 | 作者 | 先定下面「要作者定的事」那几条 | — |
| 1 | 作者 | 在仓库 Settings › Secrets and variables › Actions 里加新变量（已有的证书、公证、更新钥匙、Hosted 地址都不用动，0.1 的发布已经在用；证书必须就是 0.1 在用的那张 Developer ID，同一个团队，钥匙串里的登录和 API Key 才读得到、不弹框） | `DRIFTING_LAST_V1_TAG`：最后一个 0.1 Release 的标签，现在是 `v0.1.0-alpha.12`。要开崩溃上报再加 `DRIFTING_SENTRY_DSN`、`SENTRY_ORG`、`SENTRY_PROJECT`（变量）和 `SENTRY_AUTH_TOKEN`（`release` 环境的密钥）；整张表在工作流文件开头 |
| 2 | 作者 | 本机装 Metal Toolchain，打一个预编译着色器的开发包看一眼 | Xcode 26；见下面「验证预编译着色器」 |
| 3 | 作者 + 监管会话 | 真实条件下的验收（[progress.md](progress.md)「等作者的事」第 3、4 条），尤其导入自己的 0.1 库；Windows 实机手测挡发布，在 ARM 虚拟机里用 CI 产物里的开发身份安装包照 [m43 的清单](modules/m43-windows.md)走（见「Windows 这一半」） | CI 产物、Windows 11 ARM 虚拟机 |
| 4 | 监管会话 | 改版本号 `next/app/drifting/Cargo.toml` → `0.2.0`；写发布说明 `docs/releases/0.2.0.md`（第一行 `# Drifting 0.2.0`，先中文后英文，纯文本） | — |
| 5 | 监管会话（作者同意推送） | 把工作流挪进来：`git mv next/script/release-next.draft.yml .github/workflows/release-next.yml`；**同一个提交里**把 `release.yml` 的触发改成 `tags: ['v0.1.*']`（现在两个都认所有 `v*` 标签），并把 `scripts/check-ci-contract.mjs` 里「release.yml 必须认 `v*`」那条改成新的规矩；跑 `pnpm ci:contract:check`、`cargo xtask check`；本地 `next/script/check-release v0.2.0` | — |
| 6 | 作者同意后推 | `git tag v0.2.0 && git push origin main v0.2.0`，等工作流跑完，出草稿 Release。草稿谁也看不到，装着的 App 也不会收到 | — |
| 7 | 作者 | 检查草稿：文件齐（`Drifting_0.2.0_macos_arm64.dmg`、`Drifting_0.2.0_aarch64.app.tar.gz` 和 `.sig`、`Drifting_0.2.0_windows_x64-setup.exe`、`…_arm64-setup.exe` 和各自的 `.sig`、`update.json` 里正好 `darwin-aarch64`、`windows-x86_64`、`windows-aarch64` 三个键、`latest.json` 的版本是 alpha.12、`SHA256SUMS.txt`）。没有 `update.json` 就是有个 Windows 任务失败了，重跑它，别发 | — |
| 8 | 作者 | 用草稿里的包，在**不是日常用的** macOS 用户（或虚拟机）和 Windows 虚拟机里把「0.1 → 新版」走一遍：先装 alpha.12、写几个字、登录、存一个 API Key，关掉；再把草稿里的 DMG 装上去（Windows：直接运行草稿里的 `…_arm64-setup.exe`，它会装进 alpha.12 的同一个文件夹，等于 0.1 更新器做的那一步，见 m43 清单第一节最后一条），打开看：书能导入、登录还在、API Key 还在、`drifting:` 链接能跳进来，「已安装的应用」里只有一个 Drifting。正式身份的包会读写那台机器上正式版的数据，所以**不要在日常账户上做**。要连 0.1 更新器自动换包那一下也验，就在私有测试仓库用测试密钥跑一遍工作流（[f7「下一个里程碑建议」](foundations/f7-platform.md#下一个里程碑建议)第 1 条） | 一台干净的 Mac 账户或虚拟机、Windows 虚拟机 |
| 9 | 作者 | **点 Publish**。这一下就是把新版推给所有人，也是回不去的那一点（下一节） | — |
| 10 | 监管会话 | Publish 后重建官网：下载按钮按文件名直链最新 Release，文件名的格式没变（`Drifting_<版本>_macos_arm64.dmg`、`Drifting_<版本>_windows_x64-setup.exe`），但生成脚本（`scripts/design-assets/landing/build.mjs`）现在从 0.1 的 `package.json` 取版本号，要改成读 `next/app/drifting/Cargo.toml` | — |

装着更早 0.1（alpha.10 以前、只读 `latest.json`）的人也不会跳过交接：新版的 Release 原样带着 alpha.12 的 `latest.json`，他们先升到 alpha.12，alpha.12 下一次检查时读到 `update.json`，装新版之前先交接。所以不用专门「等大家都升到最后一版」。只有自己手动下载新版 DMG 的人会跳过交接，导入时被拦下、给「仍然导入」（M10）。

要是还想再发一个 0.1（比如 alpha.13 修个问题）：照 `docs/releasing.md` 发，它的 Release 不会带 `update.json`；然后把 `DRIFTING_LAST_V1_TAG` 改成新的标签。

### 验证预编译着色器（第 2 步）

装 Metal Toolchain（Xcode 的一个单独下载，约 700 MB，要作者在自己的机器上点）：

```bash
xcodebuild -downloadComponent MetalToolchain
```

在 `next/` 里打一个开发身份、预编译着色器的包（release 档案，几分钟到十几分钟）：

```bash
script/bundle-mac --precompiled-shaders --open
```

查包里的程序确实是预编译的着色器、不是正式身份：

```bash
cargo xtask check-binary --precompiled-shaders "target/bundle/Drifting Next.app/Contents/MacOS/drifting"
```

打开的窗口里字、按钮、阴影、玻璃都正常画出来，就说明预编译的着色器能用。这个包是开发身份「Drifting Next」，不碰正式版的数据，可以放心开。

## 回不去的那一点

**点了 0.2.0 的 Publish 以后，就只能往前修，不能靠更新退回 0.1。**

- 新版拒绝比自己旧的版本（M42 的「降级」），0.1 的更新器在换包那一刻已经被新版替换掉了。发现问题只能发 `0.2.1`。
- Publish 之前都能反悔：草稿删掉，修好以后用新版本号重新打标签（移动已推的标签要作者每次同意强推）。
- 真要退，只能让人手动装 0.1 的 DMG。因为新版不碰 0.1 的书库和登记表，装回去的 0.1 打开的是它离开时的书；在新版里写的东西 0.1 看不到。

## 两个平台一起发（作者 2026-11-20 定）

`0.2.0` macOS 和 Windows 一起发。`update.json` 从第一版起就是三个键：`darwin-aarch64`（Mac 的更新包 `.app.tar.gz`）、`windows-x86_64` 和 `windows-aarch64`（两个 Windows 安装包本身）。

为什么一个都不能少（读的是 0.1 用的 `tauri-plugin-updater` 2.10.1）：0.1 的更新器依次读两份清单，**拿到第一份能读懂的就停**，不会再去读 `latest.json`；然后它**先找本平台的下载地址、再比版本号**。`update.json` 里少了哪个平台，那个平台上的 alpha.11、alpha.12 每次检查都报「找不到这个平台」：不升级，设置里一直显示检查失败。

所以工作流是这样排的：

- Mac 那一步建草稿时只放 DMG、更新包、`latest.json`，**不放 `update.json`**；它算好的 Mac 那一段先存在工作流里。
- 两个 Windows 安装包都打好、签好以后，最后一步（「add Windows and update.json to the draft release」）把三段合成一份 `update.json`，核对正好是这三个键、每个都有签名、地址都指向这一次的文件，先传安装包、再传 `update.json`。
- 哪个 Windows 任务失败，草稿里就没有 `update.json`：这样的草稿就算误点了 Publish 也不会把任何人升级（只是要手动下载）。处理办法是重跑失败的任务，**不要发这样的草稿，也不要自己手写一份缺平台的 `update.json`**。
- **绝对不要**：给 Windows 的键填 0.1 的安装包（版本号是全清单共用的，Windows 会每 3 小时把 0.1 重装一遍）；也不要用不分平台的清单写法（顶层直接写 `url`、`signature`），那样 Windows 会去下 macOS 的包。

## Windows 这一半

| 件 | 怎么做 | 现在的状态 |
| --- | --- | --- |
| 安装包 | NSIS，`next/script/bundle-windows.ps1 -BuildProfile dist -Target <x86_64 或 aarch64>-pc-windows-msvc -ReleaseIdentity`，出 `Drifting_<版本>_windows_x64-setup.exe` 和 `…_arm64-setup.exe`。不要管理员权限，装到当前用户下 | 工作流里每个架构一个任务；开发身份的安装包 CI 每次都打、装一遍、升级一遍、卸一遍（`check-windows-installer.ps1`） |
| 从 0.1 原位升级 | 0.1 最后一版的更新器下载新安装包、验签，用 `/P /R /UPDATE /ARGS` 运行它，自己马上退出。新安装器装进**同一个**文件夹 `%LOCALAPPDATA%\Drifting`（之前装在别处的，按 `HKCU\Software\drifting\Drifting` 记下的位置），改写同一个卸载项（「已安装的应用」里还是一个 Drifting）、同一个 `drifting:` 协议键；最多等旧进程 10 秒，被动模式下再结束本用户残留的同名进程；`/UPDATE` 时不动开始菜单和任务栏上已有的固定；装完把新版打开 | 安装位置、卸载项、厂商键、协议、`/P /UPDATE` 都对着旧版 Tauri 安装器写的，CI 上验过开发身份那一套；**正式身份的安装包没在 Windows 上打过**，从 0.1 真升级一次是实机验收（m43 清单第一节最后一条） |
| 数据 | 0.1 的 `%LOCALAPPDATA%\cc.drifting.client`（书库、登记表、WebView2 的 `EBWebView/`）新版除了 `mcp/` 不写；新版自己的东西在 `%LOCALAPPDATA%\cc.drifting.client.v2`，日志在它的 `logs\`；程序在 `%LOCALAPPDATA%\Drifting`，卸载只删程序自己的文件，书不在那里 | 测试按 Windows 的规则也跑一遍（不管在哪个系统上跑），含程序文件夹不被碰 |
| 更新签名 | Windows 的更新包就是安装包本身：`update-tool sign` 用同一把 minisign 私钥签出 `-setup.exe.sig`，签名里带文件名（含版本号），`update.json` 的 Windows 两个键指向安装包和它的签名 | 工作流里签完立刻用公钥验一次 |
| 代码签名（Authenticode） | **要作者定，默认照 0.1：不签**。不签时第一次运行 SmartScreen 会提示「Windows 已保护你的电脑」（点「更多信息」→「仍要运行」），发布说明里照 0.1 写一句；更新照样由 minisign 签名保证。要签得买代码签名证书，工作流里在「Sign the installer with the updater key」前面加一步 | 不签 |
| 实机验收 | 作者只有一台 Windows 11 ARM 虚拟机：开发身份的安装包从 `next` 工作流每次运行的产物里下（`drifting-next-windows-arm64-<提交号>`，x64 的叫 `…-windows-x64-…`；在跑测试之前就传上去，留 7 天），照 [m43-windows.md](modules/m43-windows.md) 的清单走 | **挡发布**（progress「等作者的事」第 3 条） |

## 要作者定的事（带推荐）

1. **Windows 签不签名（D10）。** 默认照 0.1：不签（上一节「代码签名」）。
2. **GPUI 的补丁挂不挂。** 补丁在 `next/patches/gpui`：停掉空闲时的显示链接（不挂的话窗口空闲时也有约 1% 的 CPU）、读屏的两处修正、组字取消的接口。推荐挂 0001（省电，对所有人都有用），读屏和组字那几个等真实输入法验收再定。挂补丁要作者指定一个能推送的 fork 仓库，`next/Cargo.toml` 改指向它。
3. **崩溃上报开不开。** 推荐开：在 Sentry 建好（或复用旧的 `drifting/drifting-client`）项目，填第 1 步那四项；同意开关在设置里，首次说明在欢迎卡上（m35-account.md）。不填也能发，只是这一版收不到崩溃。开之前在签名的正式包上验一次 ⌘Q（[f7 发版前第 4 条](foundations/f7-platform.md#发版前必须由作者做的事)）。
4. **新版自己的文件夹名。** 替作者定成 `cc.drifting.client.v2`（放在 0.1 文件夹旁边，macOS、Windows 一样）。没意见就不用回；要改必须在发 0.2.0 之前。

已经定了的：两个平台一起发（2026-11-20）。

## 本机演练（2026-11-20）

在开发身份的 dist 包上，用一次性密钥和本地清单，把「打包 → 签更新包 → 写清单 → 查到 → 下载验签 → 换包」走了一遍：查到新版本、下载加验签约 0.1 秒，退出时换包 0.6 到 1.6 秒（机器很忙）；换完签名校验通过，旧包里多出来的东西清掉了。同版本、更旧的版本、旧包冒充新版本号、被改过一个字节的包、别的钥匙签的包，五种都拒绝，已装的包一点没动。数字和步骤见 [f7-platform.md 的「第五轮」](foundations/f7-platform.md#第五轮发布交接的工程准备)。

没在本机做、也做不了的：预编译着色器那一面（要 Metal Toolchain）、Developer ID 签名和公证、工作流真跑一遍、正式身份的程序真打开（会读写这台机器上正式版的数据）、Windows 的正式身份安装包和更新包演练（本机没有 Windows，只能在 CI 上打）。
