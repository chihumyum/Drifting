# M44 条目模块自定义：数据层（CM1）和渲染（CM2）

2026-11-24，任务书 [handoff/resume-1123.md](../handoff/resume-1123.md) 的 CM1。设计是 [custom-modules.md](../custom-modules.md)（作者 2026-11-20 定稿，2026-11-23「现在就迁」）。这一路只做数据：格式和校验器、我的模块、书里的抄本和值、自动换、命令、项目模板带模块、`.driftingmodule` 文件。没有任何界面，也没有 Agent 的工具（CM2 渲染、CM3 工作台、CM4b Agent 照这一页的接口接）。

同一天的 CM2（画出来、能填）写在本页末尾 [「渲染（CM2）」](#渲染cm2)：盒子树画成界面、条目页上能填、铺满、悬停卡里的一行、坏了的抄本。

## 做了什么（大白话）

1. **一个模块是一份数据，过一个校验器。** 装什么（积木，能套着装）、长什么样（三棵盒子树）、写给 Agent、一份示例值，写成一段固定格式的 JSON。不认识的键、种类、属性、取值，档位以外的数字，像 id 的示例「条目」，示例里的图片，一律拒收；上限照设计稿第 6 节。同一个模块写出来每次逐字节一样。校验器在 `dr-model`，命令行能单独跑（`cargo drifting module check`），App 里每个入口都过它。
2. **「我的模块」存在书库里**，一个模块一篇文档 `module:<id>`，不属于任何书，跟着书库同步，整个换（两台设备同时改，留下其中一份完整的，名字不会和别人的积木拼在一起）。它不是书的内容：不计字数、不搜索、不进书文件、不进成书导出和 Markdown 文件夹。
3. **书里有抄本，条目里有值。** 书目文档多一个根映射 `modules`（模块 id → 整份模块）；条目模板多一种模块种类 `custom`，配置里只指一个模块 id，永远不进成书。条目里的值按积木 id 存在条目节点的 `module:<模板模块 id>` 下，一串是能移动的列表，每项带自己的 id；挪动、合并都按 id 认，值跟着项走。
4. **改了「我的模块」，用着它的项目自动换**，值一个不动：打开项目时对一遍；开着的项目当场换；别的设备改了、同步过来也当场换。删掉的积木，值留在书里不显示，加回来就回来；改了种类的积木，旧值读得成新种类就显示，读不成就留着不显示。抄本的 id 在我的模块里有就跟着走，没有就不动；从我的模块里删掉一个，项目留着抄本照常用，从此不跟着换。
5. **另存一份、存进我的模块、导入都给新 id**，所以别人那里来的模块不会碰巧和我的同 id；从自己的项目模板新建的项目，模块 id 对得上，照样跟着走。
6. **项目模板带着它用到的模块**（模板值多一个 `modules`），另存、导入、新建项目时一起带。书文件（`.driftingproject`）本来就带着书目文档，抄本和值都在里面；导入书文件时，「条目」「图片」积木里指向书里条目和文件的值跟着换成新 id。
7. **书里的抄本坏了**（比如更新的 App 存的模块到了这个 App），读得出「坏了」和它的名字，值照旧留着；往坏了的抄本里写值会被拒绝。

作者在 App 里暂时看不到任何不同：条目页、工作台、我的模块的列表都是后面三路的事。

## 定下的事

### 照设计稿的

- 格式头 `format: "drifting.module"`、`formatVersion: 1`；键和 §6 一样：`name`、`locale`、`credit`（只有 `author`）、`blocks`、`look`（`block` 必有，`line`、`full` 没有就跟着一块）、`agent`（`name`、`description`、`instructions`、`blocks` 每块一句）、`sample`。上限：256 KiB、100 块积木、串套串 4 层、三棵树合计 400 个节点、写给 Agent 合计 2 万字。
- 积木：`text`、`long_text`、`number`、`date`、`select`、`multi_select`、`toggle`、`entry`、`image`、`group`、`list`。节点：`box`、`each`、`value`、`text`、`mark`，属性和取值照 §4 的清单（间距 0/4/8/12/16/24，圆角 0/2/4/8，墨色 1–4，格的列宽 `fill` 或 48–320 每 8 一档）。
- 我的模块：一篇书库文档，`payload.record = {info: {origin, created_at?, updated_at?}, value: <规范化 JSON>}` 一个寄存器整个换（照我的模板 2026-11-15 的改法）。删除直接清掉（`purge_doc`），清除记录随同步走。
- 抄本：`modules[<模块 id>] = {value: <规范化 JSON>, source}`，一个值整个换。值：`module:<模板模块 id>` 是可合并映射，积木 id → 值；一串在 `list:<积木 id>`（可合并的可移动列表），每项一个映射，`id` 是项的 id。
- 「跟着走」只按 id 认：`custom_module.*` 的导入、另存一份、存进我的模块都给新 id。
- `custom` 模块 `in_book` 永远是关（写模板时强制关，模板格式里要求是 `false`）；成书导出、Markdown 文件夹不写自定义模块（§16 第 2、3 条）；批注只落到整个模块（`check_comment_part_kind` 对 `custom` 不认任何子处，§16 第 5 条）。
- 导入、导出、社区不进 Agent 和 MCP 的工具目录。这一路连别的自定义模块命令也先关着（`dr-agent-tools` 的 `CUSTOM_MODULE_VALUE_COMMANDS` 和 `custom_module.*`），由 CM4b 按设计稿 §13「Agent 能用的」打开。

### 书目格式号

**没有升**，仍是格式 5（`meta.v = 5`，创世版本 6）。照任务书「加一个根映射、多一种模块种类」做：旧的格式 5 读者遇到 `modules` 根和 `module:` 键照「不认识的原样保留」处理，`custom` 读成未知的模块种类；格式 5 还没发布。模块格式自己的 `formatVersion` 是 1；项目模板的 `formatVersion` 仍是 1（多一个可选的 `modules` 和一种模块种类，格式没发布，照旧干净改）。

### 设计稿没说到、按最保守做的（列在交回报告「等作者的事」）

- 盒子的「最宽」（`max`）用格的列宽那张档位表（48–320，每 8 一档）。
- 几个设计稿没给的数：积木 id 1–32 个 ASCII 字母、数字、`_`、`-`，不能叫 `id`（一串的每项在这个键下记自己的 id）；值节点 `lines` 1–10；写死的字 ≤ 200 字；`suffix` ≤ 40 字；格最多 12 列。
- §6 例子里用到、§4 表里没列的 `suffix`（值后面的字）和值、字节点上的 `width`：照例子收。
- 记号节点只收记号选择器的七个砂笔记号（`file-text`、`square`、`compass`、`folder`、`lightbulb`、`git-branch`、`book`）。
- 「显示成」：`text` 给除图片、一组、一串以外的；`dots` 只给数字；`mark` 只给单选；`count` 只给一串（一串不写就是个数）。
- 示例里的「条目」是几个字：像 uuid 的拒收；示例里不能有图片。
- 项目模板的示例条目**不带**自定义模块的值（`TemplateEntry` 没有放它的地方，设计稿没说）：另存时、编辑模板的工作区存回模板时，示例条目里自定义模块的值不进模板。
- 另存为项目模板时，书里有一份这个 App 读不了的抄本：整个另存拒绝，不悄悄丢掉那个模块。
- 抄本的 `source` 记的是它从哪来（`library` 从我的模块放进来、`template` 跟着项目模板来），跟不跟着走按 id 现算。没有条目模板再用的抄本留在书里，不清。
- 新建、另存一份、存进我的模块、导入不能撤销（照 `project_template.save`）；改、改名能撤（撤销把旧的整份写回，开着的项目跟着换回去）。自动换写进书里的那一笔来源是作者的命令（`user:command`），不进撤销日志。
- 自动换在三个时候：书打开时（工作区第一次打开它的书目文档）、我的模块在这台设备上改了时、我的模块从别的设备同步来时。书目文档从别的设备同步来、带着一份旧抄本（那台设备还没收到新的我的模块）时**不**马上换，等下次打开或我的模块再变：免得两台设备的我的模块版本不同时来回换；两边收齐以后就一样了。
- 抄本坏了时，这个模块的值只读：写、加项、删项、挪项都拒绝。
- 一块积木在「一串」和别的种类之间改来改去，两种值分开放（一串在 `list:<id>`，别的在 `<id>`），都不丢。
- 「一行字」的值不收换行；「条目」积木的值必须是这本书里活着的条目；「图片」必须是这本书素材库里的文件（和字段一样）。
- 书文件导入时，自定义模块的值**整个等于**书文件要换 id 的那些东西（条目、文件）的 id，才跟着换；字里只是含着一个 id 的不动。

## 接口

### 格式和校验器（`dr-model`）

```rust
dr_model::custom_module::{
    ModuleValue, ModuleCredit, Block, BlockKind, Look, LookSize, Node, BoxNode, EachNode,
    ValueNode, TextNode, MarkNode, ModuleAgent, SampleValue, Column, ColumnFill,
    BoxDir, EachDir, Align, Width, Border, Background, Decoration, Separator, Connector,
    Show, Font, TextSize,
    MODULE_FORMAT, MODULE_FORMAT_VERSION, MAX_MODULE_BYTES, MAX_MODULE_BLOCKS,
    MAX_MODULE_LIST_DEPTH, MAX_MODULE_LOOK_NODES, MAX_MODULE_AGENT_CHARS, MAX_BLOCK_ID_LEN,
    SPACING_STEPS, RADIUS_STEPS, INK_LEVELS, MODULE_MARKS, is_width_step,
};
parse_module_json(raw: &str) -> Result<ModuleValue, ModuleError>; // 先查大小和格式头，再封闭反序列化，再校验
validate_module_value(&ModuleValue) -> Result<(), ModuleError>;
to_canonical_json(&ModuleValue) -> Result<String, ModuleError>;  // UTF-8、固定键序、两空格缩进、末尾一个 \n
module_name_hint(raw: &str) -> Option<String>;                  // 坏了的抄本还写着的名字
ModuleError::{TooLarge, MalformedJson, InvalidFormat, UnsupportedFormatVersion, InvalidFormatVersion, Invalid};

ModuleValue::empty(name) -> ModuleValue;        // 「新建模块…」：没有积木，一块是一个空的竖排盒子
ModuleValue::blocks_with_scope() -> Vec<(&Block, Option<&str>)>; // 每块积木和保存它的那一串（None：条目自己）
ModuleValue::block(id) / scope_of(id) / list_chain(id) / scope_blocks(scope) / line_blocks(n);
Look::own(LookSize) -> Option<&Node>;           // 一行、铺满没有单独摆时是 None（跟着一块）
Look::trees();

// 值（dr_model::custom_module::values）
StoredScope { plain: BTreeMap<积木 id, StoredValue>, lists: BTreeMap<积木 id, Vec<StoredItem>> };
StoredItem { id, scope: StoredScope };
StoredValue::{Bool, Number, Text, Texts, Unknown};
BlockValue::{Text, LongText, Number, Date, Select, MultiSelect, Toggle, Entry(Vec<条目 id>), Image(素材 id), List(Vec<ItemValues>)};
// JSON 里是 {"type": "...", "value": ...}
ItemValues { id, values: BTreeMap<积木 id, BlockValue> };
read_scope(&ModuleValue, scope: Option<&str>, &StoredScope) -> BTreeMap<积木 id, BlockValue>; // 只给读得成的
read_block(&ModuleValue, &Block, &StoredScope) -> Option<BlockValue>;
read_plain(&Block, &StoredValue) -> Option<BlockValue>;   // 「读得成新种类就显示」的规则都在这里
InputValue::{Bool, Number, Text, Texts, Null};             // 写值的输入（null 是清空）
check_input(&Block, &InputValue) -> Result<Option<StoredValue>, String>;
ItemStep { list: 积木 id, item: 项 id };
check_path(&ModuleValue, block, &[ItemStep]) -> Result<(), String>; // 从条目往下，每一串一步
```

`dr_model::id::{CustomModuleId, ModuleItemId}`；`DocId::Module`、`DocKind::Module`（前缀 `module`，不是书的正文，没有编辑配置）；`ModuleKind::Custom`、`ModuleConfig.module: Option<CustomModuleId>`、`ModuleSpec::custom(id, name, module)`。

### 我的模块的文档、书里的抄本和值（`dr-doc`）

```rust
dr_doc::custom_module::{genesis, validate_import, ModuleDoc, BorrowedModuleDoc, ModuleDocView, ModuleDocTxn, ModuleInfo, ModuleOrigin};
ModuleDocView::{info(), raw_value(), value()};
ModuleDocTxn::save(&ModuleInfo, &ModuleValue);   // 过校验器，整份写成一个值

dr_doc::v3::CollectionV3::Modules;               // 根 `modules`
dr_doc::v3::modules::{CopySource, ModuleCopy, entry_key};
ModuleCopy { id, raw, source, value: Result<ModuleValue, ModuleError> }; // .name() .is_broken() .module()
BookViewV3::module_copies() -> BTreeMap<CustomModuleId, ModuleCopy>;
BookViewV3::module_copy(&CustomModuleId) -> Option<ModuleCopy>;
BookViewV3::custom_values(&EntryId, &ModuleId) -> StoredScope;     // 模板模块 id，不看抄本
BookViewV3::all_custom_values(&EntryId) -> BTreeMap<ModuleId, StoredScope>;
BookTxnV3::put_module_copy(&CustomModuleId, &ModuleValue, &CopySource);
EntryWriterV3::{set_custom_value, insert_custom_item, remove_custom_item, move_custom_item,
                has_custom_scope, has_custom_item};
dr_doc::schema::{book_v3::MODULES, custom_module::*, custom_values::*};
```

单个条目的撤销（`entry_history.restore`）会把 `module:` 下的值带回去：`restore_entry` 新加了这一块，一串按项的 id 对回去。条目快照点恢复（`entry_snapshot.restore`）走按容器整个带回的那条路（`restore_entry_owned_at`），`module:` 容器挂在条目节点下面，一起带回，恢复也能撤。两样都有测试（见下；快照点那条路这一轮 SR 在改，这一路没有动它）。

### 命令（`dr-workspace`）

我的模块（书库一级，`Write` 的是 `library` 并发）：

| 命令 | 输入 | 返回 | 说明 |
| --- | --- | --- | --- |
| `custom_module.list` | `{}` | `[ModuleSummary]` | 最近改的在前。`ModuleSummary {id, name, origin: own/file, blocks, locale?, author?, created_at?, updated_at?}` |
| `custom_module.get` | `{id}` | `{summary, value}` | |
| `custom_module.uses` | `{id}` | `[{book, name}]` | 条目模板用着它的项目（不算最近删除、不算编辑模板的工作区）：工作台上方「用在 N 个项目」 |
| `custom_module.create` | `{value}` | `ModuleSummary` | 新 id；不能撤销 |
| `custom_module.update` | `{id, value}` | `ModuleSummary` | 整个换；开着的项目当场换；能撤销；一样就什么都不写 |
| `custom_module.rename` | `{id, name}` | `ModuleSummary` | 整个换的一种；能撤销 |
| `custom_module.remove` | `{id}` | `{id}` | 直接清掉；Agent 不能调 |
| `custom_module.save_as` | `{book, module, value?}` | `{module: ModuleSummary, templates: [条目模板 id]}` | 另存一份：新 id 进我的模块，这本书里用 `module` 的条目模板全改指新的（同一笔书写入里带上新抄本）；`value` 不给就是书里的抄本 |
| `custom_module.adopt` | `{book, module}` | 同上 | 存进我的模块：只收我的模块里没有的 |
| `custom_module.import` | `{path}` | `ModuleSummary` | 总是新加一份（`origin: file`）；Agent 不能调 |
| `custom_module.export` | `{id, path, author?}` | `{id, name, path, bytes}` | 署名只用 `author`（导出的人的账号显示名），不给就没有；Agent 不能调 |
| `custom_module.sync_copies` | `{book}` | `{replaced: [模块 id]}` | 手动对一遍（打开、改、同步过来时已经自己对了） |

条目里的值（书一级）：

| 命令 | 输入 | 返回 |
| --- | --- | --- |
| `module.read_custom` | `{book, entry, module}` | `{module, name, copy?: {id, name?, source, follows, broken, error?}, value?, values}` |
| `module.set_custom_value` | `{book, entry, module, path: [{list, item}], block, value}` | `{id}` |
| `module.add_custom_item` | `{book, entry, module, path, list, index?}` | `{entry, item, index}` |
| `module.remove_custom_item` | `{book, entry, module, path, list, item}` | `{id}` |
| `module.move_custom_item` | `{book, entry, module, path, list, item, to}` | `{id}` |

- `module` 是**模板模块** id（种类 `custom`），不是我的模块的 id；`copy.id` 才是。`path` 从条目往下，每一串一步；条目自己的积木 `path` 是空的。
- `values` 只有这个抄本读得成的值（一串按项给，每项带 id）；`copy.broken` 为真时没有 `value`，`values` 是空的，存着的值不动。
- 写值按积木种类校验：一行字不收换行，日期 `YYYY-MM-DD`，单选、多选在选项里，条目是这本书里活着的条目 id 的列表，图片是素材库里的文件 id。四条写命令都是一步撤销（`entry_history.restore`，回到写之前条目的样子）。
- 往条目模板里放自定义模块照旧用 `entry_template.put_module` / `entry_template.put`：`kind: "custom"`、`config.module: <模块 id>`。书里没有这份抄本时，从我的模块抄进来，和模板写在同一笔里；我的模块也没有就拒绝。`in_book` 写进去总是 `false`。

Rust 里直接用的：

```rust
dr_workspace::commands::v3::custom_module::{
    my_module(ws, &id) -> Result<Option<(ModuleInfo, ModuleValue)>>,
    in_my_modules(ws, &id) -> Result<bool>,
    prepare_export(ws, id, author) -> Result<(CustomModuleId, ModuleValue)>,
    read_module_file(path) -> Result<ModuleValue>,
    is_my_module_store_event(&dr_store::StoreEvent) -> bool,
    DOC_KIND,   // "module"（dr_store::index::DOC_KIND_MODULE）
};
```

### 事件

- 抄本换了（自动换、另存一份、放进模板）：`WsEvent::Book`，`EntityChange { collection: Modules, id: Some(<模块 id>) }`。
- 条目里的值变了：`WsEvent::Book`，`EntityChange { collection: Entries, id: Some(<条目 id>), fields: Some(["module:<模板模块 id>"]) }`。
- 我的模块变了：和我的模板一样没有 `WsEvent`；听书库的存储事件，`is_my_module_store_event` 为真就重读（`project-template:` 的做法见 `dr-view-shelf` 的 `is_template_store_event`）。

### 文件（`dr-export`）和命令行

```rust
dr_export::module_file::{EXTENSION /* "driftingmodule" */, MAX_BYTES, ModuleFileError, ModuleFileSummary,
    module_filename(name), validate_module_bytes(&[u8]), validate_module_file(&Path),
    export_module(ws, id, author, &Path), import_module(ws, &Path), classify};
// ModuleFileError::{NotAModule, Newer, TooLarge, Damaged(String), Workspace, Io}
```

`cargo drifting module check <file.driftingmodule>... [--json]`：每个文件一行（`ok:` / `invalid:` / `unreadable:`），`--json` 是 `{"valid", "files": [{path, valid, name?, formatVersion?, blocks?, author?, reason?, error?}]}`。全过 0；有不合格的 1；有读不了的文件或参数写错 2。和 App 导入走同一个校验函数，判定一样。

## 外壳里的挂接点

没有动外壳。打开一本书（工作区第一次打开它的书目文档）时，数据层自己对一遍抄本；外壳什么都不用调。CM2、CM3 要接的是：`add_module_view` 给 `custom` 种类注册渲染器（读 `BookViewV3::module_copy` 和 `custom_values`）、悬停卡的一行、添加模块菜单（`custom_module.list` + `entry_template.put_module`）、全部项目页的我的模块（`custom_module.list` 和存储事件）。

## 测试

设计稿第 14 节的不变量，每条对应的测试：

| 不变量 | 测试 |
| --- | --- |
| 没有能执行的、清单外的样式、指向项目里东西的 id | `dr-model/tests/custom_module.rs`：`the_structure_is_closed`、`style_outside_the_vocabulary_is_refused`、`no_id_of_anything_in_a_project`、`every_reference_is_drawable` |
| 同一个模块每次导出逐字节相同 | `dr-model`：`every_sample_module_is_valid_and_written_canonically`、`canonical_output_does_not_depend_on_how_the_input_was_written`；`dr-export/tests/module_file.rs`：`every_sample_round_trips_byte_for_byte_and_import_always_adds_a_new_one`；`dr-workspace/tests/custom_modules.rs`：`save_as_adopt_and_import_always_make_a_new_id`（导出两次） |
| 所有入口过同一个校验器 | `dr-workspace`：`every_entrance_refuses_what_the_validator_refuses`（新建、改、另存、导入）；`dr-export`：`refused_files_write_nothing_and_say_why_the_way_the_command_line_does`（导入和命令行判定一样）；`dr-cli/tests/cli.rs`：`module_check_parses_and_runs_standalone_without_a_library`；`dr-doc/tests/custom_modules.rs`：`a_module_document_refuses_what_is_not_a_module`（同步来的更新）、`a_project_template_carries_the_modules_its_templates_draw`（模板校验器调模块校验器） |
| 换抄本、删积木、改积木种类，值一个不丢 | `dr-doc`：`values_are_kept_by_block_id_and_survive_replacing_the_copy`、`items_move_with_their_values_and_merge_by_id`、`undo_brings_values_back_from_an_entry_snapshot`；`dr-workspace`：`values_survive_deleting_a_block_changing_its_kind_and_replacing_the_copy`、`a_template_module_takes_a_copy_and_values_are_written_by_path`；`dr-export`：`a_book_file_carries_copies_and_values_not_my_modules`；`dr-model`：`stored_values_read_as_the_current_kind_and_never_change` |
| 抄本的 id 在我的模块里有就跟着换，没有就不动 | `dr-workspace`：`a_closed_project_takes_the_new_copy_when_it_is_opened`、`two_devices_keep_one_whole_module_and_an_open_project_takes_it_at_once`（同步过来当场换、删掉后不再跟）、`a_project_template_carries_modules_and_a_new_project_follows_by_id`、`save_as_adopt_and_import_always_make_a_new_id`（另存后改旧的不影响） |
| 导入、另存一份、存进我的模块都给新 id | `dr-workspace`：`save_as_adopt_and_import_always_make_a_new_id`、`a_project_template_carries_modules_and_a_new_project_follows_by_id`（存进我的模块）；`dr-export`：`every_sample_round_trips_byte_for_byte_and_import_always_adds_a_new_one` |
| 书里的抄本过不了校验器时，条目页不崩、值不丢 | 数据这一半：`dr-doc`：`a_broken_copy_reads_as_broken_and_keeps_its_name`；`dr-workspace`：`a_broken_copy_reads_as_broken_keeps_its_values_and_refuses_writes`。画占位是 CM2 的 |
| 导入、导出、从社区取不在 Agent 和 MCP 的工具目录里 | `dr-agent-tools` 的 `catalog::tests::custom_module_commands_stay_out_of_the_directory` |
| 我的模块的文档不算任何一本书的内容 | `dr-workspace`：`my_modules_are_not_the_content_of_any_book`；`dr-export`：`a_book_file_carries_copies_and_values_not_my_modules`；`dr-model` 的 `id::tests`（`DocKind::Module` 不是书的正文） |

另外：`dr-doc`：`a_module_document_keeps_one_whole_module_when_two_devices_save`（整个换）；`dr-workspace`：`my_modules_list_get_update_rename_remove`（改名撤销）、`an_entry_checkpoint_brings_custom_values_back`（条目快照点）、`an_older_copy_from_a_book_update_is_brought_up_to_date_on_request`（别的设备写进书里的旧抄本：书的更新本身不换，打开书时或 `custom_module.sync_copies` 换）。样本模块是 `dr_testkit::samples::MODULE_FILES` / `modules()`（伏笔追踪、人物弧光、世界观年表、魔法规则卡，`dr-testkit/fixtures/modules/`），在 dr-testkit 之下的 crate 按路径读同一批文件。

## 待协调

- **CM2**（已做，见下面「渲染（CM2）」）：渲染器读 `module_copy(id)`；`is_broken()` 时画只写 `name()` 的空占位。一行没单独摆时，`ModuleValue::line_blocks(n)` 给出前几块（图片、一组不算，一串是个数），`n` 由渲染定。「条目」积木的值是条目 id 列表，已删的条目要渲染时过滤；示例值里的条目是几个字。
- **CM3**：工作台随改随存就是一次次 `custom_module.update`（每次都过校验器，所以中间状态也得合格：空的一串、一组可以，指着不存在的积木的节点不行）；⌘Z 走工作区撤销。「另存一份」是 `custom_module.save_as`，模板编辑器那一行的「存进我的模块」是 `custom_module.adopt`，「用在 N 个项目」是 `custom_module.uses`。删除要先问一句（§16 第 4 条），命令本身不问。
- **CM4b**：目录里现在关着全部自定义模块命令（`dr-agent-tools/src/catalog.rs` 的 `CUSTOM_MODULE_VALUE_COMMANDS` 和 `custom_module.` 前缀），按 §13「Agent 能用的」放开建、改、改名、另存一份、写值；`import`、`export`、`remove` 命令里也拒绝 Agent。结构说明里 `custom` 模块现在和未知种类一样只给读的工具（`dr-agent-tools/src/structure.rs`）。
- 书文件导入只换「整个等于」要换 id 的值（见上）；条目链接以外的写法以后要改，改 `dr-export/src/book_file/v3.rs` 的那一段。

## 代码位置

- 格式、校验器、值：`next/crates/dr-model/src/custom_module/`（`mod.rs`、`validate.rs`、`values.rs`）；id 和文档种类：`dr-model/src/id.rs`；模块种类：`dr-model/src/v3.rs`；项目模板：`dr-model/src/project_template/`。
- 我的模块的文档：`next/crates/dr-doc/src/custom_module.rs`；抄本和值：`dr-doc/src/v3/modules.rs`；撤销：`dr-doc/src/v3/write.rs` 的 `restore_entry`；模板另存和新建：`dr-doc/src/project_template.rs`。
- 命令和自动换：`next/crates/dr-workspace/src/commands/v3/custom_module.rs`；放进模板：`commands/v3/template.rs`；打开书、同步来的文档：`dr-workspace/src/workspace.rs`。
- 文件：`next/crates/dr-export/src/module_file.rs`；书文件里的值：`dr-export/src/book_file/v3.rs`；命令行：`next/crates/dr-cli/src/lib.rs`、`args.rs`。
- 工具目录：`next/crates/dr-agent-tools/src/catalog.rs`。

## 渲染（CM2）

2026-11-24，任务书 [handoff/resume-1123.md](../handoff/resume-1123.md) 的 CM2。依据是 [custom-modules.md](../custom-modules.md) 第 3、4 节和第 16 节第 5、6 条，长相对着原型第二页「摆在条目页上」。

### 做了什么（大白话）

1. **盒子树画成界面。** 一个模块的「长什么样」加一份值，画成一块界面。五种节点（盒子、每一项、值、字、记号）和第 4 节清单里的每个属性都有对应，档位都落到 `dr-ui` 现成的东西上：三种字体是 App 的三种字（衬线是正文的、无衬线是界面的、等宽是索引的），四档大小是界面字号，四档墨色是调色板的墨，边是发丝线、静止的玻璃线或者静止的砂笔框，底是稿纸或一层淡墨，弧线是一道砂笔，记号是记号选择器的那七个砂笔记号；单选显示成记号时第一个选项空心、最后一个实心、中间半实，数字显示成点数是五个砂笔点。没有别的颜色，深浅模式跟着主题自己换。
2. **条目页上能看到、能填。** 条目模板里放了自定义模块的条目，条目页上按模板的顺序画出这个模块的「一块」，就地填：一行字、一段字、数字、日期直接在原处打字（无边框的输入框，字体字号墨色就是这个值自己的，离开时存，一行的回车存，Esc 放回原来的字）；单选、多选、条目、图片按一下弹出和「字段」模块下拉框一样的选项列表（「未设置」在最前面）；勾选按一下就翻；显示成点数的数字按一下变成输入框，存了以后回到点数。一串的每一项指上去出拖动把手和删除（竖着排的一串，把手在左边的页边、删除在右边的页边，不压住这一项的字；横着排的在这一项右上角），拖到另一项上就挪到那里；最后一项下面是一行「＋ 串的名字」，按了加一项。串里套串一样。每一次改动是一条命令、一步撤销，不拿读到的整份去替换。
3. **铺满。** 模块标题行右边的铺满按钮（指着标题行时出现，铺满时一直在），按了这个模块铺满中间一列：稿纸撑到这一列最宽，只剩条目的头和这个模块，底栏收起；画的是「铺满」那棵树（没单独摆就是「一块」撑满）。Esc 或再按一次退出。和左右栏、底栏的铺满一样一次只有一处：铺左栏会退掉模块的铺满，反过来也一样；换页、关项目以后不记。
4. **悬停卡里一行。** 指着正文里一个条目的名字，悬停卡在梗概下面给这个条目的每个自定义模块各画一行（模块单独摆了「一行」就画它，没摆就是前三块积木的值连成一行，一串显示成「3 个伏笔」这样的个数，图片和一组跳过）。
5. **坏了的抄本**（更新的 App 存的模块拿到这里）画一块空的占位，只写模块的名字，不能填，值一个字节都不动。书里没有这份抄本时也一样。
6. **抄本被自动换掉时**，开着的条目页当场跟着变（新积木当场出现），值都在；正在打字的那一格不丢字，离开时照常存。
7. **批注**只落到整个模块：条目页给每个模块的标题行页边按钮照旧，没有为自定义模块加别的。

### 定下的事（设计稿没说到、照原型或最保守做的，交回报告的「等作者的事」逐条列了）

- 格式里没写的属性用原型的默认：盒子没有间距、内边距、边、底、圆角，子节点撑满；每一项竖着排、没有间距；值是无衬线、正文大小、墨色 2；写死的字是等宽、注、墨色 4。
- 点数固定五个，值四舍五入，小于 0 算 0、大于 5 算 5。
- 「条目」显示成标题用「 · 」连起来，多选同样；勾选写成「✓ 积木名」「□ 积木名」（「字段」模块的样子）；图片画成 64 高、按比例放进格子的缩略图，没有图的画一个带图片记号的空框；没有值的画一道「—」（工作台的「空」画积木名）。
- 就地编辑照「字段」模块的控件：打字的用同一个无边框多行输入（`TextArea`），选的用和下拉框同一个菜单列表，勾选按一下翻。原型第二页没画编辑，选项列表是按在值上弹出来的，不是一个常驻的下拉框，这样看着还是模块自己的样子。
- 一串加一项的那一行写的是串自己的名字（作者起的），前面一个加号；删除和拖动把手的读屏名字借现成的「删除」「拖动排序」。
- 工作台的「空」预览里每一串画一项、不带值（`Scope::blank`，原型的空预览就是这样）；条目页上一串没有项时什么都不画，只有「＋」那一行。
- 能打字的格子空着时，淡字写的是积木的名字（输入框的占位字）；不能打字的值（单选、条目……）空着时画「—」。
- 自动一行的「3 个伏笔」是新加的一句文案 `customModule.countOf`，九种语言。
- 铺满时稿纸离这一列左右各 8 px（原型的 `midW - 16`）；没有开合动画（直接铺开、直接收回）。

### 接口

渲染器在新 crate `dr-view-module-look`（界面层，只依赖 `dr-model`、`dr-ui`、`gpui`；不依赖打开的书，所以 CM3 的工作台预览、条目页、悬停卡都能直接用）：

```rust
// 值：一个条目的（read_scope 的结果）、示例值、空的
dr_view_module_look::{Scope, Item, Shown, EntryName, Picture, Names, NoNames};
Scope::read(&BTreeMap<积木 id, BlockValue>, &dyn Names) -> Scope; // 条目 id、素材 id 由 Names 换成标题和图
Scope::sample(&ModuleValue) -> Scope;  // 「示例」
Scope::empty() -> Scope;               // 什么都没有
Scope::blank(&ModuleValue) -> Scope;   // 「空」：每串一项、没有值（配 Blanks::Names 画积木名）

// 一步画出来（CM3 的预览用它）：
dr_view_module_look::render(id, &ModuleValue, &Scope, LookSize, Blanks, Option<&dyn Edit>, window, cx) -> AnyElement;
dr_view_module_look::placeholder(id, name, window, cx) -> AnyElement;        // 坏了的抄本
dr_view_module_look::Line::new(id, Arc<ModuleValue>, Arc<Scope>);           // 悬停卡里的一行（RenderOnce）
dr_view_module_look::set_words(cx, |count, list, cx| …);                     // 版面自己写的字（自动一行的个数）
Blanks::{Dash, Names};                                                       // 没有值时画「—」还是积木名

// 分两步：纯函数的排版，和画
dr_view_module_look::plan::plan(&ModuleValue, &Scope, LookSize, &dyn Words) -> Plan;
Plan { size, own, root: PNode }; PNode::{Box(PBox), Each(PEach), Value(PValue), Text(PText), Mark(PMark)};
PValue { block, name, kind, options, path: Vec<ItemStep>, show, style, lines, width, suffix, content: Content };
Content::{Words, Missing, Dots{filled, of}, Mark(Fill), Count, Toggle, Choices, Entries, Image};
dr_view_module_look::paint::paint(id, &Plan, Blanks, Option<&dyn Edit>, window, cx) -> AnyElement;
trait Edit { fn value(..) -> AnyElement; fn item(..) -> AnyElement; fn after_items(..) -> Option<AnyElement>; }
```

宿主：

- **条目页**：`dr-view-page/src/custom.rs` 的 `CustomModule`，`add_module_view` 注册在种类 `custom` 下（`dr_view_page::init` 里）。读用 `module.read_custom`，写用 `module.set_custom_value`、`add_custom_item`、`remove_custom_item`、`move_custom_item`，按顺序一条一条跑；听书库的书事件和外壳的 `on_refresh` 重读。打字没存的字参加外壳的释放前存盘（`settlement::Drafts`）。铺满按钮用 `Rendered::with_head_action` 放在标题行。
- **铺满**（`dr-shell`，只加）：`dr_shell::workspace::{ModuleFill, FilledModule, MODULE_FILL_INSET}`；`Workspace::{fill_module, toggle_module_fill, filled_module}`；`FilledModule` 是一个全局值，条目页和模块在画的时候读它。`enter_fill` 先退掉模块的铺满，`exit_fill`（Esc、⌘[、点药丸、去主页……）也退掉它；`top_layer` 在模块铺满时是 `Layer::Fill`；换页以后自己失效。中间一列（`stage.rs`）铺满时稿纸宽到这一列减两边各 8 px、不画底栏，也不画左边页边的大纲栏（没有页边了）；条目页（`v3/page.rs`）铺满时只画头和这个模块。
- **悬停卡**（`dr-editor/src/link_card.rs`，只加）：`CardFacts` 多一个 `lines: Vec<ModuleLine>`（模板模块 id、模块、值），条目卡在梗概下面一节画它们。

### 测试

| 要守的 | 测试 |
| --- | --- |
| 四份样本在三种大小下排得出来，值落在保存它的那一串里 | `dr-view-module-look/tests/plan.rs`：`every_sample_lays_out_at_every_size_with_its_sample_and_with_nothing`、`an_entrys_values_are_kept_where_their_items_are` |
| 「一行」「铺满」没单独摆时跟着「一块」（§4） | `a_line_that_is_not_laid_out_is_the_first_blocks_and_a_list_as_its_count`、`a_full_size_that_is_not_laid_out_is_the_block_stretched` |
| 每种积木、每种「显示成」画什么 | `every_kind_of_block_shows_its_value`、`a_select_as_a_mark_is_hollow_half_or_full_by_its_place`、`foreshadowing_draws_a_ledger_with_marks_and_counts_in_its_line`、`a_blank_scope_has_one_item_in_every_list_and_no_values` |
| 渲染器不认识的东西不崩（校验器拦着，渲染器自己也不崩） | `a_value_node_for_a_block_the_module_does_not_have_draws_nothing`；坏了的抄本见下 |
| 四份样本浅深色、三种大小都画得出来；占位；一行 | `dr-view-module-look/tests/paint.rs`：`every_sample_draws_at_every_size_in_both_themes`、`a_broken_copy_is_its_name_alone`、`a_line_draws_without_the_apps_words` |
| 每种积木就地填、读回一致 | `dr-view-page/tests/v5_custom_modules.rs`：`every_kind_of_block_is_filled_in_place_and_reads_back`（魔法规则卡：九种积木都在里面，含无效的数字不存、Esc 放回）、`a_row_of_items_with_marks_and_words_is_filled_in`（人物弧光：横排带箭头的一串、单选画成记号）、`typed_words_are_stored_when_another_field_is_pressed`（按到别的格子上，打的字照样存） |
| 一串加、删、挪（串里套串），每次一步撤销 | `list_items_are_added_taken_away_and_moved_each_one_step_of_undo` |
| 坏抄本画占位、值逐字节不变 | `a_broken_copy_is_its_name_and_its_values_stay` |
| 抄本换了页面当场跟着变、值还在、正在打的字不丢 | `a_replaced_copy_redraws_at_once_and_keeps_values_and_typing` |
| 铺满、Esc 退出、再按退出、一次只铺一处 | `the_module_fills_the_middle_column_and_esc_leaves` |
| 悬停卡里每个自定义模块一行 | `an_entry_names_hover_card_has_the_modules_line` |

真窗口：`next/crates/dr-view-page/scenarios/cm2-custom-modules.json`（lite 种子，一个条目模板放伏笔追踪、魔法规则卡、世界观年表，江微月的模板放人物弧光；就地填、拖动挪一项、串里套串、两个模块铺满、名字的悬停卡，浅深色截图）。调试桥驱动的窗口没有键盘焦点，按到别的格子上不会让原来的格子失焦，所以场景里打完字用回车或 ⌘↵ 存；悬停卡那一步按坐标指到第 1 章正文第一行的「江微月」（正文里的链接不是无障碍节点）。

### 待协调

- **CM3**：工作台的预览直接用 `dr_view_module_look::render`（「示例」`Scope::sample`、「空」`Scope::blank` + `Blanks::Names`、「借一个真实条目」读 `module.read_custom` 的 `values` 后 `Scope::read`）；点预览选节点要的是值节点和盒子到盒子树节点的对应，现在 `Plan` 里没有记节点在树里的路径，到时候在 `plan` 里加一个字段（只加）。
- 铺满的开合动画没做（左右栏、底栏的是 420 ms 结构性开合）；要的话在 `FillState` 里给模块加一条和别的一样的 tween。
- 模块铺满是全局状态（`FilledModule`），两个窗口开着两本书时会互相看见；现在 App 只有一个工作区窗口。

### 代码位置

- 渲染器：`next/crates/dr-view-module-look/src/`（`values.rs` 值、`plan.rs` 排版、`paint.rs` 画、`lib.rs` 入口、占位、一行、文案钩子）。
- 条目页上的模块：`next/crates/dr-view-page/src/custom.rs`。
- 铺满：`next/crates/dr-shell/src/workspace/fill.rs`（`ModuleFill` 一段）、`stage.rs`、`mod.rs`（`top_layer`、`changed`）、`v3/page.rs`。
- 悬停卡：`next/crates/dr-editor/src/link_card.rs`。
- 文案：`next/crates/dr-i18n/own/*.json` 的 `customModule.countOf`。
