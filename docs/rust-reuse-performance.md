# Tauri 的 Rust 复用与性能验证

2026-09-30。Tauri 是当前产品；本轮不恢复 Apple 前端迁移。基准只使用合成
数据，运行真实 renderer 服务、共享 Rust 和文件 SQLite。所有变更在同一批
结束时提交；没有收益的原型不进入产品。

## 保留的边界

- **数据库 BLOB 传输**：共享数据库 owner 不变。Tauri adapter 使用带标签的
  Base64，避免 JSON 数字数组的展开、解析和多次分配；前端仍接受原数组。
  `DatabaseValue` 的 Apple wire 表示、SQLite 数据、整数精度、事务和恢复边界
  均不变。正式基准关闭 `Uint8Array.toBase64`，验证旧 WebView 的兼容路径。
- **搜索的关闭文档冷读取**：最多 16 个 doc ID 在一次 SQLite 读事务中捕获
  原始 snapshot/tail/revision，释放事务后在临时 Yrs 文档中投影顶层块文本。
  复用 migration 的 v1 校验器，但不建立 native 编辑会话、不进行编辑修复，
  不把 Yrs 更新写回 Yjs/SQLite。空块与块序号、硬换行的文本语义、NFKC 和
  排序仍与 renderer 一致。已打开文档、种子正文、无法处理的 CRDT、revision
  不匹配和原生调用失败均走原 Yjs 路径。热缓存不触发原生文档还原。
- **Markdown ZIP 压缩**：在共享 Rust 中对现有 renderer 生成的路径/正文
  进行 DEFLATE，Tauri 使用二进制 response 返回 ZIP。本机 capture、Yjs
  正文真值、关系链接、Markdown 格式和保存对话框保持原所有者。压缩器不
  读取文件或写导出目标，拒绝重复/非相对路径，保留 256 MiB 导出上限。
  浏览器回退在交给 JSZip 前整体编码 UTF-8，修复字符串分块切断代理对、
  损坏 emoji 的缺陷。基准对比的是已修复后的 JSZip。

搜索投影引入 `drifting-prose`/Yrs 依赖，Tauri 的最低 Rust 版本随之升到 1.96；
普通 CI 和 Alpha 构建明确选择 1.96.0。共享 core 仍兼容 Rust 1.88。
本轮只更新共享库依赖锁，不刷新任何 Apple UI acceptance。

## 可复现证据

```sh
pnpm perf:rust-reuse
pnpm perf:rust-reuse:check
```

每个 runner 支持 `--quick`（只做冒烟，不作为收益验收）、`--output=...` 和
`--check`。报告包含源码指纹、可执行文件/依赖锁指纹、样本和机器环境。
这些报告只认证其产生时的源码；历史报告不应为了消除过期提示而手改指纹。
最终 Release harness 从 Tauri 的依赖锁构建，避免独立 crate 的依赖补丁版本
不同影响对照。旧 metrics/Agent/数据库 cache harness 也接受新的 BLOB 格式。

预设门槛：数据库至少两个工作负载中位数改善 10%，至少 75% 配对获胜；
搜索至少两个场景改善 20%，ZIP/完整导出至少两个场景改善 15%，均须至少
6/7 配对获胜。以上保留项均不得出现超过 5% 的场景中位数退化。

| 报告 | 测量边界 |
| --- | --- |
| [数据库传输](acceptance/database-transport-benchmark.json) | 真实查询、短 append、快照读写、正文还原、metrics；3 轮预热 + 9 对样本 |
| [关闭文档投影](acceptance/rust-cold-prose-benchmark.json) | 前端还原、完整 native 会话、只读 Yrs 三路比较；24 个兼容探针 |
| [搜索语料](acceptance/rust-search-corpus-benchmark.json) | 完整元数据读取、缓存、正文文本字段、归一化；完整语料/排名一致 |
| [ZIP 压缩](acceptance/rust-archive-benchmark.json) | 变化丰富的合成 Markdown，包含传输；CRC 与所有解压后文件字节一致 |
| [完整导出](acceptance/rust-export-benchmark.json) | SQLite capture、Yjs 还原、关系 Markdown、ZIP；不含保存对话框/磁盘写入 |

后四项使用 2 轮预热与 7 轮交替/轮转测量。每对数据库工作负载均检查完整
持久数据内容、integrity 和 foreign keys；只读路径不允许任何持久变更。
数据库写入对照只规范化时钟，以及并行 metrics 工作分配的派生 revision
顺序，Yjs 字节、原始记录与最终版本不能发生差异。

