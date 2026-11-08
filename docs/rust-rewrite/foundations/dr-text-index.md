# dr-text 与派生器（dr-index）

2026-11-07，第一、二个里程碑。代码在 `next/crates/prose-metrics/`（字数规则）、`next/crates/dr-text/`（文字工具）和 `next/crates/dr-index/`（派生器），测量在 `next/crates/dr-testkit/src/bench/index.rs`。目标架构见 [README.md](../README.md) 里的 `dr-text`，派生索引的存法见 [f2-store.md](f2-store.md)「派生索引」，正文文档的读法见 [f1-model-doc.md](f1-model-doc.md)。

## 大白话

新版的大纲、字数、引用、搜索不再由编辑器推回去，而是存储层看着 Loro 的变化自己算（[simplifications.md](../simplifications.md) 第二节）。F2 留好了接入点「派生器」，这里把它做出来，连同它要用的文字工具：

1. **字数**：旧版的字数规则原样搬到 Rust，单独放在一个小 crate `prose-metrics` 里，和旧版一样用 Apache-2.0，不依赖任何 `dr-*`，以后独立的服务也能用。规则一字不改：汉字一个算一个字，其余按空白分开、含英文字母或数字的一段算一个词。用旧版 TypeScript 代码本身算出的 1545 个用例对拍，全部一致。
   - **唯一的故意差异**（监管会话已定）：旧版从编辑器的 JSON 里取文字时，在每个节点后面补一个空格，所以 hel**lo** 这种被加粗切开的英文词会数成两个。新版按真实文字数，算一个。对拍夹具里专门钉住了这两处差异。
2. **纯文本和大纲**：从正文文档读出纯文本，一段一行，给搜索、导出、帮手用；表格读成「格子之间一个制表符、行之间一个段内换行」。大纲取 H1、H2、H3 三级段落，三级同等对待，带块 ID；规则照旧版：标题去掉首尾空白，空标题不进大纲。
3. **派生器**：每篇正文算出每段一行（块 ID、段序、标题级别、纯文本）、人物链接和素材嵌入的引用、整篇和每段的字数，交给 dr-store 和版本号在同一个事务里写进去。
   - 作者打一个字之后，派生器直接读持有者手里那份文档（不复制），只看 Loro 告诉它的那一点改动，**只重读改到的那一段**，然后只把变了的那几行交给 dr-store（按段补丁），其余的行不动。
   - 拿不准的时候（改动太多、对不上），就整篇重读、整篇替换，结果一样。
4. **实时字数**（给 M07）：作者连续打字时持有者一直不空闲，索引要等停笔 750 ms 才更新。所以「本章字数」这类跟着编辑器走的读数不等索引：`dr_text::LiveCount` 按编辑器手上的段落一段一个数，改了哪段只重数哪段，规则和索引完全一样。全书、故事线的合计照旧读索引，只把正打开的那篇换成实时数。
5. **人物自动链接的匹配器**：给一本书的要素名、别名、章节和构想标题，在文字里找出该链接的位置：逐字、区分大小写、不看词边界、同一位置最长的名字优先、互不重叠。合并后两个要素同名时，只认保留名字的那个，不替作者猜。只找位置，不写回正文，给以后的 M12（人物链接）和导入后修断链用。
6. **测量**（heavy 种子：100 章 150 万字，连同要素、构想、素材笔记等共 680 篇、约 360 万字）：
   - **持有者上打一个字后的一次派生，连写入一共约 0.21 ms**（p95 0.69 ms），派生本身 0.05 ms。第一个里程碑是 17 ms，当时 13 ms 花在整篇重写这一章的索引行上，2–3 ms 花在复制文档给 dr-doc 读。现在在 1 ms 的按键写入预算以内。
   - **回车例外，约 3 ms**：多了一段，dr-store 要把这一章后面所有段的段序挪一遍，时间几乎全在这里，不在派生器（待协调 1）。
   - 打开库时全部重建约 1.7 秒；**每一类正文的字数和种子自己数的完全相等**（章节 1 500 000、构想 1 000 000、要素 500 000、素材笔记 500 000、故事线 60 000、分类 16 000）。
7. **定下的**：派生放在**提交之后、持有者空闲时、单独一个事务**（F2 现在的做法），不放进每次按键的提交事务里。挂上派生器后按键写入的耗时不变（中位数 0.041 ms，有没有派生器一样）。

