# M41 导出

2026-11-08，第一个里程碑：成稿导出（EPUB / PDF / Word）和 Markdown 分享。计划见 [modules.md 的 M41](../modules.md)。排版搬自旧版 `src-tauri/src/manuscript_export/*`，放进新的服务层 crate `next/crates/dr-export/`；新写的是「Loro → 成稿」的转换和 Markdown；界面在 `next/crates/dr-view-export/`，外壳挂在页面右下角的 ⋯ 菜单。`.driftingbook` v2、整库备份、导入 docx 和 Markdown 也在 M41 的那一行里，这一轮没做，见「待协调」。

## 做了什么（大白话）

1. **⋯ 菜单最上面多了「分享」和「导出成稿」两行**（旧版的位置和顺序）。章节页的 ⋯ 里，分享的是这一章；「通览全书」页现在也有 ⋯，里面只有这两行，分享的是全书。
2. **「导出成稿」对话框照旧版：**
   - 格式：EPUB、PDF、Word 三选一；
   - 范围：全书 / 选中章节。全书 = 除了「弃用」以外的所有章节；从某一章的 ⋯ 打开时，「选中章节」只勾着这一章。选中章节时下面列出全书章节（按卷分组，每章前面是它的圆印，勾上的行尾一个勾），上面一行「N 章」和「全选 / 全不选」；
   - 内容：卷标题、章节标题两个开关（书里没有卷时不显示卷标题）。**H1、H2、H3 永远全导出，没有开关**；
   - 书籍信息：书名（默认是书名）、作者、封面（选一张图片，旧版同样的处理：转正方向、长边最多 2560、重新压成 JPEG）；
   - 点「导出 EPUB」先弹系统的保存面板，选好位置以后在后台读正文、排版、写文件（先写临时文件，写完再改名，失败不会留下半个文件），状态栏显示「正在导出…」「已导出」或「导出未完成，请重试。」。
   - 格式、两个开关、改过的书名和作者名会记住，下次打开同一本书时还是上次的选择。
3. **「分享 Markdown」对话框照旧版：** 全书或这一章的完整正文转成 Markdown，只读显示；「复制全部」放进剪贴板，「保存 .md」弹保存面板写文件；下面一行字符数。全书很长时只排可见的那几行，不卡。
4. **排版和转换在 `dr-export`**（服务层，不带界面）：
   - **排版照搬旧版**：EPUB 3、Word、PDF 三个写出器、校验和各种上限都是旧版 `manuscript_export` 原样，只删了 Tauri 命令和对话框；旧版的格式验收测试也搬过来了，本机 macOS 上 PDF 的测试真跑了，没有中文字体的系统上照旧版跳过。
   - **「Loro → 成稿」是新写的**，规则照旧版 `manuscript-export.ts`：阅读顺序（第一卷之前的章节，再按卷）；正文的 H1/H2/H3 照三级标题导出，标题里没有字的去掉；段落保留居中、靠右和缩进 0–8；连续的引用段合成一段引文；分隔线照旧；粗体、斜体、下划线、删除线照旧；只有 http(s) 和 mailto 链接保留地址，别的链接只留字（旧版遇到这种链接会让整本书导不出来）；人物链接、批注、高亮只留字；章首章尾的空段去掉。
   - **Markdown 照旧版 `markdown-share.ts`**：全书时书名是 `#`，没有卷时每章 `##`，有卷时卷 `##`、章 `###`（第一卷之前的章也是 `###`）；章题下面是梗概（引文），再是正文，正文自己的 H1/H2/H3 往下挪到章题之下（最多 `######`）。全书分享连弃用的章也带上（旧版就是这样）。
   - **封面**：转正方向、长边最多 2560、压成质量 90 的 JPEG（旧版 `image_pipeline`）；新加的一点是透明的地方铺白底。HEIC、AVIF 读不了，会说读不了。

截图在 [m41/](m41/)：全书导出、选中章节（换成 Word）、分享这一章，浅色深色。

## 定下的事

- **入口**：只有章节和「通览全书」的 ⋯ 有这两行。旧版的构想、要素等页面的 ⋯ 也有「分享」；新版这些页面还没有 ⋯ 菜单（外壳只给章节画了），等它们有了再加同一组两行（`export_items`）。
- **对话框放在外壳给别的 crate 用的对话框位置**（`Workspace::dialog`，M39 的反馈也在这里），外壳没有为导出新加字段。
- **记住的选择存在设置文件里**：旧版存在 WebView 的 `localStorage`；新版由外壳（F6 第六轮）存进设置文件，跨重启有效。
- **保存面板从用户主目录开始**，建议的文件名是书名（旧版 `manuscriptFilename`：去掉文件名里不能用的字符，最多 35 个字）。
- **PDF 用的字体**：旧版会先试作者在设置里选的编辑器字体；新版还没有这个设置，先按 `dr-export` 的系统字体链。
- **`sync-locales.py` 修了一处**：按 `前缀.*` 整棵搬文案时，英文有 `_one`/`_other` 而中文只有不带后缀的键（`manuscriptExport.chapterCount`），原来会漏掉中文那一个，构建报「zh-CN.json lacks …_other」。现在整棵搬时也带上它（和逐个列出的键同一条规则，build.rs 本来就把它当作这门语言的 `_other`）。
- **PDF 断行改用编辑器的那一套**（`prose-linebreak`，simplifications.md 第 19 条「断行只写一套」）：比旧版的 `unicode-linebreak` 更严，「——」「……」不会被拆开，开引号不落在行尾；行内排版、标点挤压、两端对齐还是旧版的代码。旧版 PDF 的 `unicode-linebreak` 依赖不要了。
- **表格和嵌入**：旧版 ProseMirror 里表格是节点，新版是嵌入物。表格保留字：每个非空单元格的每一行一段，先行后列；素材嵌入和认不出的嵌入去掉（它们没有自己的字）。
- **Markdown 分享只给章节、构想、要素、故事线、类目和全书**：素材笔记旧版就没有分享，它的清单、待办在 Markdown 里也没有对应的样子。
- **不加说明文字**：文案全是旧版搬来的（`manuscriptExport.*`、`markdownShare.*`）。旧版分享对话框里的「正在复制…」（复制是一瞬间的事）和预览框的读屏标签没有用到，没搬。

