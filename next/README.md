# next/：Rust + GPUI + Loro 重写工作区

计划见 [docs/rust-rewrite](../docs/rust-rewrite/README.md)，各路进度见 [progress.md](../docs/rust-rewrite/progress.md)，工程骨架的结论见 [P0-A](../docs/rust-rewrite/spikes/p0-a-skeleton.md)。

旧客户端（`src/`、`src-tauri/`、`crates/` 等）照旧维护，规则见仓库根目录的 `AGENTS.md`；这个工作区和旧代码互不依赖。

## 构建与运行

下面的命令都在 `next/` 里跑。工具链由 `rust-toolchain.toml` 指定（1.98.1），rustup 会自动装上。

```bash
cargo run -p drifting
```

- 第一次编译 GPUI 要几分钟；每个 worktree 有自己的 `next/target`。
- 开发构建用 GPUI 的 `runtime_shaders`：Metal 着色器在启动时编译，不需要另装 Xcode 的 Metal Toolchain。
- 目标平台是 macOS 和 Windows；Linux 没有验证过。

### 开发开关

都是环境变量，不设就是正常行为：

| 变量 | 作用 |
| --- | --- |
| `DRIFTING_LOG=<级别或目标>` | 日志级别，`tracing` 的写法（`debug`、`warn,dr_platform=trace`）。开发时打到 stderr，默认 `warn`；装好的版本写进日志文件（位置见 [F7](../docs/rust-rewrite/foundations/f7-platform.md#日志)），设了它也同时打到 stderr。GPUI 自己的报错（字体、着色器、窗口）只走日志 |
| `DRIFTING_LOG_FILE=1` | 开发时也写日志文件 |
| `DRIFTING_PROFILE=<名字>` | 开发版的数据、日志文件夹、钥匙串服务和单实例锁都加上这个名字，几个 worktree 的开发版互不干扰 |
| `DRIFTING_CRASH_REPORTS_IN_DEV=1` | 开发构建也发崩溃报告（还要构建时带 DSN，平时没有）；反馈也改走服务而不是邮件（还要有服务地址） |
| `DRIFTING_DEV_API_BASE_URL` | 开发构建的反馈发到这个服务，只认 `https://` 或本机 `http://127.0.0.1:<端口>`，用于对着本机服务验收；见 [m39-feedback.md](../docs/rust-rewrite/modules/m39-feedback.md) |
| `DRIFTING_DEV_UPDATE_MANIFEST`、`DRIFTING_DEV_UPDATER_PUBLIC_KEY` | 开发构建从测试清单更新（本地文件，或本机 `http://127.0.0.1:<端口>/…`），只用于自测；不设就不查更新。见 F7 文档和 `docs/rust-rewrite/modules/m42-update.md` |
| `DRIFTING_APPEARANCE=light\|dark` | 强制浅色或深色，不动系统设置。macOS 上设的是本应用自己的外观，和系统切换走同一条路 |
| `DRIFTING_DEV_PROBE=<文件>` | 把启动各阶段的时间和外观变化按 JSON 行追加到文件；`-` 表示写到 stderr |
| `DRIFTING_DEV_EXIT_AFTER_FIRST_FRAME=1` | 画完首帧就退出，给测启动时间用 |

```bash
DRIFTING_APPEARANCE=dark DRIFTING_DEV_PROBE=- cargo run -p drifting
```

macOS 上必须给 `gpui_platform` 开 `font-kit` 特性，不然窗口里一个字都不画（只在 `warn` 日志里说一句）。

## 打包（macOS）

```bash
script/bundle-mac
```

- 产物是 `target/bundle/Drifting Next.app`：release 构建，带 `Info.plist`、旧版的 `.icns` 和分层图标（`Assets.car`，要 Xcode 26 以上的 `actool`）。
- 加 `--open` 打包完就打开；加 `--debug` 打 dev 构建，快很多。
- 加 `--dmg` 再出一个不签名的 `.dmg`，加 `--archive` 再出更新包 `.app.tar.gz`。
- 加 `--dist` 打发出去的那种构建：`dist` 档案（release 加行号表），包里的可执行文件剥掉符号，符号留在包旁边的 `Drifting Next.app.dSYM`（给 Sentry 还原崩溃位置，不随包发）。Windows 是 `-BuildProfile dist`，符号是可执行文件旁边的 `drifting.pdb`。`release` 档案不变，照旧给基准测试用。
- bundle id 是开发用的 `cc.drifting.next.dev`，链接协议是 `drifting-next-dev:`，和装着的正式版互不干扰。接管正式版身份、签名、公证在 F7 的交接里，见 [f7-platform.md](../docs/rust-rewrite/foundations/f7-platform.md)。
- 不用开发者证书签名，只做 ad-hoc 签名（Apple 芯片要求改过的可执行文件至少有这个）。本机打的包双击就能开；从别处下载的副本会被 Gatekeeper 拦下。
- 正式包要预编译着色器、去掉 `runtime_shaders`，脚本里记成了发版前的待办。

Windows 安装包（NSIS，只能在 Windows 上打，要装 NSIS 3）：

```powershell
script/bundle-windows.ps1
```

安装位置、卸载项和协议与旧版 Tauri 安装器一致；`script/check-windows-installer.ps1` 是 CI 用的安装、升级、卸载检查，会改当前用户的注册表，别在自己用的机器上跑。

测启动时间（打开 5 次，每次画完首帧就退出）。机器忙的时候墙钟时间会成倍变长，结果里带着当时的负载：

```bash
script/measure-startup-mac --runs 5
```

## 检查

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo xtask check
```

`cargo xtask check` 是新工作区的门禁，一条命令跑完 9 道：

- 隐私与凭据、大文件；
- 退役产品、术语（构想 / Ideas；H1/H2/H3 只叫 H1/H2/H3）；
- 已发布迁移的哈希；
- 许可证、依赖方向；
- 测量证据；
- `cargo audit`。

`--list` 列出全部，`--only` / `--skip` 挑着跑（离线时 `--skip audit`）。漏洞审计要先装 `cargo install cargo-audit --version 0.22.2 --locked`。每一道查什么，见 [F8](../docs/rust-rewrite/foundations/f8-testkit.md#门禁cargo-xtask-check)。

CI 是 [`.github/workflows/next.yml`](../.github/workflows/next.yml)：

- **什么时候跑**：`next/`、`docs/rust-rewrite/`、`next/` 还在引用的旧目录资源，或这个工作流本身变化时；
- **两个平台**：macOS 和 Windows 各一条，跑上面前三项和 `cargo build`；
- **macOS 上再加**：`cargo xtask check`、仓库的公开边界检查，再打一次 dev 包。

## 测试数据、证据、基准

都在 `crates/dr-testkit`，做法见 [F8](../docs/rust-rewrite/foundations/f8-testkit.md)：

- **种子**：只用 `dr_testkit::seed`，预设 tiny / lite / heavy / showcase。样书在 `dr_testkit::samples`。不要另写随机语料。
- **证据**：契约类在测试里断言，不提交 JSON。测量类只在里程碑提交：

  ```bash
  cargo run --release -p dr-testkit --bin bench -- <套件> --milestone <里程碑>
  ```

  源码变了只报「过期」：

  ```bash
  cargo xtask evidence --check
  ```

- **崩溃试验**：`dr_testkit::crash`，示范在 `crates/dr-testkit/tests/crash_store.rs`。

## 开发实例与命令行

```bash
cargo xtask dev                                   # 按 worktree 设 DRIFTING_PROFILE 再启动
cargo xtask dev --instance two --print-config     # 同一 checkout 的第二个实例；只打印配置
cargo xtask dev --hot                             # 热重载：经 dx serve --hot-patch 起，界面代码存盘即换（要 dx 0.7.10）
cargo drifting workspace describe                  # F3 的命令和查询（--json 带 Schema）
cargo drifting workspace call chapter.list --library <目录> --input '{"book": "…"}'
cargo drifting workspace scenario 验收.json --library <目录> --yes   # 脚本化的一串调用
cargo drifting workspace scenario seed:lite --library <目录> --yes   # 写种子（seed-commands: 走命令）
cargo drifting workspace inspect --library <目录>  # 只读查看一个库
```

- **隔离**：在 linked worktree 里，每个 checkout 的开发版有自己的数据、日志、钥匙串服务和单实例锁。
- **离线改库**：要应用关着、先备份、加 `--yes`。查询和只读的场景在库的副本上跑，不用 `--yes`。

## 调试桥：照脚本操作真实窗口

开发版带上调试桥以后，Agent 会话或脚本能打开书和章、打字、按键、触发动作、按名字（无障碍树里的名字）点按钮和菜单、调 F3 的命令，读回稿纸上的文字、章首和要素页头、外壳的状态、设置和截图。正式包里没有它（`cargo xtask check` 的 `debug-bridge` 门禁、`cargo xtask check-binary`）。

```bash
cargo xtask dev --debug-bridge                    # 这个 worktree 的开发版，带调试桥
cargo drifting app state                          # 连上正在跑的那个（按 profile 找）
cargo drifting app book 慢钟                       # 从书架打开一本书
cargo drifting app open 第一章                     # 还有 type、key、dispatch、call、text、wait、screenshot、quit
cargo drifting app raw ui.press --params '{"label":"More actions"}'   # 按无障碍名字点（macOS）
cargo drifting app raw panel.answer --params '{"path":"/…/a.drifting"}'  # 下一个系统打开/存储面板答这个路径（再按应用的按钮）
cargo build -p drifting --features debug-bridge
cargo drifting workspace scenario crates/dr-cli/scenarios/writing-loop.json --app target/debug/drifting
                                                  # 阶段 2 写作闭环（打字、回车、⌘Z、换章、重开），在临时 profile 里跑完再删掉
                                                  # 同一目录下还有 M03 章首章末、M09 快照历史、M10 导入、M11 要素页、
                                                  # M18 批注、设置、M39 反馈对话框、M41 恢复备份和一本书导出再导入
```

方法表、场景的写法、被遮住的窗口和截图的细节见 [f8-testkit.md](../docs/rust-rewrite/foundations/f8-testkit.md)「调试桥」。

## 工作区约定

- **成员**：`Cargo.toml` 的 `members` 一行一个、按字母排，几路分支同时加 crate 也不冲突。
- **依赖**：新依赖加进 `[workspace.dependencies]`，至少钉到 minor（`"1.2"`，0.x 钉到 `"0.6"` 这一级）；成员里写 `xxx.workspace = true`。`Cargo.lock` 入库，检查和 CI 都带 `--locked`。
- **Loro** 精确钉 `=1.17.1`，升级单独做、单独验。
- **GPUI** 钉在 Zed 的发布标签（现为 `v1.27.0`，决定 D1），`gpui` 和 `gpui_platform` 两项一起改。
- **`[patch.crates-io]`** 照抄 Zed 同一标签根目录 `Cargo.toml` 里 GPUI 用得到的补丁。git 依赖不继承上游的 `[patch]`，删了会编不过或行为不同。
- **许可**：Zed 的 `editor`、`text`、`rope`、`ui`、`theme` 等是 GPL-3.0，不要抄；`gpui` 及其平台 crate、`sum_tree` 是 Apache-2.0，可以参考和依赖。

### 升级 GPUI

每月一次，单独一个分支：

1. 选 Zed 新的稳定标签，读两个标签之间 `crates/gpui*` 的改动。
2. 把 `gpui`、`gpui_platform` 的 `tag` 一起改掉；对照新标签的根 `Cargo.toml` 更新 `[patch.crates-io]`。
3. 工具链对齐新标签的 `rust-toolchain.toml`，同时改 `next.yml` 里的 `toolchain`。
4. `cargo update -p gpui -p gpui_platform`，然后跑全部检查、`script/bundle-mac --open` 看一眼窗口、标题栏、菜单和深浅色。
5. 重跑探针档基准（[benchmarks.md](../docs/rust-rewrite/benchmarks.md)），和升级前对比；输入法矩阵抽测。
6. 结论和踩到的坑记进提交说明。

## 目录

```text
next/
  Cargo.toml            虚拟工作区：成员、钉住的依赖、补丁
  rust-toolchain.toml   工具链
  .cargo/config.toml    别名：cargo xtask、cargo drifting
  app/drifting/         可执行程序：窗口、标题栏、菜单、外观、开发探针
  crates/dr-cli/        F8：开发命令行（cargo drifting workspace …、cargo drifting app …）和验收场景
  crates/dr-debug-bridge/, crates/dr-debug-protocol/
                        F8：调试桥（只在 --features debug-bridge 的开发版里）和它的协议、客户端
  crates/dr-platform/   F7：身份与目录、日志、崩溃上报、钥匙串、深链接与单实例、自动更新、反馈与诊断摘要
  crates/dr-testkit/    F8：种子、样书、测量证据、崩溃试验台、基准
  xtask/                F8：门禁（cargo xtask check）和开发启动器（cargo xtask dev）
  script/bundle-mac     打 .app，可选 .dmg 和更新包
  script/bundle-windows.ps1, script/windows/drifting.nsi
                        Windows 安装包
  script/release-next.draft.yml
                        新版发布工作流的草稿，不会被触发
  script/measure-startup-mac
                        测冷启动到首帧
```
