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

- **K3**：第四十二批接收重交 `d28e911d`，后半段已消费第三十九批 K1 修复：模板返回的实际根 id、按模板重读和带书 id 的模板正文均已接，原 `67ccafc7` 暂缓关闭。v3 导入、历史／续导及两本样书写库已有契约；24 的故事线字段模板、27 的旧颜色落点已逐项读回。22、23、25 仍由调用者显式给 MappingChoices，缺项在写目标库／设备身份前返回未决，不把语义未定当成已完成。
- **作者 / K3**：m10 待协调 22、23（幕绑定构想的关系类型与方向；「未归属」泳道的树上住处和模板设置）以及 25 的语义取舍等作者回来定。前半段只读清单保留来源和 pending，不挡本批；后半段不能把尚未决定的映射当作完成。
- **K3**：m10 待协调 26 的异常旧数据继续保留并报告；真正导入时明确阻止／提示／修复的边界，不静默丢弃或覆盖。以上只分派新交回的协调项，不恢复旧导入分支的冻结待办。
- **K1／K3／K4 后续：** m10 新待协调 28（素材端点／指定模块的正文链接）、29（字段模板非空初值）归 K1 与消费方，30（旧表格单元标记无损映射）归 K3，31（v3 索引、App 样书入口与 once-only 接线）归 K4。当前不支持的来源会预检阻止、保留原文，未接旧索引派生器；原 v2.2 路径保持。待协调 32 的 Markdown 转义修复已按监管许可随第四十二批接收。
- **K2／后续 K6：** 第四十一批接收 K2 的 44 个 v3 通用命令、版本标记、模板／模块读取、默认正文初始化与「新建＋住处＋归属」；帮手目录仍全部排除，排除改动已有作者明确授权。逐项继承来源解释、带隐藏关系的完整影响读取、读取覆盖／CAS facade 与模板动作目录按 [k6-agent-tools.md](../modules/k6-agent-tools.md#待协调) 后续实施；不把命令可用当作工具已开放。M30 计划／工作记忆的模型工具仍未注册，后续单列接入。
- **K4／K5 后续：** M30 的主页建议插槽、模板指导／starter 的界面落点及通用条目导航随正式 v3 接回安排；冻结旧页面不因此恢复。
- **K1／K4／K6 与作者：** 第四十一批 F1 交回保留指定正文模块的行内链接和六类模块的导出／Markdown／搜索统计约定，见 [F1 第 6 步待协调](../foundations/f1-model-doc.md)。当前 EntityLink 尚无 module；K4 要同步编辑器与索引消费者，模块下游表示仍需约定，不由整合者发明。旧 UI 缓存／事件仍是 v2.2。早期固定 id 的开发库若已混用文档，不能靠新 id 修复找回丢失归属，须另行审计／重新导入，不能静默重置。
- **轨道 4 的 F7／M43 与作者：** M34 的 macOS 用途声明、裸程序和开发包接线已由轨道 3 提供；正式身份／Hardened Runtime 时核对 audio-input entitlement，Windows 原生录音、系统麦克风授权与设备切换仍需作者手测。合成测试不代表硬件验收。

- **F6／后续应用接线方：** 第四十批已接轨道 4 的模块接口；M37 的设置编辑防抖回调、M36 的生产同步周期／账号换库与退出调度及稿纸角标、M43 的窗口关闭／托盘命令与第二实例唤醒仍需接线。当前 SyncEngine 只由测试调用，不把传输层验收写成应用已自动同步；整合者不代写这些功能。
- **轨道 2 的 F5：** M43 的平台字体回退链已接，dr-ui 的角色字体挂接按 [m43 待协调](../modules/m43-windows.md#待协调) 后续处理。
- **Hosted 服务负责方／作者：** M36 的 `loro-v2` 网络命名空间登记、真实服务、Windows 安装器与 arm64／实机验收仍待独立安排；不在公共客户端镜像服务源码，不自行安装缺失工具链。

- **K4 G1／G2／G3／G4 与 K5：** 第四十三批接首次接口，第四十四批接 K4-0 第二次交回 `92f78243`：动态根标签、模板集合、公共条目卡和扩展动作接口。按 [F6 K4-0 接口](../foundations/f6-shell.md) 接线；组合／显示器仍可为占位，未注册的新建／换模板／归属及模板新建保持禁用。第二次交回已完成，`workspace/sidebar.rs`、`workspace/outline.rs` 正式交 G2，当前 v3 左栏主体是 `v3/sidebar.rs`，其余公共外壳仍归 F6。
- **K4-0／K6／G1／G4／K5：** F6 新待协调 1 的设置来源 DTO 交 K6 与查询方统一，外壳暂只追溯来源、有效值来自 F3；2 的 Entry/module 导航由 G4 直接消费新 Target，新的模块链接与 EntityLink.module 归 K1／G1，不能经旧 nav_target 的 Book 哨兵；3 的任意模板 mark 图形词汇归 K5，外壳保留原字符串且暂用通用记号。

- **G2／K5／G4 与外壳：** F6 第二次交回的协调项已转交：G2 注册三种条目选择器并接左栏／大纲，K5 注册 template creator 和 Template 页，G4 与外壳补版本化主页注册口与正式 v3 导览；当前 v3 不显示旧按种类导览。maker／on_refresh 只读所给快照、更新子实体，避免重借正被外壳借用的 workspace；写入留点击回调并在异步提交前重验书和目标。

- **F3/K2 与 G3：** G3 第一段交回的 `timeline_view.list` 会隐藏无效目标，但 `timeline_view.put` 是整份替换。当前 G3 重读后比较原始与有效集合数量，并以 book frontier 做 CAS，数量不一致就拒绝、不丢隐藏数据；视图改名／泳道增删排序的局部命令交 F3/K2，G3 消费后补验。
- **F6/K2 与 G3：** G3 的 v3-heavy 真窗口在书快照尚未载入、时间线尚未实例化时超时，最长等待 180 秒仍 `book.loaded=false`。打开／横滚验收未过，不能算 G3 全组或 K4 切换完成；外壳／查询负责方定位，再由 G3 重跑 `python3 crates/dr-view-timeline/scripts/window-bench.py`。现有 v2.2 的 CLI／IPC 往返计时不等于发布档绘制帧基准，见 m14 的待协调 2。

- **K6：** 轮询发现 `handback/k6` → `6b18815e` 已有目录／resolver 实现，但相对 main 的 `docs/` 差异为空，k6-agent-tools.md 最后一节仍是轨道 3 的「方案交回」并说明没有实现。请按交回协议第 3 项补本轮包含段落、最终全套检查结果和待协调，再前移指针；暂未接收，不把旧方案的 1974 项检查套用于新实现。复查：`git diff main...6b18815e -- docs`，以及 `git show 6b18815e:docs/rust-rewrite/modules/k6-agent-tools.md`。此项仅登记交回资料待补，不宣称产品测试失败。

## 监管说明

- 11-09 18:10：K3 为了让全套测试通过，改了冻结的 `dr-mirror` 一行（`897551ac`：链接前的 `!` 一律转义，不再因为前面有反斜杠就跳过，并留下 proptest 种子）。我核过：普通文字里的 `!` 不会被预先转义，前面那个反斜杠只可能是转义过的反斜杠，所以一律转义是对的。这一行同意随 K3 收，不算越界。
- 11-09 18:10：K1+K2 已全部合进 `main`（第 39、41 批）。新开轨道 8 K6（帮手工具通用化），指针 `handback/k6`，范围见 kernel-v3-split.md。

## 收进来的

整合者在这里记：时间、指针、合进 `main` 后的提交、检查结果。

| 时间 | 指针 | main | 检查 |
| --- | --- | --- | --- |
| 11-09 02:46 | `handback/k3` → `4d9c3d8b`（第三十二批：K3 前半段） | `bd017094` | 并发 6；fmt、Clippy、test（1892 通过／22 忽略／0 失败）、xtask、public 及附加兼容检查全过；待协调 22–27 已分派，实际 v3 导入等 K1。 |
| 11-09 02:58 | `handback/track4` → `e4722faa`（第三十三批：M35） | `5f98dd1d` | 并发 6；fmt、Clippy、test（1901 通过／22 忽略／0 失败）、xtask、public 及附加兼容检查全过；账号状态／换库失败反馈已归轨道 4，真实服务留后续授权验收。 |
| 11-09 04:05 | `handback/k1` → `dd39c0bd`（第三十六批：第 1–4 步及退回修正） | `574e7a4f` | 并发 6；fmt、Clippy、test（1925 通过／22 忽略／0 失败）、xtask、public 及附加兼容检查全过；旧 v2.2 行为和 crate 范围已修正，K3 可接 v3 接口继续。 |
| 11-09 14:21 | `handback/track3` → `5750ea57`（第三十八批：M30、M34、K6 方案及 P2 复验） | `4e147ce7` | 并发 6、测试单线程；fmt、Clippy、test（1974 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过，无重跑；无冲突修补，K6 仅文档，硬件验收仍待。 |
| 11-09 16:11 | `handback/k1` → `a1ac3c24`（第三十九批：文档 id 隔离修复） | `324ca07d` | 并发 6、测试单线程；fmt、Clippy、test（1977 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过，无重跑；两书同库删除隔离通过，K3 须同步后重交。 |
| 11-09 16:26 | `handback/track4` → `8275c95f`（第四十批：M37、M36 修复、M43） | `1c313869` | 并发 6、测试单线程；原探针与 7 项永久回归通过，fmt、Clippy、test（2000 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过；Windows x64 平台 Clippy 通过，生产接线和实机仍待。 |
| 11-09 17:04 | `handback/k1` → `17f254d4`（第四十一批：K1+K2 第 5、6 步） | `de7a5997` | 并发 6、测试单线程；fmt、Clippy、test（2018 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过，无重跑；旧 136 个 schema 不变，新增 44 个 v3 命令仍排除出帮手目录，无冲突修补。 |
| 11-09 18:32 | `handback/k3` → `d28e911d`（第四十二批：v3 导入与样书适配） | `cf5095d3` | 并发 6、测试单线程；fmt、Clippy、test（2033 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过，无重跑；导入 12 项、样书 3 项及获准的 Markdown 29 项通过，原 K3 暂缓关闭，无冲突修补。 |
| 11-09 19:10 | `handback/k4-0` → `ee2365e9`（第四十三批：首次外壳接口） | `d050e2d0` | 并发 6、测试单线程；fmt、Clippy、test（2038 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过，无重跑；隔离真窗口 49/49 步、0 pending，三图已目检，无冲突修补。 |
| 11-09 19:36 | `handback/k4-0` → `92f78243`（第四十四批：左栏与公共条目卡） | `8471d7e2` | 并发 6、测试单线程；fmt、Clippy、test（2039 通过／0 失败／22 忽略）、xtask／审计、public 及附加兼容／语言检查全过，无重跑；隔离真窗口 49/49 与 84/84 步、0 pending，六图已目检，无冲突修补，sidebar／outline 交 G2。 |
| 11-09 20:46 | `handback/k4-g3` → `85b70cbf`（第四十五批：时间线视图与泳道） | `b7595ae0` | 并发 6、测试单线程；fmt、Clippy、test（2041 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过；真窗口 45/45 步、0 pending，两图已目检，无冲突修补。仅第一段；v3-heavy 快照超时和后续操作仍待，不算全组完成。 |

## 退回

整合者在这里记：时间、指针、原因和复现、退给谁。

| 时间 | 指针 | 原因 | 处理 |
| --- | --- | --- | --- |
| 11-09 03:13 | `handback/k1` → `3f20c049`（第三十四批） | 全套检查通过（1920 通过／22 忽略／0 失败），但违反本页 K1 第 4 条：`dr-model/src/kind.rs::EntityKind::may_be_linked` 新放行既有 `Material`，改变 v2.2 正文链接及旧导入行为。临时 Rust 程序打印 `dr_model::kind::EntityKind::Material.may_be_linked()`，main `fb506d26` 为 false、候选为 true。 | 退 K1：保留 v2.2 原行为，把 v3 所需扩展限定到 v3 路径，补兼容契约并同步 main 后重交。整合者不代改功能；候选保留在 `codex/batch-34`，当时未合 main。**已由 `dd39c0bd` 修正，第三十六批接收。** |
| 11-09 03:13 | `handback/k1` → `72734432`（第 3 步续交） | 仍含上条未修的行为变化；新增 `next/crates/dr-index/tests/library.rs`，不在分轨给 K1 的 crate 列表（dr-model / dr-doc / dr-store / dr-testkit / dr-workspace）内。 | 退 K1：把跨层契约放到已授权的 dr-testkit 等合适位置，连同上条一起修后重交。此次先按范围退回，未合候选、未冒称已跑过这个续交 SHA 的全套检查。**已由 `dd39c0bd` 撤回 dr-index 改动，第三十六批接收。** |
| 11-09 03:28 | `handback/track4` → `c719a76d`（第三十五批：M37） | 全套检查通过（1905 通过／22 忽略／0 失败），但超出本页轨道 4 第 2 条的 dr-shell「只限挂账号入口」：`settings/store.rs` 新增持久化账本并修改 set/reset/快捷键写入，`settings/mod.rs` 新增同步回调与快捷键应用，`settings/registry.rs` 新增同步范围标记。`git diff e4722faa..c719a76d -- next/crates/dr-shell/src/settings` 可见范围。 | 退轨道 4：按夜间范围收敛共享改动，或把必要的 settings 接线单列为待协调，等作者明确范围后重交。旧 M37 任务书允许最小注册表标记，但本页更窄，整合者不自行扩大；候选保留 `codex/batch-35`，M35 已接成果不受影响。 **已由 `5c777ca8` 收敛，随 `8275c95f` 在第四十批接收。** |
| 11-09 14:10 | `handback/k1` → `dd39c0bd`（已在第三十六批合进 main） | 监管审查：默认层级和默认分类用写死的 id（`dr_doc::v3::novel::NovelRootEntries::new()`：`root-manuscript`、`cat-character`……），模板正文文档 id `template:<模板>/<模块>` 不带书 id；`loro_doc.doc_id` 是全库主键，两本书会共用 `body:root-manuscript/about` 和 `template:tpl-chapter/mod-prose`，彻底删除一本书会删掉另一本的文档。dr-testkit 的 v3 种子、K3 的样书（两本书进同一个库）都踩在上面。 | 退 K1：照 kernel-v3.md「文档 id 在整个库里唯一」改，加两本书同库、删一本另一本不少的测试，再做第 5、6 步。K3 后半段 `handback/k3` → `67ccafc7` 先不收，等 K1 修完合进 main，K3 改用模板返回的根 id 后重交。 **K1 已由 `a1ac3c24` 修正，第三十九批接收；K3 适配重交 `d28e911d` 已在第四十二批接收。** |
| 11-09 14:05 | `handback/track4` → `5c777ca8`（第三十七批；最新 `e657622e` 的同步实现未变） | 常驻整合候选 `8c1e429e` 的绝对路径素材探针失败：`sync_once` 返回 `Ok`、`downloaded_assets: 1`，库外合成稿件 `synthetic-manuscript-source.txt` 被删除。`engine.rs` 把远端 `asset_id` 拼进暂存路径，绝对路径越过库边界，下载覆盖后又被暂存清理删除。在候选 `next/` 运行 `CARGO_BUILD_JOBS=6 cargo test -p dr-sync --test integrator_absolute_asset --locked -- --nocapture`，0 通过／1 失败（退出码 101）。 | 退轨道 4：同步入口只接受合法素材 id，拒绝绝对路径、正反斜杠及其他不合法路径形式；在任何素材查重、下载、写入、清理前校验。把探针改写成自己的永久回归，断言拒绝并且库外文件仍存在、原字节不变；同步 main、全套检查后重交。第 37 批和含同一缺陷的 M43 续交均未接收；整合者不代修，临时探针不进 main。探针备份在公共 Git 目录的 `integration-evidence/batch-37/integrator_absolute_asset.rs`，可复制到自己分支的同名 tests 路径复现。 **已由 `9af4892b` 修正，永久回归与原探针通过；第四十批接收 `8275c95f`。** |
