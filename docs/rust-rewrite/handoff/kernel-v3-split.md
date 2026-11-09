# 分轨：通用内核 v3 与继续推进的部分

2026-11-08 晚，作者暂停了 GPUI 重写的推进，定了一个新方向：**内核做成通用的，小说是第一个、也是默认的模板**。这一页说明重写接下来怎么分轨：哪些继续做，哪些冻结，哪些等 v3。所有外部会话开工前先读这一页，它比 [remaining.md](remaining.md) 和各队列文件优先。

> 2026-11-09 夜：作者睡觉期间各会话怎么交回、整合者怎么收、各自的顺序，见 [overnight.md](overnight.md)。

## 新方向（摘要）

v3 的完整方案在 [kernel-v3.md](../kernel-v3.md)，2026-11-09 作者已定稿。要点：

- **小说的默认结构开箱就在**：书稿与章、构想、要素与分类、故事线、素材，由「小说模板」保证。幕不再内置。
- **条目树**：章节、构想、要素、故事线、分类不再是各自一张表，而是同一棵树里的条目。条目分层级和叶子：层级模板只管理下面放什么（默认和允许的模板、自动链接、显示、收别处的条目等），设置往下继承；叶子模板只定义自己的模块，叶子不能有子条目。能不能归属到别处由要挂去的那一层决定。
- **模块拼装**：叶子的正文可以有多篇、随意命名；字段、键值表、补丁、情节规划都是模块，由用户拼装。每个模块要交代：怎么存、帮手怎么读写、搜索和字数算不算、导出成什么、在 Markdown 文件夹里写成什么、撤销和快照怎么处理。
- **帮手通用化**：和小说绑定的提示词挪进小说模板；帮手对项目的认识来自用户定义的结构和写给 Agent 的描述；工具要大改。
- **时间线**：作者自己建视图，把任何条目拖进去，顺序完全由作者摆；没有书序；泳道本身是条目，拖进泳道就是归属到它；幕改成作者自己定的时间钉，时间钉可以挂条目。时间线和文稿树、层级完全解耦。
- 素材、批注、待办在项目树之外，单独保留。
- 代码插件现在不做。

## 三类工作

| 类别 | 内容 | 现在怎么办 |
| --- | --- | --- |
| **继续** | 和数据模型无关的：编辑引擎和输入法、`dr-ui`、平台与自动更新、存储底层、帮手运行时和模型接入、MCP 传输、账号、同步传输、偏好同步、Windows、导出排版 | 按下面的轨道继续，照旧交回、整合 |
| **冻结** | 按种类做的界面和命令的收尾：要素与分类（M11）、故事线（M13）、时间线（M14）、构想（M16）、关系（M17）、素材收尾（M19）、主页新建（M02）、样书写入（M24）、Super View（M21–M23）、帮手工具清单（M29 后续）、生图（M33）、分享链接（M38）、Markdown 文件夹第二期（M40） | 不再修、不再预审、不再合；分支原样留着，不删、不 rebase |
| **等 v3** | `dr-model`、`dr-doc` 的结构，`dr-workspace` 的按种类命令，旧库导入的映射，样书，测试种子 | v3 方案定稿后，先开一个数据层会话做内核和小说模板，再把冻结的界面一个个接回来 |

## 继续做的轨道都要守的规矩

- **不新增按种类的东西**：不加章节、构想、要素、故事线、分类专用的新命令、新工具、新字段、新文档种类。真的需要，写进自己文档的「待协调」，等 v3。
- **书目文档结构冻结在 v2.2**：不改 `dr-model`、`dr-doc` 的结构；只修确定的缺陷。
- **新写的提示词里和小说绑定的部分集中放在一处**，并在代码旁写明 v3 会把它挪进小说模板。
- **同步、导出、Markdown 这类按文档工作的代码，不要写死文档种类的列表**：把一本书当成「一组 Loro 文档加资源文件」，文档 id 当作不透明的字符串。
- 其余照 [README.md](README.md) 的共用约定：自己的分支和 worktree，不推送，不开 PR；除整合者以外不合 `main`；交回前在 `next/` 跑全套检查，再在仓库根跑 `pnpm public:check`。

## 轨道

