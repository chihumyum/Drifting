# M41 导出

2026-11-08，第一个里程碑：成稿导出（EPUB / PDF / Word）和 Markdown 分享。计划见 [modules.md 的 M41](../modules.md)。排版搬自旧版 `src-tauri/src/manuscript_export/*`，放进新的服务层 crate `next/crates/dr-export/`；新写的是「Loro → 成稿」的转换和 Markdown；界面在 `next/crates/dr-view-export/`，外壳挂在页面右下角的 ⋯ 菜单。第二部分（同一天）是搬运：`.driftingbook` v2、导入 Markdown / 文本 / Word、整库备份与恢复，见文末「第二部分：搬运」。

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

- **入口**：章节和「通览全书」的 ⋯ 有「分享」「导出成稿」。F6 第六轮已在 `workspace::page_actions` 给构想、要素、故事线、类目页接上「分享」；它们不增加成稿导出入口。
- **对话框放在外壳给别的 crate 用的对话框位置**（`Workspace::dialog`，M39 的反馈也在这里），外壳没有为导出新加字段。
- **记住的选择存在设置文件里**：旧版存在 WebView 的 `localStorage`；新版由外壳（F6 第六轮）存进设置文件，跨重启有效。
- **保存面板从用户主目录开始**，建议的文件名是书名（旧版 `manuscriptFilename`：去掉文件名里不能用的字符，最多 35 个字）。
- **PDF 用的字体**：旧版会先试作者在设置里选的编辑器字体；新版还没有字体家族选择（只有字号等排版设置），先按 `dr-export` 的系统字体链。
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
4. **M41 第二部分**：已做，见下文；分享链接属于在线服务，不在这里。
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
next/crates/dr-export/src/book_file.rs             .driftingbook v2：写出、读入、改写 id
next/crates/dr-export/src/import/                  导入 Markdown / 文本 / Word（解析、写进书）
next/crates/dr-view-transfer/                      书卡导出、导入书、导入文件、备份与恢复的对话框
next/crates/dr-view-transfer/examples/transfer-capture.rs  第二部分的截图
```

---

## 第二部分：搬运

2026-11-08 下午。监管会话派的顺序：`.driftingbook` v2、导入 Markdown / 文本 / Word、整库备份与恢复的对话框。读写在 `dr-export`（`book_file.rs`、`import/`），界面在新的 `next/crates/dr-view-transfer/`（依赖 dr-shell，和 M10 的 dr-view-import 一样；不能放进 dr-view-export，dr-shell 依赖它）。导入文件的解析和写入是后台子代理在自己的 worktree 里做的，合进来以后由我接界面。

### 做了什么（大白话）

1. **一本书存成一个文件，再导回来（`.driftingbook` v2）。**
   - 书架上书卡悬停时多一个「导出这本书（.driftingbook）」的箭头（旧版的位置：编辑和移进最近删除旁边），点了弹保存面板，写出 `<书名>.driftingbook`。
   - 书架左栏的「导入书（.driftingbook）」原来只是个占位，现在弹文件面板，选了文件出一个「正在导入」的小对话框带进度条，导完对话框消失，新书出现在书架上（书架在索引写进来时会自己重读）。
   - **导入永远是加一本新书**，不会盖掉任何书，连它自己的原书也不会：同一个文件在同一个库里导两次，就有三本并排。复本和原书不共用任何 id。
   - 带过去的：书目文档（章节、构想、故事线、要素、类目、关系、批注、素材、情节规划、幕、时间钉、设定、项目记忆、写作日、最近删除里的东西）和这本书的每一篇正文，**连同它们的历史**；图片、PDF 的原件、显示版、缩略图。不带的：这台设备的本机状态（最近打开、布局）、历史标签、派生索引（导入后重建）。
   - 出错时说旧版的那几种原因：不是 Drifting 的书、更新版本导出的、太大、文件坏了、没导成；导一半失败，已经写进去的全部删掉，库和导入前一样。
   - **旧版（0.1）导出的 `.driftingbook`（v1）读不了**：里面是 0.1 的同步包和 Yjs 状态（P0-E 的结论）。会说「这本书是 Drifting 0.1 导出的。请在旧版里导入它，再把旧版资料库交接给新版。」（新写的一句，九种语言）。
2. **把 Markdown、文本、Word 文件导进这本书**（旧版的「导入文件」对话框）。
   - 入口：书里左下角账户菜单的「导入　MD · DOCX · TXT」（旧版账户菜单的那一行；书架上的账户菜单没有这一行）。
   - 一次只导一种：章节（归到选的故事线，排在最后一章后面）、要素（归到选的类目）、构想。
   - 「选择文件」或「选择文件夹」（文件夹里只取 `.md`、`.markdown`、`.txt`、`.docx`，按自然顺序：`2` 在 `10` 前面）。每个文件加进来就在后台读，读完显示「就绪」，标题（开头的一级标题，没有就用去掉序号的文件名）可以改。
   - 「开始导入（N）」按顺序写；每个文件各算各的，要素重名的那一个报错，其余照样导进去；最后一行「完成 · 成功 N · 失败 M」。
   - 标题、引用、分隔线、居中 / 靠右、粗体 / 斜体 / 下划线 / 删除线、网址链接、段内换行都带过来；H4–H6 变成 H3；列表、代码变成普通段落；Word 里的图片去掉并提示。
3. **整库备份与恢复**（旧版「本地数据」里的两行，照 0.1 的文案）。
   - 备份：保存面板（`Drifting-<日期>.drifting`），「正在备份…」，写完说「已保存「…」。共 N 个项目、M 个素材文件，大小。」，本机缺了的素材文件也说一句。库照常用，不用关。
   - 恢复：选文件，「正在核对…」（检查每个校验和、数据库完好，旧了就在旁边升级；库照常开着），然后问旧版那一句：用哪个文件替换、备份时间、内容、有哪些书，以及「当前资料库会先自动存成恢复前副本」。「替换并恢复」交给外壳去关库、换库、重开；「取消」把核对出来的副本删掉。
   - 0.1 的整库备份（格式 1）不能直接恢复，会说「这是 Drifting 0.1 的备份…请先在 Drifting 0.1 里恢复它，再在书架上用「导入 · Drifting 0.1」导入那个资料库。」（新写的一句）。
   - **入口**：设置「本地数据」的两行按钮派发 `dr_shell::actions::{BackupLibrary, RestoreLibrary}`（监管会话和 F6 定的名字；这条分支上先加了这两个动作，F6 第六轮的分支也加了同名的，合并时留一份），`dr_view_transfer::init` 接住。
   - **换库已接上**：第十三批整合在应用里用 `dr_view_transfer::backup::set_replace(cx, …)` 登记了 `dr_shell::library::replace`，由外壳关库、替换、重开。没有登记替换步骤的测试宿主仍会核对、询问，确认后说明没能替换，库不动。

截图在 [m41/](m41/)：`transfer-book-importing`、`transfer-book-refused`、`transfer-documents`、`transfer-backup`、`transfer-restore`，浅色深色各一套。

### 文件格式（`.driftingbook` 版本 2）

```text
manifest.json                      format "drifting.book"、formatVersion 2、appVersion、exportedAtMs、title、book、
                                   documents[{id, path, sha256, sizeBytes}]、assets[{asset, variant, mime, ext, width?, height?, path, sha256, sizeBytes}]
