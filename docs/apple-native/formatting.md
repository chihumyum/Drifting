# Native editor formatting, find and pickers

Selection marks (bold, italic, underline, strike, URL links), block styles
(paragraph, heading 1–3) and block attributes (alignment, indent) use the same
document owner, history and persistence path as typing, in every Mac body
editor: chapter, drift, element, category and storyline pages and the
全书长卷. The slash menu, find and the @ picker are editor tools on that path.
Native only; no Tauri interoperability is kept. The deferred UIKit editor keeps
bold, italic and the paragraph-style menu.

## Document commands

`DocumentSession::format_native(NativeFormatting)` (`documentFormat`) takes the
displayed revision, a global UTF-16 range and one action: `bold`, `italic`,
`underline`, `strike`, `paragraph`, `heading1`–`heading3`, `alignLeft`,
`alignCenter`, `alignRight`, `indentIncrease` or `indentDecrease`. The core
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

- **格式 menu**: 加粗 ⌘B, 斜体 ⌘I, 下划线 ⌘U, 删除线; 正文, 标题 1–3; 左对齐,
  居中 and 右对齐 on the macOS ⌘{ ⌘| ⌘} (shown and recorded with their ⇧, as
  ⇧⌘{); 增加缩进, 减少缩进; 链接… ⌘K, 移除链接. Items are checked for
  the selection: a mark when all selected text has it (mixed when some), the
  block style and alignment of the touched blocks. The prose context menu has
  the same 格式 submenu, and 打开链接 on a URL link. Every body's toolbar offers
  加粗, 斜体, 下划线, 删除线, 段落样式, 对齐, 减少缩进, 增加缩进 and 链接…; a narrow
  pane drops the last controls first.
- **Keys**: Tab and ⇧Tab indent the caret's paragraph or every selected one, as
  in the renderer, and never type a tab character. ⌘[ and ⌘] stay free for
  back and forward. The shortcuts are listed in 设置 › 快捷键
  ([settings](settings.md)).
- **Guards**: pending input, marked text, recovery and failed drafts disable
  the commands, as for bold and italic. Tab, or a slash-menu row, pressed while
  typed text is still on its way applies once it lands, only to the blocks its
  selection touched then (a paragraph the queued input creates is named by its
  reply), never elsewhere: later input, any other key command (Return, ↓ …),
  a click in the prose, a failed draft or save and a render that removed the
  block drop it. Formatting keeps selection, focus and scroll position.
- **Rendering** (`DocumentStyle`, every editor and the 全书长卷's read-only
  rows): underline and strike; URL links in the system link colour, underlined
  (an entity link's own presentation wins on the same text); paragraph
  alignment; an indent shifts the whole block by two em of the body size per
  level, on top of 设置's first-line indent. An empty paragraph's line break
  carries its paragraph style, so its caret follows the alignment. Headings are
  28/24/20 pt at the 17 pt body. Printing and the PDF export set the same
  ([library](library.md)).
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
  with 正文, 标题 1, 标题 2, 标题 3, 居中 and 右对齐. Typing filters by title or
  keyword (`h1`, `center` …); ↑ and ↓ move, Return chooses: “/query” is deleted
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
  filters (exact, then prefix, then other matches; at most 30). A space,
  sentence punctuation (，。！？；：、,.!?;:) or a query that names nothing closes
  it, so ↑, ↓ and Return act on the text again. Return replaces “@query” with
  the highlighted name through the input path and asks for a link pass, which
  links it as [automatic linking](entity-links.md) does — leftmost-longest,
  so a longer overlapping name wins. After the names, a query no element is
  named or aliased and the pass does not resolve adds ＋ 新建设定「…」 for each
  category; Return takes one only after ↑ or ↓ moved to it. It creates the
  element there, every open view adopts the library, and the name is inserted
  and linked while “@query” is still in place, leaving the caret or a
  selection where the author has put it meanwhile. Esc leaves the text.
- **Both pickers** close when undo, another pane, a remote change or the
  writing assistant replaces the prose, and a row is chosen only while its
  trigger and query are still under the caret; otherwise nothing is edited.

## Acceptance and limits

- Rust document tests cover marks, heading levels, paragraph reset, atomic
  refusal, underline and strike, alignment and indent (clamped at eight, no-op
  without a write, headings keeping both) and URL links (set, replace, removal
  at a caret, entity links kept, refusals); bridge tests cover format, history,
  refusal, save retry and alignment, indent, underline and links through a cold
  reopen of the workspace SQLite.
- `--format-extras-only` (ten AppKit cases in
  `native/apple/Tests/FormatExtrasAcceptance.swift`, in the
  [binding report](acceptance/p2b-binding.json)) drives the real tab host, both
  panes, the Rust workspace and SQLite: every new command through the menu, its
  key, the toolbar and the context submenu with checkmarks, one undo unit each,
  unchanged commands writing nothing, marked text disabling them, Tab and ⇧Tab
  (also while input is queued, up to eight levels), the drawn attributes, the
  link sheet (prefill, replace, `javascript:` refused in the sheet and in Rust,
  removal three ways, entity links kept), ⌘-click and 打开链接 through an
  injected opener, the slash menu, find, the @ picker with element creation,
  printing a page with these attributes and a cold reopen; then the review
  fixes: an e-mail address, CJK prose and sentence punctuation around “@”,
  ＋ rows alone, names shadowed by a chapter or a drift, undo and a
  writing-assistant change closing the pickers, a created name keeping the
  caret and a selection, and a waiting Tab or slash row reaching only its own
  block (also a new one) and dropped by Return, ↓, a failed save and a block
  another pane removed. `--style-only` and
  the older formatting cases keep the incremental-style reference.
- Not covered: physical keys and clicks, the popovers and find bar on screen,
  typing into the find bar's field, and input-method composition inside a
  picker's query. The version-history preview shows plain text, since the
  history entries Rust returns carry text only.
