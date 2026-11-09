# K4 G1：页面与正文

分支 `codex/k4-g1-pages`，交回指针 `handback/k4-g1`。从 main 开独立检出；
2026-11-09 已同步 main `df72fe87`（含 K4-0 第二次交回与 G3 第一段），不合 main，不推送。

按三段交回：模块渲染器；通览全书与人物链接；条目快照历史。v2.2 路径保留。
实现中的内容不视为验收完成；检查与真窗口证据随各次交回补齐。

## 模块渲染器（第一段）

按公共 DTO 的实际 kind 注册 `prose`、`fields`、`kv`、`patches`、`plot_grid`、
`relations`。`about` 仍由外壳作为 prose 模块送入。每一篇正文各自持有
`ChapterEditor` 与 `SessionSource`，刷新只交新快照，不重建编辑器；小说章节与
构想的章首、章末复用 M03，摘要与状态按字段角色写入，主归属颜色按颜色角色读取。
字段输入沿用 dr-ui，键值表与情节规划复用既有控件；补丁写入保留来源。

契约在所属 crate 的测试中断言，不提交手写的通过结果：

- `dr-view-page/tests/v3.rs`：刷新保留实例、双正文撤销隔离、章节字段角色、
  种子批注按正文模块定位、新章异步加载后的标题焦点。
- `dr-view-elements/tests/v3_fields.rs`：数字／日期校验、别名转换、刷新不覆盖
  输入、失败后继续编辑并提交。
- `dr-view-plot/tests/v3.rs`：编辑保留其他格和另一模块，失效的格不覆盖现存数据。
- `prose-bench … --v3` 使用 F8 的 v3-heavy，沿用原基准的打开和滚动测量方法；
  不替换旧种子，不覆盖 F4e 的旧证据。

## 待协调

1. **K4-0：组合页登记正文编辑器。** `Rendered` 目前只交 view、focus、refresh、
   reveal，外壳的统一编辑器表不知道模块内的 `ChapterEditor`。需要给模块一个
   登记/释放 `ChapterEditor` 的接口（标明条目和模块），使批注入口、页内搜索、
   主题和偏好变化、沉浸写作、保存阅读位置以及调试桥 `page.text`/选择状态消费
   真正的编辑器。G1 当前提供 `BodyModule::editor()`；宿主应登记正在挂载的实例，
   区分同一正文的多个标签页，不应另开会话或用全局 doc→单实例表替代。
2. **K1 与整合者：带模块的人物链接。** G1 接管链接消费者和 URL 约定，但
   `dr_model::prose::EntityLink` 没有 module；`ProseTxn::link_entity` 的编码只接受
   这个旧结构，且 `Material` 仍按 v2.2 的规则被拒。需在公共模型和 dr-doc 加
   版本明确的带模块链接读写接口，保持 v2.2 的允许种类不变。这两个 crate 不在
   G1 可改范围内，G1 不绕过文档事务写原始 Loro，不把模块偷偷编码进目标 id。
3. **K4-0：正文的页面空间。** 组合页外层固定画条目标题和每个模块的名字，再给
   所有模块一个外层滚动；章节正文已有章首、章末和虚拟滚动。需要外壳提供正文
   模块占用稿纸视口的布局契约，并避免小说章页出现两份标题。当前模块内暂用
   独立视口保留虚拟化，不把展开所有段落当作 heavy 的解决办法。
4. **K2：情节规划的并发粒度。** v3 当前仅有 `module.put_grid` 整网格写入；
   G1 复用原规划器的输入/布局，提交前重读后只应用本批编辑，但读取与整网格
   提交之间仍缺 revision/CAS 或逐格命令。需要公共命令提供条件写或逐格修改，
   才能承诺与另一窗口/帮手并发编辑不同格时不覆盖它的更新。
