# Loro 文档结构 v2.2

2026-11-07 由 P0-C 探针定下 v0，同日 F1 实现时改成 v1，再按监管会话的数据层审查改成 v2；2026-11-08 F1 第五轮加了几样向后兼容的东西（正文模板文档、种子变更、待办的任务文字），记成 v2.1；同日 M27（帮手运行时）加了 Agent 对话文档，F1 第七轮审过，记成 v2.2（改了什么、为什么见「版本」一节）。以后任何改动都要升版本号，并在这里写明从哪一版改成哪一版、旧文档怎么读。

- 正式实现：`next/crates/dr-doc/`（类型化的书目文档、正文文档和对话文档）和 `next/crates/dr-model/`（领域类型、不变量清单），说明见 [foundations/f1-model-doc.md](foundations/f1-model-doc.md)。
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
| 正文模板（v2.1） | `template:category:<分类 id>`（要素模板）、`template:storyline:<故事线 id>`（章节模板） | 每个分类、每条故事线最多 1 |
| Agent 对话（v2.2） | `conversation:<对话 id>` | 每个对话 1；属于哪本书由存储的文档记录记着 |

- 实体 id 沿用旧数据的 uuidv7。旧库导入后 id 不变。
- 正文文档有两种编辑配置：`material:` 用「笔记」配置，其余用「正文」配置（和旧版 `editor-schema-profile.ts` 一样，配置跟着文档走，不跟着视图走）。模板用「正文」配置，和用它新建的章节、要素一样。
- **正文模板**是一篇普通的正文文档，结构、创世、写入规则和别的正文完全一样，只是 id 由主人算出（`TemplateOwner::doc_id`）：两台设备同时开始写同一个分类的模板，写的是同一篇，会合并。它不是书的正文：不进搜索、不计字数、不导出（`DocKind::is_book_text`）。新建要素、新建章节时把它整篇抄进新正文（`ProseTxn::insert_copy`：段落属性、行内标记、人物链接、表格、素材嵌入都抄，块 ID 和嵌入 id 换新的）。分类、故事线彻底删除以后，它的模板文档就没有主人了（`BookView::owns_prose` 按主人认），和别的没主人的正文一样清掉。
- **Agent 对话**不是正文：没有编辑配置，不进搜索、不计字数、不导出、不进 Markdown 文件夹、不投待办。它只追加，结构见「对话文档」。它直接属于书（像书目文档一样），不会被当成没主人的正文清掉。

### 版本号

- 每个文档的 `meta` 映射里有 `v`，现在是 `2`（见「版本」）。v2.1、v2.2 只加了向后兼容的东西，`meta.v` 和已有文档的创世都不变。
- 下文的样式表（每个标记键的 `ExpandType`）也是结构的一部分，规则见下面「样式表」一节。

### 样式表：只有一个来源

**唯一来源是 `dr_doc::schema::STYLE_TABLE` 加 `dr_doc::schema::DEFAULT_EXPAND`**（键和规则就是下文段落属性、行内标记两张表的 ExpandType 列；新版本加的、这张表里没有的键一律 `None`）。`dr_doc::schema::configure(doc)` 照它配置一份文档。

- **谁来配**：Drifting 里的文档只由 `dr-doc` 和 `dr-store` 配（存储打开文档时调 `configure`）。`dr-editor` 拿到的是已经配好的文档，不再调 `gpui_prose::schema::configure`。
- **`gpui-prose` 自带的表**只给它自己的 `LoroSource` 和对拍测试用，必须和这张一模一样（2026-11-07 逐键核对过：12 个段落属性 `None`，加粗、斜体、下划线、删除线 `After`，链接、高亮、行内代码、人物链接、嵌入 `None`）。
- **怎么对拍**：`dr-editor` 的测试调 `dr_doc::schema::style_config_mismatches(&gpui_prose::schema::style_config())`，不一样就列出差在哪个键。如果两边手里都是键列表，也可以用 `style_table_mismatches(另一张表, 另一个默认值)`，它还能查出多出来的键。谁改表，两边一起改、升结构版本。
- `dr-doc` 不依赖 `gpui-prose`。
- 默认值只有 `dr-doc` 设。`gpui-prose` 不设默认值时，没配置的键在本机根本打不上标记（Loro 报错），不会打出规则不一样的标记，所以不算分歧。

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
- 对话文档的创世内容：`meta.v = 2`、`meta.doc = <文档 id>`，没有别的（v2.2）；
- 创世版本号现在是 `2`（v0 是 `0`，v1 是 `1`）。

