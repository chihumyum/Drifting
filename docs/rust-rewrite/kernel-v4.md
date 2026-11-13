# 通用内核 v4：只有一种条目（设计说明）

2026-11-13 起草，同日监管会话审查通过（补了第 5 节「命令层的预防」一段）；第 13 节的问题等作者白天定，实现先按各条「不等答复时」的做法。

实现进度：第 12 节的 2a（写作日和快照点清单挪进两篇小文档、书目格式 4、书文件格式 4）、2b（只有一种条目）和之后的八条轨道都已合进 `main`（2026-11-13）；收尾（`cutover` 门禁的模板 id 规则、`terms` 的禁用词）已打开。数据层留给各轨道的缺口和最终的接口名字见第 14 节；正文里的接口名字已经和实现对齐。它取代 [kernel-v3.md](kernel-v3.md) 的「概念」「数据结构」「不变量」三节；v3 那页的其余部分（小说项目模板的样子、帮手、旧库导入的映射、不做的）照旧有效，下文写明了哪些地方跟着变。现在到哪一步见 [progress.md](progress.md)。

输入是作者 2026-11-13 的决定（九条）和监管会话替作者定下的几条，原文在本页末尾「输入」一节。设计里凡是和输入不一样的地方，都在「和输入不一样的地方」一节单列。

## 1. 大白话

**改了什么。** 现在一本书里的条目分两种：「层级」能在下面放别的条目，但只能有说明、字段和键值表；「叶子」能有正文、补丁、情节规划、关联，但下面不能放东西。模板也跟着分成两种。改完以后**只有一种条目**：任何条目都可以由模板随意拼模块（几篇正文、字段、键值表、补丁、情节规划、关联都行），「下面能不能放东西」是条目上的一个开关。

**为什么。** 作者说两分是设计问题：一个条目能不能挂子条目，和它自己长什么样，是两件不相干的事。比如想给「阿Q」下面挂几条「阿Q的过去」，现在做不到，因为人物是叶子；想给「第一卷」写一篇正文，也做不到，因为卷是层级。

**作者会看到的不同：**

- **模板编辑器**：不再先选「层级模板」还是「叶子模板」。每个模板都能加任何模块，另有一个「新条目默认能放子条目」的开关；它开着时，才显示只跟「下面」有关的设置（在这一层新建时默认用什么模板、怎么显示、自动链接、收别处的条目、新条目住在哪、成书、格式快捷输入、泳道、动作）。「允许放哪些模板」这项没了：开了开关就什么都能放。
- **条目页**：每个条目都有这个开关。打开后，页面上多出「下面的条目」和「下面」的那些设置。关掉时，如果下面还有条目，会先提示「这些条目会移到最外层」，作者点继续，它们就连同各自下面的东西一起挪到最外层。归属到它的条目、它在时间线里当泳道的身份、它自己的设置都不删，只是暂时不起作用；再打开开关就都回来。
- **以前层级固定带的那篇「说明」**，现在就是模板里一篇叫「说明」的普通正文。书稿、构想、要素、各个分类、分组、故事线这些，打开看和现在一样。
- **默认的小说结构不变**：书稿与章、构想看板、要素与分类、故事线、时间线，用起来和现在一样。
- **写作日和快照点**挪进每本书自己的两篇小文档。作者看不出区别；写作时界面不再每分钟被「书变了」惊动一次，存快照点也不再惊动。
- **整书视图**以后改成「从任何一个能放子条目的条目出发，摊平看它和它下面的全部内容」，挂名在它这里的条目也算（比如从一条故事线打开，能读到这条线上的章节），按章写死的旧「纵览全书」退役。这一步只把读取接口定下来，视图本身是后面的工作。

**作者要做的。** 改完以后，开发库里现在这些书会像 v3 切换那时的旧书一样原样拒开（不修、不删）。要从 0.1 再重新导入一次，和上次一样导进一个新的库目录。第 13 节记着作者 2026-11-13 对七个问题的答复，只剩「下面的条目」怎么摆还没定，按默认做法先做。

下文把「开了开关的条目」叫**层级**，这是作者自己的说法（「是否是层级，只有一个开关的区别」）：它不再是一种条目，只是「开关开着」的意思。开关关着的条目就叫条目，「叶子」不再是术语。

## 2. 模型

### 条目

书里的东西都是条目，放在一棵树里。每个条目有：标题、模板（可以没有）、**开关**（下面能不能放条目）、它自己的模块数据、住处（树上的父级和兄弟间的位置）、归属、主归属、布局坐标、时间。

- **开关是条目自己的属性。** 新建时取模板给的默认值（`entry.create` 也可以显式指定）；之后模板的默认值怎么改，都不动已有条目的开关。换模板也不动开关。理由：开关关掉有后果（子条目要挪走），不能因为别处改了模板就连带发生。
- **开关开着**：可以有子条目；它的「下面」设置、泳道、动作、「下面的条目」模块起作用；可以收归属。
- **开关关着**：下面没有条目（命令层保证，见第 3 节和第 5 节）；它存着的「下面」设置、泳道身份、归属到它的成员，都读作不存在，数据留着。
- 兄弟之间的先后就是**文稿顺序**，导出、整书视图、章节编号都按它。

### 模板

模板是「新建条目长什么样」的一份定义，存在书里：

| 部分 | 说明 |
| --- | --- |
| 名字、记号、颜色、写给帮手的说明 | 照 v3 |
| 模块 | 任意种类、任意个数，按 `pos` 排；v3 的「层级模板只许字段和键值表」取消 |
| 开关的默认值 `level` | 用这个模板新建的条目，开关默认开不开 |
| 名字参与自动链接 `linkable` | 默认开。用这个模板的条目住进（或归属到）开了自动链接的层级时，它的标题和别名在正文里自动链接。新加的，理由见下面「自动链接」 |
| 「下面」的设置 `settings` | 用这个模板、开关开着的条目，「下面」的默认设置；照旧可以被条目自己覆盖、往下继承 |
| 动作 `verbs` | 照 v3（比如书稿的「新建章节」）；只在用这个模板、开关开着的条目上出现 |

- **v3 的 `kind`（`level` / `leaf`）和 `TemplateKind` 删掉。** 模板上的 `lane` 字段并进设置（见下面的表）。
- 模板编辑器里，`level` 默认值开着时才展开「下面」的设置和动作；关着时这些值照旧存着、不删（作者先关后开，配置还在）。用这个模板、却自己开了开关的条目，照样用模板里的这些设置。
- **模板更新与项目无关（作者第 6 条）。** 新建书时把内置的项目模板整份复制进书，之后两边各走各的，不做升级通道、不做「有新版本」提示。kernel-v3 里「内置模板有新版本时只提示作者可以更新」「模板 id 固定是为了以后按内置模板更新」这两句作废。`meta.project_template` 只记「这本书是从哪个模板建的」，没有别的用处。
- 内置小说模板的模板 id 仍然是 `tpl-chapter` 这样的固定字符串（它们只是数据，换成随机 id 不换来任何东西，反而让测试和导入多一层查找），但**产品代码不许按模板 id 认东西**，由门禁拦（第 11 节）。

### 模块

六种数据模块照旧（正文、字段、键值表、补丁、情节规划、关联），加一种不存数据的：

| 模块 | 数据放在哪 | 变化 |
| --- | --- | --- |
| 正文 | `body:<条目>/<模块>`，一个模块一篇 | 任何模板都能有、能有多篇。配置加 `in_book`：这篇正文进不进成书（导出、全书字数、章节编号，一个开关一起管），默认进。每篇正文各自一个，模板编辑器里每篇都露出这个开关（作者 2026-11-13 定）。小说模板里的「说明」不进 |
| 字段、键值表、补丁、情节规划、关联 | 照 v3 | 任何模板都能有 |
| **下面的条目**（`children`，新） | 不存数据 | 在条目页上按「显示」设置排出住在下面的条目和归属进来的条目；只在开关开着时显示。模板里没有它而开关开着时，界面把它排在最后（第 13 节问题 4） |

每个模块要交代的六件事（存储、帮手读写、搜索与字数、导出、Markdown、撤销）照 kernel-v3 的模块表，只有两处改：正文的「导出、全书字数」由 `in_book` 决定，不再由「是不是层级的说明」决定；「下面的条目」模块六件事都是「不存数据，帮手经 `entry.get` 读、不进搜索和字数、导出和 Markdown 按树、无撤销」。

### 「下面」的设置与继承

开关开着时才有意义的东西，一张表：

| 设置 | 意思 | 往下继承 | 和 v3 比 |
| --- | --- | --- | --- |
| 新建默认模板 `default_template` | 在这一层新建时用哪个模板 | 是 | 不变 |
| 显示 `display` | 列表、网格、看板、岛屿 | 是 | 不变 |
| 自动链接 `auto_link` | 住在下面或归属进来的条目，名字和别名自动链接 | 是 | 不再只管叶子，见下 |
| 收别处的条目 `accept` | 别处的条目可以归属到这一层 | 是 | 不变 |
| 新条目住在 `home` | 只对收别处条目的层级：在这一层新建的条目住在哪个层级 | 是 | 不变；目标必须是开着开关的活条目 |
| 成书 `is_manuscript` | 下面按文稿顺序排出来的东西是书的正文 | 只认直接声明、只认最外层 | 序列规则改了，见「成书」 |
| 格式快捷输入 `format_shortcuts` | 住在下面的条目的正文，行首快捷格式 | 是 | 不变 |
| 泳道 `lane` | 这个层级可以当时间线泳道；泳道总是收别处的条目 | **否**：只看条目自己的覆盖和它的模板 | 从模板字段挪进设置，条目可以自己覆盖 |
| 动作 `verbs` | 模板声明的新建动作 | 否（模板上的） | 不变 |
| 下面的条目模块 | 见上 | — | 新 |
| ~~允许的模板 `allow`~~ | — | — | **删掉**（作者第 2 条） |

**继承照旧**：一个层级的某项设置，先看它自己的覆盖，再看它的模板，再往上找最近一个说了这一项的祖先，都没有就用默认值。祖先链只走开关开着的祖先（合并后偶尔会有子条目挂在开关关着的条目下，见第 5 节）。泳道不往下继承，否则一条故事线下面的每个层级都会变成泳道。

一个条目自己的正文用哪种格式快捷输入，看它**住处所在层级**解析出来的值，不看它自己（设置说的是「下面」）。v3 对叶子就是这样，现在对层级自己的正文也一样。

开关关着时，条目上存着的覆盖不删、不用；命令层不接受给开关关着的条目写覆盖（先开开关），免得作者以为改了却没有效果。

### 住处与归属

- 每个条目在树里只有一个**住处**：根，或者一个开关开着的条目。
- 开了「收别处的条目」的层级（泳道总是收）可以有**归属**：别处的条目挂一个名在这里，本体不动；可以标一处为主归属。归属只看要挂去的那一层：它活着、开关开着、解析后收别处的条目。**不再看它允许哪些模板。**
- 宿主的开关关掉以后，归属到它的记录不删，读取时忽略（主归属指着它也一样当作没有）；打开开关就回来。这沿用 v3「读取时不满足就忽略这条归属，数据留着」的容错。

### 自动链接

一个条目自动链接，当且仅当：它活着、**它的模板 `linkable` 是开着的**（没有模板的条目算开着），并且它的住处所在的层级、或者它任一有效归属的层级，解析后开了自动链接。**不看它自己的开关**：一个人物下面挂了子条目，照样自动链接。

`linkable` 是新加的。只按「住处或归属的层级开了自动链接」判断的话，小说模板里「人物」分类下面的「分组」（导入 0.1 时每个要素分组都变成这样一个分组）也会被自动链接：正文里出现「主要人物」「城里」这类分组名就被链上，名字唯一的检查也会把分组算进去，和同名的要素互相冲突。v3 靠「分组是层级、层级不链接」挡住了这件事。现在由模板说：整理用的模板 `linkable = false`（书稿 `tpl-manuscript`、构想看板 `tpl-ideas`、构想分组 `tpl-idea-group`、要素库 `tpl-elements`、分类 `tpl-category`、分组 `tpl-group`、故事线列表 `tpl-storylines`、故事线 `tpl-storyline`、幕 `tpl-act-track`），装内容的模板 `linkable = true`（章 `tpl-chapter`、构想 `tpl-idea`、人物、地点、道具、组织和通用要素 `tpl-element`）。默认结构的行为因此和现在一样。

名字和别名唯一的范围跟着改成「自动链接的条目」（上面的定义），规则照 v3：命令层预防，合并后重名按创建时间和 id 留第一个，其余标出。

### 成书

- 「成书」打开的层级（只认直接声明的、最外层的）下面的东西是书的正文。默认结构里只有书稿打开。一本书可以有几处成书。
- **成书序列**：从成书层级出发，按树的先序走住在下面的条目（不走归属）：每个条目先给出**它自己的、`in_book` 开着的正文**（按模板里模块的顺序），再走它下面的条目（作者第 5 条）。放进回收站的条目连同它下面的都不算。
- v3 只收「成书层级下面的叶子」。现在中间的层级（比如书稿下的「第一卷」）自己的正文也会出现在它下面的章之前；但小说模板里分组的正文模块是「说明」，`in_book` 关着，所以默认结构导出的内容和现在一样（第 13 节问题 2、3）。
- 导出、全书字数和字数目标、章节编号都只看成书序列；整书视图用同一个读取接口（第 7 节）。

