# M30 长任务、记忆与主动建议

先读 [README.md](README.md) 的共用约定，以及 [m27-agent-runtime.md](m27-agent-runtime.md)、[m29-agent-tools.md](m29-agent-tools.md)、[m31-agent-panel.md](m31-agent-panel.md)。

## 要做的

**长任务**
- 计划、步骤、约束。帮手按步骤做，能停、能续。
- 照 `docs/agent-runtime/long-task-execution-protocol.md`。

**记忆**
- **Project Memory** 跟书走、会同步。作者和帮手看到的都是一份纯 Markdown 的 `PROJECT_MEMORY.md`，存的时候一条一行。
  - 不分作者写的和帮手写的，谁都能改、能删；帮手写了立刻生效。
  - F3 已经有 `memory.add` / `list` / `update` / `remove` / `restore`。
- **工作记忆**只在本机，帮手自己整理：删过时的；把属于项目或作者个人的内容挪进 Project Memory。
- 个人的想法也留在这本书的记忆里，不自动升到跨书的一层。

**主动建议**：主页上的任务卡，都由作者点了才做。作者 2026-11-05 定的规则：
- 只有一个开关「主动建议」，同时管签到和整理卡。没有「每日签到」「自动整理」开关，也没有手动「现在签到」按钮。
- **签到**：
  - 自动触发：主页打开时、主页开着时每次窗口获得焦点、整理结束后；每本书每台设备最多 90 分钟一次。
  - 一次模型调用产出最多 4 张卡，**什么都不写**。
  - 提示词只讲原则，不给具体例子。
- **整理卡**：
  - 本机算出上次以来作者本人写的章节和构想（来源是作者的，不算帮手和同步来的），出一张「把上次写的整理进要素」，这一步不调模型。
  - 点了才开一个能读写的后台会话去整理；× 表示跳过这一批；失败了会再提示。
- **记忆维护卡**：签到发现工作记忆里有长期偏好或过期内容、项目记忆里有重复时出这张卡。点了才由帮手去改。
- 卡的内部名字可以叫 check-in，界面上不出现「签到」字样。

**交给帮手的入口**
- 章末 ⁂ 的「Agent 审阅」；
- 把待办交给帮手。

两个都用能读写的会话加一句简短提示，比如「审这一章，留批注，不改正文」。作者明确不要只读档或只能批注的权限档。

## 旧版

- `src/renderer/lib/agent/runtime/long-task-*`
- `src/renderer/lib/agent/checkin/*`、`src/renderer/lib/agent/organize/*`
- `src/renderer/features/agent/ProjectAgentHome.tsx`、`ProjectMemoryEditor.tsx`、`AgentWorkingMemoryView.tsx`
- 文档：`docs/agent-runtime/project-checkin.md`、`project-organize.md`

## 新版放哪、接哪

- 运行时那头放在 `dr-agent`，界面放在 `dr-view-agent`（M31 建的）。
- 主页上的卡：作品主页是 M02（`dr-view-home`，M01 那一路负责）。要一个放卡的位置，写进「待协调」，说清卡的大小、个数、点了做什么。
- 章末 ⁂：M03 的章末（`dr-view-page`）。待办：M18（`dr-view-review`）。这两处只加一个入口，入口的动作调你的函数。
- 工作记忆的本机存储：F2 的 `local_state`。

## 完成标准

- 用假驱动跑通：
  - 签到出卡、不写任何东西；
  - 整理卡在本机算出来、点了才整理；
  - 记忆维护卡；
  - 长任务分步做完、中途停下再续。
- 90 分钟节流、只算作者来源的改动、开关关掉以后什么都不出，各有测试。
