# Native editor formatting, find and pickers

Selection marks (bold, italic, underline, strike, URL links), block styles
(paragraph, heading 1–3), block attributes (alignment, indent) and quotes and
lists (引用, 无序列表, 有序列表) use the same document owner, history and
persistence path as typing, in every Mac body editor: chapter, drift,
element, category and storyline pages and the 全书长卷. The slash menu,
Markdown-style starts, find and the @ picker are editor tools on that path.
Native only; no Tauri interoperability is kept. The deferred UIKit editor keeps
bold, italic and the paragraph-style menu.

## Document commands

`DocumentSession::format_native(NativeFormatting)` (`documentFormat`) takes the
displayed revision, a global UTF-16 range and one action: `bold`, `italic`,
`underline`, `strike`, `paragraph`, `heading1`–`heading3`, `alignLeft`,
`alignCenter`, `alignRight`, `indentIncrease`, `indentDecrease`, `blockquote`,
`bulletList` or `orderedList`. The core
validates the whole selection before mutation; one command is one local
transaction and one undo unit, also across paragraphs, and a command that
changes nothing writes nothing and keeps the revision. There is no separate
typing-marks state.

- **Marks** need selected text. They are removed when all selected text has the
  mark, otherwise applied across it; other marks and entity links stay.
- **Headings** change the actual tag and level and keep text, block IDs, typed
  metadata, comments, selection lineage, alignment and indent. **Paragraph**
  converts selected root text blocks, removes their level and clears bold,
  italic and strike from selected characters only (a caret clears nothing);
  entity links, unknown metadata, alignment and indent stay. Resetting inside
  quotes and lists, or turning a list item's first paragraph into a heading, is
  refused atomically.
- **Alignment and indent** set the block attribute `textAlign` (`center`,
  `right`; left removes it) or `indent` (1–8; 0 removes it) on every paragraph
  or heading the selection touches; a caret takes its block. Other block kinds
  refuse. Enter carries both to the next block of the same kind.
- **Quotes and lists** toggle over the paragraphs and headings the selection
  touches (a caret takes its block), keeping text, public block IDs, marks,
  typed metadata and comment anchors (`crates/drifting-document/src/wrapping.rs`).
  Consecutive root blocks are wrapped in one new root container (a list puts
  each block in its own `listItem`). Blocks that are all direct children of one
  root quote, or each the only paragraph of an item of one root list of that
  kind, are lifted to the root when they are the first ones, the last ones or
  all of it. Anything else refuses before mutation: the middle of a quote or
  list, the other list kind, a quote around a list item, a list inside a
  quote, a mixed selection, an item of several paragraphs and nested
  structures. Blocks report `containers` (outermost first) and `listNumber`.

`DocumentSession::link_native(NativeLinking)` (`documentLink`) sets the URL
link mark `link: {href}` on selected text — a trimmed http, https or mailto
address without spaces, at most 2,048 bytes — replacing URL links there and
keeping entity links and other marks. Without an address it removes URL links
from the selection, or at a caret the whole link around it.

The bridge guards pending recovery and active drafts or composition, then uses
the durable session. `NATIVE_FORMATTING_UNAVAILABLE:` marks a refusal before
mutation, for formatting and links alike: Swift keeps its input bases, resumes
queued input and shows the reason in Chinese. A persistence failure instead
returns the edited state with `saved: false`; retry keeps the change without a
duplicate operation.

## Native interaction

