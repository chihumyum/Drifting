# M36 Hosted 同步 v2

> 2026-11-10 切换实施更新：保留任务 6 的 v3 同步契约；新增闭库后真实 SyncEngine 长活 fake-server helper，生产 App 自动调度仍未实现。 当前范围、删除／保留边界和验收状态见 [canonical v3 切换](../v3-cutover.md)。下文历史交回记录保留其原语境。

**交回状态**：第四十批已接收 `handback/track4` → `8275c95f`；第三十七批路径问题修复、永久回归及全套整合检查通过。接收范围为传输层与状态接口，生产调度边界见本文末尾。

## 目标与范围

对应当时的任务书（`handoff/m36-sync-v2.md`，已随过程文档清理删除，在 git 历史里）、`docs/hosted-sync/README.md` 与 `docs/hosted-sync/sync-status.md`，在 `next/` 工作区实现 Hosted 同步 v2（`dr-sync` 服务层 crate 与 `dr-view-account::sync_mark` 界面层记号视图）：

1. **对象日志 HTTP 协议（决定 D6，`loro-v2` 命名空间）**：
   - 沿用不可变对象日志 HTTP 协议，通过 `/api/sync/v1/loro-v2/objects/<key>`、`/api/sync/v1/loro-v2/changes?cursor=<seq>&includeRemovals=1` 与 `/api/sync/v1/usage` 承载 Loro 增量更新批次、快照、文档清除墓碑（`removals-v1`）以及不可变资源变体文件。
   - 服务端只存不透明对象，不感知文档内部结构。
   - 保留 `src-tauri/src/hosted_sync.rs` 的安全边界：`validate_sync_url`（校验 `http`/`https`、禁止凭据与 fragment、强制同源、路径必须以 `/api/sync/v1/` 开头并拦截 `..` 与 `%2e%2e` 路径穿越）、`verify_payload_integrity`（`MAX_OBJECT_BYTES = 64 MiB`、字节长度与 `sha256:<hex>` 摘要校验）以及 `write_verified_file_atomic`（`.part` 临时文件写入、`sync_all`、取消信号清理与原子 `rename`）。
2. **不透明文档与资源同步引擎（`SyncEngine`）**：
   - 把一本书及工作区当作「一组不透明 ID 的 Loro 文档加资源文件」，文档 ID（`doc_id`）和文档种类（`kind`）均作为不透明字符串处理，不写死任何文档种类列表，直接兼容通用内核 v3 的树与叶子模块。
   - **增量上传与压缩正交**：使用 F2 `dr_store::Library` 已有的 `docs_with_local_changes`、`export_for_upload(doc_id)` 与 `mark_uploaded(doc_id, &vv)`，只上传 `remote_vv` 之后的增量改动；即使本机已跑过 `compact_now` 折叠快照，`export_for_upload` 依然从文档 oplog 导出精确增量，压缩与上传互不相干。
   - **帮手对话同路同步（M27）**：帮手对话文档（如 `conv:*`）与书目、正文章节走同一条 `LoroUpdate` 通道，不另起同步引擎。
   - **断网续传**：逐条记录并持久化游标（2026-11-13 起存在库内 F2 `local_state` 的 `sync-v2` 下，见文末同日一节；原 `sync-cursor-v2.json` 已废）与 `sync_doc.remote_vv`、`asset.uploaded_ms`；中途断网后重连可从断点继续上传与拉取。只有 Loro 完整应用的远端更新才确认、才推进游标。
   - **从空库恢复（`restore_library`）**：新设备或本机库重建时，从 `cursor = 0` 拉取对象日志并恢复全部 Loro 文档与资源变体文件，恢复后资源自动标记已上传。
   - **配额控制**：软上限 `500 MiB`（`DEFAULT_QUOTA_BYTES`）、硬上限 `1 GiB`（`DEFAULT_HARD_LIMIT_BYTES`）。新资源导入前可通过 `check_new_asset_quota` 结合 `GET /api/sync/v1/usage` 与本机待传资源字节数预检；服务端返回 `413 QUOTA_EXCEEDED` 时自动进入 `SyncProblem::Quota` 状态。
3. **同步状态记号与通知中心桥接（`dr_sync::health` + `dr_view_account::sync_mark`）**：
   - 严格实现 2026-11-02 定稿的稿纸左下角状态规则：
     - 本机库（`!hosted_enabled`）或已暂停、或分屏右侧稿纸（`is_trailing_pane == true`）一律不显示。
     - 已同步：什么都不显示（`SyncStatusVisual::Hidden`）。
     - 同步中：连续忙碌满 `3_000 ms` 后显示整块呼吸云（`BreathingCloud`，上传下载同一种）；完成后保留 `1_500 ms` 再淡出；编辑器打字时淡出（`faded_for_typing = true`），停笔 `2_000 ms` 后恢复。
     - 重试中：后台自动重试满 `30_000 ms`（且未达严重错误阈值）显示慢闪云（`BlinkingCloud`）。
     - 离线：显示散砂云（`LooseSandCloud`）。
     - 严重问题（`NotStarted` 没能启动、`Reauth` 需要重新登录、`Quota` 存储已满、`Failing` 连续 3 个周期或持续 5 分钟出错）：统一显示危险色「！」（`DangerExclamation`），悬停卡提供问题说明与对应按钮（`Retry`、`SignIn`、`OpenSettings`），同时通过 `reconcile_sync_problem_notifications` 钉入通知中心（`Source::Sync`）直至解决；普通上传下载与重试不进通知中心。

## 落点与文件清单

- `next/Cargo.toml`：注册工作区成员 `crates/dr-sync` 与依赖项 `dr-sync`。
- `next/crates/dr-sync/`（`Layer::Services`，无 GPUI 依赖）：
  - `src/protocol.rs`：`loro-v2` 对象日志协议类型、Origin/路径校验、SHA-256 流式原子落盘、取消控制、500 MiB / 1 GiB 配额检查与 HTTP 客户端。
  - `src/engine.rs`：`SyncEngine` 增量上传、增量拉取合并、断网续传、空库恢复与墓碑同步。
  - `src/health.rs`：`SyncHealthTracker`、`SyncCornerState`、`SyncProblem`、`SyncStatusVisual`、`evaluate_paper_sync_mark` 与 `sync_problems_of`。
  - `src/fake_server.rs`：绑定 `127.0.0.1:0` 的本机回环假同步服务 `FakeSyncServer`（支持断网注入、半途断连注入、配额上限注入与令牌校验）。
  - `src/lib.rs`：模块导出与覆盖收敛、断网续传、配额触顶、空库恢复、状态机全分支及安全边界的测试。
