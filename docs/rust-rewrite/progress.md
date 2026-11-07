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
| F1 dr-model / dr-doc | 第一个里程碑已合 `main` | 结构升到 [v2](loro-schema.md)；77 条不变量、16 条旧规则不搬、9 处界面与帮手的语义分叉留给 F3；三设备 3000 例收敛、两个模糊测试目标。见 [f1-model-doc.md](foundations/f1-model-doc.md) |
| F2 dr-store | 第一个里程碑已合 `main`（含机器指纹） | 安全快照迁移、文档持有者、压缩、历史点、派生索引、资源存储、本机身份与自动换代、同步状态；88 项测试，崩溃恢复证据。见 [f2-store.md](foundations/f2-store.md) |
| F3 dr-workspace | 第一个里程碑已合 `main` | 82 条命令和查询（63 写、19 读），每条只登记一次，能力清单是快照测试；写入顺序与补偿、事件、查询缓存、三层撤销；9 处界面与帮手的分叉已统一。暂用一份文档镜像接 dr-store，等 F1、F2 补「借来的文档上开事务」后拆掉。见 [f3-workspace.md](foundations/f3-workspace.md) |
| F4 编辑引擎 | 第一个里程碑已合 `main`；第二轮做 F4a（文本源 trait、段落索引、`gpui-ime`、断行小 crate） | `gpui-prose`（MIT OR Apache-2.0）按四条子线分目录；断行是不依赖 GPUI 的纯函数；GPUI 补丁存成文件。见 [f4-editor.md](foundations/f4-editor.md) |
| F5 dr-ui | 第一个里程碑已合 `main` | 令牌、遮盖素玻璃、砂笔、组件、一个浮层层和一个定位函数、单行输入、样张；字体是构建产物（`next/.cache/fonts`），不入库。见 [f5-ui.md](foundations/f5-ui.md) |
| F6 dr-shell | 进行中（第一个里程碑，含 dr-i18n） | — |
| F7 dr-platform | 第一个里程碑已合 `main` | 日志、崩溃上报、钥匙串（沿用旧版格式）、深链接与单实例、开发 profile 隔离、`.dmg`、更新验签与交接设计、`--mcp --connection` 入口；67 个单元测试。见 [f7-platform.md](foundations/f7-platform.md) |
| F8 dr-cli / dr-testkit | 第一个里程碑已合 `main` | 统一种子（tiny / lite / heavy / showcase 加两本样书）、测量证据、崩溃试验台、bench；`cargo xtask check` 跑 10 道门禁；`cargo xtask dev` 按 worktree 隔离开发实例；`dr-cli` 骨架。见 [f8-testkit.md](foundations/f8-testkit.md) |

## 模块

| 模块 | 状态 | 结论 |
| --- | --- | --- |
| M10 旧库导入 | 第一个里程碑已合 `main` | 五份合成库全部导入，判成最新却不对的正文 0 篇，锚点全部换成光标，历史点对得上；旧版交接补导字数目标、关系类型颜色等本机数据。见 [m10-import.md](modules/m10-import.md) |
| dr-text 与派生索引 | 第一个里程碑已合 `main` | 字数规则单独成 Apache-2.0 的 `prose-metrics`，和旧版逐篇相等；`dr-text` 纯文本、大纲、人物自动链接匹配器；`dr-index` 派生器，重型库 1.5 秒建好全部索引。按键后的派生要 17 ms，等 F2 加按段写入（实测 0.12 ms）。见 [dr-text-index.md](foundations/dr-text-index.md) |

## 架构审查

2026-11-07 分五路审查了旧架构，结论在 [simplifications.md](simplifications.md)：必须接住的 21 条、合成一份的 16 处、不搬的大块、直接复用的约 1 万行 Rust、更轻的证据做法、要重建的 13 条规则和阶段 7 的清单。和在跑的 F1、F2、F4、F5、F7 相关的条目已经发给对应会话。

## 作者定下的

- 帮手只留本机这一种接法，不保留 `sidecar` / `remote` 接缝（2026-11-07）。

## 监管会话替作者定下的小事

