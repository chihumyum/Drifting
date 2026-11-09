# 夜间队列（2026-11-09）

各负责会话照这一页交回，不等作者转话。2026-11-10 作者改为由会话主动发消息、整合者等消息接收，不再定时扫描指针。分轨和规矩照 [kernel-v3-split.md](kernel-v3-split.md)，方案照 [kernel-v3.md](../kernel-v3.md)。这一页只管三件事：怎么交回、整合者怎么收、每个会话按什么顺序做。

## 交回协议

各轨道做完一段：

1. 把这一段的改动全部提交在自己的分支上，`git merge main` 到最新，在 `next/` 跑全套检查（`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`、`cargo xtask check`），再在仓库根跑 `pnpm public:check`。
2. 检查都过了，把交回指针挪到当前提交：`git branch -f handback/<轨道名> HEAD`。轨道名见下面的队列。
3. 在自己的模块文档里写一小节「交回」：包含哪几段、检查结果、待协调。
4. 主动给整合会话「整合 Drifting 重写批次」发消息（threadId：`01a1bee7-4fe8-7cd3-bd05-bfd8bd8c1b07`，hostId：`local`），包含 handback 名、确切提交号、改动范围、检查／窗口结果与待协调。可用会话消息工具 `send_message_to_thread`；作者已授权此协作通知。修复重交也一样，不能只移动指针等待被轮询发现。

交回以后不用等，接着做队列里的下一段。每开始一段之前，先看一眼退回记录：`git show main:docs/rust-rewrite/handoff/overnight.md`，有退给自己的，先处理退回。

编译时设 `CARGO_BUILD_JOBS=3`（整合者用 6）。机器 12 核，五路同时编译。

作者 11-10 补充：所有会话（含整合者）启动的验收窗口统一放到副屏；已打开的验收窗口也移到副屏，重启／新建后仍须确认位置。保持隔离 profile 和原验收配置，不移动作者日常使用的窗口；无副屏或无法定位时主动报告。已直接通知 K1／K2、F6／K4-0、G1–G4、K5、K6。

## 整合者

等各会话的正式交回／重交消息，不再每 10 分钟扫描 `handback/*`。收到消息后核对其中指定的 ref 和提交；尚不在 `main` 的正式候选，在常驻整合 worktree 开一批，照 [integration.md](integration.md) 合并、跑全套检查。已有接收队列和当前批次继续，不因通知方式变化中断：

- 过了：本地合进 `main`，更新 [progress.md](../progress.md) 和 integration.md 的分支表，在下面的「收进来的」记一行。
- 不过、或者越出了它的 crate、或者有确定会丢作者数据的问题：不合，在下面的「退回」记一行，写清原因和复现。

退回后直接给对应工作会话发消息，附原因、复现命令和重交要求（作者 11-09 补充）；文档退回记录照常保留。