- `next/crates/dr-view-account/`（`Layer::Interface`）：
  - `src/sync_mark.rs`：稿纸左下角砂笔记号视图 `render_paper_sync_mark` / `paper_sync_mark_for`、悬停卡文案与动作按钮、通知中心钉住/解除桥接 `reconcile_sync_problem_notifications`。

## 第三十七批退回修复（2026-11-09）

- **入口先校验**：远端资源元数据进入 `SyncEngine::apply_remote_record` 后，先校验素材 id、书 id、变体和扩展名，再查重、标记已上传、下载、构造暂存路径、写入或清理。非法元数据返回 `SyncError::InvalidPath`，不推进该条记录的游标，重复素材也不能绕过校验。
- **素材 id 与书 id**：只接受与 F2 `sanitized_segment` 输出完全相同的规范拼写（1–128 个 ASCII 字母、数字、`.`、`_`、`-`，不以点开头），拒绝绝对路径、正反斜杠、点／父级路径段、盘符、UNC、URL 转义、空白、控制字符及其他需要改名的输入。同时在所有平台拒绝末尾点与 Windows 保留设备名，避免跨设备路径别名；不把非法远端 id 静默改名到另一个素材的目录。
- **变体与扩展名**：变体只接受 `source`、`display`、`thumbnail`；扩展名只接受 F2 的规范形式（1–16 个小写 ASCII 字母或数字，不带前导点）。校验失败时不会创建暂存文件，也不会执行暂存清理。
- **文档字段审查**：`doc_id` 只进入 SQLite 的文档键和 base64url 编码的 HTTP 对象键，不参与本地文件路径；保留 v3 的 `body:…/…`、`template:…/…` 等不透明 id，不按文件名改写。更新和墓碑分支均先按 F2 约束拒绝空 id、超过 256 字节或含控制字符的 id，并校验可选的书 id。`kind` 继续不透明；对象键只用于 base64url 编码的 HTTP 路由，MIME、尺寸和版本向量不参与文件路径。
- **永久回归**：`next/crates/dr-sync/tests/remote_metadata.rs` 的 7 项测试覆盖库外文件原字节、跨平台非法路径、扩展名／变体、重复素材提前拒绝、文档更新／墓碑、合法不透明文档 id，以及所有变体和 id／扩展名长度上限。拒绝用例只允许假服务的 change-list 请求成功，若提前下载就会变成网络错误，不能冒充元数据校验通过。所有数据与令牌均为合成内容，服务仅绑定本机回环。
- **修前证据**：永久绝对路径回归在旧实现上失败，库外 `synthetic-manuscript-source.txt` 被删除；修后要求同时断言 `InvalidPath`、文件仍在且原字节不变。
- **定向检查**：`CARGO_BUILD_JOBS=3 cargo test -p dr-sync --locked` 通过（6 项既有测试、7 项新增永久回归）。

## 首次交回（历史记录）

- **包含段落**：M36 Hosted 同步 v2（`dr-sync` 对象日志协议、Loro 与资源增量同步引擎、空库恢复、配额检查、同步状态机，以及 `dr-view-account::sync_mark` 稿纸左下角记号视图与通知中心桥接）。
- **触碰 `dr-shell` / `dr-view-shelf` 列表**：
  - 本模块未修改 `dr-shell`、`dr-view-shelf` 或 `dr-store` 内部代码。
- **检查结果**：
  - `cargo fmt --all --check`：通过
  - `CARGO_BUILD_JOBS=3 cargo clippy --workspace --all-targets --locked -- -D warnings`：通过
  - `CARGO_BUILD_JOBS=3 cargo test --workspace --locked`：通过
  - `CARGO_BUILD_JOBS=3 cargo xtask check`：通过
  - `pnpm public:check`：通过
- **待协调**：
  1. **F6（`dr-shell/src/workspace/corner.rs`）稿纸左下角挂接点**：`dr-view-account::sync_mark::paper_sync_mark_for` 已实现稿纸左下角记号与悬停卡（含分屏只在左稿纸显示、打字 2 秒淡出规则）。请 F6 在 `workspace/corner.rs`（或稿纸容器左下角）预留一个挂接槽位，传入当前 pane 的 `book_id` 与 `is_trailing_pane` 即可直接挂载。
  2. **Hosted 服务端命名空间登记**：Hosted 同步服务端需在对象日志路由白名单中登记 `loro-v2` 命名空间（`/api/sync/v1/loro-v2/objects/*` 与 `/api/sync/v1/loro-v2/changes`），存储层按不透明二进制对象加元数据头（`X-Content-Sha256`、`X-Drifting-Object-Meta`）原样保存，无需解析 Loro 内容。

## 交回（2026-11-09 退回修正）

- **分支／指针**：`codex/track4-account-sync` → `handback/track4`。已用 `git merge main` 同步至 `main` 的 `f9d0d55d`，合并提交 `15dbef85`，无冲突。只交回本地指针，不合进 `main`，不推送。
- **包含段落**：原有 M37 偏好同步及第三十五批范围修正、M36 同步 v2 及本次第三十七批路径校验修正、M43 Windows 补齐。此前功能和范围修正提交保留，不 rebase。
- **本次修复范围**：仅 `dr-sync/src/engine.rs`、`dr-sync/tests/remote_metadata.rs` 和本结论文档。相对当前 `main`，`dr-shell`（包括设置存储）与 `dr-view-shelf` 差异为空；未改 `dr-store`、`dr-model` 或 `dr-doc`。

### 提交清单

| 提交 | 内容 |
| --- | --- |
| `1d65b525` | M37 偏好同步 |
| `a5140849` | 偏好键切片传参修正 |
| `c719a76d` | 本机假账号服务清除继承的非阻塞标志 |
| `a822cc8d` | M36 对象日志、Loro／资源同步与状态记号 |
| `5c777ca8` | M37 收敛到账号 crate，撤回 `dr-shell` 设置改动 |
| `1a20f8d0` | M43 托盘、arm64 安装器与字体回退 |
| `9af4892b` | M36 远端路径字段提前校验与 7 项永久回归 |

