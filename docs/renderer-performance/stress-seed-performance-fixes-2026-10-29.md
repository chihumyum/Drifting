# 重型 Seed 性能与稳定性修复记录

本轮处理[原生走查记录](stress-seed-native-findings-2026-10-29.md)中列出的七类问题。旧记录和原始 before 证据保留；本页记录修复后的行为、回归方式与剩余限制。

## 实现与边界

| 原发现 | 本轮实现 | 一致性或交互约束 |
| --- | --- | --- |
| P1 后台 Markdown 投影占用 renderer | 捕获之后的 Yjs 重建、Markdown 转换与版本哈希计算移入独立 Worker；分别标记 flush-prose、flush-assets、capture、render-worker、publish 阶段 | 仍先排空本地正文/附件写入，再在同一 SQLite 事务中捕获；Worker 只读不可变副本；全部完成后交给原生原子发布。关闭项目终止 Worker；失败显示错误，不发布部分内容 |
| P1 素材全文卡片 | 转换 Markdown 前按文档结构截取：折叠 480、展开 2,400 UTF-16 单元，同时限制节点数与深度；接近视口才解析预览；卡片限制高度 | 不截断 HTML；长笔记全文在编辑页打开。素材搜索仍匹配全文，按不可变行及正文/说明内容缓存，旧行由 WeakMap 释放 |
| P2 隐藏标签参与更新 | 稳定 surface 回调与 memo 边界；路由适配器与 NodeEditorSession 分开；节点编辑器只订阅自身节点，隐藏页不订阅情节面板开关 | 保留已开标签的 TipTap、Yjs、undo 和选区所有权，不通过卸载换取指标。关闭标签才释放编辑器 |
| P2 大规模全文搜索 DOM | 固定行高的可见窗口和 overscan；结果总数独立计算，键盘可跨窗口遍历 | 保留现有项目/代际隔离和正文投影缓存；构想使用正确图标与类型文案 |
| P2 侧栏全量 UI store 订阅 | 章节、要素、构想面板分别订阅 nodeUi 或 elementUi | 无关侧栏/时间线状态不再通过整份 UI store 触发面板更新；导航选中等相关更新仍保留 |
| P2 离线历史被 Key 门槛挡住 | 本地历史、草稿与工作记忆始终可访问；发送与继续运行仍要求可用连接；长对话初次只显示最近两个 64 消息块 | canonical 历史完整保留，可按需载入更早内容；载入时维持滚动锚点；后续追加跨块时不移除正在阅读的页。没有填写假 Key 或调用模型 |
| P2/P3 章节计数、构想序号 | SQLite 聚合增加 chapters，保留 nodes 总数；桌面卡片/列表/移除提示、移动书架、故事图使用明确章数；构想卡显示“构想” | 100 章加 200 构想仍为 300 节点，显示 100 章；不为 nullable 书序制造章节编号 |

补充修复：模型目录 Hook 在菜单关闭时停止监听目录更新、窗口焦点与联网事件。登录/退出的账户失效处理仍由 codex-subscription 负责，运行前的模型目录校验仍由 driver 负责。

素材预览的文字单位是实现上限，不改变 seed 的“字数”配方；完整正文没有被截短。Agent 的上限是初次进入时的显示量，作者主动载入更早历史或继续对话后可以增长，不是删除历史或强制截断对话。

## 验证与证据

使用隔离的 stress profile、当前源码的 Debug 二进制和 Vite/React Strict Mode。原生采集期间不同时运行本任务的构建、单元测试或 Node 基准。原生观测、浏览器行为回归与 Node CPU 诊断分别记录，不能相互替代。机器同时存在其他开发任务的测试进程，因此不是专用空闲基准机。

- [最终原生观测](acceptance/stress-seed-native-after-fixes.json)
- [重开与投影哈希校验](acceptance/stress-seed-persistence-after-fixes.json)
- [Agent 生产构建行为回归](acceptance/stress-seed-agent-after-fixes.json)
- [Node CPU/持久化诊断](acceptance/stress-seed-node-diagnostic.json)与[修复前诊断副本](acceptance/stress-seed-node-diagnostic-before-fixes.json)
- [机器汇总与来源校验](acceptance/stress-seed-fix-acceptance.json)

机器汇总由 `node scripts/check-stress-seed-fixes.mjs` 生成，`--check` 复核证据哈希和当前源码。它要求各个可见原生阶段存在、没有观测到 JS/commit 错误、25 个编辑器最终释放、Worker 投影含原生新写入且所有文件匹配 manifest、没有新的一秒看门狗 stall。它不宣称 release SLA 或全 App 验收通过。

可复现命令：