- **格式 menu**: 加粗 ⌘B, 斜体 ⌘I, 下划线 ⌘U, 删除线; 正文, 标题 1–3; 引用,
  无序列表, 有序列表 (no default shortcut: Mac apps disagree, so the author
  assigns one in 设置 › 快捷键); 左对齐, 居中 and 右对齐 on the macOS ⌘{ ⌘| ⌘}
  (shown and recorded with their ⇧, as ⇧⌘{); 增加缩进, 减少缩进; 链接… ⌘K,
  移除链接. Items are checked for the selection: a mark when all selected text
  has it (mixed when some), the block style, quote or list kind and alignment
  of the touched blocks. The prose context menu has the same 格式 submenu, and
  打开链接 on a URL link. Every body's toolbar offers 加粗, 斜体, 下划线, 删除线,
  段落样式, 对齐, 减少缩进, 增加缩进, the toggles 引用, 无序列表 and 有序列表 (on
  for the caret's quote or list) and 链接…; a narrow pane drops the last
  controls first. A refused quote or list says why in Chinese with what to do
  (只能取消引用开头或结尾的段落，或整段引用; 请先取消列表再切换列表类型; …).
- **Markdown-style starts**, as in the renderer: “> ” (引用), “- ”, “+ ” or
  “* ” (无序列表) and “1. ” (有序列表), full-width forms and the ideographic
  space included, typed as the whole text before the caret in a root
  paragraph, remove the marker through the input path and then apply the
  format once that input lands (two undo units), as a slash row does. Other
  numbers, a marker inside a sentence and one in a quote or list stay text.
- **Return and ⌫ in quotes and lists**: Return in a quote paragraph adds a
  paragraph to the quote; in a non-empty list item it adds a paragraph to the
  same item, drawn without a marker (the core has no item split). Return on
  an empty paragraph that is the last of its quote, or on an empty list item
  holding one paragraph that is its list's last, lifts it out (ends the quote
  or list, one undo unit). ⌫ at the start of a quote's first paragraph, or of
  the only paragraph of a list's first or last item, lifts it out instead of
  joining it to the paragraph before. ⌫ at a middle item, and any deletion
  across list items or between a list and the paragraph beside it, is
  refused before input is queued (列表项之间不能合并…), as Rust would refuse it.
  So after typing in an item, Return twice does not leave the list: ⌫ the
  empty paragraph and continue below the list, or end it from an empty item.
- **Keys**: Tab and ⇧Tab indent the caret's paragraph or every selected one, as
  in the renderer, and never type a tab character. ⌘[ and ⌘] stay free for
  back and forward. The shortcuts are listed in 设置 › 快捷键
  ([settings](settings.md)).
- **Guards**: pending input, marked text, recovery and failed drafts disable
  the commands, as for bold and italic. Tab, ⇧Tab, a slash-menu row, a
  Markdown start or Return/⌫ ending a quote or list, given while typed text is
  still on its way, applies once it lands, only to the blocks its selection
  touched then (a paragraph the queued input creates is named by its reply,
  its range following this view's own typing meanwhile), never elsewhere.
  Typing on in those blocks, marked text included, keeps it; input that adds
  or removes a line break or lands elsewhere, any other key command (Return,
  ↓ …), a click in the prose, a failed draft or save and a render that removed
  the block drop it. Formatting keeps selection, focus and scroll position.
- **Rendering** (`DocumentStyle`, every editor, the 全书长卷's rows and
  read-only previews and the 历史版本 preview): underline and strike; URL links
  in the system link colour, underlined (an entity link's own presentation
  wins on the same text); paragraph alignment; an indent shifts the whole
  block by two em of the body size per level, on top of 设置's first-line
  indent. A quote indents two em on the left and ends two em short on the
  right, in the secondary text colour, with no bar. A list level indents two
  em; the first paragraph of each item shows its marker (`listNumber` with a
  full stop in an ordered list, •, ◦ and ▪ by level otherwise) half an em
  before its text. Markers are drawn by the text view with its background
  (`ListMarkerTextView`), never typed, so the prose, caret and selections
  exclude them; the view keeps its TextKit engine. An empty paragraph's line
  break carries its paragraph style, so its caret follows the alignment.
  Headings are 28/24/20 pt at the 17 pt body. Printing and the PDF export set
  the same, with the markers as text ([library](library.md)).
- **链接…** needs a selection, or a caret inside a URL link (which selects the
  link). The sheet is prefilled from the existing link or a selected address (a
  URL, a `www.` host or an e-mail address); a bare domain becomes https and a
  bare e-mail address mailto; any other scheme, such as `javascript:`, is
  refused in Chinese and the typed address stays. 移除链接 shows when there is a
  link. The range and revision are taken when the sheet opens. ⌘-click on a URL
  link, or 打开链接, opens http, https and mailto addresses in the default app; a
  plain click edits. Typing never autolinks.
- **Slash menu**: “/” typed at the start of an empty paragraph or heading (also
  ／, and 、, which the / key types with Pinyin) opens a popover at the caret
  with 正文, 标题 1, 标题 2, 标题 3, 引用, 无序列表, 有序列表, 居中 and 右对齐.
  Typing filters by title or keyword (`h1`, `quote`, `ul`, `ol`, `center` …);
  ↑ and ↓ move, Return chooses: “/query” is deleted
  through the input path, then the format applies once that input lands (two
  undo units). Esc, a caret moved away, lost focus, a space, sentence
  punctuation or no match closes it and leaves the text.
- **Find**: ⌘F shows the standard find bar of the page's editor with
  incremental search highlighting every match; ⌘G, ⇧⌘G and ⌘E work as in every
  Mac app (编辑 › 查找…, 查找下一个, 查找上一个, 用所选内容查找). While the bar is open,
  incremental search moves a highlight and selects the match when the bar
  closes. The bar has no 替换: a replacement from it would not pass through the
  binding's input path, and 全部替换 could not be one undo unit. The 全书长卷
  offers no find.
- **@ picker**: “@” (or ＠) typed anywhere except right after an ASCII letter
  or digit (an e-mail address) opens a popover of the project's live element
  names and aliases (latest edited first) and chapter titles (book order),
  without the body's own element or chapter, and only names the link pass
  resolves to that row's target ([entity links](entity-links.md)). Typing
  filters (exact, then prefix, then other matches; at most 30). A space or
  sentence punctuation (，。！？；：、,.!?;:…) closes it. A query that names
  nothing keeps the picker open with only ＋ 新建设定 rows while it is at most
  ten UTF-16 units long; beyond that, or without rows, the picker goes inert
  (hidden, ↑, ↓ and Return act on the text) and shows again when ⌫ brings back
  a query with rows, so a mistyped homophone can be corrected. Return replaces “@query” with
  the highlighted name through the input path and asks for a link pass, which
  links it as [automatic linking](entity-links.md) does — leftmost-longest,
  so a longer overlapping name wins. After the names, a query no element is
  named or aliased and the pass does not resolve adds ＋ 新建设定「…」 for each
  category; Return takes one only after ↑ or ↓ moved to it (otherwise it
  closes the picker and types a new line). It creates the
  element there, every open view adopts the library, and the name is inserted
  and linked while “@query” is still in place, leaving the caret or a
  selection where the author has put it meanwhile. Esc leaves the text.
- **Both pickers** close when undo, another pane, a remote change or the
  writing assistant replaces the prose, and a row is chosen only while its
  trigger and query are still under the caret; otherwise nothing is edited.

## Acceptance and limits

- Rust document tests cover marks, heading levels, paragraph reset, atomic
  refusal, underline and strike, alignment and indent (clamped at eight, no-op
  without a write, headings keeping both), URL links (set, replace, removal
  at a caret, entity links kept, refusals) and quotes and lists (wrap and lift
  as one unit with marks and a comment kept, first or last blocks only, the
  other kind refused, numbering); bridge tests cover format, history, refusal,
  save retry and alignment, indent, underline, links, quotes and lists through
  a cold reopen of the workspace SQLite.
- `--format-extras-only` (twelve AppKit cases in
  `native/apple/Tests/FormatExtrasAcceptance.swift`, in the
  [binding report](acceptance/p2b-binding.json)) drives the real tab host, both
  panes, the Rust workspace and SQLite: every command through the menu, its
  key, the toolbar and the context submenu with checkmarks, one undo unit each,
  unchanged commands writing nothing, marked text disabling them, Tab and ⇧Tab
  (also while input is queued, up to eight levels), the drawn attributes, the
  link sheet (prefill, replace, `javascript:` refused in the sheet and in Rust,
  removal three ways, entity links kept), ⌘-click and 打开链接 through an
  injected opener, the slash menu, find, the @ picker with element creation,
  printing a page with these attributes and a cold reopen; the review fixes:
  an e-mail address, CJK prose and sentence punctuation around “@”, ＋ rows
  alone, names shadowed by a chapter or a drift, undo and a writing-assistant
  change closing the pickers, a created name keeping the caret and a
  selection, and a waiting Tab or slash row reaching only its own block (also
  a new one) and dropped by Return, ↓, a failed save and a block another pane
  removed; and typing (also marked text) right after a slash row or Tab while
  its input is queued keeping the heading or indent, and a mistyped @ query
  corrected with ⌫, an inert picker not taking Return. `--style-only` and the
  older formatting cases keep the incremental-style reference.
- `--quotes-lists-only` (five AppKit cases in
  `native/apple/Tests/QuotesListsAcceptance.swift`) covers each toggle by
  menu, an assigned shortcut, the toolbar, the context submenu and the slash
  menu with checkmarks, one undo unit each, block IDs and a comment on a
  wrapped paragraph kept, both panes drawing indents and markers, and a cold
  reopen; Markdown starts (an empty chapter, text after the caret, typing on
  at once, non-starts); Rust's refusals in Chinese writing nothing and
  deletions across items refused without a failed draft; Return and ⌫ ending
  quotes and lists (also while input is queued) and Return in an item; and
  printing, the PDF, the 全书长卷's editor rows and previews and the 历史版本
  preview drawing the markers.
- Not covered: physical keys and clicks, the popovers and find bar on screen,
  typing into the find bar's field, input-method composition inside a
  picker's query, the markers' pixels (the tests record which markers each view
  draws), nested quotes and lists (read and drawn, not created), splitting a
  list item and ending a list from an item of several paragraphs, which need
  a new core edit.
