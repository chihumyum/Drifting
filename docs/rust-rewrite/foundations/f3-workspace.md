# F3：dr-workspace（命令、查询、事件、撤销）

2026-11-07，第一个里程碑。计划见 [foundation.md 的 F3](../foundation.md#f3-dr-workspace)，代码在 `next/crates/dr-workspace/`。它建在 F1（[f1-model-doc.md](f1-model-doc.md)）和 F2（[f2-store.md](f2-store.md)）之上，不依赖 GPUI。

## 做了什么（大白话）

1. **一套命令和查询，界面、帮手、MCP、开发命令行都调同一套。** 现在有 82 条：63 条命令（会写）、19 条查询（只读），覆盖书的结构：书、章节和幕、故事线、要素与分类、关系与关系类型、构想与分组、批注与待办、素材与素材夹、项目设定、Project Memory，外加读正文、精确替换正文、搜索、历史恢复和 Agent 撤销。每条只登记一次：名字、输入和输出的 JSON Schema、读还是写、能不能和别的命令同时跑、一句说明。界面按类型调（`Workspace::run`），帮手、MCP、命令行按名字传 JSON 调（`Workspace::call`）。
2. **能力清单从登记表里导出来，存成快照放进仓库。** 任何一条命令的名字、说明或输入输出变了，`cargo test` 就会把差异摆出来给人审。旧版的三份清单（帮手能力、命令行、同步）由它代替。旧版工具身上的风险、确认、撤回分级一律不要。
3. **一条命令改好几篇文档时，写入有固定的顺序。** 先全部校验，再写正文文档，再写书目文档（一次提交），最后写本机表（一个 SQLite 事务）。中途哪一步失败，留下的只会是「没人认领的正文文档」，读的时候本来就忽略它；书目里永远不会出现「指向一篇不存在的正文」的东西。测试里在每一步故意让它失败，再从磁盘重开，书都还是好的。
4. **界面和帮手做法不一样的 9 处，统一成了一条命令，以界面为准。** 删除一律进废纸篓、从不拒绝；关系被隐藏、批注显示「未定位」，恢复就都回来；连带的清理等到「彻底删除」那一步，在同一次提交里做；命令结果把影响到的每个东西列出来。新建或改名重名时自动加「 2」并返回最终的名字；只有要素名字重名才拒绝（自动链接靠名字认人），并告诉调用方是哪个要素占了这个名字。
5. **事件是细粒度的，而且一定在落盘之后才发。** 订阅者能知道哪本书的哪个实体、改了哪些字段，哪篇正文的哪几段。本机表的变化走同一条总线。视图只吃事件，不用乐观更新和回滚：命令返回时，它的改动已经落盘、事件已经发完。
6. **查询带缓存，按事件只丢掉受影响的部分。** 改一章的标题只重读这一章，不会把关系图、批注列表一起作废。列章节从 0.53 ms（每次重读）降到 0.17 ms（JSON）、0.014 ms（按类型调）。
7. **撤销分三层，都通了：**
   - 编辑器里的撤销（F4 的事）：留好了接口 `ProseSession`，只撤作者自己打的字，Agent 中途改的字不受影响；
   - 对象级撤销：每条命令都写明自己的「反操作」，作者按一次撤销就执行它，能重做，各人（作者、每个 Agent 会话）有各自的撤销栈；彻底删除的反操作是「从删除前的版本把这些对象恢复回来」；
   - Agent 的改动：按来源找到某个 Agent 会话（或某一轮）写过的东西，逐个字段恢复成它动手之前的样子；作者后来又改过的字段不动，报成冲突；Agent 新建的东西进废纸篓，删掉的东西回来；正文没人再动过就整篇退回，动过就不碰并报出来。
8. **随机测试抓到了 4 个真问题，自查又找到 1 个，都修了**（见「发现并修好的」）。

**要作者定的事：没有。** 下面的取舍都写了理由。

## 为什么这样做

- **用「镜像」把 F1 和 F2 接起来（暂时的适配）。** F2 的文档持有者拿着一份裸的 `LoroDoc`、在自己的线程上跑写入闭包；F1 的 `BookDoc` / `ProseDoc` 拿着自己的 `LoroDoc`，类型化的读写只能用在它自己那份上。两边现在都没有接口去套用对方的文档（「待协调」F1-1、F2-1）。所以工作区给每篇打开的文档配一个 dr-doc 的镜像，和持有者的文档有同样的历史、同样的对等方：
  - 镜像**只在持有者的写入任务里被改**，在持有者线程上，别的写入插不进来，所以镜像不会用到持有者已经用过的操作序号；
  - 每个任务开头先把两边对齐，改完镜像再对齐一次（把新提交导入持有者的文档），持有者照常落盘、发事件，一次写入仍是一次提交、一个来源，Agent 写入照常留结算记录；
  - 读走镜像。有人绕过工作区直接写持有者时，事件监听发现两边的版本不同，就标记镜像过期，下一次读之前先对齐。
  - 代价：打开的文档在内存里有两份，每次提交多一次导出和导入（按键大小的提交只多几微秒）。等 F1 能在借来的 `LoroDoc` 上开事务，镜像就可以拆掉。
- **删除不拒绝。** Agent 写入能按来源撤销，连带的清理也能撤回，所以没必要再靠「有关系就拒绝删」来自保（[simplifications.md](../simplifications.md) 第二节「写入四套入口」）。
- **彻底删除不删正文文档。** 彻底删章节、要素、素材时，书目实体在同一次提交里删掉、关系和批注一起处理，但正文文档留下，变成「没人认领」的状态。这样「撤销彻底删除」能把正文一起找回来；真正清掉这些文档交给以后的后台清理（「没做的」第 3 条）。
- **本机日志表暂时放在内存里的 SQLite。** F2 现在没有公开的办法往 `library.sqlite` 里加表、开事务（「待协调」F2-2）。日志的表结构和事务代码已经是最终的样子，搬过去只换连接；在那之前，对象级撤销只在这次运行里有效（Agent 撤销不受影响：它靠 F2 已经持久化的结算记录和历史）。
- **并发类别只分三种。** `shared`（读，随时并行）、`book`（写一本书：同一本书一次一条，不同的书可以同时）、`library`（新建书）。写命令在第一次碰到一本书时拿到这本书的「租约」，到日志写完才放开，所以校验和写入之间不会插进别的命令；租约可重入（撤销会在自己里面执行反操作）。
- **名字不按界面语言给默认值。** 工作区不知道界面语言，空名字一律用英文占位（`Untitled`、`New Storyline`、`New Element`），界面要本地化就自己传名字；要素的占位名用 `numbered: true` 让它自动编号。
- **搜索结果按书序排**：章节按阅读顺序在前，然后是构想、要素、故事线、分类、素材；废纸篓里的和没人认领的不出现。

## 接口概览

```rust
// 打开：库用工作区的选项开（dr-doc 的样式配置 + 派生索引用的派生器）
let lib = Library::open(root, dr_workspace::library_options(version))?;
let ws = Workspace::open(lib, WorkspaceOptions::default())?;

// 调用
ws.run::<ChapterCreate>(&Actor::User, ChapterCreateIn { .. })?;           // 按类型
ws.call(&Actor::agent("会话", 3, "调用 id"), "chapter.create", json)?;      // 按名字（JSON）
// 结果是 Outcome { output, effects, undo, journal }：输出、影响了什么、怎么撤、日志行

// 撤销
ws.undo(&Actor::User)?; ws.redo(&Actor::User)?;                             // 对象级，各人一个栈
ws.call(&Actor::User, "history.undo_agent", json!({"session": "会话", "turn": 3}))?;
let s = ws.prose_session("node:<id>")?; s.edit(|t| ..)?; s.undo()?;          // 编辑器层（给 F4）

// 事件
let _sub = ws.subscribe(|e: &WsEvent| ..);  // Book { book, changes: [{collection, id, fields}] } |
                                             // Prose { doc, ranges, blocks } | Local(本机表)
// 同步进来的更新（M36）
ws.import_remote(doc_id, Some((kind, book)), bytes, &Actor::Sync)?;

// 登记表
dr_workspace::registry().manifest();  // 能力清单（JSON），.table() 是一行一条
```

- `Actor`：`User`、`Agent { session, turn, call }`、`Mirror`、`Sync`、`Import`。它同时给出 dr-doc 的来源（Loro 提交）和 dr-store 的来源（更新行），两者拼出来的字符串一样（有测试）。
- 错误 `WsError` 有稳定的 `code()`：`not_found`、`invalid`、`invariant:<不变量 id>`、`name_taken`、`locked`、`ambiguous`、`bad_input`、`unknown_command`、`storage`、`document`……帮手和 MCP 按它分辨。
- 每条写命令的结果里，`effects` 一条一个实体：`created` / `updated` / `renamed` / `moved` / `trashed` / `restored` / `purged` / `hidden`（端点进了废纸篓而不显示）/ `shown` / `unlocated`（批注的目标不在了）/ `detached`（彻底删除时清掉的引用）。
- `undo` 是一串命令调用（`Invocation { command, input }`）；`None` 表示不能用命令撤（历史仍能恢复，比如资源登记、删掉文字的替换）。

## 命令与查询清单

全表和每条的 JSON Schema 在快照 `next/crates/dr-workspace/tests/snapshots/registry__capabilities.snap`（一行一条）和 `registry__capability_schemas.snap`。按类分：

| 类 | 查询 | 命令 |
| --- | --- | --- |
| 书 | `book.list`、`book.get`、`book.search` | `book.create`（library）、`book.update`（名字、梗概、全书和每日字数目标）、`book.trash`、`book.restore` |
| 项目设定 | `fact.list` | `fact.put`（新建或修改，可指定位置）、`fact.remove` |
| Project Memory | `memory.list` | `memory.add`、`memory.update`、`memory.remove`、`memory.restore` |
| 章节 | `chapter.list`（书序、所在的幕、故事线） | `chapter.create`（可带初始正文）、`chapter.update`（标题、梗概、状态、叙事序、故事线和主故事线）、`chapter.move`、`chapter.trash`、`chapter.restore`、`chapter.purge` |
| 幕 | `act.list`（带各幕的章节） | `act.create`、`act.update`（改名、颜色、分界、绑定构想）、`act.delete` |
| 故事线 | `storyline.list` | `storyline.create`、`storyline.update`、`storyline.move`、`storyline.trash`、`storyline.restore`、`storyline.purge` |
| 要素 | `element.list`（标出合并后重名的） | `element.create`、`element.update`（名字、梗概、分类、别名、字段、肖像、关系图固定位置）、`element.trash`、`element.restore`、`element.purge` |
| 分类 | `category.list` | `category.create`、`category.update`、`category.trash`、`category.restore`、`category.purge` |
| 关系 | `relation.list`、`relation_type.list` | `relation.create`（对称类型按规范顺序存，已有就返回已有的）、`relation.delete`、`relation_type.create`、`relation_type.update`、`relation_type.delete`（连同用它的关系） |
| 构想 | `idea.list`、`idea_group.list` | `idea.create`、`idea.update`、`idea.trash`、`idea.restore`、`idea.purge`、`idea_group.create`、`idea_group.update`、`idea_group.delete` |
| 批注与待办 | `comment.list`（目标不在的标「未定位」） | `comment.create`（挂在对象、段落、一段文字上，或浮动）、`comment.update`（正文、解决或重开、优先级、种类、关联的 Agent 对话）、`comment.delete` |
| 素材 | `material.list`、`material_folder.list` | `material.create`（文本笔记、图片、PDF）、`material.update`、`material.move`、`material.delete`、`material_folder.create`、`material_folder.update`、`material_folder.delete`、`asset.put`（资源元数据，写一次） |
| 正文 | `prose.read`（段落：块 ID、H1/H2/H3 级别、文字、版本） | `prose.replace`（一段里唯一出现的原文 → 新文字）、`prose.restore`（退回某个版本） |
| 历史 | `history.agent_changes` | `history.restore_entities`、`history.undo_agent` |

除了 `book.create` 是 `library`，其余写命令都是 `book`；查询都是 `shared`。

## 写入顺序与补偿

规则（`cx.rs` 强制，顺序反了是内部错误）：

1. **校验**：只读。dr-doc 的事务出错也会提交已经做了的部分（F1），所以所有判断在写之前做完。
2. **正文文档**：登记新文档（`loro_doc` 一行；创世内容各设备算出来一样，第一次打开时才写）、写初始正文，每篇一次提交。
3. **书目文档**：一条命令一次提交；同一条命令里第二次写书目文档是内部错误。
4. **本机表**：日志一行，一个 SQLite 事务，提交后用 `notify_local` 发到总线。

删除反过来：书目实体先删，正文文档留着（没人认领），所以书目实体永远不会指向不存在的正文。

| 在哪失败 | 留下什么 | 读的时候 | 测试 |
| --- | --- | --- | --- |
| 正文写完、书目还没写（`after_prose`） | 一篇没人认领的正文文档 | 不显示（`PROSE-OWNER`），重开后一样 | `a_failure_after_the_prose_leaves_only_an_orphan` |
| 书目事务做到一半（`in_book`，比如彻底删章节删完了关系、还没删章节） | 前一半已提交 | 两半各自都是能读的状态；重开读出来和之前一样；再执行一次就做完 | `a_failure_inside_the_book_commit_keeps_what_was_applied` |
| F2 追加失败（磁盘满） | 改动留在持有者内存里，F2 在下一次写之前补存；事件和缓存等到补存时才更新 | 补存后两次改动都在，重开也在 | `a_failed_store_append_is_retried_by_the_next_write` |
| 日志写失败（`journal`） | 文档改动已落盘，没有撤销项 | 命令照样成功，结果里 `undo` 为空 | `a_failed_journal_write_keeps_the_change_without_undo` |

另外：命令返回时改动已落盘，不冲刷直接关库再开，读出来完全一样（`every_commit_is_durable_when_the_command_returns`）。

## 事件

- 唯一的来源是 F2 的库总线：每篇打开文档的已落盘变化，加上本机表的变化（F2 自己的资源、结算、派生索引、同步状态，以及工作区的日志）。
- 书目文档的变化换算成 `EntityChange { collection, id, fields }`：哪个集合、哪个实体、改了哪些字段（新建或删除的实体 `fields` 为空）。规则和 dr-doc 的 `BookEvent` 一样（路径第一层是集合，第二层是实体）。
- 正文的变化给出改后的字符范围（插入覆盖新字，删除是一个点），工作区开着这篇文档时再换算成被碰到的段落块 ID。
- 事件在落盘它的线程上发（持有者线程）。订阅者不能在里面等文档持有者。

## 查询缓存

- 每本打开的书一份。dr-doc 的书目读取每次从 Loro 取整个集合，有的还要读别的集合来做读取容错（列关系要知道每个端点是否还活着）。
- 一个集合变了，丢掉它自己和依赖它的读取；但如果只改了不影响「是否存在」的字段（标题、梗概、颜色……），只丢它自己。决定「是否存在」的字段是 `deleted_at`、`kind`、补丁的 `element`、关系的端点和类型。
- 章节和构想（最常改的）按实体缓存：改一章只重读这一章。
- 读到一半来了事件的那次填充会被丢掉（每项带它读取时的代号），缓存不会比最后一个事件旧。
- 热路径上不用 dr-doc 那些「为一个对象读全书」的读法：判断一个关系端点或批注目标是否活着、找挂在一个对象上的批注，都走缓存或直接查一个键（「待协调」F1-3）。

## 撤销三层

| 层 | 做法 | 测试 |
| --- | --- | --- |
| 编辑器内 | `ProseSession`：dr-doc 的 `ProseUndo`（合并间隔 0，只撤 `user`），每一步经持有者落盘 | `the_editor_layer_undoes_only_the_authors_typing` |
| 对象级 | 每条命令声明反操作（新建 → 进废纸篓；改 → 改回旧值；移动 → 移回原坐标或原位置键；进废纸篓 ↔ 恢复；彻底删除 → `history.restore_entities` 从删除前的版本恢复）。日志里各人一个栈，新命令清空重做栈 | `undo_and_redo_walk_the_journal`、`a_new_command_clears_redo_and_actors_have_their_own_stacks`、`restore_entities_is_its_own_inverse` 和各命令的测试 |
| Agent 改动 | `history.undo_agent`：从 F2 的结算记录找到这个会话（或这一轮）每次写入的前后版本；书目文档逐字段比较「Agent 动手前、Agent 写完后、现在」，现在还等于 Agent 写的才恢复；正文的每段写入首尾相接、之后没人写过才整篇退回 | `undo_agent_restores_fields_nobody_changed_since`、`undo_agent_brings_back_what_it_deleted_for_good`、`undo_agent_leaves_prose_someone_else_edited` |

Agent 撤销的细节：

- 一个字段被 Agent 连着改了几次（中间没人插手），恢复到这一串之前的值；中间有人插手，只撤最后那一串。
- 要比较的实体靠 Loro 的 `diff` 先圈出来（每段写入改了哪些实体），只读这些实体，不读全书。
- 恢复回来的标题、名字如果已经被别的东西占了，照「重名加后缀」处理，不让撤销失败（随机测试抓到的，见下）。
- 撤销本身也能撤销（再执行一次就把 Agent 的改动放回来）。

## 9 处分叉怎么统一的

F1 列在 `dr_model::invariant::DIVERGENCES`，全部按 F1 的建议做了：

| 分叉 | 现在的命令 | 测试 |
| --- | --- | --- |
| DIV-TRASH-RELATIONS | `chapter/idea/element/category/storyline.trash` 从不拒绝，结果列出被隐藏的关系；`*.purge` 在同一次提交里删掉这些关系 | `trashing_never_refuses_and_reports_fallout`、`purging_a_chapter_cleans_up_in_one_commit` |
| DIV-TRASH-COMMENTS | 进废纸篓时批注标「未定位」，恢复回位；彻底删除时批注变浮动（清掉目标、块和锚点，正文和原文留着） | 同上 |
| DIV-DRIFT-BINDINGS | `idea.trash` 不解绑；`idea.purge` 把构想标题写进时间钉的标签、解开幕和时间钉的绑定 | `purging_an_idea_keeps_its_title_on_time_pins`（时间钉还没有命令能建，这条只测了幕） |
| DIV-CATEGORY-ELEMENTS | `category.trash` 后要素读成未分类，恢复就回来；`category.purge` 清掉这些要素的分类 | `categories_and_their_elements` |
| DIV-STORYLINE-MEMBERSHIP | `storyline.trash` 保留成员关系；`storyline.purge` 删掉各章的成员键和主故事线 | `storylines_order_rename_trash_purge` |
| DIV-RELTYPE-DELETE | `relation_type.delete` 一次提交删类型和关系，结果给出条数；内置类型拒绝 | `relation_types_names_locks_and_cascade` |
| DIV-DUP-TITLE | 章节、构想（共用一个名字空间）、故事线新建和改名都加后缀，返回最终名字；从废纸篓恢复时名字已被占也加后缀 | `chapters_are_ordered_and_titles_get_suffixes`、`storylines_order_rename_trash_purge` |
| DIV-DUP-CATEGORY | 同上；空名用 `Untitled` | `categories_and_their_elements` |
| DIV-DUP-ELEMENT | 明确给的名字或别名重名就拒绝（`name_taken`，带占用者的 id）；`numbered: true` 的占位名自动编号；从废纸篓恢复时名字被占加后缀、冲突的别名去掉 | `element_names_are_unique_and_placeholders_numbered` |

## 命令层的不变量落在哪

F1 清单里标「命令层」的 37 条，这一轮落实的：

| 不变量 | 在哪 |
| --- | --- |
| NAME-NONEMPTY | 书、设定、记忆、幕、分组、素材夹、要素改名用 `check::non_empty_name`；章节、构想、故事线、分类按界面的做法用占位名，不报错 |
| SEED-REQUIRED | 各创建命令写全必填字段（章节的种类、标题、书序、状态；关系的两端和类型……） |
| CHAPTER-HAS-ORDER | 新建和移动总给有限的书序（随机测试检查） |
| GROUP-EXISTS、MEMBERSHIP-LIVE | `idea.*`、`chapter.update` 先查分组、故事线存在且不在废纸篓 |
| ELEMENT-NAME-UNIQUE、TITLE-SUFFIX | 见上一节；随机测试在单设备上逐步检查 |
| REL-KINDS、REL-NO-SELF、REL-KINDS-BY-TYPE、REL-SYMMETRIC-CANONICAL | `check::relation_ends` |
| REL-ENDS-EXIST、REL-TYPE-EXISTS | `relation.create` 先查两端活着、类型存在 |
| RT-DEFINITION、RT-NAME、RT-LOCKED | `check::relation_type_definition`；规范名重复报 `name_taken`；内置类型报 `locked` |
| CMT-TARGET | `check::comment_target`，目标还必须活着 |
| MAT-KIND、MAT-PAYLOAD、AST-IMMUTABLE、AST-SHAPE | `check::material_payload`、`check::asset_shape`；`asset.put` 同一 id 不同值拒绝 |
| TREE-DELETE-MOVES-UP、TREE-DEPTH | 删分组、素材夹用 dr-doc 的 `delete_*`；构想分组最多两层 |
| ENTITY-RESTORE | `history.restore_entities`、`history.undo_agent` |
| CROSS-DOC-ORDER、ONE-ORIGIN-PER-COMMIT | `cx.rs` 的写入顺序；随机测试检查每个实体的正文文档都在 |
| BOOK-TRASH | `book.trash` 写 `deleted_at`；30 天后真删由 F2 做（还没做） |

还没有命令、所以这一轮没碰的：补丁（PATCH-BLOCK-NEEDS-NODE、IMMUTABLE-AFTER-CREATE 的补丁部分）、情节规划（PLOT-GRID）、写作日（WRITING-DAY）、模板和元数据 JSON（JSON-FIELDS）、肖像和资源「只属于一个主人」（PORTRAIT、MAT-PAYLOAD 的后半）、整本书彻底删除（BOOK-PURGE）。

## 测试与证据

在 `next/` 下：

```bash
cargo test -p dr-workspace --locked
DR_PROP_CASES=3000 cargo test --release -p dr-workspace --test invariants
cargo test --release -p dr-workspace --test measure -- --ignored --nocapture
INSTA_UPDATE=always cargo test -p dr-workspace --test registry   # 有意改了命令以后更新快照
```

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| `tests/commands.rs`（23 项） | 每条命令和查询至少调一次，含报错的情形；`null` 清空字段、撤销把空字段变回空；一项检查登记表里每条都在这个文件里被调用过 | 全过 |
| `tests/registry.rs`（4 项） | 能力清单的两份快照；每条说明是一句话、读的都是 `shared`、写的都不是、输入都是带字段名的对象；清单里不出现 H1–H3 的禁用叫法、退役产品的名字和构想的旧叫法 | 全过 |
| `tests/events.rs`（4 项） | 书目事件点名实体；正文事件只点名被改的那一段；Agent 写入带结算事件；缓存跟着事件走（改名后立刻读到新名字，依赖的读取被丢掉） | 全过 |
| `tests/write_order.rs`（6 项） | 上面「写入顺序与补偿」表里的四种失败，加上重开后正文还在、不冲刷也全落盘 | 全过 |
| `tests/undo.rs`（7 项） | 三层撤销 | 全过 |
| `tests/invariants.rs` 单设备属性测试（另有一条从失败例子固定下来的回归测试） | 每例最多 35 步随机命令（36 种，含撤销、重做、Agent 改名和撤销、故障注入、从磁盘重开），每一步后查：章节和构想标题、故事线名、分类名、要素名和别名都不重复；每个实体的正文文档都在；显示的关系两端都活着；批注目标要么显示要么标未定位；章节都有书序；构想分组不超过两层；重开前后读出来一样 | 3000 例全过（release，约 40 秒） |
| `tests/invariants.rs` 两设备属性测试 | 同一本书的两份副本各自跑随机命令，再互相交换全部文档；两边读出来逐项相同（章节、要素、关系、批注、故事线、分类、构想、分组）；合并后可能出现的重名由读取标出、只有一个保留名字 | 3000 例全过 |
| `concurrent_creates_of_one_name_are_flagged_not_lost` | 两台设备同时建同名要素、同名章节：都保留，要素标出冲突，章节标题允许重复，下一次改名加后缀 | 过 |
| 各模块单测（6 项） | 来源字符串一致、名字后缀、位置键、版本编码、事件里的段落换算、临时字数 | 全过 |

证据按 [simplifications.md 第五节](../simplifications.md#五更轻的验收证据新工作区适用)：能力清单用快照，测量只提交这一次（[acceptance/f3-workspace-measure.json](../acceptance/f3-workspace-measure.json)，带源码指纹；源码变了只提示过期，不判失败）。

### 发现并修好的

都是随机测试找到的：

1. **别名和自己的名字一样**：给要素加一个和它自己名字相同的别名，名字和别名就重复了。现在这样的别名直接忽略。
2. **改名成自己的别名**：改名后名字和别名重复。现在改名成自己的某个别名时，这个别名去掉（相当于「把别名提为正名」）。
3. **Agent 撤销恢复出重名**：Agent 把「一」改名成「二」，作者又新建了一个「一」，再撤销 Agent，就有了两个「一」。现在恢复出的名字被占时照样加后缀。
4. **撤销彻底删除时判断错了「是否在废纸篓」**：恢复一个被彻底删掉的对象时，按「现在」的状态判断它恢复后在不在废纸篓，而现在它根本不存在，于是当成了不活着、不查重名。改成现在不存在时按删除前的状态判断。

自查发现的：

5. **JSON 里的 `null` 被当成「没传」**：serde 默认把 `Option<Option<T>>` 的 `null` 读成外层的 `None`，于是「清空主故事线」之类的输入不起作用，「把空字段改成有值」的撤销也撤不回去（撤销的输入里正是 `null`）。19 个可清空的字段都改成「没传 = 不动，`null` = 清空」，补了测试 `null_clears_a_field_and_undo_brings_back_an_empty_one`。

另外：关库时如果后台线程正在投递事件，会短暂持有工作区，偶尔让 `shutdown` 报「还有别的引用」；现在先退订、再等投递结束。

## 关键数字

M3 Pro，release，合成数据：100 章（每章约 2000 字）、200 个构想、300 个要素、400 条关系、120 条批注。完整数字在 [acceptance/f3-workspace-measure.json](../acceptance/f3-workspace-measure.json)（记了当时的机器负载）。只作参考，不是门槛。

| 项 | p50 | 说明 |
| --- | ---: | --- |
| 冷开一本书并列章节 | 11 ms | 起持有者、导出快照、载入镜像、跑一次后台修复计划（F1 测得修复计划约 5 ms）。预算里「打开项目 ≤ 150 ms」是整个界面 |
| 列章节（缓存命中，JSON / 按类型） | 0.18 ms / 0.013 ms | JSON 的大头是序列化 100 章 |
| 改名后列章节 | 0.20 ms | 只重读改了的那一章 |
| 列关系：缓存命中 / 关系变了以后 | 0.51 ms / 5.1 ms | 后者是 dr-doc 的整表读取（F1 测得 3.85 ms），见待协调 F1-3 |
| 列要素：冷 / 命中 | 1.4 ms / 0.49 ms | |
| 列批注：冷 | 4.8 ms | dr-doc 为每条批注判断目标是否活着时读全书 |
| 新建章节 / 带 2000 字新建 | 0.98 ms / 2.7 ms | 带字的多出打开正文持有者和写正文 |
| 改章节标题 / 移动章节 | 0.15 ms / 0.13 ms | |
| 新建要素 / 新建关系 / 新建批注 | 0.93 ms / 1.1 ms / 0.13 ms | |
| 章节进废纸篓再恢复 | 0.52 ms | 两条命令，含两份影响清单 |
| 精确替换正文 | 0.86 ms | |
| 对象级撤销一步 | 0.79 ms | |
| 搜索：三个字 / 一个字 | 0.42 ms / 4.1 ms | 一个字退回 `LIKE`，全书扫描（F2） |
| 撤销一轮 10 次写入的 Agent 改动 | 74 ms | 每次写入在副本上检出两次 |

测的时候机器负载约 16（别的会话在编译）；负载低时同一程序的数字几乎一样（冷开书除外，在 11–18 ms 之间跳）。

对照 [benchmarks.md](../benchmarks.md)：常用命令都在 1–3 ms 内，远低于「单次按键写入 ≤ 1 ms（发布档）」以外的任何预算；按键本身不走这些命令（编辑器直接走 `ProseSession`，F2 测得持有者一次按键 0.04 ms，镜像多几微秒）。优化前同一负载下，进出废纸篓 12 ms、新建关系 14 ms、新建批注 5 ms、Agent 撤销 1145 ms，原因都是反复做「为一个对象读全书」或反复检出历史，改法见「查询缓存」最后一条和「撤销三层」。

## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1 | 注册表：命令、查询各登记一次，JSON Schema、读写、并发类别、说明；能力清单快照 | 完成 |
| 2 | 事务与写入顺序：先校验再写；正文、书目、本机表的顺序与补偿；带来源经 F2 持有者写入 | 完成（本机表暂在内存，见 F2-2） |
| 3 | 事件：Loro 差异换成实体 / 段落级事件，本机表变化同一条总线；不用乐观更新 | 完成 |
| 4 | 查询：按事件增量缓存；章节、故事线、要素（含重名标记）、关系、构想、批注与待办、搜索（按书序） | 完成 |
| 5 | 第一批命令覆盖书的结构；9 处分叉统一；正文最小接口 | 完成 |
| 6 | 撤销三层 | 完成（编辑器层是接口，F4 接） |
| 7 | 单元测试、属性测试、两设备并发合并、测量 | 完成 |
| 8 | 证据（快照 + 一次测量） | 完成 |

## 待协调

按负责的 crate 分。

### F1（dr-model / dr-doc）

1. **在借来的 `LoroDoc` 上开事务（最要紧）**：`BookView` / `BookTxn` / `ProseView` / `ProseTxn` 能套在一个外面传进来的 `&LoroDoc` 上（不提交，提交由持有者做），`ProseUndo` 也一样。有了它，dr-workspace 直接在 F2 持有者的写入闭包里写，镜像拆掉：内存少一半，每次提交少一次导出导入。现在的适配见 `bridge.rs`。
2. **提交信息**：`dr_model::Origin::commit_message` 只给 Agent 写提交信息；dr-store 和 loro-schema.md 说 Agent、Markdown 文件夹、导入三种都写。经过镜像，Loro 的变更是 dr-doc 提交的，所以现在 `mirror`、`import` 的变更没有提交信息，「谁改了什么」读不出这两种来源。请让 dr-model 和 dr-store 一致。
3. **为一个对象读全书**：`BookView::comment(id)`、`comments()`、`relations()`、`entity_exists()` 每次都读所有集合（上面的负载下 4–5 ms）。F3 已经在热路径上绕开（自己判断是否活着、直接查键），但「关系变了以后列关系」仍要 5 ms。建议 dr-doc 提供按端点或按 id 的便宜读取，或者增量的「活着的实体」索引。
4. **`EntitySnapshot` 的值读不出来**（`value` 是 `pub(crate)`）：Agent 撤销要比较「动手前 / 写完后 / 现在」的字段，现在只好从 F2 载的副本上读裸值。给一个公开的按字段读取（或两份快照的差异）就能只用 dr-doc 的类型。
5. **9 处分叉已按建议实现**（`DIV-DUP-CATEGORY` 的空名在工作区里是 `Untitled`，本地化的默认名由界面传）。请在 `dr_model::invariant` 里把它们标成已统一，并把 F3 的测试名补进命令层不变量的 `tests`（上面「命令层的不变量落在哪」有对照）。
6. `BookDoc::repair()` 的修复计划约 5 ms，F3 每次打开书跑一次。如果只在导入远端更新后才可能非空，可以考虑给一个更便宜的「需要修吗」判断。

### F2（dr-store）

1. **持有者文档的类型化读取**：配合 F1-1，需要 `DocView` 能把只读的 `&LoroDoc` 交给 dr-doc 的视图（比如 `DocView::with_doc(|doc| ..)`）。另外镜像依赖一个现状：写入闭包开始时持有者已经结清了待提交事务，所以在闭包开头导入导出是安全的。镜像拆掉之前请保持这一点，或者给一个明确的「把这些更新字节作为一次本机写入落盘（带来源、可带结算）」的接口。
2. **本机表**：没有公开的办法往 `library.sqlite` 加表、开事务。需要 `0001_*.sql` 加 `ws_journal`（表结构在 `journal.rs`），加一个 `Library::local_write(|tx| ..)` 之类的接口（提交后照常 `notify_local`）。在那之前日志在内存里，对象级撤销只在本次运行有效。
3. **搜索顺序**：`search()` 按文档 id 再按段序、先 `LIMIT`，F3 只好最多取 10 000 条再按书序排、截断。给 `block_index` 加一个书序列，或者允许传排序依据，`limit` 才准。
4. **来源缺 `repair`**：dr-doc 的确定性修复存成了 `genesis`（同样是各设备算出来一样的内容），请加上 `Origin::Repair`。
5. **`Library::close(self)` 消耗掉库**：后台线程恰好拿着一个文档句柄时会报 `DocumentsOpen`，调用方没法重试。可以考虑 `close(&self)` 或把库放在错误里还回来。

### F4（编辑器）

- 先用 `ProseSession`（`edit` / `undo` / `redo` / `reader`）：每一步经持有者落盘，来源 `user`，Agent 的写入不进作者的撤销（有测试）。文本源 trait 定下来以后由 dr-editor 用它实现。
- 会话占着的正文文档不会被「最近最少用」的规则关掉（工作区最多同时开 16 篇正文，可调）。
- 编辑器的写入请走工作区（会话或命令），不要直接用 dr-store 的持有者写：镜像能追上外来的写入，不会写坏，但追上之前工作区的读取和缓存看不到它们。

### M29（帮手工具）/ M32（MCP）/ F8（开发命令行）

- 按名字调 `Workspace::call(actor, name, json)`；输入输出的 Schema 从 `registry().manifest()` 来；错误按 `code()` 分。
- 按名称找对象、把正文投影成可改的文本（带行号、修订 CAS、自动还原人物链接）是 M29 的事，这一轮的 `prose.replace` 只是最小的精确替换。

### M36（同步）

- 远端更新一律走 `Workspace::import_remote`，镜像和缓存才能跟上；它内部走 F2 的 `import`（自动记下服务器已有的版本）。

## 没做的，和下一个里程碑建议

- **没做**：
  1. 时间钉、情节规划、补丁、写作日、模板的命令；整本书彻底删除和废纸篓 30 天到期；
  2. 正文的修订 CAS（带版本的写入）、作者也改过同一篇正文时按段撤销 Agent 改动（现在只报冲突，请作者从历史恢复）；
  3. 清理没人认领的正文文档（彻底删除后留下的，和中途失败留下的）；
  4. 字数统计用的是临时规则（汉字一个算一个、其他连续字母数字算一个），等 dr-text。
- **建议的下一个里程碑**：
  1. F1-1、F2-1 落地后拆掉镜像，重测内存和每次提交的开销；
  2. 日志搬进 `library.sqlite`（F2-2），对象级撤销跨重启保留；
  3. 补齐上面第 1 条的命令；加后台清理（第 3 条）；
  4. 和 F1 一起做关系、批注的增量索引（F1-3），把「改了以后列关系」降到 1 ms 以内；
  5. F8 的开发命令行直接接 `registry()`：`drifting workspace call | describe` 基本只是一层参数解析。

## 代码位置

```text
next/crates/dr-workspace/src/
  lib.rs           入口和总说明
  registry.rs      登记表、能力清单、Op trait
  cx.rs            命令上下文：写入顺序、租约、影响清单、反操作、故障注入
  workspace.rs     打开的书和正文、run / call、撤销重做、import_remote、事件分发
  bridge.rs        镜像适配（dr-doc 写入者 ↔ dr-store 持有者）
  events.rs        事件类型和换算
  cache.rs         按书的查询缓存
  journal.rs       本机日志表（撤销栈）
  editor.rs        ProseSession（编辑器层撤销）
  deriver.rs       派生索引的派生器（段落、标题级别、人物链接、临时字数）
  actor.rs dto.rs naming.rs error.rs
  commands/        book chapter storyline element relation idea comment material prose history
next/crates/dr-workspace/tests/
  commands.rs registry.rs events.rs write_order.rs undo.rs invariants.rs measure.rs
  snapshots/       能力清单快照（registry__capabilities.snap、registry__capability_schemas.snap）
docs/rust-rewrite/acceptance/f3-workspace-measure.json
```
