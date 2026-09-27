# Materials library, portraits, import and export

The materials library (素材库) holds images and PDFs imported into the app's
own asset store, links and text notes. Elements can carry a portrait. Text can
be imported into a new chapter, drift or element, and the book exported as
Markdown or plain text. Native only; no Tauri interoperability is kept.

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

文件 › 导入… (⇧⌘O) reads one Markdown, text or Word file into blocks on the host.
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
(Markdown), the first line (text) or the file name (Word). A sheet shows the
editable title, 导入为 章节, 设定 (with a 分类 popup; none refuses) or 漂流, the
block count and a preview; 导入 creates the entity and opens its page once
every open body is idle, and lists and links read the new entity.

文件 › 导出全书… asks for a destination in a save panel whose 格式 popup offers
Markdown (.md) or 纯文本 (.txt), then writes Rust's text as UTF-8. Queued input
is refused first, since export reads open owners.

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
