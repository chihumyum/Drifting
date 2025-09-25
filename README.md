# Drifting 前端

UI 界面是简洁的，能够赋予创作灵感的，融合现代 markdown 笔记 app 的轮廓，如 craft，但是元素饱含拟物特征，如活页本、笔记本、etc.
侧栏营造厚重质感实体的感觉，毛玻璃或者 liquid glass 之类的半透明，带高光阴影，配合主页面的类纸外观，营造镇纸的效果？

- **章节导航-左栏 1**：最左侧提供章节列表与缩略图切换，便于快速定位、排序与重命名。
  - 缩略图模式需要自动根据章节画布，构建关联关系，显示为迷你版本的、紧凑的章节画布。
- **元素设定-左栏 2**：第二列汇总整部作品的角色、地点等 element，可按阶段管理实体演化。
  - 允许添加 element 种类，element item。
  - 新建 element 和 category 的按钮会始终显示。元素面板展开时融合进去，收起时按钮脱离出来。
    **两个左栏可以 x 轴、y 轴、z 轴排列**
- **章节画布**：核心区域以卡片+连线展示章节关系，卡片支持拖拽、双击打开编辑器，标题/梗概可在卡片上直接编辑。
  - 卡片的边缘以便条形式显示一个个该章节最重要 element，如章节主角，地点等，作为类似章节 tag 的东西。
- **小说编辑器**： tiptap 基础之上实现的 block 文本编辑器。支持三级 heading，bold，italic，quote，颜色，stroke，underline 等基本样式。
  - 是单独的 route，但是展示样子像是章节画布上的 modal
  - 默认双页展示，而不是传统的 vertical scroll，取决于 screen size。也支持 vertical scroll 和单页。
  - 提供多种不干扰的 format 方式。1. slash menu 2. 右侧 format 按钮。右侧 format 按钮打开后变为竖栏，内部是所有样式，用来应用在选定片段。3.上面 format 按钮，默认隐藏
- **右侧弹出面板**：提供节点检查、关联实体，以及 TODO / 片段等辅助面板。
  - 右侧竖着排列多个按钮，点击后变为竖栏。
  - 章节画布显示 todo， snippet 等按钮，进入小说编辑器之后，额外显示 format， 章节 info 等按钮。此时将 todo, snippet 等按钮排在下方。

## 目录总览

src/
components/ # 章节导航、实体列表、侧栏等界面模块
views/ # 路由页(章节画布、编辑器、设定库等), 日后拆一下
store/ # Zustand 状态树
lib/ # SQLite 工具、事件总线、Schema 常量
schema/ # 持久层的抽象
domain/ # 业务层的抽象
repository/ # 业务层 - 持久层 bridge
workers/ # SQLite Wasm Web Worker

## 编辑器与布局改造

- TipTap 编辑器已集成 `@chi-hum/tiptap-simple-slash-menu`，Slash 菜单覆盖标题、列表、引用、代码块等常用命令。
- 编辑器右侧新增竖向工具条，提供格式、信息、页面等入口；格式按钮弹出面板，可直接应用 TipTap 支持的格式。
- Inspector / TODO / Snippets 入口改为矩形按钮：在 Graph 场景以浮动面板显示，在 Editor 场景跟随右侧工具条排列。
- 左侧章节与实体面板采用圆角卡片布局，实体面板默认收起，仅露出细边，悬停或点击展开；收起时提供独立的“新建实体 / 新建类别”快捷按钮。
