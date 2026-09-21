# CI、剧情规划面板与资源释放复核

2026-09-21，按维护者授权完成三项后续工作。只执行无头浏览器、代码检查与生产构建，
模拟器、原生窗口和真机验收继续由维护者完成。

## CI 浏览器启动与退出

上一次 `d1b854ce` 的 renderer CI 报告为 Chromium 调试端口启动超时，随后清理流程
一直等待到任务超时。原脚本丢弃了浏览器 stderr，无法据此确认原启动失败的具体原因。

- Ubuntu 24.04 的 renderer 任务显式使用 `/usr/bin/google-chrome`，启动前输出版本。
- 共用启动器保留有长度上限的 stderr、可执行文件名和退出信号；临时 profile 路径脱敏。
- 进程通过信号退出时同时检查 `signalCode`，先订阅退出事件再发送信号；
  SIGTERM 超时后升级 SIGKILL。CDP、浏览器和预览服务器分别限时清理，单项失败不跳过后续清理。
- CDP 连接、页面载入和组合场景有明确超时。失败报告保留为 CI artifact。
- 六项 Node 回归覆盖已退出进程、忽略 SIGTERM 的真实子进程、启动失败诊断、缺失可执行文件、
  异步阶段超时和清理失败后的继续释放。

## 剧情规划面板

`NodeEditorView` 的 `PlotPlannerDock` 和相邻 `editor-body` 曾同时使用章节 ID 作为 key。
切章时 React 的兄弟节点匹配可能留下旧面板。现在面板使用 `plot-planner:${nodeId}`，
保持每章独立实例，同时避免与正文容器冲突。

无头生产构建从真实 `NodeEditorView.tsx` 读取 key 表达式，放入受控兄弟节点场景，
挂载真实 `PlotPlannerDock`/`PlotGridEditor`。旧 key 反例必须先触发
`Planner orphan DOM after chapter switch`；修复版本检查每次只保留一个面板、关闭后清空、
待保存行变更恰好写入原章节一次，以及拖动中切章/关闭后的监听器释放。
这不是完整 `NodeEditorView` 与数据库集成验收。

## 资源释放压力检查

命令：`pnpm perf:renderer:lifecycle`。默认输出至忽略目录；本次生成证据为
[lifecycle-followup.json](acceptance/lifecycle-followup.json)。CI 每次从当前源码重跑，并保留报告。

每类预热 10 轮，再执行 100 轮：

| 场景 | 实际执行的责任边界 |
| --- | --- |
| 剧情规划 | 切章、增行、关闭、拖动途中卸载、待保存变更归属 |
| 编辑器标签 | 两个真实 Tiptap 实例、`useEntityEditorSession`、可见/隐藏切换与编辑、卸载 flush、活动编辑器清空、关闭标签后的选择记忆裁剪 |
| Agent | 真实桌面 transcript，每轮 300 条合成历史、往返会话、待显示流式尾部尚有调度时卸载、释放 store 订阅 |
| 图谱 | 真实 `useMeasuredGraphEdges` 与 DOM 几何测量、布局修订、开始平移、resize/pan 事件、待测量时卸载 |

每个场景卸载后都核对全局监听器、timeout、interval、动画帧、ResizeObserver、MutationObserver、
Agent store 订阅和场景 DOM。探针先注入并释放各类资源，验证计数器能发现残留；
普通 DOM 事件不由探针持有，另用 CDP 在垃圾回收后检查 DOM/监听器总数。

本次所有场景每轮卸载后，上述八项计数均为 **0**。五个采样点的 DOM 均为 **19 节点、
141 个监听器、1 个 document**，包含测试页和 React 自身事件。
垃圾回收后的 JS heap 从 **6,336,396** 到 **7,125,404** 字节，增加约 **0.75 MiB**。
无累积 DOM 或受测资源残留；堆内存有少量增长，不能据此声称所有内存泄漏均被排除。
粗粒度保护上限为相对预热基线增加 40 个 DOM 节点、10 个监听器及 8 MiB JS heap，
该阈值是无头回归保护，不是设备内存或性能预算。

本轮没有发现需要另外改造的编辑器会话、Agent 显示订阅或图谱几何清理问题。
真实项目路由、Yjs 持久化、账号/同步、原生输入和设备体验不在这些受控生命周期场景内。

## 代码验收与证据身份

全量测试 2,985 项通过、1 项原有跳过；常规边界、类型、lint、Agent 能力、
Agent 对话同步及前端架构检查均通过。lint 为 0 错误；本地扫描还包含已有的嵌套工作树与
基线副本，输出 71 条警告，本次新增文件无警告。普通生产构建通过，产物不含本轮生命周期
探针或组合性能入口。组合渲染器回归由 `pnpm perf:renderer --ci` 生成
[ci-followup-regression.json](acceptance/ci-followup-regression.json)，当前源码身份和确定性约束均通过。

提交前生成的报告以父提交 `d1b854ce`、`dirty: true` 和完整源码 fingerprint 标识被测工作树，
不手工改写成未来提交 SHA。远端每次运行重新生成当前 HEAD 的证据。推送完成与 CI 成功
分别核对，原先设备验收清单的 `partial` 状态保持其原有含义。
