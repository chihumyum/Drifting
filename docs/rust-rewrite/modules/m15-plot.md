# M15 情节规划

2026-11-08，第一个里程碑；同日第二轮：手调的宽高比按表存在本机；旧模块收尾第三轮：从表格软件粘贴一块铺开（`codex/legacy-m15-paste`）；第四轮：窄格中的行尾标点完整换行（`codex/legacy-m15-details`）。计划见 [modules.md 的 M15](../modules.md#阶段-3故事工坊)。界面在 `next/crates/dr-view-plot/`，数据全走 F3 的 8 条 `plot_grid.*` 命令（`next/crates/dr-workspace/src/commands/plot_grid.rs`）。对照的旧版是桌面端的 `src/renderer/components/editor/PlotGrid.tsx`、`PlotPlannerDock.tsx`、`plot-grid/plot-grid-layout.ts`、`src/styles/plot-planner.css`。截图在 [m15/](m15/)。

## 做了什么（大白话）

1. **每章一张格子表。** 左边一条条泳道（行），上面一列列标题（列），每个格子是一张小纸条，点进去直接写，可以换行。表头的名字也是点进去直接改，回车或 Esc 离开。
2. **表头菜单。** 指针移到表头上，右端出现「⋯」，点开是：重命名；上移、下移（列是左移、右移）；在上方 / 下方插入一行（列是左侧 / 右侧）；删除此行 / 此列。删除时如果这一行有字，菜单里写「会清空 N 格」；最后一行、最后一列删不掉。
3. **面板头上的按钮。** 章节的记号和标题、「情节」，右边「＋ 行」「＋ 列」（加在最后，并滚到它那里）、「适应」（把格子调到整张表正好铺满面板）、「清空」（先问一句，确认后清掉所有标题和格子里的字，行列和大小不动）。
4. **格子可以拉大拉小。** 表的右下角有个把手，拖动时所有格子一起变，左上角实时显示「宽 × 高」，松手才存。范围 120–440 × 56–380。手动拖过以后，「适应」会保持这个宽高比只做缩放（和旧版一样）；这个比例按表记在这台电脑上，关掉再开、换章再回来都还在，不跟着同步走。表格不会被挤小：行列多了就滚动。
5. **还没有表的章节**，显示一张空的 3 × 3；作者第一次改动时才存进书里（F3 的 `plot_grid.create`），存之前打的字、加的列都不会丢。
6. **别处的改动会显示出来。** 另一个窗口、帮手（Agent）改了这张表，F3 发出事件，表格重新读一遍；正在打字、还没存的那个格子保留作者打的字。
7. **从表格软件粘贴一块。** 在格子里粘贴包含制表符或换行的文字，从当前格子起按行列铺开；超出表的右边、下边就加空标题的列、行。空的剪贴板格会清掉对应格子，短行之外的格子保持原样。只多出来的最后一个换行不算新行，CRLF 和 CR 与旧版一样归成换行。没有制表符和换行的纯文字仍在光标处插入或替换选区。

**要作者定的事：没有。** 和旧版不一样的地方列在「和旧版的差别」，要外壳配合的在「外壳要接的」。

### 第四轮：窄格中的行尾标点

真实窗口先复现了原问题：120 像素格宽、原 12.5 像素界面字体，样书《阿Q正传》的「你算是什么东西！”」在 F3 中仍完整，画面却裁掉最后一个右引号。用旧 `PlotGrid.tsx` 的格子结构及 `plot-planner.css` 原样式，在 macOS WebKit 中加载同一构建字形；截图及逐字符矩形确认旧版把「西！”」一起放到第二行，两个标点都可见。这个隔离排版核对针对旧 CSS，不冒充整套旧应用验收。基线截图和隔离核对在本机 `next/target/acceptance/legacy-m15-punctuation-before/`。

F5 增加可选的 `TextArea::wrap_punctuation()`，只有情节格子启用。底层 `prose-linebreak::Overflow::Wrap` 遇到放不下的行尾标点时退到前一个合法断点，把前一个字和标点一同移到下一行，不压缩字形；没有合法断点的不可拆段仍保留整体。测量、绘制、光标及选区共用相同的断行结果。默认多行框、界面只读文字和正文仍用原来的悬挂规则，打印的压缩规则也不变。格子删去原来为悬挂标点预留的额外 4 像素，恢复旧格子内容宽度。

本轮从已提交的 M17 分支继续，吸收 `main` 的 `f4853f33`。悬停提示、关闭动画中的旧表保留等仍未完成，不能据本轮宣布 M15 完成。

## 规则（定稿）

- **写入顺序**：作者的每个动作先改界面上的表（马上看到），再按先后顺序排队，在后台线程依次交给 F3。打字在最后一个键 400 毫秒后存（旧版 `PERSIST_DEBOUNCE_MS`），离开格子时立刻存；结构上的动作（插入、移动、删除、清空、改大小）之前先把打的字存掉，保证顺序。
- **没存过的表**：空表的行列先用临时 id（`~r0`…`~c2`）。第一批写入先跑 `plot_grid.create`，按位置把临时 id 换成 F3 给的 id，再写其余的；之后排队的写入、打的字、各个输入框都跟着换。F1/F3 已把默认行列的 id 变成确定的（`create_plot_grid` 写种子），这套按位置对应的做法不变。
- **新行新列的 id** 由界面生成（`PlotRowId::new_v7`），连同「放在谁后面」交给 `plot_grid.line_add`，所以不用等 F3 回话就能画出来、接着在里面打字。
- **重新读**：F3 的 `Book` 事件里有这张表（`PlotGrids` 集合、这个节点）时重新读；作者还有没交出去的写入时，等写完再读。读回来以后，正在输入的格子和还有没存的字的格子不被覆盖。
- **F3 拒绝的写入**（比如另一台设备刚删了那一行）：记日志，再读一遍，以书里的为准。
- **行表头的宽度**：按最宽的标签量（空的按「行」量），52–220 像素，再长就换行；列标题最多两行，行标题最多三行。
- **适应**：用面板正文的大小算（`model::fit`，和旧版的 `fitPlotGridCellSize` 同一套），算完存进 `plot_grid.size`。
- **手调的宽高比**：拖把手（或别处「按手调」改大小）时记下宽 ÷ 高，「适应」照它缩放；存在 F2 的 `local_state`（作用域 `plot`、键 `ratio:<节点>`、挂在书下），后台写、不等它落地，面板换章时也不会丢。打开时在后台读；读回来之前作者已经手调过的话，以手调的为准。
- **块粘贴**：旧版 `PlotGrid.tsx` 的 `handlePaste` / `pasteBlock` 是行为依据。先交出尚未保存的输入，再依次排新增行列、格子写入；在空表里第一次粘贴也走原来的临时 id 认领。当前输入框会立即换成第一格的文字，不被「保护焦点里的字」挡住。沿用 `plot_grid.line_add` / `plot_grid.cell` 的撤销粒度，未新增整块原子写入或撤销命令。

## 和旧版的差别

| 旧版 | 新版 | 为什么 |
| --- | --- | --- |
| 菜单里的上移用「下箭头转 180°」，在上方插入用镜像过的图标 | 上移、下移、左移、右移用四个方向的 V 形箭头；插入上方和下方用同一个图标 | dr-ui 的菜单行不能旋转或镜像图标（待协调 2） |
| 按钮和「⋯」悬停有说明（「添加一行」「适应窗口：…」「表头菜单」「拖拽调整格子大小与比例」） | 没有 | dr-ui 还没有悬停提示（待协调 2） |
| 清空的确认：「…此操作无法撤销。」 | 照搬 | F3 记了反操作，但界面上还没有对象级撤销，对作者来说确实撤销不了 |
| 手机端的格子表、横竖转置 | 不做 | 这一轮只做桌面端；转置只在手机端用 |

先前把「已经铺满时适应变淡」列成缺口，是对旧 CSS 的推断过头。旧 `.planner-wrap[data-fitted='true'] .plot-planner__fit` 选择器只匹配内部后代，桌面 `PlotPlannerDock` 的按钮实际在同级 `BottomPanelHeader`，没有命中，也没有禁用逻辑。新版保留已经实现的一次性适应及手调比例，不新增变淡或禁用行为。

## 外壳要接的（给 F6）

**F6 第八轮接上了**：底部面板和工具托盘里的开关在外壳（`pages::add_bottom_panel`），`dr_view_plot::init` 把情节规划登记进去（按前面的章节或构想做一个，改名时 `set_title`；这个 `init` 是 F6 写的），应用里调用。下面是当时提的要求，留作对照。

旧版的情节规划放在稿纸下面的底部面板里，和底部时间线（M14）轮流用一块地方。新外壳还没有这块面板，所以这一轮 dr-view-plot 只提供视图，挂到哪里由外壳决定。要的是：

1. **稿纸下面的底部面板**，和 M14 的时间线共用（一次只显示一个），高度和上沿拖动把手两者共用，滑出滑入。打开情节规划时时间线收起，反过来也一样（旧版 `ui-store` 的 `plotPlannerOpen` / `bottomTimelineHidden`）。
2. **开关**：稿纸工具栏上一个按钮，旧版文案 `editorTopBar.actions.expandPlotPlanner`「展开情节规划」/ `collapsePlotPlanner`「收起情节规划」；开着与否跟布局一起存。
3. **跟着前面那一章走**：只在章节或构想（`Target::Chapter` / `Target::Idea`）在前面时显示；切到别的页面时面板收起，回到章节时再出来，作者的选择保留。沉浸写作时不显示。
4. **怎么做出来**：`dr_view_plot::planner(PlannerHost { library, book, node, title, mark, color }, window, cx)`，得到 `Entity<PlotPlanner>`，按节点换新的；章节改名时调 `set_title`。`mark` 和 `color` 用外壳 `Book::mark(&target)` 给的。
5. **清空的确认**是 `dr_shell::dialogs::show_in` 弹的对话框，外壳不用管。
6. 拖动格子大小用的是窗口级的鼠标事件，指针拖出面板也跟着走。

这些也写进了共享笔记，由监管会话转给 F6。

## 文案

全部是旧版九种语言里现成的，`dr-i18n/keys.txt` 加了 22 个键（`plotGrid.*`）：

| 用在哪 | 键 | 中文 |
| --- | --- | --- |
| 面板标签 | `plotGrid.title` | 情节 |
| 按钮 | `plotGrid.addRowShort`、`addColumnShort`、`fit`、`clear` | 行、列、适应、清空 |
| 空标签、空格子 | `plotGrid.rowPlaceholder`、`columnPlaceholder`、`emptyCell` | 行、列、写点什么… |
| 表头菜单 | `plotGrid.rename`、`moveUp`、`moveDown`、`moveLeft`、`moveRight`、`insertRowAbove`、`insertRowBelow`、`insertColumnLeft`、`insertColumnRight`、`deleteRow`、`deleteColumn` | 重命名、上移、下移、左移、右移、在上方插入一行、在下方插入一行、在左侧插入一列、在右侧插入一列、删除此行、删除此列 |
| 删除时清掉几格 | `plotGrid.deleteClears` | 会清空 {{count}} 格 |
| 清空的确认 | `plotGrid.clearTitle`、`clearConfirm`；按钮 `common.cancel` | 清空情节规划器内容；清空当前情节规划器的所有行列标题和单元格文字？…；取消 |
| 没有标题的章节 | `common.untitled` | 未命名 |

## 截图

`cargo run -p dr-view-plot --features capture --example plot-capture -- ../docs/rust-rewrite/modules`：GPUI 离屏画（真的 macOS 排字和 Metal），1100 × 380（底部面板的大小），书是 dr-testkit 的《阿Q正传》，第四章有一张 4 × 4 的表，第一章没有。外壳还没有底部面板，所以截的是面板本身。

| | 浅色 | 深色 |
| --- | --- | --- |
| 第四章的表 | [plot-grid-light](m15/plot-grid-light.png) | [plot-grid-dark](m15/plot-grid-dark.png) |
| 光标在一个空格子里（选中的玻璃、「写点什么…」） | [plot-slip-light](m15/plot-slip-light.png) | [plot-slip-dark](m15/plot-slip-dark.png) |
| 「吴妈」的表头菜单（会清空 3 格） | [plot-menu-light](m15/plot-menu-light.png) | [plot-menu-dark](m15/plot-menu-dark.png) |
| 拖右下角把手（左上角的实时尺寸） | [plot-resize-light](m15/plot-resize-light.png) | [plot-resize-dark](m15/plot-resize-dark.png) |
| 清空的确认 | [plot-clear-light](m15/plot-clear-light.png) | [plot-clear-dark](m15/plot-clear-dark.png) |
| 还没有表的第一章 | [plot-empty-light](m15/plot-empty-light.png) | [plot-empty-dark](m15/plot-empty-dark.png) |

截图的窗口只有 380 高，表头菜单在「⋯」上下都放不下，所以压在那一行上；放进真的底部面板后有更多地方。

## 测试

在 `next/` 下：

```bash
cargo test -p dr-view-plot --locked
cargo clippy -p dr-view-plot --all-targets --features capture --locked -- -D warnings
```

| 测试 | 内容 |
| --- | --- |
| 单元测试（5，`model.rs`） | 空表是 3 × 3、默认大小；行列的插入、移动、删除连同格子，最后一列删不掉，清空；临时 id 按位置换成存下的 id；大小限在 F3 的范围内、行表头宽度、拖把手时每像素分给几格；「适应」铺满面板，手调的宽高比接近时整张装下、差得远时只铺满短的一边 |
| `tests/plot.rs`（11） | GPUI 测试平台，F3 经 dr-store 的真库，书是《阿Q正传》：读出第四章的四条泳道、四列和格子；在空格子里打字，400 毫秒后存进书里，和打的一样；在上方插入一行、最后一行下移不动、上移、重命名（选中后打字、回车）、在右侧插入一列、删除带两格字的一列，每一步都按顺序到了 F3，最后一列删不掉；没有表的第一章，存之前在格子里打字再加一列，存下的表是 3 × 4、字在对的格子里、界面换成了存下的 id、之后接着在同一个格子里打字也存对了；拖把手（4 行 4 列时每 4 像素 1 格）、拖过头停在最大值、松手才存；清空后行列和大小不变；帮手写了另一个格子时界面显示出来，作者正在打的格子不被覆盖、两边都存进书里；在工作区窗口里按清空，问题成了窗口的对话框，Esc 关掉它、表里什么都没清；手调成 3 : 1 以后，本机记下这张表的比例（挂在这本书下）、「适应」不改它，同一章再打开时读回 3 : 1，别的章没有；外壳切换前台章节时换上对应的表。第三轮新增两项见下。 |

第三轮新增的两项都把文字写入测试平台剪贴板，按实际粘贴快捷键，不直接调用粘贴函数：

- `spreadsheet_paste_grows_both_axes_and_replaces_the_focused_slip`：已有表从右下角粘贴，行列都长大；CRLF、末尾换行、空格清除、短行和未涉及格子的保留；先前还在 400 ms 暂存期的输入不会盖回去，焦点所在格子也立即更新。
- `spreadsheet_paste_is_the_first_edit_and_plain_paste_still_inserts`：第一次粘贴建表，临时 id 认领后继续普通粘贴和再次块粘贴；普通文字仍按光标和选区插入，连续两个尾换行只去掉最后一个。

真窗口场景在 `next/crates/dr-cli/scenarios/plot-paste.json`：用 showcase 的章名和要素名组成两行四列，先在格子内全选复制，再粘回原格；从 F3 读回行列和格子坐标核验。命令：`cargo drifting workspace scenario crates/dr-cli/scenarios/plot-paste.json --app target/debug/drifting --yes`（先构建带 `debug-bridge` 的开发应用；场景自己使用临时库和配置）。

第三轮在 `main` 的 `f5ca535b` 基线上验收：真窗口场景 27 步全部通过；点「适应」后四列都可见，截图核对两行八格，结束时退出临时应用。截图和场景结果在本机 `next/target/acceptance/legacy-m15-paste/`，不作为手改证据提交。这一轮补完块粘贴，不代表 M15 全部完成，下面的剩余项继续保留。

第三轮检查全部通过：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`、`cargo xtask check`（含 audit）、`pnpm public:check` 和 `pnpm ci:contract:check`。旧版其余 TypeScript 检查由整合会话跑共同基线；本轮没有修改旧版代码。

第四轮新增四项契约：`prose-linebreak` 对两个尾标点回退、保留字宽及默认悬挂不变，另验 Latin 单词、开引号、emoji 字形簇、强制换行及无合法断点时终止；`dr-ui/tests/area.rs` 验证选项默认关闭、启用后的高度与 Home/End/上下移动；`dr-view-plot/tests/plot.rs` 用样书原有格子内容反复缩窄／放宽，核对行数变化且内存及 F3 原文不变。

真窗口场景 `next/crates/dr-cli/scenarios/plot-punctuation.json` 在 120 像素格宽下核对浅色、深色重开后的完整原文、存储尺寸与两张截图；重开后明确打开原作品和章节，不改变外壳现有启动行为。最终 37 步全部通过（0 pending），两张截图已目检，均把「西！”」完整放在第二行；两次 `app.quit` 均正常退出。结果及截图在本机 `next/target/acceptance/legacy-m15-punctuation/`，不提交生成 JSON。断行 9 项、多行输入 8 项、情节规划 11 项定向测试通过。第四轮以 `main` 的 `f4853f33` 为基线（本分支另含尚待整合复审的 M17 提交），`cargo fmt --all --check`、全工作区 Clippy、全工作区测试（1747 通过、0 失败、22 忽略）、`cargo xtask check`（含 audit，0 漏洞）、`pnpm public:check`（5258 个候选文件）与 `pnpm ci:contract:check`（659 个测试文件）全部通过。旧版其余检查由整合会话跑共同基线。本轮只交窄格换行及相关文档，不代表 M15 或祖先 M17 已接收。

## 待协调

1. ~~**F6：底部面板和开关**~~：F6 第八轮做了，见上面「外壳要接的」。
2. **F5（dr-ui）**：
   - 菜单行的图标能旋转、镜像（旧版的上移、在上方插入）；
   - 悬停提示（按钮、「⋯」、把手的说明，旧版都有）；
   - ~~输入框的「粘贴前」钩子~~：第三轮在格子容器捕获既有 `Paste` 动作完成，不必改共享输入框；
   - ~~窄格的两个行尾标点被裁切~~：第四轮增加 `TextArea::wrap_punctuation()`，仅格子启用。
3. ~~F6：本机偏好存哪里~~（第二轮已做：存进 F2 的 `local_state`，作用域 `plot`、键 `ratio:<章节或构想>`，挂在书下，彻底删书时一起删；没有同步，和旧版的 localStorage 一样每台设备各自记）。F6 第八轮另给了按书存在设置文件里的 `Workspace::book_memory`；**F6 第九轮收成一处：`book_memory` 也搬进了 `local_state`**（理由见 f6-shell.md「第九轮」），这边不用改。
4. ~~**F1：默认行列的确定 id**~~：已在 `main`，`dr-workspace/tests/workshop.rs` 覆盖两台设备各自第一次编辑、合并后默认行列相同且两边的字都保留；界面的临时 id 按位置对应，不需要另建基座接口。
5. **F3**：界面上还没有对象级撤销（⌘Z 在格子外面时）。F3 的 `plot_grid.*` 都记了反操作，接上以后清空的确认可以去掉「此操作无法撤销」（要换文案）。

## 没做的

- ~~外壳里的挂接~~（F6 第八轮接上了，真窗口里能点）；
- 悬停提示；
- 视图释放后的写入排空：当前 `planner.rs::pump` 的后续队列只由视图的 `written()` 继续推进，视图释放后不会再推进；旧 `PlotPlannerDock.tsx` 的卸载清理会 `flush`，已接受的 promise 链继续写原节点。下一轮补首建表临时 id、修改／删除／块粘贴排队、切书及失败边界契约后修。400 ms 暂存文字在普通切章时可能先收到失焦事件，直接关窗／释放是否漏存仍需专门复现。
- 离开章节时留一张静止的旧表随面板滑走（旧版的 ghost）：旧 `plot-planner-slot.ts::leavePlotPlannerGhost` 保留滚动位置并设为 inert。当前 `dr-shell/src/workspace/bottom.rs::panel` 在关闭动画中仍调用按当前导航重建的 `bottom_panel`；切到主页／要素等目标时，新 maker 返回 `None` 并覆盖旧 Planner 缓存，旧表提前消失。需要 F6/M31 协调的最小接点是关闭期间复用旧缓存、屏蔽交互并保留滚动，直到关闭完或新 Planner 接管。本轮不改共享外壳。章节 A → B 等待异步新表时是否还闪空，仍需另做窗口验收；
- 手机端和转置。

## 代码位置

`next/crates/dr-view-plot/`：

| 文件 | 内容 |
| --- | --- |
| `src/lib.rs` | 模块说明、`planner()` |
| `src/model.rs` | 界面上的表（`Grid`）、改动、临时 id 的对应，尺寸规则（限幅、行表头宽度、适应、拖把手） |
| `src/planner.rs` | `PlotPlanner` 视图：读和重新读、输入框、写入队列、作者的动作、本机记的宽高比（`RATIO_SCOPE`、`ratio_key`）、画面板头、表头、格子、把手、表头菜单；`ClearDialog` |
| `tests/plot.rs` | GPUI 测试 |
| `examples/plot-capture.rs` | 截图 |