docs/<n>.loro                      每篇文档的 Loro 快照（带历史），书目文档在最后
assets/<asset>/<variant>.<ext>     资源的每个存着的版本，原样
```

- 和旧版 v1（CBOR）不同，换成 ZIP 加清单：和整库备份（`.drifting` v2）同一种做法，大文件不用整个读进内存，也能用普通工具打开看。格式名和「最大 1 GiB」照旧版。
- 每个文件读进来都核对大小和 SHA-256；多版本（更新的格式）、旧版（CBOR 里写着 `drifting.book`）、不是书，分别报。

### 定下的事

- **新 id 怎么换**（这是这一部分最难的地方）：不能整篇重建（那要把每种集合、每个标记的写法都再写一遍，模式一改就漏），而是**改写每篇文档的变更**：
  - 用 Loro 的 JSON 变更（不压缩对等方），在**类型化的结构上**改（`loro::json`），不能先转成 JSON 文本再转回来——JSON 里的二进制值会变成数字列表，可合并子容器的标记（`ensure_mergeable_map` 留下的校验和）和批注锚点都会坏。
  - 换的 id：书本身、书目文档里每个集合的键、每篇文档的实体、每个资源。不含冒号的 id 换成新的 uuidv7；派生出来的 id（`rt-generic:<书>`、生成的 TODO `todo:…:<文档>#<段>`、位置链接）跟着里面的 uuid 走。字符串里的 uuid 按 uuid 的样子扫出来再查表，不会误伤正文——**正文插入的文字一个字都不动**。
  - 可合并子容器的名字（`🤝:$<集合>><键>`）按段拆开、去掉转义、换、再转义回去，所以不是 uuid 的 id（比如样书里的设定）也跟得上；容器的标记按新的父容器和键**重新算校验和**。
  - 每篇文档的「出生」变更（dr-doc 用确定的对等方写的第一笔）挪到新文档 id 的出生对等方上，这样它和这一版给新 id 写的出生变更**一模一样**，Loro 去重；写进去以后核对操作数，多一笔就当文件坏了。
  - 变更的 id 不变，所以批注锚点、块 ID、历史都照常能用。
