# F3：dr-workspace（命令、查询、事件、撤销）

2026-11-07，两个里程碑。计划见 [foundation.md 的 F3](../foundation.md#f3-dr-workspace)，代码在 `next/crates/dr-workspace/`。它建在 F1（[f1-model-doc.md](f1-model-doc.md)）、F2（[f2-store.md](f2-store.md)）和 dr-index（[dr-text-index.md](dr-text-index.md)）之上，不依赖 GPUI。

## 做了什么（大白话）

### 第二个里程碑

1. **拆掉了「镜像」，每篇打开的文档在内存里只剩一份。** 第一个里程碑时，F1 的类型化读写只能用在它自己那份 Loro 文档上，所以每篇打开的文档要多存一份副本，每次提交还要多导出、导入一次。F1 现在能把读写套在 F2 持有者手里的那份文档上了：命令直接在持有者的写入任务里用 dr-doc 写，读也直接读那一份。同时打开 100 章时，每章占的内存从 0.47 MiB 降到 0.30 MiB，少了三分之一；作者打一个字从 0.094 ms 降到 0.078 ms。「副本落后了、读之前先对齐」这类情况也不会再有。
2. **撤销记录存进了 `library.sqlite`，重启以后照样能撤销、重做。** 用的是 F2 建好的 `ws_journal` 表。每个人（作者、每个 Agent 会话）保留最近 1000 条。
3. **搜索改由 F2 先按书序排好再截断**，工作区不再自己多取一万条再排。现在结果总是准的。但 F2 的这个函数在大书上慢了十倍左右（见「关键数字」），修法已经写进待协调 F2-1，F2 改完以后工作区这边不用动。
4. **给外壳（F6）做了三样东西：**
   - **目录** `BookCatalog`：按组加名字、或者按 id 找对象，标签上显示的名字也从这里取。F6 的 `Catalog` trait 套上它只要三行，替身书就能删了。
   - **删除事件** `WsEvent::Removed`：不管是作者、Agent 还是另一台设备，把东西放进废纸篓或者彻底删掉，总线上都会发一条，外壳据此关掉对应的标签。
   - **退出钩子** `Workspace::before_quit()`：补齐打开文档的搜索索引，让每篇文档收好尾（写关闭标签、该压缩就压缩），下次启动就不用重建。
5. **派生索引换成了 dr-index 的**（字数按 dr-text 的规则算，按 Loro 的差异增量更新），第一个里程碑里那套临时字数规则删掉了。
6. **测量改用 F8 的 `bench workspace` 套件**，自己那份测量测试和 JSON 删掉了。拆镜像前后在同样的负载下各跑了两遍。
7. **随机测试又抓到一个问题**：关库的那一刻如果碰上 F2 的后台索引重建，关库会被拒。已经修好，并固定成了回归测试（见「发现并修好的」）。

### 第一个里程碑

1. **一套命令和查询，界面、帮手、MCP、开发命令行都调同一套。** 一共 82 条：63 条命令（会写），19 条查询（只读）。覆盖书的结构：书、章节和幕、故事线、要素与分类、关系与关系类型、构想与分组、批注与待办、素材与素材夹、项目设定、Project Memory，外加读正文、精确替换正文、搜索、历史恢复和 Agent 撤销。每条只登记一次：名字、输入和输出的 JSON Schema、读还是写、能不能和别的命令同时跑、一句说明。界面按类型调（`Workspace::run`），帮手、MCP、命令行按名字传 JSON 调（`Workspace::call`）。
2. **能力清单从登记表里导出来，存成快照放进仓库。** 任何一条命令的名字、说明或输入输出变了，`cargo test` 都会把差异摆出来给人审。旧版的三份清单（帮手能力、命令行、同步）都由它代替。旧版工具身上的风险、确认、撤回分级一律不要。
3. **一条命令改好几篇文档时，写入有固定的顺序。** 先全部校验，再写正文文档，再写书目文档（一次提交），最后写本机表（一个 SQLite 事务）。中途哪一步失败，留下的最多是一篇「没人认领的正文文档」，读的时候本来就会忽略它；书目里永远不会出现指向一篇不存在的正文的东西。
4. **界面和帮手做法不一样的 9 处，统一成了一条命令，以界面为准。** 删除一律进废纸篓、从不拒绝；关系被隐藏、批注显示「未定位」，恢复以后都回来；连带的清理等到「彻底删除」那一步，在同一次提交里做；命令结果把受影响的每个东西都列出来。新建或改名遇到重名时自动加「 2」，并返回最终的名字。只有要素重名会被拒绝（自动链接靠名字认人），并告诉调用方是哪个要素占了这个名字。
5. **事件是细粒度的，而且一定在落盘以后才发。** 本机表的变化也走同一条总线。
6. **查询带缓存，按事件只丢掉受影响的部分。**
7. **撤销分三层**：编辑器里的撤销（接口留给 F4）、对象级撤销（每条命令写明自己的反操作）、Agent 改动的撤销（按来源逐个字段恢复）。

**要作者定的事：没有。** 下面每个取舍都写了理由。

## 为什么这样做

- **读写都在持有者的那一份文档上。** F2 的持有者在自己的线程上跑写入任务，每个任务提交一次，落盘以后才发事件。命令在任务里用 `BorrowedBook` / `BorrowedProse` 开 dr-doc 的事务；读的时候，从 `DocView::with_doc` 拿到同一份文档，用 `BookReader::from_loro` / `ProseReader::from_loro` 共享它。要守两条规矩（`holder.rs`）：
  - 任务开头先设好这次提交的来源和提交信息，因为解析已删文字上的锚点会在中途隐式提交一次。空的显式提交会吞掉这些设置，所以不会漏到下一次写入里。
  - 读只读当前状态。导出、检出、比较版本、解析锚点，要放在持有者线程上做（`DocHandle::read`），或者在副本上做。
  
  Loro 没法回滚，所以「先校验再写」这一条没变。
- **删除不拒绝。** Agent 的写入能按来源撤销，连带的清理也能撤回，所以不需要再靠「有关系就拒绝删」来自保（[simplifications.md](../simplifications.md) 第二节「写入四套入口」）。
- **彻底删除不删正文文档。** 彻底删章节、要素、素材时，书目实体在同一次提交里删掉，关系和批注也一起处理，但正文文档留着，变成「没人认领」。这样「撤销彻底删除」能把正文一起找回来。真正清掉这些文档留给以后的后台清理。
- **撤销记录放在 `library.sqlite`，每人保留 1000 条。** 每条写命令记一行，用一个事务写（`Library::local_write`），提交以后才发到总线。保留条数有上限，免得本机表无限长。Agent 撤销不靠这张表（靠 F2 的结算记录和历史），所以截掉的旧记录只影响「一步一步往回撤」能撤多远。
- **并发类别只分三种。** `shared`（读，随时可以并行）、`book`（写一本书：同一本书一次一条，不同的书可以同时写）、`library`（新建书）。写命令第一次碰到一本书时拿到这本书的「租约」，等日志写完才放开，所以校验和写入之间插不进别的命令。租约可以重入（撤销会在自己里面执行反操作）。
- **名字不按界面语言给默认值。** 工作区不知道界面用什么语言，空名字一律用英文占位（`Untitled`、`New Storyline`、`New Element`）。界面要本地化就自己传名字；要素的占位名用 `numbered: true` 自动编号。
- **搜索结果按书序排**：章节按阅读顺序在前，然后是构想、要素、故事线、分类、素材。废纸篓里的和没人认领的不出现，也不占名额。顺序由工作区从书目文档里取，排序和截断由 F2 在同一条 SQL 里做。
- **删除事件从落盘的变化里算，不从命令里发。** 这样另一台设备同步过来的删除、Agent 的删除、撤销造成的删除，外壳都能收到。只看「废纸篓标记变了」或者「整个对象没了」的实体，每个查一个键，在持有者线程上做，花不了多少时间。被彻底删掉的章节或构想，如果这台设备从来没读过，就不知道它原来是章节还是构想，事件里两种都报（关掉一个不存在的标签什么也不会发生）。
- **退出钩子不是必须的。** 每条命令返回时改动已经落盘，不跑它也不会丢东西。它只是把下次启动要做的事（重建落后的索引）提前做掉，并在历史里留一个「关闭」标签。正被编辑会话占着的文档只补索引，不关。

## 接口概览

```rust
// 打开：库用工作区的选项开（dr-doc 的样式配置 + dr-index 的派生器）
let lib = Library::open(root, dr_workspace::library_options(version))?;
let ws = Workspace::open(lib, WorkspaceOptions::default())?;

// 调用
ws.run::<ChapterCreate>(&Actor::User, ChapterCreateIn { .. })?;           // 按类型
ws.call(&Actor::agent("会话", 3, "调用 id"), "chapter.create", json)?;      // 按名字（JSON）
// 结果是 Outcome { output, effects, undo, journal }：输出、影响了什么、怎么撤、日志行

// 撤销
ws.undo(&Actor::User)?; ws.redo(&Actor::User)?;                             // 对象级，各人一个栈，重启后还在
ws.call(&Actor::User, "history.undo_agent", json!({"session": "会话", "turn": 3}))?;
let s = ws.prose_session("node:<id>")?; s.edit(|t| ..)?; s.undo()?;          // 编辑器层（给 F4）

// 事件
let _sub = ws.subscribe(|e: &WsEvent| ..);  // Book { book, changes: [{collection, id, fields}] } |
                                             // Removed { book, entities: [{target, purged}] } |
                                             // Prose { doc, ranges, blocks } | Local(本机表)
// 外壳
let cat = ws.catalog(book)?;                 // by_name(LinkGroup, 名字)、by_id、title、exists
ws.before_quit();                            // QuitReport { closed, in_use, ms }

// 同步进来的更新（M36）
ws.import_remote(doc_id, Some((kind, book)), bytes, &Actor::Sync)?;

// 登记表
dr_workspace::registry().manifest();  // 能力清单（JSON），.table() 是一行一条
```

- `Actor`：`User`、`Agent { session, turn, call }`、`Mirror`、`Sync`、`Import`。它同时给出 dr-doc 的来源和 dr-store 的来源，两者拼出来的字符串一样（有测试）。
- 错误 `WsError` 有稳定的 `code()`：`not_found`、`invalid`、`invariant:<不变量 id>`、`name_taken`、`locked`、`ambiguous`、`bad_input`、`unknown_command`、`storage`、`document`……帮手和 MCP 按它分辨。
- 每条写命令的结果里，`effects` 一条一个实体：`created` / `updated` / `renamed` / `moved` / `trashed` / `restored` / `purged` / `hidden`（端点进了废纸篓而不显示）/ `shown` / `unlocated`（批注的目标不在了）/ `detached`（彻底删除时清掉的引用）。
- `undo` 是一串命令调用（`Invocation { command, input }`）；`None` 表示不能用命令撤（历史仍然能恢复，比如资源登记、删掉文字的替换）。

## 给外壳（F6）的接口

`dr-shell` 依赖 `dr-workspace` 以后（层次上允许：界面层依赖服务层），在 F6 的文件里这样接：

```rust
use dr_workspace::{BookCatalog, LinkGroup, NavTarget, WsEvent};

fn group(g: Group) -> LinkGroup {
    LinkGroup::from_segment(g.segment()).expect("the same five groups")
}

fn target(t: NavTarget) -> Target {
    match t {
        NavTarget::Book => Target::Book,
        NavTarget::Chapter(id) => Target::Chapter(id),
        NavTarget::Idea(id) => Target::Idea(id),
        NavTarget::Storyline(id) => Target::Storyline(id),
        NavTarget::Element(id) => Target::Element(id),
        NavTarget::Category(id) => Target::Category(id),
        NavTarget::Material(id) => Target::Material(id),
    }
}

impl Catalog for BookCatalog {
    fn book_id(&self) -> Option<&str> {
        Some(BookCatalog::book_id(self))
    }
    fn by_name(&self, g: Group, name: &str) -> Vec<Target> {
        BookCatalog::by_name(self, group(g), name).into_iter().map(target).collect()
    }
    fn by_id(&self, g: Group, id: &str) -> Option<Target> {
        BookCatalog::by_id(self, group(g), id).map(target)
    }
}

// 删除事件：在持有者线程上到达，转到主线程再调 Navigator::forget
let _sub = ws.subscribe(move |e| {
    if let WsEvent::Removed(r) = e {
        let _ = to_main_thread.send(r.clone());
    }
});

// 退出
let ws2 = ws.clone();
quit::before_quit(cx, move |_| {
    let r = ws2.before_quit();
    log::info!("workspace: {} documents closed in {:.0} ms", r.closed, r.ms);
});
```

- `NavTarget` 和 `dr_shell::nav::Target` 的变体、`key()` 都一一对应，`LinkGroup` 的路径段和 `Group` 相同。
- 目录只认活着的东西：在废纸篓里的找不到，`title` 返回 `None`。名字两头的空白不算；同名的都返回（链接据此报「有几个重名」）。命令新建、改名都会加后缀，所以重名只会来自两台设备的合并。
- 目录的每次查找读的是工作区的查询缓存，代价是扫一遍缓存里的列表，不读书目文档。
- 面板的数据从查询来：`chapter.list`、`storyline.list`、`element.list`、`category.list`、`idea.list`、`material.list`，按类型调用（`ws.run::<ChapterList>`）最便宜。
- 正文稿纸可以用 `ws.prose_session(doc)?.reader()` 读，事件里的 `blocks` 说明哪几段变了。

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

规则由 `cx.rs` 强制，顺序反了是内部错误：

1. **校验**：只读。dr-doc 的事务出错也会提交已经做了的部分，所以所有判断在写之前做完。
2. **正文文档**：登记新文档（`loro_doc` 一行；创世内容各设备算出来一样，第一次打开时才写）、写初始正文，每篇一次提交。
3. **书目文档**：一条命令一次提交；同一条命令里第二次写书目文档是内部错误。
4. **本机表**：`ws_journal` 一行，一个 SQLite 事务（`Library::local_write`），提交以后才发到总线。

删除反过来：书目实体先删，正文文档留着（没人认领），所以书目实体永远不会指向不存在的正文。

| 在哪失败 | 留下什么 | 读的时候 | 测试 |
| --- | --- | --- | --- |
| 正文写完、书目还没写（`after_prose`） | 一篇没人认领的正文文档 | 不显示（`PROSE-OWNER`），重开后也一样 | `a_failure_after_the_prose_leaves_only_an_orphan` |
| 书目事务做到一半（`in_book`，比如彻底删章节时关系删完了、章节还没删） | 前一半已经提交 | 两半各自都是能读的状态；重开后读出来和之前一样；再执行一次就做完 | `a_failure_inside_the_book_commit_keeps_what_was_applied` |
| F2 追加失败（磁盘满） | 改动留在持有者内存里，F2 在下一次写之前补存；事件和缓存等到补存时才更新 | 补存后两次改动都在，重开也在 | `a_failed_store_append_is_retried_by_the_next_write` |
| 日志写失败（`journal`） | 文档改动已经落盘，没有撤销项 | 命令照样成功，结果里 `undo` 为空 | `a_failed_journal_write_keeps_the_change_without_undo` |

另外，命令返回时改动已经落盘：不冲刷直接关库再开，读出来完全一样（`every_commit_is_durable_when_the_command_returns`）。

## 事件

- 唯一的来源是 F2 的库总线：每篇打开文档已经落盘的变化，加上本机表的变化（F2 自己的资源、结算、派生索引、同步状态，以及工作区的日志）。
- 书目文档的变化换算成 `EntityChange { collection, id, fields }`：哪个集合、哪个实体、改了哪些字段（新建或删除的实体 `fields` 为空）。规则和 dr-doc 的 `BookEvent` 一样（路径第一层是集合，第二层是实体）。
- 紧跟着同一次变化，如果有东西进了废纸篓或者被彻底删掉（章节、构想、故事线、要素、分类、素材、整本书），再发一条 `Removed`，带上外壳能用的 `NavTarget`。恢复和新建不发。
- 正文的变化给出改后的字符范围（插入覆盖新字，删除是一个点）。工作区开着这篇文档时，再换算成被碰到的段落块 ID。
- 事件在落盘它的那个线程（持有者线程）上发。订阅者不能在回调里等文档持有者。

## 查询缓存

- 每本打开的书一份。dr-doc 的书目读取每次都从 Loro 取整个集合，有的还要读别的集合来做读取容错（列关系要知道每个端点是否还活着）。
- 一个集合变了，就丢掉它自己和依赖它的读取。如果只改了不影响「是否存在」的字段（标题、梗概、颜色……），只丢它自己。决定「是否存在」的字段是 `deleted_at`、`kind`、补丁的 `element`、关系的端点和类型。
- 章节和构想改得最频繁，按实体缓存：改一章只重读这一章。
- 读到一半来了事件的那次填充会被丢掉（每项带着读取时的代号），所以缓存不会比最后一个事件旧。
- 热路径上不用那些「为一个对象读全书」的读法：判断关系端点或批注目标是否活着、找挂在一个对象上的批注，都走缓存或者直接查一个键。F1 第三轮给了按键查、按端点查的便宜读取，下一个里程碑换上（见「下一个里程碑建议」）。

## 撤销三层

| 层 | 做法 | 测试 |
| --- | --- | --- |
| 编辑器内 | `ProseSession`：dr-doc 的 `ProseUndo` 挂在持有者那份文档上（合并间隔 0，只撤 `user`），每一步是持有者的一个写入任务。Agent 和同步的改动是别的来源的提交，管理器把它们当成远端改动折进去，从不撤它们 | `the_editor_layer_undoes_only_the_authors_typing` |
| 对象级 | 每条命令声明自己的反操作（新建 → 进废纸篓；改 → 改回旧值；移动 → 移回原坐标或原位置键；进废纸篓 ↔ 恢复；彻底删除 → `history.restore_entities` 从删除前的版本恢复）。日志在 `library.sqlite`，各人一个栈，新命令清空重做栈，重启后还在 | `undo_and_redo_walk_the_journal`、`a_new_command_clears_redo_and_actors_have_their_own_stacks`、`the_journal_survives_a_restart`、`an_actor_keeps_its_newest_rows`、`restore_entities_is_its_own_inverse` 和各命令的测试 |
| Agent 改动 | `history.undo_agent`：从 F2 的结算记录找到这个会话（或这一轮）每次写入的前后版本。书目文档逐字段比较「Agent 动手前、Agent 写完后、现在」，现在还等于 Agent 写的才恢复。正文的每段写入首尾相接、之后也没人再写过，才整篇退回；「比较版本」和「退回」在同一个写入任务里做 | `undo_agent_restores_fields_nobody_changed_since`、`undo_agent_brings_back_what_it_deleted_for_good`、`undo_agent_leaves_prose_someone_else_edited` |

Agent 撤销的细节：

- 一个字段被 Agent 连着改了几次（中间没人插手），恢复到这一串改动之前的值；中间有人插手，只撤最后那一串。
- 要比较的实体先用 Loro 的 `diff` 圈出来（每段写入改了哪些实体），只读这些实体，不读全书。
- 恢复回来的标题、名字如果已经被别的东西占了，照「重名加后缀」处理，不让撤销失败。
- 撤销本身也能撤销（再执行一次，就把 Agent 的改动放回来）。

## 9 处分叉怎么统一的

F1 列在 `dr_model::invariant::DIVERGENCES`，全部按 F1 的建议做了，F1 第三轮已把它们标成「已统一」并挂上下面的测试名：

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
cargo run --release -p dr-testkit --bin bench -- workspace [--out 文件 | --milestone f3-m2]
INSTA_UPDATE=always cargo test -p dr-workspace --test registry   # 有意改了命令以后更新快照
```

内存和单次提交的耗时用一个不进 CI 的测试量（只打印，不出证据），要分两个进程跑：

```bash
DR_FOOTPRINT_DIR=<空目录> cargo test --release -p dr-workspace --test footprint -- --ignored --exact build
DR_FOOTPRINT_DIR=<同一个> cargo test --release -p dr-workspace --test footprint -- --ignored --exact measure --nocapture
```

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| `tests/commands.rs`（23 项） | 每条命令和查询至少调一次，包括报错的情形；`null` 清空字段、撤销把空字段变回空；搜索按书序、废纸篓里的不占名额；有一项检查登记表里的每条都在这个文件里被调用过 | 全过 |
| `tests/registry.rs`（4 项） | 能力清单的两份快照（先排好键再比）；每条说明是一句话；读的都是 `shared`，写的都不是；输入都是带字段名的对象；清单里不出现 H1–H3 的禁用叫法、退役产品的名字和构想的旧叫法 | 全过 |
| `tests/events.rs`（4 项） | 书目事件点名实体；正文事件只点名被改的那一段；Agent 写入带结算事件；缓存跟着事件走 | 全过 |
| `tests/shell.rs`（4 项） | 目录按名字、按 id 找，组和组分开，重名（两台设备合并出来的）都返回，废纸篓里的找不到，改名立刻生效；进废纸篓、彻底删除、Agent 删除、删素材、删整本书都发 `Removed`，恢复不发；另一台设备同步过来的删除也发，没读过的被删节点两种都报；`before_quit` 补齐索引、关掉没人占着的文档，之后还能照常用 | 全过 |
| `tests/write_order.rs`（6 项） | 上面「写入顺序与补偿」表里的四种失败，加上重开后正文还在、不冲刷也全落盘 | 全过 |
| `tests/undo.rs`（9 项） | 三层撤销；日志重启后还在；每人只留最近的记录 | 全过 |
| `tests/invariants.rs` 单设备属性测试（另有两条从失败例子固定下来的回归测试） | 每例最多 35 步随机命令（36 种，包括撤销、重做、Agent 改名和撤销、故障注入、从磁盘重开），每一步后检查：章节和构想标题、故事线名、分类名、要素名和别名都不重复；每个实体的正文文档都在；显示的关系两端都活着；批注目标要么显示、要么标「未定位」；章节都有书序；构想分组不超过两层；重开前后读出来一样 | 3000 例全过（release） |
| `tests/invariants.rs` 两设备属性测试 | 同一本书的两份副本各自跑随机命令，再互相交换全部文档；两边读出来逐项相同；合并后可能出现的重名由读取标出，只有一个保留名字 | 3000 例全过 |
| `concurrent_creates_of_one_name_are_flagged_not_lost` | 两台设备同时建同名要素、同名章节：都保留，要素标出冲突，章节标题允许重复，下一次改名加后缀 | 过 |
| `tests/footprint.rs`（2 项，默认忽略） | 上面那组内存和单次提交的测量 | 手动跑 |
| 各模块单测（5 项） | 来源字符串一致、名字后缀、位置键、版本编码、事件里的段落换算 | 全过 |

证据按 [simplifications.md 第五节](../simplifications.md#五更轻的验收证据新工作区适用)：能力清单用快照；测量用 F8 的 `bench workspace` 套件，这个里程碑的结果是 [acceptance/f3-m2-workspace-bench.json](../acceptance/f3-m2-workspace-bench.json)（带源码指纹；源码变了只提示过期，不判失败）。

### 发现并修好的

第二个里程碑：

1. **关库碰上后台索引重建**（3000 例的随机测试里出现一次，复现率大约三分之一）：F2 打开库时会起一个线程重建落后的索引，它遇到已经打开的文档，会临时拿一个句柄去补索引。关库恰好落在这一刻，F2 就以「还有文档开着」拒绝。现在 `shutdown` 用 F2 的 `try_close`，被拒时把库拿回来，最多重试一秒。回归测试 `regression_shutdown_during_the_index_rebuild`；根上的修法写进了待协调 F2-2。
2. **Agent 撤销正文时「比较版本」和「退回」分成了两步**：作者的编辑器写正文不拿书的租约，两步之间打的字会被一起退掉。现在两步在同一个写入任务里做。
3. **测量发现**：F2 的按书序搜索在 heavy 种子上慢了十倍左右（见下）。

第一个里程碑，都是随机测试找到的：

1. **别名和自己的名字一样**：给要素加一个和它自己名字相同的别名，名字和别名就重复了。现在这样的别名直接忽略。
2. **改名成自己的别名**：改名后名字和别名重复。现在改名成自己的某个别名时，这个别名去掉（相当于「把别名提为正名」）。
3. **Agent 撤销恢复出重名**：Agent 把「一」改名成「二」，作者又新建了一个「一」，再撤销 Agent，就有了两个「一」。现在恢复出的名字被占时照样加后缀。
4. **撤销彻底删除时判断错了「是否在废纸篓」**：恢复一个被彻底删掉的对象时，按「现在」的状态判断它恢复后在不在废纸篓，而现在它根本不存在，于是当成了不活着、不查重名。改成现在不存在时按删除前的状态判断。

自查发现的：

5. **JSON 里的 `null` 被当成「没传」**：serde 默认把 `Option<Option<T>>` 的 `null` 读成外层的 `None`，于是「清空主故事线」之类的输入不起作用，「把空字段改成有值」的撤销也撤不回去（撤销的输入里正是 `null`）。19 个可清空的字段都改成「没传 = 不动，`null` = 清空」，补了测试 `null_clears_a_field_and_undo_brings_back_an_empty_one`。

6. 关库时如果后台线程正在投递事件，会短暂持有工作区，偶尔让 `shutdown` 报「还有别的引用」；现在先退订、再等投递结束。

## 关键数字

### 拆镜像前后（同一台机器、同样的负载，背靠背跑）

F8 的 `bench workspace`，heavy 种子（100 章，正文共约 360 万字，300 个要素，200 个构想，400 条关系，约 200 条批注），全部走命令写入。「拆前」是合并 main 后、改动前的同一份代码（镜像 + 内存里的日志 + 多取再截断的搜索 + 临时派生器）。拆前、拆后各跑两次，两两背靠背（第一对一分钟负载 5–7，第二对 8–15）；拆后的第二次就是证据文件。p50，单位 ms。

| 项 | 拆前 | 拆后 | 说明 |
| --- | ---: | ---: | --- |
| 走命令写完整个 heavy 种子（1623 条命令、679 次编辑会话） | 5429、5731 | 3501、3582 | 少了每次提交的导出导入，派生索引也换成了增量的 |
| 重开后第一次列章节 | 10.2、10.5 | 7.6、7.5 | 不用再载一份镜像 |
| 列章节（缓存命中，按名字 / 按类型） | 0.25 / 0.031 | 0.25 / 0.031 | 走缓存，和镜像无关 |
| 列要素、列关系（缓存命中） | 0.66、0.65 | 0.64、0.65 | 同上 |
| 新建章节 / 带 2000 字新建 | 1.7–1.9 / 3.1–3.3 | 1.8–2.0 / 2.6–3.2 | 在噪声以内 |
| 改章名、移动章节 | 0.27–0.28、1.5 | 0.26–0.29、1.5–1.7 | 同上 |
| 新建要素、新建批注 | 1.7、0.27–0.30 | 1.7–1.9、0.24–0.29 | 同上 |
| 进废纸篓再恢复、精确替换正文、对象级撤销 | 0.96–0.98、1.03–1.04、0.89 | 1.02–1.13、0.96–1.06、0.86–0.97 | 撤销日志现在写在磁盘上，也在噪声以内 |
| 改一处关系后马上列关系 | 2.6 | 2.7–2.8 | |
| 撤销帮手的一轮（10 处改动，每次只量一遍） | 111、191 | 103、146 | 单次测量，跳得厉害 |
| **搜索：三个字 / 一个字** | **46 / 32** | **262–264 / 489–498** | 见下 |

单条命令的耗时拆前拆后差不多：书目文档不大，镜像那一次导出导入本来就只占几微秒。拆镜像省下来的主要是内存和正文提交（下一节）。

**搜索变慢的原因**：F2 的 `search_in_order` 把书序当成一张临时的值表，和每一条命中做连接。这张表没有索引，所以每条命中都要从头扫一遍书序（heavy 种子上约 600 个文档）。花的时间大约是「命中条数 × 书序长度」。在 100 章、30 万字的书上单独量过：3000 条命中时，F2 的普通搜索（不排书序，最多取 1 万条）3.8 ms；按书序搜索，书序只有 100 个文档时 10 ms，600 个文档时 56 ms。把那张表改成 `MATERIALIZED` 试过，没有用。修法见待协调 F2-1，F2 改完以后工作区这边不用动。

### 内存和单次提交（`tests/footprint.rs`）

一本合成的书：100 章，每章约 3000 字、30 段，300 个要素。三轮背靠背，下面是三轮里都差不多的数（p50 / p95，ms）：

| 项 | 拆前 | 拆后 |
| --- | ---: | ---: |
| 打开 100 章正文多占的内存 | 46.8 MiB（每章 0.47） | 30.1 MiB（每章 0.30） |
| 再做完下面这些编辑以后，比开始时多占 | 63.1 MiB | 41.5 MiB |
| 作者打一个字（编辑会话，一次提交） | 0.094 / 0.128 | 0.078 / 0.103 |
| 书目提交（`chapter.update` 改梗概） | 0.091 / 0.125 | 0.090 / 0.130 |
| 正文提交（`prose.replace`） | 0.216 / 0.258 | 0.202 / 0.239 |

打开书目文档本身多占的内存（约 10 MiB，包括库和工作区自己的结构）两边一样：这本书的书目文档很小，镜像那一份副本可以忽略。

对照 [benchmarks.md](../benchmarks.md)：单次按键写入 ≤ 1 ms（发布档），现在是 0.08 ms；常用命令都在 0.3–2 ms。

## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1.1 | 注册表：命令、查询各登记一次，JSON Schema、读写、并发类别、说明；能力清单快照 | 完成 |
| 1.2 | 事务与写入顺序：先校验再写；正文、书目、本机表的顺序与补偿；带来源经 F2 持有者写入 | 完成 |
| 1.3 | 事件：Loro 差异换成实体 / 段落级事件，本机表变化走同一条总线；不用乐观更新 | 完成 |
| 1.4 | 查询：按事件增量缓存；章节、故事线、要素（含重名标记）、关系、构想、批注与待办、搜索（按书序） | 完成 |
| 1.5 | 第一批命令覆盖书的结构；9 处分叉统一；正文最小接口 | 完成 |
| 1.6 | 撤销三层 | 完成（编辑器层是接口，F4 接） |
| 1.7 | 单元测试、属性测试、两设备并发合并、测量 | 完成 |
| 1.8 | 证据（快照 + 一次测量） | 完成 |
| 2.1 | 拆掉镜像：命令在持有者的写入任务里用 dr-doc 写，读走 `DocView::with_doc`；量拆前拆后的内存和每次提交的耗时 | 完成 |
| 2.2 | 对象级撤销的日志换成 `ws_journal`（重启后还能撤销） | 完成 |
| 2.3 | 搜索用 F2 的按书序搜索，去掉多取再截断 | 完成；F2 那边慢，见 F2-1 |
| 2.4 | 给 F6：`Catalog` 用的目录、删除事件、退出钩子 | 完成；`dr-shell` 里的三行接法见上 |
| 2.5 | 测量改用 F8 的 `bench` 套件 | 完成 |

## 待协调

按负责的 crate 分。第一个里程碑提的 F1-1 到 F1-6、F2-1 到 F2-5 都由对方做了，这个里程碑也都用上了，下面只列新的。

### F2（dr-store）

1. **按书序搜索慢**（最要紧）：`search_in_order` 的耗时是「命中条数 × 书序长度」（数字见「关键数字」）。建议在 Rust 里排序：先只选所有命中的 `(id, doc_id, ord)`，用一张 `HashMap<doc_id, 名次>` 排好、截出前 `limit` 条，再按 id 取这些行的文字和片段。这样整体接近普通搜索的耗时。另外，SQL 文本会随书序长度变，`prepare_cached` 的缓存会被不断换掉。
2. **关库和后台索引重建**：打开库时起的重建线程会对已经打开的文档调 `reindex_doc`，临时拿一个 `DocHandle`。`try_close` 在停掉后台工作之前就先数打开的文档，所以碰巧会被拒。工作区现在靠重试绕过去（`Workspace::shutdown`）。建议 `try_close` 先停后台重建、等它退出，再数文档；或者重建线程不去拿已经打开的文档的句柄，交给持有者自己的空闲维护。

### F6（dr-shell）

- 照「给外壳（F6）的接口」那一节接：`Catalog` 套在 `BookCatalog` 上；订阅 `WsEvent::Removed`，转到主线程以后调 `Navigator::forget`；`quit::before_quit` 里调 `ws.before_quit()`。接好以后 `stand_in.rs` 可以删掉。
- 事件在持有者线程上到达，回调里不要等文档持有者，也不要直接碰 GPUI 的状态。
- `before_quit` 会等每个持有者收尾（写关闭标签、按需压缩）。测试里的小书只要几毫秒；大书压缩可能要几十毫秒，结果里的 `ms` 可以记下来看看。

### F4（编辑器）

- 先用 `ProseSession`（`edit` / `undo` / `redo` / `reader`）。撤销管理器挂在持有者那份文档上，Agent 的写入不会进作者的撤销栈（有测试）。
- `reader()` 和持有者共享同一份文档。读当前状态随便读；但**解析锚点**（`ProseView::resolve`，它要查历史，会在中途隐式提交）只能放在持有者线程上做（`DocHandle::read`），否则会把别人正在进行的写入拆成两次提交。
- 写入请走工作区（会话或命令），不要直接用 dr-store 的持有者写。

### F8（dr-testkit）

- `bench workspace` 的输入包含 `crates/dr-workspace`，所以 `f8-m2-workspace-bench.json` 现在显示为过期，这个里程碑的结果在 `f3-m2-workspace-bench.json`。旧的要不要删，由 F8 定。
- 套件里没有内存这一项。要的话可以把 `tests/footprint.rs` 的做法（分两个进程、`ps` 读常驻内存）搬进 `bench`。
- `bench.rs` 的注释里还写着「moved from F3's `tests/measure.rs`」，那个文件已经删了。

### dr-index

- `library_options` 现在调 `dr_index::attach`，工作区打开的每个库都用 `TextDeriver`。dr-index 以后改派生器的行为，工作区不用跟着改。

### M29（帮手工具）/ M32（MCP）

- 按名字调 `Workspace::call(actor, name, json)`；输入输出的 Schema 从 `registry().manifest()` 取；错误按 `code()` 分。
- 按名称找对象可以直接用 `ws.catalog(book)`，和外壳解析位置链接是同一套规则。

### M36（同步）

- 远端更新一律走 `Workspace::import_remote`：它走 F2 的 `import`（自动记下服务器已有的版本），然后跑 dr-doc 的修复（重复的块 ID、语义重复的关系、缺书序的章节）。直接调持有者的 `import` 会跳过修复。

## 没做的，和下一个里程碑建议

- **没做**：
  1. 时间钉、情节规划、补丁、写作日、模板的命令；整本书彻底删除和废纸篓 30 天到期；
  2. 正文的修订 CAS（带版本的写入），以及作者也改过同一篇正文时按段撤销 Agent 的改动（现在只报冲突，请作者从历史恢复）；
  3. 清理没人认领的正文文档（彻底删除后留下的，和中途失败留下的）；
  4. 第一个里程碑里自己写的「是否活着」判断、按目标找批注、Agent 撤销时从副本读裸值，还没换成 F1 第三轮给的 `entity_exists` / `relations_of` / `EntitySnapshot::field`。
- **建议的下一个里程碑**：
  1. 补齐上面第 1 条的命令（F8 的种子对拍等着时间钉和写作日）；加后台清理（第 3 条）；
  2. 换上 F1 的按键读取和快照按字段读取（第 4 条），重测「改了以后列关系」「冷读批注」；
  3. F2 改完按书序搜索后重测搜索；
  4. 帮外壳接上真书（F6 下一步的第 1 条），用 F8 的调试桥跑一遍「打开书 → 删章 → 标签关掉」。

## 代码位置

```text
next/crates/dr-workspace/src/
  lib.rs           入口和总说明
  registry.rs      登记表、能力清单、Op trait
  cx.rs            命令上下文：写入顺序、租约、影响清单、反操作、故障注入
  holder.rs        在 F2 持有者的写入任务里写（提交选项）、共用的锁
  workspace.rs     打开的书和正文、run / call、撤销重做、import_remote、事件分发、删除事件、退出
  nav.rs           给外壳的目录（LinkGroup、NavTarget、BookCatalog）
  events.rs        事件类型和换算
  cache.rs         按书的查询缓存
  journal.rs       撤销日志（ws_journal）
  editor.rs        ProseSession（编辑器层撤销）
  actor.rs dto.rs naming.rs error.rs
  commands/        book chapter storyline element relation idea comment material prose history
next/crates/dr-workspace/tests/
  commands.rs registry.rs events.rs shell.rs write_order.rs undo.rs invariants.rs footprint.rs
  snapshots/       能力清单快照（registry__capabilities.snap、registry__capability_schemas.snap）
docs/rust-rewrite/acceptance/f3-m2-workspace-bench.json
```