另外保留同步 `main` 的合并提交：`3936061e`、`8f9fdd63`、`e657622e`、`15dbef85`。本小节随最终交回记录提交，交回指针指向含本小节的 HEAD。

### 检查结果

在合入上述 `main` 后验证，编译统一 `CARGO_BUILD_JOBS=3`，测试统一 `RUST_TEST_THREADS=1`：

- `cargo fmt --all --check`：通过。
- `cargo clippy --workspace --all-targets --locked -- -D warnings`：通过。
- `cargo test --workspace --locked --no-fail-fast`：通过，含文档测试共 **1997 通过、0 失败、22 忽略**；`dr-sync` 的 6 项既有测试和 7 项新增永久回归全部通过。
- `cargo xtask check`：通过，含完整审计（971 个锁定包、0 漏洞、12 条既有提示）。14 项 stale／15 项 legacy 测量仅记录，未重写生成证据。
- 仓库根 `pnpm public:check`：通过（5409 个发布候选文件）；`pnpm ci:contract:check`：通过（659 个测试文件）。
- **运行中断记录**：首次全工作区测试在 `dr-agent-tools --test projection` 启动时收到 `SIGKILL`；同时发现本 worktree 的 `next/target` 被清空，原测试程序已不存在。没有为此修改产品源码；重建后该程序定向复验 8 项通过，再完整重跑得到以上全量结果。
- 账号／同步测试只用本机回环假服务、临时库和合成令牌，没有连接真实账号／同步服务或使用真实密钥。本轮未执行 Windows 实机验收。

### 待协调

本次退回问题无新增跨 crate 接线需求。沿用原有待协调：M37 的 F6 设置编辑防抖回调、M36 的 F6 稿纸角标和服务端 `loro-v2` 登记，以及 M43 文档中的托盘／字体挂接、arm64 工具链和作者 Windows 实机验收。以上未完成的接线与实机验证仍由原负责方承接。

### 第四十批整合补记：生产调度边界

本批接收的是传输引擎和状态／视图接口；当前 `SyncEngine` 的调用者仍只有 dr-sync 测试，生产 app 尚未创建并驱动它。周期同步、账号库切换／退出排空与健康状态推送归后续应用接线方，连同上述角标和服务端命名空间在 overnight 分派；本次合成收敛／恢复测试不等于应用已自动同步或真实服务已接通。

## 交回（2026-11-10：真实 v3 假服务往返）

### 做了什么

本次从 `main e49c02c11` 续接 `codex/autopilot-sync-v3`，交回 `handback/track4`，不执行切换、不合 main、不推送。改动限于 `dr-sync`、其四个测试依赖与锁文件，以及本文。测试使用 `FakeSyncServer` 的真实 `127.0.0.1:0` HTTP 往返、明显合成令牌、临时库和临时设备身份；所有正文来自 `dr_testkit::seed::generate_v3`，图片来自 `dr_testkit::media::png`。没有使用日常库、真实账号、真实 Hosted 或模型 API。

新增永久契约在 [`dr-sync/tests/v3_roundtrip.rs`](../../../next/crates/dr-sync/tests/v3_roundtrip.rs)：

| 契约 | 实际断言 |
| --- | --- |
| `v3_books_assets_hidden_fields_checkpoints_and_book_purge_round_trip_over_fake_server` | A 有两个不同 seed 的 canonical Tiny v3 书，B 从空库接收；两设备的安装身份、写入 peer 与库路径独立。两书均有真实 book/body/template/material 文档与关联素材的 source/thumbnail，共四份变体。逐文档比较 `DocInfo`、typed raw、正文、版本向量和 frontier；逐资源比较全部网络元数据和真实字节。 |
| 同一主契约：隐藏数据与双向编辑 | 回收条目及正文、移除定义后仍保留的模块正文、时间钉被有效查询投影为 null 的原始绑定、条目未来嵌套字段和正文未来根均保留。A/B 用逐项、带观察版本守卫的正式命令编辑两书；时间线整份 put 只构造最初合成 fixture。有效查询与历史预览前后逐文档 head/raw 不变；双向往返后再核隐藏值。 |
| 同一主契约：历史和重开 | 两书均用真实 `entry_snapshot.create` 建点，在 B 实际 list＋preview，再比较历史身份、版本、校验信息、owned raw 与全部历史正文。编辑后及两台真正关库／重开后再读；只排除预览中随当前版本变化的 restore guards。checkpoint 清单和正文 oplog 随同步走，SQLite 的本机 history_label／journal 不属于网络同步清单；未修改 G1 历史语义。 |
| 同一主契约：软删除与永久删除隔离 | book.trash 先往返，正文／模板／素材文档、历史点、资源原记录和字节均留存。随后实际 book.purge：A 的 26 份文档逐份验证 docs/doc_info/head/load_copy/purged，两个变体的登记和原文件确实删除；B 接收 DocPurge 后逐份核对文档已删。另一本书的 22 份全部文档按各设备自己的完整 head/raw/prose/metadata 快照核对，全部资源记录（含本机时间、路径）及字节完全不变。 |
| 同一主契约：离线／取消／历史重放／库外边界 | 初次上传的真实 set_offline 失败及取消保留未同步数据和待传清单。永久删除后再次实际断网、失败、恢复并重建 engine；B 用公开 restore_library 从 cursor 0 重放旧更新、资源和墓碑，已删文档不复活。最后两台再次关库／重开核墓碑、另一书和历史点。各阶段检查库外合成 sentinel 原字节，末尾还核修改时间。 |
| `a_held_v3_document_blocks_remote_purge_without_consuming_its_cursor` | 真 v3 正文仍被持有时，远端 purge 返回 AlreadyOpen，文档、原始数据及失败记录游标不变；释放后重建 engine 重试，实际删除、墓碑落地，其余文档不变，历史重放不复活。 |
| `damaged_remote_loro_preserves_real_v3_author_data_and_reopen_state` | 将有效网络摘要包裹的损坏 Loro 字节指向真 v3 正文；导入报错，不确认伪造版本、不推进失败记录游标，原作者数据逐文档 head/raw/prose 与重开结果不变。 |
| `contradictory_doc_purge_cannot_delete_another_real_v3_books_body` | 固化守卫的真实两书误删探针：书 B 的实际 canonical body 配书 A、空归属或矛盾 kind，均在清除前拒绝。两书逐文档 raw/head/正文/DocInfo、墓碑和库外 sentinel 原字节／修改时间不变。 |
| `contradictory_loro_metadata_is_rejected_before_covered_or_new_updates` | 同样三种矛盾分别覆盖现有 head 已包含的版本和带新操作的有效 Loro 增量；只允许 change-list 请求成功，提前下载会导致测试失败。拒绝前不导入、不确认 remote_vv，不推进游标。 |
| `contradictory_metadata_cannot_acknowledge_existing_v3_tombstones` | 对真实 canonical body 的既有墓碑重复上述三种矛盾及 purge／已覆盖更新／新增量三条路径。三个新增契约共 18 种情况，各真正关库、重开并重试同一记录；两书完整快照、remote_vv、墓碑与整个持久化同步状态均不变。 |

