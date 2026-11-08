# F1：dr-model 与 dr-doc

2026-11-07 至 11-08，七轮：第一轮把结构做成库（结构改成 v1）；第二轮按监管会话的两份审查补数据、改顺序（结构改成 v2）；第三轮按 F3、dr-text、F8 的反馈，让视图和事务能套在存储持有的文档上，读取按对象变便宜，证据换成新做法；第四轮按 F4 的建议让插入事件带上新字的标记，并对照 F4 的待协调核对了样式表、锚点和打开文档的分工；第五轮按 F3 的待协调做了作者命令不进编辑器撤销、待办和情节规划表的确定写法（「种子变更」）、正文模板文档，并评估了 Agent 改动「看过」怎么跨设备（结构记成 v2.1，向后兼容）；第六轮让 `insert_copy` 连表格格子里的标记一起抄，清单里没测试的三条都挂上了测试；第七轮审了 M27（帮手运行时）加的对话文档，改了读取容错、导入校验和两处分派（结构记成 v2.2）。计划见 [foundation.md 的 F1](../foundation.md#f1-dr-model-与-dr-doc)，文档结构见 [loro-schema.md](../loro-schema.md)，代码在 `next/crates/dr-model/` 和 `next/crates/dr-doc/`。

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

6. **第三轮：让命令层不再需要「镜像」，读取变便宜，证据换成新做法。**
   - **借来的文档上也能读写**：存储（F2）的文档持有者手里拿着 Loro 文档，原来 `dr-doc` 只能在自己那份上开事务，所以 F3 得给每篇打开的文档多存一份「镜像」，每次提交再导出导入一次。现在 `BorrowedProse` / `BorrowedBook` 直接套在持有者的文档上，读写都行，提交由持有者做；撤销也一样（`ProseUndo::on` + `undo_step`）。F3 可以拆掉镜像，内存少一半。
   - **直接读持有者手里的热文档**：`ProseReader::from_loro` / `BookReader::from_loro` 共享那份文档，不复制、不写；`ProseView::paragraph_in(位置, 段数)` 不看前文就能读中间几段。
   - **按对象读不再读全书**：「某个对象还在不在」从读五六个集合改成直接查一个键；「列关系」只对用到的端点查；新增 `relations_of(端点)`。
   - **「要不要修」先粗看一眼**：`needs_repair()` 遇到第一个问题就停；修复计划里找重复关系也不再先算「哪些能显示」（重复的关系端点和类型都一样，要显示一起显示，要藏一起藏）。
   - **快照能按字段读、能比较**：`EntitySnapshot::field` / `diff`，帮手撤销要比「动手前 / 写完后 / 现在」。
   - **9 处分叉标成已统一**，F3 的测试名挂到了对应的不变量和分叉上；清单里还没有测试的 3 条单独列出来并写明原因。
   - **证据换成新做法**：不变量清单、两个三设备属性测试、模糊测试的 JSON 都删了，改成测试里直接断言；模糊测试找到的两个崩溃输入作为回归测试保留；测量搬进 `dr-testkit` 的基准，成了 `doc` 套件。

7. **第四轮：编辑器打字不用再回读这一段。**
   - **插入事件带上标记**：`ProseEvent` 里的插入现在是 `TextChange::Insert { text, marks }`，`marks` 就是这几个新字插进去以后带的行内标记（加粗、链接、人物链接……），和读出来的一模一样。原来事件只说「插了哪几个字」，编辑器的段落镜像不知道新字该不该加粗，只好每打一个字就把这一段从文档里再读一遍；现在照事件就能把新字摆好。Loro 的事件本来就带这些，本机打字、撤销、远端导入都带，所以总是有，不是可选的。
   - **怎么知道它对**：新的三设备属性测试随机打字（专挑加粗的字后面、链接的字后面这种边界打）、回车、删、加减加粗斜体链接、加人物链接、撤销重做、任意顺序同步，每走一步都只靠事件拼出一份正文和每个字的标记，再和重新读出来的逐字比。3000 例全过，比了约 94 万个字。故意把事件里的标记改成空的，或者把「格式变了」的标志弄反，测试当场失败。
   - **和 F4 的约定逐条对过**（F4 文档「待协调」第 3、4、5 条），都一致，补了两处：
     - **样式表**：`gpui-prose` 自带的表逐键核对过，和 `dr-doc` 的一样。`gpui-prose` 只导出 Loro 的配置表、给不出键列表，所以新加了 `style_config_mismatches(&配置表)`，`dr-editor` 的对拍测试一行就能写。
     - **锚点**：两边存的是同样的两段字节，加了一个测试把这个约定钉住。撤销带回来的锚点写回书目文档用 `CommentWriter::anchor` / `PatchWriter::anchor`，注释里写清楚了：这是作者的写入，要同步出去。
     - **打开文档的分工**：配样式表、创世、对等方、块 ID 修复都在 `dr-doc` / `dr-store` / F3 这边（F3 已经拆了镜像，在持有者的写入里用 `BorrowedProse` 修块 ID），`dr-editor` 拿到的是已经打开好的文档。
     - 顺手发现 `gpui-prose` 自己的 `Anchor::resolve` 没有「锚点是不是指向这篇正文」的检查，坏字节会让 Loro panic（`dr-doc` 第一轮的模糊测试找到过同一个问题）。Drifting 里锚点经 `dr-doc` 解析，碰不到；记给 F4。

8. **第五轮：两台设备各写一遍也不出错；正文模板有了自己的文档。**
   - **作者的命令不进编辑器的撤销**：作者从命令面板、或者帮手代作者改了正开着的这一章，那次改动的来源是 `user:command`。现在任何一个撤销管理器都自动排除它（以前 F3 要在会话上另外加），编辑器的撤销只撤作者自己打的字，命令由工作区的日志撤。
   - **「种子变更」：两台设备没同步就各写了一遍的默认内容，合起来只有一份，也盖不掉作者的改动。** 打个比方：两个人各自往同一本账上抄同一张「出厂设置」，只要抄的是同一张，账上就只记一次；而且这张出厂设置永远垫在最底下，谁后来真改过哪一格，都以改过的为准。做法是像创世那样，在一份空文档里用一个由内容算出来的固定写入者写好，再导入（详见 loro-schema.md「种子变更」）。用在两处：
     - **从正文 TODO 标记投出的待办**：以前两台设备都投了同一个标记，待办只有一条，但正文读出来是两遍（「补一场雨补一场雨」），F3 只能事后修，两边读到的文字不一样时还修不了；而且一台设备晚到的投影会把另一台上已经解决的待办重新打开。现在 `project_todo` 把任务文字写成一个值（`projection_text`），正文没人改过就读它：两边一样只有一份，不一样也只留一个、不会叠；已解决的永远是已解决。
     - **新情节规划表的三行三列**：以前每台设备给新行新列起随机 id，两台同时第一次建同一张表就合出六行六列（旧版也这样）。现在 id 是确定的（`<章节 id>:r1`–`r3`、`:c1`–`c3`），由 `create_plot_grid` 写成种子：合起来还是三行三列，作者挪过、改过名的行不会被另一台晚到的默认值挪回去。
   - **正文模板**：新的文档种类 `template:category:<分类>`（要素模板）和 `template:storyline:<故事线>`（章节模板），就是普通的正文文档，id 由主人算出，所以两台设备开始写的是同一篇、会合并。新建要素或章节时用 `insert_copy` 把模板整篇抄进去：标题级别、加粗、人物链接、表格都在，块 ID 换新的。模板不算书的正文（不进搜索、不计字数、不导出）。
   - **Agent 改动「看过」跨设备**：只评估、没做，结论见「待协调」第 8 条：记号不用同步，每台设备从同步来的历史里自己算出同样的记号；只同步「看过」这一个集合，放在每本书一篇单独的小文档里。
   - **怎么知道它对**：新的三设备属性测试随机投待办（同一个标记、不同的任务文字）、改正文、解决、删掉再投、建同一张表、改行名、挪行、加行、让某台设备先写一大堆别的（把它的时钟拨快），任意顺序同步，最后查：各设备读到的一样；没人改过的待办正文正好是投过的某一个任务文字；有人解决过、没人删过的待办一定是已解决；表一定是三行三列加上新加的行；挪过的行一定在真正挪到的位置上。3000 例全过（数字见「测试与证据」）。把种子换回普通写入，这个测试和四个单元测试当场失败（试过）。

9. **第六轮：模板里表格的加粗、高亮不再丢；清单没有空着的了。**
   - **表格格子里的标记一起抄**：上一轮 `insert_copy` 抄表格只抄了格子里的字。现在格子里的加粗、斜体、高亮、行内代码、链接、人物链接都跟着过去，位置一字不差；行列 id 和顺序照旧。新加了 `ProseView::table_cell(表, 行, 列)`，按段读出一个格子和它的标记（素材笔记的表格能读到高亮和行内代码）。写法有个坑：要先把整格的字放进去再打标记，一段一段边插边打的话，加粗会顺着「往后长」的规则漫到下一段上。测试照素材笔记表格的真实写法搭表（每个格子一段文字、标记直接打在这段文字上、高亮的值是空串），抄过去逐格比对；故意改成只抄字、或者边插边打，测试都当场失败（试过）。素材笔记里带高亮的表格抄进章节会报「这里不能用」，和正文一样。
   - **清单里没有测试的三条都有了测试**（`NOT_YET_TESTED` 清空）：
     - **模板、元数据、来源是 JSON 文本**：新测试 `json_fields_are_kept_whole`，两台设备同时往这四个字段写两份不同的、各自完整的 JSON，合并后两边一样，都是其中完整的一份，不会拼成坏的（这几个字段是整值，不是会逐字合并的文字）；不是 JSON 的字符串也原样存。另挂上 F3 的 `a_01_element_template_reads_as_paragraphs`：读旧模板 JSON 读不出就当作空模板。
     - **彻底删书时属于它的一切都删掉**：挂上 F3 的 `purging_a_book_deletes_it_for_good`（文档、资源、日志行都删，不能撤销）和 `a_purged_book_does_not_come_back_with_sync`（另一台设备再送来的副本不收）。
     - **资源字节到了才能显示**：挂上 M19 的 `a_material_without_its_file_says_so`（这台设备上没有这个文件时，素材页说一句「没有」，不报错、不崩）。字节后来同步到了自动重新显示，要等 F2 做资源同步，见「待协调」。
     - 检查「清单点名的测试都存在」的测试原来只在 dr-model、dr-doc、dr-workspace 里找，现在找整个 `next/crates/`，存储和页面的测试也能挂上来。
   - **撤销栈不设上限**（9b28b566，第十六批）：对过了，和清单不冲突。清单里撤销那条（`ONE-ORIGIN-PER-COMMIT`）说的是「作者撤销只撤作者自己的输入」，不管栈多深；`undo.rs` 的注释和「待协调」里的「撤销计数」原来写着「Loro 默认也不设上限」，是错的，那个提交已经一起改对了，这边没再动，免得合并时冲突。

10. **第七轮：审 Codex 给帮手运行时（M27）加的对话文档。**
   - **它是什么**：每个 Agent 对话一篇 `conversation:<对话 id>`，里面一张只追加的列表，每条是一段写死的 JSON（谁说的、第几轮、内容）。它从本机的运行日志投出来，能同步。整体思路对：只追加、按事件身份去重、不进正文的那一套。下面四处我改了。
   - **一条坏记录不再让整篇对话打不开。** 原来读的时候遇到一条读不懂的记录（比如以后版本换了记录格式），或者同一个身份有两份不同内容，整篇对话就报错：打不开，也收不了同步，而且新旧版本混用时旧版本会把新版本的更新全拒掉。现在读不懂的跳过、原样留着，同一身份读列表里第一条，两种情况都报出来（`problems()`）；每台设备读同一张列表，得到同一个结果。
   - **导入时只看「这份更新自己做了什么」，不看「导入前后差了什么」。** 打个比方：原来是「我手里的账本不能少一页」，可每台设备手里的账本不一样。一台没见过某条记录的设备，会收下「先写上又撕掉」的更新，见过的那台却拒绝，两边从此不一样，而且再也合不回来。还有个后门：先送撕页的更新，它依赖的那页还没到，Loro 先挂着不检查；等那页送到，撕页就跟着生效了，没人查过。现在的规矩只看更新里的操作：有删除（改一条、挪一条在列表里也是删了再插）就拒；不是创世却改了对话身份就拒；依赖还没到的也拒，等依赖到了再送。同一份字节在每台设备上答案都一样。
   - **同一身份内容不同的记录不再拒收。** 这种记录只有程序出错才会出现。拒收保护不了任何东西，却会让那台设备之后的更新全都进不来（Loro 要等被拒的那份）。现在收下，读第一条，并报出来。
   - **两处分派漏了，补上**：`owns_prose` 原来说对话「没有主人」，存储以后按它清理没主人的正文时会把对话删掉，现在认它属于书。投待办原来把对话、模板、书目文档都当成章节，现在只收书的正文，其余的报错。
   - **顺带快了**：一篇 2000 条、约 4 MB 文字的对话，追加一条从 31 ms 降到 1.8 ms，校验一份传进来的更新从 123 ms 降到 20 ms（原来逐条按下标取、校验时整篇导出再导入；现在一次遍历、直接 `fork`）。
   - **怎么知道它对**：新加的三设备属性测试让三台设备各追加自己的运行事件、重放旧事件、随机顺序同步，还故意把某台的最新一份更新抢先送到缺依赖的设备上。查四件事：老实的同步从来不被拒；抢先到的被拒，依赖到了再送就收下；最后各设备读到的一样，每个事件只出现一次；每台设备自己的事件保持自己追加的顺序。故意去掉「缺依赖就拒」或「有删除就拒」，单元测试当场失败（试过）。
   - 清单里对话的两条拆成四条（只追加、历史不动、读取容错、不是正文），挂上测试；`loro-schema.md` 加了一节「对话文档」，记成 v2.2。结构上的意见和要别人做的写进了 [m27-conversation-schema.md](../modules/m27-conversation-schema.md) 的「待协调」。

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
- **F3（命令总线）**：在 `BookTxn` / `ProseTxn` 之上组命令；创建时必填什么、名字是否重复、跨文档先写哪个，都在命令层，清单里标了「命令层」的 35 条是 F3 的活。第五轮起：投待办换成 `project_todo`、建情节规划表换成 `create_plot_grid`、模板命令用 `template:` 文档和 `insert_copy`，见「待协调」第 2 条。
- **F4（编辑器）**：`dr-editor` 经 F3 的 `ProseSession` 读写和撤销（底下是 `ProseReader`、`ProseTxn`、`ProseUndo`），订阅 `ProseEvent`；插入事件带标记，打字不用回读。见「待协调」第 3 条。
- **M10（旧库导入）**：用确定性的导入对等方（`peer::import_peer`）和 `edit_at` 的固定时间戳；旧块 ID 用 `ProseTxn::set_block_id` 原样写入；`library_item` 写成 `material`；内置关系类型的 id 和旧版一样，不用改写。

## 接口概览

标注：**稳定** = v1 定下，改要走版本号或先协调；**可能变** = 下游用起来以后大概率要调。

### dr-model（不依赖 Loro）

| 模块 | 内容 | 状态 |
| --- | --- | --- |
| `id` | `BookId`、`NodeId`、`ElementId`……共 23 种 id（非空、无控制字符的字符串，新建是 uuidv7，比较按 UTF-8 字节）；`DocId`（`book:` / `node:` / `element:` / `storyline:` / `category:` / `material:`，第五轮加 `template:category:<id>` / `template:storyline:<id>`，M27 加 `conversation:<id>`；字符串形式就是存储的键）；`DocKind`（第五轮加 `Template` 和 `is_book_text()`：模板和书目文档不是书的正文；M27 加 `Conversation`，也不是）；`check_id`（第七轮：不是哪种 id、但守 id 规则的字符串，比如对话记录的事件身份）、`ProseProfile`；`TemplateId` / `TemplateOwner`（`for_category`、`for_storyline`、`owner()`、`doc_id()`）；`CommentId::for_projection`（生成的待办的确定 id）、`PlotRowId::default_for` / `PlotColId::default_for`（新表三行三列的确定 id）、`DeviceKey::from_installation_id`（写作日设备键，和旧版同一个摘要） | 稳定 |
| `kind` | 书目里所有字符串枚举，全部「开放」：不认识的值读成 `Other` 原样保留 | 稳定 |
| `pos` | 分数索引位置键 `PosKey`：`first`、`between`、`after`，`key_between` / `keys_between`，`cmp_pos`；照搬 Rocicorp `fractional-indexing` 4.0.0，测试里的期望值是用那个库本身算出来的 | 稳定 |
| `legacy` | 退役取值到 v2 的映射（导入用）：`copilot` → `api` / `ai`、`converted` → `resolved`、`library_item` → `material`、批注动作只留 `start_agent_task` | 稳定 |
| `book` | 每类实体一个记录：`BookMeta`、`Node`、`Act`、`Storyline`、`Category`、`Element`、`Patch`、`RelationType`、`Relation`、`TimePin`、`PlotGrid`、`Comment`、`Material`、`Asset`、`DriftGroup`、`MaterialFolder`、`Memory`、`WritingDay`、`KvEntry`；`EntityRef`、`EncodedAnchor`、`BlockSnapshot`、`MaterialRegion`、`TodoProjection`；`canonical_symmetric`、`normalize_relation_type_name`、`element_name_key`；`BookMeta::word_target` / `daily_word_target`（默认 120000 / 1500，0 是关掉）；`PLOT_DEFAULT_CELL`（184 × 96）、`PLOT_DEFAULT_LINES`（3） | 字段稳定；记录里会加便利方法 |
| `prose` | `BlockAttrs`（H1/H2/H3、引用、缩进 0–8、对齐、分隔线，笔记的列表 / 任务 / 代码块 / 提示框）、`InlineMarks`、`InlineStyle`、`EntityLink`、`Heading` | 稳定 |
| `order` | `cmp_order`（坐标、缺的排最后、平局按 id）、`chapter_order_after`（照搬旧版插章规则）、`act_segments` / `act_index_for_order`（幕按分界）、`needs_spread`、`CHAPTER_ORDER_STRIDE` | 稳定 |
| `origin` | `Origin`：`user` / `agent:<会话>/<轮>` / `mirror` / `sync` / `import` / `genesis` / `repair`；`commit_message()`：Agent、Markdown 文件夹、导入的提交带提交信息，作者自己的不带；`UNDO_EXCLUDED_ORIGIN_PREFIXES`（第五轮加了 `user:command`）；`COMMAND_ORIGIN = "user:command"`（和 `dr_store::COMMAND_ORIGIN` 同一个字符串；不是 `Origin`，模型层的命令就是作者的写入） | 稳定 |
| `time` | `Timestamp`（秒）、`Day`（`YYYY-MM-DD`，校验闰年） | 稳定 |
| `check` | 命令层用的判断：`non_empty_name`、`relation_type_definition`、`relation_ends`、`comment_target`、`patch_source`、`material_payload`、`asset_shape`、`plot_cell_size`；违反时返回不变量 id | 可能变（F3 会加） |
| `invariant` | 不变量清单 `INVARIANTS`（82 条，第七轮起含对话的 4 条）、`NOT_CARRIED`（16 条）、界面和 Agent 的分叉 `DIVERGENCES`（9 条，已由 F3 统一，各带测试名）、还没有测试的 `NOT_YET_TESTED`（第六轮起是空的；以后新加的规则没测试时写在这里并说明原因）；全部由测试当场断言，不再生成 JSON | 随 F3 增补 |

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
ProseReader::from_loro(doc_id, &loro_doc)            共享别人（持有者）手里的文档，不复制不写
BorrowedProse::new(&loro_doc, &doc_id)               借来的文档：.view() / .txn() / .undo_manager()，不提交
genesis(&doc_id) -> Vec<u8>         确定性创世字节
```

| 类型 | 主要方法 | 状态 |
| --- | --- | --- |
| `ProseView` | `len` / `len_utf8` / `len_utf16`、`pos(unit, value) -> TextPos`、`text_in(range)`、`paragraphs()`（逐段懒读，已按「重复 id 只认第一个」处理）、`paragraph_at(pos)`、`paragraph_by_id(&BlockId)`、`blocks()`（只要换行位置和块 ID）、`newlines()`、`entity_links()`、`embed_refs()` / `embed(id)` / `orphan_embeds()`、`anchor(range)`、`resolve(&Anchor)`；第三轮新增 `paragraph_in(位置, 段数)`（不看前文，块 ID 按存的原样）；第六轮新增 `table_cell(表, 行, 列)`（一个格子按段读出，带本文档配置能读的行内标记） | 稳定 |
| `Paragraph` | `id`（读者用的）、`stored_id`、`range`、`newline`、`attrs: BlockAttrs`、`runs: Vec<Run { text, marks }>`、`embed()` | 稳定 |
| `ProseTxn` | `insert_text`、`insert_paragraphs`（粘贴，每段新块 ID）、`split`（回车）、`delete`（含并段规则）、`set_block_attrs`、`set_heading`、`set_style` / `clear_style`、`link_entity` / `unlink_entity`、`insert_embed` / `table`、`drop_orphan_embeds`、`repair_block_ids`、`set_block_id`（只给导入）；第五轮新增 `insert_copy(段首位置, &另一篇的视图)`（把模板整篇抄进来：段落属性、行内标记、人物链接、表格的结构和格子（第六轮起连格子里的行内标记和人物链接）、素材嵌入；块 ID 和嵌入 id 换新的；落在空段上时最后一段顶替它，所以套进新文档正好是模板本身；本文档配置不允许的属性和标记报错） | 稳定；F4 会要更多编辑原语 |
| `ProseEvent` | `trigger`（本机 / 导入 / 检出）、`origin`、`body: Vec<TextChange>`（按字符的 retain / insert / delete）、`splices()`（改后的坐标）、`restyled()`、`embeds_changed`、`meta_changed`；第四轮起 `TextChange::Insert { text, marks: InlineMarks }`：新字插入后的行内标记，和 `ProseView` 读出来的一样（`\n` 的段落属性不在里面） | 可能变（F4 用起来再调） |
| `ProseUndo` | `undo(&mut doc)` / `redo(&mut doc)` 返回 `Committed`；借来的文档上用 `ProseUndo::on(&loro_doc)` + `undo_step()` / `redo_step()`（只执行，落盘归持有者）；`hooks()` 拿到 Loro 的 `UndoManager` 挂 `set_on_push` / `set_on_pop` | 可能变 |
| `BorrowedProse` | 套在持有者的 `LoroDoc` 上：`new`（核对 `meta.doc`、要有创世）、`view`、`txn`、`undo_manager`；什么都不提交 | 稳定 |
| `TableWriter` | `add_row` / `add_col` / `remove_*` / `set_cell` | 可能变 |

### dr-doc：书目文档

```text
BookDoc::create(book_id, peer) / load(book_id, peer, &blobs)
  .view() -> BookView<'_>      .reader() -> BookReader
  .edit(origin, |txn| ...)     .import(bytes, origin)
  .repair() -> (RepairPlan, Option<Committed>)
  .subscribe(|BookEvent| ...)  BookEvent.changes: {Change { collection, id }}
generic_relation_type_id(&book) = "system:generic-association:<书 id>"
BookReader::from_loro(book_id, &loro_doc)    共享持有者手里的书目文档
BorrowedBook::new(&loro_doc, &book_id)       借来的书目文档：.view() / .txn()，不提交
```

| 类型 | 主要方法 | 状态 |
| --- | --- | --- |
| `BookView`（读，已容错） | `meta`、`node` / `nodes` / `chapters`（书序）/ `drifts` / `timeline`（叙事序）、`acts`、`time_pins`、`storylines`、`categories`、`element` / `elements`、`patches` / `patches_of`、`relation_type(s)`、`relations`（能显示的）/ `relations_raw`（存的全部）、`entity_exists`、`plot_grid`、`comment` / `comments`（目标不在时标 `target_missing`）、`materials`、`assets`、`drift_groups`、`material_folders`（父在前）、`facts`、`memory`、`writing_days` / `words_on`、`owns_prose(&DocId)`（第五轮起也认模板的主人）、`repair_plan`；v2 新增 `element_name_conflicts`（合并后重名的要素和保留名字的那个）、`todo_done`（任务行显示的待办状态）、`entity_snapshot`（某对象存着的全部字段，用在历史副本上）；第三轮新增 `relations_of(端点)`、`needs_repair()`，`entity_exists` / `comment` / `comments` / `relations` 改成按键查是否还在 | 稳定；增量索引以后再说 |
| `EntitySnapshot` | `field(键)`、`keys()`、`diff(&另一份)`（按键列出 `(键, 之前, 之后)`）；`restore_fields` 用它写回 | 稳定 |
| `BookTxn`（写） | 每类一个写入器，逐字段设值、`None` 即删除：`meta()`、`node(id)`、`act`、`storyline`、`category`、`element`、`patch`、`relation_type`（内置的拒绝）、`relation`、`time_pin`、`plot_grid(chapter)`、`comment`、`material`、`memory`；`put_asset`（写一次）、`put_fact` / `remove_fact`、`writing_day`、`drift_groups()` / `material_folders()`（树：建、改名、改色、移动）、`delete_drift_group` / `delete_material_folder`（子级和成员上移）、`purge(collection, id)`、`apply_repair(&plan)`；v2 新增 `projected_todo(kind, doc, block)`（生成待办，id 确定）、`restore_fields(collection, id, &snapshot, metadata_fields(collection))`（按对象恢复历史）；第五轮新增 `project_todo(kind, doc, block, 任务文字)`（设备投待办，种子变更；`projected_todo` 留给导入）、`create_plot_grid(chapter)`（新表，种子变更），以及各写入器的新字段：`pos`、`color`、`word_target`、`relate_pin`、`quote`、`snapshots`、`region`、`agent_conversation`、`description` | 稳定；F3 会提出缺的 |
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
| `peer` | `genesis_peer`、`seed_peer`（第五轮，种子变更的写入者）、`import_peer`、`is_device_peer`、`random_device_peer`（测试用；正式的由 F2 分配） | 稳定 |
| `conversation`（M27 加，第七轮审） | `genesis(id)`；`ConversationDoc`（`create` / `load` / `append(来源, 记录)` / `entries` / `problems` / `import` / 导出）；`BorrowedConversation`（持有者文档上的 `append` / `entries` / `problems`）；`validate_update(文档, 字节)`（导入前的校验，见 loro-schema.md「对话文档」）；`ConversationProblems`（读不懂的位置、内容冲突的身份） | 稳定；`entries` 留着 `Result` 只为不改调用方，它不会因内容失败 |
| `schema` | 容器名、标记键、`SCHEMA_VERSION = 2`、`GENESIS_VERSION = 2`；样式表的唯一来源 `STYLE_TABLE` + `DEFAULT_EXPAND`，`style_config()`、`configure(doc)`，以及给别处对拍用的 `style_table_mismatches(表, 默认值)`、第四轮新增的 `style_config_mismatches(&配置表)`（直接比 `gpui_prose::schema::style_config()` 那样的 Loro 配置表） | 稳定（就是 loro-schema.md） |
| `loro_types` | 重新导出 `VersionVector`、`Frontiers`、`Subscription`、`Cursor`、`UndoManager`，下游用同一个钉住的 Loro | 稳定 |

## 不变量清单（摘要）

完整清单和每条的旧版出处、新版落点、对应测试在 `dr_model::invariant`，由测试当场断言：每条都有落点；没有测试的必须写在 `NOT_YET_TESTED` 里并说明原因（`every_rule_is_tested_or_says_why_not`）；清单和分叉里点名的每个测试都必须真的存在，整个 `next/crates/` 里都会找（`every_named_test_exists`；第六轮起不只 dr-model、dr-doc、dr-workspace，存储和页面的测试也算）。

| 靠什么成立 | 条数 | 例子 |
| --- | ---: | --- |
| 命令层预防 | 40 | 关系不能连自己、名字不能空、要素名不重复、关系类型的定义合法、跨文档先写正文、按对象恢复历史 |
| 读取时容忍 | 54 | 关系一端不在就不显示、分组不在的构想放根目录、主故事线不在成员里就当没有、批注目标不在标「未定位」、合并后重名的要素标出来 |
| 后台修复 | 7 | 语义重复的关系删到只剩 id 最小的、缺书序的章节补上、重复的块 ID 改掉、没人指向的嵌入条目清掉 |
| 结构保证 | 34 | 树不会成环（Loro 保证）、内置关系类型只有一个（创世保证）、写作日的设备和日期就是键、正文永远以换行结尾、列表顺序用位置键、生成的待办 id 确定 |

一条可以同时靠几种办法，所以条数加起来大于 78。和旧版比，**故意改了的**：

- 旧版「不认识的种类和字段一律拒绝」改成「原样保留」：合并没法拒绝远端的改动，而且这样新旧版本能共存。
- 旧版删章节、要素时把它们的关系永久删掉；新版只是不显示，恢复后关系回来。
- 旧版靠外键级联删书；新版一本书就是它的那些文档，按文档 id 一起删。

### 界面和 Agent 做法不一样的地方（已由 F3 统一）

旧版界面和 Agent 工具各走各的代码，同一个操作结果不同。新版两边走同一条命令，F3 照下面的做法实现了（`DIVERGENCES` 里每条都标了「已统一」并挂着 F3 的测试名；分类的空名在工作区里是 `Untitled`，本地化的默认名由界面传）：

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
DR_PROP_CASES=3000 cargo test --release -p dr-doc --test prose_convergence --test book_convergence --test prose_events --test book_seeds -- --nocapture
cargo run --release -p dr-testkit --bin bench -- doc
```

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| 单元测试 | dr-model 34 个；dr-doc 99 个（正文 41、书目 40、对话 9、样式表与位置换算、对等方等 9）。P0-C 的正文用例全部搬过来，换成类型化接口 | 全过 |
| 正文三设备属性测试 `three_peers_converge` | 三台设备随机打字、回车、跨段删、设标题、加人物链接、加锚点、撤销、Agent 写入，任意顺序同步；查收敛、以换行结尾、块 ID 唯一且一致、锚点各处一致；最后断言这一轮真的修过重复块 ID、锚过字也收起过 | 3000 例全过；导入后自动修复 1622 次，没有一例需要额外修复轮；2708 个锚点，793 个收成点 |
| 书目三设备属性测试 `three_peers_read_the_same_book` | 随机建章、建构想、建要素、进出废纸篓、彻底删、建关系（含没按规范顺序存的对称关系）、加减故事线、移动和删除分组、后台修复，任意顺序同步；查各设备读出来一样、读出来的东西守住全部读取规则 | 第一次跑 3000 例时在第 708 例失败：两台设备各建了同一个分组 id，树里有两个同 id 的节点，挂在其中一个下面的子分组读漏了（见下「发现并修好的」）。修好后 3000 例全过：1725 例同步后需要修复，都是一轮修好（第五轮重跑：1842 例，仍都是一轮）。第三轮加查：便宜的 `needs_repair` 和完整的修复计划结论一致；按端点读的关系和全书关系里挑出来的一致 |
| 正文事件属性测试 `insert_events_carry_the_marks_reads_see`（第四轮） | 三台设备随机打字（含加粗、链接、人物链接的边界）、回车、删、加减加粗 / 斜体 / 删除线 / 链接、加人物链接、设标题、撤销、重做，任意顺序同步；每一步都只用事件重建正文和每个字的标记，和重新读出来的逐字比：字一样；插入事件说的标记就是读出来的标记；标记变了的字一定落在 `restyled` 的范围里 | 3000 例全过（release 约 2 秒）：比了 939642 个字，本机带标记的插入 2405 次，导入来的插入 16548 次。把事件里的标记换成空的、或把 `restyled` 弄反，测试都会失败（试过） |
| 种子变更属性测试 `seeds_merge_into_one_and_never_beat_a_real_edit`（第五轮） | 三台设备随机投待办（同一个标记、不同的任务文字）、改正文、解决、删掉再投、建同一张情节规划表、改行名、挪行、加行、先写一大堆别的把时钟拨快，任意顺序同步；查各设备读到的一样，没人改过的待办正文正好是投过的某一个任务文字，有人解决过、没人删过的一定是已解决，表是三行三列加新加的行，挪过的行在真正挪到的位置上 | 3000 例全过（release 约 45 秒）：查了 6280 条待办、其中 1914 条「解决过」，4947 张表、2918 次「挪过的行」。把种子换回普通写入，测试当场失败（试过：挪过的行被晚到的默认值挪回去） |
| 对话属性测试 `honest_devices_converge_and_are_never_refused`（第七轮） | 三台设备各追加自己运行的事件（种类里有以后版本才有的）、重放自己的旧事件、按缺什么补什么同步，还把某台的最新一份更新单独抢先送过去；查老实的同步从不被拒、抢先到而缺依赖的一定被拒、依赖齐了的一定收下，最后各设备读到的一样、每个事件一次、没有读不懂和冲突的，每台设备自己的事件保持追加的顺序 | 3000 例全过（release 约 17 秒）：读了 37090 条记录，拒掉 3897 份抢先到的更新、补齐后都收下，4060 次重放都没多写。故意去掉「缺依赖就拒」或「有删除就拒」，单元测试当场失败（试过） |
| 其他属性测试 | 没人删的锚点永远锚着原文；块 ID 修复是状态的函数（两台设备修出来一样）；位置换算三种单位处处一致、字符中间一律报错 | 全过 |
| 模糊测试（`next/crates/dr-doc/fuzz/`，不进 CI） | `load_bytes`：任意字节当存储的数据载入、导入、读、写；`bad_structure`：用 Loro 原始接口写出结构坏掉的文档（没有末尾换行、段落标记打在字上、字段类型不对、树节点重复同一个 id、两个写入者），再经 `dr-doc` 读写 | 找到两个崩溃（批量导入申请 29 GB 内存、坏锚点让 Loro panic），都已修；修后两个目标各跑 150 秒无崩溃。两个崩溃输入（124 和 546 字节，模糊测试生成的）放在 `tests/fuzz-regressions/`，`tests/fuzz_regressions.rs` 用和模糊目标同一段代码回放 |
| 测量 | `dr-testkit` 基准的 `doc` 套件，统一种子：快跑（tiny）进 CI 只查形状，全跑（heavy）在作者机器上 | 见下 |

### 发现并修好的

1. **坏字节让进程被杀**（模糊测试）：见开头第 4 条。修在 `core.rs`，测试 `corrupted_bytes_are_an_error_not_a_crash`。
2. **坏锚点让 Loro panic**（模糊测试）：Loro 的 `get_text` 遇到不存在的容器会 panic，而锚点字节里的容器 id 是任意的。修在 `anchor.rs`，测试 `anchors_into_another_container_read_as_unlocated`。
3. **同一个分组 id 在树里出现两次时，子分组读漏**（书目属性测试）：两台设备各自导入或新建了同一个分组，Loro 的树里就有两个节点带同一个领域 id。原来只留第一个，挂在另一个下面的子分组整枝不见了，而构想「所在分组存在」用的名单又包括它，两处对不上。现在把树按领域 id 读成一棵逻辑树，重复节点的孩子都归到保留的那个名下；删分组时同 id 的节点一起删。测试 `a_group_created_on_two_devices_keeps_every_child`。
4. **在链接中间回车，新换行带上了链接标记**（单元测试）：Loro 把插在标记中间的字算进标记里。现在凡是新写的换行都清掉行内标记，读取时链接也在换行处断开。

### 关键数字

`cargo run --release -p dr-testkit --bin bench -- doc`，heavy 种子；里程碑测量证据是 [acceptance/f1-m3-doc-bench.json](../acceptance/f1-m3-doc-bench.json)（带输入指纹和当时的机器负载）。只作参考，不是门槛。

| 项 | p50 / p95 | 说明 |
| --- | ---: | --- |
| 打开一章（从快照载入） | 0.44 / 0.55 ms | heavy 种子里最长的一章：22031 字、124 段、222 处人物链接 |
| 第一次读出全部段落（含整章解码） | 2.49 / 2.85 ms | 冷文档第一次读会整章解码（P0-C） |
| 再读全部段落 | 0.42 / 0.52 ms |  |
| `paragraph_at`（按位置找段） | 121 µs / 228 µs | 要读前面各段的块 ID |
| `paragraph_in`（第三轮新增，不看前文） | 10 µs / 13 µs | 编辑器、派生器按段读用它 |
| 位置换算往返 | 2 µs / 2 µs |  |
| 列出人物链接 | 0.42 / 0.67 ms | 读整章 |
| 一次按键：`edit` + 提交 + 导出 | 5 µs / 7 µs | 不含 SQLite；经持有者落盘见 F8 的 store 套件 |
| 打开书目（100 章、300 要素、400 关系、200 批注） | 1.13 / 1.92 ms |  |
| 列章节 | 1.42 / 2.00 ms |  |
| 列能显示的关系 | 2.27 / 2.46 ms | 第三轮起每个端点只查一次键 |
| 某个要素的关系 `relations_of`（新增） | 1.23 / 2.70 ms | 仍要读一遍关系表 |
| 列批注 | 3.32 / 3.73 ms | 目标是否还在改成查键；剩下的是读出 200 条批注本身 |
| 对象还在不在 `entity_exists` | 1 µs / 2 µs | 第三轮前每次读五六个集合，约 4–5 ms |
| 要不要修 `needs_repair`（新增） | 2.17 / 4.96 ms | 没东西要修时和下一行一样，要把节点表、关系表各整块读一遍 |
| 修复计划 `repair_plan` | 2.11 / 5.26 ms | 第三轮前约 5 ms：原来要先算「哪些关系能显示」，现在不用 |

测的时候机器一分钟负载 10.68（别的会话在编译），长尾偏高。和第一轮的旧数字不是同一份数据（旧的是 `tests/measure.rs` 自己造的书，没有批注），只能看量级。

## 里程碑状态

| # | 里程碑 | 状态 |
| --- | --- | --- |
| 1 | `dr-model`：领域类型和 id；每类实体的类型；不变量清单逐条对过旧版并标明归属 | 完成 |
| 2 | `dr-doc`：书目和正文文档的类型化封装（创世、块 ID、块属性与行内标记、人物链接、嵌入、锚点、书序与叙事序、mergeable 映射、来源）；统一位置类型 | 完成 |
| 3 | 给 F3 / F4 的接口，写入不暴露裸 `LoroDoc`，读取不拷贝整章 | 完成，上面已列；标了「可能变」的等下游用起来再定 |
| 4 | 属性测试（含 3000 例三设备）、模糊测试 | 完成 |
| 5 | 第二轮（监管会话审查）：v2 补字段、列表改位置键、待办单一真相、按对象恢复、名字唯一的读取容忍、分叉清单、视图数据归属 | 完成 |
| 6 | M10 / F4 反馈：导入和 Markdown 文件夹的提交也带提交信息；样式表的唯一来源和对拍接口 | 完成 |
| 7 | 第三轮（F3 / dr-text / F8 反馈）：借来的文档上读写和撤销、`from_loro`、`paragraph_in`、按对象的便宜读取、`needs_repair`、快照按字段读和比较、分叉标已统一、证据换新做法 | 完成 |
| 8 | 第四轮（F4 反馈）：插入事件带标记；对照 F4 待协调 3、4、5 核对样式表、锚点、打开文档的分工，补 `style_config_mismatches` 和锚点编码测试 | 完成 |
| 9 | 第五轮（F3 待协调 F1-1 到 F1-3、M15 的六行六列、F4d 的「看过」）：撤销排除 `user:command`；种子变更（投待办、新情节规划表）；正文模板文档和 `insert_copy`；「看过」跨设备的评估；结构记成 v2.1 | 完成 |
| 10 | 第六轮：`insert_copy` 抄格子里的标记、`ProseView::table_cell`；`NOT_YET_TESTED` 的三条挂上测试、清单测试在整个工作区里找；对照撤销不设上限 | 完成 |
| 11 | 第七轮（审 M27 的对话文档）：读取不因内容失败；导入校验只看更新自己的操作、缺依赖的拒；同身份冲突不拒收；`owns_prose` 认对话、投待办只收书的正文；`check_id`；清单四条；属性测试；结构记成 v2.2 | 完成 |

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
   - ~~**第五轮：写入任务开始前先设好提交选项。**~~ F2 第七轮已实现，第二十批整合；原建议： 建议持有者在 `job.run` 之前调一次 `doc.set_next_commit_options(这次的来源和提交信息)`（`dr-doc` 自己的 `edit` 就是这么做的），提交时照旧 `commit_with`。原因：Loro 的导入和解析已删文字上的锚点都会在中途隐式提交一次，种子变更就是在写入中途导入的；不先设好，中途提交的那一部分没有来源，Agent 写入的那一部分还会丢掉提交信息。此前 F3 只能把种子放在写入的最前面来躲开；F2 第七轮以后不再要求这个顺序。
   - **`user:command`**：`dr_model::origin::COMMAND_ORIGIN` 和 `dr_store::COMMAND_ORIGIN` 是同一个字符串，F2 的来源测试里加一行 `assert_eq!` 对上。
   - **模板文档**（`template:` 开头）存法和别的正文一样，不用改表。它不是书的正文（`DocKind::is_book_text()` 为假）：派生索引（dr-index 的 `TextDeriver`）应当像书目文档那样记成「已索引、空的」，不进搜索、不计字数。
   - ~~**第六轮：写入前先设提交选项那条还没做**~~：F2 第七轮已实现，第二十批整合；`COMMAND_ORIGIN` 的对拍也还没加。
   - **第六轮：资源字节到了要让页面知道**（不变量 ASSET-BYTES 的后一半）。做资源同步时，字节落盘后发一个 `asset` 表的变化事件（`events.rs` 现成的「表 + 键」），素材页（M19 的 `MediaPage`）收到这个资源的事件就重读一次；现在它只在打开时读一次，字节后来才到的话要关了重开才显示。
2. **F3（dr-workspace）**
   - **可以拆镜像了**：在持有者的写入闭包里用 `BorrowedBook::new(doc, &book)` / `BorrowedProse::new(doc, &doc_id)` 开视图和事务，撤销用 `ProseUndo::on(doc)` + `undo_step`；读取用 `BookReader::from_loro` / `ProseReader::from_loro` 共享持有者的文档。两条规矩：写之前先 `set_next_commit_options`（带来源和提交信息；F2 第七轮已由持有者代设），因为解析已删文字上的锚点会在中途隐式提交一次；文档要先过 `dr_doc::schema::configure`、带着创世。
   - 清单里标「命令层」的 37 条是命令层的事，`dr_model::check` 有一部分现成的判断。
   - 9 处界面和 Agent 的分叉（`DIVERGENCES`）请照建议做成一条命令，或者改了建议再回来更新清单。
   - 新建要素前用 `element_name_key` 查重；合并后的重名读取时已经标出来（`name_conflict`），界面可以提示作者改名。
   - `edit` 出错也会提交已经做了的部分（Loro 不能回滚），所以先校验再写。
   - 写对称关系前用 `canonical_symmetric`（或 `check::relation_ends`）。
   - 删分组、删素材夹用 `delete_drift_group` / `delete_material_folder`，它们先把子级和成员挪上去；直接删树节点会连子树一起删。
   - `BookDoc::repair()` 现在先问 `needs_repair()`；没东西要修时两者都约 2 ms（各整块读一遍节点表和关系表），比原来约 5 ms 少了一半多，但不是零。重复关系、缺书序这类问题只会在合并远端或导入后出现，建议只在打开书时跑一次、之后只在导入远端更新后跑。
   - 书目读取每次都从 Loro 取整个根映射的值。100 章、300 要素、400 关系时，列章节、列关系各要几毫秒（见上表）。如果 F3 的查询频繁，在它那一层按事件做增量缓存，不要每次都全读。
   - **第五轮（F3 待协调 F1-1 到 F1-3、M15 的六行六列）**：
     - **作者命令的撤销**（F1-2）：`UNDO_EXCLUDED_ORIGIN_PREFIXES` 加了 `user:command`，所以 `ProseUndo` 自己就排除作者的命令。`editor.rs` 里另外加的那个前缀可以删（留着也没坏处）。测试 `the_editors_undo_leaves_the_authors_commands_out`。
     - **投待办**（F1-1）：`todo.project` 里把 `projected_todo` 加 `.body(..).status(Open)` 换成 `project_todo(&ProjectionKind::Marker, &doc, &block, &任务文字)`，返回的写入器上只设作者、来源、元数据、时间，**不要再写正文和状态**（写了就又成了普通写入，并发时又会叠两遍、又会重新打开）。换了以后 `repair_projections`、`doubled_seed` 和 metadata 里的种子可以删；换之前用 `projected_todo` 写的待办带着 `body`，照旧读。同一次写入里先投待办、再删别的（见 F2 那条：持有者先设好提交选项以后就不用管顺序）。待办已经在时 `project_todo` 什么都不写。
     - **情节规划表**（M15 的六行六列）：`plot_grid.create` 换成 `txn.create_plot_grid(&node)?`，不用再写尺寸（没写就读成 184 × 96，和 `DEFAULT_CELL` 一样）。表还没建时 `plot_grid.get` 可以直接给出 `PlotRowId::default_for(&node, 1..=3)` / `PlotColId::default_for` 这几个 id，界面第一次动手前就能用。作者后加的行列照旧用随机 id。
     - **正文模板**（F1-3）：模板文档是 `TemplateOwner::Category(分类).doc_id()` / `TemplateOwner::Storyline(故事线).doc_id()`，建的时候和别的正文一样写 `dr_doc::prose::genesis(&doc_id)`，编辑走 `ProseSession`。「这个分类有没有模板」就看这篇存不存在、正文是不是只剩一个空段。新建要素、章节时，在新正文的第一次写入里调 `BorrowedProse::new(doc, &新id)?.txn().insert_copy(0, &模板视图)`；模板视图在模板自己的持有者线程上取一份副本（比如对它 `fork()` 再 `ProseReader::from_loro`），免得模板正好在被编辑时抄到一半。分类、故事线彻底删除时把它的模板文档一起删（`owns_prose` 已经认它的主人）。
     - **我改了 dr-workspace 的两行**（单独一个提交）：`DocId` / `DocKind` 多了 `Template`，`commands/comment.rs` 的 `owner_of` 和 `commands/mention.rs` 的 `owner` 是穷举匹配，不补就编译不过。两处都归到「没有主人实体」那一支（模板里的 TODO 不投成待办、不排除自链）。F3 看一眼，不对就改。
   - **第六轮**：投待办（`todo.project`）和建情节规划表（`plot_grid.create`）已经换上第五轮的接口，对过了；模板命令不用改，`insert_copy` 现在自己会抄表格格子里的标记。建议补一个测试：一条投出来的待办的 metadata 不是 JSON（或少了 `prose_vv`）时，标记删掉后它照样删得掉（`has_seen` 读不出时当作没有要等的版本）。不变量 JSON-FIELDS「读的地方解析失败当作没有」这一半，现在只有模板那边有测试。
3. **F4（编辑器）**：按 F4 文档「待协调」逐条对过（2026-11-07）。
   - **插入带标记**（F4 待协调 2 的小建议，已做）：`TextChange::Insert { text, marks }`。`dr-editor` 把 `marks` 用和 `read` 同一个函数换成 `gpui_prose::Marks`，传进 `SourceChange::Insert.marks`（总是 `Some`）。`marks` 只对新字里的非换行字成立，这和编辑器只在「一段之内插字」时用它正好对上。`gpui-prose` 的 `text/drdoc_style.rs` 样板里还写着「dr-doc 不带标记」，F4 改样板时顺手改掉。
   - **事件从哪来**：`ProseSession::reader().subscribe(...)`（F3）。回调在持有者线程上、提交的那一刻同步执行，先进队列，回到界面线程再折进镜像（`drdoc_style.rs` 就是这么做的）。它表示「文档变了」，不表示「已经存好」。
   - **样式表**（F4 待协调 3，一致）：Drifting 的文档只由 `dr-doc` / `dr-store` 配，`dr-editor` 不调 `gpui_prose::schema::configure`。两张表逐键核对过一样。`dr-editor` 的测试写 `assert!(dr_doc::schema::style_config_mismatches(&gpui_prose::schema::style_config()).is_empty())`。默认值只有 `dr-doc` 设；`gpui-prose` 不设时没配置的键在本机打不上标记，不会打出规则不同的标记，不算分歧。
   - **锚点**（F4 待协调 4，一致）：编码一样，都是两个 `Cursor::encode()`，`start` 是首字上的 `Side::Left`，`end` 是末字上的 `Side::Right`，点是同一个 `Side::Left` 光标两次（测试 `anchors_are_the_cursor_pair_the_editor_stores`）。两边的 `Anchor` 字段都是 `loro::cursor::Cursor`，`dr-editor` 可以直接搬光标，不用过字节。解析的规则一样；`dr-doc` 多两样：先查光标是不是指向这篇正文，结果夹在全文长度以内。撤销带回的锚点用 `CommentWriter::anchor` / `PatchWriter::anchor` 写回，来源 `user`，要同步；替换光标照旧只进本机的 `AnchorCache`。
   - **`gpui-prose` 自己的 `Anchor::resolve`**（给 F4）：没有容器检查。锚点字节指向一个文档里没有的容器时，Loro 的 `get_cursor_pos` 会 panic，这是 `dr-doc` 第一轮模糊测试找到的（修法见 `dr-doc` 的 `anchor.rs`：先比 `cursor.container` 和正文的容器 id）。只影响 `LoroSource`；Drifting 里经 `dr-doc` 解析，碰不到。
   - **打开文档的分工**（F4 待协调 5，一致）：存储打开文档时调 `dr_doc::schema::configure`（样式表、默认值、时间戳），设备对等方由 F2 分配，创世由 F3 用 `dr_doc::prose::genesis` 写，块 ID 修复由 F3 在持有者的写入里用 `BorrowedProse::txn().repair_block_ids()` 做（来源 `repair`）。`dr-editor` 拿到的是已经打开、配好、修过的文档。
   - **撤销计数**：编辑器把一阵连打的几项合成一步、按步一项一项撤，所以它数过的每一项都得还在 Loro 的撤销栈里；按 `ProseUndo::undo_count` 前后相减算 `EditResult::undo_items` 的文本源（`gpui-prose` 的 `drdoc_style.rs` 样板）在有上限的栈满了以后还会算成 0（`dr-editor` 的 `SessionSource` 是从正文订阅里数作者的提交，合并间隔 0，一次提交一项）。所以 `dr-doc` 的撤销栈不设上限。Loro 公开的 `loro::UndoManager::new` 默认只留 100 项（只有 `loro-internal` 自己的默认才不设上限），所以 `ProseUndo::new` 显式设成 `usize::MAX`；2026-11-08 之前没设，作者实际只能撤最近约 100 个按键。测试 `the_authors_undo_stack_has_no_limit`：提交 250 次，每次多一项，全部撤得回。
   - **每次按键的查询**照旧用 F4a 自己的段落索引，不调 `ProseView::paragraph_at` / `paragraph_by_id`（前者 2 万字章约 0.12 ms，后者全文扫描）。
4. **批注、补丁的正文和素材描述**在书目文档里是 `LoroText`，现在只给了纯文本写入（按最小差异更新，并发会合并）。审阅模块（M-审阅）如果要在批注里用富文本，要么在 `dr-doc` 加一套书目文档内的富文本接口，要么以后把批注正文挪成独立的正文文档。等该模块开工时定。
5. **M10（旧库导入）**：退役取值用 `dr_model::legacy` 规整；旧 `anchor_json` 拆成 `anchor`（光标对）、`quote`（`selectedText` / `textAnchor.text`）、`snapshots`（`blockSnapshots`，没有时用 v2 的 `blockText`）、`region`；`comment_action` 里 `start_agent_task` 的 `conversationId` 写进 `agent_conversation`；元数据里 `kind = todo-autoparse` / `note-task` 的待办，改用 `CommentId::for_projection` 的 id 和 `projection` 字段；旧的 `position_key` 原样写进 `pos`；本机 localStorage 里的颜色、目标、固定位置在交接时一起导出。
6. **正文模板（第五轮已做）**：新的文档种类 `template:category:<id>` / `template:storyline:<id>`，用法见上面 F3 那条。旧字段 `chapter_template` / `element_template` 原样保留、只读。**M10** 导入旧库时把旧 JSON 用和章节正文同一个转换器写进模板文档（导入对等方，两台设备导入同一个旧库写出的一样），旧字段不用动。**dr-index、统计（M20）、导出（M41）、Markdown 文件夹（M40）** 遇到 `template:` 文档一律跳过（`DocKind::is_book_text()`）。
7. **Loro 的两个问题要不要报上游**：`import_batch` 不查校验和、解码器信任字节里的长度（修复很小：批量导入也传 `check_checksum = true`）；按不存在的容器取文本会 panic（有 `try_get_text`，但 `get_cursor_pos` 之类的路径不该让坏光标走到那里）。报不报、谁报，由监管会话定；我没有对外发任何东西。
8. **Agent 改动「看过」跨设备（F4d；第五轮只评估，没做）**
   - **现状**：账本 `agent-marks.json` 在本机；记号来自 dr-store 的结算记录，而结算记录只在 Agent 跑的那台设备上、不同步。所以换台设备不只是「看过」跟不过去，连「哪些字是 Agent 写的」也没有：B 收到 A 上 Agent 写的字，根本不上色。
   - **结论：分两半。**
     1. **记号不同步，每台设备自己算。** Agent 的提交本来就带提交信息 `agent:<会话>/<轮>`（Markdown 文件夹是 `mirror`），存在 Loro 历史里、随同步走。任何设备都能从历史里找出这些变更，对「这次变更之前 → 之后」做和现在一样的 diff，得到同样的几处新字；每处的 id 由（文档、这次变更的 ID、第几处）算出，处处一样。只算最近 30 天（按变更自带的时间，所有设备一致）的变更，更早的一律当看过：新设备第一次打开时不会把历史上的 Agent 改动全染色，「看过」的集合也有了上限。
     2. **只同步「看过」：每本书一篇单独的小文档 `seen:<书 id>`**，里面一个映射：记号 id → 看过的时间（秒）。碰到一处写一个键，两台设备碰了同一处合起来还是一个键。
   - **为什么不放书目文档**：一条约 60 字节，作者一天碰掉几十处，一年就是 1 MB 上下的历史，而书目文档每次打开书都要整篇载入、历史永不裁剪。单独一篇只在编辑器上色时才读；以后大了可以换一篇新的（窗口外的记号本来就算看过，丢掉旧的不影响）。也不做成正文里的行内标记：那会让「看没看过」进正文的撤销、导出、Markdown 文件夹和复制粘贴。
   - **要动的**：F1 加一个文档种类和读写接口（加、查），结构升小版本，和模板一样要在 dr-workspace 的两处穷举匹配里补一行；F4d 的账本改成从历史算记号（新到的变更按对等方和计数遍历，读提交信息），本机只留「算到哪了」；结算记录不变（Agent 撤销还用它）。本机 `agent-marks.json` 迁移：窗口内、本机单子上已经没有的记号写成看过。
   - **代价**：每次同步来新的 Agent 变更，后台对它做一次 diff，和账本现在对结算记录做的一样。
   - 要做的话，由监管会话排进某一轮。

9. **M27 的对话文档（第七轮审）**：审查结论、我改了什么、要 F2 / M36 / M27 / M31 做的，都写在 [m27-conversation-schema.md](../modules/m27-conversation-schema.md) 的「待协调」。要点：存储清理没主人的正文时照 `owns_prose` 就不会删对话；同步要按因果顺序送对话的更新，被拒的不能当成已收；`entries()` 不会再因内容报错，`problems()` 留给诊断。

## 没做完的，和下一个里程碑建议

- **没做**：批注 / 补丁正文的富文本接口（见待协调 4）；书目读取的缓存和增量索引（见待协调 2）；模糊测试只跑了几分钟；「看过」跨设备只评估（见待协调 8），等帮手搬过来再做；资源字节同步到了以后素材页自动重新显示（ASSET-BYTES 的后一半，等 F2 的资源同步）。
- **探针**：`next/spikes/loro-model/` 原样保留没动。种子已经由 F8 搬进 `dr-testkit`，基准也改用 `dr-doc`；探针删不删由监管会话定。
- **建议的下一个里程碑**：
  1. `dr-editor` 开工后，按它真正用到的补接口（比如段落属性改动在事件里直接带上新属性，设标题就不用回读整段，这要 F4a 的快路径一起做）；
  2. 书目读取按事件做增量缓存，如果 F3 的查询热起来。

## 代码位置

```text
next/crates/dr-model/src/
  id.rs kind.rs book.rs prose.rs order.rs origin.rs time.rs check.rs invariant.rs conversation.rs
next/crates/dr-doc/src/
  schema.rs peer.rs pos.rs core.rs anchor.rs undo.rs error.rs
  prose/  mod.rs view.rs txn.rs attrs.rs embed.rs event.rs tests.rs
  book/   mod.rs read.rs write.rs seed.rs fields.rs tests.rs
  conversation.rs conversation/tests.rs（M27 加）
next/crates/dr-doc/tests/
  prose_convergence.rs book_convergence.rs prose_events.rs book_seeds.rs conversation_convergence.rs positions.rs invariant_tests_exist.rs
  fuzz_regressions.rs fuzz-regressions/ fuzz_seeds.rs
next/crates/dr-doc/fuzz/   load_bytes、bad_structure（独立工作区，不进 CI）
next/crates/dr-testkit/src/bench/doc.rs   基准的 doc 套件
docs/rust-rewrite/acceptance/f1-m3-doc-bench.json   第三轮的测量证据
```
