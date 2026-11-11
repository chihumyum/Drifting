# 自动推进手册（2026-11-10）

作者睡觉、不介入。整合者照这一页一直推进：自己合并、自己派活、自己开子会话，直到下面「终点」写的状态，然后写晨报、停下。分轨、规矩和方案照旧以 [kernel-v3-split.md](kernel-v3-split.md)、[k4-ui.md](../k4-ui.md)、[kernel-v3.md](../kernel-v3.md)、[overnight.md](overnight.md) 为准；这一页只管「谁来做、怎么开会话、做到哪停」。

## 终点

做到下面这些就停，在本页「晨报」一节写清楚，等作者：

1. K4 四组、K6 的功能都合进 `main`，包括 G1 的快照历史。
2. v3 的读写与外壳结构读取正确，层级设置、来源、子条目和成员一致。大书查询优化、heavy 打开／滚动测量和性能预算达标暂缓，等全部流程打通后再处理，不阻塞切换。
3. 统一正确性验收做完：真窗口把主要流程打通，核对输入、保存、恢复、导航和跨模块读写；发现的功能或数据正确性问题修完再验。截图目检、样式与交互流畅度打磨放到全部流程打通后，性能和外观待办不阻塞切换，也不记成已通过。
4. v3 的书在假服务上同步往返过一次（两台设备、带资源、删一本书另一本不受影响）。
5. **切换完成并本地合进 `main`**（2026-11-10 作者更新）：在分支 `codex/switch-v3` 上做好切换（新建书用 v3，App 只开 v3 的书，开发库从 0.1 重新导入的入口，删掉 next/ 里 v2.2 的页面、命令、数据层和测试），全套自动检查、功能与数据正确性验收通过后，由整合者本地合进 `main`，不用等作者试写一周或再次批准。性能和 UI 打磨不作为合入门槛；不推送、不发版。
6. 有余力就接着做「切换后的活」里不需要作者拿主意的部分，见下。

## 夜间队列（11-11）

作者新指示（11-11 夜）：到 autopilot.md 的「终点」以后不要停，接着做下面的夜间队列，一直做到队列全部做完。作者在睡觉，不要提问，不要等回复。先把这段原样记进 docs/rust-rewrite/handoff/autopilot.md，新开一节「夜间队列（11-11）」，随你下一次文档提交进 main，方便接手的人看到。

怎么保持不停：
- 一项做完马上开下一项，不要用总结结束回合。等长命令时继续轮询，顺手做下一项的只读准备。
- 卡住了（要作者拿主意、连续三次修不过、缺权限）：把卡点写进 autopilot.md「待作者」或「晨报」，分支留着，跳到下一项。
- 每开始一项，先重读 autopilot.md 和 ~/Drifting-autopilot-logs/guardian-antigravity.json。每做完一项，更新这个状态文件，并在「晨报」追加一段，让作者什么时候醒来看到的都是最新的。
- 每项一个分支、一个工作区。全套检查和你自己的数据正确性复核通过，才本地合进 main；不通过就不合。main 任何时候都要能跑。
- autopilot.md「不能做」的清单照旧：不推送、不发版、不连真服务、不花钱、不装系统组件、不动 0.1 客户端、不删 refs/wip 和别人的分支、不读作者的日常库和真实书稿。

队列，按顺序：
0. 做完切换。
   - codex/batch-70 的全套检查跑完。
   - 照 ~/Drifting-autopilot-logs/guardian-codex.json 里 switchReview.pending 的八条逐条核对。删掉的测试要按内容核对有没有丢掉 v3 的覆盖，不能只看文件名。
   - 副屏真窗口走一遍主要流程。
   - 通过后本地合进 main，记 overnight.md、progress.md、autopilot.md「进度」，写晨报第一版。
   - AGENTS.md 和 docs/rust-rewrite/ 里还写着 v2.2 并存的地方，一并改成现状。
1. 截图总览（给作者早上看）。用 showcase 的 v3 样书，在副屏把每个页面和主要状态各截一张：书架、主页、条目页（各种模块）、层级页的四种显示、时间线、模板编辑、搜索、审阅、素材、统计、帮手、偏好、导入导出。浅色深色各一套，拼成一页放在 ~/Drifting-autopilot-logs/screens/index.html，不进仓库。另列一份「看着明显不对、或者和设计系统差得远」的清单，只列不改。
2. 导入的三个技术缺口，即 v3-cutover.md「待作者／待协调」里的 28、29、30：
   - 旧链接到 EntityLinkV3 写入的无损适配；
   - 非空字段的默认值；
   - 带标记或链接的旧表格单元。
   这三项是技术活，不用作者定。22、23、25 是作者的策略，不要碰，保持 pending。每项都要有「源库不变、导入结果逐项核对」的永久测试。
3. 大书性能。用 heavy 的 v3 样书（约 150 万字），release 构建，机器空闲（一分钟负载 < 4）时量：打开书、首屏、长章节里打字的延迟、滚动、切章节、层级页和左栏、搜索、时间线。对照 benchmarks.md 和各模块文档里的预算，从最慢的开始一项一项修，修一项量一次。不为了快去改数据格式和已有行为，Loro 版本不动。要改交互才能快的（比如分段加载长什么样），写进「待作者」。证据照 f8-testkit.md 的规矩。
4. Super View 接到 v3。先读 ~/Drifting-autopilot-logs/post-switch-superviews-map.md。先做 M23 审阅与素材，再做 M22 要素全景。凡是要用到书序或幕的地方（v3 已经没有了），停下写进「待作者」，不自己设计。M21 故事图只写「待作者」，不动手。
5. Markdown 文件夹 v3：只写方案文档，不写代码。
6. 作者 11-11 追补导入的两条默认行为（排进夜间队列第 6 项）：
   - 第 23 条「未归属」：只在旧库里有「有叙事序、但不属于任何故事线」的章节或构想时才建。建在小说模板生成的故事线入口下，排在最后，用和其他导入故事线一样的模板和层级设置，名字沿用旧界面的「未归属」（bottomTimeline.synthetic.unaffiliated）。不设主归属，位置照现有映射。住处用初始化后实际返回的故事线入口 id，不能恢复 root-manuscript 那类固定 id。这一条改成默认行为，不再需要 MappingChoices。
   - 第 25 条关系类型端点：node、element、category、storyline 转成 entry；patch 转成 patch；comment 转成 comment；library_item 转成 material，去重。source_templates 和 target_templates 留空，不展开成模板清单。旧的种类原样留在导入记录里，以后可以还原。内置关系类型不动。这是暂定，作者之后要重构关系类型。也改成默认行为。
   - 两条都要有永久测试：源库字节和修改时间不变，导入结果逐项核对。在 m10-import.md 的 23、25 条和 v3-cutover.md「待作者」写明「作者已定 11-11」，autopilot.md「待作者」同步更新。全套检查通过后本地合进 main，晨报追加一段。
   - 第 22 条继续 pending：作者在考虑改成「时间线视图里的幕轨道」，不要建「大纲」关系，等作者确认。

全部做完后给晨报收尾：每一项合进了什么、main 在哪、量到的性能数字、还开着的问题、等作者定的事。然后停。

## 晚间最终指令（11-11）

作者 11-11 晚的最终指令，取代之前未开始的口信，照下面清单一直做到全部完成、写完晨报再停：

- 另有一个并行会话「同步接线」，分支 `codex/app-sync-v3`，工作区 `~/Drifting-app-sync-v3`，交回指针 `handback/app-sync`。它只交回、不合 `main`，由整合者每 10 分钟检查并复核数据正确性、全套检查、副屏双 profile 连同一 `FakeSyncServer` 真窗口往返重开冒烟后合进 `main`（不通过则写入 `overnight.md`「退回」表）。
- 一、按顺序执行：
  1. **记下作者的决定**（随第一次文档提交进 `main`，并把本页「待作者」里对应条目改成「作者已定 11-11」）：整书视图冷首开的分段／懒挂载暂不做（现在 120 ms 保持不动，未来新层级结构方向已记）；视觉打磨暂不做（13 条留作清单，M22 浮岛小卡提及分布并进视觉打磨一起暂缓）；M21 故事图等新的层级结构落地再说（四个待定问题标成「暂缓」）；M40 Markdown 文件夹七组写进 [`m40-markdown-folder-v3.md`](../modules/m40-markdown-folder-v3.md) 第 3 节，代码等新的层级结构落地再写，本轮不实现。
  2. **重跑输入法外部测试**：检查 `AXIsProcessTrusted` 与 `CGPreflightPostEventAccess`，都为 `true` 则跑完整的 `guardian-native-ime.py` 并把结果写进晨报；仍为 `false` 则照实记下（不重启宿主、不绕过系统权限）。
  3. **第 22 条「幕轨道」（作者已定 11-11）**：不建「大纲」关系，改为时间线视图里的幕轨道（带长度的泳道，每个时间线视图 0..N 条，新书默认无）；完成旧幕按需导入、8 种情形永久测试、文档同步、`TimelineLane` 可选字段与 `loro-schema.md`、视图顶部幕轨显示、「新建幕轨道」与已有泳道切换入口、九语文案及副屏真窗口往返重开冒烟。
  4. **文案和调试残留**（只改文字、去掉调试入口，不动布局）：条目页枚举值九语本地化、中文设置里的「General Agent」、导入对话框旧术语「主线节点」、从 0.1 重新导入对话框隐藏原始绝对路径并从普通界面移除「选择 MappingChoices JSON」（保留开发者／调试桥入口）。
  5. **有余力再做**：M22、M23 在 `heavy` 样书上趁机器空闲（一分钟负载 `< 4`）重量首帧；超出 `benchmarks.md` 预算的，在不改行为的前提下优化。
- 二、收「同步接线」（`handback/app-sync`）。
- 二之二、**GitHub Actions `next/` CI 追补（`main` `e8dad601`，run `43024370854`，收尾前做完并写进晨报）**：
  1. **Windows 编译错误与全工作区交叉排查**（已完成并合入 `main` `8d980c7c`）：修复 `crates/dr-ui/src/components/color.rs:431` 调用不存在的 `App::background_spawn`（改用 `cx.background_executor().spawn(...)`），并用 `cargo check/clippy --workspace --all-targets --target x86_64-pc-windows-msvc --locked --keep-going` 在本机找全并修掉 `spikes/prose-spike` 无条件拉入 `objc2`／Apple 框架与 macOS 专属 `libc` 符号的问题；5 个需要 MSVC／Windows SDK／`llvm-rc` 的第三方原生 build script 记录在晨报，不装系统组件，等下次推送后看 Windows CI。
  2. **macOS CI `dr-agent` 崩溃恢复测试失败**（已完成并合入 `main` `5ded0501`）：查明 SQLite WAL 单事务保证章节正文与 `agent_settlement` 始终原子一致，根因是 `dr_testkit::crash::Harness::run` 在续写子进程尚未打印首条 `durable` 就被 `SIGKILL` 时把基线退回 `-1` 而丢掉前序已核实落盘的 `floor`；已在 `dr-testkit` 跨轮次保留 `floor`（同时堵住前序步骤丢失的漏检盲区），并在 `dr-agent/tests/crash.rs` 新增零重试、100% 确定性复现的永久回归测试。
- 三、一的 1–4 做完（5 可选）、二的同步接线合进 `main`（或写明卡在待作者事项上）且二之二的 CI 追补全部完成并写进晨报后，在本页「晨报」写最终总结并停下。

### 凌晨追加（11-12，排在合入 `app-sync` 之后、写最终晨报之前）

1. 先关掉同步会话留下的两个冒烟窗口：`~/Drifting-app-sync-v3/next/target/debug/drifting`，profile 分别是 `app-sync-a-634d89f6`（21:49 起）和 `app-sync-a-6b6b6f11`（23:04 起）。它们还开在副屏上，会干扰后面的真窗口测试。确认同步会话已经交回、没有冒烟在跑再关。顺手让 `run_app_sync_smoke.py` 退出时把两个窗口都关掉。
2. 合入 `app-sync` 以后，补上它留下的待协调：设置 › 账号页里的「退出登录」也要先调 `dr_shell::sync::run_before_sign_out` 排空上传，再吊销令牌（在 `dr-view-account` 里），加测试。
3. 同步会话顺带发现一个测试竞态：`dr-view-element-overview` 的 `drag_drop_onto_island_reuses_g2_prepare_drop_and_supports_undo`，偶尔会和 `dr-view-history` 的 `AutomaticHistory` 后台 `entry_snapshot.capture` 抢同一本书的 oplog frontier。查清楚，改成确定的，不许靠重试、放宽断言或 `ignore`。
4. 另有一个并行会话在 `~/drifting-server` 做 Hosted 服务端的 `loro-v2`，它不碰 `~/Drifting`。它的交回说明会写在 `~/Drifting-autopilot-logs/loro-v2-server.md`。写晨报前读一下：已经交回的，就在 `m36-sync-v2.md`「服务端需要提供的」一节标出服务端已经具备的部分（只改文档）；还没交回的，在晨报里写「进行中」，不要等它。

