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

## 验收来源

- `next/crates/dr-view-templates/tests/contract.rs`：共享 tiny v3 种子上的真实
  F3／SQLite 契约。覆盖全部类型、两篇正文、重读后的顺序、删除后正文与字段值保留、
  并发互不相干的修改合并、冲突拒绝，以及未知记号保留。
- `next/crates/dr-cli/scenarios/k5-leaf.json`：v3-lite 的真窗口输入路径，
  包括模板集合新建、改名、全部模块与九种字段、真实鼠标拖动、删除、并发刷新和重开。
  运行结果与截图写到忽略目录 `next/target/acceptance/k5-leaf/`。

```bash
cd next
CARGO_BUILD_JOBS=3 cargo build -p drifting --features debug-bridge --locked
CARGO_BUILD_JOBS=3 cargo drifting workspace scenario crates/dr-cli/scenarios/k5-leaf.json \
  --app target/debug/drifting
```

## 待协调

- 层级模板的设置、泳道、动作与写给帮手的说明在第二次交回；第一次不声明完成。
- K6 的结构说明函数合入 main 后消费其公共接口；未合入的分支不是依赖。
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
