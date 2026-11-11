# M23：审阅与素材 Super View（`dr-view-shelf-review`）

`SuperView::ReviewMaterials`（工作台快捷键 `⌘⌥5` / 切页器「审阅与素材」）将整本书的待办、批注、素材与未整理／已解决归档收拢在同一张全屏工作台上，建立在 canonical v3 书目模型（`Entry { id, module }`、`Material`、浮动批注与 `Relation`）之上。

## 结构与职责划分

- **`next/crates/dr-view-review`（M18 复用出口）**
  - `v3_panel::ensure` 为宿主返回绑定到当前书与跳转／砂印回调的 `Entity<ReviewView>`，不经过旧版导航类型转换。
  - `ReviewView` 暴露 `cards_for`、`group_header`、`render_card`、`set_done`、`delete`、`reload_now`、`is_loaded`、`is_writing` 与 `drain_writes`。两列审阅卡的就地双击编辑、保存失败草稿保留、原文快照悬停卡与局部写入（`comment.update`、`comment.delete`）继续走 M18 的同一套实现，不复制第二份状态机。
- **`next/crates/dr-view-shelf-review`（M23 舞台）**
  - **页眉双槽（`ShelfReviewHeadStart` / `ShelfReviewHeadEnd`）**：左侧显示 `{{todos}} 待办 · {{comments}} 批注 · {{materials}} 素材` 实时计数；右侧放置统一搜索框，同时过滤待办、批注、素材架与底部抽屉。
  - **左一列（待办列）与左二列（批注列）**：各自带独立拖宽手柄与键盘左右微调（`24px` 步进），最小列宽 `240px`，右侧素材区至少保留 `360px`。列宽与比例、底部抽屉开合与高度通过 `Workspace::book_memory("shelf-review")` 按书持久化到本机 `local_state`，不写进同步书目文档。
  - **右侧素材架（`shelf.rs`）**：复用 `dr_view_material::card::MaterialCard`、`kind_label`、`subline`、`thumb` 与 `previews`；顶栏提供固定顺序的类型片（笔记 / 图片 / PDF）、基于 `dr_view_material::v3::related` 的可搜索 `Entry` 关系筛选、以及新建笔记／导入或拖入外部图片与 PDF（`dr_view_material::import::import_paths`）。每张素材卡的悬停卡提供打开、用系统应用打开原件、基于 `dr_view_material::v3::entry_links` 与 `material.set_entry_link` 的条目关联开关、基于 `dr_view_material::folders::{Tree, move_to}` 的素材夹移动，以及带确认对话框的删除。
  - **底部抽屉（`drawer.rs`）**：默认收起为 `28px` 底栏并显示「待整理」与「已解决」计数，展开后可从顶边拖高（最小 `120px`）。左栏列出当前可见素材中尚未关联任何存活实体的待整理素材（保留同一套悬停卡整理入口）；右栏列出已解决的待办与批注，支持一键重开（`set_done(id, false)`）与删除。

## 生命周期与库切换隔离

- **归属校验（`Owner`）**：导航跳转与 `book_memory` 写回均核对 `(book_id, Book::v3, Library ptr)`，切书或换库后的旧异步回调不会误跳页或污染新书记忆。
- **释放屏障（`dr_shell::release`）**：`before_release` 同步冻结新写入，异步等待本视图与内嵌 `ReviewView` 的全部在途写入落盘后释放 `Workspace` 句柄、事件订阅与 `dr_view_material::previews` 缓存，确保整库恢复或退出时 `try_shutdown` 零泄漏通过；`after_release` 从当前 `Services` 重新绑定。

## 验证

- 纯模型与 GPUI 契约测试：`next/crates/dr-view-shelf-review/tests/shelf_review.rs`（覆盖列宽比例与夹紧、统一搜索、类型片与 `Entry` 关系筛选、关联／解除关联驱动待整理抽屉、完成与重开驱动已解决抽屉、多书隔离与按书记忆恢复、以及 `dr_shell::library::replace` 释放屏障）。
- 调试桥副屏真窗口验收：在 `showcase` 种子的《慢钟》上以独立临时 profile 走通打开 `SuperView::ReviewMaterials`、展开底部抽屉、拖动调整待办栏宽度、浅色与深色双轮重启并验证 `book_memory` 恢复。
- 字符串门禁：`dr-i18n/keys.txt` 新增的 `memoMaterial.super.*`、`memoMaterial.todo.empty`、`memoMaterial.dialog.*` 与 `reviewPanel.newComment` 九语种对齐并由 `dr-shell` 字符串测试校验。
- **`Preset::Heavy` release 空闲实测与优化对比**（100 章约 165 万字符、96 条待办、64 条批注、60 篇素材；`cargo test --release --locked -p dr-view-shelf-review --test shelf_review heavy_seed_reference_timings -- --ignored --nocapture`，机器空闲 `load1m < 4.0`）：
  - **不改格式与行为的热路径优化**：待办栏、批注栏、右侧素材网格以及底部抽屉「待整理／已解决」全部五个滚动区由全量立即树切换为 `gpui::list(ListState)` 按视口虚拟化挂载，并按修订号缓存行扁平化快照（`CachedReview`、`CachedMaterials`、`ShelfRowsCache`）；`dr-ui::glass::paint_rim` 对滚出遮罩的玻璃框提前裁剪；`dr-doc` 新增标量头扫描 `entry_headers` 与 `material_titles` 供 `dr-view-review::v3::load` 与 `dr-view-material::v3::shelf_relations` 复用，消除打开时的 4 次全树 `get_deep_value()` 重扫。
  - **首开首帧（`first_frame_ms`）**：优化前（`load1m 3.44 → 3.40`）`3.95 ms` → 优化后（`load1m 3.71 → 3.57`）**`2.35 ms`**（满足 `benchmarks.md` Super View 首开 `≤ 100 ms` 发布档预算）。
  - **异步数据就绪（`ready_ms`，含审阅分组、60 篇素材与关联加载）**：优化前 `326.80 ms` → 优化后 **`136.06 ms`**（提速 **2.4×**）。
  - **单帧绘制与滚动（20 帧，底部抽屉展开态）**：优化前 `p50 = 43.37 ms`、`p95 = 48.34 ms` → 优化后 **`p50 = 3.96 ms`、`p95 = 4.70 ms`**（提速 **10.3–11.0×**，远优于 120 Hz 发布档 `≤ 8.3 ms` 与 Super View 最差帧 `≤ 100 ms`）。
