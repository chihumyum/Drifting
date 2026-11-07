# 功能模块 M01–M43

每个模块对应一个功能界面 crate（`dr-view-*`）或一个服务 crate，由一个会话负责。

- **「旧代码」**一列写的是要对照的现有实现，行数不含测试，路径相对于仓库根目录。
- **「依赖」**一列只写基座和其他模块。所有带界面的模块都依赖 F5、F6，表里不再重复。
- **大小**的含义同 [foundation.md](foundation.md)：S 几天，M 1–2 周，L 3–6 周，XL 6 周以上。

每个模块的验收都包括三项：

1. 对照旧版功能逐项点过；
2. 文案进 `dr-i18n`，九种语言都有；
3. 浅色和深色都看过。

## 阶段 2：写作闭环

| # | 模块 | 作者能做什么 | 旧代码 | 依赖 | 大小 |
| --- | --- | --- | --- | --- | --- |
| M01 | 书架（基础） | 书卡；新建、编辑、删除书；最近删除；账号格子 | `src/renderer/views/ProjectPickerView.tsx` 1085、`views/shelf/*`、`src/styles/project-picker.css` 890 | F3 | M |
| M02 | 作品主页（基础） | 在原地改书名；进度读数；「继续写」和最近打开；每条故事线一行；新建一行（章节 / 构想 / 要素 / 故事线 / 分类 / 素材）；主页上的设置 | `views/ProjectDashboard.tsx` 796、`shells/desktop/project-home/*`，合计约 2.3k | F3 | M |
| M03 | 章节页与稿纸工具栏 | 标题自动换行，回车进入正文；梗概；页眉（第 N 章 · 故事线 · 字数）；写作状态；章末 ⁂（完成或回到草稿、在后面新建一章）；空章提示；工具栏的 ⋯ 菜单 | `views/NodeEditorView.tsx` 950、`components/editor/ChapterEditor.tsx` 485、`ChapterEndOrnament.tsx` 268、`EditorTopBar.tsx` 556 | F4 | M |
| M04 | 章节面板、幕与大纲栏 | 左栏章节面板（按故事线分组或看全书概览、排序、格子信息）；幕的分界；左侧只有文字的大纲（幕 / 章 / H1 / H2 / H3，空间不够时收起）；滚动条上的批注和 Agent 改动刻度 | `components/leftBars/ChapterPanel.tsx` 654、`LeftSidebarSubHeader.tsx` 620、`GroupHeaderCell.tsx` 463、大纲栏约 1.9k | F3、F4 | M |
| M05 | 通览全书 | 一个滚动区装下所有章节，每幕有扉页；在任意一章里直接写；目录跳转；保留阅读位置 | `views/AllChaptersEditorView.tsx` 1038、`components/editor/VirtualChapterRow.tsx` 454 | F4b | M |
| M06 | 搜索与查找 | 全局搜索 ⌘⇧F，结果按章节、故事线、要素、分类分组；章内查找 ⌘F；全书查找。只查找，不替换 | `components/search/*` 约 1.5k、`lib/all-chapters-find.ts` 347 | F2 的 FTS5、F4d | M |
| M07 | 字数与写作日 | 两个读数：一个按选区 → 章 → 故事线 → 全书取最具体的那一级，一个是今天写的字数；每台设备每天每本书记一条写作日 | `components/workspaceChrome/WorkspaceWordTally.tsx`、`services/writing-days/*`、`packages/prose-metrics`（Apache-2.0 的字数规则，移到 Rust 后规则一字不改） | F2、F3 | S |
| M08 | 设置（第一批） | 外观、编辑器、语言、快捷键、本机数据、关于；可以搜索设置项 | `features/settings/*` 约 5.9k、`store/settings-store.ts` 864、`src/styles/settings.css` 2522 | F6 | M |
| M09 | 快照历史 | 每篇正文保留 30 天快照，每 15 分钟最多一份；可以预览和恢复 | `components/modals/EntitySnapshotHistoryModal.tsx` 220、`services/snapshot-*.ts` | F2、F3 | S |
| M10 | 旧库导入 | 把 0.1.x 的库导入新库：结构化表、正文、批注与补丁的锚点、快照历史、资源文件、设置、钥匙串条目，以及只读的帮手对话；显示进度；原库只读、不动；没经过交接、无法证明最新的正文默认拦住，作者点「仍然导入」才照缓存导入 | 新写，规格来自 P0-E | F1、F2、F3 | L |

