# 仓库会话留下的活

2026-11-08，Claude 的用量快用完了。原来由 Claude 会话负责的基座（F1–F8）和已经开工的模块，后面的活也交给外部代理。每一路的细节在它自己的文档里，看「下一步」「待协调」「没做的」那几节；这里只列要点和先后。共用约定照 [README.md](README.md)，合并照 [integration.md](integration.md)。

以前「谁管哪里」的分工（README）作废：现在谁接哪一项，就动哪一项要动的 crate。但同一时间同一个 crate 只让一个代理改，开工前在自己的队列里写清楚。

## 基座

- **F2 dr-store**（[f2-store.md](../foundations/f2-store.md)）
  - ~~持有者在写入任务开始前设好提交选项（F1 要）~~：F2 第七轮已做，第二十批整合；
  - 备份在几百 MB 的合成库上量（空闲时）；
  - ~~迁移 0007 的审查意见~~：F2 第七轮已交，第二十批整合；M27 恢复与日志建议转 Codex 队列，M36 拒绝更新的处理以 M27 的现行文档为准。
- **F3 dr-workspace**（[f3-workspace.md](../foundations/f3-workspace.md)）
  - ~~`chapter.create` 带叙事位置~~：F3 第十轮已做，第二十一批整合；时间线 UI 仍需改成一次调用。
  - ~~M16 要的构想转换、绑幕和时间钉命令~~：F3 第十轮已交。实际接口为 `idea.to_chapter { book, id, storyline? }`（返回 `{ id, title, book_order }`）和 `idea.to_element { book, id, category?, name? }`（返回 `{ id, name }`），不是旧约定的 `idea.convert`。两种转换一步撤销；绑定使用已有 `act.update`、`time_pin.create/update`。M16 界面需按实际接口接线，见 F3 文档。
  - 空闲时跑 bench，补补链提速的证据。
  - F2 第七轮已提前设提交选项；F3 的相同设置可择机去重（不影响行为）。
  - M29 后续需要：按稳定 block id 和版本的结构／富文本编辑、恢复点标签与版本检查原子挂接、带版本的准确级联影响查询。M29 本批未合，先修 Codex 队列里的两个隐藏关系读写屏障问题。
- **F4 编辑引擎**（[f4e-editor.md](../foundations/f4e-editor.md)「下一轮怎么拆」）
  - 章末 ⁂ 的帮手审阅（等 M30）；
  - 空闲时重跑 `prose-bench`；
  - 发布前给 GPUI 打两个补丁：按键后立刻交出画面（G1）、空闲时停 CVDisplayLink（f4-editor.md 补丁表）。
- **F4c 输入**（[f4c-input.md](../foundations/f4c-input.md)）
  - ~~Windows 输入法组字中失焦丢弃的第四轮实现~~：第二十二批已合，真实微软拼音及 ARM 验收仍未做；
  - 旧模块收尾接续：dr-ui 单行／多行输入框处理空无范围上屏、窗口失活取消和迟到输入，与编辑器对齐；编辑器 macOS 丢弃组字改用窗口自身 inputContext。具体接口与回归要求见 F4c 待协调 12、14；
  - 同一正文内点击时的组字策略需要作者决定，保持现状，不擅自改变；
  - 读屏、跨章选区、列表按键的手测清单给作者。
- **F4d 画层与素材**（[f4d-render.md](../foundations/f4d-render.md)、[m19-materials.md](../modules/m19-materials.md)）：M19 素材笔记的编辑配置里，任务、代码、提示框等旧版有、新版还缺的块。
- **F5 dr-ui**（[f5-ui.md](../foundations/f5-ui.md)）：数字写法还有两份没并：`dr-view-stats` 的 `model::grouped`（带符号）、`dr-shell` 的 `chapter_sort::compact_words`，并进 `dr_i18n::number`。
- **F6 dr-shell**（[f6-shell.md](../foundations/f6-shell.md)）
  - 悬停卡能固定打开（截图用），泳道名字的卡开在名字旁边（M14 要）；
  - 键盘框架（Tab 进出 ⁂、侧栏方向键）要等作者定设计；
  - 冷启动空闲时重测。
- **F7 dr-platform**（[f7-platform.md](../foundations/f7-platform.md)「下一个里程碑建议」）：交接、符号上传、Windows 实机、发布档关掉 `runtime_shaders`，这些都要作者同意或动手，先列给作者。
- **F8 dr-testkit**（[f8-testkit.md](../foundations/f8-testkit.md)）
  - 真窗口场景补上：M25 书架封面、M14 时间线、M15 情节规划、M24 字海和首次体验、M26 沉浸写作、M16 构想、M19 素材库；
  - 空闲时重测过期的测量证据。`m10-m4-import` 要 0.1 的样例库，照旧标过时。

## 已开工的模块

- **M01–M02**（[m01-shelf.md](../modules/m01-shelf.md)、[m02-home.md](../modules/m02-home.md)）
  - 时间线片段和泳道卡的截图（等 F6 能固定打开卡）；
  - 叙事时双击新建一步撤销（F3 第十轮已给 `chapter.create.narrative_order`，待 M14 换成一次调用）。
- **M03**：⁂ 的键盘操作（等 F6 键盘框架）；构想页页眉写出它所在的组。
- **M09**：帮手里进历史快照的入口（等 M31）。
- **M16**（原 M10 那一路已停在 `7a4cc87d`）：原面板真窗口场景 `09e94777` 已在第二十三批接收（补去重断言后 54 步通过）；第二里程碑 `805e2064` / `7a4cc87d` 先修后收，交旧模块收尾会话承接：
  - 分支仍调用不存在的 `idea.convert`，确认键一直禁用；接上已合 main 的 `idea.to_chapter` / `idea.to_element`，改为两种转换的正向测试（不能允许 UnknownCommand 通过），补真实窗口转换及一步撤销。
  - `tray.rs` 的固定宽卡片在横向滚动容器直接 `justify_center`，多卡窄窗口时首卡落到不可滚回的负坐标；照旧版 safe center 做“放得下居中、溢出从起点排列”，补窄窗口可达性测试。此项来自代码与锁定布局实现的静态核对，尚未做真窗口复现。
  - 绑定弹窗打开时的占用过滤不能保证全局独占；F3 时间钉只排斥别的时间钉，幕未检查占用。接入 M14 前对照旧版统一幕/钉的占用语义，补过期快照、冲突及失败反馈；不能宣称已经保证“一条构想只绑一处”。
  - 侧栏排序／右侧元数据偏好接 F6 已有的 `book_memory`；共享悬停卡的英文长标签越出右边界，补宽度约束及布局验收。
  - 修好后重生成转换截图（`7a4cc87d` 把确认键置灰后原截图未更新），再交回；M14 绑定弹窗、M21/M22 托盘宿主仍是独立挂接点。
- **M17**：章节、构想页要不要也挂「关联」，照旧版定。
- **M24、M26**：真窗口里看一遍。观感要作者看。
- **M40**（[m40-markdown-folder.md](../modules/m40-markdown-folder.md)「待协调」）：第二期。
- **M41**：~~备份、核对、恢复的对话框换成真进度~~（第二十四批 `fab79905`）；PDF 字体家族等 M08 设置可供选择后再接，发布搬运仍在原交接范围。

## 阶段 7（全部模块做完以后）

照 [simplifications.md 第七节](../simplifications.md)：
- 冻结旧库测试库；
- 发最后一个旧版，带交接；
- 删 TS、Tauri、yrs；
- 重建门禁。

这一步要作者一路定，不要自己开始。
