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
| F1 dr-model / dr-doc | 第四轮已合 `main`（插入事件带标记；与 F4 的样式表、锚点、打开分工逐条对齐） | 结构升到 [v2](loro-schema.md)；77 条不变量、16 条旧规则不搬、9 处界面与帮手的语义分叉留给 F3；三设备 3000 例收敛、两个模糊测试目标。见 [f1-model-doc.md](foundations/f1-model-doc.md) |
| F2 dr-store | 第四轮已合 `main`（按书序搜索单字 495→0.5 ms、回车 2.6→0.4 ms、关库先停后台重建、派生短空闲等待） | 安全快照迁移、文档持有者、压缩、历史点、派生索引、资源存储、本机身份与自动换代、同步状态；88 项测试，崩溃恢复证据。见 [f2-store.md](foundations/f2-store.md) |
| F3 dr-workspace | 第三轮已合 `main`（`comment.reanchor`、`comment.anchors`、`todo.project`；作者命令以 `user:command` 来源提交，不进编辑器的撤销栈；两台设备同投一个 TODO 标记时正文自动修回） | 88 条命令和查询，每条只登记一次，能力清单是快照测试；写入顺序与补偿、事件、查询缓存、三层撤销；9 处界面与帮手的分叉已统一。重锚和投影不进对象级撤销日志（进了会让作者在编辑器外撤到看不见的锚点、并清掉重做栈）。见 [f3-workspace.md](foundations/f3-workspace.md) |
| F4 编辑引擎 | 第五轮已合 `main`：F4c 输入（查找替换、按词按段拖选、读屏、Windows 键位与组字失焦丢弃）、F4d 画层（批注砂笔垫在字下、Agent 墨色、查找高亮、干笔链接下划线、块样式、沉浸淡出、滚动条刻度）；F4 自己做 M05 通览全书 | `gpui-prose`（MIT OR Apache-2.0）按四条子线分目录；`dr-editor`（AGPL）经 F3 会话编辑并落盘。全部替换 400 处后撤销要 2.6 s（Loro 撤销平方级），要给文本源加「一批编辑一次提交」。GPUI v1.27 的两个读屏问题 G7、G8 存成补丁文件。见 [f4-editor.md](foundations/f4-editor.md)、[f4c-input.md](foundations/f4c-input.md)、[f4d-render.md](foundations/f4d-render.md) |
| F5 dr-ui | 第三个里程碑已合 `main`（单行输入改用 `gpui-ime`，标签坞成了组件 `TabDock`） | 令牌、遮盖素玻璃、砂笔、组件、一个浮层层和一个定位函数、单行输入、样张；字体是构建产物（`next/.cache/fonts`），不入库。见 [f5-ui.md](foundations/f5-ui.md) |
| F6 dr-shell | 第三个里程碑已合 `main`：App 里打开一本书就能写字（稿纸是 `dr-editor`，每个标签一个编辑器，换章回来光标、滚动、撤销都在；关掉重开内容和字数都对）；模块能登记自己的快捷键 | 三栏、侧栏抽屉与一半两半、标签坞与分栏、Super View 舞台、一个导航模型（标签树 + 历史栈）、位置链接与深链接、快捷键注册表（无 ⌘S）、声明式设置与搜索、通知中心、退出流程；文案只搬用到的键、编译期检查。冷启动在高负载下超 300 ms，待空闲重测。见 [f6-shell.md](foundations/f6-shell.md) |
| F7 dr-platform | 第一个里程碑已合 `main` | 日志、崩溃上报、钥匙串（沿用旧版格式）、深链接与单实例、开发 profile 隔离、`.dmg`、更新验签与交接设计、`--mcp --connection` 入口；67 个单元测试。见 [f7-platform.md](foundations/f7-platform.md) |
| F8 dr-cli / dr-testkit | 第二个里程碑已合 `main`；第三个里程碑（调试桥、写作闭环场景、调试桥不进正式包的门禁）这一批没合：它的测试还按旧的只读稿纸读页面，F6 换成编辑器后读不到，回 F8 在新 `main` 上改 | 统一种子（tiny / lite / heavy / showcase 加两本样书）、测量证据、崩溃试验台、bench；`cargo xtask check` 跑 10 道门禁；`cargo xtask dev` 按 worktree 隔离开发实例；`dr-cli` 骨架。见 [f8-testkit.md](foundations/f8-testkit.md) |

## 模块

