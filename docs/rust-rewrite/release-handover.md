# 新版第一次发布（0.2.0）交接清单

2026-11-20 写。新版（`next/`，Rust + GPUI）第一次正式发布、接替 0.1 时要做的事：哪些已经准备好了，哪些必须作者动手，按什么顺序，哪一步以后回不去。设计在 [f7-platform.md 的「交接设计」](foundations/f7-platform.md#交接设计) 和 [m42-update.md](modules/m42-update.md) 的「旧版那头的交接」；这一页只讲做法。

## 一句话

已经装着 0.1 的人什么都不用做：0.1 最后一版查到新版，先把书誊好（交接），再把自己换成新版；新版第一次打开时自己弹出导入对话框，从 0.1 的数据里导入书（只弹这一次，入口一直在「全部项目」左栏）；登录和 API Key 直接读得到。为了这件事，新版要用 0.1 的「身份」（同一个 bundle id、同一把更新钥匙、同一个安装位置），而这个身份平时绝不能出现在开发构建里。

## 已经准备好的（不用作者动手）

| 件 | 现在是什么样 |
| --- | --- |
| 正式身份的开关 | `dr-platform` 有 `release-identity` 特性，打开后程序就是「Drifting」（`cc.drifting.client`、`drifting:` 链接、旧版的钥匙串）。只有打包脚本的 `--release-identity`（Windows 是 `-ReleaseIdentity`）会打开它，发布工作流用。平时所有构建、测试、CI 都还是开发身份「Drifting Next」。`cargo xtask check` 拦着别处打开它；它和调试桥、热重载放在一起编不过；`cargo xtask check-binary` 能从打好的程序里认出是哪个身份 |
| 新旧两版的数据文件夹 | 见下面「新版第一次打开时」。核实过会撞，已经修好：新版自己的东西放在 0.1 文件夹的**旁边**，0.1 的书库和登记表一个字节都不动 |
| 预编译着色器的开关 | `script/bundle-mac --precompiled-shaders`：不带 App 的默认特性编，Metal 着色器在编译时预编好，窗口第一次画的时候不用再现编。这台机器 2026-11-20 装了 Metal Toolchain，照第 2 步验过 |
| 发布工作流 | `next/script/release-next.draft.yml` 写全了：检查、macOS 打包签名公证、更新包签名、符号上传、带上 0.1 最后一版的 `latest.json`、Windows 两个架构、建草稿 Release，三个平台都打好以后才写进三个键齐全的 `update.json`。放在 `next/script` 里，GitHub 不会跑它，挪进 `.github/workflows` 就会跑（第 5 步） |
| 旧版那头 | 已经做了，而且已经发出去了：0.1.0-alpha.11 和 alpha.12 都带着交接和「先读 `update.json`、读不到再读 `latest.json`」（提交 `c788d72b2`）。0.1 的发布流程本来就只出 `latest.json`，不会出 `update.json` |
| 开发身份的安装包 | `next` 工作流每次运行都把 macOS 的 `.dmg`（跑测试之前，debug 构建）和 Windows 两个架构的安装包（单独的 `windows-installer` 任务，`dist` 档：和正式发布同一档的优化构建，装上、启动一遍才上传）作为运行产物传上去（名字带平台和提交号，留 7 天），作者在虚拟机里实机验收用（见「Windows 这一半」） |
| 第一次打开时带去导入 | 这台设备第一次显示「全部项目」时，找到 0.1 的书库就自己弹出导入对话框，只弹一次；登录着的账号只在这次导入会被放行时才弹（账号在本机和服务端都是空的）。见 [m10 的「第一次打开时自己弹出」](modules/m10-import.md#第一次打开时自己弹出2026-11-20) |
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

文件夹名 `cc.drifting.client.v2` 作者 2026-11-20 确认就用它；**发了 0.2.0 以后就不能再改**（老用户的书在那里）。

## 发布顺序

| 步 | 谁 | 做什么 | 要什么 |
| --- | --- | --- | --- |
| 0 | ~~作者~~ | ~~先定「要作者定的事」那几条~~ 2026-11-20 都定了，见下面「作者定了的事」 | — |
| 1 | 作者 | 在仓库 Settings › Secrets and variables › Actions 里加新变量（已有的证书、公证、更新钥匙、Hosted 地址都不用动，0.1 的发布已经在用；证书必须就是 0.1 在用的那张 Developer ID，同一个团队，钥匙串里的登录和 API Key 才读得到、不弹框） | `DRIFTING_LAST_V1_TAG`：最后一个 0.1 Release 的标签，现在是 `v0.1.0-alpha.12`。要开崩溃上报再加 `DRIFTING_SENTRY_DSN`、`SENTRY_ORG`、`SENTRY_PROJECT`（变量）和 `SENTRY_AUTH_TOKEN`（`release` 环境的密钥）；整张表在工作流文件开头 |
| 2 | ~~作者~~ 监管会话 | ~~本机装 Metal Toolchain，打一个预编译着色器的开发包看一眼~~ 作者 2026-11-20 同意装，当天装了、验过，见下面「验证预编译着色器」 | — |
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

装 Metal Toolchain（Xcode 的一个单独下载，约 840 MB；换一台机器打包时要再装一次）：

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

2026-11-20 在这台机器上做过一遍（Xcode 27.2，Metal Toolchain 27B47）：包打出来了（release 档案，209 MB，程序 131 MB），`check-binary` 报「precompiled Metal shaders」「not the release identity」；用一个一次性的 profile 打开，首次引导那一屏的字海、卡片、字和按钮都画出来了（截了窗口的图看的）。阴影和玻璃在这一屏上不多，作者打开日常界面时再扫一眼就行。CI 的发布任务用的是 GitHub 的 macOS 机器，草稿工作流里有一步每次先装 Metal Toolchain；那一步要等工作流第一次真跑才算验过。

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
| 代码签名（Authenticode） | **作者 2026-11-20 定：不签，照 0.1**。不签时第一次运行 SmartScreen 会提示「Windows 已保护你的电脑」（点「更多信息」→「仍要运行」），发布说明里照 0.1 写一句；更新照样由 minisign 签名保证。要签得买代码签名证书，工作流里在「Sign the installer with the updater key」前面加一步 | 不签 |
| 实机验收 | 作者只有一台 Windows 11 ARM 虚拟机：开发身份的安装包从 `next` 工作流每次运行的产物里下（`windows-installer` 任务打的 `drifting-next-windows-arm64-<提交号>`，x64 的叫 `…-windows-x64-…`；`dist` 档，留 7 天），照 [m43-windows.md](modules/m43-windows.md) 的清单走。2026-11-21 监管会话先用脚本走了一遍（装、启动、单实例、深链接、通知区收起和唤回、原地更新），查出两处启动不了的问题并修了，见 m43 的「第一次在干净的 Windows 上装和启动」；修好的包还没重验，通知区、微软拼音、观感等要作者点 | **挡发布**（progress「等作者的事」第 3 条） |

## 作者定了的事（2026-11-20，「全部按照推荐做」）

| 事 | 定的 | 还差什么 |
| --- | --- | --- |
| Windows 签不签名（D10） | 不签，照 0.1。第一次运行 SmartScreen 会提示，发布说明里照 0.1 写一句；更新照样由 minisign 签名保证 | 写发布说明时带上那一句（第 4 步） |
| GPUI 的补丁 | 挂 `0001`（空闲时停掉显示链接，不挂的话窗口空闲时也有约 1% 的 CPU）。读屏和组字那几个不挂，等真实输入法验收再定 | 一个能推送的公开 fork：作者的 GitHub 账号下没有 Zed 的 fork，建公开仓库要作者点头。有了以后：在 `v1.27.0` 上打 `0001`、推一个分支，`next/Cargo.toml` 的 `gpui`、`gpui_platform`、`sum_tree` 改指它的提交，重跑全套和空闲 CPU 的测量 |
| 崩溃上报 | 开 | 本机没有 Sentry 的令牌，要作者先在浏览器里登录 sentry.io。之后监管会话建客户端项目，把 `DRIFTING_SENTRY_DSN`、`SENTRY_ORG`、`SENTRY_PROJECT` 填进仓库变量；`SENTRY_AUTH_TOKEN`（上传符号用）是密钥，要作者自己放进仓库的 `release` 环境，不放也能发，只是崩溃栈没有函数名。开之前在签名的正式包上验一次 ⌘Q（[f7 发版前第 4 条](foundations/f7-platform.md#发版前必须由作者做的事)） |
| 新版自己的文件夹名 | `cc.drifting.client.v2`，就用它。**发了 0.2.0 以后不能再改** | — |
| 老用户升级后第一次打开 | 找到旧书库就自己弹出现有的导入对话框，不加新界面和新文案 | 做了（[m10](modules/m10-import.md#第一次打开时自己弹出2026-11-20)）；正式身份的包上要在第 8 步看一眼 |
| 登录状态下导入的两句文案 | 照现在：「这个账号已经有书了，直接同步就行。」「文件夹里还有 N 个账号资料库没导入」 | — |
| 装 Xcode 的 Metal Toolchain | 装 | 装了、验过（「验证预编译着色器」） |
| 服务端「清空某个账号的新版同步数据」 | 发布前做，部署前再问作者 | 脚本做了，在服务端仓库的本地 `main`（`dcd1570`，没推送、没部署），见下面「导坏了怎么重来」。部署要作者点头 |

更早定的：两个平台一起发（2026-11-20）。

### 导坏了怎么重来（服务端的清空脚本）

登录着的账号只能导一次：账号在新格式里有过东西（删掉的也算）就不再让导。第一次导坏了、而且已经传上去时，要先把这个账号在服务端的新版同步数据清空，才能重新导。

- **服务端**：`scripts/reset-loro-v2-account.ts`（服务端仓库，`docs/loro-sync-v2.md` 的「Operator reset」、`docs/production.md` 的「Resetting an account's loro-v2 sync」）。在 API 容器里跑，按邮箱或用户 id 选一个账号；默认只报告会删什么，加 `--yes` 才删。只动这个账号的新版同步数据（连删除记录一起），旧版（0.1）的同步数据、别的账号、账号本身都不动。运营台仍然只读，没有网页入口。
- **每台设备都要先丢掉这个账号在本机的新版书库，然后才能清服务端。** 协议里没有「这条同步流被重置过」的记号，服务端自己挡不住还留着旧书库的设备：那台设备要么悄悄漏掉新传上去的开头，要么把新导入的内容并进旧的书里；它要是再删掉那些旧书，删除记录会把重新导入的书一起删掉（重新导入用的是同样的书 id）。退出登录不够，账号的书库还留在磁盘上。
- **客户端没有做这件事的界面。** 开发版最简单：换一个 `--instance` 名字，就是一套全新的数据文件夹。正式版只能手动处理新版的数据文件夹，这条路没演练过；要对别人的账号用之前，先在开发版上完整走一遍。
- 以后要让它对任何账号都安全，得给同步协议加一个重置代号，让留着旧书库的设备被明确拒绝。服务端已有的能力协商（缺能力的客户端收到「需要升级」）可以在发版以后再加这一项，不必赶在 0.2.0 之前。做法记在服务端 `docs/loro-sync-v2.md` 的「Operator reset」末尾。
- 第一个用到它的多半是作者自己试账号迁移的时候。

## 本机演练（2026-11-20）

在开发身份的 dist 包上，用一次性密钥和本地清单，把「打包 → 签更新包 → 写清单 → 查到 → 下载验签 → 换包」走了一遍：查到新版本、下载加验签约 0.1 秒，退出时换包 0.6 到 1.6 秒（机器很忙）；换完签名校验通过，旧包里多出来的东西清掉了。同版本、更旧的版本、旧包冒充新版本号、被改过一个字节的包、别的钥匙签的包，五种都拒绝，已装的包一点没动。数字和步骤见 [f7-platform.md 的「第五轮」](foundations/f7-platform.md#第五轮发布交接的工程准备)。

预编译着色器那一面 2026-11-20 装了 Metal Toolchain 以后补做了（见「验证预编译着色器」）。没在本机做、也做不了的：Developer ID 签名和公证、工作流真跑一遍、正式身份的程序真打开（会读写这台机器上正式版的数据）、Windows 的正式身份安装包和更新包演练（本机没有 Windows，只能在 CI 上打）。