**为什么**：任何一台设备都可以独立生成同一份创世变更，字节完全相同。Loro 按操作 ID 去重，所以两台设备同时初始化同一篇空正文，合并后仍然只有一个空段落，不会多出一段；内置关系类型也只会有一个。

**规则**：

- 创世对等方只写创世变更，别的什么都不写。
- 创世内容将来要改，就升创世版本号。版本号参与算对等方 ID，所以新旧两版的创世变更 ID 不同，最坏只是多一个空段落，不会出现「同一个 ID、两份不同内容」。

### 种子变更（v2.1）

有些写入在每台设备上写出来都一样，而且常常是两台设备还没同步就各写了一遍：从正文 TODO 标记投出的待办、新情节规划表的三行三列。当成普通的本机改动写，合并会出三种错：

- 一段文字两边各插一遍，读出来两遍（「补一场雨补一场雨」）；
- 两边各给新行新列起一个随机 id，合起来六行六列；
- 映射的键按 Lamport 时间「后写的赢」，一台写得多的设备晚一点写的默认值，可能盖掉另一台设备上作者的改动（已解决的待办又打开了）。

**做法**：和创世一样，在一份空文档里写好、再导入（`dr_doc::book::seed`）：

- 写入者是「种子对等方」，ID 由（文档 id，种子的键）算出（FNV-1a 64 位，最高位和最低位都是 1，和创世对等方、设备对等方都不重叠；`peer::seed_peer`）；时间戳 0，没有提交信息；
- 同一个种子在两台设备上写出来逐字节相同，Loro 只留一份；
- 它前面没有任何历史，所以它的操作带着最小的 Lamport 时间：同一个键上任何一次真正的改动，不管在哪台设备、在它之前还是之后，都赢过它；
- 同一件事的两个不同种子（两台设备读到的任务文字不一样）是两个并发的最底层改动，Loro 在所有设备上挑同一个；会变的部分只是一个值，不会叠成两份。

**规则**：种子的键要写出它写的全部内容（一个键永远只对应一份内容，否则就是「同一个操作 ID、两份不同内容」）；要改种子写什么，就换键（升键里的版本后缀）。导入会先把这次写入前面做的改动提交掉（Loro 的导入屏障），所以写之前要先设好提交选项（`set_next_commit_options`），或者先写种子再写别的。

现在有两种：

| 种子 | 键 | 写什么 |
| --- | --- | --- |
| 投出的待办（`BookTxn::project_todo`） | `todo-v1`、待办 id、文档、块、任务文字 | `kind = todo`、目标、`target_block`、`projection` / `projection_block`、`status = open`、`projection_text` |
| 新情节规划表（`BookTxn::create_plot_grid`） | `plot-grid-v1`、章节 id、行列数 | 表本身，三行三列的 `pos`（id 见 `PlotRowId::default_for` / `PlotColId::default_for`：`<章节 id>:r1`…、`<章节 id>:c1`…）；不写标签、不写尺寸（没写就读成空标签、默认 184 × 96） |

### 对等方 ID

- 每个（设备，文档）一个对等方 ID，随机生成，存在本机 SQLite 的 `loro_peer` 表，以后每次打开这个文档都用它。
- 前提是一个库只被一个进程打开（应用独占数据库）。
- 库有一个「换代号」（`library_meta.epoch`）。**从备份恢复、复制库、把库搬到另一台机器时，必须先换代**：换代以后每个文档在下次本机写入前都会拿到新的对等方 ID。原因是：如果副本沿用旧 ID，副本会在别处已经用过的操作 ID 下写出不同的内容，Loro 合并时会把它当成已有的变更跳过，两边从此悄悄不一致，而且查不出来。
- 每次本机提交，先追加进 SQLite，再发事件、再上传。这样进程崩溃时丢掉的只是从未离开本机的操作，重启后复用它们的计数器是安全的。
- 种子变更用确定的「种子对等方」，见上一节。
- **导入旧库用确定性的对等方**：每个文档的导入对等方由文档 id 算出（`seed::import_peer`），时间戳也是确定的。同一个旧库在两台设备上各导入一次，写出的变更字节相同，合并后不会出现两份正文。（探针已测：两次独立生成的种子逐字节相同，合并后内容不变。）

