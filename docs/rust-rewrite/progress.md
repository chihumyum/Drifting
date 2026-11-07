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
| P0-B 编辑器 | 进行中 | — |
| P0-C Loro 模型 | 已合 `main` | 结构定为 [loro-schema.md](loro-schema.md) v0。D3、D4 成立；书序和叙事序改回每章一个实数字段；Agent 就地写入；撤销合并间隔设 0；回看历史从 SQLite 另载副本。见 [p0-c-loro.md](spikes/p0-c-loro.md) |
| P0-D 视觉 | 已合 `main` | 作者按性能优先选了「遮盖」玻璃（D2）；浮起的玻璃不透明；字海用简化画法；图标用 `svg()` 内嵌位图着色。见 [p0-d-visual.md](spikes/p0-d-visual.md) |
| P0-E 旧库导入 | 已合 `main` | 新版不懂 Yjs 也能读全旧书；旧版最后一版加「交接」，不另做交换文件（D5）。见 [p0-e-import.md](spikes/p0-e-import.md) |

## 监管会话替作者定下的小事

- 菜单先保持英文，到 `dr-i18n` 时跟界面语言一起做（P0-A 说中文窗口菜单要先绕过 GPUI 按标题认菜单的问题）。
- 「冷启动到书架」从可执行文件开始运行算起，不含 Launch Services 的那一段；P0-A 直接运行测得 0.26 s，在预算内。
- P0-E 的两件事按它的建议：旧帮手对话只读搬过去；没交接的库默认拦住，同时给「仍然导入」。

## 待作者手测（不挡推进）

- P0-A：双击 `next/target/bundle/Drifting Next.app` 后的焦点、图标和名字；系统切深浅色；增强对比度下的深色；标题栏拖动和双击、⌘W / ⌘M / ⌘Q / ⌘,；Windows 虚拟机里的标题栏按钮。清单见 [p0-a-skeleton.md 的「待作者」](spikes/p0-a-skeleton.md#待作者)。
- P0-B 的输入法矩阵，等 P0-B 交回后补。
