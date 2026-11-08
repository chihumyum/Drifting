# M40 Markdown 文件夹

2026-11-08，第一个里程碑：章节和构想写成 Markdown 文件，在别的编辑器里改了保存，修改合并回正文。计划见 [modules.md 的 M40](../modules.md)；旧版的做法见 [`docs/markdown-mirror.md`](../../markdown-mirror.md)。代码在新的服务层 crate `next/crates/dr-mirror/`（不带界面）；设置里的位置、通知和应用的启动停止还没接，见「外壳里的挂接点」。

## 做了什么（大白话）

1. **每本书一个文件夹**，放在作者选的位置下面，文件夹名就是书名（同名的加 ` 2`、` 3`，书改名时文件夹跟着改名）：
   - 章节：`正文/01 上部/001 钟楼.md`（在某一幕里的章节放进幕的文件夹，幕和章都按阅读顺序编号），不在幕里的直接放在 `正文/` 下；
   - 构想：`构想/伏笔/修理单.md`（构想分组是文件夹，可以嵌套）；
   - 名字的清洗规则、撞名时加的 ` (8 位十六进制)` 都照旧版，和旧版生成的路径一样。
2. **文件的样子照旧版**：开头一小段属性（`drifting-id`、`写作状态`、`摘要`、`aliases`，别的编辑器加的属性比如 Obsidian 的 `tags` 原样留着、写回时照抄），下面是正文。`#`、`##`、`###` 就是 H1、H2、H3，`>` 是引用，`---` 是分隔线，粗体、斜体、删除线、下划线、网页链接照常写；人物链接只写名字。一行就是一段，空一行是段落之间的分隔，多空一行就是多一个空段。表格和素材在文件里是一行 `<!-- drifting:embed <id> -->`：文件里改不了，删掉这一行就删掉它。
3. **在别的编辑器里改了、保存了**，Drifting 开着的话大约半秒后合并进正文；关着时改的，下次打开时合并。和在 Drifting 里同时打的字两边都留着、各在各的位置（改的是同一处时两段字都在，先后由 Loro 定）。只改了的字被改：段落的块 ID、批注、链接、居中和缩进都还在。写作状态和摘要也照文件改。改过的段落里出现的人物名重新链上。
4. **Drifting 里写的字，停笔 5 秒后（一直在写的话最多 30 秒）写回文件**。只有文件还是 Drifting 上次写的那份时才会覆盖：外面改了还没读进来的文件从来不被盖掉，先合并再写。
5. **合并不了的文件**（`drifting-id` 是别的章节、正文被清空、基线对不上、不是 UTF-8、太大）：报出来，原文件另存到书文件夹的 `.drifting/preserved/<时间>/` 下，再按 Drifting 里的样子重写。**开头属性写坏了**的文件报出来以后不合并也不覆盖，等作者修好。
6. **改名、移动、删掉的章节**：旧位置的文件拿走（外面改过、还没读进来的先另存）；改名前外面的修改先合并进来再搬。作者自己删掉的文件下次重新写出来。
7. **一个文件夹只归一个 Drifting 安装**（书文件夹里的 `.drifting/owner.json`）。别的安装的同名文件夹不碰，这一本写到旁边的「慢钟 2」；自己的文件夹后来被别的安装接管了，就报出来、不读也不写。

## 定下的事