### 时间线与泳道

照 v3，只改「谁能当泳道」：泳道是**开关开着、解析后 `lane` 为真**的条目。

- 视图由作者自己建，由泳道组成，顺序由作者摆；没有书序。
- 条目只有归属在某条泳道里才在视图里；位置按条目存，同一视图的几条泳道共用一个位置。
- 时间钉、幕轨道（视图里标了 `act_track` 的泳道）照旧。
- 泳道条目的开关关掉：它在各视图里暂时不当泳道画，成员的位置读作不在（数据留着）；打开就回来。

### v3 的概念：消失、保留、换说法

**消失：**

| v3 里的 | 去处 |
| --- | --- |
| 层级模板 / 叶子模板，模板的 `kind`，`TemplateKind` | 删。模板只有一种 |
| 允许的模板：`allow`、`LevelSettings::allows_template`、`check_level_allows_template`、契约 `V3-LEVEL-ALLOWS-TEMPLATE`、界面上的「允许的模板」、归属检查里的模板限制 | 删（作者第 2 条，「临时」删掉：以后要加回来就是一个新设置） |
| 固定的 `about`：`LEVEL_ABOUT_MODULE`、`level_about_module_id`、`novel::MOD_ABOUT`、`body:<条目>/about`，以及各处「是层级就多一篇 about」的分支（编辑器、搜索、审阅、统计、外壳的页面和大纲、帮手的模块解析和结构说明、证据收集） | 删。小说模板给原来是层级的模板各加一个正文模块「说明」（id `mod-description`，`in_book = false`） |
| 「叶子不能有子条目」（`check_parent_is_level` 按模板判断、`V3-LEAF-NO-CHILDREN`） | 换成「开关关着的条目下面没有条目」，按条目的开关判断 |
| 「层级模板只许字段和键值表」：`ModuleKind::allowed_on_level`、`check_template_modules`、读模板时丢掉层级模板的其他模块 | 删 |
| 「叶子模板不能声明设置、泳道、动作」（`entry_template.put` 的校验、帮手动作诊断 `leaf_template_verb`） | 删。设置和动作存着，用在开着开关的条目上 |
| 「层级换成叶子之前要先没有子条目」「改用中模板的种类要先没有子条目」（`check_template_switch`、`entry_template.put` 的两段） | 删。换模板不动开关；关开关另有命令 |
| `is_autolink_leaf` 里「必须是叶子」 | 换成 `linkable`，函数改名 `is_autolinked` |
| `Entry::is_leaf`、`EntryTemplate::is_leaf/is_level`、`is_level(&templates)` | `Entry::is_level()` 读条目自己的开关；`is_leaf` 删 |
| 模板上的 `lane` 字段、`is_lane_level` | 并进设置 `lane`；`Entry::is_lane()` 由解析后的设置给出 |
| `level.get`、`level.list` 两条命令 | 并进 `entry.get`、`entry.list`（第 6 节） |
| `ChildSettings`、`ChildSettingsOverride`、`resolve_child_settings_for_parent` 这些别名 | 删 |
| 内置模板的升级说法（固定 id 的理由、「有新版本时提示」） | 作废（作者第 6 条） |
| 书目文档里的 `writing_days`、`entry_checkpoints` 两个根，`CollectionV3::WritingDays`，书目事件的 `touched` 分类 | 挪进两篇小文档（第 8 节）；`touched` 不再需要 |
| 快照点的旧指纹兼容（`content_hash_with_siblings`，11-12 为旧库留的） | 删：新格式的库里没有旧指纹的点 |
| 时间线界面按 id 找或建 `tpl-act-track` 的那段 | 删：「幕」模板随小说模板一起建（第 9 节、第 13 节问题 6） |

**保留：** 条目树和文稿顺序；住处、归属、主归属；时间线视图、泳道、摆放、时间钉、幕轨道；六种数据模块和它们的存法；设置往下继承（去掉 `allow`）；成书不嵌套、只认最外层；动作；模板复制进书、模板正文初值 `template:<书>/<模板>/<模块>`；换模板不删数据（新模板没有的模块原样留着，换回来就回来）；只能删没人用的模板；条目 id 一律新生成、文档 id 在库里唯一；素材、批注、待办、项目设定、Project Memory 不在树里。

**换说法：**

| v3 | v4 |
| --- | --- |
| 层级（一种条目） | 层级 = 开关开着的条目 |
| 叶子 | 条目（开关关着），不再是术语 |
| 层级的说明 `about` | 模板里一个叫「说明」的正文模块 |
| 泳道层级（模板 `lane`） | 开关开着、设置 `lane` 为真的条目 |
| 自动链接的叶子 | 自动链接的条目 |
| 成书层级下面的叶子 | 成书序列（每个条目自己的成书正文在前，下面的条目在后） |

## 3. 关开关

### 命令 `entry.set_level`

一条命令管开和关：输入 `{book, id, level: bool}`，输出 `{id, level, moved}`（`moved`：关开关时挪到根层级的直接子条目，按原来的先后）。开关已经是要的值时什么都不写、不登记撤销。数据层的原语是 `EntriesTreeWriterV3::switch_level_off(&id) -> Vec<EntryId>`；打开只写 `EntryWriterV3::level(true)`。

**打开**：只写这个条目的 `level = true`。之前存着的覆盖、归属、泳道身份、视图里的位置都重新起作用；合并时偶然挂在它下面的条目（第 5 节）回到它下面。

**关掉，下面没有条目**：只写 `level = false`。

**关掉，下面还有条目**：一次书目提交里做完下面这些，要么全做、要么都不做：

1. 取它**直接的**子条目，包括放在回收站里的，按文稿顺序。回收站里的也挪，否则以后从回收站恢复时又落回一个关着开关的条目下面。
2. 把它们挪到根层级，**紧跟在这个条目所在的那个顶层条目后面**（这个条目本身就在根上时，紧跟在它自己后面），相互之间保持原来的先后。作者说的是「移到根层级」；放在顶层祖先后面而不是根的最末尾，是为了挪完以后它们还在作者眼前附近（这是我定的工程细节，不另问）。
3. 各自下面的子树原样跟着走（树的移动本来就带子树）。
4. 写 `level = false`。
5. 不动：这个条目上存着的覆盖、它的模板、归属到它的记录、指着它的主归属、视图里以它为泳道的记录、成员的摆放、`home` 指着它的别处设置。这些读取时都忽略（`home` 指着关了开关的条目时，新条目住在发起新建的那一层，v3 对 `home` 指着叶子就是这样）。被挪走的子条目不再从它继承设置，这是「移到根层级」的本意。

**受守卫的写入**（[f3-write-guards.md](foundations/f3-write-guards.md)）声明替换：

| 情形 | 声明 |
| --- | --- |
| 打开，或关掉而下面没有条目 | `entries/<条目>/level` |
| 关掉，下面有条目 | `entries/<条目>/level` 加 `children_of(<条目>)`（这一层的子条目顺序） |

声明子条目顺序，是为了让「提示里说要挪的那几个」和「真挪的那几个」一致：调用方读完以后别处又往下面加了一个条目，这次写入就冲突、什么都不做，界面重读再问一次。被挪的子条目自己的记录（住处变了）是命令按当前文档规划出来的连带改动，照守卫规则第 3 条不用声明；它们落到根层级是追加，不替换根层级已有的顺序。

调用方读的是 `RecordKey::entry(<条目>)` 和 `RecordKey::children_of(Some(<条目>))`。子条目顺序这种键只被同一个键的读覆盖（`RecordKeyV3::contains`，2b 改的：以前它不被任何读覆盖，声明了它的写入在 `require_all` 守卫下永远过不去）。

**撤销**：命令登记一条 `entry_history.restore`，目标是这个条目和每个被挪的子条目，时间点是提交之前。恢复时先恢复这个条目（开关回到开：`restore_entry` 恢复的标量里有 `level`），再恢复子条目的住处和位置（`restore_entry_with_parent` 按幸存的邻居把位置放回去），最终的树校验在同一次写入里做。所以作者撤销一步，开关和子条目一起回到原样。恢复时拒绝「把一个条目恢复成开关关着、而它下面还留着活的条目」。

**写前快照**：作者的操作照旧由自动快照点在之后捕获。帮手调用时，执行器应对这个条目和每个直接子条目各存一个写前快照（它们的「变没变」都包括住处，见 [m09-history.md](modules/m09-history.md)）；更深的后代父级没变，不用存。2b 只做了条目自己那一份（`dr-agent-tools/src/checkpoints.rs` 的 `Named` 把 `entry.set_level` 归入按 `id` 选条目的一组），直接子条目那几份留给 T3（第 14 节）。

**事件与效果**：一次 `Book` 事件；效果是这个条目「更新」、每个子条目「移动」。不发 `Removed`。

### 界面只负责提示和确认

条目页（以后还有左栏）上的开关：

- 打开：直接调。
- 关掉：界面先用 `entry.get` 读到「下面」（含子条目和归属成员），下面有条目时弹一次确认：「下面的 N 个条目会移到最外层，各自下面的东西跟着走。归属到它的条目和它在时间线里的泳道先不显示，再打开就回来。」继续才调，并带上它读到的 `children_of` 摘要。冲突时重读、再问。
- 命令本身不再问：帮手和 MCP 直接调（作者 11-06 定的「Agent 一律最高权限」），靠写前快照和撤销兜底。

## 4. 数据结构

### 版本标记

- 书目文档 `meta.v` 从 3 升到 **4**，创世版本也是 4（创世对等方由文档 id 和创世版本算出，所以 v4 的创世和 v3 的不是同一份变更）。只开 `meta.v == 4` 的书；3 和更早的原样拒开、不改不删，和 v3 切换时对 v2.2 的政策一样（作者第 7 条）。导入校验照旧拦住「并完以后不再是 4」的更新，所以 v3 的书目更新进不了 v4 的库。
- 正文、素材笔记、对话文档的结构和创世版本都不变（仍是 2），样式表不变。
- `.driftingbook` 的格式版本从 3 升到 **4**，只读 4；3 报「这是以前格式的书文件」，和别的旧格式一样拒绝、不写任何东西。
- 两篇小文档自己的 `meta.v = 1`（第 8 节）。

### 书目文档 v4 的根容器

| 根容器 | 类型 | 内容 | 和 v3 比 |
| --- | --- | --- | --- |
| `meta` | 映射 | `v = 4`、`book`；书名、梗概、创建与删除时间；`word_target`、`daily_word_target`；`project_template = {id, version}`（只记来源） | `v` 改 |
| `entries` | LoroTree | 节点 meta：`id`、`title`、`template`、**`level`**（布尔，开关）、`overrides`（「下面」设置的覆盖，含 `lane`）、`fields`（`<模块>.<字段>` → 值）、`kv:<模块>`（键值表）、`primary`、`layout`（看板、网格、关系图坐标）、`created_at`、`updated_at`、`deleted_at`。兄弟顺序就是文稿顺序 | 加 `level`；`overrides` 去 `allow`、加 `lane` |
| `templates` | 映射 | 模板 id → `name`、`mark`、`color`、`agent`、**`level`**（新条目开关的默认值）、**`linkable`**、`modules`（模块 id → `{kind, name, pos, config, agent}`，任意种类）、`settings`（含 `lane`）、`verbs`、`deleted_at` | 删 `kind`、`lane`；加 `level`、`linkable`；`modules` 不再限种类 |
| `memberships` | 映射 | `<层级>\|<成员>` → `{host, member, pos, created_at}` | 不变 |
| `timeline_views` | 映射 | 视图 id → `{name, pos, lanes, placements, pins, deleted_at}`；`lanes[<泳道条目>] = {pos, act_track?}` | 不变 |
| `patches` | 映射 | 补丁 id → `{entry, module, source_entry, source_module, source_block, source_text, anchor, invalidated_at, title, body, pos}` | 不变 |
| `plot_grids` | 映射 | `<条目>/<模块>` → 行、列、格子、尺寸 | 不变 |
| `relation_types`、`relations` | 映射 | 照 v3（`source_templates`/`target_templates` 是关系类型自己的端点限制，和删掉的 `allow` 无关，不动） | 不变 |
| `comments` | 映射 | 照 v3，目标为条目时可带 `module` | 不变 |
| `materials`、`assets`、`facts`、`memory` | 映射 | 照 v3 | 不变 |
| `material_folders` | LoroTree | 照 v3 | 不变 |
| ~~`writing_days`~~ | — | 挪进 `stats:<书>` | 删 |
| ~~`entry_checkpoints`~~ | — | 挪进 `checkpoints:<书>` | 删 |

读取时缺键的含义：条目没有 `level` 读作关；模板没有 `level` 读作关、没有 `linkable` 读作开；`in_book` 缺读作开；覆盖里缺的键表示继承，`default_template`/`home` 的显式 `null` 表示清空（照 v3）。不认识的字段照旧原样保留。

### 模板的形状

两个例子（JSON 只为示意，存的是 Loro 映射）：