### M10 要读的旧数据

- **数据库**：`drizzle/` 下的 19 个迁移，共 100 张表。其中 28 张会同步，72 张不同步。同步的那 28 张是导入的主体。
- **正文**：每个文档一个 `XmlFragment('default')`，存的是 Yjs v1 更新，位置按 UTF-16 计。
  - 文档 id 有五种前缀：`node-content:`、`element:`、`storyline:`、`category:`、`library-item:`。
  - 节点和标记的完整清单见 `src/renderer/lib/editor-schema-profile.ts`。
  - 人物链接在 Yjs 里的标记键是 `entityLink--<6 字节哈希>`；缓存 `content_json` 里是普通的 `entityLink` 加属性。导入读缓存，不碰哈希。
- **锚点**：`comment.anchor_json` 有 v1–v4 四版，`element_patch.text_anchor_json` 也是这个形状。它们都是「块 ID + 偏移量」，不是 Yjs 的相对位置。
- **快照历史**：`entity_snapshot_history` 每行除了 `state_blob`（完整的 Yjs 状态），还有捕获时渲染好的 `content_json`，导入用它回放，不读 Yjs。
- **规格草稿**：逐表映射、缓存新鲜度的判断、交接设计见 [P0-E 结论](spikes/p0-e-import.md)。
- **其他格式**：
  - `.driftingbook`：CBOR，`drifting.book` v1；
  - 整库备份 `.drifting`：ZIP，里面是 SQLite 加资源文件；
  - Markdown 文件夹清单：`.drifting/manifest.json`，schema 4。

## 阶段 3：故事工坊

| # | 模块 | 作者能做什么 | 旧代码 | 依赖 | 大小 |
| --- | --- | --- | --- | --- | --- |
| M11 | 要素与分类 | 要素页：名称、别名、摘要、立绘、字段、正文、补丁、引用与反链、Agent 改动的字段审阅；分类页和字段模板；左栏要素面板（紧凑索引或名称列表） | `views/ElementEditorView.tsx` 1026、`ReferencesPanel.tsx` 803、补丁与字段约 2.5k、`components/leftBars/ElementPanel.tsx` 905、`views/CategoryEditorView.tsx` 488 | F3、F4 | L |
| M12 | 人物链接 | 用 @ 选择要素或章节，也可以直接新建要素；按名称和别名自动链接；改名导致断链时修复；对已有正文补加链接；悬停卡 | `lib/extensions/entity-link*`、`lib/entity-link-*.ts`、`services/reference-projection.service.ts` | F4e、M11 | M |
| M13 | 故事线 | 故事线页：标题和砂笔记号、颜色、字段、说明、章节序列；主故事线 | `views/StorylineEditorView.tsx` 573、`KvEditor.tsx` 244 | F3、F4 | M |
| M14 | 底部时间线 | 故事线泳道，按书序或叙事时间排列；在泳道之间拖动章节片段（带弹簧吸附）；幕轨可以拖动边界；时间钉可以绑定构想；展开；未安放的章节；无归属泳道；双击在当前位置新建 | `shells/desktop/views/DesktopBottomTimeline.tsx` 1444 等，约 3.6k；`bottom-timeline.css` 840、`act-rail.css` 332 | M13 | L |
| M15 | 情节规划 | 每章一张格子表，行 × 列，格子是一张张纸条；格子可以拉宽；在表头插入、移动、改名、清空 | `components/editor/PlotGrid.tsx` 770、`plot-grid/*`，约 2.1k | F3 | M |
| M16 | 构想 | 构想面板：可以嵌套的分组、休息抽屉、浮动托盘；构想可以转成章节或要素，可以绑到幕或时间钉 | `components/leftBars/DriftPanel.tsx` 722、`usecase/useDriftGroup.ts` 352、`DriftBindModal.tsx` | F3、F4 | M |
| M17 | 关系与关系类型 | 在要素、章节、构想之间建关系；关系类型带两端的角色名；端点种类有限制 | `components/rightBars/EntityRelationPicker.tsx` 500、`components/ui/RelationKindMenu.tsx` 578、`docs/relation-types.md` | F3 | M |
| M18 | 审阅：批注与待办 | 右栏审阅面板：可按全部、批注、待办筛选，范围选当前或全项目，按位置分组；在原地编辑；完成待办时画上勾；批注撰写框跟着选区出现；多段批注锚点画成干笔砂痕；自动识别 `TODO:` 和 `待办:` | `components/rightBars/ReviewPanel.tsx` 433、`features/comments/*`、`lib/comment-sand.ts` 554，约 3.9k；`comments-review.css` 1939 | F4d、F3 | L |
| M19 | 素材 | 图片和 PDF：缩放平移、区域批注；笔记用素材笔记的编辑配置（列表、任务、表格、代码、提示框、高亮、素材嵌入）；素材夹树可以拖放和多选；右栏素材库；拖入或粘贴文件导入 | `views/MaterialEditorView.tsx` 587、`features/library/*`，约 6.5k；`material-workbench.css` 2065。PDF 预览改用 hayro 或 pdfium-render | F2、F4 | XL |
| M20 | 统计面板 | 右栏统计：单个对象、全书、素材三种范围；提及的出与入；读数用砂笔画 | `features/stats/*` 约 2.2k、`store/writing-stats-store.ts` 371 | F2、M07 | M |

