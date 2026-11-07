# P0-E 旧库导入探针：结论与导入规格草稿

2026-11-07。对应 [foundation.md 的 P0-E](../foundation.md#p0-e-旧库导入探针) 和 [modules.md 的 M10](../modules.md#阶段-2写作闭环)。代码在 `next/spikes/import-v1`（包名 `import-v1-spike`，不依赖 GPUI，也不依赖 yrs/Yjs），证据在 [`acceptance/p0-e-import.json`](../acceptance/p0-e-import.json)。

## 结论（先说大白话）

**1. 新版不懂 Yjs，也能把旧书完整读出来。**

旧库里，除了正文的「真身」存在 Yjs 里，别的东西全在普通的 SQLite 表和文件里：章、幕、故事线、要素、分类、关系、时间钉、情节规划、构想、批注、待办、补丁、素材、写作日、项目事实、Project Memory、资源文件。正文本身在 SQLite 里还有一份副本（`content_json`，以下叫「缓存」），格式就是编辑器用的 JSON，块 ID、人物链接、加粗斜体都在里面。批注和补丁的锚点存的是「块 ID + 偏移 + 原文」，不是 Yjs 的位置；快照历史每一行除了 Yjs 状态，还存了一份渲染好的正文。

探针只读这些，就把内置样书、两份合成库、一份「用旧了」的样书副本全部转成了新版的书目文档和 Loro 正文文档：正文往返 0 处差错，锚点全部变成 Loro 光标，快照历史全部回放成可以检出的版本。

**2. 唯一的坑：缓存可能比真正文少最后几秒的字。**

- **现象**：作者打完字马上退出（或者崩溃、强退、断电），Yjs 里已经有这几个字，缓存里还没有。
- **原因**：打个比方，正文像账本，缓存像抄本。账本每敲一个字就记上；抄本要等手停 400 毫秒（输入法组字时还要更久）才誊一遍。誊之前就关门，抄本就少了最后几行。2026-10-29 之前，macOS 上按 ⌘Q 会直接杀掉进程，誊抄根本来不及做（见 `docs/desktop-quit-persistence.md`）。
- **影响**：章节和构想没事——旧版每次打开书都会把章节的抄本重新誊一遍，而且章节记着「抄本是照哪一版誊的」，新版能看出来是不是最新。要素、故事线、分类、素材笔记的正文没有这道修复，也没有记版本：只要最后一次编辑后没有再碰过，抄本就一直缺那几个字，新版单看旧库无法判断。
- **规模**：在「用旧」副本里人为制造了 5 处这种情况，探针一处不漏地把它们归到「无法证明是最新」，而被它判为「可以证明是最新」的 152 篇，没有一篇和 Yjs 不一致。

**3. D5：不另做交换格式文件；旧版最后发一版，加一个「交接」步骤，把交接结果写回旧库本身。** 作者 2026-11-07 同意，已定。

交接只做三件事：把每篇正文从 Yjs 重新誊一遍缓存；在旧库的 `library_state` 里记一张「交接清单」（每篇誊的是第几版、缓存的哈希）；把只存在 WebView 里的设置一起记进清单。新版照常直接读旧库，对着清单逐篇核对版本号和哈希，全部对上就是一字不差。交接已经在旧客户端里实现（[docs/v2-handoff.md](../../v2-handoff.md)），每次启动和退出都会跑。

理由：

- 新版要读的东西，旧库里几乎都已经有了，缺的只是「缓存是最新的」这个证明，单独设计一种交换格式是多余的；
- 交接用的全是旧版现成的函数（从 Yjs 读当前正文、写回各类缓存），重型种子库上把 619 篇正文从 Yjs 全部渲染一遍只要 0.57 秒；
- 设置存在 WebView 的 localStorage 里，GPUI 程序读不到，本来就只能由旧版导出；
- 自动更新本来就要由最后一个 Tauri 版本交棒给新程序（M42），交接放在交棒之前，作者不用多做任何事。

不推荐的两条路：在新版里自己写只读的 Yjs 解码器（要实现 Yjs 的排序算法、y-prosemirror 的约定，估计 2–3 千行加大量对照测试，只为照顾「跳过最后一版」的人）；让旧版导出 Loro（会把 P0-C 还没定稿的 Loro 结构写死在旧版里）。

**4. 作者已定的两件事（2026-11-07）**

1. **旧的帮手对话只读搬过去**：能看、能搜，不能接着聊。搬的是对话、运行会话、轮次、消息、工具调用和工具结果这 7 张表。Agent 改动的结算记录、读取回执、检查点、事件流、长任务状态存的是 Yjs 状态向量或运行时的中间状态，到新版没有意义，留在旧库里。旧库导入后只读保留，不删。
2. **没经过交接的库默认拦住**（比如有人跳过最后一版，直接装了新版）：列出「无法证明是最新」的几篇，提示先用旧版最后一版打开一次；同时给一个「仍然导入」的按钮，照缓存导入，并说明这几篇可能少最后几秒的字。

还有一条规则要监管会话在 M36 里定，见下文「多台设备和账号库」：一个账号只能由一台设备做导入。

## 关键数字

六份库都是在本 worktree 里新生成的副本，不碰作者的库。「用旧」副本 = 样书副本上用旧版开发命令行做了 7 次 Agent 写入、1 条新批注、删了 1 个要素，再用旧版自己的写入路径追加 5 处「Yjs 已写、缓存未誊」的编辑，另把一章打了 60 次字并压缩进 `yjs_snapshots`。

| | 样书 | 合成·轻量 | 合成·重型 | 样书·用旧 | 用旧+交接 |
| --- | --- | --- | --- | --- | --- |
| 有正文的对象 | 156 | 80 | 679 | 156 | 156 |
| 其中有 Yjs 文档的 | 152 | 68 | 619 | 154 | 154 |
| 正文字数（字符） | 70.3 万 | 27.3 万 | 390.8 万 | 70.3 万 | 70.3 万 |
| 可证明最新 / 与 Yjs 一致 | 152 / 152 | 68 / 68 | 619 / 619 | 147 / 147 | 154 / 154 |
| 证明落后（章节）/ 确实不同 | — | — | — | 1 / 1 | — |
| 无法证明 / 其中确实不同 | — | — | — | 6 / 4 | — |
| 误判为最新 | 0 | 0 | 0 | 0 | 0 |
| 落后的行 / 字符 | 0 | 0 | 0 | 6 / 45 | 0 |
| Loro 往返（成功/总数） | 156/156 | 80/80 | 679/679 | 156/156 | 156/156 |
| 锚点 → 光标（成功/总数） | 19/19 | 2/2 | 10/10 | 20/20 | 20/20 |
| 锚点：原文已改、退回整块 | 0 | 0 | 0 | 2 | 2 |
| 快照历史行 / 有预览 / 回放一致 | 0 | 0 | 0 | 5/5/是 | 5/5/是 |
| 资源文件（行 / 校验通过） | 7 / 未写字节 | 6 / 6 | 36 / 36 | 7 / 未写字节 | 7 / 未写字节 |
| 未知的表 | 0 | 0 | 0 | 0 | 0 |

- 「用旧+交接」是在「用旧」副本上跑真实的旧版交接（`runV2Handoff`）得到的：154 篇全部核对盖章，其中 70 篇的缓存被重写（5 篇真的落后，其余是同样内容、不同写法）。
- 第六份「交接后又改缓存」：在「用旧+交接」里改了一个要素的缓存，不动 Yjs。探针按哈希识破，归为 `handoff-mismatch`，不再退回别的规则；其余 153 篇照常是 `handoff`，误判 0。这一份最初暴露了探针的一个漏洞：哈希对不上之后它退回了「创建种子」规则，又把这篇判成了最新，已修。
- 「可证明最新」= 下文「新鲜度」里的前四类。样书里的人物链接 3857 处、斜体 467 处、素材笔记的加粗 17 处全部往返无误；没有发现重叠的人物链接，也没有未知的行内节点。
- 样书是用应用首次启动时同一个 `ensureBuiltInSampleProject` 无窗口生成的，插图只写了记录、没写字节，所以资源文件只在两份合成库上校验了字节和 SHA-256。
- 重型库整库探针（读表、解析、建 Loro、对照、锚点）0.9 秒，峰值内存 328 MB；679 篇 Loro 正文快照共 5.8 MB，对应的 Yjs 数据 11.9 MB。这个数字只说明导入不慢，不是新版的性能基准。
- 「用旧」副本里两处锚点「原文已改」，是因为 Agent 改了被批注的那句话（「你那里配姓赵」改成「你哪里配姓赵」），导入时退回整块，并保留旧版存的原文快照，和旧版卡片的表现一致。

## 一、缓存什么时候会落后

旧版每条写正文的路径，Yjs 和缓存是不是在同一个事务里写：

| 写入路径 | 代码 | 同一事务 | 中途退出的后果 | 之后会被修好吗 |
| --- | --- | --- | --- | --- |
| 编辑器里打字 | `features/editor/entity-editor-session.ts`（`PERSIST_DEBOUNCE_MS = 400`，组字时顺延）→ `ChapterEditor` 的 `materializeCanonicalNodeProse`、笔记的 `projectNoteBody`、要素等的 `updateContent` | 否 | 缓存少最后一段 | 章节：下次打开书时 `reconcileProjectProseMetrics` 修好；其他：不会 |
| Agent 写关着的文档 | `lib/agent/chapter-prose.ts` 的 `persistBody`：先追加 Yjs，再刷新缓存 | 否 | 缓存少整次 Agent 改动 | 同上 |
| 快照恢复 | `services/snapshot-restore.service.ts`：先写 Yjs，再 `materializeCanonicalNodeProse` / `projectNoteBody` | 否 | 同上 | 同上 |
| 新建正文、Markdown 文件夹合回、同步收到远端更新 | `sync/journal`（phase 1）、`services/markdown-mirror/ingest.ts`、同步内核 | 是 | 无 | — |

2026-10-29 之前的 macOS 版，⌘Q 不经过退出前的刷新，上面三条「否」在每次退出时都可能发生。

**新版不读 Yjs，怎么判断缓存是否最新**（代码：`legacy.rs` 的 `Freshness`）：

| 类别 | 判断依据 | 结论 |
| --- | --- | --- |
| `seed-only` | 没有任何 Yjs 行（从没打开过的素材笔记） | 缓存就是正文 |
| `creation-seed` | 只有 1 条 Yjs 更新、版本号 1、没有快照 | 创建时和缓存同一事务写入，最新 |
| `node-basis-current` | 章节/构想的字数依据 `word_count_basis_kind = 'yjs'` 且版本号等于 `yjs_document_revision` | 依据和缓存同一事务写入，最新 |
| `handoff` | 交接清单里这篇的版本号等于当前版本号，缓存的 SHA-256 等于清单记的 | 旧版交接时核对过，最新 |
| `handoff-mismatch` | 版本号对得上，哈希对不上 | 缓存在核对之后被改过，不再套别的规则 |
| `node-basis-behind` | 字数依据的版本号落后 | 证明落后 |
| `unproven` | 创建后改过，又没有任何版本记录 | 无法判断 |

注意：缓存和 Yjs 的 JSON 逐字节比较会有大量「假不同」——标记的先后顺序（Yjs 把标记存在一个 map 里）、`indent: 0` 和 `targetEndBlockId: null` 这类默认值、相邻文字节点拆没拆开。对比要按语义比（`prose.rs` 的 `same_prose`）。样书 78 章里逐字节相同的只有 8 章，语义上 78 章全同。

## 二、导入规格草稿（进 M10）

### 流程

1. **前置检查**
   - 旧版必须关着：库文件没有别的进程持有（照旧版开发命令行 `src/dev-cli/safety.ts` 的做法）。
   - 用 SQLite 的 backup 接口把库（连同 `-wal`）复制到新版的暂存目录，之后只读暂存副本。原库只读、不动，导入完也不删。
   - 迁移级别：`__drizzle_migrations` 行数。0018（19 行）直接读；更低的 0.1.x 库，用 M10 里冻结的那 19 个 `drizzle/*.sql` 在暂存副本上补齐（迁移是纯 SQL，旧版的 `crates/drifting-core/src/database.rs` 就是这么做的）；更高的拒绝。
   - 报告并默认拦住：`sync_conflict`、`sync_frontier_gap`、`sync_quarantined_object` 非空。账号库还要求交接时同步已经停稳。
2. **读交接清单**（`library_state` 的 `v2-handoff`），给每篇正文分类（上表）。有 `unproven` 或 `node-basis-behind` 时默认停下：列出这几篇，提示先用旧版最后一版打开一次；作者点「仍然导入」才照缓存导入，导入回执里把这几篇记成「未证明」。
3. **书目文档**：每本书（`project` 一行）一个，见下文逐表映射。最近删除里的书、各表里 `deleted_at` 不为空的对象，照样导入并保持「已删除」。
4. **正文文档**：每个有正文的对象一个（章节和构想 `node-content`、要素、故事线、分类、素材笔记）。
5. **锚点**：批注、补丁换成一对 Loro 光标，见下文。
6. **快照历史**：回放成历史标签，见下文。
7. **资源文件**：`assets/<书>/<资源>/source.*` 按 `project_asset.source_sha256` 校验后复制进 `dr-store`；`display`、`thumbnail` 可以重建，缺了不算错。
8. **帮手对话**：`agent-archive` 那 7 张表只读导入，按对话分组，能看能搜，不能续聊；其余帮手表不导入。
9. **本机状态**：设置文件（交接导出）、`library_state` 的内置样书标记（删掉的样书不能回来）、MCP 扩展配置、工作记忆；钥匙串条目不用搬，新版用同一个服务名 `Drifting` 读（F7）。
10. **重建**：引用与提及（`inline_mention`）、搜索、大纲、字数、写作统计。
11. **写导入回执**：每篇正文的来源、新鲜度类别、旧版本号、缓存的哈希。之后的多设备核对要用。

### 逐表映射

旧库在迁移 0018 之后正好 100 张表，每张都有去向。这张表由 `cargo run -p import-v1-spike --release -- --mapping-md` 从 `tables.rs` 生成；测试保证它和真实旧库的表、和仓库里 `drizzle/*.sql` 建出来的表完全一致，多一张少一张都会失败。

去向：`book-doc` 书目文档，`prose-doc` 正文文档，`prose-evidence` 只用来判断缓存新鲜度，`assets` 资源文件，`history` 快照历史，`local` 新版本机 SQLite，`agent-archive` 帮手对话，只读导入，`rebuild` 导入后重建，`drop` 不导入（旧机制，或留在旧库里的记录）。

| 旧表 | 去向 | 落到哪里 / 为什么 |
| --- | --- | --- |
| `agent_chat_binding` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_branch` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_cursor` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_delivery` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_object` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_chat_queue` | drop | 帮手对话扩展的投递状态，留在旧库 |
| `agent_conversation` | agent-archive | 帮手对话的标题，只读搬过去 |
| `agent_mcp_server` | local | MCP 扩展配置；secret_* 只是钥匙串引用 |
| `agent_memory` | book-doc | 书目文档：Project Memory |
| `agent_permission_grant` | drop | 授权绑定旧工具版本，作者在新版重新授权 |
| `agent_runtime_checkpoint` | drop | 模型上下文检查点，可由消息重建，留在旧库 |
| `agent_runtime_element_patch_receipt` | drop | 结算记录（含 Yjs 状态向量），留在旧库 |
| `agent_runtime_entity_write_receipt` | drop | 结算记录，留在旧库 |
| `agent_runtime_event` | drop | 运行事件流，留在旧库 |
| `agent_runtime_message` | agent-archive | 对话消息，只读搬过去 |
| `agent_runtime_read_observation` | drop | 读取回执（含 Yjs 状态向量），留在旧库 |
| `agent_runtime_read_receipt` | drop | 读取回执，留在旧库 |
| `agent_runtime_result_artifact` | agent-archive | 工具结果，随对话只读搬过去 |
| `agent_runtime_result_blob` | agent-archive | 工具结果，随对话只读搬过去 |
| `agent_runtime_session` | agent-archive | 对话的运行会话，只读搬过去 |
| `agent_runtime_task` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_chapter_manifest` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_command` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_constraint` | drop | 长任务状态，留在旧库 |
| `agent_runtime_task_step` | drop | 长任务状态，留在旧库 |
| `agent_runtime_tool_call` | agent-archive | 工具调用，随对话只读搬过去 |
| `agent_runtime_turn` | agent-archive | 对话轮次，只读搬过去 |
| `agent_runtime_write_effect` | drop | 结算记录，留在旧库 |
| `agent_runtime_write_expectation` | drop | 结算记录，留在旧库 |
| `agent_runtime_write_review` | drop | 结算记录，留在旧库 |
| `agent_runtime_write_review_block` | drop | 结算记录，留在旧库 |
| `agent_working_memory` | local | 每本书的工作记忆文本 |
| `block_section` | drop | 已退役 Copilot 的滚动摘要 |
| `book_act` | book-doc | 书目文档：幕，书序上的分界 |
| `book_node` | book-doc | 书目文档：章节和构想，书序、叙事序两条列表 |
| `comment` | book-doc | 书目文档：批注和待办；锚点变成一对光标 |
| `comment_action` | book-doc | 书目文档：挂在所属批注下 |
| `drift_group` | book-doc | 书目文档：构想分组树 |
| `element` | book-doc | 书目文档：要素；content_json 成为正文文档 |
| `element_category` | book-doc | 书目文档：分类；content_json 成为正文文档 |
| `element_patch` | book-doc | 书目文档：补丁；text_anchor_json 变成一对光标 |
| `entity_kv_entry` | book-doc | 书目文档：事实和字段模板，挂在所属对象下 |
| `entity_relation` | book-doc | 书目文档：关系 |
| `entity_relation_type` | book-doc | 书目文档：关系类型 |
| `entity_relation_type_endpoint_kind` | book-doc | 书目文档：端点种类，并入所属关系类型 |
| `entity_snapshot_history` | history | 快照历史：按渲染好的预览回放成历史标签 |
| `inline_mention` | rebuild | 引用索引，按人物链接标记重建 |
| `library_item` | book-doc | 书目文档：素材；笔记正文成为正文文档 |
| `library_state` | local | 库级标记：内置样书标记、交接清单 |
| `markdown_mirror_file` | local | Markdown 文件夹绑定；file_sha256 分辨文件是否被外部改过 |
| `material_folder` | book-doc | 书目文档：素材夹树 |
| `node_content` | prose-doc | 正文文档：章节和构想正文；大纲、情节规划 JSON 是投影 |
| `node_storyline_link` | book-doc | 书目文档：故事线成员和主故事线 |
| `plot_grid_cell` | book-doc | 书目文档：情节规划格子 |
| `plot_grid_column` | book-doc | 书目文档：情节规划列 |
| `plot_grid_document` | book-doc | 书目文档：每章一张情节规划 |
| `plot_grid_row` | book-doc | 书目文档：情节规划行 |
| `project` | book-doc | 书目文档：书本身（书名、简介、最近删除） |
| `project_asset` | assets | 资源表加 assets/<书>/<资源>/source.* 文件 |
| `storylines` | book-doc | 书目文档：故事线；content_json 成为正文文档 |
| `sync_app_authority` | drop | 同步 v1 引擎 |
| `sync_apply_receipt` | drop | 同步 v1 引擎 |
| `sync_blob_state` | drop | 同步 v1 引擎 |
| `sync_change_set` | drop | 同步 v1 引擎 |
| `sync_checkpoint` | drop | 同步 v1 引擎 |
| `sync_conflict` | drop | 同步 v1 引擎；有未解决冲突时导入前报告 |
| `sync_connect_attempt` | drop | 同步 v1 引擎 |
| `sync_connect_generation_attempt` | drop | 同步 v1 引擎 |
| `sync_cursor` | drop | 同步 v1 引擎 |
| `sync_entity_lifecycle` | drop | 同步 v1 引擎 |
| `sync_field_clock` | drop | 同步 v1 引擎 |
| `sync_frontier` | drop | 同步 v1 引擎 |
| `sync_frontier_gap` | drop | 同步 v1 引擎；有缺口时导入前报告 |
| `sync_generation` | drop | 同步 v1 引擎 |
| `sync_generation_purge` | drop | 同步 v1 引擎 |
| `sync_generation_writer_state` | drop | 同步 v1 引擎 |
| `sync_journal_truncation` | drop | 同步 v1 引擎 |
| `sync_local_object` | drop | 同步 v1 引擎 |
| `sync_mutation` | drop | 同步 v1 引擎 |
| `sync_order_register` | drop | 同步 v1 的排序键；派生的排序列给出同样的顺序 |
| `sync_provider_account` | drop | 同步 v1 引擎；账号归属由库文件本身决定 |
| `sync_provider_binding` | drop | 同步 v1 引擎 |
| `sync_quarantined_object` | drop | 同步 v1 引擎；有隔离对象时导入前报告 |
| `sync_reducer_base` | drop | 同步 v1 引擎 |
| `sync_reducer_snapshot` | drop | 同步 v1 引擎 |
| `sync_remote_object` | drop | 同步 v1 引擎 |
| `sync_restore_attempt` | drop | 同步 v1 引擎 |
| `sync_segment` | drop | 同步 v1 引擎 |
| `sync_set_tag` | drop | 同步 v1 的 OR-set 标签；aliases_json 已有成员 |
| `sync_transfer` | drop | 同步 v1 引擎 |
| `sync_yjs_materialization_receipt` | drop | 同步 v1 引擎 |
| `timeline_marker` | book-doc | 书目文档：时间钉 |
| `workspace_projection_change` | drop | 界面失效提示 |
| `workspace_projection_clock` | drop | 界面失效提示 |
| `writing_day` | book-doc | 书目文档：写作日，按（设备，日期） |
| `yjs_document_revision` | prose-evidence | 每篇的版本号：判断缓存是否最新 |
| `yjs_document_revision_provenance` | drop | 每个版本由谁写的本机审计 |
| `yjs_prose_command_receipt` | drop | Agent 幂等回执 |
| `yjs_snapshots` | prose-evidence | Yjs 状态：说明文档存在、被压缩过 |
| `yjs_updates` | prose-evidence | Yjs 更新：说明文档存在、改过几次 |

### 书目文档：字段细则

探针（`book.rs`）把每张 `book-doc` 表按 id 写成一个 map 的条目（`ensure_mergeable_map`），列原样复制，`*_json` 列解析成结构化的值；字段名的最终形状由 P0-C 的 `loro-schema.md` 定。下面是不能照抄的地方：

| 旧数据 | 新版怎么得到 |
| --- | --- |
| 书序、叙事序 | `book_node.book_order`、`narrative_order` 排序后写成两条 `LoroMovableList`。构想也可以有叙事序（重型种子里 200 个节点有叙事序，100 个有书序） |
| 幕 | `book_act.start_order` 是书序上的分界，原样保留；`drift_node_id` 是绑定的构想 |
| 构想分组、素材夹 | `drift_group.parent_group_id`、`material_folder.parent_folder_id` 建 `LoroTree`；父节点不存在或成环时挂到根上，不丢 |
| 故事线、补丁、素材、构想分组的顺序 | 旧版的权威顺序在同步表 `sync_order_register` 的分数键里，本机的 `order_key` / `sort_order` 列是它派生出来、同一事务维护的名次，导入用名次即可 |
| 要素别名 | `element.aliases_json`（OR-set 标签的投影，同一事务维护） |
| 事实、字段模板 | 权威是 `entity_kv_entry`（每条有稳定 id）；它没有顺序列，顺序取所属对象的 `kv_json` / `element_template_kv_json` 投影 |
| 字数、大纲、情节规划 JSON | `book_node.word_count*`、`node_content.outline_json`、`plot_grid_json` 都是投影，导入后重算；情节规划用四张 `plot_grid_*` 表 |
| 批注、补丁正文 | `comment.body_json`、`element_patch.content_json` 是编辑器 JSON，旧版本来就整体覆盖（不走 Yjs），原样存成值 |
| 批注目标 | `target_kind` / `target_id` / `target_block_ids_json` + `anchor_json`；另有一条路：`entity_relation` 里 `from_kind = 'comment'` 的关系，两条都要导 |
| Project Memory | `agent_memory`，`target_block_id` 指向正文块时按块 ID 定位 |
| 写作日 | `writing_day`，键是（`device_key`，`day`）；设备键沿用旧值，这样旧设备的历史不会和新设备的混在一起 |
| 素材笔记的待办开关、来源 | `library_item.task_todos`、`provenance_json` 原样；`external_url`、`preview_image_url` 自迁移 0011 起恒为空，不导 |

### 正文：从编辑器 JSON 到 D3

数据里出现过的节点：`paragraph`、`heading`（level 1–3，即 H1/H2/H3）、`blockquote`、`hardBreak`；素材笔记另有 `bulletList`、`listItem`、`taskList`、`taskItem`（重型种子 180 个）。笔记的编辑配置还允许 `orderedList`、`codeBlock`、`table` / `tableRow` / `tableCell` / `tableHeader`、`callout`、`materialEmbed`、`horizontalRule`（`src/renderer/lib/editor-schema-profile.ts`），探针的单元测试覆盖了它们。标记：`entityLink`、`italic`、`bold`；配置里还有 `underline`、`strike`、`link`、`highlight`、`code`。

规则（`prose.rs`、`loro_body.rs`）：

- **一行一个叶子块**，以 `\n` 结尾（最后一行也有）。块属性记在这个 `\n` 上：类型、块 ID、`level`、`indent`、`textAlign`、`codeBlock` 的语言、`materialEmbed` 的 `libraryItemId`。默认值（`indent: 0`、`textAlign: left`、未勾选）不写。
- **容器记成路径**：叶子块外面的引用、列表、列表项、任务项、提示框、表格行和单元格，按外到内记在这一行上（类型、属性含块 ID、在父节点里的序号）。序号是必须的：表格行没有块 ID，两行属性相同，没有序号就会被并成一行。
- **硬换行**是 U+2028，不是 `\n`，不然一段会被拆成两行。
- **原子块**（分隔线、素材嵌入）是一个空行加类型；F1 写的「占位字符 U+FFFC 加标记」也行，由 P0-C 定。
- **未知节点不丢**：未知的块当容器或原子块；未知的行内节点变成 U+FFFC，整个节点的 JSON 存在一个 `inline` 标记里，导出时原样还原。
- **人物链接可以重叠**：旧 schema 里 `entityLink` 是 `excludes: ''`。Loro 一个键在一个字符上只有一个值，所以每个目标一个键，探针用 `entityLink:<种类>:<id>:<块>`，值是其余属性。旧版 Yjs 里的 `entityLink--<哈希>` 只存在于 Yjs 内部，缓存里就是普通的 `entityLink` 加属性，导入不需要算哈希。
- **扩展方向**：加粗、斜体、下划线、删除线、代码、高亮向后扩展；链接、人物链接、行内对象和所有块属性不扩展（对应旧版 `inclusive: false`）。单元测试验证了「在加粗末尾打字会变粗，在人物链接末尾打字不会」。
- 反过来从 Loro 读回、再还原成编辑器 JSON，和原文语义一致；样书的 156 篇、重型库的 679 篇全部往返无误。

### 锚点

| 旧数据 | 形状 | 导入 |
| --- | --- | --- |
| `comment.anchor_json` v1 | `selectedText` + ProseMirror 位置 | 位置不可移植，只留原文；样书和种子里都没有纯 v1 |
| v2 / v3 | 再加整块原文、各块原文快照 | 快照原样保留，用来显示「原文」 |
| v4 | `textAnchor`：起止块 ID + 块内偏移 + 原文 | 换成一对光标 |
| 区域批注 | `region`（图片/PDF 上的矩形，0–1 归一） | 原样保留，不涉及正文 |
| `element_patch.text_anchor_json` | 与 v4 同形，块在 `source_node_id` 那一章 | 同 v4 |
| 只有 `target_block_ids_json` | 整块 | 光标框住这些块 |

v4 的偏移有三个陷阱，单元测试都覆盖了：

- 偏移按 **UTF-16** 计（浏览器 DOM 的 `textContent`），表情符号占 2；
- **硬换行不占位置**（DOM 里 `<br>` 没有文字），而新版正文里它是一个字符；
- 块 ID 可以是**容器**的：引用块、列表项、任务项也能被批注锚住，这时「块内文字」是里面各段直接相接、中间没有分隔符。

定位顺序和旧版的 `lib/comment-highlight.ts` 一致：先按偏移取，和存的原文比对（跨块时忽略空白）；对不上就在起始块里找离原偏移最近的同一段原文；还找不到就退回整块，原文快照照旧显示。块已经不在了就不放光标，批注挂在对象上、卡片显示原文快照。

光标用 `LoroText::get_cursor` 取，取完立刻用 `get_cursor_pos` 解析回来核对位置，五份库共 71 个锚点全部一致。

### 快照历史

- `entity_snapshot_history` 每行有 `state_blob`（完整 Yjs 状态）、`content_json`（捕获时从这个状态渲染出的正文）、`meta_json`（当时的标题、摘要等）、`created_at`。「用旧」副本里 5 行全部有预览，预览和 Yjs 状态的渲染逐篇语义一致（一次性对照）。所以**快照历史也不需要读 Yjs**，modules.md 原来写的「state_blob 也要转换」不必做。
- 导入时按对象把预览从旧到新排好，最后接上当前正文，依次写进同一个 Loro 文档：第一版直接写入，后面每一版用 `LoroText::update` 做文字差分，再重放标记。每一版留下一个版本点（frontiers），写进 `history_label`，时间用旧行的 `created_at`，`meta_json` 跟着标签走。探针逐个版本检出核对，全部和预览一致。
- 预览为空的行（代码允许为空，五份库里没有遇到）由交接补上。
- 旧版只保留 30 天、24 小时内每小时一份、更早每天一份，所以每个对象最多几十个版本，回放成本可以忽略。

### 多台设备和账号库

旧版的 Hosted 同步存的是 Yjs 对象，新版读不了，新版同步 v2 是新的命名空间（D6）。账号库因此也要从某台设备的本机库导入。要避开一个陷阱：**同一本书在两台设备上各自导入，会得到两段毫不相干的 Loro 历史，同步后正文会重复。**

建议在 M36 里定：

1. 交接前先把同步跑完（没有待上传的改动、没有冲突和缺口）；
2. 一个账号由第一台升级的设备导入，并把导入回执（每篇的旧版本号和缓存哈希）随 v2 一起上传；
3. 之后升级的设备不再导入，只拉 v2；它本机的旧库若有回执里没有的较新改动（在第一台导入之后、自己升级之前写的），逐篇提示作者，把这台设备上的版本作为一次普通编辑合进去。

## 三、D5：三种做法的比较

| | 新版自己读 Yjs | 旧版导出交换文件 | 旧版交接 + 新版直接读旧库（已定） |
| --- | --- | --- | --- |
| 新版要写的 | 只读 Yjs 解码器：更新格式、YATA 排序、删除集、XmlText 格式、y-prosemirror 约定，估计 2–3 千行加对照测试 | 交换文件的读取 | 读旧库（本探针的大部分代码） |
| 旧版要加的 | 无 | 一种文件格式的写出：每篇正文、标记、块 ID、锚点、历史 | 交接：誊缓存、写清单、导出设置。估计 200–300 行，实际约 560 行 TS（含注释）加 300 行集成测试 |
| 跳过最后一版的库 | 能完整导入 | 不能导入 | 能导入；无法证明的几篇需要作者选择 |
| 旧的 `.driftingbook` v1 文件 | 能读 | 要先导入旧版 | 要先导入旧版 |
| 设置 | 读不到（在 WebView 里） | 可以一起导出 | 可以一起导出 |
| 风险 | 自写 CRDT 解码的细节错误；旧代码删掉后失去对照 | 多一种只用一次的格式 | 最小；用的都是旧版现成路径 |

交接已在旧客户端实现，细节和验收见 [docs/v2-handoff.md](../../v2-handoff.md)。要点：

1. 对库里每个有 Yjs 的文档（跳过已无主的），只处理版本号和清单不一致的：在同一个 SQLite 读边界里取 Yjs 状态和缓存，按章节投影和同步内核同样的方式渲染，缓存不同就写回。章节走 `materializeCanonicalNodeProse`（大纲、字数、字数依据一起），要素、故事线、分类、笔记只改缓存那一列、不动 `updated_at`。全部是派生事务，不进同步日志。
2. 再在一个读边界里核对版本号没变、缓存和渲染逐字节相同，才盖章：清单里每篇记 `revision` 和缓存 UTF-8 字节的 `sha256`。
3. 补上快照历史里缺的预览。
4. 设置：白名单里的偏好和界面布局键原样记进清单的 `settings`。会话令牌、账号资料、诊断、更新器状态、偏好同步记录不拷。原计划是写成应用数据目录下的文件；改进清单是因为导入本来就读这个库文件，省掉一段原生代码和路径约定。
5. 时机：库打开 20 秒后在后台跑一次（跳过编辑器里开着的文档）；退出前在刷新屏障里再跑一次（编辑器已保存、Yjs 队列已清空），限时 1.5 秒，超时就留给下次，失败也不拖住退出。重型种子库第一次 0.68 秒，没有改动时 14 毫秒。

越早发越好：只要作者用过任何一个带交接的 0.1.x 版本，库里就有清单，就算之后跳过了最后一版也能证明。

## 四、和计划不一致的地方

- **快照历史不用转换 Yjs**：每行自带渲染好的预览（见上）。
- **人物链接的键**：modules.md 写「标记键是 `entityLink--<6 字节哈希>`」，那是 Yjs 内部的写法；缓存里是普通的 `entityLink` 加属性，导入不用碰哈希。
- **D3 需要容器路径**：F1 列的块属性（H1/H2/H3、引用、缩进、对齐、块 ID）不够。引用块、列表项、任务项有自己的块 ID，批注可以锚在它们上面；表格行没有 ID，需要序号区分。交给 P0-C。
- **人物链接可以重叠**，一个 Loro 键装不下，需要按目标分键。交给 P0-C。
- **导入的块 ID 沿用旧的 UUID**：批注、补丁、Project Memory 和人物链接的 `targetBlockId` 都指向它。新版给新段落起块 ID 的规则不管是什么，块 ID 都要当不透明的字符串。
- **硬换行**需要一个不是 `\n` 的字符。
- **设置在 WebView 里**，只有旧版能导出，这是让旧版最后发一版的又一个理由。
- **旧的 `.driftingbook` v1**（CBOR 包里正文只有 Yjs 状态）新版读不了，要先导入旧版再交接；整库备份 `.drifting` 是 SQLite 加文件，可以和库一样导入。
- **删除单个素材会留下它的 Yjs 行**（`docs/material-workbench.md`）。五份库里没出现，探针把这类无主文档单独计数，不导入。

## 五、怎么复现

数据都在 scratchpad，不进仓库。

```bash
# 合成库（无窗口，几秒到一分半）
./node_modules/.bin/tsx --conditions=import src/dev-cli/seed-main.ts --db <dir>/drifting-library.db --preset lite --app-local-data <dir>/app-local-data
./node_modules/.bin/tsx --conditions=import src/dev-cli/seed-main.ts --db <dir>/drifting-library.db --preset stress --app-local-data <dir>/app-local-data
```

样书库、「用旧」副本和 Yjs 对照用的是三个一次性脚本（旧工具链，放在 vitest 下跑，因为样书的 `import.meta.glob` 需要 Vite），没有提交，交回监管会话时放在会话共享笔记目录：

- `make-sample.test.ts`：照 `built-in-sample.integration.test.ts` 的依赖，调用 `ensureBuiltInSampleProject` 生成两本样书；
- `unflushed.test.ts`：用 `createAuthoredYjsUpdateWriter` 追加「缓存未誊」的编辑，并压缩一章；
- `compare-yjs.test.ts`：用旧版的 `yjs` + `y-prosemirror` 渲染每篇正文和每行快照历史，写出对照文件（JSON lines，每行 `documentId`、`revision`、`prose`）；
- `run-handoff.test.ts`：在副本上跑真实的 `runV2Handoff`。「交接后又改缓存」是在它的结果上用 `sqlite3` 改一个要素的 `content_json`。

「用旧」副本里的 Agent 写入用旧版开发命令行（`DRIFTING_CLI_ALLOW_NON_USERDATA_WRITE=1`，只用于这些一次性副本）：`revise_chapter`、`replace_chapter_body`、`replace_storyline_body`、`replace_material_note_body`、`create_comment`、`delete_element`。

```bash
cd next
cargo run -p import-v1-spike --release -- <library.db> --truth <exchange.jsonl> [--app-local-data <dir>]
cargo run -p import-v1-spike --release -- evidence <manifest.json> > ../docs/rust-rewrite/acceptance/p0-e-import.json
cargo run -p import-v1-spike --release -- check ../docs/rust-rewrite/acceptance/p0-e-import.json
cargo test -p import-v1-spike
```

`cargo test` 里的 `committed_evidence_holds` 检查已提交的证据：映射和代码一致，每份库没有未知表、Loro 往返无误、光标全部解析、历史回放一致、资源文件哈希一致、没有误判为最新。

## 六、代码位置

`next/spikes/import-v1/src/`：

| 文件 | 内容 |
| --- | --- |
| `tables.rs` | 100 张表的去向，和真实旧库、`drizzle/*.sql` 的一致性测试 |
| `legacy.rs` | 只读打开、迁移级别、正文对象和新鲜度、快照历史、锚点行、资源文件校验、阻断项 |
| `prose.rs` | 编辑器 JSON ⇄ 扁平行（D3），语义比较 |
| `loro_body.rs` | 行 ⇄ `LoroText`，光标，历史回放 |
| `anchors.rs` | `anchor_json` v1–v4、UTF-16 偏移换算、按旧版规则重新定位 |
| `book.rs` | 结构化表 → 书目文档 |
| `probe.rs` | 整库报告、证据生成与检查 |

这是探针，不是 M10 的实现：没有写入新版的 SQLite（F2 未定），Loro 的键名是临时的，书目文档是逐列照抄。M10 应该保留的是：逐表映射和它的一致性测试、新鲜度分类、`prose.rs` 的转换规则和往返测试、锚点换算、历史回放的做法。
