# 交给外部代理的模块任务书

> **2026-11-08 更新**：Claude 的用量快用完了，仓库里的 Claude 会话停下，后面的活全交给外部代理。
>
> - Codex：帮手那一条，见 [codex-queue.md](codex-queue.md)。
> - Antigravity：Super View、账号、Windows，见 [antigravity-queue.md](antigravity-queue.md)。
> - 基座和已开工模块的剩余：见 [remaining.md](remaining.md)。
> - 合并 `main` 的整合者：照 [integration.md](integration.md) 做。
>
> 下面「谁管哪里」的分工不再适用，以 remaining.md 为准。

2026-11-08。`next/` 重写里还没人做的独立模块，一个文件一个任务，给 Codex 这类外部编码代理做。仓库里另有一组 Claude 会话在做基座和别的模块，由监管会话统一审、统一合进 `main`。这一页是所有任务共用的约定，每份任务书只写自己的那部分。

## 先读

1. 仓库根的 `AGENTS.md`，尤其是「New workspace (`next/`)」一节：钉住的版本、检查命令、`dr_testkit` 的种子、`cargo xtask dev`、调试桥。
2. [`docs/rust-rewrite/README.md`](../README.md)：阶段、决定 D1–D10。
3. [`progress.md`](../progress.md)：每个基座和模块现在做到哪、接口在哪。
4. [`modules.md`](../modules.md) 里自己那个模块的一行：旧版功能、旧版代码位置、依赖。
5. 依赖的基座和模块的结论文档（`foundations/`、`modules/` 下）。写法照它们来。

旧版（0.1，Tauri + React）的代码在仓库里：`src/`、`src-tauri/`。它是功能和交互的标准答案，新版照它的行为做，但**不逐行搬 TypeScript**：数据模型已经换成 Loro（F1），命令走 F3 的注册表，界面走 GPUI 和 F5 的 `dr-ui`。

## 怎么做、怎么交

- 从当前 `main` 开一个自己的分支和 worktree（比如 `codex/m21-story-graph`），只在上面提交。**不合进 `main`，不推送，不开 PR。** 做完把分支名和提交列表交给作者，作者转给监管会话合。
- 做的过程中需要新的 `main`，就 `git merge main`，不要 rebase 已经交出去的提交。
- 每个模块写一份结论文档 `docs/rust-rewrite/modules/mNN-<名字>.md`，结构照已有的（比如 [m40-markdown-folder.md](../modules/m40-markdown-folder.md)）：做了什么（大白话）、定下的事、接口、外壳里的挂接点、测试、待协调、代码位置。
- **不要改 `progress.md`**，那一页只由监管会话维护。
- 别的会话负责的 crate（见下面「谁管哪里」），只在任务书写明的挂接点上动，改动尽量小。改不动、或者需要对方加接口的，写进自己文档的「待协调」，不要自己大改别人的 crate。
- 交之前在 `next/` 下跑全套检查：

  ```bash
  cargo fmt --all --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  cargo xtask check
  ```

  再在仓库根跑 `pnpm public:check`。字体是构建产物（`next/.cache/fonts`），缺了会让一两个画字的测试失败：先构建一次，或者在交回时注明。

## 共用的规矩

- **共享文件只加不改**：
  - `next/Cargo.toml` 的 `members` 一行一个、按字母排；新依赖进 `[workspace.dependencies]`，至少钉到次版本。
  - `next/app/drifting/src/main.rs` 里每个模块一行 `init`。
  - 界面文字：旧版有的键写进 `next/crates/dr-i18n/keys.txt`，再跑 `python3 crates/dr-i18n/script/sync-locales.py`；旧版没有的写进 `next/crates/dr-i18n/own/<语言>.json`，九种语言都要写。
  - `cargo xtask check` 的许可、依赖层等表在 `next/xtask/src/gates/`，新 crate 要登记的就登记。