```json
{
  "name": "章", "mark": "file-text", "level": false, "linkable": true,
  "modules": {
    "mod-fields":    {"kind": "fields", "name": "章节信息", "pos": "a0", "config": {"defs": ["…梗概、写作状态…"], "summary_field": "summary", "status_field": "status"}},
    "mod-prose":     {"kind": "prose", "name": "正文", "pos": "a1", "config": {"show_outline": true, "task_todos": true, "in_book": true}},
    "mod-plot-grid": {"kind": "plot_grid", "name": "情节规划", "pos": "a2"}
  },
  "settings": {}, "verbs": []
}
```

```json
{
  "name": "分类", "mark": "tag", "level": true, "linkable": false,
  "modules": {
    "mod-fields":      {"kind": "fields", "name": "属性", "pos": "a0", "config": {"defs": ["颜色"], "color_field": "color"}},
    "mod-description": {"kind": "prose", "name": "说明", "pos": "a1", "config": {"in_book": false}},
    "mod-children":    {"kind": "children", "name": "要素", "pos": "a2"}
  },
  "settings": {"default_template": "tpl-character", "display": "grid", "auto_link": true, "accept": true, "is_manuscript": false, "format_shortcuts": "notes"},
  "verbs": []
}
```

### 正文文档的 id

| 文档 | id | 变化 |
| --- | --- | --- |
| 条目的一篇正文 | `body:<条目>/<模块>` | 任何条目都可以有；没有保留的模块 id |
| ~~层级的说明~~ | ~~`body:<条目>/about`~~ | 删；小说模板里的「说明」是 `body:<条目>/mod-description` |
| 模板里一篇正文的初值 | `template:<书>/<模板>/<模块>` | 任何模板都可以有（原来只有叶子模板） |
| 写作日 | `stats:<书>` | 新（第 8 节） |
| 快照点清单 | `checkpoints:<书>` | 新（第 8 节） |
| 素材笔记、对话 | `material:<素材>`、`conversation:<对话>` | 不变 |

条目 id 一律新生成（包括默认根和默认分类），文档 id 在整个库里唯一：两篇小文档的 id 带书 id，所以照旧成立。

### 代码里叫 `…V3` 的名字要不要改

现状：带 `V3`/`v3` 的标识符约 4,600 处、分布在约 400 个文件；名字里带 v3 的文件和目录 91 个。去掉后缀不是纯机械替换：`BookView`、`BookTxn`、`BookDoc`、`BorrowedBook`、`BookReader`、`EntityLink`、`Comment`、`Patch`、`PlotGrid`、`RelationType`、`BookMeta`、`RecordKey`、`SeededBook`、`SampleBook` 这些名字在源格式适配边界（`import_v1`、种子的源格式部分）里都还有同名的定义，得先把那边改叫 `…V1`；门禁还把 `dr-doc/src/book/mod.rs` 列为「不得回来的路径」。

建议分两半：

1. **说出错误事实的名字，在第 2 步数据层里就改**，量不大：`is_v3_doc` → `is_book_doc`（判断 `meta.v == 4`）、`SCHEMA_VERSION_V3`/`GENESIS_VERSION_V3`/`genesis_v3` → 书目的版本常量和创世函数、命令注册里的 `BOOK_VERSION: Some(3)` → 4、错误信息里的「v3 book」、导入的新库目录前缀 `reimport-v3-`、种子别名 `seed:v3-<preset>`、门禁名 `v3-cutover`。这些留着会让人以为格式还是 3。
2. **类型和目录的后缀**，等所有并行轨道都合进 `main`、没有开着的分支时，单独做一路纯改名：先把源格式那边的同名类型改成 `…V1`，再去掉 canonical 这边的 `V3` 后缀，门禁的退役路径表跟着调。估计一个晚上（脚本替换加修同名冲突加全套检查），提交里只有改名。在轨道并行期间做，会让每条分支都和它冲突，所以不能提前。值得做：不改的话，格式是 4 而代码到处写 V3，以后每个读代码的人都要先弄懂这层历史。

## 5. 不变量

### 改后的完整表（条目内核这一块）

共用的不变量（关系、批注、素材、正文结构、对话……）不受这次影响，照 [loro-schema.md](loro-schema.md) 和 `dr_model::invariant`。

| 不变量 | 靠什么 |
| --- | --- |
| 树不成环 | LoroTree 保证；命令层拒绝把条目移到自己或后代下 |
| 开关关着的条目下面没有条目 | 命令层：新建和移动只接受根或开着开关的活条目做住处；关开关的命令把直接子条目一次挪走。读取：合并后仍有条目挂在开关关着的条目下（一台设备关开关、另一台同时往下面加了条目），读作住在最近一个开着开关的祖先下面（没有就是根），数据不动；开关再打开，它就回来 |
| 关开关不删「下面」的东西 | 结构：覆盖、泳道身份、归属、主归属、视图里的位置都留着。读取：开关关着时它们读作不存在 |
| 关开关下面有条目时是一次原子的挪动，能一步撤销 | 命令层（第 3 节） |
| 新条目的开关取模板的默认值，之后模板怎么改、条目换什么模板，都不动已有条目的开关 | 结构：开关存在条目上；命令层：只有 `entry.create`、`entry.set_level` 写它 |
| 条目的模板不在了：当作没有模板，只显示已有数据，不丢 | 命令层检查模板存在；读取容错（照 v3） |
| 换模板不删数据 | 结构：只改 `template`；新模板没有的模块原样留着、界面放在「原来的内容」里（照 v3，去掉「层级换叶子」那一半） |
| 只能删没人用的模板 | 命令层；合并后照模板缺失容错（照 v3） |
| 归属到的层级活着、开关开着、解析后收别处的条目 | 命令层预防；读取时不满足就忽略这条归属，数据留着（去掉模板限制） |
| 视图里的泳道是开关开着、解析后 `lane` 为真的条目 | 命令层预防；读取时不是就不当泳道画 |
| 视图里的条目在这个视图的某条泳道里 | 命令层：拿出最后一条泳道时一起去掉位置；读取时不在任何有效泳道里的位置不显示（照 v3） |
| 视图里的泳道、时间钉挂的条目都要在 | 读取时不在就不显示（照 v3） |
| 自动链接的名字和别名唯一，范围是「自动链接的条目」 | 命令层预防；合并后重名按创建时间、id 留第一个，其余标出 |
| 成书的层级不嵌套 | 命令层预防；读取时只认最外层（照 v3） |
| 成书序列：每个条目自己的成书正文在它下面的条目之前，只走住处、按文稿顺序 | 结构：只有一个读取接口算它（第 7 节） |
| 整书视图带归属摊平时，每个条目只出现一次；成书序列不带归属 | 结构：同一个读取接口，已访问集合（第 7 节） |
| 跨文档写入的先后：先正文、再书目 | 命令层（照 v3）；快照点清单在原子事务里，写作日单独写，都不和书目文档交错 |
| 文档 id 在库里唯一 | 结构：条目 id 新生成，模板正文和两篇小文档的 id 带书 id |
| 写作日和快照点不写书目文档 | 命令层（第 8 节） |
| 两篇小文档不是正文 | 结构：没有编辑配置，不计字数、不搜索、不导出、不投待办；属于 id 里的那本书 |
| 只开 `meta.v == 4` 的书 | 读取：别的版本原样拒开，不改不删 |

### 命令层的预防：只拒绝这次写入新造成的违规

上表里凡是写了「命令层」的，命令只拒绝**这次写入新造成的**违规。合并留下的旧违规（两台设备各建了一个同名人物、各把一处设成了成书）由读取容错处理，不挡住这本书里无关的写入；作者用改名、移动、关掉成书这类写入去消解它们，违规只会变少，也不会被拒。

v3 的做法不是这样：`dr-workspace` 的 `graph_ok`（`commands/v3/mod.rs`）在每次写入前把全书重验一遍。2026-11-13 的诊断（共享笔记 `E-entry-update-cost-diagnosis.md`）查出两件事：

- **正确性**：Tiny 种子上，另一台设备同步进来一个同名人物以后，这本书里所有走 `graph_ok` 的写入都被拒，包括改一个无关章节的标题、改别的人物的字段、新建一个不重名的人物。同步合出的嵌套成书按代码推断也一样。
- **代价**：改一个标题在新的重型种子上 219 ms、三年的书上 406 ms，约 94% 花在名字唯一检查上：不管改哪一条，都拿每个自动链接的条目和全书每个条目比一遍，每比一次还重算对方的层级设置、扫一遍全部归属。

v4 的做法：

| 不变量 | 「新造成的」怎么判断 |
| --- | --- |
| 树不成环 | LoroTree 保证；命令只查要移动的那个条目 |
| 开关关着的条目下面没有条目 | 只查这次写入给出的住处（新建、移动、恢复的目标） |
| 模板存在、只能删没人用的模板 | 只查这次写入点名的模板 |
| 归属规则、泳道、位置在泳道里、视图引用的条目都在 | 只查这次新加或改动的那条归属、泳道、位置、引用 |
| 自动链接的名字唯一 | 改前、改后各算一张名字表（名字 → 拥有它的自动链接条目）。某个名字改后的拥有者不止一个、而且其中有改前没拥有它的条目，才拒绝。改前就重名、改后没有新拥有者的（包括重名变少的），放行 |
| 成书不嵌套 | 改前、改后各算一次「嵌套对」（外层成书、里层成书）。改后出现改前没有的嵌套对才拒绝 |
| 关开关时挪走子条目 | 命令自己做，第 3 节 |

一次影响一批条目的写入（换模板、改模板的 `linkable` 或「下面」的设置、改条目的自动链接覆盖、移动、恢复、关开关）走同一套改前改后比较，不另写规则。

实现的名字（2b）：

- `dr_model::v3::check_new_violations(before: BookGraph<'_>, after: BookGraph<'_>) -> Result<(), Violation>`；`BookGraph { entries, templates, memberships }` 是借用。名字表是 `AutolinkNames::of(entries, memberships, templates)`（`is_linked`、`linked`、`owners(key)`、`names()`），嵌套对是 `manuscript_nest_pairs(entries, templates)`。
- `dr_doc::v3::BookViewV3::graph() -> BookGraphV3`（`entries`、`templates`、`memberships` 三项，自有，可克隆后改），`BookGraphV3::check_against(&before)`；条目部分是 `entry_headers_with(&templates)`：只读结构要的那几样。
- 命令层是 `dr-workspace` `commands/v3/mod.rs` 的 `changes_ok(&before, &after)`：每条命令先 `v.graph()`，克隆一份应用自己要做的改动，再比。只改布局的 `entry.update`、改非别名字段的 `module.set_field` 不读也不比。

怎么做才便宜：

- 名字表一遍扫出：自动链接的资格按层级各解析一次设置、归属按宿主各扫一次，再走一遍条目；不在循环里对每一对条目重算。
- 改前改后的比较不读全书的完整条目：只读结构要用的那几样（id、父级、位置、标题、模板、开关、覆盖、删除时间、创建时间、别名字段），不解码键值表、布局和别的字段。
- 写任务里按 id 找树节点，不再为一个 `TreeID` 深读全树每个节点的元数据（现在 `EntriesTxn::node` → `tree_index` → `forest`，4 / 9 ms，还占着持有者线程）：只读每个节点的 `id`，或用一张随文档版本失效的索引；重复 id、成环的读法照旧。
- `BookViewV3::entry(id)` 不再先读全书再挑一条：读这一条，名字冲突标记从名字表里取。

目标：`entry.update`、`module.set_field` 这两条命令本身在重型种子和三年的书上都回到个位数毫秒（对照组 `module.put_patch` 现在是 1.3 / 2.1 ms）。改完以后用诊断报告末尾的测量程序和两本书重量，结果写进交回报告和本页（第 14 节「量到的」）。

回归测试（2b 里加）：同步合入的重名不挡无关写入，也不挡用改名消解它；同步合出的嵌套成书同理；这次写入新造成的重名、嵌套成书、不合规的归属照旧被拒；换模板、改 `linkable`、改自动链接设置、移动、恢复各有一条「新造成的才拒，旧的放行」的测试。

### `dr_model::invariant` 里怎么改

任务书写的是 `dr-testkit/src/invariant.rs`；契约清单实际在 `next/crates/dr-model/src/invariant.rs`（`ACTIVE_CONTRACTS = 76`），点名的测试由 `dr-doc` 的 `every_named_test_exists` 核对。下表要动的条目内核契约，测试在 `dr-model/src/v3.rs` 的单元测试里（`two_novel_books_…` 在 `dr-testkit/tests/seed.rs`）。

