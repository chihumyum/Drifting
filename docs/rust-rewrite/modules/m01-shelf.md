# M01 书架（基础）

2026-11-08，第一个里程碑，分支 `chihumyum/m01-shelf-home-3bf938`（从 main `07964df6` 开工）。计划见 [modules.md 的 M01](../modules.md#阶段-2写作闭环)。代码在 `next/crates/dr-view-shelf/`，外壳里的接入点在 `next/crates/dr-shell/src/pages.rs`。作品主页（M02）在同一个分支上，见 [m02-home.md](m02-home.md)。

## 一句话

新版打开就是书架了：左边一条栏，右边是本机库里的书。点一本书进入它的工作区，⇧⌘W 或红灯回到书架。可以新建、改名、移到最近删除、从最近删除恢复。封面、热力图、近 30 天的砂笔小图、字海是阶段 4（M24、M25）的事，这一轮书架底下是平的桌面色。

## 做了什么（大白话）

1. **启动先到书架。** 窗口一打开盖着整个窗口的是书架，书还没读。点一本书，外壳换上这本书上次的标签、侧栏（第一次打开就是作品主页）。⇧⌘W（关闭项目）和红灯回到书架；在书架上按红灯照旧关窗口。开发期 `DRIFTING_BOOK=<书的 id>` 仍然直接打开那本书、不经书架。
2. **左栏**（232 px，照旧版 `ShelfRail`）：结构字的「书架」，下面一行等宽小字「8 本 · 70.3万字」；栏底依次是「导入书 .driftingbook」「导入 Drifting 0.1」「最近删除」（有删除的书时行尾是数量）三个格子，平时不垫底，指针下一圈玻璃；最下面是账号格子（头像、「本地」）和通知铃铛。铃铛打开的就是外壳的通知中心，从铃铛往上弹出。
3. **书卡**：两列，窗口窄于 1080 px 时一列。每张卡是一圈静止细玻璃线（悬停流动，按下加深），上面依次是：
   - 书名（正文字体）、副标题（项目设定里的「副标题」，和旧版一样按这个键名找）；
   - 两行梗概；
   - 等宽的字数 / 章 / 故事线 / 要素；
   - 有全书目标时一行「进度　52% · 目标 12万 字」和一笔墨色砂笔读数；
   - 最后一行是等宽的状态字（一周内编辑过「在写」、一月内「草稿」、更久「搁置」，越久越淡）和「3 天前」。
   整张卡打开这本书；编辑、移到最近删除是两枚只在悬停时出现的平面砂笔图标按钮。没有右键菜单。
4. **新建一本**：网格末尾的「新建一本 · 从一张白纸开始」，或者在空桌面上双击。对话框是书名、梗概两个输入框，取消是文字按钮、新建是主按钮；在任一个框里按回车就新建。新建后直接打开这本书。名字空着时叫「未命名」。
5. **编辑**：同一个对话框，带着原来的书名和梗概，保存后留在书架上。
6. **移到最近删除**：先问一句（书名、字数、章数、要素数，旧版的原话），取消在前、危险按钮「移到最近删除」在后，焦点在书架上，Esc 关掉。
7. **最近删除**：左栏的「最近删除」打开一个对话框，每本一行，带次按钮「恢复」。
8. **账户菜单**：点账号格子往上展开：头像和「本地 · 本机存储」，然后是主题（明 / 暗 / 系统，多选一）、语言（九种界面语言的本名，下拉选择）、设定（打开外壳的设置）。
9. **数字从哪来**：
   - 书、章、故事线、要素、梗概、目标、副标题：F3 的查询（`book.list`、`book.get`、`chapter.list`、`storyline.list`、`fact.list`）。
   - 字数：只算活着的章节，取派生索引里每章的字数（dr-index 按 dr-text 的规则算），和旧版书架一样不算构想、要素、素材笔记。
   - 最近编辑：这本书所有文档里最新一次存进 dr-store 的时间（`loro_head.ts`）。书目文档里本来就不存 `updated_at`（[simplifications.md](../simplifications.md) 第一节第 13 条）。
   - 书的顺序：最近编辑的在前。
   - 全部在后台线程读，读完整份换进来；F3 总线上有书目、删除、正文的变化，或者 dr-store 报某篇文档的派生索引写好了（字数要等索引写好才变；刚生成或刚导入的库在后台补建索引，书卡上的字数会跟着涨上来），就记一笔，书架下次露出来时重读（藏着的时候不读，作者在书里打字不会让书架跟着重读）。
10. **文案**：全部是旧版九种语言里已有的字符串（`projectPicker.*`、`userMenu.*`、`common.*`），经 `dr-i18n/keys.txt` 拷过来。
11. **数字的写法**照旧版：字数用 `Intl.NumberFormat` 的紧凑写法（12.3万、123.5K、1,2 mil），其余数字按界面语言分组（`toLocaleString`）。只有九种语言，规则直接写在 `format.rs` 里，测试对过每种语言的结果。

**要作者定的事：没有。** 规范没写的地方取了最克制的做法，都记在下面「和旧版不一样的地方」。

## 怎么看

在 `next/` 里。先给这个 worktree 的开发档案生成 showcase 库，再启动：

```bash
cargo drifting workspace scenario seed:showcase --library "$(cargo xtask dev --print-config | python3 -c 'import json,sys; print(json.load(sys.stdin)["dataDir"])')/library" --yes
```

```bash
cargo xtask dev
```

截图和测量在离屏模式下跑（不开窗口，不要录屏权限），库是临时目录里新生成的 showcase：

```bash
cargo run -p dr-view-home --features capture --example shelf-home-capture -- --capture ../docs/rust-rewrite/modules
```

```bash
cargo run --release -p dr-view-home --features capture --example shelf-home-capture -- --bench ../docs/rust-rewrite/acceptance
```

## 截图

2 倍像素、1280×800、256 色，内容是 dr-testkit 的 showcase（《慢钟》《阿Q正传（示例）》和六本合成的书）。离屏截图里没有红绿灯，也没有指针，所以卡上的悬停图标看不到。种子库里每本书的文档都是同一刻写进去的，所以「最近编辑」都是「刚刚」、状态都是「在写」。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 书架 | [shelf-light](m01/shelf-light.png) | [shelf-dark](m01/shelf-dark.png) |
| 新建一本 | [shelf-new-light](m01/shelf-new-light.png) | [shelf-new-dark](m01/shelf-new-dark.png) |
| 移到最近删除 | [shelf-trash-light](m01/shelf-trash-light.png) | [shelf-trash-dark](m01/shelf-trash-dark.png) |
| 最近删除（里面有一本） | [shelf-deleted-light](m01/shelf-deleted-light.png) | [shelf-deleted-dark](m01/shelf-deleted-dark.png) |
| 账户菜单 | [shelf-menu-light](m01/shelf-menu-light.png) | [shelf-menu-dark](m01/shelf-menu-dark.png) |

## 对照旧版

| 旧版（`ProjectPickerView.tsx`、`views/shelf/*`、components.md「书架」） | 新版 |
| --- | --- |
| 平的桌面色，字直接写在上面 | 有 |
| 左栏：书架、几本共多少字、导入书、最近删除、账号格子、通知铃铛 | 有；多一个「导入 Drifting 0.1」的入口（M10） |
| 账户菜单：主题、语言、设定、反馈、登出 | 主题、语言、设定；反馈是 M39，登录登出是 M35 |
| 书卡：书名、副标题、梗概、四项读数、进度、状态与最近编辑 | 有 |
| 书卡：封面、体裁、近 30 天砂笔小图 | 没有，M25 |
| 悬停出编辑、导出、移到最近删除 | 编辑、移到最近删除；导出是 M41 |
| 新建一本；空白处双击新建（产品规则） | 有 |
| 新建 / 编辑对话框，⌘↵ 提交 | 有；回车提交（见下） |
| 移到最近删除的确认，焦点在取消 | 有（焦点在书架上，回车不会直接删） |
| 最近删除：恢复、立即删除、N 天后永久删除 | 只有恢复（见「待协调」） |
| 写作热力图、字海、示例书落位、换封面画风的按钮 | 没有，M24、M25 |
| 打开书时的字海等待 | 没有，M24 |
| 红灯和 ⇧⌘W 回书架，书架上红灯关窗 | 有 |
| 九种语言 | 有（全是旧版的字符串） |
| 深色、浅色 | 截图两套都有 |

## 和旧版不一样的地方

- **「导入」放在左栏，不在头像菜单里。** 交给我的说明写的是头像菜单，但旧版 2026-11-03 起已经把导入和最近删除从菜单挪到了左栏（components.md「书架」：「导入与最近删除不再在菜单里」），照旧版放左栏。
- **「导入旧库」没有现成的文案。** 旧版没有这个功能，九种语言里也没有这句话。这里用旧版已有的「导入」（`userMenu.import`）加等宽的行尾「Drifting 0.1」（产品名和版本号不翻译）。M10 要是想要一句专门的话，得先有新版自己的文案来源（见「待协调」）。
- **两个导入只放了入口。** 点它们派发 `dr_view_shelf::ImportBook` / `ImportLegacyLibrary` 两个动作，M41、M10 用 `cx.on_action` 接走。`ImportLegacyLibrary` 已由 M10 接走（`dr-view-import`，2026-11-08），书架上接它的那行调试日志删了（那行不放行，动作到不了 `cx.on_action`）；`ImportBook` 还是只记一行调试日志，M41 接的时候也要把它删掉。
- **回车提交，不是 ⌘↵。** 外壳的快捷键注册表每次重绑都先清空整张键位表（`keymap::apply`），模块自己加的键位会被清掉，所以对话框里没有 ⌘↵，改成在书名或梗概框里按回车提交，旧版操作区左边那个 `⌘↵` 也就不写了。
- **相对时间用通知中心的写法**（刚刚、3 分钟前、2 小时前、5 天前），旧版书架用的是 `Intl.RelativeTimeFormat`，会写「3 个月前」。
- **字纸篓图标悬停不变红。** dr-ui 的平面图标按钮还没有危险色的悬停。
- **卡没有封面，所以矮一些**（最小 196 px，旧版带封面是 250 px）。

## 接口（给别的模块）

| 谁 | 接口 |
| --- | --- |
| 应用 | `dr_view_shelf::init(cx)`，在 `dr_shell::init` 之后调一次 |
| M10、M41 | 动作 `dr_view_shelf::ImportLegacyLibrary`、`ImportBook`：用 `cx.on_action(|_: &ImportLegacyLibrary, cx| …)` 接 |
| M25（封面、近 30 天） | `dr_view_shelf::data::ShelfBook`（加字段）、`view.rs` 的 `card`（封面放在卡的左边，旧版 126×226） |
| M24（字海、首次体验） | `Shelf` 是一个普通的 GPUI 视图，书架底色在 `view.rs` 的根上；示例书落位要的「哪本是新写的示例」现在没有 |
| M35（账号） | 账号格子和账户菜单在 `view.rs` 的 `rail_foot`、`account_menu` |
| 测试、调试桥 | `Shelf::{data, dialog(), form_fields(), open, start_create, start_edit, submit_form, ask_trash, confirm_trash, open_deleted, restore, close_dialog, toggle_menu, menu_open, cards_ms}`；`dr_view_shelf::data::{ShelfData::load, words_of, edited_ms, doc_edited_ms, Status, progress}`；`dr_view_shelf::format::{compact, grouped, ago}` |

外壳这一侧（`dr_shell::pages`）：`set_shelf(cx, |ws, window, cx| ShelfPage { view, bell })`、`set_home(cx, |ws, window, cx| view)`；`Workspace::{show_shelf, open_book, shelf_open, shelf, home}`。

## 测量

M3 Pro，release，离屏（GPUI 的测试平台，真的 macOS 排字和 Metal 画进纹理），1280×800、2 倍屏。库是临时目录里新生成的 showcase（8 本）加重型种子的那本书，一共 9 本，经 F3 读。原始数据是测量证据 [acceptance/m01-m02-shelf-home-bench.json](../acceptance/m01-m02-shelf-home-bench.json)，用上面的 `--bench` 重跑。

**机器很忙**：别的会话在并行编译，开测时一分钟负载约 17（同一晚早些时候到过 300）。同样的程序在负载约 24 时跑过一次，数字在下表括号里；两次差到一倍，所以下面只能当量级看，等机器空闲再测一次。

| 项 | 测得（负载约 17；括号里是负载约 24 的那次） | 对照 [benchmarks.md](../benchmarks.md) |
| --- | --- | --- |
| 书架打开到书卡出现：建窗口到第一帧 | 49 ms（192） | — |
| 书架打开到书卡出现：建窗口到画出书卡 | 118 ms（233），其中书架在后台读 9 本书约 61 ms（34） | 发布档「冷启动到书架」≤ 300 ms 从进程启动算起；真程序的冷启动 F6 测过约 270 ms（负载约 7，到外壳首帧），书架读书再加几十毫秒，**可能贴着预算**，见「下一步」 |
| 书架静止时整页重画一帧 | p50 3.3 ms、最大 10.9 ms（1.4 / 1.6） | 发布档每帧 8.3 ms：中位数在内，最差一帧超了（负载高时的单帧） |
| 打开一本书到工作区就绪（点卡 → 书目列表到、作品主页的数字到、画出一帧），第一次 | 《慢钟》38 ms、《阿Q正传（示例）》35 ms、重型种子 29 ms（16 / 22 / 17） | 发布档「打开项目（重型种子，从书架点开）」≤ 150 ms：**在预算内** |
| 同一本书再打开 | p50 4.5 ms、最大 4.9 ms（10 次） | — |
| 回到书架（⇧⌘W 到书卡画出） | p50 10 ms | — |

- 「第一次打开」时，书架已经为了列书卡读过每本书的书目（和真程序一样），F3 的书目文档已经开着，所以这不是 F3 的冷开；冷开的代价算在「书架打开到书卡出现」里。
- 重型种子打开反而不比样书慢：工作区先读书目列表、先画主页，正文要等点开某一章才读。
- 真程序的冷启动到书卡这一轮没有单独测（要在屏幕上开窗口）。

## 测试

`cargo test -p dr-view-shelf`：

- **单元**（4 个）：九种语言的紧凑字数和分组写法；在写 / 草稿 / 搁置按最近编辑分；进度要有目标。
- **GPUI 测试平台上，用 dr-testkit 生成的真库**（《慢钟》《阿Q正传（示例）》，经 F3 读，6 个）：
  - 窗口一开就是书架，列出两本书；每本的章数和 F3 的 `chapter.list` 一样，字数等于派生索引里各章字数之和；
  - 点卡打开书，进的是作品主页；⇧⌘W 回书架；再打开另一本；在书里按红灯回书架、窗口不关，在书架上按红灯才关窗口；
  - 新建一本（回车提交）就打开它，回书架能看到它和它的梗概；
  - 改名（对话框带着原来的书名和梗概）、移到最近删除（先问）、从最近删除恢复；
  - 在空桌面上双击打开新建对话框，Esc 关掉、什么也没建；
  - 没有库时书架是空的，照样画得出来；账户菜单从账号格子打开，Esc 关掉。
  - 书架和主页都听 dr-store 的「索引写好了」：刚生成的库在后台补建索引，测试先等索引建完，再等书架上的字数和派生索引对上。
- 外壳的孤儿文案检查（`dr-shell/tests/strings.rs`）现在也扫 `dr-view-*`，书架用到的键都在。

## 待协调

1. **F3（dr-workspace）**：
   - 书架要的数字现在逐本书跑 4 条查询，再对每章查一次派生索引、对每篇文档查一次存储头。`book.list`（或一条新的 `book.summaries`）直接带上「只算章节的字数」「最近编辑」「`created_at`」「`deleted_at`」最省事。
   - 没有 `book.purge`，所以最近删除里没有「立即删除」；`BookInfo` 没有 `deleted_at`，所以写不出「N 天后永久删除」；30 天后自动清理也还没有人做。这三样一起做时，把旧版那句「作品在这里保留 30 天……」也放回来（现在没放，免得说一句做不到的话）。
2. **F5（dr-ui）**：`PanelIconButton` 加危险色的悬停（书卡上的字纸篓）。
3. **F6（dr-shell、dr-i18n）**，请审这几处我改到的地方：
   - `src/pages.rs`（新文件）和 `workspace/mod.rs` 里书架那几处：`shelf`、`shelf_open`、`home` 三个字段，`show_shelf`、`open_book`、红灯（`on_window_should_close`）、`covered()` 算上书架、`CloseProject` 接到 `show_shelf`、`render_shelf`；`workspace/stage.rs` 的 `home()` 开头三行。
   - `keymap::apply` 先清空整张键位表，模块没有地方登记自己的键（书架对话框的 ⌘↵）。要么注册表能让模块加行，要么只清外壳自己绑的。
   - `dr-i18n/build.rs` 两处小改动：某种语言只写了普通键、英语却有复数形时，把普通键当这种语言的 `_other`（zh-CN 的 `projectPicker.desk.chaptersUnit` 等五个键就是这样，i18next 也是这么回退的）；生成模块名时 Rust 的全部关键字都加 `_`（`projectHome.continue.*` 成了 `project_home::continue_`）。
   - `dr-shell/tests/strings.rs` 的孤儿检查现在也扫 `crates/dr-view-*/src`，并认关键字模块名后面的 `_`。
   - 账户菜单现在只在书架上有；工作区左栏底部的账号格子也该打开同一个菜单，可以把 `account_menu` 挪进外壳共用。
   - 新版自己的文案（旧版没有的话，比如「导入旧库」）还没有来源：`sync-locales.py` 只从旧版拷。
4. **M10**：入口是 `ImportLegacyLibrary` 动作，见上；2026-11-08 已接上（[m10-import.md](m10-import.md)「导入界面」）。
5. **应用**：`app/drifting/src/main.rs` 在 `dr_shell::init` 之后加了 `dr_view_shelf::init`、`dr_view_home::init` 两行，`DRIFTING_BOOK` 的说明改成「直接打开那本书、不经书架」。

## 下一步

1. M25 的封面和近 30 天、M24 的字海与打开书的等待，都挂在现在的卡和根上。
2. 冷启动：书架的数据现在等窗口建好才开始读。库本来就在自己的线程上和 AppKit 启动同时打开（F6），书架可以在那时就开始读，书卡和第一帧一起出来；机器空闲时用真程序把「进程启动到书卡出现」量一次。
3. F3 给出书架汇总以后，`data.rs` 换成一条查询。
4. 最近删除补上立即删除和剩余天数。
