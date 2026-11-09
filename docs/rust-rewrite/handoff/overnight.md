# 夜间队列（2026-11-09）

作者睡觉期间，五个会话照这一页自己往下做，不等作者转话。分轨和规矩照 [kernel-v3-split.md](kernel-v3-split.md)，方案照 [kernel-v3.md](../kernel-v3.md)。这一页只管三件事：怎么交回、整合者怎么收、每个会话按什么顺序做。

## 交回协议

各轨道做完一段：

1. 把这一段的改动全部提交在自己的分支上，`git merge main` 到最新，在 `next/` 跑全套检查（`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`、`cargo xtask check`），再在仓库根跑 `pnpm public:check`。
2. 检查都过了，把交回指针挪到当前提交：`git branch -f handback/<轨道名> HEAD`。轨道名见下面的队列。
3. 在自己的模块文档里写一小节「交回」：包含哪几段、检查结果、待协调。

交回以后不用等，接着做队列里的下一段。每开始一段之前，先看一眼退回记录：`git show main:docs/rust-rewrite/handoff/overnight.md`，有退给自己的，先处理退回。

编译时设 `CARGO_BUILD_JOBS=3`（整合者用 6）。机器 12 核，五路同时编译。

## 整合者

每 10 分钟看一次 `git for-each-ref refs/heads/handback`。指针所指的提交还不在 `main` 里的，就在常驻整合 worktree 开一批，照 [integration.md](integration.md) 合并、跑全套检查：

- 过了：本地合进 `main`，更新 [progress.md](../progress.md) 和 integration.md 的分支表，在下面的「收进来的」记一行。
- 不过、或者越出了它的 crate、或者有确定会丢作者数据的问题：不合，在下面的「退回」记一行，写清原因和复现。

不推送。没有可收的就等下一轮，一直到作者回来。

## 各会话的队列

### 轨道 3 帮手运行时（Codex，指针 `handback/track3`）

1. 做完 M34 口述（现在工作区里的改动），交回。之前已提交的 M30、小说提示词集中、M32 复验一起交。
2. 写 K6 的方案文档 `docs/rust-rewrite/modules/k6-agent-tools.md`，只写文档，不写代码：帮手工具怎么换成 kernel-v3.md「帮手」一节说的通用一套（条目、模块、归属、时间线）；层级模板声明的动作怎么生成工具；帮手每次拿到的「这本书的结构说明」长什么样，从模板的写给帮手说明怎么拼出来；轨道 3 已经集中的小说提示词怎么挪进小说项目模板；哪些现有工具删掉、哪些改名、哪些照旧。交回。
3. 然后停下，等作者。

### K3 旧库导入（Codex，指针 `handback/k3`）

1. 前半段（现在在做的）：补齐合成旧库、写导入清单，交回。
2. 等 K1 的 `dr-doc` v3 合进 `main`：每 15 分钟看一次 `git cat-file -e main:next/crates/dr-doc/src/v3/mod.rs`，有了就 `git merge main` 接着做。
3. 后半段：`dr-import-v1` 加一条导入成 v3 的路径，按映射表逐项导入，结果和导入清单逐项对上；导入完跑 v3 的不变量检查；`dr-samples` 两本样书改成生成 v3 的书，内容和现在一样。导入成 v2.2 的旧路径保留。不改 v3 的结构，映射表有问题写进 m10-import.md 的待协调。交回。
4. 然后停下，等作者。

### K1+K2 通用内核（Antigravity，指针 `handback/k1`）

1. 第 2 步 `dr-doc` v3 做完就交回一次，K3 在等它。
2. 接着做第 3–6 步（`dr-store`、`dr_testkit::seed` 的 v3 四档、`dr-workspace` 的通用命令、`loro-schema.md` 和 f1/f3 文档），每做完一步交回一次。
3. 最后一步交回时，照 kernel-v3.md「分步」末尾那段改 AGENTS.md 的大纲规则：幕不再内置，默认结构是书稿 / 章 / H1 / H2 / H3，作者自己加的层级由作者命名，H1/H2/H3 的规矩不变。
4. 改 v2.2 那边的文件（`dr-doc` 的 book、schema，`dr-model` 的 kind）只能是两边共用的接线，不能改变 v2.2 的行为；交回小节里列出改了哪些、为什么。
5. 然后停下，等作者。

### 轨道 4 账号与同步（Antigravity，指针 `handback/track4`）

