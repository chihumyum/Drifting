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
| `DRIFTING_LOG=error\|warn\|info\|debug\|trace` | stderr 日志级别，默认 `warn`。GPUI 自己的报错（字体、着色器、窗口）只走日志 |
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
- bundle id 是开发用的 `cc.drifting.next.dev`，和装着的正式版互不干扰。接管正式版身份、签名、公证和 DMG 是 F7 的事。
- 不用开发者证书签名，只做 ad-hoc 签名（Apple 芯片要求改过的可执行文件至少有这个）。本机打的包双击就能开；从别处下载的副本会被 Gatekeeper 拦下。
- 正式包要预编译着色器、去掉 `runtime_shaders`，脚本里记成了待办。

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
  script/bundle-mac     打 .app
  script/measure-startup-mac
                        测冷启动到首帧
```