## 阶段 4：Super View 与视觉

视觉部分先出原型，作者点头以后再落地。

| # | 模块 | 作者能做什么 | 旧代码 | 依赖 | 大小 |
| --- | --- | --- | --- | --- | --- |
| M21 | 故事图 ⌘⌥3 | 故事线泳道，可切换书序或叙事序；构想卡片和虚线；按住 Shift 点两个节点建关系；把未安放的章节拖到轴上；幕轨和时间钉 | `DesktopStoryGraphView.tsx` 1792；三个 Super View 共用的图形核心约 5.1k；`graph-view.css` 1004 | M14、M17 | L |
| M22 | 要素全景 ⌘⌥4 | 群岛：每个分类一座岛，三档缩放，按提及次数决定印章大小，同段共现画砂线，聚焦模式，浮动岛卡可以展开成编辑器，把要素拖到另一座岛就改分类；关系：力导向布局，拖动固定，记住位置，弧线两端写角色名 | `DesktopSuperElementView.tsx` 2873，合计约 4.2k，用到 canvas、SVG 和 d3-force；`super-element.css` 936 | M11、M17 | XL |
| M23 | 审阅与素材 ⌘⌥5 | 待办和批注两列，宽度可调；素材库带类型片和关系筛选；底部抽屉放未分类的素材和已解决的条目 | `DesktopSuperMemoMaterialView.tsx` 1572 | M18、M19 | M |
| M24 | 字海、加载与首次体验 | 字海托起 Drifting；欢迎；选文件夹；示例书落位；6 步导览；空状态提示；内置样书（傲慢与偏见、阿Q正传） | `lib/char-sea/*` 1.7k（WebGL2，改成 CPU 模拟；动起来时点留在原地、只浮出字，见 P0-D）、`components/modals/PreAlphaOnboardingDialog.tsx` 409、`features/guide/CoachTour.tsx`、`services/built-in-sample` | P0-D、M01 | L |
| M25 | 书架封面与写作热力图 | 14 种封面画风，用底部按钮轮换；53 周砂笔热力图；书卡上近 30 天的砂条 | `lib/shelf-cover/*` 1.95k（Canvas 2D，改用 tiny-skia）、`views/shelf/WritingHeatmap.tsx` | M01、M07 | M |
| M26 | 沉浸写作与打字机滚动 | ⌘⇧↩、一炷香按钮，或者开始打字时自动进入：隐去所有界面，只有光标所在的段落不淡出；打字机滚动是单独的开关 | `features/immersive-writing/*` 等，约 930 | F4d | S |