| 契约 | 怎么改 | 守它的测试 |
| --- | --- | --- |
| `V3-LEVEL-ALLOWS-TEMPLATE` | **删**（作者第 2 条）。删契约的理由记在本页和 v3-cutover 的退役记录里 | `v3_level_allow_list_filters_new_entries` 删 |
| `V3-LEAF-NO-CHILDREN` | **改**成「开关关着的条目下面没有条目」（id 暂不改，见下） | 原测试换成 `entries_with_the_switch_off_hold_nothing_and_merge_lifts_to_the_nearest_level` |
| `V3-TEMPLATE-SWITCH-KEEPS-DATA` | **改**：去掉「层级换叶子要先没有子条目」，加「换模板不动开关」 | `v3_switching_template_preserves_module_data_and_checks_children` 换成 `switching_template_keeps_module_data_and_the_switch` |
| `V3-MEMBERSHIP-RULES` | **改**：宿主开着开关、解析后收；不看模板 | `v3_membership_governed_by_target_level_accept_and_allow` 换成 `membership_is_governed_by_the_hosts_switch_and_accept` |
| `V3-TIMELINE-LANE-ENABLED` | **改**：开关开着且解析后 `lane` 为真；`lane` 不往下继承 | `v3_timeline_lanes_and_placements_require_lane_membership` 改期望（它同时守 `…PLACEMENT-IN-LANE`，那条的期望不变） |
| `V3-AUTOLINK-NAME-UNIQUE` | **改**：范围是自动链接的条目（`linkable` 加住处或归属的层级），不看开关 | `v3_autolink_names_…_across_autolink_leaves` 换成 `autolink_names_are_unique_across_autolinked_entries_whatever_their_switch` |
| `V3-DOCID-LIBRARY-UNIQUE` | **改**说明：两篇小文档的 id 带书 id | 两条测试保留，`two_novel_books_…` 加上两篇小文档 |
| `V3-CROSS-DOC-ORDER` | **改**说明（快照点清单、写作日） | 不变 |
| `V3-MANUSCRIPT-NO-NEST` | **改**说明（成书层级 = 开着开关的条目） | 不变 |
| `WRITING-DAY` | **改**说明：存在 `stats:<书>` | 原测试是源格式的，保留；加 `writing_days_live_in_the_stats_document` |
| `NO-HOT-FIELDS` | **改**说明：写作日不在书目文档里了 | 原测试保留，加上一条的测试 |
| `LEVEL-OFF-KEEPS-BELOW` | **加** | `switching_off_keeps_overrides_memberships_lanes_and_placements_for_when_it_is_back` |
| `LEVEL-SWITCH-OFF-MOVES-CHILDREN` | **加**：一次挪完、子树跟着、守卫按子条目顺序、一步撤销 | `switching_off_moves_direct_children_after_the_top_level_ancestor_in_one_undoable_commit` |
| `LEVEL-DEFAULT-FROM-TEMPLATE` | **加** | `the_switch_starts_from_the_template_and_never_follows_it_afterwards` |
| `MANUSCRIPT-OWN-PROSE-FIRST` | **加** | `the_manuscript_sequence_puts_each_entrys_own_book_prose_before_what_lives_under_it` |
| `FLATTEN-MEMBERS-ONCE` | **加**（作者 2026-11-13 定的「挂名的也算」）：带归属的摊平先住处后归属、每个条目只出现一次、成书序列不带归属 | `flattening_a_lane_reads_its_members_in_lane_order_once_and_leaves_the_manuscript_alone` |
| `SIDE-DOC-NOT-PROSE` | **加** | `stats_and_checkpoints_are_neither_prose_nor_the_book` |
| `SIDE-DOC-QUIET` | **加** | `writing_days_and_checkpoints_leave_the_book_document_alone` |
| `BOOK-FORMAT-4-ONLY` | **加**（v3 切换时这条只有 `dr-workspace/tests/cutover.rs` 的测试，清单里没有对应的契约；`DOC-IDENTITY` 管的是「字节只当它自己那篇文档载入」，不是版本） | `cutover.rs` 里的拒开测试改成也拒 v3，并入清单 |

`ACTIVE_CONTRACTS` 从 76 变成 83（删 1、加 8）。2a 已加其中三条（两篇小文档的两条和 `BOOK-FORMAT-4-ONLY`），现在是 79。不变量的 id 都还带 `V3-` 前缀：id 只是清单里的字符串，改它不影响测试，留到第 4 节的改名那一路一起改成不带版本的名字。

## 6. 命令、帮手工具和 MCP

### 命令

| 命令 | 变化 |
| --- | --- |
| `project.create` | 照旧用小说模板建书；给每个建出来的条目登记它模板里的每篇正文（新书里还没有模板正文可抄，所以只登记、不打开；不再单独建 `about`）；同时建 `stats:<书>`、`checkpoints:<书>` 两篇小文档（第 8 节） |
| `entry.list` | 每个条目多 `level`；入参加 `below: bool`，为真时给每个开着开关的活条目带上 `below`（见下），全部出自同一次读。吸收 `level.list`；`level.list` 带的书目 `version` 没有了，要守卫的版本用 `entry_history.version` 或 `Workspace::observe` |
| `entry.get` | 多 `level`；开关开着的活条目多 `below = {settings, sources, children, members}`（解析后的设置、每项设置来自哪里、住在下面的条目、归属进来的条目），DTO 是 `types::Below`，`sources` 的值是 `types::SettingSource`（泳道强制收别处条目时是 `{"kind":"lane","entry":…}`，不再带模板）。吸收 `level.get` |
| `level.get`、`level.list` | **删**。门禁 `cutover` 把它们列进退役命令 |
| `entry.create` | 住处（`parent`，或 `home` 解析出的住处）必须是根或开着开关的活条目；不再查允许的模板；开关取模板的默认值，入参可加 `level` 覆盖；按模板初始化全部正文模块 |
| `entry.set_level` | **新**，第 3 节 |
| `entry.update` | `title`、`template`、`overrides`、`layout` 照旧，只写点了名的字段；`overrides` 只接受开关开着的条目；换模板不再查子条目；不管开关 |
| `entry.move` | 目标住处必须是根或开着开关的活条目；不再查允许的模板 |
| `entry.trash`、`entry.restore` | 不变 |
| `entry_template.list` | 输出没有 `kind`、多 `level`、`linkable`；设置里没有 `allow`、多 `lane` |
| `entry_template.put` | 不查种类；模块任意种类、没有保留的模块 id；设置、泳道、动作不论 `level` 默认值都可以存；`home` 必须指向开着开关的活条目；删掉「改用中模板的种类」的子条目检查 |
| `entry_template.put_module`、`remove_module` | 不再限种类 |
| `entry_template.delete` | 不变 |
| `module.list`、`module.read`、`module.read_prose`、`module.set_prose`、`module.replace_prose`、`module.prose_document` | 去掉 `about` 的特殊情况：一篇正文要么是模板里的正文模块、要么是条目留着的旧正文；`module.read` 读「下面的条目」模块时返回和 `entry.get` 的 `below` 一样的内容 |
| `module.set_field`、`put_kv`、`edit_kv`、`remove_kv`、`put_patch`、`edit_patch`、`remove_patch`、`put_grid`、`put_relation`、`remove_relation` | 不变 |
| `membership.add` | 宿主必须活着、开关开着、解析后收别处的条目；不看成员的模板 |
| `membership.list`、`remove`、`primary`、`restore` | 不变（`list` 只给有效的，有效的定义跟着上一行变） |
| `timeline_view.put`、`add_lane` 等 | 泳道检查改成「开关开着、`lane` 为真」；其余不变 |
| `writing_day.record`、`book.writing_days` | 写、读 `stats:<书>`（第 8 节）；名字、入参、输出不变 |
| `entry_snapshot.*` | 清单写、读 `checkpoints:<书>`（第 8 节）；名字、入参、输出不变 |
| `book.shelf` | 字数从成书序列算（第 7 节） |
| 其余（批注、素材、关系、设定、记忆、历史、正文、最近） | 不变 |

通用命令注册时带的 `BOOK_VERSION`（`op!` 宏里写死的 `Some(3)`，读写命令都有）改成 4，并改成引用书目版本常量。

**守卫声明表**（[f3-write-guards.md](foundations/f3-write-guards.md)「每类命令守什么」）要改的行：

| 命令 | 现在 | 改成 |
| --- | --- | --- |
| `entry.set_level` | — | 第 3 节的两种 |
| `entry.update` | 点了名的 `title`、`template`、`overrides`、`layout` | 不变 |
| `level.get` 的记录（帮手的 `level:<id>`） | `entries/<id>` 加子条目顺序 | 并进 `entry:<id>`：读了 `below` 的，背后是 `entries/<id>` 加 `children_of(<id>)`（帮手记账这一半留给 T3） |
| `writing_day.record` | 无（书目） | 不写书目；调用方带来的书目前置条件在写统计文档之前比对 |
| `entry_snapshot.*` | 整篇版本，走 `check_atomic_guards` | 同左；存点不再推进书目版本，清单文档不参加守卫 |

### 帮手拿到的结构说明（`BOOK_STRUCTURE.json`）

- 模板摘要：去掉 `kind`，加 `level`（「新条目默认能放子条目」）、`linkable`、`lane`；模块里可以有任何种类，`说明` 就是一个普通的正文模块。
- 根摘要的 `kind: level/leaf` 换成 `level: bool`。
- `levels` 列表照旧叫 levels（= 开着开关的条目），每项的 `lane` 来自解析后的设置；`effective_settings` 去掉 `allow`。
- 小说模板里写给帮手的说明，凡是「说明正文保存在 `body:<条目 id>/about`」的句子改成「说明写在本条目的『说明』正文里」；「叶子」「层级模板」字样去掉。
- 结构修订号的前缀从 `k6-structure-v3` 换一个新的，免得帮手把旧缓存当新的。

### 工具目录（帮手和 MCP 共用）

工具目录照旧从命令注册表生成，加上这本书模板里声明的动作：

- 少 `level.get`；多 `entry.set_level`（开放给帮手，靠写前快照和撤销兜底）。`entry.get`、`entry.list` 的输入输出 schema 变了。
- 动作：只在开着开关的条目上绑定；删诊断 `leaf_template_verb`；`invalid_membership_binding` 去掉模板限制和「泳道只收叶子」那一半。
- 记账（`dr-agent-tools/src/records.rs`）：`level:<id>` 这种 subject 留着，改由带着「下面」读到的 `entry.get`、`entry.list {below}` 记，背后是条目记录加 `children_of(<id>)`；「下面」里每个归属进来的条目记成那一条归属（第 14 节 T3）。
- 写前快照选条目：`entry.set_level` 关掉时，选这个条目和它的直接子条目。
- MCP 没有自己的一套：它暴露的就是这个目录，变化跟着走；注册表快照、能力清单、MCP 的 schema 快照由现有生成器重新生成，不手改。

## 7. 整书视图需要的读取接口

这一步只定接口和语义，视图本身是后面的轨道。

```rust
// dr-doc，挂在一次读出来的结构快照（现在叫 BookStructureV3）上
pub struct FlatEntry<'a> {
    pub entry: &'a Entry,
    /// 出发点是 0，它下面一层是 1，依此类推。
    pub depth: u32,
    /// 这个条目自己的正文，按模板里模块的顺序；没有模板就没有。
    pub prose: Vec<FlatProse>,
    /// 只在成书序列里有：带着成书正文的条目从 1 起编号。
    pub ordinal: Option<u32>,
}
pub struct FlatProse {
    pub module: ModuleId,
    pub name: String,
    pub doc: DocId,
    pub in_book: bool,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flatten {
    /// 只给 `in_book` 开着的正文。
    pub in_book_only: bool,
    /// 每个层级在住在下面的条目之后，再摊开归属进来的条目（作者 2026-11-13
    /// 定：「挂名的也算」）。整书视图默认打开。
    pub include_members: bool,
}
impl BookStructureV3 {
    /// 从 `from` 出发（它必须活着、开关开着），先序走下面的条目。
    pub fn flatten(&self, from: &EntryId, how: Flatten) -> Result<Vec<FlatEntry<'_>>, NotALevel>;
    /// 每个最外层成书层级一份，按它们在树里的先后；`in_book_only` 恒为真，
    /// 不带归属（`include_members` 恒为假），带编号。
    pub fn manuscript(&self) -> Vec<ManuscriptPart<'_>>;
    /// 成书序列里全部正文文档，按顺序。
    pub fn manuscript_docs(&self) -> Vec<DocId>;
    /// 成书序列里带成书正文（有编号）的条目，按顺序，自有拷贝。
    pub fn manuscript_entries(&self) -> Vec<Entry>;
    /// 一个条目在成书序列里的编号。
    pub fn ordinal(&self, id: &EntryId) -> Option<u32>;
}
pub struct ManuscriptPart<'a> {
    pub root: &'a Entry,
    pub entries: Vec<FlatEntry<'a>>,
}
/// `flatten` 的出发点不是开着开关的活条目。
pub struct NotALevel(pub EntryId);
```

这些类型都在 `dr_doc::v3` 下导出（`BookStructureV3`、`FlatEntry`、`FlatProse`、`Flatten`、`ManuscriptPart`、`NotALevel`）；结构快照从 `BookViewV3::structure_snapshot()` 取。

**语义：**

