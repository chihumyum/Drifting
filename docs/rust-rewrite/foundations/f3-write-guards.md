# F3：写入守卫（按记录）

2026-11-12。接着 [f3-workspace.md](f3-workspace.md) 的「写入顺序与补偿」，讲受守卫的写入（`Workspace::call_guarded`）到底守什么。

状态：**第 1、2 步已落地**（内核原语、每条写命令的声明；帮手工具按记录记账和守卫）。界面还在用整本书的版本号，行为和改造前一样，在第 3 步换过来。

## 大白话

「先读后写」的调用方（帮手、MCP、界面的保存）要保证一件事：我是照着读到的内容改的，要是这段内容在我读完之后被别人改过，我这次写入就不能落下去，否则会把别人的改动盖掉。

以前的做法是给整篇书目文档记一个版本号，写入时比对。可一本书只有一篇书目文档，条目树、模板、归属、时间线、补丁、情节格、关系、批注、素材、设定、记忆、写作日都在里面。于是每分钟一次的写作日记录、同步进来的任何改动、帮手改了别的条目，都会让所有等着提交的写入失败，哪怕它们碰的根本不是同一样东西。

现在改成：**写入只和它依赖的那几条记录比对**。书里别处怎么变都不影响它；它要替换的那条记录变了，照旧拒绝。

## 模型

- **记录键**：书目文档里一块可以单独比对的内容，写成「集合 + 路径」。
  - 路径为空：整个集合（`templates`、`timeline_views`、`meta`……）。
  - 一段：一条记录（映射的键，或者条目 / 素材夹的 id）。例：`timeline_views/<视图>`、`patches/<补丁>`、`entries/<条目>`、`plot_grids/<条目>/<模块>`（这个键本身带斜杠，所以键在接口里是数组，不是拼好的字符串）。
  - 更多段：记录里面的一个值。例：`entries/<条目>/title`、`entries/<条目>/fields/<模块>/<字段>`、`entries/<条目>/kv:<模块>/<行>`、`timeline_views/<视图>/pins/<时间钉>`。
  - 条目树另有一种键：**某一层的子条目顺序**（`children_of`，不给父级就是顶层）。
  - 短路径包含以它开头的长路径：读过整条记录，就算读过它的每个字段。
- **记录状态**：这块内容**自己存着的全部东西**，包括查询不显示的（回收站里的泳道名下的位置、换模板后留下的旧模块值），带上容器类型和富文本的格式。条目记录是它的元数据加住处（父级）；同一个 id 有两个树节点时（两台设备各建了一个），两个都算。
- **摘要**：记录状态的 SHA-256。两次读到的摘要相同，就是这条记录一点没变。它只看内容，不看是谁、分几次写成的，重开库、换一台设备读出来都一样。
- **观察**：`Workspace::observe_records(书目文档 id, 键列表)`，在持有者的一次读任务里算出每个键的摘要和它的普通值。不导出、不导入、不解码书里其余部分。
- **前置条件**：调用方交给 `call_guarded` 的 `WritePreconditions.records`，每条是「这个键现在应该是什么样」，有两种说法：
  - **摘要**（`Expected::Digest`）：和我观察时一模一样。整条写、帮手的写入用它。
  - **取值**（`Expected::AnyOf`）：这个键是单独一个值（普通值或一段文字，没存就是 `null`），而且等于我给出的几个值之一。界面改一个字段时说「`[我显示过的旧值, 作者改成的新值]`」：现在是旧值就写，已经是新值也算数（别处做了同样的改动），是第三个值说明别人改过，拒绝。它不需要先观察，界面手里本来就有显示过的值。给整条记录或者任何容器用取值永远不成立。
  - 比对都在持有者的**写任务里、任何改动之前**做，所以读和写之间插不进别的写入。
- **正文文档照旧按整篇的版本守卫**（`WritePreconditions.versions`）：一篇正文只属于一个条目的一个模块，粒度已经够细。批注锚定对来源正文的检查也不变。
- 书目文档也还可以按整篇版本守卫。只有真的需要整本书不动的调用才这样用：完整条目快照的原子恢复（`entry_snapshot.*`）。

## 内核强制的规则

