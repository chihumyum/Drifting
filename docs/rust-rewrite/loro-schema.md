# Loro 文档结构 v2

2026-11-07 由 P0-C 探针定下 v0，同日 F1 实现时改成 v1，再按监管会话的数据层审查改成 v2（改了什么、为什么见「版本」一节的「v0 → v1」「v1 → v2」）。以后任何改动都要升版本号，并在这里写明从哪一版改成哪一版、旧文档怎么读。

- 正式实现：`next/crates/dr-doc/`（类型化的书目文档和正文文档）和 `next/crates/dr-model/`（领域类型、不变量清单），说明见 [foundations/f1-model-doc.md](foundations/f1-model-doc.md)。
- 探针的实现和测试：`next/spikes/loro-model/`（包名 `loro-model-spike`），只读保留。
- 测量和结论：[spikes/p0-c-loro.md](spikes/p0-c-loro.md)。
- Loro 精确钉在 `=1.17.1`。

## 一句话

每本书一个**书目文档**，存书里所有对象的元数据；每篇正文一个**正文文档**，存一段扁平的富文本。两类文档都从一份所有设备算得一模一样的「创世」变更开始，每台设备对每个文档用自己固定的对等方 ID 写入。

## 总则

### 两类文档和它们的 id

| 文档 | 文档 id | 一本书里有几个 |
| --- | --- | --- |
| 书目文档 | `book:<书 id>` | 1 |
| 章节和构想的正文 | `node:<节点 id>` | 每章、每个构想各 1 |
| 要素正文 | `element:<要素 id>` | 每个要素 1 |
| 故事线说明 | `storyline:<故事线 id>` | 每条故事线 1 |
| 分类说明 | `category:<分类 id>` | 每个分类 1 |
| 素材笔记 | `material:<素材 id>` | 每篇文本素材 1 |

- 实体 id 沿用旧数据的 uuidv7。旧库导入后 id 不变。
- 正文文档有两种编辑配置：`material:` 用「笔记」配置，其余用「正文」配置（和旧版 `editor-schema-profile.ts` 一样，配置跟着文档走，不跟着视图走）。

### 版本号

- 每个文档的 `meta` 映射里有 `v`，现在是 `1`。
- 下文的样式表（每个标记键的 `ExpandType`）也是结构的一部分，规则见下面「样式表」一节。

### 样式表：只有一个来源

**唯一来源是 `dr_doc::schema::STYLE_TABLE` 加 `dr_doc::schema::DEFAULT_EXPAND`**（键和规则就是下文段落属性、行内标记两张表的 ExpandType 列；新版本加的、这张表里没有的键一律 `None`）。`dr_doc::schema::configure(doc)` 照它配置一份文档。别的地方（`gpui-prose`）要么调这个函数，要么用一模一样的表；`dr-editor` 用 `dr_doc::schema::style_table_mismatches(另一张表, 另一个默认值)` 逐键对拍，不一样就把差在哪列出来。`dr-doc` 不依赖 `gpui-prose`。

为什么必须只有一张表（都测过，`dr-doc` 的 `schema` 测试）：

- Loro 不把样式表存进文档，每个 `LoroDoc` 在运行时配置；`config_text_style` 会**整张替换**原来的表（默认值另外由 `config_default_text_style` 设，不受影响），所以两处各配一次，后配的说了算。
- 更要紧的是：**打标记的那一刻，Loro 把这个键的规则抄进标记本身**，之后每台设备在这个标记旁边打字，都照标记自己带的规则走，跟打字那台设备配的什么表无关。所以一台设备用错了表，它打出来的标记就带着错的规则进了书，同步到哪儿错到哪儿，换设备也改不回来。
- 「`ExpandType` 只管本机插入」说的是另一回事：远端并发插进来的字，按 Loro 的合并规则落位，不按扩展规则（见「读取规则」第一条）。

### 创世变更

每个文档的第一份变更是确定的：

- 写入者是一个专用的「创世对等方」，ID 由文档 id 和创世版本号算出（FNV-1a 64 位，最高位置 1；见 `ids::genesis_peer`）；
- 时间戳为 0，不带提交信息；
- 正文文档的创世内容：`meta.v = 2`、`meta.doc = <文档 id>`，`body` 里一个 `\n`，它的块 ID 是 `0@<创世对等方>`；
- 书目文档的创世内容：`meta.v = 2`、`meta.book = <书 id>`，以及内置的锁定关系类型（见「书目文档」）；
- 创世版本号现在是 `2`（v0 是 `0`，v1 是 `1`）。

**为什么**：任何一台设备都可以独立生成同一份创世变更，字节完全相同。Loro 按操作 ID 去重，所以两台设备同时初始化同一篇空正文，合并后仍然只有一个空段落，不会多出一段；内置关系类型也只会有一个。

**规则**：

- 创世对等方只写创世变更，别的什么都不写。
- 创世内容将来要改，就升创世版本号。版本号参与算对等方 ID，所以新旧两版的创世变更 ID 不同，最坏只是多一个空段落，不会出现「同一个 ID、两份不同内容」。

