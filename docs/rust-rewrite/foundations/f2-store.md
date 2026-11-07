# F2 dr-store：存储基座

2026-11-07 起。代码在 `next/crates/dr-store/`，计划见 [foundation.md 的 F2](../foundation.md#f2-dr-store)，Loro 文档结构见 [loro-schema.md](../loro-schema.md)。

## 大白话

一个库就是一个文件夹：一个 SQLite 文件装着所有书的 Loro 数据、派生索引、资源登记和本机记录，旁边是资源文件、升级前的安全快照和升级回执。库外面（应用的本机数据目录）还有这台设备的身份文件和「见过每个库写到哪」的水位记录。

- **打开库**：新库直接建表。旧库要升级时，先把整个库拍一张安全快照，在快照的副本上升级，检查无误后才换掉原库；每次尝试都留一张回执。升级失败，原库内容不变，报错里写着快照和回执在哪。库被拷到别的电脑、或者被旧备份盖回来时，打开就自动「换代」：以后每篇文档都换新的对等方 ID，不会和别处已经写过的操作撞号。
- **打开一篇文档**：每篇打开的文档有一个专门的线程（持有者）。作者打字、Agent 写入、Markdown 文件夹、同步进来的更新，全都排队交给它，一件一次提交、一次只有一个来源。提交后先写进 SQLite 再通知界面，所以每次提交都已经落盘，退出时什么都不用冲刷（GPUI 只给退出钩子 200 ms）。
- **谁改了什么**：Agent、Markdown 文件夹、导入的提交都把来源写进 Loro 的提交信息，跟着文档走、压缩删不掉。每次 Agent 写入还会在同一个事务里留下一条结算记录。
- **压缩与历史**：文档空闲时把攒下的小更新压成一份完整快照，历史一直全留着。值得回去的版本打标签，同时记下当时书目文档的版本；要看某个版本，就从 SQLite 另载一份副本。
- **派生索引**（搜索、大纲、段落长度、引用、字数）由存储层自己算：持有者空闲时把攒下的 Loro 差异交给「派生器」，结果和它对应的版本号在同一个事务里写进去；打开库时把落后的文档重建一遍。
- **同步**：每篇文档记住服务器已经有到哪（`remote_vv`），上传时从文档本身导出那之后的改动，所以压缩和上传互不相干。
- **资源文件**：照旧版 `native_capabilities.rs` 的做法存原文件、显示图、缩略图；图片管线这一轮只留了接口。

## 里程碑状态

| # | 里程碑 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 数据库基线与迁移：基线、安全快照、影子库、恢复回执、失败原库不变 | 完成 | `tests/migrate.rs`（15 项，含每个阶段注入失败、模拟崩溃、回执的各种状态） |
| 2 | 表：Loro 相关表、历史标签、结算、同步状态、派生索引、资源 | 完成 | `migrations/0000_baseline.sql`；`tests/index.rs`（6 项，含 1–2 字中文查询退回 LIKE、没有触发器） |
| 3 | 文档持有者：专用线程、来源标记、先落盘再发事件、作者与 Agent 不同提交 | 完成 | `tests/holder.rs`（18 项）、`tests/records.rs`（7 项） |
| 4 | 压缩与历史：后台压缩、同事务删除、不做浅快照、另载副本回看 | 完成 | `tests/holder.rs`、`tests/records.rs` |
| 5 | 崩溃安全：随机杀进程、迁移各阶段杀进程 | 完成 | `tests/crash.rs`（CI 跑 6 次）；[acceptance/f2-crash-recovery.json](../acceptance/f2-crash-recovery.json)（60 次） |
| 6 | 资源文件：三种版本、导入标记协议、垃圾回收、落盘删除、图片管线接口 | 完成（管线只有接口） | `tests/asset.rs` 和 `asset.rs` 里的单测 |
| 7 | 测量 | 完成 | [acceptance/f2-store-bench.json](../acceptance/f2-store-bench.json)，见下文「测量」 |
| — | 本机身份与自动换代、同步状态、派生器、事件总线（监管会话追加） | 完成 | `tests/device.rs`（4 项）、`tests/sync.rs`（2 项）、`tests/records.rs` |
| — | `file_io.rs`、`archive.rs` 原样搬入并补单测 | 完成 | `tests/file_io.rs`（8 项，Windows 另有 1 项在 CI 跑） |

合计 88 项测试（Windows 上 89 项）。

## 接口概览

```rust
// 设备：库外的身份文件与水位
let device = Device::open(app_local_dir)?;          // 读写 sync-installation-v2.json（与 0.1 同一个文件）
device.writing_device_key();                        // 写作日的设备键，与 0.1 算法一致

// 打开库（一个文件夹；同一时刻只能被一个进程、一个 Library 打开）
let mut options = LibraryOptions::new(env!("CARGO_PKG_VERSION"));
options.device = Some(device);
options.configure_doc = Some(Arc::new(dr_doc::schema::configure)); // F1 接入点：样式表
options.deriver = Some(Arc::new(my_deriver));      // F1/F3 接入点：派生索引
let lib = Library::open(root, options)?;           // 新建 / 迁移 / 自动换代
lib.open_report(); lib.epoch_change();              // 迁了几条、快照在哪；换代了吗、为什么
Library::recovery_receipts(root)?;                  // 不打开库也能读回执（给恢复界面）
Library::restore_from_receipt(root, id, options)?;  // 校验快照哈希后恢复，自动换代

// 打开文档：一个持有者线程；已打开的返回同一个持有者
let h = lib.open_doc("node:<id>", OpenDoc::CreateIfMissing {
    kind: "node", book_id: Some(book), genesis: &dr_doc::genesis_for(...), // F1 接入点：创世
})?;
h.write(Origin::User, |doc| { /* 只改，不提交 */ })?;          // 落盘后才返回
h.write_agent(AgentWrite { session, turn, call, summary }, |doc| ...)?; // 同一事务里留结算记录
h.import(bytes, Origin::Sync)?;                     // 远端更新：导入、落盘、记下服务器已有
h.read(|doc| ...)?;                                 // 持有者线程上读：导出、光标位置、回看都在这里
h.doc();                                            // DocView：任何线程可读的当前状态，不许改
h.subscribe(|e: &DocEvent| ...); h.reindex_now()?; h.compact_now()?; h.label(labels::RESTORE)?;
h.close();                                          // 最后一个句柄：等持有者收尾；直接 drop 不阻塞

// 总线：所有文档的已落盘变化 + 本机表的变化
let _sub = lib.subscribe(|e: &StoreEvent| ...);     // Doc(DocEvent) | Local(LocalChange)
lib.notify_local(LocalChange::new("agent_run", id, LocalChangeKind::Insert)); // F3 的本机表

// 历史、活动、结算
lib.history(doc_id)?;                               // 标签（带书目文档的版本），新的在前
lib.load_copy_at(doc_id, &frontiers)?;              // 另载副本检出，只读，用完丢
lib.activity_since(ts_ms)?;                         // 某时间起谁改了哪些文档（对等方、时间、提交信息）
lib.settlements(Some(session), None)?;              // Agent 结算记录

// 同步
lib.export_for_upload(doc_id)?;                     // remote_vv 之后的改动（先 sync_to_disk）
lib.mark_uploaded(doc_id, &vv)?; lib.docs_with_local_changes()?;
lib.assets_pending_upload()?; lib.mark_asset_uploaded(asset_id, variant)?;

// 派生索引
lib.search(Some(book), "安娜", 50)?;                // 3 字以上 FTS5 trigram，1–2 字 LIKE
lib.outline(doc_id)?; lib.block_lengths(doc_id)?; lib.references_to(target)?;
lib.doc_stats(doc_id)?; lib.book_stats(book)?; lib.stale_index_docs()?; lib.rebuild_stale_indexes()?;

// 资源文件
let mut import = lib.begin_asset_import(book, asset)?;   // 先写导入标记
import.copy_variant(Variant::Source, path, mime, ext, dims, limit)?;
import.write_variant(Variant::Thumbnail, &bytes)?;
import.commit()?;                                   // 先写行，再清标记
lib.import_asset(&SourceImport { .. })?;            // 上面三步的一次性版本
lib.derive_variants(asset_id, &pipeline)?;          // pipeline: impl ImageDeriver（待做）
lib.remove_asset(asset_id)?; lib.collect_asset_garbage()?;

lib.purge_doc(doc_id)?;                             // 一个事务删掉一篇文档的所有行
lib.close()?;                                       // 等持有者和后台重建收尾、关库、放锁
```

`Origin` 是 `User`、`Agent("<会话>/<轮>")`、`Mirror`、`Sync`、`Import`、`Genesis`，外加兜底用的 `Outside`。

## 设计与取舍

### 库的文件夹与本机身份

```text
<root>/library.sqlite
<root>/library.lock                    打开期间加排他锁（std 的 File::try_lock）
<root>/assets/<书>/<资源>/{source,display,thumbnail}.<扩展名>
<root>/safety-snapshots/<版本>/library-*.sqlite      每个版本留最新 3 份
<root>/safety-snapshots/recovery/<回执 id>.json
<设备目录>/sync-installation-v2.json   本机安装身份（与 0.1 同一个文件）
<设备目录>/library-watermarks.json     每个库：这台设备见它写到过哪
```

- **独占**：loro-schema 的对等方规则以「一个库只被一个进程打开」为前提。所以打开时对 `library.lock` 加排他锁：另一个进程、或同一进程里第二个 `Library` 都打不开。进程被杀时系统自动放锁。
- **两条连接**：一条写（所有持有者共用，Rust 互斥锁排队），一条只读（`query_only`）。WAL 下读不挡写。
- **本机身份**：`identity.rs` 原样搬了 0.1 的 `installation_identity.rs`：随机 32 字节、先写临时文件再硬链接发布、损坏时报错且不改动文件、只给本人读写。写作日的设备键沿用 0.1 渲染层的算法（`device-key.ts`：`SHA-256("drifting.writing-day.v1\n" + 安装 id)` 的前 12 字节），同一台设备导入后在写作日里还是同一台。
- **对等方 ID 不从安装身份派生**：迁移助理、恢复整个用户目录时，身份文件会跟着被拷走，两台电脑就会用同一组对等方写入。所以对等方仍是每库、每（设备，文档）随机一个，存在 `loro_peer`；靠下面的自动换代兜住搬库。
- **自动换代**：`library_meta` 记着上次打开它的安装 id 和一个全库的写入计数 `write_seq`（每追加一行加一，和那一行在同一个事务里）。打开时：
  - 安装 id 和本机不同：库是从别的设备拷来的，换代（`EpochChange::OtherDevice`）；
  - `write_seq` 低于本机水位：库被旧备份盖回来了，换代（`EpochChange::OlderCopy`），并把计数抬到水位，免得每次打开都换；
  - 水位在**东西离开本机时**抬高（`sync_to_disk`、`export_for_upload`），关库时也抬。只在本机出现过、没离开过的操作被旧备份覆盖后重用，不会造成分歧。
  - 局限：同一台电脑上把整个库文件夹复制一份、两份轮流用，第二份打开时比水位低会换代，第一份之后可能再换一次。换代总是安全的，只是对等方会多几个。
- 按账号分库（M36）以后在这一层之上做，参考 `src-tauri/src/library_registry.rs`：每个账号一个这样的文件夹，共用同一个设备目录。

### 迁移与恢复回执

照旧版 `crates/drifting-core/src/database.rs` 的影子库迁移、恢复回执、按版本的安全快照那一段改写；给渲染层的 SQL 网关和 Drizzle 相关的部分不搬（Drizzle 旧库留给 dr-import-v1）。新基线用自己的迁移记录表 `schema_migration`（序号、名字、SHA-256）。

- 迁移是 `migrations/` 下按序号排的 SQL 文件。记录必须是本版本列表的前缀，否则报 `SchemaMismatch`（改过已发布的迁移），比本版本多则报 `SchemaNewer`（请升级应用）；两种情况都不碰库。测试 `published_migrations_are_unchanged` 钉住每条已发布迁移的哈希。
- **升级步骤**：checkpoint 清空 WAL → `VACUUM INTO` 安全快照（先写临时名，fsync 后改名）→ 写回执（快照的相对路径、SHA-256、大小、来源和目标版本）→ 关连接 → 回执记下影子文件名 → 把快照复制成影子 → 在影子上迁移（一个事务）→ `integrity_check`、`foreign_key_check`、迁移记录完整 → fsync → 回执改成「替换中」→ 删掉原库已空的 `-wal`/`-shm` → 原子改名替换原库并 fsync 目录 → 重新打开再检查 → 删回执。
- **失败**：替换之前任何一步失败，影子删掉，原库内容不变；回执留着，写明失败阶段和原因。返回 `MigrationFailure { stage, detail, safety_snapshot, recovery_id, from, to }`。只有「替换之后重新打开」失败时库已是新的，`source_unchanged()` 为假。改名成功、只是之后同步目录失败的情况，会检出库已迁完，照常往下走。
- **下次打开先结清回执**（照旧版）：读不出的回执 → 停（`recovery-receipt-invalid`），不猜；快照哈希或大小对不上 → 停（`safety-snapshot-invalid`）；没到「替换中」、或影子还在 → 替换没发生，删影子和回执、照常打开（有待跑的迁移就重试）；「替换中」且影子已不在 → 替换已发生，库必须完整、迁移条数等于回执的目标，否则停（`activated-database-invalid`），不在半成品上继续迁移。停下时界面用 `Library::recovery_receipts` 读回执，`restore_from_receipt` 校验哈希后恢复。
- **「原库不变」的确切含义**：原库正常关闭过（WAL 为空）时逐字节不变，测试按这个校验；上次是崩溃退出时，升级前的 checkpoint 会把 WAL 写回主文件，内容不变、字节会变。
- **换版本也拍快照**：没有待跑的迁移、但打开它的应用版本变了，也先拍一张。
- **基线什么时候冻结**：哈希已钉住。这一轮按监管会话的数据层审查改过一次基线，钉住的哈希同时更新（还没合进 `main`，没有任何库用过旧基线）。建议合进 `main` 就当作已发布，以后都追加新迁移。

### 表

DDL 以 `migrations/0000_baseline.sql` 为准：所有表 `STRICT`，时间一律 Unix 毫秒，**没有触发器、没有级联**。跨表的改动都是 dr-store 里一个显式事务（例如 `purge_doc` 一次删掉一篇文档在所有表里的行），不变量放在命令层和读取容错。

| 表 | 内容 |
| --- | --- |
| `library_meta` | `library_id`（拷贝之间不变）、`epoch`、`installation_id`、`write_seq`、`app_version`、`created_ms` |
| `loro_doc` | 文档登记：`kind`、`book_id`（可空）、`created_ms` |
| `loro_update` | 更新日志：每次提交一行。`origin` 只是本机备注，压缩会删 |
| `loro_snapshot` | 每篇一份完整快照（普通表：快照是 MB 级大块） |
| `loro_head` | 每篇文档最新落盘的 `seq`、版本向量、frontiers、时间，和每次追加同一个事务写 |
| `loro_peer` | 每（设备，文档）的对等方与换代号 |
| `sync_doc` | 服务器已有到哪：`remote_vv` |
| `history_label` | 历史标签，带 `book_frontiers` |
| `agent_settlement` | Agent 结算：会话、轮次、调用、文档、`seq`、前后 frontiers、摘要。没有审阅状态 |
| `index_state` | 每篇派生数据对应的 `indexed_seq` 和 frontiers，以及字数、字符数、段数 |
| `block_index` + `block_fts` | 每段一行（搜索、大纲、段落长度），FTS5 由 dr-store 在同一事务里维护 |
| `reference` | 引用：`link` / `mention` / `embed` |
| `asset` | 资源文件，每个版本一行，带 `uploaded_ms` |

### 文档持有者

- **为什么必须有**：Loro 每个文档只有一个隐式事务，所有克隆共享。测试 `loro_shares_its_implicit_transaction_across_clones` 钉住了这件事。
- **一条消息一次提交**：写入是闭包，持有者线程跑完后 `commit_with(origin, message)`。两个线程同时写 400 次、逐行核对，每一行只含它那个来源的字。
- **一次追加一个事务**：更新行、文档的新 head、全库写入计数，加上不能和它分开的东西（到期的历史标签、Agent 写入的结算记录、同步导入时服务器已有的版本），都在同一个 SQLite 事务里。所以每次提交返回时已经落盘，退出时不需要冲刷，也没有旧版那样的十条车道和 ⌘S 强制保存。
- **先落盘再通知**：Loro 的订阅回调在提交时同步触发、早于写 SQLite，所以持有者先把差异存着，追加成功后才发 `DocEvent`，同时发到库的总线上。
- **别的线程怎么读**：`h.doc()` 给的是 `DocView`，只开放读当前状态的方法。Loro 的 `export`、`fork`、`checkout`、`diff`、光标位置查询和历史遍历都会先提交共享的待提交事务，在别的线程上做会把正在执行的写入切成两半，所以一律放进 `h.read`。
- **兜底**：`DocView` 取出的容器技术上还能改。万一有人改了，持有者在下一件事之前把它单独提交成 `Outside` 来源（提交信息 `outside`）；存不进去就拒绝接下来的写入。
- **失败**：追加失败（比如磁盘满）时改动留在内存里，记下来源和随它要写的东西（标签、结算、同步版本）；之后先用原来源重试，重试不成功就拒绝新写入。写入闭包 panic：已做的改动照样提交落盘，返回 `WritePanicked`；读取闭包 panic：返回 `ReadPanicked`，持有者照常运行。
- **关闭**：放掉最后一个句柄不阻塞，持有者在自己的线程上做完队列里的事、打关闭标签、按需压缩。要等用 `h.close()` 或 `lib.close()`。
- **另载副本是一致的**：`load_copy` 在一个读事务里读快照和之后的更新；载入时有缺依赖的更新直接报错。

### 来源与活动

- 来源不只记在 `loro_update.origin`（压缩会删）：`Agent`、`Mirror`、`Import`（以及 `Outside`）的提交都把来源写进 **Loro 提交信息**，作者自己的提交不带。远端的提交带着它们自己的提交信息过来。
- 「某时间起谁改了哪些文档」（主页签到）：`loro_head.ts` 找出改过的文档，再从每篇文档自己的 Loro 变更里读出对等方、时间和提交信息（`history::changes_since`、`Library::activity_since`）。对等方是不是本机，用 `peer_for` 比对。
- Agent 结算记录（`agent_settlement`）和那次写入在同一个事务里写；作者撤销 Agent 的改动走历史（`revert_to` 到 `before`），由 F3 实现。
- **这些都依赖「不做浅快照」**：来源、活动、历史标签、结算记录里的 frontiers，都要求完整历史还在。以后谁要加浅快照，得先给这些找别的存法。

### 压缩

- 持有者空闲 `idle`（默认 750 ms）后，攒够 `max_updates`（默认 200）条或 `max_bytes`（默认 1 MiB）就压缩；关闭时攒了 `on_close_min_updates`（默认 50）条以上也压缩。默认值来自测量。
- 快照在持有者线程上导出（不占写锁），然后一个事务里写快照、删 `seq <= upto_seq` 的更新。只做完整快照。
- 压缩与上传无关：上传从文档导出 `remote_vv` 之后的改动，不按行上传。

### 历史标签

照旧版快照历史的规则：

- `periodic`：提交之后，距上一个标签满 15 分钟才打；`close`、`restore` 不受间隔限制；
- `agent:<会话>/<轮>`：每轮 Agent 的第一次写入之前打一个，整轮可以一起撤；
- 同一个版本不连着打两个；一小时内全留，一天内每小时留一个，再往前每天一个，30 天以前的删掉；
- 每个标签同时记下当时书目文档（`book:<书 id>`）最新落盘的 frontiers，按实体恢复时两边一起用（F1 给按实体恢复的接口）。

### 派生索引

- 由存储层自己算，不由编辑器推回：`LibraryOptions::deriver` 注册一个 `Deriver`，输入是文档、它的种类和所属的书，以及**自上次以来累积的 Loro 差异**（`None` 表示从头算）。输出现在只有「整篇替换」一种（`DerivedUpdate::Full`，枚举已标 `non_exhaustive`，以后加按段补丁不用改接口）。实现要用 dr-doc 的结构知识和 dr-text 的数法，归 F1/F3。
- 持有者每次追加后标记「索引落后」，空闲时调用派生器，把结果和 `indexed_seq` 在同一个事务里写进去；同一篇文档的索引永远不会倒退（`seq` 不比已存的大就不写）。
- 打开库时（有派生器就默认开），后台线程把 `loro_head.seq > index_state.indexed_seq` 的文档全部重建；打开着的文档交给它的持有者做。这是 P0-E 发现的「缓存落后正文」的根治办法。
- 搜索：3 个字以上走 FTS5 trigram（整句当一个短语），1–2 个字退回 `LIKE`；都不分大小写，结果按文档 id 再按段序排，给出命中位置和上下文。

### 同步状态

- `sync_doc.remote_vv`：服务器已有到哪。`export_for_upload` 先 `sync_to_disk`（断电也不会丢、并抬高水位），再从文档导出 `remote_vv` 之后的改动；收到确认后 `mark_uploaded` 合并进去。
- 从服务器导入时，存储层自动把那份数据包含的版本（Loro 的 `decode_import_blob_meta`）并进 `remote_vv`，所以两台设备共有的创世变更不会被当成「只在本机」。
- `docs_with_local_changes`：`loro_head.vv` 超出 `remote_vv` 的文档，就是「有改动只在这台电脑上」。
- 资源文件带 `uploaded_ms`：`assets_pending_upload`、`mark_asset_uploaded`。
- 旧版的写入者、HLC、`device_seq` 都不要。

### 资源文件

以 `src-tauri/src/native_capabilities.rs` 为准：

- 路径 `assets/<书>/<资源>/<版本>.<扩展名>`；id 按 0.1 的规则变成路径段（`[A-Za-z0-9._-]` 以外的字符换成 `_`，开头的点前面加 `_`），扩展名小写、只许字母数字、最长 16。导入的 0.1 资源目录一一对应。任何一级是符号链接都拒绝。
- 导入：`begin_asset_import` 先原子写导入标记 `.drifting-import-v1`（内容是本进程的会话 id）→ 各版本原子写入、有大小上限（内存写入 64 MiB、复制 512 MiB、显示图 8 MiB、缩略图 1 MiB）→ `commit` 一个事务写所有版本的行 → 清标记。
- 垃圾回收只看**还带标记**的目录：有行就清标记；没有行、标记不是本进程的就删；本进程正在导入的留着；不带标记的目录一律不碰。名字不规范、标记过大或是符号链接都直接报错，不猜。
- 删除：先删行，再落盘删目录。Unix：删资源目录 → 同步书目录 → 书目录空了就删并同步根目录；Windows：先用写穿的 `MoveFileExW` 把目录改名成 `.<名字>.deleting` 墓碑，再递归删除，中断后可重试。
- 图片管线只留了接口 `ImageDeriver`。搬 `src-tauri/src/image_pipeline.rs`（`image` 解码、EXIF 方向、限制尺寸、HEIC/AVIF 走系统解码器）要另开一项。

### 搬来的文件

- `file_io.rs`、`archive.rs` 从 `crates/drifting-core` 原样搬入，只为 edition 2024 把 `extern` 块标成 `unsafe`，其余逐字节相同（包括 11-05 修好的 Windows 写穿 `windows_move_write_through`）。`tests/file_io.rs` 补了 8 项单测（原子写入与复制、改名后目录同步失败、临时文件清理、大小上限、符号链接），Windows 上另有 1 项写穿测试在 CI 跑。
- `archive.rs` 依赖 `zip`，和旧版一样钉在 `=9.4.1`；`flate2` 显式选纯 Rust 后端（`rust_backend`，即旧版实际用的 miniz_oxide），否则单独编 dr-store 时 flate2 没有后端。

## 测量

M3 Pro（12 核，36 GB），release，Loro 1.17.1，2026-11-07，跑时 1 分钟负载约 7（记在证据里）。数据全是合成的：章节由固定字池随机组段，一次写入后压缩，然后模拟打字（每次插 1–6 字，六分之一的概率删 1–3 字）。完整数字在 [acceptance/f2-store-bench.json](../acceptance/f2-store-bench.json)。

| 项 | 结果 | 预算（benchmarks.md） |
| --- | ---: | --- |
| 一次按键写入：持有者线程上提交 + 导出 + 一个事务写更新行、head、写入计数 + 发事件 + 唤醒调用方，2 万字章节，2000 次，`synchronous=NORMAL` | p50 0.037 ms，p95 0.059 ms，最慢 1.5 ms | 单次按键的写入中位数 ≤ 2 ms（探针档）/ ≤ 1 ms（发布档） |
| 同上，`synchronous=FULL` | p50 0.056 ms，p95 0.076 ms，最慢 0.53 ms | — |
| 每次按键的更新平均大小 | 104 字节 | — |
| 打开一章（2 万字快照 + N 条按键更新）：载入 / 载入并读出全文 / 起一个持有者，p50 | N=0：0.11 / 0.22 / 0.12 ms<br>N=100：0.95 / 0.94 / 0.99 ms<br>N=500：3.2 / 3.2 / 3.2 ms<br>N=1000：6.0 / 5.9 / 6.0 ms<br>N=5000：28 / 28 / 29 ms | 打开 2 万字章节 ≤ 80 ms（探针档，含排版） |
| 压缩（2 万字章节，写快照 + 删掉 N 行），p50 | N=100：0.40 ms；N=500：0.55 ms；N=2000：1.2 ms；快照 69–133 KB | — |
| 全书 100 章 × 1.5 万字：从 SQLite 冷载入全部 | 8.9 ms | 冷开全书的 Loro 文档 ≤ 300 ms（发布档） |
| 全书：第一次读出每章全文 | 9.3 ms | — |
| 全书：起 100 个持有者 / 逐个 `close` 等它们收尾 | 12.2 ms / 2.5 ms | — |
| 全书的库文件 | 5.2 MB | — |

怎么读这些数字：

- **按键写入**比第一轮（0.022 ms）多了约 15 µs，是每次追加多写 `loro_head` 和全库写入计数的代价，仍比预算低约 50 倍。最慢的那一次（约 1.5 ms）多半是 SQLite 自动 checkpoint 落在了这次提交上，见「下一步」。
- **打开一章的成本几乎全在待压缩的更新上**：每多一条约 6 µs。所以默认 200 条就压缩（打开 ≤ 约 1.5 ms），关闭时 50 条以上也压缩；一次压缩不到 1 ms，又是在空闲时做。
- **全书数字偏乐观**：每章只有「一次写入」的历史。P0-C 用重型种子测得冷载入 26–29 ms、第一次解码每章 0.8–1.7 ms，更接近真实；两者都远在预算内。
- 机器忙时同一程序会慢 2–4 倍（负载 70 多时测过），所以证据里记着负载。内存 P0-C 已测过，存储层没有改变那些数字。

## 崩溃安全

[acceptance/f2-crash-recovery.json](../acceptance/f2-crash-recovery.json)，`f2-crash run --kills 60 --migration-kills`：

- **编辑中被杀**：写入进程通过真实的持有者不停编辑一篇 3 万字的文档，每 25 次压缩一次，并故意把压缩事务撑开 20 ms。父进程随机时刻强杀（macOS 上 SIGKILL，Windows 上 TerminateProcess），重开库、和「第 0 到第 k 次编辑」的确定性重放逐字比对。60 次里 36 次落在压缩事务中间、2 次刚压缩完、22 次落在两次编辑之间：**零丢失、零不一致**；更新日志始终连续、没有被快照覆盖的残行；有 2 次恢复出了比最后一次报告多一步的编辑（写进去了、还没来得及报告就被杀，允许）。崩溃后重开并载入 p50 13.4 ms，最慢 28 ms。
- **迁移中被杀**：对迁移的六个阶段各杀一次（子进程停在该阶段等着被杀）：

  | 停在 | 原库字节 | 留下的回执 / 影子 | 旧版本还能打开 | 下一次新版本打开 |
  | --- | --- | --- | --- | --- |
  | 拍安全快照前 | 不变 | 0 / 0 | 能 | 迁移成功，正文完整 |
  | 复制影子前 | 不变 | 1 / 0 | 能，回执结清 | 同上 |
  | 迁移事务里（未提交） | 不变 | 1 / 1 | 能，影子和回执结清 | 同上 |
  | 校验前 | 不变 | 1 / 1 | 能，影子和回执结清 | 同上 |
  | 替换前 | 不变 | 1 / 1 | 能，影子和回执结清 | 同上 |
  | 替换后、重开前 | 已是新库 | 1 / 0 | 回执校验新库完整后结清；旧版本报 `SchemaNewer`，库不动 | 不用再迁，正文完整 |

  每种情形之后回执都结清了（`receiptsAfterNextOpens = 0`）。
- CI 里 `tests/crash.rs` 跑同样的程序，杀 6 次加六个迁移阶段，约 2 秒。

## 实测发现（给其他基座）

- **Loro 的 `oplog_vv()` 包含还没提交的本机操作**。
- **Loro 的订阅回调在提交时同步触发**，早于写 SQLite：要「先落盘再通知」，就订阅持有者或库总线，不直接订阅 Loro。
- **Loro 的 `export`、`fork`、`checkout`、`diff`、`get_cursor_pos`、历史遍历都会提交共享的待提交事务**（loro-internal 1.17.1 的 `with_barrier`）。
- **从服务器导入时，`ImportStatus.success` 只含新应用的操作**：要知道服务器有什么，得读数据包本身的版本范围。

## 独立审阅（第一轮）

第一轮做完后请了一个独立会话只读审阅，报了 10 条，9 条已修并补了测试：

| 审阅发现 | 处理 |
| --- | --- |
| `load_copy` 两次读之间撞上压缩，会少读一段更新而不报错 | 改成一个读事务；缺依赖时报错；新测试不修时稳定失败 |
| `h.doc()` 上的导出、检出、光标查询会把正在执行的写入切成两半 | 改成只读当前状态的 `DocView` |
| `restore_backup` 换代太晚、删 WAL 前没检查、直接复制备份文件 | 影子里先换代；先 checkpoint；用 `VACUUM INTO` 复制 |
| 追加失败后重试时丢了 Agent 轮次标签 | 随失败的操作一起记下、重试时补上 |
| 外部改动存不进去时，下一次写入会和它混进一行 | 存不进去就拒绝写入 |
| 读取闭包 panic 会让持有者线程退出 | 捕获，返回 `ReadPanicked` |
| 系统时间往回调过时，刚拍的安全快照会被保留策略删掉 | 刚拍的永不删；先写临时名再改名 |
| 放掉最后一个句柄时同步等持有者，可能互相等死 | 放句柄不再等；`h.close()`、`lib.close()` 才等 |
| 「失败后原库字节不变」只在 WAL 为空时成立 | 写明含义 |
| 断电后可能复用对等方计数器 | `sync_to_disk` + 水位，见「库的文件夹与本机身份」 |

## 监管会话的架构与数据层审查（第二轮）

| 要求 | 处理 |
| --- | --- |
| 资源存储以 `native_capabilities.rs` 为准 | 按它重写：三种版本、`.drifting-import-v1` 标记、只回收带标记的目录、Windows 墓碑删除；单测照搬 |
| `database.rs` 只搬影子库迁移、恢复回执、按版本的快照 | 补上恢复回执及其结清规则，测试照旧版的情形移植；SQL 网关和 Drizzle 部分不搬 |
| `file_io.rs`、`archive.rs` 原样搬并补单测 | 已搬，见「搬来的文件」 |
| 每次提交就落盘，退出不需要冲刷 | 本来就是；写进持有者的说明。崩溃测试证明强杀后零丢失 |
| 写作日设备键沿用 `sync-installation-v2.json` | `identity.rs`；对等方不从它派生，理由见上 |
| 派生数据由 dr-store 按 Loro 差异算 | `Deriver` 接口、空闲时派生、打开库时重建落后的 |
| 库被搬走或被旧备份盖回时自动换代 | `installation_id` 比对 + 库外水位 |
| 记住服务器已有什么，压缩与上传无关 | `sync_doc.remote_vv`、`export_for_upload`；资源带 `uploaded_ms` |
| 派生索引带版本戳，同一事务写，打开时重建 | `index_state.indexed_seq` |
| 来源写进 Loro 提交信息；Agent 结算表；写明依赖不做浅快照 | 见「来源与活动」 |
| 历史标签同时记书目文档的 frontiers | `history_label.book_frontiers` |
| 本机表的变化发到和 Loro 事件同一条总线 | `Library::subscribe`、`notify_local` |
| Loro 表和派生表不写触发器 | 基线里没有触发器和级联，测试检查 `sqlite_schema` |

## 待协调

1. **F1 的接入点**：`configure_doc`（样式表）、`OpenDoc::CreateIfMissing.genesis`（创世），以及 `Deriver`（段落、块 ID、人物链接 → `BlockRow`、`RefRow`，字数用 dr-text）。书目文档的 id 按 loro-schema 用 `book:<书 id>`，历史标签靠它找书目文档的版本。
2. **`loro_doc.book_id`**：F3 创建任何属于某本书的文档时传入，书目文档自己也填。
3. **F4 编辑器怎么读写**：写一律走 `write` 闭包；读用 `DocView` 或 `h.read`。批注锚点的位置（`get_cursor_pos`）、导出、回看要放进 `h.read`。`UndoManager` 建议放在写闭包里用。
4. **基线冻结的时间**：见「迁移与恢复回执」最后一条。
5. **搜索结果的顺序**：现在按文档 id、段序；要按书序排，需要 F3 用书目文档排，或以后给 `block_index` 加书序列。
6. **本机表**（帮手运行记录、权限、Markdown 台账、工作记忆、生图收件箱）：谁需要谁追加 `0001_*.sql`，变化用 `notify_local` 发到总线。
7. **同步 v2（阶段 6）**：上传走 `export_for_upload` → `mark_uploaded`；导入走 `h.import(.., Origin::Sync)`，存储自动记服务器已有的版本。服务端协议和多文档恢复是阶段 6 的事。
8. **搬到新电脑但身份文件也被拷走**（迁移助理）：两台电脑的安装 id 相同，自动换代抓不到。可以在身份文件里加机器指纹（macOS 的 `IOPlatformUUID`、Windows 的 `MachineGuid`），指纹变了就当新设备。这会改变写作日的设备键（新电脑本来就是新设备），需要监管会话点头。
9. **Windows**：代码有 Windows 分支（写穿改名、墓碑删除、可写句柄 fsync），本机只能编 Rust、编不了打包的 SQLite C 代码，只能靠 CI 的 Windows 那一条验证。

## 没做的、下一步建议

- 图片管线（`image_pipeline.rs` 和各平台解码器）只有接口。
- 派生器的真正实现（F1/F3），以及按段补丁（`DerivedUpdate` 的下一种）。
- 帮手的本机表、整库备份（`library_backup.rs`：`VACUUM INTO` 加资源文件打包）、按账号分库（M36）。
- WAL 自动 checkpoint 会让某一次提交多花约 1 ms；如果真实打字测到尾延迟，改在持有者空闲时做被动 checkpoint。
- 建议下一个里程碑：F1 的 dr-doc 出来后做「F1 + F2」接线测试：真实的创世、样式表和派生器跑一遍崩溃测试和测量，再接 F3。

## 怎么复现

在 `next/` 下：

```bash
cargo test -p dr-store
cargo run --release -p dr-store --bin f2-bench
cargo run --release -p dr-store --bin f2-crash -- run --kills 60 --migration-kills
cargo run --release -p dr-store --bin f2-bench -- --check
cargo run --release -p dr-store --bin f2-crash -- --check
```

- `f2-bench` 写 `docs/rust-rewrite/acceptance/f2-store-bench.json`，`f2-crash` 写 `f2-crash-recovery.json`。两份都带源码指纹和当时的机器负载；`--check` 只校验指纹和形状，不校验耗时。
- 测试数据全是合成的（`dr_store::synthetic`：固定字池随机组段），不含任何书稿。
