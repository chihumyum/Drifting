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
| 发布工作流 | `next/script/release-next.draft.yml` 写全了：检查、macOS 打包签名公证、更新包签名、符号上传、写 `update.json`、带上 0.1 最后一版的 `latest.json`、Windows 两个架构、建草稿 Release。放在 `next/script` 里，GitHub 不会跑它，挪进 `.github/workflows` 就会跑（第 5 步） |
| 旧版那头 | 已经做了，而且已经发出去了：0.1.0-alpha.11 和 alpha.12 都带着交接和「先读 `update.json`、读不到再读 `latest.json`」（提交 `c788d72b2`）。0.1 的发布流程本来就只出 `latest.json`，不会出 `update.json` |
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
| 3 | 作者 + 监管会话 | 真实条件下的验收（[progress.md](progress.md)「等作者的事」第 4、8 条），尤其导入自己的 0.1 库、Windows 实机 | — |
| 4 | 监管会话 | 改版本号 `next/app/drifting/Cargo.toml` → `0.2.0`；写发布说明 `docs/releases/0.2.0.md`（第一行 `# Drifting 0.2.0`，先中文后英文，纯文本） | — |
| 5 | 监管会话（作者同意推送） | 把工作流挪进来：`git mv next/script/release-next.draft.yml .github/workflows/release-next.yml`；**同一个提交里**把 `release.yml` 的触发改成 `tags: ['v0.1.*']`（现在两个都认所有 `v*` 标签），并把 `scripts/check-ci-contract.mjs` 里「release.yml 必须认 `v*`」那条改成新的规矩；跑 `pnpm ci:contract:check`、`cargo xtask check`；本地 `next/script/check-release v0.2.0` | — |
| 6 | 作者同意后推 | `git tag v0.2.0 && git push origin main v0.2.0`，等工作流跑完，出草稿 Release。草稿谁也看不到，装着的 App 也不会收到 | — |
| 7 | 作者 | 检查草稿：文件齐（`Drifting_0.2.0_macos_arm64.dmg`、`Drifting_0.2.0_aarch64.app.tar.gz` 和 `.sig`、两个 Windows 安装包和 `.sig`、`update.json` 里有 `darwin-aarch64`、`windows-x86_64`、`windows-aarch64` 三个键、`latest.json` 的版本是 alpha.12、`SHA256SUMS.txt`） | — |
| 8 | 作者 | 用草稿里的包，在**不是日常用的** macOS 用户（或虚拟机）和 Windows 虚拟机里把「0.1 → 新版」走一遍：先装 alpha.12、写几个字、登录、存一个 API Key，关掉；再把草稿里的 DMG（Windows 是安装包）装上去，打开看：书能导入、登录还在、API Key 还在、`drifting:` 链接能跳进来。正式身份的包会读写那台机器上正式版的数据，所以**不要在日常账户上做**。要连 0.1 更新器自动换包那一下也验，就在私有测试仓库用测试密钥跑一遍工作流（[f7「下一个里程碑建议」](foundations/f7-platform.md#下一个里程碑建议)第 1 条） | 一台干净的 Mac 账户或虚拟机、Windows 虚拟机 |
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

## 只发 macOS 时 `update.json` 怎么写

先说结论：**推荐两个平台一起发**。只发 macOS 时，`update.json` 里只写 `darwin-aarch64` 一个键，Windows 上的老用户不会被升级，但他们每次检查更新都会在「设置 › 更新」里看到「检查失败」，直到 Windows 的键补上。

原因（读的是 0.1 用的 `tauri-plugin-updater` 2.10.1）：0.1 的更新器依次读两份清单，**拿到第一份能读懂的就停**，不会再去读 `latest.json`；然后它**先找本平台的下载地址、再比版本号**。所以 `update.json` 里没有 `windows-x86_64` 这个键时，Windows 上的 alpha.11、alpha.12 每次检查都报「找不到这个平台」：不升级（这是想要的），但会报错（自动检查只在设置那一行显示，不进通知中心，另外发一条诊断日志）。

| 做法 | Mac 老用户 | Windows 老用户 |
| --- | --- | --- |
| 甲（推荐）：两边一起发，`update.json` 三个键都有 | 升级 | 升级 |
| 乙：只发 macOS，`update.json` 只有 `darwin-aarch64` | 升级 | 不升级；设置里一直显示检查失败，等下一个两边都有的版本 |
| 丙：先发 Release 但不挂 `update.json` | 不自动升级，只能手动下 DMG | 不升级，也不报错 |

**绝对不要**：给 Windows 的键填 0.1 的安装包（版本号是全清单共用的，Windows 会每 3 小时把 0.1 重装一遍）；也不要用不分平台的清单写法（顶层直接写 `url`、`signature`），那样 Windows 会去下 macOS 的包。

工作流里的情形：Windows 任务失败时，草稿里的 `update.json` 就只有 macOS 一个键，正好是乙。这时先别 Publish，重跑失败的 Windows 任务（「add Windows to the draft release」只往草稿里加，Publish 以后它不再改）。

## 要作者定的事（带推荐）

1. **Windows 签不签名（D10）。** 推荐：这一版先不签，和 0.1 一样；第一次运行 SmartScreen 会提示「Windows 已保护你的电脑」，发布说明里照 0.1 写一句。要签就要买代码签名证书，工作流里在「Sign the installer with the updater key」前面加一步。
2. **GPUI 的补丁挂不挂。** 补丁在 `next/patches/gpui`：停掉空闲时的显示链接（不挂的话窗口空闲时也有约 1% 的 CPU）、读屏的两处修正、组字取消的接口。推荐挂 0001（省电，对所有人都有用），读屏和组字那几个等真实输入法验收再定。挂补丁要作者指定一个能推送的 fork 仓库，`next/Cargo.toml` 改指向它。
3. **只发 macOS 还是两边一起。** 推荐一起（上一节）。Windows 实机手测（progress「等作者的事」第 3 条）没做完就等它。
4. **崩溃上报开不开。** 推荐开：在 Sentry 建好（或复用旧的 `drifting/drifting-client`）项目，填第 1 步那四项；同意开关在设置里，首次说明在欢迎卡上（m35-account.md）。不填也能发，只是这一版收不到崩溃。开之前在签名的正式包上验一次 ⌘Q（[f7 发版前第 4 条](foundations/f7-platform.md#发版前必须由作者做的事)）。
5. **新版自己的文件夹名。** 替作者定成 `cc.drifting.client.v2`（放在 0.1 文件夹旁边）。没意见就不用回；要改必须在发 0.2.0 之前。

## 本机演练（2026-11-20）

在开发身份的 dist 包上，用一次性密钥和本地清单，把「打包 → 签更新包 → 写清单 → 查到 → 下载验签 → 换包」走了一遍：查到新版本、下载加验签约 0.1 秒，退出时换包 0.6 到 1.6 秒（机器很忙）；换完签名校验通过，旧包里多出来的东西清掉了。同版本、更旧的版本、旧包冒充新版本号、被改过一个字节的包、别的钥匙签的包，五种都拒绝，已装的包一点没动。数字和步骤见 [f7-platform.md 的「第五轮」](foundations/f7-platform.md#第五轮发布交接的工程准备)。

没在本机做、也做不了的：预编译着色器那一面（要 Metal Toolchain）、Developer ID 签名和公证、工作流真跑一遍、正式身份的程序真打开（会读写这台机器上正式版的数据）、Windows 的正式身份安装包（本机没有 Windows）。
