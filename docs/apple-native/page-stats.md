# Page statistics, heading rail, scrollbar markers and 便笺栏

Reading aids beside the page a tab shows: 统计 of that page, the 大纲轨道 of
its headings and sections, ticks beside the body's scrollbar for notes,
TODOs and the writing assistant's pending revisions, and the 便笺栏 of notes
pinned to the page's margin. Native only; the renderer's stats panel,
outline rail, scroll markers and sticky-note rail are product references,
not parity targets. No Rust command or SQLite migration is added; nothing
here writes the journal.

## 统计 (页面统计)

视图 › 页面统计, or 统计 in the page header (beside the title of a chapter or
drift, beside the name of an element, storyline or category), opens a popover
of the page's statistics in plain labels. Rows naming a page (设定, 章节,
漂流) open it in the page's pane; values still being read show 统计中….

- **Chapter and drift**: 位置 (第 2 章 / 共 5 章, or 漂流 outside the book
  order) and 所在幕 (第一幕「启程」, 未分幕 before the first act, a drift's
  bound act); 字数 (the canonical count); 段落, 句子 and 对白比; 提到的设定
  (elements the body links, with counts, most first); 引用其他 (chapters and
  drifts it links); 被引用 (chapters and drifts whose bodies link it).
- **Element**: 出现 (chapters and drifts linking it, with counts), 首次出现
  and 最后出现 in book order, and the list of those bodies.
- **Category**: its 设定, 健康度 (how many are linked from a chapter or drift
  body, as a share), 最常提到 (up to five) and 从未提到.
- **Storyline**: its chapters with their words, the same by 写作状态, and
  核心设定 (the elements most linked across its chapters, up to five).

Definitions (`ProseShape`), over paragraphs only (headings, code and
read-only blocks do not count; paragraphs in quotes and lists do):

- 段落: paragraphs with non-whitespace text.
- 句子: runs of sentence ends. 。！？ always end one; ASCII . ! ? only before
  whitespace, a closing quote or the paragraph's end (3.14 does not); an
  ellipsis (…, ……, ...) only at the paragraph's end, since mid-paragraph it
  is a pause. A run counts once, closing quotes after it belong to it, and
  text after the last end is one more sentence.
- 对白比: characters inside “”, 「」, 『』 or straight "" (nested quotes once;
  an unclosed quote runs to the paragraph's end) over all characters, with
  whitespace and the quotation marks left out; whole percent, rounded.
- Link counts are spans: a stretch of adjacent runs linked to one target,
  as backlinks count them.

Sources: the open page's projection (shape and its own links), the word
count model, `workspaceOutline` (book order and acts), the libraries the tab
host holds, and a link index of every live chapter and drift read with
`readProjection` one body at a time: live from an open owner, else stored.
No owner opens and nothing is written. The index is kept per project until a
chapter or drift body saves, the writing assistant or Copilot revises one
(also closed), the chapter or drift lists change, a remote original is
accepted or a version is restored; statistics open at the time follow. A read
that went stale while it ran is read again for everyone waiting, so 统计中…
always settles. Closing the popover lets its statistics go; unchanged
statistics are not drawn again.

## 大纲轨道

Every tab's page (chapter, drift, element, storyline and category) has a rail
at its leading side: element, storyline and category pages list their fixed
sections (概述, 字段 or 模板字段, 章节, 设定, 章节模版 or 模版, 关系, 补丁,
被引用 where the page has them) and 正文, then the body's headings indented by
level. The rail follows the body's blocks as they are typed. The current item
is set in the label colour and a heavier weight, never an edge bar:

- the heading at or above a reading line near the top of the visible prose;
- 正文 before the first heading on pages with sections, else none;
- scrolled to the prose's end, the last heading in view.

A click on a heading lays the text out, scrolls the heading to the top (or as
far as the text allows) and puts the caret there; 正文 goes to the body's
start; a section is scrolled into view and 概述 puts the keyboard in the
name. 视图 › 大纲轨道 shows or hides the rail on every page of the active
page's kind; the choice is kept in `settings.json` (`outlineRails`, only the
hidden kinds). The 全书长卷 has no rail.

