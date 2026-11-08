# M23 审阅与素材 ⌘⌥5

先读 [README.md](README.md) 的共用约定。

## 要做的

全窗口的「货架」：一次看到大量待办、批注和素材。作者定过「现在功能够用，先不动」，所以照旧版搬过来，不加新东西。

- 待办和批注两列，宽度可以拖；
- 素材库带类型片和关系筛选；
- 底部抽屉放还没分类的素材和已解决的条目。

## 旧版

`src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx`（1572 行）和它用到的组件、样式。

## 新版放哪、接哪

- 新 crate `next/crates/dr-view-shelf-review`。名字可以改，别和书架的 `dr-view-shelf` 混。
- 审阅卡和待办卡：右栏审阅是 M18（`dr-view-review`，F4d 那一路）。卡片、来源悬停卡、原地编辑、撰写框都照它的公开接口用；缺的写进「待协调」。
- 素材卡和素材夹：M19（`dr-view-material` 是图片和 PDF 的查看器，素材笔记在 `dr-editor`）。打开素材走外壳的导航。
- 数据：`comment.*`、`todo.project`、`material.*`、`material_folder.*`、`relation.list`。
- 外壳挂接：F6 正在加 `dr_shell::pages::add_super_view`。

## 完成标准

- 旧版的两列、筛选、抽屉、拖宽都在。
- 视图测试：筛选、解决一条批注后它进抽屉、拖宽后宽度记住。
- 调试桥真窗口点一遍。