### 对等方 ID

- 每个（设备，文档）一个对等方 ID，随机生成，存在本机 SQLite 的 `loro_peer` 表，以后每次打开这个文档都用它。
- 前提是一个库只被一个进程打开（应用独占数据库）。
- 库有一个「换代号」（`library_meta.epoch`）。**从备份恢复、复制库、把库搬到另一台机器时，必须先换代**：换代以后每个文档在下次本机写入前都会拿到新的对等方 ID。原因是：如果副本沿用旧 ID，副本会在别处已经用过的操作 ID 下写出不同的内容，Loro 合并时会把它当成已有的变更跳过，两边从此悄悄不一致，而且查不出来。
- 每次本机提交，先追加进 SQLite，再发事件、再上传。这样进程崩溃时丢掉的只是从未离开本机的操作，重启后复用它们的计数器是安全的。
- **导入旧库用确定性的对等方**：每个文档的导入对等方由文档 id 算出（`seed::import_peer`），时间戳也是确定的。同一个旧库在两台设备上各导入一次，写出的变更字节相同，合并后不会出现两份正文。（探针已测：两次独立生成的种子逐字节相同，合并后内容不变。）

### 实体映射和删除

- 书目文档里每个实体是根映射下、以实体 id 为键的子映射，一律用 `ensure_mergeable_map(id)` 取或建。两台设备写同一个实体时会逐字段合并，不会一方的整个容器把另一方的藏掉。
- 实体的子容器（别名、成员、字段列表、批注正文……）也一律用 `ensure_mergeable_*`。
- 进废纸篓：写 `deleted_at`（秒）。彻底删除：删掉键。id 永不重用。

### 时间戳、来源和提交信息

- 每次载入后调用 `set_record_timestamp(true)`，提交时间按秒记。快照历史（`history_label`）靠它。
- 提交来源（origin）只在本机生效，不进 Loro 历史：本机备注在 SQLite `loro_update.origin`，取值 `user`、`agent:<会话>/<轮>`、`mirror`、`sync`、`import`、`genesis`、`repair`（`dr-doc` 自己写的确定性修复，比如导入后修重复的块 ID；v1 新增）。压缩会删这些行，所以它不是来源的正式记录。编辑器的撤销管理器排除 `user` 以外的全部来源。
- **Agent、Markdown 文件夹、导入的提交带提交信息** `agent:<会话>/<轮>`、`mirror`、`import`（F2 由文档持有者自动写上）；作者自己的提交不带。提交信息会存进 Loro 历史，并随快照和同步走（探针已测快照往返后仍在）。「谁改了什么」一律从 Loro 变更自带的对等方、时间和提交信息读。

## 正文文档

### 根容器

| 根容器 | 类型 | 内容 |
| --- | --- | --- |
| `body` | LoroText | 整篇正文 |
| `embeds` | LoroMap | 表格和素材嵌入的内容，键是嵌入 id |
| `meta` | LoroMap | `v`、`doc` |

### 段落

- `body` 是扁平文本，**每个段落以 `\n` 结尾**，段落属性是打在这个 `\n` 字符上的标记（Quill 式，决定 D3）。
- `body` **永远以创世写的那个 `\n` 结尾**：所有插入都发生在最后一个字符之前，任何命令都不删最后一个字符；撤销只会删除本对等方插入的内容，删不到创世对等方写的字符。
- 段内换行（Shift-Enter）是 U+2028，不是 `\n`。
- 位置一律按 Unicode 标量计（Loro 原生 Rust 的默认）；GPUI 的 UTF-8 字节、输入法的 UTF-16 用 `LoroText::convert_pos` 换算。

### 段落属性（标记在 `\n` 上，ExpandType 一律 `None`）

| 键 | 值 | 配置 | 说明 |
| --- | --- | --- | --- |
| `bid` | 字符串 | 都有 | 块 ID，每段必有 |
| `heading` | 1 / 2 / 3 | 都有 | H1 / H2 / H3；没有就是正文段落 |
| `quote` | true | 都有 | 引用；相邻的引用段画成一块 |
| `indent` | 1–8 | 都有 | 缩进；没有就是 0 |
| `align` | `center` / `right` | 都有 | 没有就是左对齐 |
| `rule` | true | 都有 | 分隔线段落（内容为空） |
| `list` | `bullet` / `ordered` / `task` | 笔记 | 列表项，一段一项 |
| `list_level` | 0 起 | 笔记 | 列表嵌套层级；没有就是 0 |
| `checked` | bool | 笔记 | 没链接待办的任务是否勾上。**链接了待办（有 `todo`）就不存、读时忽略**：显示待办自己的状态，待办是唯一的真相（v2） |
| `todo` | 待办 id | 笔记 | 任务项链接的待办 |
| `code_block` | 语言（可为空串） | 笔记 | 代码块；相邻的代码段画成一块 |
| `callout` | 种类 | 笔记 | 提示框；相邻同种的段画成一块 |

