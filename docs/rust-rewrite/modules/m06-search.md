# M06 全书搜索

2026-11-08，第一个里程碑。计划见 [modules.md 的 M06](../modules.md)。界面在 `next/crates/dr-view-search/`，后端是 F3 的 `book.search`（`next/crates/dr-workspace/src/commands/prose.rs`），外壳里只挂了一处。章内查找替换是 F4c 的查找条，不在这里。

## 做了什么（大白话）

1. **⌘⇧F 打开全书搜索。** 稿纸上方浮起一张平的浮层（菜单外壳，和设置一样压在工作区上面）：一个单行输入框，前面是砂笔搜索图标，框尾用等宽字写「几个 · 几处」；右边是关闭。再按一次 ⌘⇧F、按 Esc、点浮层外面都会关掉。
2. **一边打字一边出结果，按所在的东西分组。** 停手约 90 毫秒就搜。顺序是全书阅读顺序的章节在前，然后构想、要素、故事线、类目、素材；每组的组头是它的砂笔记号（颜色和侧栏一样）、名字、命中几处和种类（等宽小字），下面每条命中一行：左边等宽小字写在哪里（标题 / 名称、梗概、正文、补丁、说明），右边是前后各约 24 个字的片段，命中的字**加深加粗，不垫底色**。
3. **点一条就跳过去。** 正文里的命中经位置链接（`drifting:chapters/id-<id>/prose.md#L<行>`）交给 F6 的导航模型打开那一章，稿纸滚到那一段；标题、梗概、补丁、说明里的命中打开那一页；素材没有位置链接，直接打开。点组头打开那一页。
4. **键盘也能用。** 打开时光标在输入框里，第一条命中已选中（静止的选中玻璃）；↑↓ 在命中之间移动（列表跟着滚），回车跳过去。↑↓ 由浮层自己读按键，不进键表：外壳每次改快捷键都会按自己的登记表重建整张键表（`keymap::apply` 先清空），模块自己绑的键会丢（M01/M02 也碰到了，见待协调 4）。
5. **浅色深色都看过。** 截图在 [m06/](m06/)：`search-*` 是单字「钟」（37 组 84 处），`search-name-*` 是人名「沈知微」，浅色、深色各一张。

## 定下的事

### 书目文档里的文字进不进搜索（之前 dr-text-index 的待协调 6）

| 文字 | 进不进 | 理由 |
| --- | --- | --- |
| 章节、构想、素材的标题；要素、故事线、类目的名称 | 进 | 旧版就搜；找一章最常见的办法是搜它的名字 |
| 章节、构想、要素、故事线的梗概 | 进 | 旧版就搜（旧版叫「简介」，界面字改用「梗概」） |
| 素材的说明（`description`） | 进 | 结构定稿时就写明「Agent 写、搜索读」 |
| 要素补丁的标题和正文 | 进，归在它的要素下 | 补丁是作者关于这个要素写的字，跳过去是打开要素 |
| 批注、待办的正文 | **不进** | 它们是对正文的意见，有自己的审阅面板（M18，可以按全部 / 批注 / 待办筛选）；混进全书搜索会把「找原文」变成「找原文和对原文的议论」。M18 要的话在审阅面板里加自己的搜索框 |
| 构想分组、素材夹、关系类型的名字，项目设定 | 不进 | 旧版不搜，也不是作者写的正文 |

**怎么搜：** 这些都是书目文档里的短字段，F3 的查询缓存手上就有，查询时直接逐个扫（大小写按 dr-store 同一条简单折叠规则），不进 dr-store 的 `block_index`。所以没有索引延迟、不用给它们造文档身份；书目文档再大也只是几千条短字符串。正文照旧走 F2 的按书序搜索。

### 一条命中是什么

- 正文一段一条（dr-store 的规则：一段里第一次出现的位置），标题、梗概、说明、每个补丁也各一条。
- 一组的顺序：标题 → 梗概 / 说明 → 正文各段 → 补丁。
- 一次最多读 500 条，读满时框尾写「500+ 处」。截断按上面的顺序切，和只搜正文时的书序一致。

### 改了 F3 的 `book.search`

- 输出每条多了 `field`（`body` / `title` / `summary` / `description` / `patch`）、`snippet_match` 和 `match_len`（片段里命中从第几个字起、几个字，界面直接用来加粗），`paragraph` 改成只有正文命中才有。片段里的换行一律换成空格。
- `kind` 从 `node` 细分成 `chapter` / `idea`（界面要知道打开哪一种）。
- 帮手用的也是这一条，所以它现在也能按标题、梗概找到东西。能力清单快照已更新。

## 接口