## 你能做什么、不能做什么

**能做：**开子会话（下面的方法）；给子会话写指令；本地合并进 `main`；退回；给退回的问题开修复会话；会话死了就接手；在 `docs/rust-rewrite/` 里补必要的协调文档。

**不能做（碰到就记进晨报，留给作者）：**

- 推送、开 PR、发版、打标签、移动标签。
- 连真服务、用真密钥、调真的模型 API，花钱。
- 安装系统组件（比如 Metal Toolchain）、建远端仓库（比如 GPUI 的 fork）。
- 删 0.1 客户端（`src/`、`src-tauri/`）的任何东西。
- 要作者拿主意的设计：条目页内部长什么样、样式打磨、Markdown 文件夹 v3 的写法、分享链接的语义。可以写方案文档，不写代码。
- 删 `refs/wip/*`、删别人的分支、在别人还在动的工作区里改东西。

## 怎么开子会话

用 Codex 的非交互模式，一个任务一个会话、一个工作区：

```bash
git worktree add ~/Drifting-<任务名> -b codex/<任务名> <起点>
mkdir -p ~/Drifting-autopilot-logs
codex exec -C ~/Drifting-<任务名> -m gpt-6.1-sol -c model_reasoning_effort=max -s danger-full-access \
  --output-last-message ~/Drifting-autopilot-logs/<任务名>.last.txt "<指令>" > ~/Drifting-autopilot-logs/<任务名>.log 2>&1 &
```

- 作者在整合会话明确覆盖初版模型安排：统一 `gpt-6.1-sol`、`model_reasoning_effort=max`，不用 Astra；不自行降低推理强度或换模型。
- 同时运行的子会话不超过作者要求的四个；当前整合执行环境按含整合者共四个并发槽位安排，最多三个后台子会话。机器 12 核；子会话编译用 `CARGO_BUILD_JOBS=3`，整合者用 6。
- 起点：接着某个分支做，就从那个分支的最新提交开新分支；新活从 `main` 开。
- 每个子会话的指令都用下面的模板，写清楚这一个任务。子会话是非交互的：遇到要作者拿主意的事，写进自己模块文档的待协调和本页「待作者」，然后停下。
- 日志放在 `~/Drifting-autopilot-logs/`，不放进任何工作区，免得公开检查扫到。看子会话做到哪：读它的日志尾巴和 `.last.txt`。

**指令模板：**

```text
你是 Drifting next/ 重写的子会话，任务是「<任务名>」，仓库在 ~/Drifting，你的工作区是 ~/Drifting-<任务名>（分支 codex/<任务名>）。作者不在，不要提问。
先读：AGENTS.md；docs/rust-rewrite/handoff/autopilot.md；docs/rust-rewrite/k4-ui.md「各组共同的规矩」；docs/rust-rewrite/handoff/overnight.md 的交回协议；<这个任务相关的文档>。
要做：<具体内容和完成标准>。
能动：<crate 和文件>。公共地方只加不改；v2.2 冻结。
交回：提交，git merge main，跑全套检查（next/ 下 fmt、clippy、test、xtask check，仓库根 pnpm public:check），git branch -f handback/<指针名> HEAD，在 <模块文档> 写三段交回小节（做了什么、检查结果、待协调）。
遇到要作者拿主意的事：写进待协调和 docs/rust-rewrite/handoff/autopilot.md「待作者」，停下。不推送，不合 main。编译用 CARGO_BUILD_JOBS=3。
```

## 判断会话死没死

每一轮看一次各分支和工作区：最后一次提交或文件改动超过 **45 分钟**，而手头的活没交回的，算停了。

1. 先把它没提交的改动存成引用（不动它的工作区）：照 kernel-v3-split.md「停掉的会话留下的改动」的做法，`refs/wip/<日期>/<名字>`。
2. 从它的分支最新提交开新工作区，`git restore --source=<引用> --worktree -- .` 取回半成品（或者 `git reset --soft` 拆开快照提交），开新的子会话接着做，指令里写明半成品在哪。
3. 作者自己开的 G2、G4、外壳会话现在还在动，不要抢；它们停了再接手。

## 任务清单（按顺序）

| # | 任务 | 怎么做 | 起点 | 交回指针 |
| --- | --- | --- | --- | --- |
| 1 | 收现有交回 | 每轮把不冲突的交回放进同一批：现在排着 `handback/k1`（一次性结构查询，优先）、`handback/k4-g4`、`handback/f6` | — | — |
| 2 | G1 快照历史 | 当前 v3 完整快照安全阶段已在第 65 批接收（main 282587bb）：整份快照／多文档原子恢复、预览／确认、自动点、失败草稿与焦点。受检源码 a9ec87b0 全套 2198／0 失败／22 忽略，副屏 72/72、0 pending；最终仅文档和 main 协调变化。无法保真表示在首次真实提交前整批拒绝，当前原值、版本、before 点和重开不变；经整合者只读复核，可按安全边界接收，后续引擎能力由 G1／K1 技术协调，不待作者拍板。本轮前移 handback，不表示 G1 全部完成或 autopilot 终点达成。34 文件 WIP 引用和原树保持，日志在约定外部目录。 | `codex/autopilot-g1-history` | `handback/k4-g1` |
| 3 | 外壳结构读取正确性 | 核对 `dr-shell/src/book/v3.rs` 的结构读取、设置来源与刷新一致性；已有一次性结构查询的接线按正确性验收，未完成的性能优化和 heavy 测量记后续，不阻塞下一项。等任务 1 把 `handback/k1` 合进来，并且外壳原会话交回了搜索入口以后再开 | `main` | `handback/k4-0` |
| 4 | 等 G2、G4、外壳原会话做完 | 它们停了而活没完，照「会话死了」接手 | 各自分支 | 各自指针 |
| 5 | 统一正确性验收 | 1–4 的功能合进来以后开：真窗口打通主要流程，核对功能与数据正确性；相关缺陷按组记进 overnight.md「退回」，每组开一个修复子会话，修完再验。性能、截图目检、样式和流畅度记后续，不因此退回或等待机器空闲 | `main` | 各组指针 |
| 6 | 同步往返 | v3 的书在假服务上：两台设备往返、带资源、删一本书另一本不受影响、隐藏数据不被覆盖。缺的就在 `dr-sync` 里补 | `main` | `handback/track4` |
| 7 | 切换并合入 | 照「终点」第 5 条，在 `codex/switch-v3` 上做好，全套自动检查、功能与数据正确性验收通过后，由整合者本地合进 `main`，不用等作者试写或再次批准 | `main` | 不设指针，晨报里写分支名和合入提交 |
| 8 | 切换后的活 | 不需要作者拿主意的才做：三个 Super View（M21–M23）接到 v3，`refs/wip/2026-11-08/m21-story-graph-review` 等可以参考；Markdown 文件夹 v3 只写方案文档。分享链接、立绘生成、样式打磨不做 | `main` | `handback/k8-<名字>` |

每完成一项，在本页「进度」记一行。

## 真窗口和机器

- 测试窗口默认开在副屏（`DRIFTING_WINDOW_DISPLAY=secondary`，`handback/f6` 合进来以后生效）。真窗口失败先查 `app.info` 有没有被遮住、失活，环境问题重跑一次。
- heavy 测量和基准移到全部流程打通后，不作为交回或切换门槛；后续测量仍只在机器空闲（一分钟负载 < 4）时量，不能拿繁忙机器上的数字当正式结果。

## 进度

| 时间 | 做了什么 | main |
| --- | --- | --- |
| 11-10 02:41 | 任务 1：第 60 批收齐内核批量结构／写作日、G4 搜索统计 API、F6 副屏与导航。全套 2136／0 失败／22 忽略，主流程 58 步及副屏定位 18 步通过。外壳宿主与 G1 历史继续；作者 6d86ffce 的正确性切换规则已同步，性能／UI 暂缓。 | `236196de` |
| 11-10 03:21 | 任务 1 续批：第 61 批收 K2 批注／素材／主页／最近访问及 G4 只读审阅素材、主页动作、成稿／整书往返。全套 2161／0 失败／22 忽略，副屏主流程 43/43、0 pending，导出内容与独立导入书通过。G1 历史继续，宿主和 K6 按正式接口续接。 | `f3709422` |
| 11-10 06:30 | 任务 2 安全阶段：第 65 批接 G1 完整条目快照／原子恢复，与 K2 来源守卫、K6 公共投影和 G4 写入同批。全套 2227／0／22，探针 1/1、副屏 23＋16＋72 步通过；排空／登记／写前快照仍续接，不算整个任务或终点完成。任务 3 的内核合入和搜索正式交回条件已满足，独立结构读取子会话已启动，尚未交回。 | `282587bb` |

| 11-10 10:08 | 任务 1–4 的本轮功能交回合为第 67 批：K1/K2、G1 最终快照与登记、G2/G3 拖动、G4 归档与搜索、K5/K6 消费及外壳结构／释放。全套 2367／0／22，副屏主流程 162 步首轮通过；原桥并发条件 4/4。现开始任务 5 统一正确性验收，G1 普通跨章剪贴静态回退交原会话复现修复；任务 6／7 未开始，性能与 UI 仍暂缓。 | `af0c55c3` |

| 11-10 10:24 | 任务 5 在进行：第 67 批运行时代码上的 13 条主要流程累计 801 步通过，副屏 PID 全退出；格式 3 归档 106 份文档哈希／两正文历史恢复／源书不变通过。旧 links 场景按真实范围选区修正动作后 35 步通过，首红保留；G1 普通跨章剪贴真实动作 1 过／2 败已交修，未关闭前不记统一完成，不启动 6／7。 | `6406d029`（场景衔接暂存 `codex/batch-68`） |
| 11-10 13:55 | 任务 5 完成：第 68 批接收 `handback/k4-g1` → `aa403f52`（G1 普通跨章剪贴本地确定性重放与旧输入成组撤销修复）及 `k4-0-links` 范围选区衔接。全套 2380 通过／0 失败／22 忽略，通知顺序探针 1/1，副屏 74 步跨章剪贴与两次撤销／重开复验 74/74、0 pending；连同此前 13 条流程 801 步，统一正确性验收共 14 条真窗口流程、875 步全部通过。开始任务 6（v3 假服务同步往返）。 | `f6eb256c` |