5. **K2／G4：带模块的批注命令。** 当前 `comment.create` 的 target 没有 module，
   `comment.reanchor`、`todo.project`、`comment.update` 都走 v2.2 的 `cx.book`。
   G1 按 `CommentV3.target_module` 读取种子批注并画砂笔，但从浮条创建批注、
   撤销后的重锚和 TODO 投影还需要版本化命令。不能把显示已有批注算成新建／
   重锚／审阅端到端验收通过。
6. **F5：长选项列表。** 现有 `dr-ui::Select` 没有选项视口高度／滚动参数；
   条目引用和关联候选多时，菜单末尾超出窗口。需要公共选择器的有界滚动或
   搜索入口，不能把 lite 中选第一个条目的场景当作 heavy 全候选可达。

## 第一段验收记录

真窗口脚本在 `next/crates/dr-view-page/scenarios/`。从 `next/` 运行：

```bash
CARGO_BUILD_JOBS=3 cargo build -p drifting --features debug-bridge --locked
cargo drifting workspace scenario crates/dr-view-page/scenarios/body.json \
  --app target/debug/drifting --out target/k4-g1-body
```

其余脚本以同样方式运行。每次由 runner 建立独立临时库和应用身份，不使用日用库；
v3 场景均从 `seed:v3-lite` 生成，额外字段、模块和关系类型仅为测试元数据。
脚本先用既有快捷键收起默认时间线，再验收 G1 稿纸交互。
脚本由命令回读断言保存结果；截图与 runner 结果留在忽略的 `target/`。

- `body.json`：真实输入与撤销、章首、斜杠 H1、选区浮条、⁂ 完稿、新建下一章、
  新章标题自动全选和回车接正文、层级 about 输入。新建和改名等待实际页面状态，
  不用固定 1 秒代替快照到达。
- `two-bodies.json`：同页两个正文，分别输入、分别撤销，另一篇内容保持。
- `fields.json`：文字、长文字、数字、日期、单选、多选、别名和条目引用回读；
  图片选择器在 lite 没有图片资产时保持可见的空选项。实际图片选取／新增后刷新
  尚未完成真窗口验收，不把空列表检查计为这两项通过。
- `controls.json`：键值表保留原行 id／pos，新行、补丁标题与正文失焦保存；情节格
  编辑后回读，原格／其他模块保留由契约测试覆盖。
- `relations.json`：新建关系、点击条目跳转、返回删除，关系列表回到初始值。
- `v2-chrome.json`：以已有 M03 场景为基础，保留 v2.2 标题、梗概、正文输入、
  Esc 撤销字段编辑与章末菜单展示；为异步写回增加等待，不改旧实现。
  旧场景的“回到草稿”点击探针未稳定完成状态切换，未计入通过项；旧实现未改。

### v3-heavy 测量

生成证据：[`k4-g1-modules-prose-bench-window.json`](../acceptance/k4-g1-modules-prose-bench-window.json)。
release，M3 Pro，内屏 120 Hz；100 章、1,649,538 字符。沿用 F4e 的真实编辑器
会话和 GPUI 窗口基准，`--v3` 只切换到 F8 的 v3-heavy 和成书顺序。

| 测量 | 结果 |
| --- | ---: |
| 全书会话／文档冷开；热开两次 | 61.86；17.32／16.61 ms |
| 全书首屏呈现冷开；热开两次 | 90.32；19.86／21.15 ms |
| 最长单章首屏呈现中位数 | 13.43 ms |
| 滚动绘制工作 p95 | 1.387 ms |
| 滚动帧间隔 p95；最大值 | 11.319；487.667 ms |
| 滚动到全书末尾 | 4,238 帧，39.9 秒，reached_end=true |

F4e 的旧 headless 基线是全书会话／文档冷 52.8 ms、热 14–15 ms；它不包含首屏
呈现。旧 decor 基线滚动 CPU p95 为 0.157→0.248 ms，测量方法和装饰数量不同，
不直接把本次窗口数据当作倍率回归。本次一分钟负载 16.47→18.67，自动标记
`reference_only=true`，只能作为忙机参考，尚不能判定空闲性能是否退化。
这也不是外壳 `Book::load` 加模块组合页的端到端打开时间。