## 接口

```rust
// 外壳（dr-shell）：
ws.open_export(dr_view_export::Request::Manuscript { chapter: Some(id) }, window, cx); // 或 chapter: None
ws.open_export(dr_view_export::Request::Markdown(MarkdownTarget::Book), window, cx);   // 或 Doc("node:<id>")

// 对话框（dr-view-export），测试和别的入口也能直接用：
ExportDialog::new(lib, book, request, locale, platform, window, cx)  // 发 ExportEvent::Close
dialog.manuscript_mut().unwrap().export(cx)       // 弹保存面板，写文件
dialog.markdown_mut().unwrap().copy(cx) / save(cx)
```

## 外壳里的挂接点（逐条）

1. `dr-shell/Cargo.toml`：依赖 `dr-view-export`。
2. `dr-shell/src/workspace/corner.rs`：
   - `export_items`：章节 ⋯ 菜单最上面加「分享」「导出成稿」两行，下面一条分隔线再接原来的写作状态；
   - 「通览全书」页的角上也画 ⋯ 按钮，菜单（`book_menu`）里只有这两行；
   - `Workspace::open_export(request, window, cx)`：把对话框放进 `Workspace::dialog`，对话框关掉时清空并把焦点还给工作区。

没有新字段，没有新快捷键，没有改渲染顺序。

## 测量（只作参考）

`lite` 种子（20 章、约 15 万字），release，机器有负载：

| 步骤 | 耗时 | 文件 |
| --- | ---: | ---: |
| 从 Loro 读出成稿 | 209 ms | — |
| EPUB | 10 ms | 53 KiB |
| Word | 7 ms | 21 KiB |
| PDF（含扫描系统字体） | 720 ms | 506 KiB |
| 全书 Markdown | 191 ms | 484 KiB |

都在后台线程，对话框只显示「正在导出…」。

## 测试

- `dr-export/tests/export.rs` 和搬来的格式验收（33 个）：大纲的顺序和分卷、正文变成段落和标题、选中的章节保持书中顺序和两个标题开关、Markdown 全书和单篇、没写过的章导出为空、`lite` 种子三种格式都能导出且能解开。
- `dr-view-export/tests/dialog.rs`（GPUI 测试平台，真实的库）：全书导出 EPUB（保存面板、写出的 zip、记住的格式）、只选一章导出 Word、从某一章打开时只勾着它、取消保存面板什么都不写也不报错；Markdown 复制进剪贴板、保存的文件和显示的一字不差。
- `dr-shell/tests/m41.rs`：从外壳打开（从章节打开时只选着这一章）、对话框盖住工作区、关掉以后位置清空；全书分享读出了全部章节。

## 待协调

1. ~~**F6（外壳设置）**：导出记住的选择跨重启~~：**已做（F6 第六轮）**，外壳启动时从设置文件填 `Prefs`、`Prefs` 一变就写回：账号值 `export.author`，每本书的 `export`（`format`、`actTitles`、`chapterTitles`、`title`）。
2. ~~**F6（⋯ 菜单）**：构想、要素、故事线、类目页最上面加「分享」~~：**已做（F6 第六轮）**，在外壳的 `workspace::page_actions` 里，⋯ 菜单和章节面板的悬停卡共用。
3. **编辑器字体设置（F4 / F6）**：旧版 PDF 先试作者选的编辑器字体（`preferredFont`）；新版有这个设置以后传给 `read_manuscript` 的 `preferred_font`。
4. **M41 下一轮**：`.driftingbook` v2、整库备份、导入 docx 和 Markdown 还没做；分享链接属于在线服务，不在这里。
5. **dr-i18n**：`sync-locales.py` 的那处修复（见「定下的事」），请 dr-i18n 的维护者过目。
6. **进度表**：`progress.md` 的 M41 一行等合进 main 时由监管会话写。

## 代码位置

```text
next/crates/dr-export/                             排版（旧版搬来）、Loro → 成稿、Markdown、封面、写文件
next/crates/dr-view-export/src/manuscript.rs       「导出成稿」对话框
next/crates/dr-view-export/src/markdown.rs         「分享 Markdown」对话框
next/crates/dr-view-export/src/prefs.rs            记住的选择（外壳存进设置文件）
next/crates/dr-shell/src/workspace/corner.rs       ⋯ 菜单的两行、通览全书的 ⋯、open_export
next/crates/dr-i18n/keys.txt                       manuscriptExport.*、markdownShare.*（从旧版搬）
next/crates/dr-i18n/script/sync-locales.py         整棵搬文案时带上没有复数形式的语言的那个键
next/crates/dr-shell/examples/m06-m07-capture.rs   截图（加了 m41）
```