1. **调用方说过的都要成立。** 这次调用带来的每一条前置条件（书的整篇版本、每条记录的摘要或取值）都在写任务开头比对。有一条不符就返回 `conflict`（`stale observation: book:<id> record <键>`），什么都不写，不记撤销日志。
2. **替换什么，就得读过什么。** 每条写命令都声明它「替换」的内容：用入参的值盖掉的已存的值，以及因为入参点了名而删掉的记录，声明到它实际写的最细路径。受守卫的调用必须给每一条声明带上同一路径或上级路径的前置条件，缺了就返回 `conflict`（`read required: book:<id> record <键>`）。带了整篇版本等于全都读过。
3. **不用声明的两类**：命令自己生成 id 新建的记录；命令自己照着当前文档规划出来的连带改动（取消归属时清掉的位置、放进回收站时跟着走的子树）。后一类本来就在租约里或写任务里按现状算，不依赖调用方读到过什么。
4. **什么都不替换，就不用读。** 纯新建（声明为空）的写入不带任何关于这本书的前置条件也可以通过；它带来的前置条件照第 1 条比对。有声明却一条关于这本书的前置条件都没带：`read required: book:<id>`。`require_all: false` 只关掉第 2 条的「缺了就拒绝」，第 1 条照样比对。
5. 没有按记录约定的命令（见下表最后两行）只认整篇版本；调用方带来的记录前置条件它们也照第 1 条比对。
6. 受守卫的调用新建正文文档之前，先在读任务里把第 1 条查一遍，过期的调用不会留下没人认领的正文。

声明是写在每个 `Cx::write_book_v3(slot, Replaces::…, …)` 调用上的必填参数，新加一条写命令不写它就编译不过。

## 每类命令守什么

| 命令 | 声明替换 |
| --- | --- |
| `book.update` | `meta/<点了名的字段>` |
| `book.trash`、`book.restore` | `meta/deleted_at` |
| `entry.create`、`project.create` | 无（新 id） |
| `entry.update` | `entries/<条目>/` 下点了名的 `title`、`template`、`overrides`、`layout`；现在也只写这几个 |
| `entry.move` | `entries/<条目>`（住处是条目记录的一部分） |
| `entry.trash`、`entry.restore` | `entries/<条目>/deleted_at`；跟着走的子树由命令规划 |
| `module.set_field` | `entries/<条目>/fields/<模块>/<字段>` |
| `module.put_kv`、`module.remove_kv` | `entries/<条目>/kv:<模块>/<行>` |
| `module.put_patch` | 给了 id：`patches/<补丁>/title`、`body`（给了 `pos` 再加 `pos`），来源引用不碰；没给 id：无 |
| `module.remove_patch` | `patches/<补丁>` |
| `module.put_grid` | `plot_grids/<条目>/<模块>` |
| `module.put_relation`、`relation.create` | 无（新 id；同一对端点已有关系时命令自己返回已有的） |
| `module.remove_relation`、`relation.delete` | `relations/<关系>` |
| `material.set_entry_link` | 取消时：被删掉的 `relations/<关系>`；建立时：无 |
| `entry_relation_type.put`、`entry_relation_type.delete` | `relation_types/<类型>` |
| `entry_template.put` | `templates/<模板>` |
| `entry_template.put_module`、`entry_template.remove_module` | `templates/<模板>/modules/<模块>` |
| `entry_template.delete` | `templates/<模板>/deleted_at` |
| `membership.add` | 已有这条归属（改顺序）：`memberships/<层级>\|<成员>`；新加：无 |
| `membership.remove`、`timeline_view.remove` | `memberships/<层级>\|<成员>`；主归属和位置的连带清理在写任务里规划 |
| `membership.primary` | `entries/<成员>/primary` |
| `timeline_view.put` | `timeline_views/<视图>` |
| `timeline_view.delete` | `timeline_views/<视图>/deleted_at` |
| `timeline_view.place` | `timeline_views/<视图>/placements/<条目>` |
| `timeline_view.put_pin`、`timeline_view.remove_pin` | `timeline_views/<视图>/pins/<时间钉>` |
| `timeline_view.rename` | `timeline_views/<视图>/name` |
| `timeline_view.add_lane`、`timeline_view.remove_lane` | `timeline_views/<视图>/lanes/<泳道>` |
| `timeline_view.move_lane`、`timeline_view.set_lane_act_track` | `timeline_views/<视图>/lanes/<泳道>/pos`、`…/act_track` |
| `comment.create`、`todo.project` | 无 |
| `comment.update`、`comment.delete` | `comments/<批注>` |
| `comment.reanchor` | `comments/<批注>/anchor` |
| `material.create`、`material_folder.create`、`asset.put` | 无 |
| `material.update`、`material.delete` | `materials/<素材>` |
| `material.move` | `materials/<素材>/pos` |
| `material_folder.update`、`material_folder.delete` | `material_folders/<素材夹>` |
| `fact.put` | 改已有的：`facts/<设定>`；新建：无 |
| `fact.remove` | `facts/<设定>` |
| `memory.add` | 无 |
| `memory.update` | `memory/<记忆>` |
| `memory.remove`、`memory.restore` | `memory/<记忆>/deleted_at` |
| `writing_day.record` | 无（本机这一天自己的计数，没有别的写入方） |
| `entry_history.restore` | 每个目标的 `<集合>/<id>` |
| `membership.restore`、`timeline_view.restore_fields` | 无（撤销 / 重做的逆操作，自己在写任务里逐字段比对 `expected`） |
| `history.restore_point` 的书目部分 | 整篇版本（受守卫的调用本来就拒绝这条命令） |
| `entry_snapshot.*`（原子建点和恢复） | 整篇版本，走原来的 `check_atomic_guards`；带来的记录前置条件一并比对 |