必要修复均在 `dr-sync/src/engine.rs`：远端 DocPurge 不再吞掉 register/purge_doc 错误，只有实际成功后才计数、推进游标；重复接收已确认资源时不再重写 `uploaded_ms`，使重放对另一书全部资源元数据也是无变化；远端文档元数据同时核对本机已登记 DocInfo 或既有墓碑的实际 kind/book_id，矛盾时报 `IntegrityMismatch`。最后一项在 LoroUpdate 的墓碑跳过／head 已覆盖快捷路径／下载导入之前，以及 DocPurge 的登记／清除／确认之前共同生效；对未知 id、合法 opaque kind 和未来字段不添加种类白名单，不改存储层或网络 payload。

**守卫退回与本次复现。** 初次候选 `6c8a51e0` 即使通过原全套也不能接收：守卫独立复现书 B 的 body 被谎称属于书 A 的 DocPurge 删除，`applied_purges=1`、cursor 41。本次在该候选上先加入上述永久契约，实跑 **0 通过／3 失败**：两书 inventory 明确少一份真实正文；已覆盖更新及已有墓碑则错误成功并消耗记录。修复后的结果单独重新检查，原绿色结果不作为本次修复证据。

### 检查结果

修复后本地定向 `cargo test -p dr-sync --locked -- --nocapture` 已通过 **19 项**（原有 6 项、原有远端安全 7 项、真实 v3 3 项、归属拒绝 3 项）。原有绝对路径、分隔符、重复资产元数据提前拒绝、原子落盘／取消及配额／中断矩阵保留原断言。独立使用本 worktree 的 `next/target`，只复制现成字体缓存。

修复提交 `cac707bc62f2acf146e60e5ecf7673f623fc410e` 再次 `git merge main`（`e49c02c11`，已为最新）后，统一 `CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1`，实际重新执行：

- `cargo fmt --all --check`：通过。
- `cargo clippy --workspace --all-targets --locked -- -D warnings`：通过。
- `cargo test --workspace --locked`：含文档测试共 **2386 通过、0 失败、22 忽略**；原 3 项真实 v3 契约及新增归属 3 项在全工作区特性组合中再次通过。
- `cargo xtask check`：全部门禁通过，含完整审计（973 个锁定包、0 漏洞、12 条提示）。20 份 stale／15 份 legacy 测量照实报告，没有重写生成证据或补做暂缓的性能验收。
- 根目录 `pnpm public:check`：通过（5613 个发布候选文件）。

全量测试链接 `drifting` 测试二进制时有一条非阻断链接器警告：`__eh_frame` 超过 16 MiB，无法将 DWARF unwind offsets 编入 compact unwind table；未改无关构建设置。全套命令、退出码、耗时和受检源码 SHA 见外部 `sync-v3-ownership-fix/checks.json`，测试合计由日志生成在 `test-totals.json`。最终交回仅另补本文检查记录，Rust／Cargo 树与上述受检源码相同。

机器重跑：在 `next/` 设置 `CARGO_TARGET_DIR=target CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1`，运行：

```bash
cargo test -p dr-sync --test v3_roundtrip --locked -- --nocapture
cargo test -p dr-sync --test remote_metadata --locked
cargo test -p dr-sync --lib --locked
```

首轮证据保留在工作树外 `$HOME/Drifting-autopilot-logs/sync-v3-acceptance/`；本次守卫退回后的原红、修后定向和重新执行的全套日志另存于 `sync-v3-ownership-fix/`，其中 `01-conflicting-identity-red.log` 是修前 3 项失败，`02-dr-sync-green.log` 是修后 19 项通过。核心验收是纯内核实际假服务往返；没有改窗口，没有将 UI、heavy、截图目检、性能或真实服务接线记为已通过。

### 待协调

- 本次归属退回已修复，无新增存储接口或网络协议协调，也没有遗留的本轮正确性阻塞；下列继续区分既有集成边界。
- **物理缓存与网络墓碑分开。** 本机 book.purge 的原资源文件已实测删除。当前公开协议只有 LoroUpdate／AssetBlob／DocPurge；B 的被删书文档确实清空，但原先下载的两个资源变体仍作为物理缓存留在 B，重放后仍在；不把文档删除计数当作远端物理文件已删。本轮既不据单个 DocPurge 级联 remove_asset，也不自创资产网络墓碑或服务器 GC。后续若要求远端设备／服务的物理缓存清理，需要负责方另定边界；另一书的资源不能受影响。
- **持有者与应用调度。** 远端 purge 遇打开文档现在明确阻塞并保留重试位置。主契约显式释放 B 的 Workspace slots 后才接收整书删除；生产应用如何排空编辑器和重试仍属既有 F6 接线工作，不绕过 F2 保护，不据纯内核测试声称 App 自动同步。缺失文档的墓碑若无法通过既有 F2 register 建立，保持错误和游标，不吞错；需新存储接口时另协调 F2。
- 沿用既有 F6 稿纸角标、生产同步调度与 Hosted `loro-v2` 登记待办；本次没有改生产服务协议或 G1 的历史／恢复语义。

## 服务端需要提供的

服务端代码位于独立仓库，不在本客户端仓库修改。客户端 `dr-sync` 与生产桌面 App 自动同步已按下列契约完备接线。**2026-11-12 交回核对（见仓库外 `~/Drifting-autopilot-logs/loro-v2-server.md`）：** 独立服务端仓库本地 `main`（`29074bc6`，尚未推送上线）已完成下述第 1–3 项全部接口与配额判定、第 4 项有序表迁移与默认关闭的整书回收任务及第 5 项双命名空间并存实现，并通过 86 项单测、32 项本机 HTTP／PostgreSQL／对象存储验收、11 项账号数据隔离检查（14 张归属表）及与 `next/` 三设备往返＋`book.purge` 墓碑空库恢复联调；仅剩作者确认切换期配额口径并执行推送与生产部署：

