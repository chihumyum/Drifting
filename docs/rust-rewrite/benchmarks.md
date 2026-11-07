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