- 出发点自己排第一（它自己的正文在最前），然后先序走：每个条目先给出自己的正文，再走它下面的条目。
- 一个层级「下面的条目」：先是住在下面的（文稿顺序）；`include_members` 打开时，再是归属进来的（按归属自己的 `pos`，平局按 id）。只算有效的归属：宿主活着、开关开着、解析后收别处的条目。走到的每个条目照同样的规则递归。
- 同一个条目在一次摊平里只出现一次，在第一次走到的位置；归属可以绕成环（A 归属到 B、B 的住处在 A 下），用已访问的集合挡住，不会重复也不会死循环。归属进来的条目的 `depth` 是宿主的加一。
- 整书视图默认带归属（作者 2026-11-13 定，见第 13 节问题 5）；成书序列、导出、全书字数、章节编号只按住处，`manuscript()` 不带归属。
- 放进回收站的条目连同下面的都不出现；合并后挂在开关关着的条目下面的，按第 5 节的读法出现在最近一个开着开关的祖先下面，和左栏的树一致。
- 没有正文的条目也出现（`prose` 为空），让视图能画出它的标题和层次，比如「第一卷」。
- 只给模板里的正文模块；换模板以后留着的旧正文不在序列里（它们在条目页的「原来的内容」里）。
- `ordinal`：在 `manuscript()` 里，所有成书部分连着编，只给至少有一篇成书正文的条目编号。默认结构下就是现在的「第 N 章」。

**谁怎么用：**

| 用处 | 怎么用 | 现在的代码 |
| --- | --- | --- |
| 全书字数、字数目标、书架上的字数 | `manuscript()` 里所有正文的字数之和 | 2b 已改：`dr-view-stats/src/v3.rs`、`dr-workspace/src/commands/book.rs`（`book.shelf`）、`dr-cli/src/inspect.rs` |
| 导出 | 选一个成书部分（有几个时作者选），有成书正文的条目各成一章，标题是条目标题，内容按模块顺序接起来；没有成书正文的条目不出现（第 13 节问题 2） | 2b 已改 `dr-export/src/v3.rs` 的 `outline`（几个部分接在一起，「作者选」留给 T5） |
| 章节编号、页眉 | `ordinal`；有编号的条目页显示「第 N 章」，没有的显示模板名 | `dr-editor/src/v3.rs` 的 `page_infos`：编号已改用成书序列，页面种类还按 `tpl-chapter`/`tpl-idea` 认（T1、T7） |
| 整书视图 | `flatten(从哪个层级出发, Flatten { in_book_only: true, include_members: true })`；从一条故事线出发能读到挂在线上的章节，顺序是线上的顺序。出发点是成书层级时，住在下面的部分和导出看到的一样（书稿通常不收别处的条目，就完全一样）。要不要给视图一个「也显示说明」的开关，留给视图那一路 | `dr-editor/src/v3.rs` 的 `manuscript_docs`：2b 改成 `manuscript()`，换成 `flatten` 是 T7 |
| 帮手的长任务 | 「书的正文」= `manuscript()` | 2b 已改 `dr-agent/src/long_task/store.rs` |
| 书架封面 | 同全书字数 | 2b 已改 `dr-view-shelf-art/src/cover.rs`（读外壳的 `manuscript`） |

原来各处各写了一遍「成书层级下的叶子」；2b 以后只有这一个接口算成书序列（契约 `MANUSCRIPT-OWN-PROSE-FIRST` 守它），`BookViewV3::manuscript_leaves` 删了。带归属的摊平由契约 `FLATTEN-MEMBERS-ONCE` 守：故事线上摊平读到挂在线上的章节、顺序是线上的顺序；环和重复不出现两次；`manuscript()` 不受归属影响。

## 8. 写作日和快照点清单外移

底稿是分支 `chihumyum/next-side-docs` 上的 `foundations/f2-side-docs.md`（按「新旧并读」写的，暂缓）。这里是去掉并读以后的干净版本，合进同一次格式改动。底稿里的现状、事件分析和量过的数仍然有效，不再抄；下面只写定下来的做法和和底稿不一样的地方。

### 两篇小文档

| | 统计文档 | 清单文档 |
| --- | --- | --- |
| id | `stats:<书>` | `checkpoints:<书>` |
| `DocId` / `DocKind` | `DocId::Stats(BookId)` / `DocKind::Stats` | `DocId::Checkpoints(BookId)` / `DocKind::Checkpoints` |
| 登记 | `kind = "stats"`，`book_id = <书>` | `kind = "checkpoints"`，`book_id = <书>` |
| `meta` | `v = 1`、`doc = "stats:<书>"` | `v = 1`、`doc = "checkpoints:<书>"` |
| 内容 | 根映射 `writing_days`：`"<设备>\|<日期>"` → 字数（键和值照旧） | 根映射 `entry_checkpoints`：快照点 id → 格式 1 的清单 JSON（照旧） |
| 谁写 | 各设备只写自己的键 | 每个 id 写一次；修剪删键 |
| 是不是正文 | 不是：`is_book_text` 为假，没有编辑配置 | 同左 |

- 创世确定（`meta` 两个键，创世对等方由文档 id 和创世版本 1 算出，时间戳 0），两台设备各自建出来是同一份变更。
- **建书时就建好**：`project.create`、导入 0.1、样书、种子、书文件导入都同时建这两篇。所以快照点的原子事务里，清单文档总是已经在了。只有一种例外：别的设备同步来一本书，书目到了而清单文档还没到时本机要存点，这时在原子事务之前照创世建出来（和对方建的是同一份）。底稿里「清单文档第一次创建不在原子事务里」的问题因此只剩这个短暂窗口，而那时建出来的只是创世。
- 没有旧根、没有合并函数、没有 `legacy_` 前缀的读写、没有「旧构建写旧根」的情形：书目文档里根本没有这两个根。

### `dr-doc` 接口

新模块 `dr_doc::side`：两种文档各一套和书目文档同形的持有、借用、读、写（`StatsDoc`/`BorrowedStats`/`StatsView::writing_days`/`StatsTxn::writing_day`，`CheckpointsDoc`/`BorrowedCheckpoints`/`CheckpointsView::entry_checkpoints`/`CheckpointsTxn::put_entry_checkpoint`、`remove_entry_checkpoint`），加两个创世函数。书目视图和事务上的 `writing_days`、`writing_day`、`entry_checkpoints`、`put_entry_checkpoint`、`remove_entry_checkpoint` 删掉。`owns_prose` 加两支：小文档属于 id 里的那本书。

### 命令

- `writing_day.record`：照旧取书的租约、确认书在；值没变就不写；否则只往统计文档提交一次。书目文档不被写。不进撤销日志。
- `book.writing_days`：每日目标从书目 `meta` 读，写作日从统计文档读。
- `entry_snapshot.create` / `create_with_receipt` / `capture`：原子事务预留「书目 + 这个条目的全部正文（+ 要抄默认正文的模板文档）+ 清单文档」。书目只读不写（读版本和条目状态算指纹，`book_version` 就是这时书目的版本）；清单写进清单文档，修剪也只动它。书目更新为空，不发 `WsEvent::Book`。回执里书目的版本不变。
- `entry_snapshot.restore`：同一个原子事务里恢复书目和正文、往清单文档写恢复点；在预留的拷贝上再确认一次要恢复的那个点还在（以前靠书目整篇版本顺带保证）。`expected` 只含书目和正文。
- `entry_snapshot.list` / `preview`、`entries_due_for_capture`：清单从清单文档读。
- 删掉旧指纹兼容（`content_hash_with_siblings` 和它的测试）。

### 事件

`WsEvent` 加 `Stats { book, seq, origin, days }` 和 `Checkpoints { book, seq, origin, points }`；`on_store_event` 给两种小文档各一支，只发自己那一种，不发 `Book`、不发 `Prose`。书目文档里不再有这两样，11-12 加的 `BookChanged.touched` 分类就没有用了：删掉，所有 `Book` 事件都是内容变了。原来看 `touched.writing_days` 的统计标签、书架、作品主页改听 `Stats`；历史对话框新加听 `Checkpoints`（它现在不自动刷新）。

### 客户端里认文档种类的地方

底稿的表在本分支的基点（`41b5c3100`）上逐条核对过，位置都还在：

| 在哪 | 要做什么 |
| --- | --- |
| `dr-model/src/id.rs` 的 `DocId::parse`、`DocKind`（`ALL`、`prefix`、`is_book_text`、`profile`） | 加两种 |
| `dr-doc` 的 `BookViewV3::owns_prose` | 加两支（穷举 `match`，编译会逼） |
| `dr-store/src/index.rs` 的 `KNOWN_DOC_KINDS` | 补两项（只有测试在用） |
| `dr-workspace/src/workspace.rs` 的 `on_store_event`（1465 行） | 两个新分支 |
| 同文件 `import_remote_inner`（953 行） | 两种小文档各一支，不走 `prose_slot` |
| 同文件 `release_idle_doc_for_remote_purge`（728 行） | 放掉空闲的小文档槽位 |
| 同文件 `purge_book`（1009 行）、`close_slots`（334 行）、`before_quit`（370 行） | 关掉、清除小文档槽位 |
| 同文件 `library_options` 的 `validate_import`（57 行） | 不加：小文档不做导入校验，读的一方本来就容错。书目这一支把「还是 3」改成「还是 4」 |
| `observe`、`version`、`prose_slot`、守卫解析 | 不动（小文档不参加守卫） |
| `dr-export/src/book_file.rs` 的 `import_book` | 创世按种类选，加两支 |
| `dr-export/src/book_file/v3.rs`（217、613–614 行靠 `is_v3_doc` 和 `conversation:` 前缀嗅探） | 改成按文档 id 的种类选改写方式；清单文档的键（快照点 id）换新 id、值换成改写后的清单；统计文档只换 `meta.doc` |
| `dr-export/src/book_file/v3/checkpoints.rs`（72 行在书目的 `entry_checkpoints` 里找清单） | 改到清单文档的历史里找；核对和改写规则不变 |
| `dr-agent/src/evidence.rs`（277、289 行按种类分支） | 加一支跳过 |
| `dr-agent-tools/src/resolve_v3.rs` 的文档选择器 | 拒绝两种小文档（同对话） |
| `dr-view-history/src/automatic.rs`（112 行只认正文和书目） | 不动；自己存点不再变成书目事件绕回来 |
| `dr-sync/src/engine.rs`（327、362 行 `book:` 开头的先传） | 不动 |
| `dr-workspace/src/events.rs` 的 `BookTouched`、`book_touched` | 删 |
| `dr-model/src/invariant.rs` | 第 5 节的契约 |

### 快照点的原子性，改前改后

| 保证 | 改前（v3） | 改后 |
| --- | --- | --- |
| 存点全有或全无 | 补建的默认正文和清单在一个 SQLite 事务里 | 同一个事务，清单落在清单文档；清单文档建书时就有 |
| 清单里的版本是同一刻的 | 书目和各篇正文同时预留 | 不变；书目照旧预留，只是不写 |
| 内容没变不重复存，`periodic` 不满 15 分钟不存 | 和这个条目最近一个点比 | 不变；只在清单文档里找 |
| 过期的调用不留快照 | 预留之后、写之前比对 | 不变；清单文档不在比对范围里 |
| 预览不写任何东西 | 一次只读的原子预留 | 不变 |
| 恢复是跨书目和正文的原子命令，恢复前存恢复点 | 书目、正文、恢复点一个事务 | 不变，事务里多一篇清单文档 |
| 预览之后条目变了就拒绝恢复 | 书目整篇版本和各篇正文版本都要等于 `expected` | 不变；书目版本现在只被改内容的提交推进，预览和恢复之间来一次写作日或别的条目存点，不再让恢复白白失败 |
| 要恢复的点还在 | 书目整篇版本顺带保证 | 在预留的拷贝上显式查 |
| 自动点会修剪，作者存的、帮手存的、恢复点不修剪 | 每次存自动点时修剪 | 不变，作用于清单文档 |
| 写作日不进撤销；各设备互不覆盖 | — | 不变 |
| 彻底删除一本书不留东西、不碰别的书 | 按书列文档逐篇清除 | 不变，多两篇 |

### 和底稿不一样的地方

- 不并读、不留旧根：底稿的合并规则、「旧根里的自动点不修剪」、新旧构建并存一节、问题 2/3/4/10 都不需要了。
- 书文件只读 4：底稿是「读 3 和 4」。
- 两篇文档建书时就建：底稿是第一次写时才建，因此有「清单文档第一次创建不在原子事务里」。
- `touched` 分类删掉：底稿写在 quiet-book-events 之前，那时还没有它。
- 老化模型不留「旧布局」开关：改前的数已经记在 [history-aging.md](spikes/history-aging.md)，不为对照保留两套写法。
- 底稿的问题 5（写作日落盘间隔）、7（历史对话框订阅：加）、8（空索引行：照旧）、9（书架不开书目：另一项工作）按底稿的倾向办，不再问。

## 9. 模板 id 换成角色

在基点上 `grep -rn '"tpl-' next/crates --include='*.rs'` 的结果核对过一遍：任务书点名的地方里，`dr-shell` 的 `outline.rs`/`sidebar.rs`、`dr-view-review/src/panel.rs`、`dr-store/src/index.rs`、`dr-workspace/src/cooccurrence.rs`、`dr-workspace/src/commands/v3/snapshots.rs`、`dr-view-templates`（`preview.rs`、`view.rs`）、`dr-view-plot/src/v3.rs`、`dr-view-agent/src/data.rs`、`dr-view-history/src/automatic.rs`、`dr-agent-tools/src/executor.rs` 的命中**全在 `#[cfg(test)]` 的测试模块里面**（逐个核对过模块的起止行），是测试拿内置模板造数据，不是产品逻辑。真正在产品代码里按模板 id 认东西的是下面这些：

