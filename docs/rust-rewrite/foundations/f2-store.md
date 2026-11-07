# F2 dr-store：存储基座

2026-11-07 起。代码在 `next/crates/dr-store/`，计划见 [foundation.md 的 F2](../foundation.md#f2-dr-store)，Loro 文档结构见 [loro-schema.md](../loro-schema.md)。

## 大白话

一个库就是一个文件夹：一个 SQLite 文件装着所有书的 Loro 数据、派生索引、资源登记和本机记录，旁边是资源文件、升级前的安全快照和升级回执。库外面（应用的本机数据目录）还有这台设备的身份文件和「见过每个库写到哪」的水位记录。

- **打开库**：新库直接建表。旧库要升级时，先把整个库拍一张安全快照，在快照的副本上升级，检查无误后才换掉原库；每次尝试都留一张回执。升级失败，原库内容不变，报错里写着快照和回执在哪。库被拷到别的电脑、或者被旧备份盖回来时，打开就自动「换代」：以后每篇文档都换新的对等方 ID，不会和别处已经写过的操作撞号。
- **打开一篇文档**：每篇打开的文档有一个专门的线程（持有者）。作者打字、Agent 写入、Markdown 文件夹、同步进来的更新，全都排队交给它，一件一次提交、一次只有一个来源。提交后先写进 SQLite 再通知界面，所以每次提交都已经落盘，退出时什么都不用冲刷（GPUI 只给退出钩子 200 ms）。
- **谁改了什么**：Agent、Markdown 文件夹、导入的提交都把来源写进 Loro 的提交信息，跟着文档走、压缩删不掉。每次 Agent 写入还会在同一个事务里留下一条结算记录。
- **压缩与历史**：文档空闲时把攒下的小更新压成一份完整快照，历史一直全留着。值得回去的版本打标签，同时记下当时书目文档的版本；要看某个版本，就从 SQLite 另载一份副本。
- **派生索引**（搜索、大纲、段落长度、引用、字数）由存储层自己算：持有者空闲时把攒下的 Loro 差异交给「派生器」，结果和它对应的版本号在同一个事务里写进去；打开库时把落后的文档重建一遍。改了一段就只写那一段，不用整篇重写。
- **只读打开**：检查工具（`dr-cli inspect`）可以在应用开着的时候只读打开同一个库：不升级、不拿锁、不拍快照，什么都写不进去。
- **同步**：每篇文档记住服务器已经有到哪（`remote_vv`），上传时从文档本身导出那之后的改动，所以压缩和上传互不相干。
- **资源文件**：照旧版 `native_capabilities.rs` 的做法存原文件、显示图、缩略图；图片管线这一轮只留了接口。
- **换电脑**：身份文件旁边记着「这个身份属于哪台机器」（系统机器 id 的摘要）。迁移助理把整个应用数据搬到新电脑时，机器对不上，这台就当新设备：换一个安装 id，写作日里算新设备，打开的每个库也自动换代。

## 里程碑状态

| # | 里程碑 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 数据库基线与迁移：基线、安全快照、影子库、恢复回执、失败原库不变 | 完成 | `tests/migrate.rs`（16 项，含每个阶段注入失败、模拟崩溃、回执的各种状态） |
| 2 | 表：Loro 相关表、历史标签、结算、同步状态、派生索引、资源 | 完成 | `migrations/0000_baseline.sql`；`tests/index.rs`（18 项，另有 1 项手动测量） |
| 3 | 文档持有者：专用线程、来源标记、先落盘再发事件、作者与 Agent 不同提交 | 完成 | `tests/holder.rs`（19 项）、`tests/records.rs`（14 项） |
| 4 | 压缩与历史：后台压缩、同事务删除、不做浅快照、另载副本回看 | 完成 | `tests/holder.rs`、`tests/records.rs` |
| 5 | 崩溃安全：编辑中被杀、迁移各阶段被杀 | 完成 | `tests/crash.rs`（迁移六个阶段各杀一次，用 dr-testkit 的试验台）；编辑中被杀归 dr-testkit 的 `tests/crash_store.rs` |
| 6 | 资源文件：三种版本、导入标记协议、垃圾回收、落盘删除、图片管线接口 | 完成（管线只有接口） | `tests/asset.rs` 和 `asset.rs` 里的单测 |
| 7 | 测量 | 完成 | 现由 dr-testkit 的 `bench store` 测，证据 [acceptance/f8-m1-store-bench.json](../acceptance/f8-m1-store-bench.json)；见下文「测量」 |
| — | 本机身份与自动换代、同步状态、派生器、事件总线（监管会话追加） | 完成 | `tests/device.rs`（5 项）、`tests/sync.rs`（3 项）、`tests/records.rs` |
| — | 机器指纹：换了机器就当新设备（监管会话批准待协调第 8 条） | 完成 | `machine.rs`、`identity.rs` 的单测（7 项）、`tests/device.rs` |
| — | `file_io.rs`、`archive.rs` 原样搬入并补单测 | 完成 | `tests/file_io.rs`（8 项，Windows 另有 1 项在 CI 跑） |
| — | M10 要的接口：`label_at`、`Device::adopt`、导入回执表（`0001`）、`repair` 来源 | 完成 | `tests/labels.rs`（3 项）、`identity.rs` 单测、`tests/migrate.rs`、`tests/sync.rs`、`tests/records.rs` |
| — | 第三轮（监管会话）：按段写派生索引、类型化读取、本机表 `ws_journal`（`0003`）、书序搜索、关库被拒时交还、大纲规则、只读打开、换用 dr-testkit | 完成 | `tests/index.rs`、`tests/holder.rs`、`tests/records.rs`、`tests/crash.rs`；见「第三轮」 |

合计 122 项测试（macOS：32 项单测、90 项集成测试），另有 1 项手动测量默认不跑。按平台条件算，Windows 上是 115 项：少了只在 Unix/macOS 上有意义的 8 项（符号链接、目录同步、`IOPlatformUUID`、子进程拿着锁文件），多 1 项写穿改名；没在 Windows 上跑过。

## 接口概览

```rust
// 设备：库外的身份文件与水位
let device = Device::open(app_local_dir)?;          // 读写 sync-installation-v2.json（与 0.1 同一个文件），并核对机器指纹
device.machine_changed();                           // 身份来自别的机器：已换成新的安装 id
Device::adopt(app_local_dir, &old_installation_id)?; // 导入时：目录里还没有身份，就采用 0.1 那份
device.writing_device_key();                        // 写作日的设备键，与 0.1 算法一致

// 打开库（一个文件夹；同一时刻只能被一个进程、一个 Library 打开）
let mut options = LibraryOptions::new(env!("CARGO_PKG_VERSION"));
options.device = Some(device);
options.configure_doc = Some(Arc::new(dr_doc::schema::configure)); // F1 接入点：样式表
options.deriver = Some(Arc::new(my_deriver));      // F1/F3 接入点：派生索引
options.derive_idle = Duration::from_millis(150);   // 空闲多久就派生（默认值）；压缩看 options.compaction.idle
let lib = Library::open(root, options)?;           // 新建 / 迁移 / 自动换代
let ro = Library::open_read_only(root, options)?;  // 只读：不迁移、不拿锁、不拍快照（dr-cli inspect）
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
h.doc().with_doc(|doc: &LoroDoc| ..);               // 同上，给要 &LoroDoc 的类型化读取（dr-doc 的视图）
h.subscribe(|e: &DocEvent| ...); h.reindex_now()?; h.compact_now()?; h.label(labels::RESTORE)?;
lib.label_at(doc_id, &frontiers, "import", ts_ms, LabelRetention::Thinned)?; // 指定版本、指定时间的历史点
lib.label_many(&[NewLabel { .. }])?;                // 同上，多条一个事务（导入重放旧版本用）
h.close();                                          // 最后一个句柄：等持有者收尾；直接 drop 不阻塞

// 总线：所有文档的已落盘变化 + 本机表的变化
let _sub = lib.subscribe(|e: &StoreEvent| ...);     // Doc(DocEvent) | Local(LocalChange)
lib.notify_local(LocalChange::new("agent_run", id, LocalChangeKind::Insert)); // 自己发
lib.local_write(|tx| {                              // F3 的本机表：一个事务，提交后才发
    tx.execute("INSERT INTO ws_journal ..", params)?;
    tx.changed(LocalChange::new("ws_journal", id, LocalChangeKind::Insert));
    Ok(())
})?;

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
// 派生器返回 DerivedUpdate::Full(Derived) 或 ::Patch(DerivedPatch)；DeriveInput.held 说明是不是持有者的文档
lib.patch_index(&DocPatch { doc_id, book_id, seq, frontiers, patch: &DerivedPatch::between(&old, &new) })?;
lib.search(Some(book), "安娜", 50)?;                // 3 字以上 FTS5 trigram，1–2 字 LIKE
lib.search_in_order(Some(book), "安娜", 50, &doc_ids_in_book_order)?; // 先按书序排，再截 limit
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
lib.local_transaction(|tx| { /* 本模块自己的本机表 */ Ok(()) })?; // 例如导入回执；之后 notify_local
lib.local_read(|conn| ...)?;
lib.close()?;                                       // 等持有者和后台重建收尾、关库、放锁
match lib.try_close() { Err(CloseRefused { error, library }) => /* 还有文档开着：库还回来，可重试 */, Ok(()) => .. }
```

`Origin` 是 `User`、`Agent("<会话>/<轮>")`、`Mirror`、`Sync`、`Import`、`Repair`（dr-doc 的确定性修复）、`Genesis`，外加兜底用的 `Outside`。字符串和 dr-model 的 `Origin` 一一相同，有测试对照。

## 设计与取舍

### 库的文件夹与本机身份

```text
<root>/library.sqlite
<root>/library.lock                    打开期间加排他锁（std 的 File::try_lock）
<root>/assets/<书>/<资源>/{source,display,thumbnail}.<扩展名>
<root>/safety-snapshots/<版本>/library-*.sqlite      每个版本留最新 3 份
<root>/safety-snapshots/recovery/<回执 id>.json
<设备目录>/sync-installation-v2.json   本机安装身份（与 0.1 同一个文件、同一个格式）
<设备目录>/device-machine-v1.json      这个身份属于哪台机器（机器 id 的加盐摘要）
<设备目录>/library-watermarks.json     每个库：这台设备见它写到过哪
```

- **独占**：loro-schema 的对等方规则以「一个库只被一个进程打开」为前提。所以打开时对 `library.lock` 加排他锁：另一个进程、或同一进程里第二个 `Library` 都打不开。进程被杀时系统自动放锁。
- **关库时明确放锁**：Unix 上这把锁是 `flock`，属于「打开的文件」而不是进程。别的线程正在启动子进程时，子进程在换成自己的程序之前手里有一份所有文件描述符的副本；只关掉我们自己那份，锁要等子进程那份也关了才放。所以关库时先显式解锁，所有副本一起失效（见下文「M10 报的两处」）。
- **两条连接**：一条写（所有持有者共用，Rust 互斥锁排队），一条只读（`query_only`）。WAL 下读不挡写。
- **本机身份**：`identity.rs` 原样搬了 0.1 的 `installation_identity.rs`：随机 32 字节、先写临时文件再硬链接发布、损坏时报错且不改动文件、只给本人读写。写作日的设备键沿用 0.1 渲染层的算法（`device-key.ts`：`SHA-256("drifting.writing-day.v1\n" + 安装 id)` 的前 12 字节），同一台设备导入后在写作日里还是同一台。
- **机器指纹**（`machine.rs`）：macOS 读硬件 UUID（`gethostuuid`，和 `ioreg` 里的 `IOPlatformUUID` 是同一个值，测试逐字比对过），Windows 读 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`（`RegGetValueW`，强制 64 位视图）。只存 `SHA-256("drifting.machine.v1\n" + 大写的机器 id)`，不存原值。其他平台没有指纹，也就不做这项检查。
- **换了机器就当新设备**：`device-machine-v1.json` 记着「安装 id → 机器摘要」。`Device::open` 时：
  - 没有这个文件（第一次运行，或从 0.1 升级上来）：绑定到这台机器；
  - 安装 id 对得上、机器摘要也对得上：什么都不做；
  - 安装 id 对得上、机器摘要不同：身份是在别的机器上生成的（迁移助理、恢复了整个用户目录）。生成新的安装 id 原子替换身份文件（仍是 0.1 的格式和只给本人读写的权限），再写新的绑定，`machine_changed()` 为真。写作日的设备键随之改变（新电脑就是新设备），打开的每个库都因为安装 id 不同而自动换代；
  - 安装 id 对不上（身份文件被删后重建，或上一步在两次写入之间崩溃）：只重新绑定，不再换。
  - 绑定文件损坏：报错，不猜、不动任何文件。
- **为什么不写进身份文件本身**：0.1 读 `sync-installation-v2.json` 用的是 `deny_unknown_fields`，多一个字段它就会当成损坏、停用同步。所以摘要放在同一目录的另一个文件里，效果相同，0.1 照常能读。
- **采用旧身份**（`Device::adopt`）：导入 0.1 库时，新设备目录里还没有身份文件，就把 0.1 那份安装 id 原样写进来（0.1 的格式、只给本人读写、和首次创建一样用硬链接发布，绝不覆盖已有的），写作日里还是同一台设备。下一次 `Device::open` 把它绑到这台机器。局限：如果旧数据本身是从别的机器拷来的，采用时分辨不出来（0.1 没有机器绑定）。
- **对等方 ID 不从安装身份派生**：对等方仍是每库、每（设备，文档）随机一个，存在 `loro_peer`；搬库靠下面的自动换代兜住。
- **自动换代**：`library_meta` 记着上次打开它的安装 id 和一个全库的写入计数 `write_seq`（每追加一行加一，和那一行在同一个事务里）。打开时：
  - 安装 id 和本机不同：库是从别的设备拷来的，换代（`EpochChange::OtherDevice`）；
  - `write_seq` 低于本机水位：库被旧备份盖回来了，换代（`EpochChange::OlderCopy`），并把计数抬到水位，免得每次打开都换；
  - 水位在**东西离开本机时**抬高（`sync_to_disk`、`export_for_upload`），关库时也抬。只在本机出现过、没离开过的操作被旧备份覆盖后重用，不会造成分歧。
  - 局限：同一台电脑上把整个库文件夹复制一份、两份轮流用，第二份打开时比水位低会换代，第一份之后可能再换一次。换代总是安全的，只是对等方会多几个。
- 按账号分库（M36）以后在这一层之上做，参考 `src-tauri/src/library_registry.rs`：每个账号一个这样的文件夹，共用同一个设备目录。

### 只读打开与关库

- **只读打开**（`Library::open_read_only`，给 `dr-cli inspect`）：
  - 两条连接都以 SQLite 只读方式打开，再加 `query_only`，任何写都会失败；
  - 不拿 `library.lock`，应用开着同一个库时也能打开；WAL 下每次读看到的是一致的某一刻；
  - 不迁移、不拍安全快照、不看换代、不在后台重建索引；库的迁移条数必须正好等于本版本的，否则报 `NeedsMigration { applied, known }`；
  - 不能 `open_doc`（报 `ReadOnly`），但 `load_copy`、历史、搜索、统计都照常能读。
- **关库被拒时交还**：还有文档句柄开着（`DocumentsOpen(n)`），或者这个 `Library` 还有别的克隆活着，关库会被拒。`lib.try_close()` 被拒时返回 `CloseRefused { error, library }`，把库还给调用方，关掉句柄后可以再试；`close()` 是丢掉库、只留错误的那个版本。因为克隆被拒时，后台重建已经停了：落后的索引等文档打开、或下次打开库时再补。后台重建从不拿已打开文档的句柄（见「派生索引」），所以它不会让关库被拒。

### 迁移与恢复回执

照旧版 `crates/drifting-core/src/database.rs` 的影子库迁移、恢复回执、按版本的安全快照那一段改写；给渲染层的 SQL 网关和 Drizzle 相关的部分不搬（Drizzle 旧库留给 dr-import-v1）。新基线用自己的迁移记录表 `schema_migration`（序号、名字、SHA-256）。

- 迁移是 `migrations/` 下按序号排的 SQL 文件。记录必须是本版本列表的前缀，否则报 `SchemaMismatch`（改过已发布的迁移），比本版本多则报 `SchemaNewer`（请升级应用）；两种情况都不碰库。每条迁移的哈希只在一个地方钉：F8 的门禁 `next/xtask/src/gates/migrations.rs` 的 `PINNED`（`cargo xtask check` 的 migrations 一道）。新迁移在那里登记，发布后填上哈希。
- **升级步骤**：checkpoint 清空 WAL → `VACUUM INTO` 安全快照（先写临时名，fsync 后改名）→ 写回执（快照的相对路径、SHA-256、大小、来源和目标版本）→ 关连接 → 回执记下影子文件名 → 把快照复制成影子 → 在影子上迁移（一个事务）→ `integrity_check`、`foreign_key_check`、迁移记录完整 → fsync → 回执改成「替换中」→ 删掉原库已空的 `-wal`/`-shm` → 原子改名替换原库并 fsync 目录 → 重新打开再检查 → 删回执。
- **失败**：替换之前任何一步失败，影子删掉，原库内容不变；回执留着，写明失败阶段和原因。返回 `MigrationFailure { stage, detail, safety_snapshot, recovery_id, from, to }`。只有「替换之后重新打开」失败时库已是新的，`source_unchanged()` 为假。改名成功、只是之后同步目录失败的情况，会检出库已迁完，照常往下走。
- **下次打开先结清回执**（照旧版）：读不出的回执 → 停（`recovery-receipt-invalid`），不猜；快照哈希或大小对不上 → 停（`safety-snapshot-invalid`）；没到「替换中」、或影子还在 → 替换没发生，删影子和回执、照常打开（有待跑的迁移就重试）；「替换中」且影子已不在 → 替换已发生，库必须完整、迁移条数等于回执的目标，否则停（`activated-database-invalid`），不在半成品上继续迁移。停下时界面用 `Library::recovery_receipts` 读回执，`restore_from_receipt` 校验哈希后恢复。
- **「原库不变」的确切含义**：原库正常关闭过（WAL 为空）时逐字节不变，测试按这个校验；上次是崩溃退出时，升级前的 checkpoint 会把 WAL 写回主文件，内容不变、字节会变。
- **换版本也拍快照**：没有待跑的迁移、但打开它的应用版本变了，也先拍一张。
- **已合进 `main` 的迁移**：基线随 `main` 的 `e0a9e964` 合入，从此不再改；之后的表一律追加。现在有四条：
  - `0000_baseline`；
  - `0001_import_receipts`：导入回执表（见「本机表」）；
  - `0002_history_label_keep`：历史标签加 `keep` 列，`1` 表示不参与修剪；
  - `0003_ws_journal`：F3 的本机日志表（见「本机表」）。

  测试 `a_baseline_library_gets_the_later_published_migrations` 用只有基线的旧库走一遍真实的升级：先拍安全快照，再在影子库上迁后面几条，正文和已有标签都在。
- **哈希还没人钉**：`PINNED` 里四条现在都是 `None`（F8 的约定：第一个 0.2 版本发布时才填），门禁只提示「not published yet」。以前 dr-store 自己有一个 `PUBLISHED` 测试钉着前三条，第三轮删了，免得两份名单。监管会话定了：等第一个 0.2 版本真正发布时再钉，在那之前保持「未冻结」。

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
| `import_run`、`import_book`、`import_doc`、`import_anchor`、`import_original` | 导入回执（`0001`，M10 写） |
| `ws_journal` | F3 的本机日志（`0003`，F3 写） |

### 文档持有者

- **为什么必须有**：Loro 每个文档只有一个隐式事务，所有克隆共享。测试 `loro_shares_its_implicit_transaction_across_clones` 钉住了这件事。
- **一条消息一次提交**：写入是闭包，持有者线程跑完后 `commit_with(origin, message)`。两个线程同时写 400 次、逐行核对，每一行只含它那个来源的字。
- **一次追加一个事务**：更新行、文档的新 head、全库写入计数，加上不能和它分开的东西（到期的历史标签、Agent 写入的结算记录、同步导入时服务器已有的版本），都在同一个 SQLite 事务里。所以每次提交返回时已经落盘，退出时不需要冲刷，也没有旧版那样的十条车道和 ⌘S 强制保存。
- **先落盘再通知**：Loro 的订阅回调在提交时同步触发、早于写 SQLite，所以持有者先把差异存着，追加成功后才发 `DocEvent`，同时发到库的总线上。
- **别的线程怎么读**：`h.doc()` 给的是 `DocView`，只开放读当前状态的方法。Loro 的 `export`、`fork`、`checkout`、`diff`、光标位置查询和历史遍历都会先提交共享的待提交事务，在别的线程上做会把正在执行的写入切成两半，所以一律放进 `h.read`。
- **类型化读取**：dr-doc 的视图要的是 `&LoroDoc`，用 `h.doc().with_doc(|doc| ..)` 借出同一篇文档。规矩和 `DocView` 一样：只读当前状态，上面那些会提交的操作不许在这里做。
- **写闭包开始时文档是干净的**：持有者在每件事之前先结清（重试没存进去的、把外部改动单独提交成 `Outside`），所以写闭包拿到的文档没有待提交的事务，闭包里的改动全属于这一次写。F4 的镜像拆掉之前，这一点不变（测试 `a_write_starts_on_a_settled_document_and_typed_readers_borrow_it`）。
- **兜底**：`DocView` 取出的容器技术上还能改。万一有人改了，持有者在下一件事之前把它单独提交成 `Outside` 来源（提交信息 `outside`）；存不进去就拒绝接下来的写入。
- **失败**：追加失败（比如磁盘满）时改动留在内存里，记下来源和随它要写的东西（标签、结算、同步版本）；之后先用原来源重试，重试不成功就拒绝新写入。写入闭包 panic：已做的改动照样提交落盘，返回 `WritePanicked`；读取闭包 panic：返回 `ReadPanicked`，持有者照常运行。
- **关闭**：放掉最后一个句柄不阻塞，持有者在自己的线程上做完队列里的事、打关闭标签、按需压缩。要等用 `h.close()` 或 `lib.close()`。
- **另载副本是一致的**：`load_copy` 在一个读事务里读快照和之后的更新；载入时有缺依赖的更新直接报错。

### 来源与活动

- 来源不只记在 `loro_update.origin`（压缩会删）：`Agent`、`Mirror`、`Import`、`Repair`（以及 `Outside`）的提交都把来源写进 **Loro 提交信息**，作者自己的提交不带。远端的提交带着它们自己的提交信息过来。
- `genesis` 和 `repair` 的行和别的行一样追加、一样上传：上传按 `remote_vv` 从文档导出，不看来源（`repair_and_genesis_rows_are_appended_and_uploaded_like_any_other`）。各设备的创世变更字节相同，服务器和 Loro 都会去重；修复是确定的，两台设备修出来的值相同。`repair` 不触发周期标签。
- 「某时间起谁改了哪些文档」（主页签到）：`loro_head.ts` 找出改过的文档，再从每篇文档自己的 Loro 变更里读出对等方、时间和提交信息（`history::changes_since`、`Library::activity_since`）。对等方是不是本机，用 `peer_for` 比对。
- Agent 结算记录（`agent_settlement`）和那次写入在同一个事务里写；作者撤销 Agent 的改动走历史（`revert_to` 到 `before`），由 F3 实现。
- **这些都依赖「不做浅快照」**：来源、活动、历史标签、结算记录里的 frontiers，都要求完整历史还在。以后谁要加浅快照，得先给这些找别的存法。

### 压缩

- 持有者空闲 `compaction.idle`（默认 750 ms）后，攒够 `max_updates`（默认 200）条或 `max_bytes`（默认 1 MiB）就压缩；关闭时攒了 `on_close_min_updates`（默认 50）条以上也压缩。默认值来自测量。
- 快照在持有者线程上导出（不占写锁），然后一个事务里写快照、删 `seq <= upto_seq` 的更新。只做完整快照。
- 压缩与上传无关：上传从文档导出 `remote_vv` 之后的改动，不按行上传。

### 历史标签

照旧版快照历史的规则：

- `periodic`：提交之后，距上一个标签满 15 分钟才打；`close`、`restore` 不受间隔限制；
- `close` 只在这次打开有过「值得打点」的提交时才打，口径和 `periodic` 一样：只有创世、导入、修复、外部改动的话不打；
- `agent:<会话>/<轮>`：每轮 Agent 的第一次写入之前打一个，整轮可以一起撤；
- 同一个版本不连着打两个，不管上一个是持有者自己打的，还是文档开着时别人用 `label_at` 打的；一小时内全留，一天内每小时留一个，再往前每天一个，30 天以前的删掉；
- 每个标签同时记下当时书目文档（`book:<书 id>`）最新落盘的 frontiers，按实体恢复时两边一起用（F1 给按实体恢复的接口）。
- **指定版本、指定时间的历史点**（`label_at`、`label_many`，导入重放 0.1 的快照历史用）：书目文档的版本取当前落盘的那个。参数 `LabelRetention` 默认 `Thinned`：照常修剪，所以早于 30 天的点写进去马上就会被删；`Kept` 写 `keep = 1`，永不修剪。M10 要不要保留导入的旧历史点，由它选。
- 文档打开着时也可以 `label_at`；持有者记着的「上一个标签」只认它自己打的，影响的只是下一个周期标签什么时候到期。

### 派生索引

- 由存储层自己算，不由编辑器推回：`LibraryOptions::deriver` 注册一个 `Deriver`，输入是文档、它的种类和所属的书，以及**自上次以来累积的 Loro 差异**（`None` 表示从头算）。实现要用 dr-doc 的结构知识和 dr-text 的数法，在 dr-index。
- **两种输出**（枚举仍是 `non_exhaustive`）：
  - `DerivedUpdate::Full(Derived)`：整篇替换；
  - `DerivedUpdate::Patch(DerivedPatch)`：只写改了的段。`base_paragraphs` 是做补丁时依据的段数；`splices` 是按位置排好、互不重叠的若干处「从第 `at` 段起删 `removed` 段、换成这些段」，位置都按补丁之前的段序；`references` 是 `None` 表示引用没变，`Some` 就整篇换掉（引用很少）；`words`、`chars` 是整篇的新合计。`DerivedPatch::between(旧, 新)` 按首尾相同的段算出一处替换，派生器留着上一次的结果时可以直接用。
- **补丁只落在它依据的那些行上**：存着的段数不等于 `base_paragraphs`，写入就报 `IndexBase`，什么都不改；持有者遇到它就丢掉攒的差异，下次从头算一遍。补丁的 `seq` 不比已存的大就跳过，和整篇写一样。
- **段序是带空隙的排序键**：`block_index.ord` 不再等于「第几段」，只用来排序。整篇写入时每段隔 2³²；补丁先删掉被替换的行（连同 FTS 条目），再给新段取它前后两段的键之间的值（在末尾就接着隔 2³²，在中间就均匀分开），**后面的行一行都不动**。所以回车只写两行，不管这一章后面还有多少段。
  - 相邻（一处结束正好是下一处开始）的几处替换共用同一个空隙，一起分配。
  - 空隙用完（同一个位置连着插了 32 次左右）才把整篇重新编号：先把留下的行整体挪到所有键之上（`UNIQUE(doc_id, ord)` 已随基线发布，不能改），再逐行给新键。
  - 键始终不超过 2⁶⁰，挪上去也不会溢出。
  - **旧库**：以前的库里段序是 0、1、2……，读起来一样；在末尾追加照样有空隙，第一次在中间插段时那一篇重新编号一次。不需要迁移。
  - **对外的段号不变**：`SearchHit.ord`、`OutlineEntry.ord` 仍是第几段（从 0 起）。读的时候按这篇文档的键数出来：每篇只从 `(doc_id, ord)` 索引读一次键，再二分。
  - 随机 400 步补丁和整篇重写逐行比对、FTS 完整性检查都过；另有一组在「键被压成 0、1、2……」、补丁被切成几处相邻替换的情况下跑同样的比对，专门走重新编号。
- **引用也只写变了的**：`references` 是 `Some` 时，dr-store 拿它和存着的那篇的引用比：头尾相同的行都留着，只删、只插中间变了的那一段。`references_from` 按行号给出引用，顺序就是派生器给的顺序，所以每篇的引用行号也带空隙（隔 2¹⁶），新行取前后两行之间的号；没有空隙（或是以前一条挨一条写的旧行），就把这一篇的引用在表尾重写一遍。
  - 为什么要这样：人物链接多的章节里，回车把带链接的一段切开，这一篇的引用确实变了；以前每次都整篇删了重插，那一章上百行引用，占了回车的大半时间。
- **`held`**：`DeriveInput.held` 为真，是持有者自己的那篇文档，值得把结果缓存起来接下一次的差异；为假，是后台重建从 SQLite 另载的副本，只读一次，派生器不该把它放进缓存。
- 持有者每次追加后标记「索引落后」，空闲时调用派生器，把结果和 `indexed_seq` 在同一个事务里写进去；同一篇文档的索引永远不会倒退（`seq` 不比已存的大就不写）。
- 打开库时（有派生器就默认开），后台线程把 `loro_head.seq > index_state.indexed_seq` 的文档全部重建。已经打开的文档它跳过，不拿句柄：持有者打开时就知道索引落后，空闲时自己补。这是 P0-E 发现的「缓存落后正文」的根治办法。
- **派生有自己的空闲等待**：`LibraryOptions::derive_idle`（默认 150 ms）。最后一件事过去 150 ms 就派生，压缩照旧等 `compaction.idle`（750 ms）。哪件做过（或失败了），都要再等满一段才重试，不会空转。
- 搜索：3 个字以上走 FTS5 trigram（整句当一个短语），1–2 个字退回 `LIKE`；都不分大小写，给出命中位置和上下文。`search` 按文档 id 再按段序排。`search_in_order(书, 查询, limit, 文档顺序)` 先按传进来的文档顺序排（不在名单里的排在后面，按 id），再截 `limit`，所以截出来的就是书里最前面的那些命中；顺序由 F3 从书目文档取。
- **按书序搜索**，SQL 文本都是固定的（`prepare_cached` 能一直用），耗时不再随书序长度变：
  - 3 个字以上（FTS）：先只取所有命中的行号、文档和段序键，不取文字；在 Rust 里按 `HashMap<文档, 名次>` 排好，截出前 `limit` 条，再按行号取这几行的文字、切片段。
  - 1–2 个字（`LIKE`，反正要逐行看）：按传进来的顺序一篇一篇查（走 `(doc_id, ord)` 索引），凑够 `limit` 条就停；常见的字头几章就够了。不够再查名单以外的文档（`NOT IN json_each(名单)`），按 id 排。
- **段号要现数**：段序键不等于第几段，所以搜索结果和大纲里的段号要数出来。每条命中在索引上数一次（`count(*) … ord < 键`）；同一篇命中超过 4 条，就把这篇的键读一遍再二分。
- 大纲：照 dr-text 的规则，标题文字按 JavaScript 的空白去掉首尾（`is_js_whitespace`，和 prose-metrics 的判断逐字比对过），去完是空的标题不列。`paragraphs_after` 没做，原因见「待协调」。

### 同步状态

- `sync_doc.remote_vv`：服务器已有到哪。`export_for_upload` 先 `sync_to_disk`（断电也不会丢、并抬高水位），再从文档导出 `remote_vv` 之后的改动；收到确认后 `mark_uploaded` 合并进去。
- 从服务器导入时，存储层自动把那份数据包含的版本（Loro 的 `decode_import_blob_meta`）并进 `remote_vv`，所以两台设备共有的创世变更不会被当成「只在本机」。
- `docs_with_local_changes`：`loro_head.vv` 超出 `remote_vv` 的文档，就是「有改动只在这台电脑上」。
- 资源文件带 `uploaded_ms`：`assets_pending_upload`、`mark_asset_uploaded`。
- 旧版的写入者、HLC、`device_seq` 都不要。

### 本机表

只在本机、不进 Loro 的表由各自的模块所有，dr-store 只负责迁移和事务。Loro 表、历史和派生表不许这样碰。

- **写**：`Library::local_write(|tx| ..)` 开一个写事务，`tx` 当 `rusqlite::Transaction` 用；每改一处就 `tx.changed(LocalChange::new(表, id, 种类))` 记下来。事务提交之后，记下的变化才一条条发到总线；闭包返回错误就回滚，什么都不发。
- 不需要发事件的（比如导入回执），用 `local_transaction(|tx| ..)`；`notify_local` 留给事务以外的场合。
- **读**：`local_read(|conn| ..)`，在只读连接上。

| 表 | 归属 | 现状 |
| --- | --- | --- |
| 本机日志：`ws_journal`（索引 `ws_journal_actor`） | F3（dr-workspace） | `0003` 已建，表结构和 F3 的 `journal.rs` 逐字相同；F3 用 `local_write` 写 |
| 导入回执：`import_run`、`import_book`、`import_doc`、`import_anchor`、`import_original` | M10（dr-import-v1） | `0001` 已建，表结构照 M10 的 `receipt.rs`；M10 改为经 `local_transaction` 写进库里 |
| 旧帮手对话的只读存档（`archive_*`） | M31 | 这一轮不建，暂留在 M10 的 `import-v1/receipt.sqlite` |
| MCP 服务（`local_agent_mcp_server`） | M32 | 同上 |
| 工作记忆（`local_agent_working_memory`） | M30 | 同上 |
| Markdown 文件夹台账（`local_markdown_mirror_file`） | M40 | 同上 |
| 本机设置（`local_setting`、`local_library_state`） | F6 | 同上 |

谁接手就追加自己的 `000N_*.sql`，并把数据从 `receipt.sqlite` 搬进来。

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

**现在的测量归 dr-testkit**：`cargo run --release -p dr-testkit --bin bench -- store` 测按键写入（`NORMAL` 和 `FULL`）和全书 100 章，数据是统一种子 heavy，证据是 [acceptance/f8-m1-store-bench.json](../acceptance/f8-m1-store-bench.json)，数字见 [F8](f8-testkit.md#示范dr-store)。这一轮改了 dr-store，门禁把那份证据报为「过期」，到下一个里程碑重测。

**按段写派生索引**：一章约 2 万字、120 段，每次只改一段，整篇重写 p50 7.68 ms，只写那一段 p50 0.235 ms，约 33 倍（release，M3 Pro，2026-11-07，跑时一分钟负载约 31，绝对值偏高、比例可信）。这是 `tests/index.rs` 里默认不跑的 `measure_patch_against_full_rewrite`，不是门禁。

下面是第一轮用 F2 自己的 `f2-bench` 测的（那个程序和 `f2-store-bench.json` 这一轮删了）。按键写入和全书两项已由上面的 `bench store` 接替；「打开一章」和「压缩」两项只记在这里，要重测得加进 dr-testkit 的 store 套件。

M3 Pro（12 核，36 GB），release，Loro 1.17.1，2026-11-07，跑时 1 分钟负载约 7.4。数据全是合成的：章节由固定字池随机组段，一次写入后压缩，然后模拟打字（每次插 1–6 字，六分之一的概率删 1–3 字）。

| 项 | 结果 | 预算（benchmarks.md） |
| --- | ---: | --- |
| 一次按键写入：持有者线程上提交 + 导出 + 一个事务写更新行、head、写入计数 + 发事件 + 唤醒调用方，2 万字章节，2000 次，`synchronous=NORMAL` | p50 0.036 ms，p95 0.057 ms，最慢 1.5 ms | 单次按键的写入中位数 ≤ 2 ms（探针档）/ ≤ 1 ms（发布档） |
| 同上，`synchronous=FULL` | p50 0.061 ms，p95 0.084 ms，最慢 0.59 ms | — |
| 每次按键的更新平均大小 | 104 字节 | — |
| 打开一章（2 万字快照 + N 条按键更新）：载入 / 载入并读出全文 / 起一个持有者，p50 | N=0：0.11 / 0.23 / 0.14 ms<br>N=100：1.0 / 1.0 / 1.1 ms<br>N=500：3.5 / 3.4 / 3.5 ms<br>N=1000：6.5 / 6.5 / 6.7 ms<br>N=5000：30 / 30 / 31 ms | 打开 2 万字章节 ≤ 80 ms（探针档，含排版） |
| 压缩（2 万字章节，写快照 + 删掉 N 行），p50 | N=100：0.52 ms；N=500：0.70 ms；N=2000：1.3 ms；快照 69–133 KB | — |
| 全书 100 章 × 1.5 万字：从 SQLite 冷载入全部 | 9.4 ms | 冷开全书的 Loro 文档 ≤ 300 ms（发布档） |
| 全书：第一次读出每章全文 | 9.6 ms | — |
| 全书：起 100 个持有者 / 逐个 `close` 等它们收尾 | 12.8 ms / 2.6 ms | — |
| 全书的库文件 | 5.2 MB | — |

怎么读这些数字：

- **按键写入**比第一轮（0.022 ms）多了约 15 µs，是每次追加多写 `loro_head` 和全库写入计数的代价，仍比预算低约 50 倍。最慢的那一次（约 1.5 ms）多半是 SQLite 自动 checkpoint 落在了这次提交上，见「下一步」。
- **打开一章的成本几乎全在待压缩的更新上**：每多一条约 6 µs。所以默认 200 条就压缩（打开 ≤ 约 1.5 ms），关闭时 50 条以上也压缩；一次压缩不到 1 ms，又是在空闲时做。
- **全书数字偏乐观**：每章只有「一次写入」的历史。P0-C 用重型种子测得冷载入 26–29 ms、第一次解码每章 0.8–1.7 ms，更接近真实；两者都远在预算内。
- 机器忙时同一程序会慢 2–4 倍（负载 70 多时测过），所以证据里记着负载。内存 P0-C 已测过，存储层没有改变那些数字。

## 崩溃安全

崩溃试验用 dr-testkit 的统一试验台（`dr_testkit::crash`）：测试程序把自己再启动一次当写入进程，到点强杀（macOS 上 SIGKILL，Windows 上 TerminateProcess），再由父进程重开、核对。

- **编辑中被杀**：归 dr-testkit 的 `tests/crash_store.rs`，在真实的持有者上做。第一轮 F2 自己的 `f2-crash` 杀过 60 次（35 次落在压缩事务中间），零丢失、零不一致；那个程序和 `f2-crash-recovery.json` 这一轮删了。
- **迁移中被杀**（`tests/crash.rs`，dr-store 专有，留着）：写入进程用「再多一条迁移」的新版本打开一个有正文的库，停在指定的阶段。停下时通过 `migrate::on_migration_pause` 向试验台报告，试验台就在这时杀掉它。六个阶段各杀一次，每次之后核对：

  | 停在 | 原库字节 | 旧版本打开 | 下一次新版本打开 |
  | --- | --- | --- | --- |
  | 拍安全快照前 | 不变 | 能，正文完整，没有残留的影子 | 迁 1 条，正文完整 |
  | 复制影子前 | 不变 | 同上 | 同上 |
  | 迁移事务里（未提交） | 不变 | 同上 | 同上 |
  | 校验前 | 不变 | 同上 | 同上 |
  | 替换前 | 不变 | 同上 | 同上 |
  | 替换后、重开前 | 已是新库 | 报 `SchemaNewer`，库不动 | 不用再迁，正文完整 |

  每种情形之后都不剩恢复回执。CI 里约 1 秒。

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

## 第三轮（监管会话，2026-11-07）

| 要求 | 处理 |
| --- | --- |
| 1. 按段写派生索引 | `DerivedUpdate::Patch(DerivedPatch)`、`Library::patch_index`；只落在依据的行上，对不上就报 `IndexBase`、下次从头算；见「派生索引」 |
| 2. 类型化读取持有者的文档 | `DocView::with_doc(\|doc: &LoroDoc\| ..)`；写闭包开始时已结清待提交事务，写进文档并有测试 |
| 3. 本机表 `ws_journal` | `0003_ws_journal.sql`（与 F3 的 `journal.rs` 逐字相同），登记进 xtask 的 `PINNED`；`Library::local_write(\|tx\| ..)`，提交后才发总线 |
| 4. 搜索按书序 | `search_in_order(书, 查询, limit, 文档顺序)`：先排序后截断。没加书序列：书序在书目文档里，存一份就得跟着每次挪章节改 |
| 5. 关库失败能重试 | `try_close()` 返回 `CloseRefused { error, library }` |
| 6. 大纲照 dr-text；`held` 标志 | 去空白、去空标题；`DeriveInput.held`，后台重建的副本为 `false` |
| 7. 只读打开 | `Library::open_read_only`；见「只读打开与关库」 |
| 8. 换用 dr-testkit | 测试改用 dr-testkit 的随机流和语料；迁移被杀改写在 `crash::Harness` 上（`for_test` 就是 `with_args` 加上测试名）；删了 `f2-bench`、`f2-crash` 和两份 `f2-*.json`。`synthetic.rs`、`evidence.rs` 只留下 dr-index 的基准例子还在用的几个函数，见「待协调」 |

## 第四轮：性能（监管会话，2026-11-07）

| 要求 | 处理 |
| --- | --- |
| 1. 按书序搜索慢十倍（F3「待协调」F2-1） | 见「派生索引」：FTS 先取命中、Rust 里排序截断再取文字；`LIKE` 按书序逐篇查、够数就停；SQL 文本固定 |
| 2. 回车约 3 ms（dr-text「待协调」1） | 段序键带空隙，插段、删段不动后面的行；查下来另一半时间在整篇重写引用，改成只写变了的引用行 |
| 3. 关库碰上后台重建（F3「待协调」F2-2） | 后台重建跳过已打开的文档、不拿句柄，交给持有者空闲时补；`try_close` 就不会因为它被拒 |
| 4. 派生单独一个短的空闲等待（dr-text「待协调」2） | `LibraryOptions::derive_idle`，默认 150 ms；压缩照旧 750 ms |
| 另：删掉 `dr_store::synthetic`、`dr_store::evidence`（dr-text「待协调」4） | 已删 |

测试：
- **段序键**：`a_new_paragraph_writes_its_own_rows_and_no_others`（200 段中间切一段：只多两行、别的行号和键都不变，搜索和大纲的段号对）；`inserting_in_one_place_renumbers_only_when_the_gap_runs_out`（同一处连插 80 次，正好重新编号 2 次）；`a_document_numbered_one_by_one_reads_the_same_and_renumbers_when_needed`（旧库）；`random_patches_on_packed_keys_and_touching_splices`（键压紧、补丁切成相邻几处，随机 400 步和整篇重写比对）。
- **引用**：`references_keep_their_order_and_only_changed_rows_are_rewritten`（随机 400 步，别的文档的行穿插在中间，顺序始终和派生器给的一样；200 条里改一处只写两行；旧行没空隙时重写）。
- **搜索**：`ordered_search_equals_sorting_every_hit`（随机书序，含漏掉的、重复的、不认识的文档，1–4 个字，随机 `limit`，结果和「普通搜索全取出来再按书序排、截断」逐条相同）。
- **关库**：`closing_during_the_rebuild_on_open_is_not_refused`（改前 3 次里 3 次被拒）；**空闲等待**：`deriving_and_compacting_wait_for_their_own_quiet_spells`。

重测用 F8 的 `bench`，改前改后的两个程序背靠背跑（M3 Pro，release，heavy 种子，2026-11-07，一分钟负载 6–11）。下表是背靠背那一轮的数；证据 [f2-m4-index-bench.json](../acceptance/f2-m4-index-bench.json) 和 [f2-m4-workspace-bench.json](../acceptance/f2-m4-workspace-bench.json) 是改后单独又跑的一轮（负载约 7），数字在噪声以内一致（回车 0.40 / 0.89，工作区一个字 0.52、三个字 6.0）。

| 项（p50 / p95，ms） | 改前 | 改后 |
| --- | ---: | ---: |
| 回车后的一次派生，连写入（`index` 套件，174 段的一章，50 次） | 2.59 / 8.71 | 0.41 / 0.84 |
| 打一个字后的一次派生，连写入 | 0.19 / 0.61 | 0.20 / 0.62 |
| 工作区按书序搜索一个字（`workspace` 套件） | 495 / 588 | 0.50 / 0.59 |
| 工作区按书序搜索三个字 | 265 / 301 | 5.8 / 9.4 |
| `search_in_order` 一个字 / 两个字 / 三个字 / 八个字，取 50 条（`index` 套件） | 15.3 / 12.4 / 1.84 / 0.20 | 0.50 / 1.03 / 0.78 / 0.087 |
| 普通 `search` 三个字，取 50 条 / 取 1 万条 | 0.24 / 0.81 | 0.58 / 2.05 |
| 普通 `search` 一个字，取 1 万条 | 12.6 | 15.6 |
| `outline`（13 个标题） | 0.019 | 0.037 |

怎么读：
- **回车**：一半时间省在不再挪后面各段的段序，另一半省在引用只写变了的行。调查时在 `write_patch` 里临时计时，回车那 50 次里有 39 次带着整篇的引用，删了重插要 0.7–0.9 ms，提交还要多写约 0.8 ms 的脏页。现在回车和打字一样在 1 ms 以内。
- **按书序搜索**：一个字、两个字从头几章就凑够了，所以几乎不花时间；冷僻的字要查完整本书，大约是一次全表扫描再加每篇几微秒。
- **普通搜索变慢了一点**：段号现在要数（每条命中在索引上数一次），取 50 条多 0.3 ms 左右，取 1 万条多 1–3 ms。工作区已经全用按书序搜索。
- 别的项（全书冷读、开关持有者、按键写入、全书重建、种子写入）改前改后在噪声以内；种子写入只跑一次，三轮里分别是 1.02×、0.54×、1.22×。

## M10 报的两处（2026-11-07）

| M10 的报告（`m10-import.md`「待协调」1、12） | 原因 | 处理 |
| --- | --- | --- |
| 导入的每篇正文多一个 `close` 历史点，和 `import` 点同一个版本，书目文档版本是空的 | 持有者关闭时只要这次打开有过提交就打 `close`，导入的那次 `import` 提交也算 | `close` 改成只在有「值得打点」的提交（口径同 `records_periodic`）时才打；另外打任何标签前都和表里最新的标签比一下版本，相同就不打，`label_at` 打的也算 |
| 并行测试里关库后马上再开，大约三次里有一次报「已在别的进程或句柄里打开」 | Unix 上库锁是 `flock`，属于打开的文件。别的测试线程同时在启动子进程（M10 每次导入跑一次 `lsof`），子进程换成自己的程序之前握着锁文件描述符的副本，只关我们那份，锁要等它那份也关了才放 | 关库时显式解锁（`LibraryLock` 的 `Drop`），所有副本一起失效 |

测试：
- `closing_labels_only_openings_that_wrote_something_worth_a_label`（`tests/labels.rs`）按 M10 的顺序走一遍：创世 → `import` → 修复 → 关 → `label_at`。之后验证三件事：只开不写不打点；作者写了就打 `close`；文档开着时别人在当前版本打过点，就不再重复。两项改动分别撤掉时，这项测试分别失败。
- `a_closed_library_reopens_at_once_while_processes_start`（`tests/records.rs`，只在 Unix 上跑）：四个线程不停启动子进程，同时开关库 1000 次。不显式解锁时 438 次被拒，改后 0 次，约 2 秒。

## 待协调

0. **给 M10**：`label_at` / `label_many` 可以替换 `run::write_labels` 的直写 SQL（行为相同：书目文档的版本取当前 head；另外多了保留参数和修剪）；`Device::adopt(dir, &id)` 替换 `adopt_identity`；导入回执的五张表在库里了（`0001`），用 `lib.local_transaction` 写，表名和列与 `receipt.rs` 相同。存档和本机表这一轮仍留在 `receipt.sqlite`（`ATTACH` 不能在事务里做，到它们的模块接手时再搬）。
1. **F1 的接入点**：`configure_doc`（样式表）、`OpenDoc::CreateIfMissing.genesis`（创世），以及 `Deriver`（段落、块 ID、人物链接 → `BlockRow`、`RefRow`，字数用 dr-text）。书目文档的 id 按 loro-schema 用 `book:<书 id>`，历史标签靠它找书目文档的版本。
2. **`loro_doc.book_id`**：F3 创建任何属于某本书的文档时传入，书目文档自己也填。
3. **F4 编辑器怎么读写**：写一律走 `write` 闭包；读用 `DocView` 或 `h.read`。批注锚点的位置（`get_cursor_pos`）、导出、回看要放进 `h.read`。`UndoManager` 建议放在写闭包里用。
4. **基线冻结的时间**：并进第 12 条。
5. **搜索按书序（给 F3）**：调 `search_in_order`，把书目文档里的章节顺序（文档 id 列表）传进来。
6. **本机表**（帮手运行记录、权限、Markdown 台账、工作记忆、生图收件箱）：谁需要谁追加下一个序号的 `000N_*.sql`（现在到 `0003`），登记进 xtask 的 `PINNED`，用 `local_write` 写、提交后自动发到总线。
7. **同步 v2（阶段 6）**：上传走 `export_for_upload` → `mark_uploaded`；导入走 `h.import(.., Origin::Sync)`，存储自动记服务器已有的版本。服务端协议和多文档恢复是阶段 6 的事。
8. ~~搬到新电脑但身份文件也被拷走~~：监管会话已批准，已做（见「库的文件夹与本机身份」）。
9. **Windows**：代码有 Windows 分支（写穿改名、墓碑删除、可写句柄 fsync、`MachineGuid`）。本机 `cargo check --target x86_64-pc-windows-msvc` 过不了：Loro 依赖的 `stacker` 和打包的 SQLite 要用 `windows.h` 编 C 代码，这台 Mac 上没有 Windows SDK。只依赖标准库的 `machine.rs`（库和测试）和 `file_io.rs` 用 `rustc --edition 2024 --crate-type lib --target x86_64-pc-windows-msvc --emit=metadata -D warnings` 单独做了类型检查，通过；`asset.rs` 的 Windows 删除分支依赖 crate 内部，只能靠 CI 的 Windows 那一条验证（它是从 0.1 在 Windows 上编过的代码逐行搬来的）。
10. **给 dr-index**：
    - ~~派生器改发 `DerivedUpdate::Patch`、照 `held` 决定缓存~~：dr-index 第二个里程碑做了。
    - ~~它的基准例子还在用 `dr_store::synthetic`、`dr_store::evidence`~~：例子已删，这两个模块第四轮删了。
    - 这一轮给 `DeriveInput` 加了 `held`，`dr-index/tests/common/mod.rs` 里的构造因此编不过，我在那里补了一行 `held: true,`。这是 F2 的文件范围以外唯一改动的一处。
11. **大纲的 `paragraphs_after`**（dr-text 的规则：数到下一个进大纲的标题为止的段落，正文段和嵌入算，分隔线不算）没在 `Library::outline` 里做：`block_index` 只记标题级别，分不出分隔线和嵌入，现在算只能算错。要做就给 `block_index` 加一列段落种类（新迁移），由派生器填；在那之前要这个数，用 `dr_text::outline` 过一遍持有者的文档。
12. ~~迁移的哈希要不要现在就钉~~：监管会话定了，等第一个 0.2 版本真正发布时再钉（发布才算「已发布」），在那之前保持「未冻结」。
13. **F8 的证据与文档**：`f8-m1-store-bench.json` 因为 dr-store 改了被报「过期」，下一个里程碑重测。`f8-testkit.md`「待协调 → dr-store」里的「换用统一的种子和试验台」和「只读打开」这一轮都做了，`dr-cli inspect` 可以改用 `Library::open_read_only`，不用先复制；那份文档归 F8，我没改。
14. **给 M10**：`run::reopen` 和测试里打开库的重试（最多 2 秒）可以删了；测试里对 `close` 历史点的豁免也可以去掉。
15. **给 F3**：`Workspace::shutdown` 被拒后重试一秒的绕法可以删了（后台重建不再拿已打开文档的句柄）；`book.search` 用 `search_in_order` 不用改。
16. **给 dr-text / dr-index**：待协调 1（回车）、2（派生的空闲等待）、4（删两个旧模块）都做了，回车重测见「第四轮」。`references_from` 的顺序照旧是派生器给的顺序。

## 没做的、下一步建议

- 图片管线（`image_pipeline.rs` 和各平台解码器）只有接口。
- 大纲的 `paragraphs_after`（见第 11 条）。
- 帮手的本机表、整库备份（`library_backup.rs`：`VACUUM INTO` 加资源文件打包）、按账号分库（M36）。
- WAL 自动 checkpoint 会让某一次提交多花约 1 ms；如果真实打字测到尾延迟，改在持有者空闲时做被动 checkpoint。
- 普通 `search` 因为要现数段号慢了一点（见「第四轮」）。要是有人还在用它取很多条，可以给数段号换一种做法（比如按文档一次数完）。
- 建议下一个里程碑：把「打开一章」「压缩」两项测量加进 dr-testkit 的 store 套件，用真实的 dr-doc 创世、样式表和派生器重测一遍，替掉上面第一轮的数字。

## 怎么复现

在 `next/` 下：

```bash
cargo test -p dr-store --locked
cargo test --release -p dr-store --test index -- --ignored --nocapture measure_patch
cargo run --release -p dr-testkit --bin bench -- store
cargo xtask check
```

- 第一条包括迁移各阶段被杀（`tests/crash.rs`）；编辑中被杀在 `cargo test -p dr-testkit --test crash_store`。
- 第二条是按段写索引和整篇重写的对比，只打到屏幕，不写证据。
- 第三条是 dr-testkit 的存储基准；加 `--milestone <名字>` 才写成测量证据，只在里程碑时做。
- 测试数据全是合成的：dr-testkit 的随机流和语料（`dr_testkit::rng`、`dr_testkit::text`），不含任何书稿。