1. 按 M35 账号 → M37 偏好同步 → M36 同步 v2 → M43 Windows 补齐的顺序，**每做完一个模块交回一次**，不要攒到最后。
2. 动 `dr-shell`、`dr-view-shelf` 只限挂账号入口的地方，交回小节里列出来。
3. 做完四个就停下，等作者。

## 待协调分派

- **K3**：第三十九批已接 K1 文档 id 修复 `a1ac3c24`。旧交回 `67ccafc7` 仍暂缓；先同步 main，使用 `apply_novel_project_template` 返回的实际根 id（重读可用 `root_entry_by_template`／`novel_roots`），模板正文使用带书 id 的 `TemplateId::for_entry_module` 后重交。第三十六批的 v3 接口已在 main。K1 对 [m10 待协调 24、25、27](../modules/m10-import.md#待协调) 的回应已转回 m10：项目级故事线字段模板用模板 KV 初值，个别层级颜色用既有字段模块；后半段消费接口并逐项核对。25 的关系模板约束仍有作者语义取舍，不自行放宽。
- **作者 / K3**：m10 待协调 22、23（幕绑定构想的关系类型与方向；「未归属」泳道的树上住处和模板设置）以及 25 的语义取舍等作者回来定。前半段只读清单保留来源和 pending，不挡本批；后半段不能把尚未决定的映射当作完成。
- **K3**：m10 待协调 26 的异常旧数据继续保留并报告；真正导入时明确阻止／提示／修复的边界，不静默丢弃或覆盖。以上只分派新交回的协调项，不恢复旧导入分支的冻结待办。
- **K2／后续 K6：** 轨道 3 的 K6 方案只交文档；通用命令的版本／作用域、完整影响读取、正文初始化和「新建＋住处＋归属」接口按 [k6-agent-tools.md](../modules/k6-agent-tools.md#待协调) 对接，不把已写方案当成已开放工具。M30 计划／工作记忆的模型工具仍未注册，后续单列接入。
- **K4／K5 后续：** M30 的主页建议插槽、模板指导／starter 的界面落点及通用条目导航随正式 v3 接回安排；冻结旧页面不因此恢复。
- **轨道 4 的 F7／M43 与作者：** M34 的 macOS 用途声明、裸程序和开发包接线已由轨道 3 提供；正式身份／Hardened Runtime 时核对 audio-input entitlement，Windows 原生录音、系统麦克风授权与设备切换仍需作者手测。合成测试不代表硬件验收。

## 收进来的

整合者在这里记：时间、指针、合进 `main` 后的提交、检查结果。

| 时间 | 指针 | main | 检查 |
| --- | --- | --- | --- |
| 11-09 02:46 | `handback/k3` → `4d9c3d8b`（第三十二批：K3 前半段） | `bd017094` | 并发 6；fmt、Clippy、test（1892 通过／22 忽略／0 失败）、xtask、public 及附加兼容检查全过；待协调 22–27 已分派，实际 v3 导入等 K1。 |
| 11-09 02:58 | `handback/track4` → `e4722faa`（第三十三批：M35） | `5f98dd1d` | 并发 6；fmt、Clippy、test（1901 通过／22 忽略／0 失败）、xtask、public 及附加兼容检查全过；账号状态／换库失败反馈已归轨道 4，真实服务留后续授权验收。 |
| 11-09 04:05 | `handback/k1` → `dd39c0bd`（第三十六批：第 1–4 步及退回修正） | `574e7a4f` | 并发 6；fmt、Clippy、test（1925 通过／22 忽略／0 失败）、xtask、public 及附加兼容检查全过；旧 v2.2 行为和 crate 范围已修正，K3 可接 v3 接口继续。 |
| 11-09 14:21 | `handback/track3` → `5750ea57`（第三十八批：M30、M34、K6 方案及 P2 复验） | `4e147ce7` | 并发 6、测试单线程；fmt、Clippy、test（1974 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过，无重跑；无冲突修补，K6 仅文档，硬件验收仍待。 |

## 退回

整合者在这里记：时间、指针、原因和复现、退给谁。

| 时间 | 指针 | 原因 | 处理 |
| --- | --- | --- | --- |
| 11-09 03:13 | `handback/k1` → `3f20c049`（第三十四批） | 全套检查通过（1920 通过／22 忽略／0 失败），但违反本页 K1 第 4 条：`dr-model/src/kind.rs::EntityKind::may_be_linked` 新放行既有 `Material`，改变 v2.2 正文链接及旧导入行为。临时 Rust 程序打印 `dr_model::kind::EntityKind::Material.may_be_linked()`，main `fb506d26` 为 false、候选为 true。 | 退 K1：保留 v2.2 原行为，把 v3 所需扩展限定到 v3 路径，补兼容契约并同步 main 后重交。整合者不代改功能；候选保留在 `codex/batch-34`，当时未合 main。**已由 `dd39c0bd` 修正，第三十六批接收。** |
| 11-09 03:13 | `handback/k1` → `72734432`（第 3 步续交） | 仍含上条未修的行为变化；新增 `next/crates/dr-index/tests/library.rs`，不在分轨给 K1 的 crate 列表（dr-model / dr-doc / dr-store / dr-testkit / dr-workspace）内。 | 退 K1：把跨层契约放到已授权的 dr-testkit 等合适位置，连同上条一起修后重交。此次先按范围退回，未合候选、未冒称已跑过这个续交 SHA 的全套检查。**已由 `dd39c0bd` 撤回 dr-index 改动，第三十六批接收。** |
| 11-09 03:28 | `handback/track4` → `c719a76d`（第三十五批：M37） | 全套检查通过（1905 通过／22 忽略／0 失败），但超出本页轨道 4 第 2 条的 dr-shell「只限挂账号入口」：`settings/store.rs` 新增持久化账本并修改 set/reset/快捷键写入，`settings/mod.rs` 新增同步回调与快捷键应用，`settings/registry.rs` 新增同步范围标记。`git diff e4722faa..c719a76d -- next/crates/dr-shell/src/settings` 可见范围。 | 退轨道 4：按夜间范围收敛共享改动，或把必要的 settings 接线单列为待协调，等作者明确范围后重交。旧 M37 任务书允许最小注册表标记，但本页更窄，整合者不自行扩大；候选保留 `codex/batch-35`，M35 已接成果不受影响。 |
| 11-09 14:10 | `handback/k1` → `dd39c0bd`（已在第三十六批合进 main） | 监管审查：默认层级和默认分类用写死的 id（`dr_doc::v3::novel::NovelRootEntries::new()`：`root-manuscript`、`cat-character`……），模板正文文档 id `template:<模板>/<模块>` 不带书 id；`loro_doc.doc_id` 是全库主键，两本书会共用 `body:root-manuscript/about` 和 `template:tpl-chapter/mod-prose`，彻底删除一本书会删掉另一本的文档。dr-testkit 的 v3 种子、K3 的样书（两本书进同一个库）都踩在上面。 | 退 K1：照 kernel-v3.md「文档 id 在整个库里唯一」改，加两本书同库、删一本另一本不少的测试，再做第 5、6 步。K3 后半段 `handback/k3` → `67ccafc7` 先不收，等 K1 修完合进 main，K3 改用模板返回的根 id 后重交。 **K1 已由 `a1ac3c24` 修正，第三十九批接收；K3 仍等适配后重交。** |
| 11-09 14:05 | `handback/track4` → `5c777ca8`（第三十七批；最新 `e657622e` 的同步实现未变） | 常驻整合候选 `8c1e429e` 的绝对路径素材探针失败：`sync_once` 返回 `Ok`、`downloaded_assets: 1`，库外合成稿件 `synthetic-manuscript-source.txt` 被删除。`engine.rs` 把远端 `asset_id` 拼进暂存路径，绝对路径越过库边界，下载覆盖后又被暂存清理删除。在候选 `next/` 运行 `CARGO_BUILD_JOBS=6 cargo test -p dr-sync --test integrator_absolute_asset --locked -- --nocapture`，0 通过／1 失败（退出码 101）。 | 退轨道 4：同步入口只接受合法素材 id，拒绝绝对路径、正反斜杠及其他不合法路径形式；在任何素材查重、下载、写入、清理前校验。把探针改写成自己的永久回归，断言拒绝并且库外文件仍存在、原字节不变；同步 main、全套检查后重交。第 37 批和含同一缺陷的 M43 续交均未接收；整合者不代修，临时探针不进 main。探针备份在公共 Git 目录的 `integration-evidence/batch-37/integrator_absolute_asset.rs`，可复制到自己分支的同名 tests 路径复现。 |