## 阶段 5：帮手

F3 的命令注册表一好就能开，不必等阶段 3。

| # | 模块 | 内容 | 旧代码 | 依赖 | 大小 |
| --- | --- | --- | --- | --- | --- |
| M27 | 运行时核心 | 与模型无关的驱动接口，只做本机这一种接法（`sidecar` / `remote` 从没实现，作者 2026-11-07 定为不保留）；运行日志是唯一的事件流，消息由事件推出，结算记录和 Loro 更新同一事务；权限请求；向作者提问；中途转向；在当前工具之后停止；中止 | `src/renderer/lib/agent/protocol.ts`、`transport.ts`、`runtime/*`。运行时核心约 5.7 万行，其中不少是旧数据模型和 Yjs 的适配，新版要重新设计，不是逐行搬 | F3 | XL |
| M28 | 模型接入 | DeepSeek（Chat Completions）、Anthropic（Messages：流式输出、自适应思考、回放签名过的思考内容）、OpenAI（Responses）、ChatGPT 订阅（设备码登录，走 Codex 后端）；实时拉取模型列表；各家自带的联网搜索 | TS 驱动：`runtime/drivers/*`。已经是 Rust、可以复用的：`codex_oauth.rs` 858、`codex_models.rs` 516、`byok_models.rs` 484；`openai_responses.rs` 644 只转发字节，只留错误投影和 Codex 请求头，流式解析按 TS 驱动重写。新版一个 HTTP 客户端、一个 SSE 解析器、三种协议适配 | M27 | L |
| M29 | 工具 | 命令注册表加一层帮手外观（按名称找对象、正文投影成可改的文本），不保留旧目录名和虚拟路径；工具搜索（`tool_search` / `call_tool`）；读写屏障；修订 CAS（每轮每个目标冲突两次就停）；结算记录 | `runtime/drifting-workspace-tool-runtime.ts` 6023、`tool-registry.ts` 2037、`drifting-write-*.ts`；生成的清单在 `docs/agent-runtime/acceptance/agent-capabilities.md` | M27、F3 | XL |
| M30 | 长任务、记忆与主动建议 | 长任务的计划、步骤、约束；Project Memory 和工作记忆；主页签到（只出卡片，什么都不写）和整理卡；「主动建议」开关；章末交给 Agent 审阅；把待办交给帮手 | `runtime/long-task-*`、`lib/agent/checkin/*`、`lib/agent/organize/*`、`docs/agent-runtime/project-checkin.md` | M29 | L |
| M31 | 帮手面板与改动显现 | 面板、对话记录、上下文指示、引导连接（ChatGPT / DeepSeek / Anthropic / OpenAI 四个格子，加三条起手请求）；Agent 写入时逐字覆盖显现，之后留下绿色（新增）或紫色（改写）墨色，指针碰到才褪去；Markdown 文件夹的外部改动显示为蓝色 | `features/agent/*` 约 3.7k、`components/editor/AgentEditAnimator.tsx` 651 等，约 2.0k；`agent-panel.css` 1396 | M27、F4d | L |
| M32 | MCP | 对外服务：89 个工具；macOS 用 Unix socket，Windows 用本机回环；一键配置 Codex、Claude Code、Antigravity。扩展客户端：stdio 和 HTTP 两种传输 | 已经是 Rust、可以复用的：`src-tauri/src/mcp_server.rs` 1872、`mcp_server/client_config.rs` 485、`mcp_stdio.rs` 860、`mcp_http.rs` 279；协议层改用 rmcp | M29 | M |
| M33 | 生图（实验） | 给要素生成立绘候选，放进本机收件箱，保留下来的导入成素材 | `src-tauri/src/codex_images.rs` 1004（Rust，可以复用）、`features/element-images/*` 约 1.1k | M28、M19 | S |
| M34 | 语音口述（未验收，可以放后面） | 在帮手的输入框里口述 | `lib/speech/*` 841（DashScope ASR） | M31 | S |

