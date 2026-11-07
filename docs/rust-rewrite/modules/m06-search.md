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