**要作者定的事：没有。** 下面的取舍都写了理由。

## 里程碑状态

| # | 里程碑 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1.1 | 字数：照 `packages/prose-metrics` 移植，和 TS 版对拍；故意不复现「加粗切开的英文词算两个」 | 完成 | `prose-metrics/tests/ts_parity.rs`：1545 个用例（45 个手写边界 + 1500 个固定种子随机串），期望值由 TS 原版生成（`tests/fixtures/generate.mts`）；差异用例 2 个 |
| 1.2 | 纯文本与大纲：一段一行；H1/H2/H3 带块 ID | 完成 | `dr-text/src/tests.rs` |
| 1.3 | 派生器：段落 → `BlockRow`、人物链接与素材嵌入 → `RefRow`、大纲、字数；按 Loro 差异增量；和 `index_state` 同一事务；打开库时重建落后的 | 完成 | `dr-index/tests/incremental.rs`、`tests/library.rs`、`dr-import-v1/tests/index.rs` |
| 1.4 | 人物自动链接匹配器 | 完成（只找位置） | `dr-text/src/tests.rs`：旧版自己的用例、和旧版逐字扫描的属性对拍、书目里的优先级和重名 |
| 2.1 | 派生器直接读持有者的热文档（F1 的 `ProseReader::from_loro`、`paragraph_in`），只交改了的段（F2 的 `DerivedUpdate::Patch`）；重测按键后的一次派生 | 完成：打字 p50 0.21 ms | 3000 例属性测试（18 129 次按差异派生，每次都是补丁，补丁落到上一次的行上和整篇重读逐项相等，0 次退回）；真实持有者 120 步随机编辑（`patches_written_by_the_holder_keep_the_rows_right`）；[acceptance/dr-text-index-m2-index-bench.json](../acceptance/dr-text-index-m2-index-bench.json) |
| 2.2 | 基准换进 F8 的 `dr-testkit` bench 套件，语料用 heavy 种子；证据换新格式 | 完成 | `bench index`；CI 里快跑比形状（`bench --check`、`dr-testkit/tests/bench.rs`）；`cargo xtask evidence --check` |
| 2.3 | M07 的实时字数接口 | 完成 | `dr-text/src/tests.rs`（编辑器的段落拼接、表格、占位符、和索引合计相加；随机拼接的属性测试）；`dr-index` 的属性测试每一步核对实时字数等于索引字数 |

## 接口概览

```rust
// prose-metrics（Apache-2.0，不依赖 dr-*）
prose_metrics::count_words("她叫安娜。Hello") == 5;
prose_metrics::is_js_whitespace(c); prose_metrics::is_counted_ideograph(c);

// dr-text：在 dr-doc 的 ProseView 上读，不写文档
dr_text::plain_text(&view);                 // 一段一行，段内换行保留为 U+2028
dr_text::block_text(&view, &paragraph);     // 一段：表格读成格子，素材嵌入没有字
dr_text::paragraph_text(&p); dr_text::table_text(&embed);
dr_text::text_metrics(&text) -> TextMetrics { words, chars };
dr_text::outline(&view) -> Vec<OutlineItem { ord, block_id, heading, text, paragraphs_after }>;
dr_text::outline::OutlineBuilder            // 已经在逐段读的调用方边读边建
let m = LinkMatcher::new(book_link_names(&book_view, &[自己的实体 id]));
m.find(text) -> Vec<LinkMatch { range, name }>;   // 字符偏移
m.suggest(&prose_view) -> Vec<SuggestedLink { block, range, target }>; // 还没链上的

// dr-text：实时字数（M07）
let mut live = LiveCount::from_view(&view);   // 或 LiveCount::new(编辑器各段的文字)
for s in change_set.splices { live.splice(s.start, s.old, s.new); } // gpui-prose 的 LineSplice，按顺序
live.recount(|i| lines[i].text.clone());      // 只问被改过的段
live.total() -> TextMetrics;                  // 本章（本篇）
dr_text::with_live(book_stats, doc_stats_of_open_doc, live.total()); // 全书、故事线
dr_text::paragraph_metrics(line_text);        // 一段，占位符 U+FFFC 不算字符
dr_text::count_words(selected_text);          // 选区

// dr-index：dr-store 的派生器
let deriver = dr_index::attach(&mut library_options); // 同时挂上 dr-doc 的样式表
deriver.stats();   // 整篇读几次、按差异（补丁）几次、退回几次、重读几段、补丁写了几行
dr_index::derive_view(&prose_view) -> Derived; // 不经存储，整篇算一遍
```

