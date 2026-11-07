# dr-text 与派生器（dr-index）

2026-11-07，第一个里程碑。代码在 `next/crates/prose-metrics/`（字数规则）、`next/crates/dr-text/`（文字工具）和 `next/crates/dr-index/`（派生器）。目标架构见 [README.md](../README.md) 里的 `dr-text`，派生索引的存法见 [f2-store.md](f2-store.md)「派生索引」，正文文档的读法见 [f1-model-doc.md](f1-model-doc.md)。

## 大白话

新版的大纲、字数、引用、搜索不再由编辑器推回去，而是存储层看着 Loro 的变化自己算（[simplifications.md](../simplifications.md) 第二节）。F2 留好了接入点「派生器」，这一轮把它做出来，连同它要用的文字工具：

1. **字数**：旧版的字数规则原样搬到 Rust，单独放在一个小 crate `prose-metrics` 里，和旧版一样用 Apache-2.0，不依赖任何 `dr-*`，以后独立的服务也能用。规则一字不改：汉字一个算一个字，其余按空白分开、含英文字母或数字的一段算一个词。用旧版 TypeScript 代码本身算出的 1545 个用例对拍，全部一致。
   - **唯一的故意差异**（监管会话已定）：旧版从编辑器的 JSON 里取文字时，在每个节点后面补一个空格，所以 hel**lo** 这种被加粗切开的英文词会数成两个。新版按真实文字数，算一个。对拍夹具里专门钉住了这两处差异。
2. **纯文本和大纲**：从正文文档读出纯文本，一段一行，给搜索、导出、帮手用；表格读成「格子之间一个制表符、行之间一个段内换行」。大纲取 H1、H2、H3 三级段落，三级同等对待，带块 ID；规则照旧版：标题去掉首尾空白，空标题不进大纲。
3. **派生器**：每篇正文算出每段一行（块 ID、段序、标题级别、纯文本）、人物链接和素材嵌入的引用、整篇和每段的字数，交给 dr-store 和版本号在同一个事务里写进去。作者打一个字之后，派生器只看 Loro 告诉它的那一点改动，**只重读改到的那一段**（一般就一段），其余照搬上一次的结果。拿不准的时候（改动太多、对不上），就整篇重读，结果一样。
4. **人物自动链接的匹配器**：给一本书的要素名、别名、章节和构想标题，在文字里找出该链接的位置：逐字、区分大小写、不看词边界、同一位置最长的名字优先、互不重叠。合并后两个要素同名时，只认保留名字的那个，不替作者猜。这一轮只找位置，不写回正文，给以后的 M12（人物链接）和导入后修断链用。
5. **测量**：
   - 用 M10 导入 0.1 的 stress 合成库（100 章 150 万字，连同 300 个要素、200 个构想、60 篇素材笔记，共 680 篇文档、约 390 万字），打开时重建全部派生索引约 1.5 秒；**每一类正文的字数和 0.1 种子自己用旧版规则算的数完全相等**（章节 1 500 000、构想 1 000 000、要素 500 000、素材笔记 500 000、故事线 60 000、分类 16 000）。导入的书有了搜索、大纲和字数。
   - 100 章 150 万字的合成书，全书重建约 1.1 秒。
   - 打一个字之后，增量派生本身约 0.15 ms。但今天持有者上走完一次要约 17 ms：13 ms 花在 dr-store 把这一章的索引行整篇删掉重写（全文搜索的三元组要重新切），约 2–3 ms 花在把文档复制一份给 dr-doc 读、再冷读一遍（dr-doc 还不能直接读 dr-store 手里的文档）。两处都要别的基座加一个小接口（待协调 1、2）；按段写只要约 0.12 ms，加上以后一次派生约 0.3 ms。
6. **定下的**：派生放在**提交之后、持有者空闲时、单独一个事务**（F2 现在的做法），不放进每次按键的提交事务里。挂上派生器后按键写入的耗时不变（中位数 0.037 ms，有没有派生器一样）。

**要作者定的事：没有。** 下面的取舍都写了理由。

## 里程碑状态

