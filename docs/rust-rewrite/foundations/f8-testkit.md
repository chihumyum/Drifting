# F8 dr-testkit、dr-cli、调试桥与新工作区门禁

2026-11-07 至 11-08，第一到第三个里程碑（第三个里程碑在 F6 把稿纸换成编辑器以后补了一轮）。计划见 [foundation.md 的 F8](../foundation.md#f8-dr-cli-与-dr-testkit)，要简化的东西见 [simplifications.md](../simplifications.md) 第二、五、六节。

## 一句话

旧版的测试设施是「同一件事好几套」：种子约 10 套、崩溃试验台 6 套、基准十几套、几十个检查脚本各写一份指纹。新工作区里每样只留一套：

- **测试数据只有一个来源**：`dr_testkit::seed`。
- **证据只有一种做法**：契约类当场断言，测量类在里程碑提交。
- **崩溃试验台和基准各一套**。
- **新工作区的规矩一条命令查完**：`cargo xtask check`，CI 每次都跑。
- **真实窗口也能照脚本操作**：开发版带上调试桥，Agent 会话或者 `dr-cli scenario` 就能打开书、开章、打字、截图（正式包里没有它）。

## 进度

| 部分 | 在哪 | 里程碑 | 状态 |
| --- | --- | --- | --- |
| 统一种子：tiny / lite / heavy / showcase | `next/crates/dr-testkit/src/seed/` | 1 | 做完，指纹钉在测试里 |
| 种子也能通过 F3 的命令写入，和直写对拍一致 | `seed/commands.rs`、`seed/digest.rs` | 2 | 做完 |
| 样书：《傲慢与偏见》《阿Q正传》，以及 showcase 的《慢钟》和书架 | `src/samples.rs`、`fixtures/`；两本样书和摆书的代码在 `dr-samples` | 1 | 做完，只有文字，插图没拷 |
| 合成素材：一张 PNG 地图、三页 A5 的 PDF（Helvetica 和没嵌字体的中文），给 M19 的查看器 | `src/media.rs` | — | 做完（2026-11-08） |
| 测量证据和过期检查 | `src/evidence.rs`、`cargo xtask evidence --check` | 1 | 做完；旧证据待各自迁移 |
| 崩溃试验台 | `src/crash.rs`，F2 示范在 `tests/crash_store.rs` | 1 | 做完 |
| 基准约定和 `bench` 程序 | `src/bench.rs`、`src/bin/bench.rs` | 1、2 | 两个套件：dr-store、dr-workspace（收编 F3 的测量） |
| 门禁 | `next/xtask/` | 1、3、6 | 11 道（第三个里程碑加了「调试桥不进正式包」，第六个加了「热重载不进正式包、依赖不成环」）和 `check-binary`，接进了 `next.yml` |
| 开发实例隔离 | `cargo xtask dev` | 1、3、6 | 做完；`--debug-bridge` 带上调试桥，`--hot` 经 dx 热重载 |
| 开发命令行 | `next/crates/dr-cli/` | 1、2、3 | 接上 F3 的注册表：`describe`、`call`、脚本化 `scenario`、`inspect`；`app` 子命令，场景能启动和驱动应用 |
| 调试桥 | `next/crates/dr-debug-bridge/`、`dr-debug-protocol/` | 3、4 | 做完：打开书和页、打字、按键、动作、F3 命令、读外壳状态和页面文字、等待、截图；第四个里程碑加了按无障碍名字找元素和按它、悬停、拖选、滚动、点进输入框、读章首和要素页头、读设置；第五个里程碑加了答系统的打开、存储面板（`panel.*`）、按卡挑按钮（`within`）、等后台写的文件、读 M41 的对话框和恢复前副本（`library.info`）。组字没做 |
| 阶段 2「写作闭环」验收场景 | `next/crates/dr-cli/scenarios/writing-loop.json` | 3 | 在真实窗口上 46 步全过：从书架打开书、在编辑器里打字、回车、⌘Z、换章、关掉重开 |
| 各模块的验收场景：M03、M09、M10、M11、M18、设置、M39 | `next/crates/dr-cli/scenarios/*.json` | 4 | 七个场景在真实窗口上全过（M18 有一步按待协调跳过）；跑的过程中找到的问题记在「待协调」 |
| M41 恢复备份、一本书导出再导入；系统的打开、存储面板 | `scenarios/restore.json`、`book-transfer.json`，`dr-debug-bridge/src/panel.rs` | 5 | 两个场景在真实窗口上全过；顺手修了 M41 的两处（见「待协调」） |
| 收编编辑器的基准语料 | — | 4 | 等 F4 把基准搬进 `dr-editor` |

## 种子

### 怎么用

```rust
use dr_testkit::seed::{self, Preset};

let seeded = seed::generate(Preset::Lite, seed::DEFAULT_SEED)?;   // 内存里的书目文档和正文文档
seeded.write_to(&library)?;                                       // 可选：写进一个 dr-store 库
println!("{}", seeded.shape().to_json());                         // 规模和语料指纹
```

命令行里写进一个库（应用要关着，加 `--yes` 才执行）：

```bash
cargo drifting workspace scenario seed:lite --library <目录> --yes
```

### 两种写法

同一本书可以用两种方式写进库，结果要一致：

| 写法 | 怎么写 | 用在哪 |
| --- | --- | --- |
| 直写 | `seed::generate` 加 `write_to`：用 dr-doc 直接写文档，ID、对等方、时间戳都是确定的 | 快，逐字节可复现；基准和大多数测试用它 |
| 走命令 | `seed::generate_via_commands`：每一样东西都调 F3 的命令（`Workspace::call`，和界面、帮手、MCP、命令行同一条路），段落格式（标题、任务项、引文、人物链接）走工作区的编辑会话 | 命令层的规则（名字唯一、目标存在、关系类型允许的两端）也检查种子；慢一些 |

- **共同的计划**：两种写法都读同一份「计划」（`seed/plan.rs`）。计划把书里有什么一次定下来：名字、长度、正文、谁链接谁、批注在哪。所有随机选择都在计划里做完，所以两条路写的是同一本书。
- **对拍**：`seed::digest` 把库里的一本书读回成一种和写法无关的形式，两条路的结果比这个。tiny 和 lite 都对拍一致（`tests/seed_commands.rs`）。
  - 实体按名字认，不按 ID；
  - 顺序只比先后，不比数值；
  - 正文比到每一段的标题级别、列表、勾选、引文、粗斜体和人物链接（按目标的名字）。
- **不比的东西**：
  - ID、时间戳和对等方：命令自己生成；
  - 章节书序的具体数值：命令自己排位置，比的是阅读顺序；
  - 分类的布局；
  - 写作日和时间钉：F3 还没有写这两样的命令，所以走命令的种子里没有它们，见「待协调」。
- **只能直写的**：showcase 和两本样书暂时只有直写。

命令行里两种都能用：`scenario seed:<预设>` 是直写，`scenario seed-commands:<预设>` 走命令。

### 预设

| 预设 | 用在哪 | 规模 |
| --- | --- | --- |
| tiny | 单元测试 | 4 章 3 千字、6 个要素、3 个构想，每种东西都有几个 |
| lite | 日常开发 | 20 章 15 万字、30 个要素、10 个构想、12 篇素材笔记、12 条待办、8 条批注 |
| heavy | 性能、全书、导入、内存 | 100 章 150 万字（每章 2 千到 2 万）、300 个要素 50 万字、200 个构想 100 万字（最长 5 万）、60 篇素材笔记 50 万字、120 条待办、80 条批注、400 条关系、一年的写作日 |
| showcase | 截图 | 《慢钟》、《阿Q正传》，再加书架上 6 本中文书（文字按字数合成），各带写作日 |

另外两本样书单独取：`samples::pride_and_prejudice()`、`samples::a_q()`（转调 `dr-samples`，产品首次运行用同一份写进新库）。

lite 和 heavy 的每一类正文，**篇数、总字数、最短、最长**都和旧版 `lite`、`stress` 种子完全一样（`docs/dev-cli/acceptance/seed-presets.json`）。这份旧文件还在的时候，测试会逐项对照；它随旧客户端删掉以后，数字留在 `preset.rs` 里。

### 怎么生成

- **文字**：沿用旧版种子自己写的句库（`sample-project/prose.ts` 的地点、人物、物件、细节、标题和十句原创句子），由随机数重新组合。不含任何真实书稿。
- **随机数**：只有一种，SplitMix64（`dr-samples` 的 `rng.rs`，`dr_testkit::rng` 转出；样书的固定 ID 也从它来）。每篇正文有自己独立的随机流，所以加一类新东西，不会让已有的正文变样。
- **字数**：一个汉字算一个词，标点、引号、换行不算。语料里没有拉丁文字，所以这和产品的字数统计一致。
- **结构**：每篇正文先是一个标题，之后每九段一个标题，依次是 H2、H3、H1，长一些的正文三级都有。章节和构想里的人名链接到要素；素材笔记开头有一个三项的任务列表；批注和待办锚在章节正文的随机一段上，带原文快照。
- **确定性**：对等方 ID 用 dr-doc 的导入对等方，提交时间从固定的「第零天」（2025-11-01）起算。同一个预设、同一个随机种子，生成的每个 Loro 文档**逐字节相同**，测试里比的就是快照字节。
- **写进库**：每个文档先写 dr-doc 的创世提交，再把整段历史作为一次 `import` 来源的更新写进去，然后压缩，和 0.1 导入器（M10）的做法一样。已经在库里的文档跳过。

### 指纹

- 每一类正文一个 SHA-256：按生成顺序，每篇正文的纯文字后面跟一个 NUL。这是旧版种子审计的算法。
- 所有类别再合成一个总指纹 `corpusFingerprint`，基准和证据里记的就是它。
- 测试里钉住了 tiny、lite、heavy 用默认随机种子的总指纹。改了生成器，这个测试就会失败：要在提交说明里写明，并且知道依赖旧指纹的测量证据会变成「过期」。
- **旧版 TS 种子的指纹不复现。** 旧指纹是从 SQLite 里按不固定的行序读出 Yjs、转成 ProseMirror 文字再算的，新存储里没有对应的东西；硬去复现，只会把旧格式的偶然细节搬进新代码。新版只保证规模一致。`benchmarks.md` 说的「同一个随机种子生成同样的语料、指纹一致」，指的是新生成器自己前后一致。

### 样书

四个 JSON：《傲慢与偏见》、《阿Q正传》在 `crates/dr-samples/books/`（产品要把它们写进新库，见 `dr_samples::ensure_built_in`），《慢钟》和截图书架在本 crate 的 `fixtures/`。它们是 0.1 客户端样书定义逐字段导出的，出处和授权见两处的 `README.md` 和仓库根目录的 `ASSET_PROVENANCE.md`。

`dr-samples` 的 `layout.rs` 照 0.1 的样书写法把它们摆成书（写书用的 `Builder` 也在 `dr-samples` 的 `build.rs`，种子的合成预设用同一个；测试工具箱转出 `seed::{SeededBook, T0, write_book}`、`text::{Para, Link, plain}`，外部接口不变）：

- 幕、章、梗概、故事线；
- 分类和要素（别名、事实）、关系类型和关系；
- 时间钉、构想、素材笔记（Markdown 的标题、列表、任务、粗体）；
- 批注和待办（引文在正文里找到后锚上）、补丁、情节规划表；
- 章节里的人名按「最长优先、不重叠、拉丁名按词边界」链接到要素；
- 《傲慢与偏见》的斜体和信件（引文块）保留。

插图（约 80 万字节的 JPEG）这一轮没有拷，等阶段 7 搬旧目录资源时一起搬。

## 证据

旧版「每个里程碑都交证据」的做法太重，新工作区只留两类：

- **契约类**（种子的规模、表结构、命令清单）：不提交 JSON，测试当场生成当场断言。需要人看 diff 的（命令清单）用 insta 快照测试，和 dr-workspace 的做法一样。
- **测量类**（耗时、内存）：只在里程碑、或者「优化前后」各提交一次。
  - 文件名带里程碑：`<里程碑>-<名字>.json`，放在 `docs/rust-rewrite/acceptance/`。
  - 文件里记：
    - 输入：每个输入是 `next/` 下的一个文件或目录，各算一个指纹。只覆盖语料生成器、基准程序和被测的 crate，不覆盖整个仓库；
    - 语料指纹；
    - 机器信息：CPU、核数、内存、系统、当时的负载，没有路径和用户名；
    - 结果。
  - 输入变了，检查只报「过期」，不算失败；合并以后也不刷新。到下一个里程碑重测。

检查只有一处：

```bash
cargo xtask evidence --check
```

`cargo xtask check` 也会跑这一项，CI 每次都跑。检查的规则：

- **新格式的证据**：文件名对不上、没有输入、没有结果，就算失败；
- **旧格式的 JSON**（P0、F1、F2、F4、M10 留下的 21 份）：标成「旧格式」列出来，由各自的会话迁移，见文末「待协调」。

这一轮唯一一份新格式证据是 `f8-m1-store-bench.json`，见下面「基准」。

**2026-11-08 统一重测**：第十三批合进来以后，`cargo xtask check` 报 14 份新格式证据过期。等机器空下来（一分钟负载降到 4.7，没有别的会话在编译）以后，按每份文件里 `generatedBy` 记的原命令原地重测了 13 份，一份接一份，测的时候负载 3–5，十三份都是离屏绘制，没有开窗口。现在是 13 份新鲜、1 份过期：
- 重测的：`f8-m1-store`、`f1-m3-doc`、`dr-text-index-m2-index`、`f2-m4-index`、`f8-m2-workspace`、`f3-m2-workspace`、`f2-m4-workspace`、`f4-m3-editor`、`f4e-m2-prose-bench-decor`、`f4e-m2-prose-bench-headless`、`m05-m1-book`、`f6-m3-shell`、`m01-m02-shelf-home`；
- 数字都比上一次快（上一次多半是在负载 14–19 下测的），没有变慢的；下面「基准」两张表还是第一次测的数，以文件为准。heavy 种子上的搜索从 33–47 ms 降到 0.5 ms（一个字）和 4.4 ms（三个字）；
- **没重测的**：`m10-m4-import.json`。它要 0.1 客户端的测试库（`m10-fixtures.test.ts` 生成的 `sample` 三份，加 0.1 种子命令生成的 `lite`、`stress`），`next/` 里单独生成不了，等 M10 的下一个里程碑；
- 旧格式的 15 份（包括会占前台窗口的 `f4-window`、`f4-present*`、`f4-idle-*`）不算过期，这次没动。

## 崩溃试验台

做法和 P0-C、F2 一样，抽成了通用的 `dr_testkit::crash`：

1. **写入进程**：就是测试程序自己。带上环境变量重新启动它，只跑一个「写入」测试。它不停地写，每确认一步已经落盘，就报告一行。
2. **杀掉**：试验台在随机时刻杀掉它（Unix 上是 SIGKILL，Windows 上是 TerminateProcess）。
3. **验证**：重开它写的东西，交给验证函数：和确定性重放比，返回重开以后的最后一步。
4. **规则**：试验台统一检查两条：
   - 写入进程报告过已落盘的步骤，一步都不能少；
   - 最多多出它正在写的那一步。
5. **报告**：按「杀在哪个阶段」分类，比如「压缩中」「两步之间」。

F2 的示范（`tests/crash_store.rs`）：

- 写入进程通过 dr-store 的文档持有者编辑一篇 2 万字的文档，每 25 步压缩一次，压缩事务故意多开 20 ms，好让杀进程落在压缩中途；
- CI 里杀 8 次，一般有一半落在压缩中，没有一次丢失已报告的写入；
- 重开加重放比对，每次十几毫秒。

## 基准

### 约定

一个**基准套件**是一个函数，跑完交回若干个**用例**。每个用例有两样东西：

- **形状**：计数和大小，比如写了几次、收到几个事件、多少字；
- **耗时样本**。

套件有两种跑法：

| 跑法 | 数据 | 谁跑 | 查什么 |
| --- | --- | --- | --- |
| 快跑（quick） | tiny 种子，重复几次 | CI（`cargo test` 和 `bench --check`） | 只查形状，确认基准还在做它说的事 |
| 全跑（full） | heavy 种子，完整重复 | 作者的机器，release 构建 | 记耗时，从不断言；加 `--milestone` 写成测量证据 |

```bash
cargo run --release -p dr-testkit --bin bench -- store                       # 结果打到屏幕
cargo run --release -p dr-testkit --bin bench -- store --milestone f8-m1     # 写成测量证据
cargo run -p dr-testkit --bin bench -- --check                               # 每个套件快跑一遍，比形状
cargo run -p dr-testkit --bin bench -- --compare a.json b.json               # 两份结果的 p50 对比
cargo run -p dr-testkit --bin bench -- --list
```

新模块的基准加进 `bench::suites()`，写清它的输入（被测的 crate）和快跑的形状。

### 示范：dr-store

从 F2 的 `f2-bench` 迁来两项，数据换成统一种子（heavy）：

- 一次按键经过文档持有者：提交、导出、追加进 SQLite、发出事件。`synchronous=NORMAL` 和 `FULL` 各测一次；
- 全书 100 章：
  - 从 SQLite 冷读全部章节；
  - 读出全部文字；
  - 开 100 个持有者，再关掉。

`f8-m1-store-bench.json` 是第一个里程碑测的；之后 dr-store 加了两个迁移、种子也重构成了「计划加写法」，`evidence --check` 现在报它「过期」，到下一次测 dr-store 时再重测。当时的结果（M3 Pro；测的时候机器上别的会话在编译，一分钟负载 14.6，所以长尾偏高）：

| 项 | p50 | p95 | 预算 |
| --- | ---: | ---: | ---: |
| 按键写入（NORMAL） | 0.061 ms | 0.441 ms | 探针档 2 ms，发布档 1 ms |
| 按键写入（FULL） | 0.075 ms | 0.181 ms | — |
| 冷读全书 100 章（150 万字） | 15.9 ms | 34.2 ms | 发布档 300 ms |
| 读出全书文字 | 32.5 ms | 63.1 ms | — |
| 开 100 个持有者 | 28.3 ms | 109.9 ms | — |

### 收编 F3 的测量：dr-workspace

F3 的 `tests/measure.rs`（`f3-workspace-measure.json`）改成了 `bench` 的 `workspace` 套件，放在 dr-testkit 里，F3 的代码一行没动：

- **数据**：heavy 种子，**走命令写入**。它正好就是 F3 原来测的规模（100 章、300 要素、200 构想、400 关系、约 200 条批注），区别是正文从每章 2 千字变成了 2 千到 2 万字；
- **测什么**：
  - 写入种子本身；
  - 重开以后第一次查列表；
  - 反复查（按名字调，和直接调类型）；
  - 改一处后马上查；
  - 一个个命令；
  - 搜索；
  - 撤销帮手的一整轮写入。

```bash
cargo run --release -p dr-testkit --bin bench -- workspace --milestone f8-m2
```

`f8-m2-workspace-bench.json` 的结果（M3 Pro，一分钟负载 16.9，和 F3 测的时候差不多）：

| 项 | p50 | p95 | F3 原来（轻量数据） |
| --- | ---: | ---: | ---: |
| 走命令写完整个 heavy 种子（1623 个命令、679 次编辑会话） | 6.3 s | — | — |
| 重开后第一次列章节 | 24.5 ms | — | 11.4 ms |
| 列章节（按名字 / 按类型） | 0.29 / 0.035 ms | 0.65 / 0.11 ms | 0.18 / 0.013 ms |
| 列要素、列关系 | 0.71、0.77 ms | 1.35、1.38 ms | 0.49、0.51 ms |
| 新建章节（空的 / 带 2 千字） | 2.4 / 4.8 ms | 5.7 / 11.9 ms | 1.0 / 2.7 ms |
| 改章名、批注、撤销 | 0.35、0.38、1.08 ms | 1.25、1.11、3.54 ms | 0.15、0.13、0.79 ms |
| 改一处关系后马上列关系 | 15.3 ms | 27.6 ms | 5.1 ms |
| **搜索（三个字 / 一个字）** | **47.4 / 33.0 ms** | 58.9 / 36.9 ms | 0.42 / 4.1 ms |
| 撤销帮手的一轮（10 处改动） | 112 ms | — | 74 ms |

- **搜索变慢了一百倍左右**：heavy 种子的正文约 360 万字，是 F3 测试数据（约 20 万字）的十几倍，搜索的耗时涨得比正文量快。这是统一种子第一次在全书规模上测命令层就测出来的，交给 F3 和 dr-index 看，见「待协调」。
- **其余慢两三倍**：一是书目文档大了，二是测量时机器负载高（其他会话在编译）。要比较，先在同样的负载下重测。
- **F3 原来的测量文件**：`f3-workspace-measure.json` 和 `tests/measure.rs` 可以由 F3 删掉。

## 门禁：`cargo xtask check`

```bash
cd next
cargo xtask check                      # 全部
cargo xtask check --list               # 有哪些
cargo xtask check --only privacy,terms
cargo xtask check --skip audit         # 离线时跳过漏洞审计（它要联网取数据库）
```

| 门禁 | 查什么 | 对应第六节 |
| --- | --- | --- |
| privacy | `next/` 和 `docs/rust-rewrite/` 里（未跟踪的文件也查）：个人绝对路径（`example`、`me`、`runner` 这类占位名除外）、私有姊妹仓库的路径、署名行，以及 `.env`、`.pem`、`.p12`、`.p8`、`.mobileprovision`、`.jks`、`.keystore` 文件 | 1 |
| large-files | 同一范围里，大于 1 MiB 的二进制文件（字体这类大资源是构建产物，不提交） | — |
| retired | `next/` 里不出现已退役的产品：云盘同步、旧的应用内 AI 及其 BYOK 路由、三个独立的帮手产品、独立 Apple 前端、旧对象存储、旧 SDK 会话。名单照搬旧版的三份守护测试。导入器和数据模型需要读旧库里存的退役取值，这几个文件按旧守护测试的做法列为例外 | 6 |
| terms | 构想的两个旧中文名在 `next/` 里一处都不许有；产品文字里不用 inspiration 指构想；**H1/H2/H3 不叫 scene、beat、场景、节拍**（这一条以前没有任何检查）。「产品文字」是测试、夹具、基准以外的 Rust 字符串字面量，加上 `locales/`、`prompts/`、`templates/` 里的文件；注释和文档可以解释规则 | 7 |
| migrations | `crates/*/migrations/` 下的每个迁移都登记在 `xtask/src/gates/migrations.rs`；已发布的钉住 SHA-256，改了、删了、没登记、编号不连续都算失败。`0000_baseline.sql` 还没发布，登记为「未冻结」，检查时打印它现在的哈希 | 10 |
| licenses | 用 `cargo metadata` 查：工作区默认 AGPL-3.0-or-later；`gpui-prose` 是 MIT OR Apache-2.0，它的任何依赖（包括 dev-dependencies）都不能是 `dr-*`；第三方 crate 的许可证表达式必须能用白名单满足（813 个全过） | 3 |
| layers | 依赖方向：界面 → 应用服务 → 数据，平台和工具在旁边。数据、应用服务、平台和工具都不能编进 GPUI，直接间接都不行；产品 crate 不依赖工具和探针（dev-dependencies 用测试工具可以）；每个成员都要在 `layers.rs` 里归了类 | 4 |
| debug-bridge | 调试桥只能主动打开：没有哪个成员非可选地依赖 `dr-debug-bridge`（dev-dependencies 可以），没有哪个成员的 `default` 特性顺着特性表展开后会打开它，`next/script/` 下的打包脚本和发布流程草稿里不出现 `debug-bridge`。另有 `cargo xtask check-binary <文件>…` 查打好的可执行文件，见「调试桥」 | 9 |
| hot-reload | GPUI 的热重载只能主动打开：没有哪个成员在普通依赖里直接要 `gpui/hot-reload`，没有哪个成员的 `default` 特性展开后会打开它，`next/script/` 下不出现 `hot-reload`、`dx serve`；工作区依赖图（普通、构建、开发依赖都算）里没有环，dx 打补丁要按这个图排先后。`cargo xtask check-binary` 也查这个（程序里有「GPUI hot reload」就失败），见「热重载」 | 9 |
| evidence | 见上面「证据」 | 第五节 |
| audit | 对 `next/Cargo.lock` 跑 `cargo audit`：有漏洞就失败；「不再维护」「不健全」只列出来，现在有 12 条：4 个来自 Loro（`im`、`sized-chunks`、`bitmaps`、`atomic-polyfill`，其中 `im` 和 `sized-chunks` 标了「不健全」），其余来自 GPUI。取不到漏洞数据库也算失败 | 5 |

在这台机器上全部跑完约 7 秒。

### 几处取舍

- **不装新工具。** 许可证白名单原计划用 cargo-deny，改成 `cargo metadata` 加约 60 行 SPDX 表达式解析，不多装一个工具。漏洞审计用机器上已有的 `cargo audit`，CI 里装同一个版本（0.22.2）。
- **被 `.gitignore` 忽略的文件不查。** 它们本来就提交不进来，这和旧版的公开边界检查一致。未跟踪、没被忽略的文件要查。
- **gpui-prose 的 dev-dependencies 也不许用 `dr-*`。** 示例和测试会链接进被依赖的代码；一个准备单独开源的宽松许可证 crate，在仓库外也必须能编译和测试。所以 F4 的基准程序以后要搬到一个 AGPL 的 crate 里（见「待协调」）。
- **应用服务也不许编进 GPUI。** 命令行、MCP 和测试都要在没有窗口的情况下调同一套命令，F3 的 `dr-workspace` 现在也确实不依赖 GPUI。
- **基准放在 examples 里的也算基准**：`examples/` 下文件名或子目录名带 `bench` 的文件，用词门禁不当成界面文案。dr-index 的基准读旧种子 JSON 的旧键名，监管会话合并时加了这一条；第二个里程碑补上了子目录的情况（`examples/prose-bench/synth.rs`）和测试。
- **不为「单包能过、全工作区挂」加门禁。** 合并时 dr-workspace 的能力清单快照在 `cargo test --workspace` 下挂过：别的 crate 打开了 `serde_json` 的 `preserve_order`，键的顺序变了。这类问题的根是 cargo 在一次构建里把各包的特性合并，单独查哪个包都看不出来；CI 本来就是全工作区跑测试，已经能抓到。规矩是：**快照里的 JSON 先排好键再比**，比较两个 JSON 值用 `==`（它不看键的顺序），不要比序列化出来的字符串。
- **门禁自己的源码** 要写出它在找的东西，所以这些模式都是拼出来的（和旧版守护测试一样），免得被别的扫描器当成真货。

### CI

`.github/workflows/next.yml` 的变化：

- 在 macOS 那一条上，装 cargo-audit、跑 `cargo xtask check`，再跑仓库根目录的 `node scripts/check-public-boundaries.mjs`。门禁读的是工作区的元数据和文字，两个平台结果一样，只跑一遍；rust-cache 会缓存 `~/.cargo/bin`，命中时安装那一步什么都不做。
- 触发路径加上：
  - `docs/rust-rewrite/**`：门禁要扫它；
  - `next/` 还在引用的旧目录资源：`src/assets/design/**`、`src/assets/icon.*`、`src/renderer/locales/**`。阶段 7 搬完以后去掉；
  - 公开边界检查脚本本身。

### 第六节还没做的

| 条 | 内容 | 谁来做 |
| --- | --- | --- |
| 2 | 必需的公开文件 | 已经由 `check-public-boundaries.mjs` 查，现在 `next.yml` 也跑它 |
| 8 | 九种语言的文案键齐全、插值占位一致 | `dr-i18n` 的编译期检查 |
| 11 | GPUI fork 的来源校验 | F4，挂 fork 的时候 |
| 12 | Codex 兼容检查，每周一次 | M28 |
| 13 | 发布前检查 | M42 |

## 开发实例隔离：`cargo xtask dev`

在一个 linked worktree 里，`cargo xtask dev` 用 worktree 的名字当 `DRIFTING_PROFILE`（F7 已经支持），再 `cargo run -p drifting`。每个 worktree 的开发版因此各有：

- 数据和日志文件夹；
- 钥匙串服务；
- 单实例锁。

两个 worktree 的开发版不会抢同一把锁，也不会指向同一个库。

```bash
cargo xtask dev                       # 这个 worktree 自己的 profile
cargo xtask dev --instance two        # 同一个 checkout 再开一个：<worktree>-two
cargo xtask dev --debug-bridge        # 带上调试桥（cargo run -p drifting --features debug-bridge）
cargo xtask dev --hot                 # 热重载：经 dx serve --hot-patch 起应用（见下）
cargo xtask dev --print-config        # 打印 profile、文件夹、钥匙串服务、调试桥的连接文件，不启动
cargo xtask dev --release -- --mcp …  # 参数原样交给程序
```

- **主 checkout**：不设 profile，就是作者日常用的开发版；加 `--instance` 才隔离。
- **profile 名**：只用小写字母、数字和连字符，最长 32 个字符，这是 F7 的规则。名字太长就截断，再加 6 位哈希，两个长名字不会撞成同一个。
- **和 dr-platform 对齐**：文件夹的算法和 dr-platform 的 `AppDirs` 一致，测试里拿两者对照。
- **端口**：旧版每个实例还分端口；新版的调试桥按 profile 分开（连接文件在 profile 的数据文件夹里，socket 名带实例名的哈希）。
- **规则只有一份**：profile 怎么从 worktree 名算出来，写在 `dr_debug_protocol::place`，xtask 和 `cargo drifting app` 共用。

### 热重载：`cargo xtask dev --hot`

改了界面的代码，不用重编、重启、再点回原来的地方：存盘以后，正开着的窗口里那一块原地换成新的。

```bash
cargo install dioxus-cli --version 0.7.10 --locked   # 一次；版本要和 GPUI 钉的 subsecond 一样
cargo xtask dev --hot                                # 经 dx serve --hot-patch 起应用，profile 照旧隔离
cargo xtask dev --hot --debug-bridge                 # 再带上调试桥
cargo xtask dev --hot --print-config                 # 看会跑什么命令，不启动
```

- **原理**：钉住的 GPUI v1.27.0 带 `hot-reload` 特性（Zed PR #65738，用 Dioxus 的 subsecond）。应用经 `dx serve --hot-patch` 启动时，dx 盯着源码，改了就只编改动的那几个函数，打成补丁发给正在跑的应用；GPUI 在两次更新之间换上补丁，再让所有窗口重画。应用这边只是打开 GPUI 的这个特性（`drifting` 的 `hot-reload` 特性，`--hot` 会带上）。
- **能换的**：视图和组件的渲染函数（`Render::render`、`RenderOnce::render`），以及它们调用到的代码：布局、颜色、文字、哪些子元素、点击处理器里写的逻辑。
- **换不了的**（要重启，dx 会说要整个重来）：
  - 自定义元素的 `request_layout` / `prepaint` / `paint`（GPUI 不经过补丁表调它们；编辑器的正文就是这种元素）；
  - 结构体加减字段、改类型（内存里的旧对象还是旧的样子）；
  - 加新依赖、改 `Cargo.toml`、改构建脚本；
  - 启动时只跑一次的代码（`main`、`init` 里注册的东西、快捷键表）：换了也不会再跑。
- **哪些 crate 改了能热替换**：dx 0.7.10 打补丁时，要把改了的 crate 和**所有**依赖它的工作区 crate（测试用的依赖也算）按第一次全量构建时记下的编译参数重编一遍；应用没编进去的 crate 没有这份参数，补丁就失败（「Missing rustc args for replay: 'dr_testkit'」），窗口里还是旧代码，在 dx 的终端按 `r` 全量重编（或者重启 `cargo xtask dev --hot`）。所以只有「依赖它的 crate 全在应用里」的 crate 才能热替换。`cargo xtask dev --hot` 启动时把这一份名单打印出来（`--print-config` 里是 `hotReload.crates`，按当时的工作区和特性现算）。合进 main `069caa5e`（第十八批）以后是：
  - 能：整个界面层：`dr-shell`、`dr-ui`、`dr-editor`、`gpui-prose`、`gpui-ime`、`prose-linebreak`、所有 `dr-view-*`、`dr-i18n`、`dr-export`、`dr-mirror`、`dr-debug-bridge`；
  - 一直不能：数据和服务层（`dr-store`、`dr-doc`、`dr-model`、`dr-index`、`dr-text`、`dr-workspace`、`dr-corpus`、`prose-metrics`、`dr-platform`、`dr-import-v1` 等），命令行和测试工具（`dr-cli`、`dr-testkit`、`xtask`）和还没接进应用的 `dr-agent` 依赖它们，而应用不编这些。这是 dx 的限制（它不把补丁限在应用编进去的 crate 里），热替换本来就是给界面用的；
  - 一个新 crate 还没接进应用时，它依赖的界面 crate 也会暂时不能（第一次算时 `dr-shell`、`dr-ui`、编辑器就是被当时没接上的 plot、shelf-art、timeline、relations、sea 挡住的）。
- **快多少（2026-11-08，M3 Pro，机器负载 16–90，只作参考）**：改的是书架左栏格子（`dr-view-shelf` 的 `rail_cell`，书架的渲染函数调到的那个函数）读屏用的名字，再用调试桥轮询 `ui.find` 看到新名字为止：
  | 做法 | 从保存到窗口里变了 |
  | --- | ---: |
  | `cargo xtask dev --hot`，热替换（6 次） | 3.9–8.4 s，多数 6 s 左右；dx 自己报的「编补丁」0.8–2.1 s，其余是 dx 发现文件变了、窗口画下一帧 |
  | `cargo xtask dev`，关掉、重编、再启动（2 次） | 19.6 s、20.4 s |

  热替换不重启，所以开着的书、页、对话框、滚动位置都还在；重启要再点回去，上表没算这一段。dx 用自己的构建目录（`target/dx/`），第一次 `--hot` 要全量编一遍（这次 335 s），之后改了别的再起是 56 s。
- **只在调试构建里**：GPUI 的构建脚本只在打开特性、而且有调试断言时才编进补丁的接收端，`--hot` 和 `--release` 一起给会被拒绝。
- **依赖不能成环，连测试用的依赖也算**：dx 打补丁时，把改了的 crate 和所有依赖它的工作区 crate 一起重编，按依赖图排先后；它的依赖图连开发依赖（dev-dependencies）也算，遇到环就停（「Cycle in workspace dependency graph — cannot determine replay order」）。Cargo 允许「A 依赖 B，B 的测试又依赖 A」，dx 不行。实测：改书架（dr-view-shelf）一切正常，改 dr-store 就报这句。工作区里原来有四个这样的环，都只是测试或示例，2026-11-08 解开了，办法都是把那个测试或示例挪到环的另一头：
  1. dr-store 的测试用 dr-testkit 的随机数和语料，dr-testkit 又写 dr-store：不碰库的那几样收进新的 `dr-corpus`（数据层，只依赖 dr-model）：随机数（`rng.rs`）和段落（`para.rs`）从 dr-samples 挪过来（F5 第七轮刚把它们放进 dr-samples，而 dr-samples 写库），合成语料（`text.rs`）和指纹（`digest.rs`）从 dr-testkit 挪过来。dr-samples 转出 `rng`、`para`，dr-testkit 转出 `rng`、`text`、`digest`，原来的写法照旧能用，随机数还是同一个类型；dr-store 的测试改用 `dr_corpus`。语料只有一份，种子的指纹不变（只是挪了位置）；
  2. dr-store 里要种子、崩溃试验台或真派生器的两个测试，挪进 dr-testkit 的 `tests/`：`crash_migrate.rs`（迁移各阶段被杀，和原有的 `crash_store.rs` 放在一起）、`store_rebuild.rs`（后台重建不挡打字）。它们照旧用 dr-store 的 `tests/common`（按路径引入）；
  3. dr-index 的 `tests/m10.rs`（导入的 0.1 库打开时建索引）挪到 dr-import-v1 的 `tests/index.rs`：dr-import-v1 本来就依赖 dr-index；
  4. dr-view-history 的 `history-capture` 截图示例挪到 dr-shell 的 `examples/`（M06、M07、M18 的截图示例也在那里）：它要在外壳里显示对话框，而外壳依赖 dr-view-history。

  `cargo xtask check` 的 `hot-reload` 门禁从此查工作区依赖图（各种依赖都算）里没有环，再有就报出环上的 crate。解开以后，改 dr-store 不再报环，而是报上一条的「Missing rustc args」：环是第一道坎，第二道是 dx 本身的限制。
- **代价**：这次挪动改了 dr-store、dr-index、dr-testkit、dr-samples 的目录，以及 `rng.rs`、`para.rs`、`text.rs` 的位置，14 份测量证据都按「输入变了」报过期（不是失败）。挪的是测试、示例和不带逻辑变化的模块，测的代码没有变，种子的指纹测试照旧通过；下一次机器空闲时按各自的 `generatedBy` 重测。
- **不进正式包**：照调试桥的守法，`cargo xtask check` 的 `hot-reload` 门禁查：没有哪个成员默认打开 `gpui/hot-reload`，也没有在普通依赖里直接要它；`next/script/` 下的发布脚本不提 `hot-reload`、`dx serve`。`cargo xtask check-binary` 同时查这个：编进了补丁接收端的程序里有它的日志句子「GPUI hot reload」，有就失败。


`cargo drifting …` 是 `cargo run -p dr-cli --` 的别名。第二个里程碑接上了 F3 的命令注册表：

```bash
cargo drifting workspace describe [--json]
cargo drifting workspace call <命令> --library <目录> [--input JSON] [--yes]
cargo drifting workspace scenario <场景.json | seed:预设 | seed-commands:预设> --library <目录> [--yes]
cargo drifting workspace inspect --library <目录> [--doc <文档 ID>] [--json]
cargo drifting workspace scenario <场景.json> --app <可执行文件> [--profile P] [--out 目录] [--keep] [--yes]
cargo drifting app <动作> …                     # 正在跑的开发版，经调试桥（见「调试桥」）
```

- **`describe`**：列出注册表里的全部命令和查询；`--json` 输出 `registry().manifest()`，带每一项的输入、输出 Schema。
- **`call`**：以作者的身份（来源 `user`）调一个命令或查询，输出它的结果（输出、影响、撤销方式、日志行）。
  - 查询在库的一致副本上跑，不用 `--yes`，应用开着也行；
  - 命令照下面的离线改库规则在库本身上跑；
  - 出错时带上注册表的错误码（`not_found`、`name_taken`、`invariant:<ID>` 等）。
- **`scenario`**：按顺序跑一个 JSON 文件里的调用，给验收用。
  - 每一步可以 `save` 输出，后面的输入里用 `${名字.字段}` 引用（整个字符串只是一个引用时，换成原值，可以是任何 JSON 类型）；
  - `expect` 用 JSON 指针检查输出，`expect_error` 要求这一步按指定的错误码失败；
  - `actor` 可以是 `user`（默认）、`import` 或 `agent:<会话>/<轮>`；
  - `{ "undo": true }`、`{ "redo": true }` 撤销、重做这个身份的上一步；
  - 任何一步失败或者期望不符，就停在那一步并报出步号；
  - 全是查询的场景在副本上跑，不用 `--yes`；
  - 第三个里程碑起，场景还能驱动应用：`seed`、`launch`、`app` 这几种步骤，见「阶段 2 验收：写作闭环」；
  - 格式和例子写在 `crates/dr-cli/src/scenario.rs` 的开头。

- **离线改库的规则**，照旧版：
  1. **应用必须关着**：库的锁（`library.lock`）被别的进程占着，就拒绝；
  2. **先备份**：用 `VACUUM INTO` 把 `library.sqlite` 一致地复制到 `<库>/backups/dr-cli-<毫秒>.sqlite`，备份通过完整性检查才往下走；
  3. **加 `--yes` 才执行**：不加只打印会做什么、备份会放在哪，什么都不改。

  `call` 和 `scenario` 都走这一套。
- **`inspect`**：
  - 用 F2 的只读打开（`Library::open_read_only`：不拿锁、不迁移、不写安全快照、什么都不写）直接读库，应用开着也能看，也不用先复制；
  - 这一版要先迁移的旧库只读打不开，就照原来那样一致地复制到临时目录、在副本上迁移再读，原库不动；输出里 `opened` 说是哪一种（`read-only` / `copy`）；
  - 默认列出文档数、每本书的章节、构想、要素、关系、批注、素材、写作日和正文字数；
  - `--doc` 打印一个文档的完整内容。

  查询（`call` 一个查询、全是查询的场景）还在副本上跑：F3 的查询经可编辑的文档句柄读书目和正文，只读的库不给这种句柄，见「待协调 → dr-workspace」。
- **内置场景**：`seed:<预设>` 直写种子，`seed-commands:<预设>` 走命令写种子。
- **打开库时的版本号**：用和应用一样的版本号（`0.2.0-dev`）打开库，免得命令行打开一次，库就多一份安全快照。

## 调试桥

### 是什么

调试桥是开发版里的一个本机接口。Agent 会话或者脚本连上去，就能像人一样操作**真实的窗口**：打开书、换到某一章、在输入框里打字、按快捷键、触发界面动作，再把稿纸上的文字、外壳的状态和截图拿回来。它代替旧版的 frontend debug bridge。

正式包里没有它：它是应用的一个默认关着的 cargo 特性，只有 `cargo xtask dev --debug-bridge` 打开；门禁和 CI 各查一道。

### 用起来

```bash
cd next
cargo xtask dev --debug-bridge                 # 这个 worktree 的开发版，带调试桥（前台运行）
cargo drifting app info                        # 版本、profile、窗口（在不在前台、有没有被遮住）
cargo drifting app book 慢钟                     # 打开一本书，和在书架上点书卡一样（app shelf 回书架）
cargo drifting app open 第二章 面馆             # 按章名、页面键（chapter:<id>、book）或位置链接打开
cargo drifting app wait --text 周阿婆           # 等书目和屏幕上的页读好，还可以等某段文字出现
cargo drifting app text                        # 这一页编辑器里的段落和选区
cargo drifting app type 灯塔亮了。              # 走 GPUI 的输入路径打字；没有输入框拿着焦点就报 no_input
cargo drifting app key secondary-z             # 按键（secondary 在 macOS 上是 ⌘，别处是 Ctrl）
cargo drifting app dispatch workspace::ToggleLeftSidebar
cargo drifting app call chapter.list --input '{"book": "…"}'   # 在应用打开的库上调 F3 的命令，来源 user
cargo drifting app screenshot shot.png         # 应用自己画出的窗口截图
cargo drifting app quit
```

`app` 连哪一个开发版：`--profile` 优先，其次环境变量 `DRIFTING_PROFILE`，再其次当前 checkout 的 profile（和 `cargo xtask dev` 同一条规则，`--instance` 也一样）。

### 方法

一行一个 JSON：请求 `{"id", "method", "params"}`，回答 `{"id", "result"}` 或 `{"id", "error": {"code", "message"}}`。`cargo drifting app raw <方法> --params '{…}'` 能调任何一个，`methods` 列出全部。

| 方法 | 做什么 |
| --- | --- |
| `app.info` | 版本、profile、进程号、有没有库、能不能截图；每个窗口在不在前台、是否可见（被完全遮住的窗口不画帧）、位置大小、缩放 |
| `app.quit` | 先回答，再走外壳的退出流程（和 ⌘Q 一样：退出钩子、存布局、存设置） |
| `window.focus` / `window.close` / `window.open` | 把窗口带到前台；关掉工作区窗口（macOS 上应用不退出）；再打开 |
| `command.call` | `{name, input, actor?}`：在窗口打开的那个库上调 F3 的命令或查询，默认来源 `user`，也可以 `agent:<会话>/<轮>`；回答 F3 的结果（输出、影响、撤销方式、日志行），错误码沿用 F3 的 |
| `action.list` / `action.dispatch` | 列出所有动作名；按名字触发一个动作，和按它的快捷键一样（发给有焦点的元素） |
| `input.type` | 逐字打字，走 GPUI 的输入路径到有焦点的输入框；换行是回车；没人接就报 `no_input` |
| `input.key` | 按键，空格隔开可以连按：`secondary-z`、`enter escape`；`times` 把整串按几遍 |
| `input.click` | 在窗口坐标（逻辑像素）上点一下，可以连点 |
| `input.move` / `input.drag` / `input.scroll` | 指针移过去（悬停）；按住左键从一点拖到另一点再松开（用鼠标选字）；在某处滚动若干像素 |
| `ui.find` | 窗口无障碍树里的节点：角色、名字、值、位置、中心点。按 `label`（名字全等）、`contains`（名字、值、说明里含）、`role`（去掉 AX 前缀：Button、RadioButton、Slider、PopUpButton、MenuItem、TextArea…）挑；`within`（同样几个键）只要落在第一个符合它的节点里面的（中心点在它的框里）：比如某一张书卡上的导出箭头。等到有一个（`count` 等到正好几个，`absent` 等到一个都没有）。只在 macOS |
| `ui.press` | 按第几个（`nth`）符合的节点：默认指针移到它中心（`dx`、`dy` 可以挪开一点），停 120 ms 再点，和手一样，只在悬停时才出现的按钮（别名的 ×）也点得到；在窗口外就报错，叫先滚进来。`via: "a11y"` 改让 AccessKit 按，`increment` / `decrement` 拨滑杆 |
| `ui.hover` | 指针停到符合的节点上 |
| `ui.focus` | 把键盘交给一个还不在无障碍树里的输入框，和点进去一样：`page.title`、`page.synopsis`（稿纸上那一章的章首）、`element.name`、`element.alias`、`element.summary`、`element.field.key`、`element.field.value`（`row` 第几行，默认最后一行）、`category.name`、`settings.search`；`select_all` 连字一起选中（像三连击） |
| `settings.get` | `{keys?}`：外壳读到的设置值（默认全部）和界面语言 |
| `book.open` / `shelf.show` | `{name}`（书名或 id）：打开一本书，和在书架上点书卡一样，它存过的标签和侧栏回来；回到书架（⇧⌘W） |
| `nav.open` | `{target}`（页面键）、`{chapter}`（章名或 id）或 `{link}`（位置链接）：开成留下的标签（`preview: true` 是预览） |
| `state.get` | 外壳的状态：书、书架是否盖着、当前页、标签、侧栏、浮层、焦点（`focus.editor`：当前页的编辑器有没有拿到键盘）、当前页的选区和选区浮条（`selectionBar`）、盖在稿纸上的东西（`dialog`、`history`、`composer`、`cornerMenu`）、打开着的编辑器；M41 的对话框是盖着的那一个时，`transfer` 是它的状态（`working` / `done` / `confirm` / `failed`）、标题、正文、确认键、失败的原因键；`panel` 同 `panel.state` |
| `page.text` | 一页的段落（默认稿纸上那一页）：编辑器里的文字（每个键都已经在里面）和选区，通览全书每章前面加章名；带标题级别。`head` 是正文外面那一圈：章节页的标题、梗概、状态、第几章、⁂ 展开没有；要素页的名字、别名输入框、简介、字段行、提示；类目页的名字；以及哪个框有键盘 |
| `ui.wait` | 等到窗口有库（恢复备份换库时会有一会儿没有）、书目到了、当前标签里每一页的编辑器都打开了（打不开就报错）、书架盖着时不等书；还可以要求页上出现某段文字、`state.get`（`state`）或 `page.text`（`page`）的某些字段等于某些值；超时报 `timeout` 并说明还在等什么。`{until: "time", ms}` 只是等一会儿；`{until: "file", path}` 等到应用在后台写的一个文件出现（书的导出写完以后不弹什么，只有文件），回答它的大小 |
| `panel.state` | 系统的打开、存储面板：给下一个面板想好的答案（`armed`）、应用上一次要的面板（`last`：`kind` 是 `open` 还是 `save`、文件夹、建议的文件名、按钮上的字、答了什么）、屏幕上有没有一个真面板（`shown`）。只在 macOS |
| `panel.answer` | `{path}`：给应用下一个要的打开或存储面板想好答案，之后再按应用的按钮：面板不显示，应用的回调马上拿到这个路径，和作者选完一样。只在 macOS |
| `panel.cancel` | 给下一个面板想好「取消」 |
| `library.info` | 打开着的库在哪个文件夹，恢复前存下的副本（新的在前） |
| `ui.screenshot` | 窗口的 PNG（base64），默认先等 500 ms 让动画走完 |

### 怎么做的

- **读编辑器**：章节、构想、要素等正文页和通览全书都是 `dr-editor` 的编辑器，放在 `Workspace::editors` 里（`PageView::Doc` 或 `Book`），用 `page_view(&Target)` 拿到。换页时外壳自己把键盘交给当前页的编辑器（`focus_page`），所以 `nav.open` 之后直接 `input.type` 就进编辑器。正文外面那一圈（章首章末、要素页头）是 `pages::add_page_chrome` 挂进来的视图，调试桥从 `dr-view-page`、`dr-view-elements` 留的入口去读。
- **两个 crate**：
  - `dr-debug-protocol`（平台层，不依赖 GPUI）：线上格式、连接文件在哪、令牌握手、阻塞的客户端、不带 GPUI 的监听线程，以及 profile 的规则。`dr-cli` 和 xtask 用它；
  - `dr-debug-bridge`（界面层）：把请求交到 GPUI 的主线程，实现上面的方法。读外壳只走 dr-shell 的公开接口。
- **挂接点只有一处**：`app/drifting/src/main.rs` 在 `dr_shell::init` 之后加了 `#[cfg(feature = "debug-bridge")] dr_debug_bridge::start(cx);`，dr-shell 一行没改（F6 正在改它）。读的是 F6 接口表里给调试桥列的那些：`Workspace` 的 `nav`、`pages`、`book`、侧栏，`open`、`open_link`、`top_layer`；退出时用 `quit::before_quit` 删掉连接文件。
- **传输**：
  - macOS 用 Unix socket，放在 `$TMPDIR/drifting-<实例名的哈希>.sock`（不超过 104 字节），权限 0600；
  - Windows 用本机回环 TCP，端口由系统分配。设计里写的是命名管道，改成回环 TCP 是因为标准库就够，令牌照样挡住别的程序。Windows 那一份由 CI 的 Windows 那一条编译，还没在 Windows 上跑过；
  - 连接文件 `debug-bridge.json`（0600）放在开发版的**数据文件夹**里，写明地址、进程号和令牌。客户端按 profile 就能找到它，不受 `TMPDIR` 影响；应用退出时删掉。
- **每个请求一个主线程任务**：一个长的 `ui.wait` 不挡别的请求。打字、按键、点击走 `Window::dispatch_keystroke` 和 `dispatch_event`，而且是在任何实体的更新之外调用的，所以外壳自己的动作处理器、输入框的输入处理器，收到的和真实按键一样。测试里就看得出来：设置的搜索框里有字时，第一次 Esc 先清空，第二次才关掉设置，和外壳的规则一致。
- **系统的打开、存储面板**：GPUI 在 macOS 上用 AppKit 的 `NSOpenPanel` / `NSSavePanel`（`beginWithCompletionHandler:`），作者选好以后它的回调读面板的 `URLs` / `URL`。这一版 macOS 上面板的内容在系统服务的进程里，应用里谁也按不了它的按钮（第一次试，调 `-[NSSavePanel ok:]`，AppKit 抛「not implemented」，应用直接退出），调试桥的指针也够不着。所以在 AppKit 把答案交回来的地方答：场景先 `panel.answer {path}`（或 `panel.cancel`）想好答什么，再按应用自己的按钮；应用开始下一个面板时，调试桥换上的 `beginWithCompletionHandler:`（`NSOpenPanel` 继承它）记下应用要的是什么（打开还是存储、哪个文件夹、建议的文件名、按钮上的字），什么也不显示，马上用「好」调应用的回调，回调读到的 `URL` / `URLs` 就是想好的路径。之后全是应用自己的路，和作者点完一样。没想好答案时直接交给 AppKit 原来的实现，真面板照常出来（`panel.state` 的 `shown`）。这三个方法只在第一次 `panel.answer` 时换上，只在带调试桥的构建里有；不用系统权限：换的是应用进程里自己的类。
- **截图在应用里画**：GPUI 的 `Window::render_to_image` 把最后一帧画进一张纹理，不用屏幕录制权限，窗口被挡着也能拍。这个调用在 GPUI 的 test-support 后面，所以 `dr-debug-bridge/screenshot` 特性只在带调试桥的构建里打开。截图前默认等 500 ms（dr-ui 最长的结构动画是 420 ms）：第一次在真窗口上拍的时候，拍到了翻页叠化到一半、两章的字叠在一起。
- **被遮住的窗口**：GPUI 在 macOS 上，窗口完全被遮住时会停掉显示链接、不再画帧；而外壳是在渲染时才开始读一页的正文，于是这一页会一直停在「读取中」。`ui.wait` 和截图发现窗口不可见时，自己调一次 `Window::draw`（只画、不上屏）把这一步推过去，再把窗口标脏，等它露出来时正常重画。
- **按名字找元素：借无障碍树**（第四个里程碑）。设计里的 `ui.query` 原想靠调试名，可 GPUI 只在测试上下文里读得到 `debug_selector` 记下的位置。GPUI 自己有一棵 AccessKit 无障碍树：凡是带角色和 id 的元素都在里面，dr-ui 的按钮、单元格、标签、单选、滑杆、⁂ 和它的动作、选区浮条的按钮都有角色和名字。只是这棵树要等辅助技术（比如 VoiceOver）连上才建。调试桥在应用里面自己连：向窗口的内容视图要一次 `accessibilityChildren`，和 VoiceOver 一样，AccessKit 就向 GPUI 要树，从下一帧起每帧都建。然后：
  - 一个个节点读角色、名字（AccessKit 放在 `accessibilityTitle`）、值、`accessibilityFrame`，把屏幕坐标换回窗口的逻辑像素；
  - `ui.press` 默认用指针点中心，走的是真实的悬停、命中、点击，和手一样；`via: "a11y"` 才让 AccessKit 去按（GPUI 收到后也是在元素自己的位置上点一下）；
  - 读的都是应用自己的对象，在它的主线程上，不需要系统的辅助功能权限。只做了 macOS；Windows 要读 UI Automation，等需要时再做；
  - **还不在树里的**：dr-ui 的输入框（`TextField`、`TextArea`）、开关（`Switch`）、对话框右上角的 ×、几处列表行（历史点、导入时找到的库、审阅卡）。输入框由 `ui.focus` 按页面去拿（`dr_view_page::page_views`、`dr_view_elements::element_page` 本来就为测试和调试桥留着），其余按旁边按钮的位置挪 `dx`、`dy` 点，或点雾面关掉。这一轮给 dr-ui 的菜单行（`MenuItem` 角色、名字是行上的字）和下拉框（`ComboBox` 角色、名字是当前选项；macOS 上叫 PopUpButton）补了角色，⋯ 菜单和设置里的语言下拉才点得到。
- **还没做的**：**组字**（`input.ime`）：真实窗口的输入处理器握在平台窗口手里，GPUI 只对测试窗口开放 `replace_and_mark_text_in_range`，要 gpui-ime 给调试构建开一个口子。写进了「待协调」。

### 不进正式包

- **门禁 `debug-bridge`**（`cargo xtask check` 的第 10 道），见上面的门禁表。
- **`cargo xtask check-binary <文件>…`**：可执行文件里出现协议名 `drifting-debug-bridge/1` 就失败。协议名在握手里用到，所以带调试桥的构建里一定有它。本地验过：普通构建通过，`--features debug-bridge` 的构建被拦下。
- **CI**：macOS 那一条打包以后，对包里的 `drifting` 跑 `check-binary`；再 `cargo check -p drifting --features debug-bridge`，保证带调试桥的开发版能编。

## 阶段 2 验收：写作闭环

场景文件是 `next/crates/dr-cli/scenarios/writing-loop.json`，用 `dr-cli scenario` 加调试桥在真实窗口上跑：

```bash
cd next
cargo build -p drifting --features debug-bridge
cargo drifting workspace scenario crates/dr-cli/scenarios/writing-loop.json --app target/debug/drifting
```

- **用自己的 profile**：不给 `--profile` 时，场景新建一个 `accept-<哈希>` profile，在它的空库里写入 showcase 种子并补齐索引，跑完删掉这个 profile 的数据和日志文件夹（`--keep` 留着）。作者的库、各 worktree 的开发库都碰不到。给了 `--profile` 就用那个 profile 的库，要加 `--yes`。
- **新的步骤**：
  - `seed`：往空库里写一个预设，写完补齐索引（不然启动前读到的字数和搜索不全）；
  - `launch`：启动应用，带上指定的环境变量（`book` 会设 `DRIFTING_BOOK`，跳过书架），等到调试桥应答为止。应用的输出写进输出目录的 `app-<n>.log`；
  - `app`：调一个调试桥方法；
  - `png`：把截图存进输出目录（默认 `target/acceptance/<场景名>/`）。
- **其他变化**：
  - 应用开着的时候，`call` 走调试桥的 `command.call`（库的锁在应用手里）；应用关着时直接开库；
  - `expect` 支持 `{"$sum": […]}` 求和，`contains` 检查子串；
  - 引用可以按字段挑数组元素：`${books.[name=慢钟].id}`；
  - `pending` 跳过一步并写明原因，结尾报出跳过了几步；
  - `note` 写这一步是干什么的。
- **流程**：
  1. 写入 showcase 种子；启动，窗口先显示书架，截图；
  2. 从书架打开《慢钟》（`book.open`），主页，截图；
  3. 按章名打开第一章：编辑器打开、拿到键盘，稿纸上第一段和 F3 读出的一致，截图；
  4. 在编辑器里打「验收打字一句。」（光标在开头），回车：第一段拆成两段，截图；
  5. ⌘Z：只撤回回车，两段合回一段，打的字还在；
  6. 以作者身份经 F3 在第二章开头加一句（窗口外的写入，像帮手那样）；
  7. 换到第二章：编辑器里已经有那句话，两个标签都在，截图；
  8. 退出，确认连接文件已删；
  9. 重新启动，从书架再打开《慢钟》：布局恢复（两个标签，停在第二章，那句话还在）；
  10. 回到第一章：编辑器里打的那句还在；F3 读出的段数没变、第一段和编辑器一致；
  11. 全书字数正好多了 14 个字（8 + 6）；两句话各自搜得到，命中各自的章；
  12. 截图，退出。
- **结果**：2026-11-08 在这台 Mac 上，带调试桥的开发版，46 步全过、没有跳过的；临时 profile 跑完删干净了。截图 6 张，都在动画走完以后拍：书架、主页、第一章、打字回车以后、第二章、重开以后。另外用 `cargo xtask dev --debug-bridge` 在这个 worktree 自己的开发库（先写了 showcase 种子）上手动走了一遍：`app book 慢钟`、`app open 第三章 钟楼下`、打字、回车、⌘Z、截图、退出，结果一样。
- **测试平台上也跑一遍**：`crates/dr-debug-bridge/tests/bridge.rs` 在 GPUI 的测试平台上做同样的事（打字、回车、⌘Z、窗口外的修改、⌘[ 回上一页、设置的搜索框），每次 `cargo test` 都跑，不用开窗口。

## 阶段 2 各模块的验收场景

第四个里程碑（2026-11-08）。每个场景一个文件，都在 `next/crates/dr-cli/scenarios/`，和写作闭环一样跑（每个场景自己一个临时 profile，跑完删掉）：

```bash
cd next
cargo build -p drifting --features debug-bridge
for f in crates/dr-cli/scenarios/*.json; do
  cargo drifting workspace scenario "$f" --app target/debug/drifting --yes || break
done
```

- **界面语言钉住**：`launch` 新加 `settings`，启动前并进这个 profile 的 `settings.json`。场景都写 `{"account": {"language.ui_locale": "en"}}`（反馈对话框中英各拍一次），按钮名字不随这台机器的系统语言变。
- **新的步骤和写法**：
  - `legacy`：造一个合成的 Drifting 0.1 库（就是 dr-import-v1 测试用的那份，见下），回答它的数据文件夹 `root`；
  - 期望的 JSON 指针里可以有 `${…}`，也可以按字段挑数组元素：`/[name=沈知微]/aliases`；
  - 每次跑完把每一步存下的输出写进输出目录的 `result.json`，失败时也写，方便回头看。
  - 第五个里程碑：`launch` 的回答多了 `out`（这次跑的输出目录，绝对路径），要应用写的文件（备份、导出的书）就放这里，`${app.out}/library.drifting`；系统的打开、存储面板先 `panel.answer` 再按应用的按钮（见「调试桥 → 怎么做的」）；`ui.find` / `ui.press` 的 `within` 挑某一张卡里的按钮；`ui.wait {until: "file"}` 等后台写的文件。
- **各场景**：

| 场景 | 文件 | 走了什么 | 步数 |
| --- | --- | --- | ---: |
| M03 章首章末 | `page-chrome.json` | 点进标题框、全选、改名、回车：标题存下（F3 读回来对），光标在正文开头，接着打的字进第一段；梗概改了 ⌘↵ 存；改了标题按 Esc 放回原样；滚到章末点 ⁂，「改回草稿」（F3 状态变 draft），「新建下一章」：新章开在第 2 章、光标在标题里且标题选中，直接打字起名、回车、写第一句，F3 里章序和正文都对 | 58 |
| M09 快照历史 | `history.json` | 种子书没有历史点；在第一章打一个字（第一次提交打下一个点），隔一会儿再打几个；⋯ 菜单 →「历史快照…」：一个点；点这一行展开当时的全文；「恢复…」→「确认覆盖当前版本」：打开着的编辑器回到那个点，列表多出恢复前的点（F3：`restore` 在前、`auto` 在后，字数对），F3 读出的正文对；点雾面关掉 | 35 |
| M10 导入旧库 | `import.json` | 合成的 0.1 库放在临时文件夹，用 `DRIFTING_APP_DATA_DIR` 让应用把它当成这台设备上的 0.1 库；新库是空的。书架「导入」→ 列出找到的库 → 点它 → 导入 → 总结（一本书、40 字、imported），书架上出现《阿Q正传》→「完成」；F3 里书名、简介、字数目标、章节、正文（H1、引文的两段、TODO 那一段）、要素和别名、批注和 TODO 都对；点书卡打开、开第一章，章首和正文对 | 29 |
| M11 要素页 | `elements.json` | 打开「沈知微」：页头的名字、简介、字段和 F3 一致，别名带 ×；改名回车就存；改成「周阿婆」（别的要素已经叫这个）被拒，弹提示、名字放回；加别名「阿微」、去掉旧别名「知微」（× 悬停才出现）；改简介；「添加字段」新加一行写「籍贯：青梅镇」；F3 读回来全对；再开它的类目页，清单里是改过的名字 | 57 |
| M18 批注 | `review.json` | 键盘选中第一段开头四个字：选区浮条的状态有了；⌘⌥M 打开撰写框，写批注、⌘↵ 存；在第二段另选六个字，⌘⌥M，写完点「TODOs」再点「Save」；F3 里两条都锚在选中的字上，种类、原文、状态对；打开右栏「审阅」截图。浮条的「添加批注」那一步跳过（见待协调） | 41（1 步跳过） |
| 设置 | `settings.json` | 打开设置（`app::OpenSettings`，和 ⌘, 一样）；主题点「Dark」（设置值和窗口外观都变深）；字号滑杆加一档到 18，旁边的数字跟着变；搜「width」只剩「Page width」，Esc 清空搜索；语言下拉选「简体中文」，按钮立刻变中文；关掉重开，深色、18、简体中文都还在；Esc 关掉设置 | 46 |
| M39 反馈对话框 | `feedback.json` | 只截图、不发送：中文浅色写一条合成的反馈、展开诊断摘要的预览；英文深色再拍一张；都按「取消」关掉。开发构建没有 Hosted 服务，发送键是「用邮件发送」，没点 | 25 |
| M41 整库备份与恢复 | `restore.json` | 设置里搜「backup」，点「Export backup…」：应用要的是存储面板、建议的文件名是 `Drifting-<日期>.drifting`，桥答上输出目录里的路径，对话框说「Saved …」和几本书、多大，点「Close」关掉；备份以后在第一章开头打字、新建一本书；「Choose backup…」答那个备份：先核对，再问「Replace and restore」（文件名、几本书、书名）；按下去外壳关库、换库、重开，窗口回到书架：新建的书没了（F3 `not_found`），第一章回到备份时，换掉的库存成了恢复前副本；再打开《慢钟》第一章，编辑器里也是备份时的字；最后答一个不是备份的文件：说「not a valid Drifting backup」（原因键 `errors.invalid`），库没动 | 64 |
| M41 一本书导出再导入 | `book-transfer.json` | 书架上《慢钟》书卡悬停才出来的导出箭头（`within` 挑这一张卡）：存储面板建议 `慢钟.driftingbook`，答上路径，文件写出，书架还在；左栏「Import book」答这个文件：「Importing」走完就消失，书架上两本《慢钟》并排，原书 24 章没动；再答一个不是书的文件：「Could not import」「not a book exported from Drifting」（原因键 `notABook`），关掉以后还是两本 | 27 |
| M17 关系与关系类型 | `relations.json` | 打开「沈知微」滚到页尾的「关联」；「Edit types」→「New」写「宿敌」保存；色条换第三个颜色（F3 存 `hsl(var(--story-3))`）；「Link entity」搜「林晚秋」、选「宿敌」、「Create」，F3 里有这条；× 移除；类型列表滚到底，「宿敌」的垃圾桶，对话框确认，F3 里没有了（m17-relations.md） | 57 |

- **结果**：2026-11-08 在这台 Mac 上，带调试桥的开发版，七个场景都跑过（M18 一步按待协调跳过），写作闭环也重跑了一遍，46 步全过。截图在各自的输出目录（`target/acceptance/<场景>/`，不提交）；反馈对话框的三张真窗口截图提交在 [modules/m39/](../modules/m39/)：`window-feedback-zh-light.png`、`window-feedback-preview-zh-light.png`、`window-feedback-en-dark.png`。
- **第五个里程碑的结果**：2026-11-08，同一台 Mac，`restore.json` 64 步、`book-transfer.json` 27 步全过，没有跳过的步。截图在 `target/acceptance/restore/`、`target/acceptance/book-transfer/`（不提交）。
- **合成的 0.1 库从哪来**：dr-cli 用 `#[path]` 直接编进 `dr-import-v1/tests/common/mod.rs`（M10 测试用的构造器：用公开的 0.1 迁移和纯 SQL 造一本《阿Q正传》），不另写一份。它将来更适合放进 dr-testkit，见「待协调」。
- **跑的过程中找到的问题**都在「待协调」里，按模块列。没有一处是改了别人的代码去绕过的：要么场景照作者真实会做的那样走（比如 ⌘↵ 离开多行框），要么那一步标成跳过并写明原因。

## 待协调

### dr-store（F2）

- **换用统一的种子和试验台**：可以删掉 `src/synthetic.rs`、`src/evidence.rs`、`bin/f2-bench.rs`，以及 `bin/f2-crash.rs` 里「编辑中被杀」那一半，改用 `dr-testkit`（作为 dev-dependency）。
  - dr-testkit 本身依赖 dr-store，所以只能在 `tests/` 下的集成测试里用它；放进 `src/` 的单元测试，会编出两份 dr-store 的类型；
  - 「迁移各阶段被杀」那一半是 dr-store 专有的，可以留着，用 `crash::Harness::with_args` 改写；
  - `f2-store-bench.json` 已经由 `f8-m1-store-bench.json` 接替；
  - `f2-crash-recovery.json` 在下一个里程碑换成新格式。
- ~~**只读打开**~~：已有（`Library::open_read_only`），`dr-cli inspect` 已经改用它（2026-11-08）。
- **冻结基线**：`0000_baseline.sql` 随第一个 0.2 版本发布时，把它的哈希填进 `xtask/src/gates/migrations.rs`。

### dr-model / dr-doc（F1）

- ~~**契约类证据改成断言**~~：已做（F1 第三轮）。四份 JSON 删了，改成测试里断言；模糊测试的两个崩溃输入成了回归测试。
- ~~**测量换进基准**~~：已做（F1 第三轮）。`bench` 里加了 `doc` 套件（`src/bench/doc.rs`），`tests/measure.rs` 和 `f1-measure.json` 删了，里程碑测量是 `f1-m3-doc-bench.json`。

### dr-shell 与应用入口（F6）

- **调试桥挂在哪**：只在 `app/drifting/src/main.rs` 加了一行（`dr_shell::init` 之后，`#[cfg(feature = "debug-bridge")]`），`app/drifting/Cargo.toml` 加了 `debug-bridge` 特性。dr-shell 没改。
- **调试桥读外壳用到的接口**：`Workspace` 的 `nav`、`editors`（`PageEditor` 的 `doc`、`view`、`loading`、`failed`）、`page_view`、`book`、`book_id`、`library`、`left`、`right`、`super_view`、`dock_locked`、`shelf_open`、`dialog`、`history`、`composer`、`corner_menu`、`settings`（`SettingsPanel::focus`），以及 `open`、`open_link`、`open_book`、`show_shelf`、`top_layer`、`focus_handle`；`PageView::{Doc, Book, prose}`，编辑器那边是 `ChapterEditor` / `BookEditor` 的 `assist()`（`Assist::bar`）、`ProseEditor::{book, selection}`、`ProseDoc::{visible_lines, line}`；`Settings::{read, locale}`、`SettingsFile::get`、`settings::registry::REGISTRY`；`title_of`、`Layer`、`Target::{key, from_key}`、`Open`、`Page`；`quit::before_quit`、`quit::request`、`open_workspace`、`Services`、`ShellInfo`。页面外圈从 `dr_view_page::page_views`（`PageHead::{title, synopsis}`、`PageEnd::{page, is_open}`）和 `dr_view_elements::{element_page, category_page}`（`ElementHead::{fields, alert}`、`Fields::rows`、`CategoryHead::name_field`）读。改这些时请顺手改 `crates/dr-debug-bridge/src/methods.rs`（它在全工作区构建里，编不过 CI 会报）。
- **编辑器接进稿纸以后**：调试桥要的两样 F6 第三个里程碑都已经有了：打开一章时 `focus_page` 把键盘交给编辑器；`editor_of(&Target)` 拿到当前页的编辑器。所以这一轮 dr-shell 还是一行没改。
- **一个小坑**（不用改，记一笔）：`ui.wait` 等的是「编辑器已经打开」，键盘交给编辑器要再晚一帧（下一次渲染里的 `focus_page`）。场景里打字之前多等一个 `/focus/editor: true`。
- **按名字找元素已经不靠调试名**：改用无障碍树（见「调试桥 → 怎么做的」）。所以元素要被找到，给它角色和名字就行（`.role(…)`、`.aria_label(…)`，顺带也是给读屏用的）。
- **真窗口上找到的问题**（第四个里程碑跑场景时）：
  1. **章首标题框里按 ⌘Z，撤的是正文**。复现：在一章里打一句话，点进标题框打一个字，⌘Z：标题里那个字还在，正文里刚打的那句没了。⌘A 也不行：标题没被全选（按下去走的也是外壳的 `edit::SelectAll`，编辑器那边接的是正文的全选）。外壳给 `edit::Undo`、`edit::SelectAll`（以及剪切、复制、粘贴）绑了不带上下文的快捷键，盖过了 dr-ui 输入框自己在 `DrTextArea` 里的 ⌘A；章首又画在编辑器里面，动作一路冒泡到编辑器的处理器。要素页头的名字、简介、字段，审阅的撰写框，凡是挂在编辑器里的输入框应该都一样。请和 F5 一起看：输入框自己接住 `edit::*`，或者这几个快捷键加上不在输入框里的上下文。场景里改用 `ui.focus … select_all` 绕开 ⌘A，⌘Z 没有绕，场景不按它。
  2. **快照历史按 Esc 关不掉**：`dismiss` 不管 `history`；关掉以后键盘回到工作区（`ws.focus`），没有像导出对话框那样 `refocus` 回正文，作者得再点一下正文才能接着写。（`workspace/corner.rs` 的 `open_history`、`workspace/mod.rs` 的 `dismiss`。）
  3. **保活的隐藏页还在无障碍树里**：别的标签里保活的编辑器（连同它的 ⁂）虽然看不见，节点都还在，读屏会读到看不见的东西；`ui.find` 也会找到它们，场景里只开一个标签或按名字区分。
- **场景里写死的位置**：导入时找到的库那一行、历史点那一行不在无障碍树里，场景按旁边按钮挪 `dx`、`dy` 去点；那几行给了角色和名字以后改掉。

### gpui-prose、gpui-ime 与编辑器（F4、F5）

- **基准换地方**（已做完，F4e）：`prose-bench` 搬进了 `dr-editor/examples/prose-bench/`，语料换成 `dr_testkit::seed` 的重型种子，证据写成 F8 格式。命令是 `cargo run --release -p dr-editor --example prose-bench -- <子命令> --write`；`gpui-prose` 只留不依赖 `dr-*` 的 `examples/editor.rs`。
- **重测**：搬过去以后，按新格式重测 `f4-*.json`。语料指纹会变一次。
- **收编编辑器的基准语料**（监管会话这一轮的第 3 条）：F4 把基准搬进 `dr-editor` 交回以后，F8 把它收成 `bench` 的一个套件（`editor`），语料用统一种子，再按新格式重测。等 F4。
- **组字**：调试桥要模拟输入法（`setMarkedText` 再 `insertText` 那一路），需要 gpui-ime 在调试构建里开一个入口。真实窗口的输入处理器握在 GPUI 的平台窗口手里，外面拿不到。
- **选区浮条在真窗口上不出来**（F4e，`dr-editor` 的 `assist`）：键盘选中、鼠标拖选、双击选词都试过，`Assist::bar()` 都有值（`state.get` 的 `selectionBar` 是 true），可是浮条没画出来，截图里没有，它的按钮也不在无障碍树里。M18 场景里点「添加批注」那一步因此跳过；⌘⌥M 那条路是好的。
- **dr-ui 这一轮改的两处**（第四个里程碑，F8 改的，请过目）：`components/menu.rs` 的 `MenuItem` 加了 `.role(Role::MenuItem).aria_label(行上的字)`；`components/select.rs` 的下拉框加了 `.role(Role::ComboBox)`，名字是当前选项。都只是给无障碍树补角色，样子和行为没变。还没有角色的：输入框、`Switch`（设置里的开关点不到）、`Dialog` 右上角的 ×（`PanelIconButton` 没给 `label`）。

### dr-workspace（F3）

- ~~**搜索在全书规模上慢**~~：2026-11-08 重测，heavy 种子上 `book.search` 一个字 0.5 ms、三个字 4.4 ms（原来 33–47 ms），已经回到 F3 原来的量级（`f8-m2-workspace-bench.json`）。
- **缺两个命令**：时间钉（`time_pin.*`）和写作日。没有它们，走命令写的种子里就没有这两样，对拍只好不比。
- **删掉旧测量**：`tests/measure.rs` 和 `f3-workspace-measure.json` 已经由 `bench` 的 `workspace` 套件接替，可以删掉（`measure_evidence_has_its_shape` 一起删）。
- **快照**：能力清单的快照先排好键再比（合并时已经这样改了），以后新的快照照这个做。
- **查询能在只读的库上跑**：F2 的只读打开不给可编辑的文档句柄（`open_doc` 报 `ReadOnly`），而 F3 的查询经 `BookSlot` / `ProseSlot` 打开文档，所以 dr-cli 的查询还得先复制一份库再开工作区。工作区要是能在只读的库上开，查询改读副本（`load_copy`），命令行的查询就不用复制了（库越大，这一份复制越慢）。

### dr-index / dr-text

- **基准**：`examples/` 里的基准（读旧种子 JSON 的那个）改成 `bench` 的一个套件，用统一种子；改完以后门禁里「examples 下带 bench 的算基准」这条可以去掉。

### dr-import-v1 与导入界面（M10）

- **证据**：`m10-import.json` 在下一个里程碑换成新格式。
- **合成旧库的构造器**：dr-cli 的 `legacy` 步骤用 `#[path]` 编进了 `tests/common/mod.rs`。改它的函数签名（`build`、`Old`、几个 ID 常量）时 dr-cli 会编不过；更好的做法是搬进 dr-testkit（`dr_testkit::legacy`），dr-import-v1、dr-view-import 和 dr-cli 都从那里用。
- **找到的库那一行**不在无障碍树里（`dr-view-import` 的列表行没有角色和名字），场景是按「选择文件夹」的位置往上挪了一行点的。
- **测试库**：旧库测试库的冻结（阶段 7 第 1 条）完成以后，测试里改为钉住那几份库的 SHA-256。

### 快照历史（M09）、审阅（M18）、要素页（M11）

- **M09**：英文界面里恢复成功那句「Restored to the selected version. …」比对话框宽，伸出了右边；历史点那一行和对话框的 × 不在无障碍树里。Esc 和关后焦点见上面 F6 第 2 条。
- **M18**：在撰写框上点「批注 | TODO」，鼠标按下穿过撰写框落到了下面的正文：正文拿走键盘、光标挪到点的位置（场景里点完 `state.get` 看到 `focus.editor` 是 true、选区收成一个点）。这时候再打字就打进正文了。场景改成先写再选种类、再点「保存」。另外英文界面里右栏审阅的「Current」开关被裁掉一半；审阅卡不在无障碍树里。
- **M11**：要素页没发现问题。别名的 × 只在悬停时出现（`invisible` + `group_hover`），所以调试桥点之前先让指针停一下。

### 搬运与恢复（M41）

第五个里程碑在真窗口上跑 M41 时找到两处，都是一行的事，**在这条分支上顺手改了**，请 M41 的维护者过目：

1. **「Close」和 × 关不掉搬运的对话框**（恢复、备份、导入书失败时都是这一个对话框；导入文件的对话框同理）。`TransferDialog::close` 在点击的处理器里直接调 `dr_shell::dialogs::hide`，这时窗口正忙着处理这次点击，外壳够不着它的工作区（`handle.update` 失败，错误被吞掉），对话框就一直在。M15 的清空确认早就这样写了（`cx.defer` 一下，「the window is busy with the click or key」），M10、M11 是在观察者里关。改成 `cx.defer(…hide…)`（`dr-view-transfer/src/dialog.rs`、`documents.rs`）。原来的测试是从窗口外面调 `close` 的，所以没发现；`tests/backup.rs` 改成从窗口里面关（和点击一样），不改代码时它失败。
2. **点书卡上的导出箭头，书也跟着打开了**：编辑、移进最近删除两个按钮都 `stop_propagation`，导出箭头没有，点击一路冒到书卡上。作者点完，保存面板后面书已经开了。补上（`dr-view-shelf/src/view.rs`）。

另外给 F6 的一个建议（没改）：`dialogs::hide` 从点击、按键里调就够不着窗口，三个模块各自绕了一遍（defer、观察者）。`hide` 自己 defer 一下，别的模块就不用知道这件事。

### dr-platform（F7）

- **路径函数**：可以给 `AppDirs` 加一个按指定 profile 算路径的函数。现在 xtask 和 `cargo drifting app` 都用 `dr_debug_protocol::place` 按同样的算法算一遍，靠测试保证和 `AppDirs` 一致。
- **发布流程**：`script/release-next.draft.yml` 正式启用时，在打包之后加 `cargo xtask check-binary <可执行文件>`，Windows 安装包里那一份也要查。门禁已经保证这些脚本里不出现 `debug-bridge`。
- **Windows**：调试桥在 Windows 上走本机回环 TCP，由 CI 编译，还没在 Windows 上跑过。

### 监管会话

- `progress.md` 里 F8 那一行；
- `AGENTS.md` 的「New workspace」检查清单已经加上 `cargo xtask check`；第三个里程碑在同一节加了调试桥的用法；
- 各探针的旧证据和探针本身删掉的时候，把 `retired.rs` 里 `spikes/import-v1` 那一条例外一起删掉。

## 下一个里程碑建议

1. **场景进 CI**：试着把 `scenarios/` 放进 CI 的 macOS 那一条（runner 有图形会话），先只在 `next/` 改动时跑；再补 M04 大纲、M06 搜索、M07 字数、M41 导出几条。
2. **无障碍树补齐**：和 F5 一起给输入框、开关、对话框的 ×、列表行补角色和名字，场景里写死的偏移改成按名字点；Windows 那边读 UI Automation；和 F4、F5 商量组字的入口。
3. **编辑器基准**：F4 交回以后，收成 `bench` 的 `editor` 套件。
4. **补齐种子**：
   - 素材图片和 PDF（合成的小文件，或者从样书插图生成）；
   - 帮手对话：heavy 的 24 段、1800 轮；
   - 样书和 showcase 也走一遍命令，对拍；
   - F3 补上时间钉和写作日的命令以后，对拍把它们也比上。
5. **迁移旧证据**：F1、F2、F4、M10、dr-index 的旧证据和基准迁进 `bench` 和新证据格式，迁完以后把「旧格式」改成失败。
6. ~~**`inspect` 换只读打开**~~：`inspect` 已经改了（2026-11-08）；查询要等 F3 能在只读的库上开工作区（见「待协调 → dr-workspace」）。
7. **旧库测试库**：冻结旧库测试库（阶段 7 第 1 条），钉住 SHA-256。

## 代码位置

```text
next/crates/dr-testkit/
  src/lib.rs              转出 dr-corpus 的 rng、text、digest
  src/seed/               预设、长度分配、计划、直写、走命令写、对拍用的 digest、形状、写进库
  src/samples.rs          样书（转调 dr-samples）和 showcase
  src/evidence.rs         测量证据、过期检查
  src/crash.rs            崩溃试验台
  src/bench.rs            基准约定，store 和 workspace 两个套件
  src/bin/bench.rs        bench 程序
  fixtures/               《慢钟》、截图书架的 JSON 和来源说明
  tests/                  种子、两种写法对拍、样书、崩溃（编辑中被杀 crash_store、迁移中被杀 crash_migrate）、
                          后台重建不挡打字（store_rebuild，dr-store 的）、基准
next/crates/dr-samples/   两本内置样书（books/）、摆书和写书（layout.rs、build.rs、store.rs）、新库只写一次（built_in.rs）
next/crates/dr-corpus/    不碰库的那部分，dr-samples、dr-testkit 和 dr-store 的测试共用
  src/rng.rs              唯一的随机数（SplitMix64；dr-samples、dr-testkit 都转出它）
  src/para.rs             样书和种子摆书用的段落
  src/text.rs             合成语料、字数口径
  src/digest.rs           唯一的指纹函数
next/xtask/
  src/main.rs             cargo xtask check | evidence --check | check-binary | dev
  src/gates/              11 道门禁（调试桥那道在 debug_bridge.rs，热重载和依赖环那道在 hot_reload.rs）
  src/dev.rs              开发实例隔离、--debug-bridge、--hot
next/crates/dr-cli/       开发命令行：describe、call、scenario（src/scenario.rs、src/live.rs）、inspect、app（src/app.rs）
  scenarios/              验收场景：writing-loop.json（阶段 2 写作闭环）
next/crates/dr-debug-protocol/   调试桥的线上格式、连接文件、客户端、监听线程、profile 规则（不依赖 GPUI）
next/crates/dr-debug-bridge/     调试桥的方法，跑在 GPUI 主线程上；tests/bridge.rs 在测试平台和真 socket 上验
next/app/drifting/        debug-bridge 特性和唯一的挂接点（src/main.rs）
next/.cargo/config.toml   cargo xtask、cargo drifting 两个别名
```