## 设计与取舍

### 字数规则（`prose-metrics`）

- 规则就是旧版 `countWords`：U+3400–U+4DBF、U+4E00–U+9FFF 的汉字一个一个算；这些汉字、CJK 标点（U+3000–U+303F）和全角半角形式（U+FF00–U+FFEF）当作分隔；其余按空白分开，一段里有 ASCII 字母或数字才算一个词。
- **空白按 JavaScript 的 `\s` 算**，不是 Rust 的 `char::is_whitespace`：U+FEFF 算空白，U+0085 不算。这一条对拍里有专门的用例。
- 旧规则本来就**不数**的，照样不数：假名、谚文、西里尔、希腊等不含 ASCII 字母数字的段，扩展 B 以后的汉字和兼容汉字。要改是产品决定，不在移植里改。
- 实现是一遍扫过、不分配内存的状态机，和旧版「先替换再切分」等价（对拍证明）。
- **可加性**：段与段之间隔着换行（换行是空白），所以整篇的字数等于各段字数之和。派生器和实时字数都靠这一条按段缓存。
- **字符数**：纯文本的 Unicode 字符数，含空白，不含段落之间的换行和嵌入占位符。dr-store 的 `chars`（整篇）和 `BlockRow.chars`（每段）都是这个数。
- 对拍的期望值由 TS 原版本身算：`tests/fixtures/generate.mts` 直接 import `packages/prose-metrics/src/index.ts`，用 Node 22 自带的去类型运行，不需要装任何依赖；结果 `count-words.json` 作为夹具提交。旧客户端删掉以后夹具还在，测试照跑。

### 纯文本

- 一段的文字 = 它的各个片段连起来，去掉嵌入占位符（U+FFFC）；段内换行（U+2028）保留，所以一段永远是一行。
- 单独成段的嵌入：表格读成「同一行的格子之间一个制表符、行之间一个 U+2028」，行列按存的顺序；素材嵌入本身没有字（素材是另一篇文档）。
- 整篇 = 各段用 `\n` 连起来，最后不补换行。导出和帮手要别的格式时，在这之上再转。
- 搜索用的就是每段的这份文字，所以表格里的字也搜得到。

### 大纲

- 照旧版 `src/renderer/lib/outline.ts`：H1、H2、H3 三级，标题文字去掉首尾空白（按 JavaScript 的空白），空标题不进大纲；`paragraphs_after` 数到下一个进大纲的标题为止的段落数（正文段和嵌入算，标题和分隔线不算）。
- 块 ID 用读者看到的那个（重复的块 ID 在修复前只有第一段有）。
- dr-store 的 `Library::outline` 已经照这条规则查（F2 第三轮）；bench 的 `outline` 一项每次都核对它和 `dr_text::outline` 一致。

### 派生器（`dr-index`）

**输入输出对应：**

| dr-store 要的 | 从哪来 |
| --- | --- |
| `BlockRow.block_id` | 段落存的块 ID；整篇里重复的，只有第一段保留（dr-doc 的读取规则） |
| `BlockRow.heading` | 0 是正文段，1–3 是 H1–H3。空标题也是标题（排版高度要用），只是不进大纲 |
| `BlockRow.text` / `chars` | 上面的纯文本和字符数 |
| `RefRow`（`link`） | 每段每个目标一行，`count` 是这一段里链到它的分开的几处（相邻的同一目标算一处，和 dr-doc 一致）；`target_kind` 是链接里的种类（`element`、`node`……） |
| `RefRow`（`embed`） | 素材嵌入：`target_kind = material`，目标是素材 id。表格不算引用 |
| `RefRow`（`mention`） | 没做：派生器看不到书里的名字，见待协调 5 |
| `Derived.words` / `chars` | 各段之和 |
| 书目文档、正文模板 | 交一份空的结果：书目文档没有段落；正文模板（`template:category:<id>` / `template:storyline:<id>`）不是书的正文（F1 的 `DocKind::is_book_text()`），不进搜索、大纲、字数、引用和待办。两种都记成「已索引」，免得每次打开都被当成落后的重读一遍。这条规则加进来以前已经索引过的模板（只有 `next/` 开发库里有），下次改它时行才清掉（M10 第六个里程碑先在派生器里补上，dr-text 审过并把待办也排除了）|

