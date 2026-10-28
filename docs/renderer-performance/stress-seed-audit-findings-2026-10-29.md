# 2026-10-29 重型 Seed 诊断记录

本轮完成了真实重型 SQLite 副本上的 CPU、内存趋势、Yjs、Agent 恢复和持久化诊断。**原生 App 主界面全覆盖操作验收仍未完成**：macOS 持续锁定，Computer Use 无法访问原生应用；浏览器备用路径进入了实际 Drifting 书架，随后控制通道超时。以下结论按证据层级区分，不能作为原生响应时间、FPS、绘制、回流或整机内存验收通过的依据。

机器证据：[Node 诊断 JSON](acceptance/stress-seed-node-diagnostic.json)；[原生观测状态](acceptance/stress-seed-native-audit.json)。原生剩余操作见[完整走查清单](stress-seed-native-audit.md#native-coverage-to-complete)。

本轮独立采样的部分结果概览如下，精确值与每次样本以 JSON 为准。堆增长是操作前后的观测差值，不等于峰值或泄漏量；时长均为 Node 层诊断值。

| 操作 | 中位数 | 最大值 | 最大堆增长 |
| --- | ---: | ---: | ---: |
| 24 个会话的用量统计 | 约 80 ms | 约 80 ms | 约 28 MiB |
| 600 轮历史的完整恢复与显示投影 | 约 100 ms | 约 115 ms | 约 75 MiB |
| 完整替换 API 修改两万字正文中的一个字 | 约 510 ms | 约 520 ms | 约 71 MiB |
| 60 篇笔记全文转 Markdown／HTML | 约 20 ms | 约 26 ms | 约 11 MiB |
| 素材正文搜索，连续 5 个查询合计 | 约 13 ms | 约 14 ms | 约 22 MiB |
| 完整工作区投影读取 | 约 28 ms | 约 34 ms | 约 15 MiB |
| 有覆盖记录、无变化的工作区投影读取 | 约 1–2 ms | 约 2 ms | 约 1 MiB |

## 测试对象与方法

- 使用默认重型配方：100 章／150 万字，300 要素／50 万字，200 构想／100 万字，60 篇素材笔记／50 万字，24 段 Agent 对话／1,800 轮；最长对话为 600 轮、2,600 个显示块。
- 从本任务独立重型实例做 SQLite backup，所有领域写入发生在新的诊断副本。原始重型实例和日常资料库均不承担这些测试写入。
- Apple M3 Pro、12 个逻辑 CPU、36 GiB 内存，Node 24.19.0／SQLite 3.53.3。机器同时存在其他活动，时长作为诊断值使用。
- 每项时长通常重复 5 次；Agent 关闭／重新恢复循环 20 次；Yjs 每轮加载并销毁 20 个最长文档，共 5 轮，每轮合计 43 万字。GC 前后观察使用 `--expose-gc`。
- 测量调用实际产品仓库、投影、恢复、Markdown 和 authored-write 实现。Node 传输不包含 Tauri IPC；未挂载 React、DOM 或真实编辑器。两毫秒定时器迟到反映 Node 事件循环阻塞，不能换算成 App 输入延迟。
- CPU profile 是单独一轮，原始文件留在忽略目录；JSON 只保留无个人路径的函数采样摘要。短 profile 用于定位线索，不提供稳定的函数耗时占比。

## 发现与建议顺序

### 1. Agent 用量统计会读取并解析全部对话正文

证据级别：已测得的 Node 同步热点，原生卡顿待确认。建议优先验证。

[usageByProject](../../src/renderer/sqlite-repo/agent-conversation-repo.ts#L145) 为每个会话读取 `messagesJson`，逐个解析显示历史，再筛选 `usage`。设置页的 [AgentSettingsPanel](../../src/renderer/features/settings/panels/AgentSettingsPanel.tsx#L122) 使用这条路径。重型项目包含 24 个会话；相比约 5 ms 的精简会话列表，用量汇总约为 80 ms，且观察到约 28 MiB 堆增长和接近 80 ms 的 Node 定时器迟到。

建议把累计用量作为可重建的投影，在正常提交事务中更新，并以 canonical usage 为依据；按时间窗口的统计也应避免传输／解析整段聊天文本。先用原生设置页打开／切换统计周期复测，再确定实现和预算。

### 2. 600 轮对话恢复与显示投影有明显分配压力

证据级别：已测得的 Node CPU／内存热点，React 和原生成本未测。

实际 [loadCanonicalAgentChatProjection](../../src/renderer/lib/agent/runtime/recovered-transcript.ts#L93) 会加载 recovery snapshot，严格验证 canonical 历史，再从事件重建显示消息。最长对话的完整显示投影约 100 ms，单次观测到约 75 MiB 堆增长；仅 snapshot 读取／解码就约 56 ms。数值包含在各自完整路径内，不能将表中的阶段简单相加。

显示层 [DesktopAgentTranscript](../../src/renderer/features/agent/desktop/DesktopAgentTranscript.tsx#L101) 还会挂载所有消息块。已有 memo 能减少历史消息更新成本，首次挂载的 Markdown／DOM 成本仍需要实测。

建议先确认快照、显示投影和会话缓存是否可以按完整 revision 身份复用，避免重复恢复和大对象复制。纯验证／投影可评估 Worker；必须保留损坏检测、checkpoint 验证和恢复失败时停止打开的行为。原生长历史的首次打开、滚动、工具卡展开和退出后保留量是下一批重点。

### 3. 两万字完整正文替换路径成本偏高

证据级别：已测得的开发 CLI／authored-write 路径；不代表键盘输入速度。

在同一个诊断章节上连续执行 5 次两万字完整替换，耗时从约 270 ms 增长到约 520 ms。随后通过相同完整替换 API 只改变正文中的一个字，耗时仍约 510 ms。期间重新读取 canonical Yjs，确认字数为 20,000，缓存字数相同，关闭数据库后回读仍一致。

该路径包含开发 CLI 的完整工作区准备、自动 read-before-rewrite、持久化收据、正文处理与写入，不等同于已经加载的原生编辑器打一个字。它提示应分别检查工作区重复读取、历史更新累计、Yjs 解码／物化及正文差异计算，避免把总耗时直接归因于输入法或 React。

机器证据保留了该写入的独立 CPU profile 和查询计数。应先在原生 Agent／正文替换入口复现，再选择增量修改、稳定上下文复用或适当的 Yjs 压缩方案。原生完整替换与普通键入需要分别设立预算。

独立 profile 的该次写入包含 74 次查询、2,872 行结果、约 10.2 MiB 原始值：其中 `yjs_snapshots` 和 `yjs_updates` 各读取 8 次，合计约 4.5 MiB；完整要素与素材笔记读取也占据较大部分。采样中出现 Yjs 编解码、SQLite 查询和 GC 工作。计数包含 CLI 的上下文准备，原始值字节不等于 Tauri IPC 字节。表级计数没有证明这些读取针对相同文档，也没有单独证明某一步就是全部耗时的原因。

### 4. 三个左侧面板订阅整个 UI store

证据级别：代码与实际 store 通知验证；React 提交次数未测。

[ChapterPanel](../../src/renderer/components/leftBars/ChapterPanel.tsx#L79)、[ElementPanel](../../src/renderer/components/leftBars/ElementPanel.tsx#L74)、[DriftPanel](../../src/renderer/components/leftBars/DriftPanel.tsx#L93) 使用 `useUiStore()`，之后才解构 `nodeUi`／`elementUi`。对右侧栏拖拽状态做 10 次切换，整个 store 的订阅收到 10 次更新，而两个目标切片的引用变化均为 0。

建议先改成针对切片的 selector，再在原生多面板／多标签场景比较 React commit 和组件渲染计数。此处首先是订阅范围问题；是否还需要对子组件 memo，应由实际提交数据决定。

### 5. 素材卡片和搜索会处理完整正文

证据级别：已测得的数据转换／分配成本；原生 DOM 与布局未测。

[NoteExcerpt](../../src/renderer/features/library/NoteExcerpt.tsx#L25) 即使最终通过 CSS 折叠，也先把完整笔记转为 Markdown／HTML，再挂载全文。60 篇笔记得到约 58 万字符 HTML、3,583 个开始标签；转换本身约 20 ms，观察到约 11 MiB 堆增长。CSS 折叠没有限制生成和挂载的数据量。

[libraryItemMatchesQuery](../../src/renderer/features/library/library-item-search.ts#L10) 对非空搜索重新解析并小写化笔记正文。5 个递增／无匹配查询合计约 14 ms，观测到约 22 MiB 堆增长；这不是“每敲一个字 14 ms”。

建议为折叠卡片生成有界摘要，在展开／编辑时加载完整内容；搜索文本按正文 revision 缓存。原生素材 Super View 的首次打开、输入搜索和频繁切换是验证重点。实现摘要时需保留 Markdown 结构和安全转义，不能直接截断 HTML 字符串。

### 6. 书架把构想数量显示为章节数

证据级别：浏览器实际界面观察与产品查询结果相互印证。属于明确的显示正确性问题。

备用浏览器路径在书架显示“1500.0k 字 300 章 3 线 300 要素”。实际数据为 100 个 `chapter` 和 200 个 `drift`；[readProjectStats](../../src/renderer/sqlite-repo/project-stats-repo.ts#L35) 的 `nodes: count()` 统计全部未删除节点，[项目卡片](../../src/renderer/views/ProjectPickerView.tsx#L763) 把这个数标作“章”。

建议新增独立章节计数或修正展示语义。不要直接全局改变 `stats.nodes` 的含义，因为其他逻辑可能确实需要全部节点数量。字数 150 万的统计是正确的。

## 稳定性检查结果

以下检查已通过，全部发生在诊断副本／Node 层：

- 20 次最长 Agent 历史恢复，均得到 2,600 个显示块，并通过严格 canonical 验证。
- 5 轮最长 20 文档加载、销毁、让出事件循环并 GC。热身后未观察到按文档组大小持续累积的堆保留量；Agent 循环后的堆也维持在相近水平。原始数值见 JSON 的 `retention` 和 `agentRetention`。这不能证明 React 编辑器、DOM、监听器或 native 资源不存在泄漏。
- 通过正常 authored 工具新增 5 条 TODO，创建诊断章节并多次写入两万字正文，新增要素→章节关系。
- canonical Yjs 重建字数与缓存字数一致；关闭并重新打开 SQLite 后，正文计数、TODO 数量和关系端点仍存在。
- `PRAGMA integrity_check` 为 `ok`，`PRAGMA foreign_key_check` 无错误。没有调用模型服务或产生模型费用。

这轮没有建立“主线程无阻塞”“无重绘／回流问题”“全 App 无内存泄漏”的结论。侧栏动画的 `getBoundingClientRect`／CSS 写入、三个 Super View 的平移缩放、20 个真实编辑器标签、素材预览和 IME 仍需解锁后的原生采样。

## 覆盖状态

| 层级／操作 | 状态 |
| --- | --- |
| 当前代码的隔离 Debug 原生实例＋重型 Seed | 已构建启动；桌面锁定，0 个原生用户交互样本 |
| 实际产品浏览器书架 | 已进入并核验重型统计；随后控制通道出现 `Page.navigate`／焦点仿真超时，故障归因未确认 |
| 数据投影、素材转换与搜索、Agent 列表／用量／恢复 | 已按实际重型数据重复测量 |
| 领域写作、关系、TODO、关闭后回读 | 通过正常 authored 路径完成；属于程序化领域检查 |
| 真实键入／IME、多标签、侧栏／Super View、PDF／图片、所有设置页 | 未完成原生操作验收 |
| 布局、绘制、合成呈现、真实 App 常驻内存 | 未测；不由 Node 时长或 GC 结果推断 |

## 复现与证据校验

先在当前 checkout 创建名为 `stress-native-audit` 的重型实例；已有实例会保留：

```bash
pnpm dev:seed --instance stress-native-audit --no-watch --performance-audit
```

测试过程应避开其他构建任务。在另一个终端执行：

```bash
node --expose-gc --conditions=import --import=tsx scripts/measure-stress-seed.ts
node --conditions=import --import=tsx scripts/measure-stress-seed.ts --check
```

第一条命令从独立实例做新的 SQLite backup，保留临时副本和原始 profile 到忽略目录，重新生成机器 JSON。第二条只校验源码指纹、样本完整性、核心数据规模和领域检查，不把时长当成统一性能门槛。若要重新生成这份文字分析，应同时核对最新 JSON，避免沿用旧数值。

本轮没有修改业务实现，以上建议保留给后续有原生 before／after 证据的优化变更。

代码校验：全量 3,881 个测试通过、5 个跳过；CI contract、public boundary、typecheck、Agent capability 检查通过；lint 无错误，保留既有 34 条警告。诊断脚本另经包含它的严格 TypeScript 检查，最终机器证据通过 `--check`；重型／轻量 Seed 原有完整性证据仍匹配源码。
