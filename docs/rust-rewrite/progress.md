# 推进状态

监管会话维护这一页：每路工作合进 `main` 时更新它的一行。哪一路做完、结论是什么，以这一页和各自的结论文档为准。

## 怎么推进

- 每一路是一个独立会话，在自己的 worktree 和分支上做，只改分给它的目录。
- 做完后在分支上提交，交回监管会话；监管会话审过再本地合进 `main`。各路会话不自己合 `main`，不推送，不开 PR。
- 要作者定的事（视觉方案、D7、需要真人手测的输入法）汇总到监管会话，由它一起问。

## 骨架

`next/` 工作区已建：

- GPUI 钉在 Zed `v1.27.0`，工具链 1.98.1，Loro `=1.17.1`；
- `app/drifting` 只是一个空窗口，用来证明这个版本能编译、能跑；
- 开发构建开了 GPUI 的 `runtime_shaders`，因为本机 Xcode 没装 Metal Toolchain（Xcode 现在把它拆成单独下载的组件）。正式打包要预编译着色器，到时候要装这个组件（`xcodebuild -downloadComponent MetalToolchain`），装之前问作者。

每一路新加的 crate 在 `next/Cargo.toml` 的 `members` 里各占一行，新依赖加进 `[workspace.dependencies]`。

## 阶段 0

| 探针 | 状态 | 结论 |
| --- | --- | --- |
| P0-A 工程骨架 | 已合 `main` | 标题栏、菜单栏、深浅色、不签名的 `.app`、`next.yml` CI 都用 GPUI 公开接口做成，不用改 GPUI。补上了 `gpui_platform` 的 `font-kit` 特性：没有它，macOS 上一个字都画不出来，而且不报错。见 [p0-a-skeleton.md](spikes/p0-a-skeleton.md) |
| P0-B 编辑器 | 已合 `main` | 能过关。全书打开约 47 ms、滚完全书 258 MB、单次写入 0.025 ms；按键上屏 p95 16.6 ms（预算 16）、空闲 CPU 约 1%（预算 1%），差的部分都在 GPUI 的刷新节奏。中文断行改由编辑器自己做（钉住的 GPUI 里还没有 ICU 断行）。见 [p0-b-editor.md](spikes/p0-b-editor.md) |
| P0-C Loro 模型 | 已合 `main` | 结构定为 [loro-schema.md](loro-schema.md) v0。D3、D4 成立；书序和叙事序改回每章一个实数字段；Agent 就地写入；撤销合并间隔设 0；回看历史从 SQLite 另载副本。见 [p0-c-loro.md](spikes/p0-c-loro.md) |
| P0-D 视觉 | 已合 `main` | 作者按性能优先选了「遮盖」玻璃（D2）；浮起的玻璃不透明；字海用简化画法；图标用 `svg()` 内嵌位图着色。见 [p0-d-visual.md](spikes/p0-d-visual.md) |
| P0-E 旧库导入 | 已合 `main` | 新版不懂 Yjs 也能读全旧书；旧版最后一版加「交接」，不另做交换文件（D5）。见 [p0-e-import.md](spikes/p0-e-import.md) |

阶段 0 到此全部完成，没有一个探针要求停下来重新评估。

## 基座

| 基座 | 状态 | 开工条件 |
| --- | --- | --- |
| F1 dr-model / dr-doc | 进行中（第一个里程碑） | — |
| F2 dr-store | 进行中（第一个里程碑） | — |
| F3 dr-workspace | 未开 | F1、F2 的接口定稿 |
| F4 编辑引擎 | 待开 | P0-B 已合，可以开 |
| F5 dr-ui | 进行中（第一个里程碑） | — |
| F6 dr-shell | 未开 | F5 的令牌和基础组件 |
| F7 dr-platform | 进行中（第一个里程碑） | — |
| F8 dr-cli / dr-testkit | 未开 | 跟着 F3、F6 |

## 监管会话替作者定下的小事

- 菜单先保持英文，到 `dr-i18n` 时跟界面语言一起做（P0-A 说中文窗口菜单要先绕过 GPUI 按标题认菜单的问题）。
- 「冷启动到书架」从可执行文件开始运行算起，不含 Launch Services 的那一段；P0-A 直接运行测得 0.26 s，在预算内。
- P0-B 的几件事（作者在 P0-B 会话里说「都按照你的建议来」）：
  - 按键上屏的 16 ms 线：采用「改完立刻画」（探针里的 `PlatformHooks::present_now`，对 GPUI 视图发 `setNeedsDisplay:`），但 F4 接手时先用 Instruments 的显示 / Metal 轨迹或高速相机量准真实上屏时间，量准之前默认仍走 GPUI 原节奏。探针档里按键上屏（p95 16.6 ms）和组字上屏（16.7 ms）按此处理，不算阻塞。
  - 空闲 CPU：探针档接受现状（0.9–1.3%，约 1% 是 GPUI 的 CVDisplayLink 空转）。发布档之前给 GPUI 打补丁：连续 N 帧没有绘制就停掉 CVDisplayLink，`wake_platform` 时再启动（`gpui_macos` 的 `window.rs`、`display_link.rs`，约 50–80 行）；按 D1 在挂补丁时开自己的 fork，同时提给上游。GPUI 的 fork 由 F4 负责。
  - 组字中失焦：保持清掉（编辑器丢弃 + `discardMarkedText`），不改成原样上屏。Windows 上的丢弃（IMM32 的 `ImmNotifyIME`）进 F4 的输入子线。
- P0-E 的两件事按它的建议：旧帮手对话只读搬过去；没交接的库默认拦住，同时给「仍然导入」。

## 待作者手测（不挡推进）

- P0-A：双击 `next/target/bundle/Drifting Next.app` 后的焦点、图标和名字；系统切深浅色；增强对比度下的深色；标题栏拖动和双击、⌘W / ⌘M / ⌘Q / ⌘,；Windows 虚拟机里的标题栏按钮。清单见 [p0-a-skeleton.md 的「待作者」](spikes/p0-a-skeleton.md#待作者)。
- P0-B 的输入法矩阵：自动测试覆盖了组字的各种时序，但真输入法要真人在最前面的窗口里打。在 `next/` 下 `cargo run --release -p prose-spike -- chapter` 打开一章，每种输入法（系统拼音、系统注音、豆包、微信、搜狗、百度、系统日语）照 [p0-b-editor.md 的「待作者手测」](spikes/p0-b-editor.md#待作者手测) 过一遍，结果写进 `docs/rust-rewrite/acceptance/ime-matrix-<日期>.md`。不挡 F4 开工，结果回来再补修。