| 11-10 17:03 | 任务 6 完成：第 69 批接 `handback/track4` → `dee8634d`。两台独立设备、两本 canonical v3 书与四份资源变体真实往返；删除目标书 26 份文档，另一书 22 份全部文档及全部资源元数据／字节不变，隐藏／未来字段与历史保留，断连重连及 cursor 0 重放不复活。根独立跨书删除探针先红后绿，整合全套 2386／0 失败／22 忽略及全部门禁通过。接着从最新 main 启动任务 7；生产自动同步和远端物理缓存回收不冒称通过。 | `59a9cc45`（产品合入） |
| 11-11 05:34 | 任务 7 暨夜间队列第 0 项完成：第 70 批接 `codex/switch-v3` `b10d7ac1` 整合候选 `2ae27b00` 合入 `main`。整合全套 9 门禁一次通过（Rust 2204 通过／0 失败／20 忽略，含全部 17 条恢复注册的 `release_tests`；`xtask` 13 门禁含 `v3-cutover` 与 `audit`），删掉的 236 个测试函数按内容逐条核对无丢 v3 覆盖，`switchReview.pending` 八条逐一复核通过；副屏真窗口 `g-b70-m3` 15 条主流程、`g-b70-switch-2`、`g-b70-sync-1` 全部通过；`AGENTS.md` 与 `docs/rust-rewrite/` 的 v2.2 并存表述已更新为现状，晨报第一版已写，继续夜间队列第 1 项。 | `140d0775` |
| 11-11 06:12 | 夜间队列第 1 项完成：在副屏真窗口用 `showcase` v3 样书（《慢钟》《阿Q正传》及六本陈列样书）采集书架、主页、整书通览、章／情节规划／人物字段与下方模块／构想条目页、层级页四种显示（列表文稿序＋按故事线、看板、网格、岛屿）、时间线、模板编辑、全局搜索、审阅、素材、统计、帮手、偏好设定及三类导入导出共 24 组（浅色 24 张＋深色 24 张，共 48 张），拼成外部总览页 `~/Drifting-autopilot-logs/screens/index.html`（未进仓库），逐张目检列出 13 条视觉／设计系统问题清单（只列不改），继续夜间队列第 2 项。 | `8b02dc4c` |
| 11-11 09:11 | 夜间队列第 2 项完成：`codex/import-v3-gaps`（`b05f19fb`）补齐导入三个技术缺口——28 旧链接到 `EntityLinkV3` 无损适配（含 `material`/`library_item`、显式 `module` 与跨容器 `targetBlockId` 范围重映射）、29 非空字段默认值（`FieldDef.default_value`、Loro 读写、`entry.create` 默认初始化、当前与历史目录快照无损保留且不覆盖条目实填值）、30 带标记或链接的旧表格单元（多段单元、带标记 `hardBreak`、单元格内 `EntityLinkV3` 往返及 `remove_cell`）；22、23、25 保持 `Pending` 不动。全套 2211 通过／0 失败／20 忽略，`xtask check` 与 `public:check` 全绿，合入 `main` `7fe13566`，继续夜间队列第 3 项。 | `d150b0f3` |
| 11-11 13:45 | 夜间队列第 3 项完成：`codex/heavy-perf-v3`（`b1533b9b`）在空闲 release（`load1m < 4.0`）下用 `heavy` v3 样书量完首屏、开书、长章打字、滚动、切章节、层级页与左栏、搜索、时间线八条路径，按最慢优先分四步逐项修复并每步独立复测（不改格式、不动 Loro `1.17.1`、不改行为）：单章冷／热开由 `2,742.8 / 2,442.5 ms` 降至 `97.6 / 44.4 ms`，切章预览 `p50` 由 `2,377.5 ms` 降至 `38.8–46.0 ms`，末章跳转由 `2,444.6 ms` 降至 `46.7–55.7 ms`，`Book::load` 由 `149.4 ms` 降至 `27.1 ms`，开书到主页由 `159.9 ms` 降至 `48.4–52.6 ms`，层级页四种显示由 `1,721–1,758 ms` 降至 `43.6–56.7 ms`，整书标签由 `2,974.6 ms` 降至 `120.3–137.2 ms`（`book-bench` 冷 `104.4 ms`／热 `37.5 ms`），搜索 3 字／零命中降至 `9.16 / 8.66 ms`。提交三份新鲜里程碑证据并更新 `benchmarks.md`，合入 `main` `139ad7d4`，继续夜间队列第 4 项。 | `a0cac18f` |
| 11-11 18:18 | 夜间队列第 4 项完成：Super View 接入 canonical v3。① M23 审阅与素材（`codex/m23-v3` `daab17c0` → 合入 `main` `5ce137a3`）：`dr-view-shelf-review` 接入 `SuperView::ReviewMaterials`（`⌘⌥5`），复用 M18 局部写入与 M19 素材卡片／`v3::{entry_links,related}` 关联筛选，提供拖宽比例与底部抽屉按书 `book_memory` 持久化及释放屏障；② M22 要素全景（`codex/m22-v3` `e390bde5` → 合入 `main` `c22489a1`）：`dr-workspace` 增按 `(book, source_doc, source_block)` 真实同段共现查询，`dr-view-relations` 补图例，`dr-view-element-overview` 接入 `SuperView::Elements`（`⌘⌥4`），支持默认关系图、群岛切换、三档缩放、聚焦、拖点固定（保留 `board`/`grid`）、拖上层级岛（复用 G2 `prepare_drop`）与浮层挂载真实 G1 `EntryPage`；全套 2,227 通过／0 失败／21 忽略，`xtask check` 全绿，副屏真窗口验收全过。③ M21 故事图按指示零代码改动，四项 v3 产品待定写入「待作者」。 | `c22489a1` |
| 11-11 18:35 | 夜间队列第 5 项完成：`codex/markdown-v3-plan`（`0731b3c4` → 合入 `main` `5f1ea41c`，零代码改动）撰写 [`m40-markdown-folder-v3.md`](../modules/m40-markdown-folder-v3.md)（已知 v3 约束、七组拍板矩阵、五步实现顺序、永久验收清单）并补交叉链接；`xtask check` 与公开边界门禁全绿。 | `3cc69c03` |
| 11-11 19:40 | 夜间队列第 6 项暨全部队列收尾完成：`codex/import-v3-23-25`（`e25b56e4` → 合入 `main` `78a9df97`）落地作者 11-11 新定的导入第 23 条（「未归属」默认按需建在初始化返回的实际故事线入口末位，沿用 `TPL_STORYLINE`、层级设置与实际书稿入口 `home`，无主归属、不再要 `MappingChoices`）与第 25 条（非内置关系类型端点转 `entry`/`patch`/`comment`/`material` 去重、模板列表留空，原种类写入 `import_original`，内置关系类型不动）；第 22 条 `act_binding` 继续 `Pending`（等作者确认幕轨道，不建「大纲」关系）。全套 2,230 通过／0 失败／21 忽略、含 `audit` 的 `xtask check`、副屏 `switch-v3.json` 47/47 真窗口验收与根门禁全绿，写完最终晨报后停下。 | `b202e4f2` |
| 11-11 20:08 | 晚间队列第 1 项完成：记录作者 11-11 晚最终指令与四项产品决定——① 整书视图冷首开分段／懒挂载暂不做（120 ms 保持不动，未来新层级结构方向已记）；② 视觉打磨暂不做（13 条留作清单，M22 浮岛小卡提及分布并入一起暂缓）；③ M21 故事图四个待定问题标为「暂缓」（等新层级结构落地）；④ M40 Markdown 文件夹七组规则写入 [`m40-markdown-folder-v3.md`](../modules/m40-markdown-folder-v3.md) 第 3 节（代码等新层级结构落地再写，本轮不实现），同步更新「待作者」，立即进入晚间队列第 2 项（重跑输入法外部测试）。 | `8f5bf493` |
| 11-11 20:27 | 晚间队列第 2 项完成：核验 `Antigravity` 宿主 `AXIsProcessTrusted == true`、`CGPreflightPostEventAccess == true`，在冻结候选 `8f5bf493` 上跑通完整 `guardian-native-ime.py`（`g-evening-ime-3`，副屏真窗口）：真实系统 `Control-Space` 切到 Apple 拼音（`SCIM.ITABC`），硬件级 `CGEvent` 输入 `nihao` 观察到真实平台预编辑 `ni hao` 且持久正文与 frontier 未提前提交，空格提交恰好一次「你好」并推进 frontier，退出重开读回与提交版本逐字一致，原输入源恢复无误。立即进入晚间队列第 3 项（第 22 条「幕轨道」）。 | `61c80bbd` |
| 11-11 23:33 | GitHub `next/` CI 追补完成（`main` `e8dad601`，run `43024370854`）：① `codex/ci-crash-fix`（`dcd6dc09` → 合入 `main` `5ded0501`）：核实 `DocInner::append` 单一 SQLite WAL 事务保证正文与 `agent_settlement` 原子一致，修复 `dr_testkit::crash::Harness` 续写子进程首步未打印 `durable` 即被 `SIGKILL` 时丢掉前序已核实落盘基线 `floor` 的缺陷（同时补齐前序步骤丢失检测），并新增 3 轮强杀确定性永久回归测试 `killing_resumed_agent_writer_on_first_step_recovers_book_and_settlement`（零重试、零放宽断言、零 `ignore`）；② `codex/ci-win-fix`（`6731d34a` → 合入 `main` `8d980c7c`）：修复 `dr-ui/src/components/color.rs:431` Windows 取色器 `cx.background_executor().spawn(...)`，并通过本机 `--target x86_64-pc-windows-msvc --keep-going` 全工作区排查修掉 `spikes/prose-spike` 无条件依赖 `objc2`／Apple 框架的阻塞，记录 5 个需 MSVC／`llvm-rc` 的第三方原生 build script（未装系统组件）。全套门禁通过，详记晨报。 | `8d980c7c` |
| 11-11 23:45 | 晚间队列第 3 项完成：第 22 条「幕轨道」默认落地（`codex/act-track-v3` `0c4a189c` → 合入 `main` `bd9c3748`）。`TimelineLane` 新增可选 `act_track`（旧文档缺省读为 `false`，新书默认无幕轨道），`dr-import-v1` 在旧库含幕时按需在树顶层建「幕」层级（允许任意模板、新条目默认构想叶子模板、住处取初始化返回实际 id）并导入绑构想／新建同名条目／多幕复用提示／跨度计算／已有位置保留，8 类情形永久测试（含源库字节与 `mtime_ns` 零改动核对）全绿；`dr-view-timeline` 支持多条幕轨置顶在标尺正下方带分隔线、新建幕轨道与已有泳道切换幕轨道、泳道内首条新建落回视图起点、拖入与拉宽跨度及九语文案；副屏真窗口 `act-track-v3`（44/44）、`k4-g3-views-lanes`（40/40）、`switch-v3`（49/49）全部 0 pending 通过。立即进入晚间队列第 4 项。 | `bd9c3748` |
| 11-12 00:52 | 晚间队列第 4 项完成：文案和调试残留清理（`codex/copy-cleanup-v3`，只改文字与移除普通界面调试入口，零布局改动）。① 条目页内置枚举选项（`writing_status`：`draft`／`revised`／`finished`；构想 `status`：`drifting`／`anchored`／`settled`）九语显示本地化，底层存储值原样不变；② 设定侧栏与页头九语本地化，修复中文显示英文 `General Agent`；③ 导入文档对话框替换旧术语「主线节点」与中英混排大写小标题；④ 从 0.1 重新导入对话框隐藏 `Application Support`／`app-local-data` 原始绝对路径并移出普通界面的「选择 MappingChoices JSON」（保留程序／调试桥入口 `LegacyImport::choose_mapping`）；同步记入作者 11-12 凌晨四条追加。全套门禁通过，立即进入晚间队列第 5 项（M22、M23 空闲 `heavy` 首帧复测与优化）。 | 本提交 |

## 技术待协调

- **M36：已验收边界与后续。** 真实 v3 假服务往返已在第 69 批接收，跨书 DocPurge／LoroUpdate 身份矛盾先拒绝、游标不前移；不透明文档种类保持兼容。现有协议没有资源删除墓碑，接收端被删书已下载的物理缓存仍在；App 自动调度／退出接线和真实服务未在任务 6 验证。切换验收另做窗口写入、离线假服务往返和另一窗口重开，不混称生产自动同步。

- **G1／K1：引擎身份保真扩展。** 普通嵌套树删除后，固定 Loro 1.17.1 的恢复可重建节点身份。当前安全阶段在首次真实提交之前对无法保真表示整批拒绝，所有当前原值、版本、before 点和重开状态不变；整合者独立只读复核后确认可正式接收。后续是 G1／K1 的引擎技术协调，不需要作者拍板，不宣称全部未来表示受支持。详见 [G1](../modules/k4-g1-pages.md)／[M09](../modules/m09-history.md) 本轮待协调。
- **第 67 批接收状态。** 下列 G1/F6/K1/K6 正式候选已组合进 main `af0c55c3`；最终全套 2367／0／22、G1 53 步和 F6 43 步均过，真实 Home 路径已由根覆盖。下列源阶段未合描述保留来源，不再表示候选待收。普通通览跨章剪切／应用内粘贴替换静态复核为既有功能回退，交 G1 先动态复现再修；不与未知表示保真扩展混为一项，统一验收仍待。
- **G1／F6：保存排空与最终捕获。** 原 before_release 的挂载字段／KV／补丁／planner／页头排空已交回；G1 续段获准消费正式 `3712d13f`／`8cfdd74e`，已登记真实 BodyModule／WholeBook 实例并把最终 checkpoint 接到 fallible 后台 after_drain。受检 Rust／Cargo `93dcf93e` 全套 2315／0／22，副屏主要流程 53/53、0 pending，最终仅场景与交回文档变化；详见 G1／M09。最终捕获失败阻止释放并恢复输入／服务。F6 Home 持库另有正式修复 `7d673090`，根已接收，本 G1 候选未追合；含真实 Home 的两库替换由 F6／根最终组合验收，不算 G1 已测通过，不转待作者。
- **G1／F6／K1：已定链接与宿主消费。** G1 已消费正式 K1 `a3676ea9` 与 F6 编辑器登记／系统模块 URL：正文和表格保留版本化 Entry＋module／Material 与 block 范围，富剪贴保留原始类型，坏或不支持的表示写前拒绝；实际查找、模块选区批注、同正文多标签、通览重载和旧书导航拒绝有永久契约。跨文档富剪切／替换与无法保真表示保守拒绝，后续能力属 G1／K1 技术协调；不改成作者设计项，也不宣称全部未来表示支持。
- **K6：同批接收。** G1 快照 API 与新增 Spec 的显式目录排除同批接收，再接每轮首次写条目前打点；`entry_snapshot.*` 是宿主公共接口，不因通用目录规则直接开放给模型。G1 不改 K6 既有实现。