- **测试数据**只用 `dr_testkit::seed`（tiny / lite / heavy / showcase）和 `dr_testkit::samples`，不另写语料。合成图片、PDF 在 `dr_testkit::media`。
- **不碰真服务。** 账号、同步、分享、模型接入这些，测试一律对着本机起的假服务或录好的合成响应；不连 `api.drifting.cc`，不调真的模型 API，不用真密钥。真服务上的手测留给作者。
- 不往仓库提交凭据、`.env`、个人路径、数据库、签名材料，也不提交从官方服务拷来的数据。
- **界面规矩**（AGENTS.md「UI rules」，新版照旧）：
  - 没有自定义右键菜单，操作放在悬停卡底部一行；
  - 不用左边竖条做强调；
  - 弹出层走 `dr-ui` 的浮层；
  - H1/H2/H3 只叫 H1/H2/H3；
  - 不自编说明文字和提示句，旧版有的照搬，没有的不加。
- **证据**：契约用测试断言，不提交 JSON；性能数字只在机器空闲时量，写进文档当参考。
- 真窗口验收用 F8 的调试桥：`cargo xtask dev --debug-bridge`，再用 `cargo drifting app …` 驱动。没有截图权限时，用 `state` 读界面状态。

## 谁管哪里

下面这些由仓库里的会话负责，只在任务书写明的地方动：

- `dr-model`、`dr-doc`：F1
- `dr-store`：F2
- `dr-workspace`：F3。新的命令和查询要登记进注册表，改它就是改能力清单快照
- `gpui-prose`、`dr-editor`：F4
- `dr-ui`、`dr-view-sea`、`dr-view-shelf-art`：F5
- `dr-shell`、`dr-i18n`：F6
- `dr-platform`、`dr-view-feedback`：F7
- `dr-testkit`、`dr-cli`、`dr-debug-*`、`xtask`：F8
- 各个 `dr-view-*`：负责它的那一路，写在 `progress.md` 对应那行

需要别人加接口时，在「待协调」里写清：要什么、为什么、你那边先怎么绕。

## 任务和先后

**连续做的顺序见 [codex-queue.md](codex-queue.md)**：一个做完接着做下一个，不用等合并。下表是每个模块的依赖。

| 任务书 | 模块 | 什么时候能开工 |
| --- | --- | --- |
| [m21-story-graph.md](m21-story-graph.md) | M21 故事图 | F6 的 `add_super_view` 进 `main` 后接上；模块本身现在就能写 |
| [m22-element-overview.md](m22-element-overview.md) | M22 要素全景 | 同上 |
| [m23-review-materials.md](m23-review-materials.md) | M23 审阅与素材 | 同上 |
| [m27-agent-runtime.md](m27-agent-runtime.md) | M27 帮手运行时核心 | 现在 |
| [m28-model-providers.md](m28-model-providers.md) | M28 模型接入 | M27 的驱动接口定下来以后（可以和 M27 同一个任务连着做） |
| [m29-agent-tools.md](m29-agent-tools.md) | M29 工具 | M27 之后 |
| [m31-agent-panel.md](m31-agent-panel.md) | M31 帮手面板与改动显现 | M27 之后；F6 的帮手栏挂接点进 `main` 后接上 |
| [m32-mcp.md](m32-mcp.md) | M32 MCP | M29 之后 |
| [m30-long-tasks-memory.md](m30-long-tasks-memory.md) | M30 长任务、记忆与主动建议 | M29、M31 之后 |
| [m33-image-generation.md](m33-image-generation.md) | M33 生图（实验） | M28 之后 |
| [m34-dictation.md](m34-dictation.md) | M34 语音口述（可以放最后） | M31 之后 |
| [m35-account.md](m35-account.md) | M35 账号与登录 | 现在 |
| [m36-sync-v2.md](m36-sync-v2.md) | M36 Hosted 同步 v2 | M35 之后（会话令牌）；协议层现在就能写 |
| [m37-preference-sync.md](m37-preference-sync.md) | M37 偏好同步 | M35 之后 |
| [m38-share-links.md](m38-share-links.md) | M38 分享链接（发布端） | M35 之后 |
| [m43-windows.md](m43-windows.md) | M43 Windows 版 | 现在 |

帮手这一组（M27–M34）彼此依赖最紧：最好按表里的顺序，一次只开一两个，等前一个合进 `main` 再开下一个。账号这一组（M35–M38）也是先 M35。Super View 三个彼此独立，可以同时开。

不在这里的：M16 构想、M17 关系、M26 沉浸写作、M42 自动更新，以及 M19、M24 的收尾，都已经有会话在做。
