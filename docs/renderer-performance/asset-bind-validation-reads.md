# 每次写入时的资产绑定校验读取（2026-10-29）

## 问题

同步 reducer 每次写入（包括正文每一次按键产生的 change set）都会对**整个确定性投影**做域校验，而不只是本次变更。投影里的每个 `asset.bind` 都会单独读 5 次 SQLite：

- blob 本地状态
- `project_asset` 行
- 所有者行
- 以该资产为头像的其他要素
- 引用该资产的其他素材

重型 seed 有 36 个图片/PDF 资产，因此每次按键要多出 180 条查询，而且这个数随资产数量线性增长。

不能只校验本次 change set 的资产效果（`order.position` 是这样处理的）：被挡住的绑定，例如 blob 尚未验证的导入图片，正是靠每次写入都重新校验，才能在条件满足后落地。见 `production-domain-kernel.integration.test.ts` 中的 "lands it once it can"。

## 修复

`loadAssetBindFacts` 在校验开始前，针对投影里所有可物化的绑定，按 500 个 id 一批读出上面五类行。之后每个绑定在内存中检查，判断规则与冲突码不变。资产数量在 500 以内时，每次写入固定为 5 条查询；有头像绑定时为 6 条。

以下两个回归测试在 `src/renderer/sync/reducer/production-domain-kernel.integration.test.ts`：

- "blocks a bind whose asset or owner is already taken, or whose metadata changed" 覆盖 `asset.invalid-owner`、`asset.multiple-owners` 和 `asset.immutable-metadata-mismatch`。新旧实现都通过。
- "reads the stored rows for every bound asset in a fixed number of queries" 断言 2 个和 8 个资产时，一次无关写入的查询数相同。旧实现在这里失败。

## 实测

### 测试条件

- 实例：同一个重型 seed 实例，第 007 章，22,261 字。
- 构建：Debug + Vite + React Strict Mode。
- 方法：同一会话内替换新旧 kernel 文件并重载页面，每次重载后先输入一个预热字符。
- 测量：连续输入 8 个字，每个字形成一个 change set，记录约 32 秒窗口内的 SQL 条数、写入事务耗时和两个进程累计的 CPU 秒数。
- 窗口状态：可见但不在前台。WKWebView 此时把 rAF 节流到约 3 fps、定时器节流到约 1 秒，所以绝对耗时偏大，也不能和前台打字时的 CPU 百分比直接比较；新旧实现在同样条件下测量。

### Markdown 投影照常运行时

| | 旧实现 | 新实现 |
| --- | ---: | ---: |
| 8 次写入的 SQL 总数 | 2,228 | 828 |
| 其中资产校验读取 | 1,446 | 约 40 |
| 每次按键写入事务的语句数 | 211 | 36 |
| 每次按键写入事务耗时（中位数） | 235 ms | 113 ms |
| 原生进程 CPU（约 32 秒） | 14.3 s | 16.1 s |

### 暂停 Markdown 投影后

暂停方法：只在页面运行时把投影的 `info` 调用替换成永不返回的 promise，重载即恢复。

- 空闲 33 秒的 CPU：原生约 0.9 s，WebContent 约 0.8 s。
- 旧实现：原生 2.44–2.57 s，WebContent 2.81–3.06 s。另有一次原生 3.28 s。
- 新实现：原生 2.35–2.38 s，WebContent 3.04–3.10 s。

扣除空闲开销后，每次按键的原生 CPU 约从 200 ms 降到 185 ms；WebContent 约 270–285 ms，看不出差别。

### 结论

- 这次修复让每次按键的 SQL 减少约三分之二，保存事务耗时减半。
- 打字时原生 CPU 的主要来源是整项目 Markdown 投影：投影运行时原生进程约占 45–50%，暂停后约 7%。资产校验读取不是主要来源。
- 暂停投影后，每次按键在 Debug 下仍要花约 0.2 s 原生 CPU 和约 0.27 s WebContent CPU。尚未拆分这些开销的具体来源。
