# M07 字数与写作日

2026-11-08，第一个里程碑。计划见 [modules.md 的 M07](../modules.md)。界面和写作日记录器在 `next/crates/dr-view-stats/`，查询和写入是 F3 的三条新命令（`next/crates/dr-workspace/src/commands/stats.rs`），外壳里挂了两处（初始化、统计标签）。字数规则是 `prose-metrics`，实时字数是 `dr_text::LiveCount`（[dr-text-index.md](../foundations/dr-text-index.md)）。热力图是 M25；统计面板的其余内容（提及、分幕节奏、素材）是 M20，在同一个标签里往下加，见 [m20-stats.md](m20-stats.md)。

## 做了什么（大白话）

1. **右栏「统计」标签有内容了。** 平的排字，键和数字用等宽字，值用正文字，节与节之间只留空，读数是砂笔：
   - 第一节：最具体的那个数，选中的字 → 这一章或这条构想 → 这条故事线 → 全书，取能取到的最具体的一级（和旧版账户格里的读数同一条规则）；不是全书时下面再给全书；再下面是今天写的字数和一笔朝每日目标走的砂笔，以及目标是多少。
   - 第二节「写作进度」：已写 / 全书目标（一笔砂笔），章节数，平均每章；是故事线时章节数和平均按这条故事线算，不列全书目标（M20 起；章节的「全书位置」M20 挪进了「章节坐标」）。
   - 第三节「最近」：本周、连续写作几天，然后最近七天每天一行（日期、一笔砂笔、字数），今天在最上面。
   - 截图在 [m07/](m07/)：章节、故事线、全书三种，浅色深色各一张。
2. **字数从派生索引来，打开的那篇用编辑器手上的数。** 每章、每条构想、每条故事线、全书都读 dr-store 的索引（按章节逐篇查，一次查询）；全书 = 所有活着的章节之和，和旧版一样不算构想、要素、素材。编辑器（F4e）把它手上那篇的 `LiveCount` 报给 `LiveWords`，统计标签就用它替换索引里这一篇的数，全书、故事线的合计跟着变，不等索引。选中文字时第一行变成「选中」。
3. **写作日记下来了。** 每台设备、每本书、每天一个数，存在书目文档的 `writing_days` 里（键 `<设备>|<日期>`），设备键沿用旧版：`device-` 加 SHA-256(`"drifting.writing-day.v1\n" + 安装身份`) 的前 12 字节（F2 的 `Device::writing_device_key`）。各设备只写自己的键，同步时不会互相覆盖；一天的数是各设备之和。
4. **今天写了多少，按旧版的规则算，而且更准。** 一天的字 = 全书章节总数 − 这一天的基线：
   - 作者自己（编辑器、帮手、Markdown 文件夹）改了一章，索引跟上以后，这一章多出的字算今天写的；
   - 别的设备同步来的、导入的、打开时补建落后索引的，**只挪基线不算字**（旧版是「别的设备的改动到达后 8 秒内的变化都不算」，这里按每一篇的来源判断，没有时间窗）；
   - **新建、移进最近删除、恢复一章也只挪基线**（旧版恢复一章会把整章算成今天写的，这里不会）；
   - 删得比写得多，读数是 0；
   - 一天里第一次见到这本书时，基线从「已经存下的今天的数」算起，所以重开应用不会丢掉上午写的。
   - 写入：字数在变时最多一分钟写一次书目文档，退出前再写一次；不进撤销日志（`writing_day.record` 不报改动、不声明反操作），所以不会夹在作者的两步撤销之间。
5. **给 M02（作品主页）的接口。** `dr_view_stats::load_progress(&ws, book, &今天, today_live)` 一次给出全书字数、全书目标和进度、今天的字数和每日目标进度、本周、连续天数；`today_live(book, cx)` 是记录器手上还没存下的本机今天的数。也可以直接调 F3 的 `book.word_counts`、`book.writing_days`。

