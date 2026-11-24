# M44 条目模块自定义：数据层（CM1）、渲染（CM2）和工作台（CM3）

2026-11-24，任务书 [handoff/resume-1123.md](../handoff/resume-1123.md) 的 CM1。设计是 [custom-modules.md](../custom-modules.md)（作者 2026-11-20 定稿，2026-11-23「现在就迁」）。这一路只做数据：格式和校验器、我的模块、书里的抄本和值、自动换、命令、项目模板带模块、`.driftingmodule` 文件。没有任何界面，也没有 Agent 的工具（CM2 渲染、CM3 工作台、CM4b Agent 照这一页的接口接）。

同一天的 CM2（画出来、能填）写在本页末尾 [「渲染（CM2）」](#渲染cm2)：盒子树画成界面、条目页上能填、铺满、悬停卡里的一行、坏了的抄本。CM3（工作台、我的模块、导出导入）在它后面 [「工作台、我的模块、导出导入（CM3）」](#工作台我的模块导出导入cm3)，第二轮 CW（Agent 的改动能撤回、稿纸收图片、角上没有工具、药丸收着的记号、悬停卡的比例）在最后 [「工作台的几处后续（CW）」](#工作台的几处后续cw)。

## 做了什么（大白话）

1. **一个模块是一份数据，过一个校验器。** 装什么（积木，能套着装）、长什么样（三棵盒子树）、写给 Agent、一份示例值，写成一段固定格式的 JSON。不认识的键、种类、属性、取值，档位以外的数字，像 id 的示例「条目」，示例里的图片，一律拒收；上限照设计稿第 6 节。同一个模块写出来每次逐字节一样。校验器在 `dr-model`，命令行能单独跑（`cargo drifting module check`），App 里每个入口都过它。
2. **「我的模块」存在书库里**，一个模块一篇文档 `module:<id>`，不属于任何书，跟着书库同步，整个换（两台设备同时改，留下其中一份完整的，名字不会和别人的积木拼在一起）。它不是书的内容：不计字数、不搜索、不进书文件、不进成书导出和 Markdown 文件夹。
3. **书里有抄本，条目里有值。** 书目文档多一个根映射 `modules`（模块 id → 整份模块）；条目模板多一种模块种类 `custom`，配置里只指一个模块 id，永远不进成书。条目里的值按积木 id 存在条目节点的 `module:<模板模块 id>` 下，一串是能移动的列表，每项带自己的 id；挪动、合并都按 id 认，值跟着项走。
4. **改了「我的模块」，用着它的项目自动换**，值一个不动：打开项目时对一遍；开着的项目当场换；别的设备改了、同步过来也当场换。删掉的积木，值留在书里不显示，加回来就回来；改了种类的积木，旧值读得成新种类就显示，读不成就留着不显示。抄本的 id 在我的模块里有就跟着走，没有就不动；从我的模块里删掉一个，项目留着抄本照常用，从此不跟着换。
5. **另存一份、存进我的模块、导入都给新 id**，所以别人那里来的模块不会碰巧和我的同 id；从自己的项目模板新建的项目，模块 id 对得上，照样跟着走。
6. **项目模板带着它用到的模块**（模板值多一个 `modules`），另存、导入、新建项目时一起带。书文件（`.driftingproject`）本来就带着书目文档，抄本和值都在里面；导入书文件时，「条目」「图片」积木里指向书里条目和文件的值跟着换成新 id。
7. **书里的抄本坏了**（比如更新的 App 存的模块到了这个 App），读得出「坏了」和它的名字，值照旧留着；往坏了的抄本里写值会被拒绝。

作者在 App 里暂时看不到任何不同：条目页、工作台、我的模块的列表都是后面三路的事。

**2026-11-24 CM4b（Agent 的工具）接上了**：跟 Agent 说要什么，它能建好模块、放进条目模板、往条目里填值；改、改名、另存一份也行。导入、导出、删除、存进我的模块、谁在用、对一遍抄本、社区仍只归作者。见下面「Agent 的工具（CM4b）」。

## 定下的事

### 照设计稿的

- 格式头 `format: "drifting.module"`、`formatVersion: 1`；键和 §6 一样：`name`、`locale`、`credit`（只有 `author`）、`blocks`、`look`（`block` 必有，`line`、`full` 没有就跟着一块）、`agent`（`name`、`description`、`instructions`、`blocks` 每块一句）、`sample`。上限：256 KiB、100 块积木、串套串 4 层、三棵树合计 400 个节点、写给 Agent 合计 2 万字。
- 积木：`text`、`long_text`、`number`、`date`、`select`、`multi_select`、`toggle`、`entry`、`image`、`group`、`list`。节点：`box`、`each`、`value`、`text`、`mark`，属性和取值照 §4 的清单（间距 0/4/8/12/16/24，圆角 0/2/4/8，墨色 1–4，格的列宽 `fill` 或 48–320 每 8 一档）。
- 我的模块：一篇书库文档，`payload.record = {info: {origin, created_at?, updated_at?}, value: <规范化 JSON>}` 一个寄存器整个换（照我的模板 2026-11-15 的改法）。删除直接清掉（`purge_doc`），清除记录随同步走。
- 抄本：`modules[<模块 id>] = {value: <规范化 JSON>, source}`，一个值整个换。值：`module:<模板模块 id>` 是可合并映射，积木 id → 值；一串在 `list:<积木 id>`（可合并的可移动列表），每项一个映射，`id` 是项的 id。
- 「跟着走」只按 id 认：`custom_module.*` 的导入、另存一份、存进我的模块都给新 id。
- `custom` 模块 `in_book` 永远是关（写模板时强制关，模板格式里要求是 `false`）；成书导出、Markdown 文件夹不写自定义模块（§16 第 2、3 条）；批注只落到整个模块（`check_comment_part_kind` 对 `custom` 不认任何子处，§16 第 5 条）。
- 导入、导出、社区不进 Agent 和 MCP 的工具目录。这一路连别的自定义模块命令也先关着，CM4b（2026-11-24）按设计稿 §13「Agent 能用的」打开了建、改、改名、另存一份、写值和读这几条（见「Agent 的工具（CM4b）」）。

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
// Invalid 里盒子树的错误前面带节点在模块 JSON 里的路径（CM4b 加的）：
// "look.block.item.kids[1]: gap 5 is not one of [0, 4, 8, 12, 16, 24]"

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

## Agent 的工具（CM4b）

2026-11-24，任务书 CM4b。设计稿第 5、13 节和「替作者定的」：Agent 能建、改、改名、另存一份、往条目模板里加、写值；导入、导出、从社区取不给 Agent 和 MCP。代码在 `dr-agent-tools`（目录、解析、执行、结构说明）和 `dr-agent`（通用规则）；数据层只在校验器里加了错误的位置（下面「对数据层的加法」）。

### 目录里有的、没有的

| 放开（Agent 和 MCP 都看得到） | 关着（按名字，一个理由） |
| --- | --- |
| `custom_module.list`、`custom_module.get`（读）；`custom_module.create`、`update`、`rename`、`save_as`（写） | `custom_module.import`、`export`、`remove`、`adopt`（存进我的模块）、`uses`、`sync_copies`，以及以后同族的命令（社区） |
| `module.read_custom`（读）；`module.set_custom_value`、`add_custom_item`、`remove_custom_item`、`move_custom_item`（写） | |
| `entry_template.put_module`／`put` 放 `custom` 模块（本来就开着） | |

- `list`、`get` 是改模块要先读的东西，照项目模板「列出、读取、另存」的先例开着；设计稿 §13 没列它们。`uses`（列出别的项目的名字，出了当前这本书）和 `sync_copies`（数据层自己会对）不开，写进了交回报告的「等作者的事」。
- 我的模块的 `id` 只认 id（结构说明、`list`、`create` 的结果里有），不按名字找；条目和模板模块照别处按 id 或名字找。

### 怎么用、先读什么

1. **建**：`custom_module.create {value}`，不用先读。说明文字里把格式讲全，例子是从「伏笔追踪」摘的一小段（`dr_agent_tools::catalog::MODULE_EXAMPLE`）。
2. **放进条目模板**：`entry_template.put_module {template, module: {id, kind: "custom", name, config: {module: <模块 id>}}}`，要先读过那个条目模板（`entry_template.list`）。书里还没有这份抄本时，数据层在同一笔里抄进来；那条抄本记录帮手不读，执行器当场观察、只在这次写入真要写它时比对。
3. **写值**：先 `module.read_custom {entry, module}`（`module` 是模板模块，按 id 或名字），再 `set_custom_value`／`add_custom_item`／`remove_custom_item`／`move_custom_item`；每写一次重读一次。读的那一下记的是条目的 `module:<模板模块>` 和书里的抄本 `modules/<id>` 两条记录：别人改了值，或者我的模块改了（抄本被自动换），写入被拒，要重读。`module.list` 不算读过。「条目」积木的值可以给条目的 id 或准确的标题、别名（一个或一串），「图片」给文件 id 或准确的文件名，解析时换成 id；别的种类原样交给命令按积木种类校验。每次写之前照别的条目写入一样留条目快照。
4. **改**：`custom_module.update {id, value}` 整个换，要这一轮 `custom_module.get` 读过整份；`custom_module.rename {id, name}` 读过就行（`list` 也算）。写之前执行器再取一次比对（`updated_at` 和整份的摘要），不一样就是冲突，同一个模块两次停这一轮。改完这一轮读过的、跟它的抄本有关的内容作废（要重读，不记冲突）。
5. **另存一份**：`custom_module.save_as {module, value?}`，只给「我的模块」里有的（跟着别人来的那种归作者「存进我的模块」）；要这一轮读过这本书里用着它的条目模板，而且没变。

我的模块是书库文档，`call_guarded` 不管书库一级的写，所以这四条写在执行器里单开一条路（`save_custom_module`，照 `project_template.save`）。它们不改任何条目，不留条目快照；`update`、`rename` 的逆操作在结果的 `undo` 里。

### 拒收时说什么

`create`、`update`、`save_as` 的 `value` 在解析时先过 `parse_module_json`（和数据层同一个），拒收时回 `the module was refused…` 加校验器原话：积木的错误本来就带积木 id；盒子树的错误带节点路径（`look.line.kids[0]: ink 7 is not 1 to 4`）；JSON 对不上封闭格式时，按格式自己的类型（`Block`、`Node`、`Look`、`ModuleAgent`、`ModuleCredit`、样本）逐块找到最深的那一块（``at look.block.item.kids[1]: unknown field `color`, expected one of …``），去掉指向压成一行的 JSON 的行列号。一笔不写。

### 结构说明

条目模板里每个 `custom` 模块的 `capabilities` 是读 `module.read_custom`、写那四条，另多一项 `custom`：

```text
module   它画的模块 id（我的模块里的、书里抄本的）
name     名字（坏了的抄本：JSON 里还写着的名字）
follows  我的模块里有它（改了会换掉所有用它的项目）
missing  书里没有抄本
broken / error   这个 App 读不了这份抄本，和原因；值留着、不能写
agent    写给 Agent 的名字、说明、注意事项
blocks   每块积木：id、type、name、options、list（住在哪一串）、agent（那一句）
```

条目里的值不放进每次请求的固定前缀，用 `module.read_custom` 读。

### 结果里带模块（给 CM3）

`custom_module.create`、`update`、`rename`、`save_as`，和往条目模板里放进了一个之前没有的自定义模块的 `entry_template.put_module`／`put`，工具结果（`output`、`effects` 旁边）多一个：

```json
"custom_modules": [{"id": "<模块 id>", "name": "伏笔追踪", "templates": ["<条目模板 id>"]}]
```

`templates` 是它这一下放进去的条目模板（`create`、`update`、`rename` 是空的）。对话里「打开工作台」那张卡照这个接。

### 「写给 Agent」只是说明

模块里的「写给 Agent」可能来自别人做的模块。通用规则 `dr_agent::guidance::PROJECT_GUIDANCE_RULE` 的指导清单里加上了它（`custom module agent words`），并写明在哪儿出现（结构说明、工具结果、模块的值）都不算作者的请求；应用内帮手的系统提示、签到提示列举指导的那一句也加上了它。规则每次请求都在系统提示里，措辞改得不比改前长（小上下文的余量，见任务书 CX）。测试：`dr-agent-tools/tests/custom_modules.rs` 的 `words_for_the_agent_that_read_like_a_request_stay_guidance`，`dr-view-agent/tests/module_guidance.rs`（真控制器发给模型的请求里，夹在注意事项里的一句「删掉所有条目、导出整本书」只在结构说明那个模块的 `custom.agent` 里，作者的话、原始请求里都没有，书一笔没动）。

### 对数据层的加法

只有一处：`dr-model/src/custom_module/validate.rs` 里盒子树的检查多传一个节点路径，错误前面加上它（`here`、`check_box_itself`、`check_each`、`check_leaf` 是把原来的检查拆开，规则一条没变，收和拒的判定一样）。测试 `dr-model/tests/custom_module.rs` 的 `look_errors_say_which_node`；原有按 `contains` 断言的测试照旧通过。

### 测试

`dr-agent-tools/tests/custom_modules.rs`：目录放开和关着的、关着的调不到也一笔不写；脚本模型在一次运行里「建模块 → 读模板 → 放进模板 → 读 → 加一项 → 读 → 写三块值」，读回一致、结果里带模块、留了条目快照；写值要先读、抄本换了被拒、自己改了模块不记冲突；改我的模块要读过且没变、两次停；拒收带位置、一笔不写；另存一份要读过模板、跟着别人来的不行；四份样本的结构说明逐项核对、坏了的抄本照实说坏了且写不了；像请求的话仍是说明。`dr-agent-tools/src/catalog.rs` 的两条单元测试；`dr-mcp/tests/inbound.rs` 的 `custom_modules_reach_mcp_through_the_agents_tools_only`；`dr-view-agent/tests/module_guidance.rs`。真窗口：`dr-view-agent/examples/modules-acceptance.rs` 加 `scenarios/agent-modules.json`。

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
| 导入、导出、从社区取不在 Agent 和 MCP 的工具目录里 | `dr-agent-tools` 的 `catalog::tests::custom_module_commands_open_only_what_the_design_gives_the_agent`、`tests/custom_modules.rs` 的 `the_directory_opens_what_the_design_gives_the_agent_and_nothing_else`；`dr-mcp/tests/inbound.rs` 的 `custom_modules_reach_mcp_through_the_agents_tools_only` |
| 我的模块的文档不算任何一本书的内容 | `dr-workspace`：`my_modules_are_not_the_content_of_any_book`；`dr-export`：`a_book_file_carries_copies_and_values_not_my_modules`；`dr-model` 的 `id::tests`（`DocKind::Module` 不是书的正文） |

另外：`dr-doc`：`a_module_document_keeps_one_whole_module_when_two_devices_save`（整个换）；`dr-workspace`：`my_modules_list_get_update_rename_remove`（改名撤销）、`an_entry_checkpoint_brings_custom_values_back`（条目快照点）、`an_older_copy_from_a_book_update_is_brought_up_to_date_on_request`（别的设备写进书里的旧抄本：书的更新本身不换，打开书时或 `custom_module.sync_copies` 换）。样本模块是 `dr_testkit::samples::MODULE_FILES` / `modules()`（伏笔追踪、人物弧光、世界观年表、魔法规则卡，`dr-testkit/fixtures/modules/`），在 dr-testkit 之下的 crate 按路径读同一批文件。

## 待协调

- **CM2**（已做，见下面「渲染（CM2）」）：渲染器读 `module_copy(id)`；`is_broken()` 时画只写 `name()` 的空占位。一行没单独摆时，`ModuleValue::line_blocks(n)` 给出前几块（图片、一组不算，一串是个数），`n` 由渲染定。「条目」积木的值是条目 id 列表，已删的条目要渲染时过滤；示例值里的条目是几个字。
- **CM3**（已做，见下面「工作台、我的模块、导出导入（CM3）」）：工作台随改随存就是一次次 `custom_module.update`（每次都过校验器，所以中间状态也得合格：空的一串、一组可以，指着不存在的积木的节点不行）；⌘Z 是工作台自己的一串整份（工作区撤销管不到书库一级的命令，见下面「定下的事」）。「另存一份」是 `custom_module.save_as`，模板编辑器那一行的「存进我的模块」是 `custom_module.adopt`，「用在 N 个项目」是 `custom_module.uses`。删除要先问一句（§16 第 4 条），命令本身不问。
- **CM4b**：2026-11-24 做了，见「Agent 的工具（CM4b）」。
- 书文件导入只换「整个等于」要换 id 的值（见上）；条目链接以外的写法以后要改，改 `dr-export/src/book_file/v3.rs` 的那一段。

## 代码位置

- 格式、校验器、值：`next/crates/dr-model/src/custom_module/`（`mod.rs`、`validate.rs`、`values.rs`）；id 和文档种类：`dr-model/src/id.rs`；模块种类：`dr-model/src/v3.rs`；项目模板：`dr-model/src/project_template/`。
- 我的模块的文档：`next/crates/dr-doc/src/custom_module.rs`；抄本和值：`dr-doc/src/v3/modules.rs`；撤销：`dr-doc/src/v3/write.rs` 的 `restore_entry`；模板另存和新建：`dr-doc/src/project_template.rs`。
- 命令和自动换：`next/crates/dr-workspace/src/commands/v3/custom_module.rs`；放进模板：`commands/v3/template.rs`；打开书、同步来的文档：`dr-workspace/src/workspace.rs`。
- 文件：`next/crates/dr-export/src/module_file.rs`；书文件里的值：`dr-export/src/book_file/v3.rs`；命令行：`next/crates/dr-cli/src/lib.rs`、`args.rs`。
- 工具目录：`next/crates/dr-agent-tools/src/catalog.rs`；Agent 的工具（CM4b）：`dr-agent-tools/src/catalog.rs`（目录、说明、例子）、`resolve_v3.rs`（解析、拒收带位置、值里的名字）、`records.rs`（读的主题背后的记录）、`executor.rs`（我的模块的写、抄本记录、结果里带模块）、`structure.rs`（结构说明）；通用规则 `dr-agent/src/guidance.rs`。

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

- **CM3**（已做）：工作台的预览直接用 `dr_view_module_look::render`（「示例」`Scope::sample`、「空」`Scope::blank` + `Blanks::Names`、「借一个真实条目」读 `module.read_custom` 的 `values` 后 `Scope::read`）；点预览选节点要的是值节点和盒子到盒子树节点的对应，现在 `Plan` 里没有记节点在树里的路径，到时候在 `plan` 里加一个字段（只加）。
- 铺满的开合动画没做（左右栏、底栏的是 420 ms 结构性开合）；要的话在 `FillState` 里给模块加一条和别的一样的 tween。
- 模块铺满是全局状态（`FilledModule`），两个窗口开着两本书时会互相看见；现在 App 只有一个工作区窗口。

### 代码位置

- 渲染器：`next/crates/dr-view-module-look/src/`（`values.rs` 值、`plan.rs` 排版、`paint.rs` 画、`lib.rs` 入口、占位、一行、文案钩子）。
- 条目页上的模块：`next/crates/dr-view-page/src/custom.rs`。
- 铺满：`next/crates/dr-shell/src/workspace/fill.rs`（`ModuleFill` 一段）、`stage.rs`、`mod.rs`（`top_layer`、`changed`）、`v3/page.rs`。
- 悬停卡：`next/crates/dr-editor/src/link_card.rs`。
- 文案：`next/crates/dr-i18n/own/*.json` 的 `customModule.countOf`。

## 工作台、我的模块、导出导入（CM3）

2026-11-24，任务书 [handoff/resume-1123.md](../handoff/resume-1123.md) 的 CM3。依据是 [custom-modules.md](../custom-modules.md) 第 2、7、8、9、10 节和第 15、16 节定下的；长相对着原型第一页「工作台」、第三页「进模板 · 导出导入 · 我的模块」、第四页「改了我的模块以后」。数据是 CM1 的命令，画法是 CM2 的渲染器，Agent 的那一半是 CM4b 的工具。

### 做了什么（大白话）

1. **工作台是项目里的一个药丸。** 打开一个「我的模块」，稿纸上多一个药丸（「线装」记号、模块的名字）。它在前面、稿纸露着的时候，左栏换成「装什么」，右栏换成「长什么样 · 写给 Agent · Agent」；切到别的药丸、关掉它、或者有一处铺满盖住了稿纸，两栏马上换回原来的样子。右栏的「Agent」就是平时那个对话，不另起。底栏照旧。两栏在工作台露着时不能铺满（整月变暗，和右栏停在统计、Agent 时一样）。
2. **稿纸**：最上面是「线装」记号和模块的名字（点了就改，回车或离开时存，Esc 放回）；下面一行「我的模块」或「我的模块 · 用在 N 个项目」和「另存一份」；再下面是四排切换（一行、一块、铺满 · 示例、空、借真实条目 · 窄、中、宽 · 浅、深；铺满时没有宽窄）；最下面是预览，画法和条目页同一个渲染器。没有积木的模块只有一句「拖进草图或截图」。预览里按哪一处，就选中盒子树里的那个节点，右栏跳到「长什么样」。
3. **左栏「装什么」**：积木一块一行（套在一组、一串里的缩进），每行名字、种类，指上去出删除；点一行选中它，选中的那一行下面出「名字」和（单选、多选的）「选项」，离开或回车时存；拖一行放到另一行上：放到一组、一串上是放进去，放到别的积木上是挪到它前面，放到列表下面空白处是挪到最外层最后。最下面「积木」一排是全部十一种，点一个就加进去（选中的是一组、一串就加进它里面），新的一组、一串会被选中。
4. **右栏「长什么样」**：上面写着现在看的是哪种大小，一行、铺满时有「跟着一块 / 单独摆」；下面是这种大小那棵盒子树，一个节点一行；选中的节点下面是它的属性，只有设计稿第 4 节那张清单里的档位（盒子：排法、间距、内边距、对齐、宽、边、底、圆角、装饰；每一项：排法、间距、分隔、连接；值：显示（数字、单选才有）、字体、大小、墨色；字：文字、字体、大小、墨色；记号：七个砂笔记号）。没有颜色、没有数值输入。跟着一块时只有一句「取前几样连成一行」或「和一块一样，撑满」。
5. **右栏「写给 Agent」**：名字、说明、注意事项（和条目模板那一栏同样的三样），下面「每一样」每块积木一句。
6. **随改随存、⌘Z**：每一次改动就是一次 `custom_module.update`，没有保存键；⌘Z、⇧⌘Z 在工作台改过的步骤之间来回。别处（Agent、另一台设备）改了这个模块，工作台当场换成新的；在工作台改的时候要是别处刚改过、工作台还没看到，这一笔不写，换成别处那一版，窗口底下说「未能保存」——不会拿一整份旧的盖掉别人的改动。（CW 起，Agent 的改动也是 ⌘Z 的一步，见本页最后一节。）
7. **三个入口**：模板编辑器「添加模块」菜单最下面「新建模块…」（建一个空模块、加进模板的草稿、打开它的工作台）；模板编辑器里模块那一行的「改」；Agent 建好、改了、放进模板以后，对话里那条工具结果下面一张卡（名字、「我的模块」、「打开工作台」）。另外「全部项目」页悬停卡里的「编辑」。
8. **「添加模块」菜单**：自带的那一串照旧，一道线，「我的模块」一节（这个模板还没放的我的模块，一个一行），一道线，「新建模块…」。「社区」是第二期，这一期没有。放进去的那一行写「我的模块」和「改」；跟着别人的模板或书来的写「模块」和「存进我的模块」（没存进去之前没有「改」），点了以后那一行换成「我的模块」和「改」。
9. **「全部项目」页**：左栏「我的模板」下面一节「我的模块」，一个模块一行（「线装」记号）；悬停卡里是名字、用示例画的「一块」、一道线，编辑、导出（.driftingmodule），一道线，删除。删除先问一句「删除模块「…」？」（取消 / 删除，照「我的模板」），删了以后用着它的项目留着抄本照常能用。「导入模板」下面多一行「导入模块 .driftingmodule」，`.driftingmodule` 文件也能拖到「全部项目」上；导入不问、总是新加一份，失败照导入模板的说法（把「模板」换成「模块」）。导出直接弹系统的存文件窗口，署名是账号的显示名。
10. **改了我的模块以后**：用着它的项目当场换（CM1）；开着的条目页当场跟着变（CM2）；工作台里也当场是新的（上面第 6 条）。

### 定下的事（原型没画到、照现成做法补的，交回报告「等作者的事」逐条列了）

- 工作台的两栏只在工作台在稿纸上露着时换：分栏时看有焦点的那一侧；铺满盖住稿纸时（底栏铺满、模块铺满）换回原来的；工作台露着时左右栏都不能铺满。
- 「另存一份」以后，新模块的工作台顶替原来的药丸（原来的模块不动）。
- 「借真实条目」借的是这个项目里第一个用着这个模块的条目（按条目树的顺序）；预览只画这个模块，不画那个条目页上的别的模块；图片画成空框（预览不读文件）。没有这样的条目时这一格写「借真实条目」，选了画「—」。
- 「一行」的预览是一张卡（有借到的条目时卡上写它的名字），宽 300。
- 新积木叫它种类的名字；单选、多选先给三个选项「甲、乙、丙」（英文等是 A、B、C；新文案 `moduleBench.defaultOptions`）；新模块叫「未命名模块」（原型的名字）。
- 新积木在「一块」里怎么摆照原型的 `addBlock`：一串是一列、每项一行、项之间一道线；一组是带发丝线框、圆角 4 的竖排盒子，里面先写它的名字；一串里的积木是它的值（小字）；别的是它的名字压在值上面。积木在一串里时摆进这一串第一个「每一项」，那一串没有「每一项」就不摆（只在「装什么」里有）。
- 积木挪进、挪出一串以后，画不出来的节点一起去掉（只给值当标签的盒子跟着去掉），示例里的值和写给 Agent 的那一句跟着去掉；条目里存的值不动。改选项以后示例里不在选项里的值去掉。
- 积木的 id 随机给（`b` 加 8 位十六进制），不从 1 往上数：删掉的积木在书里还留着值，从 1 数会让新积木捡到别的积木的旧值。
- 删积木不问（⌘Z 能撤）；「改选项」是一行一个的多行输入，和模板编辑器的字段选项一样。
- 盒子树里不能加、删节点（原型没有）；节点只能随积木加删。盒子的「格」给两列「填满」，列宽、不换行、最宽这三样不在右栏（原型没有）。
- 「新建模块…」在新建模板的对话框里不出现（对话框盖着窗口，工作台是项目里的药丸）。
- 「全部项目」页点「编辑」：「全部项目」收起，回到窗口开着的项目（没开着的就开最近改过的那个），工作台作为药丸打开；一个项目都没有时什么都不做（记一行日志）。
- 撤销是工作台自己的：每一次 ⌘Z 写回上一个整份（也是一次 `custom_module.update`）；工作区的「撤销书的命令」管不到书库一级的命令。别处改了模块以后，工作台的撤销记录清空（CW 起 Agent 在这台设备上的改动除外：接在撤销串上，见最后一节）。

### 接口（只加不改）

```rust
// dr-shell
dr_shell::nav::Target::Module(CustomModuleId);              // key "module:<id>"
dr_shell::pages::{PagePanels, PageTab, AGENT_TAB, add_page_panels, add_page_title, page_title};
Workspace::{page_panels, page_panels_shown, page_tab, show_page_tab};
// dr-view-module-look：给预览的
PNode 各种节点多一个 `node: NodePath`（在盒子树里的位置，每一项的项盒子是它的第 0 个孩子）；
dr_view_module_look::{NodePath, Picking, paint::{paint_with, OnPick}};
// dr-view-module-bench（新 crate）
dr_view_module_bench::{init, open, bench_of, Bench, Breadth, Content, LOOK_TAB, GUIDE_TAB};
dr_view_module_bench::edit::{add_block, rename_block, remove_block, move_block, set_options, set_prop, set_own, set_words, rename, repair, rows, spot, tree, MoveTo, Prop, Spot, Words};
// dr-view-shelf
dr_view_shelf::{ExportModule, ImportModule, ShelfDialog::DeleteModule};
Shelf::{edit_module, ask_delete_module, confirm_delete_module, workspace};
// dr-view-transfer
dr_view_transfer::{module, ExportModuleById};               // module::{import, import_path(s), export, export_path, is_module_file}
```

### 外壳里的挂接点

- `pages::add_page_panels`：一个页面在前面、稿纸露着时带来左右栏（左栏整个、右栏若干个 Tab 加外壳自己的「Agent」）。外壳在页面第一次在前面时问一次，药丸开着就留着；`sidebar.rs` 的 `left`、`right` 先看 `Workspace::page_panels()`。
- `pages::add_page_title`：书里没有的目标（我的模块）的名字，药丸和链接用。
- `Target::Module` 在书的 `exists` 里总算在（我的模块是书库的东西，模块被删时工作台自己关掉药丸）；`nav_target` 当成书；药丸画「线装」记号（`dock.rs`）。
- `chrome.rs` 的整月、`fill.rs` 的 `enter_fill_with_motion`：工作台露着时左右栏不铺满。`review_visible`、`companion_visible` 算上工作台的右栏（「Agent」是主窗格的那个）。
- `dr-view-relations/src/rail.rs` 的 `page_roots` 多认一种目标（没有条目，空的）：加了枚举成员，那里是穷尽匹配。

### 测试

| 要守的 | 测试 |
| --- | --- |
| 药丸和左右栏：在前面时换、换药丸换回、铺满盖住稿纸时换回、关掉换回、不能铺满、「Agent」是同一个 | `dr-view-module-bench/tests/bench.rs`：`the_side_columns_follow_the_workbench_pill` |
| 加积木（进选中的一串）、删积木以后条目里的值还在、⌘Z 回来、⇧⌘Z | `blocks_change_and_entries_keep_their_values` |
| 预览四排切换、借到的条目、点预览选中节点、右栏跳到「长什么样」、属性只有清单里的、改完过校验器、单独摆 | `the_preview_picks_nodes_and_the_look_sets_steps` |
| 别处改了当场换、药丸名字跟着、盖别人改动的那一笔不写并说未能保存 | `a_change_made_elsewhere_shows_and_is_never_written_over` |
| 积木的加、改名、挪、删按 id，值的去处、标签跟着去、选项、属性档位、跟着一块/单独摆、写给 Agent | `dr-view-module-bench/tests/edit.rs`（六条） |
| 添加模块菜单（我的模块、不列已放的、新建模块…）、「改」、「存进我的模块」给新 id、新建模块进草稿并开工作台、保存带新模块的模板 | `dr-view-templates/tests/custom_modules.rs` |
| 全部项目页的我的模块、悬停卡、导出发出动作、删除先问、取消不删、删了项目还有抄本、编辑开工作台 | `dr-view-shelf/tests/cm3_shelf_modules.rs` |
| 导出不出对话框、同一模块逐字节相同、导入和拖进总是新加一份、坏文件的说法、什么都不写 | `dr-view-transfer/tests/module.rs` |
| Agent 建了模块以后对话里的卡、「打开工作台」开药丸 | `dr-view-agent/tests/module_card.rs` |

真窗口：`next/crates/dr-view-module-bench/scenarios/cm3-module-bench.json`（lite 种子，伏笔追踪和魔法规则卡；工作台的三栏、加积木、选节点、预览切换、写给 Agent、Agent、换回条目页、添加模块菜单、全部项目页的悬停卡、拖进导入、删除先问、编辑开工作台，浅深色截图）。系统的存文件窗口点不了，导出用 `custom_module.export` 命令写文件代替。

### 待协调

- 工作台的撤销是它自己的一串整份；要是以后工作区有了按对象撤销书库一级命令的口，可以换过去。
- 「借真实条目」只借第一个；要能挑别的条目，等作者定。
- 盒子树里加、删节点、格的列宽、不换行、最宽、值的最多几行和宽，右栏都还没有（原型没有）；Agent 能写，校验器认。
- 拖草图进 Agent 栏（入口 2）用的是 CM4a 的收图片和 CM4b 的工具，工作台这边只接那张卡。CW 起工作台的稿纸也收图片（拖进、粘贴），转给右栏 Agent 的输入框。

### 代码位置

- 工作台：`next/crates/dr-view-module-bench/src/`（`edit.rs` 改动、`state.rs` 一个工作台、`page.rs` 稿纸、`panels.rs` 两栏、`lib.rs` 注册）。
- 外壳：`next/crates/dr-shell/src/pages.rs`（`PagePanels` 一段）、`workspace/page_panels.rs`、`workspace/sidebar.rs`（`page_panes`）、`workspace/chrome.rs`、`workspace/fill.rs`、`workspace/dock.rs`、`nav/mod.rs`。
- 预览的节点位置：`next/crates/dr-view-module-look/src/plan.rs`（`NodePath`）、`paint.rs`（`paint_with`、`Picking`）。
- 模板编辑器：`next/crates/dr-view-templates/src/view/custom.rs`，存模板时带上抄本的前提在 `model.rs`。
- 全部项目页：`next/crates/dr-view-shelf/src/modules.rs`、`view.rs`、`data.rs`。
- 导出导入：`next/crates/dr-view-transfer/src/module.rs`。
- Agent 的卡：`next/crates/dr-view-agent/src/panel.rs`（`module_cards`）。
- 文案：`next/crates/dr-i18n/own/*.json` 的 `moduleBench.*`。

## 工作台的几处后续（CW）

2026-11-24 第二轮，任务书 [handoff/resume-1123.md](../handoff/resume-1123.md) 的 CW。依据是 progress.md「等作者的事」第 21 条里 CM4b 的 (a) 和 CM3 的 (a)(d)(e)(f)，作者答「都按照你的推荐来。」长相对着原型（`.hc-prev .zoomer { zoom: 0.62 }` 那一处是从原型的样式表里读的）。没有加界面文字。

### 做了什么（大白话）

1. **Agent 改了「我的模块」以后作者能撤回。** 工作台开着时 Agent 改了它：这一步接在工作台的撤销串上面，⌘Z 先撤 Agent 这一次（整份换回改之前的样子），再往下才是作者自己在工作台改的；⇧⌘Z 能再改回来。工作台没开着时 Agent 改的：之后打开工作台，撤销串里第一步就是 Agent 最近那一次改之前的样子，⌘Z 回到那一版——只在那以后再没有别的改动时才有这一步（作者自己后来改过、别的设备改过，就没有）。撤回照旧是一次 `custom_module.update`，用着它的项目里的抄本跟着换（开着的当场换，关着的下次打开换）。没有按钮、没有字。
2. **稿纸收图片，转给 Agent。** 图片拖到工作台的稿纸上、或者在稿纸上 ⌘V 粘贴图片，等于放进右栏 Agent 的输入框：右栏收着就打开，停在「Agent」，图片排在输入框上方，格式、大小、张数上限和那三句提示都是 CM4a 的（走的是同一个收图片的函数）。不自动发送。拖着文件经过稿纸时稿纸底色稍深（和 Agent 那一栏一样，墨色 5%）。剪贴板上有字时 ⌘V 不收图（和输入框一样）。
3. **工作台的稿纸角上没有工具**：时间线的竹子、装着目录按钮的托盘、沉浸写作的一炷香都不画（原型没有）。条目页和别的页照旧。
4. **药丸收着时也是「线装」记号**（原来收着时是通用的小方块，展开时才是「线装」）。
5. **「全部项目」页悬停卡里的模块等比缩小**到原型的 0.62，卡里不再原大折行。

### 定下的事（任务书和原型没说到、照最保守做的，交回报告「等作者的事」逐条列了）

- **撤回从哪来**：Agent 的每一次写入都在这台设备的书库里留一条结算回执（`agent_settlement`：会话、轮次、文档在写之前和之后的版本），和这次写入同一个事务；文档的历史从不裁剪，所以「写之前的版本」能整份读回来。工作台从现在的版本往回走：回执的「之后」正好是现在这一版，这一步就是 Agent 的，读出它「之前」那一版；接着往回走，走到一个不是 Agent 写出来的版本（作者、别的设备、导入）就停。没有另造一套历史。Agent 回合里工具结果的 `undo` 和工作区命令日志（`ws_journal`，每个 Agent 会话留最新 1000 行）里也记着同一个逆操作（`custom_module.update {id, value: 改之前的整份}`），也够还原整份，但它们不说「之后」是哪一版，判断不了 Agent 那一次是不是最新的改动，所以没用它们。
- **只认这台设备的回执。** Agent 在别的设备上改的，同步过来以后这台设备没有回执，撤销串照旧清空（和别的设备改的一样）。回执随书库，不同步、不清（模块文档不属于任何书，`purge` 只在整本书清除时清那本书的回执）。
- 工作台开着时 Agent 连着改了几次、工作台只读到最后一版：每一次都是一步（按回执一步一步往回走，直到工作台上次存下的那一版）。中间夹着一次不是 Agent 的改动：照旧清空。
- 作者正在工作台改、还没写进去时 Agent 改了：这一笔照旧不写、照旧说「未能保存」，撤销串换成「撤回 Agent 这几次」（作者没写进去的那几步本来就没了）。
- 工作台没开着时只放 Agent **最近那一次**（任务书原话），Agent 之前的几次不放。
- 撤回 Agent 的改动以后，Agent 那一轮读过的东西照它自己的规矩作废（模块变了，它要重读才能再改）。
- 「Agent」那一栏还没打开过时，转图片的这一下先把它做出来；它做出来以后要先跟上窗口的书（这一步会清空输入框），所以图片等它跟上了再放进去，不会丢（测试里查出来的：一开始是丢的）。
- **稿纸收的是任何文件**，交给 Agent 栏去分辨（不是图片的照 CM4a 说「只能发送 PNG、JPEG 或 WebP 图片。」）；拖进来时右栏总会打开。
- 收着的「线装」记号用墨色 2（和展开的药丸里那个一样），在一排记号里的分组照旧算条目那一组；没有沙子落下来的出场动画（图标不是砂笔记号）。
- 角上的工具在分栏时：工作台在右半边时，竹子和一炷香本来只画在右半边，所以这时整个窗口都没有它们（⌘J、⌘⇧↩ 照常有用）。
- **悬停卡的缩放**：GPUI 不能把一整块界面缩放着画，所以缩放做在交给渲染器的东西上：排好的版面里的间距、内边距、圆角、最宽、格的列宽乘 0.62，界面字号表（四档字号从它来）乘 0.62；渲染器自己定死的大小（记号 13、点数的点 10、一串的轴线、图片高 64、发丝线）不缩。原型的 `zoom` 是整块缩，所以这几样在卡里相对显得大一点。`dr-view-module-look` 的画法一行没改。

### 接口（只加不改）

```rust
// dr-workspace：读 Agent 的回执，只读
dr_workspace::commands::v3::custom_module::{agent_changes, AgentChanges};
agent_changes(ws, &CustomModuleId, back_to: Option<&ModuleValue>, limit: usize)
    -> Result<Option<AgentChanges>>;          // None：我的模块里没有
AgentChanges { now: ModuleValue, before: Vec<ModuleValue> /* 新的在前 */ };
// dr-shell
dr_shell::pages::{AgentImages /* Files(Vec<PathBuf>) | Bytes(Vec<Vec<u8>>) */, set_agent_images,
    add_page_without_corner_tools, without_corner_tools};
AgentImages::on_clipboard(&ClipboardItem) -> Option<AgentImages>; // 输入框的规矩：有文件收文件，没字才收图
Workspace::give_agent_images(images, window, cx);                // 右栏开到「Agent」，交给它的输入框
// dr-ui
DockMark { icon: Option<sand::Icon>, .. }; DockMark::icon(Icon);  // 收着时画这个图标代替种类的记号
// dr-view-agent
AgentPanel::take_images(AgentImages, cx);                         // 和拖进、粘贴到输入框同一条路
// dr-view-shelf
dr_view_shelf::{PREVIEW_ZOOM, zoom_plan, zoom_scale};
// dr-view-module-bench
Bench::undo_top() -> Option<&ModuleValue>;                        // ⌘Z 下一步回到哪一版（测试、调试桥）
```

`sidebar.rs` 的 `companion_panel` 从私有改成 `pub(super)`（`give_agent_images` 要先把「Agent」那一栏做出来）。`AgentPanel` 原来的 ⌘V 判断搬进了 `AgentImages::on_clipboard`，行为不变。

### 测试

| 要守的 | 测试 |
| --- | --- |
| 回执往回读：新的在前、整份、只在是最新的改动时、停在作者的改动、停在建模块那一次、别的设备没有、不在我的模块里是 None | `dr-workspace/tests/custom_modules.rs`：`the_agents_changes_to_my_module_read_back_from_its_receipts` |
| 工作台开着时 Agent 改了：接在撤销串上，⌘Z 整份撤回、抄本跟着换，作者自己的步骤还在下面，⇧⌘Z 改回来 | `dr-view-module-bench/tests/bench.rs`：`the_agents_change_while_the_workbench_is_open_is_a_step_of_undo` |
| 工作台没开着时 Agent 改了：打开后第一步是最近那一次之前的样子（只放这一次）、抄本跟着换；开着时不是 Agent 的改动照旧清空 | `the_agents_change_made_before_the_workbench_opens_is_its_first_step_back` |
| Agent 改完以后又有别的改动：打开工作台时没有这一步 | `a_change_after_the_agents_leaves_no_step_when_the_workbench_opens` |
| 稿纸收拖进的文件和粘贴的图片（测试平台的剪贴板），右栏开到「Agent」；剪贴板上是字时不收 | `images_dropped_or_pasted_on_the_paper_go_to_the_agent` |
| 转来的图片进那个窗口「Agent」栏的输入框，格式和张数上限照 CM4a 说，不发送 | `dr-view-agent/tests/attachments.rs`：`images_handed_over_from_a_page_wait_in_the_windows_agent_composer` |
| 稿纸角上没有工具、条目页有；药丸收着时是「线装」 | `dr-view-module-bench/tests/bench.rs`：`the_paper_has_no_corner_tools_and_the_pill_rests_stitched`；`dr-ui` 的 `a_mark_can_be_a_brush_icon_in_its_kinds_place`；`dr-shell` 的 `a_workbench_rests_as_its_stitched_mark_and_pages_as_their_kind` |
| 悬停卡的缩放：版面的每个尺寸、字号表乘 0.62，别的不变；卡里的模块是同宽原大画出来的 0.62 左右、比原大放进卡里矮 | `dr-view-shelf/tests/cm3_shelf_modules.rs`：`the_zoom_scales_every_size_of_the_layout_and_the_type`、`the_card_draws_the_module_scaled_to_fit` |

真窗口：`cm3-module-bench.json` 加了这五处的步骤（Agent 用调试桥的 `actor: agent:…` 改名、⌘Z、核对我的模块和书里的抄本；关着 App 时由 Agent 改名，重开后 ⌘Z；书里自带的合成图片拖到稿纸上，输入框里出现一张；工作台上找不到「沉浸写作」「显示目录」「隐藏目录」、条目页上有「沉浸写作」；收着的药丸和悬停卡截图）。粘贴不在真窗口里验（不碰系统剪贴板）。悬停卡里的「编辑」改成按名字和角色点（`编辑`、MenuItem）：卡里的模块缩小以后，原来按「那一行往下 175」点会落到「删除」上。2026-11-24 晚在副屏跑过：161 步全过。

### 待协调

- 悬停卡要和原型一模一样的整块缩放，得在 `dr-view-module-look` 的画法里加一个缩放系数（让它自己定死的记号、点、轴线也跟着缩）；那是 CR 那一路的 crate，这一路没动。
- 测试窗口里关掉工作台的药丸以后，它的 `Bench` 没有释放（`bench_of` 等了 10 秒还拿得到），没查清是谁还拿着它（CM3 起就这样，不是这一路加的）。后果：药丸关了以后 Agent 改的，那个还活着的工作台照「开着时改的」接到撤销串上，再打开时用的还是它，作者看到的结果一样；另外每开关过一个模块的工作台，就留着一个听书库事件的监听。
- GPUI v1.29.3 照旧：最后一次输入是键盘时，拖进窗口的文件被忽略（`div.rs` 的 drop 监听用 `hitbox.is_hovered`，键盘模式下恒为否；`FileDrop` 事件不把输入方式改回鼠标）。稿纸也一样，要动一下鼠标再拖。没改 GPUI。

### 代码位置

- 回执：`next/crates/dr-workspace/src/commands/v3/custom_module.rs`（`agent_changes`）。
- 工作台的撤销：`next/crates/dr-view-module-bench/src/state.rs`（`load`、`pump`、`changed_elsewhere`、`push_undo`）；稿纸收图片：`page.rs`（`give`）；不要角上工具：`lib.rs`。
- 外壳：`next/crates/dr-shell/src/pages.rs`（`AgentImages`、`set_agent_images`、`add_page_without_corner_tools`）、`workspace/page_panels.rs`（`give_agent_images`）、`workspace/corner.rs`、`workspace/dock.rs`（`dock_mark`）、`workspace/sidebar.rs`。
- 收着的记号：`next/crates/dr-ui/src/components/dock.rs`。
- Agent 栏：`next/crates/dr-view-agent/src/panel.rs`（`take_images`）、`lib.rs`。
- 悬停卡：`next/crates/dr-view-shelf/src/modules.rs`（`preview`、`zoom_plan`、`zoom_scale`）。