| # | 里程碑 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 字数：照 `packages/prose-metrics` 移植，和 TS 版对拍；故意不复现「加粗切开的英文词算两个」 | 完成 | `prose-metrics/tests/ts_parity.rs`：1545 个用例（45 个手写边界 + 1500 个固定种子随机串），期望值由 TS 原版生成（`tests/fixtures/generate.mts`）；差异用例 2 个 |
| 2 | 纯文本与大纲：一段一行；H1/H2/H3 带块 ID | 完成 | `dr-text/src/tests.rs` |
| 3 | 派生器：段落 → `BlockRow`、人物链接与素材嵌入 → `RefRow`、大纲、字数；按 Loro 差异增量；和 `index_state` 同一事务；打开库时重建落后的 | 完成（写入仍是整篇替换，待协调 2） | `dr-index/tests/incremental.rs`（3000 例属性测试：17 913 次按差异派生，和整篇重读逐项相等，0 次退回）、`tests/library.rs`（真实持有者）、`tests/m10.rs`（M10 导入的合成库） |
| 4 | 人物自动链接匹配器 | 完成（只找位置） | `dr-text/src/tests.rs`：旧版自己的用例、和旧版逐字扫描的属性对拍、书目里的优先级和重名 |
| 5 | 测量：heavy 全书重建、按键后增量、M10 导入的库 | 完成 | [acceptance/dr-text-index-m1.json](../acceptance/dr-text-index-m1.json)，见下文「测量」 |
| 6 | 证据按第五节的轻做法 | 完成 | 契约类的都在 `cargo test` 里当场算；测量一份 JSON，带指纹，源码变了只报过期（`dr-index/tests/evidence.rs`） |

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

