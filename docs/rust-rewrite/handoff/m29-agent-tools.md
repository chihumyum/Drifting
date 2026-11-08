# M29 帮手的工具

先读 [README.md](README.md) 的共用约定和 [m27-agent-runtime.md](m27-agent-runtime.md)。

## 要做的

在 F3 的命令注册表上加一层帮手外观，把命令和查询变成帮手能用的工具。

已经定下的：

- **工具从注册表生成，不手写第二份清单。** F3 的注册表（`dr_workspace::registry`）给每条命令和查询登记了名字、输入输出的 JSON Schema、读还是写、并发类别、说明。`Workspace::call` 按名字和 JSON 调。能力清单是 insta 快照：`next/crates/dr-workspace/tests/snapshots/registry__capabilities.snap`。
- **帮手外观**，是给模型看的那一层：
  - 按名字找对象，不要求模型知道 id；
  - 正文投影成能改的文本（H1/H2/H3、段落、批注锚点），改完再落回 Loro。
- **不保留旧的目录名和虚拟路径。** 旧版有两套词汇并存：生产用的约 69 个作者域工具，和只在评测里用的旧目录名。新版只要作者域这一套。
- **工具搜索**：`tool_search` / `call_tool`。不一次把全部工具塞给模型。
- **读写屏障**：写之前先读过；读到的版本过时了就重读。
- **修订号 CAS**：每轮里同一个目标冲突两次就停下，告诉作者。
- **结算记录**：每次写入一条，落在 M27 定的事务里。
- **对齐旧版**：生成的清单要和旧版的工具面对得上，差异列成表。旧版清单在 `docs/agent-runtime/acceptance/agent-capabilities.md`。阶段 5 的过关标准就是这一条。
- 不分权限档，也没有「危险操作」开关。

## 旧版

- `src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.ts`（6023 行）
- `tool-registry.ts`（2037 行）
- `drifting-write-*.ts`
- `drifting-tool-selection.ts`、`tool-search-metadata.ts`
- 文档：`docs/agent-runtime/tool-discovery.md`、`domain-crud-transaction-protocol.md`

## 新版放哪、接哪

- 放在 `dr-agent` 的工具模块里，或者单开 `dr-agent-tools`。
- 注册表里缺帮手要用的查询或命令（比如按名字找对象、正文投影），写进「待协调」请 F3 加，说明输入输出；先在帮手外观里用现有查询拼。不要自己往 `dr-workspace` 里加命令。
- M32 MCP 用的是同一份工具，这里的设计要让 MCP 直接复用。

## 完成标准

- 用 M27 的假驱动跑通：搜工具、找对象、读正文、改一段、冲突两次停下、按来源撤回。
- 生成的工具清单有快照测试；和旧版的对照表写进文档。
- 正文投影往返：投影出来、不改、落回去，Loro 文档逐字节不变。用 `dr_testkit` 的种子测。