## 待作者

（这里只保留实际产品设计；已定功能及引擎能力留在技术待协调。）

- **M10 切换映射第 22 条「幕轨道」（作者已定并已落地 11-11；第 23、25 条作者已定 11-11 并已落地默认行为）。** 第 22 条「幕轨道」、第 23 条「未归属」泳道与第 25 条关系类型端点去重／留空模板列表＋`import_original` 保留原种类均已落地默认行为，旧库迁移不再需要任何人工 `MappingChoices` 选项。见 [切换记录](../v3-cutover.md) 与 [M10 文档](../modules/m10-import.md)，不再待办。

- **视觉打磨与 M22 浮岛小卡提及分布（作者已定 11-11：暂缓）：** 视觉打磨暂不做，截图总览列出的 13 条问题留作清单；条目页空间、重复标题等布局设计及样式／流畅度打磨，连同 M22 要素全景（`SuperView::Elements`）浮岛 Peek 小卡的提及分布展示一并并入视觉打磨，一起暂缓。

- **macOS 辅助功能／键盘注入权限（作者已定并已验 11-11）：** 作者已为 `Antigravity` 开启辅助功能权限；守卫已核验 `AXIsProcessTrusted == true`、`CGPreflightPostEventAccess == true`，并在副屏真窗口跑通完整 `guardian-native-ime.py`（外部证据 `g-evening-ime-3`，见下方晨报追加二），不再待办。

- **100 章重型书「整书视图」冷首开分段／懒挂载（作者已定 11-11：暂不做，保持现有 ~120 ms 不动）：** 工作区内打开 100 章（约 165 万字）整书视图当前冷首开 `120.3–137.2 ms`（独立 `book-bench` 冷开 `104.4 ms`、热开 `37.5–40.7 ms`，滚完全书 3,332 帧 `p95 = 0.704 ms`）保持不动，本轮不做分段／懒挂载。方向记录：以后新的层级结构也许让任意层级都能开整书视图，顺序可自定义，不再绑死在固定的故事线上。

- **M21 故事图（`SuperView::StoryGraph`）在 canonical v3 下的四项产品问题（作者已定 11-11：暂缓，等新的层级结构落地再说）：**
  1. **【暂缓】文稿树与画布边界（旧书序轴／幕轨／顶部未安放章节列表取消后）：** `kernel-v3.md` 已定文稿顺序只属条目树、时间线无书序轴、无内置幕轨且「只有在泳道里的条目才在视图里」；待新的层级结构落地后再定画布范围与展示规则。
  2. **【暂缓】底部托盘存废与「未绑定」筛选口径：** 待新的层级结构落地后再定底部托盘存废、来源层级筛选口径以及拖向泳道区／标尺区的行为。
  3. **【暂缓】画布 Shift 连线的模块承载与虚实线规则：** 待新的层级结构落地后再定端点 `Relations` 模块承载方式与关系线型规则。
  4. **【暂缓】多 `TimelineView` 选择与视图记忆联动：** 待新的层级结构落地后再定顶栏多视图切换／新建入口与底部时间线抽屉的联动方式。

- **M40 Markdown 文件夹 v3 的七组格式与交互规则（作者已定 11-11：规则已定，代码等新的层级结构落地再写，本轮不实现）：** 七组规则已完整写入 [`m40-markdown-folder-v3.md`](../modules/m40-markdown-folder-v3.md) 第 3 节——① 范围：全书所有叶子的正文模块，不含层级说明；② 一篇正文一个文件，多篇时用「标题 · 模块名.md」；③ 目录跟着树嵌套、不加序号，书稿文件夹另放只读「目录.md」按书序列出链接；④ 文件头：身份键加简单字段（单行文字、长文字、单选、数字）按字段名双向同步，重名或复杂类型只读，外部未知键原样保留；⑤ 第一期不支持外部新建、改名、移动、删除；⑥ 嵌入占位行受保护（外部删了也放回原处，其余改动照常合并并在通知中心提示），不导出只读摘要；⑦ 外部改动用蓝色墨色，两边改了同一处挂待办，一次删掉超过一半先存条目快照。代码等新的层级结构落地后再写。

## 晨报

### 第一版（2026-11-11 05:40，夜间队列第 0 项：canonical v3 切换完成）

- **合入记录与 `main` 位置：**
  - 任务 5（统一正确性验收收尾）：第 68 批产品合入 `f6eb256c`（14 条副屏真窗口流程共 875 步全绿）。
  - 任务 6（v3 假服务同步往返）：第 69 批产品合入 `59a9cc45`（协调提交 `93a43a3f`，两设备、两本 canonical v3 书、四份资源变体、删除隔离、隐藏字段保留与跨书身份矛盾拦截全部通过）。
  - 任务 7 暨夜间队列第 0 项（canonical v3 切换）：源分支 `codex/switch-v3`（`b10d7ac1`）合入整合分支 `codex/batch-70` 并补入字海开书模块就绪等待门修复（`2ae27b00`），本地 `--no-ff` 合入 `main` 产品提交 `ad97a43c`；随后本提交同步更新 `AGENTS.md` 与 `docs/rust-rewrite/` 的切换后现状表述。
- **全套自动检查结果（冻结源码 `2ae27b00`，外部证据 `batch-70-full-2/results.json`）：**
  - `cargo fmt --all --check`：通过。
  - `cargo clippy --workspace --all-targets --locked -- -D warnings`：通过。
  - `RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1 cargo test --workspace --locked --no-fail-fast`：**2204 通过、0 失败、20 忽略**（含全部 17 条恢复注册的 `dr-shell::release_tests` 及新增开书就绪回归 `sea_opening_wait_prepares_v3_entry_modules_without_stalling`）。
  - `cargo xtask check`：13 道门禁全部通过（含新增 `v3-cutover` 扫描 686 个产品 Rust 文件零违规、`licenses` 59 成员／893 包、`audit` 972 包 0 漏洞、`evidence` 记录 20 stale／15 legacy 未篡改）。
  - 仓库根 `pnpm public:check`、`pnpm ci:contract:check`、`pnpm agent:capabilities:check`、四份兼容验收与九语生成检查：全部通过。
- **`switchReview.pending` 八条逐项复核（外部证据 `guardian-switch-8point-audit.json`、`guardian-content-test-audit.json`）：**
  1. 17 条 `dr-shell::release_tests` 已全部恢复注册并在全量测试第 2369–2385 行实际编译运行通过。
  2. 按函数体内容逐条核对 `main..codex/batch-70` 删除的 236 个测试函数：仅 2 条含 v3 词元且均为切换前“v3 与 v2.2 并存”双断言（已由 `dr-cli/tests/cli.rs` 与 `dr-export/tests/v3.rs` 的纯 canonical v3 测试替代），6 条共享命令名调用均属已退役固定域调用方且对应 v3 覆盖仍在 `v3_common.rs`、`dr-view-stats/tests/v3.rs`、`dr-workspace/tests/registry.rs`。
  3. 普通新建、启动首选、显式 `book.open`、深链 `nav.open` 与书架计数均只接受 canonical v3；库内非 v3 书与 SQLite 文件原样保留、不就地改写或删除。
  4. 开发库重新导入强制使用独立新目标目录 `reimport-v3-<id>`：未提供策略时 prewrite `V3Pending` 拒绝且不建目标目录、`libraries.json` 字节完全不变；提供显式 `MappingChoices` 后源库副本全部文件的 SHA-256 与 `mtime_ns` 零变化，原库仍留在注册表且可切回。
  5. 输入法组字：进程内 `gpui-ime`／`gpui-prose`／`dr-editor`／`state.get.ime` 契约全绿，源会话 `sv3-ime-10` 原件保留；`Antigravity` 宿主因 macOS TCC `CGPreflightPostEventAccess == false` 无法由外部进程向系统拼音发 `CGEvent` 硬件按键（已如实记入「待作者」，未用 `input.type` 冒充组字）。
  6. 窗口与假服务往返：`g-b70-sync-1` 完成真窗口 A 写入关闭 → `v3-loopback`（`FakeSyncServer` + `SyncEngine`）上传下载 → 真窗口 B 精确读回 frontier 并追写关闭 → 假服务上传下载 → 真窗口 A 重开精确读回；明确标注 `automaticAppSync: false`，不冒称生产自动后台同步。
  7. 旧 Markdown 文件夹 watcher 在应用／外壳层零激活，既有外部文件夹与用户设置完整保留。
  8. 书架字数新鲜度：`dr-workspace/src/commands/book.rs:152-164`（`shelf_book`）对不存在或 `head == None` 的正文计 `Some(0)`，对已有提交而 `doc_stats.indexed_seq` 未追上 `head.seq` 的正文返回 `None`（pending），不把待建索引正文误显示为空章 0 字。
- **副屏真窗口全流程结果：** `g-b70-m3` 全部 15 条 canonical v3 场景（搜索、素材、模板、帮手、链接、排空、释放、结构、归属、历史、主页、时间线、接线、剪贴板、切换）+ `g-b70-switch-2` + `g-b70-sync-1` 全部在副屏通过，所有验收进程均已干净退出并归还租约。
- **当前状态与下一步：** 夜间队列第 0 项已完成；现立即进入夜间队列第 1 项（`showcase` v3 样书副屏浅／深色截图总览与视觉问题清单），后续按顺序继续第 2–5 项并持续追加本节。

### 追加一（2026-11-11 06:12，夜间队列第 1 项：showcase 截图总览与视觉问题清单）

- **截图总览产物（仓库外）：**
  - 总览页：`~/Drifting-autopilot-logs/screens/index.html`（内嵌问题清单锚点导航与 24 组浅色／深色并排大图链接，点击可看原尺寸）。
  - 独立问题清单：`~/Drifting-autopilot-logs/screens/visual-issues.md`。
  - 原图目录：`~/Drifting-autopilot-logs/screens/light/*.png`（24 张）与 `~/Drifting-autopilot-logs/screens/dark/*.png`（24 张），覆盖书架、主页、整书通览、章条目页（字段＋正文）、情节规划模块、人物要素（字段＋正文＋键值＋补丁＋关联）、构想条目页、层级页四种显示（列表文稿序、按故事线、看板、网格、岛屿）、底部时间线、模板编辑、全局搜索、审阅、素材（素材库＋详情页）、统计、帮手、偏好设定、导出成稿、导入文件、从 0.1 重新导入。
