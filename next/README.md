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
| `DRIFTING_CRASH_REPORTS_IN_DEV=1` | 开发构建也发崩溃报告（还要构建时带 DSN，平时没有） |
| `DRIFTING_DEV_UPDATE_MANIFEST`、`DRIFTING_DEV_UPDATER_PUBLIC_KEY` | 开发构建从本地清单更新，只用于自测；见 F7 文档 |
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
```

CI 是 [`.github/workflows/next.yml`](../.github/workflows/next.yml)：只在 `next/` 或它自己变化时跑，macOS 和 Windows 各一条，跑上面三项和 `cargo build`，macOS 上再打一次 dev 包。

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
  app/drifting/         可执行程序：窗口、标题栏、菜单、外观、开发探针
  crates/dr-platform/   F7：身份与目录、日志、崩溃上报、钥匙串、深链接与单实例、自动更新
  script/bundle-mac     打 .app，可选 .dmg 和更新包
  script/bundle-windows.ps1, script/windows/drifting.nsi
                        Windows 安装包
  script/release-next.draft.yml
                        新版发布工作流的草稿，不会被触发
  script/measure-startup-mac
                        测冷启动到首帧
```