H1、H2、H3 三级同等对待，只叫 H1/H2/H3。

### 行内标记

| 键 | 值 | ExpandType | 配置 |
| --- | --- | --- | --- |
| `bold` `italic` `underline` `strike` | true | After | 都有 |
| `link` | 网址 | None | 都有 |
| `entity:<目标 id>` | `{kind, block?, end_block?}` | None（按前缀 `entity` 配置） | 都有 |
| `highlight` | 颜色 | None | 笔记 |
| `code` | true | None | 笔记 |
| `embed` | 嵌入 id | None | 都有（只打在 U+FFFC 上） |

### 写入规则

- **行内标记不打在 `\n` 上**：跨段的选区按段切开再打（`mark_inline`）。
- **新写一个 `\n` 时，把它的全部段落属性显式写成想要的值**，多余的清掉（`set_newline_attrs`）。原因见下面「读取规则」的第一条。
- **回车**：新 `\n` 永远插在光标处。块 ID 跟着文字走：
  - 在非空段落的末尾回车：新 `\n` 结束了刚写的那段文字，所以把原段落的块 ID 和全部属性挪到新 `\n` 上；原来那个 `\n` 现在结束新的空段，拿一个新块 ID，属性只继承引用、缩进、对齐、列表、提示框（标题不延续）。
  - 在段首回车（或在空段里回车）：上面多出来的空段拿新块 ID，原段落不动。
  - 在段中回车：前半段拿新块 ID，继承标题、引用、缩进、对齐、列表、代码块、提示框；后半段留着原来的 `\n` 和块 ID。
- **并段与跨段删除**：起点所在段落吸收终点所在段落剩下的文字，合起来的段落保留**起点段落**的块 ID 和全部属性（照 ProseMirror / Quill）。例外：删掉的正好是几个整段（从段首开始、到某个 `\n` 之后结束），后面那段原样不动。所以在一个空段下面的段首按退格，删掉的是空段，下面那段的标题和块 ID 都留着。
- **新块 ID**：用新插入的那个 `\n` 自己的操作 ID，写成 `"{counter}@{peer}"`。操作 ID 全局唯一，不需要随机数。导入的旧块 ID（uuidv7 字符串）原样保留。
- **粘贴**：粘进来的段落一律拿新块 ID。

### 读取规则（容错）

- **只认 `\n` 上的段落属性**，别的字符上的段落属性忽略。`ExpandType` 只管本机插入：一台设备给某段设标题、另一台同时在这段开头打字，合并后新打的字可能被这个段落标记盖住。属性测试里这种情况很常见，读的时候忽略它就不会显示错。
- `\n` 上的行内标记忽略。
- 末尾没有 `\n`（只会出现在坏数据里）时，把末尾那段当成一个没有块 ID 的段落。
- **块 ID 重复或缺失**：文档顺序里第一个保留，后面的在修复前当作没有 ID。修复（`repair_block_ids`）给它们写上自己那个 `\n` 的操作 ID；如果这个字符串已经被别的段落占用，就加 `/1`、`/2` 后缀。修复是确定的：两台设备对同一状态修复，写出的值相同。打开文档时、导入远端更新后各跑一次。重复只在两台设备同时在同一段末尾操作时出现：都按回车，或一边回车、一边把这段和下一段合并，两边各把同一个块 ID 挪到了不同的 `\n` 上。

### 人物链接

- 键是 `entity:<目标 id>`，一个目标一个键。值是映射：`kind`（`element`、`node`、`storyline`、`category`），链到章节里一段范围时再加 `block` 和 `end_block`（沿用旧版 `targetBlockId` / `targetEndBlockId`）。
- ExpandType `None`：在链接的前后打字不会扩进链接；在链接中间打字算链接的一部分。
- **重叠**：不同目标用不同的键，所以可以任意重叠，比如「安娜·卡列尼娜」链一个要素、其中「卡列尼娜」链另一个。指向同一目标的两段相邻链接会合成一段（旧版 ProseMirror 也这样）。
- 断开链接：`unmark(range, entity:<目标 id>)`。
- 旧版的键 `entityLink--<哈希>` 只在导入时读一次属性值，不进新结构。

### 表格和素材嵌入

- 正文里放一个 U+FFFC，单独成段；字符上打 `embed = <嵌入 id>`。
- 内容放在 `embeds[<嵌入 id>]`（mergeable 映射）：
  - 表格：`kind = "table"`；`cols` 是映射（列 id → `{pos}`），`rows` 是映射（行 id → `{pos, cells}`），`pos` 是分数索引位置键（v2，v1 是数字 `order`），`cells` 是映射（列 id → LoroText，单元格内只有行内标记，换行用 U+2028）。两台设备同时建同一个单元格会合成同一段文本。
  - 素材嵌入：`kind = "material"`，`material = <素材 id>`。
- 删掉占位字符时不删条目，这样撤销能把嵌入带回来；没有占位指向的条目在读取时忽略，后台清理时再删。
- 复制一个嵌入要深拷贝成新的嵌入 id。