## 阶段 6：连接与发布

| # | 模块 | 内容 | 旧代码 | 依赖 | 大小 |
| --- | --- | --- | --- | --- | --- |
| M35 | 账号与登录 | 邮箱和密码、验证码登录、注册、找回密码；Google 登录（打开系统浏览器，PKCE，回调 `drifting://auth/callback`，再换取令牌）；头像、改密码、退出；按账号分库，退出后回到本机库 | `features/auth/*` 约 2.1k、`lib/auth-client.ts`；Rust 可以复用 `library_registry.rs` | F7 | M |
| M36 | Hosted 同步 v2 | 新命名空间承载 Loro 的更新批次和快照（决定 D6）；恢复；配额（500 MiB 软上限、1 GiB 硬上限）；稿纸角落的同步状态记号；每个文档记 `remote_vv`，压缩与上传无关；帮手对话的同步（每个对话一个只追加的 Loro 文档，不再是第二套同步引擎） | 旧引擎 `src/renderer/sync` 约 3.5 万行，大部分被 Loro 取代；`hosted_sync.rs` 等三个文件主要是给 WebView 的代理，只留 origin 校验、带校验的流式传输和取消（约 150 行） | F2、F3、M35 | L |
| M37 | 偏好同步 | 约 20 个键，每个键各自以最后写入为准 | `features/preference-sync/*` | M35 | S |
| M38 | 分享链接 | 发布端：发布、更新、收件箱（轮询）。阅读页：见决定 D8 | `features/share-links/*` 约 1k、`src/share-web` 2.45k、`src/shared/share-document.ts` | M35 | M |
| M39 | 反馈与崩溃上报 | 反馈对话框，可以附带脱敏的诊断信息；崩溃跟进的通知 | `features/feedback/FeedbackDialog.tsx` 168、`services/diagnostics` | F7 | S |
| M40 | Markdown 文件夹双向同步 | 章节和构想写成 Markdown 文件；外部修改合并回正文；文件夹认领（`.drifting/owner.json`）；文件头字段 | `services/markdown-mirror/*` 1.39k；Rust 可以复用 `src-tauri/src/markdown_projection.rs` 2952。旧版每 1.5 s 轮询一次，新版改用 notify 监听 | F3、F4a | M |
| M41 | 导出与搬运 | EPUB / DOCX / PDF 原稿导出；Markdown 分享；`.driftingbook` v2；整库备份；导入 docx 和 Markdown | Rust 原样复用 `src-tauri/src/manuscript_export/*` 约 4.8k（PDF 排版用 krilla、rustybuzz；DOCX、EPUB 只用 zip 手写，不需要 docx-rs、epub-builder 或 typst），只新写「Loro → `Manuscript`」的转换、`library_backup.rs` 709；TS 的 `services/export`、`services/book-transfer`、`components/modals/ImportDialog.tsx` 449 | F3、dr-text | M |
| M42 | 自动更新与旧版交接 | 检查更新（启动时检查，之后每 3 小时一次），一键安装；最后一个 Tauri 版本把更新交给 GPUI 版本 | `src-tauri/src/app_update.rs` 214、`services/update/*`、`.github/workflows/release.yml` | F7 | M |
| M43 | Windows 版 | 双架构的 NSIS 安装包；深链接注册；输入法验收（微软拼音）；字体回退 | `docs/windows.md`、`.github/workflows/windows.yml` | F7 | M |

## 不在本计划里的

- **手机端**：短期不做。分层不排斥以后接上 GPUI 的 iOS 后端（目前还是实验性的）。
- **只在旧版里有的开发设施**：前端调试桥、`perf:renderer` 的 Chromium 试验台、Vite 相关的检查，切换后连同 TS 一起删掉。它们的新版替代见 F8。