正文命令（`prose.*`、`module.set_prose`、`module.replace_prose`）和批注对来源正文的读取，照旧按正文文档的版本。

声明的是**最低要求**。调用方多带的前置条件（推导这次写入时读过的别的记录）照第 1 条一并比对。

## 这样守，守住了什么、没管什么

- **过滤后的读取不能授权整份替换**这一条不变，而且判断依据更准了：摘要算的是存着的全部内容，所以查询里看不见的数据变了，照样冲突；`RecordObservation.value` 给出记录存着的普通值，调用方拿它和查询结果对一下，就知道自己看到的是不是全部（帮手的 `timeline::Coverage`、时间线界面的 `covers` 已经是这么比的，只是以后数据来自这一条记录，不再来自整本书）。回归：`stored_data_a_filtered_read_hides_is_part_of_the_record`。
- **比的是内容，不是版本。** 记录被改走又改回原样，算没变，写入可以通过。照着读到的内容去改一条内容没变的记录，不会丢任何东西。
- **守卫不替命令检查不变量。** 「这个条目还活着吗」「这条泳道还收这个模板吗」仍由命令在书的租约里照当前文档校验，读取容错兜底。以前整本书的版本号顺带把「我读完之后书里任何变化」都挡了，现在不挡无关的变化，这正是这次改动的目的。
- **已删除记录底下保留的子映射不在摘要里。** Loro 里删掉一个映射键之后，原来那个子映射的内容还留着，别的设备离线时写进去的字段同步过来也在，只是读不到。摘要只算读得到的内容。时间线的字段级命令和两个逆操作自己另查这一层（`timeline_field_restore_state`、`membership_restore_state`），照旧。
- 这仍然是每篇文档各自的守卫，不是跨文档事务。

## 调用方怎么改

**帮手工具（第 2 步，已做）**

读工具调用：

- 不再前后各 `observe` 一遍整本书。执行器先取这次读涉及的文档的版本号（`Workspace::version`，不读内容），执行查询，观察这次读覆盖的记录，再取一次版本号；前后相同，说明查询结果和记录摘要是同一个状态下的。这个版本括号只管这一次调用，过后正文按它的版本守，书目只按读到的记录守。
- 每个 subject 记下它背后的记录和当时的摘要（`dr-agent-tools/src/records.rs`）：

  | subject | 背后的记录 |
  | --- | --- |
  | `entry:<id>` | `entries/<id>` |
  | `level:<id>` | `entries/<id>` 加这一层的子条目顺序 |
  | `entry:*`、`entry:all`、`entry:roots` | 顶层的子条目顺序；列出来的每个条目另有自己的 `entry:<id>` |
  | `module:<条目>:<模块>`（来自 `module.read`） | `entries/<条目>/fields/<模块>`、`entries/<条目>/kv:<模块>`、`plot_grids/<条目>/<模块>`，以及读到的每条补丁和关系 |
  | `module:<条目>:<模块>`（来自模块清单或模块正文）、`module:<条目>:*` | `entries/<条目>` |
  | `entry_template:<id>`、`timeline_view:<id>`、`entry_relation_type:<id>` | 那一条记录；`:*` 是整个集合 |
  | `membership:<层级>\|<成员>`（`membership.list` 的每一行、`level.get` 的每个成员） | `memberships/<层级>\|<成员>`；`membership:*` 是整个集合 |
  | `fact`、`memory`、`material`、`material_folder`、`comment`、`relation`、`asset`、`book` | 同名集合里的那一条；`:*` 是整个集合（`book` 是 `meta`） |
  | `prose:<文档>` | 正文文档，按版本，不变 |
  | `entry_history:<书>` | 没有按记录的依据：整本书的版本 |