- **「看着明显不对、或者和设计系统差得远」清单（只列不改，共 13 条）：**
  1. **作品主页（`02-home`）行布局断裂与重复按钮：** 「今日字数／设定」「继续写／第二十四章 开张」未成同一水平两端对齐行，「设定」「第二十四章 开张」「全书」孤立居中悬浮；快速新建区连续出现 **5 个同名「新建章节」**（各故事线派生章模板未去重或标注故事线）；「全书」作为按钮和下方分区标题重复出现两次。
  2. **条目页双标题／双梗概重复与双层嵌套滚动（`04`、`06`、`08`）：** `EntryPage` 顶部已有条目标题与 `Fields` 梗概，内嵌 `Prose` 模块内部再次渲染独立章节眉栏、大号 H1 标题与灰色梗概；外层整页滚动同时内嵌 `Prose` 模块带固定视口高度与独立内层滚动条，正文在约 340px 处被腰斩裁切；`06` 不显示大标题时顶部仍残留约 160px 大块空白。
  3. **条目页枚举值未本地化与下拉双箭头（`04`、`08`）：** 章「写作状态」显示原始英文 `> finished`、构想「状态」显示 `> drifting`，且下拉框左右同时带 `>` 与 `v` 双箭头。
  4. **模板编辑页顶栏重叠碰撞（`15-template-editor`）：** 纸面顶部居中浮动标签坞向右延伸后直接压在右上角「`叶子  已保存  还原  保存`」上；字段类型选择器（`v 别名 v`）左右各画一个向下箭头；「颜色」行右侧空白无取色器。
  5. **右栏展开遮挡主纸面右下角工具盘与模块操作（`17`、`19`、`20`）：** 打开右栏后，右下角悬浮工具盘压在底部 `Plot Grid` 模块右上角「`+ 行  + 列  适应  清空`」之上（「清空」被遮挡一半）。
  6. **底部时间线泳道名硬裁切（`14-timeline`）：** 左侧泳道「钟楼 15」中「楼」字右半部被容器硬裁切成残字，右侧仍有留白。
  7. **层级页空白「说明」占满首屏上半部且看板／网格无卡片载体（`09`～`13`）：** 顶部空 `about`（「说明」）模块固定撑开约 450～500px 空白，将「条目」推至视口下半部；`board` 与 `grid` 仅显示裸文字点列，缺少底色洗染（wash）、圆角边界或摘要，静态视觉几乎无差别；左栏树底部与固定「模板集合」交界处无分割线或渐隐遮罩，滚入底部的文字呈半截裁切。
  8. **左栏底部「模板集合」重复同名项（`02`～`20`）：** 连续出现 3 个同名「要素」项，缺少层级／叶子或来源区分。
  9. **键值模块重复表头与补丁模块通栏危险按钮（`06`、`07`）：** KV 模块外层与缩进内层重复显示两遍「字段」；补丁模块的「删除」与「新建补丁」均为横跨整栏的同宽同色大按钮紧邻排列，易误触。
  10. **空正文区孤立悬浮快捷键表（`05-entry-plot-grid`）：** 无正文时中央孤立渲染快捷键表与三点装饰符，与外层模块层级脱节。
  11. **全局搜索浮层底边裁切（`16-search`）：** 列表底部最后一行命中文字被底边横向切半，浅色下浮层与底纸明度接近。
  12. **书架空热力图不可见与深色亮白封面反差（`01-shelf`）：** 0 字状态下热力图格点近乎不可见；深色模式下米白底书封与深黑背景反差过强。
  13. **设定与导入导出残留旧术语及工程调试信息（`21`、`23`、`24`）：** 中文设定左侧仍显示英文 `General Agent`；导入文件对话框残留旧术语「主线节点」及中英混排大写小标题；0.1 重新导入对话框直接展示 `app-local-data`、Application Support 原始绝对路径及 `选择 MappingChoices JSON` 调试文案。
- **当前状态与下一步：** 夜间队列第 1 项已完成（零代码改动）；现立即切新工作区与分支进入夜间队列第 2 项（导入的三个技术缺口：28、29、30）。

### 追加二（2026-11-11 09:11，夜间队列第 2 项：导入的三个技术缺口 28、29、30 完成）

- **合入记录：** 分支 `codex/import-v3-gaps`（`b05f19fb`）本地 `--no-ff` 合入 `main` 产品提交 `7fe13566`。策略项 **22、23、25** 原样保持结构化 `Pending`，零触碰。
- **三项技术缺口落点：**
  1. **28 旧链接到 `EntityLinkV3` 写入的无损适配：** `dr-import-v1::prose::{plan_v3, read_paras_v3, sync_v3, export_v3}` 与 `dr-samples::v3` 将旧 `entityLink`（`element`/`chapter`/`idea` 条目及 `material`/`library_item` 素材、显式 `module`/`targetModule`、`targetBlockId`/`targetEndBlockId` 容器范围重映射）经 `ProseTxn::link_entity_v3` 无损写入当前正文、模板正文与全部快照历史点；未知目标种类与失配 ID 在首字节写入前结构化拒绝。
  2. **29 非空字段默认值：** `FieldDef` 增加可选 `default_value: Option<FieldValue>`，`dr-doc::v3` Loro 往返读写（`Null` 归一化省略），`entry_template.put` 校验默认值类型与选项，`entry.create` 对未显式传入字段按模板默认值初始化；`dr-import-v1` 在当前目录与 `element-category` 历史快照的 `elementTemplateKvJson` 中无损保留非空模板默认值，且绝不覆盖已导入要素条目自身的空值或实填值。
  3. **30 带标记或链接的旧表格单元：** `dr-doc::prose` 新增 `ProseTxn::set_table_cell_runs_v3` 与 `TableWriter::remove_cell`；`dr-import-v1` 支持 `Prose` 与 `Note` 两类正文里的多段表格单元、带行内标记的 `hardBreak`、全套文本标记与单元格内 `EntityLinkV3` 在当前正文、模板与历史恢复点之间逐单元无损往返，并拦截不支持的单元格嵌套块或未知标记。