### 实体映射和删除

- 书目文档里每个实体是根映射下、以实体 id 为键的子映射，一律用 `ensure_mergeable_map(id)` 取或建。两台设备写同一个实体时会逐字段合并，不会一方的整个容器把另一方的藏掉。
- 实体的子容器（别名、成员、字段列表、批注正文……）也一律用 `ensure_mergeable_*`。
- 进废纸篓：写 `deleted_at`（秒）。彻底删除：删掉键。id 永不重用。

### 时间戳、来源和提交信息

- 每次载入后调用 `set_record_timestamp(true)`，提交时间按秒记。快照历史（`history_label`）靠它。
- 提交来源（origin）只在本机生效，不进 Loro 历史：本机备注在 SQLite `loro_update.origin`，取值 `user`、`user:command`（作者的命令：命令面板、帮手代作者执行、对象级撤销；F2 的 `Origin::Command`）、`agent:<会话>/<轮>`、`mirror`、`sync`、`import`、`genesis`、`repair`（`dr-doc` 自己写的确定性修复，比如导入后修重复的块 ID；v1 新增）。压缩会删这些行，所以它不是来源的正式记录。编辑器的撤销管理器排除 `user` 以外的全部来源，`user:command` 也排除（`UNDO_EXCLUDED_ORIGIN_PREFIXES`，v2.1）：作者的命令由工作区的日志撤。种子变更是导入进来的，没有本机来源。
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
| `storylines` | 映射 | `name`、`color`、`summary`、`pos`、`facts`（键值列表）、`chapter_template`（旧版编辑器的 JSON，原样保留、只读；v2.1 起章节模板在 `template:storyline:<id>` 文档里）、`deleted_at` | `storylines` |
| `categories` | 映射 | `name`、`color`、`layout`、`grid_x`、`grid_y`、`element_template`（旧版 JSON，只读；v2.1 起要素模板在 `template:category:<id>` 文档里）、`template_fields`（键值列表）、`deleted_at` | `element_category` |
| `elements` | 映射 | `name`、`summary`、`category`、`aliases`（集合）、`facts`（键值列表）、`group_name`、`portrait`、`pin_x` / `pin_y`（关系图里作者拖动固定的位置，v2）、`deleted_at`、`created_at` | `element`；固定位置在旧版只在本机 `super-element-view:relate:<书>` |
| `patches` | 映射 | `element`、`source_node`、`source_block`、`source_text`、`anchor`、`invalidated_at`、`title`、`body`（LoroText）、`pos` | `element_patch` |
| `relation_types` | 映射 | `name`、`normalized_name`、`description`、`orientation`、`system_key`、`locked`、`source_role`、`target_role`、`source_kinds`、`target_kinds`、`color`（关系线的颜色，v2） | `entity_relation_type*`；颜色在旧版只在本机 `drifting:edge-kind-meta:<书>` |
| `relations` | 映射 | `from_kind`、`from`、`to_kind`、`to`、`type`、`created_at` | `entity_relation` |
| `time_pins` | 映射 | `narrative_order`、`label`、`drift` | `timeline_marker` |
| `plot_grids` | 映射（键是章节 id） | `cell_w`、`cell_h`；`rows`、`cols`（id → `{pos, label}`，`pos` 是分数索引字符串；新表的三行三列 id 确定、由种子变更写，见「种子变更」）；`cells`（`"<行>/<列>"` → 文字） | `plot_grid_*` |
| `comments` | 映射 | `kind`（`note` / `todo`）、`target_kind`、`target`、`target_block`（v1）、`anchor`、`quote`（选中的原文）、`snapshots`（选区跨过的每段当时的全文：`[{block?, text}]`）、`region`（图片或 PDF 页上的矩形 `{page?, x, y, w, h}`，0–1）、`author_kind`（`user` / `ai` / `external`）、`author`、`author_name`、`body`（LoroText）、`status`（`open` / `resolved`）、`priority`、`source`（`manual` / `api`）、`metadata`、`agent_conversation`（从这条待办开的 Agent 对话）、`projection`（`marker` / `note_task`）和 `projection_block`（从正文生成的待办：哪种、哪一块）、`projection_text`（投出时标记后面的任务文字；作者没改过正文时它就是正文，v2.1）、`resolved_at`、`created_at`、`updated_at` | `comment`（`anchor_json` 里的 `selectedText`、`blockSnapshots`、`region`）、`comment_action` 里的 `start_agent_task` |
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

