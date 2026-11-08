# M19 素材：查看器与素材库

2026-11-08。第一部分：图片和 PDF 的缩放、平移、翻页，和画在上面的区域批注（下面前几节）。第二部分（同一天）：右栏「素材库」标签，素材夹树的拖放、多选、移动，拖入和粘贴文件导入，见[「第二部分：素材库」](#第二部分素材库)；给 M23 的接口写在[那一节的末尾](#给-m23-的接口)。计划见 [modules.md 的 M19](../modules.md)。代码在 `next/crates/dr-view-material/`。第三部分补素材页动作菜单，见本文末尾。素材笔记已使用 F4 的列表、任务块、代码块、提示框、表格和斜杠菜单；这不等于旧版笔记的任务 → TODO 自动投射已经补齐。M19 尚未完成，逐项缺口见「待协调」及第三部分的核对。

## 做了什么（大白话）

1. **图片和 PDF 素材有了自己的整页。** 以前打开它们是一个空的正文编辑器；现在是一个查看器：上面是标题和描述（就地改，标题回车或离开就存，描述离开就存），下面是画面。页面不放在稿纸上，直接铺在桌面上占满宽度，图片（或 PDF 的当前页）自己就是桌上抬起来的那张纸，和旧版桌面壳一样。文字素材（作者的笔记）还是在正文编辑器里打开。
2. **缩放。** ⌘ + 滚轮、触控板捏合、工具栏的 − 和 +（每次 1.25 倍），或者 ⌘= 和 ⌘-。以指针所在的点为中心缩放：那一点在屏幕上不动。范围是「适配大小」的 0.5 到 6 倍。点工具栏中间的百分比、双击画面或 ⌘0 回到适配。
3. **平移。** 放大以后拖动画面，或者直接用滚轮（不按 ⌘），画面跟着走。适配大小或更小时没东西可移，画面回到正中。新加的一条：拖得再远，也至少留 48 px 在台面上（旧版能把图拖丢）。
4. **怎么适配。** 图片最大到它自己的像素大小，不放大糊掉；PDF 页最大 1.8 倍、最小 0.18 倍（这两条照旧版）。新的一条：画面四周留 16 px 桌面，顶上让出工具栏那一条（56 px），有多页时底下再让出翻页条那一条（64 px），所以适配大小时工具栏和翻页条都不压在画面上（旧版是盖在上面的）。
5. **PDF 翻页。** 一次看一页。底部一个玻璃药丸「‹ 2 / 3 ›」，或者按 ← / →。每一页都按它显示出来的大小（再乘屏幕倍率）渲染，不糊；放大以后停手 120 ms 再按新大小重画一次（大小差 15% 以上才重画），一页最多 4096 × 4096 像素。
6. **区域批注。** 工具栏第一个按钮「框选批注」，按下后画面上的光标变成十字，拖出一个矩形；松手的地方浮出和审阅里一样的撰写框（批注 | TODO、一张纸片、取消和保存），写的时候那块矩形一直用虚线框着（旧版松手就不见了）。存下的批注记住这块矩形：存的是它占图片（或那一页）的比例，所以怎么缩放都不走位；PDF 还记着页码。拖得太小（不到画面的 1%）不算。Esc 结束框选，存完一条也自动结束。
7. **矩形怎么画。** 用砂笔干框（和侧栏选中格子的那种笔触同一套）：平时淡淡的在那儿，指针指着更深，被选中时沿着框重新画一遍；已解决的更淡。每个矩形固定一笔，不会每次换样子。左上角一个砂笔印章，里面是编号（印章用批注色或 TODO 色本色，深色主题下压在浅色图上也看得见）。TODO 用 TODO 色，批注用批注色，和审阅卡一样。
8. **右边的批注列。** 有批注或正在框选时出现，300 px 宽。按阅读顺序排：有区域的按页、从上往下，然后是挂在整条素材上的；编号和画面上的印章一致。指着一张卡，画面上对应的矩形变深；指着矩形，对应的卡亮起来。点卡就选中它、翻到它那一页；卡上可以「解决」和「重新打开」。

## PDF 用哪个库：hayro

结论：**用 hayro**。

| | hayro 0.9.0 | pdfium-render 0.9.5 |
| --- | --- | --- |
| 是什么 | 纯 Rust 写的 PDF 光栅化器（Laurenz Stampfl，typst 那边的人） | 一层 Rust 包装，真正干活的是 PDFium（Chromium 里的 PDF 引擎，C++） |
| 许可 | Apache-2.0 或 MIT；依赖也都是 Apache-2.0 / MIT / BSD-3-Clause。随包内嵌的 14 种标准字体是 Foxit 字体（PDFium 的 BSD-3 许可），CMYK 用的 ICC 是 CC0。`cargo xtask check` 的许可门禁全过 | 包装 MIT 或 Apache-2.0；PDFium 本身 BSD-3 / Apache-2.0 |
| 要另装的东西 | 没有：编进程序里，代码里禁止 `unsafe` | 要另拿 PDFium 的二进制：macOS 系统不带，得从 bblanchon/pdfium-binaries 下载每个平台的动态库跟着应用一起发（再签名），或者自己编静态库。按这次的约束不下载，所以没有实测它 |
| 体积 | 发布版试跑程序 6.86 MB，只有 PNG 编码的对照程序 0.57 MB：多出约 6.3 MB（其中标准字体和 CMap 约 0.55 MB） | 没下载，没量 |
| 渲染质量 | CPU 光栅化（vello_cpu），有抗锯齿；回归测试里有 1000 多份取自 pdf.js 和 PDFBox 测试集的 PDF。不支持加密的 PDF，也不支持混合模式、隔离组、挖空组等少数特性 | 最全：Chrome 自带的 PDF 阅读器就是它，加密和表单都支持 |
| 速度（试跑，发布版，负载 57，只作参考） | A5 一页：1 倍第一次 9–26 ms（含第一次加载字体），2 倍 0.5–1.7 ms，4 倍 2.5–8.3 ms | — |

为什么选 hayro：不用另装任何东西，许可干净，作者放进来的参考资料（看、放大、圈出来批注）它都画得好。代价是加密的 PDF 打不开（页面上显示「无法打开 PDF」），以及少数复杂特效画不全。以后真遇到大量画不好的文件，再考虑 pdfium，那时先要定下它的二进制怎么跟着应用分发。

**中文。** PDF 里没嵌字体的中文（文件里只写了个字体名，比如 `STSong-Light`），hayro 默认画不出来。我们把界面自己带的 Drifting Sans（思源黑体的字形）交给它做中、日、韩文字的回退，测过能画出来；其余没嵌的字体回退到最接近的标准字体。

## 定下的事

- **图片和 PDF 素材整页交给模块画。** 外壳新加了 `pages::add_page_view`：打开页面前先问模块，模块答了就不开正文编辑器。文字素材不答，照旧进编辑器。
- **页面铺在桌面上、全宽，没有稿纸。** 和旧版壳模式一样，图片自己就是那张纸。
- **区域存比例（0–1），PDF 还存页码（从 1 起）。** 读出来超出画面的当作没有区域（F1 的规则，旧版 `parseMaterialRegion`）。
- **`comment.create` 多了 `region`。** 只能挂在图片或 PDF 素材上，不能和 `range` 同时给；`comment.list` 每条多一个 `region`。
- **图片先读 display 变体，没有就读原文件。** 解码后最长边限 4096 px（显示变体本来就有上限；没有它时防原图太大）。

## 外壳和共用文件里的挂接点

| 文件 | 改了什么 |
| --- | --- |
| `dr-shell/src/pages.rs` | 新的登记口 `add_page_view(cx, \|target, PageViewHost, window, cx\| Option<ModulePage>)`；`ModulePage { view, focus }`、`PageViewHost { workspace, library, book_id, book }` |
| `dr-shell/src/workspace/editors.rs` | `prepare_editor` 先问 `page_view_for`，有答案就存成 `PageEditor::module(page)`（不开编辑器）；`PageEditor` 多一个 `module` 字段；`Workspace::module_page(&Target)`；「焦点给当前页」把模块页的焦点当编辑器一样：素材标签到前面时页面拿键盘（←/→ 立刻能翻页），切回章节时编辑器把键盘拿回去 |
| `dr-shell/src/workspace/stage.rs` | `paper()` 遇到模块页：直接铺在桌面上、全宽，不画稿纸 |
| `dr-workspace` | `CommentCreateIn.region`、`CommentInfo.region`、`dto::Region`（`to_model()` 校验）；能力清单的两个快照跟着更新（只多了 `region` 和 `comment.create` 的一句说明） |
| `dr-view-review/src/composer.rs` | 撰写框的锚点改成 `Anchor::Range` 或 `Anchor::Region`；新的 `CommentComposer::for_region`；`new` 的签名没变 |
| `dr-ui/src/sand/mod.rs` | `SandFrame` 加了 `.rest(强度)`（没选中时留着的淡框）和 `.seed(种子)`（固定一笔）；不用这两个时和原来一样 |
| `dr-testkit/src/media.rs`（新） | 合成的 PNG（一张地图）和 PDF（三页 A5 的潮汐笔记：Helvetica 和没嵌字体的中文） |
| `dr-i18n/keys.txt` | 十九个旧版词条：放大、缩小、适配窗口、框选批注、结束批注、提示语、第几页、整条素材、加载中、无法预览、上一页、下一页等 |
| 应用（`app/drifting`） | `main.rs` 在 `dr_view_elements::init(cx)` 后面加了 `dr_view_material::init(cx)`；`Cargo.toml` 加依赖 |

## 截图

`DRIFTING_FONTS_DIR=… cargo run -p dr-view-material --features capture --example m19-capture -- ../docs/rust-rewrite/modules`（在 `next/` 下）。离屏画整个外壳，书是 dr-testkit 的《慢钟》，图片和 PDF 是 dr-testkit 的合成画面，上面的批注是截图程序现写的。2 倍像素 2560 × 1600，压成 256 色，每张 0.14–0.27 MB。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 图片素材：标题和描述，图在桌上；湖上一条批注（被选中，框刚重画过）、街区上一条 TODO（指针指着，卡亮着），右边三条批注，最后一条挂在整张图上 | [image-light](m19/image-light.png) | [image-dark](m19/image-dark.png) |
| PDF 第一页：中文那一行有一条批注（Drifting Sans 回退画的中文），底部翻页条「1 / 3」，右边两条批注（第二条在第 2 页） | [pdf-light](m19/pdf-light.png) | [pdf-dark](m19/pdf-dark.png) |
| 放大 2.2 倍、框选中：工具栏「框选批注」亮着，下面一行提示，正在拖的虚线框 | [draw-light](m19/draw-light.png) | [draw-dark](m19/draw-dark.png) |
| 松手后撰写框出现在松手处，那块矩形还框着 | [compose-light](m19/compose-light.png) | [compose-dark](m19/compose-dark.png) |

## 数字

截图程序顺手量的（debug 构建，离屏，负载 40–50，**只作参考**；同一天负载更高时量到的三个数是 817.8 / 563.6 / 473.6 ms）：

| 项 | 数 |
| --- | ---: |
| 打开图片素材页到画面出来（读 1600 × 1000 的原图、解码、转成 GPUI 位图） | 971.3 ms |
| 打开 PDF 素材页到第一页画出来（读文件、hayro 打开、按显示大小渲染第一页） | 451.1 ms |
| 翻一页到这一页画出来 | 594.5 ms |

debug 构建里 hayro 和图片解码都没优化，发布版会快很多（试跑的发布版一页 A5 渲染 0.5–26 ms，见上面的表）。这几个数里大半是离屏测试平台一帧一帧推进的等待，等空闲时用发布版再量。

## 测试

- `dr-view-material`：
  - `viewport` 单元测试：指针下的点缩放不动、缩放上下限、适配大小才不能平移、拖远了留 48 px、工具栏和翻页条那两条让出来、图片不放大和留边、PDF 留边和倍率上下限、画面框和比例互算、渲染倍率不超像素上限和 15% 才重画。
  - `regions` 单元测试：拖出的矩形夹在画面里、太小不算、按页再从上往下排和编号、指针下取最小的那个。
  - `media` 单元测试：图片解码成 GPUI 的 BGRA、超过 4096 缩小、坏文件报错；PDF 三页的尺寸、按倍率渲染、红框在该在的地方、坏 PDF 和不存在的页报错；标准字体的字画出来了，有字体时中文也画出来了。
  - `tests/material.rs`（GPUI 测试平台，真书库）：图片适配、⌘ + 滚轮以指针为中心放大（指针下的点不动）、捏合、拖动平移、工具栏 +、双击回适配、适配时普通滚轮不动；PDF 三页、按显示大小渲染、→ 和 ← 翻页、翻过头停在最后一页、放大后重画得更大；没框选时拖动不出撰写框、框选时太小不算、真的框出来撰写框带着第 2 页的区域、存下后列里多一条并选中、框选结束；列按页排、选中第 3 页的那条就翻到第 3 页、指针指着矩形、点矩形选中它；素材的文件没了显示无法预览。
- `dr-shell`：`a_module_draws_a_whole_page_instead_of_an_editor`（模块答了就不开编辑器、章节照旧开编辑器、关标签放掉模块页）。
- `dr-testkit`：合成 PNG 和 PDF 的格式（PDF 的交叉引用指得对）。
- `dr-workspace`：`region_comments_sit_on_image_and_pdf_materials`（PDF 素材上的区域存下、列出来带着它；浮动、文字素材、章节、超出画面、和 `range` 一起给都拒绝）。
- `dr-ui`：`a_resting_frame_stays_faint_and_keeps_its_stroke`（`SandFrame` 的静止强度和固定笔触）。

## 待协调

1. **全屏（旧版的 ⤢ 灯箱）没做。**
2. **来源说明与关联仍缺**：AI 生成信息、曾是谁的设定图，以及通用关联的关系标签/选择器。⋯ 菜单的「用默认应用打开」「移到素材夹」「删除素材」已在第三部分补上；笔记的任务 → TODO 开关尚缺实际投射行为，不能只放一个开关。
3. **HEIC 读不了**（旧版靠系统解码）。图片导入的 display / thumbnail 管线已由第二部分 `import.rs` 实现（2048 px / 256 px，PDF 首图）；这一项过去的「没有管线」记载已过时。
4. **列里的卡比审阅卡简单**：没有双击编辑、来源卡、删除、转 TODO（这些在右栏审阅里能做）。
5. **从审阅卡点箭头跳到区域批注**：会打开素材页，但还不会选中那条、翻到那一页。要外壳把「打开并定位到某条批注」传给模块页。
6. **加密的 PDF 打不开**（hayro 不支持），页面上显示「无法打开 PDF」。
7. **深色主题下，白色 PDF 页上的区域框偏淡。** 砂笔在深色主题里往白里提（为了压在深色桌面上），落在白纸上就淡了。要不要让画面上的砂笔不提亮，留给设计定。
8. 截图时用的是另一个工作区已经构建好的字体缓存（只读，`DRIFTING_FONTS_DIR`），这个工作区没有构建字体。

## 代码位置

- `next/crates/dr-view-material/src/page.rs`：整页（页头、台面、工具栏、翻页条、矩形、批注列、撰写框）。
- `next/crates/dr-view-material/src/media.rs`：读文件、解码图片、hayro 渲染 PDF、中文回退字体。
- `next/crates/dr-view-material/src/viewport.rs`、`regions.rs`：缩放平移和矩形的计算。
- `next/crates/dr-view-material/examples/m19-capture.rs`：截图。

## 第二部分：素材库

### 做了什么（大白话）

1. **右栏「素材库」标签有了自己的面板。** 以前外壳只是把素材夹和素材一行行列出来；现在由 `dr-view-material` 画（外壳新加的登记口 `pages::set_library`，和「帮手」标签同一种写法，单独一个提交）。
2. **头一行。** 左边「当前」：打开后只列和前面那一页（章节、要素、素材……）有关联的素材；中间「8 素材」；右边三个按钮：审阅与素材（打开那个全屏视图）、新建素材夹、+（下拉两项：「笔记」新建一条笔记并打开来写，「从文件导入图片或 PDF…」打开系统的选文件框）。
3. **一棵素材夹树。** 素材夹是细行，用结构字体，前面是展开箭头和文件夹图标，后面是它下面一共有几条素材；素材是高一点的格子：素材记号、一个 32 px 的缩略图（笔记是一个纸的图标）、标题，标题下面一行淡字——笔记显示开头几个字，图片和 PDF 显示「图片」「PDF」。素材夹按名字排，素材有标题的在前、按标题排（数字按大小），没标题的在后。前面正打开的那条素材，砂笔框围着它。
4. **点击。** 点素材打开它（双击保持标签），点素材夹展开或收起；⌘ 点一下加选或减选，⇧ 点一下选一段，被选中的几行底下有一层淡色；⌥ 点素材夹把它里面的全部展开或收起；⌘A 全选，Esc 取消。新建的素材夹、笔记和导入的文件，都放进最后点过的那个素材夹（点列表底下的空白处回到最外层）。
5. **悬停卡**（和别处一样，没有右键菜单）：素材有「打开」「在系统 app 中打开」（图片和 PDF）「重命名」，素材夹有「在其中新建素材夹」「全部展开」「全部收起」「重命名」；都有「移动到素材夹…」——卡里直接列出最外层和每个素材夹的路径（「东岸 / 旧城」），点一下就移过去，它现在所在的那一个是亮着的、点不了；最后是删除（红字）。如果这一行在一组多选里，卡就对整组：「将 3 项移动到素材夹…」「删除 3 项」。删除前先问一句（旧版的原话）；素材夹删掉时，里面的东西挪到上一层，不会删素材。
6. **重命名**就在行里：名字变成输入框，回车或点别处保存，Esc 放弃。新建的素材夹一出现就进入重命名。
7. **拖动。** 把一行（或它所在的那组）拖到素材夹上就移进去，拖到某条素材上就移进那条素材所在的素材夹，拖到列表空白处就移到最外层；拖着的时候指针下面跟着一张小卡（标题，或「3 素材」），能放的地方底下浮起一层淡色。素材夹不会被移进它自己或它下面的素材夹（F3 会拒绝，它留在原地）。
8. **导入文件。** 从系统里把文件拖进来（拖到哪个素材夹就进哪个），或者复制了图片或文件以后在面板里按 ⌘V，或者用 + 里的选文件框：图片（PNG、JPEG、GIF、WebP、BMP、TIFF）和 PDF 变成素材，标题是文件名去掉扩展名；导入时就生成显示用的副本（最长边 2048 px）和缩略图（256 px），PDF 生成第一页的缩略图。别的文件（Word、HEIC 等）跳过，底部提示「无法导入文件：……」列出名字。导入期间面板顶上有一行「导入中…」。

### 定下的事

- **素材库的面板由模块画。** 外壳只负责在标签里放它（`set_library`），没有登记模块时照旧自己列。
- **移动是一条一条的命令。** 移 3 项就是 3 步撤销，和 F3 现在的命令粒度一致；以后需要可以合成一步。
- **缩略图在导入时就做。** 现成没有缩略图的旧素材，面板第一次要显示时在后台做一个（不写回库里）。
- **「当前」按关系筛。** 读 F3 的 `relation.list`（前面那一页的全部关系），另一端是素材的就算。

### 外壳和共用文件里的挂接点

| 文件 | 改了什么 |
| --- | --- |
| `dr-shell/src/pages.rs`、`workspace/{mod,sidebar}.rs` | 单独提交 ab2a2c6f：`set_library`、`library_for`；`Workspace.library_panel`（每个半栏一份，换书时清空）；`right_header` / `right_body` 的「素材库」先问模块 |
| `dr-ui/src/components/cell.rs` | `SandCell` 加了 `.lead(元素)`（最前面放自己的东西：展开箭头和图标、缩略图）和 `.subline(文字)`（名字下面一行淡字，行高跟着变）；不用时和原来一样 |
| `dr-i18n/keys.txt` | 26 个旧版词条（素材夹的菜单和提示、导入、删除确认、数量） |
| `dr-view-material` | 新模块 `library`、`folders`、`import`、`previews`、`card`；`init` 里登记素材库和快捷键 |

### 截图

同一个截图程序（`m19-capture`）多拍两组。

| 画面 | 浅色 | 深色 |
| --- | --- | --- |
| 中间是打开的「东岸速写」，右栏素材库：东岸（里面是旧城）和潮汐展开，缩略图，正打开的那条有砂笔框，两条笔记被多选（底下一层淡色），笔记显示开头几个字 | [library-light](m19/library-light.png) | [library-dark](m19/library-dark.png) |
| 指着「潮汐笔记」的悬停卡：打开、在系统 app 中打开、重命名、移动到素材夹（最外层和每个素材夹，「潮汐」亮着）、删除素材 | [library-card-light](m19/library-card-light.png) | [library-card-dark](m19/library-card-dark.png) |

### 测试

- `folders` 单元测试：数字按大小排；素材夹在前、有标题的素材在前；素材夹的数是它下面全部的；只看关联时没有内容的素材夹不列；素材夹不能移进自己下面；路径；点击、⌘ 点、⇧ 点、全选、清空、对整组还是单行。
- `import` 单元测试：按扩展名和文件头认图片和 PDF，Word、HEIC 不认；显示副本和缩略图的尺寸，不透明的存 JPEG；PDF 第一页缩略图。
- `previews` 单元测试：开头几个字的截取。
- `tests/library.rs`（GPUI 测试平台，真书库）：拖进来的两张图和一个 PDF 变成素材、进了那个素材夹、Word 文件跳过、显示副本和缩略图都在；复制的图片按 ⌘V 变成「粘贴的图片」；新建素材夹进入重命名、输入名字回车后改名；多选移进素材夹、它展开、父素材夹不动；素材夹移进自己下面时留在原地；删除；⌥ 展开全部、全选、Esc 取消。
- `dr-shell`：`a_module_draws_the_library_tab`（登记后每个半栏问一次，之后留着用）。

### 待协调

1. **「展开预览」**（旧版行内展开大图或整段笔记）和**关联**（行内的关系标签、「关联…」）没做；关联在 M23 和要素页里有，以后可以把同一个选择器放进悬停卡。
2. **拖动的截图没有。** 离屏截图程序模拟不了从系统拖文件进来；行与行之间的拖动在测试里用 `move_to` 覆盖了，真窗口里的拖动手感没看过。
3. **移动不是一步撤销**（见上）。
4. **审阅里的区域批注卡**（第一部分的待协调）还在。

### 给 M23 的接口

M23「审阅与素材」可以直接用这些（都在 `dr_view_material` 下）：

| 用来做什么 | 接口 |
| --- | --- |
| 一张素材卡 | `card::MaterialCard::new(id, &MaterialInfo).width(168.0).selected(bool).on_click(…)`：缩略图（或笔记开头几个字）、素材记号和标题、下面一行淡字；选中时砂笔框围着 |
| 卡的零件 | `card::thumb(&MaterialInfo, 边长, window, cx)`（方形缩略图或图标）、`card::subline(&MaterialInfo, cx)`（笔记开头几个字 / 「图片」「PDF」）、`card::kind_label(kind, cx)` |
| 缩略图和开头几个字 | `previews::thumbnail(asset, MediaKind, cx) -> Option<Picture>`、`previews::first_words(material, cx) -> Option<String>`：没做好时返回 `None` 并在后台做，做好了重画窗口；全应用共用一份 |
| 素材夹树 | `folders::Tree::new(&book.folders, &book.materials, 只看这些: Option<&HashSet<String>>)`，然后 `.entries(&展开的, 收窄)`（`Entry::Folder { id, name, depth, open, count }` / `Entry::Material { id, depth }`）、`.total(素材夹)`、`.subtree(素材夹)`、`.within(甲, 乙)`、`.path(素材夹)`、`.choices(&Selection, 当前, 最外层的名字) -> Vec<Choice { folder, path, current }>` |
| 选择 | `folders::Selection { materials, folders }`、`Selection::of(&行键)`、`folder_key(id)` / `material_key(id)`（`f:` / `i:`）、`folders::Picker`（`click(键, ⌘, ⇧, &顺序)`、`all`、`clear`、`target(键)`、`keep(&顺序)`） |
| 命令（放后台线程跑） | `folders::move_to(lib, book, &sel, Option<&str>)`、`create_folder(lib, book, 名字, 父)`、`rename_folder`、`rename_material`、`delete(lib, book, &sel)` |
| 导入 | `import::import_paths(lib, book, 素材夹, &[PathBuf]) -> Report { imported, skipped }`、`import_path`、`import_bytes(lib, book, 素材夹, 字节, 标题)`、`kind_of_path`、`kind_of_bytes` |
| 拖动 | `library::MaterialDrag { selection, label }`：M23 的卡用 `.on_drag(MaterialDrag { … })` 拖出来，放到素材库的素材夹上就会移进去；反过来素材库拖出来的也是它，M23 可以接 |
| 打开着的素材库面板 | `library::panels(cx)`；`LibraryPanel` 的 `select`、`set_open`、`set_open_all`、`move_to`、`import_paths`、`paste`、`new_folder`、`new_note`、`ask_delete` 都是公开的 |


## 第三部分：素材页动作菜单（旧模块收尾）

2026-11-08，分支 `codex/legacy-m19-actions`，基线含 main `037a1d74`（及 M41 交回提交）。只补旧版 `MaterialEditorView.tsx`、`EditorTopBar.tsx` 和 `MaterialFolderPicker.tsx` 已有行为；不把本里程碑当作整个 M19 完成。

- 图片和 PDF 的 ⋯ 菜单增加「用默认应用打开」，交给系统的是书库拥有的 source 原件，绝不使用 display/thumbnail。元数据或原件缺失时显示旧版的「无法打开文件：…」。GPUI 的 `open_with_system` 不返回系统处理结果，所以默认应用接管后的系统错误反馈仍须作者在目标系统手测。
- 笔记、图片和 PDF 都有「移动到素材夹…」：列出根及完整素材夹路径，当前位置有勾；也能输入名称，在根新建素材夹并移入。名称去掉两端空白，空名称不提交。命令仍是既有的 `material_folder.create` / `material.update`，创建和移动分别撤销，保留已有命令粒度。
- 「删除素材」使用旧版的标题确认句。取消和 Esc 不改数据；确认成功才关对话框，外壳原有订阅关闭已删除的素材标签；失败留在对话框并提示。提交中不重复写、不允许关闭。
- 素材模块通过 `pages::add_page_menu` 注册自己的动作；没有改外壳、输入法或默认运行配置。文字笔记不出现原件打开项；历史入口及危险操作末置由现成菜单组合保留。
- 八条文案从旧版九种语言同步。实现：`dr-view-material/src/menu.rs`；契约：`tests/actions.rs`；真实窗口流程：`dr-cli/scenarios/material-actions.json`。

### 此次逐项核对后的剩余

| 类别 | 结论与代码依据 |
| --- | --- |
| 真缺：笔记任务自动投射 TODO 和开关 | 旧版 `MaterialNotePage.tsx` 调 `note-todo-links.ts`，按 `taskTodos` 扫描/同步任务；Rust `MaterialInfo.task_todos` 与 `MaterialUpdateIn.task_todos` 目前只有存取；`dr-editor` 已能读取关联 TODO 状态，点击任务框会完成／重开对应 TODO，且有双向状态契约。剩余是自动创建／关联、对账和开关；现有 `todo.project` 只处理正文段首文字标记，并拒绝素材文档，不能直接充当这条投射。 |
| 真缺：来源 | 模型 `dr-model/src/book.rs` 保留 `Material.provenance`，`dr-workspace/src/dto.rs::MaterialInfo` 未暴露。需一个只读来源 DTO（生成模型/日期/提示词及 former portrait 的要素 id），素材页按旧版只读展开，不引入生成产品。 |
| 真缺：通用关联 | 旧 `MaterialRelations` 只显示通用关联的 chips 和 picker。当前素材整页/笔记页未挂；复用关系的选择/增删能力即可，不应直接把全关系管理塞进本页。素材库的行内关联与展开预览也仍缺。 |
| 真缺：区域批注卡完整动作与定位 | 当前列只有选择、解决/重开；旧版有编辑、来源、删除、转 TODO。审阅箭头打开素材后还需模块级 `open-and-select-comment` 接口（含 PDF 页码），待外壳协调。 |
| 真缺/作者决定：灯箱、格式支持 | 全屏灯箱未做；HEIC 尚无系统解码适配；加密 PDF 是 hayro 的已知限制，若换引擎涉及分发/安装，交作者决定。 |
| 文档过时 | 导入 display/thumbnail 已做；F4 的列表、任务块、代码块、提示框、表格与斜杠菜单已存在，不能把整类编辑能力仍列为未做。 |
| 作者手测/设计 | 系统默认应用实际接管及系统失败反馈；触控板/拖放手感；深色主题白色 PDF 上批注框的对比度与视觉决定。 |

接口核对还发现：`import_bytes` 虽有“图片或 PDF”的注释，实际 PDF 会带 0 × 0 尺寸写变体，被 F2 拒绝。当前 UI 的 PDF 导入/粘贴文件都走 `import_path`，原始剪贴板字节只传图片；本次 PDF 契约也使用真实文件入口。这是现有接口说明与能力不一致，不能凭它推断旧版产品缺了“原始 PDF 字节粘贴”，未来调用者需要字节入口时再补明确的无尺寸 source 接口。

### 验证

契约检查菜单按素材类型分流、危险项末置、原件字节、缺失原件错误、移到既有素材夹/根/新建素材夹、空名称、取消与确认删除及标签关闭。定向测试 `cargo test --locked -p dr-view-material --test actions`：4/4 通过。真实窗口用 `workspace scenario crates/dr-cli/scenarios/material-actions.json --app target/full/debug/drifting`：61/61 步通过、0 pending、`app.quit` 正常退出；通过点击/输入和 F3 回读核对，四张截图中已检查素材夹选择和原件缺失提示。素材夹对话框无裁切、当前路径有勾，错误提示清晰。证据写入忽略的 `target/acceptance/legacy-m19-actions/`，不提交生成 JSON，不碰个人书库或外部服务。媒体模块页的 `ui.wait ready` 桥接口尚不识别，因此媒体末段使用 `ui.find` 等按钮和 `state.get` 核对，没有改共享调试桥。

本分支按 AGENTS.md 完成：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（1684 passed / 0 failed / 22 ignored）、`cargo xtask check` 全通过；审计 942 个锁定 crate，0 漏洞、12 条既有 notice，既有 stale 测量证据保留，未手改。`pnpm public:check`：5228 个候选文件通过。旧版检查的共同基线由收尾主线运行并汇总，本分支单独复查公开边界。

### 第二十六批整合边界

`fe7657a1` 作为基础动作里程碑验收。现有／根素材夹的选择行虽然有 Button 角色，但没有焦点和键盘选择；新名称输入的 Enter 与 Esc 不能证明整个选择器能用键盘完成。删除确认依赖的共享按钮也需补键盘焦点。这两处仍是实现工作，已转交旧模块收尾；系统默认应用实际接管另保留作者手测。
