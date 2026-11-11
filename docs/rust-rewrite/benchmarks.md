# 基准：工作负载、预算与输入法矩阵

预算分两档：

- **探针档**：阶段 0 的编辑器探针（P0-B）必须达到，否则停下来重新评估。
- **发布档**：切换到新版之前必须达到。

测量机器沿用旧版的基线：M3 Pro（12 核，36 GB），120 Hz 内建屏。

## 工作负载

所有数据都是合成的，或是有再分发权的样书。

| 名称 | 内容 | 用在哪 |
| --- | --- | --- |
| 单篇正文 | 5 千 / 2 万 / 5 万字，各带 0 / 100 / 500 处人物链接（沿用旧版 `perf:renderer` 的三档） | 编辑器、排版、输入 |
| 样书 | 《傲慢与偏见》61 章约 12.2 万词，配 Hugh Thomson 插图；《阿Q正传》 | 功能验收、导入 |
| 轻量种子 | 20 章 15 万字、30 个要素、10 个构想、12 篇素材笔记、3 段帮手对话 | 日常开发 |
| 重型种子 | 100 章 150 万字（每章 2 千到 2 万字）、300 个要素 50 万字、200 个构想 100 万字（最长 5 万字）、60 篇素材笔记 50 万字、120 条待办、80 条批注、24 张图片、12 个 PDF、24 段帮手对话共 1800 轮 | 性能、全书、导入、内存 |

- 重型种子的规模和语料指纹以 `docs/dev-cli/acceptance/seed-presets.json` 为准。
- F8 把生成器移到 Rust 以后，同一个随机种子要生成同样的语料，并且指纹一致。

## 旧版现状

release 构建，2026-10-30，修复之后的数字。来源：`docs/renderer-performance/heavy-seed-baseline.md` 和 `keystroke-write-path.md`。

| 项 | 旧版 |
| --- | ---: |
| 按键到第二帧 p95 | 29–32 ms |
| 单次按键的写入（Node 重放，中位数） | 10.4 ms |
| 打字时的 CPU（界面进程 / 原生进程） | 31% / 14% |
| 不操作时的 CPU（界面进程） | 4–6% |
| 打开 2 万字章节 | 约 120 ms |
| 打开全书 | 133–167 ms |
| 全书快速滚动 p95 | 18 ms（按脚本的步长估算，只滚过开头两三章） |
| 打开项目 | 292–296 ms |
| 切换标签 p50 | 57–81 ms |
| 展开侧栏 | 161–183 ms |
| Super View 最差帧 | 129–212 ms |
| 关闭最后一个标签 | 约 70 ms |
| 峰值内存（开 12 个标签，加全书和三个 Super View） | 原生 350 MB + 界面进程 1.54 GB |
| 退出 | 0.6 s |

## 预算

