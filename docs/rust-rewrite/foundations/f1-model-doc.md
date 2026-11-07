# F1：dr-model 与 dr-doc

2026-11-07，两轮：第一轮把结构做成库（结构改成 v1），第二轮按监管会话的两份审查补数据、改顺序（结构改成 v2）。计划见 [foundation.md 的 F1](../foundation.md#f1-dr-model-与-dr-doc)，文档结构见 [loro-schema.md](../loro-schema.md)，代码在 `next/crates/dr-model/` 和 `next/crates/dr-doc/`。

## 做了什么（大白话）

1. **把 P0-C 探针里的文档结构做成了两个正式的库。** 以后所有功能模块读写书和正文，都只经过它们：
   - `dr-model` 是「词汇表」：各种 id、每类实体长什么样、顺序怎么排、写入从哪来、哪些规矩必须成立。它不认识 Loro，谁都能用。
   - `dr-doc` 是「文档本身」：一本书一个书目文档、每篇正文一个正文文档，读写都有类型，模块拿不到裸的 Loro 文档。
2. **旧版的规矩逐条对过了。** 旧版靠同步内核、SQL 约束和触发器守住 70 条领域规则（触发器总共写过 144 个，现在还生效的 126 个）。新版的数据会自动合并，「写的时候拦住」在两台设备之间做不到，所以每条都写明了换成什么办法：命令层预防、读的时候容忍、后台修复，或者数据结构本身就不允许。清单 71 条，另有 14 条写明了为什么不再需要。
3. **实现时发现 v0 结构有一处错，改成了 v1。** 内置关系类型（用来把 TODO 和素材挂到章节、要素上的那个）在旧版是有向的，v0 写成了对称的；照 v0 做，「TODO → 要素」可能被存反。还补了两处漏的：批注可以只挂在某一段上（`target_block`），实体种类的字符串写明了。详见 loro-schema.md 的「v0 → v1」。
4. **模糊测试找到两个会让程序直接崩掉的问题，都已挡住。**
   - 一份坏掉的存储字节，能让 Loro 的批量导入申请近 29 GB 内存。原因是 Loro 的批量导入不先查校验和。现在 `dr-doc` 载入前先逐份查，坏字节只会报错。
   - 一个坏掉的批注锚点，能让 Loro 在解析时直接 panic（它指向一个文档里不存在的容器）。现在解析前先确认锚点指向这篇正文，不是就当作「未定位」。

5. **第二轮：补上旧版有、v1 漏了的数据，改了列表的顺序，结构升到 v2。**
   - 补进书目文档：关系类型的颜色、全书和每日的字数目标、关系图里拖动固定的位置。这三样旧版只存在本机，换台电脑就没了。还补了素材描述、批注当时的原文和各段快照（「查看原文」「原文已改」靠它）、图片和 PDF 上的区域批注。
   - 纯列表（故事线、补丁、素材、各种字段列表、表格行列）的顺序从数字改成分数索引字符串。数字要「打散重排」，两台设备各排一遍再合并就乱了；位置键挪一项只动这一项。格式照搬旧版用的库，旧键一个字节都不用改。
   - 待办只有一份真相：链了待办的任务行不再存自己的勾；从正文生成的待办，id 由文档和块算出，两台设备生成的是同一个。
   - 删掉不该进书目文档的：节点的 `updated_at`（每阵打字都会变）、素材的预览图网址（早就一直为空）。退役的 Copilot 取值不进新结构，导入时规整。
   - 新增「按对象恢复快照」的接口：在历史副本上读出这个对象当时的字段，作为新提交写回，书里别的东西不动。
   - 界面和 Agent 做法不一样的 9 处（删章时关系、批注、构想绑定、分类里的要素、故事线成员怎么办，删关系类型，重名时加后缀还是报错）列成了清单，每条写了建议的统一做法，等 F3 照着做成一条命令。
   - 视图数据逐项定了放哪：作者亲手摆的（关系图固定位置、情节规划格子宽高）进书目文档，看的方式（视图模式、视口、滚动位置、手调比例、栏宽）放本机。

**要作者定的事：没有。** 都是技术取舍，下面写了理由。

## 为什么这样做

- **一个写入者，多个读者。** 每篇文档只有一个 `ProseDoc` / `BookDoc` 能写（写要独占借用），由 F2 的文档持有者线程拿着；界面和别的线程拿 `reader()` 读。这样作者的按键和 Agent 的写入在类型上就不可能落进同一次提交。
- **每次写入都交还给存储。** `edit` 返回 `Committed`：恰好这一次提交的更新字节和它的来源。存储先把它追加进 SQLite，再发事件、再上传。撤销、修复也一样返回，不会有绕过存储的本机写入。
- **写不下去也不留半截在外面。** Loro 没有「回滚未提交的改动」。所以 `edit` 里不管闭包成功与否都提交，来源照样是这次的来源；命令层要在写之前校验（`dr_model::check`），不要指望出错能撤回。
- **读的时候就给「能显示的样子」。** 书目读取返回的记录已经容错：指向已删实体的引用读成「没有」，一端不在的关系不列出，构想身上多出来的书序忽略。真正存坏了什么，由 `repair_plan()` 报出来，后台修复按确定的规则写回，两台设备修出来一样。
- **逐字段写，不整条重写。** 同一个实体两台设备同时改不同字段，两边都留下；新版本加的字段，旧版本改这个实体时不会抹掉。
- **一个位置类型管三种单位。** Loro 按 Unicode 字符数，GPUI 按 UTF-8 字节，输入法按 UTF-16。`TextPos` 三个数一起带着，换算一次到处用；落在一个字符中间（emoji 的半个、汉字的一个字节）直接报错，不会悄悄错一位。

## 影响

- **F2（存储）**：存字节、管对等方和换代；载入一律交给 `ProseDoc::load` / `BookDoc::load`，打开后跑一次 `repair()` 并把结果存下来。见「待协调」第 1 条。
- **F3（命令总线）**：在 `BookTxn` / `ProseTxn` 之上组命令；创建时必填什么、名字是否重复、跨文档先写哪个，都在命令层，清单里标了「命令层」的 35 条是 F3 的活。
- **F4（编辑器）**：读 `ProseView`、订阅 `ProseEvent`，写走 `ProseTxn`，撤销走 `ProseUndo`。见「待协调」第 3 条。
- **M10（旧库导入）**：用确定性的导入对等方（`peer::import_peer`）和 `edit_at` 的固定时间戳；旧块 ID 用 `ProseTxn::set_block_id` 原样写入；`library_item` 写成 `material`；内置关系类型的 id 和旧版一样，不用改写。

## 接口概览

标注：**稳定** = v1 定下，改要走版本号或先协调；**可能变** = 下游用起来以后大概率要调。

### dr-model（不依赖 Loro）

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| `id` | `BookId`、`NodeId`、`ElementId`……共 23 种 id（非空、无控制字符的字符串，新建是 uuidv7，比较按 UTF-8 字节）；`DocId`（`book:` / `node:` / `element:` / `storyline:` / `category:` / `material:`，字符串形式就是存储的键）；`DocKind`、`ProseProfile`；`CommentId::for_projection`（生成的待办的确定 id）、`DeviceKey::from_installation_id`（写作日设备键，和旧版同一个摘要） | 稳定 |
| `kind` | 书目里所有字符串枚举，全部「开放」：不认识的值读成 `Other` 原样保留 | 稳定 |
| `pos` | 分数索引位置键 `PosKey`：`first`、`between`、`after`，`key_between` / `keys_between`，`cmp_pos`；照搬 Rocicorp `fractional-indexing` 4.0.0，测试里的期望值是用那个库本身算出来的 | 稳定 |
| `legacy` | 退役取值到 v2 的映射（导入用）：`copilot` → `api` / `ai`、`converted` → `resolved`、`library_item` → `material`、批注动作只留 `start_agent_task` | 稳定 |
| `book` | 每类实体一个记录：`BookMeta`、`Node`、`Act`、`Storyline`、`Category`、`Element`、`Patch`、`RelationType`、`Relation`、`TimePin`、`PlotGrid`、`Comment`、`Material`、`Asset`、`DriftGroup`、`MaterialFolder`、`Memory`、`WritingDay`、`KvEntry`；`EntityRef`、`EncodedAnchor`、`BlockSnapshot`、`MaterialRegion`、`TodoProjection`；`canonical_symmetric`、`normalize_relation_type_name`、`element_name_key`；`BookMeta::word_target` / `daily_word_target`（默认 120000 / 1500，0 是关掉） | 字段稳定；记录里会加便利方法 |
| `prose` | `BlockAttrs`（H1/H2/H3、引用、缩进 0–8、对齐、分隔线，笔记的列表 / 任务 / 代码块 / 提示框）、`InlineMarks`、`InlineStyle`、`EntityLink`、`Heading` | 稳定 |
| `order` | `cmp_order`（坐标、缺的排最后、平局按 id）、`chapter_order_after`（照搬旧版插章规则）、`act_segments` / `act_index_for_order`（幕按分界）、`needs_spread`、`CHAPTER_ORDER_STRIDE` | 稳定 |
| `origin` | `Origin`：`user` / `agent:<会话>/<轮>` / `mirror` / `sync` / `import` / `genesis` / `repair`；`UNDO_EXCLUDED_ORIGIN_PREFIXES` | 稳定 |
| `time` | `Timestamp`（秒）、`Day`（`YYYY-MM-DD`，校验闰年） | 稳定 |
| `check` | 命令层用的判断：`non_empty_name`、`relation_type_definition`、`relation_ends`、`comment_target`、`patch_source`、`material_payload`、`asset_shape`、`plot_cell_size`；违反时返回不变量 id | 可能变（F3 会加） |
| `invariant` | 不变量清单 `INVARIANTS`（77 条）、`NOT_CARRIED`（16 条）、界面和 Agent 的分叉 `DIVERGENCES`（9 条，待 F3 统一），生成 [acceptance/f1-invariants.json](../acceptance/f1-invariants.json) | 随 F3 增补 |

### dr-doc：正文文档

```text
ProseDoc::create(doc_id, peer) / load(doc_id, peer, &blobs)     一个写入者
  .view() -> ProseView<'_>          读，不拷贝整章
  .reader() -> ProseReader          Clone + Send + Sync 的只读句柄
  .edit(origin, |txn| ...) -> (Result<R>, Option<Committed>)
  .edit_at(origin, Some(ts), ...)   固定时间戳（导入）
  .import(bytes, Origin::Sync) -> Imported { pending, repair }
  .repair() -> Option<Committed>    块 ID 去重（来源 repair）
  .undo_manager() -> ProseUndo      合并间隔 0，只撤 user
  .subscribe(|ProseEvent| ...)      提交或导入后同步回调
  .version() / frontiers() / export_updates_since(vv) / export_snapshot()
ProseReader::load_at(doc_id, &blobs, &frontiers)   看历史：另载一份脱离的副本
genesis(&doc_id) -> Vec<u8>         确定性创世字节
```

| 类型 | 主要方法 | 状态 |
| --- | --- | --- |
| `ProseView` | `len` / `len_utf8` / `len_utf16`、`pos(unit, value) -> TextPos`、`text_in(range)`、`paragraphs()`（逐段懒读，已按「重复 id 只认第一个」处理）、`paragraph_at(pos)`、`paragraph_by_id(&BlockId)`、`blocks()`（只要换行位置和块 ID）、`newlines()`、`entity_links()`、`embed_refs()` / `embed(id)` / `orphan_embeds()`、`anchor(range)`、`resolve(&Anchor)` | 稳定；会加按范围读 |
| `Paragraph` | `id`（读者用的）、`stored_id`、`range`、`newline`、`attrs: BlockAttrs`、`runs: Vec<Run { text, marks }>`、`embed()` | 稳定 |
| `ProseTxn` | `insert_text`、`insert_paragraphs`（粘贴，每段新块 ID）、`split`（回车）、`delete`（含并段规则）、`set_block_attrs`、`set_heading`、`set_style` / `clear_style`、`link_entity` / `unlink_entity`、`insert_embed` / `table`、`drop_orphan_embeds`、`repair_block_ids`、`set_block_id`（只给导入） | 稳定；F4 会要更多编辑原语 |
| `ProseEvent` | `trigger`（本机 / 导入 / 检出）、`origin`、`body: Vec<TextChange>`（按字符的 retain / insert / delete）、`splices()`（改后的坐标）、`restyled()`、`embeds_changed`、`meta_changed` | 可能变（F4 用起来再调） |
| `ProseUndo` | `undo(&mut doc)` / `redo(&mut doc)` 返回 `Committed`；`hooks()` 拿到 Loro 的 `UndoManager` 挂 `set_on_push` / `set_on_pop` | 可能变 |
| `TableWriter` | `add_row` / `add_col` / `remove_*` / `set_cell` | 可能变 |

### dr-doc：书目文档

```text
BookDoc::create(book_id, peer) / load(book_id, peer, &blobs)
  .view() -> BookView<'_>      .reader() -> BookReader
  .edit(origin, |txn| ...)     .import(bytes, origin)
  .repair() -> (RepairPlan, Option<Committed>)
  .subscribe(|BookEvent| ...)  BookEvent.changes: {Change { collection, id }}
generic_relation_type_id(&book) = "system:generic-association:<书 id>"
```

| 类型 | 主要方法 | 状态 |
| --- | --- | --- |
| `BookView`（读，已容错） | `meta`、`node` / `nodes` / `chapters`（书序）/ `drifts` / `timeline`（叙事序）、`acts`、`time_pins`、`storylines`、`categories`、`element` / `elements`、`patches` / `patches_of`、`relation_type(s)`、`relations`（能显示的）/ `relations_raw`（存的全部）、`entity_exists`、`plot_grid`、`comment` / `comments`（目标不在时标 `target_missing`）、`materials`、`assets`、`drift_groups`、`material_folders`（父在前）、`facts`、`memory`、`writing_days` / `words_on`、`owns_prose(&DocId)`、`repair_plan`；v2 新增 `element_name_conflicts`（合并后重名的要素和保留名字的那个）、`todo_done`（任务行显示的待办状态）、`entity_snapshot`（某对象存着的全部字段，用在历史副本上） | 稳定；会加缓存和按 id 的批量读 |
| `BookTxn`（写） | 每类一个写入器，逐字段设值、`None` 即删除：`meta()`、`node(id)`、`act`、`storyline`、`category`、`element`、`patch`、`relation_type`（内置的拒绝）、`relation`、`time_pin`、`plot_grid(chapter)`、`comment`、`material`、`memory`；`put_asset`（写一次）、`put_fact` / `remove_fact`、`writing_day`、`drift_groups()` / `material_folders()`（树：建、改名、改色、移动）、`delete_drift_group` / `delete_material_folder`（子级和成员上移）、`purge(collection, id)`、`apply_repair(&plan)`；v2 新增 `projected_todo(kind, doc, block)`（生成待办，id 确定）、`restore_fields(collection, id, &snapshot, metadata_fields(collection))`（按对象恢复历史），以及各写入器的新字段：`pos`、`color`、`word_target`、`relate_pin`、`quote`、`snapshots`、`region`、`agent_conversation`、`description` | 稳定；F3 会提出缺的 |
| `Collection` | 19 个根容器 | 稳定 |
| `RepairPlan` | 语义重复的关系、缺书序的章节（补成什么）、带书序的构想、在分组里的章节 | 随修复项增补 |

### dr-doc：锚点、位置、其他

| 类型 | 说明 | 状态 |
| --- | --- | --- |
| `Anchor` | 一对光标；`encode() -> EncodedAnchor` / `decode`；由 `ProseView::anchor` 建、`ProseView::resolve` 解析 | 稳定 |
| `Resolved` | `range`、`collapsed`（锚住的字全删了）、`updated`（Loro 回放历史后给的替换锚点） | 稳定 |
| `AnchorCache` | 替换锚点存本机、不回写书目文档；`resolve(key, &stored, &view)` 先用缓存；`export` / `import` 给存储做本机持久化 | 可能变 |
| `TextPos` / `Unit` / `PosError` | 三种单位一起带；`TextPos::in_str`（段内，线性）、`ProseView::pos`（全文，经 Loro 索引）；字符中间、越界都报错 | 稳定 |
| `Committed` / `Imported` | 交给存储的一次提交；导入结果（有没有在等依赖、导入后修了什么） | 稳定 |
| `peer` | `genesis_peer`、`import_peer`、`is_device_peer`、`random_device_peer`（测试用；正式的由 F2 分配） | 稳定 |
| `schema` | 容器名、标记键、样式表、`SCHEMA_VERSION = 2`、`GENESIS_VERSION = 2`、`configure` | 稳定（就是 loro-schema.md） |
| `loro_types` | 重新导出 `VersionVector`、`Frontiers`、`Subscription`、`Cursor`、`UndoManager`，下游用同一个钉住的 Loro | 稳定 |

## 不变量清单（摘要）

完整清单和每条的旧版出处、新版落点、对应测试在 `dr_model::invariant`，证据 [acceptance/f1-invariants.json](../acceptance/f1-invariants.json) 由测试生成并校验（`invariants_evidence_is_current`）；清单里点名的每个测试都必须真的存在（`every_named_test_exists`）。

| 靠什么成立 | 条数 | 例子 |
| --- | ---: | --- |
| 命令层预防 | 37 | 关系不能连自己、名字不能空、要素名不重复、关系类型的定义合法、跨文档先写正文、按对象恢复历史 |
| 读取时容忍 | 52 | 关系一端不在就不显示、分组不在的构想放根目录、主故事线不在成员里就当没有、批注目标不在标「未定位」、合并后重名的要素标出来 |
| 后台修复 | 7 | 语义重复的关系删到只剩 id 最小的、缺书序的章节补上、重复的块 ID 改掉、没人指向的嵌入条目清掉 |
| 结构保证 | 31 | 树不会成环（Loro 保证）、内置关系类型只有一个（创世保证）、写作日的设备和日期就是键、正文永远以换行结尾、列表顺序用位置键、生成的待办 id 确定 |

一条可以同时靠几种办法，所以条数加起来大于 77。和旧版比，**故意改了的**：

- 旧版「不认识的种类和字段一律拒绝」改成「原样保留」：合并没法拒绝远端的改动，而且这样新旧版本能共存。
- 旧版删章节、要素时把它们的关系永久删掉；新版只是不显示，恢复后关系回来。
- 旧版靠外键级联删书；新版一本书就是它的那些文档，按文档 id 一起删。

### 界面和 Agent 做法不一样的地方（待 F3 统一）

旧版界面和 Agent 工具各走各的代码，同一个操作结果不同。新版两边走同一条命令，下面是每处建议的统一做法（详细出处在 `DIVERGENCES`）：

| 操作 | 旧版界面 | 旧版 Agent | 建议统一成 |
| --- | --- | --- | --- |
| 删章节 / 要素 / 分类 / 故事线时的关系 | 照删，关系永久删掉 | 有关系就拒绝 | 都直接删进废纸篓；关系留着、读取时隐藏，恢复就回来；彻底删除时一起删 |
| 删对象时挂着的批注和待办 | 照删，批注留着 | 有批注就拒绝 | 都直接删；批注显示「未定位」，恢复就回位；彻底删除时变成浮动批注，不删 |
| 删构想时绑定它的幕和时间钉 | 先解绑，时间钉留下构想标题 | 不解绑 | 进废纸篓不解绑，读取时当没绑；彻底删除时把标题写进时间钉再解绑 |
| 删还有要素的分类 | 照删，要素变未分类 | 拒绝 | 都直接删；要素显示未分类，恢复就回来；彻底删除时清掉分类字段 |
| 删故事线时的成员关系 | 删掉成员关系 | 有成员就拒绝 | 都直接删；成员关系留着，恢复就回来；彻底删除时清理 |
| 删还在用的关系类型 | 连带删关系 | 拒绝 | 同一次提交里删类型和关系；界面先问作者，Agent 直接做并报出删了几条 |
| 章节、构想、故事线重名 | 自动加「 2」 | 报错 | 都自动加后缀，并返回最终名字 |
| 分类重名 | 不查重 | 报错 | 和章节一样自动加后缀 |
| 要素重名 | 报错（占位名自动编号） | 报错 | 本来一致，保持报错（自动链接靠名字认人物） |

建议的总原则：**删除一律进废纸篓、不拒绝，副作用推迟到「彻底删除」那一步，命令结果把影响写清楚**。这样界面和 Agent 都不用各自判断，作者靠废纸篓和快照历史撤回，和「Agent 写入直接生效、作者靠快照历史撤销」一致。

## 测试与证据

在 `next/` 下：

```bash
cargo test -p dr-model -p dr-doc
DR_PROP_CASES=3000 cargo test --release -p dr-doc --test prose_convergence --test book_convergence -- --nocapture
cargo test --release -p dr-doc --test measure -- --ignored --nocapture
```

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| 单元测试 | dr-model 33 个；dr-doc 65 个（正文 31、书目 29、位置换算与对等方等 5）。P0-C 的正文用例全部搬过来，换成类型化接口 | 全过 |
| 正文三设备属性测试 `three_peers_converge` | 三台设备随机打字、回车、跨段删、设标题、加人物链接、加锚点、撤销、Agent 写入，任意顺序同步；查收敛、以换行结尾、块 ID 唯一且一致、锚点各处一致 | 3000 例全过；导入后自动修复 1622 次，没有一例需要额外修复轮；2708 个锚点，793 个收成点。见 [f1-prose-convergence.json](../acceptance/f1-prose-convergence.json) |
| 书目三设备属性测试 `three_peers_read_the_same_book` | 随机建章、建构想、建要素、进出废纸篓、彻底删、建关系（含没按规范顺序存的对称关系）、加减故事线、移动和删除分组、后台修复，任意顺序同步；查各设备读出来一样、读出来的东西守住全部读取规则 | 第一次跑 3000 例时在第 708 例失败：两台设备各建了同一个分组 id，树里有两个同 id 的节点，挂在其中一个下面的子分组读漏了（见下「发现并修好的」）。修好后 3000 例全过：1725 例同步后需要修复，都是一轮修好。见 [f1-book-convergence.json](../acceptance/f1-book-convergence.json) |
| 其他属性测试 | 没人删的锚点永远锚着原文；块 ID 修复是状态的函数（两台设备修出来一样）；位置换算三种单位处处一致、字符中间一律报错 | 全过 |
| 模糊测试（`next/crates/dr-doc/fuzz/`，不进 CI） | `load_bytes`：任意字节当存储的数据载入、导入、读、写；`bad_structure`：用 Loro 原始接口写出结构坏掉的文档（没有末尾换行、段落标记打在字上、字段类型不对、树节点重复同一个 id、两个写入者），再经 `dr-doc` 读写 | 找到两个崩溃（批量导入申请 29 GB 内存、坏锚点让 Loro panic），都已修；修后两个目标各跑 150 秒无崩溃。见 [f1-fuzz.json](../acceptance/f1-fuzz.json) |
| 测量 | 2 万字章节、100 章 / 300 要素 / 400 关系的书目，release | 见下 |

### 发现并修好的

1. **坏字节让进程被杀**（模糊测试）：见开头第 4 条。修在 `core.rs`，测试 `corrupted_bytes_are_an_error_not_a_crash`。
2. **坏锚点让 Loro panic**（模糊测试）：Loro 的 `get_text` 遇到不存在的容器会 panic，而锚点字节里的容器 id 是任意的。修在 `anchor.rs`，测试 `anchors_into_another_container_read_as_unlocated`。
3. **同一个分组 id 在树里出现两次时，子分组读漏**（书目属性测试）：两台设备各自导入或新建了同一个分组，Loro 的树里就有两个节点带同一个领域 id。原来只留第一个，挂在另一个下面的子分组整枝不见了，而构想「所在分组存在」用的名单又包括它，两处对不上。现在把树按领域 id 读成一棵逻辑树，重复节点的孩子都归到保留的那个名下；删分组时同 id 的节点一起删。测试 `a_group_created_on_two_devices_keeps_every_child`。
4. **在链接中间回车，新换行带上了链接标记**（单元测试）：Loro 把插在标记中间的字算进标记里。现在凡是新写的换行都清掉行内标记，读取时链接也在换行处断开。

### 关键数字

M3 Pro，release，Loro 1.17.1，合成数据（[f1-measure.json](../acceptance/f1-measure.json)，只作参考，不是门槛）：

| 项 | 数字 | 说明 |
| --- | ---: | --- |
| 打开一章（2 万字，从快照载入） | 0.30 ms | 快照 44 KB，199 段、135 处人物链接 |
| 第一次读出全部段落（含解码整章） | 4.22 ms | 冷文档第一次读会整章解码（P0-C 的结论） |
| 再读全部段落 | 0.45 ms | 逐段懒读，每段只拷这一段 |
| 按位置找段落 `paragraph_at` | 121.9 µs | 要读它前面各段的块 ID（「重复的只认第一个」）；随段落数增长，编辑器用自己的索引，别每次按键调用 |
| 位置换算（字符 → 三种单位 → 再从 UTF-16 换回） | 1.4 µs | 经 Loro 的索引，与文档长度无关 |
| 列出全部人物链接 | 0.46 ms | 读整章 |
| 一次按键：`edit` + 提交 + 导出更新字节 | p50 5 µs / p95 18 µs | 每次约 96 字节；不含 SQLite（P0-C 测过写库，合计 0.23 ms） |
| 打开书目（100 章、200 构想、300 要素、400 关系） | 0.36 ms | 快照 85 KB |
| 列章节（书序，已容错） | 0.53 ms |  |
| 列能显示的关系（已容错、已去重） | 3.85 ms | 每次重新读各集合，见待协调 2 |
| 算修复计划 | 5.39 ms |  |


## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1 | `dr-model`：领域类型和 id；每类实体的类型；不变量清单逐条对过旧版并标明归属 | 完成 |
| 2 | `dr-doc`：书目和正文文档的类型化封装（创世、块 ID、块属性与行内标记、人物链接、嵌入、锚点、书序与叙事序、mergeable 映射、来源）；统一位置类型 | 完成 |
| 3 | 给 F3 / F4 的接口，写入不暴露裸 `LoroDoc`，读取不拷贝整章 | 完成，上面已列；标了「可能变」的等下游用起来再定 |
| 4 | 属性测试（含 3000 例三设备）、模糊测试 | 完成 |
| 5 | 第二轮（监管会话审查）：v2 补字段、列表改位置键、待办单一真相、按对象恢复、名字唯一的读取容忍、分叉清单、视图数据归属 | 完成 |

## 待协调

1. **F2（dr-store）**
   - 载入一律经过 `ProseDoc::load` / `BookDoc::load`（它们先查校验和），**不要自己调 `import_batch`**：Loro 1.17.1 的批量导入不查校验和，坏字节会让进程申请几十 GB 内存后被杀。
   - 打开文档后跑一次 `repair()`，返回的 `Committed`（来源 `repair`）照常追加。`loro_update.origin` 多了一个取值 `repair`。
   - 存储的键用 `DocId` 的字符串形式（`book:<id>`、`node:<id>`……）。
   - 设备对等方由 F2 随机分配，最高位必须是 0（`dr_doc::peer::is_device_peer`）；最高位是 1 的留给创世，载入时会拒绝。
   - 快照表里的 `vv`、`frontiers` 用 `dr_doc::loro_types` 里重新导出的 Loro 类型编码。
   - 清理没有主人的正文文档时用 `BookView::owns_prose`。
   - 历史点（`history_label`）要同时记正文文档和书目文档的 frontiers，按对象恢复才拿得到当时的元数据。
   - 写作日的设备键用 `DeviceKey::from_installation_id(安装身份)`，安装身份文件归 F2。
   - 本机布局（视图模式、视口、滚动位置、手调比例、栏宽，见 loro-schema.md「不进书目文档的」）按书 id 存在本机文件里，格式由 F2 / F6 定。
2. **F3（dr-workspace）**
   - 清单里标「命令层」的 37 条是命令层的事，`dr_model::check` 有一部分现成的判断。
   - 9 处界面和 Agent 的分叉（`DIVERGENCES`）请照建议做成一条命令，或者改了建议再回来更新清单。
   - 新建要素前用 `element_name_key` 查重；合并后的重名读取时已经标出来（`name_conflict`），界面可以提示作者改名。
   - `edit` 出错也会提交已经做了的部分（Loro 不能回滚），所以先校验再写。
   - 写对称关系前用 `canonical_symmetric`（或 `check::relation_ends`）。
   - 删分组、删素材夹用 `delete_drift_group` / `delete_material_folder`，它们先把子级和成员挪上去；直接删树节点会连子树一起删。
   - 书目读取每次都从 Loro 取整个根映射的值。100 章、300 要素、400 关系时，列章节、列关系各要几毫秒（见上表）。如果 F3 的查询频繁，在它那一层按事件做增量缓存，不要每次都全读。
3. **F4（编辑器）**
   - 计划里 `gpui-prose` 只依赖 gpui 和 loro、不依赖任何 `dr-*`，但正文的写入规则（回车挪块 ID、新换行写全属性、行内标记不打在换行上）都在 `dr-doc` 里。建议：`gpui-prose` 定义一个「文本源」trait（读段落、订阅改动、提交编辑），由 `dr-editor` 用 `dr-doc` 实现。不要让 `gpui-prose` 直接往 `LoroText` 里写，否则这些规则会绕过去。
   - 撤销走 `ProseUndo::undo(&mut doc)`，它返回要存的提交；按阵合并用 `hooks()` 挂 `set_on_push`。
   - `ProseEvent` 的位置是改之前的字符坐标（Quill 式）；`splices()` 给的是改之后的坐标。
   - `ProseView::paragraph_at` 要读前面各段的块 ID（2 万字章约 0.13 ms），`paragraph_by_id` 是全文扫描。光标所在段、按块 ID 定位这类每次按键都要的查询，用 F4a 自己的段落索引（由事件增量维护），不要每次调它们。
4. **批注、补丁的正文和素材描述**在书目文档里是 `LoroText`，现在只给了纯文本写入（按最小差异更新，并发会合并）。审阅模块（M-审阅）如果要在批注里用富文本，要么在 `dr-doc` 加一套书目文档内的富文本接口，要么以后把批注正文挪成独立的正文文档。等该模块开工时定。
5. **M10（旧库导入）**：退役取值用 `dr_model::legacy` 规整；旧 `anchor_json` 拆成 `anchor`（光标对）、`quote`（`selectedText` / `textAnchor.text`）、`snapshots`（`blockSnapshots`，没有时用 v2 的 `blockText`）、`region`；`comment_action` 里 `start_agent_task` 的 `conversationId` 写进 `agent_conversation`；元数据里 `kind = todo-autoparse` / `note-task` 的待办，改用 `CommentId::for_projection` 的 id 和 `projection` 字段；旧的 `position_key` 原样写进 `pos`；本机 localStorage 里的颜色、目标、固定位置在交接时一起导出。
6. **`chapter_template` / `element_template`** 暂时原样存旧版的 JSON 字符串。做模板的模块如果想让模板可编辑、可合并，需要一种新的正文文档（比如 `template:<id>`），那是一次结构改动。
7. **Loro 的两个问题要不要报上游**：`import_batch` 不查校验和、解码器信任字节里的长度（修复很小：批量导入也传 `check_checksum = true`）；按不存在的容器取文本会 panic（有 `try_get_text`，但 `get_cursor_pos` 之类的路径不该让坏光标走到那里）。报不报、谁报，由监管会话定；我没有对外发任何东西。

## 没做完的，和下一个里程碑建议

- **没做**：批注 / 补丁正文的富文本接口（见待协调 4）；书目读取的缓存和增量索引（见待协调 2）；按范围读正文的接口（F4 的全书模式用得上）；模糊测试只跑了几分钟。
- **探针**：`next/spikes/loro-model/` 原样保留没动。它的种子生成器和 P0-C 的测量还在用它；等 F8 把种子移到 `dr-testkit`、改用 `dr-doc`，就可以删。
- **建议的下一个里程碑**：
  1. F3 开工后，把它真正用到的写入组合补进 `BookTxn`，把清单里「命令层」各条接到 `check` 上并补测试；
  2. 给 F4 的「文本源」trait 定稿，同时补按范围读、按块 ID 定位的接口；
  3. 用 P0-C 的重型种子（150 万字）在 `dr-doc` 上重测打开、读取、按键的数字，进 F8 的基准程序。

## 代码位置

```text
next/crates/dr-model/src/
  id.rs kind.rs book.rs prose.rs order.rs origin.rs time.rs check.rs invariant.rs
next/crates/dr-doc/src/
  schema.rs peer.rs pos.rs core.rs anchor.rs undo.rs error.rs
  prose/  mod.rs view.rs txn.rs attrs.rs embed.rs event.rs tests.rs
  book/   mod.rs read.rs write.rs fields.rs tests.rs
next/crates/dr-doc/tests/
  prose_convergence.rs book_convergence.rs positions.rs invariant_tests_exist.rs measure.rs fuzz_seeds.rs
next/crates/dr-doc/fuzz/   load_bytes、bad_structure（独立工作区，不进 CI）
docs/rust-rewrite/acceptance/f1-*.json
```
