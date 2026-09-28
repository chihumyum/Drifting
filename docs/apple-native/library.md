# Materials library, portraits, import, export and printing

The materials library (素材库) holds images and PDFs imported into the app's
own asset store, links and text notes. Elements can carry a portrait. Text can
be imported into a new chapter, drift or element, the book exported as
Markdown, plain text or PDF, and a page printed. Native only; no Tauri
interoperability is kept.

## Domain contract

- Asset bytes live at `<workspace>/assets/<project>/<asset>/source.<ext>`. An
  import writes an in-progress marker naming the importing session before any
  byte, copies the file atomically under a 200 MB cap and hashes it; the marker
  is cleared only after the `project_asset` and owner rows commit, and a failed
  commit removes the directory. Deleting removes the rows first and the bytes
  after the commit. Opening the workspace collects every directory no committed
  row retains (interrupted imports and deletes converge). Symlinks are refused.
- Library items (`library_item`, ordered by `order_key`) are `image`/`pdf` with
  an asset, `url` (http/https only) or `text` (body as a paragraph-per-line doc).
  Title, notes and a text note's body are edited with one `field.set` each;
  unchanged edits write nothing. Deleting purges the item's relations, the item
  and its asset row, then the bytes. Journals use `library-item` entities.
- `moveItem` places an item before another one (or last) in the authored
  order with `order.*` mutations on the `library-item` list in one original,
  then renumbers `order_key` by rank; a place it already has writes nothing.
- An item is associated (关联) with chapters, drifts, elements, categories and
  storylines through the built-in Generic association ([review](review.md)).
- A portrait imports an image asset and binds it to the element
  (`portrait_asset_id`, `field.set portraitAssetId`); replacing or clearing it
  releases the previous asset row and bytes. Trash keeps the portrait; restore
  brings the element back with it.
- Import creates the chapter, drift or element with an empty body, then its
  owner replaces the seed paragraph with one paragraph per imported block,
  applies each block's bold and italic marks (UTF-16 ranges in the block) and
  then heading levels (1–3; deeper levels become 3), saved as the author's
  input. The host parses the source file (txt, Markdown, docx) into blocks.
- Export walks the outline: the book title and summary, acts, then each
  chapter's title and body (read live from an open owner), with body headings
  shifted below chapter headings. Markdown keeps bold, italic, strike, code,
  links, quotes, lists and code blocks; entity links export as text.

No SQLite migration is added.

## Native interaction

素材库 (action row and 视图 › 素材库, ⇧⌘M) opens a panel of cards in the
library's order: a preview well, the title, a detail line and the notes. Image
wells show an ImageIO thumbnail and PDF wells PDFKit's first page, both
downsampled off the main thread from the read-only `assetPath` and cached; a
link shows its host (its address when the title already is the host); a note
its first two lines. Cards sit on a soft wash, stronger when selected.
导入文件… opens a multi-selection panel of images and PDFs, and files dropped on
the list import the same way. The host reads the type from the content
(ImageIO, else UTType), an image's displayed size and the 200 MiB cap, and
passes the extension Rust derives from the MIME type (JPEG is `jpg`). Files
that are not images or PDFs are named in the status in Chinese and nothing is
written for them. 添加链接… takes an optional title (default: the host) and an
address (no scheme means https; Rust refuses anything but http/https). 新建笔记
opens a sheet with 标题, 正文 and 备注.

