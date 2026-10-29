# 2026-10-29 重型 Seed 原生 App 走查

> 后续修复及重新测量见[修复记录](stress-seed-performance-fixes-2026-10-29.md)。本文与 before JSON 保留原始观察时点。

重型 Seed 已在当前隔离 Debug App 中完成主要工作区走查，**发现一次超过一秒的 renderer 阻塞，以及素材全文卡片、多标签后台更新、全文搜索结果规模等优化点**。未出现崩溃、未处理 JS 异常或持久化校验失败。Agent 长会话正文、中文输入法、拆分布局和导入/恢复等细项仍有覆盖缺口；这份记录不是“全 App 性能验收通过”。

验收入口：默认 `pnpm dev:seed --no-watch` 使用 stress；`pnpm dev:seed:lite --no-watch` 用于快速验证功能。数据规模、字数定义及验收方法见[开发数据说明](../development-seed-workloads.md)和[完整配方](../worktree-development.md#seeded-profiles)。

## 证据与条件

- [原生观测 JSON](acceptance/stress-seed-native-audit.json)：1,246 个两秒左右的桶，937 个页面可见桶；排除隐藏/仅保有 DOM 焦点的桶和跨操作标记边界的桶后，916 个桶、328 个输入到第二次 rAF 样本。它们不是 328 次独立用户操作，单次操作可能产生多个输入事件。
- [持久化与看门狗 JSON](acceptance/stress-seed-native-persistence.json)：14 项只读断言、4 个 canonical Yjs 正文哈希、原生 stall/recovery 记录和脱敏后的栈采样信号。报告由脚本生成，没有手改测量数值。
- 采集基于 `994c866f5bc7aa420e3771c6d334569da4902649` 加可选审计插桩；采集开始的全源码 SHA-256 为 `74d72c8da53c4cfb8a41ddc6a2c680fc5437327fddf34440a0905e616f318427`。结束后重新计算确认采集期间源码没有改变。Debug 二进制哈希见 JSON。本任务之后只修订审计过滤、汇总、校验及文档，没有改业务性能实现。收尾同步了 main 的字体/面板样式更新 `5c046a59`，没有对该样式版本重新做原生性能采集；上述结果仍仅对应已记录的测量版本。
- Apple M3 Pro，12 个逻辑 CPU，36 GiB 内存。使用 `dev:worktree --no-watch --performance-audit` 的隔离配置、数据库、端口和 freshly built Debug 二进制；为原生自动化识别打成并签署同一二进制的 `.app`。没有使用旧安装包，没有进行 release 构建性能测量。
- Vite、React development/Strict Mode 和可选 Profiler 均开启。没有同时运行本任务的构建/测试，但机器还有其他应用和活动 WebContent 进程；不是专用空闲基准机。频繁的可访问树读取、截图和原生采样也会扰动耗时及内存，尤其长正文的 AX 暴露。
- 最初窗口位于另一显示器，DOM 有焦点而页面报告隐藏，帧回调不运行。通过原生 Window 菜单移到内建屏幕后恢复；这部分隐藏数据不计入交互结论。最终探针也移除了焦点兜底，严格要求页面可见。

下表是混合操作阶段内、合格桶的观测最大值。不是单次动作的专用计时，也不是 release SLA；p95、数量、CPU/RSS 和组件详情以 JSON 为准。输入指标从事件分发开始，到第二次 rAF 回调结束，包含编辑/查找/导航事件，不是 INP、键入延迟或合成器实际呈现时间。

| 阶段 | 帧回调间隔最大值 | 输入至第二次 rAF 最大值 | React Profiler 渲染阶段最大值 |
| --- | ---: | ---: | ---: |
| 两万字章节写作、撤销重做和情节规划 | 102 ms | 74 ms | 18 ms |
| 素材工作台、全文筛选、标题编辑 | 350 ms | 79 ms | 150 ms |
| 故事图、构想抽屉、章节关系 | 180 ms | 133 ms | 35 ms |
| 要素全景、聚焦/章节带、滚动拖动 | 121 ms | 78 ms | 10 ms |
| 连续打开 20 个章节标签 | 302 ms | 140 ms | 23 ms |
| 25 次循环切换、覆盖 20 个标签 | 78 ms | 92 ms | 23 ms |
| 全局搜索及结果跳转 | 342 ms | 113 ms | 48 ms |
| 五万字构想查找/保存后打开全书，混合阶段 | 1,311 ms | 1,449 ms | 42 ms |
| 素材正文、工作台重开、PDF，混合阶段 | 970 ms | 978 ms | 158 ms |
| 清空标签后单独复测五万字查找，6 个查询 | 142 ms | 146 ms | 20 ms |
| 清空标签后再次打开全书并滚动 | 130 ms | 118 ms | 27 ms |

多数阶段的帧间隔 p95 为 18–19 ms；连续开标签为 30 ms、热切换为 24 ms。大量空闲帧会稀释 p95，因此不能用这个数掩盖尾部停顿。WebKit 未提供 `longtask` 类型，报告中的空桶代表不支持该接口。

## 优先处理的发现

### P1：编辑后的后台 Markdown 投影与一次主线程阻塞重叠

12:29:26–28，从已编辑的五万字构想切到通览全书时，看门狗检测到 1,354 ms 心跳静默，恢复记录静默 1,419 ms、`blocked: renderer`、renderer 定时器迟到 1,168 ms。同一时间 `markdown-projection` 活动持续到 1,482 ms；独立审计记录了 1,311 ms 帧间隔和 1,449 ms 输入至第二次 rAF。这是实际原生 renderer 停顿，不能仅解释成 IPC 慢。

[投影服务](../../src/renderer/services/markdown-projection.service.ts) 在 authored change 后合并请求，读取项目关系与正文，再构建整份 Markdown 条目；只在输入法 composition 时暂缓。当前合并和异步调用没有把同步正文转换移出 renderer。原生三秒栈采样含 JSON、GC 和 layout 活动，但从检测后开始，跨越恢复，且没有可识别的 JS 函数名；它不足以把整个停顿归给投影，也不能得出“强制回流占多少”的结论。

建议先给 source read、canonical materialization、条目构建/序列化和 native write 分别插桩；验证只刷新变更文档、按 revision 复用、分批让出主线程或 Worker 化。必须保留一致性、只读投影和失败恢复边界。单独重开全书的后续阶段最大帧间隔为 130 ms，六次长文查找阶段为 142 ms，说明首次混合停顿不能笼统写成“查找每次卡一秒”。

### P1：素材卡片挂载全文，“折叠”没有限制生成量

素材工作台首次进入阶段 React 渲染最大 150 ms，重开阶段达到 158 ms；`NoteExcerpt` 的 Fiber 自身渲染累计分别为 104/109 ms，属于各阶段累计，不能当作单次函数耗时。60 篇笔记共 50 万字，默认工作台截图中几张卡片的长正文一直延伸到屏幕下方，后面的素材需要很长滚动才能找到。一个被筛选出来的一万字笔记仍暴露全文。

[NoteExcerpt](../../src/renderer/features/library/NoteExcerpt.tsx) 对完整笔记执行 `noteToMarkdown`、`marked.parse`，再 `dangerouslySetInnerHTML`。源码生成 `note-excerpt--clamped` 类，但当前 renderer 没有对应的样式定义。即使补回 CSS 裁切，也不会减少全文解析、HTML 或 DOM。该阶段最多约 7,450 个 DOM 元素；[素材全文匹配](../../src/renderer/features/library/library-item-search.ts) 还会对每个非空查询重新提取正文。

建议折叠卡片使用有结构边界的短摘要，只在打开时加载全文，并给可搜索文本按 revision 建缓存。大列表采用窗口化；既处理长卡片的使用问题，也减少主线程分配。不要直接截断 HTML。

### P2：每个打开标签常驻编辑器，隐藏页仍参与更新

最多同时打开 25 个标签，采样也观察到 25 个 `.ProseMirror`。[EditorMainArea](../../src/renderer/components/editor/EditorMainArea.tsx) 明确按打开标签常驻 surface，仅改变 `visibility`。20 标签的 25 次切换期间，Fiber 记录 `NodeEditorView` 769 次、`ChapterEditor` 184 次、`ProjectDashboard` 50 次渲染；节点自身通常较轻，但总工作明显超过当前可见页面的需求。开发 Strict Mode 和 Fiber 元数据会影响数量，不能把它当成生产提交次数。

混合操作中 owned WebContent RSS 峰值为 1,535,312 KiB（约 1,499 MiB），native 峰值约 431 MiB，两个峰值不一定同时发生。RSS 包括 WebKit/native/可访问性缓存，不能称为 JS 堆或泄漏量。逐个关闭 25 个标签后编辑器确实降到 0、DOM 到 963，随后重新打开也能恢复保存的内容；未证明有永久泄漏。看门狗只采样本实例的进程。

建议先让隐藏页停止大纲、统计、布局测量与非必要 store 更新，同时保持当前 continuity 语义；再评估有上限的热编辑器缓存。卸载必须先完成 Yjs 本地持久化，并验证 undo/selection、切换空帧和恢复行为。需要同配置的多轮等量开关与 heap/physical footprint 对比，才能判断长期保留问题。

### P2：全局搜索一次挂载大量命中

搜索“修船厂”显示 450 个实体、2,352 处命中，DOM 最高约 17,704 个元素，该阶段帧间隔最大 342 ms、定时器迟到 209 ms，`GlobalSearchSession` 单次自身渲染最大 27 ms。缩小为唯一标题后可以正常跳转。搜索结果还把构想标为“章节”，与章节数量问题属于同一语义边界。

建议实体组/命中行窗口化或有界分页，区分总命中计数与当前渲染数量；正文索引按 revision 复用。需要继续拆分搜索计算、列表构建、DOM/layout 的耗时，当前证据不能把 342 ms 都归为 React。

### P2：侧栏全量 store 订阅放大无关更新

开启章节侧栏后，切换底部时间线 10 次的阶段记录到 `ChapterPanel` 30 次函数入口、15 次 Fiber 渲染；包括打开/关闭面板本身，不能将其精确归成“每次切换三次”。连续打开 20 标签的阶段记录到 250 次函数入口。结合先前 Node 检查中 10 次无关变化导致 10 次 whole-store 通知、相关切片引用均未变，可以确认收窄订阅有优化价值。

[ChapterPanel](../../src/renderer/components/leftBars/ChapterPanel.tsx)、[ElementPanel](../../src/renderer/components/leftBars/ElementPanel.tsx)、[DriftPanel](../../src/renderer/components/leftBars/DriftPanel.tsx) 仍使用 `useUiStore()` 后再解构。先改 selector，再比较相同操作的渲染数量与总耗时；没有证据支持全局堆叠 `memo`。

### P2：未配置 Key 时，本地 Agent 正文历史也被挡住

Agent 右侧栏只显示“Agent 未连接”和配置入口，但工作记忆可以创建并保存；设置的历史管理列表能列出 seed 的 24 个会话和开发 CLI 会话。[DesktopAgentPanel](../../src/renderer/features/agent/desktop/DesktopAgentPanel.tsx) 在 `!usable` 时提前返回，历史按钮和 transcript 都在之后。

建议把本地历史浏览、草稿和发送能力分开判定，离线仍可阅读 canonical 历史，仅禁用发送。没有为了测试填写假 Key 或调用付费模型。600 轮历史的恢复/投影已有[独立 Node 证据](acceptance/stress-seed-node-diagnostic.json)，**本次没有完成其原生打开、滚动、工具卡展开或内存验收**。

### P2/P3：章节计数和构想序号显示错误

原生书架再次确认显示“300 章”，实际为 100 章加 200 构想；故事图头部也显示 `100/300 章`。项目主页的“100 章”和正文 150 万字正确。[project-stats-repo](../../src/renderer/sqlite-repo/project-stats-repo.ts) 统计所有节点，[故事图](../../src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx) 使用 `bookNodes.length`。应提供明确的 chapter 计数，保留总节点语义。

构想抽屉出现 `§NULL`。[StoryGraphDriftCards](../../src/renderer/features/graph/StoryGraphDriftCards.tsx) 和 [SuperElementDriftCards](../../src/renderer/features/graph/SuperElementDriftCards.tsx) 将 nullable `bookOrder` 直接字符串化；构想没有书序是有效数据，不应为了展示而给它伪造章节序号。

## 实际覆盖与持久化

| 入口 | 已做的正常操作 | 结果/限制 |
| --- | --- | --- |
| 书架、项目主页 | 打开项目；概览、结构与设定、项目设置；正常退出后再次进入 | 可进入；书架章数错误 |
| 左右侧栏 | 章节/要素/构想索引、16 类折叠；Review、素材、统计、Agent；开关面板、10 次时间线开关 | 导航正常；大型 AX 树会截断，已用截图区分控件消失与观察通道限制 |
| 写作 | 两万字章、五万字构想、一万字要素和一万字素材笔记；输入/粘贴、撤销重做、查找、情节格编辑、Cmd+S | 四个 canonical 正文标记通过；中文输入使用粘贴，未测 IME composition |
| 多标签 | 20 个章节标签；25 次循环切换；加入构想/全书/笔记/PDF/要素后共 25 个标签；逐个关闭 | 编辑器数从 25 降到 0；未做拖拽拆分的持久化验收 |
| 关系与 Review | 新建 TODO、批注并关联人物；图中新增关系类型和章节边；要素之间新增呼应 | 重启后 Review、章节目标、额外人物关系、章节边、要素边均通过只读断言；未完整覆盖回复、解决/重开及移除 |
| 素材 | 全文筛选、长笔记标题和正文编辑、图片预览、PDF 加载/缩放 | 图片和 PDF 都在 App 内加载成功；共用小文件不代表大 PDF/解码压力；未做系统外部打开/文件夹移动 |
| 三个 Super View | 故事图书序/叙事时、200 构想展开、节点选取和创建关系；要素聚焦/粘带、滚动/拖动；素材搜索/编辑 | 可导航返回；种子 100 章均无叙事时间位置，因此空叙事时视图不是图丢数据；拖动还会选中文字，未确认为画布平移验收 |
| 全书、搜索 | 全书打开和滚动；全局大命中搜索/唯一标题跳转；长文内六个查询与连续跳转 | 热路径复测没有再次超过一秒；首次混合操作捕获 stall |
| 设置 | 回收站空态；外观、编辑器、语言、模型/API、Copilot、General Agent 历史管理列表 | 可进入并滚动；没有执行更新、导入、清空历史、连接模型或扩展权限 |
| Agent | 未连接状态、工作记忆创建/保存；设置中的历史元数据列表 | 长会话正文仍被 Key 门槛挡住 |
| 重启 | Cmd+Q 正常退出，同一 App/数据库重开；搜索打开五万字构想；其余通过数据库重建复核 | 四个标记及词数、素材标题、工作记忆和关系均持久；`integrity_check=ok`，无外键错误 |

写入后的观测词数为：章节 20,041、构想 50,021、要素 10,020、素材笔记 10,018。这是独立测试实例的修改，配方字数预算没有改变。canonical Yjs 为正文依据，chapter/构想的缓存词数与重建值一致。没有把截图或 `contentJson` 单独当作保存成功。

## 后续验证顺序

1. 拆分 Markdown 投影阶段，复现“长文写入后立刻切到全书/其他标签”，再改增量投影或任务调度。
2. 为素材折叠卡片提供短摘要，结果列表做窗口化；比较首次进入、全文筛选、恢复后 DOM 和内存。
3. 收窄 store selector、暂停隐藏编辑器的非必要工作；再决定缓存上限及 memo 边界。
4. 放开离线本地历史浏览后，在同一重型配方中补测 600 轮 transcript、工具卡和会话循环；补齐 IME、拆分、回复/解决/恢复等剩余操作。

当前记录没有测得 repaint 次数、forced layout 次数、合成器帧率或 JS heap retained graph。原生栈中有 layout/GC 并不等于已定位“回流太多”或“内存泄漏”。优化后应以同设备/同构建/同配方的 before/after 结果验收，不用本次 Debug 数值承诺 release 表现。

## 本次代码校验

CI contract、public boundary、typecheck、Agent capability（19 项）及 stress/lite seed 完整性检查通过。lint 为 0 错误，保留既有 34 条警告。全量以 2 个 worker 运行：539 个文件通过、2 个跳过，3,884 项测试通过、5 项跳过。最初与其他检查并行的默认全量运行中，一个 1,000 次 JSON 分片用例达到 20 秒超时；停止竞争后该文件的 40 项测试约 5 秒通过，低并发全量也全部通过，没有为此放宽测试超时。

审计插桩增加了冻结 Tauri bridge、与已有 React hook 共存、root Profiler、函数调用计数、隐藏但有焦点的页面、跨操作边界排除等回归检查。插桩为显式 opt-in，普通开发和产品构建不启用。
