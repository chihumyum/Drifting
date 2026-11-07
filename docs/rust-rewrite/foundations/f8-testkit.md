# F8 dr-testkit 与新工作区门禁：第一个里程碑

2026-11-07。计划见 [foundation.md 的 F8](../foundation.md#f8-dr-cli-与-dr-testkit)，要简化的东西见 [simplifications.md](../simplifications.md) 第二、五、六节。

## 一句话

旧版的测试设施是「同一件事好几套」：种子约 10 套、崩溃试验台 6 套、基准十几套、几十个检查脚本各写一份指纹。新工作区里每样只留一套：

- **测试数据只有一个来源**：`dr_testkit::seed`。
- **证据只有一种做法**：契约类当场断言，测量类在里程碑提交。
- **崩溃试验台和基准各一套**。
- **新工作区的规矩一条命令查完**：`cargo xtask check`，CI 每次都跑。

## 这一轮做了什么

| 部分 | 在哪 | 状态 |
| --- | --- | --- |
| 统一种子：tiny / lite / heavy / showcase | `next/crates/dr-testkit/src/seed/` | 做完，指纹钉在测试里 |
| 样书：《傲慢与偏见》《阿Q正传》，以及 showcase 的《慢钟》和书架 | `src/samples.rs`、`fixtures/` | 做完，只有文字，插图没拷 |
| 测量证据和过期检查 | `src/evidence.rs`、`cargo xtask evidence --check` | 做完；旧证据 21 份待各自迁移 |
| 崩溃试验台 | `src/crash.rs`，F2 示范在 `tests/crash_store.rs` | 做完 |
| 基准约定和 `bench` 程序 | `src/bench.rs`、`src/bin/bench.rs` | 做完，迁了 dr-store 一个示范 |
| 门禁 | `next/xtask/` | 9 道，接进了 `next.yml` |
| 开发实例隔离 | `cargo xtask dev` | 做完 |
| 开发命令行骨架 | `next/crates/dr-cli/` | 参数、离线改库规则、`inspect` 做完；`describe` / `call` 等 F3 |

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

### 预设

| 预设 | 用在哪 | 规模 |
| --- | --- | --- |
| tiny | 单元测试 | 4 章 3 千字、6 个要素、3 个构想，每种东西都有几个 |
| lite | 日常开发 | 20 章 15 万字、30 个要素、10 个构想、12 篇素材笔记、12 条待办、8 条批注 |
| heavy | 性能、全书、导入、内存 | 100 章 150 万字（每章 2 千到 2 万）、300 个要素 50 万字、200 个构想 100 万字（最长 5 万）、60 篇素材笔记 50 万字、120 条待办、80 条批注、400 条关系、一年的写作日 |
| showcase | 截图 | 《慢钟》、《阿Q正传》，再加书架上 6 本中文书（文字按字数合成），各带写作日 |

另外两本样书单独取：`samples::pride_and_prejudice()`、`samples::a_q()`。

lite 和 heavy 的每一类正文，**篇数、总字数、最短、最长**都和旧版 `lite`、`stress` 种子完全一样（`docs/dev-cli/acceptance/seed-presets.json`）。这份旧文件还在的时候，测试会逐项对照；它随旧客户端删掉以后，数字留在 `preset.rs` 里。

### 怎么生成

- **文字**：沿用旧版种子自己写的句库（`sample-project/prose.ts` 的地点、人物、物件、细节、标题和十句原创句子），由随机数重新组合。不含任何真实书稿。
- **随机数**：只有一种，SplitMix64（`rng.rs`）。每篇正文有自己独立的随机流，所以加一类新东西，不会让已有的正文变样。
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

`fixtures/` 里是四个 JSON：《傲慢与偏见》、《阿Q正传》、《慢钟》和截图书架。它们是 0.1 客户端样书定义逐字段导出的，出处和授权见 `fixtures/README.md` 和仓库根目录的 `ASSET_PROVENANCE.md`。

`samples.rs` 照 0.1 的样书写法把它们摆成书：

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

`f8-m1-store-bench.json` 的结果（M3 Pro；测的时候机器上别的会话在编译，一分钟负载 14.6，所以长尾偏高）：

| 项 | p50 | p95 | 预算 |
| --- | ---: | ---: | ---: |
| 按键写入（NORMAL） | 0.061 ms | 0.441 ms | 探针档 2 ms，发布档 1 ms |
| 按键写入（FULL） | 0.075 ms | 0.181 ms | — |
| 冷读全书 100 章（150 万字） | 15.9 ms | 34.2 ms | 发布档 300 ms |
| 读出全书文字 | 32.5 ms | 63.1 ms | — |
| 开 100 个持有者 | 28.3 ms | 109.9 ms | — |

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
| evidence | 见上面「证据」 | 第五节 |
| audit | 对 `next/Cargo.lock` 跑 `cargo audit`：有漏洞就失败；「不再维护」「不健全」只列出来，现在有 12 条：4 个来自 Loro（`im`、`sized-chunks`、`bitmaps`、`atomic-polyfill`，其中 `im` 和 `sized-chunks` 标了「不健全」），其余来自 GPUI。取不到漏洞数据库也算失败 | 5 |

在这台机器上全部跑完约 7 秒。

### 几处取舍

- **不装新工具。** 许可证白名单原计划用 cargo-deny，改成 `cargo metadata` 加约 60 行 SPDX 表达式解析，不多装一个工具。漏洞审计用机器上已有的 `cargo audit`，CI 里装同一个版本（0.22.2）。
- **被 `.gitignore` 忽略的文件不查。** 它们本来就提交不进来，这和旧版的公开边界检查一致。未跟踪、没被忽略的文件要查。
- **gpui-prose 的 dev-dependencies 也不许用 `dr-*`。** 示例和测试会链接进被依赖的代码；一个准备单独开源的宽松许可证 crate，在仓库外也必须能编译和测试。所以 F4 的基准程序以后要搬到一个 AGPL 的 crate 里（见「待协调」）。
- **应用服务也不许编进 GPUI。** 命令行、MCP 和测试都要在没有窗口的情况下调同一套命令，F3 的 `dr-workspace` 现在也确实不依赖 GPUI。
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
| 9 | 调试桥不进正式包 | F8 的下一个里程碑，和调试桥一起做 |
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
cargo xtask dev --print-config        # 打印 profile、文件夹、钥匙串服务，不启动
cargo xtask dev --release -- --mcp …  # 参数原样交给程序
```

- **主 checkout**：不设 profile，就是作者日常用的开发版；加 `--instance` 才隔离。
- **profile 名**：只用小写字母、数字和连字符，最长 32 个字符，这是 F7 的规则。名字太长就截断，再加 6 位哈希，两个长名字不会撞成同一个。
- **和 dr-platform 对齐**：文件夹的算法和 dr-platform 的 `AppDirs` 一致，测试里拿两者对照。
- **端口**：旧版每个实例还分端口；新版的调试桥还没做，以后它的 socket 也按 profile 分开。

## 开发命令行：`dr-cli`

`cargo drifting …` 是 `cargo run -p dr-cli --` 的别名。

```bash
cargo drifting workspace describe [--json]
cargo drifting workspace call <命令> --library <目录> [--input JSON] [--yes]
cargo drifting workspace inspect --library <目录> [--doc <文档 ID>] [--json]
cargo drifting workspace scenario <名字> --library <目录> [--yes]
```

- **离线改库的规则**，照旧版：
  1. **应用必须关着**：库的锁（`library.lock`）被别的进程占着，就拒绝；
  2. **先备份**：用 `VACUUM INTO` 把 `library.sqlite` 一致地复制到 `<库>/backups/dr-cli-<毫秒>.sqlite`，备份通过完整性检查才往下走；
  3. **加 `--yes` 才执行**：不加只打印会做什么、备份会放在哪，什么都不改。

  `call` 和 `scenario` 都走这一套。
- **`inspect`**：
  - 先把库一致地复制到临时目录，再用 dr-store 打开这份副本，原库从不以写方式打开，应用开着也能看；
  - 默认列出文档数、每本书的章节、构想、要素、关系、批注、素材、写作日和正文字数；
  - `--doc` 打印一个文档的完整内容。

  dr-store 现在没有只读打开，所以用副本代替，见「待协调」。
- **`scenario`**：现在内置 `seed:tiny`、`seed:lite`、`seed:heavy`、`seed:showcase`，把统一种子写进库。
- **`describe` 和 `call`**：等 F3 的命令注册表合进来。现在它们照样检查参数和规则，然后说明「要等 F3」，以退出码 2 结束，什么都不改。
- **打开库时的版本号**：用和应用一样的版本号（`0.2.0-dev`）打开库，免得命令行打开一次，库就多一份安全快照。

## 待协调

### dr-store（F2）

- **换用统一的种子和试验台**：可以删掉 `src/synthetic.rs`、`src/evidence.rs`、`bin/f2-bench.rs`，以及 `bin/f2-crash.rs` 里「编辑中被杀」那一半，改用 `dr-testkit`（作为 dev-dependency）。
  - dr-testkit 本身依赖 dr-store，所以只能在 `tests/` 下的集成测试里用它；放进 `src/` 的单元测试，会编出两份 dr-store 的类型；
  - 「迁移各阶段被杀」那一半是 dr-store 专有的，可以留着，用 `crash::Harness::with_args` 改写；
  - `f2-store-bench.json` 已经由 `f8-m1-store-bench.json` 接替；
  - `f2-crash-recovery.json` 在下一个里程碑换成新格式。
- **只读打开**：给库加一个只读打开（不迁移、不拿锁、不写安全快照），`dr-cli inspect` 就不用先复制。
- **冻结基线**：`0000_baseline.sql` 随第一个 0.2 版本发布时，把它的哈希填进 `xtask/src/gates/migrations.rs`。

### dr-model / dr-doc（F1）

- **契约类证据改成断言**：`f1-invariants`、`f1-book-convergence`、`f1-prose-convergence`、`f1-fuzz` 是契约类，改成测试里断言，删掉 JSON。
- **测量换进基准**：`tests/measure.rs` 和 `f1-measure.json` 改成 `bench` 里的一个 `doc` 套件。

### gpui-prose 与编辑器（F4）

- **基准换地方**：`prose-bench` 的语料（xorshift 那一套）要换成 `dr_testkit::seed`。但 gpui-prose 不能依赖 `dr-*`，所以基准程序要搬到 AGPL 的 `dr-editor`（或者一个单独的基准 crate）里。
- **重测**：搬过去以后，按新格式重测 `f4-*.json`。语料指纹会变一次。

### dr-workspace（F3）

- **已有的接入**：`dr-workspace` 已经归在「应用服务」，它的 insta 快照就是契约类证据的做法，不用改。
- **测量换进基准**：`f3-workspace-measure.json` 改成 `bench` 的一个套件。
- **接命令行**：合进来以后，`dr-cli` 的 `describe` 和 `call` 直接接注册表，`scenario` 加脚本化的调用序列。
- **种子走命令**：种子以后可以改成通过命令写入，这样命令层的不变量也会检查种子数据。

### dr-import-v1（M10）

- **证据**：`m10-import.json` 在下一个里程碑换成新格式。
- **测试库**：旧库测试库的冻结（阶段 7 第 1 条）完成以后，测试里改为钉住那几份库的 SHA-256。

### dr-platform（F7）

- **路径函数**：可以给 `AppDirs` 加一个按指定 profile 算路径的函数。这样 `cargo xtask dev --print-config` 就不用自己按同样的算法算一遍（现在靠测试保证两边一致）。

### 监管会话

- `progress.md` 里 F8 那一行；
- `AGENTS.md` 的「New workspace」检查清单已经加上 `cargo xtask check`；
- 各探针的旧证据和探针本身删掉的时候，把 `retired.rs` 里 `spikes/import-v1` 那一条例外一起删掉。

## 下一个里程碑建议

1. **接 F3**：`dr-cli describe | call | scenario` 接上命令注册表，命令清单做成快照测试。
2. **调试桥**：一个本机 socket，走 JSON，按 profile 分开；同时加「调试桥不进正式包」的检查（第六节第 9 条）。
3. **补齐种子**：
   - 素材图片和 PDF（合成的小文件，或者从样书插图生成）；
   - 帮手对话：heavy 的 24 段、1800 轮；
   - 种子改成通过命令写入。
4. **迁移旧证据**：F1、F2、F4、M10 的旧证据和基准迁进 `bench` 和新证据格式，迁完以后把「旧格式」改成失败。
5. **旧库测试库**：冻结旧库测试库（阶段 7 第 1 条），钉住 SHA-256。

## 代码位置

```text
next/crates/dr-testkit/
  src/rng.rs              唯一的随机数（SplitMix64）
  src/text.rs             合成语料、字数口径
  src/digest.rs           唯一的指纹函数
  src/seed/               预设、长度分配、书的构建、形状、写进库
  src/samples.rs          样书和 showcase
  src/evidence.rs         测量证据、过期检查
  src/crash.rs            崩溃试验台
  src/bench.rs            基准约定和 store 套件
  src/bin/bench.rs        bench 程序
  fixtures/               样书 JSON 和来源说明
  tests/                  种子、样书、崩溃（F2 示范）、基准
next/xtask/
  src/main.rs             cargo xtask check | evidence --check | dev
  src/gates/              9 道门禁
  src/dev.rs              开发实例隔离
next/crates/dr-cli/       开发命令行骨架
next/.cargo/config.toml   cargo xtask、cargo drifting 两个别名
```
