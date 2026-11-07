# M10 旧库导入

2026-11-07，第一个里程碑。计划见 [modules.md 的 M10](../modules.md#阶段-2写作闭环)，依据是 [P0-E 的结论和规格草稿](../spikes/p0-e-import.md)。代码在 `next/crates/dr-import-v1/`（不依赖 GPUI，不依赖 yrs / Yjs），旧版这一侧只改了交接（`src/renderer/services/v2-handoff/`，[docs/v2-handoff.md](../../v2-handoff.md)）。证据在 [acceptance/m10-import.json](../acceptance/m10-import.json)。

## 做了什么（大白话）

1. **能把一个 0.1 的库整本搬进新库了。** 书目、章节和构想、要素、分类、故事线、关系、时间钉、情节规划、批注和待办、补丁、素材和素材夹、构想分组、Project Memory、写作日、资源文件，全部写进 F1 的书目文档和正文文档，存进 F2 的 dr-store。正文从旧库里的缓存（`contentJson`）来，新版完全不读 Yjs。
2. **原库一个字节都不碰。** 导入先把旧库文件（连同崩溃后留下的 `-wal`）逐字节读出来拷一份，复制前后都看一眼文件有没有变；之后所有读取都在这份副本上。0.1 早一些版本的库，在副本上按旧版自己的规则补齐迁移。拷贝前检查旧版是不是还开着这个库（macOS / Linux 用 `lsof`，和旧版开发命令行一样；Windows 用独占打开）。
3. **「一字不差」有证据。** 每篇正文先判断缓存是不是最新（见下文「新鲜度」）。旧版最后一版的交接给每篇记了版本号和哈希，对上就是最新。没交接过、又有证明不了的正文时，**默认拦住**，列出是哪几篇（带标题），给出旧版最后一版的下载地址；作者点「仍然导入」才照缓存导入，回执和摘要里写清这几篇可能少了最后几秒的字。
4. **快照历史也搬过来了。** 旧版每条快照历史都存着当时渲染好的正文，导入时按时间先后依次写进同一篇 Loro 正文，每一版都能检出，每一版一个历史点，时间用旧版的时间。
5. **批注和补丁的位置变成了 Loro 光标。** 旧版存的是「块 ID + 偏移 + 原文」，导入时按旧版自己的规则找回位置（找不到原文就退回整段），再换成一对光标；原文和各段快照照旧保留，「查看原文」「原文已改」还能用。
6. **导入的结果可以复查。** 新库旁边多一个 `import-v1/` 文件夹：`receipt.sqlite` 记着每本书、每篇正文导入了什么、规整了什么、哪些篇无法证明是最新，以及只读搬过来的旧帮手对话和本机设置；`summary.md` 是给作者看的同一份摘要。
7. **两台设备导入同一个旧库，写出的字节完全一样。** 每篇文档用由文档 id 算出的固定「导入对等方」和旧数据里的时间戳写，测试逐字节比过。
8. **旧版交接补上了漏导的按书数据**：字数目标和每日目标、关系类型的颜色、关系图里作者拖动固定的位置，现在记进交接清单的 `books` 一节（以前只能从原始设置里猜，字数目标根本没导）。

**要作者定的事：没有。** 技术取舍都写在下面，要别的会话配合的列在「待协调」。

## 关键数字

M3 Pro，release，2026-11-07，机器负载约 6.5（记在证据里；同一程序在忙的机器上会慢 2–4 倍，见 F2）。五份库都是本 worktree 里新生成的合成库，不碰作者的库。「真值」是旧版用 Yjs 渲染出的正文（交接用的同一个函数），只用来核对，导入本身不读它。

| | 样书 | 样书·用旧（没交接） | 样书·交接过 | 合成·轻量 | 合成·重型 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 书 / 有正文的对象 | 2 / 156 | 2 / 156 | 2 / 156 | 1 / 80 | 1 / 679 |
| 正文字数（字符） | 70.3 万 | 70.3 万 | 70.3 万 | 27.3 万 | 390.8 万 |
| 闸门 | 通过 | **拦住**：没交接、5 篇无法证明、2 章证明落后 | 通过 | 通过 | 通过 |
| 和 Yjs 真值一致 | 152 / 152 | 146 / 153 | 153 / 153 | 68 / 68 | 619 / 619 |
| 判为最新、其实不同 | **0** | **0** | **0** | **0** | **0** |
| 被拦的几篇里真的落后的 | — | 7 / 7 | — | — | — |
| 存进去读回来和计划一致 | 156 / 156 | 156 / 156 | 156 / 156 | 80 / 80 | 679 / 679 |
| 导出旧版 JSON 再导入，往返一致 | 156 / 156 | 156 / 156 | 156 / 156 | 80 / 80 | 679 / 679 |
| 锚点 → 光标 | 19 / 19 | 19 / 19 | 19 / 19（1 处按原文找回） | 2 / 2 | 10 / 10 |
| 快照历史行 → 历史点（逐版检出核对） | 0 | 6 / 6 | 6 / 6 | 0 | 0 |
| 资源文件（校验后复制） | 7 / 7 | 7 / 7 | 7 / 7 | 6 / 6 | 36 / 36 |
| 整库导入耗时 | 0.89 s | 0.91 s | 0.85 s | 0.67 s | 4.4 s |
| 峰值内存 | 36 MB | 38 MB | 37 MB | 29 MB | 132 MB |
| 旧库 / 新库的数据库文件 | 11.2 / 1.7 MB | 11.5 / 1.7 MB | 11.6 / 1.7 MB | 15.9 / 1.4 MB | 243 / 16.5 MB |

- 「用旧」= 样书上用旧版自己的写入路径在 7 篇正文的 Yjs 里追加了字、不誊缓存（章节、要素、故事线、分类、素材笔记都有），再用旧版的快照服务给两篇各拍 3 份历史。闸门判出的 7 篇正好是这 7 篇；作者点「仍然导入」后，这 7 篇照缓存导入，和真值不同，回执里记成「无法证明」。
- 「交接过」= 在「用旧」上跑真实的 `runV2Handoff`（153 篇重新誊写并盖章）。导入时 153 篇全部判为「交接时核对过」，和真值一字不差；历史 6 行全部变成历史点，逐个检出和当时的预览一致。
- 重型库的耗时里：拷贝、检查和判断旧库 1.0 s，建正文 1.06 s，写进 dr-store 1.19 s，资源文件 0.86 s（每个文件都落盘同步）。新库小得多，是因为旧库里还有同步引擎、投影表和 Yjs 的多份拷贝。重型库里 3343 段正文在旧数据里没有块 ID，导入后由 dr-doc 的修复按确定规则补上。
- 样书里的「容器块 ID 改指段落」34 处：引用块自己的块 ID 在新结构里不是段落 ID，引用它的批注、链接改指它的第一段（见下文「正文」）。

## 流程（定稿）

`run::import(旧库文件, 新库文件夹, Options)`，F6 以后在它前面加界面和进度：

1. **找库**（`locate`）：照旧版 `library_registry.rs` 和 `data_paths.rs` 的规则。旧版应用数据目录（正式版身份的 `AppDirs::data`，F7）里的 `libraries.json` 列出各个库：`legacy` 就是这个目录本身，其他的在 `libraries/<id>/`；每个库的数据库是 `databases/drifting-library.db`，资源、安装身份、Markdown 文件夹状态在库根下。没有登记表就只有 `legacy`；登记表坏了直接拒绝，不重置（和旧版一样）。本机库（`local`）和各账号库（`account-<哈希>`）都能列出来，各导进各自的新库（按账号分库是 M35 / M36 的事）。
2. **暂存副本**（`staging`）：确认旧版没开着这个库 → 逐字节复制数据库和 `-wal`（边复制边算 SHA-256，作为「旧库指纹」）→ 复制前后文件大小和修改时间都没变才算数 → 打开副本让 SQLite 回放 WAL、`quick_check`、合成单个文件 → 迁移级别不是最新就在副本上补齐（`schema`，见下）。副本放在 `<新库>/import-v1/staging/`，导入成功后删掉。
3. **闸门**（`gate`）：给每篇正文判新鲜度，统计同步的未决冲突、缺口、隔离对象；有问题就停（见下文），什么都不写。
4. **逐本书写入**：
   1. 读这本书的全部行（`legacy::BookRows`），解析每篇正文的缓存；
   2. 给每个旧块 ID 找到它在新正文里的段落（容器块 ID → 第一段 / 最后一段）；
   3. 从正文生成的待办（`TODO:` 标记、素材笔记的任务行）换成确定的新 id（`CommentId::for_projection`），所有指向旧 id 的地方（关系、任务行的 `todo`）一起改；
   4. 每篇正文在内存里用 dr-doc 建：先按时间写快照历史的各版，再写当前正文；写完读回来和计划逐段比对；导出成旧版 JSON 再导入一遍，必须得到同一份；再在当前版本上把批注、补丁换成光标并当场解析核对；最后跑一次 dr-doc 的块 ID 修复；
   5. 书目文档同样在内存里用 dr-doc 建（`book`），跑一次 dr-doc 的书目修复；
   6. 每篇文档交给 dr-store：`open_doc(创世)` 后 `import(字节, Origin::Import)`，落盘为来源 `import` 的一行；
   7. 资源文件按 SHA-256 和大小校验后经 dr-store 的资源导入协议复制。
5. **收尾**：库关好后写历史点（见「待协调」2），写回执和摘要，删暂存副本。

已经在新库里的书（`book:<id>` 已存在）不再导入，回执里记 `already-imported`：导入对等方是确定的，同一本书第二次导入如果旧数据变过，会在同一批操作 ID 下写出不同的内容，Loro 合并时会悄悄跳过（见「待协调」9）。

### 补齐迁移（`schema`）

旧版 `crates/drifting-core/src/database.rs` 里和 Drizzle 绑定的那部分照搬：`__drizzle_migrations` 里记的每一条必须是已发布迁移的前缀（`created_at` 等于日志的 `when`、`hash` 等于文件的 SHA-256），比已知的多就报「旧库比导入器新」，对不上就报「不是 0.1.0-alpha.1 以后的库」；缺的迁移在一个事务里、关掉外键补上。19 个迁移文件不拷贝，由 `build.rs` 从仓库的 `drizzle/` 嵌进来，`schema.rs` 钉住每个文件的 SHA-256（改了已发布的迁移就编不过测试）。不拷贝是因为基线 SQL 里有已退役同步提供方的名字，拷进来会触发退役守护测试；阶段 7 删旧客户端时把文件搬进本 crate，并更新守护名单。

## 新鲜度和闸门

新版不读 Yjs，所以每篇缓存是不是最新只能看旁证（`legacy::Freshness`，和 P0-E 一致）：

| 类别 | 判断依据 | 算不算最新 |
| --- | --- | --- |
| `seed-only` | 没有任何 Yjs 行（从没打开过的素材笔记） | 算：缓存就是正文 |
| `creation-seed` | 只有 1 条 Yjs 更新、版本号 1、没有快照 | 算：创建时和缓存同一事务写 |
| `node-basis-current` | 章节、构想的字数依据是 `yjs` 且版本号等于当前版本 | 算 |
| `handoff` | 交接清单里这篇的版本号等于当前版本号，缓存的 SHA-256 等于清单记的 | 算 |
| `handoff-mismatch` | 版本号对得上，哈希对不上 | 不算：核对后缓存又被改过，不再退回别的规则 |
| `node-basis-behind` | 字数依据的版本号落后 | 不算：证明落后 |
| `unproven` | 创建后改过，又没有任何版本记录 | 不算：无法判断 |

注意不能拿缓存和 Yjs 的字节比：样书里一个字没改的章节，缓存和 Yjs 渲染也有 70 章字节不同（人物链接属性的顺序、`targetEndBlockId: null` 这类默认值），内容完全一样。

闸门（`gate::Gate`）的理由和作者的选择：

| 理由 | 什么时候 | 「仍然导入」要勾的 |
| --- | --- | --- |
| `no-handoff` | 没有交接清单，且有 `unproven` 的正文 | 无法证明的正文 |
| `unproven` / `stale` / `changed-after-handoff` | 有对应类别的正文 | 无法证明的正文 |
| `sync` | 同步有未解决的冲突、缺口或隔离对象 | 同步未停稳（单独一项） |

拦下时 `Gate` 里有：每篇被怀疑的正文（书、种类、旧文档 id、类别、标题）、各类别计数、旧版最后一版的下载页 `LAST_RELEASE_URL`（现在是仓库的 Releases 最新页，最后一个 0.1 标签发出后换成它的页面，M42）。界面文案只给了占位键（`gate::messages`，dr-i18n 还没建）：

| 键 | 意思 | 参数 |
| --- | --- | --- |
| `import.v1.blocked.title` | 有几篇正文可能少了最后几秒打的字 | |
| `import.v1.blocked.no_handoff` | 这个库没有用旧版最后一版打开过 | `{release_url}` |
| `import.v1.blocked.unproven` | 有几篇无法证明是最新，列在下面 | `{count}` |
| `import.v1.blocked.stale` | 有几章确定比作者写的旧 | `{count}` |
| `import.v1.blocked.changed_after_handoff` | 有几篇在交接核对后又被改过 | `{count}` |
| `import.v1.blocked.sync` | 同步还有没解决的冲突 | |
| `import.v1.blocked.get_last_release` | 怎么办：下载旧版最后一版，打开一次这个库再退出，然后重新导入 | `{release_url}` |
| `import.v1.action.download_last_release` | 按钮：去下载旧版最后一版 | |
| `import.v1.action.import_anyway` | 按钮：仍然导入（这几篇照缓存导入） | `{count}` |

## 书目文档：逐表怎么落

字段名以 [loro-schema.md](../loro-schema.md) v2 和 `dr-doc` 的写入器为准。时间：旧版的 ISO 文本换成秒（`time.rs`，带测试）。退役取值一律经 `dr_model::legacy` 规整。

| 旧表 | 新版 | 不能照抄的地方 |
| --- | --- | --- |
| `project` | `meta`：书名、简介、创建时间、最近删除 | 字数目标、每日目标来自交接清单的 `books`（没有就用默认 120000 / 1500；0 是作者关掉的，保留）；项目设定、故事线模板来自 `entity_kv_entry` |
| `book_node` + `node_storyline_link` | `nodes` | 书序只写章节（构想身上的书序丢掉并计数）；构想分组只写构想；`is_primary` 成为 `primary_storyline`；字数各列是投影，不导 |
| `book_act`、`timeline_marker` | `acts`、`time_pins` | 原样 |
| `storylines` | `storylines` | 顺序：按旧的名次 `order_key` 生成分数索引位置键；`node_content_template_json` 成为 `chapter_template`（空的 `{}` 不写） |
| `element_category` | `categories` | 字段模板来自 `entity_kv_entry`；`element_template_json` 原样存字符串 |
| `element` | `elements` | 别名来自 `aliases_json`；关系图里固定的位置来自交接清单 |
| `entity_kv_entry` | 各对象的键值列表、项目设定 | 没有顺序列：顺序取所属对象的 `*_kv_json` 投影（按键和值逐个对上，多出来的排后面）；条目 id 原样 |
| `entity_relation_type` + `…_endpoint_kind` | `relation_types` | 内置关系类型由创世写好，不再写；颜色来自交接清单 |
| `entity_relation` | `relations` | 种类 `library_item` → `material`；端点是被换了 id 的待办时跟着换；对称类型的两端按规范顺序存 |
| `plot_grid_*` | `plot_grids` | 行、列的 `position_key` 原样（坏的才整列重排） |
| `comment` | `comments` | 锚点见下；`anchor_json` 的 `selectedText` / `textAnchor.text` → `quote`，`blockSnapshots`（没有就用 v2 的 `blockText`）→ `snapshots`，`region` → `region`；`target_block_id` 是容器的改指第一段；正文是纯文字（见「待协调」5）；`copilot` 来源 → `api`，`copilot` 作者 → `ai`，`converted` → `resolved` |
| `comment_action` | 待办的 `agent_conversation` | 只留 `start_agent_task`；采纳 / 拒绝不导（计数） |
| `element_patch` | `patches` | 锚点同批注；`source_block_text` → `source_text`；正文纯文字；顺序按每个要素内的名次 |
| `library_item` | `materials` | `notes_json` 成为纯文字的描述；`external_url`、`preview_image_url` 自迁移 0011 起恒为空，不导；文本素材的 `body_json` 成为正文文档 |
| `material_folder`、`drift_group` | 两棵树 | 父级在前地建；父级不在或成环的挂到根上（计数）；构想分组的颜色、兄弟顺序按 `sort_order` |
| `agent_memory` | `memory` | 目标块是容器的改指第一段 |
| `writing_day` | `writing_days` | 设备键原样（旧值就是 `DeviceKey::from_installation_id` 的同一个摘要） |
| `project_asset` | `assets` + dr-store 资源文件 | 见「资源文件」 |

从正文生成的待办：元数据 `kind = todo-autoparse`（章节里的 `TODO:`，块是 `blockId`）、`kind = note-task`（素材笔记的任务行，块是任务项）换成 `CommentId::for_projection(种类, 文档, 块)`，写 `projection` / `projection_block`；任务项的块 ID 在新结构里是它那一段的块 ID。旧 id 不留。

## 正文：从编辑器 JSON 到 dr-doc 的段落

解析沿用 P0-E 的 `prose.rs`（`prose/pm.rs`）：一行一个叶子块，外面的容器记成路径。映射到 schema v2（`prose/plan.rs`）：

- 段落的块 ID 就是旧的块 ID（uuid 原样）。容器（引用、列表、列表项、任务项、提示框）在 v2 里只是段落属性，它们自己的块 ID 不是段落 ID：引用这些块的批注、人物链接的 `targetBlockId`、补丁、Project Memory 都改指容器的第一段（结束块指最后一段）；容器的第一段本身没有 ID 时，把容器的 ID 给它。
- 标题 H1/H2/H3、缩进、对齐、引用、分隔线、列表（种类 + 嵌套层级）、任务（勾选；链了待办的不存勾，只存 `todo`）、代码块（每行一段，第一段带原块 ID）、提示框，逐一对应 `BlockAttrs`。
- 行内：加粗、斜体、下划线、删除线、链接、高亮、行内代码、人物链接（每个目标一个键，可以重叠）。段内换行是 U+2028。
- 表格成为一个嵌入：格子是纯文字，格子里的几段用 U+2028 连起来；行列 id 是 `r0…`、`c0…`，位置键按顺序生成；嵌入 id 和段落 ID 都用表格的块 ID。素材嵌入成为素材嵌入。正文最后一段是嵌入时，后面补一个空段（dr-doc 的正文永远以普通段落结尾）。
- 写入只走 dr-doc 的类型化接口（`prose/write.rs`）：段落级的差分（相同的前缀、后缀不动，中间成对改写或插入删除），所以历史的每一版只多出它真正改了的那几段。

**怎么证明零差错**：(1) 存进去再读回来，逐段（块 ID、属性、每一段文字和它的标记、嵌入的内容）等于计划；(2) 读回来的段落导出成旧版 JSON（`prose/export.rs`，也是 M41「Loro → Manuscript」的起点）再导入一次，得到同一组段落；(3) 和 Yjs 真值比：真值经同一套映射得到的段落，和新库里读出来的完全一致（块 ID 只排除修复改过的）。五份库全部满足。

规整清单：每一处都计数，写进回执（每本书、每篇正文）。前五项是无损的记账，其余是和旧版不完全一样的地方，摘要里用大白话写给作者：

| 键 | 意思 | 五份库里出现 |
| --- | --- | --- |
| `container-id-remapped` | 容器的块 ID 不是段落 ID，引用改指它的段落 | 样书 34 |
| `container-id-on-paragraph` | 容器的第一段没有 ID，拿容器的 ID | 0 |
| `code-block-line` | 代码块按行拆成段 | 0 |
| `entity-link-block-remapped` | 人物链接的目标块是容器，改指它的段落 | 0 |
| `paragraph-after-final-embed` | 嵌入在最后，后面补空段 | 0 |
| `block-id-assigned`（正文回执） | 旧数据里没有块 ID 或重复，dr-doc 修复补上 | 轻量 172、重型 3343 |
| `list-item-extra-paragraph` | 一个列表项里有几段，新版每段一项 | 0 |
| `table-header-cell` / `table-cell-marks` / `table-cell-span` / `table-cell-paragraphs-joined` | 表头按普通格；格子里的格式、合并和列宽不保留；格子里几段合成一段 | 0 |
| `ordered-list-start` / `align-unsupported` / `heading-level-clamped` / `indent-clamped` | 编号起点、两端对齐、超范围的标题层级和缩进 | 0 |
| `unknown-inline:<类型>` / `unknown-mark:<类型>` / `unknown-block:<类型>` / `unknown-container:<类型>` | 新版不认识的节点和标记：行内对象从正文去掉、JSON 原样进回执；格式去掉、文字保留；块按普通段落 | 0 |
| `highlight-in-prose` / `code-in-prose` / `note-attribute-in-prose` | 笔记才有的格式出现在正文里（旧版不允许，不该出现） | 0 |
| `entity-link-same-target-overlap` | 同一目标两段范围不同的链接重叠，保留后一条 | 0 |
| `comment-body-formatting-kept-as-text` 等 | 批注、补丁、素材描述的格式按纯文字导入，原 JSON 进回执 | 0 |

## 锚点

照 P0-E（`anchors.rs`），只是换成在旧行上定位、再按计划换成新正文的位置：

| 旧数据 | 导入 |
| --- | --- |
| `anchor_json` v4 `textAnchor`、补丁的 `text_anchor_json` | 起止块 + UTF-16 偏移（硬换行不占位，表情占 2）+ 原文：先按偏移取、和原文比（跨块忽略空白），对不上在起始块里找离原偏移最近的同一段原文，还找不到退回整段；结果换成一对光标 |
| 只有 `target_block_ids_json` / `target_block_id` | 光标框住这些块；有块不在了就框住剩下的 |
| v1–v3 | 只留原文和快照（v1 的 ProseMirror 位置不可移植） |
| `region` | 原样，不涉及正文 |

光标用 `ProseView::anchor` 建，当场 `resolve` 回来核对范围；块已经不在、范围为空的不放光标，批注挂在对象上，卡片显示原文快照。从正文生成的待办不放光标：它的位置就是它的块。

## 快照历史

`entity_snapshot_history` 每行有当时渲染好的预览（`content_json`），所以不读 `state_blob`。一篇正文的各行按时间排好，逐版写进同一个 Loro 文档（提交时间用旧行的 `created_at`），每版之后记下 frontiers，作为一个 `periodic` 历史点，时间用旧行的时间（毫秒）；最后一版是当前正文，导入完再打一个 `import` 历史点。预览为空的行跳过并计数（交接会补上预览，五份库里没有）。`--verify-history` 时每一版都在脱离的副本上检出，和当时的预览逐段比对。旧行的 `meta_json`（当时的标题等）没有回放进书目文档，见「待协调」10。

## 资源文件

旧路径 `<旧库根>/assets/<书>/<资源>/source.*`（路径段用 dr-store 同一套 0.1 规则清理），读出来核对 `project_asset.source_sha256` 和大小，对上才经 `Library::import_asset`（导入标记、原子写入、落盘）复制。找不到、对不上的不导，计数进回执和摘要。`display`、`thumbnail` 不搬：等 dr-store 的图片管线做好由它重建（F2 已留接口）。

## 写作日和设备

写作日的设备键原样搬。新版这台设备的安装身份（dr-store 的 `Device`，同名文件 `sync-installation-v2.json`）如果还没有，就采用旧库根里那份（同一格式，权限 0600），这样升级后在同一台电脑上接着写，写作日还记在同一个设备键下。已经有了就不动，回执里记一笔。

## 帮手对话、本机状态和回执

`<新库>/import-v1/receipt.sqlite`：

| 表 | 内容 |
| --- | --- |
| `import_run` | 每次导入一行：导入器版本、起止时间、旧库指纹和大小、导入前的迁移级别、闸门、作者勾了什么 |
| `import_book` | 每本书：状态、各表行数、规整计数、正文数、历史点、资源文件、待办换 id 的数量 |
| `import_doc` | 每篇正文：新旧文档 id、新鲜度、旧版本号、缓存的 SHA-256（多设备核对要用）、历史版本数、存得是否一致、往返是否一致、规整计数、去掉的行内对象 |
| `import_anchor` | 每个锚点：怎么找到的、是否成了光标 |
| `import_original` | 按纯文字导入的批注、补丁、素材描述的原 JSON |
| `archive_agent_*` | 旧帮手对话的 7 张表，原样只读：对话、运行会话、轮次、消息、工具调用、工具结果（作者已定：能看能搜，不能接着聊） |
| `local_*`、`local_setting` | 本机状态原样：MCP 扩展配置、工作记忆、`library_state`（内置样书标记、交接清单）、Markdown 文件夹台账；交接导出的 WebView 设置 |

Agent 的结算记录、读取回执、检查点、事件流、长任务状态留在旧库（作者已定）。`summary.md` 是给作者看的中文摘要（书名、导入了多少、哪几篇无法证明、哪些地方和旧版不完全一样），以后由界面按作者的语言显示。

## 旧版交接补上的按书数据

`src/renderer/services/v2-handoff/books.ts`（测试 `books.test.ts`，集成测试加了一例），清单格式见 [docs/v2-handoff.md](../../v2-handoff.md)：

```json
"books": { "<书 id>": { "wordTarget": 80000, "dailyWordTarget": 0,
  "relationTypeColors": { "<关系类型 id>": "#aabbcc" },
  "elementPins": { "<要素 id>": [12.5, -40] } } }
```

- 字数目标和每日目标从 `writing-stats-storage` 按 store 自己的迁移读（以前完全没导出）；关系类型颜色只认 v2 格式（和 `useEdgeKindMeta` 一样）；固定位置只取 `pins`，不取模拟算出来的位置和视图模式（那些是本机布局）。
- 只写这个库 `project` 表里的书（WebView 存储是全应用共用的，账号库也共用）；读不到存储时沿用上一次的。
- 还在 `version: 1` 里，是加出来的一节；没有这一节的旧清单，导入器从原始设置里读颜色和固定位置（`handoff::books_from_settings`）。

## 测试数据（可重复的生成步骤）

全是合成数据，生成在会话的临时目录，不进仓库；**不读也不拷作者的真实库**。阶段 7 冻结测试库时，照下面再跑一遍，把五份库作为发布附件、在测试里钉住 SHA-256。

```bash
# 在 worktree 根目录。合成库（无窗口）：
./node_modules/.bin/tsx --conditions=import src/dev-cli/seed-main.ts --db <dir>/lite/drifting-library.db --preset lite --app-local-data <dir>/lite/app-local-data
./node_modules/.bin/tsx --conditions=import src/dev-cli/seed-main.ts --db <dir>/stress/drifting-library.db --preset stress --app-local-data <dir>/stress/app-local-data
# 样书、「用旧」、「交接过」，以及五份库的 Yjs 真值和清单：
DRIFTING_M10_FIXTURE_DIR=<dir> ./node_modules/.bin/vitest run src/renderer/services/v2-handoff/m10-fixtures.test.ts
```

`m10-fixtures.test.ts` 不设环境变量时跳过。它写出 `sample`（两本内置样书，和首次启动一样，插图带真实字节）、`sample-stale`（在 7 篇正文的 Yjs 里追加字不誊缓存，两篇各 3 行快照历史，没有交接）、`sample-handoff`（再放进按书设置、跑一次真实的交接），每份库一个 `truth/<名字>.jsonl`（每篇正文的 Yjs 渲染、每行快照历史从 `state_blob` 的渲染）和 `manifest.json`。书和库的 id 每次生成都不同，以清单为准。

```bash
cd next
cargo run --release -p dr-import-v1 --bin m10-import -- measure <dir> --out ../docs/rust-rewrite/acceptance/m10-import.json
```

`measure` 对清单里每份库在子进程里导入一遍（峰值内存按库算），先不勾「仍然导入」，被拦了再勾着导一遍，然后和真值核对。

## 测试与证据

在 `next/` 下：

```bash
cargo test -p dr-import-v1 --locked
cargo clippy -p dr-import-v1 --all-targets --locked -- -D warnings
```

| 测试 | 内容 |
| --- | --- |
| 单元测试（37） | 迁移的前缀规则和补齐、登记表规则、暂存副本不动原库、时间解析、交接清单（含旧格式退回原始设置）、闸门、编辑器 JSON 的解析和映射、写入后读回和多版本检出、往返、锚点（UTF-16、硬换行、容器块、找回和退回）、键值顺序、树的孤儿和环、100 张表和已发布迁移建出的表完全一致 |
| `tests/import.rs`（5） | 用已发布迁移和纯 SQL 建一个合成 0.1 库（不需要 Node、不需要 Yjs），整本导入真实的 dr-store 再用 dr-doc 读回：每个集合的字段、锚点解析出的原文、待办换 id 和关系跟着换、历史点的时间和检出、资源文件字节、安装身份、回执和存档；没交接时闸门拦住、勾了才导；同一本书不导第二次；两次导入写出的字节完全一样；旧迁移级别的库在副本上补齐、原库不变 |
| `tests/evidence.rs` | 已提交的测量证据仍然成立（每份库：存得一致、往返一致、锚点全是光标、判为最新的和真值一致、历史点对得上、被拦的几篇确实落后）；源码变了只提示「过期」，不判失败（[simplifications.md 第五节](../simplifications.md#五更轻的验收证据新工作区适用)） |

旧客户端：`./node_modules/.bin/vitest run src/renderer/services/v2-handoff src/renderer/lib/persistence-lifecycle.test.ts`、`pnpm typecheck`。

## 里程碑状态

| # | 里程碑 1 的内容 | 状态 |
| --- | --- | --- |
| 1 | 打开旧库：暂存副本、原库只读、补齐迁移、按登记表找出本机库和账号库 | 完成 |
| 2 | 读交接清单：逐篇核对版本和哈希；没交接默认拦住、列出无法证明的几篇、「仍然导入」、下载方式（文案键占位） | 完成 |
| 3 | 写新库：书目文档、正文文档（块 ID、人物链接、行内标记、批注锚点换光标加 `quote` / `snapshots` / `region`、位置键、退役取值、生成待办的确定 id）、存进 dr-store（来源 `import`）、快照历史回放成版本和历史点、资源文件、写作日设备键、帮手对话只读存档 | 完成；提交信息 `import` 缺 dr-model 的一行（待协调 1），历史点用直接写表（待协调 2） |
| 4 | 导入回执：写进新库旁的回执库和给作者的摘要 | 完成（位置见待协调 3） |
| 5 | 测试数据：样书、合成库、交接过的、没交接的；生成步骤写成可重复的说明 | 完成 |
| 6 | 测量与核对：零差错、锚点全成光标、历史点对得上、耗时和内存 | 完成 |
| — | 旧版交接补上按书数据（字数目标、关系颜色、固定位置） | 完成 |

## 待协调

1. **F1（dr-model）：导入的提交没有提交信息。** loro-schema.md 和 F2 都写「Agent、Markdown 文件夹、导入的提交带提交信息」，dr-store 的 `Origin::commit_message` 也给 `import` 写了；但 dr-doc 提交时用的是 `dr_model::Origin::commit_message`，它只给 Agent 写。M10 只能经 dr-doc 写（拿不到裸 `LoroDoc`），所以导入的变更现在没有 `import` 提交信息。改法是 dr-model 一行：`matches!(self, Agent { .. } | Import | Mirror)`；改了以后 M10 不用动。在那之前，导入的变更靠对等方认得出来：每篇文档的导入对等方是 `peer::import_peer(文档 id)`，确定的、最低位是 1。
2. **F2（dr-store）：没有「在某个版本、某个时间打历史点」的接口。** `DocHandle::label` 只能给当前版本、按现在的时间打。M10 等库关好后用 dr-store 自己的那句 `INSERT INTO history_label …`（同样从 `loro_head` 取书目文档的 frontiers）直接写进去（`run::write_labels`），这是本 crate 里注明的最小适配。请 F2 加 `Library::label_at(doc_id, &frontiers, label, ts_ms)`，M10 换过去。另外：历史点 30 天以前的会被修剪（照旧版），作者几个月后才导入的话，导入的历史点在这篇下一次打点时就被删掉（版本本身还在 Loro 历史里）；`import` 这个历史点要不要豁免，由 M09 定。
3. **F2：导入自己的表放在新库旁边的 `import-v1/receipt.sqlite`。** dr-store 的基线没有回执、帮手对话存档、本机状态这些表，迁移又归 F2。表结构在 `receipt.rs`；F2 准备好 `0001_*.sql` 时可以原样搬进 dr-store，同时把 `archive_agent_*` 交给 M31、`local_agent_mcp_server` 交给 M32、`local_agent_working_memory` 交给 M30、`local_markdown_mirror_file` 交给 M40、`local_setting` 交给 F6 的设置注册表。
4. **F2：安装身份。** 新设备目录里还没有 `sync-installation-v2.json` 时，M10 把旧库根里那份（同一格式）写过去，写作日因此还记在同一个设备键下。身份文件归 F2：如果 F2 要自己管这一步，给一个 `Device::adopt(id)`，M10 换过去。
5. **F1：批注、补丁的正文和素材描述是纯文字**（F1 待协调 4）。有格式的计数并把原 JSON 存进回执；五份库里都没有。F1 加了富文本以后，可以从 `import_original` 补回来。
6. **F1：容器块 ID 没有地方放。** 引用块、列表项、任务项的块 ID 在 D3 里不是段落 ID。M10 把所有引用改指容器的第一段 / 最后一段，容器第一段没 ID 时拿容器的。P0-E 设想过「容器路径」，F1 没有采用；有了这条改指规则，目前不需要。
7. **F1：新版不认识的行内对象存不下**（`insert_text` 拒绝 U+FFFC，也没有 P0-E 设想的 `inline` 标记）。M10 从正文里去掉它，JSON 原样进回执；五份库和旧编辑配置里都没有这种节点。
8. **M24：删掉的内置样书不能回来。** 旧版的样书标记在回执的 `local_library_state` 里，M24 做首次体验时要读它。
9. **M36：一个账号只能由一台设备导入。** 导入对等方是确定的：同一个旧库在两台设备各导一次，字节相同、合并后不重复（测试证明）；但如果两台设备上的旧库内容不同（第一台导入之后，第二台又在旧版里写过），两边会在**同一批操作 ID 下写出不同的内容**，Loro 合并时把后来的当作已有、悄悄跳过，两边从此不一致。所以 P0-E 的规则（第一台导入并把回执随 v2 上传，之后的设备只拉 v2，自己多出来的改动逐篇提示作者、作为普通编辑合进去）在 M36 里是必须的，不是可选的。同一台设备上，M10 已经拒绝把同一本书导第二次。
10. **M09：快照历史的元数据没有回放。** 旧行的 `meta_json`（当时的标题、梗概等）现在只在旧库里；新版按对象恢复要从书目文档的历史版本读字段，而导入的书目文档只有一个版本，所以恢复一个导入的历史点只恢复正文。要的话下一个里程碑把各行的元数据按时间回放进书目文档（一本书多几次小提交）。
11. **F6：界面。** 入口、进度和闸门对话框都等 F6；`run::analyse` 可以先只看闸门不写任何东西，`run::import` 返回 `Outcome::Blocked(Gate)` 或回执。旧版应用数据目录用 F7 的 `AppDirs::for_identity(Identity::RELEASE).data`，交给 `locate::discover`。进度回调还没有（整本重型库 4 秒多，界面至少要能显示「正在导入第几本书」）。
12. **F1 / F3：派生索引。** 导入的文档还没有搜索、大纲、字数索引：派生器（`Deriver`）还没人实现，实现后 dr-store 打开库时会把落后的文档重建一遍。

## 没做的，和下一个里程碑建议

- **没做**：导入界面（F6）、同步（M36）、Markdown 文件夹（M40）——都按计划不在这一轮。整库备份 `.drifting`（ZIP：SQLite 加资源文件，读的部分来自 `library_backup.rs`）和旧的 `.driftingbook` v1（只有 Yjs 状态，新版读不了，要先导入旧版再交接）没做。资源文件的 `display` / `thumbnail` 没搬。Windows 上「旧版是否开着」的判断（独占打开）只在 CI 能验。
- **下一个里程碑建议**：
  1. 接上 F1 的提交信息修正和 F2 的 `label_at`，删掉直接写表的适配；
  2. 进度回调和取消，给 F6 用；按账号库逐个导入的流程（和 M35 一起）；
  3. 导入 `.drifting` 整库备份（解压到暂存目录后走同一条路）；
  4. 快照历史的元数据回放进书目文档（待协调 10）；
  5. 阶段 7：用最后一个 0.1 标签重新生成五份测试库，作为 release 附件，测试里钉住 SHA-256，`measure` 改读附件。

## 代码位置

`next/crates/dr-import-v1/`：

| 文件 | 内容 |
| --- | --- |
| `build.rs`、`src/schema.rs` | 嵌入并钉住 19 个已发布迁移；Drizzle 前缀规则；在副本上补齐 |
| `src/locate.rs` | 旧版登记表的规则：本机库、账号库、数据库和安装身份的位置 |
| `src/staging.rs` | 暂存副本：是否被占用、逐字节复制、前后比对、回放 WAL、检查、补齐 |
| `src/legacy.rs` | 读副本：书和各表的行、正文缓存和新鲜度、快照历史、同步阻断项 |
| `src/handoff.rs` | 交接清单：每篇的版本和哈希、原始设置、按书数据（含旧格式的退回） |
| `src/gate.rs` | 闸门、作者的选择、文案键 |
| `src/prose/` | `pm.rs` 解析（P0-E）、`plan.rs` 映射到 v2 段落、`write.rs` 写入、`read.rs` 读回、`export.rs` 导回旧 JSON |
| `src/anchors.rs` | `anchor_json` v1–v4、区域、UTF-16 偏移、按旧版规则找回 |
| `src/book.rs` | 结构化表 → 书目文档 |
| `src/run.rs` | 整个流程、写进 dr-store、资源文件、历史点 |
| `src/receipt.rs` | 回执库、帮手对话存档、本机状态、给作者的摘要 |
| `src/tables.rs` | 100 张表的去向，和已发布迁移建出的表比对 |
| `src/bin/m10-import.rs` | 开发工具：`discover`、`analyse`、`import`、`check`、`measure`、`mapping-md` |
| `tests/` | 合成 0.1 库的整本导入、证据检查 |

## 附：100 张旧表的去向

由 `cargo run -p dr-import-v1 --bin m10-import -- mapping-md` 从 `tables.rs` 生成；测试保证它和已发布迁移建出来的表完全一致，多一张少一张都会失败。去向：`book-doc` 书目文档，`prose-doc` 正文文档，`prose-evidence` 只用来判断缓存新鲜度，`assets` 资源文件，`history` 快照历史，`local` 本机状态（这一轮在回执库里），`agent-archive` 帮手对话只读存档，`rebuild` 导入后重建，`drop` 不导入（旧机制，或留在旧库里的记录）。

| 旧表 | 去向 | 落到哪里 / 为什么 |
| --- | --- | --- |
| `agent_chat_binding` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_branch` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_cursor` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_delivery` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_object` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_queue` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_conversation` | agent-archive | 帮手对话的标题，只读搬过去 |
| `agent_mcp_server` | local | MCP 扩展配置；secret_* 只是钥匙串引用 |
| `agent_memory` | book-doc | 书目文档：Project Memory |
| `agent_permission_grant` | drop | 授权绑定旧工具版本，作者在新版重新授权 |
| `agent_runtime_checkpoint` | drop | 模型上下文检查点，可由消息重建，留在旧库 |
| `agent_runtime_element_patch_receipt` | drop | 结算记录（含 Yjs 状态向量），留在旧库 |
| `agent_runtime_entity_write_receipt` | drop | 结算记录，留在旧库 |
| `agent_runtime_event` | drop | 运行事件流，留在旧库 |
| `agent_runtime_message` | agent-archive | 对话消息，只读搬过去 |
| `agent_runtime_read_observation` | drop | 读取回执（含 Yjs 状态向量），留在旧库 |
| `agent_runtime_read_receipt` | drop | 读取回执，留在旧库 |
| `agent_runtime_result_artifact` | agent-archive | 工具结果，随对话只读搬过去 |
| `agent_runtime_result_blob` | agent-archive | 工具结果，随对话只读搬过去 |
| `agent_runtime_session` | agent-archive | 对话的运行会话，只读搬过去 |
| `agent_runtime_task` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_chapter_manifest` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_command` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_constraint` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_step` | drop | 长任务状态，留在旧库 |
| `agent_runtime_tool_call` | agent-archive | 工具调用，随对话只读搬过去 |
| `agent_runtime_turn` | agent-archive | 对话轮次，只读搬过去 |
| `agent_runtime_write_effect` | drop | 结算记录，留在旧库 |
| `agent_runtime_write_expectation` | drop | 结算记录，留在旧库 |
| `agent_runtime_write_review` | drop | 结算记录，留在旧库 |
| `agent_runtime_write_review_block` | drop | 结算记录，留在旧库 |
| `agent_working_memory` | local | 每本书的工作记忆文本 |
| `block_section` | drop | 已退役 Copilot 的滚动摘要 |
| `book_act` | book-doc | 书目文档：幕，书序上的分界 |
| `book_node` | book-doc | 书目文档：章节和构想；书序、叙事序是实数坐标，原样搬 |
| `comment` | book-doc | 书目文档：批注和待办；锚点变成一对光标 |
| `comment_action` | book-doc | 书目文档：只留「开 Agent 任务」，成为待办的 agent_conversation；Copilot 的采纳与拒绝不导 |
| `drift_group` | book-doc | 书目文档：构想分组树 |
| `element` | book-doc | 书目文档：要素；content_json 成为正文文档 |
| `element_category` | book-doc | 书目文档：分类；content_json 成为正文文档 |
| `element_patch` | book-doc | 书目文档：补丁；text_anchor_json 变成一对光标 |
| `entity_kv_entry` | book-doc | 书目文档：事实和字段模板，挂在所属对象下 |
| `entity_relation` | book-doc | 书目文档：关系 |
| `entity_relation_type` | book-doc | 书目文档：关系类型 |
| `entity_relation_type_endpoint_kind` | book-doc | 书目文档：端点种类，并入所属关系类型 |
| `entity_snapshot_history` | history | 快照历史：按渲染好的预览回放成可检出的版本和历史点 |
| `inline_mention` | rebuild | 引用索引，按人物链接标记重建 |
| `library_item` | book-doc | 书目文档：素材；笔记正文成为正文文档 |
| `library_state` | local | 库级标记：内置样书标记、交接清单 |
| `markdown_mirror_file` | local | Markdown 文件夹绑定；file_sha256 分辨文件是否被外部改过 |
| `material_folder` | book-doc | 书目文档：素材夹树 |
| `node_content` | prose-doc | 正文文档：章节和构想正文；大纲、情节规划 JSON 是投影 |
| `node_storyline_link` | book-doc | 书目文档：故事线成员和主故事线 |
| `plot_grid_cell` | book-doc | 书目文档：情节规划格子 |
| `plot_grid_column` | book-doc | 书目文档：情节规划列 |
| `plot_grid_document` | book-doc | 书目文档：每章一张情节规划 |
| `plot_grid_row` | book-doc | 书目文档：情节规划行 |
| `project` | book-doc | 书目文档：书本身（书名、简介、最近删除） |
| `project_asset` | assets | 书目文档的资源记录；source.* 按 SHA-256 校验后经 dr-store 复制 |
| `storylines` | book-doc | 书目文档：故事线；content_json 成为正文文档 |
| `sync_app_authority` | drop | 同步 v1 引擎 |
| `sync_apply_receipt` | drop | 同步 v1 引擎 |
| `sync_blob_state` | drop | 同步 v1 引擎 |
| `sync_change_set` | drop | 同步 v1 引擎 |
| `sync_checkpoint` | drop | 同步 v1 引擎 |
| `sync_conflict` | drop | 同步 v1 引擎；有未解决冲突时导入前报告 |
| `sync_connect_attempt` | drop | 同步 v1 引擎 |
| `sync_connect_generation_attempt` | drop | 同步 v1 引擎 |
| `sync_cursor` | drop | 同步 v1 引擎 |
| `sync_entity_lifecycle` | drop | 同步 v1 引擎 |
| `sync_field_clock` | drop | 同步 v1 引擎 |
| `sync_frontier` | drop | 同步 v1 引擎 |
| `sync_frontier_gap` | drop | 同步 v1 引擎；有缺口时导入前报告 |
| `sync_generation` | drop | 同步 v1 引擎 |
| `sync_generation_purge` | drop | 同步 v1 引擎 |
| `sync_generation_writer_state` | drop | 同步 v1 引擎 |
| `sync_journal_truncation` | drop | 同步 v1 引擎 |
| `sync_local_object` | drop | 同步 v1 引擎 |
| `sync_mutation` | drop | 同步 v1 引擎 |
| `sync_order_register` | drop | 同步 v1 的排序键；派生的排序列给出同样的顺序 |
| `sync_provider_account` | drop | 同步 v1 引擎；账号归属由库文件本身决定 |
| `sync_provider_binding` | drop | 同步 v1 引擎 |
| `sync_quarantined_object` | drop | 同步 v1 引擎；有隔离对象时导入前报告 |
| `sync_reducer_base` | drop | 同步 v1 引擎 |
| `sync_reducer_snapshot` | drop | 同步 v1 引擎 |
| `sync_remote_object` | drop | 同步 v1 引擎 |
| `sync_restore_attempt` | drop | 同步 v1 引擎 |
| `sync_segment` | drop | 同步 v1 引擎 |
| `sync_set_tag` | drop | 同步 v1 的 OR-set 标签；aliases_json 已有成员 |
| `sync_transfer` | drop | 同步 v1 引擎 |
| `sync_yjs_materialization_receipt` | drop | 同步 v1 引擎 |
| `timeline_marker` | book-doc | 书目文档：时间钉 |
| `workspace_projection_change` | drop | 界面失效提示 |
| `workspace_projection_clock` | drop | 界面失效提示 |
| `writing_day` | book-doc | 书目文档：写作日，按（设备，日期） |
| `yjs_document_revision` | prose-evidence | 每篇的版本号：判断缓存是否最新 |
| `yjs_document_revision_provenance` | drop | 每个版本由谁写的本机审计 |
| `yjs_prose_command_receipt` | drop | Agent 幂等回执 |
| `yjs_snapshots` | prose-evidence | Yjs 状态：说明文档存在、被压缩过 |
| `yjs_updates` | prose-evidence | Yjs 更新：说明文档存在、改过几次 |