```rust
// 外壳（dr-shell）里的挂接，只在 workspace/mod.rs 一处：
ws.toggle_search(window, cx);                               // GlobalSearch 动作；渲染时加上浮层
let panel = cx.new(|cx| SearchPanel::new(lib, book_id, marks, locale, platform, window, cx));
// SearchEvent::Jump(Jump { target: NavTarget, link: Option<String> }) → ws.open_link(link)，
// 没有链接（素材）就 ws.open(target)；SearchEvent::Close → 收起。

// 不依赖 GPUI 的部分（dr_view_search::model）
model::group(hits) -> Vec<Group>;          // 按所在的东西分组，保持书序
model::jump(&group, Some(&row)) -> Jump;   // 正文命中 → #L(2N+1)
panel.set_query("钟", cx);                 // 测试和截图：不等防抖直接搜
```

## 测量

heavy 种子（一本书 680 篇、约 360 万字），release 构建，每项 15 次。测的时候机器在多路并行编译（负载约 28），只作参考，空闲时重测。`book.search` 一次取 500 条（界面的上限）：

| 查询 | 命中 | p50 | 最慢 |
| --- | ---: | ---: | ---: |
| 1 个字「灯」 | 500 | 8.7 ms | 67 ms |
| 2 个字「灯塔」 | 500 | 28 ms | 76 ms |
| 3 个字「灯塔亮」 | 500 | 18 ms | 171 ms |
| 4 个字，没有命中 | 0 | 7.2 ms | 26 ms |

搜索在后台线程跑，停手 90 毫秒才开始，新的一次会丢掉还没回来的旧的一次，打字本身不等它。书目文档里的短字段每次全扫一遍（几千条短字符串），在这些数里占不到 1 毫秒。

## 测试

- `dr-workspace/tests/commands.rs`：
  - `search_reads_titles_summaries_and_material_descriptions_too`：标题、梗概、正文、素材说明的顺序；片段里的命中位置；截断也算短字段；拉丁字母大小写折叠。
  - `search_orders_by_book_order`（改）：要素的名称在它的正文前面。
- `dr-view-search/src/model.rs`：分组、链接的行号、字节范围。
- `dr-shell/tests/m06_m07.rs`：在真书《慢钟》上按 ⌘⇧F、打字（等防抖）；外壳重建键表之后 ↓ 移到第二条、↑ 回到第一条；↓ 再回车，跳到第二条命中所在的章，稿纸读完并取走了位置；Esc 和再按一次 ⌘⇧F 都能关。

## 待协调

1. **F4c（查找条）/ F4e（编辑器）：跳到段落以后高亮命中的字。** 现在稿纸只滚到那一段（F6 的 `take_reveal`），不标出命中的字。位置链接只到行，要标出字需要链接带字符范围，或者 M06 交一个 `(段, 字符范围)` 给编辑器。等编辑器接进外壳时一起定。
2. **F6：搜索浮层算不算「层」。** 现在浮层自己管 Esc 和点外面关闭，没有进 `Workspace::top_layer` / `covered()`。要让「Esc 一层一层关」把它也算进去，在 `dismiss` 里加一支即可。
3. **M18：** 批注不进全书搜索（见上），审阅面板要搜批注就自己加。
4. **F6：模块自己的快捷键。** `keymap::apply` 清空后只装回 dr-ui 输入框和外壳登记表里的键，模块用 `cx.bind_keys` 绑的键在下一次 `apply`（启动最后一步、每次改快捷键）就没了。搜索面板改成自己读 ↑↓ 绕开了；M01/M02 的对话框 ⌘↵ 也碰到同一个问题。建议外壳给模块一个登记入口（比如 `keymap::register_module(bindings)`），`apply` 每次一起装回。
5. **和 M01/M02 分支的合并：** 两边都改了 `dr-shell/tests/strings.rs`，让它也扫 `crates/dr-view-*/src`（做法一样，留一份即可），`keys.txt` 也都加了键。

## 代码位置

```text
next/crates/dr-view-search/src/
  lib.rs      init、导出
  model.rs    分组、高亮范围、跳转链接（不依赖 GPUI）
  panel.rs    浮层：输入框、结果列表、键盘
next/crates/dr-workspace/src/commands/prose.rs   book.search
next/crates/dr-shell/src/workspace/mod.rs        toggle_search（挂接）
next/crates/dr-shell/examples/m06-m07-capture.rs 截图
```

截图：`cargo run -p dr-shell --features capture --example m06-m07-capture -- ../docs/rust-rewrite/modules`（要先建好字体，见 F5）。

## K4 G4：接线待协调（开工核对）

基线 `10e97880`，分支 `codex/k4-g4-book`；尚未交回功能。