```sh
pnpm dev:worktree --instance stress-native-audit --no-watch --performance-audit
node scripts/run-renderer-performance.mjs --agent-panel --output=docs/renderer-performance/acceptance/stress-seed-agent-after-fixes.json
node --expose-gc --conditions=import --import=tsx scripts/measure-stress-seed.ts
node --expose-gc --conditions=import --import=tsx scripts/measure-stress-seed.ts --check
node --import=tsx scripts/verify-stress-native-session.ts <private-profile> docs/renderer-performance/acceptance/stress-seed-persistence-after-fixes.json --after-fixes
node scripts/check-stress-seed-fixes.mjs --check
```

原生窗口移动、可见桶过滤、二进制签名与进程归属、mark/summarize 和原始文件保留方式见[原生审计方法](stress-seed-native-audit.md)。`--after-fixes` 将看门狗记录限制到本轮 source.recordedAt 以后，不把上轮 stall 混入新结果。原始数据库、采样和完整测试 JSON 留在忽略的本地目录，提交的汇总不包含个人路径或正文。

## 本轮实测结果

以下是当前源码 Debug 会话的阶段最大值，包含可访问性读取和 Strict Mode 开销。旧记录是不同操作时序的观察对照，不是受控加速比例；大量空闲帧也会稀释 p95。

| 场景 | 帧间隔最大值 | React 渲染阶段最大值 | 观察 |
| --- | ---: | ---: | --- |
| 素材工作台、滚动和全文筛选 | 154 ms | 48 ms | DOM 峰值 3,617；旧会话约 7,450，旧 React 最大 150/158 ms；笔记末尾的新写入仍能筛选命中 |
| 搜索“修船厂”并连续键盘下移 | 66 ms | 2 ms | 仍显示 450 实体、2,352 处；DOM 峰值 1,378，旧会话约 17,704 |
| 离线进入 600 轮 Agent 历史并载入更早消息 | 89 ms | 31 ms | 不要求 Key；可按需继续载入，阶段 DOM 峰值 2,351 |
| 五万字构想保存后立即打开全书 | 303 ms | 34 ms | 当前会话没有新的一秒看门狗 stall；旧混合阶段 1,311 ms，不能将全部差异单独归因于 Worker |
| 25 个常驻编辑器下连续切换 25 次 | 100 ms | 7 ms | ChapterEditor 24 次 Fiber 渲染；本阶段 ProjectDashboard 无渲染，旧阶段分别 184/50 次 |
| 25 个编辑器下开关时间线 10 次 | 297 ms | 10 ms | ChapterPanel 仍有 20 次函数入口，父层传播仍有优化空间；收窄 store 订阅不代表面板从此零渲染 |
| 关闭全部标签 | 246 ms | 7 ms | 编辑器 DOM 25→0，总 DOM 9,989→1,232 |

本轮 WebContent RSS 峰值约 1,062 MiB。关闭标签后 RSS 仍约 938 MiB，没有随着编辑器 DOM 立即回落；这不足以确认泄漏，也不能宣称内存问题已消除。需要后续等量循环及 retained heap/physical footprint 采集。

正常退出并重开后，书架显示 100 章，故事图显示 100/100 章，构想卡显示“构想”。新写入的五万字正文可重新搜索、打开；只读检查 18 项通过，4 份 canonical Yjs 正文及词数一致，755 个投影文件哈希全部匹配，918 个文档包含新写入；SQLite 完整性及外键检查通过。旧会话创建的 TODO、批注、章节关系、要素关系、素材标题与工作记忆仍在。跨标签后聚焦正文再撤销可恢复修改；未测真实输入法 composition。

Node 五次重复的 CPU 诊断中，60 篇素材预览转换中位数由 26.56 降到 5.82 ms，五组素材全文搜索由 19.33 降到 0.682 ms。两万字全量正文替换仍约 545 ms（旧 607 ms），这是尚未解决的 CPU 开销，不能用预览改善掩盖。

全量测试 541 文件通过、2 文件跳过，3,895 项通过、5 项跳过；typecheck、脚本类型检查、CI contract、public boundary、19 项 Agent capability、stress/lite seed 完整性与 production renderer 构建通过。lint 为 0 错误、34 条既有警告。生产 React 的 Agent 定向浏览器回归 28 项通过，包括异步历史到达、按需载入与滚动锚点、跨块追加、草稿隔离、工具卡、离线禁发及 100 次挂载/卸载后监听器归零；该回归使用合成适配器，不证明真实模型或原生工具调用。

## 尚未覆盖的范围

编辑器依旧常驻，RSS 中包含 WebKit、AX 和其他 native 缓存；关闭后 DOM 数下降不能证明没有长期泄漏。尚无 retained heap graph、重绘次数、强制回流次数、真实中文输入法、多小时 soak、签名 release 的完整性能验收。单次全量正文物化仍有分配和 CPU 开销，后续应继续优化保存路径，而不是把 Worker 化理解为所有长文操作都无阻塞。

旧 before 与新 after 是同设备上的独立观察会话，界面样式和操作顺序有差异。可以比较现象、组件工作和规模；不能据此给出严格的整体加速百分比。