1. **命名空间隔离与能力协商（`loro-v2`）【服务端已具备（`29074bc6`，待推送上线）】**：
   - **【已具备】** 在对象日志路由白名单中新增账号级命名空间 `loro-v2`（与 0.1 客户端使用的 `project-v1` / `agent-chat-v1` 完全隔离，互不读写、互不混流），全程仅凭已验证账号的 Bearer 会话鉴权拦截跨账号访问，CORS `Access-Control-Allow-Headers` 已放行 `X-Drifting-Object-Meta`。
   - **【已具备】** 所有同步请求均携带 `Authorization: Bearer <token>` 与 `X-Drifting-Sync-Capabilities: removals-v1`。当流发生过物理回收（`pruned_at IS NOT NULL`）时，服务端对缺少 `removals-v1` / `includeRemovals=1` 的旧客户端返回 `426 CLIENT_UPGRADE_REQUIRED`。
   - **【已具备】** 服务端只存不透明二进制对象与元数据 JSON，不解析 Loro oplog 或快照内部 schema，单对象上限维持 `64 MiB`（`MAX_OBJECT_BYTES`，超限返回 `413 OBJECT_TOO_LARGE`）。

2. **HTTP 接口与头部契约【服务端已具备（`29074bc6`，待推送上线）】**：
   - **`PUT /api/sync/v1/loro-v2/objects/<encoded_key>`【已具备】**：
     - `<encoded_key>` 为逻辑 `object_key`（如 `loro/<doc_id>/<sha256>`、`asset/<book_id>/<asset_id>/<variant>`、`purge/<doc_id>/<purged_ms>`）的 URL-safe 无填充 Base64 编码。
     - 请求头：`X-Content-Sha256: sha256:<64位小写hex>`、`X-Drifting-Object-Meta: <base64url(JSON)>`、`Content-Type: application/octet-stream`。
     - 服务端校验实收字节长度（`≤ 64 MiB`）与 `X-Content-Sha256` 一致（不一致返回 `400 DIGEST_MISMATCH`）；解码并校验 `X-Drifting-Object-Meta` 为合法 `RemoteObjectPayload`（`type` 为 `loroUpdate` / `assetBlob` / `docPurge` 三者之一，字段名 `camelCase`）。
     - **幂等重放【已具备】**：同一 `(account_id, object_key)` 重传且摘要与元数据一致时，直接返回原已分配的 `RemoteObjectRecord`（`200`，不重复追加 `seq`、不重复计费）；同键不同摘要或不同元数据返回 `409 Conflict`（`IMMUTABLE_OBJECT_CONFLICT`）。
     - 成功响应返回 `RemoteObjectRecord` JSON：`{ seq, objectKey, sha256, byteLength, createdAt, payload }`。
   - **`GET /api/sync/v1/loro-v2/changes?cursor=<u64>&limit=<usize>&includeRemovals=1`【已具备】**：
     - 在流级行锁串行提交保证下按账号内严格单调递增的整数序号 `seq > cursor` 升序返回分页：`{ changes: RemoteObjectRecord[], nextCursor: u64, hasMore: bool }`。
     - 无新记录时返回 `changes: []`、`nextCursor: cursor`、`hasMore: false`。`includeRemovals=1` 时包含 `type: "docPurge"` 墓碑记录，保证离线重连或从 `cursor = 0` 空库恢复的设备不会让已删文档或已删书复活。
   - **`GET /api/sync/v1/loro-v2/objects/<encoded_key>`【已具备】**：
     - 按 `(account_id, object_key)` 鉴权并返回原始 `application/octet-stream` 字节、`Content-Length`、`X-Content-Sha256` 与 `Cache-Control: no-store`（禁止跨账号读取、禁止 3xx 跨域跳转，响应前复核行内 `< 256 KiB` 或外部对象存储 `>= 256 KiB` 字节数与 SHA-256）；客户端落盘前再次校验字节数与 `sha256`。
   - **`GET /api/sync/v1/usage`（及 `loro-v2/usage`、`?namespace=loro-v2|project-v1`）【已具备】**：
     - 返回 `{ usedBytes, quotaBytes, hardLimitBytes, metering, namespaces }`（默认软上限 `500 MiB`、硬上限 `1 GiB`），同时兼容 0.1 与 `next/`。

3. **配额判定与 `413 QUOTA_EXCEEDED` 分流【服务端已具备（`29074bc6`，待推送上线）】**：
   - 客户端在导入新素材变体前会按 `usedBytes + pendingUploadBytes + incomingBytes > quotaBytes` 预检软上限（`500 MiB`），但**从不在客户端阻断正文／条目结构更新（`loroUpdate`）或永久删除墓碑（`docPurge`）**。
   - **【已具备】** 服务端已落地与 0.1 对齐的三档分层策略：
     - `assetBlob` 上传超过 `quotaBytes`（`500 MiB`）即返回 `413` 与 `{ "code": "QUOTA_EXCEEDED", "usedBytes": ..., "quotaBytes": ..., "hardLimitBytes": ... }`；
     - `loroUpdate` 放行至 `hardLimitBytes`（`1 GiB`），避免资源触顶时卡住纯文字写作同步；
     - **`docPurge` 墓碑不计入 `usedBytes`，且即使已达或超过硬上限也始终放行写入**，保证存储满后永久删书腾空间的操作总能同步上云。

