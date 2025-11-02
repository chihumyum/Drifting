# Drifting 前端

## UI

UI 界面是简洁的，能够赋予创作灵感的，融合现代 markdown 笔记 app 的轮廓，如 craft，但是元素饱含拟物特征，如活页本、笔记本、etc.
侧栏营造厚重质感实体的感觉，毛玻璃或者 liquid glass 之类的半透明，带高光阴影，配合主页面的类纸外观，营造镇纸的效果？

- **书本章节-左栏 1**：提供章节列表与缩略图切换，便于快速定位、排序与重命名。
  - 缩略图模式需要自动根据章节画布，构建关联关系，显示为迷你版本的、紧凑的章节画布。
- **书本元素-左栏 2**：汇总整部作品的角色、地点等 element，可按阶段管理实体演化。
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

- **元素编辑器**： 类似小说编辑器，但是将元素拉出来变成类似表的结构，进行富文本编辑。
- **不同的章节视图**： 章节画布是最重要的视图。但是也需要提供其他的可视化：
  - timeline 视图
  - 树形大纲视图

## 技术相关

- 技术选型：
  状态管理： Zustand，UI 相关的业务实体丢 state 里面，乐观更新
  persistence 层： OPFS; 用 wa-sqlite 的 OPFSCoopSyncVFS 来 bridge。

- 数据链路：

1. hook 带着 store 和 dependency 注入组件 2.前端组件操作 3.hook callback 调用 usecase 4. usecase 中 操作 state，更新 state 5. usecase 中调 repository 持久化

## 目录总览

src/
components/ # 章节导航、实体列表、侧栏等界面模块
views/ # 路由页(章节画布、编辑器、设定库等), 日后拆一下
store/ # Zustand 状态树
lib/ # SQLite 工具、事件总线、Schema 常量
usecase/ # 封装repository操作给UI层
repository/ # domain 操作 -> 转record -> 持久化
domain/ # 最前的业务层抽象
schema/ # 持久层的抽象
workers/ # SQLite Wasm Web Worker