| 轨道 | 做什么 | 可以动的 crate | 不做 |
| --- | --- | --- | --- |
| 1 整合 | 按本页把 [integration.md](integration.md) 的分支表和 [progress.md](../progress.md) 的状态改成「冻结（v3）」或「继续」；验收 `codex/batch-30`（M32）；之后只收继续轨道的分支 | 只修合并时两边对不上的地方 | 冻结模块的复审、复现和修复 |
| 2 编辑引擎与输入 | GPUI 补丁（见 [f4-editor.md](../foundations/f4-editor.md)「GPUI 补丁台账」）：G3 丢弃组字的接口写成补丁文件；G1 空闲停刷新时钟已经写好，挂上去要开 GPUI 的 fork，fork 放在哪先问作者，不要自己建远端仓库；F4c 待协调 12、14（`dr-ui` 输入框与编辑器对齐、macOS 用窗口自身的 inputContext）；F5 剩下两处数字写法并进 `dr_i18n::number`；M31 逐字显现要的公共播放接口；空闲时重跑 `prose-bench` | `gpui-prose`、`gpui-ime`、`prose-linebreak`、`dr-ui`、`dr-editor`（只限输入、排版、播放）、`dr-i18n` | 人物链接、批注画层里按种类的部分 |
| 3 帮手运行时 | 接着 M30：长任务、工作记忆、上下文、主动建议的机制（未提交的改动在 `refs/wip/2026-11-08/m30-long-tasks-memory`，原工作区也还在）；把和小说绑定的提示词集中到一处；M32 出站清理失败那条 P2；M34 口述 | `dr-agent`、`dr-agent-providers`、`dr-view-agent`，`dr-agent-tools` 只限执行管线 | 新工具、扩工具清单（M29 后续）、M33 生图 |
| 4 账号与同步 | 按 [antigravity-queue.md](antigravity-queue.md) 的任务书做 M35 账号 → M37 偏好同步 → M36 同步 v2 → M43 Windows 补齐（托盘、arm64、字体回退；实机验收留给作者）。M36 把书当成一组不透明 id 的 Loro 文档加资源文件 | M35–M37、M43 各自的 crate，`dr-platform` 里和它们有关的部分 | M21–M23 Super View、M38 分享链接 |
| 5 v3 方案 | ~~写 `kernel-v3.md`~~：2026-11-09 定稿 | 只写文档 | 代码 |
| 6 K1+K2 内核 | 照 [kernel-v3.md](../kernel-v3.md) 的「分步」和「怎么换过去」：`dr-model`、`dr-doc` 加 v3 模块，`dr-store` 认 v3 文档，`dr_testkit::seed` 加 v3 四档，`dr-workspace` 加通用命令；和 v2.2 并存，`main` 一直全绿。分支 `codex/k1-kernel-v3`，作者交给 Antigravity | `dr-model`、`dr-doc`、`dr-store`、`dr-testkit`、`dr-workspace`、`loro-schema.md` | 界面 crate、帮手 crate、删 v2.2 |
| 7 K3 导入与样书 | K1 的 `dr-doc` v3 接口定下来以后开：`dr-import-v1` 按 kernel-v3.md 的映射导进 v3，`dr-samples` 两本样书改用 v3 | `dr-import-v1`、`dr-samples` | 改 v3 的结构 |
| 8 K6 帮手工具 | 照 [k6-agent-tools.md](../modules/k6-agent-tools.md)：帮手工具目录按书的内核版本生成（v3 的书用通用命令和模板动作）、拼「这本书的结构说明」、小说提示词挪进小说项目模板；v2.2 的书行为不变 | `dr-agent-tools`、`dr-agent`、`dr-view-agent`，`dr-doc` 的 v3 `novel.rs` 只改写给帮手的说明 | 改 `dr-workspace` 的命令实现、`dr-model`、`dr-store` |

轨道 2、3、4 互不重叠。轨道 6 动的 `dr-workspace`、`dr-store` 别的轨道也可能碰：先合进 `main` 的一方为准，后到的照 `main` 调整。碰到同一个 crate 时，先在自己文档里写清楚，由整合者协调。

## 停掉的会话留下的改动

作者 11-08 晚停掉了几路会话。它们工作区里没提交的改动，监管会话已经原样存成 git 引用，工作区本身没动：

| 引用 `refs/wip/2026-11-08/…` | 原分支 | 内容 | 去向 |
| --- | --- | --- | --- |
| `m30-long-tasks-memory` | `codex/m30-long-tasks-memory` | M30 长任务、记忆、主动建议，模型接入的小改 | 轨道 3 接着做 |
| `m21-story-graph-review` | `codex/m21-story-graph-review` | M21 故事图，时间线、构想、关系的配合改动，接续队列文件 `codex-super-account-queue.md` | 冻结；队列文件里账号那部分轨道 4 可以参考 |
| `legacy-m02-arrival` | `codex/legacy-m02-arrival` | M02 主页新建后的落位 | 冻结 |
| `legacy-m24-illustrations-owned` | `codex/legacy-m24-illustrations-owned` | M24 样书插图、认领与释放 | 冻结；认领和释放的做法留给 v3 写样书时参考 |
| `legacy-m11-field-recovery` | `codex/legacy-m11-field-recovery` | M11 字段写入恢复、书的租约 | 冻结；`with_book_lease` 的思路留给 v3 参考 |
| `legacy-m17-release` | `codex/legacy-m17-release` | M17 关系写入的退出排空 | 冻结 |
| `legacy-m19-release` | `codex/legacy-m19-release` | M19 素材任务投射的退出排空 | 冻结 |

看某一份：`git diff <原分支> refs/wip/2026-11-08/<名字>`。要接着做，在原工作区里直接继续（改动还在），或者从引用新开分支：`git switch -c <新分支> refs/wip/2026-11-08/<名字>`。

## 其他在途分支

| 分支 | 去向 |
| --- | --- |
| `codex/batch-30`（M32 MCP 的整合候选） | 轨道 1 验收；传输和扩展客户端继续，工具清单不扩 |
| `antigravity/m21-story-graph`、`antigravity/m22-element-overview`、`codex/m22-element-overview-wip` | 冻结 |
| `codex/legacy-*` 其余分支、`codex/integration-*-review` | 冻结 |
| `claude/m10-import-e63951`（M16 第二里程碑的最后两个提交） | 冻结 |
| `claude/loro-upstream-issues` | 与本页无关，原样 |
