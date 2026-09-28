# Category pages and element templates

An element category (分类) has a page of its own: its body, its template facts,
its relations and the body template new elements of the category start from.
Native only; no Tauri interoperability is kept.

## Domain contract

- A category body (`category:<id>`) is an ordinary durable owner, opened and
  closed like element and storyline bodies. Trash retires an open owner after
  the trash commits; restore refuses while an owner is open. Version history,
  relations and the writing assistant's prose tools cover category bodies.
- The element template (`element_template_json`) is a ProseMirror document the
  author edits as blocks: headings (levels 1–3) and paragraphs with bold and
  italic runs; other structures read as paragraphs of their text. Setting it
  writes `field.set elementTemplateJson`; an empty list clears it to `{}`;
  unchanged templates write nothing; mark ranges outside their block are refused.
- Creating an element in a category with a template creates it with the usual
  empty seed, then fills its body with the template's blocks through a
  short-lived owner as the author's input (one `entity.create` original, then
  the body's Yjs revisions). Templates no longer block creation.
- For the [element overview](element-overview.md), `categoryLayouts` lists
  each live category's placement (`auto`, or `pinned` at a grid cell) and
  `setCategoryLayout` pins a category or returns it to `auto` with `field.set`
  of `layoutMode`, `gridX` and `gridY`; unchanged placements write nothing.

No SQLite migration is added.

## Native interaction

A category opens as a “分类 · 名称” tab beside chapter, element, storyline and
drift tabs, in either split pane: double-click its 设定库 row or choose 打开分类页,
or click a 关系 row that names it. Categories are not entity-link targets. The
page (`MacCategoryPageView`) has a header on a wash in the category's colour
with 名称 and 颜色 (`updateCategory`, committed on Return, end of editing or a
colour choice), the live element count with 新建设定, and 模板字段, the same
ordered row editor as the 设定库's sheet (`setCategoryTemplateFacts`). Then come
设定 (the category's elements in library order, each opening its page in
the page's pane), the shared 关系 section, 新设定模版 and the category's own
body editor, with
历史版本… in the pane header. A refusal keeps typed text and rows and shows
the reason in Chinese.

设定 is filtered by 全部, 已填写 and 未填写 (with their counts), from what an
element page shows: an element is 已填写 when its 简介 has text, a 字段 has a
value other than the one the category's 模板字段 gave it (same key, trimmed),
or its body has text other than the 新设定模版 (lines compared without
surrounding spaces and blank lines); otherwise 未填写, so an element created
from the templates and not touched since is 未填写. Bodies are read with
`agentReadProse` (live from an open owner, else stored; a read only): all of
them when a page opens; after a library reply only 设定 not read yet (a new or
moved one), while the list itself follows the reply's library at once; and
only the element whose body settled at a new revision. Each sweep has a
generation, so a newer one stops an older chain. Until every body and the
template are read all elements show. The filter is kept per page in `settings.json` (`listFilters`,
`category:<id>`) like the [storyline page's](storylines.md).

新设定模版 previews how a new element's body starts, in the body editor's
typography. 编辑模版… opens a sheet of block rows: 正文 or 标题 1–3, the text,
and 加粗 and 斜体 for the selected text of that row (the whole row when nothing
is selected; italic rows are slanted because CJK faces have no italic). Return
adds a paragraph below, and rows move up, down or away. A live preview follows
every change. 清空模版 empties the rows. 保存 writes `setElementTemplate`, and
an unchanged template writes nothing. After 保存 every open page of the
category reads the stored template back. A refusal keeps the rows in the sheet.

An element created from the 设定库 or the page's 新建设定 opens with the
template body, and its later typing has its own undo history. Moving a category
to the trash asks first. The page's tabs in both panes and an open template
sheet close only after the trash commits; its elements move to 未分类 and their
pages stay open. A library reply that lists a category as trashed also closes
its tabs. Restore lists the category again, and its page reopens from the
stored body. The writing assistant lists categories in `list_elements`, reads
one with `read_category` (members, 模板字段, template and body) and proposes
`revise_category` or `append_to_body` with `kind: "category"`.

## Acceptance

Bridge tests cover the template round trip, an element created from a template
(headings, paragraphs and marks), clearing, refusals, the category body owner
with history and the assistant's reads, and trash/restore through cold reopen.

AppKit cases in `native/apple/Tests/CategoryAcceptance.swift` (`--categories-only`;
[binding report](acceptance/p2b-binding.json)) cover the page opened from the
设定库 beside chapter and element tabs, header and 模板字段 edits with their
originals, the body's own undo, a second pane and cold reopen. They cover the
template sheet: headings, paragraphs, bold and italic on a selected range, Return,
the preview, one `field.set` on 保存 and none when unchanged or cancelled, and
Rust's range refusal in Chinese. That refusal is injected at the page's save
seam. Elements created from the 设定库 and the page open with the template
body, and 清空模版 returns new elements to an empty body. A 关系 row from an
element page opens the 分类页, which lists the relation back. 历史版本
restores the body as one undoable edit, and the assistant reads and revises
the open body. Trash closes the tabs and sheet only after the commit, and
restore and cold reopen keep the body, 模板字段 and template. Physical input,
desktop XCTest and devices are not covered. `--small-items-only` lists six
elements (简介, a changed 字段, a written body, template-only, blank, and one
written later), filters them, follows a body edit and restores the filter
after a cold relaunch.