v2.1 起，设备自己投出的待办写成种子变更（`BookTxn::project_todo`）：种类、目标、块、`status = open` 和任务文字 `projection_text`。**正文（`body`）不写**，没有 `body` 时读出来的正文就是 `projection_text`；作者改了正文才有 `body`（清空也算改过，读出来是空的）。这样两台设备投同一个标记只有一份正文，一边已解决、另一边晚到的投影也不会把它重新打开。标记删掉、待办删掉以后又打回来，再投时按普通写入写回，旧的正文、优先级、对话一并清掉。导入旧库（M10）照旧用 `projected_todo` 加普通写入，它自己的对等方本来就是确定的。

### 实体种类的取值

关系两端（`from_kind` / `to_kind`）、批注目标（`target_kind`）、Project Memory 目标、人物链接的 `kind` 用同一套字符串：`node`、`element`、`patch`、`category`、`storyline`、`comment`、`material`。旧版的 `library_item` 读作 `material`，导入时改写成 `material`（v1 写明；v0 没规定）。

## 对话文档（v2.2）

每个 Agent 对话一篇 `conversation:<对话 id>`，内容是帮手运行时（M27）从本机落盘的运行事件投出来的，可以同步。运行日志、权限请求、运行状态、取消这些本机控制不进来。界面从这里或本机运行日志还原消息，不另存一份能单独改的消息副本。M27 的提案和衔接见 [modules/m27-conversation-schema.md](modules/m27-conversation-schema.md)。

### 根容器

| 容器 | 类型 | 内容 |
| --- | --- | --- |
| `meta` | 映射 | `v`、`doc`：创世写，之后谁都不改。别的键留给以后的版本 |
| `entries` | 列表 | 每项是一段 JSON 字符串，即一条记录；写进去以后不改、不删、不挪 |

### 一条记录

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | 字符串 | 来源运行事件的身份，运行时写 `<会话>:<序号>`；重试、重放都是同一个 |
| `session` | 字符串 | 本机这次运行的随机身份 |
| `turn` | 非负整数（u32） | 这次运行里的第几轮 |
| `kind` | 字符串 | `user`、`assistant`、`thinking`、`tool_call`、`tool_result`；不认识的取值原样保留 |
| `payload` | 任意 JSON | 这条记录的内容（文字、思考、工具参数和结果，以及签名之类以后要原样送回模型的结构） |

`id`、`session`、`kind` 守 id 的规则：非空、最多 256 字节、没有控制字符（`dr_model::id::check_id`）。

### 写入规则

- 只追加，加在列表末尾（`ConversationDoc::append` / `BorrowedConversation::append`）；没有删、改、挪的接口。
- 追加前按 `id` 查：已有且内容相同，什么都不写（重放不重复）；已有但内容不同，报错。
- 两台设备同时追加，先后由 Loro 列表收敛，每台设备自己的记录保持自己追加的顺序。

### 读取规则（容错）

读取和载入都不会因为内容失败，每台设备读同一个列表得到同一个结果：

- 同一个 `id` 出现多次，只读列表里的第一条；内容不同时（只有程序出错或外来写入者会造成）也读第一条，把这个 `id` 报在 `problems().conflicting`；
- 读不懂的项（不是字符串、不是 JSON、是以后版本的记录格式）跳过，原样留在文档里，位置报在 `problems().unreadable`。

### 导入校验

导入别处来的更新之前先过 `conversation::validate_update`（F3 的 `library_options` 把它装进 F2 的导入校验，`ConversationDoc::import` 自己也调）。它只看这份更新自己带来的操作，所以同一份字节在每台设备上得到同一个答案，老实的设备之间不会因为各自见过的东西不同而分叉。拒绝的情况：