- **永久测试与门禁：**
  - `dr-import-v1/tests/v3_import.rs` 新增 3 组「源库字节 SHA-256 与 mtime 不变 ＋ 导入结果与历史点逐项核对」永久契约测试，连同 `dr-doc`、`dr-workspace`、`dr-samples` 新增单测共 +7 条测试。
  - 全套检查：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1 cargo test --workspace --locked`（**2211 通过／0 失败／20 忽略**）、`cargo xtask check`（含 `audit`）、`pnpm public:check`、`pnpm ci:contract:check`、`pnpm agent:capabilities:check` 全部通过；`dr-testkit` 种子的 `tiny`/`lite`/`heavy` 语料指纹完全不变。
- **当前状态与下一步：** 夜间队列第 2 项已完成；现立即从最新 `main` 开新工作区与分支 `codex/heavy-perf-v3` 进入夜间队列第 3 项（大书性能）。

### 追加三（2026-11-11 13:45，夜间队列第 3 项：canonical v3 大书性能测量与逐项优化完成）

- **合入记录：** 分支 `codex/heavy-perf-v3`（`b1533b9b`）本地 `--no-ff` 合入 `main` 产品提交 `139ad7d4`。数据格式、Loro 版本（`=1.17.1`）与已有产品行为零改变。
- **测量基准与分步修复轨迹（`Preset::Heavy`：100 章约 165 万字符、300 要素、200 构想、60 素材、200 批注／待办、28,468 处实体链接，release 构建，空闲负载 `< 4.0`）：**
  1. **Step 1（批注锚点）：** 消除 `BookViewV3::comments()` 对每条批注重扫 `forest(&ENTRIES)` 的 `200 × 633` 扫描并新增 `anchored_comments()` → 长章冷开 `2,742.8 ms → 1,169.9 ms`，整书标签 `2,974.6 ms → 1,683.1 ms`。
  2. **Step 2（实体链接目标快照与整书会话打开）：** `LinkTargets` 新增单次快照 `TargetSnapshot`（消除 28,468 处链接逐个重读 `entries()`）、`manuscript_docs_from` 单趟收集与 `SessionSource::open_verified_v3` → `book-bench` 冷开 `1,744.5 ms → 173.7 ms`、末章跳转 `234.8 ms → 4.59 ms`；应用内整书标签 `→ 198.7 ms`，切章预览 `p50 → 160.7 ms`。
  3. **Step 3A / 3B（单节点树读取、自动链接匹配器按 frontier 缓存、单次读快照 `Book::load`）：** `dr-doc` 增 `forest_node`／`forest_entry_status`／`entry_raw`／`timeline_views_with`；`BookSlot` 缓存预编译 `LinkMatcher` 并由 `dr-editor` 按 `(ws.instance_id(), book)` 共享 `Arc<LinkMatcher>` 与 `NameIndex`（跨库测试实例严格隔离）；`dr-shell::Book::load` 改为单次 `read_book_v3` 直接构造快照 → `Book::load` 冷读 `149.4 ms → 27.1 ms`，开书到主页 `159.9 ms → 48.4–52.6 ms`，2 万字长章热开 `p50 → 44.4 ms`（冷开 `97.6–108.2 ms`），切章预览 `p50 → 38.8–46.0 ms`，跳末章 `→ 46.7–55.7 ms`，层级页四种显示打开 `1,721–1,758 ms → 43.6–56.7 ms`，`book-bench` 冷开 `→ 104.4 ms`（热开 `37.5–40.7 ms`）。
  4. **Step 4（搜索热路径）：** `dr-store::search_in_order` 改用 `HashSet`、非 ASCII 短词走 `instr()`、未列文档改查 `index_state`；`dr-view-search::v3` 改用 `entries_raw()`、预分组补丁／表格并增零分配 ASCII／CJK 子串匹配 → 3 字实体搜索 `p50` `14.36 ms → 9.16 ms`，零命中 `13.71 ms → 8.66 ms`，1 字／2 字 `13.06 / 33.55 ms → 10.89 / 28.66 ms`，搜索面板端到端 `p50 = 37.2 ms`。
- **八项路径最终空闲实测与预算对照（详见 [`benchmarks.md`](../benchmarks.md)）：**
  - 首屏：书架首帧 `35.7 ms`、书卡就绪 `165.9–190.5 ms`（发布预算 `≤ 300 ms` 通过）。
  - 打开书：点书卡到主页 `48.4–52.6 ms`（发布预算 `≤ 150 ms` 通过）；工作区内整书标签 `120.3–137.2 ms`（达探针档 `≤ 200 ms`，热开 `37.5 ms`；冷首开压进 `< 100 ms` 需改分段挂载交互，已记入「待作者」）。
  - 长章打字（21,907 字）：热开 `p50 = 44.4 ms`（`≤ 50 ms` 通过），单键写入 `p50 = 0.211–0.274 ms`（`≤ 1 ms` 通过），单键帧 CPU `p95 = 1.637–2.544 ms`（`≤ 8.3 ms` 通过）。
  - 滚动：长章 `p95 = 2.23–3.16 ms`、工作区整书 `p95 = 2.31–2.50 ms`、`book-bench` 滚完 100 章 3,332 帧 `p95 = 0.704 ms`（120 Hz 发布预算 `≤ 8.3 ms` 通过）；滚完后进程物理内存 `150.4–204.5 MB`（发布预算 `≤ 400 MB` 通过）。
  - 切章节：未访问章预览 `p50 = 38.8–46.0 ms`（`≤ 50 ms` 通过），跳末章 `46.7–55.7 ms`（`≤ 80 ms` 通过），已开标签切换 `p50 = 8.13–8.24 ms`。
  - 层级页与左栏：左栏展开 `27.2–30.9 ms`、根标签切换 `p50 = 8.9–9.3 ms`、目录滚动 `p95 = 2.64–2.98 ms`；列表／网格／看板／群岛首开 `47.1–54.8 / 46.4–46.7 / 54.4–56.7 / 43.6–47.1 ms`、滚动 `p95 = 3.28–4.34 ms`。
  - 搜索：1 字 `10.89 ms`、2 字 `28.66 ms`（`≤ 40 ms`）、3 字 `9.16 ms`（`≤ 15 ms`）、零命中 `8.66 ms`。
  - 时间线：打开 `3.90 ms`、首帧 CPU `1.80 ms`、横向滚动 `p95 = 2.23–2.82 ms`。
- **机器可校验里程碑证据与门禁：** 提交新鲜证据 `v3-heavy-v3-heavy-app-bench.json`、`v3-heavy-v3-book-bench.json`、`m05-m1-book-bench.json`（仓库外分步原始对比存于 `~/Drifting-autopilot-logs/heavy-perf/{before,step1,step2,step3a,step3b,step4}-*.json`）；`cargo fmt`、`clippy`、全量 `cargo test --workspace --locked`、`cargo xtask check --skip audit`（`evidence: 3 fresh, 0 invalid`）、`pnpm public:check`、`pnpm ci:contract:check`、`pnpm agent:capabilities:check` 全部通过。
- **当前状态与下一步：** 夜间队列第 3 项已完成；现立即开新工作区进入夜间队列第 4 项（Super View 接到 v3：先做 M23 审阅与素材，再做 M22 要素全景，M21 故事图只写「待作者」）。

### 追加四（2026-11-11 18:18，夜间队列第 4 项：Super View 接到 canonical v3 — M23、M22 合入，M21 列待作者）

- **4a. M23 审阅与素材（`SuperView::ReviewMaterials`，快捷键 `⌘⌥5`）：**
  - **合入记录：** 分支 `codex/m23-v3`（`daab17c0`）本地 `--no-ff` 合入 `main` 提交 `5ce137a3`；模块文档见 [`m23-shelf-review.md`](../modules/m23-shelf-review.md)。
  - **实现要点：** `dr-view-review` 暴露 `v3_panel::ensure` 与卡片／局部 guarded 写入口（`Entry { id, module }`、`Material`、浮动批注、失败草稿与原文快照悬停卡与 M18 共用同一套状态机，零重复）；新建 `next/crates/dr-view-shelf-review` 提供页眉实时计数与统一搜索、左一列待办与左二列批注（支持手柄拖宽与键盘微调，比例写入 `Workspace::book_memory("shelf-review")`）、右侧素材架（复用 `dr-view-material` 卡片、笔记／图片／PDF 类型片、`v3::{entry_links,related}` 条目关系筛选与关联开关、素材夹移动及外部文件导入）和底部抽屉（待整理无关联素材＋已解决审阅重开／删除），并接入 `dr_shell::release` 排空屏障。
  - **验证结果：** 全套门禁（`fmt`、`clippy`、GPUI 契约测试、`xtask check`、`dr-shell` 九语字符串检查）通过；副屏真窗口在《慢钟》走通打开 `SuperView::ReviewMaterials`、展开底部抽屉、拖动调整栏宽及浅／深色重启恢复 `book_memory`。
- **4b. M22 要素全景（`SuperView::Elements`，快捷键 `⌘⌥4`）：**
  - **合入记录：** 分支 `codex/m22-v3`（`e390bde5`）本地 `--no-ff` 合入 `main` 提交 `c22489a1`；模块文档与浅／深色关系图＋群岛截图见 [`m22-element-overview.md`](../modules/m22-element-overview.md)。
  - **实现要点：** 仅提取 ID 中立的力导向／弹簧模拟／装箱纯几何计算，零引入旧估算或扁平章节出现带；`dr-workspace` 新增基于 `Library::entry_module_references_in_book` 的按 `(book, source_doc, source_block)` 真实同段共现与提及次数查询（`Workspace::entry_cooccurrences`，查询前冲刷本机正文索引）；`dr-view-relations` 新增共享 `legend.rs`；新建 `next/crates/dr-view-element-overview` 实现默认关系图与群岛视图切换、三档自动缩放、单要素聚焦、节点拖动固定（经 guarded `entry.update` 写入 `Entry.layout.relation_graph`，原样保留 `board`/`grid` 并支持恢复自动排布与撤销）、群岛拖入层级岛（复用 G2 `dr_view_elements::data::v3::{drop_target,prepare_drop}` 处理 `add`/`move`/`blocked`）、点击浮岛 Peek 小卡与「展开」右侧抽屉直接挂载真实 G1 `EntryPage`（含 `dr_shell::release` 写排空屏障与按书 `book_memory` 隔离）。涉及文稿树提及分布的设计项未自行发挥，已记入「待作者」。
  - **验证结果：** `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1 cargo test --workspace --locked`（**2,227 通过／0 失败／21 忽略**）、`cargo xtask check --skip audit`（12 道门禁含 `v3-cutover` 扫描 700 个产品 Rust 文件、`licenses` 61 成员／893 包）全部通过；副屏真窗口 68 步验收流程（关系图默认首屏、`沈知微` Peek 小卡、Sheet 挂载真实 `EntryPage`、群岛切换、浅／深色重启恢复、真实鼠标拖动固定节点触发「恢复自动排布」、群岛真实鼠标拖卡入岛并通过 `entry.get` 核实层级归属）**68/68 通过、0 pending**。另在 release 构建下记录 `Preset::Heavy`（300 要素、12,187 对真实共现、约 165 万字）参考耗时：首帧 `387.8 ms`、绘制 `p50 = 27.3 ms`／`p95 = 45.3 ms`、拖点再平衡收敛 `877.0 ms`（注：测量时宿主机有用户外部虚拟机后台负载 `load1m ≈ 10.6–12.0`，按规矩仅作高负载参考，不冒充空闲正式里程碑）。
- **4c. M21 故事图（`SuperView::StoryGraph`）：** 按指示一行代码未动，已将旧书序轴／内置幕轨取消后的四项产品待定完整写入上文「待作者」。

### 追加五（2026-11-11 18:28，夜间队列第 5 项：Markdown 文件夹 v3 方案文档完成）

- **合入记录：** 分支 `codex/markdown-v3-plan`（`0731b3c4`）本地 `--no-ff` 合入 `main` 提交 `5f1ea41c`（纯文档提交，零代码改动）。
- **文档内容：** 新建 [`m40-markdown-folder-v3.md`](../modules/m40-markdown-folder-v3.md)，并在 [`m40-markdown-folder.md`](../modules/m40-markdown-folder.md)、[`modules.md`](../modules.md)、[`k4-ui.md`](../k4-ui.md)、[`v3-cutover.md`](../v3-cutover.md) 补齐交叉引用。方案严格锚定已敲定的 v3 内核不变量（`EntryId + ModuleId` 正文寻址、`H1/H2/H3` 仅作标题层级、本机 SQLite `markdown_mirror` 状态隔离、段落级合并、`EntityLinkV3` 回退与 `Actor::Mirror` 单一撤销步），把需要作者拍板的七组格式与交互分歧整理为对比矩阵，并给出拍板后的五步实现顺序及永久数据安全与双书隔离验收清单。
- **门禁复核：** `cargo xtask check --skip audit`、仓库根 `pnpm public:check`（5,579 文件）、`pnpm ci:contract:check`（659 测试文件）、`pnpm agent:capabilities:check` 全部通过。

### 追加六（2026-11-11 19:40，夜间队列第 6 项：导入第 23、25 条默认行为落地，第 22 条保持 pending）

- **合入记录：** 分支 `codex/import-v3-23-25`（`e25b56e4`）本地 `--no-ff` 合入 `main` 产品提交 `78a9df97`。
- **落地内容：**
  1. **第 23 条「未归属」改为默认行为（不再需要 `MappingChoices`）：** `dr-samples::v3::catalog::sync_catalog` 与 `dr-import-v1` 仅在旧库存在「有叙事序（`narrative_order.is_some()`）、但不属于任何故事线」的章节或构想时创建「未归属」泳道；挂在小说模板初始化实际返回的故事线入口 UUIDv7（`roots.storylines`）之下且排在所有已导入故事线最后（左栏树与默认时间线泳道顺序均排末位），复用标准故事线模板 `TPL_STORYLINE`（`home` 绑定初始化实际返回的书稿入口 UUIDv7 `roots.manuscript`，绝不恢复 `root-manuscript` 等固定 id）与相同层级设置（`overrides = None`），名字沿用旧界面的「未归属」（`bottomTimeline.synthetic.unaffiliated`），成员不设主归属（`primary = None`），叙事摆放坐标原样保留，断点续导重用同一已分配入口 id。内置样书（不含幕绑定构想）因此在新库首次启动时可零配置直接生成落架。
  2. **第 25 条关系类型端点改为暂定默认行为（不再需要 `MappingChoices`）：** 非内置关系类型（`!locked && system_key.is_none()`）的端点种类按 `node`／`element`／`category`／`storyline` → `entry`、`patch` → `patch`、`comment` → `comment`、`library_item` → `material` 转换并去重，`source_templates` 与 `target_templates` 留空不展开成模板清单；旧库 `entity_relation_type_endpoint_kind` 的原始种类数组原样写入回执与新库 SQLite `import_original`（`collection = "relation_types"`，`field = "source_kinds" | "target_kinds"`）供日后还原；内置 `generic-association` 关系类型保持原样不动。
  3. **第 22 条继续 `Pending`：** `MappingChoices` 现仅保留 `act_binding: Option<ActBindingChoice>`；源库含 `book_act.drift_node_id` 且未显式提供时继续写前返回 `act-binding-relation-type-and-direction`，不建「大纲」关系，等作者确认时间线视图幕轨道设计。
  4. **文档同步：** 已在 [`m10-import.md`](../modules/m10-import.md) 第 22、23、25 条、[`v3-cutover.md`](../v3-cutover.md)「待作者／待协调」及本页「待作者」写明「作者已定 11-11」与第 22 条待定说明。
- **永久测试与全套门禁：**
  - `dr-import-v1/tests/v3_import.rs` 新增两条永久契约测试 `default_unaffiliated_lane_created_only_when_needed_and_placed_last_under_storylines`（覆盖有／无未归属叙事序节点的正负向对照、末位排序、实际分配的 `roots.storylines`／`roots.manuscript` UUIDv7、层级设置一致性、无主归属与源库全文件字节／大小／mtime／SHA-256 零改动）与 `default_relation_type_endpoints_dedup_leave_templates_empty_and_preserve_legacy_kinds_in_receipt`（覆盖全部 7 种旧端点去重映射、空模板列表、内置关系类型不动、`import_original` 原样保留与源库全文件字节／mtime 零改动），`dr-view-import/tests/import.rs` 新增零配置 GUI 导入测试 `library_without_act_drift_imports_with_default_choices`。
  - 全套自动与真窗口检查：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1 cargo test --workspace --locked`（**2,230 通过／0 失败／21 忽略**）、`cargo xtask check`（含 `audit`，974 锁定包 0 漏洞）、副屏真窗口 `switch-v3.json` **47/47 步通过、0 pending**、仓库根 `pnpm public:check`、`pnpm ci:contract:check`、`pnpm agent:capabilities:check` 全部通过。

### 夜间队列（11-11）收尾总结

1. **0–6 各项合入提交与最终 `main` 位置：**
   - **第 0 项（canonical v3 切换完成与全仓表述对齐）：** 产品合入 `ad97a43c` + 文档与晨报第一版 `140d0775`。
   - **第 1 项（`showcase` v3 副屏浅／深色 48 张截图总览与 13 条视觉问题清单，零代码改动）：** `723e5981` → 合入 `main` `8b02dc4c`。
   - **第 2 项（导入三个技术缺口 28、29、30 无损闭环，22／23／25 保持 pending）：** `b05f19fb` → 合入 `main` `7fe13566` + 晨报记录 `d150b0f3`。
   - **第 3 项（`heavy` v3 约 165 万字空闲 release 八条路径逐项性能优化与里程碑证据）：** `b1533b9b` → 合入 `main` `139ad7d4` + 晨报记录 `a0cac18f`（其后完整保留主线既有提交 `1437e669` 与 `f2662713`）。
   - **第 4 项（Super View 接到 v3）：** M23 审阅与素材 `daab17c0` → 合入 `main` `5ce137a3`；M22 要素全景 `e390bde5` → 合入 `main` `c22489a1`；M21 故事图零代码改动、列清四项产品待定。
   - **第 5 项（Markdown 文件夹 v3 方案文档，零代码改动）：** `0731b3c4` → 合入 `main` `5f1ea41c` + 晨报记录 `3cc69c03`。
   - **第 6 项（作者 11-11 新定导入第 23、25 条默认行为落地，第 22 条保持 pending）：** `e25b56e4` → 合入 `main` `78a9df97`。
   - **收尾晨报提交：** 本提交（父提交 `78a9df979142e2d68f18199b59ef4b93813cb18c`）。本地 `main` 停在本提交，遵守全部禁令：未推送、未开 PR、未发版、未建或移动标签、未删任何分支或 `refs/wip/*`、未触碰 0.1 客户端。
