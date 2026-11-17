# M17 关系与关系类型

**2026-11-17，RD。** 关系是项目级的名字、带条目链接的描述和方向。每行的左、右各有一组条目，跨两边的每一对都成立。同一边的成员可分别同步，关系图按当前方向摊成配对。条目页的「关联」模块和旧的图上类型管理已移除。参见 [规则](../kernel-v5.md#19-关系重做)和 [读写接口](../kernel-v5.md#rd-交回项目关系与带链接的短文字2026-11-17)。

**RL 监管补口（实施中）。** 右栏草稿的一行不能拆成「建一对、再逐个加人」：会拆撤销，且已有行的其他对端会被误连。监管先记录缺口，再补 `relation_row.create_group` 一次提交明确左右集合，失败保留草稿；接口与守卫见 [第 18 节](../kernel-v5.md#rl-监管补口右栏的一行草稿2026-11-17实施中)。这段不是已验收声明，合树验收后更新。

数据回归见 `dr-workspace/tests/relations_v5.rs`、`dr-doc/src/v3/tests.rs`，覆盖选行、方向、最近删除、清除、撤销、正文标记投影及并发追加。以下是切换前的历史记录。

2026-11-08，第一个里程碑；同日第二个里程碑：挂到要素页上，用调试桥在真窗口里点了一遍。计划见 [modules.md 的 M17](../modules.md#阶段-3故事工坊)。界面在 `next/crates/dr-view-relations/`，数据全走 F3 的 `relation.*`（列出、建立、删除）和 `relation_type.*`（列出、新建、修改、删除），在 `next/crates/dr-workspace/src/commands/relation.rs`。对照的旧版是桌面端 `src/renderer/components/editor/ReferencesPanel.tsx` 的「关联」一节、`components/ui/RelationTypeField.tsx`、`components/ui/RelationKindMenu.tsx`（类型管理和 `RelationTypeEditor`）、`src/styles/entity-editors.css` 和 [docs/relation-types.md](../../relation-types.md)。截图在 [m17/](m17/)。

## 做了什么（大白话）

1. **「关联」一节。** 旧版只在要素页上有，放在「字段」下面。每条关系是一张卡片：上面是对方的记号、种类（要素、章节……）和箭头（→ 是这个要素指向对方，← 是对方指向它）；中间是对方的名字，点一下打开它的页面；下面是关系类型（色条、名字、两端的角色，比如「欺辱 欺负的人 → 受气的人」）。点类型可以换成别的类型；只有对方向能用的类型会把这条关系掉个头。有方向、两头都合规矩的类型旁边有 ⇄，点了直接掉头。指针移到卡片上，右上角出现 ×，点了移除。最新建的排最前。卡片一行放几张看页面宽度，每张至少 190 宽。
2. **「＋ 关联实体」。** 在这一节里就地打开选择器：上面一排种类（全部 / 要素 / 章节 / 分类 / 故事线；「章节」里也有构想），下面一个搜索框，再下面是书里还没跟它建关系的东西（最多 50 个）。点一个，它就出现在搜索框下面，等着定方向（「该实体 → 目标」，点 ⇄ 掉头）和类型；类型下拉里只列这一对能用的类型。选好后点「创建」，关系建好，选择器收起。
3. **下拉的最后一行「新建关系类型」。** 这一对没有合适的类型时，点它直接打开新建类型，两端的种类已经按这一对填好；保存后类型面板收起，新类型自动选上，回到这一对。（从「编辑类型」新建的类型不会替作者选上。）
4. **「编辑类型」。** 打开整本书的关系类型：每个类型一行，色条、名字、两端角色、用了多少条、垃圾桶。
   - 点色条展开七个颜色和「恢复默认色」。颜色存在书里（跟着同步），存的写法和旧版一样（`hsl(var(--story-3))` 这样），所以浅色、深色下各自是对的颜色。
   - 点名字就地编辑：名称、方向（有向 / 对称）、角色（对称只有一个「端点角色」）、说明、两端允许哪些种类。名字和别的类型重复时，F3 拒绝，原因写在编辑区下面。
   - 垃圾桶：只有没有关系在用的类型能删，删前先问「删除关系类型「X」？」（窗口的对话框）。
   - 内建的「关联」（批注、素材一键关联用的）不能改、不能删、不能换颜色。
5. **别处的改动会显示出来。** 另一个窗口、帮手（Agent）建了或删了关系、改了类型，F3 发出事件，这一节和类型列表重新读一遍。

**要作者定的事：没有。** 和旧版不一样的地方列在「和旧版的差别」，要别的模块配合的在「待协调」。

### 第二个里程碑：挂上要素页、真窗口验收

1. **要素页上有了「关联」。** 和旧版一样放在「字段」下面，是页面的最后一节（底下留 80 的空）。章节页、构想页旧版没有这一节，这里也不加。
2. **真窗口里点了一遍。** 用 F8 的调试桥写成场景 `next/crates/dr-cli/scenarios/relations.json`（57 步，界面英文），在这台 Mac 上全过：打开《慢钟》的「沈知微」，滚到页尾，11 张卡片；「编辑类型」→「新建」→ 写「宿敌」→「保存」，F3 里是有向、角色 Source / Target；点「宿敌」的色条换第三个颜色，F3 里存成 `hsl(var(--story-3))`；「关联实体」搜「林晚秋」、选上、类型下拉选「宿敌」、「创建」，F3 里有沈知微 → 林晚秋；× 移除；再开类型，把列表滚到底，点「宿敌」的垃圾桶：类型面板收起、对话框问「删除关系类型」，确认后 F3 里没有了，卡片回到 11 张。截图在 `target/acceptance/relations/`（不提交）。
3. **点的过程中找到并修了三处：**
   - 新建的类型排在列表最后，列表高度有限，它被挡在下面，色条点不到：保存后、点开颜色或编辑时，把那一行滚进来；
   - 点「保存」后整页跳回顶上：编辑区的输入框一消失键盘就没了主人，外壳把键盘交回正文，正文滚到光标那里。现在编辑区关掉时键盘留在类型面板上；
   - 删除的确认弹出时类型面板收起（旧版的弹窗下面面板还开着；这里对话框和面板上的垃圾桶都叫「删除关系类型」，留着两个分不清），确认框自己拿着库去删。
4. **给调试桥和读屏的名字**：卡片是一组（名字是对方的名字），卡片名字是链接，类型字段是下拉（名字是选中的类型或「选择关系类型」），⇄ 是「交换关系两端」；类型面板每一行是一组（名字是类型名），色条「修改 {{label}} 的颜色」，七个颜色「点击改色 N」，名字是按钮。用的是旧版这几处的 `title` / `aria-label` 文案（加了 3 个键）。

## 规则（定稿）

- **读**：这一节读整本书的关系类型和与这个对象有关的关系（`relation_type.list`、`relation.list` 带 `entity`）；类型管理读全部关系，用来数每个类型用了几条。都在后台线程。对方的名字、记号、颜色用外壳的书快照（`dr_shell::book::Book`），不另读。
- **对方是哪一种**：F3 的端点是 `node` 时，书里有这个章节就当章节，否则当构想；补丁、批注没有页面，名字点不开。对方已经不在书里时写「(已删除要素)」之类（`referencesPanel.deleted.*`）。
- **自己连自己**：F3 不允许（`REL-NO-SELF`）；万一有，显示一次，当作指出去的。
- **哪些类型能用**：直接用 dr-model 的 `relation_ends`（F3 建关系时用的同一个检查）：方向、两端种类都对得上才算。改类型时，两个方向有一个能用就列出来；只有反过来能用时，换类型的同时掉头。
- **写**：建立、删除、换类型、掉头都在后台线程交给 F3，作者的身份；做完再读一遍。F3 没有「改一条关系」的命令，所以换类型和掉头是「先建新的，再删旧的」：撤销要两步，关系换了 id（待协调 1）。
- **新类型的默认值**：有向，角色是「源端」「目标端」（`relationTypes.default*Role`，作者的语言），两端允许全部种类（源端 7 种，目标端 5 种，和旧版一样）。从下拉的「新建关系类型」进来时，两端只允许这一对的种类。切到「对称」时，两端都留下任一端原来有的结构种类（批注、素材不能用在对称类型上）。
- **改已有的类型**：只改名称、说明、角色（只把变了的字段发给 F3）；方向和允许的种类显示出来但不能改（F3 的 `relation_type.update` 不改这些，待协调 2）。
- **颜色**：类型自己有颜色就用它（旧版的写法或 `#RRGGBB`），没有就按 id 算一个默认色（旧版 `defaultRelationTypeColor` 同一个算法），所以同一个类型在各处颜色一样。
- **删除类型**：F3 会连这个类型的关系一起删（`relation_type.delete`），界面照旧版只让删没在用的类型，所以不会连带删关系。

## 和旧版的差别

| 旧版 | 新版 | 为什么 |
| --- | --- | --- |
| 关系卡片上的色条用一套单独的散列（`relationTypeColor`，六种故事线色） | 和类型管理、图里用同一个颜色（类型自己的颜色或 `defaultRelationTypeColor`） | 旧版两处颜色对不上；新版一个类型一个颜色 |
| 类型颜色只存在这台设备上（`drifting:edge-kind-meta`），内建的「关联」也能换色 | 存在书里，跟着同步；内建的不能换色 | F3 把颜色放进了类型本身（导入时也从交接清单搬了进来）；F3 拒绝改内建类型（待协调 3） |
| 改已有类型的方向和允许种类（逐条检查已有关系） | 只能改名称、说明、角色，方向和种类灰着 | F3 的 `relation_type.update` 没有这几项（待协调 2） |
| 换类型、掉头是一步（`updateRelationType`），id 不变 | 先建后删，撤销两步，id 换了 | F3 没有 `relation.update`（待协调 1） |
| 类型下拉没有合适的类型时写「请先在“全部关系”中创建关系类型」 | 下拉最后一行是「新建关系类型」，就地新建 | 新版还没有「全部关系」那个画布菜单（M21 / M22）；用的是旧版现成的「新建关系类型」 |
| 垃圾桶、色条、⇄、卡片名字悬停有说明（「仍有关系使用此类型」「点击改色」……） | 没有 | dr-ui 还没有悬停提示（待协调 4） |
| 类型编辑器里种类的标签前有砂笔记号 | 只有字 | dr-ui 的 `Chip` 没有记号（待协调 4） |
| 类型管理里「当前画布 N 条 / 项目共 M 条」 | 只有全书的条数 | 这里不在画布上；画布的筛选和计数是 M21 / M22 的事 |
| 空名字的分类写它的 id | 写「分类」 | id 对作者没有意义 |

## 怎么挂的

旧版的「关联」只在要素页上，放在「字段」下面、补丁上面（补丁还没做）。第二个里程碑在 dr-view-elements 里挂好了（`ElementEnd`，`element_relations(id)` 给测试和调试桥拿到它）：

1. 用 `dr_view_relations::relations(End { kind: "element", id }, ws, window, cx)` 做出 `Entity<Relations>`，放在要素页的页尾、「字段」下面（`Fields` 的 `last` 改成 `false`）。它自己从 `ws` 读书快照、从 `Services` 拿库，别的不用传；节头（「关联」、条数、「编辑类型」「＋ 关联实体」）和「字段」同一个样式，排在正文那一栏里。
2. 要素页的页尾现在只有 `Fields` 一个视图，要改成 `Fields` 和 `Relations` 上下两个；`end_estimate` 大约多 200。
3. 类型管理从「编辑类型」浮出来，删除的确认走 `dr_shell::dialogs::show_in`，要素页都不用管。
4. M11 计划里的「关联（ReferencesPanel 的关联节、关联选择器）」就是这一块，不用再写一遍；「被引用 / 引用其他」两节还是 M11 / M20 的。

dr-view-elements 依赖 dr-view-relations（界面层之间可以依赖，门禁 `layers` 认可）。

## 文案

全部是旧版九种语言里现成的，`dr-i18n/keys.txt` 第一个里程碑加了 52 行：51 个键一个个列出，`relationTypes.entityKinds.*` 一组 7 个（用到的旧键 `common.cancel`、`storyGraph.edge.create`、`referencesPanel.kind.patch`、`relationTypes.description` 原来就有）：

| 用在哪 | 键 | 中文 |
| --- | --- | --- |
| 节头 | `referencesPanel.sections.relations`、`actions.linkEntity`、`common.cancel`、`edgeKindManager.editTypes` | 关联、关联实体、取消、编辑类型 |
| 选择器 | `referencesPanel.filters.all`、`kind.element` / `node` / `category` / `storyline`、`picker.placeholder`、`picker.empty` | 全部、要素、章节、分类、故事线、搜索可关联的实体…、没有可选项 |
| 等着建的那一条 | `relationTypes.pendingOutgoing` / `pendingIncoming`、`selectConfigured`、`storyGraph.edge.create`、`createInline` | 该实体 → 目标、该实体 ← 目标、选择关系类型、创建、新建关系类型 |
| 卡片 | `referencesPanel.actions.remove`、`relationTypes.missing`、`symmetricSummary`、`referencesPanel.kind.patch`、`referencesPanel.deleted.*`、`relationPicker.untitled*` | 移除关联、缺失的关系类型、对称 · {{role}}、补丁、(已删除要素)……、无标题章节…… |
| 空的时候 | `referencesPanel.empty.relations` | 尚无关联 |
| 类型管理 | `edgeKindManager.title`、`summary`、`resetColor`；`relationTypes.title`、`create`、`builtIn`、`delete`、`confirmDelete` | 全部关联类型、{{kinds}} 类 · {{relations}} 条关联、恢复默认色、关系类型定义、新建、内建、删除关系类型、删除关系类型「{{name}}」？ |
| 类型编辑器 | `relationTypes.name`、`direction`、`directed`、`symmetric`、`sourceRole`、`targetRole`、`endpointRole`、`description`、`allowedSources`、`allowedTargets`、`allowedEntities`、`entityKinds.*`、`defaultSourceRole`、`defaultTargetRole`、`cancel`、`save` | 名称、方向、有向、对称、源角色、目标角色、端点角色、说明、允许源实体、允许目标实体、允许实体、章节或构想……、源端、目标端、取消、保存 |
| 内建类型 | `relationTypes.genericAssociation.name` / `sourceRole` / `targetRole` | 关联、关联项、对象 |
| 读屏和调试桥用的名字（第二个里程碑） | `edgeKindManager.changeColor`、`changeColorLabel`、`relationTypes.swap` | 点击改色、修改 {{label}} 的颜色、交换关系两端 |

## 截图

`cargo run -p dr-view-relations --features capture --example relations-capture -- ../docs/rust-rewrite/modules`：GPUI 离屏画（真的 macOS 排字和 Metal），820 × 760，书是 dr-testkit 的《阿Q正传》，看的是阿Q（15 条关系）。一个工作区窗口打开这本书（名字从它来），「关联」单独一个窗口；要素页还没挂它，所以截的是这一节本身。

| | 浅色 | 深色 |
| --- | --- | --- |
| 阿Q 的关联 | [relations-cards-light](m17/relations-cards-light.png) | [relations-cards-dark](m17/relations-cards-dark.png) |
| 「土谷祠」那张卡片的类型下拉 | [relations-type-menu-light](m17/relations-type-menu-light.png) | [relations-type-menu-dark](m17/relations-type-menu-dark.png) |
| 选择器：要素、搜「赵」、赵白眼 → 阿Q 等着「欺辱」 | [relations-picker-light](m17/relations-picker-light.png) | [relations-picker-dark](m17/relations-picker-dark.png) |
| 类型管理 | [relations-types-light](m17/relations-types-light.png) | [relations-types-dark](m17/relations-types-dark.png) |
| 「冤家」的颜色 | [relations-colors-light](m17/relations-colors-light.png) | [relations-colors-dark](m17/relations-colors-dark.png) |
| 新建类型 | [relations-editor-light](m17/relations-editor-light.png) | [relations-editor-dark](m17/relations-editor-dark.png) |
| 删除类型的确认 | [relations-delete-light](m17/relations-delete-light.png) | [relations-delete-dark](m17/relations-delete-dark.png) |

## 测试

在 `next/` 下：

```bash
cargo test -p dr-view-relations --locked
cargo clippy -p dr-view-relations --all-targets --features capture --locked -- -D warnings
```

| 测试 | 内容 |
| --- | --- |
| 单元测试（5，`model.rs`） | 关系按新到旧、自己连自己只显示一次、两端的顺序；类型按方向和种类合不合（要素 → 章节、反过来、对称、自己连自己），改类型时哪些能选、要不要掉头、能不能掉头；颜色读旧版写法和 `#RRGGBB`，默认色和旧版的算法逐个对得上；编辑器切对称时两端种类一致、对称只有一个角色；内建类型用作者语言的名字和角色 |
| `tests/relations.rs`（5） | GPUI 测试平台，F3 经 dr-store 的真库，书是《阿Q正传》，外壳的工作区窗口打开书：阿Q 的 15 条关系按新到旧、类型 10 个（9 个加内建）、赵太爷 → 阿Q 是「欺辱」；帮手给阿Q 建一条关系，这一节马上多一张、排在最前；选择器排除阿Q 自己和已有关系的 12 个要素，按种类、按名字（「赵」只剩三个）筛，选一章时下拉只有「关键章节」、掉头后一个都没有，赵白眼 → 阿Q 选「欺辱」创建后 F3 里有、选择器收起；「土谷祠」那张从「住在」换成「持有」（方向不变、旧的删了），⇄ 后变成土谷祠 → 阿Q，× 后没了；类型管理：和「本家」重名被拒、原因写在编辑区，新建对称的「师徒」（一个角色、两端种类一样、没有批注），改名「师生」（方向没变），改颜色存成 `hsl(var(--story-3))`、恢复默认色清空，内建类型不能编辑不能改色，在用的「欺辱」点垃圾桶什么都不问，新类型点垃圾桶时工作区窗口出现确认对话框、确认前没删、确认后删了；一章 → 阿Q 没有合适的类型时，下拉的「新建关系类型」打开的编辑器两端种类是章节 / 要素，保存后新类型自动选上、类型面板收起，创建成功 |
| `dr-view-elements/tests/pages.rs` | 打开「沈知微」的要素页，「字段」下面有「关联」，条数和 F3 列出的一样 |
| `dr-cli/scenarios/relations.json`（真窗口，57 步） | 见上面「第二个里程碑」；`cargo build -p drifting --features debug-bridge`，再 `cargo drifting workspace scenario crates/dr-cli/scenarios/relations.json --app target/debug/drifting --yes` |

## 待协调

1. **F3：`relation.update`**。改一条关系的类型或掉头，现在是先建后删（撤销两步、id 变了）。要一个 `relation.update { id, relation_type?, swap? }`，一步、id 不变；有了以后 `data::replace` 改成调它。
2. **F3：改类型的方向和允许种类**。旧版能改（会逐条检查已有关系，不合规矩的拒绝）。F3 的 `relation_type.update` 没有这几项，编辑器里灰着。
3. **F3：内建类型的颜色**。旧版的颜色是本机偏好，内建类型也能换色；新版颜色在类型里，F3 把内建类型整个锁住，连颜色也不能改。要不要放开颜色，F3 定。
4. **F5（dr-ui）**：悬停提示（垃圾桶为什么灰、色条、⇄、卡片名字）；`Chip` 加记号（类型编辑器的种类）。
5. ~~M11：把这一节挂到要素页「字段」下面~~：第二个里程碑做了（改了 dr-view-elements 的 `lib.rs`、`Cargo.toml` 和 `tests/pages.rs`，请 M11 知悉）。
6. **M18 / M19**：批注、待办、素材卡片上的一键关联（旧版 `EntityRelationPicker`，用内建的「关联」类型）这一轮没做，等那两张卡片做出来时可以用这里的选择器和 `data::create`（F3 的 `relation.create` 对批注和素材省略类型时自动用内建类型）。

## 没做的

- 批注、待办、素材上的一键关联（`EntityRelationPicker`），见待协调 6；
- 画布上的关系筛选（`RelationKindMenu` 的「画布筛选」那一半）和故事图里按住 Shift 连线，是 M21 / M22；
- 手机端。

## 代码位置

`next/crates/dr-view-relations/`：

| 文件 | 内容 |
| --- | --- |
| `src/lib.rs` | 模块说明、`relations()` |
| `src/model.rs` | 不依赖 GPUI 的部分：一个对象的关系、选择器的候选、类型合不合、类型的文字和颜色、编辑中的类型（`Draft`） |
| `src/data.rs` | 调 F3：读、建、删、换类型（先建后删）、新建 / 修改 / 改色 / 删除类型 |
| `src/look.rs` | 页面上的样子：正文那一栏、节头、空的那一行、色条、种类和名字的文字 |
| `src/section.rs` | `Relations`：「关联」一节、选择器、等着建的那一条、卡片、类型下拉、类型管理的浮层 |
| `src/types.rs` | `TypeManager`（类型列表、颜色、编辑器）、`DeleteTypeDialog` |
| `tests/relations.rs` | GPUI 测试 |
| `examples/relations-capture.rs` | 截图 |

## 内核 v5 · T5 条目关系里的文件端点显示（2026-11-15）

按 [kernel-v5.md 第 15 节第 17 条](../kernel-v5.md#15-还要定的) 与 [v5-tracks.md 的 T5](../handoff/v5-tracks.md#t5-文件t5-files)，`dr-view-relations` 的 `EntryRelations` 支持显示另一端为活文件（`EntityKind::Asset`）的关系行：展示 `24×24` 缩略图（无缩略图时按图片/PDF 显示图标）、文件名、关系类型与方向，点击打开文件查看器，右侧可删除该条关系；文件或其所在素材夹进入最近删除后自动隐藏，恢复后重现。按任务书约定，界面暂不提供新建「条目 ↔ 文件」关系的入口（选择器只列条目）。永久回归见 `dr-view-relations/tests/v5_files.rs`。

## RL 正文一边：悬停连线和就地建关系（2026-11-17，分路实现）

照 [kernel-v5.md 第 19 节](../kernel-v5.md#19-关系重做)「指针停在名字上」「就地建关系」和原型第 3 版做的。右栏的「关系」、批注和描述里的链接、关系图是 RL 的另一个会话，不在这里。

### 大白话

1. **指针停在正文里的条目名字上**：悬停卡照旧出来，同时这一屏里彼此有关系的名字之间都连上一道砂笔弧线（不只是指针下这一个），被连的名字下面多一道砂笔。线上写关系的名字，落在两行字之间的空白里，不带框、不盖字；同一对之间几种关系只画一条线，名字用「·」隔开；单向的名字后面一个小箭头指着被指的那一头。同一个名字在屏上出现几次只连一处：指针下的用指针下那一处，别的取离它最近的。滚出屏的名字不连，滚动时跟着重算；悬停卡收起，线跟着收。悬停卡躲到线少的那一边（往下的线多就放到名字上面）。指向文件的链接不参加。单章的条目页和整书视图都有。
2. **悬停卡最下面一行「建关系」**：点了悬停卡收起，稿纸底下出来一条，停在看得见的那一块的底部，不跟正文滚。从左到右：这个条目、方向钮、对方、关系的名字、取消、建立；上面一排是这本书里用过的关系名字，再上面是 @ 框找到的条目。
   - 对方：点正文里另一个名字（这时屏上别的名字都描一圈，指针移上去、选中的那一个圈变成强调色），或者在 @ 框里打字找，全书活着的条目都找得到；选了以后两个名字之间画一条虚线，对方那里可以点 × 换一个。
   - 关系的名字：点上面一排里的一个就是复用，点中的亮着；写一个没用过的名字就是新建。用过的名字方向已经定了：双向的方向钮点不动，单向的只能换谁在左边；新名字按 → ← ↔ 轮着换。
   - 「建立」：对方和名字都有了才点得动，调 RD 的 `relation_row.create_pair`（落行的四步规则、这一对已经有了就不写，都是数据层的），建一次是书里的一步撤销。建好以后正文发 `RevealRelationRow { row }` 给右栏，这个条目的线再留 2.6 秒。Esc 和「取消」退出。
3. **右栏的一行**：右栏设置 shell 的 `RailHover`，`dr_view_page::init` 将它传给正文的 `RelationFocus`；正文把这一行里屏上看得见的几对连出来，清空悬停行时线也收起。

### 怎么画的

- **线**：dr-ui 的 `sand::line::along` 把实体链接下面那道砂笔（`ul.png`）顺着弧线弯过去：比砂笔本身长就整道拉长，短就从种子定的地方截一段、最后 12 px 留它自己的干笔头，和 gpui-prose 在一行字下面铺这道笔的规则一样。每条线按「相对起点的形状」光栅化成一张图缓存，正文滚动时两头一起动、形状不变，不重画；约 90 帧没用到的图放掉。名字下面那一道用同一支笔拉直了画。墨色是 `ink-2` 铺在纸上的颜色，线 0.7、名字下面 0.55（深色主题再乘 0.72，和正文砂笔一样）；虚线是强调色，照原型。
- **位置**：`dr-editor` 的 `assist::relate::geom` 是纯几何，规则照原型的 `edgesOnScreen`、`curve` 和放名字的那一段（同一行的两个名字之间是一道往下垂 20 px 的弧；不同行的从上面那个名字底下到下面那个名字顶上，往右弓出长度的 16 %，6 到 44 px）。屏上的名字、行的位置从编辑器上一帧画出来的东西读（gpui-prose 新加的两个只读接口，见下）。
- **在哪画**：每个编辑器的 `Assist` 一层，盖在正文上、悬停卡下面（GPUI 的延后绘制，优先级 1），裁到编辑器看得见的那一块（条目页的正文按页面的滚动区裁）。

### 接口

| 名字 | 说明 |
| --- | --- |
| `dr_editor::assist::relate::{RelationLabels, RelationFocus, Dir, Drawn, DrawnLine, ComposeState, Index, LINGER}` | 文字（宿主给）、右栏指着的行、方向、上一帧画了什么（测试用）、建关系那一条的状态、读到的关系和条目、建好后线留多久 |
| `Assist::{start_relation, open_compose, close_compose, relation_pick, relation_unpick, set_relation_query, set_relation_name, relation_flip, relation_commit, compose_state, relation_drawn, set_relation_labels, set_page}` | 悬停卡「建关系」和那一条上每个按钮做的事；`set_page` 是条目页的滚动区 |
| `AssistEvent::RelationPlaced { row }` | 建立以后给宿主的行 id；`dr_view_page::v3::bind_relations` 把它转成 `dr_shell::actions::RevealRelationRow` |
| `link_card::card_element_with(facts, actions, …)` | 悬停卡带最后几行 |
| `gpui_prose::ProseEditor::{painted_group, painted_rows}` | 上一帧画出来的某一组装饰（每个连同各段合在一起）、每一行字的位置（行顶就是两行之间空白的中线） |
| `dr_ui::sand::line::{along, quadratic, Line}` | 顺着一条折线弯的砂笔线、二次曲线取点、画成图 |

### 测试

- `dr-editor/tests/relations.rs`（11 条）：悬停一个名字屏上有关系的几对都连出来、同一对两种关系一条线两个名字、单向的箭头指向对的一头、关系名字落在行间空白不在名字上、没关系的名字不连、卡收起线收；同一个名字出现两次只连近的那一处；整书视图里滚走一个名字以后那条线没了；点正文里的名字复用用过的名字落进已有的那一行（规则 1）、宿主拿到行 id、线留 2.6 秒后收、撤销一步回来；@ 框找到屏上没有的条目、新名字的方向三选一、新建一种关系、建关系和这一对是一步撤销；用过的双向名字方向钮点不动、单向的只换左右、已经有的一对不重复写并给回那一行；Esc 和取消退出、正在建时指针停在名字上不出卡；右栏指着一行时只连这一行；指向文件的链接不参加；整书视图里跨章连线；六项候选超过列表高度时，用真实滚轮滚到第六项并点击选中。
- `dr-editor` 的 `assist::relate::geom`、`assist::relate` 单元测试（7 条），`dr-ui` 的 `sand::line`（4 条）。
- `dr-view-page/tests/v5_rl_prose.rs`：真实正文宿主接收 `RailHover` 后检查画出的两端，清空后连线消失；条目页正文里建好一对，`RevealRelationRow` 带着落到的那一行的 id 发出去。
- 2026-11-17 分路收尾：正文 11 条、宿主 1 条 GPUI 回归通过；分别撤掉候选滚动和宿主 hover 转发，两个负控都在对应行为断言失败，恢复后复绿。四个涉及 crate 的 all-targets clippy（`-D warnings`）、格式和语言文件一致性检查通过，实际日志见仓外交回报告。
- 正文、右栏、关系图合树后的真窗口场景由监管执行；本分路没有独立的 `v5-rl-prose.json` 场景，不把旧草稿里写过的文件名当成已完成验收。

### 没画、要作者定的

这里记下做法上照原型没补、交给作者定的几处：@ 框里回车不选第一个、名字框里回车不建立（原型都没绑）；@ 框只按标题找（不按别名、拼音首字母）；正文同一页上有几篇正文时，线只连同一篇里的名字（原型只有一篇）。

## 内核 v5 · RL 右栏与短文本（2026-11-17，定向验收交回）

`dr-view-relations::rail` 实现第 19 节的「关系」侧栏，位于「审阅」之后：按创建时间倒序的关系卡、改名与重复名失败保留、整卡方向、描述、左右集合及行增删、当前筛选、行定位和短暂亮起。每种关系的计数由 RD 返回的唯一 pair 数给出。新卡先单独保存名称；一行两边都有条目后使用监管补的 `relation_row.create_group`，明确保存这组左右集合，不让 `create_pair` 的自动归行扩出草稿没有选的关系。写入期间保留草稿并拒绝重复提交，失败保留左右集合并可重试；一次成功分组对应一次撤销。

右栏通过工作区 Book/正文索引事件重读。换书的回调按 epoch 隔离，旧书的完成回调不能清新书的编辑框；鼠标离开、行消失、换页/换书和侧栏隐藏时收起悬停。`dr-shell::relations::RailHover` 是侧栏和正文宿主之间的 seam，实际接到正文的 relay 由 RL prose 一路交回。当前条目页包含其条目及正文链接到的条目；整书/泳道范围读取与正文相同的 `BookStructureV3::sequence`，包含挂入的条目，再合正文引用索引。它不自行定义另一套父子树。

`dr-ui::linked` 是短文本显示和输入组件：链接用正文相同的强调色与砂笔下划线，点击打开条目，不增加条目悬停卡；编辑保存字符位置的链接，输入链接内部会拆链，链接外的编辑让范围随文字移动。@ 的列表只收活条目，超过七行可滚动并用上下键选；输入法组合中的方向键和确认键不被候选截走。

关系描述、审阅卡片和批注撰写框共用这套输入。批注 @ 排除自身挂靠条目；保存发送 `LinkedTextIn::Linked`，自动名字/别名链接和不可见链接回填仍由 RD 已有规划器处理，服从同一个自动链接设置。重命名、最近删除及恢复读取 RD 投影。标记/清单投影只显示正文已有的链接，不另开改字入口；链接不进入正文提及或同段关系索引。

定向回归的位置：`dr-view-relations/tests/rail.rs`（含真实 `import_remote`、失败分组、一步撤销、换书和当前筛选）；`dr-view-review/tests/review.rs` 与两个编辑器单元回归（含 @、隐藏链接恢复、重复提交和失败保留）；`dr-ui/tests/linked.rs`（候选滚动、Unicode 范围和链接点击）。本轮定向结果：右栏 16 项、审阅集成 15 项、短文本真输入/滚动/点击 1 项、监管分组命令 10 项、Agent 关系身份与每成员读取覆盖 3 项全部通过；注册表 5 项和目录 15 项通过，由测试生成的三份快照仅增加 `relation_row.create_group`。8 个精准负控在移除守卫后转红、恢复源码后转绿，覆盖重复 pair、方向并发、整行撤销、失败草稿、换书回调、隐藏清线、整书收纳范围和候选键盘滚动。真实窗口串联、全套检查和 clippy 由监管在 `supervisor/merge-rl` 跑，本段不把最终验收记为完成。

### RL 合树复审补修：并发写守卫（2026-11-17，待定向验证）

右栏读取关系、原始行和记录摘要时核对同一个书版本；名称和描述从开始编辑保留这一份摘要，列表刷新不换掉旧稿的依据。保存冲突保留输入和已有失败提示，明确点击「重试」才采用当前显示记录。方向、移出成员和删行也由 `call_guarded` 在写入事务里核对所显示记录；删除最后一个空草稿时保留草稿直到成功，未知的远端新行没有读取授权，不能一起删掉。新卡名称正在保存时不能删其草稿。

往已有行加成员先在同一次读取中比较原来的对边集合、关系身份与方向，再用该次观察守住正式写入；同侧别人新加的成员保留。它复用 RD 命令，不增加数据接口。以下定向回归和负控仍在执行，本段不记作验收通过。