## 书目文档

### 根容器

除了 `meta`、`facts`、`writing_days` 和两棵树，每个根容器都是「id → 实体映射」。

| 根容器 | 类型 | 每个实体的字段 | 旧表 |
| --- | --- | --- | --- |
| `meta` | 映射 | `v`、`book`、`name`、`summary`、`deleted_at`、`created_at`；`storyline_template`（键值列表）；`word_target`（全书字数目标）、`daily_word_target`（每日目标），没设过就用默认 120000 / 1500，0 表示关掉（v2；今天写了多少只从 `writing_days` 算，不另存） | `project`；目标在旧版只在本机 localStorage `writing-stats-storage` |
| `nodes` | 映射 | `kind`（`chapter` / `drift`）、`title`、`summary`、`book_order`、`narrative_order`、`status`、`group`、`x`、`y`、`storylines`（集合）、`primary_storyline`、`deleted_at`、`created_at`。**没有 `updated_at`**（v2 删掉：旧版每次正文投影都刷新它，照搬会让每阵打字都同步一次书目文档；「最近编辑」从本机索引取） | `book_node`、`node_storyline_link` |
| `acts` | 映射 | `name`、`color`、`start_order`（可为空）、`drift` | `book_act` |
| `storylines` | 映射 | `name`、`color`、`summary`、`pos`、`facts`（键值列表）、`chapter_template`、`deleted_at` | `storylines` |
| `categories` | 映射 | `name`、`color`、`layout`、`grid_x`、`grid_y`、`element_template`、`template_fields`（键值列表）、`deleted_at` | `element_category` |
| `elements` | 映射 | `name`、`summary`、`category`、`aliases`（集合）、`facts`（键值列表）、`group_name`、`portrait`、`pin_x` / `pin_y`（关系图里作者拖动固定的位置，v2）、`deleted_at`、`created_at` | `element`；固定位置在旧版只在本机 `super-element-view:relate:<书>` |
| `patches` | 映射 | `element`、`source_node`、`source_block`、`source_text`、`anchor`、`invalidated_at`、`title`、`body`（LoroText）、`pos` | `element_patch` |
| `relation_types` | 映射 | `name`、`normalized_name`、`description`、`orientation`、`system_key`、`locked`、`source_role`、`target_role`、`source_kinds`、`target_kinds`、`color`（关系线的颜色，v2） | `entity_relation_type*`；颜色在旧版只在本机 `drifting:edge-kind-meta:<书>` |
| `relations` | 映射 | `from_kind`、`from`、`to_kind`、`to`、`type`、`created_at` | `entity_relation` |
| `time_pins` | 映射 | `narrative_order`、`label`、`drift` | `timeline_marker` |
| `plot_grids` | 映射（键是章节 id） | `cell_w`、`cell_h`；`rows`、`cols`（id → `{pos, label}`，`pos` 是分数索引字符串）；`cells`（`"<行>/<列>"` → 文字） | `plot_grid_*` |
| `comments` | 映射 | `kind`（`note` / `todo`）、`target_kind`、`target`、`target_block`（v1）、`anchor`、`quote`（选中的原文）、`snapshots`（选区跨过的每段当时的全文：`[{block?, text}]`）、`region`（图片或 PDF 页上的矩形 `{page?, x, y, w, h}`，0–1）、`author_kind`（`user` / `ai` / `external`）、`author`、`author_name`、`body`（LoroText）、`status`（`open` / `resolved`）、`priority`、`source`（`manual` / `api`）、`metadata`、`agent_conversation`（从这条待办开的 Agent 对话）、`projection`（`marker` / `note_task`）和 `projection_block`（从正文生成的待办：哪种、哪一块）、`resolved_at`、`created_at`、`updated_at` | `comment`（`anchor_json` 里的 `selectedText`、`blockSnapshots`、`region`）、`comment_action` 里的 `start_agent_task` |
| `materials` | 映射 | `title`、`kind`（`image` / `pdf` / `text`）、`asset`、`folder`、`pos`、`task_todos`、`provenance`、`description`（LoroText，素材是讲什么的：Agent 写、搜索读，v2）。`preview_image` 删了（URL 素材退役后一直为空） | `library_item`（描述是 `notes_json`） |
| `assets` | 映射 | `kind`、`mime`、`size`、`sha256`、`width`、`height` | `project_asset`（字节在 SQLite / 文件里） |
| `drift_groups` | LoroTree | 节点 meta：`id`、`name`、`color` | `drift_group` |
| `material_folders` | LoroTree | 节点 meta：`id`、`name` | `material_folder` |
| `facts` | 映射 | 条目 id → `{key, value, pos}` | `entity_kv_entry`（项目设定） |
| `memory` | 映射 | `kind`、`body`、`target_kind`、`target`、`target_block`、`source`、`origin_ref`、`status`、`supersedes`、`deleted_at` | `agent_memory`（Project Memory） |
| `writing_days` | 映射 | 键 `"<设备>\|<日期>"` → 字数 | `writing_day` |