- 书里别的记录变了，不清空已经读过的。同一条记录再读一次，换成新摘要。

写工具调用：

- 带上这次写入要求的每个 subject 背后的记录摘要，正文目标照旧带版本。整条替换点名了已有记录的（`timeline_view.put`、`entry_template.put`、`entry_relation_type.put`），只带那一条的摘要，不带整个集合的。
- 只有 `entry_history.restore` 还带整本书的版本（它的依据是 `entry_history.version` 读到的那个版本）。
- 写完（不论成败）只忘掉这次写入用到的 subject 和它们所在的列表：照着写的那份内容不能悄悄当成最新，要重读；这一轮读过的其他记录照旧有效，可以接着写。以前是任何一次写入都清空对这本书的全部读取。
- 冲突按记录计数：`stale observation: book:<id> record <键>` 里的记录冲突两次，这一轮对这条记录停手；别的记录不受影响。
- 写前快照（`entry_snapshot.create_with_receipt`）带同一组记录前置条件和正文版本，过期的写入不留快照。快照会推进书的版本，但碰不到被守的记录，所以不用再把回执里的新版本换进守卫；只有带整本版本的那一种还要换。
- 时间线的 `Coverage` 留着，原始数据来自 `timeline_views` 集合的记录观察。取消归属除了两个条目，还要求读过时间线视图（证明没有隐藏位置会被连带清掉，这份证据必须是当前的）和被取消的那条归属。

比以前严的两处（都是内核按声明拒绝的，不是执行器另加的规则）：

- 只看过模块清单（`module.list`）就整条替换补丁或情节格、删关系，以前放行，现在要先 `module.read`。清单里没有这些内容，这本来就不满足「整条替换前完整读过」。
- 取消归属、给已有的归属改顺序，要读过那条归属（`membership.list`，或它所在层级的 `level.get`）。以前只要求读过两头的条目。新加一条归属不替换任何东西，照旧只要两头的条目。

每次调用的其他整本读取也换掉了：工具目录缓存的失效判断、结构说明的前后比对改用 `Workspace::version`；`is_v3_book` 对已经打开的书不再拷贝整本（`Workspace::is_v3_book`）；`prose.read` 取批注锚点改在持有者读任务里读。名字解析（`resolve_v3`）每次调用仍拷贝一份书目文档，见「还没做的」。

**界面（第 3 步）**

- 只是为了拿版本号的 `observe("book:…")`，换成记录观察；确实只要一个版本号的地方（比较新旧快照）用 `Workspace::version`，它不读内容。
- 整条写的保存（模板编辑、整份时间线、情节格）：显示的内容是哪次读出来的，就留那次的记录摘要，保存时交给 `call_guarded`。**不能在保存前重新观察**再拿旧的界面值去写，这一条和以前一样。
- 字段保存不再观察、不再在界面里合并：只写作者改过的那个字段，带一条取值前置条件 `[显示过的旧值, 新值]`。三方比对由内核在写任务里做，所有界面是同一套规则。作者明确选择覆盖（现在的「重试」）就不带这条前置条件。例：

  ```rust
  ws.call_guarded(&Actor::User, "entry.update", json!({"book": book, "id": entry, "title": edited}),
      WritePreconditions::default().with_value(doc, RecordKey::entry(entry).at(["title"]), [json!(shown), json!(edited)]))
  ```

- 这要求命令只写点了名的字段。`entry.update`、`module.set_field`、`book.update`、`comment.update`、`material.update` 已经是；补丁和键值行现在是整条写，要加字段级的写法：

  | 现在 | 第 3 步 |
  | --- | --- |
  | 补丁改标题或正文：`observe` 全书 + `module.read` + 界面合并 + `module.put_patch` 整条写回 | 新增 `module.edit_patch {id, title?, body?}`，只写给出的字段，各自声明 `patches/<补丁>/title`、`body` |
  | 键值行：同上 + `module.put_kv` | 新增 `module.edit_kv {row, key?, value?}`；新建行仍用 `module.put_kv` |
  | 删补丁 / 删键值行前在界面里比对旧值 | 命令不变。界面带它显示过的两个字段的取值前置条件，并设 `require_all: false`：两个字段合起来不算读过整条记录，界面只担保作者看到的那两样没变 |
  | 条目标题、字段值 | 命令不变，带取值前置条件 |

  这两条新命令不进帮手的工具目录（帮手照旧整条写，由执行器带记录摘要）。

## 变了的行为