1. **F6 搜索宿主**：`workspace/mod.rs::toggle_search` 只接
   `SearchPanel::new` 和 `Jump { target: dr_workspace::NavTarget, link }`。
   此类型没有 Entry/module，旧位置链接也不解析模块。需要在 v3 分支把
   G4 返回的条目 id、模块 id、段落位置转成
   `Target::Entry { id, module }` 并用 `open_at`，保留 v2.2 原分支。
   G4 提供独立 v3 面板接口，宿主仅负责版本选择、记号和导航。
2. **F6/G2 右栏宿主**：`workspace/sidebar.rs::right_body` 的 Stats、Review
   都先调用 `book::nav_target`，Entry/module 会变成 Book 哨兵。
   需要在这个转换之前按版本分流，将 Entry/module 或 Material 交给各自
   v3 面板，回调直接打开 `Target`。这两处不在 G4 获准修改的外壳范围内。
3. **K2 公共命令**：`Cx::book` 当前只放行 v3 通用命令、`prose.*` 和四个
   book 生命周期/元数据命令；`book.search`、`book.word_counts`、
   `book.writing_days`、`writing_day.record`、`comment.*`、`material.*`、
   `material_folder.*` 仍拒绝 v3。搜索/统计可在 G4 只读适配；审阅、素材和
   写作日写入需要 K2 提供明确的 v3 命令，不由视图绕过 Workspace 直接改 Loro。
   批注输入/输出还需携带正文模块；现有 `CommentCreateIn` 没有 module。

以上是实现前的接口缺口，不是验收通过或范围扩大。外壳仍只在 G4 接主页时
新增主页注册口；其余接线及公共命令交负责方。真窗口验收必须等实际产品入口接通。

### 接口准备（2026-11-10，尚未功能交回）

作者已选择由整合者安排 F6/G2/K2 补接口，保持 G4 修改边界。
`SearchPanel::new_v3` 与原 `new` 并存；`SearchEvent::JumpV3` 返回
`v3::Jump { target: Entry { id, module } / Material(id), line }`，段落位置遵循
`2 * paragraph + 1`。宿主传入 v3 的记号回调并直接映射外壳 Target。
`v3_groups()` 供验收读取，旧 `groups()` 不装入 v3 目标。

只读搜索按活条目树序、模板模块序、保留模块、素材排列；回收祖先下的条目、
模板正文和批注正文不进入结果。正文复用 F2 索引，一次按有效文档顺序搜索；
标题、文字字段、键值、补丁文字、格子文字在对应模块分组。关系标识和已知的
图片／实体引用字段不当正文搜索。结果上限在有效目的地排序后应用。

永久契约 `dr-view-search/tests/v3.rs` 覆盖多正文的模块跳转、模块删除后保留正文、
回收／恢复、短查询与全文查询的额度、空查询、只读版本不变、v2.2 路径和 GPUI
键盘跳转。搜索／统计两 crate 的定向测试共 30 项通过，另有 1 项文档示例忽略；
定向 Clippy、fmt 和九语言同步检查通过。此处不包含全工作区检查、真窗口或
heavy 验收；接口批完整检查见下节。宿主接通后必须从实际产品入口补验。

## K4 G4 搜索／统计接口批交回（2026-11-10）

按作者保持 G4 边界的决定，以及整合者在 overnight 的接口批分派，本批只交
可编译的公共接口、只读数据适配和永久契约，供 F6/G2 正式从 main 消费。
**不是搜索／统计产品功能验收完成，也不是 G4 完成。**

- 分支：`codex/k4-g4-book`；实现提交 `78a8a314`，合入 main 基线
  `ee372789`（第 57 批；同步提交 `d42c1a2f`、`3c085afd`、`13469f7c`）。
  交回指针为 `handback/k4-g4`。
- 范围：dr-view-search、dr-view-stats、它们的依赖清单／测试，以及 dr-i18n 的
  own 与生成 locales（九语言四个短标签）。没有修改 dr-shell、K2 或其他组产品。
  本批适配只有读，契约断言读取不改书的版本；后续写入仍须使用逐项命令或
  与原读取对应的版本守卫，并补并发／隐藏内容的写入回归。
- 检查：`CARGO_BUILD_JOBS=3`；workspace fmt、Clippy（all-targets、locked、
  `-D warnings`）通过；`DR_UI_REQUIRE_FONTS=1 RUST_TEST_THREADS=1 cargo test
  --workspace --locked` 的 Cargo 汇总 **2090 通过、0 失败、22 忽略**；
  `cargo xtask check`（含 audit）、根目录 `pnpm public:check`、九语言同步检查、
  `git diff --check` 通过。xtask 仍标注既有 14 份 stale 和 15 份 legacy 测量，
  本接口批没有新增或改写测量证据。