## 定下的事

- **「今天」是写作者本机的日历日**（旧版 `todayKey`）。新版没有日期库，`dr_view_stats::clock::today()` 在 macOS / Linux 用 `localtime_r`，Windows 用 `GetLocalTime`（工作区的 `windows` 依赖加了 `Win32_System_SystemInformation` 特性）。
- **统计标签显示的今天 = 书目文档里各设备之和，本机那一份换成记录器手上的数**，所以刚写的字不用等一分钟的写入就能看到；别的设备的字等同步到了才算。
- **连续写作**：截至今天、每天都有字的天数；今天还没写就是 0（和旧版统计面板、书架热力图一致）。今天的第一个字一落下（还没存下），读数立刻接上昨天的连续天数（`streak_before + 1`）。
- **本周**是包括今天在内的最近七天，不是周一到周日（旧版 `deriveWritingStats`）。
- **数字分组**：旧版用 `toLocaleString`。新版没有 ICU 的数字格式，按语言用逗号、句点或窄空格三位一组，西班牙语四位数不分组（CLDR 的最小分组）。
- **连续写作「N 天」在英文里是「1 days」**：旧版书架热力图就是这样拼的（`projectPicker.heat.daysUnit`），旧文案里没有带复数的「N 天」可搬，照旧。
- **没有设备身份时**（身份文件读不出来时的应用，或测试）记录器照样数今天的字、统计标签照样显示，只是不写进书目文档。
- **记录器跟哪些书**：窗口显示的那本，以及这次运行里本机写过的每一本（帮手可能写别的书）。

## 改了 F3

三条新命令，能力清单快照已更新，每条在 `tests/commands.rs` 里都有测试：

| 命令 | 读 / 写 | 做什么 |
| --- | --- | --- |
| `book.word_counts` | 读 | 每章（阅读顺序，带所属故事线）、每条构想、每条故事线的字数和字符数，全书（章节之和），每篇有没有被索引数过（`counted`），全书目标和每日目标 |
| `book.writing_days` | 读 | 最近 N 天（默认 7，最多 400）每天各设备之和；今天、本机今天（给了 `device` 时）、本周、最近三十天里写了的天数、连续天数和到昨天为止的连续天数、每日目标 |
| `writing_day.record` | 写，不可撤销 | 本机某一天的字数（设备键和日期都校验；值和已存的一样就不写） |

另外加了 `Workspace::writing_device()`：库打开时带了 F2 的 `Device` 就返回写作日设备键。

## 接口

```rust
// 外壳（dr-shell）里的挂接：
dr_view_stats::init(services.library.clone(), cx);     // lib.rs 的 init：记录器 + 事件分发
quit::before_quit(cx, dr_view_stats::flush);           // 退出前写下今天
RightTab::Stats => dr_view_stats::panel(&pane_id, &book_id, current_target, locale, platform, cx)

// 编辑器（F4e）报实时字数：
LiveWords::set_doc("node:<id>", live.total(), cx);    // LiveCount 每次变化后
LiveWords::set_selection(Some(dr_text::count_words(&selected)), cx);
LiveWords::clear_doc("node:<id>", cx);                 // 编辑器关掉时

// M02：
dr_view_stats::load_progress(&ws, &book, &dr_view_stats::clock::today(), dr_view_stats::today_live(&book, cx))
  -> Progress { words, counted, word_target, book, today, daily_word_target, daily, week, streak }
```

## 测量

heavy 种子（一本书 100 章），release 构建，每项 15 次，机器负载约 28（只作参考）：

| 查询 | p50 | 最慢 |
| --- | ---: | ---: |
| `book.word_counts`（100 章、所有构想和故事线） | 3.6 ms | 14 ms |
| `book.writing_days`（最近 7 天） | 0.10 ms | 13 ms |