- **合并的办法照旧版，搬到 Loro 上**：文件被当成一份只会说 Markdown 的副本。台账记住文件写出时对应的版本（基线，Loro 的 frontiers）。文件变了，就在文档的基线版本上分叉一份（`fork_at`），把「基线 → 文件」的差别做在分叉上，得到的 Loro 更新像别的设备的修改一样导进正在用的文档（`Workspace::import_remote`，来源 `mirror`）。Loro 从不裁历史，所以基线一直在；旧版要整份存 Yjs 状态，新版只存几十个字节的版本号。
- **段落怎么对上**：照旧版，先按每段写出来的那一行比（Myers 差异），两边一样的段落原样不动；剩下的空隙里只把相像的段落（字的二元组 Dice ≥ 0.3）配成对，配上的算改了这一段，配不上的算删一段、加一段，新段落不会顶替旧段落的身份。段内只改变了的字（逐字差异），样式只在和文件不同的地方设或清，标题、引用、分隔线照文件，对齐和缩进不动；只改标题级别时用最窄的写法（`set_heading`），不盖掉别处同时改的别的属性。
- **同一个文件读两次只算一次**：分叉用的对等方由「文档 + 基线 + 文件的字节」算出来，同一份文件在同一个基线上做出的修改完全一样，Loro 去重。所以合并写进去、台账还没写就崩溃了，下次再读一遍也不会多出一份字（旧版靠把合并和台账放进一个 SQLite 事务）。
- **写出来的能原样读回**：每段写成的那一行，用导入功能（M41）的 Markdown 读法读回来，和原来那一段一模一样（字、样式、标题、引用）。为此：Markdown 的标点、`&`、会被认成裸链接的 `http:` 的冒号和 `www.` 的点、`]:` 的冒号都转义；`*`、`**`、`~~` 在 Markdown 的规则下读不回来时（挨着标点、首尾是空格、和相邻的同种符号连成一串、粗斜体叠在一起），改用 `<b>`、`<i>`、`<s>`；标题末尾的 `#` 转义。5 万例随机段落往返全对；dr-testkit 的 tiny 种子和《慢钟》写出去、再把每个文件当成外面改过的读回来，摘要不变、一个字都不多写。
- **段首段尾的空格**：Markdown 读不出段落首尾的空格，作者只改了这一段时首尾空格会掉（旧版一样）。没改的段落按整行比，不受影响。
- **文件里新写的列表、代码、表格、四级以下的标题**按导入的规则变成普通段落（旧版按 Agent 写入的规则，结果一样）；一个围栏代码块是一段（行之间是段内换行）。
- **章首章尾的空段**不写进文件，文件开头结尾的空行也不算；删掉文档的最后一段时，Loro 要留最后一个换行，这一段变成空段。
- **表格、素材**：文件里那一行挪了位置不会删掉它（可能是它周围的段落挪了），文件里出现文档没有的嵌入行就不理它。
- **文件夹的名字和位置照旧版**：名字先做 NFKC（全角括号变半角，和旧版一样，用依赖树里已有的 `icu_normalizer`），再替换不能用的字符；撞名的后缀是实体 id 的 FNV 短哈希，别的章节变了它也不变。只写章节和构想：要素、故事线、类目、素材的只读文件旧版是给 Agent 和外部读者看的，新版的帮手直接用工作区的命令读，这一版不写（待协调 4）。**正文模板（`template:` 文档）从不写出**。
- **台账放在 dr-store 的 `local_state`**（范围 `mirror`）：每个文件一行（路径、上次写或读的 SHA-256、基线版本、当时的字段、读不了的那份字节），每本书一行（文件夹名）。行上记着书，书清除时一起走；也记着位置，换了位置就从头写。F2 说的 `local_markdown_mirror_file` 表没有建：`local_state` 够用（`f2-store.md` 也说小东西可以放这里）。
- **什么时候动**：文件的变化用 `notify`（macOS 是 FSEvents）监听，旧版每 1.5 秒扫一遍；保存不到 0.4 秒的文件下一轮再读（可能还在写）。Drifting 里的修改停笔 5 秒、最多 30 秒后写；合并自己导进去的修改不另外排一轮（写出就在合并的那一轮里）。启动时整个过一遍，停下时先把还没写的写完。
- **不白读、不白写**：启动时的第一轮和 `sync_now` 每个文件都读、每篇都渲染；之后大小和修改时间（纳秒）和台账一样的文件不读，存着的版本、标题、字段和文件都没变的章节不重新渲染（旧版也是第一轮算指纹、之后只比大小和时间）。
- **写文件**：先写旁边的临时文件、刷盘、再改名盖过去，读的人看到的要么是旧的要么是新的；权限只给自己（0600）。旧版的生成文件是 0400，这一版没有生成文件。
- **通知的文案**用旧版的 `notifications.markdownFolder.issue.*`；「文件夹归别的安装」旧版只在设置里显示，没有通知文案，新写一句（九种语言，`issue.owned`）。

## 接口