旧表 `block_section`（已退役 Copilot 的滚动摘要）不进 v2：导入时如果要保留，再加 `block_sections` 映射并升版本号。

### 顺序：真坐标用实数，纯列表用位置键

- **真坐标用实数**：`book_order`、`narrative_order` 是**带间隙的实数坐标**，和旧版一样（新章默认间隔 5，时间线上的块宽 4 个单位）。幕的 `start_order` 是书序轴上的分界，时间钉的 `narrative_order` 是叙事轴上的位置。只有章节有 `book_order`；章节和构想都可以有 `narrative_order`，没有就是还没放上叙事轴。排序时坐标相同按 id 排。浮点精度用尽时由「打散」命令统一重排，和旧版一样。
- **纯列表用位置键**（v2）：故事线、补丁、素材、键值列表、情节规划的行列、表格的行列，存的是分数索引字符串 `pos`，不是数字。格式是 Rocicorp `fractional-indexing` 4.0.0 的默认格式（`dr_model::pos` 照搬，逐字节兼容），导入时原样搬旧的 `position_key`。按字节比较，平局按 id，缺键或坏键的排最后。
  - **为什么**：数字要「打散重排」，两台设备各自重排一遍再逐字段合并，两套编号会交错，顺序就乱了。位置键挪一项只改这一项，谁也不打扰谁；两台设备往同一个空隙插，算出同一个键，按 id 定先后。旧版早就为这个改用分数索引，数字列只是投影（`src/renderer/sync/journal/order-authority.ts`）。
  - 构想分组、素材夹的兄弟顺序由 LoroTree 自己的分数索引管，不另存 `pos`。

### 集合和键值列表

- **集合**（别名、章节所属故事线）：一个 mergeable 映射，成员是键，值为 `true`。两边同时加同一个成员只算一个。
- **键值列表**（要素字段、故事线字段、分类模板字段、项目设定）：一个 mergeable 映射，条目 id → `{key, value, pos}`。按 `pos` 排，平局按条目 id。用带 id 的条目而不是列表，是为了同一个旧库在两台设备导入时不会出现两份条目。

### 树

- 构想分组和素材夹各是一棵 LoroTree（打开分数索引），节点 meta 里存领域 id、名称、颜色。引用分组或素材夹一律用领域 id，载入时建一个「领域 id → 树节点」的索引。
- LoroTree 自己保证不会出现环，旧版「不能把分组设为自己的父级」这条不变量由它承担，而且连两边同时互相移入形成环的情况也能处理。

### 锚点

- 批注、补丁（以及以后的引用和 Agent 命令位置）的位置存在实体的 `anchor` 字段：一个映射 `{start, end}`，两个都是 `Cursor::encode()` 的二进制。锚点指向哪篇正文由实体的 `target` / `source_node` 决定。
- 规则见下一节。

### 内置关系类型

id 是 `system:generic-association:<书 id>`，和旧版 `genericAssociationRelationTypeId` 一样，导入的旧关系不用换类型 id。在创世变更里建，字段照抄旧版 `genericAssociationRelationType`：

- `name = "Generic association"`、`normalized_name = "generic association"`、`description = "Built-in association for TODO and library item links."`；
- `orientation = directed`、`source_role = "Source"`、`target_role = "Target"`；
- `source_kinds = [comment, material]`、`target_kinds = [node, element, patch, category, storyline]`；
- `system_key = generic-association`、`locked = true`。

它不能改、不能删（`dr-doc` 的写入接口拒绝）。界面显示的名字按 `system_key` 本地化，不读 `name`。

### 从正文生成的待办

正文里的 `TODO:` 标记和素材笔记的任务行会生成待办。它们的 id 由（种类、文档 id、块 ID）算出：`todo:<marker|note_task>:<文档 id>#<块 ID>`（`CommentId::for_projection`）。两台设备各自生成也是同一个实体，不需要去重。「来自哪种、哪一块」是正式字段 `projection` / `projection_block`，不再塞在 `metadata` 里。

### 实体种类的取值

关系两端（`from_kind` / `to_kind`）、批注目标（`target_kind`）、Project Memory 目标、人物链接的 `kind` 用同一套字符串：`node`、`element`、`patch`、`category`、`storyline`、`comment`、`material`。旧版的 `library_item` 读作 `material`，导入时改写成 `material`（v1 写明；v0 没规定）。

## 锚点

- `start` 是第一个被锚字符上的光标（`Side::Left`），`end` 是最后一个被锚字符上的光标（`Side::Right`），活着的时候解析为「那个字符的位置 + 1」。所以在锚点前后打字不会扩进去，在中间打字算进去。
- 被锚的文字删掉一部分：锚点缩小到剩下的文字。全删掉：锚点收成删除处的一个点（`collapsed`），批注还在，界面显示「原文已删除」。
- **撤销不会把收起的锚点展开回来**：撤销重新插入的文字是新的操作 ID，旧光标找不回它们。编辑器要靠撤销项的元数据自己带回锚点（Loro 的 `UndoItemMeta` 可以附带光标），这件事归 F4。
- 被锚字符删掉以后，Loro 要回放历史才能找到位置（重型种子里每次 0.1–1 ms），并给回一个指向活字符的替换光标（再解析只要几微秒）。**替换光标存在本机缓存里，不回写书目文档**：读一次就产生一次同步写入不值得。