// dr-index：dr-store 的派生器
let deriver = dr_index::attach(&mut library_options); // 同时挂上 dr-doc 的样式表
deriver.stats();                            // 整篇读了几次、按差异几次、退回几次
dr_index::derive_view(&prose_view) -> Derived; // 不经存储，整篇算一遍
```

## 设计与取舍

### 字数规则（`prose-metrics`）

- 规则就是旧版 `countWords`：U+3400–U+4DBF、U+4E00–U+9FFF 的汉字一个一个算；这些汉字、CJK 标点（U+3000–U+303F）和全角半角形式（U+FF00–U+FFEF）当作分隔；其余按空白分开，一段里有 ASCII 字母或数字才算一个词。
- **空白按 JavaScript 的 `\s` 算**，不是 Rust 的 `char::is_whitespace`：U+FEFF 算空白，U+0085 不算。这一条对拍里有专门的用例。
- 旧规则本来就**不数**的，照样不数：假名、谚文、西里尔、希腊等不含 ASCII 字母数字的段，扩展 B 以后的汉字和兼容汉字。要改是产品决定，不在移植里改。
- 实现是一遍扫过、不分配内存的状态机，和旧版「先替换再切分」等价（对拍证明）。
- **可加性**：段与段之间隔着换行（换行是空白），所以整篇的字数等于各段字数之和。派生器靠这一条按段缓存。
- **字符数**：纯文本的 Unicode 字符数，含空白，不含段落之间的换行。dr-store 的 `chars`（整篇）和 `BlockRow.chars`（每段）都是这个数。
- 对拍的期望值由 TS 原版本身算：`tests/fixtures/generate.mts` 直接 import `packages/prose-metrics/src/index.ts`，用 Node 22 自带的去类型运行，不需要装任何依赖；结果 `count-words.json` 作为夹具提交。旧客户端删掉以后夹具还在，测试照跑。

### 纯文本

- 一段的文字 = 它的各个片段连起来，去掉嵌入占位符（U+FFFC）；段内换行（U+2028）保留，所以一段永远是一行。
- 单独成段的嵌入：表格读成「同一行的格子之间一个制表符、行之间一个 U+2028」，行列按存的顺序；素材嵌入本身没有字（素材是另一篇文档）。
- 整篇 = 各段用 `\n` 连起来，最后不补换行。导出和帮手要别的格式时，在这之上再转。
- 搜索用的就是每段的这份文字，所以表格里的字也搜得到。

### 大纲

- 照旧版 `src/renderer/lib/outline.ts`：H1、H2、H3 三级，标题文字去掉首尾空白（按 JavaScript 的空白），空标题不进大纲；`paragraphs_after` 数到下一个进大纲的标题为止的段落数（正文段和嵌入算，标题和分隔线不算）。
- 块 ID 用读者看到的那个（重复的块 ID 在修复前只有第一段有）。
- dr-store 的 `Library::outline` 现在按 `heading > 0` 直接查行，空标题也会列出来、文字也没去空白，见待协调 3。

### 派生器（`dr-index`）

**输入输出对应：**

| dr-store 要的 | 从哪来 |
| --- | --- |
| `BlockRow.block_id` | 段落存的块 ID；整篇里重复的，只有第一段保留（dr-doc 的读取规则） |
| `BlockRow.heading` | 0 是正文段，1–3 是 H1–H3。空标题也是标题（排版高度要用），只是不进 dr-text 的大纲 |
| `BlockRow.text` / `chars` | 上面的纯文本和字符数 |
| `RefRow`（`link`） | 每段每个目标一行，`count` 是这一段里链到它的分开的几处（相邻的同一目标算一处，和 dr-doc 一致）；`target_kind` 是链接里的种类（`element`、`node`……） |
| `RefRow`（`embed`） | 素材嵌入：`target_kind = material`，目标是素材 id。表格不算引用 |
| `RefRow`（`mention`） | 没做：派生器看不到书里的名字，见待协调 6 |
| `Derived.words` / `chars` | 各段之和 |
| 书目文档 | 交一份空的结果：书目文档没有段落，但记成「已索引」，免得每次打开都被当成落后的重读一遍 |

**按差异增量：**

- 派生器给每篇打开的文档记住上一次每段的结果（每段的长度、存的块 ID、标题、文字、字数、链接）。
- 拿到 Loro 的差异后，把上一次的各段看成正文上一串连续的片段，按差异逐条改这串片段：保留的照旧、改了样式的标成「脏」、插入的是脏的、删掉的拿走。差异是 Quill 式的保留、插入、删除，按 Unicode 字符，按提交顺序一条条套上去。
- 套完以后，正好还是旧的某一整段、一个字没动的，直接沿用；其余的只扫一遍脏的那几段文字找换行，定出新的段落边界，再从文档里读这几段。打一个字只读一段。
- 嵌入表（表格格子、素材绑定）有变化时，所有嵌入段都重读一遍（它们很少）。
- **退回整篇重读**：差异条目超过 4096 条、要重读超过 24 段（每读一段都要扫它前面的块 ID，见待协调 1），或者套完的总长度和文档对不上。退回的结果和增量的一样，只是慢一点。3000 例属性测试里没有一次退回。
- **缓存认人**：缓存按（文档 id，Loro 对等方）存。持有者手里的文档用的是本机的设备对等方，后台重建临时载入的副本是随机对等方，所以差异只会套在同一份文档上次的结果上。测试 `a_cache_entry_is_only_used_for_its_own_document` 钉住了「后台副本先算、持有者的差异后到」这种交错。另外还核对文档的版本向量包含缓存的版本、套完的总长度等于文档长度。
- 缓存最多 32 篇（每篇大约是一份正文纯文本，2 万字章约 60 KB），超出时丢最久没用的；丢了只是下次整篇读。
- **一个库一个派生器**：缓存不跨库共享。

**读 dr-store 手里的文档：** dr-store 交给派生器的是一个裸的 `LoroDoc`，而 dr-doc 只通过自己的类型读正文，没有「包一个现成的 `LoroDoc`」的构造。所以现在先导出一份快照、载入成 dr-doc 的只读副本再读（M10 的工具也这么做）。代价见「测量」：2 万字章复制约 0.45 ms；副本是冷的，第一次读要解码整章，整篇读约 2 ms，热文档只要 0.43 ms。dr-doc 加一个构造就能去掉（待协调 1），换的时候只改 `dr-index/src/source.rs` 一个函数。

**什么时候派生（测完定的）：**

- 放在**提交之后、持有者空闲时（默认 750 ms 没有新消息）、单独一个事务**，就是 F2 现在的做法。不放进每次按键的提交事务：今天一次要约 17 ms，按键写入的预算是 1 ms；即使两个接口都补上（约 0.3 ms），也会让每次按键的写入翻几倍，换来的只是派生数据早 750 ms。
- 挂上派生器以后，按键写入本身不变：差异只是在内存里攒着。2000 次按键的中位数有无派生器都是 0.037 ms。
- **代价**：派生在持有者线程上跑，这时恰好来的按键要等它跑完。今天是 17 ms（p95 约 21 ms），比一帧长；而且 dr-store 写索引时拿着全库唯一的写连接，别的文档这时的写入也要排队。所以待协调 2（按段写）是这一路最要紧的一件，补上以后整件事约 0.3 ms，就不成问题了。
- 连续打字时持有者一直不空闲，索引会落后到作者停下来为止。界面上「本章字数」这类实时读数不要等索引，由 M07 直接拿 `dr_text::count_words` 数编辑器手上的段落（待协调 5）。

**打开库时重建：** dr-store 打开库时在后台把 `loro_head.seq > index_state.indexed_seq` 的文档全部交给派生器重算（这时没有差异，整篇读）。M10 导入的书一开始没有索引，第一次打开就全部建好。

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

`suggest` 列出还没链上的位置：已经整段都链到同一个目标的跳过；链到别的目标的照样建议（不同目标的链接可以重叠，比如「安娜·卡列尼娜」和其中的「卡列尼娜」）。这一轮不写回正文。

## 测量

M3 Pro（12 核，36 GB），release，Loro 1.17.1，2026-11-07。完整数字和机器负载在 [acceptance/dr-text-index-m1.json](../acceptance/dr-text-index-m1.json)。语料全是合成的：本程序的章节由 dr-store 的固定字池组段、每 15 段一个标题（H1、H2、H3 轮流）、每章 100 处人物链接；M10 那一项是 0.1 的 `stress` 种子经 M10 导入的库。

| 项 | 结果 | 说明 |
| --- | ---: | --- |
| 2 万字章（111 段）整篇派生，热文档 | p50 0.43 ms | 补上待协调 1 以后的代价 |
| 同上，今天的做法（复制给 dr-doc + 冷读） | p50 2.5 ms（其中复制 0.45 ms） | |
| 打一个字之后的增量派生，热文档 | p50 0.15 ms，p95 0.28 ms | 每次只重读 1 段 |
| dr-store 写这一章的索引（整篇替换） | p50 13.3 ms，p95 17.1 ms | 删掉重写 111 行和它们的全文索引 |
| 同一张表上只写改了的一段（模拟按段补丁） | p50 0.12 ms，p95 0.25 ms | 一行、它的全文索引、引用、`index_state`，一个事务 |
| 持有者上打一个字后的一次派生（今天走完全程） | p50 17.1 ms，p95 21.3 ms | 300 次全部走增量；时间几乎全在复制、冷读和整篇替换 |
| 按键写入，有 / 无派生器 | p50 0.037 / 0.037 ms，p95 0.061 / 0.073 ms | 2000 次；派生不拖慢提交 |
| 100 章 150 万字合成书，全书重建 | 1.07 s（每章从 SQLite 载入并派生 p50 2.7 ms） | 8387 段 |
| M10 导入的 stress 库（680 篇，约 390 万字），全部重建 | 1.52 s | 打开库 65 ms |
| 同上，每类正文的字数 vs 0.1 种子用旧规则算的 | 六类全部相等 | 章节 1 500 000、构想 1 000 000、要素 500 000、素材笔记 500 000、故事线 60 000、分类 16 000 |
| 同上，全书搜索（取自书里的 1 / 2 / 3 / 8 个字，各 50 条） | 0.08 / 0.34 / 2.5 / 3.2 ms | 1–2 字走 `LIKE`，3 字以上走 FTS5 三元组 |

上表是负载约 6.8 时的一轮（另外三轮在负载 4.6–6.6 时，数字相差不到一成）。负载升到 27 时同一程序慢 4–5 倍，那一轮不算。

怎么读这些数字：

- **派生本身很便宜**：增量 0.15 ms、整篇 0.43 ms。今天贵在两处别人的接口：整篇替换写索引（13 ms）和复制文档（约 2–3 ms，含冷读）。
- **全书重建在后台**，1–1.6 秒只发生在第一次打开导入的书、或者从没有派生器的版本升级上来时；平时打开库没有落后的文档，什么都不做。
- **字数和旧版完全相等**说明两件事：规则移植对；0.1 种子的正文里没有被样式切开的英文词，故意的那处差异在这份数据上不起作用。真实书稿里含英文的章节，新版可能比旧版略少（每个被加粗、斜体或链接切开的英文词少算一个）。

## 测试

在 `next/` 下：

| 测试 | 内容 |
| --- | --- |
| `cargo test -p prose-metrics` | 文档里的规则用例；段落可加；和 TS 原版对拍 1545 例；故意差异 2 例 |
| `cargo test -p dr-text` | 纯文本（表格、素材嵌入、占位符）、字数可加和加粗切开的词、三级大纲（空标题、去空白、`paragraphs_after`）、匹配器（旧版自己的用例、最长优先、不重叠、名字去空白和后者生效、已链接的跳过、书目里的优先级和重名）、匹配器和旧版逐字扫描的属性对拍 |
| `cargo test -p dr-index --test incremental` | 属性测试：随机打字、回车、粘贴多段、跨段删除、设标题、加粗、加减人物链接、插表格和改格子、插素材嵌入、撤销、第二台设备的编辑合并进来（含随后的块 ID 修复），每一步按差异派生和整篇重读逐项比较；故意改坏增量算法（样式变化不标脏、嵌入变化不重读）两种都能抓到。另有「普通编辑必须走增量」「缓存只认自己的文档」 |
| `cargo test -p dr-index --test library` | 真实 dr-store：持有者空闲时按差异派生，字数、大纲、1 字和 4 字搜索、人物链接和素材嵌入的引用都对；没有派生器时写的库，换有派生器的版本打开后重建；书目文档记成已索引 |
| `cargo test -p dr-index --test m10` | M10 自己的合成 0.1 库导入真实 dr-store，打开后重建：7 篇全部索引，每篇字数等于 dr-doc 读出来算的，`book_stats` 等于各篇之和，大纲带旧块 ID，2 字和 3 字搜索、旧版人物链接和素材嵌入的引用都在 |
| `cargo test -p dr-index --test evidence` | 已提交的测量证据仍然成立（字数六类相等、增量 300 次 0 退回、全书重建 100 章）；源码变了只报过期 |

`DR_PROP_CASES=3000 cargo test --release -p dr-index --test incremental` 跑 3000 例（默认 200 例）。

## 待协调

1. **dr-doc（F1）：从现成的 `LoroDoc` 读正文。** 建议加 `ProseReader::from_loro(doc_id: DocId, doc: LoroDoc) -> Result<ProseReader>`（核对 `meta.doc`，不复制、不写），派生器就能直接读 dr-store 持有者手里的热文档，每次省掉约 0.45 ms 的复制和约 1.6 ms 的冷读。同时建议公开一个不扫前文的按段读：`ProseView::paragraph_in(start, newline) -> Paragraph`（现在只有 `paragraph_at`，它为了「重复的块 ID 只认第一个」要扫这一段前面所有块 ID；派生器自己判重复，不需要这一步）。补上以后可以把「重读超过 24 段就整篇读」的门槛放宽。
2. **dr-store（F2）：按段补丁。** `DerivedUpdate` 加一种只写改了的段：改了哪些段（按段序）、删了哪些、这些段的引用、整篇的新合计。派生器已经知道哪几段变了（`incremental::Update`）。实测整篇替换 2 万字章 13.3 ms，只写一段 0.12 ms。这件事最要紧：整篇替换期间持有者线程和全库唯一的写连接都被占着，这时的按键要等 17 ms 左右。段序会因为插入和删除段而整体移动，补丁里要能表达「从第 k 段起段序加 n」，或者 `block_index` 改用不随插入变化的排序键。
3. **dr-store：`Library::outline` 照 dr-text 的大纲规则。** 现在空标题也列出、文字不去空白。建议查询时去掉去空白后为空的标题并返回去空白的文字（或者直接用 `dr_text::outline::OutlineBuilder` 过一遍查到的行）；`paragraphs_after` 也可以一起算。
4. **dr-store：`DeriveInput` 说明是不是持有者的文档。** 后台重建临时载入的副本也会进派生器的缓存，挤掉打开着的文档（只是下次整篇读，不会错）。多一个标志就能不缓存它们。小事。
5. **M07（字数与写作日）：实时读数不要等索引。** 连续打字时持有者一直不空闲，派生要等作者停下 750 ms 才跑。界面上本章字数这类实时读数，用 `dr_text::count_words` 数编辑器手上的段落；全书、故事线这类合计再读索引。
6. **「提及」引用（`RefKind::Mention`）没做。** 派生器只看得到这一篇正文，看不到书里的要素名。要做的话，要么 `DeriveInput` 带上书的名字表（书目文档变了就要重算全书），要么由 M12 / M20 在书这一层另算一遍。等 M20（统计面板的「提及的出与入」）开工时定。
7. **书目文档里的文字不进搜索。** 补丁正文、批注正文、素材描述是书目文档里的 `LoroText`，派生器对书目文档交的是空结果。M06（搜索）要搜它们的话，需要给这些文字一种在 `block_index` 里的身份（比如 `book:<书>#patch:<id>`）。M06 开工时定。
8. **断行**：照 F4 的计划，`gpui_prose::layout::linebreak` 拆成一个只依赖 ICU4X 的宽松许可小 crate 以后，dr-text 再依赖它。这一轮没做。
9. **测量语料**：bench 的 M10 那一项要先用 0.1 的种子生成 stress 库、再用 M10 导入（步骤见「怎么复现」）。F8 的 `dr-testkit::seed` 出来以后，统一用它的 heavy 预设。

