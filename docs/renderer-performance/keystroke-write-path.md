# 打字时每次按键的写入路径（2026-10-30）

## 问题

release 基线里，打字时 WebContent 进程的 CPU 约 73%，按每秒约 8 个字算，每个字约 140 ms CPU（见[重型 seed 基线](heavy-seed-baseline.md)）。打字延迟不受影响，但耗电、发热。

正文的每一次按键都是一个 `yjs.update` change set，要走完整的作者写入事务：

1. 写 Yjs 更新行、版本号和来源；
2. 记录 change set；
3. 同步 reducer 把它归约进整项目的状态；
4. 域校验内核校验整个确定性投影；
5. 持久化 reducer 元数据。

第 3、4 步都按整个项目计算，而不只是本次变更。重型 seed 的状态有 3265 个效果，其中 1901 个实体生命周期效果带着共约 1.8 MB 的种子（含正文的 Yjs 字节）。

## 测量方法

`pnpm perf:keystroke` 不启动应用。它复制 `pnpm perf:stress` 为实例保存的 seed 后数据库，用 Node 的 SQLite 打开，再向第 007 章（约 2.2 万字）连续写入单字 Yjs 更新。写入走编辑器用的同一条作者写入路径，逐次计时。

```bash
pnpm perf:keystroke                 # 默认 60 次写入，实例 perf-stress
pnpm perf:keystroke --label after   # 另存 .local-data/perf-stress/keystroke-after.json
pnpm perf:keystroke --snapshot <目录> # 改用该目录里的库，便于在旧提交的检出里测同一份数据
```

- 第一次写入要冷加载 reducer 状态，所以中位数从第 6 次起算。
- Node 的 V8 不是应用里的 JavaScriptCore，SQLite 也在进程内而不经 IPC。这里的数字只能互相比较，不能和 `perf:stress` 的帧时间直接比较。
- 应用里的效果看 `perf:stress --release` 的打字 CPU，见下文。

## 修复

按提交顺序，`pnpm perf:keystroke --snapshot <seed 库> --keys 150` 的结果（M3 Pro，Node 22）：

| 提交 | 改动 | 每次写入（中位数） |
| --- | --- | ---: |
| `df251d31` | 修复前 | 49.7 ms |
| `ce4eed9d` | 校验内核：主线归属和故事线成员不变量只对相关效果做异步检查，集合成员按索引查找；只有远端写入才计算变更效果集；reducer 状态重建后只修复与存储不一致的元数据行 | 31.2 ms |
| `1d8fa9fe` | Yjs 校验文档按数据库缓存，只读上次之后追加的更新行 | 28.8 ms |
| `0957aff0` | 复用未变寄存器的效果、键按代码单元排序、只读自身的检查每个效果只做一次 | 10.4 ms |

原始数据：[acceptance/keystroke-write-path-2026-10-30.json](acceptance/keystroke-write-path-2026-10-30.json)。

- 全新 seed 里第 007 章只有一条更新行，所以 Yjs 缓存这一步只省了约 2 ms。
- 换成用过一段时间的库（同一章已有快照，会话中写入不断追加更新行），旧实现每次都要把快照和全部新行重新读出、重建，单次写入从 81 ms 涨到 209 ms。
  - 在这份库上用同样的写入循环测得：141 ms → 75 ms → 42 ms → 19 ms。
  - 加上 Yjs 缓存后，耗时不再随更新行增长。
- 另外，打开项目 1 秒后会在后台预热 reducer 状态。项目里的第一次写入原来要冷加载状态，在 Debug 构建中曾长达 13 秒。

### Yjs 校验文档

校验一个 `yjs.update` 要把它应用到文档的存储状态上。原来每次按键都从快照和整条更新日志重建整章文档，每个 blob 都要过 IPC。

现在，与已提交状态完全一致的文档按数据库保留，最多 4 篇（`src/renderer/sync/reducer/yjs-validation-documents.ts`）。下一次校验只读之后追加的更新行。以下任一变化都会触发重建：

- 快照的时间或长度变了；
- 最早的更新行变了；
- 版本号的增量与新行数不符（压缩、恢复、清除）。

一次校验会先把文档从缓存取出，只有同时满足以下两点才放回：

- 本次更新已经是一条存储行（作者写入在 reducer 之前追加）；
- 事务已提交（`afterDatabaseCommit`）。

所以缓存里永远不会有数据库没有的更新。缓存按打开事务的数据库客户端区分（`activeTransactionOwner`），重开或换库互不串用。

### 整项目投影

- **效果复用**：reducer 在修改寄存器或生命周期前总是先复制，之后不会原地修改。所以未变的寄存器保持同一对象，它的效果直接复用，不再重新深拷贝种子（`reducer.ts` 的 `projectedEffect`）。只有 `materialize` 变化时才生成新对象。
- **排序**：精确的 UTF-8 字节序比较器每次比较都要重新检查两个字符串是否为合法 UTF-16。只要一批键里没有代理项或更高的代码单元，代码单元序就与 UTF-8 字节序一致，可以改用原生比较。否则仍用精确比较器（`sortByUtf8`）。
- **单效果检查**：字段、元组、排序、集合成员和生命周期的检查只读效果本身。效果对象复用后，每个效果只检查一次（`production-domain-kernel.ts` 的 `ownIssues`）。原来每次按键都要重新解析项目里每个 JSON 正文。
- **实体索引**：`effectsForEntity` 的索引改为按类型、按 id 的两级 Map，不再给每个效果拼 JSON 键。

以下测试覆盖这些改动：

- `yjs-validation-documents.integration.test.ts`：
  - 复用已提交的文档，只读新行；
  - 回滚后丢弃；
  - 尚未成为存储行的更新不缓存；
  - 快照或版本号另有变化时重建；
  - 不同数据库互不借用。
- `reducer.test.ts`：
  - 含 U+E000 和表情符号的 id 仍按 UTF-8 字节排序；
  - 未变寄存器的效果是同一对象；
  - 实体移入回收站后，其未变字段的 `materialize` 变为 false，旧结果不受影响。
- `production-domain-kernel.integration.test.ts`：同一个无效效果在每次校验中都报出冲突。

每条测试都在对应的错误实现上失败过。

## 应用内结果

`pnpm perf:stress --release` 修复前后各跑一遍。测量时屏幕处于锁定状态：窗口不画帧，定时器被节流到约每 2 秒一次，所以只有 CPU 秒数可比。三段打字共 90 个字：

| | 修复前 `df251d31` | 修复后 `2bbb9343` |
| --- | ---: | ---: |
| WebContent CPU | 31.8 s | 21.7 s |
| 原生进程 CPU | 8.2 s | 6.9 s |

原始数据：[acceptance/keystroke-release-cpu-2026-10-30.json](acceptance/keystroke-release-cpu-2026-10-30.json)。

- `2bbb9343` 已包含上表全部写入路径改动，之后的提交只改了界面。
- 锁屏状态下每个字的 CPU 远高于前台：两次按键之间的空闲时间也计入其中，还有切换章节后的后台工作。
- 前台打字（每秒约 8 个字）的 CPU 占比，留待下一次 `--foreground` 运行补齐。