Cards can be dragged to reorder the library; the drop places the card before
the card it lands above (after the last shown card at the end), also while
the 备忘与素材 board hides some kinds, whose items keep their places. A card's
menu offers 关联 (the project's live pages by kind) and 移除关联; its 关联
show as chips under the card, whose names open the page and whose × removes
the association. Pages' 关系 sections leave 关联 out.

Double-click, Return or 快速查看 previews an image or PDF in Quick Look (Space
toggles it; the arrow keys move the selection it follows), opens a link in the
browser and a note in its sheet. A card's menu adds 用默认应用打开, 在访达中显示 or
拷贝链接, 编辑笔记…, 重命名…, 编辑备注… and 删除…, which confirms and says whether a
stored copy goes with it. The sheet sends only changed fields; a refusal (an
empty title) keeps the typed text. Every reply's library replaces the list.

An element page shows its 肖像 in the header: the image, or the name's initial
on a wash, with 设置肖像… (更换肖像… once set; an image picker) and 移除肖像. An
image dropped on it replaces the portrait; anything else is refused before Rust.
Every open page of the element, and the 设定库 rows (a small portrait beside the
name), follow the reply.

文件 › 导入… (⇧⌘O) takes one or more Markdown, text and Word files, or a folder,
and reads each into blocks on the host.
Text: paragraphs split at blank lines with their lines joined (no space between
CJK characters); a file without blank lines keeps one paragraph per line.
Markdown, line by line: front matter and rules are dropped, `#`–`###` (and
setext) headings keep their level and deeper ones become 3, list items become
paragraphs keeping `- ` or their number, quotes and fenced code keep their
text; bold (`**`, `__`) and italic (`*`, `_`, nested or `***`) become marks
while code, strike, links and images reduce to their text. Word: AppKit's
Office Open XML reader, one block per paragraph keeping bold and italic runs
(a heading's own whole-text style is dropped); only a short paragraph without
closing punctuation at least 1.25× the body size (or with a header level)
becomes a heading. The title guess is the first `#` heading or first line
(Markdown), the first line (text) or the file name (Word). For one file a
sheet shows the editable title, 导入为 章节 (with an optional 故事线 it joins as
主线), 设定 (with a 分类 popup; none refuses) or 漂流, the block count and a
preview; 导入 creates the entity and opens its page once every open body is
idle, and lists and links read the new entity.

Several files, or a folder, open one sheet for all of them. It lists every
file sorted by name as the Finder sorts (第2章 before 第10章) with its format
and block count; a folder contributes its Markdown, text and Word files (not
subfolders, hidden or other files, which the summary counts), and a chosen
file of another kind, an empty or unreadable file is listed as skipped with
the reason. One target applies to all: 章节 with an optional 故事线, 设定 with
a 分类, or 漂流. 导入 imports the files one after another through the
single-file path, each with its guessed title (a chapter then joins the
storyline), and each line then reads 已创建「标题」 or 跳过 with Rust's
refusal (for example a 设定 name already used). The summary counts created and
skipped files and 完成 closes the sheet; lists and libraries learn about the
new entities and no page opens.

文件 › 导出全书… asks for a destination in a save panel whose 格式 popup offers
Markdown (.md) or 纯文本 (.txt), then writes Rust's text as UTF-8. Queued input
is refused first, since export reads open owners.

文件 › 导出为 Markdown 文件夹… (and per project on the
[项目书架](workspace.md) and in the project list's menu) asks for a folder, reads
`workspaceTransfer {"action":"exportArchive"}` — `{projectName,
documentCount, files:[{path, text}]}`: one file per chapter, drift, element,
category, storyline, note and material with YAML front matter, `[[路径|标题]]`
wiki links and a 关系 section, plus `index.md` and `README.md` — and writes it
into a new `<项目名>-<yyyy-MM-dd>` folder there (`/` and `:` in the name become
full-width; an existing folder gets `-2`, `-3` … instead of being reused).
Every path is checked before the first byte: absolute, `..`, `.`, empty or
backslashed components, and duplicates refuse the whole export. Files are
UTF-8 in subfolders, never overwriting. An alert reports the count and offers
在访达中显示. Reading writes no journal row; images and PDFs are not included.

文件 › 导出全部项目为 Markdown 文件夹… asks for a location, creates a new
`全部项目-<yyyy-MM-dd>` folder there (`-2`, `-3` … when it exists) and writes
every project's archive into its own folder inside it, exactly as the
single-project export does (the same path checks, `<项目名>-<yyyy-MM-dd>`
naming, `-2` for a second project of the same name). A project that fails is
named with its reason while the others still export; an alert lists each
project's folder and file count with the total and offers 在访达中显示.

## Printing and PDF

文件 › 打印… (⌘P) prints the focused page (the chapter being written in the
全书长卷, else the active tab's chapter, drift, element, category or
storyline) through the standard print panel, so 存储为 PDF… works there. The
page title heads the first page and the body follows in the editor's
typography (`DocumentStyle.typography`: 设置's face, size, line height,
first-line indent and manuscript language), in black whatever the
appearance. Each page's header holds the title and the page number; pages
lay out again when the panel's paper or orientation changes.

文件 › 导出 PDF… asks for a destination and writes the whole book in outline
order: a title page with the project's name and summary, a page per act, and
every chapter from a new page under its heading, with the book title and the
page number in the header (none on the title and act pages). The paper is
A4 or Letter as set in 文件 › 页面设置… (any other paper means A4). Body
headings are set one level below the chapter heading; bold, italic,
underline, strike, inline and block code, quotes, lists, rules and links are
styled, paragraphs keep their alignment and block indent (two em of the body
size per level, as in the editor), entity links are plain text and comments
are not marked. 打印… sets a page the same way.

Bodies come from `workspaceAgent readProjection` (`{projection:{text,
blocks}, live}`): an open owner gives its live text, including text whose
save failed. Nothing opens an owner or writes a journal row. Both commands
first wait up to three seconds for input still on its way to Rust (queued,
sending or composing), then refuse in Chinese. The export reads the project,
the outline and each chapter in turn, then sets and writes pages for about
25 ms per run-loop turn. A sheet shows the chapters read and the pages
written, with 取消. The PDF is written in a temporary folder and moved to the
destination only when complete, so cancelling or failing leaves no file and
an existing file untouched.

Each projected block names its enclosing containers (`blockquote`,
`bulletList`, `orderedList`, `listItem`, outermost first) and an ordered
item's number (`listNumber`, from the list's `start`), so quotes indent,
ordered items print their numbers and a list inside a quote keeps the
quote's indent. Limits: Quartz's PDF text extraction reads some CJK glyphs as
Kangxi radicals when text is copied or searched (Songti's 口 as ⼜); the
pages render correctly. Links are styled but not clickable.

## Acceptance

Core tests cover the asset store protocol and the library, portrait and
collection rules; bridge tests cover import/edit/delete/collection through the
C ABI and import/export of bodies.

Four programmatic AppKit cases in the [binding report](acceptance/p2b-binding.json)
(`--library-only`) drive the real panel, element pages, tab host and transfer
coordinator with files the test generates (PNG, JPEG, PDF, Markdown, text and
a Word document written by AppKit). They import a PNG and a PDF through
导入文件… and a JPEG by a drop, check the stored bytes, the MIME extension and
the loaded, downsampled thumbnails, add links and a note, preview through Quick
Look and Space, and refuse a text file and a `javascript:` link without a
journal row; rename, edit notes, a note's body and notes (one `field.set` per
changed field in one original, none when unchanged or refused) and delete with
confirmation (one `entity.purge`, bytes removed); set, replace by drop and
clear a portrait with the previous bytes released, following in the second
pane and the 设定库 row and refusing a PDF; import Markdown into a chapter, text
into an element of a chosen category and Word into a 漂流 with the expected
headings and paragraphs, export Markdown and text, and reopen cold with the
library, portrait and bodies intact. Reordering and 关联 are covered by the
[review](review.md) cases (`--review-only`). Physical drag and drop, the open
and save panels, the Quick Look window and devices are not covered.
`--small-items-only` chooses five files (two Markdown, a text file, a PNG and
an empty file) and imports them as chapters of a storyline, then a folder
with Markdown, text, a Word document written by AppKit, a PDF, a hidden file
and a subfolder as 设定 of a category (one refused as a used name) and as
漂流, checking the listed order, reasons, results, bodies, memberships and
journal; it exports three projects (two with the same name) twice and
compares every project folder with its archive, with no journal row.
`--trash-shelf-only` exports a Markdown folder into a temporary folder twice
(the second with `-2`), compares every written file with the archive, checks
subfolders, front matter and wiki links, 在访达中显示 and that no journal row
was written, and refuses four escaping paths without writing anything.

`--print-keys-only` ([binding report](acceptance/p2b-binding.json)) typesets a
synthetic projection of every block kind and mark; prints a drift and an
element page through `NSPrintOperation` to PDF files (no panel), on Letter
and again after the operation's paper changes to A4; exports books to a
temporary folder and reads them back with PDFKit: page count and paper, the
title page, act pages, chapters from new pages, headers with the title and
page number, body text in order, bold and italic font traits in 设置's family,
size, line pitch and first-line indent, an entity-linked name as plain text,
and an open chapter's text whose save failed; no journal row and no new owner.
It cancels while reading and while typesetting (no file at or beside the
destination, an earlier file untouched), checks the progress reported, and
waits for queued input before reading. The print panel, a printer and the
progress sheet on screen are not covered. The same run drives 设置 › 快捷键:
recording, the reserved and text-editing refusals and stored values the
rules now refuse ([settings](settings.md)). `--format-extras-only` prints a
page whose paragraphs are centred, indented and right-aligned with an
underline and a URL link, checks the typeset attributes from the live
projection and the positions of those lines in the PDF
([formatting](formatting.md)).