**读文档：** dr-store 交来的 `LoroDoc` 用 dr-doc 的 `ProseReader::from_loro` 原地读，不复制、不写。持有者那里读的是它手里的热文档；后台重建读的是 dr-store 从 SQLite 载入的副本。

**按差异增量：**

- 派生器给每篇打开的文档记住上一次每段的结果（每段的长度、存的块 ID、标题、文字、字数、链接），以及每段是否保住了自己的块 ID、整篇的引用。
- 拿到 Loro 的差异后，把上一次的各段看成正文上一串连续的片段，按差异逐条改这串片段：保留的照旧、改了样式的标成「脏」、插入的是脏的、删掉的拿走。差异是 Quill 式的保留、插入、删除，按 Unicode 字符，按提交顺序一条条套上去。
- 套完以后，正好还是旧的某一整段、一个字没动的，直接沿用；其余的只扫一遍脏的那几段文字找换行，定出新的段落边界，再用 dr-doc 的 `paragraph_in` 读这几段（它不看这一段前面的内容，在章末读和在章首读一样快）。打一个字只读一段。
- 嵌入表（表格格子、素材绑定）有变化时，所有嵌入段都重读一遍（它们很少）。
- **退回整篇重读**：差异条目超过 4096 条、要重读超过一半的段（至少 32 段），或者套完的总长度和文档对不上。退回的结果和增量的一样，只是交整篇替换。3000 例属性测试里没有一次退回。

**按段补丁：** 增量的结果直接变成 F2 的 `DerivedPatch`：

- 沿用的段，行原样不动；只有一种例外：块 ID 的「重复的只认第一段」变了结论（前面多了或少了一段同 ID 的），这一段的行也要重写。
- 两段不动的行之间，变了的连成一个拼接（`Splice`：从第几段起、删几行、换上哪几行）；一次改动可以有好几个拼接。拼接两头要是有重读了但结果没变的段（只改了样式、文字没变；嵌入表变了但这个表格没变），就从拼接里剪掉。
- 引用变了才整份交（一篇的引用很少），没变就不交；整篇的字数、字符数每次都交。
- 什么都没变（比如加粗了一段又取消），也交一个空补丁，让 dr-store 把 `indexed_seq` 往前推。

**补丁只落在它出自的那份行上**：补丁是相对派生器上一次交出去的结果算的。dr-store 写补丁前核对存着的段数，对不上就报 `IndexBase`，持有者下一次让派生器从头整篇算。其余的情形：

- 持有者每次打开、或者上一次写失败，下一次给派生器的差异都是「没有」（`changes: None`），派生器一律整篇读、整篇替换，并重新记住结果。所以只有同一个持有者上一次派生顺利交出去以后，才会有补丁。
- 后台重建的副本（`DeriveInput.held = false`）读一次就丢，不进缓存，也不会挤掉打开着的文档。
- 后台重建和持有者恰好同时写同一篇：dr-store 按 seq 只认新的；seq 相同时两边是同一个版本，派生结果逐项相同（派生是确定的），所以补丁的基底还是对的。
- 缓存按（文档 id，Loro 对等方）存。对等方区分两个共用一个派生器的库里同 id 的文档（测试里会这样）。另外还核对文档的版本向量包含缓存的版本、套完的总长度等于文档长度。
- 缓存最多 32 篇（每篇大约是一份正文纯文本，2 万字章约 60 KB），超出时丢最久没用的；丢了只是下次整篇读、整篇替换。

**什么时候派生（测完定的）：**

- 放在**提交之后、持有者空闲时（默认 750 ms 没有新消息）、单独一个事务**，就是 F2 现在的做法。不放进每次按键的提交事务：打字后一次派生加写入约 0.21 ms，放进去会让按键写入（0.041 ms）慢五倍，换来的只是派生数据早 750 ms。
- 挂上派生器以后，按键写入本身不变：差异只是在内存里攒着。2000 次按键的中位数有无派生器都是 0.041 ms。
- **代价**：派生在持有者线程上跑，这时恰好来的按键要等它跑完：打字后 0.21 ms，回车后约 3 ms（dr-store 挪段序，待协调 1）。都在一帧以内。
- 连续打字时持有者一直不空闲，索引会落后到作者停下来为止。界面上的实时读数用下面的 `LiveCount`，不等索引。空闲等待现在和压缩共用一个 750 ms；派生已经足够便宜，要让搜索、大纲更跟手，可以给它单独一个更短的等待（待协调 2）。

