# M17 关系与关系类型

2026-11-08，第一个里程碑。计划见 [modules.md 的 M17](../modules.md#阶段-3故事工坊)。界面在 `next/crates/dr-view-relations/`，数据全走 F3 的 `relation.*`（列出、建立、删除）和 `relation_type.*`（列出、新建、修改、删除），在 `next/crates/dr-workspace/src/commands/relation.rs`。对照的旧版是桌面端 `src/renderer/components/editor/ReferencesPanel.tsx` 的「关联」一节、`components/ui/RelationTypeField.tsx`、`components/ui/RelationKindMenu.tsx`（类型管理和 `RelationTypeEditor`）、`src/styles/entity-editors.css` 和 [docs/relation-types.md](../../relation-types.md)。截图在 [m17/](m17/)。

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

**要作者定的事：没有。** 和旧版不一样的地方列在「和旧版的差别」，要别的模块配合的在「外壳要接的」和「待协调」。

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

## 外壳要接的（给 M11）

旧版的「关联」只在要素页上，放在「字段」下面、补丁上面。dr-view-relations 只提供视图，挂在哪里由要素页决定：

1. 用 `dr_view_relations::relations(End { kind: "element", id }, ws, window, cx)` 做出 `Entity<Relations>`，放在要素页的页尾、「字段」下面（`Fields` 的 `last` 改成 `false`）。它自己从 `ws` 读书快照、从 `Services` 拿库，别的不用传；节头（「关联」、条数、「编辑类型」「＋ 关联实体」）和「字段」同一个样式，排在正文那一栏里。
2. 要素页的页尾现在只有 `Fields` 一个视图，要改成 `Fields` 和 `Relations` 上下两个；`end_estimate` 大约多 200。
3. 类型管理从「编辑类型」浮出来，删除的确认走 `dr_shell::dialogs::show_in`，要素页都不用管。
4. M11 计划里的「关联（ReferencesPanel 的关联节、关联选择器）」就是这一块，不用再写一遍；「被引用 / 引用其他」两节还是 M11 / M20 的。

这些也写进了共享笔记（`m17-relations-hooks.md`），由监管会话转给 M11。

## 文案

全部是旧版九种语言里现成的，`dr-i18n/keys.txt` 加了 52 行：51 个键一个个列出，`relationTypes.entityKinds.*` 一组 7 个（用到的旧键 `common.cancel`、`storyGraph.edge.create`、`referencesPanel.kind.patch`、`relationTypes.description` 原来就有）：

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

## 待协调

1. **F3：`relation.update`**。改一条关系的类型或掉头，现在是先建后删（撤销两步、id 变了）。要一个 `relation.update { id, relation_type?, swap? }`，一步、id 不变；有了以后 `data::replace` 改成调它。
2. **F3：改类型的方向和允许种类**。旧版能改（会逐条检查已有关系，不合规矩的拒绝）。F3 的 `relation_type.update` 没有这几项，编辑器里灰着。
3. **F3：内建类型的颜色**。旧版的颜色是本机偏好，内建类型也能换色；新版颜色在类型里，F3 把内建类型整个锁住，连颜色也不能改。要不要放开颜色，F3 定。
4. **F5（dr-ui）**：悬停提示（垃圾桶为什么灰、色条、⇄、卡片名字）；`Chip` 加记号（类型编辑器的种类）。
5. **M11**：把这一节挂到要素页「字段」下面，见「外壳要接的」。
6. **M18 / M19**：批注、待办、素材卡片上的一键关联（旧版 `EntityRelationPicker`，用内建的「关联」类型）这一轮没做，等那两张卡片做出来时可以用这里的选择器和 `data::create`（F3 的 `relation.create` 对批注和素材省略类型时自动用内建类型）。

## 没做的

- 要素页里的挂接（见上），所以还不能在真窗口里点；
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