## 下一个里程碑建议

1. 待协调 1、2 补上以后：`source.rs` 换成直接读，dr-store 写按段补丁，重测「持有者上打一个字后的一次派生」（目标 1 ms 以内），再考虑把空闲等待从 750 ms 缩短，让索引更跟手。
2. M12 用匹配器做编辑器里的自动链接，和导入后的断链修复（旧版留下的、一个名字被样式或编辑切成两段链接的那种）。
3. M06 在 `Library::search` 上做分组和按书序排序（F2 待协调 5）。

## 代码位置

```text
next/crates/prose-metrics/          Apache-2.0：LICENSE、NOTICE
  src/lib.rs                        count_words 及其字符分类
  tests/ts_parity.rs                对拍；tests/fixtures/{generate.mts,count-words.json}
next/crates/dr-text/src/
  plain.rs metrics.rs outline.rs autolink.rs tests.rs
next/crates/dr-index/
  src/lib.rs                        TextDeriver、缓存、attach
  src/paragraphs.rs                 一段的派生数据，整篇的行
  src/incremental.rs                按差异更新
  src/source.rs                     把 dr-store 的文档交给 dr-doc 读（待协调 1）
  src/evidence.rs                   测量证据的指纹
  examples/dr-index-bench.rs        测量
  tests/{incremental,library,m10,evidence}.rs
docs/rust-rewrite/acceptance/dr-text-index-m1.json
```

