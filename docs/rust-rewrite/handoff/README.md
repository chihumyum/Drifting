# 在 next/ 里开一路工作、交回、整合

这个目录原来放的是 2026-11-08 到 11-12 交给各路会话的任务书、队列和整合流水。那些都是已经结束的过程记录，2026-11-12 删掉了，最后一版在 `git show f272963e8:docs/rust-rewrite/handoff/`。里面还开着的事项搬进了 [progress.md](../progress.md)。内核 v4 八条轨道的任务书（`v4-tracks.md`）在轨道合完、收尾做完后删了，仍然有效的规矩并进了本页。

这一页只留下现在仍然有效、而且别处没写的规矩。别处已经写了的不重复：

- 钉住的版本、检查命令、种子、`cargo xtask dev`、调试桥：仓库根 `AGENTS.md` 的「New workspace (`next/`)」。
- 一路工作怎么开、怎么交：[README.md 的「怎么推进」](../README.md#怎么推进)。
- 界面公共接口只加不改、写入不能拿读到的整份去替换：[k4-ui.md 的「仍然有效的规矩」](../k4-ui.md#仍然有效的规矩)。

## 内核 v4：作者定下的（2026-11-13，不要再议）

设计在 [kernel-v4.md](../kernel-v4.md)。

1. 只有一种条目。模块任意拼（正文可以多篇、字段、键值表、补丁、情节规划、关联、「下面的条目」）。
2. 开关在界面上叫「**层级**」，旁边一行小字「打开后下面能放条目」。开关是条目自己的属性，模板只给新建时的默认值。
3. 开关打开后才显示只对「下面」有意义的设置。没有「允许放哪些模板」；要选的只有「在这一层新建时默认建什么」。
4. 下面还有条目时关开关：界面提示，作者继续就把下面的条目移到最外层（一条原子命令，一步可以撤销）。归属、泳道身份、设置都不删，再打开就回来。
5. 一个条目可以有一篇或多篇正文，**每篇各自有一个开关**，决定这一篇是否计入字数、是否参与导出。
6. 导出和整书视图里，条目自己的正文排在它下面的条目之前。导出时，自己没有成书正文的中间层（比如「第一卷」）的标题暂不出现。
7. 整书视图从任何一个开着开关的条目出发，摊平看它和它下面的全部内容；**挂名（归属）进来的也算**，按归属自己的顺序排在住在下面的条目之后。成书、导出、全书字数只看住处。
8. 「下面的条目」是一个模块，显示方式维持现有四种（列表、网格、看板、岛屿）。
9. 新书的模板列表里有「幕」模板。
10. 模板更新与项目无关：项目建好以后，内置模板怎么变都不影响它，不做升级通道。
11. H1/H2/H3 是正文内部的结构，不是条目层面的结构。只叫 H1/H2/H3，不为「把标题当条目」设计任何东西。
12. Markdown 文件夹（`dr-mirror`、M40）以后按新结构重新设计。
13. 格式干净改：不并读、不写迁移、不留兼容垫片。新模型让哪些代码和测试失去意义，就删掉。
14. 先把结构弄对、功能可用，长相以后再打磨：不自己设计新的视觉样式，沿用现有组件；不加作者没要的说明文字、提示句、选项描述。

## 做的时候

- **碰到必须作者定的新问题**：写进交回报告的「等作者的事」，按最保守的做法先做，不停工等。作者白天集中答这些问题，长时间的执行放在夜里。
- **范围**：只改分给自己的 crate。确实要动别处时做最小改动，在交回报告里逐处列出原因；觉得公共接口不够用，写进报告，由监管会话协调。
- **测试**：模型变了，断言旧规则的测试换成断言新规则的测试；每删一条、每改一条期望，都在报告里写改前改后和原因。不许为了通过而放松断言、加重试或 `#[ignore]`。
- **`dr-i18n` 的文案文件是并行各路唯一的共同热点**：每路只加删自己的键，冲突由监管会话合并时处理（见下面「整合」）。

- **每个 worktree 用自己的 `next/target`，不借别的树的。** `build.rs` 生成的文件和编译期的 `CARGO_MANIFEST_DIR` 会带着另一棵树的内容或路径；跨树共用曾经让一路读到旧的语言键，还让 xtask 指向已经删掉的 worktree。真遇到这种缓存对不上，只清这个工作区自己的包的构建产物再重建，第三方依赖留着，不手改生成的文件。
- **字体是构建产物**（`next/.cache/fonts`）。新 worktree 第一次要从别的 worktree 拷过来，或者构建一次，否则画字的测试会失败。
- **机器上同时有几路在编译时限制并发**：每路 `CARGO_BUILD_JOBS=3` 到 `4`，整合者 `6`（机器 12 核）。测试单线程：`RUST_TEST_THREADS=1`。
- **按文档工作的代码不写死文档种类**（同步、导出、Markdown 文件夹）：文档 id 当不透明的字符串处理。
- **不读作者的日常库和真实书稿。** 测试数据只用 `dr_testkit::seed`、`dr_testkit::samples`，合成的图片和 PDF 用 `dr_testkit::media`。
- **日志和验收证据放仓库外**（现在都在 `~/Drifting-autopilot-logs/`），不放进任何工作区，免得被公开检查扫到。
- **每个模块一份结论文档** `modules/<编号>-<名字>.md`，照已有的写：做了什么（大白话）、定下的事、接口、外壳里的挂接点、测试、待协调、代码位置。
- **新模块接进 App**：`next/app/drifting/src/main.rs` 里每个模块一行 `init`。
- **界面文字**：旧版有的键写进 `next/crates/dr-i18n/keys.txt`，再跑 `python3 crates/dr-i18n/script/sync-locales.py`；旧版没有的写进 `next/crates/dr-i18n/own/<语言>.json`，九种语言都写。
- **删测试要按内容核对有没有丢覆盖**，不能只看文件名或函数名里带旧种类的词。删了哪些在交回里列出来。
- **改导入的代码要带永久测试**：源库的字节和修改时间不变，导入结果逐项核对。
- **凡是要用到书序或幕的地方**（v3 里已经没有了），停下来写进「等作者的事」，不自己设计替代品。
- **量性能**只在 release 构建、机器空闲（一分钟负载小于 4）时量才算数；从最慢的一项开始，修一项量一次；不为了快去改数据格式、已有行为或 Loro 的版本；要改交互才能快的，写进「等作者的事」。
- **`DRIFTING_PROFILE` 的名字只能是小写字母、数字和 `-`，1 到 32 个字符；不合规矩的名字会被整个忽略**（`dr-platform/src/identity.rs`）。忽略以后 App 回到默认的开发实例，命令行等不到调试桥，验收脚本可能落到别的开发库上。`cargo xtask dev` 自己推出来的名字会截断加哈希，手写的名字要自己数。

## 交回

1. 交回前 `git merge main`，在合并后的最终树上跑，全部通过才算做完；哪条没跑、哪条是红的，如实写：

   ```bash
   cd next
   cargo fmt --all --check
   cargo clippy --workspace --all-targets --locked -- -D warnings
   RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1 cargo test --workspace --locked --no-fail-fast
   cargo xtask check
   python3 crates/dr-i18n/script/sync-locales.py --check
   cd .. && pnpm public:check && pnpm ci:contract:check
   ```

2. 真窗口冒烟自己改到的功能和场景（下一节）。
3. 更新自己涉及的模块结论文档；`progress.md` 由监管会话改，发现它过时就写进报告。
4. 建交回指针 `git branch -f handback/<名字> HEAD`，报告用中文，先说大白话（做了什么、作者会看到什么不同），再列改了哪些文件、出了范围的改动、删了和改了期望的测试、检查结果、真窗口结果、等作者的事、分支和提交号。

## 真窗口验收

- 验收窗口一律放副屏；重启或新开以后要确认位置。没有副屏或者定不了位置就报告，**不动作者日常用的窗口**。每个实例用自己的 profile。
- 往真窗口发真实的系统按键（比如验输入法）之前，先核对前台进程就是要测的那个；焦点被别的应用抢走就中止，**不能把按键发到别的应用里**。同一时间只让一个验收占用前台。
- 真窗口失败先看 `app.info` 和结果里的 environment。确实是被遮挡、窗口失活、不在前台，才原样重跑一次，第一轮的记录留着；不是这几种原因就当真失败处理。
- 机器很忙时，等画完、等后台补建索引的测试偶尔会超时：单独重跑一次，过了就算过，在交回里记一句。这两种情况以外不重跑，更不给断言加重试。
- 场景按名字找控件（`ui.press`、`ui.find` 的 `label`、`role`、`within`），少按坐标点；目标可能在窗口外时先滚动到一个不随上文变的位置（比如页尾），再按名字按。默认打开的底部时间线会盖住窗口下部，要点窗口下部的控件先用 `workspace::ToggleBottomTimeline` 收起它。
- 需要预先造库的场景：`dr-view-review/scenarios/book-media-writes-v3.json` 不自己造库。先取一个没用过的 profile 名（`DRIFTING_PROFILE` 的规矩见上），造库，再带这个 profile 跑：

  ```bash
  cd next
  P=media-$(date +%H%M%S)
  cargo run -p dr-view-material --example v3-media-fixture -- "$HOME/Library/Application Support/cc.drifting.next.dev.$P/library"
  cargo drifting workspace scenario crates/dr-view-review/scenarios/book-media-writes-v3.json --app target/debug/drifting --profile "$P" --yes
  ```

  跑完这个 profile 的数据要自己删（`--profile` 的运行不替你删）。
- 调试桥的鼠标事件现在不带修饰键（`Modifiers::none()`）。要验按住 Shift 点这类操作，得先给调试桥加上：默认语义不变，修饰键贯穿真实的按下、移动、抬起，补上默认、指定、无效参数三种契约测试。

## 整合

监管会话把各路的分支合进 `main` 时照这些做。

- **收件只核三样**：改动有没有出自己的范围、全套检查过没过、有没有确定会丢作者数据的问题。别的意见写进那个模块结论文档的「待协调」，不反复复审。整合者不写功能，只修合并时对不上的地方。
- **检查在合并后的树上自己跑一遍**，不拿源分支报的测试数当结果；中途停掉的检查不记成通过。除了 `AGENTS.md` 列的四条 cargo 命令和 `pnpm public:check`、`pnpm ci:contract:check`，合进 `main` 前再跑：

  ```bash
  pnpm agent:capabilities:check
  pnpm exec vitest run src/renderer/architecture/retired-client-integrations.acceptance.test.ts \
    src/renderer/lib/agent/runtime/acceptance/retired-shadow-arc-evolve.acceptance.test.ts \
    src/renderer/lib/ai/retired-copilot.acceptance.test.ts \
    src/renderer/locales/drift-terminology.acceptance.test.ts
  ```

  cargo 的测试加 `--no-fail-fast`，一次看全失败的。
- **`cargo xtask check` 报测量证据「过期」只是提示**，不挡合并。只在机器空闲时重测。
- **怀疑会丢数据时**：用 `dr_testkit` 的种子写一个临时探针复现，写清复现命令再退回。探针和日志放在公共 Git 目录的 `integration-evidence/` 下，不进 `main`；永久的回归测试由负责那块的会话补。
- **常见冲突怎么解**：
  - `next/crates/dr-i18n/locales/*.json` 是生成的：取 `main` 的一边，再重新生成。

    ```bash
    git checkout --ours next/crates/dr-i18n/locales/
    cd next && python3 crates/dr-i18n/script/sync-locales.py && python3 crates/dr-i18n/script/sync-locales.py --check
    ```

  - `next/crates/dr-i18n/keys.txt`、`own/*.json`：两边都留；`keys.txt` 去掉重复的键，`own/*.json` 按键合并。
  - `next/Cargo.lock`：取 `main` 的一边，再让 cargo 补：`git checkout --ours next/Cargo.lock && cd next && cargo check --workspace --all-targets`。
  - 两边在同一处各加了一个函数或测试：两边都留。git 常把两边共有的收尾 `}` 提到冲突外面，都留以后前一个函数会少一个 `}`，合完先 `cargo check`。
  - 接口被别的分支改了：在整合分支上把调用改到新接口，提交说明写清是整合修补。

## 不能替作者做的

- 推送 `main`、发版、打或移动标签、对外发帖、开上游 PR、在别人的 issue 里表态。上游 issue 有长期许可，但要先复现、查重、确认不是用错了接口。
- 装系统组件（Xcode 的 Metal Toolchain、Windows 工具链等）；建远端仓库（比如 GPUI 的 fork）；连真服务、用真密钥、调真的模型 API、花钱；往真 Sentry 传符号。
- 删 0.1 客户端（`src/`、`src-tauri/` 等）的任何东西。
- 视觉和交互的取舍、产品设计，以及 D7。
- 需要真人做的手测。

## 仓库里看不见的三样东西

都在 Git 里但不在任何分支的工作树上，`git status` 看不到。没有作者的话不删、不 rebase。

- **`refs/wip/<日期>/<名字>`**（15 个）：被停掉的会话当时没提交的改动，原样存成了引用。以后要停掉一路没做完的会话，也先这样把它没提交的改动存下来，不在别人还在动的工作区里改。看某一份：`git diff <原分支> refs/wip/<日期>/<名字>`；要接着做：`git switch -c <新分支> refs/wip/<日期>/<名字>`。其中多数属于切换时已经删掉的 v2.2 按种类代码，只有参考价值。
- **`handback/*` 分支**（18 个）：各路交回时用的指针，指向的提交都已经在 `main` 里。
- **公共 Git 目录下的 `integration-evidence/`**（34 个目录）：整合者的探针原件和失败日志。

两条从没合进 `main` 的冻结分支带着已知的数据缺陷，谁再捡起来要先读当时的记录（`git show f272963e8:docs/rust-rewrite/handoff/integration.md`）：M24 样书认领会覆盖用户的书；M19 笔记任务投射有三项数据问题。
