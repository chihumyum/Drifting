# F2 dr-store：存储基座

2026-11-07 起。代码在 `next/crates/dr-store/`，计划见 [foundation.md 的 F2](../foundation.md#f2-dr-store)，Loro 文档结构见 [loro-schema.md](../loro-schema.md)。

## 大白话

一个库就是一个文件夹，里面一个 SQLite 文件装着所有书的 Loro 数据、派生索引和资源文件的登记，旁边是资源文件本身和升级前的安全快照。

- **打开库**：新库直接建表；旧库要升级时，先把整个库拍一张快照（`VACUUM INTO`），在快照的副本上升级、检查无误后才换掉原库。升级失败，原库一个字节都不变，报错里写着快照在哪。
- **打开一篇文档**：每篇打开的文档有一个专门的线程（持有者）。作者打字、Agent 写入、同步进来的更新，全都排队交给它，一次一件、一件一次提交、每次提交只有一个来源。提交后先写进 SQLite，再通知界面。所以作者的按键永远不会和 Agent 的改动混进同一次提交，进程被杀也只会丢「还没通知任何人」的那一下。
- **压缩**：文档空闲时，如果攒了足够多的小更新，就写一份完整快照，并在同一个事务里删掉被它覆盖的更新。历史一直全留着。
- **回看历史**：给值得回去的版本打标签（每 15 分钟最多一个、关闭时、恢复后、每轮 Agent 写入之前），要看某个版本时从 SQLite 另载一份副本，不碰打开着的文档。
- **派生索引**：搜索、大纲、段落长度、引用、字数，只建了表和最小的读写接口；什么时候更新、怎么增量更新归 F3。
- **资源文件**：图片和 PDF 的原文件、显示图、缩略图存在文件夹里，表里一行一个版本；生成显示图和缩略图的图片管线这一轮只留了接口。

## 里程碑状态

| # | 里程碑 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 数据库基线与迁移：`0000_baseline.sql`、安全快照、影子库、失败原库字节不变 | 完成 | `tests/migrate.rs`（10 项，含每个阶段注入失败和模拟崩溃后原库哈希不变） |
| 2 | 表：Loro 相关五张（`library_meta`、`loro_doc`、`loro_update`、`loro_snapshot`、`loro_peer`）、`history_label`、派生索引、`asset` | 完成 | `migrations/0000_baseline.sql`；`tests/index.rs`（含 1–2 字中文查询退回 LIKE） |
| 3 | 文档持有者：专用线程、来源标记、先落盘再发事件、作者与 Agent 不同提交 | 完成 | `tests/holder.rs`（14 项，含两线程同时写 400 次逐行核对、追加失败后按原来源重试） |
| 4 | 压缩与历史：后台压缩、同事务删除、不做浅快照、另载副本回看 | 完成 | `tests/holder.rs` |
| 5 | 崩溃安全：随机杀进程、迁移各阶段杀进程 | 完成 | `tests/crash.rs`（CI 跑 6 次）；[acceptance/f2-crash-recovery.json](../acceptance/f2-crash-recovery.json)（60 次） |
| 6 | 资源文件：`asset` 表、三种版本、导入协议、垃圾回收、图片管线接口 | 完成（管线只有接口） | `tests/asset.rs` |
| 7 | 测量 | 完成 | [acceptance/f2-store-bench.json](../acceptance/f2-store-bench.json)，见下文「测量」 |

## 接口概览

```rust
// 打开库（一个文件夹；同一时刻只能被一个进程、一个 Library 打开）
let mut options = LibraryOptions::new(env!("CARGO_PKG_VERSION"));
options.configure_doc = Some(Arc::new(dr_doc::schema::configure)); // F1 接入点：样式表
let lib = Library::open(root, options)?;          // 新建 / 迁移；失败是 StoreError::Migration
lib.open_report();                                 // 新建了吗、迁了几条、安全快照在哪

// 打开文档：一个持有者线程；已打开的返回同一个持有者
let h = lib.open_doc("node:<id>", OpenDoc::CreateIfMissing {
    kind: "node", book_id: Some(book), genesis: &dr_doc::genesis_for(...), // F1 接入点：创世
})?;
let (r, committed) = h.write(Origin::User, |doc| { /* 只改，不提交 */ })?;   // 落盘后才返回
let pending = h.submit(Origin::agent(session, turn), |doc| ...)?; pending.wait()?;
h.import(bytes, Origin::Sync)?;                    // 远端更新：导入、落盘、通知
h.read(|doc| ...)?;                                // 在持有者线程上读，看到的是完整的写入
h.doc();                                           // 只读克隆，任何线程可读；不许直接改
let _sub = h.subscribe(|e: &DocEvent| ...);        // 已落盘的变化：seq、来源、Loro 差异
h.compact_now()?; h.label(labels::RESTORE)?; h.stats();

// 历史
lib.history(doc_id)?;                              // 标签，新的在前
lib.load_copy_at(doc_id, &frontiers)?;             // 另载一份副本并检出，只读，用完丢
lib.load_copy(doc_id)?;                            // 另载一份最新副本

// 对等方与换代
lib.peer_for(doc_id)?; lib.rotate_epoch()?;        // 换代要求没有打开的文档
Library::restore_backup(root, &backup, options)?;  // 从备份恢复，自动换代

// 同步要用的
lib.updates_since(doc_id, after_seq)?; lib.snapshot_info(doc_id)?;

// 派生索引
lib.index_doc(&DocIndex { doc_id, book_id, frontiers, words, chars, blocks, references })?;
lib.search(Some(book), "安娜", 50)?;               // 3 字以上 FTS5 trigram，1–2 字 LIKE
lib.outline(doc_id)?; lib.block_lengths(doc_id)?; lib.references_to(target)?;
lib.doc_stats(doc_id)?; lib.book_stats(book)?;

// 资源文件
lib.import_asset(&SourceImport { book_id, asset_id, source, mime, ext, dimensions, limit })?;
lib.derive_variants(asset_id, &pipeline)?;         // pipeline: impl ImageDeriver（待做）
lib.put_variant(asset_id, Variant::Thumbnail, &bytes)?;
lib.asset(asset_id, Variant::Display)?; lib.remove_asset(asset_id)?; lib.collect_asset_garbage()?;
```

`Origin` 是 `User`、`Agent("<会话>/<轮>")`、`Mirror`、`Sync`、`Import`、`Genesis`，外加兜底用的 `Outside`。

## 设计与取舍

### 库的文件夹

```text
<root>/library.sqlite      Loro 更新与快照、历史标签、派生索引、资源登记、库设置
<root>/library.lock        打开期间加排他锁（std 的 File::try_lock）
<root>/assets/<书>/<资源>/{source,display,thumbnail}.<扩展名>
<root>/safety-snapshots/<版本>/library-*.sqlite   每个版本留最新 3 份
```

- **独占**：loro-schema 的对等方规则以「一个库只被一个进程打开」为前提。所以打开时对 `library.lock` 加排他锁：另一个进程、或同一进程里第二个 `Library` 都打不开。进程被杀时系统自动放锁。
- **两条连接**：一条写（所有持有者共用，Rust 互斥锁排队，不靠 SQLite 的忙等），一条只读（`query_only`）。WAL 下读不挡写。
- 按账号分库（M36）以后在这一层之上做，参考 `src-tauri/src/library_registry.rs`：每个账号一个这样的文件夹。

### 迁移

照旧版 `crates/drifting-core/src/database.rs` 的做法，简化了一处：

- 迁移是 `migrations/` 下按序号排的 SQL 文件，`MIGRATIONS` 里登记。库里的 `schema_migration` 表记着每条的名字和 SHA-256；打开时它必须是本版本列表的前缀，否则报 `SchemaMismatch`（改过已发布的迁移），比本版本多则报 `SchemaNewer`（请升级应用）。两种情况都不碰库。
- **发布过的迁移不再改**：测试 `published_migrations_are_unchanged` 钉住每条已发布迁移的哈希。改动一律追加 `0001_*.sql`。
- **旧库升级的步骤**：checkpoint 清空 WAL → `VACUUM INTO` 安全快照（fsync）→ 关闭连接 → 把快照复制成影子文件 → 在影子上以 `journal_mode=DELETE`、`synchronous=FULL` 跑迁移（一个事务）→ `integrity_check`、`foreign_key_check`、迁移记录完整 → fsync → 删掉原库已空的 `-wal`/`-shm` → 原子改名替换原库并 fsync 目录 → 重新打开再检查一遍。
- **失败**：替换之前任何一步失败，影子删掉、原库不动，返回 `MigrationFailure { stage, detail, safety_snapshot, from, to }`。只有「替换之后重新打开」失败时库已经是新的，错误里 `source_unchanged()` 为假。
- **崩溃**：替换之前崩溃，留下的只是影子文件，下次打开时删掉；替换之后崩溃，库已是新的、迁移记录完整，下次打开什么都不用做。
- **比旧版少了「回执」文件**：旧版用回执记录升级做到哪一步，用来判断崩溃时改名有没有发生。这里不需要：库自己的迁移记录就能说明它是新是旧，而改名前原库的 WAL 一定是空的（先 checkpoint(TRUNCATE)，删 `-wal` 前再查一遍长度，不空就中止）。
- **换版本也拍快照**：没有待跑的迁移、但打开它的应用版本变了（`library_meta.app_version`），也先拍一张安全快照，和旧版一样。
- **基线什么时候冻结**：现在已钉住哈希。建议合进 `main` 就当作已发布（和旧版 2026-08-26 的做法一样），以后的表（帮手的本机表等）都走新迁移，这样作者在阶段 2 用新版写作时，开发库不用重建。监管会话可以改成「0.2.0 发布前允许改基线、同时改钉住的哈希、开发库重建」。

### 表

DDL 以 `migrations/0000_baseline.sql` 为准，所有表都是 `STRICT`，时间都是 Unix 毫秒，引用 `loro_doc` 的表都 `ON DELETE CASCADE`。和 loro-schema.md 原来那段 DDL 比：

- `loro_doc` 多了 `book_id`（可空）和 `created_ms`：派生索引、整本书打开、删书都要按书找文档，书目文档里虽然也有，但读它要先解码。
- `loro_snapshot` 用普通表而不是 `WITHOUT ROWID`：快照是 MB 级的大块，SQLite 建议大行不要放进无 rowid 表。`loro_update` 保留 `WITHOUT ROWID`，同一篇的更新按 `(doc_id, seq)` 挨着存，载入时顺序读。
- 新增 `history_label`、`doc_stats`、`block_index` + `block_fts`、`reference`、`asset`，见下文。

### 对等方与换代

照 P0-C：每（设备，文档）一个随机对等方，最高位清零（创世对等方最高位为 1，永不相撞），存在 `loro_peer`；`library_meta.epoch` 换了，下次本机写入前重新分配。换代要求没有打开的文档（`DocumentsOpen`）。`restore_backup` 先校验备份、替换、再自动换代。

### 文档持有者

- **为什么必须有**：Loro 每个文档只有一个隐式事务，所有克隆共享。测试 `loro_shares_its_implicit_transaction_across_clones` 钉住了这件事：一个克隆上的按键，会进到另一个克隆接下来的 Agent 提交里，还带着 Agent 的提交信息。
- **一条消息一次提交**：写入是闭包，持有者线程跑完后 `commit_with(origin, message)`；Agent 来源同时写成提交信息（Loro 会存进历史、随同步走）。两个线程同时写 400 次，逐行导入核对：每一行只含它那个来源的字（`author_and_agent_writes_never_share_a_commit`）。
- **先落盘再通知**：持有者在文档上挂了一个 Loro 订阅，提交时把差异转成自有的值先存着；追加进 SQLite 成功后才发 `DocEvent`（带 `seq`、来源、版本、差异）。测试在事件回调里读 SQLite，那一行必须已经在。追加失败（比如磁盘满）时：改动留在内存里，记下它的来源；之后做任何事之前先用原来的来源重试，重试还失败就拒绝新的写入、把错误交给调用方。所以一行永远只有一个来源，事件也带着正确的来源晚一点发出（`a_failed_append_is_retried_under_its_own_origin`）。
- **兜底**：`h.doc()` 给出的克隆只许读。万一有人直接改了它，持有者在处理下一件事之前把这些操作单独提交成 `Outside` 来源并记错误日志，不让它混进下一个来源的提交（`stats().outside_commits` 应该一直是 0）。正在执行写入的那一瞬间被外面改，这个兜底挡不住，所以规矩是不许改。
- **写入闭包 panic**：已经做出的改动 Loro 撤不回，照样以这次的来源提交并落盘，调用方拿到 `WritePanicked`。
- **同一篇打开两次**返回同一个持有者；最后一个句柄放掉时，持有者打关闭标签、按需压缩、释放。持有者线程即使 panic、创世闭包即使 panic，占位也会释放，之后照样能打开。
- **导入有缺依赖的更新**：只有 Loro 真正应用了的部分会落盘（`Imported.status.pending` 告诉同步层还缺什么，要重新取）。这样 SQLite 里的内容永远等于文档的 oplog，压缩不会丢东西。

### 压缩

- 持有者空闲 `idle`（默认 750 ms）后，如果攒了 `max_updates`（默认 200）条或 `max_bytes`（默认 1 MiB）更新，就压缩；关闭时攒了 `on_close_min_updates`（默认 50）条以上也压缩。默认值来自下文的测量。
- 快照在持有者线程上导出（不占写锁），然后在一个事务里写快照、删 `seq <= upto_seq` 的更新。
- 只做完整快照（`ExportMode::Snapshot`），不做浅快照：作者和 Agent 交替写入时浅快照几乎裁不掉什么，而且会让锚在已删文字上的光标失效。
- 导入过远端更新后，空闲时调一次 `free_history_cache`，把导入展开的历史缓存还回去（P0-C 测过能还回一半左右）。

### 历史标签

照旧版快照历史的规则（`snapshot-history.service.ts`、`workspace/history.rs`），只是标签指向 Loro 的版本，不再存整份状态：

- `periodic`：提交之后，距上一个标签满 15 分钟才打；
- `close`、`restore`：不受间隔限制；
- `agent:<会话>/<轮>`：**每轮 Agent 的第一次写入之前**打一个，指向这一轮开始前的版本，整轮可以一起撤；即使同一个版本上已经有 `periodic` 也照打，F3 靠它找「这一轮之前」；
- 同一个版本不连着打两个；
- 一小时内的全留，一天内每小时留最新一个，再往前每天留一个，30 天以前的删掉（打新标签时顺手整理）。

回看：`load_copy_at` 从 SQLite 另载一份、`checkout` 到那个版本，只读，用完就丢。P0-C 实测在打开的文档上 `fork_at` 会让它自己膨胀且不释放，所以不提供那条路。撤销 Agent 改动（`revert_to`）是 F3 的命令。

### 派生索引

- `block_index`：每段一行，按文档顺序（`ord`）。一张表同时管三件事：
  - 搜索：`block_fts` 是它的外部内容 FTS5 表（trigram），由触发器保持同步；
  - 大纲：`heading` 为 1–3 的行；
  - 段落长度：全书模式里还没解码的章节，用它估段落高度（P0-C 对 F4 的提示）。
  - 块 ID 在修复前可能为空或重复，所以唯一键是 `(doc_id, ord)`，不是块 ID。
- `reference`：从哪篇哪段指向哪个对象，`kind` 是 `link`（人物链接标记）、`mention`（正文里出现的名字）、`embed`。
- `doc_stats`：字数、字符数、段数，以及算它们时的版本（`frontiers`），F3 用来判断过期。字数怎么数是 dr-text 的规则，调用方算好传进来。
- **搜索**：3 个字以上走 FTS5（整句当作一个短语，引号转义，`OR` 之类只是普通字）；1–2 个字（中文人名地名常见）退回 `LIKE`，`%`、`_` 转义。都不分大小写，结果按文档 id 再按段序排，给出命中位置和一小段上下文。20 章 40 万字里搜一个字和三个字，debug 构建合计不到 2 秒（测试的上限），release 下见测量。
- 现在的写入接口是「整篇替换」（一个事务）。按段增量更新、什么时候重建，是 F3 的事。

### 资源文件

- 照旧版 `asset_store.rs`：导入时先在资源目录里写一个标明本进程的 `.importing` 标记，再在大小上限内原子复制原文件、算 SHA-256，插入表里那一行后才删标记；删除时先删行、再删目录；垃圾回收删掉所有没有行的目录，只放过本进程还没导入完的。
- 原文件（`source`）不可覆盖。显示图（≤ 8 MiB）和缩略图（≤ 1 MiB）可以替换，上限沿用旧版 `image_pipeline.rs`。
- 资源的元数据（种类、mime、大小、sha256、宽高）在书目文档里随同步走；`asset` 表只记这台设备手上有哪些字节。`find_asset_by_sha256` 给导入去重用。
- 图片管线只留了接口 `ImageDeriver::derive(source, mime) -> Derived { display, thumbnail }`。搬 `src-tauri/src/image_pipeline.rs`（`image` 解码、EXIF 方向、限制尺寸、HEIC/AVIF 走系统解码器）要另开一项。

## 测量

M3 Pro（12 核，36 GB），release，Loro 1.17.1，2026-11-07。数据全是合成的：章节由固定字池随机组段，一次写入后压缩，然后模拟打字（每次插 1–6 字，六分之一的概率删 1–3 字）。完整数字和样本数在 [acceptance/f2-store-bench.json](../acceptance/f2-store-bench.json)。

| 项 | 结果 | 预算（benchmarks.md） |
| --- | ---: | --- |
| 一次按键写入：持有者线程上提交 + 导出 + 追加进 SQLite + 发事件 + 唤醒调用方，2 万字章节，2000 次，`synchronous=NORMAL` | p50 0.023 ms，p95 0.049 ms，最慢 1.3 ms | 单次按键的写入中位数 ≤ 2 ms（探针档）/ ≤ 1 ms（发布档） |
| 同上，`synchronous=FULL` | p50 0.049 ms，p95 0.094 ms，最慢 1.4 ms | — |
| 每次按键的更新平均大小 | 104 字节 | — |
| 打开一章（2 万字快照 + N 条按键更新）：载入 / 载入并读出全文 / 起一个持有者，p50 | N=0：0.11 / 0.23 / 0.13 ms<br>N=100：1.0 / 1.0 / 1.1 ms<br>N=500：3.5 / 3.5 / 3.7 ms<br>N=1000：6.6 / 6.6 / 6.8 ms<br>N=5000：32 / 31 / 32 ms | 打开 2 万字章节 ≤ 80 ms（探针档，含排版） |
| 压缩（2 万字章节，写快照 + 删掉 N 行），p50 | N=100：0.52 ms；N=500：0.77 ms；N=2000：1.8 ms（最慢 3.2 ms）；快照 69–133 KB | — |
| 全书 100 章 × 1.5 万字：从 SQLite 冷载入全部 | 8.9 ms | 冷开全书的 Loro 文档 ≤ 300 ms（发布档） |
| 全书：第一次读出每章全文 | 9.5 ms | — |
| 全书：起 100 个持有者 / 全部关掉 | 11.8 ms / 2.6 ms | — |
| 全书的库文件 | 5.2 MB | — |

怎么读这些数字：

- **按键写入**比 P0-C 测的 0.23 ms 还快一个数量级，比预算低两个数量级。最慢的那一次（约 1.3 ms）是 SQLite 自动 checkpoint 落在了这次提交上，见「下一步」。
- **打开一章的成本几乎全在待压缩的更新上**：每多一条约 6.5 µs。所以默认 200 条就压缩（打开 ≤ 约 1.5 ms），关闭时 50 条以上也压缩。一次压缩不到 1 ms，又是在空闲时做，代价很小。
- **全书数字偏乐观**：这里每章只有「一次写入」的历史，没有标记和链接。P0-C 用重型种子（带 1.5 万处人物链接、模拟打字的历史）测得冷载入 26–29 ms、第一次解码每章 0.8–1.7 ms，那组数字更接近真实；两者都远在预算内。
- 内存没有在这里测：P0-C 已经测过每章、全书和回看历史的内存，存储层没有改变那些数字。

## 崩溃安全

[acceptance/f2-crash-recovery.json](../acceptance/f2-crash-recovery.json)，`f2-crash run --kills 60 --migration-kills`：

- **编辑中被杀**：写入进程通过真实的持有者不停编辑一篇 3 万字的文档，每 25 次压缩一次，并故意把压缩事务撑开 20 ms。父进程随机时刻强杀（macOS 上是 SIGKILL，Windows 上是 TerminateProcess），重开库、和「第 0 到第 k 次编辑」的确定性重放逐字比对。60 次里 40 次落在压缩事务中间、20 次落在两次编辑之间：**零丢失、零不一致**；更新日志始终连续、没有被快照覆盖的残行。崩溃后重开并载入 p50 11.7 ms，最慢 22 ms。
- **迁移中被杀**：对迁移的六个阶段各杀一次（子进程停在该阶段等着被杀）：

  | 停在 | 原库字节 | 旧版本还能打开 | 留下的影子 | 下一次新版本打开 |
  | --- | --- | --- | --- | --- |
  | 拍安全快照前 | 不变 | 能 | 无 | 迁移成功，正文完整 |
  | 复制影子前 | 不变 | 能 | 无 | 同上 |
  | 迁移事务里（未提交） | 不变 | 能，影子被删 | 1 个 | 同上 |
  | 校验前 | 不变 | 能，影子被删 | 1 个 | 同上 |
  | 替换前 | 不变 | 能，影子被删 | 1 个 | 同上 |
  | 替换后、重开前 | 已是新库 | 不能（`SchemaNewer`，库不动） | 无 | 不用再迁，正文完整 |

- CI 里 `tests/crash.rs` 跑同样的程序，杀 6 次加六个迁移阶段，约 2 秒。

## 实测发现（给其他基座）

- **Loro 的 `oplog_vv()` 包含还没提交的本机操作**：打了一个字、还没 `commit`，版本向量已经算上它了。所以「上次落盘到哪」不能拿提交前的 `oplog_vv` 当基准；持有者只在提交后取。
- **Loro 的订阅回调在提交时同步触发**，早于我们写 SQLite。要「先落盘再通知」，就不能让界面直接订阅 Loro，只能订阅持有者的 `DocEvent`。F3 的细粒度事件请从 `DocEvent.changes` 出发。
- 隐式事务跨克隆共享，见上文的测试。

## 待协调

1. **`loro_doc.book_id`**（F1、F3）：新增的列，F3 打开文档时传入。书目文档 `book:<id>` 自己的 `book_id` 也填这本书。
2. **F1 的两个接入点**：`LibraryOptions::configure_doc`（样式表，每个新建的 `LoroDoc` 在导入前调用；时间戳由存储自己打开）和 `OpenDoc::CreateIfMissing.genesis`（创世：设创世对等方、时间戳 0、写内容；存储随后 `commit`、以 `genesis` 来源追加，再换成设备对等方）。dr-doc 不需要依赖 dr-store，反过来也不需要。
3. **F4 编辑器怎么读写**：写一律走 `write` 闭包；读可以用 `h.doc()` 克隆（可能看到写到一半的状态）或 `h.read`（经过持有者线程，一次跳转约几十微秒）。`UndoManager` 要求 `&mut` 且只撤本对等方的操作，撤销本身也是写，建议放在写闭包里调用（例如闭包捕获 `Arc<Mutex<UndoManager>>`）。具体由 F4 定，如需要持有者线程上的「扩展槽」再提。
4. **基线冻结的时间**：见「迁移」最后一条，请监管会话定。
5. **搜索结果的顺序**：现在按文档 id、段序。要按书序（章节的 `book_order`）排，需要 F3 用书目文档排序，或者以后给 `block_index` 加一个书序列。
6. **本机表**（帮手运行记录、扩展、权限、工作记忆、生图收件箱）：这一轮没建，谁需要谁追加 `0001_*.sql`。
7. **同步 v2（阶段 6）**：`updates_since` 给上传用；压缩会删掉已上传和未上传的行，上传进度（已上传到哪个 `seq`、快照是否已上传）要同步层另记，压缩前要确认。这一条到 D6 实现时再对齐。
8. **Windows**：代码有 Windows 分支（`MoveFileExW` 写穿、可写句柄 fsync），本机没有 Windows 环境，只能靠 CI 的 Windows 那一条验证。

## 没做的、下一步建议

- 图片管线（`image_pipeline.rs` 和各平台解码器）只有接口。
- 派生索引的增量维护、「什么时候需要重建」：F3。
- 帮手的本机表、整库备份（`library_backup.rs`：`VACUUM INTO` 加资源文件打包）、按账号分库（M36）。
- 持有者把连续的同来源写入合成一行追加（打字很快时能少写几行），等 F4 接上真实打字再看要不要。
- WAL 自动 checkpoint 会在某一次提交里多花几毫秒。现在用 SQLite 默认（1000 页）；如果测到按键尾延迟，就关掉自动 checkpoint，改在持有者空闲时做被动 checkpoint。
- 建议下一个里程碑：F1 的 dr-doc 出来后，做一个「F1 + F2」接线测试：用真实的创世和样式表跑一遍崩溃测试和测量，再把 F3 的命令层接上来。

## 怎么复现

在 `next/` 下：

```bash
cargo test -p dr-store
cargo run --release -p dr-store --bin f2-bench
cargo run --release -p dr-store --bin f2-crash -- run --kills 60 --migration-kills
cargo run --release -p dr-store --bin f2-bench -- --check
cargo run --release -p dr-store --bin f2-crash -- --check
```

- `f2-bench` 写 `docs/rust-rewrite/acceptance/f2-store-bench.json`，`f2-crash` 写 `f2-crash-recovery.json`。两份都带源码指纹；`--check` 只校验指纹和形状，不校验耗时。
- 测试数据全是合成的（`dr_store::synthetic`：固定字池随机组段），不含任何书稿。