2. **量到的性能数字总览（`Preset::Heavy` 约 165 万字符、100 章、300 要素、28,468 处实体链接，release 构建）：**
   - **第 3 项空闲机器（`load1m < 4.0`）前后对比：**
     - 2 万字长章打开：冷开 `2,742.8 ms → 97.6–108.2 ms`，热开 `2,442.5 ms → 44.4 ms`（预算 `≤ 50 ms`）；单键写入 `p50 = 0.211–0.274 ms`（`≤ 1 ms`），单键帧 CPU `p95 = 1.637–2.544 ms`（`≤ 8.3 ms`）。
     - 切章节与跳末章：未访问章预览 `p50` `2,377.5 ms → 38.8–46.0 ms`（`≤ 50 ms`），跳末章 `2,444.6 ms → 46.7–55.7 ms`（`≤ 80 ms`），已开标签切换 `p50 = 8.13–8.24 ms`。
     - 开书与首屏：`Book::load` 冷读 `149.4 ms → 27.1 ms`，点书卡到主页 `159.9 ms → 48.4–52.6 ms`（`≤ 150 ms`），书架首帧 `35.7 ms`、书卡就绪 `165.9–190.5 ms`（`≤ 300 ms`）。
     - 整书通览与滚动：应用内整书标签冷开 `2,974.6 ms → 120.3–137.2 ms`（`book-bench` 冷开 `104.4 ms`、热开 `37.5–40.7 ms`）；滚完 100 章 3,332 帧 `p95 = 0.704 ms`（工作区内 `p95 = 2.31–2.50 ms`，预算 `≤ 8.3 ms`），滚完后进程物理内存 `150.4–204.5 MB`（预算 `≤ 400 MB`）。
     - 层级页、左栏、搜索与时间线：层级页四种显示打开 `1,721–1,758 ms → 43.6–56.7 ms`；搜索 3 字 `p50` `14.36 ms → 9.16 ms`（`≤ 15 ms`）、2 字 `28.66 ms`（`≤ 40 ms`）、零命中 `8.66 ms`；时间线打开 `3.90 ms`、横滚 `p95 = 2.23–2.82 ms`。
   - **第 4b 项 M22 要素全景 `Preset::Heavy` 参考耗时（宿主机有外部虚拟机负载 `load1m ≈ 10.6–12.0`，仅作参考）：** 首帧 `387.8 ms`、绘制 `p50 = 27.3 ms`／`p95 = 45.3 ms`、拖点再平衡收敛 `877.0 ms`。
3. **还开着的技术问题与已知边界（不冒称已完成）：**
   - **M36 生产自动同步与远端物理缓存回收：** 离线假服务往返与多窗口重开已通过，但 App 后台自动同步调度／退出冲刷接线及删书后接收端已下载资源文件的物理缓存回收仍属后续技术收口。
   - **G1／K1 未知未来表示保真扩展：** 当前在首次真实提交前对无法保真表示整批拒绝以保原值与历史点不坏，后续扩展属引擎内部技术协调。
   - **视觉问题清单与旧模块里程碑证据：** 第 1 项列出的 13 条视觉／设计系统问题按“只列不改”保持原样；`xtask check` 中非本轮套件的历史里程碑证据（22 份 `stale`）按规矩未篡改，留待各模块空闲里程碑重采。
4. **全部等作者定的事（均已汇总在上方「待作者」）：**
   1. **M10 导入映射仅剩第 22 条 `act_binding` 待作者确认**（作者在考虑改成「时间线视图里的幕轨道」，不建「大纲」关系；第 23、25 条作者已定 11-11 并已落地默认行为）。
   2. **条目页内部布局与第 1 项 13 条视觉／设计系统打磨方向**（双标题与内层嵌套滚动、主页重复新建按钮、层级页空 `about` 高度与看板／网格卡片形态、模板编辑顶栏防撞等）。
   3. **100 章整书标签冷首开若要压进 `< 100 ms` 的分段／懒挂载交互策略**（未挂载章高度估算、滚动条行为与跨章查找补载时机）。
   4. **M21 故事图在 canonical v3 下的四项产品设计**（画布是否纯展示当前 `TimelineView`、底部托盘存废与「待安放」筛选口径、Shift 连线的 `Relations` 模块承载与线型、多 `TimelineView` 选择联动）。
   5. **M22 要素全景浮岛 Peek 小卡是否增加文稿树提及分布摘要及形态**。
   6. **M40 Markdown 文件夹 v3 的七组格式与交互拍板矩阵**（见 [`m40-markdown-folder-v3.md`](../modules/m40-markdown-folder-v3.md)）。
   7. **（可选权限）macOS「辅助功能」勾选 `Antigravity`**（仅当需要在守卫宿主下复跑外部硬件级 `CGEvent` 系统拼音脚本时）。

夜间队列（11-11）第 0–6 项至此全部完成并收尾，整合会话现按指示停下。

### 晚间队列追加一（2026-11-11 20:08，晚间最终指令第 1 项：记下作者的四项产品决定）

- **落地内容（纯文档提交，零代码改动）：**
  1. **整书视图冷首开（作者已定 11-11）：** 分段／懒挂载暂不做，现在的 ~`120 ms` 保持不动；记下未来方向——以后新的层级结构也许让任意层级都能开整书视图，顺序可自定义，不绑死在固定的故事线上。
  2. **视觉打磨与 M22 小卡提及分布（作者已定 11-11）：** 视觉打磨暂不做，截图总览的 13 条留作清单；M22 浮岛小卡的提及分布并进视觉打磨，一起暂缓。
  3. **M21 故事图（作者已定 11-11）：** 等新的层级结构落地再说，四个待定问题全部标为「暂缓」。
  4. **M40 Markdown 文件夹七组规则（作者已定 11-11）：** 已将七组定稿规则完整写入 [`m40-markdown-folder-v3.md`](../modules/m40-markdown-folder-v3.md) 第 3 节（① 全书所有叶子正文模块、不含层级说明；② 一篇正文一文件，多篇用「标题 · 模块名.md」；③ 目录随树嵌套不加序号，书稿文件夹另放只读「目录.md」按书序列出链接；④ 文件头含身份键加单行文字／长文字／单选／数字简单字段按字段名双向同步，重名或复杂类型只读，外部未知键原样保留；⑤ 第一期不支持外部新建／改名／移动／删除；⑥ 嵌入占位行受保护、外部删了也放回原处并在通知中心提示，不导出只读摘要；⑦ 外部改动蓝色墨色、同处并发挂待办、一次删超半数先存条目快照）；代码等新的层级结构落地再写，这一轮不实现。
- **下一步：** 立即开新工作区进入晚间队列第 2 项（重跑输入法外部测试 `guardian-native-ime.py`）。

### 晚间队列追加二（2026-11-11 20:27，晚间最终指令第 2 项：重跑输入法外部测试通过）

- **权限预检：** 经 `ApplicationServices`／`CoreGraphics` 实查当前 `Antigravity` 宿主进程：`AXIsProcessTrusted() == true`、`CGPreflightPostEventAccess() == true`。
- **完整 `guardian-native-ime.py` 验收结果（冻结源码 `8f5bf493f9e6271a40d6366dd104d7ff6acbeb21`，独立 profile `g-ev-ime-3`，外部完整证据 `g-evening-ime-3/{events.ndjson,preedit.json,committed.json,reopened.json,manual-result.json}`）：**
  1. **窗口与输入源切换：** 未打包真实 `target/debug/drifting` 在副屏打开 `v3-tiny` 第 1 章，经 `TISSelectInputSource` 与真实 `Control-Space` 系统快捷键切到已启用的 Apple 简体拼音（`com.apple.inputmethod.SCIM.ITABC`），前台焦点守卫全程核对目标 PID。
  2. **平台预编辑（Marked Text）隔离：** 经 `cghidEventTap` 发送真实按键 `nihao`，`state.get()` 读到真实平台组字状态 `ime = {"chapter": 0, "text": "ni hao", "range": {"start": 0, "end": 0}, "selected": {"start": 6, "end": 6}}`，同时 `module.read_prose` 核实持久正文（首段仍为 `"潮声与记录"`）与文档 frontier（`0195e1ba8eefb7f28d18ba05`）均未提前落盘。
  3. **提交与重开持久化：** 发送真实空格键提交后，`ime` 归 `null`，首段精确变为 `"你好潮声与记录"`（恰好提交一次），frontier 推进至 `01b8ddceecc8dc9cae5702`；恢复系统原输入源（`cleanupErrors: []`）并正常退出 App，重新启动打开同一本书读回正文与 frontier（`01b8ddceecc8dc9cae5702`）完全一致（`passed: true`）。
  - *附注：* 前两次尝试（`g-evening-ime-1`、`g-evening-ime-2`）因探针每次临时 JIT 编译 Swift 且 `NSRunningApplication.activate(options: [])` 未置顶副屏窗口，被前台焦点守卫捕获到浏览器／编辑器切走焦点而安全中止、未向其他应用误发按键；将守卫探针预编译为二进制并改用标准 `activateIgnoringOtherApps` 置顶目标窗口后，`g-evening-ime-3` 一次完整通过。
- **下一步：** 立即开新工作区进入晚间队列第 3 项（第 22 条「幕轨道」）。

### 晚间队列追加三（2026-11-11 23:35，GitHub Actions `next/` CI 两项故障排查与修复完成 — `main` `e8dad601` / run `43024370854`）

1. **Windows 编译错误修复与本机全工作区 `x86_64-pc-windows-msvc` 排查（`codex/ci-win-fix` `6731d34a` → 合入 `main` `8d980c7c`）：**
   - **直接故障修复：** `next/crates/dr-ui/src/components/color.rs`（`#[cfg(windows)] mod system::pick`）把调用不存在于钉选 GPUI `v1.27.0` `gpui::App` 上的 `cx.background_spawn(...)` 改为 `cx.background_executor().spawn(async move { choose(owner, current) })`，与 `dr-ui`／各视图其余后台任务派发方式一致。
   - **本机交叉检查新抓出的第二处 Windows 编译阻塞：** 在本机执行 `cargo check/clippy --workspace --all-targets --target x86_64-pc-windows-msvc --locked --keep-going` 时，发现工作区成员 `next/spikes/prose-spike` 在普通 `[dependencies]` 下无条件启用了 `objc2`、`libc` 与 `raw-window-handle`（默认 `shell` feature 打开），导致 `objc2 v0.6.5` 在 Windows 目标直接触发 `compile_error!("`objc2` only works on Apple platforms...")`，且 `src/bin/prose-spike/{main.rs,platform.rs}` 无条件链接 `CoreFoundation` 框架并调用 macOS 专属 `libc::{getrusage, proc_pid_rusage, sysctlbyname}`（此前因 `dr-ui` 先报错退出而被遮住，若不一并修掉下次推送仍会挂在 `prose-spike`）。现已照 `dr-editor` 的规矩将 `libc`、`objc2`、`raw-window-handle` 移入 `[target.'cfg(target_os = "macos")'.dependencies]`，并为 `src/bin/prose-spike/main.rs` 补齐 `#[cfg(target_os = "macos")]` 与非 macOS 入口守卫；经 `cargo tree --workspace -e normal,dev --target x86_64-pc-windows-msvc --locked` 核实，Windows 依赖图中已彻底无 `objc*`／`core-foundation*`／Apple 专有库。
   - **本机已通过的 Windows 目标检查：**
     - `dr-model`、`prose-metrics`、`prose-linebreak`、`gpui-ime`、`dr-debug-protocol`、`dr-corpus` 及 `dr-platform --no-default-features --lib --bins`（覆盖 `single_instance.rs`、`tray.rs`、`secrets/windows.rs` 等全部 `windows 0.62` 调用）在 `cargo clippy ... --target x86_64-pc-windows-msvc --locked -- -D warnings` 下全部零警告通过。
     - 受下方原生 C／RC 构建脚本阻断的包内的全部 `#[cfg(windows)]` 代码片段（`dr-ui` 的 `ChooseColorW` 与 `ImmGetContext`/`ImmNotifyIME`/`GetFocus`、`gpui-prose` 的 `SystemIme`、`dr-view-stats` 的 `GetLocalTime`/`GetSystemTime`、`dr-mcp` 的 `CREATE_NO_WINDOW`、`dr-import-v1` 的 `OpenOptionsExt::share_mode(0)`、`dr-store` 的 `OsStrExt::encode_wide`）亦用 `clippy-driver --target x86_64-pc-windows-msvc -D warnings` 对已编出的 `libwindows.rmeta` 与 `libraw_window_handle.rmeta` 完成零警告交叉类型校验。
   - **因需要 MSVC 工具链／Windows SDK／`llvm-rc` 而在 macOS 本机无法跑完 build script 的 5 个第三方原生依赖（遵照禁令未安装任何系统组件，待下次推送后由 GitHub Actions `windows-x64` 与 `windows-arm64` 实机跑完 `clippy`、`test`、`build` 与 NSIS 安装器检查）：**
     1. `stacker v0.1.25`（编译 `src/arch/windows.c` 报 `'windows.h' file not found`）；
     2. `psm v0.1.32`（汇编 `src/arch/x86_64_msvc.asm` 时 `cc-rs` 报 `failed to find tool "lib.exe"`）；
     3. `libsqlite3-sys v0.39.1`（交叉编译 bundled `sqlite3.c` 缺少 Windows CRT／SDK 头文件）；
     4. `ring v0.17.14`（编译 `crypto/curve25519/curve25519.c` 报 `'assert.h' file not found`）；
     5. `gpui v0.2.2`（`crates/gpui/build.rs:46` 调用 `embed-resource` 编译 `resources/windows/gpui.rc` 报 `NotAttempted("llvm-rc")`）。
