# K5 模板编辑器

范围按 [K4 开工细则](../k4-ui.md#k5-模板编辑器)，交回按
[overnight.md](../handoff/overnight.md#交回协议)。原型为
[第 2 版](https://claude.ai/artifact/Q9cfuRn9u5T5vZ38qG1JU7)。

## 叶子模板

`dr-view-templates` 是独立的界面 crate。应用登记 `init`，通过
`v3::add_template_creator` 消费左栏的新建入口，通过 `pages::add_page_view`
消费 `Target::Template`。只登记 v3 目标，旧版的分类／故事线模板编辑器不变。

叶子模板页可改名称、记号和颜色，添加正文、键值表、补丁、情节规划、关联，
以及九种字段；正文可重复添加、分别命名。模块由砂笔握柄拖动排序，删除只移除定义。
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

## 层级模板与帮手说明

模板集合的「新建模板」先选层级／叶子。层级模板只提供字段和键值表，
层级说明正文由内核的 `about` 提供，不在模板里另建叶子正文模块。
八项设置分别保存模板的覆盖值；「还原」删除覆盖，继续从祖先继承。
默认模板的「无」和住处的「这一层」是显式空值，与继承不同；
允许的模板的「不限」是显式空列表，与继承也不同。
三方合并保留这些区别，包括同一设置表里有其他并发修改的时候。

显示可选列表／网格／看板／岛屿，格式快捷输入使用内核的 full／notes／plain。
泳道打开时「收别处的条目」的有效值为开且不可操作，但保留作者原先的覆盖值；
关闭泳道就回到该覆盖值或继承。新条目住处从当前书的层级中选择。
设置名换行、还原按钮在行尾，避免窄稿纸上压住控件。

动作由稳定 id、作者名称和目标模板组成，目标选择遵守本模板非空的允许列表。
未选目标、目标已删除、名称为空或 id 重复的草稿不能保存；保存前重读后也会校验。
保留已有动作的描述和位置，描述不当作可执行代码。动作工具的生成和执行归 K6，
本页只编辑通用声明。

两种模板都可编辑帮手名字、一句说明、注意事项和每个模块一句说明。
不会填入自编的默认指导文字；新增的界面标签在 `dr-i18n/own` 九种语言中维护。
修改模块说明保留已有的 writable／read_tier，新出现的模块指导保留默认可写权限。
「帮手看到的」的公共结构预览消费见下节；书内指导不会从应用内置模板回填。

本段的定向检查为 9 条契约通过。最终真窗口与全套检查见文末第二次交回。

## 公共结构预览

本段为续接中的实现说明：独立副本与宿主隔离已落地，公共薄包装正式入 main 后接入视图。

K5 捕获外壳所给的书 id、`BookV3.revision` 和整份当前草稿。后台先按这一精确
frontier 读取独立历史副本，再 fork 成可编辑的临时文档；只在该副本覆盖草稿定义。
投影使用 K6 的 `StructureContext::from_v3_view` 和
`TemplateSummary::from_v3_template`，前者收到的版本来自同一临时文档的真实 frontier。
新建／未使用模板单独返回模板投影，保留模板和模块 id，不伪造条目来让模板进入在用列表。
层级草稿另列原始覆盖和声明动作；在用层级的有效值与来源由同一快照的 K6 投影提供。

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
  F3／SQLite 契约。覆盖全部类型、两篇正文、重读后的顺序、删除后正文与字段值保留、
  并发互不相干的修改合并、冲突拒绝，以及未知记号保留。
- `next/crates/dr-cli/scenarios/k5-leaf.json`：v3-lite 的真窗口输入路径，
  包括模板集合新建、改名、全部模块与九种字段、真实鼠标拖动、删除、并发刷新和重开。
  运行结果与截图写到忽略目录 `next/target/acceptance/k5-leaf/`。
- `next/crates/dr-cli/scenarios/k5-level.json`：v3-lite 真窗口新建层级模板，
  校验添加器不出现正文；操作八项设置、四种显示、泳道的强制接收、动作添加／改名／
  删除／缺目标拒绝、帮手说明与预览、逐项还原及显式空值；退出并重开核对持久化。
- 层级契约还从实际模板创建条目，核对默认模板、住处、归属和泳道有效值；
  删除动作目标后拒绝保存，删模块后保留条目数据。GPUI 契约核对后台刷新不夺走
  输入、帮手说明不改变已有权限／读取层级，以及预览中的转义和泳道有效值。

```bash
cd next
CARGO_BUILD_JOBS=3 cargo build -p drifting --features debug-bridge --locked
CARGO_BUILD_JOBS=3 cargo drifting workspace scenario crates/dr-cli/scenarios/k5-leaf.json \
  --app target/debug/drifting
CARGO_BUILD_JOBS=3 cargo drifting workspace scenario crates/dr-cli/scenarios/k5-level.json \
  --app target/debug/drifting
```

## 待协调

- **K6**：结构说明函数合入 main 后消费其公共接口；未合入的分支不是依赖。
  当前本地预览只读模板草稿，不新建动作执行器、不把编辑中的说明送入运行时。
- **F6／K1 查询方**：v3-heavy 的初始书快照在模板页挂载之前超时。
  `window-bench.py leaf` 使用共享 heavy 种子并预建索引，仍在
  `ui.wait` 的 240 秒内未得到书快照；`state.get` 的 `book.loaded = false`。
  原生采样停在 `dr_shell::book::v3::load → LevelGet → level_settings →
  entries_map → resolve_autolink_name_conflicts → resolve_level_settings`。
  本次不越界修改外壳／查询层；日志和采样在忽略目录
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