- 从 `entries` 删东西（改一条、挪一条在 Loro 列表里就是删了再插，也算）；
- 创世以外的人改 `meta.v`、`meta.doc`（改了身份，或者是另一个对话的字节）；
- 依赖本机还没有的变更。Loro 会把这种更新先挂着，等依赖到了再悄悄应用，那时就没人检查了，所以直接拒，等依赖到了再送一次。

其余的都收下，包括读不懂的记录、`meta` 里别的键和别的根容器，它们留给以后的版本。被拒的更新会挡住同一台设备之后依赖它的更新，所以同步要按因果顺序送。这是协议层面的校验，不是对远端写入者的身份认证。

### 和书、正文的关系

- 没有编辑配置（`DocKind::profile()` 为空）、不是书的正文（`is_book_text()` 为假）：正文的打开、命令、编辑会话、历史正文点、人物链接、派生索引的计数都不碰它。
- `BookView::owns_prose` 对它总是真：它属于书本身，不是哪个对象的正文。
- `project_todo` / `projected_todo` 只收书的正文，对话、模板、书目文档都报错。
- `.driftingbook` 带着对话；导入成新书时只换文档身份和创世对等方，`entries` 里的字节不动。

## 锚点

- `start` 是第一个被锚字符上的光标（`Side::Left`），`end` 是最后一个被锚字符上的光标（`Side::Right`），活着的时候解析为「那个字符的位置 + 1」。所以在锚点前后打字不会扩进去，在中间打字算进去。
- 被锚的文字删掉一部分：锚点缩小到剩下的文字。全删掉：锚点收成删除处的一个点（`collapsed`），批注还在，界面显示「原文已删除」。
- **零宽锚点**（只标一个位置）的两个光标是同一个：插入点后面那个字符上的 `Side::Left` 光标。解析出来是收起的点。
- **编码**：`dr-doc` 的 `Anchor::encode` 和 `gpui-prose` 的 `Anchor::encode` 给出同样的两段字节（测试 `anchors_are_the_cursor_pair_the_editor_stores`），`dr-editor` 在两边之间原样搬，不转换。
- **撤销不会自己把收起的锚点展开回来**：撤销重新插入的文字是新的操作 ID，旧光标找不回它们。编辑器自己带回（F4 已做）：删除前把落在被删文字里的锚点边记进撤销项，撤销后在插回来的字上重建光标，再发 `EditorEvent::AnchorsChanged`。
- **带回来的锚点要写回书目文档**：宿主用 `CommentWriter::anchor` / `PatchWriter::anchor` 写，来源是作者（`user`），像别的写入一样同步出去。这和下一条的替换光标不同：替换光标只是同一位置的便宜写法，带回来的锚点是位置真的变了。
- 被锚字符删掉以后，Loro 要回放历史才能找到位置（重型种子里每次 0.1–1 ms），并给回一个指向活字符的替换光标（再解析只要几微秒）。**替换光标存在本机缓存里，不回写书目文档**：读一次就产生一次同步写入不值得。

## 不变量

旧版靠 SQL 约束、触发器和同步内核（`production-domain-kernel.ts`）挡住的事，新版各有归属。下表是摘要；逐条对过旧版 70 条领域不变量和 126 个仍生效的触发器之后的完整清单（82 条，加 16 条写明不再需要的、9 条界面和 Agent 做法不一样、已由 F3 统一的）在 `dr_model::invariant`，由测试当场断言：

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
| 对话记录只追加，已有的不删、不改、不挪（v2.2） | 写入接口只有追加；导入前按更新自己的操作拒绝删除、改身份和缺依赖的更新 |
| 对话每台设备读出来一样，读不懂的不挡打开（v2.2） | 读取时同一身份只读第一条，读不懂的跳过并保留 |

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

- 撤销管理器排除 `user` 以外的全部来源，包括作者的命令 `user:command`（v2.1），由 `ProseUndo` 自己配好。