4. **数据库迁移、墓碑保留与云端对象回收（GC）【迁移与整书按需回收已具备（`29074bc6`）；单文档增量折叠留作可选后续优化】**：
   - **数据库迁移【已具备】**：已新增有序迁移 `0010_loro_sync_v2.sql`（未修改 `0000`–`0009` 既有迁移），建立不可变递增日志与 `(owner_id, namespace, object_key)` 唯一约束、数据库级 `CHECK` 约束强制 `docPurge` 墓碑行永不可标记回收，并同步接入账号数据归属表目录（14 张表）、管理后台指标、对象存储一致性校验及生产备份恢复验证。
   - **整书删除与服务端资源回收【已具备，默认关闭】**：客户端执行 `book.purge` 时为该书 `book:<book_id>` 及全部子文档写入带 `bookId` 的 `docPurge` 墓碑；服务端已提供整书回收脚本与开关（默认 `SYNC_LORO_GC_ENABLED=0` 关闭自动物理删除，保留期默认 `30` 天、外部对象延迟释放默认 `35` 天并支持 `--dry-run` 预检），确认度过保留窗口后可按需回收同一 `(account_id, book_id)` 下已被覆盖的历史 `loroUpdate` 与 `assetBlob` 字节并扣减 `usedBytes`，同时**永久保留 `docPurge` 墓碑元数据**。
   - **增量日志折叠【未实现，留作可选后续优化】**：当某个 `doc_id` 上传了 `isSnapshot: true` 的 `loroUpdate` 且度过保留期后回收该 `doc_id` 旧增量对象的自动折叠暂未启用，不影响当前正确性与上线。

5. **0.1（Yjs）向 `next/`（`loro-v2`）的迁移边界【双命名空间并存与可切换计量已具备（`29074bc6`），待作者确认配额口径并推送上线】**：
   - **不做服务端侧 Yjs → Loro 在线自动转换**。0.1 的 SQLite + Yjs 模型与 canonical v3 的 Loro 条目树／多正文模块存在结构映射，转换权威统一在客户端 M10（`dr-import-v1`）。
   - **【已具备】** 切换期间同一账号下的 `project-v1`（0.1 客户端）与 `loro-v2`（`next/` 客户端）在服务端按命名空间并存、互不覆盖。服务端默认启用过渡期独立计量（`SYNC_QUOTA_METERING_MODE=separate`，`loro-v2` 与 `project-v1` 各自享有独立 `500 MiB` 软上限／`1 GiB` 硬上限，避免导入首次同步受 0.1 历史占用触顶），同时已内置 `SYNC_QUOTA_METERING_MODE=combined` 共享池开关（日后切换仅改环境变量，无需改代码或数据库），待作者最终确认是否沿用默认 `separate` 并执行推送部署。

## 交回（2026-11-11：新版 App 接入自动同步）

### 做了什么

1. **内核自动同步运行时与删书物理资源回收（`dr-sync` + `dr-workspace`）**：
   - 新增 [`dr_sync::SyncRuntime`](../../../next/crates/dr-sync/src/runtime.rs)，在独立后台工作线程上驱动 `SyncEngine::sync_once`：开库后立即跑首轮同步并按固定周期轮询；订阅 `StoreEvent` 将连续本地编辑按尾部防抖合并为单次上传；瞬时网络／5xx 错误按指数退避重试，离线快速重连，遇到 `401`（`Reauth`）或 `413`（`Quota`）自动暂停重试直至凭据变化或手动触发；未登录／本机模式不创建网络循环、零请求。
   - 补齐整书永久删除后接收端的物理资源回收：当 `DocPurge` 使某本书满足整书已清除（`library.book_purged(b) && library.purged("book:<b>").is_some()`）时，自动回收本机已下载的该书物理资源变体与 `asset` 表记录，并在从 `cursor = 0` 重放时跳过已清除书的历史 `AssetBlob` 下载，另一本书的资源与文档不受影响。
   - 保持 F2 持有者边界：远端 `DocPurge` 遇到当前打开的文档先释放非活跃书槽位，若仍被编辑器持有则维持 `StoreError::AlreadyOpen` 阻塞且不推进游标，待标签页／书切换释放持有者后自动唤醒重跑；拉取更新后自动刷新 `Workspace` 派生缓存与脏全文索引，并在 [`dr-workspace`](../../../next/crates/dr-workspace/src/sync.rs) 提供 `"sync.status"`、`"sync.now"` 与 `check_book_revision_freshness`（防止外壳异步旧快照回退覆盖同步新版本）。
   - 新增独立回环假服务示例 `cargo run -p dr-sync --example fake_sync_server` 及 `FakeSyncServer::set_fail_all` 断网注入接口。
2. **桌面 App 生命周期监督器与排空屏障（`app/drifting`）**：
   - 新增 [`app/drifting/src/sync.rs`](../../../next/app/drifting/src/sync.rs) 生产监督器并在 `main.rs` 挂载：监听 `AccountUiService` 与 `LibraryRegistry` 状态切换账号库／本机库（含首次启动 `first_run::write_samples` 短暂持有 `Workspace` 克隆时的非阻塞重试切换），仅在已登录且当前打开目标账号库时启动 `SyncRuntime`。
   - 接入两阶段释放屏障：阶段一 `release::before_release` 调用 `pause_for_release()` 冻结新周期并等待在途拉取落定；待 G1 `after_drain` 最终快照写入完成后，阶段二通过 `dr_shell::sync::register_final_drain` 调用 `drain_and_detach()` 将最终快照一并上传排空（离线时最佳努力限时返回，不卡死退出／换库，本地 SQLite 提交完整保留）；侧栏账号浮层退出登录前先经 `register_before_sign_out` 排空待传改动。
3. **F6 稿纸左下角同步角标与通知中心联动（`dr-shell`）**：
   - 新增 [`dr_shell::sync`](../../../next/crates/dr-shell/src/sync.rs) 并接入主舞台首栏稿纸左下角（`left: 16px, bottom: 16px`，沉浸模式同步保留）：已同步／本机模式／暂停隐藏；同步中满 3s 显示呼吸云朵并保持至少 1.5s，打字时淡出、停笔 2s 恢复；重试满 30s 慢闪；离线显示散沙云朵；严重异常（`NotStarted`、`Reauth`、`Quota`、`Failing`）一律显示朱砂「`!`」，悬停 220ms 浮出卡片支持重试、重新登录与直达「偏好设置 → 账号」。
   - 严重同步问题置顶写入 `Notifications`（`Source::Sync`），并在侧栏通知风铃旁显示朱砂「`!`」印记；恢复正常或回到本机模式后自动撤除置顶告警。
4. **服务端契约文档**：在本文新增「服务端需要提供的」一节，完整列出 `loro-v2` 命名空间、HTTP 头与幂等规则、`413` 分层配额、数据库迁移与整书清除后的 GC 策略及 0.1 → `next/` 迁移边界。

### 检查结果