- **写入顺序**：资源 → 正文 → 书目文档最后（书目文档一写进去书就出现在书架上）；失败就把写进去的文档清掉（清掉后再忘掉「已清除」的记录）、资源删掉。
- **注册了但没写过的文档不带**（比如一个从没打开过的类目页）：新库里第一次打开时照常新建。
- **导入文件**：解析和写入的规则见 `dr-export/src/import/` 的文档注释（子代理定的，我看过）：故事线可以不选（旧版必须选；F3 允许不选）；先用 F3 的创建命令建出来（每个文件一条可撤销的日志、命名规则照旧），再一次提交写上格式；中日韩字之间的软换行直接相连不加空格（旧版会加一个）。
- **入口放在哪**：书架上的两个动作（`ExportBook` 新加，`ImportBook` 原有）、外壳的 `ImportDocuments`（新加）都由 `dr_view_transfer::init` 用 `cx.on_action` 接，和 M10 一样；对话框是外壳的模态对话框位置。
- **正文模板随书走**：要素模板、章节模板（`template:category:<类目>` / `template:storyline:<故事线>`）是书的东西，`.driftingbook` 带上它们，搬书不丢。文档 id 按结构换：前缀不动，最后一段（主人的 id）换成新的，所以模板跟着类目、故事线的新 id 走，不管那个 id 是不是 uuid。成稿导出、Markdown 分享只读章节、构想、要素这些页，从不碰模板；导进来的模板在索引里是空的（dr-index 的规则）。
- **导入文件的两句警告**（去掉了几张图片、不是 UTF-8 文本）旧版没有，新写成自己的文案，九种语言：`importDialog.warnings.imagesDropped`（按张数变复数）、`importDialog.warnings.notUtf8`。dr-export 的 `ImportWarning` 只给类型和张数，对话框用 `documents::warning` 换成界面语言。
- **不加说明文字**：文案都是旧版搬来的；新写的只有 0.1 文件那两句和上面两句警告。旧版导入对话框「构想」那一项的键名是 `importDialog.targets.inspiration`，键名里的 inspiration 过不了术语门禁（构想只叫构想），所以把它的标签和说明原样抄进新版自己的文案，键名改成 `importDialog.targets.idea`。旧版导入对话框顶上那段「支持 `.md` / `.docx` / `.txt`…」的说明、没有故事线 / 类目时的两句提示没搬（这一版允许不选）。