## Scrollbar markers

Each tab's body editor has a strip of ticks at the prose's trailing edge,
over the text container's inset and left of a scroller that takes room:

- open notes (yellow) and open TODOs (orange) anchored in the body, from the
  owner's live anchors and the project's comment rows; resolved, deleted and
  decided ones leave, and an anchor whose text was deleted has no tick;
- pending revisions of the writing assistant (purple) at each occurrence of
  the text they would replace (every occurrence for “all occurrences”).

A tick sits at its anchor line's share of the laid-out text height and is
placed shortly after the prose settles, so ticks follow typing, undo, both
panes and remote changes. Measuring lays the text out, so it happens only
when the ticks, the strip, the text column or much of the text (over 5%)
change; a typing pause keeps the measured heights while each tick's anchor
follows the text. Clicking a tick selects its anchor and scrolls it
into view; clicks between ticks reach the prose. 审阅, the chapter's 批注
panel and Copilot decisions reach the ticks through the project's comment
rows; the writing assistant announces changes of its pending revisions
(`AgentChatController.proposalsDidChange`). The 全书长卷's rows have none.

## 便笺栏

放入便笺栏 in a note's or TODO's ⋯ (审阅 and the 备忘与素材 board) pins it to
the margin of its own page (a floating TODO and a Copilot suggestion offer
none); 移出便笺栏 there, or 移出 on the card, unpins it. The column shows at
the page's trailing side while something is pinned: each card has the kind
(待办 · 已解决 once resolved), a passage note's quote and the body, on a wash
without an edge accent. Stacked (the default) only the newest card shows,
with how many lie under it; 展开 spreads them out, oldest first, and 叠起
stacks them again. A card opens its note as 定位 does (a passage note selects
its text); edits and resolves reach the card, a deleted note leaves (and
the list), and 清空便笺栏 unpins them all; the notes themselves never change.
Each page's pins and 展开 are kept in `settings.json` (`stickyNotes`, per
project and page, e.g. `node:<id>`); deleting the project removes them.

## Not ported

- Writing a new note from the 便笺栏 (the renderer's composer on the rail):
  notes are written with 添加批注… or in 审阅.
- The renderer's omission markers for very long outlines: the native rail
  scrolls instead.

## Acceptance

Seven programmatic AppKit cases in `native/apple/Tests/ReadingAidsAcceptance.swift`
(`--reading-aids-only`; [binding report](acceptance/p2b-binding.json)) drive
the real tab host, pages, editors, Rust workspace and SQLite with synthetic
prose: every statistic of a chapter, a drift, an element, a category and a
storyline against values computed by hand (对白比 with mixed quotes,
sentences with ellipses, words, links and backlinks), a click opening the
element, four bodies read with no owner opened and no journal row; the
rail's items per page kind, the highlight while scrolling and at the end, a
click scrolling and placing the caret, a new heading, the per-kind toggle in
`settings.json` through a cold relaunch; ticks at their anchors in both
panes following typing, a note turned into a TODO, a resolve and a delete,
a click selecting the anchor, and a pending revision ticked and cleared by
拒绝; and the 便笺栏 from ⋯ in 审阅 (none for a floating TODO), stacking and
展开, a card selecting its passage, an edit, a resolve and a delete reaching
the cards, 移出 and 清空便笺栏, and the pins in `settings.json` through a cold
relaunch; and a typing pause not measuring the ticks again while a new note
does. `--small-items-only` covers 统计 reading the bodies again after an
assistant revision of a closed chapter, a stale read settling and a closed
popover let go. Physical clicks, the popover on screen and the ticks' pixels
are not covered.
