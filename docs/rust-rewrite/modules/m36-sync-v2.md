# M36 Hosted 同步 v2

**交回状态**：已完成并交回（`codex/track4-account-sync` → `handback/track4`）

## 目标与范围

对应 `docs/rust-rewrite/handoff/m36-sync-v2.md`、`docs/hosted-sync/README.md` 与 `docs/hosted-sync/sync-status.md`，在 `next/` 工作区实现 Hosted 同步 v2（`dr-sync` 服务层 crate 与 `dr-view-account::sync_mark` 界面层记号视图）：

1. **对象日志 HTTP 协议（决定 D6，`loro-v2` 命名空间）**：
   - 沿用不可变对象日志 HTTP 协议，通过 `/api/sync/v1/loro-v2/objects/<key>`、`/api/sync/v1/loro-v2/changes?cursor=<seq>&includeRemovals=1` 与 `/api/sync/v1/usage` 承载 Loro 增量更新批次、快照、文档清除墓碑（`removals-v1`）以及不可变资源变体文件。
   - 服务端只存不透明对象，不感知文档内部结构。
   - 保留 `src-tauri/src/hosted_sync.rs` 的安全边界：`validate_sync_url`（校验 `http`/`https`、禁止凭据与 fragment、强制同源、路径必须以 `/api/sync/v1/` 开头并拦截 `..` 与 `%2e%2e` 路径穿越）、`verify_payload_integrity`（`MAX_OBJECT_BYTES = 64 MiB`、字节长度与 `sha256:<hex>` 摘要校验）以及 `write_verified_file_atomic`（`.part` 临时文件写入、`sync_all`、取消信号清理与原子 `rename`）。
2. **不透明文档与资源同步引擎（`SyncEngine`）**：
   - 把一本书及工作区当作「一组不透明 ID 的 Loro 文档加资源文件」，文档 ID（`doc_id`）和文档种类（`kind`）均作为不透明字符串处理，不写死任何文档种类列表，直接兼容通用内核 v3 的树与叶子模块。
   - **增量上传与压缩正交**：使用 F2 `dr_store::Library` 已有的 `docs_with_local_changes`、`export_for_upload(doc_id)` 与 `mark_uploaded(doc_id, &vv)`，只上传 `remote_vv` 之后的增量改动；即使本机已跑过 `compact_now` 折叠快照，`export_for_upload` 依然从文档 oplog 导出精确增量，压缩与上传互不相干。
   - **帮手对话同路同步（M27）**：帮手对话文档（如 `conv:*`）与书目、正文章节走同一条 `LoroUpdate` 通道，不另起同步引擎。
   - **断网续传**：逐条记录并持久化游标（`sync-cursor-v2.json`）与 `sync_doc.remote_vv`、`asset.uploaded_ms`；中途断网后重连可从断点继续上传与拉取。
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

## 交回

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
