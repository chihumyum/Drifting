# M22 要素全景 ⌘⌥4

先读 [README.md](README.md) 的共用约定。

## 要做的

全窗口的要素全景，有两种布局，**默认是「关系」**：书上次记的是「群岛」的，仍打开群岛。

**群岛**
- 每个分类一座岛，三档缩放。
- 印章大小按提及次数定；同一段里一起出现的要素之间画砂线。
- 聚焦模式。
- 浮动的岛卡可以展开成编辑器。
- 把要素拖到另一座岛就改它的分类。

**关系**
- 力导向布局，要确定性：同一本书每次算出来一样。
- 弱锚到「缩成窗口比例的岛位小地图」；边微弧；同段砂线当弱弹簧。
- 只有第一次打开和点「重新排布」时播物理落定，之后 520 ms 走到记住的位置。
- 拖动就是固定，位置按书记住。
- 弧线两端写角色名；线多（超过 60 条）或缩远时，名字只给一部分要素：远景保留提及最多的 12 个，加上聚焦要素和它的邻居。
- 对称关系在线中间写类型名。

**头部和图例**
- 群岛 / 关系切换器在头部，放在「x 类 · x 要素」计数的左边；头部挤时右边一组完整，计数省略。
- 关系线图例在内容区右上角，和故事图共用。

**作者定过要去掉的**：章节带。旧版里还有的话，这里不做。

## 旧版

- `src/renderer/shells/desktop/views/DesktopSuperElementView.tsx`（2873 行），合计约 4.2k，用到 canvas、SVG 和 d3-force。
- 关系布局在 `src/renderer/features/graph/` 下：`element-relate-layout.ts`、`useElementRelateLayout.ts`、`SuperElementRelateLayer.tsx`。
- 画布工具 `shells/desktop/components/SuperElementCanvasTools.tsx`。
- 规范在 `docs/design-system/components.md` 的「要素全景」一节。
- 关系图例 `shells/desktop/components/SuperViewRelationLegend.tsx`。
- 样式 `super-element.css`。

## 新版放哪、接哪

- 新 crate `next/crates/dr-view-element-overview`。
- **力导向**：d3-force 没有现成的 Rust 版就自己写一个确定性的模拟（固定随机种子、固定步数），不要引入 JS 运行时。新依赖要过许可门禁。
- 数据都从 F3 的查询取：
  - 提及次数和同段共现：`mention.list`；不够用就在「待协调」里请 F3 加查询，先不自己扫正文。
  - 要素、分类：`element.*`、`category.*`
  - 关系：`relation.*`、`relation_type.*`
- 写入：
  - 改分类：`element.update`
  - 拖动固定的位置：本机记忆，存进 F2 的 `local_state`，挂在书下。F6 正在把按书的本机记忆收成一处，等它定了再跟。
- 岛卡展开成编辑器：要素页（M11，`dr-view-elements`）已经有了，照它的公开接口嵌，不复制。
- 外壳挂接：F6 正在加 `dr_shell::pages::add_super_view`，切换器放进头部的 `head_start` 槽（计数左边）；图例画在正文的右上角。

## 完成标准

- 两种布局、聚焦、拖改分类、拖动固定、重新排布、切换器和图例都照旧版。
- 布局确定性测试：同一种子两次算出的坐标逐位相同。
- showcase 种子上能截一张深色、一张浅色的图放进文档。没有截图权限就在交回时说明。
- 调试桥真窗口点一遍：打开、切布局、拖一个要素到另一座岛。
- heavy 种子上首帧和每帧耗时（空闲时量，当参考）。