| 在哪 | 现在按什么认 | 改成按什么认 |
| --- | --- | --- |
| `dr-editor/src/v3.rs`（159–160 行）页面种类 | `tpl-chapter` → 章节页，`tpl-idea` → 构想页 | 成书序列里有编号的条目 → 「第 N 章」页眉和章末 ⁂ 的动作；其余显示模板名。章末「标为完成」用模板字段模块的 `status_field`，「新建下一章」= 在后面用同一个模板新建 |
| `dr-view-page` 的 `head.rs`/`end.rs` 里按 `PageKind::Chapter`/`Idea` 分支 | 跟着上一行 | `PageKind` 收成「成书里的条目（带编号）」和「其他（带模板名）」两种；「无标题」占位用模板名 |
| `dr-view-transfer/src/documents.rs`（161–162 行）导入文档的目标列表 | `tpl-storyline`、`tpl-category` | 列出所有开着开关的条目作目标（按树显示路径）；新条目用目标解析出的默认模板 |
| `dr-export/src/import/write.rs`（254–257 行）导入文档的落点 | `TPL_MANUSCRIPT`、`TPL_IDEAS`、`TPL_ELEMENTS` | `ImportTarget` 改成直接给一个层级条目 id（上一行的对话框选的）；不再有「章/构想/要素」三种目标 |
| `dr-view-timeline/src/v3/write.rs`（337、371 行）新建幕轨道 | 按 id 找 `tpl-act-track`，没有就用 `act_track_template` 建 | 「幕」模板随小说模板建好；新建幕轨道时在「新条目默认开着泳道的模板」里选（按数据认，不按 id），选中的建在根上并加进视图、标为幕轨道 |
| `dr-shell/src/book/v3.rs`（183 行）条目颜色 | 模板 `kind == "leaf"` 时取主泳道的颜色 | 条目自己的颜色字段有值就用；没有再取主归属泳道的颜色。不看开关 |
| `dr-view-shelf-art/src/cover.rs`（101 行） | 模板 `kind == "leaf"` | 用成书序列 |
| `dr-view-timeline/src/v3/model.rs`（36 行）、`render.rs`（190、374 行）、`dr-view-elements/src/storyline.rs`（40 行） | `kind == "level" && lane`、`allow` | 解析后的「开关开着且 `lane`」；`allow` 的显示删掉 |
| `dr-view-elements`（`data.rs`、`category.rs`、`dialogs.rs`、`panel.rs`） | `kind` 过滤模板、「允许的模板」设置项 | 模板不再分种类；删掉「允许的模板」 |

可以留着认内置模板 id 的地方：`dr-doc` 的小说模板模块本身（它就是定义它们的地方）、`dr-import-v1` 和 `dr-samples`（它们按小说模板建书）、`dr-testkit`（种子和验收工具）、`project.create`（照小说模板建书），以及所有测试。测试和种子统一用 `dr_doc::…::novel` 里的常量，不写字符串。门禁按这个清单放行（第 11 节）。

`dr-cli/src/scenario.rs` 第 10 行是文档注释里的示例场景，跟着改写法；`dr-import-v1/src/v3.rs` 768 行（按 `TPL_GROUP` 认分组）在导入器里，允许。

## 10. 导入 0.1、样书与种子、书文件、Markdown 文件夹、同步

**导入 0.1（`dr-import-v1`，经 `dr-samples` 的 `v3` 转换）：**

- 原来是层级的（书稿、构想、构想分组、要素、分类、分组、故事线列表、故事线、「幕」泳道、「未归属」泳道）建成开关开着的条目；章节、构想、要素建成开关关着的条目。开关取模板默认值，和新建书一样。
- 分类说明、故事线说明原来写进 `body:<条目>/about`，改写进 `body:<条目>/mod-description`（`dr-samples/src/v3/mod.rs` 81、133–134 行，种子同理）。
- 每个分类生成的要素模板、故事线的章节模板照旧；生成时不再写「允许的模板」（`dr-samples/src/v3/catalog.rs` 607、679 行），导入后的结构校验（同文件 1051–1092 行）改按开关判断，不再查 `allow`。
- 策略 22（幕轨道）：「幕」模板已经在小说模板里，导入不再另建；泳道条目「允许模板不限」这句没有对应物了，删掉。策略 23、25 不变。
- 写作日写进统计文档：导入对等方由 `stats:<书>` 算出，来源 `Import`，一次写完；源库没有写作日也建这篇（只有创世）。存储顺序：正文、两篇小文档、书目。导入 0.1 不产生条目快照点，清单文档只有创世。
- 导入的新库目录前缀 `reimport-v3-` 改成 `reimport-v4-`（`dr-view-import/src/reimport.rs`）；旧前缀的未完成目标照旧保留不动、拒绝续导。

**样书与种子（`dr-samples`、`dr_testkit::seed`、老化模型）：**

- 两本样书走同一个转换，跟着上面变。
- 种子各档（tiny / lite / heavy / showcase）生成 v4：`level` 开关、`说明` 模块、两篇小文档；种子摘要（`digest_v3`）把两篇小文档算进去；`seed:v3-<preset>` 别名删掉，只留 `seed:<preset>`。
- 老化模型（`aging/book.rs`）的写作日和存点写进两篇小文档，提交按落在哪篇文档分开计；`bench book-aging` 的项目跟着分文档报。不留旧布局开关（第 8 节）。
- `bench/v3_levels.rs` 改用 `entry.list` 的 `below`。

**书文件（`.driftingbook`）：** 格式 4，只读 4。导出按书列文档，两篇小文档登记在书名下，自动带上；导入时按种类选创世和改写方式（第 8 节的表）。

**Markdown 文件夹（`dr-mirror`，M40）：** 这次不为它做任何事。作者 2026-11-13 定：Markdown 投影的结构也该随着条目的新层级来变，更灵活；2026-11-11 定的七组规则（[m40-markdown-folder-v3.md](modules/m40-markdown-folder-v3.md)）不再当作前提，M40 恢复时按新的条目树重新设计。H1/H2/H3 只是正文内部的结构（作者第 4 条），这一条不变。

**同步：** 核实过，不用改协议和服务端。`dr-sync` 只把文档 id 和种类当字符串：上传时 `book:` 开头的排前面（`engine.rs` 327、362 行），整本清除按书名下的文档；两篇小文档登记在书名下，跟着走。另一台设备收到小文档时只是往一篇小文档里并一次更新，不再校验整份书目（底稿量过改前：三年的书导入一次写作日约 78 毫秒，大头是整份书目的校验；改后预计不到 1 毫秒，没量过）。一条提醒：服务端的 `loro-v2` 还没部署（progress「等作者的事」第 1 条）。建议在 v4 合进 `main` 之后再部署；先部署的话，开发期往上面传过的 v3 书在新设备上会一直被导入校验拒绝，需要换命名空间或清掉。

## 11. 门禁和文档

**门禁（`cargo xtask check`）：**

- `v3-cutover` 改名 `cutover`（`next/xtask/src/gates/mod.rs` 71 行，`cutover.rs`）。加：
  - 退役命令表加 `level.get`、`level.list`（它也扫场景 JSON，所以 `dr-cli/scenarios` 里调这两条的场景要跟着改，比如 `k4-g2-levels.json`）。
  - 产品代码不许引用小说模板模块（`novel::` 的常量和函数）、不许写 `"tpl-` 开头的字符串；放行第 9 节末尾那几处和测试路径。这一条要等第 9 节的产品代码改完才能打开（见第 12 节的收尾一步）。
  - 退役路径表加上删掉的文件（如果数据层删了整文件）。
- `terms`：产品字符串里不许出现「叶子模板」「层级模板」「leaf template」「level template」。「层级」本身照用。H1/H2/H3 的规则不变。
- `migrations`：不动。文档种类在 SQLite 里是自由字符串，不需要 SQL 迁移；`dr-store` 的已发布迁移不碰。
- `evidence`：数据结构变了，提交的几份测量证据会多报过期，照旧不在这一路重测。
- 根目录：`pnpm public:check`、`pnpm ci:contract:check` 不受影响；`next/` 的界面文案键删改（「允许的模板」「层级模板」「叶子模板」等）以后，如果语言证据覆盖 `dr-i18n`，要重新生成（`pnpm locales:check` 那一套），不手改。

**文档里要改的话：**

| 文件 | 改什么 |
| --- | --- |
| `AGENTS.md` | 「`next/` runs canonical v3 only (`docs/rust-rewrite/v3-cutover.md`)」改成 v4 和本页；检查列表里「canonical v3 cutover (`v3-cutover`)」改名并加上「产品代码不按内置模板 id 认东西」；默认大纲那句（书稿 / 章 / H1 / H2 / H3）不变 |
| `next/README.md` | 核对过，没有写 v3 或层级/叶子的地方，不用改 |
| `docs/rust-rewrite/kernel-v3.md` | 这一次只在最前面加一句指向本页 |
| `docs/rust-rewrite/loro-schema.md` | 开头那段；「文档和它们的 id」表（删 `about` 那半行，加两篇小文档）；版本号和创世两节（书目 4）；「书目文档 v3」整节换成 v4（根容器表照第 4 节、id 表、「层级、模板和模块」「归属与时间线」两段）；「版本」加「v3 → v4」一条；v2.2 那几节注明是导入时内存里的源格式（`import_v1` 还在用），不删 |
| `docs/rust-rewrite/v3-cutover.md` | 开头的「切换之后变了的」加一条：格式升到 4，v3 的书照本页对旧书的政策拒开 |
| `docs/rust-rewrite/progress.md`（监管会话改） | 「现在跑的是什么」的「只运行 canonical v3」；基座表 K1+K2 行；M04、M05、M11、M13、M16 的「层级」说法；M21、M40、整书视图的「等新的层级结构」；「技术上还开着」里写作日和快照点清单外移那两条；「作者定下的」加 11-13 的决定 |
| 各模块文档（各轨道合入时改） | f1、f3-workspace（事件、命令）、f3-write-guards（守卫表）、f8-testkit（种子、门禁名）、m05、m07、m09、m10、m11、m13、m14、m16、m20、m25、m29、m36、m40、m41、k4-ui、k5、k6、`spikes/history-aging.md`（文末加「挪出之后」） |

## 12. 实现步骤

### 第 2 步：数据层（一个会话，下面两段各自提交、各自全绿）

**2a 两篇小文档和版本 4。** 和条目模型无关，先做，格式版本在这里升。

- `dr-model`：`DocKind`/`DocId` 两种；书目版本常量。
- `dr-doc`：`side` 模块；书目去掉两个根和对应读写；`meta.v = 4`、创世 4；`is_v3_doc` 等改名（第 4 节第 1 半）。
- `dr-store`：`KNOWN_DOC_KINDS`。
- `dr-workspace`：小文档槽位与生命周期；`writing_day.record`、`book.writing_days`、`entry_snapshot.*`、`project.create` 建两篇文档；事件 `Stats`、`Checkpoints`，删 `touched`；`validate_import` 认 4；删旧指纹兼容。
- 让工作区编译、测试通过的最小改动：`dr-export` 书文件 4、`dr-import-v1`/`dr-samples` 写统计文档、`dr-testkit` 种子和老化模型、`dr-view-stats`/`dr-view-shelf`/`dr-view-home` 改听 `Stats`、`dr-view-history` 对话框听 `Checkpoints`、`dr-agent` 证据跳过、`dr-view-import` 目录前缀。
- 契约：`SIDE-DOC-NOT-PROSE`、`SIDE-DOC-QUIET`、`BOOK-FORMAT-4-ONLY`；改 `WRITING-DAY`、`NO-HOT-FIELDS`、`V3-DOCID-LIBRARY-UNIQUE`。
- 回归测试：底稿第 1–5 步的回归测试去掉并读的那些；要改夹具的现有测试（用 SQL 触发器拦 `book:%` 来模拟存点失败的，改拦 `checkpoints:%`）照底稿那张表；`v3_common.rs` 的 `writing_days_dispatch_…` 改期望为「书目一点没变，写作日在统计文档里」；书文件版本 3 的那几条测试改成「版本 3 被拒、不写任何东西」。

**2b 一种条目。** 定下各轨道要用的接口。