**打开库时重建：** dr-store 打开库时在后台把 `loro_head.seq > index_state.indexed_seq` 的文档全部交给派生器重算（这时没有差异，整篇读、整篇替换）。M10 导入的书一开始没有索引，第一次打开就全部建好。

### 实时字数（`dr_text::live`，给 M07）

M07 的两个读数里，跟着编辑器走的那个按「选区 → 本章或本篇构想 → 故事线 → 全书」取最具体的一级。各级从哪来：

| 级 | 从哪来 |
| --- | --- |
| 选区 | `count_words(选中的文字)`：跨段的选区，段与段之间放一个换行 |
| 本章、本篇构想（打开着的） | `LiveCount`：编辑器手上的段落，一段一个数 |
| 故事线、全书 | 索引的合计（`book_stats`、各章的 `doc_stats`）；打开着的那篇在其中时，用 `with_live` 把它的索引数换成实时数 |

`LiveCount` 的用法和 gpui-prose 的段落镜像一致：镜像每处理一个 Loro 事件，给出一串 `LineSplice`（第几段起、旧的几段变成新的几段，段内打字是「一段变一段」）。按顺序把它们交给 `splice`，被换上的段先记成「待数」；然后 `recount` 只问这些段现在的文字，数完加进合计。打一个字只数一段。

- **和索引的数一致**：规则同一个（`text_metrics`），按段相加，嵌入占位符不算字符。表格那一段要把表格的文字（`table_text`）交给它，因为索引数的是格子里的字；只是一个占位符的话表格的字就漏了。`LiveCount::from_view` 直接从 dr-doc 的文档建，和索引逐字一样（dr-index 的属性测试每一步都核对）。
- **为什么是结构和文字分两步**：一个事件可能带好几个拼接，后一个拼接用的是前一个之后的段号；事后拿到的只有最终的段落。先只改结构、最后统一按最终文字数，就不用知道每一步中间的文字。gpui-prose 的镜像本身也是这么处理属性的。
- **合计**：全书、故事线不在界面里重新数，读索引；打开的那篇索引可能落后几百毫秒，用 `with_live(合计, 这篇的索引数, 这篇的实时数)` 补上。这篇还没有索引行（刚新建）时，索引数传 0。

### 人物自动链接匹配器

旧版的规则（`crates/drifting-document/src/entity_links.rs`、`src/renderer/lib/entity-link-names.ts`），保留的：

- 名字逐字匹配：区分大小写，不看词边界；
- 同一位置最长的名字优先，结果互不重叠，从左往右（Aho–Corasick 的 leftmost-longest）。属性测试拿它和旧版的逐字扫描对拍；
- 同一个名字给了两次，后给的生效（旧版的 JavaScript `Map`），所以章节和构想标题排在要素名后面，和要素同名时链到章节；
- 文档不链自己，补丁不链它所属的要素（`exclude` 参数）。

故意改了的：

- 名字先去掉首尾空白，空的忽略。旧版只忽略空字符串，一个全是空格的名字会匹配所有连续空格。
- 两个还在的要素合并后同名（dr-doc 给后建的那个标 `name_conflict`）：这个名字只链到保留名字的那个，后建的那个只用它独有的名字。自动链接不替作者在两个人之间猜。
- 在整段文字上找，不按样式片段切开找：名字一半加粗也认得出（和字数按真实文字数是同一个道理）。

`suggest` 列出还没链上的位置：已经整段都链到同一个目标的跳过；链到别的目标的照样建议（不同目标的链接可以重叠，比如「安娜·卡列尼娜」和其中的「卡列尼娜」）。不写回正文。

## 测量

`cargo run --release -p dr-testkit --bin bench -- index`，M3 Pro（12 核，36 GB），release，Loro 1.17.1，2026-11-07，测的时候一分钟负载 6.4（机器上别的会话在编译）。完整数字在 [acceptance/dr-text-index-m2-index-bench.json](../acceptance/dr-text-index-m2-index-bench.json)。语料是 F8 的 heavy 种子（`dr_testkit::seed`，默认随机种子）：100 章 150 万字（每章 2 千到 2 万字）、300 个要素、200 个构想、60 篇素材笔记、3 条故事线、16 个分类，共 680 篇文档、23 212 段、约 360 万字，全是合成的。