- 复验经过：main `2f80ac40` 基线曾完整通过 2068 项；同步第 57 批后按同一
  配置重跑全套，以上 2090 项和全部门禁结果来自新候选。更早的首轮全测在原书架封面／日期卡片测试等待超时，同一二进制独跑
  2.16 秒通过；第二轮串行全测该项通过，但字符封面因本 worktree 缺构建字体而
  画空。补入已有六个构建字体并逐个核对 provenance 的固定 SHA-256 后，字符
  封面独跑和最终完整全测均通过。没有修改书架、字体配方、测试阈值或忽略项。
  原始本地日志保留在 `next/target/g4-checks/`，不作为手写 JSON 证据提交。
- 待协调：F6 搜索／素材导航、G2 右栏版本分流、K2 批注模块／素材／写作日。
  真窗口 `seed:v3-lite` 搜索／统计场景和 heavy 打开／滚动对照**尚未验收**；
  等真实产品入口接通后由 G4 补验，再交完整功能批。未合入 main、未推送。

## K4 G4 索引延迟刷新修复交回（2026-11-10）

第 64 批窗口在素材搜索处超时；F6 随后的确定复现把派生等待设为 60 秒，
先查得空结果，再显式重建索引，直接查询已有 Material Body／paragraph 0，
但面板仍为空。G4 的 v3 面板现订阅所属 Workspace 的索引和同书元数据事件，
在后台核对索引文档的书 id 后重查当前词；事件回调不阻塞文档持有线程。
每次查询有独立序号，旧请求不能覆盖新请求（包括 A→B→A）；面板绑定库和书，
销毁时释放订阅和任务。不改搜索宿主、查询接口、产品文案或 v2.2 测试。

分支 `codex/k4-g4-book`，实现 `d73a5bd4`，已合 main `07fd3c15`；交回指针
`handback/k4-g4`。永久回归 `dr-view-search/tests/v3_live.rs` 先在旧实现复现刷新超时，修复后
3 项通过：素材的晚到索引；正文模块的切词／清空、回收／恢复；同库其他书和
同 id 的独立库不能重置选中命中。素材与正文均断言精确目标及段落。测试正文
仍来自共享 seed，仅添加识别标记。编译并发 3，fmt、workspace Clippy
（all-targets／locked／`-D warnings`）、全测 **2179 通过／0 失败／22 既有忽略**、
xtask（含 audit）、public（5537 candidates）、九语言同步检查通过；全测启用
`DR_UI_REQUIRE_FONTS=1 RUST_TEST_THREADS=1`。首次红绿与整轮原始日志保留于
`next/target/g4-checks/search-late-index-{before,after}.log` 和 `search-fix-*.log`。
审计 972 个锁定依赖、0 漏洞／12 条既有通知；测量标记仍为 0 fresh／19 stale／15 legacy。

本次按整合者明确分派独立交搜索修复：当前 main 未含 F6 搜索宿主，原 60 步
副屏真窗口由整合者与 F6 正式候选配对复验，**本交回尚未通过该窗口验收，
组合场景通过前不合 main**。不放宽原窗口断言，不把首次失败解释成已证明的
环境干扰，也不跨改 F6 宿主。没有新增公共接口、文案、heavy 测量或删除 v2.2
测试；未合入 main、未推送。

### 索引刷新时的选择与位置保持（2026-11-10，重交准备）

整合预审提出同书无关索引可能重置选中项，G4 已实际复现：选中第二个正文
命中后，显式重建不匹配当前词的同书素材索引；直接查询结果完全不变，面板
收到完成通知后却从 `Hit(1,0)` 变成 `Hit(0,0)`。修复后，同词同结果不改选择
和滚动；结果变化时按精确 Entry/module 或 Material、字段、段落、片段及高亮
范围唯一匹配原命中。命中消失或身份有歧义时清空选择，Enter 不跳转，方向键
或点击重新选择。新查询及首次空结果后出现命中仍默认首项。
同一个查询曾有命中、随后全部消失再出现时仍保持安全清空，不重新冒充首次结果。

新增永久事件回归覆盖同书不相关索引、原 Enter 目的地、前置分组删除后的
身份保持、原命中消失时 Enter 无操作和方向键重选；既有晚索引测试补断言
首次命中选中首项。私有 GPUI 契约验证相同结果既保留实际滚动偏移，也不排入
下帧滚回顶部的请求，并覆盖同身份重复命中的安全清空。定向 12 项通过；
首轮红与修复后日志保留于 `search-selection-before.log`、
`search-selection-final-focused-2.log`。新增测试初版的 Rust 借用编译错误已修，
该编译失败日志也保留，未改变产品断言或忽略测试。

正在重跑全套，原 `f83d8c16` 待修不合；原 60 步窗口仍由整合者配对 F6
正式宿主验收，断言不改、不扩窗口矩阵。没有公共接口或文案变化，没有删除
v2.2 测试；检查完成前不挪交回指针。