### 外壳和其他模块里的挂接点（逐条）

1. `dr-shell/src/actions.rs`：新动作 `ImportDocuments`、`BackupLibrary`、`RestoreLibrary`（后两个和 F6 第六轮同名，合并时留一份）。
2. `dr-shell/src/account.rs`：书里的账户菜单加一行「导入　MD · DOCX · TXT」，派发它（书架上的账户菜单不加）。
3. `dr-view-shelf/src/view.rs`：新动作 `ExportBook { book }`、书卡悬停多一个导出箭头；删掉 `ImportBook` 的占位处理（不删的话动作到不了 `dr_view_transfer`）。
4. `app/drifting/src/main.rs`：`dr_view_transfer::init(cx)`（在 `dr_view_import::init` 后面）。
5. `app/drifting/src/main.rs` 在 `dr_view_transfer::init` 后面用 `set_replace` 登记 F6 的换库 `dr_shell::library::replace(cx, job, done)`（第十三批整合时接上；对话框换库时只留着根目录和版本，不持有库）。

### 接口

```rust
// dr-export
book_file::export_book(&ws, book, dest, &|Progress{done, total}| …) -> Result<BookFileSummary, BookFileError>
book_file::import_book(&ws, path, &|Progress| …) -> Result<BookFileSummary /* 新书的 id */, BookFileError>
book_file::book_filename(title)          // `<书名>.driftingbook`
import::{parse_file, import_docs, files_in_folder, order_import_files, ImportTarget, ParsedDoc, …}

// dr-view-transfer
book::{export, import, export_path, import_path}
documents::{open, show, DocumentsDialog}
backup::{backup, backup_path, restore, restore_path, Replace, set_replace, replacer}
// Replace = Rc<dyn Fn(StagedBackup, ReportProgress, &mut App) -> Task<Result<(), String>>>
// ReportProgress = Box<dyn FnMut(&dr_store::backup::Progress) -> bool + Send>
// 外壳关库、Library::restore_staged_with（传入 ReportProgress）、重开
```

### 测量（只作参考）

release，机器负载 21–25，导出到同一个库再导回来（新 id）：

| 书 | 文档 | 文件 | 导出 | 导入 |
| --- | ---: | ---: | ---: | ---: |
| dr-testkit 轻量种子 | 81 | 0.4 MB | 30 ms | 350 ms |
| dr-testkit 重型种子（100 章、150 万字） | 680 | 5.7 MB | 261 ms | 4.0 s |

都在后台线程，导入时对话框有进度条（每写完一篇走一格）。导入的时间主要花在把每篇文档的变更转成类型化 JSON、改写、再导入一份新文档，以及每篇写完后的压缩；重型种子 4 秒可以接受，真要快可以把改写放到多个线程（文档之间互不相干）。

### 测试

- `dr-export/tests/book_file.rs`：
  - 一本有链接、锚定批注、关系、图片文件、最近删除、写作日、要素模板和章节模板的书导出再导进同一个库：读起来和原书一样，原书没动，两本不共用任何 id，链接、关系、批注、故事线都指向复本自己，两种模板是复本类目、故事线自己的文档、内容相同，图片文件在复本的 id 下、字节相同，字数重建；同一文件再导一次，三本并排。
  - 导进另一个库、再导出、再导回原库，都和原书一样。
  - dr-testkit 的 tiny 种子（每种东西都有一点）和《慢钟》导回来，dr-testkit 的摘要（按名字不按 id 读整本书）完全相同，同库和另一个库都是。
  - 坏了的文件、不是书、0.1 的文件、更新版本的文件：各报各的原因，库里文档数和资源一个不多。
