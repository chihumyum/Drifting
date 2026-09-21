# 前端架构代码交付与手动验收

2026-09-14，按维护者最新要求收束自主工作：完成已确定的代码改造，执行必要的代码正确性、
无头回归和构建指标检查；模拟器、原生窗口、真机及固定设备性能由维护者手动验收。
这份交付记录覆盖原计划的编码落点，不将验收清单中的 `partial` 改成整阶段通过。

2026-09-21 后续完成 CI 浏览器生命周期修复、剧情规划面板 key 修复和四类界面的
100 轮无头资源释放检查，见 [后续复核](headless-followup.md)。

## 最后两批改动

- **F4q，`c290c998`**：桌面和移动聊天按不可变消息块复用 usage/tool 汇总；保持原始加法顺序、
  已返回快照及移动证据目标的当前归属。见 [聊天汇总](transcript-summary.md)。
- **F7g，本交付提交**：项目工作区、编辑子路由与独立设置经过同一个代码加载边界。
  壳层继续持有项目运行时与编辑会话；AppEffects 的应用级监听时序保留。
  见 [项目路由加载](project-route-loading.md)。

## 对照原计划的编码落点

下表按原计划的实施条目核对。源码与确定性回归已经覆盖主要责任边界；
仍标为 partial 的原生、组合预算和人工操作门槛继续保留。

| 阶段及实施条目 | 已实现的代码边界 | 验证入口 / 尚待人工确认 |
| --- | --- | --- |
| F0，fixture、计数、报告、证据校验 | `src/renderer/performance/`、`scripts/run-renderer-performance.mjs`、`scripts/check-renderer-performance.mjs`；合成数据、构建身份、原始样本、确定性约束分开记录 | [本轮组合回归](acceptance/code-delivery-regression.json)；固定设备预算校准和整 App 指标仍未完成 |
| F1，条目 1–5：输入路径、链接索引、外观失效、正确性 | `lib/extensions/entity-link.ts`、`lib/entity-link-appearance.ts`；普通正文事务由 mark DOM 路径更新，外观修订有单独慢路径 | 无头三档输入、链接增删/重建/撤销等回归；真实中文输入体验由维护者验收 |
| F2，条目 1–5：窄订阅、稳定引用、语义修订、共享索引、统计 | `store/data-store.ts`、`store/workspace-projection-sharing.ts`、`lib/entity-link-target-state.ts`、`store/writing-stats-store.ts`；generation 和原子快照归属明确；书架使用聚合读模型 | 普通 CI 保护全 store 订阅边界；组合报告包含 1/5/20 消费者、无关更新、generation 及目标查询检查 |
| F3，条目 1–5：会话、Review、可见交互、ready 屏障、释放 | `features/editor/useEntityEditorSession.ts`、`useEntityLinkConfiguration.ts`、`useAgentEditorDecorations.ts` 与拥有者明确的选择、菜单、建议及 Copilot 控制器 | 隐藏准备/恢复、正文/命令归属、晚到回调、卸载和标签共享回归；物理输入、焦点及触摸不在本轮自动验收中 |
| F4，条目 1–5：会话控制、去重、投影、显示调度、历史复用 | journal 消费者、运行投影、会话路由/恢复控制、树形 transcript、短窗口显示发布、64 行分块及 usage/tool 汇总各有独立拥有者 | [F4q 实测](acceptance/f4-transcript-summary.json)和本轮组合回归；增量 Markdown/视口虚拟化是原计划有条件追加项，未追加 |
| F5，条目 1–6：读模型、卡片、几何、视口、交互 | 共享 ID 读模型、稳定卡片和 Drift 槽位、独立连线 overlay；每轮同一端点只读一次布局；拖动预览保留 ref/DOM 与结束提交边界 | 组合报告覆盖投影、卡片、几何、浮层和 Timeline；视口裁剪仍是证据驱动的可选项，未引入新的焦点/锚点语义 |
| F6，条目 1–6：原子投影、影响来源、队列、恢复、局部读取、全量退路 | `services/workspace-projection*.ts`、`services/reference-index.service.ts`；提交后的 durable coverage、项目队列、失效结果丢弃、SQLite 一致捕获与原子发布；node/element/library/comment/action 有受限范围读取 | SQLite/Yjs 集成与已有恢复证据，外加本轮全套测试；未知影响、超界或覆盖不可信时保留全量捕获，未要求每张薄表一律做增量读取 |
| F7，条目 1–4 的代码部分：入口、加载状态、缓存、预加载、重试 | PDF/ZIP、设置、图谱、资料与 AI SDK 已独立加载；本批补上 `app/AppRoutes.tsx` 到 `project-route-components.tsx` 的代码门槛；设置/图谱共享依赖由门槛先就绪 | [F7g 生产构建观察](acceptance/f7-project-routes.json)、[设置回归](acceptance/f7-settings-after-routes.json)；首次点击成本、原生离线与升级资源由维护者验收 |
| F8，条目 1–5 的自动化和记录部分 | 确定性组合脚本、架构边界、普通 CI、源指纹与历史证据；最终代码运行现有全套检查 | 新的[组合回归](acceptance/code-delivery-regression.json)；不把无头、旧原生报告或构建体积视为本次设备验收 |