| 项 | p50 | p95 | 说明 |
| --- | ---: | ---: | --- |
| **持有者上打一个字后的一次派生，连写入** | **0.21 ms** | 0.69 ms | 最长的一章（22 857 字、174 段），950 次；第一个里程碑是 17.1 ms |
| 其中派生本身（读热文档、重读一段、算补丁） | 0.050 ms | 0.086 ms | 1000 次全部走补丁，平均每次重读 1.05 段、补丁写 1.05 行 |
| 回车后的一次派生，连写入 | 3.1 ms | 9.7 ms | 50 次；时间在 dr-store 挪后面各段的段序（待协调 1） |
| dr-store 写这一章的索引：整篇替换 | 9.2 ms | 15.6 ms | 删掉重写 174 行和它们的全文索引 |
| dr-store 写这一章的索引：一行的补丁 | 0.11 ms | 0.20 ms | |
| 这一章整篇派生（原地读热文档） | 0.86 ms | 1.25 ms | 退回整篇时的代价 |
| 按键写入，有 / 无派生器 | 0.041 / 0.041 ms | 0.075 / 0.079 ms | 2000 次；派生不拖慢提交 |
| 打开库时全部重建（680 篇） | 1.69 s | — | 每篇从 SQLite 载入后的派生 p50 0.17 ms、p95 2.7 ms |
| 每类正文的字数 vs 种子自己数的 | 六类全部相等 | — | 章节 1 500 000、构想 1 000 000、要素 500 000、素材笔记 500 000、故事线 60 000、分类 16 000；不等时 bench 直接失败 |
| 大纲（这一章，13 个标题） / 全书合计 | 0.020 / 0.11 ms | 0.032 / 0.14 ms | 大纲和 `dr_text::outline` 逐项一致 |
| 全书搜索 1 / 2 / 3 / 8 个字，取 50 条 | 3.9 / 4.4 / 0.25 / 0.11 ms | 4.4 / 5.1 / 0.37 / 0.22 ms | 1–2 字走 `LIKE`，3 字以上走 FTS5 三元组；查询字取自这一章 |
| 同上，取 10 000 条（`book.search` 现在的取法） | 13.6 / 12.6 / 0.82 / 0.11 ms | — | 这几个查询词命中不多；命中多的见下文，待协调 3 |
| 同上，按章节顺序取 50 条（`search_in_order`） | 16.5 / 13.4 / 1.9 / 0.20 ms | — | 待协调 3 |

同一程序在负载 14–18 时又跑了三轮：打字后的一次派生 p50 0.20–0.28 ms，回车 3.2–3.4 ms，重建 1.6–2.7 s，长尾随负载变长。

怎么读这些数字：

- **按键后的派生现在可以不管了**：0.21 ms 里派生本身只占四分之一，其余是 dr-store 写一行补丁和持有者线程收发消息。离 1 ms 的按键预算还有余量。
- **回车是剩下唯一贵的**，而且贵在存储的段序是连续编号：插一段，后面每一行都要改编号（为了不撞唯一约束，还要改两遍）。一章 174 段平均挪 87 行，约 3 ms。只在作者敲回车时发生，一帧以内，但比按键预算高。
- **全书重建在后台**，1.7 秒只发生在第一次打开导入的书、或者从没有派生器的版本升级上来时；平时打开库没有落后的文档，什么都不做。
- **字数和种子相等**：种子按「一个汉字一个词、标点不算」数，它的语料里没有拉丁字母，所以和产品规则的结果应当一样。真实书稿里含英文的章节，新版可能比旧版略少（每个被加粗、斜体或链接切开的英文词少算一个）。和 0.1 原版逐篇相等的核对在 `dr-import-v1/tests/index.rs`（M10 导入的 0.1 合成库；原来是 dr-index 的 `tests/m10.rs`）和 `prose-metrics` 的对拍里。
- **搜索慢在一次取太多**：dr-store 先把全部命中排好序，再给取回的每一条切一段片段，所以命中越多、取得越多就越慢。上表 1–2 个字只取 50 条约 4 ms，取 1 万条 13–14 ms。换成 F8 测 `book.search` 用的查询词另测了一次（负载约 6，没进证据）：「灯塔亮」7340 条命中，取 1 万条 38 ms、取 50 条 4.2 ms；「灯」取 1 万条 30 ms、取 50 条 0.11 ms。F8 量到的 `book.search` 是 47 / 33 ms，所以大头就是这一步（待协调 3）。