- `dr-export/tests/import.rs` 和 `src/import/` 的单元测试（子代理写的）：三种格式的解析、标题规则、写进书里再读回来。
- `dr-view-transfer/tests/`：书卡的导出动作经保存面板写出文件、导入时对话框出现又消失、多出一本书；不是书的文件报「这不是 Drifting 导出的书。」；备份写出真文件、恢复核对后问、确认后把核对过的副本交给替换步骤，替换失败说原因，取消什么都不交；不是备份的文件报「不是有效的 Drifting 备份」；设置的两个动作经保存面板、文件面板走到底（没登记换库时确认后说没能替换，登记了就把副本交给它）；导入文件：账户菜单的动作打开对话框，文件夹里只取能读的、自然顺序，标题可改，章节进选的故事线，重名要素单独失败；两句警告按界面语言（中、英单复数、韩）。

### 待协调

1. ~~**F6**：旧版文案里的「打开恢复前副本」按钮~~：F6 第八轮做了，「恢复…」旁边的淡按钮，在访达里打开恢复前副本的文件夹（`dr_store::Library::pre_restore_dir`，没有就先建）。换库（`dr_shell::library::replace`）第十三批整合时已用 `set_replace` 接上。
2. ~~**F2**：备份、核对、恢复的真进度~~：旧模块收尾里程碑已接 F2 的三个 `_with` 接口，见下。
3. **M01（书架）**：书卡多了导出箭头、`ImportBook` 的占位删了；导入完书架靠索引事件重读，F2 的导入不发书目事件。


## 旧模块收尾：备份与恢复的真实进度

2026-11-08，分支 `codex/legacy-m41-progress`。这是 M41 的一个收尾里程碑，不代表整个模块结项。旧版 `LibraryBackupSettings.tsx` 只显示忙碌文案；此处依据交接任务明确要求，把已存在的 F2 进度回调接到对话框。

- 备份改用 `Library::export_backup_with`，核对改用 `backup::stage_with`；复制的数据达到多少就画多少，不按时间模拟。
- 恢复的 `Replace` 接口多接一个可跨线程的 `ReportProgress`；应用把它原样传进 `Library::restore_staged_with`。外壳的关库、换库、重开流程没有改。
- 进度是**当前阶段**的字节比例：打包、解包、保存恢复前副本、复制素材有总字节数；快照、数据库核验、原子替换没有可用总数，仍是不定进度。恢复前副本阶段用旧文案「正在备份…」，复制与替换用「正在恢复…」。没有新增取消行为或说明句。
- 每次操作有独立的进度通道。完成、失败、核对后的确认，都会先收完本次通道，迟到的核对进度不会盖掉恢复进度或最终结果。窗口消失不取消已经启动的备份或替换。

契约在 `dr-view-transfer/tests/backup.rs`：真实备份、核对必须在结果之前报告非零字节进度；替换回调跨保存副本、复制素材、原子替换阶段显示对应进度，某一阶段到 100% 不代表操作完成，失败结果不会被迟到报告覆盖。已有取消、无效备份和设置入口测试继续覆盖。真实窗口沿用 `dr-cli/scenarios/restore.json`，验证设置入口、确认、换库、恢复前副本、无效文件拒绝；瞬时进度的阶段转换由可控制的契约测试断言。

仍留给后续：编辑器字体家族设置尚无可传给 PDF 的选择（只有字号设置），不能把它误记成已接；真实账号服务、签名发布和作者观感手测不在本里程碑。

本轮真实窗口验收（`f5ca535b` 基线，2026-11-08）：`restore.json` 64 步通过、0 跳过；恢复确认、恢复后书架、无效备份的截图在 `next/target/acceptance/legacy-m41-restore/`，结果与截图只留作本机产物，不提交。

交回前检查：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo test --workspace --locked`（1675 通过、22 忽略）、`cargo xtask check`、`pnpm public:check` 全部通过。审计 0 漏洞，既有 12 条依赖提示及过期测量提示保留；本轮没有重测性能。
