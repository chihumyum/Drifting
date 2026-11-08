# M09 快照历史

2026-11-08，第一个里程碑。计划见 [modules.md 的 M09](../modules.md)。界面在 `next/crates/dr-view-history/`，后端是 F3 的 `history.points`、`history.preview`、`history.restore_point`（`next/crates/dr-workspace/src/commands/points.rs`，说明见 [f3-workspace.md 第四轮](../foundations/f3-workspace.md)），历史点本身是 F2 的历史标签。外壳里只挂了一处入口。

## 做了什么（大白话）

1. **章节稿纸右下角的 ⋯ 菜单里有「历史快照…」。** 点它，工作区上方浮起一个对话框，照旧版 `EntitySnapshotHistoryModal`：
   - 上面一行小字「历史快照 · 30 天」，标题是「章节 · 这一章的名字」；
   - 下面是这一章的历史点，新的在前，每个点一行：时间（等宽小字，今年的写「11/08 14:05」，往年的前面加年份）、当时的字数、当时这一章的标题、当时正文的前两行；
   - 一个点都没有时，显示旧版那句「暂无快照。编辑正文后系统会按约 15 分钟一次的节奏自动留存。」
2. **点一行就能预览。** 那一行变成静止的选中玻璃，下面展开当时的全文（H1/H2/H3 加粗，正文用稿纸的字体），最多 240 像素高，可以滚动。再点一次收起。这是新加的：旧版只看得到前两行。
3. **恢复要再确认一次。** 每行右边是「恢复…」；点了以后原地变成「取消」和「确认覆盖当前版本」。确认后按钮显示「恢复中…」，这时对话框关不掉。恢复完，列表下面写「已恢复到所选版本。恢复前的状态已自动存为新快照。」，列表重新读一遍，最上面多出一个点（恢复前的样子）。失败就写「恢复失败：原因」。
4. **恢复的是正文和这一页自己的字段**（按实体恢复）：正文回到那个点；章节的标题、梗概、写作状态也回到当时的值；书里别的东西不动。要素当时的名字或别名现在已经被别的要素占了，就不改名字和别名（照旧版）；章节当时的标题现在被另一章占了，就照新版的规矩加后缀（「雨 2」）。
5. **能撤销。** 恢复是作者的一个命令：对象级撤销一步撤回正文和字段，重做再来一次。编辑器自己的撤销不会撤到它。
6. **浅色深色都看过。** 截图在 [m09/](m09/)：`history-*` 是三天前那个点展开了预览，`history-confirm-*` 是点了「恢复…」以后。

## 定下的事

| 事 | 怎么定的 | 理由 |
| --- | --- | --- |
| 快照存在哪 | 不另存，用 F2 的历史标签（每个标签记着正文和书目当时的版本） | F2 已经照旧版的规则打点、修剪；另存一份就是两套历史 |
| 多久一个、留多久 | F2 的规则：写作时最多每 15 分钟一个，关闭时一个，帮手每轮动手前一个，恢复时一个；一小时内全留，一天内每小时一个，再往前每天一个，30 天后删掉 | 和旧版一样；旧版 TypeScript 那份会把恢复前的点在同一个小时里修剪掉，F2 用的是旧版 Rust 移植的修正（一小时内全留） |
| 列表里显示什么 | 时间、字数、当时的标题、前 120 个字（界面截成两行） | 照旧版；旧版不显示「为什么打的这个点」，这里也不显示（数据里有 `kind`，以后要可以加） |
| 预览放哪 | 点哪一行就在哪一行下面展开 | 旧版是一列，没有预览区；在原地展开不用改布局，宽度照旧 520 |
| 恢复前先存一份 | 先给现在的版本打一个 `restore` 点，再恢复 | 旧版的提示语就是这么说的 |
| 入口在哪 | 章节 ⋯ 菜单的「历史快照…」，以及右栏统计标签最底下的同名按钮（M20 加的，调同一个 `open_history`） | 监管会话定的；旧版唯一的入口在右栏统计面板底部 |
| 别的页面 | 对话框不分种类：要素、故事线、分类、素材笔记的正文都能用，标题前面写「要素 ·」之类 | 它们的 ⋯ 菜单还没做，做的时候各加一项 |

## 接口

```rust
// 外壳（dr-shell）里的挂接：workspace/corner.rs 的菜单项和 open_history，
// workspace/mod.rs 的一个字段、一行渲染。
ws.open_history("node:<id>".into(), "章节名", window, cx);   // 打开；HistoryEvent::Close 时收起
let dialog = cx.new(|cx| HistoryDialog::new(lib, doc, name, locale, platform, cx));
// HistoryEvent::Restored { doc } —— 恢复成功（改动本来也会从 F3 的总线到达）

// 不依赖 GPUI 的部分（dr_view_history::model）
model::kind_key("element:…")      // 标题前面的种类：章节 / 要素 / 故事线 / 类目 / 笔记
model::stamp(ts_ms, now_ms)       // 「MM/DD HH:mm」，往年加「YYYY/」，按这台设备的时区

// 测试和截图直接驱动
dialog.select(point_id, cx); dialog.ask_restore(point_id, cx); dialog.restore(point_id, cx);
```

截图：`cargo run -p dr-shell --features capture --example history-capture -- ../docs/rust-rewrite/modules`（在 `next/` 下跑，要先建好字体，见 F5）。书是 dr-testkit 的《慢钟》，第一章三天里加了几行字、改了一次名，造出几个历史点。

## 改动的文件

```text
next/crates/dr-view-history/               新 crate：对话框（dialog.rs）、不依赖 GPUI 的部分（model.rs）、截图例子
next/crates/dr-shell/Cargo.toml            加依赖一行
next/crates/dr-shell/src/workspace/mod.rs  一个字段、初始化、渲染各一处
next/crates/dr-shell/src/workspace/corner.rs  ⋯ 菜单加「历史快照…」，加 open_history
next/crates/dr-i18n/keys.txt               snapshotHistory 用到的 8 个键和 kind.*、rightSidebar.stats.snapshotButton、common.wordsCount
next/crates/dr-i18n/locales/*.json         sync-locales.py 生成
```

## 待协调

- **F5（dr-ui）**：界面文字（GPUI 自己的换行）不避头尾，摘录里「，」会落到行首（截图里能看到）。稿纸正文走 prose-linebreak 没有这个问题；要不要给界面文字也接上避头尾，由 F5 定。
- **F6（dr-shell）**：要素、故事线、分类、素材的 ⋯ 菜单做出来时，各加一项「历史快照…」，调 `open_history`。
- **M07 / M20（统计）**：已加。统计标签最底下的「历史快照…」调 `open_history`（章节、构想、故事线、要素、类目、笔记素材都有；旧版的悬停提示没有搬）。见 [m20-stats.md](m20-stats.md)。
- **M27–M34（帮手）**：旧版恢复后会清掉这一页「帮手刚改过」的标记和活动点；墨色显现做好以后，在 `HistoryEvent::Restored` 时清。

## 没做的

- 旧版恢复素材笔记时会核对笔记里的任务行和待办（M19 的事）。
- 新建一章时，存储层给正文打第一个点的那一刻书目里还没有这一章（写入顺序是先正文后书目），那个点没有「当时的标题」，列表里就空着标题。
- 性能没测：`history.points` 要载两份副本、逐个检出，heavy 种子上的耗时等机器空闲时量。