- `dr-model`：`Entry::level`、`EntryTemplate { level, linkable, settings(含 lane), … }`、删 `TemplateKind`/`allow`/`about` 常量和第 2 节「消失」表里的函数；`ModuleKind::Children`、`ModuleConfig::in_book`；检查函数改按开关；`is_autolinked`；`book_doc_ids` 不再列 `about`。
- `dr-doc`：读写 `level`、`linkable`、`lane`、`in_book`；读模板不再丢模块；`EntriesTreeWriter::create` 带开关；关开关的事务原语（挪直接子条目到顶层祖先后面、写开关，返回挪了谁）；结构快照的 `flatten` 和 `manuscript`；小说模板 v4（各模板的 `level` 默认值、`linkable`、「说明」模块、去 `allow`、`lane` 进设置、「幕」模板随模板建）。
- `dr-workspace`：第 6 节的命令表（含 `entry.set_level` 和它的守卫声明、撤销登记）、`types.rs` 的 DTO、`level.*` 并进 `entry.*`、注册表和能力清单重新生成；`graph_ok` 换成第 5 节「只拒绝新造成的违规」的改前改后比较，各命令不再为它读全书的完整条目；写任务里按 id 找树节点、`BookViewV3::entry(id)` 按第 5 节改。交回时附 `entry.update`、`module.set_field` 改后的中位数。
- 帮手一侧的 `resolve_v3`、工具目录 `catalog.rs` 的整本拷贝和反复解码，留给 T3，这一步只做编译需要的改动。`dr-store/src/library.rs` 的 `load_into` 和 `dr-agent-tools/src/checkpoints.rs` 的 `entries` 由并行的小修（分支 `chihumyum/next-agent-copy-costs`）改，这一步除了编译必须的改动不重写它们。
- `dr-testkit`：种子各档按新模型；`v3_levels` 基准；契约第 5 节其余各条和它们点名的测试。
- 让工作区编译、测试通过的最小改动（每处都列进交回报告的「缺口」）：界面里按 `kind`/`allow`/`about` 写的分支换成按开关和模块；`level.get` 的调用方换成 `entry.get`；`manuscript_docs`、`outline`、统计、书架封面、长任务换成 `manuscript()`；帮手工具的目录、记账、结构说明跟着命令变；导入 0.1 和样书按第 10 节（因为种子、样书的测试依赖它们，这一半必须在 2b 里做对）；场景 JSON 里调 `level.get` 的改掉。

2b 是一次跨全工作区的类型变更，中间提交编译不过；按 crate 分几个提交，交回时只声称最后一个提交全绿。

### 第 2 步之后可以并行的轨道

| 轨道 | 动哪些 crate | 依赖数据层的哪个接口 | 和谁碰同一批文件 | 回归测试 |
| --- | --- | --- | --- | --- |
| T1 外壳与条目页 | `dr-shell`（左栏树、页面组装、大纲、颜色）、`dr-view-page`（开关和确认、「下面的条目」模块、页眉）、`dr-view-elements`、`dr-view-element-overview` | `Entry::level`、`entry.set_level`、`entry.get` 的 `below`、`ModuleKind::Children`、去 `allow` 的设置 | `dr-shell` 和 T7 都碰（T7 只加一个入口，排在 T1 之后合） | 开关开关、确认后子条目到位、撤销一步回去；没有「下面的条目」模块的模板排在最后；设置面板没有「允许的模板」 |
| T2 模板编辑器 | `dr-view-templates` | 模板的新形状、`linkable`、`in_book`、`lane` 进设置 | 无 | 不再选种类；任何模块都能加；默认开关关着时「下面」的设置收起但值留着；每篇正文模块都露出 `in_book` 开关（管字数和导出） |
| T3 帮手工具与 MCP | `dr-agent-tools`、`dr-agent`（证据、长任务）、`dr-mcp`（快照）、`dr-view-agent`（口述的名字上下文） | 命令表、注册表、`manuscript()` | 无 | 目录里没有 `level.get`、有 `entry.set_level`；关开关前对条目和直接子条目存写前快照；结构说明没有 `kind`/`allow`；动作只绑在开着开关的条目上 |
| T4 导入 0.1 收尾 | `dr-import-v1`、`dr-samples`、`dr-view-import` | 小说模板 v4、两篇小文档 | 无（正确性部分已在 2a/2b） | 合成库真窗口导入；导入报告的说法；`reimport-v4-` 续导 |
| T5 导出与书文件 | `dr-export`、`dr-view-transfer` | `manuscript()`、`in_book`、按层级 id 的导入目标 | 无 | 中间层级的说明不进导出；有几处成书时选择；导入文档落到选中的层级 |
| T6 统计与小文档的界面 | `dr-view-stats`、`dr-view-shelf`、`dr-view-shelf-art`、`dr-view-home`、`dr-view-history` | `Stats`/`Checkpoints` 事件、`manuscript()` | 无 | 写作日只叫醒统计、书架、主页；历史对话框随存点刷新；封面字数和统计一致 |
| T7 整书视图 | `dr-editor`（`book.rs`、`v3.rs`）、`dr-shell` 的入口 | `flatten`（`include_members: true`） | `dr-shell` 和 T1 | 从任意层级打开；条目自己的正文在下面的条目之前；从故事线打开能读到挂在线上的章节；旧「纵览全书」入口退役；阅读位置照旧 |
| T8 按模板 id 认东西的收尾与时间线 | `dr-view-timeline`、第 9 节表里剩下的点 | 解析后的 `lane`、`flatten` 的编号 | 第 9 节的点分别落在 T1、T5、T7 的 crate 里，由那几路各自改；T8 只管时间线和最后打开门禁 | 新建幕轨道不按 id；`cutover` 门禁的「产品代码不认内置模板 id」打开后全绿 |

所有界面轨道都会碰 `dr-i18n` 的文案文件，这是唯一的共同热点：每路只加删自己的键，合并时由监管会话依次合、合一路重新生成一次语言证据。

**收尾（所有轨道合完以后）：** 打开 `cutover` 门禁的模板 id 规则；第 4 节的纯改名一路；文档表里剩下的改动；真窗口全流程冒烟。

每一步交回前照任务书跑全套检查。会红的只有一种情况：2b 中间的提交（上面写了）。各轨道之间不会互相弄红，因为数据层接口在 2b 定死，轨道只改自己的 crate。

## 13. 作者的答复与还没定的

2026-11-13 白天监管会话问了作者，答复如下。已定的照做，正文相应各节已经改过。

**作者已定（2026-11-13）：**

1. **开关在界面上叫「层级」**，旁边一行小字说明（「打开后下面能放条目」）。
2. **成书开关按正文模块各自一个。** 一个条目里可以有一篇或多篇正文，每一篇各自决定是否参与统计和导出，就是 `in_book`（一个开关同时管全书字数、导出、章节编号）。模板编辑器里每篇正文都露出这个开关。小说模板里的「说明」默认关着，其余正文默认开着。
3. **导出时，自己没有成书正文的中间层级（比如「第一卷」）的标题这一轮不出现**，和现在一样；以后在导出选项里加。
5. **整书视图从收别处条目的层级出发时，挂名的也算。** 读取接口和语义见第 7 节：`flatten` 的 `include_members`，整书视图默认打开；成书序列、导出、字数、编号只按住处。
6. **新书的模板列表里多一个「幕」模板：可以。**
7. **Markdown 文件夹先不定。** 原来的七组规则不再当作前提，M40 恢复时按新的条目树重新设计（第 10 节）。

**还没定：**

4. **「下面的条目」是一个可以在模板里摆位置的模块，还是固定排在条目页最后；它要不要更多的显示方式。** 作者说先不动：显示照旧是列表、网格、看板、岛屿四种，不加新的取值。不等答复：做成模块（`children`），模板里没有它而开关开着时排在最后。

## 14. 数据层交回：留给各轨道的缺口

2b 交回时写（2026-11-14）。数据层（`dr-model`、`dr-doc`、`dr-workspace`、`dr-testkit`）的接口到此定下；界面、帮手、导入、导出只做了「能编译、测试能过」的最小改动，下面按轨道列出每一处：在哪个文件、现在的最小改动是什么、轨道要把它做成什么、该用数据层的哪个接口。（当时的任务书 `handoff/v4-tracks.md` 已在收尾时删掉，仍然有效的规矩在 [handoff/README.md](handoff/README.md)。）

### 最终的接口名字

**`dr_model::v3`（条目模型）**

- `Entry { level: bool, … }`；`Entry::is_level(&self) -> bool`、`Entry::is_lane(&self, templates) -> bool`（开关开着，`lane` 取条目自己的覆盖、没有再取模板，不往下继承）、`Entry::is_linkable(&self, templates) -> bool`。
- `EntryTemplate { level: bool, linkable: bool /* 缺省 true */, settings: LevelSettingsOverride, verbs, … }`；`EntryTemplate::prose_modules()`、`book_prose_modules()`（`in_book` 开着的）。没有 `kind`、`lane` 字段了。
- `ModuleKind::Children`（`"children"`）；`ModuleConfig { in_book: bool /* 缺省 true */, … }`；`ModuleSpec::children(id, name)`、`ModuleSpec::in_book(self, bool)`。
- `LevelSettings { …, lane: bool }`、`LevelSettingsOverride { …, lane: Option<bool> }`，都没有 `allow`；`LevelSettingSource::Lane { entry }`；`LEVEL_SETTING_KEYS` 里 `lane` 替了 `allow`（仍是 8 项）。`resolve_level_settings` 对开关关着的条目给默认值。
- 检查和读取容错：`effective_parent_id(entry, entries)`、`effective_ancestors(entries, start)`、`check_parent_is_level(parent, entries)`、`check_membership(host, member, entries, templates)`（不看成员模板）、`check_timeline_lane`、`filter_valid_memberships`（每个宿主只解析一次）。
- 自动链接：`is_autolinked(entry, memberships, entries, templates)`（单条）、`AutolinkNames::of(entries, memberships, templates)`（一遍扫出：`is_linked`、`linked`、`owners`、`names`）。
- 命令层预防：`BookGraph<'a> { entries, templates, memberships }`、`check_new_violations(before, after)`、`manuscript_nest_pairs(entries, templates)`。
- 删掉的：`TemplateKind`、`ModuleKind::allowed_on_level`、`LEVEL_ABOUT_MODULE`、`level_about_module_id`、`ChildSettings*`、`resolve_child_settings_for_parent`、`check_template_modules`、`check_level_allows_template`、`check_template_switch`、`is_autolink_leaf`、`check_autolink_name_unique`、`check_manuscript_no_nest`、`LevelSettings::allows_template`、`Entry::is_leaf`、`Entry::is_lane_level`、`EntryTemplate::is_level/is_leaf/is_lane_level`。

**`dr_doc::v3`（文档）**

- 写：`EntriesTreeWriterV3::create(id, parent, title, template, level)`、`create_at(id, parent, index, title, template, level)`、`switch_level_off(id) -> Vec<EntryId>`；`EntryWriterV3::level(bool)`；`TemplateWriterV3::level(bool)`、`linkable(bool)`（没有 `kind`、`lane` 了）；`restore_entry` 恢复 `level`。
- 读：`BookViewV3::graph() -> BookGraphV3`、`BookGraphV3::{as_graph, check_against}`、`entry_headers_with(&templates)`、`entry(id)`（一条加名字表，不读全书）；`structure_snapshot()` 上的 `flatten`、`manuscript`、`manuscript_docs`、`manuscript_entries`、`ordinal`（第 7 节）。`manuscript_leaves` 删了。
- 小说模板：版本 2；`novel::MOD_DESCRIPTION`（`mod-description`，「说明」，`in_book = false`）替了 `MOD_ABOUT`；`act_track_template()`（原 `act_track_level_template`），「幕」随小说模板建。内置模板里没有放 `children` 模块（作者第 13 节问题 4 未定：没有时排在最后）。
- 守卫：`RecordKeyV3::contains` 对子条目顺序键只认同一个键。

**`dr-workspace` 命令和 DTO**

- `entry.set_level { book, id, level } -> { id, level, moved }`（第 3 节）。
- `entry.get` 的输出 `types::Entry { level, below: Option<Box<Below>>, … }`；`types::Below { settings, sources, children, members }`；`types::SettingSource`（原 `entry::SettingSource`，仍从 `commands::v3::entry` 重新导出）。
- `entry.list { …, below: bool }`；`entry.create { …, level: Option<bool> }`；`module.read` 读 `children` 模块时带 `below`。
- `types::EntryTemplate { level, linkable, settings: { …, lane } }`，`types::ModuleConfig { in_book }`，`types::LevelSettings { lane }`，都没有 `kind`、`allow`。
- 事件：2a 加的 `WsEvent::Stats(StatsChanged { book, seq, origin, days })`、`WsEvent::Checkpoints(CheckpointsChanged { book, seq, origin, points })`；书目的 `WsEvent::Book` 都是内容变了。
- `level.get`、`level.list` 退役（门禁 `cutover` 拦）。

