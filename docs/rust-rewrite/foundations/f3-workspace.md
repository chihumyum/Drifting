# F3：dr-workspace（命令、查询、事件、撤销）

2026-11-07 两个里程碑，2026-11-08 第三轮（给编辑器的三样）、第四轮（各模块要的小命令、M09 快照历史）、第五轮（情节规划、补丁、模板的命令，别人写的字自动链人物，换上 F1 的按键读取）、第六轮（换上 F2 的作者命令来源和删书记录，提交事件只读改到的段落，M11 要的三样）、第七轮（换上 F1 的种子写法和模板文档，自动链人物补齐已有正文，换库失败交还工作区，`mention.list` 提速，要素带更新时间）、第八轮（时间线上一步放一章、打散，补链在 heavy 种子上提速，匹配器按书缓存）、第九轮（模板文档变了，书目快照跟着变）和第十轮（叙事时上一步建章，构想转成章节或要素）。计划见 [foundation.md 的 F3](../foundation.md#f3-dr-workspace)，代码在 `next/crates/dr-workspace/`。它建在 F1（[f1-model-doc.md](f1-model-doc.md)）、F2（[f2-store.md](f2-store.md)）和 dr-index（[dr-text-index.md](dr-text-index.md)）之上，不依赖 GPUI。

## 做了什么（大白话）

### 第十轮：叙事时上一步建章，构想转成章节或要素

1. **`chapter.create` 能直接给叙事位置**（M14 要的）：输入多了 `narrative_order`（有限的数）。时间线在叙事时里双击空白新建一章，一次提交、一步撤销（撤销还是 `chapter.trash`）；以前要先建在书末，再 `chapter.update` 放上叙事轴，两步。书序照旧由 `place` 定（不给就是书末）。
2. **构想转成章节、转成要素**（M16 构想面板下一轮要的，旧版编辑器的「转换为章节…」「转换为要素…」，`NodeEditorView` 的 `handleConfirmConversion`）。查过现有的命令：
   - **绑到幕、绑到时间钉已经够了**：幕是 `act.update { drift: 构想 }`（`null` 解开），时间钉是 `time_pin.create { idea }` / `time_pin.update { idea }`（`null` 解开），都是一步撤销，和旧版一样一个构想可以绑在幕或钉上。构想进废纸篓时它们读成没绑，恢复后回来。
   - **转换缺两个命令，这一轮加了**：
     - **`idea.to_chapter { book, id, storyline? }`**：同一个节点变成章节，标题、正文、批注、关系、叙事位置都不变。照旧版：状态改成草稿，放到最后一章后面（和新建章节一样，在最后一个幕分界之前），去掉构想分组；给了故事线就挂上并设为主故事线（旧版界面一定要选一条，这里可以不给）；绑着它的时间钉和幕都解开（旧版 `unbindMarkersForDrift` / `unbindActsForDrift`），没有标签的时间钉留下构想的标题当标签。一次提交、一步撤销：撤销把这个节点、那几个钉和幕退回转换前的样子（`history.restore_entities`，和彻底删除的撤销同一个办法），又是原来的构想、原来的分组和绑定。返回 `{ id, title, book_order }`。
     - **`idea.to_element { book, id, category?, name? }`**：照旧版新建一个要素：名字是构想的标题（可以用 `name` 换一个），梗概照搬，正文整篇抄过去（`insert_copy`，标记和链接都在；不套要素模板），带上分类的字段模板；然后构想进废纸篓（旧版是直接删，这里进废纸篓，能撤）。名字已经是别的要素的就拒绝（`name_taken`，和 `element.create` 一样），界面可以让作者换个名字再试。要素的名字照常补链进已有的正文；正要离开的构想的标题不再占着这个名字。返回新要素的 `{ id, name }`。撤销一步：要素进废纸篓、构想恢复（补链的链接也去掉）。
   - **一处和直觉不同、和旧版一样**：别的正文里已经链到这个构想的字（构想建的时候补上的），转成要素后还是链着那个进了废纸篓的构想，不会自动改成链到新要素；只有还没链的地方链上新要素。要「连旧链接一起改指向」的话告诉我，可以在同一步里把指向构想的链接换成指向要素（撤销照样一步）。
3. **bench**：见下面「检查」一段末尾。

命令和查询从 134 条变成 136 条：100 条命令，36 条查询。新加 `idea.to_chapter`、`idea.to_element`；`chapter.create` 多了 `narrative_order`。能力清单快照已更新。

**改了别的 crate 的三处**（`ChapterCreateIn` 多了字段，不补编译不过，都只补 `narrative_order: None`，行为不变）：`dr-view-timeline/src/view.rs`（双击新建；换成一步由 M14 自己改）、`dr-view-elements/tests/storyline.rs`、`dr-export/src/import/write.rs`。

检查（合了 main 069caa5e 以后，只跑必要的）：`cargo fmt --all --check` 干净；dr-workspace 和补了字段的三个 crate（`dr-view-timeline`、`dr-view-elements`、`dr-export`）的 clippy 干净；dr-workspace 130 个测试全过；release 下单设备、两设备属性测试各 3000 例通过（254 秒，随机命令多了构想转章节或要素）；`cargo xtask check` 10 道门全过；公开边界检查通过。别的 crate 没重跑。**bench 没跑**：负载 19–101，没低过 5；而且第八轮补链的那组数字要成证据，得 F8 先在 `bench workspace` 里加补链那一项（第九轮待协调 F8 写了具体做法），现在的套件里没有，空闲时跑也补不上。

### 第九轮：模板文档变了，书目快照跟着变

1. **问题**（M01 发现的）：故事线的章节模板、分类的要素模板各是一篇自己的正文（第七轮）。作者只改模板时，书目文档没变，F3 只发这篇正文的 `Prose` 事件；外壳只在收到这本书的 `Book` 事件时重读快照，所以快照里的 `has_chapter_template`（`has_element_template` 也一样）一直是旧的。M13 那页是直接问 F3 绕过去的。
2. **做法：照事件模型，把它当成主人的一个字段变了。** 模板文档的一次提交让它「有没有模板」翻转时（从空的变成有字，或者反过来），F3 在这篇正文的 `Prose` 事件后面再发一条 `Book` 事件，只点名它的主人：
   - 故事线：`EntityChange { collection: Storylines, id: 故事线, fields: ["chapter_template"] }`；
   - 分类：`EntityChange { collection: Categories, id: 分类, fields: ["element_template"] }`。
   - 字段名就是 0.1 存模板的那两个字段名，所以只看字段的订阅者，旧字段变了和模板文档翻转，看到的是同一个名字。`seq`、`origin` 是模板文档那一次提交的。
   - 在模板里接着打字、改字（一直有内容）只有 `Prose` 事件，不会每打一个字就让外壳重读整本书。
   - 「有没有模板」和 `storyline.list` / `category.list` 用同一个判断（不只是一个空段）。上一次的状态按文档记着：列表查询算过的记一笔，之后以每次提交为准（提交在持有者线程上按顺序到）；还没记过就当翻了，多发一次。另一台设备同步来的改动走同一条路。
   - 模板文档不会单独删除（主人彻底删除时它留着，由存储清掉）；主人进废纸篓、删掉本来就是书目的变化。
3. **和 F6 的书目快照对过**：`dr-shell` 的 `on_library_events` 收到这本书的任何 `WsEvent::Book` 就整份重读（`Book::load` 里 `storyline.list`、`category.list` 都带着这两个布尔值），所以外壳不用改。M13 那页可以去掉绕路，直接读快照里的 `storylines[i].has_chapter_template`；页上要显示模板正文的，再订这篇模板文档的 `Prose` 事件（或者直接用编辑器开 `chapter_template.document` 给的文档）。
4. **测试**：编辑器里往空模板打第一个字，发一条点名故事线的 `Book` 事件，列表随之变成有；接着打字只有 `Prose`；删光再发一条，列表变回没有。分类的要素模板经 `category_template.set_body` 也一样：空→有发、有→有不发、有→空发。
5. **bench**：负载一直在 18 以上（要求低于 5），没跑。第八轮的补链数字要成证据，得在 `bench workspace` 里加一项（见待协调 F8）。

检查（合了 main eb221684 以后，按派发只跑必要的，没有全量重跑）：`cargo fmt --all --check` 干净；dr-workspace 的 clippy 干净；dr-workspace 125 个测试全过（含 debug 下默认例数的属性测试）；`cargo xtask check` 10 道门全过；公开边界检查通过。只改了 dr-workspace，没动接口，别的 crate 没重跑；release 3000 例这轮没跑（命令没变）。

### 第八轮：时间线上一步放一章、打散，补链提速

1. **`chapter.place`：时间线上放一章**（M14 要的，旧版 `persistChapterTimelineMove`）。
   - 输入 `{ book, id, axis: "book" | "narrative", order, storyline? }`：把章节放到书序或叙事时的一个确切位置（拖放松手的位置，不吸附）。
   - `storyline` 不传是不改故事线；`null` 是去掉所有故事线（拖到「未归属」）；给 id 就是拖到那条泳道：它成为主故事线，原来的主故事线去掉，别的副线留着（规则照旧版 `resolveChapterTimelineMembership`，和 M14 的 `model::membership` 一样）。
   - 换线和挪位置是一次提交、一步撤销。撤销用 `chapter.update` 原样退回（位置、全部故事线、主故事线）；为此 `chapter.update` 多了 `book_order`（确切的书序，`null` 是拿出书序）。
   - 和现在一样就什么也不写，也不留一步。目标故事线已删除时拒绝。
2. **`chapter.spread`：打散**（旧版的 `spreadTimelineNodes` + `remapActBoundariesForSpread`）。
   - 输入 `{ book, axis }`：这条轴上所有放了位置的章节（不含废纸篓里的）顺序不变，从 `min(第一章, 1)` 起每隔 5（`CHAPTER_ORDER_STRIDE`）放一章。
   - 书序轴上，幕的分界跟着走：落在它前后两章新位置的正中间；前面没有章就是后面那章往前半格，后面没有就是前面那章往后半格。开头那一幕（没有分界）不动。叙事时轴上没有幕。
   - 一次提交、一步撤销；已经是等距的就什么也不写。
   - 撤销用新命令 **`chapter.arrange`**：`{ book, axis, chapters: [{id, order}], acts: [{id, start_order}] }`，把几章（和几个幕的分界）一次放到确切的位置。它自己也能用（比如以后一次拖动几章），撤销还是它。
3. **补链在 heavy 种子上量了，慢的不是匹配器，是逐篇打开文档**。用一个临时探针（没提交）在 heavy 种子书（100 章、150 万字、615 篇正文含「灯塔」，书里 700 个名字）上量。负载一直在 47 到 176 之间跳，同一个命令前后能差几倍，下表只作参考：
   - 第七轮的写法，新建一个叫「灯塔」的要素要 13–18 秒（链进 555 篇，7833 处），撤销 6–18 秒；「河」一篇都链不上（都在更长的名字里），也要 5–9 秒。
   - 拆开看（负载约 70）：逐篇打开 7.0 秒（每篇 12.6 ms：经过只留 16 篇的打开缓存，每开一篇都要做一次块 ID 修复、挤掉一篇别的）；搜索和挑候选 2.5 秒（每篇读一次书目的键）；写 2.4 秒；每篇重建一次去掉自己的匹配器 2.0 秒。
   - 匹配器本身：书里的名字表（dr-text 的 `book_link_names`）加上建 Aho–Corasick，一次 19–120 ms（看负载，多数 40–50 ms），其中建自动机只占 2–17 ms，大头是从书目读名字。
   - 改了这些：
     - **名字表和匹配器按书缓存**（新的缓存键 `LinkNames`，要素或节点有任何变化就作废；匹配器按「去掉哪个实体」各存一份，最多 32 份）。`prose.replace`、带正文的 `chapter.create` 和补链都从缓存取；编辑器用 **`Workspace::link_matcher(doc)`** 拿同一份（见待协调 F4）。所以「匹配器要不要按书缓存」的答案是要，省下的是每次 40–50 ms 的读名字。
     - 补链整条命令只建一个匹配器；一篇正文里出现了它自己的名字时，才给它单建一个去掉自己的。
     - 挑候选改用书目的缓存（节点表、要素表），不再每篇读一次 Loro。
     - 只看含新名字的段落；先在现状上算一遍，算出来没有要链的就不写（「河」那种）。
     - 不在打开缓存里的文档临时打开（不做块 ID 修复、不挤掉作者开着的文档），用完就放。
     - **几篇一起做**：每篇的打开、规划、写入放到最多 8 个线程上（`holder::par_map`），结果按文档顺序收回，效果和撤销的顺序不变。
     - 撤销合成一条：`prose.unlink` / `prose.link` 的输入改成 `{ links: [{ doc, target, anchors }] }`，一条命令处理所有文档，也是几篇一起写；先校验全部锚点（开着的看持有者的版本，没开的看存储的版本，都不用加载文档），有一条不对就整条拒绝、什么也不写。
   - 改后，负载 47–68 时：新建「灯塔」要素 1.8 秒、撤销 1.5 秒；「河」1.0 秒；加别名「灯塔」1.2 秒、撤销 1.3 秒；新章节标题「灯塔」1.8 秒、撤销 2.1 秒。负载 97–176 时新建「灯塔」要素是 2.7 秒。
   - 还剩的大头是把几百篇长章节从 SQLite 读进来。名字在几百篇里出现、又真要链上的，这就是下限；再快要么让 dr-store 给一个不起持有者、直接往没打开的文档追加一次改动的写法，要么让索引能回答「这一段的原文」，好在打开之前就排除链不上的（待协调 F2）。
4. **测量**：负载一直在 47 到 176 之间，没跑 `bench workspace --milestone f3-m3`。F8 说搜索那一项已经关了。

命令和查询从 131 条变成 134 条：98 条命令，36 条查询。新加 `chapter.place`、`chapter.spread`、`chapter.arrange`；`chapter.update` 多了 `book_order`；`prose.link` / `prose.unlink` 的输入改成一次多篇（第七轮加的，还没有别的模块调）。能力清单快照已更新。

**检查**（合了 main 2eb865fa 以后）：`cargo fmt --all --check`、全工作区 clippy 干净；全工作区 `--no-fail-fast` 1313 个测试通过、1 个没过（18 个默认忽略），没过的是第十三批新加的 `dr-view-shelf-art` 的 `a_cover_is_read_from_the_book`：这个 worktree 里没有生成 `next/.cache/fonts`，「chars」画风找不到字体就什么也不画，和 F3 无关（见待协调 M01）；改完最后两处以后 dr-workspace 单独重跑 123 个全过；release 下单设备、两设备属性测试各 3000 例通过（423 秒，负载 37–98，随机命令多了放一章和打散）；`cargo xtask check` 10 道门全过；公开边界检查通过。

### 第七轮：种子写法、模板文档、补链、交还工作区、提及提速、要素更新时间

1. **投待办、建情节规划表换上 F1 的种子写法。**
   - **投待办**：`todo.project` 改用 `BookTxn::project_todo`。种类、目标、所在段、任务文字和「未解决」由 dr-doc 写成一份种子变更，每台设备写出来一模一样，Loro 只留一份；工作区只再写作者、来源、metadata 和时间。
     - 第三轮的事后修复删了：导入书目后的 `repair_projections`、判断「正文是种子重复几遍」的 `doubled_seed`、metadata 里的 `seed`。旧数据里的 `seed` 读的时候忽略。
     - 两台设备同时投同一个标记，一次交换就只剩一条、正文只读一遍（以前要等修复再交换一次）。
     - 新测试：A 投了待办、改了正文并标成已解决，离线的 B 后来也投了同一个标记；合并后两边都是已解决、正文是 A 改过的。种子的操作在历史最底下，任何一次真正的编辑都压过它。
     - F1 说「投待办要放在一次写入的最前面」，因为 F2 的持有者还没在写入任务开始前设好提交选项。F3 的写入一直是自己先设的（`holder::write`，第三轮起），种子导入时的中途提交也带着来源和提交信息，所以不用挪位置。
   - **情节规划表**：`plot_grid.create` 改用 `BookTxn::create_plot_grid`，默认三行三列的 id 是 `PlotRowId::default_for` / `PlotColId::default_for`，不再写格子大小（没写就读成 184 × 96）。
     - `plot_grid.get` 在表还没存时就给出这些 id（`exists: false`），界面第一次动手前就能用。
     - 每个写表的命令都先调 `create_plot_grid`（表在就什么也不写），所以界面不用先单独调 `plot_grid.create`：第一次打字、加行、改大小，表就存下了。没存过的表「清空」什么也不写。
     - 新测试：两台设备同时从默认表开始，一台写格子、一台改行名，合并后仍是一张 3 × 3 的表，两样改动都在。
2. **正文模板改成 F1 的模板文档。**
   - 类目的要素模板是 `template:category:<类目>`，故事线的章节模板是 `template:storyline:<故事线>`，各是一篇正文。两台设备同时改，像改章节一样合并。
   - **新建时套用**：新建要素时有类目、自己没给正文，新建章节时给了故事线（就是它的主故事线）、自己没给正文，就把模板整篇抄进去（dr-doc 的 `insert_copy`：标题级别等段落属性、加粗等标记、人物链接、表格都抄，块 ID 是新的）。抄之前先在模板自己的持有者线程上取一份副本，作者正在改模板时也不会抄到一半。以后再改模板，已经建好的页面不变。
   - **命令**：
     - `category_template.body` / `chapter_template.body` 把模板读成「段落 + H1/H2/H3」（旧版模板编辑器只有这些；表格不列）；
     - `category_template.set_body` / `chapter_template.set_body` 整份写回，开头和结尾没变的段落原样留着（块 ID、标记、链接都不动），只换中间变了的，两台设备改不同的地方能合起来；撤销是把模板退回改之前的版本。和现在一样就什么也不写；
     - `category_template.document` / `chapter_template.document` 登记这篇文档并返回它的 id，给编辑器打开（`ws.prose_session(id)`），模板就和普通页面一样编辑。
     - `category.list` 照旧带 `has_element_template`，`storyline.list` 多了 `has_chapter_template`：文档存在并且不只是一个空段才算有。
   - **旧版的 JSON 字段**（`element_template`、`chapter_template`）只读：模板文档还没登记时，读、套用都认这个字段；一旦登记了，以文档为准，清空了也是清空。`*.document`、`*.set_body` 遇到只有旧字段的库，先把旧字段写进文档（这一步不算作者的一步，不进日志）。M10 导入时自己转（见待协调 M10）。
   - 类目、故事线彻底删除时，模板文档和别的页面的正文一样留着：删除能撤销（恢复书目里的实体），没有主人的正文由存储清掉（F1 的 `owns_prose` 已经认模板的主人）。
3. **F4 要的自动链人物三件事**（`f4e-editor.md` 第四批待协调）：
   - **规则补了一条**：指向别人、恰好盖住这个名字的链接不让出去。这种情况是名字后来被别的对象拿走了，原文指的还是原来那个人。现在 `link_written` 和编辑器一样。
   - **公开了只算不写的规划**：`dr_workspace::autolink::plan(段落文字, 段落里的链接, 匹配器, 范围)` 返回这一段要加哪些链接、要去哪些链接（`LinkEdit`），一处写明规则；`link_runs` 从 dr-doc 的段落读出链接，`keep_added` 只留新名字的，`apply` 写进事务。编辑器可以直接用，不用自己留一份同样的规则。
   - **补链挪进命令**：书里多了名字，已经写好的正文也链上：新建要素（名字和别名）、改名、加别名，新建章节或构想、改它们的标题。
     - 只看活着的章节、构想、要素正文、故事线和分类的说明，不碰素材笔记（旧版也不碰），不碰自己的正文；只链新名字。哪些文档要看：dr-store 的段落索引里搜得到这个名字的，加上这台设备上开着的（它最新的字可能还没进索引）。
     - 每篇一次提交，来源是命令自己的（作者是 `user:command`），不进任何编辑器的撤销栈，开着的编辑器的撤销也不受影响；撤销进日志：新命令 `prose.unlink` 去掉这次加的链接、`prose.link` 放回这次让出去的短链接，都按锚点（两个光标）找位置，作者之后打的字不会让它们找错。
     - 只有作者和帮手的命令补链；导入、镜像、同步不补（导入自己决定，见待协调 M10）。设置「自动要素链接」关掉时也不补。
     - 编辑器里的后台补链可以删掉了，怎么删见待协调 F4；已经发消息告诉 F4。
4. **换库失败时交还工作区**（F6 要的）：`Workspace::try_shutdown()` 关不掉时返回 `ShutdownRefused { error, workspace }`，照 dr-store 的 `try_close`：
   - 还有别的克隆拿着工作区：交还原来那个，重新订阅库的事件，开着的文档已经关掉、下次用到再开；
   - 库本身拒绝关：在交还的库上重新开一个工作区，作者的自动链接设置照旧；只有连撤销日志都读不出来时 `workspace` 才是 `None`。
   - `shutdown()` 照旧，就是 `try_shutdown()` 去掉交还的部分。
   - 新测试：别的克隆拿着时被拒、交还的工作区还能写、缓存还跟着事件走、设置还在；别的克隆放手后能关、重开后数据都在。
5. **`mention.list` 提速。** 先按 dr-store 返回的行里本来的字符串分组（每行不再新建字符串），每组只查一次两头还在不在、每个对象只查一次，排序也在借来的数据上做，最后只为要返回的行建结果。
   - 新加 `limit`：只要提及最多的前几条（帮手问「谁被提到最多」时用），只为这几条建结果、转 JSON。
   - 同次数、同段数的行按来源文档、目标、种类排，结果是确定的。
   - heavy 种子上量的数在下面的表里。
   - M20 量到的 687 ms 是在负载 56–111、F2 加索引之前；这一轮在空一些的机器上量不出那么慢。剩下的时间一半是把 2 万多行转成 JSON（`Workspace::call` 的事，2 万行就得这么多），一半是取行和分组。

`mention.list` 整本书，heavy 种子（一本书，22057 行引用），release，负载 13–18，同一台机器上改前、改后背靠背各跑 9 次取中位数（只作参考）：

| 项 | 改前 | 改后 |
| --- | ---: | ---: |
| dr-store 取行 | 15.0 ms | 13.5 ms |
| 按类型调用（取行 + 处理） | 37.4 ms | 28.0 ms |
| 按名字调用（再转成 JSON） | 80.6 ms | 50.0 ms |
| 按名字调用，`limit: 50` | — | 24.2 ms |

6. **要素带 `updated_at`**（M11 要的）：`element.list` 每条多了 `created_at` 和 `updated_at`（秒）。
   - `element.update` 改任何一样（名字、别名、字段、梗概、类目、肖像、固定位置）都在同一次书目提交里盖一个时间戳；`updated_at` 取这个时间戳（没有时用创建时间）和正文最后一次存盘的时间里晚的那个，所以作者在编辑器里改正文也算，不用每次打字都写书目。
   - dr-doc 的要素还没有这个字段：F3 自己写、自己读这个键（`updated_at`，和批注的一样用秒），编码和 dr-doc 的时间一致。等 F1 加上 `Element.updated_at` 和写入器，读写换成它就行，已经存的不用改（待协调 F1-5）。

命令和查询从 125 条变成 131 条：95 条命令，36 条查询。新加 `category_template.document`、`chapter_template.body`、`chapter_template.set_body`、`chapter_template.document`、`prose.link`、`prose.unlink`；`mention.list` 多了 `limit`，`element.list`、`storyline.list` 多了字段，`chapter.create` 的说明加了套用章节模板。能力清单快照已更新。

**改了别的 crate 的两处**（都是跟着接口变，不改行为）：
- `dr-view-stats/src/detail.rs` 里建 `MentionListIn` 的地方补了 `limit: None`（结构体多了字段，不补编译不过）。
- `dr-editor/tests/assist.rs` 的 `a_new_element_links_itself_in_text_already_written` 最后一段：补链现在是命令的一步，编辑器的 ⌘Z 不再撤掉它，改成断言「编辑器撤销后链接还在、对象级撤销后没了」。编辑器自己的后台补链还在，碰到已经链好的就什么也不做；F4 删掉它时这个测试一起改。

**性能**：负载在 13 到 140 之间跳，没跑 `bench workspace --milestone f3-m3`。上面第 5 条的数字是单独粗量的。

**检查**（合了 main 77a957d3 以后）：`cargo fmt --all --check`、全工作区 clippy 干净；全工作区 `--no-fail-fast` 1225 个测试通过、0 个失败（18 个默认忽略）；release 下单设备、两设备属性测试各 3000 例通过（164.5 秒，上一轮 56 秒：补链让每次建改要素、章节多做一次索引搜索和几次写入）；`cargo xtask check` 10 道门全过；公开边界检查、文档守护测试（14 项）通过。

### 第六轮：作者命令的来源、删书记录、提交事件提速、M11 要的三样

1. **换上 F2 的 `Origin::Command`（`user:command`）。** F2 第五轮给了「作者的命令」这个来源。作者的命令改正文时，工作区直接用它交给持有者提交，写入任务里不再自己提交一次（第三轮的绕法，F2-3 结案）。
   - 存进 SQLite 的那一行现在记作 `user:command`（以前是 `user`）；它在各处都算作者的写入（`Origin::is_author()`）。测试跟着改了。
   - 按 `Origin::User` 认作者的地方：F3 自己没有；M07 的 `writes_here`（这台设备写了多少字）改成认 `is_author()`，作者从命令面板改的字也算今天写的，加了单测。
   - 书目文档的写入照旧记作 `user`：书目没有编辑器的撤销栈，用不着区分。
   - 会话的撤销管理器仍然自己排除 `user:command`。F1 这一轮也会把它加进 `UNDO_EXCLUDED_ORIGIN_PREFIXES`，到时两处都排除，不冲突。
2. **删书防拉回：照 F2 的做法核对，规格收掉。** F2 第五轮做的（迁移 0005 的 `purged_doc`）覆盖了 F3 规格里的全部要点：
   - 每篇文档删掉时留一条记录，一本书在最后一篇文档删掉后算删除。F3 删书时书目文档最后删，中途出错时书还在「最近删除」里，再删一次就完，正好合得上；
   - 删过的文档、删过的书里的文档，再建、再登记一律 `StoreError::Purged`，打开照旧 `NotFound`；
   - 同步要的清单是 `purged_docs`，有意找回是 `forget_purged_book`。
   - F3 这边补的：`import_remote` 现在返回是否导入了。碰到已删的文档或书，返回 `false`、什么也不写，不算错误。有测试：A 删了书，B 上这本书的更新到 A，书不回来；解除记录以后再导入，书回到「最近删除」。
   - 共享笔记 `f3-asks-f2-purged-books.md` 已删。
3. **提交事件只读改到的段落。** F4 量到：每次按键，持有者线程大约六成时间花在提交事件里。原因是事件要说明改到了哪几段，以前用 `ProseView::blocks()` 把整篇每段的换行和样式都读一遍，再挑出改到的。
   - 现在从改动的位置出发：往回找到第一段的段首，再往后一段一段找换行（dr-doc 按 512 字一块扫），每段只读换行上的块 ID。
   - 和以前的读法逐个比对过：性质测试随机生成正文和改动范围，两种读法结果一样。
   - 粗量（release，负载约 30，只作参考）：20250 字的一章里改一个字，这一步从 462 µs 降到 10 µs。
4. **M11 要的三样：**
   - **`BookInfo` 带 `created_at`**（Unix 秒）。`book.list`、`book.get`、`book.shelf` 都有了；书架那条原来自己有一个 `created_at`，挪掉了，免得重名。
   - **类目的字段模版**第五轮已经有了（`category_template.list/put/remove`）。这一轮 `category.list` 每条直接带上 `template_fields` 和 `has_element_template`。
   - **类目的要素模版（正文模板）**：`category_template.body` 读成「段落 + H1/H2/H3」，`category_template.set_body` 整份写回（空的就是去掉），能撤销。新建要素时有类目、自己没给正文，就照模板写进正文、标题级别照旧（旧版界面的规则）。
     - 存法照旧：这个字段里放旧版编辑器的 JSON，M10 导入的就是这种，读写都认它；旧模板里的引用、列表、代码读成正文段落，换行读成空格。
     - 这个字段是一个整值：两台设备同时改，后写的那份胜出。要能合并，还是等 F1 给模板一种自己的文档（F1 待协调 6）。
     - 故事线的章节模板是同一种值，还没有命令读写，新建章节也还不套用，等 M13 需要时照这个做。
   - **引用查询**：dr-text 这一轮加的 `mention.list` 正好是 M11 要的。`to` 给要素就是「被谁提到」，`from` 给要素就是「它提到了谁」，每条带几段、几处。F3 没有另加命令，补了一个测试：一章提到两次、另一个要素的正文提到一次，`mention.list` 都列对了。
5. **情节规划默认行列的确定 id**：F1 这一轮做，还没进 main。做好以后在 `plot_grid.create` 里换掉现在的随机 id 就行（一行）。

命令和查询从 123 条变成 125 条：90 条命令，35 条查询（新加 `category_template.body`、`category_template.set_body`）。`BookInfo`、`CategoryInfo` 多了字段，能力清单快照已更新。

**性能**：负载在 20 到 200 之间，没跑 `bench workspace --milestone f3-m3`。上面第 3 条的数字是单独粗量的。

### 第五轮：情节规划、补丁、模板，别人写的字自动链人物，按键读取

**一、情节规划、补丁、模板的命令。** 规则照旧版界面（旧版帮手的工具和界面不一样的地方，照「以界面为准」统一）：

- **情节规划**（`plot_grid.get` / `create` / `size` / `line_add` / `line_update` / `line_remove` / `cell` / `clear`）：
  - 每个章节或构想一张表，行 × 列，每格一段纯文字（可以换行）。还没有表时，`plot_grid.get` 给出一张空的 3 × 3（`exists: false`，没有 id）；作者第一次动手前调 `plot_grid.create`，存下三行三列、标签都空、格子 184 × 96（再调一次原样返回）。表不能删，只能清空；彻底删除那个章节或构想时一起删。
  - 行和列按 id 操作：插在最前面或某一行之后；标签照原样存，不修剪（空的显示占位字「行」「列」）；移动到最前面或某一行之后（不能移到自己后面）。
  - 删一行或一列连同它的格子；最后一行、最后一列不能删。撤销把行和它的格子一起放回。
  - 格子照原样存，空字清掉这一格。
  - 「清空」清掉所有标签和格子，行、列和格子大小不动；撤销恢复整张表。
  - 格子大小 120–440 × 56–380，超出就拒绝（F1 的 `PLOT-GRID`；界面先夹到范围里再发）。
  - 旧版帮手是「一张 Markdown 表整张替换」、按标签认行列、修剪格子文字、不能改大小，这些都不搬：帮手和界面一样按 id 操作。
- **补丁**（`patch.list` / `create` / `update` / `move` / `delete` / `check_sources`）：
  - 补丁是作者给要素加的设定（从某一章起生效），有标题（可空）和正文（纯文字），可以是浮动的，也可以取自某个章节或构想的一段（来源、段落、当时的原文、锚点）。段落要有它的章节（`PATCH-BLOCK-NEEDS-NODE`）。旧版帮手只能挂在章节上、不能带段落和锚点；界面可以从章节或构想里的选区建，照界面。
  - 「改章节归属」：换到另一章或者不挂；段落清掉，原文和锚点留着（旧版界面就是这样）。
  - **失效**：来源正文里找不到当时的原文了（空白合并成一个空格再比），就标上失效；原文回来了就去掉。`patch.check_sources { book, node }` 在那篇正文改过以后调，只写有变化的，它跟着正文走，不进撤销日志。旧版是每次存章节后由编辑器调；新版谁调见「待协调」。
  - 删除立刻生效、不拒绝（旧版帮手在补丁上有关系或批注时拒绝，界面直接删）：指向它的关系一起删、它上面的批注变成浮动，和其他「彻底删除」一样；撤销全部放回。失效的补丁照常列出、照常能改（旧版帮手看不到它们）。
  - 顺序：先按来源章节的书序，再按补丁自己的位置；浮动的放最后（旧版界面的顺序）。界面没有手动排序，`patch.move` 是给帮手和以后用的。
- **模板**（`storyline_template.list` / `put` / `remove`，`category_template.list` / `put` / `remove`）：
  - 两种字段模板：全书的「故事线字段模板」（主页上编辑），每个分类的「字段模板」。新建故事线、新建要素（带分类）时**照抄一份**（新 id、顺序不变）；以后改模板不影响已有的，把要素挪进别的分类也不会套用那个分类的模板。
  - 字段的键和值都照原样存、不修剪，键可以重复，只拒绝键和值都空的（旧版保存时丢掉这种）。旧版帮手只能整张替换分类模板、还会修剪键，不搬。
  - 删除字段能撤销，回来的是同一个 id、同一个位置。
  - 顺手补上：`storyline.list` 每条带上字段，`storyline.update` 能加、改、删字段（和 `element.update` 同一套，抽成了公用的 `plan_fields`）。以前故事线的字段没有任何命令能读写，模板照抄进去也看不见。
  - **正文模板**（分类的要素模板、故事线的章节模板）没做：旧版存的是编辑器的 JSON，F1 说要能编辑、能合并得先有一种新的正文文档（`template:<id>`，f1-model-doc.md 待协调 6）。等 F1 定了再做，新建章节、要素也就还不套用它们。

**二、帮手、导入、镜像写进来的字自动链人物**（F4e 提的）。规则和编辑器停手半秒的自动链接是同一套（dr-text 的匹配器）：活着的要素的名字和别名、活着的章节和构想的标题，原样匹配，最长优先、互不重叠，一篇正文不链自己；已经链到目标的不动；名字里面别人的短链接让给长名字；别人的链接伸到名字外面就两边都不动。

- **只链命令自己写进去的那段字里完整出现的名字。** 编辑器链的是作者打字的整段，因为那些字是作者的；帮手、导入写字时，不该替作者去链作者原有的字（F4e 定的「自动链接只链作者打的字」反过来也成立）。这样还有一个好处：链接和字在同一次提交里写，撤销这条命令（反操作删掉这段字，或者 Agent 撤销把这次提交整个退回）链接就跟着字一起没了，作者的字上不会留下半截链接。代价是：一半是原有的字、一半是新写的字的名字不链。
- **谁写的字链：帮手、镜像、导入**（`autolink::links_for`）。作者自己的命令不链：作者的字由编辑器在打字时链，作者用命令写进去的字也是作者的，链不链由作者定；同步来的也不链，对方设备上已经链过了。一开始连作者的 `chapter.create` 带正文也链，结果 dr-editor 的两个测试（用作者身份建章造数据、要求名字先不链）失败了，这才定下这条，正好和「只链别人写的字」一致。
- 现在用上它的命令：`prose.replace`（结果里多了 `linked`，链了几处）、带初始正文的 `chapter.create`（以及同样走 `seed_prose` 的故事线、要素、构想等新建时带的正文）。导入（M10）和镜像（Markdown 双向同步）还没走 F3 的命令，给它们留了公开函数：`dr_workspace::autolink::matcher(书, 文档)` 和 `link_written(事务, 匹配器, 写入的范围)`，在它们自己的写入事务里调就行（见「待协调」）。
- 作者的设置「自动要素链接」（`editor.auto_entity_links`，默认开）也管这里：外壳在设置变了时调 `Workspace::set_auto_links(开关)`。
- 匹配器每条命令现建一次（一本书的名字建一个 Aho–Corasick 自动机），没缓存；书很大时再按书的版本缓存。

**三、换上 F1 的按键读取。** F1 第三轮给的接口都到了：

- 「某个对象还在不在」（`is_live`）改成 `BookView::entity_exists`：查一个键（F1 量的是 1–2 µs）。以前查的是查询缓存里的整个列表，每次写过以后要先把那个集合整个读一遍。关系端点、批注目标、`require_live` 都走它。
- `relation.list` 按端点过滤时：查询缓存里已经有全书的关系就用缓存；没有（刚写过）就用 `relations_of(端点)`，只检查这个端点的关系，不为了一个对象把全书的关系都算一遍、也不填缓存。
- 没换的：彻底删除时要删「存着的全部关系」（包括因为端点在废纸篓里而不显示的），`relations_of` 只给显示的，所以照旧从 `relations_raw` 里挑；按目标找批注照旧只读批注的目标字段；Agent 撤销本来就只按键读被改过的实体，换成 `EntitySnapshot::field` 读出来的值一样，没有收益，不动。

**四、和 F2 对好：彻底删除的书不被同步拉回。** F3 要的接口写成了一份规格（共享笔记 `f3-asks-f2-purged-books.md`，要点抄在「待协调」F2-6）：dr-store 一次事务删掉一本书并留下「已删」记录，之后打开、登记、导入这些文档一律拒绝（新错误 `Purged`），再给同步一份清单。F2 做好以后，F3 的 `purge_book` 改成调它，`import_remote` 把 `Purged` 当成「没有要导入的」。

命令和查询从 100 条变成 120 条：89 条命令，31 条查询（新加情节规划 8 条、补丁 6 条、模板 6 条）；`prose.replace` 的结果多了 `linked`，`storyline.list` 带上字段，`storyline.update` 能改字段，能力清单快照已更新。属性测试加了三种随机操作（给要素建补丁、删补丁、写情节规划的格子并时常删掉第一行），每一步后检查：情节规划至少留一行一列、格子都指向现有的行列；列出的补丁都属于它的要素、来源都存在。

属性测试的第一次 3000 例抓到一个测试自己的毛病：上一步布置的故障注入正好落在新操作里的 `plot_grid.create` 上，而测试用的是遇错就停的读法。改成和其他操作一样容许注入的故障，失败的种子留作回归。

**性能**：这一轮机器的一分钟负载在 14 到 200 多之间（别的会话在编译），比要求的 3 高，没跑 `bench workspace --milestone f3-m3`。

### 第四轮：各模块要的小命令，和 M09 快照历史

监管会话汇总了各模块交回时提的小命令，再加上 M09（快照历史）。都做了：

1. **`chapter.list` 每章带上字数、`created_at`、`updated_at`**（F6 的 M04 做排序菜单和格子里的字数、日期）。
   - 字数是派生索引里这一章正文的字数（dr-index 还没数到的算 0）。
   - `created_at` 是书目里存的建章时间；`updated_at` 是这一章正文最新一次存盘的时间，比建章早就用建章时间。时间都是 Unix 秒，和书目文档一致。
   - 书目文档里不存 `updated_at`（simplifications.md 第一节第 13 条），所以只改标题、梗概或状态不会让它变。旧版的 `node.updated_at` 改字段也会刷新，这一点不一样；要的话以后从书目文档的变更里按实体找最后一次改动。
2. **书架一次读完：`book.shelf { trashed }`**（M01 以前每本书要跑 4 条查询）。每本书给出：
   - 名字、梗概、字数目标；「副标题」项目设定；
   - 活着的章节、故事线、要素各几个；
   - 只算章节的字数（不算构想、要素、笔记，和旧版书架一样）；
   - `created_at`、`updated_at`（这本书任何一篇文档最新一次存盘的时间）、`deleted_at`；
   - 在「最近删除」里的，再给出 `purge_at`（哪天永久删除）和 `days_left`（还剩几天）。
   - 排序：活着的书按最近改动在前；带上 `trashed` 时，最近删除的跟在后面，最近删掉的在前。
   - 旧版书架数故事线、要素时连废纸篓里的也算进去了（它的子查询没过滤），这里只数活着的，和 M01 现在显示的一致。
3. **`book.purge`：从「最近删除」里立即删掉一本。** 保留期照旧版：**30 天**（`BOOK_TRASH_DAYS`）。还剩几天按旧版算：到期时间减现在，除以一天，**向上取整**；到 0 就是「即将永久删除」。
   - 只删已经在「最近删除」里的书；书还开着编辑器时拒绝（等最多 2 秒，读查询手上的引用会放掉）。
   - 删的东西：这本书的每一篇文档（更新、快照、历史点、派生索引，F2 的 `purge_doc`），资源文件，这本书在撤销日志里的记录（已经没法撤了），这本书的「最近打开」。书目文档最后删：中途出错时书还在「最近删除」里，再删一次就能删完。
   - 不能撤销（`irreversible`）。
   - 另加 **`book.purge_expired`**：把到期的书都删掉。旧版是书架打开 2 分钟以后跑一次（让别的设备上的「恢复」先同步过来），M01 照这个时机调用就行。还开着的书留到下次，列在结果的 `waiting` 里。
   - **只删这台设备上的。** 旧版先删 Hosted 上的、确认了再删本地；新版的同步（M36）还没做，见「待协调」M36。
4. **「最近打开」：`recent.touch`、`recent.list`**（M02 的「继续写」）。旧版是 WebView 的 localStorage，只在这台设备上，所以这里也**只在本机、不同步**。
   - 一条记录是作者打开过的一页：章节、构想、要素、故事线、分类、素材，和打开的时间。
   - `recent.touch` 把这一页挪到最前面（不重复），每本书留最近 **10** 条（旧版的默认值）。它不是作者的一步操作：不记日志、没有撤销。
   - `recent.list` 按时间倒序给出一本书的记录，废纸篓里的、已经没了的不给。「继续写」打开哪一页由界面定（旧版：最近的一个章节或构想；没有就用最近改过的章节）。
   - 旧版里调用 `touchEntity` 的地方在改成标签页时删掉了，旧版的清单其实一直是空的，「继续写」一直走的是「最近改过的章节」。新版补上了记录；谁来调 `recent.touch` 见「待协调」F6。
   - 存在 dr-store 的 `library_meta` 表里，键是 `ws.recent`，一个 JSON 值。这是借用：F2 还没有给小块本机状态的表，见「待协调」F2-4。
5. **时间钉：`time_pin.list`、`time_pin.create`、`time_pin.update`、`time_pin.delete`**（第二个里程碑列的缺口）。规则照旧版 `useTimelineMarkers`：
   - 没绑构想的钉要有标签；绑了构想的可以没有（用构想的标题）。
   - 一个构想只绑一个钉，只能绑活着的构想；构想进了废纸篓读成没绑，彻底删除时标题写进钉的标签（第二个里程碑已经做了）。
   - 删除就是删掉（钉没有废纸篓），撤销用同一个 id 建回来。
   - 写作日不用做了：M07 已经加了 `book.word_counts`、`book.writing_days`、`writing_day.record`。
6. **M09 快照历史：`history.points`、`history.preview`、`history.restore_point`**，界面在新 crate `dr-view-history`（见 [modules/m09-history.md](../modules/m09-history.md)）。
   - **历史点就是 F2 的历史标签**，F3 不另存：写作时最多每 15 分钟一个、关闭时一个、帮手每一轮动手前一个、恢复时一个；一小时内全留、一天内每小时留一个、再往前每天一个，30 天以前的删掉。这些 F2 都已经照旧版做好了（旧版的 Rust 移植里「一小时内全留」的修正也在）。
   - `history.points { doc }`：一篇正文的历史点，新的在前；每个点给出时间、为什么打的（`auto` / `close` / `restore` / `agent` / `import`）、当时的字数、当时这一页的标题、当时正文的前 120 个字（空白合成一个空格，和旧版列表一样）。都从 SQLite 另载的副本上读：正文副本按时间倒着逐个检出，书目副本每个不同的版本检出一次；不碰打开着的文档（P0-C：在它上面检出会把历史一直摊开）。
   - `history.preview { doc, point }`：那个点的正文（每段的 H1/H2/H3 级别和文字）、这一页当时的标题和梗概，和它是不是跟现在一样（一样就不用恢复）。
   - `history.restore_point { doc, point }`：**按实体恢复**（simplifications.md 第一节第 4 条）。
     - 先给现在的版本打一个 `restore` 点，所以「恢复前的状态已自动存为新快照」这句旧文案是真的。
     - 正文退回那个点（Loro 的 `revert_to`，是一次新的改动，历史还在）。
     - 这一页自己的字段退回那个点当时书目文档里的值：章节的标题、梗概、状态；要素的名字、别名、梗概、分组、字段；故事线的名字、梗概、字段；分类的名字、模板字段；素材的标题和说明（dr-doc 的 `metadata_fields`，和旧版 `restoreMetadata` 一样）。书的其余部分不动。
     - 照旧版：要素当时的名字或别名现在已经被别的要素占了，就不动名字和别名，其余照常恢复，结果里列在 `skipped`。
     - 章节、构想、故事线、分类当时的标题现在被别的占了，照新版「重名加后缀」的规矩加后缀（和 `history.restore_entities` 同一套），结果里报 `renamed`。
     - 已经一样的字段不写；正文和字段都一样就什么也不改。
     - 作者的命令：正文的提交来源是 `user:command`，编辑器的撤销不会撤到它；对象级撤销一步撤回整个恢复（正文和字段），重做再来一次。反操作是同一条命令，带着恢复前正文和书目的版本。
   - 旧版还有两件这里没做：恢复时清掉这一页「帮手刚改过」的标记（帮手的墨色显现还没做，M27–M34 做的时候接上），和素材笔记的待办核对（M19）。
   - 一个小毛病：新建一章时，存储层给正文打第一个点的那一刻，书目里还没有这一章（写入顺序是先正文后书目），所以这个点没有「当时的标题」。界面上用现在的名字顶上。

命令和查询从 88 条（第三轮的 85 条，加上 M07 的 3 条）变成 100 条：73 条命令，27 条查询。能力清单的快照已更新。属性测试加了两种随机操作（给某章打一个历史点、把某章恢复到它的某个点），单设备和两设备都跑；比较两台设备、比较重开前后时，去掉 `chapter.list` 的 `words` 和 `updated_at`：前者是后台索引慢慢补上的，后者是这台设备存盘的时间，本来就因设备而异。

**性能没重测。** 做完时机器的一分钟负载在 200 以上（别的会话在编译），比要求的 3 高得多，所以没跑 `bench workspace --milestone f3-m3`。新加的查询里，`chapter.list` 和 `book.shelf` 每章多读两行 SQLite（`index_state` 和 `loro_head`，都按主键）；`history.points` 要把正文和书目各载一份副本、逐个检出。等机器空闲时一起量，见「下一个里程碑建议」。

### 第三轮：给编辑器（F4 的 dr-editor）的三样

F4 做好了 `dr-editor`（编辑器经工作区的编辑会话改正文、落盘），提了三样要 F3 补的（f4-editor.md「待协调」第 11 条）。都做了：

1. **`comment.reanchor`：把撤销带回来的批注锚点写回书目。** 作者删掉一段带批注的文字、再在编辑器里撤销，字回来了，但用的是新的操作，书目里存的锚点已经缩成一个点。编辑器的撤销项里带着原来的锚点，经 `ChapterEditorEvent::AnchorsChanged` 交出来，宿主调这条命令写回去。字节和 dr-doc 的编码一模一样（两个 Loro 光标），JSON 里每半用 base64；`null` 表示去掉锚点（批注留在原来的段落或对象上）。写之前会检查：解得开、两个光标都在正文里、指的是这台设备见过的字（别的书、别的设备的光标会被拒）。这是作者的改动，跟着书目同步到别的设备（有测试）。
   - **它不进对象级撤销的日志**（F4 的建议是进日志，这里没照做，理由如下）。它是编辑器撤销的附带结果：如果进了日志，作者在编辑器外面按撤销，第一下撤的是一个看不见的锚点；更糟的是，日志里任何一条新记录都会清空重做栈，作者在编辑器里撤销一下，工作区那边的「重做」就没了。所以这条命令（和下面的 `todo.project`）只写书目、不记日志；结果里照样给出反操作，编辑器重做时再交一次锚点就行。
   - 另加了一条查询 **`comment.anchors { book, target }`**：一个对象正文上所有批注存的锚点（同样是 base64）。编辑器可以改用它，不用再到持有者线程上直接读书目文档（F4 提的可选项）。没有把锚点塞进 `comment.list`：那是帮手也读的清单，一串 base64 对它没用。
2. **`todo.project`：把正文里打的 TODO 标记投成待办。** 编辑器找到段首的 `TODO` / `待办` 标记，变了就把整份清单交过来：`{ doc, markers: [{ block, task }], editing }`。规则照旧版 `useTodoAutoParse`：
   - 新标记 → 建一条待办，id 是 `CommentId::for_projection(Marker, 文档, 块)`，所以两台设备投同一个标记得到的是同一个实体；正文是标记后面的任务，空的用旧版的「（此处待办）」；作者是本人、来源 manual。
   - 作者还在这一段里打字（`editing`）→ 先不建，等作者离开这一段；这一段已有的待办照留。
   - 标记的文字改了 → 不动待办（作者可能在侧栏里改过它）。
   - 标记没了、或者整段删了 → 删掉**未解决的**待办；已解决的冻结，标记没了也留着，标记再出现也不再建。
   - 清单里有、正文里已经没有的段（清单过时了）→ 不建。
   - **一处旧版没有、新版必须补的：别的设备先收到书目、后收到正文。** 同步时书目文档和正文文档是分开到的。A 设备上作者把一段改成 TODO 并投出了待办；B 设备先收到了书目（有这条待办）、正文还是旧的（没有这个标记），B 的编辑器一核对就会把它当成「标记没了」删掉。所以投出待办时把当时正文的版本（每台设备各写到了第几个操作）记在待办的 metadata 里；B 只有在自己的正文也包含这个版本以后才删，之前只把它列进结果的 `waiting`。有测试。
   - **两台设备同时投同一个标记**：实体只有一个，但待办的正文是一段可合并的文字，两边各插了一遍，合起来变成「补一场雨补一场雨」。投出时把种子文字也记进 metadata，同步导入书目以后，正文恰好是种子重复几遍的，就改回种子（来源 `repair`；两台设备算出来的删除相同，两边的修复合得上，有测试）。根本的修法在 F1，见「待协调」F1-1。
   - 它也不进日志（理由同上）：待办跟着正文走，作者撤销编辑器里的那一行字，下一次投影就把待办删了。
3. **作者的命令不再进编辑器的撤销栈。** 编辑器的撤销管理器撤所有来源是 `user` 的提交；作者从命令面板、或者帮手代作者执行，改了正开着的这一章，那次提交以前也是 `user`，编辑器按自己的步数撤销时可能撤到它。现在作者的命令改正文时，提交的 Loro 来源是 **`user:command`**（`dr_workspace::COMMAND_ORIGIN`），会话的撤销管理器额外排除这个前缀：编辑器的撤销只撤编辑器自己的那几步，命令由日志撤（对象级撤销），两边谁先撤都不碰对方。存进 SQLite 的那一行照旧记作 `user`，历史、署名、Agent 撤销都不受影响。编辑器那边按来源 `== "user"` 数自己的撤销项，`user:command` 不算，不用改。有测试，而且确认过拿掉这个改动测试会失败。
   - 做法上有一处要 F2 知道：dr-store 的规矩是「写入任务只改、由持有者提交」，而持有者提交时用的来源只能是它那几种。所以作者命令的写入任务在最后**自己提交一次**（来源 `user:command`），持有者随后的提交是空的，这批操作照常作为一行、以 `user` 存下、落盘以后才发事件；和解析锚点时中途隐式提交是同一种情形，F2 的代码本来就接受。长久的做法见「待协调」F2-3。

命令和查询从 82 条变成 85 条（多了 `comment.reanchor`、`todo.project` 两条命令和 `comment.anchors` 一条查询），能力清单的快照已更新。属性测试加了一种随机操作（对某章随机几段投 TODO），两设备测试从一章共有的章节开始，并检查投出的待办 id 和正文；3000 例单设备、两设备都过。

**这一轮没重测性能。** 跑完测试时机器的一分钟负载在 400 以上（别的会话在编译），量出来的数不可信。写入路径上的变化只有一处：作者命令改正文时多一次空提交（持有者那一下什么也没提交）。`f3-m2-workspace-bench.json` 因此显示为过期，等机器空闲时跑 `cargo run --release -p dr-testkit --bin bench -- workspace --milestone f3-m3`，顺便把 F2 第四轮以后的搜索数字记下来。

### 第二个里程碑

1. **拆掉了「镜像」，每篇打开的文档在内存里只剩一份。** 第一个里程碑时，F1 的类型化读写只能用在它自己那份 Loro 文档上，所以每篇打开的文档要多存一份副本，每次提交还要多导出、导入一次。F1 现在能把读写套在 F2 持有者手里的那份文档上了：命令直接在持有者的写入任务里用 dr-doc 写，读也直接读那一份。同时打开 100 章时，每章占的内存从 0.47 MiB 降到 0.30 MiB，少了三分之一；作者打一个字从 0.094 ms 降到 0.078 ms。「副本落后了、读之前先对齐」这类情况也不会再有。
2. **撤销记录存进了 `library.sqlite`，重启以后照样能撤销、重做。** 用的是 F2 建好的 `ws_journal` 表。每个人（作者、每个 Agent 会话）保留最近 1000 条。
3. **搜索改由 F2 先按书序排好再截断**，工作区不再自己多取一万条再排。现在结果总是准的。当时 F2 的这个函数在大书上慢了十倍左右（见「关键数字」）；F2 第四轮已经改了（它量的工作区搜索：一个字 495 → 0.50 ms，三个字 265 → 5.8 ms），工作区这边没动。
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
| 书 | `book.list`、`book.get`、`book.search`、`book.shelf`（书架一次读完：数目、只算章节的字数、日期、还剩几天） | `book.create`（library）、`book.update`（名字、梗概、全书和每日字数目标）、`book.trash`、`book.restore`、`book.purge`（library，从最近删除里立即删掉）、`book.purge_expired`（library，删掉到期的） |
| 字数与写作日（M07 加的） | `book.word_counts`、`book.writing_days` | `writing_day.record` |
| 最近打开（只在本机） | `recent.list` | `recent.touch` |
| 项目设定 | `fact.list` | `fact.put`（新建或修改，可指定位置）、`fact.remove` |
| Project Memory | `memory.list` | `memory.add`、`memory.update`、`memory.remove`、`memory.restore` |
| 章节 | `chapter.list`（书序、所在的幕、故事线、字数、建章和最近修改时间） | `chapter.create`（可带初始正文，正文里的名字自动链接；给了故事线又没给正文就套它的章节模板；可以同时给叙事位置）、`chapter.update`（标题、梗概、状态、确切的书序、叙事序、故事线和主故事线）、`chapter.move`、`chapter.place`（时间线上放到确切位置，可同时换泳道，一步）、`chapter.spread`（打散，幕的分界跟着走）、`chapter.arrange`（几章和幕的分界一次放到确切位置）、`chapter.trash`、`chapter.restore`、`chapter.purge` |
| 幕 | `act.list`（带各幕的章节） | `act.create`、`act.update`（改名、颜色、分界、绑定构想）、`act.delete` |
| 故事线 | `storyline.list`（带字段、有没有章节模板） | `storyline.create`（照抄故事线字段模板）、`storyline.update`（含字段）、`storyline.move`、`storyline.trash`、`storyline.restore`、`storyline.purge` |
| 要素 | `element.list`（标出合并后重名的；建立和最近修改时间） | `element.create`（照抄分类的字段模板，没给正文就套要素模板；名字补链进已有正文）、`element.update`（名字、梗概、分类、别名、字段、肖像、关系图固定位置；新名字补链）、`element.trash`、`element.restore`、`element.purge` |
| 分类 | `category.list`（带字段模板、有没有要素模板） | `category.create`、`category.update`、`category.trash`、`category.restore`、`category.purge` |
| 关系 | `relation.list`、`relation_type.list` | `relation.create`（对称类型按规范顺序存，已有就返回已有的）、`relation.delete`、`relation_type.create`、`relation_type.update`、`relation_type.delete`（连同用它的关系） |
| 构想 | `idea.list`、`idea_group.list` | `idea.create`、`idea.update`、`idea.trash`、`idea.restore`、`idea.purge`、`idea.to_chapter`（转成章节，一步）、`idea.to_element`（转成要素，一步）、`idea_group.create`、`idea_group.update`、`idea_group.delete` |
| 时间钉 | `time_pin.list` | `time_pin.create`、`time_pin.update`（移动、改标签、绑定或解绑构想）、`time_pin.delete` |
| 情节规划 | `plot_grid.get`（还没存时给空的 3 × 3，行列已有确定的 id） | `plot_grid.create`（任何一次写表也会建）、`plot_grid.size`、`plot_grid.line_add`、`plot_grid.line_update`（改名、移动）、`plot_grid.line_remove`（连同格子，最后一行一列不能删）、`plot_grid.cell`、`plot_grid.clear` |
| 补丁 | `patch.list`（按来源章节的书序，浮动的最后） | `patch.create`、`patch.update`（标题、正文、改章节归属）、`patch.move`、`patch.delete`（不拒绝，关系一起删、批注浮动）、`patch.check_sources`（失效的标上、回来的去掉；不进日志） |
| 模板 | `storyline_template.list`、`category_template.list`、`category_template.body`（要素模板，段落 + H1/H2/H3）、`chapter_template.body`（故事线的章节模板） | `storyline_template.put`、`storyline_template.remove`、`category_template.put`、`category_template.remove`、`category_template.set_body`、`category_template.document`、`chapter_template.set_body`、`chapter_template.document`（后两种 `document` 返回模板文档的 id，给编辑器开） |
| 批注与待办 | `comment.list`（目标不在的标「未定位」）、`comment.anchors`（一个对象正文上的锚点，给编辑器） | `comment.create`（挂在对象、段落、一段文字上，图片或 PDF 素材上的一块矩形（`region`，M19），或浮动）、`comment.update`（正文、解决或重开、优先级、种类、关联的 Agent 对话）、`comment.reanchor`（编辑器撤销带回的锚点）、`comment.delete`、`todo.project`（正文里的 TODO 标记投成待办） |
| 素材 | `material.list`、`material_folder.list` | `material.create`（文本笔记、图片、PDF）、`material.update`、`material.move`、`material.delete`、`material_folder.create`、`material_folder.update`、`material_folder.delete`、`asset.put`（资源元数据，写一次） |
| 正文 | `prose.read`（段落：块 ID、H1/H2/H3 级别、文字、版本）、`prose.shape`、`mention.list`（可带 `limit`） | `prose.replace`（一段里唯一出现的原文 → 新文字，新文字里的名字自动链接）、`prose.restore`（退回某个版本）、`prose.link` / `prose.unlink`（按锚点加上、去掉链接，一次可以多篇；补链的撤销用） |
| 历史 | `history.agent_changes`、`history.points`（一篇正文的历史点）、`history.preview`（某个点的正文和当时的标题梗概） | `history.restore_entities`、`history.undo_agent`、`history.restore_point`（按实体恢复到某个点） |

一共 136 条：100 条命令，36 条查询（含 dr-text 加的 `mention.list`、`prose.shape`、`asset.get`）。`book.create`、`book.purge`、`book.purge_expired` 是 `library`，其余写命令都是 `book`；查询都是 `shared`。`comment.reanchor` 和 `todo.project` 跟着正文走，不进对象级撤销的日志（见第三轮第 1 条）；`recent.touch`、`patch.check_sources` 不是作者的一步，也不记日志；`book.purge`、`book.purge_expired` 不能撤销。


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
- 模板文档（`template:` 开头）的一次提交让它从空的变成有字、或者反过来时，紧跟着这篇正文的事件再发一条 `Book`，点名它的主人（故事线的 `chapter_template`、分类的 `element_template`），因为列表里的 `has_chapter_template` / `has_element_template` 变了（第九轮）。
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
| 编辑器内 | `ProseSession`：dr-doc 的 `ProseUndo` 挂在持有者那份文档上（合并间隔 0，只撤 `user`），每一步是持有者的一个写入任务。Agent 和同步的改动是别的来源的提交，管理器把它们当成远端改动折进去，从不撤它们；作者的命令提交时来源是 `user:command`，会话的管理器也排除它，由日志撤 | `the_editor_layer_undoes_only_the_authors_typing`、`the_editors_undo_leaves_the_authors_commands_to_the_journal` |
| 对象级 | 每条命令声明自己的反操作（新建 → 进废纸篓；改 → 改回旧值；移动 → 移回原坐标或原位置键；进废纸篓 ↔ 恢复；彻底删除 → `history.restore_entities` 从删除前的版本恢复）。日志在 `library.sqlite`，各人一个栈，新命令清空重做栈，重启后还在。跟着正文走的两条（`comment.reanchor`、`todo.project`）和 `recent.touch` 不记日志；快照恢复（`history.restore_point`）一步撤回正文和字段；整本书彻底删除不能撤 | `undo_and_redo_walk_the_journal`、`a_new_command_clears_redo_and_actors_have_their_own_stacks`、`the_journal_survives_a_restart`、`an_actor_keeps_its_newest_rows`、`restore_entities_is_its_own_inverse`、`points_preview_and_restore_a_chapter` 和各命令的测试 |
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
| `tests/commands.rs`（32 项） | 每条命令和查询至少调一次，包括报错的情形；叙事时上建章一步（撤销、重做、非数字被拒）；构想转章节：成了最后一章、草稿、挂上故事线、正文不变、离开构想列表，时间钉和幕解开（没标签的钉留下标题），一步撤销回到原来的构想、分组和绑定，转过的不能再转；时间线上放一章：换到别的泳道（主线换掉、副线留着）、一步撤销和重做、同样的位置不写不留一步、拖到「未归属」、叙事时只动叙事位置、已删的故事线被拒、`chapter.update` 的确切书序；打散：书序上等距、幕的分界落在两章正中、开头那一幕不动、再打散什么也不写、一步撤销（章节和幕都回去）、叙事时只排放了位置的章、同位置按 id；`chapter.arrange` 设确切位置并能撤销、叙事时带幕被拒；`mention.list` 同数的按来源排、`limit` 取前几条；`null` 清空字段、撤销把空字段变回空；搜索按书序、废纸篓里的不占名额；有一项检查登记表里的每条都在这个文件或 `editor.rs`、`shelf.rs`、`points.rs`、`autolink.rs`、`workshop.rs` 里被调用过 | 全过 |
| `tests/shelf.rs`（9 项） | 彻底删除的书在另一台设备的更新到来时不回来、解除记录后才回来；`chapter.list` 的字数和日期（废纸篓里的也有）；书架一次读完：只算章节的字数、副标题、数目、日期、还剩几天，废纸篓里的在后面；还剩几天向上取整、到 0 为止；彻底删除只删最近删除里的，文档、日志、最近打开都删掉，别的书不动，再删一次找不到；没到期的书 `book.purge_expired` 不删；最近打开每本书留 10 条、挪到最前不重复、不记日志、废纸篓里的不给、重启后还在；时间钉的标签规则、一个构想一个钉、移动和改名能撤销、构想进废纸篓读成没绑、删除能撤销（同一个 id、绑定还在） | 全过 |
| `tests/points.rs`（5 项） | 历史点新的在前，带当时的标题、字数、前 120 个字；预览给出 H1 级别、当时的标题和梗概；恢复退回正文和标题梗概，恢复前的版本成了一个 `restore` 点，预览显示「和现在一样」；对象级撤销一步撤回、重做再来；恢复现在这个版本什么也不改；要素旧名字被占了就不动名字和别名；章节旧标题被占了就加后缀；书目文档、不存在的点、没给点都被拒 | 全过 |
| `tests/autolink.rs`（16 项） | 构想转要素：名字、梗概、分类字段、正文抄过去，构想进废纸篓，还没链的名字链上新要素、已经链到构想的不动，一步撤销（要素走、构想回来、新链接去掉），重名被拒；书的匹配器：两次取到同一份、不链这篇自己、改名和新章节标题以后换新的； 规划：恰好盖住名字的别人的链接、伸出名字的别人的链接都不动，里面更短的让出去，链了一半的补全，范围外的不算；补链：新要素链上已有正文，开着的编辑器撤销只撤自己打的字、链接还在，对象级撤销去掉、重做再来；更长的新名字接过短链接，撤销还给短的；加别名、改名、新章节标题都补；名字被别人拿走后原文的链接不让；素材笔记、废纸篓、关掉设置都不补；`prose.link` / `prose.unlink` 按锚点找位置（前面打了字也对）、能撤销、别的文档的锚点被拒，一次多篇时有一条不对就整条拒绝、什么也不写；作者自己的命令不链；帮手建的素材笔记、故事线带的正文也链；帮手替换进来的字里的名字链上、作者原有的字不动、Agent 撤销连链接一起撤；帮手那一步的对象级撤销连链接一起撤；章节标题也链、一篇正文不链自己、最长优先不重叠；一半旧字一半新字的名字不链；作者关掉设置就不链；废纸篓里的要素不链 | 全过 |
| `tests/workshop.rs`（14 项） | 模板文档：在编辑器里写的模板（标题、加粗、人物链接）整篇抄进新要素、块 ID 是新的；`set_body` 开头没变的段落留着原来的块 ID 和加粗，和现在一样就不写，撤销退回；前后加段、中间换段、末尾删段、两头是空标题段，写回再读都一样；改模板不影响已建的；故事线的章节模板套进新章节（标题级别照旧），自带正文的、没给故事线的不套；只有旧 JSON 字段时照它读和套用，`document` 把它写进文档且不进日志，之后以文档为准（清空了就没有）；两台设备改同一个模板的不同地方合并。情节规划：没存时就有确定的行列 id、两台设备一样，写一格就存下，两台设备合并后仍是 3 × 3，没存过的表清空不写。要素的更新时间：改名、改字段都盖时间戳，列表取它和正文存盘时间里晚的。要素模板：整份读写、新建要素按模板写正文（标题级别照旧）、自带正文优先、空的去掉并能撤回、坏的标题级别被拒；旧版 JSON（标题、换行、引用、分隔线、空段）读成段落、写回再读一样；书带创建时间；`mention.list` 列出要素被谁提到（一章两处、一个要素一处）和它提到了谁。情节规划：空表 3 × 3、建表、格子照原样存和清掉、标签不修剪、插在最前面和某行之后、移动和撤销、不能移到自己后面、删行连同格子并能撤回、最后一列不能删；构想也有表、格子大小超出被拒、清空只清文字并能撤回、彻底删除构想连表一起删。补丁：浮动的空补丁、取自两章的补丁按书序排、段落没有章节被拒、改章节归属清掉段落并能撤回、失效和恢复只写变化且不进日志、带关系和批注也照删并能全部撤回、移动。模板：不修剪、键可重复、键值都空被拒、照抄成新 id、改模板不影响已有的、删字段撤回同一个 id、分类模板照抄进新要素、挪进分类不套用 | 全过 |
| `tests/editor.rs`（8 项） | 给编辑器的：撤销以后写回锚点、去掉锚点、同一个锚点不写、反操作放回原来的、不进日志；坏字节、浮动批注、别的设备的光标被拒；锚点同步到另一台设备。TODO 标记按旧版规则建、留、删，正在打字的段先不建，已解决的冻结，过时的清单不建，书和素材的正文被拒；投影不进日志、不吃掉重做；两台设备投出同一个待办（一次交换后只一条、正文不重复）；一台已解决并改了正文、另一台晚投，合并后仍是已解决；先收到书目、后收到正文的设备先留着待办 | 全过 |
| `tests/registry.rs`（4 项） | 能力清单的两份快照（先排好键再比）；每条说明是一句话；读的都是 `shared`，写的都不是；输入都是带字段名的对象；清单里不出现 H1–H3 的禁用叫法、退役产品的名字和构想的旧叫法 | 全过 |
| `tests/events.rs`（5 项） | 书目事件点名实体；正文事件只点名被改的那一段；Agent 写入带结算事件；缓存跟着事件走；模板文档从空到有、从有到空各发一条点名主人的书目事件，接着打字不发 | 全过 |
| `tests/shell.rs`（4 项） | 目录按名字、按 id 找，组和组分开，重名（两台设备合并出来的）都返回，废纸篓里的找不到，改名立刻生效；进废纸篓、彻底删除、Agent 删除、删素材、删整本书都发 `Removed`，恢复不发；另一台设备同步过来的删除也发，没读过的被删节点两种都报；`before_quit` 补齐索引、关掉没人占着的文档，之后还能照常用 | 全过 |
| `tests/write_order.rs`（7 项） | 上面「写入顺序与补偿」表里的四种失败，加上重开后正文还在、不冲刷也全落盘；关不掉时交还工作区 | 全过 |
| `tests/undo.rs`（10 项） | 三层撤销；作者的命令不进编辑器的撤销栈（两种先后顺序）；日志重启后还在；每人只留最近的记录 | 全过 |
| `tests/invariants.rs` 单设备属性测试（另有两条从失败例子固定下来的回归测试） | 每例最多 35 步随机命令（45 种，包括撤销、重做、Agent 改名和撤销、TODO 标记投影、打历史点和恢复到历史点、建删补丁、写情节规划和删行、时间线上放一章和打散（第八轮加的）、构想转章节或要素（第十轮加的）、故障注入、从磁盘重开），每一步后检查：章节和构想标题、故事线名、分类名、要素名和别名都不重复；每个实体的正文文档都在；显示的关系两端都活着；批注目标要么显示、要么标「未定位」；章节都有书序；构想分组不超过两层；投出的待办 id 由文档和块算出、正文就是种子一遍；情节规划至少一行一列、格子都指向现有的行列；补丁属于它的要素、来源存在；重开前后读出来一样 | 3000 例全过（release） |
| `tests/invariants.rs` 两设备属性测试 | 同一本书（带一章共有的章节）的两份副本各自跑随机命令，再互相交换全部文档；两边读出来逐项相同；合并后可能出现的重名由读取标出，只有一个保留名字；两边对同一段投出的待办合并后正文不重复（第七轮起靠 dr-doc 的种子变更，导入后的修复已删） | 3000 例全过 |
| `concurrent_creates_of_one_name_are_flagged_not_lost` | 两台设备同时建同名要素、同名章节：都保留，要素标出冲突，章节标题允许重复，下一次改名加后缀 | 过 |
| `tests/footprint.rs`（2 项，默认忽略） | 上面那组内存和单次提交的测量 | 手动跑 |
| 各模块单测（6 项，含一个性质测试） | 只读改动附近算出的受影响段落和读整篇算出的一样（随机正文、随机改动范围）；来源字符串一致、名字后缀、位置键、版本编码、事件里的段落换算 | 全过 |

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
| 3.1 | `comment.reanchor`：编辑器撤销带回的锚点写回书目（base64，作者的改动，同步出去）；加 `comment.anchors` 查询 | 完成；不进日志，理由见第三轮第 1 条 |
| 3.2 | `todo.project`：按旧版 `useTodoAutoParse` 的规则建、留、删，id 用 `CommentId::for_projection`，两台设备是同一个实体 | 完成；另补了「先收到书目」的等待；「两边同时投」第七轮起靠 F1 的种子变更 |
| 3.3 | 作者命令改正开着的正文时不进编辑器的撤销栈 | 完成（`user:command`）；长久做法见 F2-3、F1-2 |
| 4.1 | `chapter.list` 带字数、建章和最近修改时间 | 完成；改标题不算「修改」，见第四轮第 1 条 |
| 4.2 | 书架一次读完（`book.shelf`） | 完成 |
| 4.3 | `book.purge`、`book.purge_expired`，书架能算还剩几天（30 天，向上取整） | 完成；只删本机，Hosted 那边等 M36 |
| 4.4 | 「最近打开」（只在本机） | 完成；暂借 `library_meta`，见 F2-4；谁来记见 F6 |
| 4.5 | 时间钉的命令 | 完成 |
| 4.6 | M09 快照历史：列点、预览、按实体恢复；界面 `dr-view-history`，外壳 ⋯ 菜单一个入口 | 完成；见 [m09-history.md](../modules/m09-history.md) |
| 4.7 | `bench workspace --milestone f3-m3` | 没跑：机器负载 200 以上 |
| 5.1 | 情节规划、补丁、模板的命令（照界面） | 完成；正文模板等 F1 的新文档种类 |
| 5.2 | 帮手、导入、镜像写进来的字自动链人物 | F3 的命令完成；导入、镜像用公开函数（M10、镜像接） |
| 5.3 | 换上 F1 的按键读取 | 完成：`is_live`、`relation.list`；其余说明了为什么不换 |
| 5.4 | 和 F2 对好删书后防拉回的接口 | 规格写好（F2-6），等 F2 实现 |
| 5.5 | `bench workspace --milestone f3-m3` | 没跑：负载 14 左右 |
| 6.1 | 换上 `Origin::Command`，按作者认的地方改用 `is_author()` | 完成（F3 自己、M07 的 `writes_here`） |
| 6.2 | 删书防拉回：对照 F2 的 `purged_doc`，收掉规格 | 完成；`import_remote` 遇到已删的返回 false |
| 6.3 | 提交事件从改动直接算受影响的段落 | 完成；20250 字一章改一字 462 µs → 10 µs（参考） |
| 6.4 | M11：`BookInfo.created_at`、类目的要素模板和字段模板、引用查询 | 完成；引用用 `mention.list` |
| 6.5 | 情节规划默认行列换上 F1 的确定 id | 第七轮完成 |
| 7.1 | 投待办用 `project_todo`、建表用 `create_plot_grid`，删掉事后修复 | 完成 |
| 7.2 | 正文模板换成模板文档 + `insert_copy`；故事线的章节模板命令，新建章节按主故事线套用；旧字段只读 | 完成 |
| 7.3 | F4：让位规则、只算不写的规划函数、补链挪进建改要素（还有章节、构想的标题） | 完成；编辑器的后台补链可以删 |
| 7.4 | F6：`try_shutdown` 关不掉时交还工作区 | 完成 |
| 7.5 | `mention.list` 提速，加 `limit` | 完成；heavy 上按类型调用 37 → 28 ms（参考） |
| 7.6 | 要素带 `updated_at` | 完成；字段暂由 F3 自己写，见 F1-5 |
| 7.7 | `bench workspace --milestone f3-m3` | 没跑：负载 13–140 |
| 8.1 | M14：`chapter.place` 换线和挪位一步；`chapter.update` 加 `book_order` | 完成 |
| 8.2 | 打散一步（`chapter.spread`，幕的分界跟着走）；`chapter.arrange` | 完成 |
| 8.3 | 补链在 heavy 种子上量、提速；匹配器按书缓存 | 完成；新建常见名字的要素 13–18 s → 1.8 s（参考） |
| 8.4 | `bench workspace --milestone f3-m3` | 没跑：负载 47–176 |
| 9.1 | 模板文档空、有翻转时发点名主人的书目事件，外壳快照跟着变 | 完成；外壳不用改 |
| 9.2 | `bench workspace --milestone f3-m3`，补链进证据 | 没跑：负载 18 以上；补链的 case 要 F8 加（见待协调 F8） |
| 10.1 | M14：`chapter.create` 带叙事位置，一步 | 完成 |
| 10.2 | M16：构想转章节、转要素（`idea.to_chapter`、`idea.to_element`）；绑幕、绑钉用现有命令 | 完成 |
| 10.3 | bench | 没跑：负载 19–101；补链那一项还等 F8 加进套件 |

## 待协调

按负责的 crate 分。第一个里程碑提的 F1-1 到 F1-6、F2-1 到 F2-5 都由对方做了，这个里程碑也都用上了，下面只列新的。

### F1（dr-model、dr-doc），第三轮、第五轮提的

1. **投出的待办，正文应该写成一份确定的改动**（像文档的创世那样）。`BookTxn::projected_todo` 给了确定的 id，但正文是可合并的文字，两台设备同时投同一个标记，合起来正文读两遍。工作区现在在导入书目以后把「恰好是种子重复几遍」的正文改回种子（`repair_projections`，种子记在 metadata 里），两边种子不一样（比如两边的任务文字刚好不同）就修不了。建议 dr-doc 用固定的对等方 ID 写种子（同样的标记、同样的操作），或者把种子放进修复计划。 **F1 第五轮已做**（2026-11-08）：`BookTxn::project_todo(种类, 文档, 块, 任务文字)` 把投出的内容写成种子变更，任务文字是一个值 `projection_text`，正文没人改过就读它；两边文字不一样也只留一个，晚到的投影也不会重新打开已解决的。换法（见 [f1-model-doc.md 的待协调](f1-model-doc.md#待协调) 第 2 条）。**F3 第七轮已换上**，事后修复删了。
2. **`UNDO_EXCLUDED_ORIGIN_PREFIXES` 可以加上 `user:command`**，这样任何 `ProseUndo` 都自动排除作者的命令，工作区就不用在会话上另外加前缀（现在用的是 `ProseUndo::hooks()`）。不急。 **F1 第五轮已做**：任何 `ProseUndo` 都自动排除 `user:command`。会话上另加的那个前缀留着，没坏处。
3. **正文模板**（第五轮提的，第六轮部分做了）：要素模板现在按旧版的 JSON 读写、新建要素时套用（见第六轮第 4 条），但它是一个整值，两台设备同时改后写的胜出；章节模板还没有命令。要能合并，还是要 F1 待协调 6 说的新正文文档（`template:<id>`）。 **F1 第五轮已做**：文档种类 `template:category:<id>` / `template:storyline:<id>`（`TemplateOwner::doc_id`），套用用 `ProseTxn::insert_copy`；用法见 [f1-model-doc.md 的待协调](f1-model-doc.md#待协调) 第 2 条。**F3 第七轮已换上**（第七轮第 2 条）。
4. **情节规划默认行列的确定 id**（第五轮提的）：两台设备同时第一次建同一张表会合并出六行六列。F1 给出确定的默认行列 id 后，F3 在 `plot_grid.create` 里换上。 **F1 第五轮已做**：`BookTxn::create_plot_grid`（`PlotRowId::default_for` / `PlotColId::default_for`）。**F3 第七轮已换上**。
5. **要素的 `updated_at`**（第七轮提的）：M11 要显示要素什么时候改过。dr-model 的 `Element` 没有这个字段（`Node` 是有意不要的，因为每次打字都会变；要素的字段只在命令里改，不会每次打字都写）。F3 现在在 `element.update` 的书目提交里自己写这个键（要素的映射里 `updated_at`，`I64` 秒，和批注的、dr-doc 的时间编码一样），读的时候也自己读（`cx.rs` 的 `ELEMENT_UPDATED_AT`）。建议 F1 给 `Element` 加 `updated_at: Option<Timestamp>`、`ElementWriter` 加 `updated_at` 的写入器，用同一个键，F3 换过去，已经存的照样读。要不要在 loro-schema.md 里记一笔，由 F1 定。
6. **`insert_copy` 不抄表格格子里的标记**（F1 自己记着的）：模板里的表格抄进新页面时格子里的加粗等会丢。模板很少带表格，不急。

### F2（dr-store）

第二个里程碑提的 1、2 两条，F2 第四轮都做了（main 07964df6）：按书序搜索在 Rust 里排序截断，后台重建不再拿已打开文档的句柄。工作区关库时的重试留着，只当保险。原文留在下面备查。

1. ~~**按书序搜索慢**~~（已做）：`search_in_order` 的耗时是「命中条数 × 书序长度」（数字见「关键数字」）。建议在 Rust 里排序：先只选所有命中的 `(id, doc_id, ord)`，用一张 `HashMap<doc_id, 名次>` 排好、截出前 `limit` 条，再按 id 取这些行的文字和片段。这样整体接近普通搜索的耗时。另外，SQL 文本会随书序长度变，`prepare_cached` 的缓存会被不断换掉。
2. ~~**关库和后台索引重建**~~（已做）：打开库时起的重建线程会对已经打开的文档调 `reindex_doc`，临时拿一个 `DocHandle`。`try_close` 在停掉后台工作之前就先数打开的文档，所以碰巧会被拒。工作区现在靠重试绕过去（`Workspace::shutdown`）。建议 `try_close` 先停后台重建、等它退出，再数文档；或者重建线程不去拿已经打开的文档的句柄，交给持有者自己的空闲维护。

3. ~~**作者命令的提交来源**~~（F2 第五轮做了 `Origin::Command`，F3 第六轮换上，见第六轮第 1 条）。
4. ~~**小块本机状态要一张表**~~（F2 第五轮做了 `local_state`，整合时「最近打开」已搬过去：scope `ws`、key `recent`，旧值由迁移 0004 搬）。
5. **按书批量读字数和最近存盘时间**（第四轮提的，不急）：`chapter.list` 和 `book.shelf` 每章调一次 `doc_stats` 和 `head`（各一行、按主键）。几百章没问题；如果量出来慢，给一个按书一次读完的接口（`index_state` 和 `loro_head` 按 `book_id` 联表）。
6. ~~**彻底删除一本书后防同步拉回**~~（F2 第五轮做了 `purged_doc`，F3 第六轮核对并补上 `import_remote` 的跳过，见第六轮第 2 条；共享笔记已删）。
7. **补链的两样（第八轮提的，不急）**：作者给一个常见的名字建要素时，补链要把几百篇长章节从 SQLite 读进来，heavy 种子上这是剩下的大头（见第八轮第 3 条）。两个做法，哪个都行：
   - 一个不起持有者、往没打开的文档追加一次改动的写法（比如 `Library::append_closed(doc, origin, |doc| …)`：读进副本、改、导出这一次的增量、按持有者同样的规矩追加），省掉每篇起线程、关时打标签；
   - 或者让索引能回答「这些段落的原文」（`search` 的结果带整段文字，或者给一个按 `doc_id` 只返回命中段落文字的查询），F3 好在打开文档之前先在原文上算一遍，链不上的就不开。

### F6（dr-shell）

- **第九轮：模板文档和书目快照**：不用改。模板文档从空变成有字、或者反过来时，F3 会多发一条这本书的 `WsEvent::Book`（点名故事线或分类，字段 `chapter_template` / `element_template`），`on_library_events` 照旧整份重读，快照里的 `has_chapter_template` / `has_element_template` 就是新的。以后要是改成按 `changes` 只重读一部分，记得这两个字段属于故事线、分类的列表。
- **第七轮：换库失败退回旧库**：`swap` 里把 `old.shutdown()` 换成 `old.try_shutdown()`。被拒时 `refused.workspace` 是还开着的旧工作区（`Some`），直接 `Swapped::Old(ws, 原因)` 交回去，不用再从磁盘重开；只有它是 `None`（库关不掉、又连撤销日志都读不出）时才是 `Swapped::Lost`。
- **第四轮在 `dr-shell` 里改了这几处**（M09 的入口，越少越好）：
  1. `Cargo.toml`：加 `dr-view-history` 依赖一行；
  2. `src/workspace/mod.rs`：`Workspace` 加一个字段 `history: Option<Entity<dr_view_history::HistoryDialog>>`，初始化 `history: None`，渲染时 `.when_some(self.history.clone(), …)` 挂上对话框，共三处各一两行；
  3. `src/workspace/corner.rs`：章节的 ⋯ 菜单在写作状态和「删除节点」之间加一项「历史快照…」（图标 `rotate`，文案 `rightSidebar.stats.snapshotButton`，旧版的入口就叫这个）；同一个文件里加 `Workspace::open_history(doc, name, window, cx)`，开对话框、收到 `Close` 时收起；模块注释跟着改了一句。
  - 另在 `dr-i18n/keys.txt` 加了旧版历史对话框用到的键（`snapshotHistory` 下的 8 个和 `kind.*`，`rightSidebar.stats.snapshotButton`、`common.wordsCount`），跑了 `sync-locales.py`。
- **补丁失效的核对**（第五轮）：旧版每次存章节以后核对一次「补丁的原文还在不在」。新版由编辑器（或外壳）在一篇正文停手以后调 `patch.check_sources { book, node }`（和 `todo.project` 同一个时机就行），它只写有变化的、不进撤销日志。没有补丁取自这一篇时它什么也不读。
- **自动链人物的开关**（第五轮）：设置「自动要素链接」（`editor.auto_entity_links`）变了时，除了交给编辑器，也调一次 `Workspace::set_auto_links(开关)`；打开库时按当前设置调一次。不调就是默认开。
- **「最近打开」要外壳来记**：作者打开或切到一页（章节、构想、要素、故事线、分类、素材）时调 `recent.touch { book, target: { kind, id } }`。F3 不知道哪一页在前面，旧版也是界面记的。建议在导航模型换活动标签的那一处调一次（后台线程，失败只记日志）；M02 的「继续写」读 `recent.list`。
- 别的页面（要素、故事线、分类、素材）的 ⋯ 菜单还没有，各模块做菜单时照章节的加一项「历史快照…」，调 `open_history("element:<id>", 名字, …)` 就行，对话框不分种类。

- 照「给外壳（F6）的接口」那一节接：`Catalog` 套在 `BookCatalog` 上；订阅 `WsEvent::Removed`，转到主线程以后调 `Navigator::forget`；`quit::before_quit` 里调 `ws.before_quit()`。接好以后 `stand_in.rs` 可以删掉。
- 事件在持有者线程上到达，回调里不要等文档持有者，也不要直接碰 GPUI 的状态。
- `before_quit` 会等每个持有者收尾（写关闭标签、按需压缩）。测试里的小书只要几毫秒；大书压缩可能要几十毫秒，结果里的 `ms` 可以记下来看看。

### F4（编辑器）

- **第八轮：匹配器不用自己建了**：`Workspace::link_matcher(&doc) -> Result<Option<Arc<LinkMatcher<LinkTarget>>>>` 给出这篇正文要用的匹配器（书里所有名字，去掉它自己），按书缓存，有名字变了才重建；heavy 种子上自己建一次是 40–50 ms（大头是读名字）。`entity_links.rs` 里调 `dr_workspace::autolink::matcher(&view, &id)` 的地方、`decor/mod.rs` 里自己调 `book_link_names` 的地方可以换成它（装饰要的是不去掉自己的全表时，告诉我，加一个）。
- **第八轮：补链的撤销改成一条**：`prose.unlink` / `prose.link` 的输入是 `{ links: [{ doc, target, anchors }] }`。编辑器不调它们，只是知会。
- **第七轮：自动链人物（`f4e-editor.md` 第四批待协调）**
  - 规则一处写明：`dr_workspace::autolink::plan(段落文字, 链接, 匹配器, 范围)` → `Vec<LinkEdit>`。`LinkRun { range, target }` 和编辑器的 `LinkRun` 一样（段内字符位置，目标 id），`LinkEdit::Unlink` 带的是目标 id（编辑器自己换成 `entity_key`）。范围给 `0..段长` 就是整段。`keep_added(文字, 规划, 新名字集合)` 和编辑器的 `only_added` 一样。编辑器的 `autolink()` 可以换成它，规则就只有一份（包括这一轮补的「恰好盖住名字的别人的链接不让」）。
  - 补链由命令做了：`element.create`、`element.update`（改名、加别名）、`chapter.create` / `chapter.update`、`idea.create` / `idea.update`（标题）在命令里把新名字链进已有的正文，来源是命令自己的（作者是 `user:command`），编辑器的撤销栈里没有它，开着的文档也照写（编辑器会像收到别人的改动一样看到）。对象级撤销用 `prose.unlink` / `prose.link` 按锚点撤。所以 `entity_links.rs` 的 `backfill_closed`、`claim_backfill` 和开着的文档的补链都可以删；作者打字时的自动链接（只链作者打的段）照旧。
  - 匹配范围和旧版一样：章节、构想、要素正文、故事线和分类的说明，不含素材笔记。
- **第三轮的三样怎么接：**
  - `AnchorsChanged` 的每一项调 `comment.reanchor { book, id, anchor }`。`anchor` 用 `dr_workspace::dto::AnchorBytes::from(&encoded)`（dr-doc 的 `EncodedAnchor`）。同一个锚点再写一次什么也不做，可以放心多发。它不进日志，编辑器重做时如果锚点又变了，再发一次。
  - 加载锚点可以改用 `comment.anchors { book, target }`（走缓存），不用在持有者线程上直接读书目文档。
  - `TodoMarkers` 变了就调 `todo.project { doc, markers, editing }`。`editing` 填光标所在段的块 ID，失焦时不填（旧版「离开该段 / 失焦」才算写完）。清单要给全，不能只给变了的：没在清单里的未解决待办会被删掉。结果里的 `waiting` 只是告知，不用处理。
  - 作者命令的来源是 `dr_workspace::COMMAND_ORIGIN`（`user:command`）。`SessionSource` 按 `== "user"` 数撤销项，所以不用改；如果以后按前缀判断「是不是作者」，要把它排除掉。
- 先用 `ProseSession`（`edit` / `undo` / `redo` / `reader`）。撤销管理器挂在持有者那份文档上，Agent 的写入不会进作者的撤销栈（有测试）。
- `reader()` 和持有者共享同一份文档。读当前状态随便读；但**解析锚点**（`ProseView::resolve`，它要查历史，会在中途隐式提交）只能放在持有者线程上做（`DocHandle::read`），否则会把别人正在进行的写入拆成两次提交。
- 写入请走工作区（会话或命令），不要直接用 dr-store 的持有者写。

### F8（dr-testkit）

- **第九轮：补链的测量进 `bench workspace`**（第八轮的数字现在只有临时探针量过）。建议在 heavy 种子上加一个 case：`element.create` 一个出现在几百篇里的名字（种子里「灯塔」在 555 篇），再 `ws.undo`；同样做一次「河」（236 篇里都在更长的名字里，一处也链不上）和标题「灯塔」的 `chapter.create`。要先 `reindex_doc` 全书（补链靠段落索引找候选，和现有的 `search` case 一样）。记下耗时和效果条数（556）。我不改 dr-testkit，F8 加了以后我在空闲时跑 `--milestone f3-m3`。
- `bench workspace` 的输入包含 `crates/dr-workspace`，所以 `f8-m2-workspace-bench.json` 现在显示为过期，这个里程碑的结果在 `f3-m2-workspace-bench.json`。旧的要不要删，由 F8 定。
- 套件里没有内存这一项。要的话可以把 `tests/footprint.rs` 的做法（分两个进程、`ps` 读常驻内存）搬进 `bench`。
- `bench.rs` 的注释里还写着「moved from F3's `tests/measure.rs`」，那个文件已经删了。

### dr-index

- `library_options` 现在调 `dr_index::attach`，工作区打开的每个库都用 `TextDeriver`。dr-index 以后改派生器的行为，工作区不用跟着改。

### M29（帮手工具）/ M32（MCP）

- 按名字调 `Workspace::call(actor, name, json)`；输入输出的 Schema 从 `registry().manifest()` 取；错误按 `code()` 分。
- 按名称找对象可以直接用 `ws.catalog(book)`，和外壳解析位置链接是同一套规则。

### M01（书架）/ M02（主页）/ M04（章节面板）

- M01 可以把每本书的四条查询换成一条 `book.shelf { trashed: true }`；「还剩几天」直接读 `days_left`（0 显示「即将永久删除」）；「立即删除」调 `book.purge`；书架打开 2 分钟后调一次 `book.purge_expired`。
- M02 的「继续写」读 `recent.list { book }`，取第一个 `node`；没有就退回「最近改过的章节」（`chapter.list` 的 `updated_at` 最大的）。
- M04 的排序和格子用 `chapter.list` 的 `words`、`created_at`、`updated_at`（秒）。
- M01（第八轮发现的）：`dr-view-shelf-art` 的测试 `a_cover_is_read_from_the_book` 要 dr-ui 的字体（`next/.cache/fonts`，或 `DRIFTING_FONTS_DIR`）。没有字体时「chars」画风什么也不画，测试就失败；新开的 worktree 里就是这样。建议没有字体时这一项跳过（像 dr-ui 自己的字体测试那样），或者在说明里写明先生成字体。

### M16（构想面板，M10 这一路）

- **第十轮**：
  - 转成章节：`idea.to_chapter { book, id, storyline? }`，返回 `{ id, title, book_order }`（同一个 id，页面不用换，标签从构想变成章节）。
  - 转成要素：`idea.to_element { book, id, category?, name? }`，返回新要素的 `{ id, name }`；名字被占时错误码是 `name_taken`（错误里点名占着它的要素），可以让作者改名后带 `name` 再调。转完构想在废纸篓，界面打开新要素（旧版是 `navigateToElement`）。
  - 绑到幕：`act.update { book, id: 幕, drift: 构想 }`；解开给 `null`。
  - 绑到时间钉：新钉 `time_pin.create { book, narrative_order, idea }`（可以没标签）；已有的钉 `time_pin.update { book, id, idea }`，解开给 `null`。
  - 都是一步撤销。旧版的确认对话框文案（「状态会重置为草稿」「原构想会被删除，内容迁移到新建要素中」）里的「删除」现在是进废纸篓。

### M14（底部时间线）/ M21（故事图谱）

- **一次拖放一步**（第八轮）：`move_chapter` 里的 `chapter.update` + `chapter.move` 换成一条 `chapter.place { book, id, axis, order, storyline }`。`storyline` 照 `model::membership` 的三种落点给：拖到书的泳道（没有故事线时那条合成的）不传；拖到「未归属」给 `null`；拖到某条故事线给它的 id，F3 按旧版规则算出换哪些线。叙事时也一样，`axis: "narrative"`。
- **双击空白新建**（`create_at`，第十轮）：叙事时里给 `chapter.create` 带上 `narrative_order: Some(order)`，后面那条 `chapter.update` 删掉，就是一步；`place` 照旧给 `Last`（或书序的位置）。我只给 `dr-view-timeline` 补了 `narrative_order: None` 让它编译，行为留给你改。
- **打散**：按钮调 `chapter.spread { book, axis }`，一步撤销，幕的分界在书序轴上跟着走。旧版不到两章时按钮不可点（`bottomTimeline.spread.needTwo`）；不到两章时命令什么也不写。
- **一次放几章**：`chapter.arrange { book, axis, chapters: [{id, order}], acts: [{id, start_order}] }`，比如以后框选几章一起拖。

### M11（要素页、补丁）/ M13（故事线页）/ M15（情节规划）

- M13（第九轮）：故事线页「章节模板」一节有没有模板，直接读外壳快照里的 `has_chapter_template`，不用再单独问 F3：模板文档空、有翻转时 F3 会发 `Book` 事件，外壳跟着重读。模板正文的变化订这篇文档的 `Prose` 事件。
- M15：打开没有表的章节或构想时显示 `plot_grid.get` 给的空 3 × 3；作者第一次动手（打字、加行、改大小）之前先调 `plot_grid.create` 拿到 id。粘贴一块（带制表符、换行的文字）在旧版会把表撑大：界面先 `line_add` 补够行列，再逐格 `plot_grid.cell`。格子宽高比是本机偏好，不进书目。
- 两台设备同时第一次建同一张表，会合并出六行六列（行列 id 各自新建）。旧版也是这样（表的 id 确定、行列 id 随机）；要避免得让默认的三行三列用确定的 id，属于 F1 的事，先记着。 **F1 第五轮已做**：`BookTxn::create_plot_grid` 用确定的 id（`PlotRowId::default_for` / `PlotColId::default_for`）写成种子变更，两台设备同时建还是三行三列（见 [f1-model-doc.md 的待协调](f1-model-doc.md#待协调) 第 2 条）。
- M11（第七轮）：`element.list` 每条有 `created_at`、`updated_at`（秒，`updated_at` 已经算上正文的修改）。要素模板现在是一篇正文：类目页要编辑它时调 `category_template.document { book, category }` 拿到文档 id，用 `ws.prose_session(id)` 开编辑器；简单的读写照旧用 `category_template.body` / `set_body`。新建要素会把它整篇抄进去（含标记和链接）。
- M13（第七轮）：故事线的章节模板：`chapter_template.body` / `set_body` / `document { book, storyline }`，用法同上；`storyline.list` 的 `has_chapter_template`。`chapter.create` 给了 `storyline`、没给 `text` 就套它。
- M15（第七轮）：没存的表 `plot_grid.get` 就给出确定的行列 id，界面不用先调 `plot_grid.create`，直接写格子、改行名就行，第一次写就存下。
- M20（第七轮）：`mention.list` 多了 `limit`；`dr-view-stats` 里建输入的地方我补了 `limit: None`。
- M11（第六轮）：类目页的字段模版用 `category.list` 的 `template_fields` 和 `category_template.put/remove`；要素模版用 `category_template.body` / `set_body`（段落 + H1/H2/H3，整份写回）；书的创建时间在 `BookInfo.created_at`；右栏的「被引用 / 引用其他」和要素页的关联节用 `mention.list`（`to` / `from` 给要素，每条带 `blocks`、`count`），名字由界面从书目快照里找。
- M11：补丁区「+ 新建」调 `patch.create`（浮动，可空）；从选区建时带上 `source`、`source_block`、`source_text` 和 `anchor`（编辑器的锚点字节）。旧版界面的补丁正文是富文本（带人物链接），新版书目文档里只有纯文字（F1 待协调 4）。
- M13：故事线页的字段用 `storyline.list` 的 `fields` 和 `storyline.update` 的 `put_fields` / `remove_fields`；主页上的「故事线字段模板」用 `storyline_template.*`。

### M10（导入）/ Markdown 镜像

- **正文模板**（第七轮）：旧库的 `element_category.element_template`、`storyline.chapter_template`（编辑器 JSON）用和章节正文同一个转换器写进模板文档（`TemplateOwner::Category(..).doc_id()` / `TemplateOwner::Storyline(..).doc_id()`，导入对等方），书目里的旧字段原样留着。没转之前 F3 照旧字段读和套用，转了以后以文档为准。
- **自动链接规则补了一条**（第七轮）：恰好盖住名字的、指向别人的链接不让出去；`link_written` 已经照这条，导入、镜像不用改代码。
- **别人写的字自动链人物**（第五轮）：导入、镜像合回不走 F3 的命令，在自己的写入事务里调 `dr_workspace::autolink::matcher(&书目视图, &文档)` 建匹配器，写完一段字以后调 `link_written(&mut 事务, &匹配器, 写入的范围)`；规则和编辑器、F3 的命令一样，只链写入范围里完整出现的名字。0.1 的正文本来就带着旧版链好的链接，导入要不要再补链，由 M10 定（旧版是打开文档时以作者名义扫全文，新版不这么做）。

### M36（同步）

- **彻底删除一本书**（`book.purge`）现在只删本机。旧版先删 Hosted 上的、确认了再删本地，离线时书留在「最近删除」里下次再试。同步做好以后，`book.purge` 要先走服务器，或者由 M36 包一层；同时要防止服务器上的旧文档把删掉的书拉回来（见 F2-6）。
- 远端更新一律走 `Workspace::import_remote`：它走 F2 的 `import`（自动记下服务器已有的版本），然后跑 dr-doc 的修复（重复的块 ID、语义重复的关系、缺书序的章节）。直接调持有者的 `import` 会跳过修复。第七轮起不再修待办正文（种子变更本身就不会重复）。返回 `false` 表示这本书在本机彻底删过（第六轮）。
- 模板文档（`template:` 开头，种类 `template`）和别的正文一样同步。
- 书目和正文分开到达是正常的：`todo.project` 已经按「正文还没到」等着，不会误删待办。

## 没做的，和下一个里程碑建议

- **没做**：
  1. 补链匹配的是 dr-store 的段落索引：刚导入、索引还在后台补建时，没开着的文档可能漏补（开着的照样补）；
  2. 正文的修订 CAS（带版本的写入），以及作者也改过同一篇正文时按段撤销 Agent 的改动（现在只报冲突，请作者从历史恢复）；
  3. 清理没人认领的正文文档（彻底删除后留下的，和中途失败留下的）；
  4. 补链要把每篇候选文档读进来：名字在几百篇长章节里出现时还要一两秒（第八轮第 3 条，再快要 F2 的接口，见 F2-7）；
  5. TODO 标记只在编辑器打开那篇正文时才投（和旧版一样）：Agent 用命令写进去的标记、同步来的标记，要等作者打开那一章。识别标记的规则现在只在 `dr-editor` 里；要在后台投，得把规则挪到下层一处（比如 dr-text），再由工作区在正文变化时自己找。素材笔记的任务行（`NoteTask`）还没做。
  6. 要素的 `updated_at` 暂由 F3 自己写键（F1-5）。
  7. 构想转成要素时，别的正文里已经链到这个构想的字不改指向新要素（和旧版一样，第十轮第 2 条）；M16 要的话，在同一步里把指向构想的链接换成指向要素。
- **下一步（2026-11-08 交接）**：作者的 Claude 用量快用完了，F3 后面的活转给 Codex / Antigravity。第十轮（`84192217`）是最后一次提交，手上没有做了一半的东西。接手时按顺序：
  1. 先读这一页第十轮到第七轮的小节和「待协调」，再读共享笔记里的 `f3-workspace-interface.md`（各轮的接口摘要）；
  2. 等别人做的：M14 把叙事时双击新建换成一步（`chapter.create` 带 `narrative_order`）、~~M14 的拖放换成 `chapter.place`、打散用 `chapter.spread`~~（M14 第三轮已接，第二十一批核对）；F4 删编辑器里的后台补链、换用 `Workspace::link_matcher`；~~F6 的 `swap` 换用 `try_shutdown`~~（F6 第八轮已接，第二十一批核对）；F8 在 `bench workspace` 里加补链那一项（第九轮待协调 F8）；
  3. F8 加好以后，在负载低于 5 时跑 `cargo run --release -p dr-testkit --bin bench -- workspace --milestone f3-m3`，把第八轮补链的数字（heavy 上新建常见名字的要素从 13–18 s 到约 2 s）写成证据；
  4. 每轮的检查照「测试与证据」一节；改了命令要 `INSTA_UPDATE=always cargo test -p dr-workspace --test registry` 更新能力清单快照，新命令要在 `tests/commands.rs` 等文件里被调到（清单测试会查）。
- **建议的下一个里程碑**：
  1. 加后台清理（第 3 条）；F2 的 `purge_book` 到了就换上（F2-6）；
  2. 重测「改了以后列关系」「冷读批注」（按键读取已换上）；heavy 种子上的补链（建要素、改名、撤销）加进 `bench workspace`，探针这次没提交；
  3. 机器空闲时跑 `bench workspace --milestone f3-m3`（第三轮、第四轮都没量；F2 第四轮以后的搜索，和 heavy 种子上的 `chapter.list`、`book.shelf`、`history.points` 也一起记下）；
  4. 帮外壳接上真书（F6 下一步的第 1 条），用 F8 的调试桥跑一遍「打开书 → 删章 → 标签关掉」。

## 代码位置

```text
next/crates/dr-workspace/src/
  lib.rs           入口和总说明
  registry.rs      登记表、能力清单、Op trait
  cx.rs            命令上下文：写入顺序、租约、影响清单、反操作、故障注入
  holder.rs        在 F2 持有者的写入任务里写（提交选项、作者命令的 user:command）、共用的锁、几篇一起做的 par_map
  workspace.rs     打开的书和正文、run / call、撤销重做、import_remote、事件分发、删除事件、退出
  nav.rs           给外壳的目录（LinkGroup、NavTarget、BookCatalog）
  events.rs        事件类型和换算
  cache.rs         按书的查询缓存（含自动链接的名字表和匹配器）
  journal.rs       撤销日志（ws_journal）
  editor.rs        ProseSession（编辑器层撤销；作者命令的 user:command 不进它的栈）
  actor.rs dto.rs naming.rs error.rs
  autolink.rs      自动链人物：规划（给编辑器）、别人写的字、补链已有正文
  commands/        book（含书架、彻底删除）chapter storyline element relation idea comment（含锚点和 TODO 投影）
                   material prose history points（M09 快照历史）recent（最近打开）time_pin stats（M07）
                   plot_grid patch template（第五轮）
next/crates/dr-workspace/tests/
  （第八轮的新测试在 commands.rs、autolink.rs 里）
  commands.rs registry.rs events.rs shell.rs editor.rs shelf.rs points.rs autolink.rs workshop.rs write_order.rs undo.rs
  invariants.rs footprint.rs
next/crates/dr-view-history/       M09 的对话框（见 modules/m09-history.md）
  snapshots/       能力清单快照（registry__capabilities.snap、registry__capability_schemas.snap）
docs/rust-rewrite/acceptance/f3-m2-workspace-bench.json
```

### 收尾检查：构想仍是存活的投射目标（2026-11-08）

不变量测试的 `check_tolerant` 原来只枚举存活章节/要素；构想转章节、投射待办、撤销转换后，仍是同一个存活 `node`，却被测试误判为孤立。补上 `idea.list`，保留 proptest 生成的失败种子，并增加 `regression_projected_todo_stays_located_when_conversion_is_undone`：相同 id 回到构想，待办及定位完全保留。这是测试口径修正，没有改变转换或投射产品逻辑。定向契约与修正后的完整工作区检查中该组通过。