## 怎么复现

```bash
# 对拍夹具（在仓库根，Node 22 起，不需要装依赖）
node --experimental-strip-types next/crates/prose-metrics/tests/fixtures/generate.mts

# 测试（在 next/）
cargo test -p prose-metrics -p dr-text -p dr-index
DR_PROP_CASES=3000 cargo test --release -p dr-index --test incremental

# 测量：先生成 0.1 的 stress 合成库并用 M10 导入（在仓库根，需要 pnpm install）
./node_modules/.bin/tsx --conditions=import src/dev-cli/seed-main.ts --db <dir>/stress/drifting-library.db --preset stress --app-local-data <dir>/stress/app-local-data > <dir>/seed.log
grep '^{"seeded"' <dir>/seed.log > <dir>/seed-stress.json
cd next
cargo run --release -p dr-import-v1 --bin m10-import -- import <dir>/stress/drifting-library.db --to <dir>/stress-v2 --old-root <dir>/stress/app-local-data --device <dir>/device --accept
cargo run --release -p dr-index --example dr-index-bench -- --library <dir>/stress-v2 --seed-stats <dir>/seed-stress.json --out ../docs/rust-rewrite/acceptance/dr-text-index-m1.json
```

不带 `--library` 时只测本程序自己生成的部分（单章、按键、100 章合成书）。bench 先把导入的库复制一份再重建，原库不动，可以反复跑。