| 模块 | 状态 | 结论 |
| --- | --- | --- |
| M01–M02 书架与作品主页 | 第一个里程碑已合 `main`（`dr-view-shelf`、`dr-view-home`） | 应用一打开就是书架：书卡、新建（按钮或双击空桌面）、改名、最近删除、账户菜单；点卡打开，⇧⌘W 或红灯回书架。作品主页：原地改书名、进度读数、继续写、每条故事线一行、主页设定。打开一本书 29–38 ms（预算 150）。导入入口照旧版放在左栏。还缺 F3 的书架汇总查询、`book.purge`、「最近打开」，F5 的无框输入。见 [m01-shelf.md](modules/m01-shelf.md)、[m02-home.md](modules/m02-home.md) |
| M03 章节页与稿纸工具栏 | 第一部分已合 `main`（F6）：稿纸右下角工具托盘、⋯ 菜单改写作状态与删除、一炷香与 ⌘⇧↩ 进沉浸写作 | 页眉、可改的标题、梗概、章末 ⁂、空章提示等 F4 给章首章末的挂接点 |
| M04 章节面板、幕与大纲栏 | 第一部分已合 `main`（F6）：按故事线 / 全书两种看法、全书按幕分组、拖格子挪章、稿纸左边的大纲栏 | 排序菜单和格子里的字数日期等 F3 的 `chapter.list` 带上；滚动条刻度等 F4d 画层接进外壳 |
| M05 通览全书 | 进行中（F4） | — |
| M06 搜索 | 已合 `main`（`dr-view-search`） | ⌘⇧F 浮层，边打字边出结果，按章节、构想、要素分组，章节按阅读顺序；回车经位置链接跳到那一段。`book.search` 也扫标题、名称、梗概、素材说明、要素补丁（查询时扫，不进索引），批注不进。取 500 条 7–28 ms（负载约 28），停手 90 ms 才搜。章内查找 ⌘F 待外壳接 F4c 的查找。见 [m06-search.md](modules/m06-search.md) |
| M07 字数与写作日 | 已合 `main`（`dr-view-stats`） | 右栏「统计」：最具体的那个数、全书、今天朝每日目标的一笔砂笔、写作进度、最近七天和连续天数。写作日按设备 × 日期存进书目文档；同步来的、导入的、补索引的、恢复一章都不算当天写的。应用打开库时带上了设备身份（F7 第二轮，`app/drifting/src/library.rs`，测试证明打开后 `writing_device()` 有值），应用里的写作日真正存下来了。见 [m07-words.md](modules/m07-words.md) |
| M10 旧库导入 | 第二个里程碑已合 `main`（F2 新接口、进度、历史元数据回放、导入后建索引） | 五份合成库全部导入，判成最新却不对的正文 0 篇，锚点全部换成光标，历史点对得上；旧版交接补导字数目标、关系类型颜色等本机数据。见 [m10-import.md](modules/m10-import.md) |
| dr-text 与派生索引 | 第二个里程碑已合 `main`（读热文档、按段写，打字后派生 0.21 ms；实时字数接口）；M06、M07 也由这一路做完 | 字数规则单独成 Apache-2.0 的 `prose-metrics`，和旧版逐篇相等；`dr-text` 纯文本、大纲、人物自动链接匹配器；`dr-index` 派生器，重型库 1.5 秒建好全部索引。见 [dr-text-index.md](foundations/dr-text-index.md) |

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
- 按键上屏的测量：机器在多路并行编译时（负载 5–6）测出的数字只作参考，最终数字等机器空闲时重测。
- 第八批合并时 F8 的调试桥没跟着合：它的测试按旧的只读稿纸读页面，和 F6 换上的编辑器对不上。整批不带 F8 重新合了一遍，F8 在新 `main` 上自己补「打开一章时编辑器拿到焦点」和「取当前页编辑器」两样再交。
- 第八批在整合分支上直接修了三处并行分支对不上的地方：M06 的搜索测试改成等稿纸的编辑器打开（F6 之后章节页不再是只读页）；统计模块退出前放开库（它的全局里留着一份库和写作日记录器，F6 的「关掉重开」测试抓到库一直开着）；写作日记录器的测试先等记录器读完书再改字（它在自己的线程上读字数，原来约一半次数会读到改完的数）。
- F3 第三轮的重锚和待办投影不进对象级撤销日志（和 F4 原先的建议不同）：照 F3 的理由采用。
- GPUI 读屏问题 G7、G8 和 Loro 撤销平方级都先不报上游：夜里没人看着，等作者在时再按「复现、查重、确认不是误用」走一遍。
- F4 想用 TextEdit 当「按键到真正显示」的参照（往 TextEdit 发模拟按键）：会动到作者电脑上的另一个应用，等空闲重测上屏时间时再问作者。
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