统计标签在后台线程读这两条，库里有变化（某一篇的索引写完、书目文档变了）后 300 毫秒再读一次，一阵连续的变化只读一次。记录器在自己的线程上，每次索引写完只读那一篇的一行。

## 测试

- `dr-view-stats/tests/recorder.rs`（假的数据源，不开库）：只有本机写的算字；别处来的、补建索引的只挪基线；章节来去不算写；删多了读 0、再写从下面爬回来；过了午夜把前一天存下、新一天从 0 起；重开从已存的数接着数；一分钟最多写一次、没变不写；本机没写过的书不跟。
- `dr-view-stats/tests/recorder_library.rs`（真库，带设备身份）：作者用 `prose.replace` 加了四个字、索引跟上以后，记录器数出 4，`flush` 后书目文档里本机今天是 4；`load_progress` 给出今天 4、连续 1 天、全书 9 字。
- `dr-view-stats/src/model.rs`：取最具体一级、编辑器的数替换索引的数（全书、故事线跟着变）、选中优先、今天和进度、数字分组。
- `dr-workspace/tests/commands.rs`：`word_counts_come_from_the_index`（全书只算章节、故事线、移进最近删除以后）、`writing_days_sum_devices_and_keep_each_device_to_its_key`（各设备相加、本机、本周、连续、坏的设备键 / 日期 / 负数都拒绝）。
- `dr-shell/tests/m06_m07.rs`：在《慢钟》上打开统计标签和第三章：读数是本章、比全书小；编辑器报了更大的数以后本章和全书一起变；有选中时是「选中」；换到通览全书读的是全书。

## 待协调

1. ~~**F7 / 应用（`app/drifting`）：打开库时带上设备身份。**~~ 已做（2026-11-08，F7）：`app/drifting/src/library.rs` 打开库时带上 `Device::open(<应用本机数据目录>)`，应用里的写作日从此存进书目文档。见 [m39-feedback.md 的「设备身份」](m39-feedback.md#设备身份m07-待协调-1)。
2. **F4e：编辑器接进外壳时报实时字数和选区字数**（`LiveWords`，接法见上）。没接之前统计标签用的是索引的数，停手约 150 毫秒后跟上。表格那一段要交表格的文字（`dr_text::table_text`），不然会比索引少。
3. **F6：账户格里的两个读数。** 旧版的「本章 N 字 · 今日 +N 字」写在左栏底部的账户格里，这次按监管会话的安排先放进统计标签。要搬回账户格的话，`dr_view_stats` 的 `model::reading`、`today_live` 已经够用，挂接在 F6 的 `account_cell`。
4. **M25（书架热力图）：** 读 `book.writing_days`（`days` 最多 400 天，一年多一点）或直接读书目文档的 `writing_days`。旧版本机更早的写作史（`writing-stats-storage`）旧版 11-03 已经回填进它的 `writing_day` 表，M10 导入时一起搬过来了。
5. **M02（作品主页）：** 它现在从书目文档的副本（`load_copy`）读写作日，可以换成 `book.writing_days` 或 `load_progress`（见上），本机还没存下的字用 `today_live`。
6. **M20（统计面板）：** 这一页的三节是 M20 的一部分，M20 开工时在同一个 `StatsView` 里往下加（提及、分幕节奏、素材的统计），不要另起一个面板。

## 代码位置

```text
next/crates/dr-view-stats/src/
  lib.rs        init、flush、panel、load_progress、today_live
  panel.rs      统计标签（StatsView）
  model.rs      取哪一级、实时字数替换、今天、进度、数字分组（不依赖 GPUI）
  recorder.rs   写作日记录器：Tracker（纯逻辑）、Recorder（自己的线程）
  live.rs       LiveWords：编辑器报来的实时字数
  clock.rs      本机日历的今天
next/crates/dr-workspace/src/commands/stats.rs   book.word_counts、book.writing_days、writing_day.record
next/crates/dr-shell/src/workspace/sidebar.rs    RightTab::Stats（挂接）
```