- **带记录前置条件的受守卫调用，不再因为同一本书里无关的写入而冲突。** 这是目的。带整篇版本的调用一字不变，所以现有调用方和现有测试的结果都没变。
- `entry.update` 只写入参点了名的字段。以前会把另外几个字段按命令读到的值重写一遍，租约外同步进来的改动有可能被写回旧值。
- `WritePreconditions` 多了 `records` 字段（默认空）。用结构体字面量构造它的 10 处补了 `records: Vec::new()`，其中 3 处在测试里，属于机械改动，断言没动。
- 冲突信息里记录级的两种多了 `record <键>` 后缀；`code()` 还是 `conflict`。
- 新接口：`Workspace::observe_records`、`Workspace::version`、`Workspace::is_v3_book`，类型 `RecordKey`、`RecordObservation`、`RecordPrecondition`、`Expected`；dr-doc 新增 `v3::RecordKeyV3`、`RecordReaderV3`、`RecordStateV3` 和 `BookViewV3::record_state`（只加不改）。
- 摘要只在内存里用（一轮对话、一个界面的草稿），不落盘、不同步，所以以后换哈希或者 Loro 升级改了序列化都不影响已有数据。
- 命令注册表、能力清单、帮手目录都没有变化。
- 帮手这边（第 2 步）：同一本书里无关的改动（包括帮手自己对别的记录的写入）不再让它重读；冲突信息里是记录不是整本书；上面「比以前严的两处」。

## 测试

- `dr-testkit/tests/v3_record_guards.rs`（Tiny 种子，9 条）：观察之后插入写作日、另一条目改名、新建设定，带整篇版本的调用冲突而带记录摘要的通过；被守的记录变了就冲突，书的版本、记录摘要、撤销日志都不动；只改了查询看不见的位置，过滤后的读取完全一样，整份替换仍被拒，位置原样保留；没读过要替换的记录就拒绝，字段 / 记录 / 集合三种粒度的覆盖关系，还不存在的 id 也能守；字段级守卫不受同一条目其他字段影响，`entry.update` 不碰没点名的字段；子条目顺序是独立的记录；过期的受守卫新建不登记正文；摘要重开库后不变，畸形的键、摘要、指向正文的记录前置条件被拒；字段按取值守卫（旧值写入、第三个值拒绝且别人的值留着、已是新值不算冲突、没设过的字段是 `null`、补丁正文按文字比、取值不能代表整条记录），`require_all: false` 仍比对带来的前置条件。
- `dr-doc` `v3::record` 的 4 条单元测试：记录状态只含自己；条目记录含住处、不含兄弟；同 id 的两个树节点都算，另一台设备上同内容同状态；不存在的读作缺失，键的包含关系。
- `dr-agent-tools/tests/record_coverage.rs`（6 条）：读过之后书里无关的改动不要求重读，写前快照照常；被改过的记录只拒绝照着它写的那一次，另一条记录照写，被拒的写入不算读，同一条记录冲突两次停手而别的记录不受影响；帮手自己写过一条记录后，读过的其他记录不用重读；只看过模块清单不能整条替换补丁，读过模块后条目标题和别的模块变了不冲突，补丁本身变了冲突；取消归属、给已有归属改顺序要读过那条归属，新加不用，别的归属变了不冲突；整份替换时间线视图只和那一个视图比，别处新建同 id 的视图不被盖掉。
- 改了一条既有测试：`barriers.rs` 的 `a_new_book_version_read_does_not_refresh_old_chapter_coverage`，原来断言「作者改了书的简介之后，帮手读过的章节全部作废」，这正是整本一把锁的行为。改成 `a_later_read_does_not_refresh_the_coverage_of_a_chapter_that_changed`：无关改动之后不用重读；章节本身被改之后，再读别的东西也不能让旧读取重新生效，写入被拒、不落任何东西，重读后才能写。
- 原有的守卫回归（`workspace_guarded`、`v3_comment_read_guard`、`v3_membership_retention`、`v3_timeline_edits`、`v3_membership`、`kernel_v3`、`entry_snapshots`、`timeline_coverage`、`checkpoints_v3` 和各界面 crate 的内联测试）断言一条没改。

## 还没做的

- 第 3 步（界面）、第 4 步（Heavy 上的前后耗时）。
- `Workspace::observe` 整本书的导出再导入还在，等界面也换走以后只留给真正需要整本内容的工具。
- 帮手的名字解析（`resolve_v3`）和写前快照选条目（`checkpoints::entries`）每次调用各拷贝一份书目文档（`Library::load_copy`），代价也随书变大。它们要的是一份前后一致的只读快照，不是守卫；换成在持有者读任务里解析要先理清解析过程中对工作区的回调，留作单独一项。