## 不变量

旧版靠 SQL 约束、触发器和同步内核（`production-domain-kernel.ts`）挡住的事，新版各有归属。下表是摘要；逐条对过旧版 70 条领域不变量和 126 个仍生效的触发器之后的完整清单（78 条，加 16 条写明不再需要的、9 条界面和 Agent 做法不一样待 F3 统一的）在 `dr_model::invariant`，生成的证据是 [acceptance/f1-invariants.json](acceptance/f1-invariants.json)：

| 不变量 | 新版靠什么 |
| --- | --- |
| 关系两端存在、在同一本书 | 命令层预防；读取时端点不在就不显示 |
| 关系类型存在 | 命令层预防；读取时不显示 |
| 关系不能连自己 | 命令层预防 |
| 对称关系两端按规范顺序 | 命令层预防 |
| 同一对端点同一类型只留一条（语义重复） | 读取时按 id 取最小的那条；后台修复删掉其余的 |
| 内置关系类型不能改、不能删 | `dr-doc` 的写入接口拒绝；创世保证它只有一个 |
| 要素的名字和别名在书里唯一（自动链接认人物的前提） | 命令层预防；合并后重名，读取时按创建时间、再按 id 取第一个，其余标出 |
| 纯列表的顺序 | 位置键：挪一项只改这一项，合并不会打乱 |
| 章节有书序，构想没有书序；章节不进构想分组 | 读取时以 `kind` 为准：章节缺书序排到最后，构想的书序忽略；后台修复 |
| 节点所在的构想分组、素材所在的素材夹存在 | 读取时不在就放到根目录（旧版也是这样） |
| 分组、素材夹不成环 | LoroTree 保证 |
| 主故事线必须是已加入的故事线 | 读取时主故事线不在成员里就当作没有 |
| 幕、时间钉绑定的构想存在 | 读取时不在就当作没绑定 |
| 批注目标要么全空，要么指向存在的对象 | 命令层预防；读取时目标不在就归到「未定位」 |
| 补丁有 `source_block` 就必须有 `source_node` | 命令层预防 |
| 要素字段的命名空间合法 | 结构上就不存在：每种字段列表有自己的位置 |
| 图片、PDF 素材有资源，资源不可变 | 命令层预防；资源字节按 sha256 存，元数据只追加 |
| 正文以 `\n` 结尾，块 ID 唯一 | 写入规则 + 读取容错 + 确定性修复 |
| 正文文档存在但书目里没有它的实体 | 读取时忽略（彻底删除和另一台设备的编辑并发时会出现）；后台清理 |

跨文档的写入没有原子提交。一个命令同时写书目文档和正文文档时，先写正文文档、再写书目文档；中途失败时留下的是「没有书目实体的正文文档」，由上表最后一行兜住。

## SQLite 存储（F2 的 Loro 部分）

DDL 以 `next/crates/dr-store/migrations/0000_baseline.sql` 为准（F2 实现，说明见 [foundations/f2-store.md](foundations/f2-store.md)）。和 Loro 直接相关的表：

```sql
library_meta (key, value)                                  -- library_id、epoch、installation_id、write_seq、app_version、created_ms
loro_doc (doc_id, kind, book_id, created_ms)               -- book_id：所属的书
loro_update (doc_id, seq, bytes, origin, ts)               -- PRIMARY KEY (doc_id, seq)
loro_snapshot (doc_id, upto_seq, vv, frontiers, bytes, ts)
loro_head (doc_id, seq, vv, frontiers, ts)                 -- 每篇最新落盘的状态，和每次追加同一个事务
loro_peer (doc_id, peer_id, epoch)
sync_doc (doc_id, remote_vv, updated_ms)                   -- 服务器已有到哪
```