## 测试

在 `next/` 下：

| 测试 | 内容 |
| --- | --- |
| `cargo test -p prose-metrics` | 文档里的规则用例；段落可加；和 TS 原版对拍 1545 例；故意差异 2 例 |
| `cargo test -p dr-text` | 纯文本（表格、素材嵌入、占位符）、字数可加和加粗切开的词、三级大纲（空标题、去空白、`paragraphs_after`）、匹配器（旧版自己的用例、最长优先、不重叠、名字去空白和后者生效、已链接的跳过、书目里的优先级和重名）、匹配器和旧版逐字扫描的属性对拍；实时字数（编辑器的段落拼接、只重数改过的段、表格按格子数、占位符不算字符、和索引合计相加），随机拼接后和重新数一遍相等的属性测试 |
| `cargo test -p dr-index --test incremental` | 属性测试：随机打字、回车、粘贴多段、跨段删除、设标题、加粗、加减人物链接、插表格和改格子、插素材嵌入、把一段的块 ID 抄到另一段（造出重复 ID）、撤销、第二台设备的编辑合并进来（含随后的块 ID 修复）。每一步：派生器交的补丁落到上一次的行上，和整篇重读逐项相等；实时字数等于索引字数；按差异派生的每一次都是补丁。故意改坏四处（样式变化不标脏、嵌入变化不重读、重复 ID 翻转不重写、拼接剪尾多剪一行）都能抓到。另有「普通编辑必须走增量」「打一个字补一行、回车一行变两行」「差异只套在同一份文档上次的结果上，后台副本、另一个库里同 id 的文档都搅不乱它」 |
| `cargo test -p dr-index --test library` | 真实 dr-store：持有者空闲时按差异派生，字数、大纲、1 字和 4 字搜索、人物链接和素材嵌入的引用都对；120 步随机编辑（打字、回车、跨段删除、标题、链接）每一步由 dr-store 写补丁后，段长、字数、引用、大纲和整篇重读一致，最后每一段都搜得到；没有派生器时写的库，换有派生器的版本打开后重建；书目文档记成已索引；两种正文模板记成已索引但是空的（搜不到、零字、没有大纲和引用） |
| `cargo test -p dr-index --test m10` | M10 自己的合成 0.1 库导入真实 dr-store，打开后重建：7 篇全部索引，每篇字数等于 dr-doc 读出来算的，`book_stats` 等于各篇之和，大纲带旧块 ID，2 字和 3 字搜索、旧版人物链接和素材嵌入的引用都在 |
| `cargo test -p dr-testkit --test bench` | 每个基准套件用 tiny 种子快跑一遍，形状不变（`index` 套件：20 篇全部重建、六类字数等于种子、40 次按键全部走补丁、0 次退回、大纲一致） |

`DR_PROP_CASES=3000 cargo test --release -p dr-index --test incremental` 跑 3000 例（默认 200 例）。

## 待协调

已经由别的基座补上的（第一个里程碑提的）：F1 的 `ProseReader::from_loro` 和 `paragraph_in`，F2 的按段补丁、`DeriveInput.held`、按 dr-text 规则的大纲查询。测量语料也换成了 F8 的种子。

1. **dr-store（F2）：插段、删段时不要挪后面所有行的段序。** 回车后的一次派生约 3 ms（p95 9.7 ms），时间在 `write_patch` 把拼接后面每一行的 `ord` 先加一个大数再减回来（两遍 `UPDATE`，为了不撞 `UNIQUE (doc_id, ord)`）。办法举两个：`ord` 留空隙（比如间隔 2^20，插入取中间值，空隙用完才重新编号），或者去掉唯一约束、一条 `UPDATE` 挪一遍。读的时候按 `ord` 排序就不变，只是段序不再等于第几段，`SearchHit.ord` 这类要按行号另算。
2. **dr-store：派生单独一个空闲等待。** 现在派生和压缩共用 750 ms 的空闲等待。派生已经只要 0.2 ms，可以给它一个短得多的等待（比如 150 ms），让搜索、大纲更跟手；压缩照旧 750 ms。小事。
3. **dr-workspace（F3）：换用 `dr_index::attach`，搜索少取一些。**
   - dr-workspace 还在用自己的替身派生器（`src/deriver.rs`）：字数规则和产品不一样（把假名、谚文也算字，非 ASCII 的字母连成的段也算词），每次导出快照再冷读，每次整篇替换，不做素材嵌入的引用，书目文档不记成已索引（每次打开都当落后的）。换成 `dr_index::attach(&mut options)` 一行就够，`count_words` 的替身也可以删掉。
   - （已解决）`book.search` 一次要 1 万条命中的问题：F3 第二个里程碑改成按 `limit` 取，F2 第四轮让按书序搜索 1–2 个字够数就停；M06 的实测见 [m06-search.md](../modules/m06-search.md)。
