# M13 故事线页（第一个里程碑）

2026-11-08，分支 `chihumyum/m01-shelf-home-3bf938`（main `60d510a6` 之后，和 M11 第二个里程碑在同一个分支上）。计划见 [modules.md](../modules.md)。旧版是 `views/StorylineEditorView.tsx`、`KvEditor.tsx`，产品规则见 components.md 的「实体编辑器」。代码和 M11 放在一起（`next/crates/dr-view-elements/src/storyline.rs`）：故事线页和要素页、类目页是同一套实体页，共用页眉、节头、字段列表、对话框；外壳没有改，和 M11 一样经 `pages::add_page_chrome` 认 `Target::Storyline`。

## 一句话

打开一条故事线，正文上面是页眉、大的砂笔短横和名字、说明、色标、「札记」的节头，正文下面是「字段」和「章节序列」；名字、说明、字段都能直接改、照旧版的时机保存；⋯ 菜单里的「删除故事线」先问再删。旧版这一页没有设主故事线、加减章节的地方（章节序列是只读的），新版也没有。

## 做了什么（大白话）

1. **正文上面**（照旧版 `sl-overview`）：
   - **页眉**：等宽小字「故事线 · （短横）钟楼 · 15 章 · 2.6k 字」，下面一条点线。字数是这条线上各章的字数加起来（派生索引）。
   - **名字**：左边一个放大到 30 px 的砂笔短横（故事线自己的颜色），右边名字（正文字体 38 px、中等字重，会换行）。回车离开，Esc 放回原名，离开就保存；空着保存就成了「New Storyline」、和别的故事线重名加「 2」，这两样都是 F3 做的，和旧版一样。
   - **说明**：正文字体小一号、次一级的墨，回车换行，Esc 放回，离开就保存。
   - **色标**：一颗 28 px 的圆形玻璃色块，里面是故事线的颜色。旧版点它打开系统取色器；GPUI 还没有取色器，所以只显示（同类目页）。
   - 一条细线，然后「札记」的节头；正文就是编辑器。
2. **正文下面**：
   - **字段**：和要素页同一个字段列表（`fields.rs`，现在分「要素的」和「故事线的」），写的是 F3 的 `storyline.update`（`put_fields` / `remove_fields`）。空着时写旧版那句「尚无字段。新建故事线时，项目主页的「故事线字段模版」会自动填入」。
   - **章节序列**（这条线上有章节时才有）：节头右边「15 章 · 2.6k 字」；下面多选一「全部 15 / 已写 8 / 未起 7」（有字就是已写）。每章一行：章的印章（故事线的颜色，没字是空心的）、「§01」（在筛出来的列表里排第几）、章名、两行梗概（没有就写「尚未填写一句话摘要」）、一行「885字 · 已写」，右边「0.9k」和「字」，指针下一个箭头。按阅读顺序，主线、副线的章节一样列。单击预览、双击留下。
3. **⋯ 菜单**：一行危险色的「删除故事线」（`menu.rs`，等外壳给 ⋯ 菜单留出模块的位置）。旧版的「确认」框：「删除故事线「钟楼」？」，「取消」在前、危险色的「确认」在后。确认后故事线进废纸篓（F3 的 `storyline.trash`），外壳关掉它的标签；失败照旧版弹「删除故事线失败，请重试。」。
4. **文案**全是旧版九种语言的原话（`storylineEditor.*`、`common.confirm`、`common.words`、`editorTopBar.menu.deleteStoryline`）。

**要作者定的事：没有。**

## 截图

2 倍像素、1280×800、256 色，dr-testkit 的《慢钟》，故事线「钟楼」。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 故事线页 | [storyline-light](m13/storyline-light.png) | [storyline-dark](m13/storyline-dark.png) |
| 往下滚到章节序列 | [storyline-sequence-light](m13/storyline-sequence-light.png) | [storyline-sequence-dark](m13/storyline-sequence-dark.png) |
| ⋯ 删除故事线 | [storyline-delete-light](m13/storyline-delete-light.png) | [storyline-delete-dark](m13/storyline-delete-dark.png) |

```bash
cargo run -p dr-view-elements --features capture --example elements-capture -- ../docs/rust-rewrite/modules
```

## 对照旧版

| 旧版 | 新版 |
| --- | --- |
| 页眉：故事线 · 名字 · N 章 · X.Xk 字 | 有 |
| 短横记号和名字、说明、色标 | 有；色标点不开（没有取色器） |
| 札记（正文） | 有（编辑器） |
| 字段 | 有 |
| 章节模版（新章节的默认骨架） | 没有：F3 还不写正文模版（`template.rs` 的说明：要先有自己的正文文档） |
| 章节序列：筛选、每章一行、点开 | 有 |
| 主故事线、加减章节 | 旧版这一页就没有（在章节的 ⋯「编辑故事线」、悬停卡、时间线里），新版也没有 |
| 目录栏：概述、札记、字段、章节模版、章节序列 | 没有：大纲栏是外壳的，只读正文里的标题 |
| ⋯ 删除故事线 | 有（等外壳的挂接点）；「分享」是别的模块 |
| 帮手改说明、改字段的演示 | 没有，阶段 5 |

## 和旧版不一样的地方

- **说明的字号**：旧版是 `calc(var(--entity-body-font-size, 16px) - 4px)`；这里取编辑器字号小 4 px（默认 17 px 的正文就是 13 px），跟着作者设的正文大小走。
- **「已写 / 未起」一开始就有数**：旧版要等每章的字数都算好才显示（之前写「统计中…」）；新版的字数来自派生索引，读书目时就带着。
- **单击预览、双击留下**：旧版点一下就打开；新版和侧栏、作品主页、要素清单一样分预览和留下。

## 接口（给别的模块）

| 谁 | 接口 |
| --- | --- |
| 测试、调试桥 | `dr_view_elements::storyline_page(id, cx)` → `(StorylineHead, StorylineEnd)`；`StorylineHead::fields`、`StorylineEnd::{fields, listed, set_filter, filter}`；`storyline::{chapters_of, thousands}` |
| ⋯ 菜单 | `dr_view_elements::menu::rows(&Target::Storyline(..), cx)` |
| 对话框 | `dr_view_elements::dialogs::open(AskFor::DeleteStoryline(id), ws, window, cx)` |

## 测试

`cargo test -p dr-view-elements --test storyline`，GPUI 测试平台上用 dr-testkit 生成的《慢钟》（经 F3 读写，3 个）：

- 打开「钟楼」：名字和说明是存着的值；改名离开就存进 F3；两行的说明离开就存，换行原样；「新增字段」加的字段存进这条故事线。
- 章节序列：就是这条线上的章节，按阅读顺序；「已写」都有字，「未起」都没字，两边加起来是全部。
- 删除：⋯ 菜单只有一行、是危险的；打开的是「删除故事线」的确认；确认后故事线进废纸篓，外壳关掉它的标签；另开一次按 Esc，什么也没删。

## 待协调

1. **F6（dr-shell）**：⋯ 菜单让模块加行，同 [m11-elements.md 的「待协调」](m11-elements.md#待协调)第 2 条。
2. **F3（dr-workspace）**：故事线的章节模版（`chapter_template`）要能写，才能做「章节模版」一节。
3. **F5 / F7**：取色器（同 M11）。

## 还没做的

- 章节模版一节。
- 目录栏里这一页的几项。
- 帮手改说明、改字段的演示（阶段 5）。
