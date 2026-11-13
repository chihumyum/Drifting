# K5 模板编辑器

范围按当时 K4 的开工细则（[k4-ui.md](../k4-ui.md) 改写前的版本，在 git 历史里），交回按当时的
夜间队列协议（`handoff/overnight.md`，已随过程文档清理删除，在 git 历史里）。原型为
[第 2 版](https://claude.ai/artifact/Q9cfuRn9u5T5vZ38qG1JU7)。

## 统一模板（内核 v4）

`dr-view-templates` 是独立的界面 crate。应用登记 `init`，通过
`v3::add_template_creator` 消费左栏的新建入口，通过 `pages::add_page_view`
消费 `Target::Template`。内核 v4 合一后不再有层级模板／叶子模板两套形态：
「新建模板」直接打开编辑器，页头不再显示类型徽章。

任何模板都可改名称、记号和颜色，添加任意模块——正文（可多篇、分别命名）、
下面的条目（`children`，可调整在稿纸中的位置）、键值表、补丁、情节规划、关联，
以及九种字段。每篇正文模块带有独立的「计入字数和导出」（`in_book`）开关；
模板带「名字参与自动链接」（`linkable`）开关。模块由砂笔握柄拖动排序，删除只移除定义。
新模块和字段用稳定 id，排序使用 F1 的位置键，通常只改变被移动模块的键。
并发插入留下相同位置键时重新分配顺序；挪动失败不会丢掉模块。
单选／多选的选项逐行填写；修改字段类型保留未改的配置和已有条目的值。

编辑器保留一份草稿，按「保存」通过 `entry_template.put` 提交。保存前重读模板，
三方合并未修改的远端属性；同一属性发生冲突时保留草稿并报告冲突。
写入使用书目的 `WritePreconditions`，不把过期快照无条件覆盖回去。
视图跟随外壳书快照，后台刷新保留尚未保存的输入和输入法组合。
新建成功后等待外壳读到模板，再打开模板标签。

记号使用外壳已经映射的砂笔集合。未知记号显示通用方印；未主动换记号时，
保存仍保留原字符串。颜色与所有未编辑的模块配置也一并保留。

## 默认「层级」开关、「下面」的设置与帮手说明

模板带默认的「层级」（`level`）开关，配一行小字说明「打开后下面能放条目」。
该开关只决定用此模板新建的条目初始是否打开「层级」，改它永不追溯已有条目。
开关打开时，编辑器展开「下面」的八项设置与动作声明；开关关闭时收起这两块，
但保留已填的 `settings` 和 `verbs` 不清空（已有打开了「层级」的条目仍按这些设置解析）。

八项设置（默认模板、显示、自动链接、收别处的条目、新条目住在、成书、格式快捷输入、泳道）
分别保存模板的覆盖值。前七项点击「还原」删除覆盖以继续从祖先继承；「泳道」（`settings.lane`）
不继承，未覆盖时不标「继承」，有显式值时点击「还原」回到 `None`（默认关）。
默认模板的「无」和住处的「这一层」是显式空值，与继承不同。
三方合并保留这些区别，包括同一设置表里有其他并发修改的时候。

显示可选列表／网格／看板／岛屿，格式快捷输入使用内核的 full／notes／plain。
泳道打开时「收别处的条目」的有效值为开且不可操作，但保留作者原先的覆盖值；
关闭或还原泳道就回到该覆盖值或继承。新条目住处从当前书的层级中选择。
设置名换行、还原按钮在行尾，避免窄稿纸上压住控件。

动作由稳定 id、作者名称和目标模板组成，目标可从书内未删除的模板中选择。
未选目标、目标已删除、名称为空或 id 重复的草稿不能保存；保存前重读后也会校验。
保留已有动作的描述和位置，描述不当作可执行代码。动作工具的生成和执行归 K6，
本页只编辑通用声明。

所有模板都可编辑帮手名字、一句说明、注意事项和每个模块一句说明。
不会填入自编的默认指导文字；新增的界面标签在 `dr-i18n/own` 九种语言中维护
（已移除退役的 `leaf`、`leaf_template`、`level_template`）。
修改模块说明保留已有的 writable／read_tier，新出现的模块指导保留默认可写权限。
「帮手看到的」的公共结构预览消费见下节；书内指导不会从应用内置模板回填。

## 公共结构预览

本段消费 K6 提供的公共薄包装；接口不来自未交回的 WIP。

K5 捕获外壳所给的书 id、`BookV3.revision` 和整份当前草稿。后台先按这一精确
frontier 读取独立历史副本，再 fork 成可编辑的临时文档；只在该副本覆盖草稿定义。
投影使用 K6 的 `StructureContext::from_v3_view` 和
`TemplateSummary::from_v3_template`，前者收到的版本来自同一临时文档的真实 frontier。
新建／未使用模板单独返回模板投影（含 `level`、`linkable`、`lane` 与模块能力）及
计入成书的正文模块列表（`book_prose_modules`），保留模板和模块 id，不伪造条目来让模板进入在用列表。
当草稿默认「层级」打开时另列 `level_defaults`（含 `lane`）和 `declared_actions`；
在用层级的有效值与来源由同一快照的 K6 投影提供。

结果是带来源 frontier、临时 frontier、模板与书结构的可访问 JSON 文本。
书结构与单模板都按作者原文投影，保留模块 writable／read_tier 与规范来源 DTO；
显式空值与继承仍分开。投影不获得读取覆盖，不访问正文，也不注册动作执行器或发送运行时请求。
预览本身不改变模板、正文、隐藏字段、书目 frontier 或运行时结构；运行时仍读已保存定义。

视图后台任务按书、frontier 和完整草稿匹配后才发布，关闭预览时取消待处理任务。
输入事件已改变草稿而下一帧尚未调度时，旧完成回调也会拒绝过期结果。
换书时先按宿主书 id 隔离：另一本文档即使用相同内置模板 id，也不会合进当前草稿。
现有输入控件、输入法状态和焦点不因预览加载而重建。

## 验收来源

- `next/crates/dr-view-templates/tests/contract.rs`：共享 tiny v3 种子上的真实
  F3／SQLite 契约。覆盖全部模块与字段类型（含 `children`）、多篇正文及每篇独立 `in_book`
  对成书序列的控制、`linkable` 对自动链接参与和重名校验的控制、默认「层级」开关收起保留
  设置且永不改动已有条目、八项「下面」设置（含 `settings.lane`）及可空设置还原合并、
  动作校验、删除后正文与字段值保留、并发互不相干修改合并与冲突拒绝，以及未知记号保留。
- `next/crates/dr-cli/scenarios/k5-leaf.json`：v3-lite 副屏真窗口输入路径，
  包括直接新建模板、`linkable` 与每篇正文 `in_book` 开关、两篇正文、「下面的条目」与全部模块
  及九种字段、真实鼠标拖动、删除、并发刷新和重开。
- `next/crates/dr-cli/scenarios/k5-level.json`：v3-lite 副屏真窗口统一模板回归，
  核对默认「层级」开关小字说明、任意模块可加（含正文与「下面的条目」）、八项设置（四种显示、
  `settings.lane` 的强制接收与还原）、收起「层级」保存仍保留设置与动作、动作添加／改名／删除／
  缺目标拒绝、帮手说明与 `book_prose_modules` 预览、逐项还原及显式空值；退出并重开核对持久化。
- `next/crates/dr-view-templates/src/preview.rs` 与 `src/view.rs`：精确历史 frontier、
  未使用／在用草稿、`book_prose_modules`、`children` 模块能力、默认「层级」收起与展开投影、
  同名模块 id、规范层级来源、晚到结果、跨书及正文／隐藏字段隔离的永久测试与 GPUI 宿主测试。
- `next/crates/dr-cli/scenarios/k5-shared-preview.json`：公共结构预览的副屏冒烟。
  直接新建未使用模板，输入模板和模块说明，先预览并断言真实模板列表不变，再保存、预览与重开。
  场景显式关闭主动模型建议，不配置或调用模型。

```bash
cd next
CARGO_BUILD_JOBS=3 cargo build -p drifting -p dr-cli --features drifting/debug-bridge --locked
CARGO_BUILD_JOBS=3 cargo drifting workspace scenario crates/dr-cli/scenarios/k5-leaf.json \
  --app target/debug/drifting
CARGO_BUILD_JOBS=3 cargo drifting workspace scenario crates/dr-cli/scenarios/k5-level.json \
  --app target/debug/drifting
```

## 待协调

- K6 公共结构预览消费已接；K5 不新建动作执行器，不将未保存草稿发送运行时。
- **历史记录，按新规暂缓、不作为本轮阻挡**：v3-heavy 的初始书快照曾在模板页挂载前超时。
  `window-bench.py leaf` 使用共享 heavy 种子并预建索引，仍在
  `ui.wait` 的 240 秒内未得到书快照；`state.get` 的 `book.loaded = false`。
  原生采样停在 `dr_shell::book::v3::load → LevelGet → level_settings →
  entries_map → resolve_autolink_name_conflicts → resolve_level_settings`。
  当时未越界修改外壳／查询层；日志和采样在忽略目录
  `next/target/k5-heavy-sample.txt`；这组标准 debug 运行没有生成打开／滚动数字。
  基准脚本保留在本 crate，后续可在同一个合成 profile 上重跑前后两次。

## 第一次交回

分支 `codex/k5-templates`，交回指针 `handback/k5`。本段只交叶子模板。
实现提交 `405cbd05`，相同排序键、保存时的书上下文校验及验收接线修正
在 `22473d18`；已同步 main `27806732`，含 K4-0 两次交回。

编译并发 3。`cargo fmt --all --check`、全 workspace Clippy
`--all-targets --locked -- -D warnings`、全 workspace test
**2045 passed / 0 failed / 22 ignored**、`cargo xtask check`（含 audit，
0 vulnerabilities）与根目录 `pnpm public:check` 通过。
xtask 保留既有 14 份过期测量提示及 12 项审计通知。
新 crate 的 6 条契约均通过；没有修改原 v2.2 的行为。

`k5-leaf.json` 在 v3-lite 真窗口 **115/115 步、0 pending**，三张截图已逐张目检。
初次全量测试曾被文案使用扫描器拒绝分组别名导入，改为仓库已有的独立别名写法后
重跑全套通过；首次窗口场景也修正了 macOS 下拉框角色及换书后的等待。
上述统计均来自修正后的运行，失败日志留在忽略目录，不把它们算成通过。

heavy 的视图基准使用额外的优化开发版，命令如下；默认构建配置没有改动。
同一个共享 v3-heavy 合成库预建索引，在原模板上重复其已有模块定义以构成 27 个模块的
真实滚动范围，没有另造正文语料。7 次采样的打开中位数 **281.0 ms**、最大
512.1 ms；滚动中位数 **64.9 ms**、最大 69.8 ms。打开包含 200 ms 的导航过渡等待；
两项均包含调试桥往返及 PNG 回读，不能解释成纯渲染耗时。当时 12 核机器有其他构建，
负载记录在生成结果中。顶部与底部截图已目检，滚动实际到达列表末端。
第二次交回用同样的配置与合成库对照本次基准。

```bash
CARGO_BUILD_JOBS=3 cargo build -p drifting --features debug-bridge --locked \
  --config 'profile.dev.package.dr-model.opt-level=2' \
  --config 'profile.dev.package.dr-doc.opt-level=2' \
  --config 'profile.dev.package.dr-workspace.opt-level=2' \
  --config 'profile.dev.package.dr-shell.opt-level=2'
DRIFTING_BENCH_BUILD='debug-bridge; dr-model/dr-doc/dr-workspace/dr-shell opt-level=2' \
  python3 crates/dr-view-templates/script/window-bench.py leaf
```

生成结果、可执行文件 SHA-256、机器负载与两张截图在忽略目录
`next/target/acceptance/k5-heavy/`。初次滚动采样的指针落在输入区域，图像未变，
该组数字已丢弃；修正为滚动容器的左侧空隙后重测，以上数字来自实际滚动。

## 第二次交回

分支仍为 `codex/k5-templates`，交回指针仍为 `handback/k5`。本次完成
层级模板、八项设置和还原、泳道、动作、两种模板的帮手说明与草稿预览，
包含九种语言的 own 文案。实现提交 `98fb5a56`；滚动采样的布局等待修正在
`d0de5527`，时间线接线后的固定窗口高度在 `4e9196a3`。
同步 main 的合并提交为 `2c3c02ed`、`17e28416`，后者包含 main `91a74675`
的第 46 批收件记录。整合者已接第一次交回；本会话未向 main 合并，也未推送。
语言合并保留两边新增块，生成文件由 sync-locales 重建；own 块顺序跟随 main，
没有修改时间线文案。

编译并发 3。`cargo fmt --all --check`、全 workspace Clippy
`--all-targets --locked -- -D warnings`、全 workspace test
**2050 passed / 0 failed / 22 ignored**、`cargo xtask check`（含 audit，
972 locked crates、0 vulnerabilities、12 notices）与根目录 `pnpm public:check`
通过。保留既有 14 份过期测量提示。测试不跳过失败项；22 个忽略项来自既有套件。

最终标准 debug 真窗口在共享 v3-lite 种子上：叶子回归 **122/122**、
层级 **139/139**，均 **0 pending**，共六张截图逐张目检。
两条场景先用外壳动作收起默认打开的时间线，等待过渡结束，再进行模板验收。
新增说明区后重定字段类型控件的位置；滚动后等待布局再点击。
记录在忽略目录 `next/target/acceptance/k5-leaf-regression/` 和
`next/target/acceptance/k5-level/`。

heavy 对照仍使用前述四个包 opt-level=2 的开发版，界面 crate 未优化；
同一个预建索引的共享 v3-heavy 合成库、27 个模块，底栏收起。
这次在两个保留的可执行文件上重新成对测量，滚动后固定等待 50 ms 让布局进入截图，
并断言每一次滚动前后图像不同；打开仍含 200 ms 的导航等待。
第一次交回的数字保留在上节，本表的滚动等待口径已改变，应在表内前后比较。

| 7 次原生桥采样 | 叶子交回版本 | 本次完整版本 |
| --- | ---: | ---: |
| 打开中位数 / 最大值 | 277.0 / 497.8 ms | 281.1 / 510.4 ms |
| 滚动中位数 / 最大值 | 112.4 / 119.8 ms | 127.2 / 129.0 ms |

打开中位数增加 1.5%，滚动中位数增加 14.8 ms（13.1%）。这是含桥往返、等待和
PNG 回读的端到端数据，不是纯渲染帧时。两次的 12 核机器 load average 均随结果保存。
顶部／底部四张截图已目检：叶子版滚到添加模块处，完整版滚到帮手说明末端。
结果为 `next/target/acceptance/k5-heavy/{leaf,full}.json`，包含可执行文件 SHA-256；
原第一次交回的结果另存 `leaf-first-handback.json`。无变化的即时旧帧采样没有计入本表。

复跑时分别指定第一次和本次的优化开发版可执行文件，执行同一脚本：

```bash
DRIFTING_BENCH_APP=target/acceptance/k5-binaries/drifting-leaf-opt \
  python3 crates/dr-view-templates/script/window-bench.py leaf
DRIFTING_BENCH_APP=target/acceptance/k5-binaries/drifting-level-opt \
  python3 crates/dr-view-templates/script/window-bench.py full
```

待协调仍为上节的 F6 标准 debug heavy 初始书快照超时，以及 K6 公共结构说明函数。
优化开发版度量不改变默认编译配置；v3-lite 窗口验收使用标准 debug。

## 公共投影接线交回（2026-11-10）

分支 `codex/k5-templates`，交回指针 `handback/k5`。本轮在两次已接收交回之上，
补齐精确 frontier 独立副本、K6 公共模板／结构投影、未使用模板、跨书保护和晚到结果隔离，
新增加载／失败标签的九语 own 文案，移除旧手工预览格式器。实现为 `a64ede4c`、
`731b2918`、`1462a499`；`e53612dc` 同步 main `07fd3c15`，`39b713a1` 合入整合者
明确允许提前消费的 K6 正式交回 `983289b9`。K6 的修改只随该正式依赖合入，K5 未跨改其包。

编译并发 3。fmt、全工作区 Clippy（all-targets／locked／D warnings）、全工作区测试
（**2175 passed / 0 failed / 22 ignored**，test-threads=3）、xtask（含审计：972 locked
crates、0 vulnerabilities、12 notices）及 public 全过；保留 19 份既有过期测量提示。
K5 定向 **14/14**。标准 debug 的共享 v3-lite 主流程 **48/48、0 pending**，首次运行通过；
预览前后真实模板列表不变，保存后重开，并从结果核对模板／模块 id、书和 frontier。
启动前确认两块显示器；桥的 `(144,125,1440,900)` 是屏内坐标，同构建、同启动参数另做
**12/12、0 pending** 原生位置核对，CG 窗口 `(564,1565,1440,900)` 完整位于副屏
`(420,1440,1728,1117)`。窗口均已退出，未移动作者日常窗口。原始结果在忽略目录
`next/target/acceptance/k5-shared-preview/` 与 `k5-secondary-probe/`，全套日志为
`next/target/k5-shared-{fmt,clippy,tests,xtask,public}.log`。

本轮无正确性待协调项，未删除 v2.2 测试，也未接模型或动作执行器；预览不向运行时发布草稿。
heavy、性能预算、截图目检和样式打磨按最新口径暂缓，没有记为通过。标准 debug 日志仍有
`__eh_frame` 链接提示及两项打包字体未找到提示，本轮未据此宣称视觉或性能达标。
未向 main 合并、未推送；旧交回的 heavy 历史记录原样保留，K6 公共预览接线待办在本轮关闭。

## 统一条目（内核 v4 · T2）交回（2026-11-13）

分支 `codex/v4-t2-templates`，交回指针 `handback/v4-t2-templates`，基于数据层信号
`ready/kernel-v4-data-layer`（`37db94f55`），并已同步 `main`（`d3bc12f9d`，含 T8 第一部分与 T4）。

本轮按 `kernel-v4.md` 合一模板编辑器：删除新建时的层级／叶子选择菜单（`src/create.rs`）
和页头类型徽章，移除 `dr-i18n/own` 中退役的 `leaf`、`leaf_template`、`level_template`，
在九种语言中补齐 `children`（下面的条目）、`in_book`（计入字数和导出）、`level_hint`
（打开后下面能放条目）、`linkable`（名字参与自动链接）并由 `sync-locales.py` 同步生成文件。
任何模板可加任意模块（含多篇正文与可拖动排序的 `children` 模块），每篇正文带独立 `in_book`
开关，模板带默认「层级」开关（展开／收起八项「下面」设置与动作且收起不清空存储值）与
`linkable` 开关，「泳道」并入 `settings.lane`（未覆盖时不标「继承」，有值时支持「还原」），
公共结构预览补齐 `book_prose_modules` 与 `settings.lane` 口径。

编译并发 3、单线程测试且开启 `DR_UI_REQUIRE_FONTS=1`：`cargo fmt --all --check`、
全工作区 Clippy（`--all-targets --locked -- -D warnings`）、全工作区测试零失败通过
（其中 `dr-view-templates` **17/17**、`dr-shell --test strings` **1/1**）、
`cargo xtask check`（含 `audit`，0 vulnerabilities）、根目录 `pnpm public:check` 与
`pnpm ci:contract:check` 全部通过。副屏临时 profile 真窗口回归：
`k5-shared-preview.json` **47/47**、`k5-level.json` **152/152**、`k5-leaf.json`
**131/131**，均 **0 pending**，六张截图已逐张目检。

跨轨道待收口：`kernel-v4.md` §14 提到移除模板类型键后在 `xtask` 的 `terms` 门禁中禁掉
`"叶子模板"`／`"层级模板"`／`"leaf template"`／`"level template"`；当前 `main` 上
`dr-agent-tools/src/executor.rs` 仍有一处待 T3 清理的 `"level template"` 字面量，
本轮按保守口径未跨改 `xtask` 或 `dr-agent-tools`，留待 T2 与 T3 合入后统一加门禁。