```rust
// 起停（应用或外壳在库打开后、换库和退出前）：
let mirror = dr_mirror::Mirror::start(ws.clone(), dr_mirror::Options::new(root, installation_id, bundle_id))?;
mirror.on_issues(|issues: &[dr_mirror::Issue]| { /* 通知中心：issue.title、t(issue.problem.message())、issue.doc */ });
mirror.on_preserved(|kept: &[PathBuf]| { /* notifications.markdownFolder.preserved，按个数 */ });
mirror.sync_now()?;   // 整个过一遍并等它完（关库、换库前）
mirror.issues();      // 现在还合并不了的文件
mirror.stop();        // 先写完还没写的；drop 也一样

// 一次同步（测试、命令行）：
dr_mirror::sync::Pass { ws: &ws, root, installation, app, settle, thorough }.run()? / .book(id)?
// 底层：file::{render, parse}、body::{render, parse, line}、plan::plan、merge::{merge, merge_peer}、layout::entries
```

`Issue { book, doc: Option<"node:<id>">, title, path, problem }`，`Problem::{Frontmatter, WrongId, Emptied, UnknownBase, NotUtf8, TooLarge, OwnedElsewhere}`，`Problem::message() -> dr_i18n::Key`。

## 外壳里的挂接点（逐条）

这一轮没有改外壳。要外壳（F6）和应用做的（F6 第九轮都做了，见 f6-shell.md「第九轮」）：

1. **设置「本地数据」加「Markdown 文件夹」一节**（旧版 `MarkdownFolderSettings`）：所有书的位置（没选时写「所有项目 · 未选择位置」，「选择文件夹」是主按钮）、「在访达中打开」、最后是危险按钮「关闭 Markdown 文件夹」（先确认，默认焦点在「取消」）。存成本机设置（建议 `markdown.folder` 路径、`markdown.disabled`），不同步。旧版的按书单独选位置这一版没有做。没选位置就什么都不写（旧版 11-06 起就是这样）。
2. **应用起停**：库打开、设置里有位置且没关时 `Mirror::start(ws, Options::new(位置, Device::installation_id(), ShellInfo.bundle_id))`；改了位置或开关就 `stop` 再按新的起；换库（`dr_shell::library::replace`）和退出（`before_quit`）前先 `sync_now()` 再 `stop()`，必须在关库之前。
3. **通知**：`on_issues` 里每个问题发一条 `notifications::Source::MarkdownFolder`，标题是章名、下面一行是 `t(problem.message())`，点开打开这一章（`issue.doc`）；同一个文件同一个原因只发一次，合并好了或原因变了就撤掉（旧版的规则）。`on_preserved` 发「N 个改过的文件另存到了 .drifting/preserved」（`notifications.markdownFolder.preserved`）。回调在 dr-mirror 的线程上，要转到主线程。
4. **首次启动问位置**（旧版 `markdownFolderGuide.*` 那张卡片，欢迎卡片之后）：归首次体验那边。

## 测量（只作参考）

`cargo run --release -p dr-mirror --example mirror-measure -- <tiny|lite|heavy>`，dr-testkit 的种子库。测的时候机器负载 37–57（别的会话在编译），数字偏大：

| 种子 | 文件 | 大小 | 第一轮（全部写出） | 没事可做 | 每个文件都读一遍 | 外面改了一个文件 |
| --- | --- | --- | --- | --- | --- | --- |
| lite | 30 | 0.6 MB | 405 ms | 1 ms | 82 ms | 122 ms（64 KB 的文件） |
| heavy | 300 | 8.3 MB | 4.5 s | 12 ms | 4.5 s | 347 ms（161 KB 的文件） |

- 都在 dr-mirror 自己的线程上跑，不碰主线程。
- 「没事可做」靠大小和时间、版本号的比较：加快速路径之前同样的 heavy 要 2 s（每章都渲染一遍）。
- 第一轮和「每个文件都读一遍」主要花在每章读一份 Loro 副本、渲染、算 SHA-256；只在启动和 `sync_now` 时做。
- 一个文件的合并：分叉、段落配对、逐字差异、导入，加上这一轮其余章节的快速比较。

## 测试

在 `next/` 下 `cargo test -p dr-mirror`：

