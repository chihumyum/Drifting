# M21 故事图 ⌘⌥3

先读 [README.md](README.md) 的共用约定。

## 要做的

三个 Super View 里的第一个：全窗口的故事线泳道图。
- 可以切换书序或叙事序；
- 构想卡片和虚线；
- 按住 Shift 点两个节点建关系；
- 把未安放的章节拖到轴上；
- 幕轨和时间钉。

作者 2026-10-30 定过：三个 Super View 都保留，只做微调。故事图和底部时间线已经基本合成一套，剩下的只是一致性小修：
- 视图模式不要存两份；
- 绑定构想的点击行为两边一样；
- 「移到未归属」只写一份。

## 旧版

- `src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx`（1792 行）
- 三个 Super View 共用的图形核心，约 5.1k 行，在 `src/renderer/features/graph/` 下
- 样式 `graph-view.css`

关系线图例放在内容区右上角，和要素全景共用一个组件（旧版 `SuperViewRelationLegend`）。

## 新版放哪、接哪

- 新 crate `next/crates/dr-view-story-graph`。
- **能复用的先复用。** M14 底部时间线（`dr-view-timeline`，M01 那一路负责）已经有泳道布局、书序 / 叙事时、拖动的弹簧、时间钉、幕轨编辑和悬停卡。照 `dr-view-timeline` 公开的模型和布局函数用；它没公开、你又需要的，写进「待协调」请它公开，不要复制一份。一致性小修的意思就是两边用同一份数据和同一套写法。
- 写入都走 F3 的命令：
  - `chapter.place`、`chapter.spread`、`chapter.arrange`
  - `time_pin.*`、`act.*`
  - `relation.create`
  - `idea.update`（绑定）
- 关系和关系类型的界面是 M17（`dr-view-relations`），建关系后弹出选类型，就用它的选择器。
- 外壳挂接：F6 正在加 `dr_shell::pages::add_super_view`，`super_view.rs` 的舞台向登记表要正文。图例画在正文的右上角，不放进头部的槽。没进 `main` 之前先把视图和测试写好，最后一步再接。
- 打开方式：⌘⌥3，以及侧栏里的入口。这两样外壳已经有了，只是现在打开是空舞台。

## 完成标准

- 旧版故事图的功能都在，交互照旧版。差异写进文档的对照表，照 m14-timeline.md 的写法。
- 视图测试覆盖：切轴、拖章节上轴、Shift 建关系、钉子和幕轨的编辑。都用 `dr_testkit::seed` 的书。
- 调试桥在真窗口里点一遍：打开、切轴、拖一章、建一条关系。
- heavy 种子上打开和拖动的耗时（空闲时量，当参考）。