### T1 外壳与条目页

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-shell/src/book/v3.rs` | 加了 `Book::is_lane(id)`；条目颜色改成「自己的颜色字段有值就用，没有再取主归属泳道的」；`manuscript` 改从 `structure.manuscript()` 取；`SettingSource::Lane` 去掉 `template` | 左栏树和大纲按开关显示（`levels` 只含开着开关的活条目）；条目页、左栏的开关入口 | `Entry::level`、`Book::is_lane`、`entry.set_level` |
| `dr-view-page`（没动） | 无 | 条目页上的「层级」开关和关开关的确认（文案照第 3 节），带 `RecordKey::entry` 和 `RecordKey::children_of(Some(id))` 的读；「下面的条目」模块（模板里没有就排最后，显示照 `below.settings.display` 的四种）；页眉按编号显示「第 N 章」，`PageKind` 收成两种 | `entry.set_level`、`entry.get` 的 `below`、`module.read`、`BookStructureV3::ordinal` |
| `dr-editor/src/v3.rs` `page_infos`（页面种类部分） | 编号已从成书序列来；页面种类仍按 `tpl-chapter`/`tpl-idea` 认 | 有编号的条目是「成书里的条目」，其余显示模板名（第 9 节表） | `ordinal`、`FlatEntry::ordinal` |
| `dr-view-elements`（`category.rs`、`dialogs.rs`、`data.rs`） | 设置面板删了「允许的模板」一行和选项，`v3Levels.allowedTemplates`、`allTemplates` 两个文案键也删了；新建、换模板、拖放只查住处是否开着开关（拖到开关关着的条目上是放在它旁边）；`panel.rs`、`storyline.rs` 用 `Book::is_lane` | 面板只在开关开着时出现；要不要露出 `lane` 一行由这一路定 | `check_parent_is_level`、`types::LevelSettings::lane` |
| `dr-cli/scenarios/k4-g2-levels.json`、`k4-g2-actions.json`、`k4-g2-review-drag.json` | 删了驱动「允许的模板」的步骤和只写 `allow` 的准备步骤；场景说明里的种子名改成 `lite` | 真窗口跑一遍 | — |
| `dr-view-element-overview/src/isles.rs` | 泳道判断换成 `Book::is_lane` | 无 | — |

### T2 模板编辑器

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-view-templates/src/model.rs` | `blank(kind, name)` 把 `"level"` 映射成 `level: true`；动作目标不再查 `allow` | 不再先选种类：新建只有一种模板，`level` 是一个开关 | `types::EntryTemplate::level` |
| `dr-view-templates/src/view.rs` | 模块选择器给出全部种类；「下面」的设置和动作只在 `draft.level` 时显示；类型标签仍用「层级模板/叶子模板」的词；没有代码引用的 `templateEditor.allow`、`all_templates`、`add_field` 三个键删了 | 去掉种类标签和这两个词（`templateEditor.leaf_template`、`level_template` 两个键；之后在门禁 `terms` 里加「叶子模板」「层级模板」「leaf template」「level template」的禁用，第 11 节）；加 `linkable` 开关；每篇正文模块露出 `in_book` 开关；`children` 模块可以摆位置 | `ModuleConfig::in_book`、`EntryTemplate::linkable`、`ModuleKind::Children` |
| `dr-view-templates/src/view/levels.rs` | 删了「允许的模板」一节；泳道开关读写 `settings.lane` | 泳道并进「下面」的设置 | `LevelSettingsOverride::lane` |
| `dr-view-templates/src/preview.rs` | 预览按 `draft.level`、`settings.lane` | 跟着上面变 | — |
| `dr-cli/scenarios/k5-level.json`（没动） | 仍按「Level template」菜单、模板的 `kind`、「Allowed templates」勾选和模板顶层的 `lane` 写，真窗口跑会失败 | 按新的编辑器重写这个场景 | — |

### T3 帮手工具与 MCP

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-agent-tools/src/catalog.rs` | 动作只绑在开着开关的条目上；删了诊断 `leaf_template_verb`、`invalid_membership_binding` 的模板限制；条目表只读一次，层级设置用 `resolve_level_settings`。没有了允许列表，`invalid_residence_binding`、`invalid_membership_binding` 两个诊断现在碰不到（`resolve_new_entry_residence` 只在收别处条目时用 `home`，`home` 不是开着开关的活条目就退回动作自己的层级），代码留着当防线；家被关掉时动作改绑到自己的层级、修订号跟着变（测试 `v3_template_verbs_bind_atomically_disambiguate_paths_and_guard_revisions` 第 4 步） | 目录缓存不按整书版本失效（只在模板、开关、动作变时重建）；不再整本拷贝（`catalog_for_book`）；那两个诊断删不删由这一路定 | `Entry::is_level`、`resolve_level_settings` |
| `dr-agent-tools/src/structure.rs` | 结构说明：根摘要 `level: bool`，模板摘要 `level`、`linkable`、`lane`，没有 `kind`/`allow`；修订号前缀 `k6-structure-v4`；去掉 `about` | 写给帮手的结构说明文字（`STRUCTURE_CONTEXT_SOURCE` 以外的说明）按新模型过一遍；`dr-agent`、`dr-agent-tools`、`dr-view-agent` 的产品代码里已经没有「叶子」字样，小说模板写给帮手的说明在 dr-doc 已改 | — |
| `dr-agent-tools/src/resolve_v3.rs` | 去掉 `about`；删了 `level.get` 的解析和记账分支；带着 `below` 读到的 `entry.get`、`entry.list {below}` 记 `level:<id>`（背后是条目加 `children_of(<id>)`）和下面每个条目；`entry.set_level` 按 `id` 解析，要求读过这个条目 | 名字解析不再整本拷贝 | `entry.get` 的 `below` |
| `dr-agent-tools/src/records.rs` | `below.members` 里的每一个记成那条归属（原来是 `level.get` 的成员） | 无 | `RecordKey::children_of` |
| `dr-agent-tools/src/checkpoints.rs` | `entry.set_level` 归入按 `id` 选条目（只存条目自己的写前快照） | 关开关时再加每个直接子条目的写前快照 | `entry.get` 的 `below.children`（只含活的；回收站里的子条目要另读） |
| `dr-agent-tools/src/executor.rs` | 没动：`call_tool` 的说明里还写着 "level template action" | 改成 "template action"，重新生成目录快照 | — |
| `dr-agent/src/long_task/store.rs` | 「书的正文」= 成书序列里的正文文档，成书序列编了号的条目另带前一个模板留下的正文（按原模块）；没有成书层级时退回「开关关着的条目」 | 无 | `structure.manuscript()` |
| `dr-view-agent/src/speech/context.rs` | 自动链接的名字用 `AutolinkNames` | 无 | — |

### T4 导入 0.1 收尾

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-samples/src/v3/catalog.rs` | 每个条目的开关取模板默认；分类、故事线的说明写进 `mod-description`；去掉 `allow`；「幕」模板随小说模板（书里已有的幕模板不覆盖，和以前一样）；导入后的校验按开关，并用 `check_new_violations` 拿整本书和空书比（不许有任何重名、嵌套成书） | 导入报告的说法跟着新模型改（`dr-view-import`） | `check_parent_is_level`、`check_new_violations` |
| `dr-import-v1` | 测试期望跟着改（`MOD_DESCRIPTION`、`is_lane`、`level`） | 真窗口用合成库导入一遍 | — |
| `dr-view-import/src/reimport.rs` | 2a 已改 `reimport-v4-` | 无 | — |

### T5 导出与书文件

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-export/src/v3.rs` `outline` | 改用成书序列：只有带成书正文的条目、只收 `in_book` 的正文；几个成书部分接在一起 | 有几个成书部分时让作者选 | `structure.manuscript()`、`ManuscriptPart` |
| `dr-export/src/import/write.rs` | 没动：导入文档的落点仍按 `TPL_MANUSCRIPT`、`TPL_IDEAS`、`TPL_ELEMENTS` 找 | `ImportTarget` 直接给一个层级条目 id；新条目用它解析出的默认模板 | `resolve_level_settings(...).default_template` |
| `dr-view-transfer/src/documents.rs` | 没动：目标列表按 `tpl-storyline`、`tpl-category` 收 | 列出所有开着开关的条目（按树显示路径） | `structure.levels()` |

### T6 统计与小文档的界面

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-view-stats/src/v3.rs` | 全书字数、章节数（`leaves`）改从成书序列来，只算 `in_book` 的正文；层级不再有 `about` | 无 | `structure.manuscript()` |
| `dr-view-shelf-art/src/cover.rs` | 章节和字数改读外壳 `Book.manuscript`；故事线用 `Book::is_lane` | 无 | — |
| `dr-workspace/src/commands/book.rs` `book.shelf` | 字数、章节数从成书序列来；故事线按 `is_lane`；「要素」数是开关关着、不在成书序列里有编号的活条目 | 无 | — |
| `dr-view-history`（没动） | 对话框还不订阅 `WsEvent::Checkpoints`（2a 起就是） | 订阅，存点后自动刷新 | `WsEvent::Checkpoints` |
| `dr-view-home/src/v3.rs` | `CreateIn` 带 `level: None` | 无 | — |

### T7 整书视图

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-editor/src/v3.rs` `manuscript_docs` | 改成成书序列（每个条目自己的成书正文在前，标题照旧：第一篇用条目标题，其余用模块名） | 从任意开着开关的条目打开：`flatten(from, Flatten { in_book_only: true, include_members: true })`；没有正文的条目也画标题和层次；退役旧「纵览全书」入口 | `BookStructureV3::flatten`、`FlatEntry`、`NotALevel` |

### T8 时间线与模板 id 收尾

| 在哪 | 现在的最小改动 | 轨道要做成什么 | 用的接口 |
| --- | --- | --- | --- |
| `dr-view-timeline/src/v3/model.rs`、`render.rs` | 泳道判断换成 `Book::is_lane`；拖进泳道的候选不再按 `allow` 过滤（泳道总是收） | 泳道条目的开关关掉时它不画、成员位置不显示（数据层已经这样读） | `Entry::is_lane`、`check_timeline_lane` |
| `dr-view-timeline/src/v3/write.rs`（337、371 行） | 没动：新建幕轨道仍按 id 找 `tpl-act-track`，找不到才建 | 「幕」模板现在随书就有：在「新条目默认开着泳道的模板」里选，建在根上、加进视图、标为幕轨道 | `EntryTemplate::level`、`settings.lane` |
| 门禁 `cutover` | 已改名、已拦 `level.get`/`level.list` | 所有轨道合完以后打开「产品代码不按内置模板 id 认东西」 | — |

### 量到的

2026-11-13，release 构建，以作者身份调用、不带守卫，各 7 次取中位数（先各热身一次），单位毫秒。「重型」是 `dr_testkit::seed` 的 Heavy 种子（633 个条目，书目文档 0.8 MB）；「三年」是同一本书用 `dr_testkit::aging::book` 写了三年（1197 个条目，书目文档 3.1 MB）。量的时候机器负载 11–15，只看量级。「改前」是 2026-11-13 改动前诊断时量的（诊断记录在监管会话的笔记里，当时三年的书目文档 26.2 MB，因为快照点清单还在里面）；改前改后的书目文档不一样大，下降里也有 2a 的份。测量程序是临时的，没有提交。

| | 重型 改前 | 重型 改后 | 三年 改前 | 三年 改后 |
| --- | ---: | ---: | ---: | ---: |
| `entry.update`（改标题） | 219 | 6.95 | 406 | 12.21 |
| `module.set_field` | 246 | 1.95 | 402 | 2.07 |

省下的主要是写入前的检查：改前每次把全书重验一遍（名字唯一那一步约占 94%），改后只读条目头、一遍扫出名字表、比较改前改后。

## 和输入不一样的地方

- **「自动链接对任何条目都适用」**：同意不看开关，但加了模板的 `linkable`。只按住处和归属判断，会让要素分类下的分组（导入 0.1 时大量生成）被自动链接、并和同名要素抢名字（第 2 节「自动链接」）。
- **任务书点名的「按固定模板 id 认东西的地方」**：其中大半是 `#[cfg(test)]` 里的测试数据，产品代码里真正这样做的是第 9 节表里那几处。另有两处任务书没列：`dr-export/src/import/write.rs` 和时间线新建幕轨道。
- **契约清单的位置**：在 `dr-model/src/invariant.rs`，不在 `dr-testkit/src/invariant.rs`。
- **泳道**：背景说开关是条目自己的属性、其余设置照旧继承。泳道我放进了设置，条目可以自己覆盖，但**不往下继承**（继承会让泳道下面的每个层级都变成泳道）。
- **「说明」正文**：背景只说「变成普通正文模块」。为了「默认结构保持原样」，还需要 `in_book` 让它不进导出和字数（第 13 节问题 2）。
- **底稿**：建书时就建两篇小文档（底稿是第一次写才建），书文件只读 4，删掉 `touched` 分类。

## 输入

作者 2026-11-13（原话大意见任务书）：

1. 只有一种条目。任何条目都可以由模板任意拼模块。「下面能不能放东西」是一个开关。
2. 开关打开后，才显示只对它有意义的选项和模块。「允许放哪些模板」临时删掉；需要选的只有「在这一层新建时默认建什么」。
3. 下面还有东西时关开关：界面提示，作者继续就把下面的条目移到根层级。
4. H1/H2/H3 是正文内部的结构，不是条目层面的结构；这次不为它设计任何东西。只叫 H1/H2/H3。
5. 导出和整书视图里，条目自己的正文排在它下面的条目之前。整书视图重做成「从任何一个能放东西的条目出发，摊平看它和它下面的全部内容」；按章写死的「纵览全书」退役。
6. 模板更新与项目无关，不做内置模板的升级通道。
7. 格式干净改：不并读、不为 `next/` 现有的库写迁移；0.1 不受影响；旧格式的书原样拒开；开发库从 0.1 重新导入。
8. 先把结构弄对、功能可用，长相以后再打磨。
9. 故事图（M21）、Markdown 文件夹（M40）、整书视图都在等这套结构。

监管会话替作者定的：开关是条目自己的属性，模板给默认值，其余设置照旧继承；关开关时归属不删、读取时忽略；自动链接对任何条目都适用；`about` 退役成普通正文模块「说明」；写作日和快照点清单在同一次格式改动里外移，文档名 `stats:<书>`、`checkpoints:<书>`；产品代码按固定模板 id 认东西的地方改成按角色或设置认。