- 时间一律 Unix 毫秒；表都是 `STRICT`；没有触发器、没有级联。
- WAL 模式，`synchronous=NORMAL`（进程崩溃不丢已提交的事务；断电可能丢最后几次，所以任何东西离开本机前先 `sync_to_disk`）。
- **写**：每次本机提交，导出自上次追加以来的更新，作为一行追加进 `loro_update`，同一个事务更新 `loro_head` 和 `library_meta.write_seq`；一次提交一个事务、一行一个来源。导入的远端更新也作为一行追加，`origin = sync`，并把数据包包含的版本并进 `sync_doc.remote_vv`。新文档的第一次追加包含创世变更（`origin = genesis`）。
- **压缩**：在**同一个事务**里写新快照（`upto_seq` = 当时最大的 `seq`）并删除 `seq <= upto_seq` 的更新。崩溃时要么是旧快照加全部更新，要么是新快照加更新的更新。上传从文档导出 `remote_vv` 之后的改动，和压缩无关。
- **载入**：先配置样式和时间戳，再在一个读事务里取快照加 `seq > upto_seq` 的更新，一次 `import_batch`（重叠的部分 Loro 会去重），最后设本机对等方。
- **换代**：库被拷到别的设备（`installation_id` 不同）、或被旧副本盖回（`write_seq` 低于设备在库外记的水位）时，打开时自动换代。
- **载入前先校验每份字节的校验和**（`LoroDoc::decode_import_blob_meta(bytes, true)`）：Loro 1.17.1 的 `import_batch` 解码时不校验，而它的解码器照字节里的长度申请内存，一份坏字节能让进程申请几十 GB 后被杀（F1 的模糊测试找到的）。单份的 `import` 自己会校验。`dr-doc` 的载入已经这样做，存储层不要绕过它直接导入。
- 不做浅快照裁剪（理由见 F2）。来源、活动、历史标签、Agent 结算都依赖完整历史。

## Agent 写入

- **就地写入**：Agent 的改动是打开的文档上的一次本机提交，origin 和提交信息都是 `agent:<会话>/<轮>`；编辑器的 `UndoManager` 用 `add_exclude_origin_prefix("agent:")` 排除它。作者撤销时不会撤掉 Agent 的字，Agent 的操作会像远端操作一样被合进撤销栈。
- 所有写入都排进文档持有者的队列，一次提交只含一个来源，作者的按键和 Agent 的操作不会落进同一次提交。
- 不用分叉副本写入：它慢约 100 倍，还会触发 Loro #1228（见下）。
- Agent 改动的撤销照旧走快照历史：`revert_to` 到改动前的版本。

## 撤销（给编辑器的约束）

- `UndoManager` 的合并间隔设为 **0**，不用 `group_start` / `group_end`。「一次撤销撤掉一阵连打」由编辑器自己做：用 `set_on_push` 给每个撤销项记时间，按一次撤销就连续弹出同一阵的几项。这样能避开 Loro #1228 和 #1245。
- Loro #1229 绕不开：作者设了某个键（标题级别、链接）之后，另一台设备或 Agent 又改了同一个键，作者再撤销，会把对方的值也抹掉。只影响格式，不丢字。等上游修。
- 详细的复现见结论文档。

## 版本

- 现在是 v2：`meta.v = 2`，创世版本 2，样式表如上；另外给未配置的标记键设了默认 `ExpandType::None`（新版本加的标记键在旧版本里本机插入时不扩展）。
- 改动分两类：
  - **向后兼容**（新增根容器、新增实体字段、新增标记键且旧版忽略它也不会写坏）：升小版本，在这里记一行；读取端遇到不认识的字段原样保留。
  - **不兼容**（改键名、改值的含义、改 `ExpandType`、改创世内容、改块 ID 规则）：升 `meta.v`，写清楚迁移办法。改 `ExpandType` 尤其要小心：规则在打标记时就写进了标记，改表只影响以后打的标记，书里已有的标记照旧，新旧两种规则会长期并存。
- Loro 自己的数据格式从 1.0 起不再有破坏性改动；新版 Loro 建的新类型容器，旧版会读成 `LoroUnknown`。

### v0 → v1（2026-11-07，F1）

实现 `dr-doc` 时对照旧版代码，发现 v0 有一处错、两处漏：

1. **内置关系类型错了**（不兼容，所以升 `meta.v`）。v0 写成对称的 `rt-generic:<书 id>`、名字「关联」。旧版其实是有向的 `system:generic-association:<项目 id>`，只允许从批注（TODO）或素材指向结构实体，专门用来把 TODO 和素材挂到章节、要素上。照 v0 做会有两个后果：对称类型要按规范顺序存两端，一条「TODO → 要素」的关系可能被存成「要素 → TODO」，指向了不该被指向的种类；旧库导入的关系指向旧 id，还得逐条改写。v1 照抄旧版的 id 和全部字段。
2. **批注漏了 `target_block`**（向后兼容）。旧版批注和 TODO 可以只挂在某一段上而不锚住文字（`target_block_id`）。v1 加回这个字段。
3. **实体种类的字符串没写**（向后兼容）。v1 写明用 `material`，旧的 `library_item` 读作 `material`。

另外两条不改结构的补充：来源多了 `repair`；载入前要先校验校验和（见「SQLite 存储」）。

**旧文档怎么读**：v0 的文档只在探针和测试里出现过，没有真实数据，所以不做迁移。万一读到 `meta.v = 0` 的书目文档，会多出一个 `rt-generic:<书 id>` 的关系类型，它是一个普通的、没锁定的类型，不影响读取。

### v1 → v2（2026-11-07，监管会话的数据层审查）

审查对照旧版代码，指出 v1 漏了作者在用的数据、有一处顺序设计会在合并时出错。改了这些：