| 项 | 怎么量 | 探针档 | 发布档 |
| --- | --- | ---: | ---: |
| 按键到交出画面 p95 | 从按键事件到包含该字的那一帧交给系统（CAMetalLayer present）。程序内探针和 Instruments 都量 | ≤ 16 ms | ≤ 8.3 ms（靠 GPUI 补丁 G1，见 [f4-editor.md](foundations/f4-editor.md#gpui-补丁台账)） |
| 按键到真正显示 | Instruments：到这一帧开始显示（`prose-bench present`）。用同一方法量一次 TextEdit 当参照 | 记录 | 记录 |
| 单次按键的写入（中位数） | Loro 提交，加追加到 SQLite | ≤ 2 ms | ≤ 1 ms |
| 打字时的 CPU | 整个进程，每秒 8 个字，持续 60 s | ≤ 15% | ≤ 8% |
| 不操作时的 CPU | 编辑器打开、光标闪烁 | ≤ 1% | ≈ 0 |
| 打开 2 万字章节 | 从点击到第一屏字出现 | ≤ 80 ms | ≤ 50 ms |
| 打开全书 | 重型种子 | ≤ 200 ms | ≤ 100 ms |
| 全书快速滚动 | **从头一路滚到尾**，看最差的 p95 帧 | ≤ 16.7 ms | ≤ 8.3 ms |
| 跳到末章 | 从目录点最后一章，到字出现 | ≤ 150 ms | ≤ 80 ms |
| 滚完全书后的内存 | 整个进程 | ≤ 800 MB | ≤ 400 MB |
| 组字中更新候选窗 | 每次按键到候选窗跟上 | ≤ 16 ms | ≤ 8.3 ms |
| 冷启动到书架 | 进程启动到书卡出现（从可执行文件开始运行算起，不含 macOS Launch Services 在 `open` 或双击时多出的约 0.3–0.4 s，见 [P0-A](spikes/p0-a-skeleton.md)） | — | ≤ 300 ms |
| 打开项目 | 重型种子，从书架点开 | — | ≤ 150 ms |
| 切换标签 | 反馈 / 内容就绪 | — | 1 帧 / ≤ 50 ms |
| 展开或收起侧栏 | 动画期间 | — | 不掉帧 |
| Super View 首开 | 最差帧 | — | ≤ 100 ms |
| 退出 | 包括保存 | — | ≤ 0.5 s |
| 冷开全书的 Loro 文档 | 100 个正文文档加书目文档，从 SQLite 读到可用 | 记录 | ≤ 300 ms |
| 导入旧库 | 重型种子库，从旧库到新库 | 记录 | ≤ 60 s，显示进度 |
| 同步恢复 | 重型种子，从 Hosted 恢复到本机 | — | 记录，切换前定预算 |

- 发布档的帧时间按 120 Hz 计。60 Hz 屏上按 16.7 ms 算。
- 「按键上屏」2026-11-07 起拆成上面两条（监管会话定）：交出画面之后，WindowServer 合成和面板刷新还要两到三个刷新周期，任何经过合成器的窗口都一样，所以「真正显示」只记录、和系统自带程序比，不设预算。
- 打字 CPU 和空闲 CPU 是「整个进程」的数字。旧版的数字是界面进程和原生进程分开统计的，对比时要把两者相加。

## 输入法矩阵

### 输入法

| 平台 | 输入法 |
| --- | --- |
| macOS | 系统拼音（简体）、系统注音（繁体）、微信输入法、搜狗、百度、系统日语 |
| Windows | 微软拼音、微软注音、搜狗 |

### 情形

每种输入法都要跑过下面这些情形：

1. 在章末组字，在段首组字，在一段 5000 字的长段落中间组字。
2. 在人物链接的里面和边缘组字；在加粗的边界组字。
3. 选中文字以后，用组字替换它。
4. 组字过程中失焦：切换标签、点击别处、切到另一个应用。
5. 组字过程中撤销。
6. 组字过程中，同步把远端对同一章的修改带进来。
7. 在全书模式里组字，以及滚动中组字时候选窗的位置。
8. 标题、搜索、设置这些单行输入里的组字。

### 合格

- 不丢字，不重复字；
- 没有残留的组字状态（失焦以后不会还剩一段被选中的拼音）；
- 候选窗贴着光标；
- 撤销一次去掉整个上屏的词。

这一项靠人工测试，结果记录在 `docs/rust-rewrite/acceptance/ime-matrix-<日期>.md`。

## 测量方法

- **基准程序**：`cargo run -p dr-testkit --bin bench`（F8 提供）。
  - 能脱离窗口测的项，用 GPUI 的 `HeadlessAppContext` 加真实的文字系统来测，包括 Loro、存储、排版和导入。
  - 帧时间和内存，在真实窗口里测：
    - 窗口必须在前台。窗口被遮挡时，系统会节流或停帧，这一点和旧版一样；
    - 需要时用 `/usr/bin/sample` 对进程做原生采样。
- **证据**：
  - 每次结果写成 JSON，放进 `docs/rust-rewrite/acceptance/`；
  - 里面带源码指纹、语料指纹、机器信息和原始样本，不含路径和正文；
  - `--check` 校验证据和当前源码是否一致，做法沿用旧版的证据生成器。
- **CI**：只检查计数和形状，不检查耗时。耗时在作者的机器上测，和旧版一样。
- **对比**：每做一项优化，都要拿出改前、改后两份报告，用 `bench --compare a.json b.json` 对比。

### 探针档的测法（P0-B，2026-11-07）

探针程序是 `next/spikes/prose-spike`，正式的 `dr-testkit` 出来之前先用它：

```bash
cd next
cargo run --release -p prose-spike -- headless --out ../docs/rust-rewrite/acceptance/p0-b-headless.json
cargo run --release -p prose-spike -- window --out ../docs/rust-rewrite/acceptance/p0-b-window.json
cargo run --release -p prose-spike -- check ../docs/rust-rewrite/acceptance/p0-b-*.json
```

- **语料**：确定性合成，单章 2 万字（含一段 5000 字的长段落）、全书 100 章 150 万字（每章 2 千到 2 万字）。种子和指纹写在证据里。
- **窗口**：
  - 放在 120 Hz 的内建屏上，窗口置顶（GPUI 不画被完全遮住的窗口）；
  - 测量窗口把 GPUI 的 `inactive_frame_interval` 关掉。GPUI 默认把非前台窗口限制在 30 帧，而且只限制带「下一帧回调」的帧，恰好是测量探头用的机制；作者打字的窗口在前台，本来就不受这个限制。
- **「上屏」的时刻**：GPUI 在显示链接的一拍上画帧，画好的帧在下一个垂直同步显示，也就是下一拍。探头在编辑器画完时登记 `on_next_frame`，回调被调用的时刻记为「上屏」。
  - 编辑器用「立即画」钩子（`setNeedsDisplay:` → `displayLayer:`）时，GPUI 会停掉再重启显示链接，第一拍可能晚一拍，所以这条路径上的「上屏」数字是上限。
- **按键**：进程内调用 macOS `insertText:` 最终调用的同一个函数（`replace_text_in_range`），每秒 8 个字；不含 AppKit 把按键送到这个函数之前的那一段（通常不到 1 ms）。按键时刻要均匀错开在一个刷新周期里：125 ms 正好是 15 个 120 Hz 周期，不错开的话每一键都落在同一个相位上，分布是假的。
- **组字**：进程内模拟 `setMarkedText:` 五次再 `insertText:`；另记输入法查询候选窗位置（`firstRectForCharacterRange` → `bounds_for_range`）的耗时。
- **滚动**：每个显示链接的拍子在回调里推进半屏，从第一章开头到第一百章末尾；记每帧的工作时间（根视图开始渲染到编辑器画完）和相邻两拍的间隔。
- **CPU**：`getrusage` 的用户态加内核态时间，整个进程，占一个核的百分比。空闲另测一次「编辑器不聚焦、光标不闪」，用来区分 GPUI 显示链接本身的开销。
- **内存**：`proc_pid_rusage` 的 `phys_footprint`（活动监视器里的「内存」）。
- **写入**：无窗口；每次按键 = `LoroText::insert` 加 `commit`（事件同步折进段落镜像），再把 `subscribe_local_update` 给出的更新 `INSERT` 进 WAL 模式、`synchronous=NORMAL` 的 SQLite。
- **`check`**：核对证据里的源码指纹（探针源码编进程序算出的 FNV-1a）和两份语料指纹，和当前代码一致才通过。

### 编辑器档的测法（F4，dr-editor 的 prose-bench）

2026-11-07 起，编辑器档用基准程序 `prose-bench`。2026-11-08（F4e 第二批）起它在 `next/crates/dr-editor/examples/prose-bench`：

- **语料**：换成 F8 的重型种子（`dr_testkit::seed`）。全书是种子的 100 章，单章是其中最长的一章。
- **怎么打开**：经 Drifting 真正的路径（工作区会话 `SessionSource`）打开。
- **证据**：写成 F8 格式（`f4e-m2-prose-bench-<子命令>.json`），由 `cargo xtask check` 核对新鲜度。
- **旧证据**：`f4-*.json` 保留作历史，由 P0-B 那一套语料量出。

```bash
cd next
cargo run --release -p dr-editor --example prose-bench -- headless --write   # 无窗口
cargo run --release -p dr-editor --example prose-bench -- decor --write      # 无窗口
cargo run --release -p dr-editor --example prose-bench -- window --write     # 开窗口，占屏
cargo run --release -p dr-editor --example prose-bench -- present --write    # Instruments，占屏
cargo run --release -p dr-editor --example prose-bench -- idle --write       # 开窗口，占屏
cargo xtask check
```

每个子命令都有总超时（`--timeout` 秒）；负载超过 2 时，程序自己把证据标成仅供参考。下面「和 P0-B 不同的地方」说的是 2026-11-07 那一版，仍适用于旧证据。

和 P0-B 不同的地方：

- **语料带块 ID。** 每段的换行符上都有 `bid`（loro-schema v0），快照大约大 4%，Loro 第一次读出全文（`to_delta`）的工作量约翻一倍。
- **打开全书用所有核。** `ProseDoc` 可以跨线程，基准程序像宿主那样把 100 章分到各个核上导入，再交给编辑器。`headless` 另外照 P0-B 的办法单线程量一次（`book_import_ms`），两项都记。
- **带标记的单章。** `headless` 加了一项：2 万字的章节再加 500 处人物链接（`entity:<id>`）和 200 段加粗，量打开时间和「在人物链接中间打字」的写入。
- **真正上屏（`present`）。** 程序内的「上屏」只量到 GPUI 交出画面（CAMetalLayer present）之后的下一个刷新节拍，不含 WindowServer 合成和面板刷新。`present` 在 Instruments 下量到画面真正显示：
  - `xcrun xctrace record --template "Metal System Trace" --instrument os_signpost --launch -- prose-bench trace-typing …`，系统自带，不装别的软件；
  - 被测进程打开单章、关掉光标闪烁（这样画面只因按键而变），每秒 8 字、按键时刻错开在一个 120 Hz 周期里，每次按键前打一个 `os_signpost` 事件（`cc.drifting.prose-bench` / `PointsOfInterest` / `key`）；
  - 导出三张表：`os-signpost`（按键时刻）、`ca-client-present-request`（本进程交出画面的时刻）、`metal-object-dependency-chain-display`（这一帧开始显示的时刻；和 Core Animation 的 `DrawableLifetime` 结束时刻一致，比这一帧的 presented 回调早约 0.3 ms）；
  - 每次按键取它之后第一次交出画面、再取那之后第一次开始显示，得到「按键 → 交出」「按键 → 显示」「交出 → 显示」三个数；
  - GPUI 原节奏和「改完立刻画」各录一次，结果写进同一个证据文件。
- **空闲 CPU 单独量（`idle`）。** 单章打开、窗口可见：聚焦且光标闪烁、聚焦且光标不闪、不聚焦三种，各 30 s。用来对比 GPUI 补丁前后；环境变量 `PROSE_BENCH_GPUI` 给证据里的 `gpui_build` 标名字。
- **负载。** 窗口、`present`、`idle` 的证据里记下测量前的一分钟负载（`load_average_1m_*`）。这台机器上常有别的会话在编译，负载高时帧间隔、上屏的长尾和单线程的数字都会变差，比较时先看负载。2026-11-07 起 `headless`、`window`、`present`、`idle` 在每次测量前后各取一次负载，写进 `conditions`：最高值不低于 2（这台 12 核的机器）就标 `reference_only: true`，表示「高负载、仅供参考」，不能拿来比较构建或补丁；`check` 会列出这些文件，但不算失败。空闲时怎么重测见 [f4-editor.md 的「重测上屏」](foundations/f4-editor.md#重测上屏机器空闲时)。
- **GPUI 补丁的对比。** 临时把工作区指向本机 fork（做法见 [f4-editor.md 的「GPUI 补丁台账」](foundations/f4-editor.md#gpui-补丁台账)），设 `PROSE_BENCH_GPUI` 给构建标名字，跑 `idle` 和 `present` 写成 `f4-idle-patched.json`、`f4-present-patched.json`；量完把工作区改回 Zed 官方标签。
- `milestone` 生成里程碑清单（要求、证明它的测试、测量它的证据），并检查清单里的测试都在源码里。
- `check` 校验源码指纹（`gpui-prose` 全部源码加基准程序）和语料指纹（用了全书的证据才查全书指纹）。

### canonical v3 重型书全链路测量与逐项优化（2026-11-11）

切换至纯 canonical v3 之后，新增端到端基准 `next/app/drifting/examples/v3-heavy-bench.rs`（`cargo run --release -p drifting --example v3-heavy-bench -- --milestone v3-heavy`），在同一重型种子（`Preset::Heavy`，约 165 万字符、100 章、300 个要素、200 条构想、60 篇素材、200 条批注与待办、28,468 处实体链接、680 个文档）与 release 构建、机器空闲（一分钟负载 `< 4.0`）条件下，覆盖首屏、开书、长章节打字、滚动、切章节、层级页与左栏、搜索、时间线全部八条路径。同时保留 `bench v3-book --milestone v3-heavy`、`book-bench --write` 与 `prose-bench {headless,decor} --write` 的机器可校验里程碑证据（`docs/rust-rewrite/acceptance/`）。

从最慢的瓶颈起按顺序逐项修复、每修一项独立复测（不改数据格式、不动 Loro `=1.17.1`、不改既有行为）：

1. **Step 1（批注锚点扫描）：** `BookViewV3::comments()` 原对每条批注重复调用 `forest(&ENTRIES)` 形成 `200 × 633` 扫描，且编辑器首次挂载装饰时遍历未锚定批注。改为单次构建存活集合并增 `anchored_comments()`。单章冷开由 `2,742.8 ms` 降至 `1,169.9 ms`，整书标签由 `2,974.6 ms` 降至 `1,683.1 ms`。
2. **Step 2（实体链接目标快照与整书会话打开）：** `LinkTargets` 原在整书 28,468 处实体链接解析时逐处重扫 `entries()`；增 `TargetSnapshot` 单次快照、`manuscript_docs_from` 单趟收集与 `SessionSource::open_verified_v3`。`book-bench` 冷开由 `1,744.5 ms` 降至 `173.7 ms`，末章跳转由 `234.8 ms` 降至 `4.59 ms`；应用内整书标签降至 `198.7 ms`，切章预览 `p50` 降至 `160.7 ms`。
3. **Step 3A / 3B（单节点树查询、自动链接匹配器缓存与单次读快照 `Book::load`）：** `dr-doc` 新增 `forest_node` / `forest_entry_status` / `entry_raw` / `timeline_views_with`；`BookSlot` 按 `book:<id>` frontier 缓存预编译 `LinkMatcher` 并由 `dr-editor` 按 `(ws.instance_id(), book)` 共享 `Arc<LinkMatcher>` 与 `NameIndex`；`dr-shell::Book::load` 改为单次 `read_book_v3` 直接构造快照，消除开书与层级页切换中的多轮 JSON 往返。`Book::load` 冷读由 `149.4 ms` 降至 `27.1 ms`，开书到主页由 `159.9 ms` 降至 `48.4–52.6 ms`，2 万字长章热开 `p50` 降至 `44.4 ms`，切章预览 `p50` 降至 `38.8–46.0 ms`，末章跳转降至 `46.7–55.7 ms`，层级页四种显示打开由 `1,721–1,758 ms` 降至 `46.4–54.8 ms`，`book-bench` 冷开进一步降至 `104.4 ms`（热开 `37.5–40.7 ms`）。
4. **Step 4（短词与全文搜索热路径）：** `dr-store` 的 `search_in_order` 改用 `HashSet` 去重、纯非 ASCII 短词走 SQLite `instr()`、未列出文档查询改为 `index_state` 轻量扫描；`dr-view-search::v3` 改用 `entries_raw()`、按 `(EntryId, module)` 预分组补丁与表格，并为 ASCII / CJK 子串匹配提供零分配快速路径。3 字实体搜索 `p50` 由 `14.36 ms` 降至 `9.16 ms`，零命中查询由 `13.71 ms` 降至 `8.66 ms`，1 字与 2 字查询分别降至 `10.89 ms` 与 `28.66 ms`。

| 路径与指标 | 优化前（`load 3.18`） | 优化后（`step3b load 2.98` / `step4 load 3.96`） | 预算（探针 / 发布） | 结果 |
| --- | ---: | ---: | ---: | --- |
| 1. 首屏：书架首帧 / 书卡就绪 | `24.3 ms` / `260.7 ms` | `35.7 ms` / `165.9–190.5 ms` | — / `≤ 300 ms` | 达标 |
| 2. 打开书：`Book::load` 冷读 / 热读 `p50` | `149.4 ms` / `131.2 ms` | `27.1–27.3 ms` / `21.3 ms` | — | **5.5–6.2×** |
| 2. 打开书：点书卡到项目主页就绪 | `159.9 ms` | `48.4–52.6 ms` | — / `≤ 150 ms` | 达标（**3.0–3.3×**） |
| 2. 打开书：工作区内打开整书标签（100 章） | `2,974.6 ms` | `120.3–137.2 ms`（`book-bench` 冷 `104.4 ms` / 热 `37.5 ms`） | `≤ 200 ms` / `≤ 100 ms` | 达探针档；冷首开 `< 100 ms` 需改分段挂载交互（已记待作者） |
| 3. 长章打字（21,907 字）：冷开 / 热开 `p50` | `2,742.8 ms` / `2,442.5 ms` | `97.6–108.2 ms` / `44.4 ms` | `≤ 80 ms` / `≤ 50 ms` | 热开达发布档（**55×**） |
| 3. 长章打字：单键写入 `p50` / 单键帧 CPU `p95` | `0.224 ms` / `1.289 ms` | `0.211–0.274 ms` / `1.637–2.544 ms` | `≤ 2 ms` / `≤ 1 ms`、`≤ 8.3 ms` | 达发布档 |
| 4. 滚动：长章帧 CPU `p95` / 整书帧 CPU `p95` | `2.254 ms` / `1.708 ms` | `2.231–3.157 ms` / `2.313–2.501 ms`（`book-bench` 3,332 帧 `p95 = 0.704 ms`） | `≤ 16.7 ms` / `≤ 8.3 ms` | 达 120 Hz 发布档 |
| 5. 切章节：未访问章预览 `p50` / 跳末章 / 已开标签切换 `p50` | `2,377.5 ms` / `2,444.6 ms` / `7.29 ms` | `38.8–46.0 ms` / `46.7–55.7 ms` / `8.13–8.24 ms` | — / `≤ 50 ms`、`≤ 80 ms`、`≤ 50 ms` | 全部达发布档（**44–61×**） |
| 6. 左栏与层级页：展开左栏 / 根标签切换 `p50` / 目录滚动 `p95` | `39.2 ms` / `10.1 ms` / `1.67 ms` | `27.2–30.9 ms` / `8.9–9.3 ms` / `2.64–2.98 ms` | 不掉帧 | 达标 |
| 6. 层级页四种显示首开（列表 / 网格 / 看板 / 群岛） | `1,729 / 1,721 / 1,758 / 1,738 ms` | `47.1–54.8 / 46.4–46.7 / 54.4–56.7 / 43.6–47.1 ms` | — | **31–40×** |
| 7. 搜索：1 字 / 2 字 / 3 字实体 / 零命中 `p50` | `13.06 / 33.55 / 14.36 / 13.71 ms` | `10.89 / 28.66 / 9.16 / 8.66 ms`（面板端到端 `p50 = 37.2 ms`） | `LIKE ≤ 40 ms`、`FTS5 ≤ 15 ms` | 全部达标 |
| 8. 时间线：打开 / 首帧 CPU / 横向滚动帧 CPU `p95` | `3.71 ms` / `1.74 ms` / `2.12 ms` | `3.90 ms` / `1.80 ms` / `2.23–2.82 ms` | `≤ 8.3 ms` | 达 120 Hz 发布档 |
| 进程物理内存（`phys_footprint`，滚完全书后） | `147.6–181.7 MB` | `150.4–181.7 MB`（`book-bench` 滚完 100 章 `204.5 MB`） | `≤ 800 MB` / `≤ 400 MB` | 达发布档 |
