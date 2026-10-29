# 2026-10-29 重型 Seed Node/领域诊断

本页记录独立 Node/领域诊断。解锁后已经完成[原生主要工作区走查](stress-seed-native-findings-2026-10-29.md)，包括看门狗确认的 renderer 阻塞、素材卡片/搜索/多标签观察，以及尚未覆盖的 Agent transcript、IME 等细项。下面的 Node 时长不能换算成原生输入延迟或 FPS。

机器证据：[Node 诊断 JSON](acceptance/stress-seed-node-diagnostic.json)、[原生观测](acceptance/stress-seed-native-audit.json)、[原生写入的重启回查](acceptance/stress-seed-native-persistence.json)。Node JSON 已在最终业务源码上重新生成；原生数据保留其采集时的独立源码身份，两个层级没有混用。

## 样本与方法

从本任务的隔离重型实例创建 SQLite backup，所有本页写入在副本发生。配方为 100 章/150 万字、300 要素/50 万字、200 构想/100 万字、60 篇笔记/50 万字。备份还包含本次原生走查留下的少量合成修改。最长 Agent 历史为 600 轮/2,600 显示块；当前库有 24 段 seed 会话加 1 段开发 CLI 会话，因此用量统计实际覆盖 25 段。

Apple M3 Pro、12 个逻辑 CPU、36 GiB 内存，Node 24.19.0/SQLite 3.53.3。最终刷新没有同时运行本任务的构建/测试；其他应用仍有活动。时长是诊断观测，不是 release 门槛，也不作为此前记录的同条件性能对比。

调用实际产品仓库、Markdown、canonical recovery、Yjs 和 authored-write 路径。每个具名时长通常重复 5 次，Agent 恢复循环 20 次；Yjs 进行 5 轮最长 20 文档加载/销毁/GC。Node 不挂载 React、DOM 或原生编辑器，不经过 Tauri IPC。堆增长只是操作前后的差值，不是峰值或泄漏量；2 ms 定时器迟到只反映 Node 事件循环。

| 操作 | 中位数 | 最大值 | 最大观测堆增长 |
| --- | ---: | ---: | ---: |
| 25 个会话的用量统计 | 122.6 ms | 134.8 ms | 28.2 MiB |
| 600 轮历史的恢复及显示投影 | 160.6 ms | 223.7 ms | 74.3 MiB |
| 完整替换 API 只改变两万字中的一个字 | 607.2 ms | 684.3 ms | 70.3 MiB |
| 60 篇笔记全文转 Markdown/HTML | 26.6 ms | 32.9 ms | 11.5 MiB |
| 连续 5 个素材正文查询合计 | 19.3 ms | 30.5 ms | 22.3 MiB |
| 完整工作区投影读取 | 37.6 ms | 45.8 ms | 15.1 MiB |
| 有覆盖记录、无变化的工作区读取 | 3.5 ms | 4.3 ms | 1.2 MiB |

## 热点与实现方向

### Agent 用量统计与历史恢复

[usageByProject](../../src/renderer/sqlite-repo/agent-conversation-repo.ts) 读取各会话完整 `messagesJson` 并解析 usage。相比精简列表中位数 7.5 ms，全量用量统计为 122.6 ms。建议以 canonical usage 为依据维护可重建的累计投影，按窗口统计时也避免反复传输和解析整段聊天。

[loadCanonicalAgentChatProjection](../../src/renderer/lib/agent/runtime/recovered-transcript.ts) 读取 recovery snapshot、严格校验，再重建显示消息。完整路径中位数 160.6 ms，单次观测堆增长约 74.3 MiB；snapshot 读取/解码本身中位数 104.3 ms。这些嵌套路径不能简单相加。应先检查能否按完整 revision 身份复用验证/显示结果，必要时评估 Worker，但必须保留损坏检测和 fail-closed 行为。