路径未特别注明时相对 `src/renderer/`。原计划中“有证据后再优化”的条目没有被改写成
必做重构，也没有被虚报为已实现。后续是否需要虚拟化、更多细表局部读取或继续缩小入口，
应依据本轮手动使用中实际暴露的问题决定。

## 本轮测量的含义

- F4q：10,000 条历史、20 次可见更新时，桌面 usage 候选处理从 **200,020 次降到 20 次**；
  移动 evidence 候选从 **200,020 次降到 1,960 次**。此前树形显示改造的 0 次历史数组展开保持。
  各 profile 的时间样本见原报告；不能将计数下降比例直接当作端到端速度提升。
- F7g：相同观察方式的生产构建首屏静态 JS 闭包由 **4,409,079 字节降到 2,362,731 字节**，
  减少 **46.4%**。目标工作区、编辑路由和首页模块在书架阶段没有请求、解析或执行。
  完整工作区代码在首次打开项目或独立设置时加载；总体 JS 数量和实际启动速度是不同指标。
- 组合回归使用合成 Tiptap/Yjs、组件和本地服务边界，记录输入、订阅、Agent、图谱等确定性工作量。
  源码通过常规检查不代表真实账号同步、输入到绘制耗时或设备内存已经达标。

## 本轮正确性检查

`pnpm ci:contract:check`、`pnpm public:check`、`pnpm lint`、`pnpm typecheck`、
`pnpm test`、`pnpm agent:capabilities:check`、`pnpm test:renderer-architecture` 通过。
全量测试 **2,979 通过、1 跳过**；lint 为 0 错误、30 条已有警告。
设置专项另外执行 85 项测试及桌面/移动组件的无头检查。

普通生产构建成功，共 55 个 JS chunk；首屏静态 JS 2,364,485 字节，项目入口不在首屏依赖闭包。
检查确认没有路由或聊天验收探针进入普通生产 JS。对照用的观察构建与普通构建分开记录，
前面的 46.4% 使用相同观察方式的两个构建计算。

## 维护者手动验收重点

1. 从书架首次打开已有项目，连续中文输入、粘贴、撤销/重做；退出后重新打开确认正文保存。
2. 快速切换章节、标签和分栏，检查草稿、滚动位置、批注与实体链接；隐藏页更新后回来显示正确。
3. 打开长 Agent 历史，发送、取消、往返会话；检查输出、usage、证据按钮和引用目标。
4. 故事/元素图谱平移、缩放、拖动卡片及连线；检查选择、浮层和 Drift 关系语义。
5. 从书架和项目分别打开设置；首次打开图谱、资料、PDF 及导出，再重复打开，检查空白或闪烁。
6. 按平时工作流确认同步及移动端连续性；观察长文、大项目、长会话下是否仍有明显卡顿。

这些项目本轮均未通过模拟器、原生窗口或真机代做。原验收清单继续保留相应未完成状态，
后续手动结果应记录在其自身构建与环境下。