1. **纯列表的顺序改用位置键**（不兼容）：故事线、补丁、素材、键值列表、表格行列的 `order`（数字）换成 `pos`（分数索引字符串），理由见「顺序」一节。真坐标（书序、叙事序、幕分界、时间钉）不变。
2. **补上旧版有、v1 漏了的数据**（向后兼容）：
   - 关系类型的颜色 `color`；写作目标 `meta.word_target` / `meta.daily_word_target`；关系图里固定的位置 `elements.pin_x` / `pin_y`。这三样旧版只存在本机 localStorage，换设备就丢；
   - 素材描述 `materials.description`；批注的原文 `quote` 和各段快照 `snapshots`（「查看原文」「原文已改」靠它们）；素材上的区域批注 `region`。
3. **待办只有一份真相**（不兼容）：链接了待办的任务行不存 `checked`；从正文生成的待办 id 由文档和块算出，来源是正式字段 `projection` / `projection_block`；`comment_action` 不再单列，唯一在用的「开 Agent 任务」改成待办上的 `agent_conversation`。
4. **删掉不该在书目文档里的**（不兼容）：`materials.preview_image`（迁移 0011 后一直为空）；`nodes.updated_at`（随打字高频变化，会让每阵打字都同步一次书目文档）。
5. **退役的取值不进新结构**：批注来源 `copilot`、作者种类 `copilot`、状态 `converted`、动作 `accept_suggestion` / `reject_suggestion`。导入时规整（`dr_model::legacy`）：`copilot` 来源 → `api`，`copilot` 作者 → `ai`，`converted` → `resolved`，采纳 / 拒绝的记录丢弃。
6. 写作日的设备键写明了：`device-` 加 SHA-256(`"drifting.writing-day.v1\n" + 安装身份`) 前 12 字节的十六进制，和旧版一样（`DeviceKey::from_installation_id`）；安装身份文件归 F2 管。

**旧文档怎么读**：v1 的文档也只在测试里出现过，不做迁移。v2 的读取端遇到 v1 的 `order` 数字会当作「没有位置键」排到最后，不报错。

## 不进书目文档的：本机布局

按书的视图状态，有的是作者的摆放，换设备也该在；有的只是这台设备上看的方式。逐项定下（拿不准的放本机）：

| 数据 | 放哪 | 理由 | 旧版存在 |
| --- | --- | --- | --- |
| 关系图里拖动固定的位置 | 书目文档 `elements.pin_x` / `pin_y` | 作者亲手摆的，和构想看板的 `x` / `y`、分类的网格位置一样同步 | localStorage `super-element-view:relate:<书>` 的 `pins` |
| 关系图模拟算出来的位置、签名 | 本机缓存 | 随时可以重算 | 同上的 `positions`、`signature` |
| 要素全景的视图模式（岛屿 / 关系） | 本机 | 看的方式，不是书的内容 | 同上的 `mode` |
| 要素全景的视口（平移、缩放、分组条吸顶、只画视口内的线） | 本机 | 和窗口大小、屏幕有关 | `DesktopSuperElementView` 的视口键 |
| 情节规划的格子宽高 | 书目文档 `plot_grids.cell_w` / `cell_h` | 旧版就同步 | `plot_grid_document` |
| 情节规划手调的格子比例 | 本机 | 旧版注释明说是「手所在那台设备」的偏好 | `plot-grid-cell-ratio:<章>` |
| 时间线、故事图的视图模式 | 本机 | 看的方式；旧版甚至不分书 | `timeline-view`、`graph-view-mode` |
| 时间线的滚动位置、展开比例 | 本机 | 同上 | `timeline-scroll-position`、`timeline-expanded-scale` |
| 各栏宽度（岛屿宽、素材栏宽） | 本机（界面设置） | 和窗口有关 | `super-element-view:island-width`、`super-memo-material:rail-widths` |

本机布局文件归 F2（存储）/ F6（外壳），按书 id 分开存，格式由它们定。

## 快照恢复是按对象的

旧版恢复一个对象的快照，会连带恢复它当时的标题、梗概、要素字段等元数据（`services/snapshot-restore.service.ts` 的 `restoreMetadata`）。新版的做法：

- 历史点同时记下正文文档和书目文档的 frontiers（F2 的 `history_label`）；
- 恢复时从 SQLite 另载一份书目文档副本，检出到那个 frontiers（`BookReader::load_at`），读出这个对象当时的字段（`BookView::entity_snapshot`），再在打开的文档上作为**新提交**写回（`BookTxn::restore_fields`，字段清单 `metadata_fields`）；
- 不整篇 revert 书目文档：书里别的对象不受影响。正文照旧在它自己的正文文档上恢复。

## 和 P0-B 的最小模型的关系

P0-B 编辑器探针用的是扁平 LoroText、段落以 `\n` 分隔、段落属性记在换行符上、只有 H1/H2/H3 和正文。它只用到了 v0 的 `body` 加 `bid`、`heading` 两个段落属性，完全落在 v0 里面。接进来时要照上面的写入规则改两处：回车一律在光标处插 `\n`（段末回车时挪块 ID）；撤销合并间隔设 0、由编辑器自己按阵合并。