计时环境是 Node/V8 + Release Rust，管道替代 Tauri IPC；不代表 WKWebView、
UI/输入延迟或整个 Agent 回合的等比例加速。ZIP runner 为管道额外使用 Base64
往返，产品使用二进制 response。没有真实账号、真实手稿或原生 UI 验收。

## 本机正式结果

下表是每个场景一次完整计时样本的中位数（ms），多次操作的样本不是单次
调用时间；操作次数见对应 JSON。各优化独立对照，百分比不能相加。

| 场景 | 基线 ms | 优化后 ms | 耗时减少 |
| --- | ---: | ---: | ---: |
| DB: `snapshot-read-50k` | 143.80 | 14.42 | 89.97% |
| DB: `snapshot-read-200k` | 280.79 | 24.46 | 91.29% |
| DB: `snapshot-write-200k` | 783.44 | 292.17 | 62.71% |
| DB: `hydrate-50k` | 126.41 | 57.55 | 54.47% |
| DB: `metrics-first` | 508.05 | 431.63 | 15.04% |
| Search: `novel-cold` | 174.74 | 47.81 | 72.64% |
| Search: `library-cold` | 768.29 | 236.32 | 69.24% |
| Search: `very-long-chapters` | 87.66 | 35.54 | 59.46% |
| Search: `long-tails` | 213.04 | 45.54 | 78.62% |
| Search: `novel-warm` | 11.90 | 11.85 | 0.42% |
| Export: `small-book` | 28.15 | 17.65 | 37.31% |
| Export: `novel` | 173.18 | 138.83 | 19.84% |
| Export: `library` | 722.59 | 581.81 | 19.48% |
| Export: `long-chapters` | 115.64 | 91.46 | 20.91% |

数据库大 BLOB 的 JSON 往返字节减少约 65%；普通点查、工作区 capture、短
append 的波动均小于 5%。冷搜索所有场景 7/7 配对更快；24 个文本兼容探针
中 23 个精确一致，顶层 XML text 的非标准形态显式回退。ZIP 独立压缩耗时
减少约 50%–78%，完整导出减少约 19%–37%；所有解压后文件字节一致。

本批验证：3141 项前端测试通过、1 项跳过；core 120 项单元测试和 4 项
集成测试通过；只读投影/数据库搜索两项专项 Rust 测试通过；Tauri 90 项
测试通过、1 项忽略。类型检查、Rust all-targets 编译/格式、CI contract、
public boundary、Agent capability 检查通过；lint 为 0 error、70 条原有 warning。

## 筛选与停止依据

| 候选 | 本轮或已有证据 | 决定 |
| --- | --- | --- |
| BLOB 传输、冷搜索、ZIP | 本页五份报告及回退/字节一致性回归 | 按正式收益门槛保留 |
| 直接复用 native 文档会话 | 与只读投影同场比较；长正文与长 tail 带来额外会话维护成本 | 不作为 Tauri 搜索 owner |
| 原生 metrics 全替换 | [原报告](prose-metrics-rust-benchmark.md)：长文无优势，JSON/hash/outline 语义有差异 | 已保留批量读改进；不继续整模块替换 |
| 整书字面搜索 | [原报告](rust-book-search-benchmark.md)：驻留 Rust 计算也慢于 JS | 不搬搜索算法 |
| SQLite statement cache / 查询合并 | [数据库报告](database-read-write-performance.md)、[批次记录](prose-metrics-performance-batches.md)：完整操作无稳定大收益 | 不保留原型 |
| Agent 快照返回拷贝 | [Agent 报告](agent-runtime/prose-read-performance.md)：约 1% 噪声，长文回退 | 不保留原型 |
| 引用索引、原始操作/CBOR、Agent 上下文 | 已有 revision 增量/覆盖与 CAS；SHA-256 使用 WebCrypto；现成 native 投影不能直接保持所有富文本/引用语义 | 尚无同等明确且兼容的大收益证据，不继续扩大移植 |
| 资源文件与图像 | SQLite、asset store、文件操作和图像 pipeline 已有 Rust/native owner | 不另造同功能 Rust 层 |
| live Yjs、IME/undo、编辑写入 | 当前 Y.Doc/历史/持久队列是产品权威；只读投影结果不能替代它们 | 不以本轮只读数据推断整体替换收益 |

停止表示当前高把握、可界定边界的候选已经筛选完成；并不声称 Rust 对整个
产品再无优化空间。进一步移植须有新的热点证据，或明确的功能需求，不能
只根据语言选择推断性能。