不推送。没有可收的就等待会话消息；不定时扫描 refs、不向其他会话反复查询无变化进度。作者 11-10 要求已主动提醒 K1／K2、F6／K4-0、G1–G4、K5、K6 一轮；已知旧指针无需重复通知，收到新交回或阻塞再处理。

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
- **K2／K6：** 第四十一批接收 44 个 v3 通用命令；第五十七批接 K6 按书版本目录、读取守卫／CAS 与模板动作，原全部排除状态仅作为 K6 之前的历史保留。当前工具面以版本化目录为准，不把全部命令自动视为帮手能力。逐项继承来源 DTO、带隐藏关系的完整影响读取和逐字段时间线命令仍按 [k6-agent-tools.md](../modules/k6-agent-tools.md#待协调) 协调；M30 计划／工作记忆的模型工具仍未注册。
- **K4／K5 后续：** M30 的主页建议插槽、模板指导／starter 的界面落点及通用条目导航随正式 v3 接回安排；冻结旧页面不因此恢复。
- **K1／K4／K6 与作者：** 第四十一批 F1 交回保留指定正文模块的行内链接和六类模块的导出／Markdown／搜索统计约定，见 [F1 第 6 步待协调](../foundations/f1-model-doc.md)。当前 EntityLink 尚无 module；K4 要同步编辑器与索引消费者，模块下游表示仍需约定，不由整合者发明。旧 UI 缓存／事件仍是 v2.2。早期固定 id 的开发库若已混用文档，不能靠新 id 修复找回丢失归属，须另行审计／重新导入，不能静默重置。
- **轨道 4 的 F7／M43 与作者：** M34 的 macOS 用途声明、裸程序和开发包接线已由轨道 3 提供；正式身份／Hardened Runtime 时核对 audio-input entitlement，Windows 原生录音、系统麦克风授权与设备切换仍需作者手测。合成测试不代表硬件验收。

- **F6／后续应用接线方：** 第四十批已接轨道 4 的模块接口；M37 的设置编辑防抖回调、M36 的生产同步周期／账号换库与退出调度及稿纸角标、M43 的窗口关闭／托盘命令与第二实例唤醒仍需接线。当前 SyncEngine 只由测试调用，不把传输层验收写成应用已自动同步；整合者不代写这些功能。
- **轨道 2 的 F5：** M43 的平台字体回退链已接，dr-ui 的角色字体挂接按 [m43 待协调](../modules/m43-windows.md#待协调) 后续处理。
- **Hosted 服务负责方／作者：** M36 的 `loro-v2` 网络命名空间登记、真实服务、Windows 安装器与 arm64／实机验收仍待独立安排；不在公共客户端镜像服务源码，不自行安装缺失工具链。

- **K4 G1／G2／G3／G4 与 K5：** 第四十三批接首次接口，第四十四批接 K4-0 第二次交回 `92f78243`：动态根标签、模板集合、公共条目卡和扩展动作接口。按 [F6 K4-0 接口](../foundations/f6-shell.md) 接线；组合／显示器仍可为占位，未注册的新建／换模板／归属及模板新建保持禁用。第二次交回已完成，`workspace/sidebar.rs`、`workspace/outline.rs` 正式交 G2，当前 v3 左栏主体是 `v3/sidebar.rs`，其余公共外壳仍归 F6。
- **K4-0／K6／G1／G4／K5：** F6 新待协调 1 的设置来源 DTO 交 K6 与查询方统一，外壳暂只追溯来源、有效值来自 F3；2 的 Entry/module 导航由 G4 直接消费新 Target，新的模块链接与 EntityLink.module 归 K1／G1，不能经旧 nav_target 的 Book 哨兵；3 的任意模板 mark 图形词汇归 K5，外壳保留原字符串且暂用通用记号。

- **G2／K5／G4 与外壳：** F6 第二次交回的协调项已转交：G2 注册三种条目选择器并接左栏／大纲，K5 注册 template creator 和 Template 页，G4 与外壳补版本化主页注册口与正式 v3 导览；当前 v3 不显示旧按种类导览。maker／on_refresh 只读所给快照、更新子实体，避免重借正被外壳借用的 workspace；写入留点击回调并在异步提交前重验书和目标。

- **F3/K2 与 G3：** timeline_view.list 会隐藏无效目标，而 put 为整份替换；G3 第 59 批已逐字段核对原始与有效投影，并以同一 book frontier 做 CAS，不完整读取明确拒写。视图改名／泳道增删排序的局部命令仍交 F3/K2，G3 消费后补验。
  第 61 批后已通知 K2 继续这段：只改指定字段，保留隐藏成员／摆放／时间钉与未知字段，补同版本守卫及永久契约；正式 `handback/k1` 接收后再通知 G3 消费，当前保护性拒写不绕过。
- **G3 返修已关闭：** 第 56 批发现的数量相同但隐藏 pin.entry 被清空，已由 `c611c8de` 在第 59 批修复接收。完整字段／身份覆盖核对、同观察版本守卫、创建缺席证明及失败草稿重试均已验收；适配拒写断言的原场景与六项永久契约、三组真窗口通过。第 45、48、56 批历史保留，局部命令与 heavy 继续协调。

- **F6/K2 与 G3：** G3 的 v3-heavy 真窗口在书快照尚未载入、时间线尚未实例化时超时，最长等待 180 秒仍 `book.loaded=false`。打开／横滚的 heavy 性能验收保留未过；按 11-10 最新作者决定移到全部流程打通后，不单独阻塞 G3 功能接收或 K4 切换，功能与数据正确性仍需验收。后续由外壳／查询负责方定位，再由 G3 重跑 `python3 crates/dr-view-timeline/scripts/window-bench.py`。现有 v2.2 的 CLI／IPC 往返计时不等于发布档绘制帧基准，见 m14 的待协调 2。

- **F6/G2 与 G3：** 第四十八批已接时间线内选择器拖入与 `EntryDrag`；左栏／大纲仍缺中立载荷或来源注册口。按 M14 待协调 3，F6/G2 提供公共入口后由 G3 消费，dr-shell 不反向依赖 dr-view-timeline。本批长度窗口首轮第 44 步超时，原场景唯一隔离复跑全过；完整失败／成功证据保留，不改阈值。

- **K6：** 第五十七批接收重交 `5d664e62`：前三步与隐藏时间线读取保护均已接，第 53、54 批退回关闭。原探针与七项永久回归通过；不完整视图／时间钉明确拒写，含数量不变但绑定被隐藏的情况。K5／M32 可消费已合 main 的公共结构接口；各自实际接线仍待，不算完成。

- **K5／K6：** K5 两次交回已在第 46、47 批接收：叶子／层级模板、八项设置、泳道、动作及写给帮手的说明。当前预览仍只读本地草稿；K6 的 StructureContext 公共投影已在第 57 批合 main，后续预览从同一接口消费；当前 K5 尚未接入，也未接动作运行时。记号沿用已有砂笔集合，未知值保留，未主动改记号就不覆盖原字符串。
  第 61 批后 K5 已恢复这段接线。新建／未使用模板不会进入现有 StructureContext 的在用模板集合，薄包装入口交 K6 在持有的 dr-agent-tools 追加，继续使用同一 summarize_template；K5 不跨改其包，在精确 frontier 的独立副本覆盖草稿，只渲染、不执行动作或发送运行时。等公开入口正式接收后合回宿主，模块身份、跨书与未保存隔离均需测试。
- **F6／K1 查询方与 K5：** K5 同样在标准 debug v3-heavy 的初始书快照阶段等到 240 秒仍未加载；其采样位于 `book::v3::load → LevelGet → level_settings → entries_map → resolve_autolink_name_conflicts → resolve_level_settings`。这补充 G3 的加载协调项。K5 另外用四个 crate 临时 opt-level=2 得到含导航等待、桥往返和 PNG 回读的视图测量，配置与口径见 k5-templates.md；不能把这些数字当作标准 debug 已通过或发布档绘制帧耗时。负责方修正后，各组用同配置复测，整合者不跨层改查询。

- **F6 与 G2：** 第五十批已接四种显示器；第五十一批接 `a9115af6` 的 `add_level_settings`，第五十二批接 G2 `d2ddab9f`（含第二批 `898e1061`）的八项设置控件及看板分节，M11 待协调 1 已关闭。设置区保留实例／刷新，不替换整页或新增持久化模块种类。拖动、选择器及 heavy 对照仍在后续。

- **G1／G2：** 第五十二批已接 G2 的大纲接口 `09142d08`，见 M11 待协调 2：G1 在实际正文编辑器的 PageHost 构造后、移入 Chrome 前调用 `Workspace::register_v3_outline_editor(&page, Some((&host.entry, &host.module.id)), cx)`，全书为 None，替换编辑器时重新登记。G1 不预先过滤 show_outline，交 G2 每次快照核对；接口只留弱引用、不重借外壳。G1 接线正式交回合 main 后，G2 再做联合真窗口，大纲目前只验编译接口，不算产品验收完成。第 58 批已接 G1 `3278b584`，网格与补丁字段覆盖修复已验收，大纲登记已进 main；G2 现在可消费 main 做专门的联合窗口，尚未因此算联合验收完成。


- **F6／G2 全书导航阻塞（11-10）**：G2 消费第 58 批 main `c033ce2d` 后，单模块 H1/H2/H3 点击、输入读回／撤销、指定模块、show_outline 刷新、关开及全书首次登记已作窗口探查；全书内 entry.move 后书快照刷新，BookV3::exists 仅接受 Entry／Template，导致 Book 标签／页面被清掉。整合者核对并直接通知 F6，在既有 Book／Material 导航协调范围内修正与回归，第 60 批已接 `d2c0c918` 修复，58 步冒烟确认重排后 Book 页面及输入／撤销正确，G2 可续验全书重排后登记及 show_outline；与暂缓的 heavy 分开推进。G2 证据保留在其工作树 target/acceptance/k4-g2-outline-reorder-diag-1，M11 待协调 2 已记录；这不是新的正式 handback，不把其余联合项目写成已通过。

### v3-heavy 加载优先修复（11-10，作者明确分派）

11-10 后续作者决定覆盖本节原有的性能优先级与测量门槛：已完成的查询修复按正确性照常收，未完成的优化和 heavy 测量移到全部流程打通后，不阻塞切换。以下保留原分工、测量计划和故障证据；暂缓不等于性能已通过。

- **先由 K1／K2 修内核**：已直接通知现有内核会话，优先于后续 G4 批注／素材命令；第 60 批已接 `469f0e8f`（含 writing-days `11619a8c`）。一次一致读取批量提供所有层级的有效设置、来源、子条目和成员，复用同次读取的条目／模板解析及重名计算，不把逐层 LevelGet 简单包成循环。缓存须明确绑定读取快照，不能在同一写事务、import 或 checkout 后读到旧值；保持过滤、排序、继承及跨书隔离。
- **再接外壳**：作者最新 autopilot 手册指定，等上述内核批正式验收合 main，且 F6 原会话交回搜索入口后，整合者从 main 另开独立后台子会话接线；已通知 F6 避免重叠。替换 book::v3::load 逐层 LevelGet，消费批量结果一次及其来源 DTO，移除独立追溯算法；保留外层 frontier 一致性检查。原会话活跃期间不改其工作区。
- **测量和交回**：K1／K2 按作者专门分派，在固定 seed:v3-heavy 分别记录 debug／release 的内核读取或快照完成计时，明确种子生成与打开时间边界，写入 f3-workspace.md。F6 接线批按最新两档规则交全套自动检查与一条主要流程冒烟，写入 f6-shell.md，分别交 handback/k1、handback/k4-0。外壳修复接收后不立即要求 G3／K5 逐项 heavy 交回：等四组与 K6 合齐，由整合者统一安排标准配置下快照可用、打开／滚动测量；优化编译参数的旧数字不能替代统一验收。
- **已核对的代码依据**：外壳 load 仍对每层调用 LevelGet；第 60 批已接内核一次性 `level.list` 和快照内复用，后续结构接线需保持有效值、来源与 frontier 一致；G3／K5 的既有 180／240 秒超时仍保持未过，未因分派而关闭。

### G1 快照历史（11-10，作者直接转交）

已原意转发 G1：待协调第 9 条所需按条目整份快照／恢复，可自行在 dr-workspace 的 v3 命令中新增，带版本守卫，不改已有命令，补永久测试并把快照历史做完，交 handback/k4-g1。快照历史是切换前必须项，帮手写入后靠它撤销；next/ v2.2 冻结，不要求再为其写测试。

G1 原会话已按作者 autopilot 接管安排确认安全停止，34 个未提交文件（含未跟踪内容）完整保存在 `refs/wip/2026-11-10/g1-snapshot-autopilot`；新树 `codex/autopilot-g1-history` 已恢复半成品，原树未动。第 60 批正式接收后已启动 `gpt-6.1-sol`／max 后台接手，日志确认模型与强度；不把 WIP 算交回。

G1 随后确认完整恢复跨 book 与多份 body，拟新增 dr-store 多文档版本守卫及原子持久化 API，不改既有单文档行为／签名；交回须列清新增范围，测试失败、并发、持久化与重开时无部分恢复。已通知 K6：正式接口合 main 后，Agent 首次写条目前先创建完整快照，不消费 WIP；签名和实际接线仍待 G1 交回。

第 63 批后复核 G1 既有待协调 1／2／8：当前公共 EntityLink 不带 module、外壳系统位置链接仍用旧解析器，模块内编辑器未进入完整的全局登记。它们是已定功能的负责方协调，不是待作者设计：K1 已接版本明确的 Entry＋可选 module／Material 链接读写与复制编码，排在正文守卫、隐藏归属修复之后，M14 新接口之前；F6 在素材／最近访问后继续真实挂载实例的登记／释放与 v3_link::Address 消费，区分同正文多标签和库，不另开会话。G1 快照正式接收后再对齐库替换最后 drain 之后的 checkpoint 阶段。条目页布局、重复标题与样式按最新规则暂缓。

后续公共命令接收须和 K6 目录一起核对：K6 为 `entry_snapshot.*`、`material.set_entry_link` 与 M14 四个局部命令增加显式排除，防止带 book 的新增 Spec 被通用规则自动开放；`983289b9` 已于第 65 批与 G1 新增命令同批接收，全套及副屏冒烟通过。K2 为第 63 批局部逆操作新增的 `membership.restore` 自带同一入口的独立排除及拒绝契约，合批时去重，不提前开放。G1 快照读写正式进 main 后，再由 K6 接首次写前创建；拒绝与失败不能留下 journal、结算或部分写入。

第 63 批返修预审还发现局部撤销的两个边界：同一摆放／主归属已被另一写者接管时，旧逆操作不能覆盖它；未知 LoroText／富文本属性等不能经 deep JSON 退化为普通值。K2 在尚未交回的修复上实际复现接管两项失败及原始容器一项失败，正在增加所选原值的完整比较与保真检查；无关标题、pin、其他条目修改继续允许。源日志及外部探针留公共 Git 目录 `integration-evidence/batch-63/undo-refinement/`，与整合者实际运行的原隐藏摆放探针区分；不是第 64 批失败，未提前接收该修复。随后根归属字段本身为非 Map 的路径亦由 K2 实际复现：有 primary 的五种表示会改变原值／版本和 journal；正在将实际键的存在与可恢复性在首次删除前预检，源日志 k2-membership-root-before.log 同处留证。

### G4 接口协调（11-10，作者确认保持边界）

作者在 G4 会话明确选择由整合者安排 F6／G2／K2 补接口；已核对原始回复并直接通知四个会话。分派时 G4 尚未交回；第 60 批已正式接收接口批 `7e2cd7d0`，以下宿主分工继续，不能把 API 接收写成入口完成。

- **G4**：先把搜索／统计可独立编译的公共接口、只读适配和永久契约按协议交成稳定接口批，全套检查后由整合者接收；文档继续区分接口可用与实际入口／真窗口未验收。宿主方等 main 接入后消费，不抄未提交工作区。审阅接口另给明确签名与模块目标。
- **F6／K4-0**：搜索宿主按书版本调用 SearchPanel::new_v3，消费 JumpV3 的 Entry{id,module}／Material 与 line，直接转 Target／open_at，保留 v2.2；核对合法素材目标的导航存在性。不碰已交 G2 的右栏，完成后交 handback/k4-0。
- **G2**：right_body 在 book::nav_target 之前分流，消费 dr_view_stats::v3_panel::panel 及 Scope::{Book, Entry{id,module}, Material}；审阅同样传模块目标，等 G4 面板接口。回调直接转 Target，不把 Entry 当 Book。保持原 G2 队列，交 handback/k4-g2；G1 大纲登记已于第 58 批接收，联合窗口仍由 G2 完成。
- **K2**：补版本明确的 v3 comment.*（正文模块目标与实际读写／重锚路径）、material.*、material_folder.*、book.writing_days／writing_day.record；保持素材夹与条目关系、v2.2 行为及两书隔离。不得只放行 Cx::book 白名单后继续调用旧 Reader／Txn，不从视图绕写 Loro。搜索／字数已由 G4 只读适配，不必先开放旧 search／word_counts。语义不确定仍列 F1/F3 协调，按内核原范围与 handback/k1 分段交回。

- **K2／F6 主页续接（11-10）**：G4 补查的 book.get/update 元数据与 recent.touch/list 已核代码并直接分派。K2 明确 v3 书名、简介、全书／每日目标读取及逐字段写入，保留其他字段、v2.2、撤销和两书隔离；旧 nodes／elements 计数不能当 v3。最近访问保留 entry＋module 的本机目标和旧记录，记录不进撤销。F6 的 touch_front 目前跳过 v3，等 K2 正式接口合 main 后消费；不绕写本机数据库，不退回旧 Book 哨兵。G4 在 M02 记协调并继续模板动作／主页及单本书准备。第 61 批正式接收 `handback/k4-g4` → `ced82326`（只读审阅／素材、主页模板动作、成稿与单书格式 3）和 K2 `handback/k1` → `3a6bbbe5`（含 `879127b4` 批注／素材及主页／最近访问）：全套 2161／0 失败／22 忽略，副屏主流程 43/43、0 pending，实际导出文件与独立导入书核对通过。F6 可消费 recent.touch/list；G2 可消费 v3 审阅 panel 的精确模块目标；G4 续接写入。K6 需按书版本使用 Spec.v3 的输入／输出签名，不能继续以旧共名签名派生目录和 resolver；G1 完整历史正式接收后再接 Agent 写前快照。

- **G4 素材关联续接（11-10）**：G4 已通知追加 `material.set_entry_link(book, material, entry, linked)`，只增删指定素材到条目的内置关联，不改原命令／签名。按作者公共新增接口规则继续；两端同书校验、其他与隐藏关系保留、重复操作／并发／持久重开须有永久契约，正式交回列明。当前仍在实现，不计已接。

- **F6／G4 素材笔记路由（11-10）**：G4 首轮写入冒烟在新建 text 素材后得到 ready 的空 v3 composition，正文为空，无法打开选区批注。整合者已读原始结果（初始 app.info active／visible，未将其当作失败瞬间的环境证明），并核对 main 的 EntryPage 只处理 Entry／Template、Material 落空分支；不是 heavy 等待。已交 F6 修现有路由、真实正文输入／保存／批注入口及跨书保护；G4 不跨改宿主。G4 可先用图片区域完成本批主要流程，但笔记缺口仍待修。F6 搜索 `e5f8d501` 的目标／行号契约不代表 Material 正文已通，整合源证据保留于 `integration-evidence/batch-63/material-routing/`。 G4 另确认 composer 保持 for_prose／for_region 签名，内部按书版本走 named comment.create，v3 捕获稳定 anchor 并消费 K2 来源守卫；原接口正式接收后 F6 才验证真正保存，旧 typed CommentCreate 的 v3 拒绝不能绕过。

接口依据为 codex/k4-g4-book 中 [M06](../modules/m06-search.md)、[M20](../modules/m20-stats.md) 的待协调；各方编译并发 3，整合并发 6。未扩大 G4 的搜索宿主、右栏或内核修改权，progress.md 仍只由整合者更新。


第 65 批期间，为按作者要求减少串行整合轮次，已允许 G2／K5／K6／F6 在各自工作区消费明确 SHA 的正式 handback 依赖并配对自测，不消费 WIP；这些仍是候选，最终组合经整合全套与主流程后才进入 main。第 65 批已接来源守卫、公共投影与 G1 安全历史，写前快照、排空及编辑器登记继续由原负责方完成。

## 监管说明

- 11-09 18:10：K3 为了让全套测试通过，改了冻结的 `dr-mirror` 一行（`897551ac`：链接前的 `!` 一律转义，不再因为前面有反斜杠就跳过，并留下 proptest 种子）。我核过：普通文字里的 `!` 不会被预先转义，前面那个反斜杠只可能是转义过的反斜杠，所以一律转义是对的。这一行同意随 K3 收，不算越界。
- 11-09 18:10：K1+K2 已全部合进 `main`（第 39、41 批）。新开轨道 8 K6（帮手工具通用化），指针 `handback/k6`，范围见 kernel-v3-split.md。

- 11-10：作者定 K4 验收分两档，见 [k4-ui.md](../k4-ui.md)「各组共同的规矩」。每次交回只要全套自动检查加一条冒烟的真窗口场景；逐项场景、截图目检、heavy 测量和样式打磨挪到切换前统一做。数据正确性、v2.2 不受影响、写作手感照旧每次都要有测试。 作者随后在整合会话确认：缺少逐项场景／目检／heavy 不退回；样式差异记待协调。窗口失败先查 app.info／environment，确属遮挡、失活、非前台等干扰时原样重跑一次，保留首轮记录。四组和 K6 合齐后由整合者排统一验收，heavy 等内核载入修复。已通知当前八个负责会话。

- 11-10：作者定三条简化，见 [k4-ui.md](../k4-ui.md)。一、next/ 里的 v2.2 冻结：不再因 v2.2 退回，碰坏的 v2.2 测试可以删（交回里列出）。二、公共地方（`dr_shell::v3` 注册口、`dr-workspace` 的 v3 命令和查询、`dr-doc` 的 v3 读写、`dr-ui` 组件）**只加不改**的小接口，谁需要谁加，整合者解冲突；改已有行为照旧走待协调。三、切换前必须做完的只有四组功能、K6、快照历史、大书性能，Super View、Markdown 文件夹 v3、分享链接、立绘生成、样式打磨都挪到切换后。整合者每轮尽量一批多收几个不冲突的交回，少跑几次全套。

- 11-10 夜：作者睡觉不介入，整合者照 [autopilot.md](autopilot.md) 自己派活、开子会话，一直推进到那里写的终点。

- 11-10 夜（最新，覆盖上面的切换与性能／UI 门槛）：作者允许 `codex/switch-v3` 在全套自动检查、功能与数据正确性验收通过后，由整合者本地合进 `main`，不用等试写一周或再次批准。先打通四组、K6、快照历史、导入与假服务同步往返；性能优化、heavy 测量、截图目检、样式与流畅度打磨暂缓，缺这些不退回、不阻塞切换，统一记后续。输入、保存、恢复、导航、并发写入、素材路径和跨书隔离等正确性照旧，丢字、数据丢失或覆盖、功能未通照旧修完再收。每次交回仍跑 fmt、Clippy、测试、xtask、public，加一条主要流程的真窗口冒烟；其他禁止事项照旧。当前标准见 [k4-ui.md](../k4-ui.md) 和 [autopilot.md](autopilot.md)。

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
| 11-09 21:07 | `handback/k5` → `a431cf7b`（第四十六批：叶子模板编辑器） | `bbf0158f` | 并发 6、测试单线程；fmt、Clippy、test（2047 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过；真窗口 115/115 步、0 pending，三图已目检。只合九语键组冲突并重生成；层级／动作／帮手说明和标准 debug heavy 加载仍待。 |
| 11-09 21:38 | `handback/k5` → `3049697a`（第四十七批：层级模板、设置、动作及帮手说明） | `8ff78d05` | 并发 6、测试单线程；fmt、Clippy、test（2050 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过；真窗口叶子 122/122、层级 139/139 步，均 0 pending，六图已目检。无冲突修补；K6 公共接口与标准 debug heavy 加载仍待。 |
| 11-09 21:59 | `handback/k4-g3` → `ba3406a8`（第四十八批：摆放、时间钉、泳道颜色） | `e5e71b20` | 并发 6、测试单线程；fmt、Clippy、test（2052 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过。窗口 45/45；摆放首次长度等待超时，唯一隔离复跑 89/89、0 pending，六图已目检，按既定重跑规则接收。无冲突修补；公共树拖动与 heavy 仍待。 |
| 11-09 22:24 | `handback/k4-g2` → `36d48818`（第五十批：四种层级显示器） | `ef6c1ffa` | 并发 6、测试单线程；fmt、Clippy、test（2056 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过。真窗口 52/52 步、0 pending，看板位移 40 × 80 px 核对通过，五图已目检。仅合注册入口冲突并保留 G3；层级设置、大纲／拖动、选择器和 heavy 仍待。 |
| 11-09 22:44 | `handback/f6` → `a9115af6`（第五十一批：层级设置区接口） | `166f8a80` | 并发 6、测试单线程；fmt、Clippy、test（2057 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过。旧场景首次空底栏断言失败，与已接 G3 对齐后窗口 49/49、52/52，均 0 pending，八图及坐标校验通过；无产品修补，G2 控件另批。 |
| 11-09 23:02 | `handback/k4-g2` → `d2ddab9f`（第五十二批：层级设置与大纲接口） | `6bfa5a35` | 并发 6、测试单线程；fmt、Clippy、test（2061 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过，无重跑。窗口 52/52、103/103，均 0 pending，两项坐标脚本及九图目检通过；只合初始化登记冲突。大纲联合验收／拖动／选择器／heavy 仍待。 |
| 11-10 00:32 | `handback/k6` → `5d664e62`（第五十七批：通用目录、结构说明、模板指导及退回修复） | `5cfb294c` | 并发 6、测试单线程；fmt、Clippy、test（2083 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过、无重跑。原探针 1 项与七项永久保护通过，无冲突修补；第 53、54 批关闭，G1／G3 返修保持。 |
| 11-10 01:10 | `handback/k4-g1` → `3278b584`（第五十八批：模块、正文、通览、链接及并发修复） | `cd7dac1f` | 并发 6、测试单线程；原补丁探针与永久回归通过，fmt、Clippy、test（2112 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过。十场窗口最终 563/563 步、0 pending，35 图目检；控件／正文／链接各原样隔离复跑一次通过，首轮失败保留。无冲突修补，第 49、55 批关闭；快照历史与 heavy 仍待。 |
| 11-10 01:36 | `handback/k4-g3` → `c611c8de`（第五十九批：隐藏绑定与失败草稿） | `5d8541b2` | 并发 6、测试单线程；fmt、Clippy、test（2118 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过，无重跑。适配拒写断言的原隐藏 pin 探针与六项永久契约通过；窗口 45/45、89/89、50/50，共 184 步、0 pending，十图目检通过。第 56 批返修关闭；heavy、局部命令与公共树拖动仍待。 |

| 11-10 02:41 | `handback/k1` → `469f0e8f`、`handback/k4-g4` → `7e2cd7d0`、`handback/f6` → `48184963`、`handback/k4-0` → `d2c0c918`（第六十批：结构／写作日、搜索统计接口、副屏与导航） | `236196de` | fmt、Clippy、test（2136 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过，Rust 无重跑；主流程冒烟 58/58、0 pending。副屏原生定位另验 18/18 首次／重启通过，整合后处理的相对坐标误判记录保留。只解九语追加键冲突，G2 导航阻塞关闭；G1 历史／宿主续接，性能与 UI 打磨按最新规则暂缓。 |
| 11-10 03:21 | `handback/k1` → `3a6bbbe5`、`handback/k4-g4` → `ced82326`（第六十一批：批注素材、主页与整书往返） | `f3709422` | fmt、Clippy、test（2161 通过／0 失败／22 忽略）、xtask／审计、public 及附加检查全过；标准 debug 副屏冒烟 43/43、0 pending，Word 内容和格式 3 独立导入书核对通过，无重跑。只合九语追加键；F6／G2／G4／K6 续接宿主与版本签名，G1 历史子会话继续。 |
| 11-10 06:30 | K2 `5ad94846`、K6 `983289b9`、G4 `a26dafd9`、G1 `82fca0b4`（第六十五批：正文来源守卫、工具投影、全书写入、完整历史安全阶段） | `282587bb` | 并发 6／测试单线程；fmt、Clippy、test（2227／0 失败／22 忽略）、xtask 含审计、public 及附加门禁全过。原第 62 批探针 1/1，注册表／目录原生成器 5＋1 项通过；副屏 23/23、16/16、72/72，均 0 pending。首轮整合 profile 超 32 字导致启动回退、桥未匹配，作为配置错误留证；更正合法新 profile 后同源码／同场景通过，不冒称环境原样复跑。仅解批注相邻分支、九语追加键与文档冲突；G1 排空／登记、K6 写前快照、搜索／素材宿主和导入回滚继续。 |

## 退回

整合者在这里记：时间、指针、原因和复现、退给谁。

| 时间 | 指针 | 原因 | 处理 |
| --- | --- | --- | --- |
| 11-09 03:13 | `handback/k1` → `3f20c049`（第三十四批） | 全套检查通过（1920 通过／22 忽略／0 失败），但违反本页 K1 第 4 条：`dr-model/src/kind.rs::EntityKind::may_be_linked` 新放行既有 `Material`，改变 v2.2 正文链接及旧导入行为。临时 Rust 程序打印 `dr_model::kind::EntityKind::Material.may_be_linked()`，main `fb506d26` 为 false、候选为 true。 | 退 K1：保留 v2.2 原行为，把 v3 所需扩展限定到 v3 路径，补兼容契约并同步 main 后重交。整合者不代改功能；候选保留在 `codex/batch-34`，当时未合 main。**已由 `dd39c0bd` 修正，第三十六批接收。** |
| 11-09 03:13 | `handback/k1` → `72734432`（第 3 步续交） | 仍含上条未修的行为变化；新增 `next/crates/dr-index/tests/library.rs`，不在分轨给 K1 的 crate 列表（dr-model / dr-doc / dr-store / dr-testkit / dr-workspace）内。 | 退 K1：把跨层契约放到已授权的 dr-testkit 等合适位置，连同上条一起修后重交。此次先按范围退回，未合候选、未冒称已跑过这个续交 SHA 的全套检查。**已由 `dd39c0bd` 撤回 dr-index 改动，第三十六批接收。** |
| 11-09 03:28 | `handback/track4` → `c719a76d`（第三十五批：M37） | 全套检查通过（1905 通过／22 忽略／0 失败），但超出本页轨道 4 第 2 条的 dr-shell「只限挂账号入口」：`settings/store.rs` 新增持久化账本并修改 set/reset/快捷键写入，`settings/mod.rs` 新增同步回调与快捷键应用，`settings/registry.rs` 新增同步范围标记。`git diff e4722faa..c719a76d -- next/crates/dr-shell/src/settings` 可见范围。 | 退轨道 4：按夜间范围收敛共享改动，或把必要的 settings 接线单列为待协调，等作者明确范围后重交。旧 M37 任务书允许最小注册表标记，但本页更窄，整合者不自行扩大；候选保留 `codex/batch-35`，M35 已接成果不受影响。 **已由 `5c777ca8` 收敛，随 `8275c95f` 在第四十批接收。** |
| 11-09 14:10 | `handback/k1` → `dd39c0bd`（已在第三十六批合进 main） | 监管审查：默认层级和默认分类用写死的 id（`dr_doc::v3::novel::NovelRootEntries::new()`：`root-manuscript`、`cat-character`……），模板正文文档 id `template:<模板>/<模块>` 不带书 id；`loro_doc.doc_id` 是全库主键，两本书会共用 `body:root-manuscript/about` 和 `template:tpl-chapter/mod-prose`，彻底删除一本书会删掉另一本的文档。dr-testkit 的 v3 种子、K3 的样书（两本书进同一个库）都踩在上面。 | 退 K1：照 kernel-v3.md「文档 id 在整个库里唯一」改，加两本书同库、删一本另一本不少的测试，再做第 5、6 步。K3 后半段 `handback/k3` → `67ccafc7` 先不收，等 K1 修完合进 main，K3 改用模板返回的根 id 后重交。 **K1 已由 `a1ac3c24` 修正，第三十九批接收；K3 适配重交 `d28e911d` 已在第四十二批接收。** |
| 11-09 14:05 | `handback/track4` → `5c777ca8`（第三十七批；最新 `e657622e` 的同步实现未变） | 常驻整合候选 `8c1e429e` 的绝对路径素材探针失败：`sync_once` 返回 `Ok`、`downloaded_assets: 1`，库外合成稿件 `synthetic-manuscript-source.txt` 被删除。`engine.rs` 把远端 `asset_id` 拼进暂存路径，绝对路径越过库边界，下载覆盖后又被暂存清理删除。在候选 `next/` 运行 `CARGO_BUILD_JOBS=6 cargo test -p dr-sync --test integrator_absolute_asset --locked -- --nocapture`，0 通过／1 失败（退出码 101）。 | 退轨道 4：同步入口只接受合法素材 id，拒绝绝对路径、正反斜杠及其他不合法路径形式；在任何素材查重、下载、写入、清理前校验。把探针改写成自己的永久回归，断言拒绝并且库外文件仍存在、原字节不变；同步 main、全套检查后重交。第 37 批和含同一缺陷的 M43 续交均未接收；整合者不代修，临时探针不进 main。探针备份在公共 Git 目录的 `integration-evidence/batch-37/integrator_absolute_asset.rs`，可复制到自己分支的同名 tests 路径复现。 **已由 `9af4892b` 修正，永久回归与原探针通过；第四十批接收 `8275c95f`。** |
| 11-09 22:03 | `handback/k4-g1` → `d85ee968`（第四十九批：模块渲染器） | 并发情节格探针在候选 `29a3cf54` 第一轮失败：同一网格两个不同格子的 `v3::write` 都返回 Ok，A 格 `synthetic A 0` 已被覆盖为不存在；0 通过／1 失败，退出码 101。`dr-view-plot/src/v3.rs` 先读整网格、改一格，再无版本守卫调用 `module.put_grid`，另一次成功提交会被旧快照覆盖。复现：在候选 next/ 放入临时探针后运行 `CARGO_BUILD_JOBS=6 cargo test -p dr-view-plot --test integrator_grid_concurrent --locked -- --nocapture`。 | 退 G1：不能把已证实的数据覆盖只列为 K2 待协调。消费已有 `Workspace::observe`／`call_guarded` 的 book 版本守卫，或协调原子逐格命令；发生冲突时拒绝旧写入并保留作者编辑，不能静默成功。把两个独立成功写入不得相互覆盖改成自己的永久契约，覆盖不同窗口／帮手并发；同步 main、全套检查和窗口验收后重交。临时探针及日志保存在公共 Git 目录 `integration-evidence/batch-49/`，不提交进 main；本批未继续全套检查或窗口验收，不能套用轨道交回的 2055 项结果。 **已由 `3278b584` 修复，第五十八批全套与窗口验收后接收，退回关闭。** |
| 11-09 23:14 | `handback/k6` → `a4603663`（第五十三批：目录与结构说明） | 候选 `c8db0af9` 的 Agent 时间线探针失败：先回收带摆放的条目，经过 `AgentTools::invoke` 读取时间线、仅改名称并整份 put，返回 Ok，底层 placements 从 4 条变成 3 条；恢复条目后原摆放仍缺失。`coverage_v3` 把过滤后的 `timeline_view.list` 授予整份覆盖，CAS 不能补回从未读到的数据。复现：把临时探针放到 dr-agent-tools/tests 后，在 next/ 运行 `CARGO_BUILD_JOBS=6 cargo test -p dr-agent-tools --test integrator_hidden_timeline --locked -- --nocapture`；0 通过／1 失败、退出码 101。 | 退 K6：过滤后的查询不能授权整份替换。至少像已接 G3 一样在存在未显示 lanes／placements／pins 时拒绝 whole-view put，或协调完整影响读取／局部命令，不能静默删除保留数据；新增永久回归覆盖回收、改名、恢复及隐藏成员，重新全套检查后交回。探针及日志保存在公共 Git 目录 `integration-evidence/batch-53/`，不进 main。fmt／Clippy 与 public／附加检查通过；完整测试因已证实数据丢失中止，xtask 和窗口未在候选运行，不套用源分支 2065 项结果。 **已由 `3dff4958` 修复，第五十七批接收 `5d664e62`；原探针及七项永久保护通过，全量 2083 通过／0 失败／22 忽略。** |
| 11-09 23:31 | `handback/k6` → `20dbf687`（第五十四批：第三步续交） | 第 53 批问题未修：与 `a4603663` 比较，resolve_v3.rs、executor.rs、catalog.rs 契约及底层 v3/timeline.rs 的 Git blob 完全相同；dr-agent-tools 只有 structure.rs 的说明测试新增，没有隐藏摆放回归。第三步小说说明及运行时接线不改变已复现的数据删除路径。复现沿用上行的 `integrator_hidden_timeline` 命令和第 53 批失败探针，本批没有重新运行或声称得到新测试结果。 | 续交不收，先按第 53 批要求修复隐藏 lanes／placements／pins 的整份覆盖保护、补永久回归、合最新 main 后重新全套交回。代码一致性机器记录在公共 Git 目录 `integration-evidence/batch-54/`；未试合产品、未跑候选全套／窗口，不套用源分支 2076 项结果。main 仅更新退回记录。 **已由 `3dff4958` 修复，第五十七批接收 `5d664e62`；原探针及七项永久保护通过，全量 2083 通过／0 失败／22 忽略。** |
| 11-09 23:43 | `handback/k4-g1` → `537b3fc1`（第五十五批：网格修复及通览／链接续交） | 候选 `a541b1a9` 的真实 GPUI 补丁控件探针失败：作者只改标题并保持焦点，Agent 成功保存新正文，显式 reload 后标题失焦保存无错误，却把正文从 `new external body` 覆盖回 `old body`。Patches::save 将旧 UI 标题／正文一起无守卫调用 PatchPut。把临时 `integrator_patch_probe.rs` 附到 dr-view-elements/src/element/patches.rs 末尾，在 next/ 运行 `CARGO_BUILD_JOBS=6 RUST_TEST_THREADS=1 cargo test -p dr-view-elements --lib integrator_patch_probe --locked -- --nocapture`；0 通过／1 失败，1.70 秒、退出码 101。 | 退 G1：使用与原读取对应的版本守卫或真正字段级命令，冲突保留草稿；不能保存前取新版本却提交旧 UI 值。补永久回归覆盖仅标题／仅正文与外部更新、冲突和显式重试，核对其他整份写入，重新全套／窗口后交回。原第 49 批网格探针现为明确 Conflict；永久网格 20 项通过，网格问题已验证修复。临时探针及日志留公共 Git 目录 `integration-evidence/batch-55/`，已还原产品字节、不进 main；本批不继续全套／窗口，不套用源分支 2076 项。已按作者授权直接通知 G1 会话。 **已由 `3278b584` 修复，第五十八批全套与窗口验收后接收，退回关闭。** |
| 11-09 23:48 | `handback/k4-g3` → `ba3406a8`（已合代码，第五十六批返修复核） | 在 main `fb75b6bb` 的隔离 worktree 用真实 Timeline 控件复现：新条目只有 pin 绑定、没有 placement；回收后 lanes／placements／pins 数量都不变，但查询 pin.entry 为 null、原始绑定仍在。执行泳道重排成功后，恢复条目，原始 pin.entry 也变 null。edit_view 的数量比较漏掉字段投影。复现：放入 dr-view-timeline/tests/integrator_hidden_pin.rs，在 next/ 运行 `CARGO_BUILD_JOBS=6 RUST_TEST_THREADS=1 cargo test -p dr-view-timeline --test integrator_hidden_pin --locked -- --nocapture`；0 通过／1 失败、2.01 秒、退出码 101。 | 返 G3：检查原始与有效数据内容，保护投影隐藏的绑定／字段，或协调局部命令；同时核对时间钉编辑。补数量相同但绑定被隐藏、改名／泳道操作、恢复后绑定保留及原隐藏成员／并发保护的永久回归，全套和相关窗口后重交。已直接通知对应会话。第 45、48 批历史不回滚，main 当前保留此明确待修问题；临时探针与日志在公共 Git 目录 `integration-evidence/batch-56/`，不进 main，本批不跑新产品全套／窗口。 **已由 `c611c8de` 修复，第五十九批全套及窗口验收后接收；绑定保留、失败草稿可重试，返修关闭。** |
| 11-10 03:32 | K1 `3a6bbbe5` 的已接代码（第六十二批返修复核） | main `229b5138` 的真实 v3-tiny 探针确认：保存 book＋body 旧观察后正文前插，book 版本不变；带旧 guards 调 comment.create(range) 仍返回 Ok 和 journal，引用由原选中文字变为新插入文字。cx.prose_view 未校验只读 body 版本，书写只校验 book。0 通过／1 失败、0.07 秒、退出码 101。把公共 Git 目录 integration-evidence/batch-62/comment-guard/integrator_comment_read_guard.rs 放入 dr-testkit/tests，在 next/ 运行 `CARGO_BUILD_JOBS=6 RUST_TEST_THREADS=1 cargo test -p dr-testkit --test integrator_comment_read_guard --locked -- --nocapture`。 | 返 K2：在同一次正文 holder 读取内验证来源版本，再生成 anchor／quote／snapshots；原 range、block_id、reanchor 与 G4 新 anchor 分支共用规范帮手，读后并发编辑须保留原稳定身份或拒绝，不能取新版 frontier 授权旧范围。补永久回归、全套后重交。已通知 K2／K6／G4；K2 暂存 M14 优先修，K6 暂不开放无保护锚定写入。第 61 批历史保留，main 当前有此明确待修项；临时探针经字节核对已移出工作树，不进 main。  **已由 `5ad94846` 修复，第六十五批原探针、永久契约、全套与主流程通过后接收，返修关闭。** |
| 11-10 03:38 | F6 已接 v3 Material 路由（第六十三轮功能复核） | G4 真窗口 book-writes-v3 首轮新建 text 素材成功，page.text 却 ready=true、source=v3、sections=[]、text为空，选区批注在 step22 失败。整合者检查原始 environment 及 main EntryPage 的 Material 空分支，未自行重跑窗口；源证据原件在 integration-evidence/batch-63/material-routing/，可用 G4 的原场景复现。 | 返 F6：将文本素材送入真实正文编辑器，准确持有 material 文档，验证输入保存、选区批注、焦点和跨书隔离；G4 不改已有宿主。搜索 e5f8d501 的3项目标／行号契约在整合通过，但不等于笔记正文通过。F6 修复另正式交回；不因图片区域冒烟通过而关闭此项。  **第 66 批前置候选 `3e9f6fbb` 已由整合者实际运行原 book-writes-v3 28/28、0 pending，保存后读回唯一批注、精确素材目标与实际源文前四字；全 PID 副屏、无重跑。最终组合全套待完成，本项暂不关闭。** |
| 11-10 03:49 | `handback/k4-g2` → `c54fda05`（第六十三批；内核归属清理由 K2 返修） | 候选 `80f7ee12` 的 Tiny 探针：条目 E 同属可见 A 与泳道 B，B 的视图保存 at=41／span=7；回收 B 后原始摆放仍在。按 G2 Mutation 同一 book guard 取消 A，membership.remove 返回 Ok＋journal，但原始 placements 变空，恢复 B 后仍空。0 通过／1 失败、0.26 秒、退出码 101。公共 Git 目录 integration-evidence/batch-63/hidden-membership/integrator_hidden_membership.rs 复制到 dr-testkit/tests 后，在 next/ 跑 `CARGO_BUILD_JOBS=6 RUST_TEST_THREADS=1 cargo test -p dr-testkit --test integrator_hidden_membership --locked -- --nocapture`。 | 本批不合：K2 removals 以过滤后的归属清理所有原始视图，须只影响本次取消真正造成的孤立摆放，保留早已隐藏／无关记录并核对撤销。K2 当前正文守卫批先完成，随后优先修此项；G2 自有操作入口补永久回归、消费正式修复后全套重交。已直接通知两方。临时探针移出树；首轮 BookId import 编译错误另存，不冒充数据失败。fmt 与附加检查过，Clippy 中主动停止，完整 test／xtask／窗口未跑；不能引用源 2145 项当整合通过。F6 搜索 e5f8d501 保留另批，整合者不代修内核。 |
| 11-10 05:08 | `handback/k4-0` → `e5f8d501`（第六十四批搜索入口；索引刷新由 G4 返修） | 冻结候选 `e224681c` 全套 2177／0 失败／22 忽略及所有门禁通过，K6 副屏 16/16；原搜索 60 步在 step49 等素材正文行号超时（null，不是 1），未取到失败瞬间环境，不归因环境。单独诊断命中正常，不冒称原样复跑通过。F6 随后实际 GPUI 探针证明：延后索引时面板先得空，显式 reindex 后直接查询已有命中，面板仍为空；0/1 失败。探针和源日志原件在 integration-evidence/batch-64/search-index-race/，由 F6 执行，非整合者运行。 | 本批搜索不合，直接交 G4 修 SearchPanel 索引事件刷新，保留当前查询与书身份、补永久回归并全套重交；F6 不跨改搜索视图，原 60 步断言不放宽。复现：把所存 v3_search_index_probe.rs 作为 dr-shell/tests/v3_search_index_probe.rs，在 next/ 用 `CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1 cargo test -p dr-shell --test v3_search_index_probe --locked -- --nocapture`。原候选和后续合批草稿 e8c2b61a 保留，第 65 批另收无关正文守卫／K6／G4 写入／G1 历史；搜索和素材宿主等修复合批。  **第 66 批前置候选 `3e9f6fbb` 已由整合者实际跑原搜索 60/60、0 pending、无重跑，所有应用副屏且已退出；最终组合全套待完成，暂不关闭。** |
| 11-10 06:30 | G4 搜索修复 `f83d8c16`（第六十六批前置复核） | G4 自有 GPUI 永久测试实际失败：同书无关素材完成索引后，搜索结果完全相同，选中却从 Hit(1,0) 回到 Hit(0,0)，Enter 会换目标；0/1 失败。原日志与来源说明保存在公共 Git 目录 integration-evidence/batch-66/search-selection/，由 G4 执行，不冒称整合者运行。复现：`CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1 cargo test -p dr-view-search --test v3_live same_book_unrelated_index_preserves_the_selected_destination --locked`。 | 已直接退 G4；要求同结果保持选择／位置，改变结果仅唯一精确匹配保留，缺失／歧义不自动跳别处。正式修复 `b099ba30` 已交回，12 项定向与源全套通过；原 60 步待与 F6 宿主组合，不提前关闭。  **整合者在 `3e9f6fbb` 原搜索 60/60 已通过，最终全套待完成；前置原件在 `integration-evidence/batch-66/search-material-preflight/`。** |
| 11-10 06:30 | G2 在途组合 `cd3a526a2` 的既有格式 3 导入（第六十六批前置复核，修复归 G4） | G2 全套在 `dr-export/tests/book_file_v3.rs:356` 失败：损坏 genesis 导入返回 Err 后多一个新 book 文档，原文档仍在；原二进制整文件第 10 轮再次失败。复现：`CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1 cargo test -p dr-export --test book_file_v3 v3_import_rolls_back_prose_if_the_book_genesis_is_damaged --locked -- --exact --nocapture`，或原二进制整文件单线程运行。原红、G4 受控红绿及来源说明在 integration-evidence/batch-66/import-rollback/；均为源会话执行，根第 65 批同项曾通过，不能以此清除偶发缺陷。 | 已直接交 G4：错误退出跳过同步 close，回滚 purge 可能遇未释放 holder，清理错误被忽略；G4 用 append_faults／通道 gate 得到 0/1 红与修后 5/5 绿，仍待完整契约和正式全套交回。G2 有界循环已停止，保留原失败、等正式修复配对；不删 v3 断言，不以一次绿放行，不跨改其他组。 |
| 11-10 07:18 | G4 `39416a46` 与 main 第 65 批 G1 完整快照的组合（第六十六批） | G4 将整合者准备的 Tiny 交叉探针改为永久 `dr-export/tests/book_file_v3_snapshots.rs`，实际得到 0/1 失败、0.32 秒、退出 101：两正文快照随格式 3 导入新书后，`entry_snapshot.list` 长度为 0，预期 1；源书及第三书的 inventory／head／原始值／正文保护断言先通过。归档未重映射 `entry_checkpoints` 清单中的书、条目、正文及历史版本。复现：在 next/ 运行 `CARGO_BUILD_JOBS=3 cargo test -p dr-export --test book_file_v3_snapshots --locked -- --nocapture`。源红与来源说明在公共 Git 目录 `integration-evidence/batch-66/snapshot-archive/`，由 G4 执行，根未运行该次。 | 第 66 批暂不合 main，已直接交 G4 修复归档的历史身份／版本／校验；补 list、preview、restore、重开及源书／第三书隔离契约，保留原红并全套重交。只增加必要共享纯数据接口，不改 G1 既有命令行为，不用放宽清单过滤假通过。原导入失败回滚已正式交回 `39416a46`，不将该修复等同于本项通过；其他组自身检查继续，最终组合统一复验。 |
| 11-10 07:33 | F6 `8cfdd74e` 与 G4 真实 v3 Home（第六十六批前置复核） | F6 永久 GPUI 契约挂载正式 v3 Home，正常换库、作业失败恢复、额外 holder 释放后重试三项均因 `other clones of the workspace are alive` 失败，0/3；`let_go_of_library` 只清旧 home，未清持有 Workspace 的 v3_home。复现：在 next/ 运行 `CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1 cargo test -p dr-shell --test v3_home_release --locked -- --nocapture`。源红绿和来源说明在公共 Git 目录 `integration-evidence/batch-66/home-release/`，由 F6 执行，根未运行；G1 旧 8 项失败中只有 4 项属于此路径，其余来源断言另行处理。 | 已直接交 F6 修现有释放路径，保留真实 Home／失败恢复／重试契约。仅释放 v3_home 后源三项转绿，仍待正式全套及主流程交回；第 66 批最终组合再验，不提前关闭，不改 G1／G4 行为。 |