在受检源码提交 `6d6bec016638f907474546782e5b62df023d8bf2`（已合并 `main` `28d1930f0`）上，统一设置 `CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1` 执行：

- `cargo fmt --all --check`：通过（退出码 0）。
- `cargo clippy --workspace --all-targets --locked -- -D warnings`：通过（退出码 0，零警告）。
- `cargo test --workspace --locked`：通过（共 **2236 通过、0 失败、21 忽略**；含 `dr-sync` 全部 20 项测试——新增 [`auto_sync_runtime`](../../../next/crates/dr-sync/tests/auto_sync_runtime.rs) 端到端双向自动同步／断网恢复／删书回收资源与库外合成哨兵文件零改动／打开文档阻塞与释放后续跑／换库与退出排空／本机模式零请求，以及 `drifting::sync::tests` 3 项监督器与冷启动重试测试、`dr-shell::sync::tests` 角标状态机测试、`dr-workspace::sync::tests` 新鲜度守卫测试）。
- `cargo xtask check`：全部 13 项门禁与 `cargo audit` 通过（974 个锁定包、0 漏洞、12 条既有提示；既有基准测量文件状态未改动）。
- 仓库根 `pnpm public:check`：通过（5589 个候选文件）。
- **副屏双窗口真窗口往返重开冒烟**：持有 `$HOME/Drifting-autopilot-logs/native-window-lease.json` 租约，在 `DRIFTING_WINDOW_DISPLAY=secondary`、`DRIFTING_DEV_EPHEMERAL_SECRETS=1` 下启动两个隔离开发 profile 真窗口连接同一 `127.0.0.1` 回环 `fake_sync_server` 与合成令牌（日志与摘要位于 `$HOME/Drifting-autopilot-logs/app-sync-v3-smoke-f8fd2904/`）：甲窗输入正文后乙窗自动出现，乙窗回应后甲窗自动出现，甲窗输入末行后立即执行 `app.quit` 排空退出、乙窗退出，双窗重开后两库正文均完整收敛且逐字一致，租约正常释放。全套门禁日志存于 `$HOME/Drifting-autopilot-logs/app-sync-v3-checks/`。最终交回仅在本提交追加此交回小节，Rust／Cargo 源码树与 `6d6bec016` 完全一致。

### 待协调

- **Hosted 服务端上线与切换期配额口径（服务端本地 `29074bc6` 已实现并验收，待作者确认配额口径并推送上线）**：独立服务端仓库已完成本文「服务端需要提供的」所列 `loro-v2` 命名空间、HTTP 接口、三档配额（默认 `SYNC_QUOTA_METERING_MODE=separate` 过渡期独立 `500 MiB / 1 GiB`，内置 `combined` 合并模式开关）、有序迁移 `0010_loro_sync_v2.sql` 与按需整书回收脚本，并通过本机容器栈与 `next/` 三设备往返联调（见 `~/Drifting-autopilot-logs/loro-v2-server.md`）；仅剩作者确认是否沿用默认 `separate` 配额口径并按交回报告五步清单推送部署。
- **「偏好设置 → 账号」页内退出登录按钮的预排空钩子（已在凌晨追加第 2 项补齐 11-12）**：`dr_shell::sync` 现提供公开入口 `run_before_sign_out(cx)`，`dr_view_account::sign_out(cx)` 统一在发起 `inner.sign_out()` 吊销远端令牌之前先行调用并等待 `run_before_sign_out(cx)` 冲刷待传改动，同时以 `signing_out` 重入保护合并侧栏账号菜单与「偏好设置 → 账号」页两处退出入口，保证无论从哪一处退出均先排空上传一次再吊销令牌并切回本机库（见 `dr-view-account::tests::settings_account_sign_out_drains_before_revoking_token` 与 `drifting::sync::tests::settings_sign_out_drains_pending_uploads_before_token_revocation_and_returns_to_local`）。
- **顺带记录的既有测试竞态观察（已在凌晨追加第 3 项确定性修复 11-12）**：排查工作区测试时发现 `dr-view-element-overview` 的 `drag_drop_onto_island_reuses_g2_prepare_drop_and_supports_undo` 偶发与 `dr-view-history::AutomaticHistory` 后台线程的 `entry_snapshot.capture` 竞争同一 `book:<id>` 的 `oplog_frontiers()`（`membership.add`／`undo` 不改条目自有状态哈希或启动基线晚于首笔前台写入，`changed.is_empty()` 分支会将全书条目加入 `dirty` 并在无周期定时器情况下后台立即连续写入首次快照），小概率触发 `WritePreconditions` 的 `stale observation`。已在 `dr-view-history::AutomaticHistory` 补齐订前同步 `loro_head` 基线与 15 分钟 `PERIODIC_INTERVAL` 定时器并移除全书标脏回退，见 [`m09-history.md`](m09-history.md)。

## 2026-11-13：没应用的远端更新不确认，游标随库保存

### 原来的问题

- **没应用也确认。** 远端 Loro 更新若依赖本机没有的操作，Loro 1.17.1 只把它停在内存里的待定池（`ImportStatus.pending`），版本不动；F2 holder 版本没变就什么也不存，关掉最后一个句柄文档就丢了。旧引擎照样 `mark_uploaded`、推进并保存游标，这条记录再也不会被拉取。
- **游标离开了它描述的数据。** 游标在库目录旁的 `sync-cursor-v2.json`，每条记录整份重写（连同不断增长的已登记文档集合）。M41 应用内恢复备份只换数据库文件，恢复旧备份后游标领先于数据：备份之后的记录不再拉取，之后依赖它们的更新又落进上一条。按服务端契约（严格递增 seq、升序分页）正常投递本就按因果顺序，恢复备份是眼下唯一现实的触发途径。

### 现在的行为