4. **dr-store：删掉只为旧基准留着的两个模块。** `dr_store::synthetic` 和 `dr_store::evidence` 只有 dr-index 的旧基准例子还在用，例子已经删了，可以一起删掉（f2-store.md 里也记着这件事）。
5. **「提及」引用（`RefKind::Mention`）没做。** 派生器只看得到这一篇正文，看不到书里的要素名。要做的话，要么 `DeriveInput` 带上书的名字表（书目文档变了就要重算全书），要么由 M12 / M20 在书这一层另算一遍。等 M20（统计面板的「提及的出与入」）开工时定。
6. **书目文档里的文字进不进搜索：M06 定了（2026-11-08）。** 标题、梗概、素材说明、要素补丁进，批注不进；这些短字段由 F3 的 `book.search` 在查询时直接扫书目文档，不进 `block_index`，派生器对书目文档照旧交空结果。见 [m06-search.md](../modules/m06-search.md)。
7. **断行**：照 F4 的计划，`gpui_prose::layout::linebreak` 拆成一个只依赖 ICU4X 的宽松许可小 crate 以后，dr-text 再依赖它。
8. **M07**：实时字数用 `LiveCount`（见上文「实时字数」）。表格那一段要交表格的文字，不然字数会比索引少。
9. **dr-testkit（F8）：登记一个新套件，别的套件的证据全变过期。** 新套件要在 `bench.rs` 的 `suites()` 里登记，而 `bench.rs` 是所有套件证据的公共输入。这次登记 `index` 以后，`f1-m3-doc-bench`、`f8-m1-store-bench`、`f8-m2-workspace-bench` 都报过期（`f8-m2-workspace-bench` 只是因为这一处）。建议把登记表挪到不算公共输入的文件里，公共输入只留约定本身。

## 下一个里程碑建议

1. 待协调 1 补上以后重测回车（目标和打字一样在 1 ms 以内）；F3 换上 `dr_index::attach` 以后，bench 的 `workspace` 套件里搜索和字数就是产品的数。
2. M12 用匹配器做编辑器里的自动链接，和导入后的断链修复（旧版留下的、一个名字被样式或编辑切成两段链接的那种）。
3. M06 在 `Library::search` 上做分组和按书序排序（待协调 3）。

## 代码位置

```text
next/crates/prose-metrics/          Apache-2.0：LICENSE、NOTICE
  src/lib.rs                        count_words 及其字符分类
  tests/ts_parity.rs                对拍；tests/fixtures/{generate.mts,count-words.json}
next/crates/dr-text/src/
  plain.rs metrics.rs outline.rs autolink.rs live.rs tests.rs
next/crates/dr-index/
  src/lib.rs                        TextDeriver、缓存、attach
  src/source.rs                     原地读 dr-store 的文档（from_loro）
  src/paragraphs.rs                 一段的派生数据，整篇的行和引用
  src/incremental.rs                按差异更新：哪些段沿用、哪些重读
  src/patch.rs                      增量结果 → dr-store 的按段补丁
  tests/{incremental,library,m10}.rs
next/crates/dr-testkit/src/bench/index.rs   测量（bench 的 index 套件）
docs/rust-rewrite/acceptance/dr-text-index-m2-index-bench.json
```

## 怎么复现

```bash
# 对拍夹具（在仓库根，Node 22 起，不需要装依赖）
node --experimental-strip-types next/crates/prose-metrics/tests/fixtures/generate.mts

# 测试（在 next/）
cargo test -p prose-metrics -p dr-text -p dr-index
DR_PROP_CASES=3000 cargo test --release -p dr-index --test incremental

# 测量（在 next/）：结果打到屏幕；加 --milestone 写成证据
cargo run --release -p dr-testkit --bin bench -- index
cargo run --release -p dr-testkit --bin bench -- index --milestone dr-text-index-m2
cargo run -p dr-testkit --bin bench -- --check     # 快跑比形状（CI）
```