- 界面和帮手对同一操作语义分叉的地方（删章、新建重名等），统一以界面为准；帮手写入能按来源撤销，连带删除也能撤回。
- 帮手对话照旧同步：每个对话一个只追加的 Loro 文档；运行日志、事件、权限只在本机。
- Windows 上「关窗后留在通知区」用 tray-icon crate 保留。
- 字数统计按真实文字数，不复现旧版「加粗切开的拉丁词算两个」的偏差。
- F2 提出的机器指纹：身份文件里加机器指纹（macOS `IOPlatformUUID`、Windows `MachineGuid`），指纹变了就当新设备，用来抓「迁移助理连身份文件一起拷走」。新电脑在写作日里算新设备，这正是想要的。
- `runtime_shaders` 改成各可执行文件自己的默认特性，正式包用 `--no-default-features` 关掉；在发布前（F7 / M42）做。
- 正式版身份照 F7 的建议，交接时加 `release-identity` 特性，只有发布工作流打开（M42）。
- 按键上屏的预算拆成两条（F4 用 Instruments 实测后提出）：「按键到交出画面」照旧 16 / 8.3 ms，发布档靠 GPUI 补丁 G1；「按键到真正显示」只记录，另量 TextEdit 作参照。G1 正式挂上要开可推送的 GPUI fork，发布档前再由作者定。
- 组字逻辑合成一个小 crate `gpui-ime`，断行拆成独立小 crate，编辑器、单行输入、PDF 导出共用。
- 合并第三批时，新门禁抓到四处并行分支对不上的地方，在整合分支上直接修了：新迁移登记进迁移门禁、`prose-metrics` 登记为宽松许可、`dr-index` 和 `prose-metrics` 登记进依赖层、放在 `examples/` 下的基准程序按基准对待；`dr-workspace` 的能力清单快照先排键再比，不再取决于工作区里别的 crate 是否打开 `serde_json` 的 `preserve_order`。
- 菜单先保持英文，到 `dr-i18n` 时跟界面语言一起做（P0-A 说中文窗口菜单要先绕过 GPUI 按标题认菜单的问题）。
- 「冷启动到书架」从可执行文件开始运行算起，不含 Launch Services 的那一段；P0-A 直接运行测得 0.26 s，在预算内。
- P0-B 的几件事（作者在 P0-B 会话里说「都按照你的建议来」）：
  - 按键上屏的 16 ms 线：采用「改完立刻画」（探针里的 `PlatformHooks::present_now`，对 GPUI 视图发 `setNeedsDisplay:`），但 F4 接手时先用 Instruments 的显示 / Metal 轨迹或高速相机量准真实上屏时间，量准之前默认仍走 GPUI 原节奏。探针档里按键上屏（p95 16.6 ms）和组字上屏（16.7 ms）按此处理，不算阻塞。
  - 空闲 CPU：探针档接受现状（0.9–1.3%，约 1% 是 GPUI 的 CVDisplayLink 空转）。发布档之前给 GPUI 打补丁：连续 N 帧没有绘制就停掉 CVDisplayLink，`wake_platform` 时再启动（`gpui_macos` 的 `window.rs`、`display_link.rs`，约 50–80 行）；按 D1 在挂补丁时开自己的 fork，同时提给上游。GPUI 的 fork 由 F4 负责。
  - 组字中失焦：保持清掉（编辑器丢弃 + `discardMarkedText`），不改成原样上屏。Windows 上的丢弃（IMM32 的 `ImmNotifyIME`）进 F4 的输入子线。
- P0-E 的两件事按它的建议：旧帮手对话只读搬过去；没交接的库默认拦住，同时给「仍然导入」。

## 对外

- Loro 上游：F1 发现的批量导入不查校验和的问题，作者在单独的会话里报成了 loro-dev/loro#1262。另一个（按不存在的容器取文本会 panic）是文档写明的行为，不报。

## 待作者手测（不挡推进）

- P0-A：双击 `next/target/bundle/Drifting Next.app` 后的焦点、图标和名字；系统切深浅色；增强对比度下的深色；标题栏拖动和双击、⌘W / ⌘M / ⌘Q / ⌘,；Windows 虚拟机里的标题栏按钮。清单见 [p0-a-skeleton.md 的「待作者」](spikes/p0-a-skeleton.md#待作者)。
- P0-B 的输入法矩阵：自动测试覆盖了组字的各种时序，但真输入法要真人在最前面的窗口里打。在 `next/` 下 `cargo run --release -p prose-spike -- chapter` 打开一章，每种输入法（系统拼音、系统注音、豆包、微信、搜狗、百度、系统日语）照 [p0-b-editor.md 的「待作者手测」](spikes/p0-b-editor.md#待作者手测) 过一遍，结果写进 `docs/rust-rewrite/acceptance/ime-matrix-<日期>.md`。不挡 F4 开工，结果回来再补修。