2. **macOS CI `dr-agent` 崩溃恢复测试失败根因核查、修复与永久回归测试（`codex/ci-crash-fix` `dcd6dc09` → 合入 `main` `5ded0501`）：**
   - **数据正确性核查结论：崩溃恢复不会造成书正文与 `agent_settlement` 结算记录不一致。**
     - 存储事务核实：`next/crates/dr-store/src/holder.rs`（`DocInner::append`）将正文的 `record_append`（`loro_update` + `loro_head`）、`doc_history_label` 与 `INSERT INTO agent_settlement` 放在同一个 SQLite WAL 事务（`conn.unchecked_transaction()?` → 单次 `tx.commit()?`）内原子提交；无论进程在事务中哪条 SQL 前后被 `SIGKILL` 强杀，重开时 WAL 只会整笔回滚或整笔恢复，绝不会出现「正文进了、结算没进」或反过来的分叉。
     - CI 报错现场核实：`next/crates/dr-testkit/src/crash.rs`（`Harness::run`）在报步号错之前，已经先调了 `dr-agent/tests/crash.rs` 的 `verify(&kill, root)` 并成功返回 `Ok(Recovered { step: 4 })`——说明第 5 轮强杀重开后，章节正文段落数、每段文本、`agent_settlement` 记录数、`before_frontiers` 链条及末条 `after_frontiers == doc_frontier` 在第 4 步完全一致。
   - **真实根因（`dr_testkit::crash::Harness::run` 跨轮次基线丢失）：**
     - 试验台每轮强杀后在同一个临时库目录上启动新子进程续写。前 5 轮（`kill 0..=4`）已落盘步骤 `0..=4`；第 6 轮（`kill 5`）的新子进程重开读到已有 5 步，从 `step = 5` 开始写第一笔事务。
     - 在较慢的 macOS CI 机器上，`kill 5` 的随机延迟恰好落在子进程首次 `append` 事务期间（例如 `DR_STORE_CRASH_PAUSE_APPEND_MS=25` 暂停窗口内或 `tx.commit()` 完成前），子进程尚未输出本进程的第一条 `durable 5` 就被 `SIGKILL`，故本轮 `durable == None`。
     - 旧 `Harness::run` 仅从当前子进程 stdout 计算 `let reported = durable.map_or(-1, |d| d as i64);`，忘掉了前几轮已核实落盘的 `floor = 4`。SQLite WAL 正确回滚未完成的第 5 步、重开得到 `got.step = 4` 后，旧代码用 `4 > -1 + 1` 误报 `kill 5: reopened at 4 beyond the step being written (0)`。
     - 同时发现旧写法的反向盲区：当续写子进程死在首条 `durable` 前时，`reported = -1` 让 `got.step < -1` 永远不触发——倘若崩溃恢复真的丢掉了前几轮已落盘的 `0..=4` 步（例如退回 `2`），旧断言反而放过数据丢失！
   - **修复方案与永久确定性回归测试（零重试、零放宽断言、零 `ignore`）：**
     - `next/crates/dr-testkit/src/crash.rs`：`Harness::run` 跨轮次维护前序已核实落盘步号 `floor`（初值 `-1`，每轮 `verify` 通过后更新为 `got.step`），抽出纯函数 `check_step(index, floor, durable, recovered)`：若子进程报出 `durable <= floor` 直接判错；以 `baseline = durable.map_or(floor, |d| d as i64)` 作为必须保住的落盘下界、以 `baseline + 1` 作为唯一允许在途的一步，既消除续写首步被杀的误报，又严格堵上「丢失前序已落盘步骤（`recovered < floor`）」的漏检盲区，并补齐两条单测（`resumed_kill_before_first_durable_report_keeps_prior_floor`、`check_step_catches_lost_prior_steps_rewinds_and_two_steps_ahead`）。
     - `next/crates/dr-agent/tests/crash.rs`：① 新增 `warm_workspace`，在子进程打印 `ready` 启动计时前先预热 `BookSlot`，避免冷加载吞掉随机 `delay_ms` 窗口；② 新增 3 轮确定性永久回归测试 `killing_resumed_agent_writer_on_first_step_recovers_book_and_settlement`（第 0 轮提交 `0..=4` 后精准停在第 5 步 `loro_update` 与 `agent_settlement` 之间强杀 → 验证回滚至 4；第 1 轮续写子进程在首步 `step = 5`、`durable == None` 的事务内强杀 → 修复前 100% 稳定复现 `kill 1: reopened at 4 beyond the step being written (0)`，修复后精确验证回滚至 4；第 2 轮续写子进程在首步 `tx.commit()` 之后、打印 `durable 5` 之前强杀 → 验证恢复至 5 且 `one_step_beyond == 1`），全程严格校验正文、`agent_settlement` 与前后 frontiers 一致。同步更新 [`f8-testkit.md`](../foundations/f8-testkit.md) 与 [`m27-agent-runtime.md`](../modules/m27-agent-runtime.md)。
3. **全套门禁结果：**
   - `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo check --locked -p drifting --features debug-bridge`、`cargo check -p prose-spike --lib --no-default-features --locked`：全部通过。
   - `cargo test -p dr-testkit -p dr-agent -p dr-ui -p prose-spike -p dr-platform --locked` 及全工作区测试套件（+3 条新增永久测试）：通过（注：全量跑时顺带观察到既有 `dr-view-element-overview` 的 `drag_drop_onto_island_reuses_g2_prepare_drop_and_supports_undo` 在 `SEED=1` 或特定异步通知时序下会与外壳 `Workspace` 后台重载产生快照竞态，与本轮改动的 crate 无依赖交集，按分轨范围未越界改动 M22）。
   - `cargo xtask check`（12 道门禁含 `v3-cutover` 与 `audit` 974 包 0 漏洞）、仓库根 `pnpm public:check`（5,583 文件）、`pnpm ci:contract:check`（660 测试文件）：全部通过。

### 晚间队列追加四（2026-11-11 23:45，晚间最终指令第 3 项：第 22 条「幕轨道」落地完成）

- **合入记录：** `codex/act-track-v3`（产品候选 `0c4a189c`）本地 `--no-ff` 合入 `main` `bd9c3748`。
- **落地内容：**
  1. **数据模型与兼容（`dr-model`、`dr-doc`、`dr-workspace`、`dr-mcp`、`loro-schema.md`）：** `TimelineLane` 新增可选布尔字段 `act_track`（缺省为 `false`，旧文档与未知字段往返无损，不升 `format_version`；新书初始化默认不建幕轨道）；暴露 `timeline.set_act_track` 与 `timeline.create_act_track`（自动在树顶层创建允许任意模板、默认构想叶子模板的层级泳道并置顶加入当前视图）。
  2. **0.1 旧幕默认无损导入（`dr-import-v1`）：** 彻底移除 `act_binding` 待决门禁（`V3Pending` 归零，无需 `MappingChoices`）。仅在旧库存在幕时于树顶层建「幕」层级（允许任意模板、新条目默认用初始化实际返回的构想叶子模板 id、住处用初始化实际返回的根 id），按书序映射每幕条目（绑在册构想则保持原住处只加「幕」归属；无绑／悬空绑则在「幕」下建同名条目并在模板含颜色字段时带过幕色；同一构想绑多幕仅最早一幕复用，其余建同名条目并记入 `ImportNotice`），跨度取该幕章节在默认视图最早 `at` 至最晚 `at + span`（无 `span` 取默认块宽 `8.0`；无位置章或空幕只加归属不落位置；首幕前章节不生条目；重叠幕照实写；构想在默认视图已有位置则保留原位置不覆盖并记入报告），书稿下的幕分组照旧保留。新增覆盖全部 8 种情形及源库字节＋`mtime_ns` 不变的永久测试。
  3. **时间线界面与九语文案（`dr-view-timeline`、`dr-i18n`）：** 多条幕轨置顶渲染在标尺正下方并以底部分隔线与普通泳道区隔；支持「新建幕轨道」、已有泳道切换幕轨开关、泳道内首条新建自动对齐视图起点（修复空幕轨新建落到全视图最末章外侧的越界问题）、拖入已有条目、拖拽改跨度与双击进条目页；补齐九语文案。
- **全套门禁与副屏真窗口验收：** `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、全工作区 `cargo test --workspace --locked`（0 失败）、`cargo xtask check`（13 门禁含 `v3-cutover` 700 文件与 `audit`）、仓库根 `pnpm public:check`、`pnpm ci:contract:check`、`pnpm agent:capabilities:check` 全绿；副屏真窗口 `act-track-v3.json`（44/44）、`k4-g3-views-lanes.json`（40/40）、`switch-v3.json`（49/49）全部 `0 pending` 通过（外部证据 `~/Drifting-autopilot-logs/act-track-smoke-3/`）。
- **下一步：** 立即开新工作区进入晚间队列第 4 项（文案和调试残留）。

### 晚间队列追加五（2026-11-12 00:52，晚间最终指令第 4 项：文案和调试残留清理完成）

- **落地内容（只改文字与移除普通界面调试入口，不动布局、不改存储格式）：**
  1. **条目页内置枚举值九语本地化（`dr-view-elements/src/fields/v3.rs`、`dr-i18n`）：** 为内置单选／多选字段选项增加界面显示映射——章写作状态 `draft`／`revised`／`finished` 与构想状态 `drifting`／`anchored`／`settled` 在九种界面语言下均显示对应本地化名称（如简体中文「草稿／修改中／定稿」「漂流中／已锚定／已落定」），用户自定义枚举选项原样显示，底层 Loro 文档存储的原始英文枚举键（`"finished"`、`"drifting"` 等）完全不变。新增永久测试 `builtin_enum_options_render_localized_labels_while_storing_raw_crdt_values`。
  2. **设定侧栏与页头消除英文残留（`dr-shell/src/settings/registry.rs`、`dr-i18n`）：** 将设定面板硬编码的英文 `"General Agent"` 及相关分组名接入 `v3Settings.*` 九语词条（简体中文显示「通用帮手」），新增全部九语种覆盖测试。
  3. **导入文档对话框移除旧术语与中英混排大写标题（`dr-view-transfer/src/documents.rs`、`dr-i18n`）：** 将残留的旧术语「主线节点」（`importPreview.summaryNodes`）及中英混排大写小标题改为 canonical v3 的章节数与九语小标题（`v3Transfer.importDocs.*`），新增永久测试 `import_dialog_copy_uses_v3_chapter_terms_and_clean_chinese_headings`。
  4. **从 0.1 重新导入对话框隐藏绝对路径并移出普通界面 `MappingChoices JSON`（`dr-view-import/src/view.rs`）：** 普通就绪对话框改为显示已选源书库文件夹名与简明新库提示，不再向普通用户暴露 `Application Support`／`app-local-data` 原始绝对路径，并从普通界面移除「选择 MappingChoices JSON」按钮（保留 `LegacyImport::choose_mapping` 供开发者测试与调试桥调用）。新增单测与九语集成测试核对。
  5. **补记作者 11-12 凌晨追加：** 已原样记入本页「晚间最终指令 › 凌晨追加（11-12）」，并按第 1 条确认 `app-sync` 已交回、无冒烟在跑后关掉其遗留的两个副屏冒烟窗口（`app-sync-a-634d89f6`、`app-sync-a-6b6b6f11`），同时修好 `~/Drifting-autopilot-logs/run_app_sync_smoke.py` 的 `finally` 双窗退出清理。
- **全套门禁结果：** `cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、全工作区 `cargo test --workspace --locked`、`cargo xtask check`（13 道门禁含 `terms` 48,208 词条与 `audit` 974 包 0 漏洞）、仓库根 `pnpm public:check`、`pnpm ci:contract:check` 全部通过。
- **下一步：** 立即开新工作区进入晚间队列第 5 项（趁机器空闲 `load1m < 4` 在 `heavy` 样书上重量 M22、M23 首帧并做不改行为优化）。