原生 Agent 面板在未配置 Key 时提前返回，本轮尚未完成 600 轮 transcript 的滚动和工具卡操作。这些 Node 值不是 React/Markdown DOM 的成本。

### 完整正文替换及工作区重复读取

同一诊断章节连续 5 次两万字完整替换，中位数 483.4 ms；随后通过相同完整替换 API 只改变一个字，中位数仍为 607.2 ms。此路径包含 CLI 工作区准备、read-before-rewrite、收据、正文处理及持久化，不能称为“原生键入一个字”的延迟。

独立 profile 的该次写入包含 74 次查询、2,882 行、约 10.2 MiB 原始值；`yjs_snapshots` 和 `yjs_updates` 各读 8 次，合计约 4.5 MiB。计数不能证明这 8 次针对同一文档，原始值字节也不等于 IPC 字节。profile 另见 JSON 的 `profiles.wholeBodyWrite`。

建议拆分准备/读取、Yjs 编解码、diff 和写入，确认重复上下文读取后再考虑稳定快照复用或增量修改。原生走查发现 Markdown 投影与一次主线程停顿重叠，应独立分析，不能把两个层级的耗时相加。

### 素材全文转换/搜索

[NoteExcerpt](../../src/renderer/features/library/NoteExcerpt.tsx) 挂载完整笔记 HTML；60 篇得到 581,913 个 HTML 字符、3,584 个开始标签，转换中位数 26.6 ms。[libraryItemMatchesQuery](../../src/renderer/features/library/library-item-search.ts) 对非空查询重新提取并小写化正文；表中搜索时长是五个查询合计。

原生后续还发现 `note-excerpt--clamped` 没有对应样式定义。即使恢复视觉裁切，也不会减少生成及挂载的全文。建议使用有结构边界的短摘要、按 revision 缓存搜索文本，并让完整内容在打开时加载。

### 左侧面板订阅范围

[ChapterPanel](../../src/renderer/components/leftBars/ChapterPanel.tsx)、[ElementPanel](../../src/renderer/components/leftBars/ElementPanel.tsx)、[DriftPanel](../../src/renderer/components/leftBars/DriftPanel.tsx) 调用 `useUiStore()` 后才解构相关字段。10 次无关状态切换产生 10 次 whole-store 通知，`nodeUi` 和 `elementUi` 引用变化均为 0。原生渲染计数也已补充在后续记录中。

先收窄 selector，再用同一 UI 操作比较；不能仅凭源代码判断是否要加 memo。

## 稳定性与正确性

- 20 次最长 Agent 严格恢复均得到 2,600 个显示块。循环前后 GC 堆约从 89.7 MiB 到 89.8 MiB。
- 5 轮最长 20 文档、每轮 430,062 字；销毁并 GC 后的堆约 89.6–89.7 MiB，没有按整组文档大小持续增长。这不能证明 React 编辑器或 native 资源无泄漏。
- 正常 authored 路径创建 5 条 TODO，创建诊断章节、多次写入两万字、增加要素到章节的关系。canonical Yjs 与缓存字数一致，SQLite 关闭/重开后仍一致。
- `integrity_check=ok`，外键检查无错误；未调用模型服务。
- 书架实际显示 300 章，而实际为 100 章加 200 构想。`readProjectStats` 的总节点计数被当成章节数展示，已由原生再次确认。

## 重新生成与校验

先保留独立重型实例：

```bash
pnpm dev:seed --instance stress-native-audit --no-watch --performance-audit
```

结束 UI 采样后再单独运行：

```bash
node --expose-gc --conditions=import --import=tsx scripts/measure-stress-seed.ts
node --conditions=import --import=tsx scripts/measure-stress-seed.ts --check
```

生成器从实例备份到忽略目录，保留原始 profile，并重新生成机器 JSON；`--check` 校验源码指纹、规模、重复样本和领域断言，不以耗时作为统一门槛。改变数据或代码后必须重新生成，文字表格也应跟随最新 JSON。