- `UndoManager` 的合并间隔设为 **0**，不用 `group_start` / `group_end`。「一次撤销撤掉一阵连打」由编辑器自己做：用 `set_on_push` 给每个撤销项记时间，按一次撤销就连续弹出同一阵的几项。这样能避开 Loro #1228 和 #1245。
- Loro #1229 绕不开：作者设了某个键（标题级别、链接）之后，另一台设备或 Agent 又改了同一个键，作者再撤销，会把对方的值也抹掉。只影响格式，不丢字。等上游修。
- 详细的复现见结论文档。

## 版本

- 现在是 v2.2（`meta.v` 仍是 2）：创世版本 2，样式表如上；另外给未配置的标记键设了默认 `ExpandType::None`（新版本加的标记键在旧版本里本机插入时不扩展）。
- 改动分两类：
  - **向后兼容**（新增根容器、新增实体字段、新增标记键且旧版忽略它也不会写坏）：升小版本，在这里记一行；读取端遇到不认识的字段原样保留。
  - **不兼容**（改键名、改值的含义、改 `ExpandType`、改创世内容、改块 ID 规则）：升 `meta.v`，写清楚迁移办法。改 `ExpandType` 尤其要小心：规则在打标记时就写进了标记，改表只影响以后打的标记，书里已有的标记照旧，新旧两种规则会长期并存。
- Loro 自己的数据格式从 1.0 起不再有破坏性改动；新版 Loro 建的新类型容器，旧版会读成 `LoroUnknown`。

### v2.1 → v2.2（2026-11-08，M27 加、F1 第七轮审）

都是向后兼容的新增，`meta.v` 和已有文档的创世不变：

1. **Agent 对话文档** `conversation:<id>`（新文档种类，见「对话文档」）。M27 提出并实现，F1 审时改了三处：
   - **读取不再因内容失败**。原来一条读不懂的记录、或者同一身份两份内容，会让整篇对话打不开、也收不了同步。现在读不懂的跳过并保留，同一身份读第一条，两种都报出来。
   - **导入校验改成只看更新自己的操作**。原来比的是导入前后的状态，可每台设备导入前见过的不一样：没见过某条记录的设备会收下「插入又删掉它」的更新，见过的设备拒绝，两边从此分叉；还有一个漏洞，先送删除（依赖没到，Loro 先挂着）、再送它依赖的插入，删除会不经检查就生效。现在删除一律拒，缺依赖的更新也拒。
   - **同一身份内容不同的记录不再拒收**，读第一条并报出来。拒收保护不了任何数据，只会让这台设备之后的更新都进不来。
2. **`BookView::owns_prose` 认对话属于书**（原来返回假，存储按它清理没主人的正文时会把对话删掉）。
3. **`project_todo` / `projected_todo` 只收书的正文**（原来对话、模板、书目文档会被当成章节，投出指向不存在章节的待办）。
4. **`dr_model::id::check_id`**：记录的事件身份、会话、种类按 id 的规则检查（原来借用了对话 id 的类型来检查）。

**旧文档怎么读**：v2.1 的文档不用改。**旧版本读新文档**：v2.1 的读取端不认识 `conversation:` 的文档 id。只发生在新旧开发版本混用时，不做兼容。

### v2 → v2.1（2026-11-08，F1 第五轮）

都是向后兼容的新增，`meta.v` 和创世不变：

1. **正文模板文档** `template:category:<id>` / `template:storyline:<id>`（新文档种类，结构和别的正文一样，见「两类文档和它们的 id」）。F3 的模板命令要用：作者能编辑、两台设备能合并。旧字段 `element_template` / `chapter_template` 原样保留、只读。
2. **种子变更**（新规则，见「种子变更」）：投出的待办、新情节规划表的三行三列。
3. **`comments.projection_text`**：投出时的任务文字；没有 `body` 时正文读它。
4. **情节规划默认行列的 id 确定**：`<章节 id>:r1`–`r3`、`<章节 id>:c1`–`c3`。
5. **撤销排除 `user:command`**（来源本身是 F2 第五轮加的）。

**旧文档怎么读**：v2 的文档不用改。v2 时投出的待办带着 `body`，照旧读 `body`；用随机 id 建的情节规划表照旧。**旧版本读新文档**：v2 的读取端看不懂 `projection_text`，种子投出、没改过的待办读成空正文；不认识 `template:` 的文档 id。这只发生在新旧开发版本混用时（还没有公开数据），不做兼容。

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
