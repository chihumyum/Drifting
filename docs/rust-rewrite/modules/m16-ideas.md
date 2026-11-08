# M16 构想面板

2026-11-08，第一个里程碑；第二十三批补原面板的真实窗口验收。计划见 [modules.md 的 M16](../modules.md#阶段-3故事工坊)。界面在 `next/crates/dr-view-ideas/`，读外壳的书快照（`Book::ideas`、`Book::idea_groups`），写全走 F3 的 `idea.*` 和 `idea_group.*`（`next/crates/dr-workspace/src/commands/idea.rs`）。对照的旧版是桌面端 `src/renderer/components/leftBars/DriftPanel.tsx`、`LeftSidebarSubHeader.tsx` 里构想那一半、`usecase/useDriftGroup.ts`、`domain/drift-group.ts`，以及 `EditorTopBar.tsx` 里构想的菜单项。截图在 [m16/](m16/)。

## 做了什么（大白话）

1. **左栏「构想」标签有了自己的面板。** 原来外壳在这里只画一张平的列表，现在换成 M16 的面板（外壳的 `add_left_panel`，和 M11 的要素面板一样挂法）。
2. **分组可以嵌套两层**（F3 的规矩，旧版也是两层）。
   - 顶层分组的头：折叠箭头、分组颜色的文件夹、名字、「· N」（它和子分组里的构想一共几条）；指针移上去，右边出现「新建子分组」和「在此新建构想」。
   - 子分组的头更素一点：小箭头、名字、「· N」，指针移上去出现「＋」。
   - 单击分组头折叠或展开，双击就地改名（回车或离开存下；清空了名字就还叫「新分组」，和旧版一样；Esc 放弃）。
   - 指针停在分组头上，旁边出卡片：新建子分组（只有顶层分组有）、在此新建构想、重命名、移动到分组（只列层数放得下的地方，一个都没有时这一节不出现）、删除分组。删除分组时，它的子分组和构想往上挪一层，不丢东西，⌘Z 能撤回（F3 的做法，旧版也不问）。
3. **构想一行一条。** 前面是小漩涡，颜色跟着分组（不在分组里时淡一些）；标题（空的写「未命名」）；右边是日期或字数，面板窄于 200 时不显示。分组里先列子分组，再列它自己的构想；不在任何分组里的构想排在所有分组后面。单击预览，双击固定成标签。指针停在上面出外壳的页面卡片（和章节面板的一样），多了一节「移动到分组…」（书里有分组时才有）。
4. **休息的构想。** 旧版早先有一个单独的「休息抽屉」，后来并进了列表：休息的构想留在原来的位置，只是变淡（`DriftPanel.tsx` 里写着 resting drifts aren't bucketed into a separate drawer anymore）。新版照现在的旧版做：留在原处，变淡（70%）。
5. **面板头**：「N 条构想」、展开／折叠全部（一下全折，再一下全开）、排序菜单、新建分组、新构想。
   - 排序菜单两节：「排序构想」按创建时间（默认，新的在前）、按更新时间、按标题字母（数字按大小）；「单元格右侧」显示日期（默认）、显示字数、显示字数和日期、都不显示。
   - 「新构想」建一条叫「新构想」的构想，马上作为固定标签打开；分组头上的「在此新建构想」建在那个分组里并展开它。
   - 「新建分组」建一个叫「新分组」的顶层分组。
6. **构想页的 ⋯ 菜单**（也就是侧栏卡片里的那几行）加了：「构想状态」漂流 / 休息（打勾的是当前的）、「移动到分组…」、「删除节点」（进回收站）。

**要作者定的事：没有。** 和旧版不一样的地方列在「和旧版的差别」。

## 规则（定稿）

- **树怎么搭**：分组按 F3 列出的顺序（父在前），每个分组下面先子分组、再构想。父分组不见了、自己是自己的父、或者嵌得比两层还深的分组，放到顶层；分组不见了的构想放到「不在分组里」那一段——作者写的东西不能藏在一个画不出来的地方（旧版同样的防护）。回收站里的构想不列。
- **能不能移**：分组不能移进自己或自己的子分组；移过去以后的层数（目标所在层 + 自己连子分组的层数）不能超过两层，和 F3 的检查一样，所以卡片里不会出现会被拒的选项。构想可以移进任何分组。
- **数字**：分组头上的「· N」和卡片里的「N 条构想」都包括子分组里的。
- **日期和字数**：每条构想正文最后一次存的时间（dr-store 的 `head`）和字数（`doc_stats`），书快照一变就在后台重读一遍；读到之前字数写「统计中…」。
- **折叠、排序、单元格右侧**：只在这次打开里记住，不存（旧版折叠也不存；排序和单元格右侧旧版存在侧栏偏好里，见待协调 2）。
- **写**：都在后台线程交给 F3，作者的身份；F3 的事件让外壳换新的书快照，面板跟着画。

## 和旧版的差别

| 旧版 | 新版 | 为什么 |
| --- | --- | --- |
| 排序方式、单元格右侧存在侧栏偏好里（每个侧栏半边一份） | 只在这次打开里记住 | F6 已有 `book_memory`，M16 还没接上（待协调 2） |
| 分组头、按钮有悬停说明（「单击折叠 · 双击重命名」「在此新建构想」） | 按钮有读屏名字，没有悬停说明 | dr-ui 还没有悬停提示 |
| 构想格子上有帮手（Agent）改动的 A / M 标记、正在改时漩涡转动 | 没有 | 帮手的改动标记是 Agent 模块的事，等它有了统一的「最近改过」接口再接 |
| 构想菜单里有「转成章节…」「转成要素…」 | 没有 | 计划里的下一步（见「没做的」） |
| 手机端的同一个面板 | 只有桌面端 | 这一轮只做桌面 |

## 文案

全部是旧版九种语言里现成的，`dr-i18n/keys.txt` 加了 15 个键：

| 用在哪 | 键 | 中文 |
| --- | --- | --- |
| 面板头 | `leftSidebar.actions.newDrift`、`newDriftGroup`；原有的 `meta.drifts`、`actions.collapseAll`、`actions.sort` | 新构想、新建分组；{{count}} 条构想、展开／折叠全部、排序 |
| 排序菜单 | `leftSidebar.sort.drifts`、`sort.title`；原有的 `sort.createdAt`、`updatedAt`、`cellMetaGroup`、`showDate`、`showWordCount`、`showBoth`、`showNone` | 排序构想、按标题字母；按创建时间…… |
| 分组 | `leftSidebar.groups.newDriftInGroup`、`newSubGroup`、`rename`、`deleteGroup`、`moveGroupToRoot`、`moveDriftToRoot`、`driftCount` | 在此新建构想、新建子分组、重命名、删除分组、根层级（移到顶层）、根层级（移出分组）、{{count}} 条构想 |
| 构想菜单 | `editorTopBar.statusSection.drift`、`status.drifting`、`status.resting`、`menu.moveToGroup`；原有的 `menu.deleteNode` | 构想状态、漂流、休息、移动到分组…、删除节点 |
| 空的时候 | 原有的 `leftSidebar.empty.noDrifts` | 还没有构想。 |

新分组的名字「新分组」在旧版就是代码里的常量、不随语言变（`DEFAULT_DRIFT_GROUP_NAME`），这里照旧。

## 截图

`cargo run -p dr-view-ideas --features capture --example ideas-capture -- ../docs/rust-rewrite/modules`：GPUI 离屏画，300 × 560（侧栏的宽度），书是《阿Q正传》，经 F3 加了「结构」（下面一个子分组「细节」）和「别处」两个分组，两条构想放进分组，一条休息。

| | 浅色 | 深色 |
| --- | --- | --- |
| 面板 | [ideas-panel-light](m16/ideas-panel-light.png) | [ideas-panel-dark](m16/ideas-panel-dark.png) |
| 「结构」的卡片 | [ideas-group-card-light](m16/ideas-group-card-light.png) | [ideas-group-card-dark](m16/ideas-group-card-dark.png) |
| 排序菜单 | [ideas-sort-light](m16/ideas-sort-light.png) | [ideas-sort-dark](m16/ideas-sort-dark.png) |
| 就地改名「别处」 | [ideas-rename-light](m16/ideas-rename-light.png) | [ideas-rename-dark](m16/ideas-rename-dark.png) |
| 全部折起 | [ideas-folded-light](m16/ideas-folded-light.png) | [ideas-folded-dark](m16/ideas-folded-dark.png) |

## 测试

在 `next/` 下：

```bash
cargo test -p dr-view-ideas --locked
cargo clippy -p dr-view-ideas --all-targets --features capture --locked -- -D warnings
cargo build -p drifting --features debug-bridge --locked
cargo drifting workspace scenario crates/dr-cli/scenarios/ideas.json --app target/debug/drifting --yes
```

| 测试 | 内容 |
| --- | --- |
| 单元测试（4，`model.rs`） | 树嵌两层，父不见了、嵌太深、自己是自己父的分组到顶层，分组不见了的构想到「不在分组里」，数字算上子分组；按创建、更新、标题排序（数字按大小）；分组能移到哪里（两层的分组不能进别的分组，不能进自己的子分组）、谁能有子分组、「父 / 子」的写法；字数的短写 |
| `tests/ideas.rs`（3） | GPUI 测试平台，F3 经 dr-store 的真库，书是《阿Q正传》，外壳的工作区窗口打开书：「新构想」建出「新构想」并作为标签打开；「新建分组」「新建子分组」，子分组下不能再建；在子分组里新建构想；构想移进分组和子分组后树对、数字对；就地改名（打字、回车）存进 F3；分组移到放得下的地方、放不下的不动；删除分组后它的构想和子分组上移；全部折起再全部展开；按标题排序；构想的 ⋯ 行：漂流打勾，点「休息」后 F3 里是 resting、面板里还在，有分组后多出「移动到分组」并能移进去，「删除节点」后进了回收站 |

第二十三批在隔离的临时 profile 上重跑 `ideas.json`：**54 步、0 pending**。原 53 步之外增加了移动目标的唯一性断言，确认共享菜单不再重复列出同一分组；菜单动作带有 `MenuItem` 角色和名字。场景覆盖分组创建／改名／嵌套、构想移动／休息、删除分组后的上移，并从 F3 读回核对。排序部分只验证选择入口和菜单收起，排序结果仍由单元测试验证；本轮是真窗口英文浅色模式，不代表完整读屏、键盘或九语言布局验收。已检查构想卡片和删除后的截图；英文的根层级长标签仍超出卡片右边界，交 dr-ui／旧模块收尾处理，不是本次去重引入。

## 待协调

1. **F6**：外壳原来给「构想」标签画的平列表（`sidebar.rs` 的 `LeftTab::Drifts`）现在被这个面板盖过；外壳那段可以删掉（外壳的事，这里没动）。
2. **M16／旧模块收尾**：F6 的 `book_memory` 已有存放接口；侧栏偏好（排序方式、单元格右侧，旧版每个侧栏半边一份）接上它，可以和要素面板的排序一起做（M11 也只在打开期间记住）。
3. **F5（dr-ui）／旧模块收尾**：悬停提示；`CardAction` 的长标签要受卡片宽度约束（真窗口英文 “Root level (move out of group)” 已观察到越出右边界）。

## 没做的

- 构想转成章节、转成要素（旧版「转成章节…」「转成要素…」）；绑到幕或时间钉（`DriftBindModal`）；故事图和要素全景里的浮动构想托盘（`components/DriftPanel.tsx`，M21 / M22 的事）；
- 帮手改动的 A / M 标记；
- 拖动构想进分组（旧版也没有，靠「移动到分组」）；
- 原面板的真窗口场景见上面的验收命令；读屏及完整键盘路径仍待验收；
- 手机端。

## 代码位置

`next/crates/dr-view-ideas/`：

| 文件 | 内容 |
| --- | --- |
| `src/lib.rs` | 模块说明、`init`（左栏面板、构想的 ⋯ 行）、`make_panel`、`panels` |
| `src/model.rs` | 不依赖 GPUI 的部分：树、排序、分组能移到哪里、写法 |
| `src/data.rs` | 调 F3：建构想、移构想、改状态、删构想、建 / 改名 / 移 / 删分组 |
| `src/panel.rs` | `IdeaPanel`（列表、分组头和卡片、构想行、就地改名）、`PanelHead`（面板头、排序菜单） |
| `src/menu.rs` | 构想页 ⋯ 菜单加的几行 |
| `tests/ideas.rs` | GPUI 测试 |
| `examples/ideas-capture.rs` | 截图 |