- `src/file.rs`：文件往返；别的编辑器写的属性（单引号、折叠块、列表、注释、BOM、CRLF）；写坏的属性拒绝。
- `src/body.rs`：几类难写的段落原样读回；空行是分隔和空段；属性测试：随机段落（中英文、各种 Markdown 标点、换行、五种样式和链接，任意组合）写出再读回完全相同（默认 512 例，`PROPTEST_CASES=50000` 跑过）。
- `src/plan.rs`：相像的段落配对、新段落不顶替；一段拆成两段只有一段保留身份。
- `src/layout.rs`、`src/disk.rs`：名字清洗和撞名后缀；整份写入、只给自己权限、不留临时文件；一个文件夹一个主人；另存的位置。
- `tests/merge.rs`（纯 dr-doc 文档）：两边改同一段都留下、段落身份不变；同一份文件读两次只算一次；增删段落、标题、引用、粗体照文件，写回来和作者写的一样；没改的文件什么都不做，居中留着；表格挪了不删、删了才删；空文档、清空和陌生基线。
- `tests/folder.rs`（真实库）：写出的路径、内容和权限；外面改字、加段、改状态和摘要，同时 Drifting 里改了同一段，合并后两边都在、人物名链上、写回的文件两边都有、再过一遍什么都不做；刚保存的文件不读也不盖；别的章节的 id 和写坏的属性（报、另存、重写；坏属性等修好，修好后合并）；太大的文件另存后重写；改名、删章、改书名；别的安装的文件夹；崩溃后同一个文件再读一遍不多字；每种问题都有文案；种子书写出再全部当成改过的读回来，摘要不变。
- `tests/service.rs`：跑起来以后，第一轮写出；外面保存的文件不用叫就合并进来（真的文件事件）；Drifting 里改的停笔后写回；停下时先写完。

## 待协调

1. ~~**F6**：上面挂接点 1–3（设置一节、应用起停、通知）~~：**F6 第九轮做了**（`dr_shell::mirror`，设置「本地数据」两行，首次运行的选文件夹一步也接上了）。
2. **M09 / F2**：旧版「一次删掉正文一半以上（且超过 200 字）时先存一份快照历史」还没做：要一个在合并前给文档打历史标签的口子（`DocHandle::label` 在 F3 的槽里，dr-mirror 拿不到，标签的种类也要 M09 认）。`merge::Merged` 已经带着删了多少字和原来多长。
3. **两边改了同一处时挂 TODO**（旧版「这一段同时在 Drifting 和外部文件里改过。」）还没做：要比较「基线 → 文件」和「基线 → 现在」在同一段里改的字有没有重叠，再经 F3 的批注命令挂一条。
4. **要素、故事线、类目、素材的只读文件**和 `开始阅读.md`、`正文/目录.md`、`注释与待办.md`、`.drifting/manifest.json`：旧版写给 Agent（MCP）和外部读者看。新版的帮手不读磁盘；要不要给外部的 Agent 再写一份，等 M32（MCP）定。
5. **第二期（旧版也没做）**：新建、删除、改名、移动文件同步回 Drifting；保留作者自己的 Markdown 写法（`_斜体_` 写回成 `*斜体*`）。
6. **M10**：旧库导入时 0.1 的 `local_markdown_mirror_file` 不搬：新版第一次写出时没有基线的旧文件先另存再重写，作者在旧版里没合并的修改会在 `.drifting/preserved` 里。

## 代码位置

- `next/crates/dr-mirror/src/`：`file.rs`（文件头）、`body.rs`（段落 ⇄ 行）、`plan.rs`（段落配对）、`merge.rs`（三方合并）、`layout.rs`（路径）、`disk.rs`（写文件、主人、另存）、`ledger.rs`（台账）、`sync.rs`（一次同步）、`service.rs`（监听和排期）。
- `next/crates/dr-mirror/tests/`：`merge.rs`、`folder.rs`、`service.rs`；`examples/mirror-measure.rs`（测量）。
- `next/crates/dr-export/src/import/mod.rs`：新加 `markdown_blocks`（导入的 Markdown 读法，给 M40 读文件）。
- `next/crates/dr-shell/tests/strings.rs`：「拷来的文案都有人用」也看 dr-mirror（通知那几行在它的 `Problem::message`）。
- 依赖：`notify` 8.2（CC0-1.0，macOS 用 FSEvents），`similar` 2.7 和 `icu_normalizer` 2.4 原来就在依赖树里（insta、url 带进来的）。
- 文案：`dr-i18n/keys.txt` 加 `notifications.markdownFolder.issue.*` 六条，`own/*.json` 加 `issue.owned`。
