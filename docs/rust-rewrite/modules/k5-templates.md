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
  `next/target/k5-heavy.log`、`next/target/k5-heavy-sample.txt`，没有生成打开／滚动数字。
  基准脚本保留在本 crate，后续可在同一个合成 profile 上重跑前后两次。

## 第一次交回

分支 `codex/k5-templates`，交回指针 `handback/k5`。本段只交叶子模板。
检查与真窗口运行记录在完成后补齐；本节未记录的检查不视为已完成。