1. **只确认完整应用的更新**（`dr-sync/src/engine.rs` `apply_remote_record`）。导入结果（F2 已有的 `Imported.status`）带 `pending` 时：不 `mark_uploaded`、不登记、不推进游标，返回 `SyncError::MissingDependencies { doc_id, seq }`。已经应用的部分照常由 F2 存下，并照常重建索引、调用 `after_remote_import`；等待的部分不写进 `loro_update`（`load_into` 拒绝缺依赖的存储）。本机还没有的文档，先读更新块的 `start_frontiers`（`decode_import_blob_meta`）：块依赖块外操作就直接报错，不为它建空文档（否则下一周期会把空 genesis 上传成服务端的一条垃圾记录）。
2. **一次自愈重放**（`pull_remote_changes`）。某文档第一次报 `MissingDependencies` 时游标存回 0，下一周期按序重放整条日志；已应用的记录走既有的 `already_covered` 跳过，与 `restore_library` 一样幂等。每个引擎实例每个文档至多一次（运行时每次接入新建引擎，即重启或换库后可再有一次）。重放后仍缺，就停在那条记录前、每周期报同一个错误，由运行时退避和健康状态（连续 3 周期失败升为「！」）呈现。**打开着的文档**：Loro 把早到的更新留在该文档内存里，依赖到达时一并应用，F2 把两者存成一行；早到那条的记录随后被判为已覆盖并确认，不会卡住。
3. **游标随库保存**。引擎状态改存在库内 F2 `local_state`，scope `sync-v2`（`dr_sync::SYNC_STATE_SCOPE`），不同步、不绑 `book_id`：键 `cursor`（十进制 seq）；每个已在服务端的文档一行 `doc/<doc_id>`；每个已上传墓碑一行 `purge/<doc_id>:<purged_ms>`。每条记录只写游标这一行（值没变不写），遇到新文档多写它自己一行，与文档总数无关；`restore_library` 在一个事务里把游标置 0、删掉文档行。备份是整库 `VACUUM INTO`，恢复后游标与数据一致；库里没有状态就从 0 开始。旧的 `sync-cursor-v2.json` 在 `SyncEngine::new` 时删除、从不读取（未发布，不做兼容）。没有新迁移：`local_state` 是 `0004` 已有的设施。写走 `local_write`，每改一行照 F2 规则发一条 `LocalChange`（表 `local_state`，键 `sync-v2/…`），运行时的订阅不理会这张表。
4. **`Workspace::import_remote`**（`dr-workspace`）未改：它对等待中的更新照旧返回成功，这是 v4 切换契约 `dr-workspace/tests/cutover.rs` 的 `a_marker_change_that_arrives_before_its_dependency_is_refused_with_it` 明确断言的行为（「等待、什么也不改」，重启后须再来一次）。同步引擎不走这条路径，目前只有测试调用它；若要让它也报错，需由切换契约的负责方一并改那条断言。
5. **假服务** 新增 `records()` 与 `withhold(seq)`／`release_withheld()`：后者故意打破按序契约，让后一条更新先于它依赖的那条被列出。

App 的恢复接线（`app/drifting/src/main.rs` 经 `dr_shell::library::replace` 调 `Library::restore_staged_with`）无需改动：恢复前运行时已排空并卸下旧库，恢复后新建的引擎从恢复出的数据库读游标。

### 测试

全部用本机回环 `FakeSyncServer`、临时库、合成令牌和 `dr_testkit::seed` 的 canonical v3 Tiny 数据。

| 测试 | 证明 |
| --- | --- |
| `causal_delivery::an_update_ahead_of_its_dependency_is_refused_and_one_replay_heals_a_closed_doc` | 同一正文的两次编辑分两条上传，扣下第一条：关闭的文档收到第二条时返回指名该文档与 seq 的 `MissingDependencies`；`remote_vv`、`head`、正文不变，游标（内存与库内）未越过它并回到 0；放出第一条后一次重放两者都在，版本与作者端一致，已确认，再同步无下载；关库重开可读。 |
| `causal_delivery::a_doc_held_open_parks_the_early_update_and_ends_acknowledged_after_the_replay` | 同上，但读者端一直持有该文档：早到的更新在打开的文档里不可见；重放后持有的句柄与库内都是两次编辑后的正文，早到那条被确认、游标到末尾，再同步无事可做。 |
| `causal_delivery::a_dependency_still_missing_after_the_replay_keeps_failing_without_another_reset` | 依赖一直不到：只回 0 一次，之后每周期停在同一位置报同一错误，失败周期计入健康状态；新引擎（相当于重启）有自己的一次重放，依赖可列出后恢复。 |
| `causal_delivery::sync_progress_lives_in_the_library_one_row_per_fact` | 旧状态文件不读、被删除；每个文档一行、首次见到时只写一次；之后拉 N 条已知文档的记录恰好只改游标行 N 次，文档行（含修改时间）不变；新引擎从这些行续上。 |
| `restore_backup::restoring_an_older_backup_resumes_from_its_own_cursor_and_converges` | 同步→备份→作者编辑、读者编辑并上传→恢复备份→作者再编辑：恢复后的新引擎游标等于备份时的游标，第一次同步即成功，取回作者两次编辑和自己恢复前上传的编辑，两库全部文档版本与值一致。换回 `main`（`8bfa4927e`）的 `engine.rs`／`protocol.rs`／`lib.rs` 实跑失败：恢复后游标是 JSON 里领先的 24 而非备份时的 22；去掉这条断言后，恢复后第一次同步下载不足 3 份文档（备份之后的记录被跳过）。 |

改动的既有断言：`v3_roundtrip.rs` 的 `reject_conflicting_document_identity`（三个矛盾元数据契约共用）原来比较 `sync-cursor-v2.json` 的字节不变，现在比较库内 `sync-v2` 全部行（含修改时间）不变，并断言这些行非空；含义同为「整个持久化同步状态不变」。

### 已知边界

- 依赖永远不到（服务端丢了记录或违反顺序契约），这台设备会停在那条记录前，后面其他文档的记录也拉不下来。这是有意的：可见的错误好过静默丢数据；何时跳过需另定。
- F2 holder 对部分应用的同步导入仍按块头把整个块的版本并进 `remote_vv`（「服务端有这些」本身为真）；是否重新拉取看 `head`，不受影响。dr-store 本次未改。

### 检查结果

在 `main` `8bfa4927e` 之上，于 `next/` 以 `CARGO_BUILD_JOBS=4`、测试 `RUST_TEST_THREADS=1` 执行：

- `cargo fmt --all --check`：通过。
- `cargo clippy -p dr-sync -p dr-store -p dr-workspace --all-targets --locked -- -D warnings`：通过。
- `cargo test -p dr-sync -p dr-store -p dr-workspace --locked`：368 通过、0 失败、2 忽略（含新增 5 项）。
- `cargo xtask check --skip audit`：11 项门禁全部通过；22 份 stale／15 份 legacy 测量照旧只记录（未跑审计）。
