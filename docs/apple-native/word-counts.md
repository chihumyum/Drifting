# Word counts and body projections

Chapters and drifts keep the renderer's derived projection of their live Yjs
body: the ProseMirror JSON body cache (`node_content.content_json`), the heading
outline (`outline_json`) and the canonical word count with its basis
(`book_node.word_count*`). The Mac client shows the counts.

## Domain contract

- The projection follows y-prosemirror's `yDocToProsemirrorJSON` over the
  `default` fragment: `{type, attrs?, content?}` elements (`content` whenever
  the element has children) and `{type:"text", text, marks?}` runs, each mark
  `{type, attrs}` with the overlapping-mark `--<hash>` suffix removed. Native
  orders marks deterministically (a key keeps its place while it stays active
  across runs; marks opening together follow the schema's mark rank) and
  attribute keys by schema declaration order. This is not byte-compatible with
  the renderer's Yjs-internal order, which the 2026-09-27 scope decision no
  longer requires; counts are unaffected.
- `@drifting/prose-metrics` is ported exactly: `countWords` over
  `extractProseText` (a space after each container child) and the basis hash,
  SHA-256 of the canonical (sorted-key) JSON. The outline is
  `serializeOutline(extractOutline(contentJson))`; a heading without a block ID
  gets `outline_native_<position>` where the renderer draws a random ID.
- After every save of a chapter or drift body, a derived transaction writes the
  projection at the saved Yjs revision (`word_count_basis_kind='yjs'`), unless
  the stored one is already exact (`canReuseCanonicalProjection`). A save that
  committed local edits stamps `updated_at`, as the editor save does; opening
  a body does not. A stale revision is refused, and a failed projection never
  fails the save.
- `workspaceMetrics reconcile` projects every live chapter and drift with
  durable prose without touching `updated_at`, as `reconcileProjectProseMetrics`
  does when a project opens; bodies without Yjs state keep their seed basis.
  `counts` returns each live node's canonical count (`null` until a basis
  exists). No original is ever written, and no SQLite migration is added.

This closes the JSON body-cache gate for chapter and drift bodies; element,
category and storyline body caches remain creation seeds.

## Native interaction

The Mac client reads counts; it never computes or stores them. Each project
has one count model in the tab host. The first read reconciles, as the
renderer does on project open. It runs when a project is selected, or when
the first page of a project opens. Later reads only read
counts. They are debounced (0.3 s) and sent one at a time, and a reconcile
covers any read queued behind it. The Mac reads again when:

- a chapter or drift body settles at a revision it has not counted yet (typing,
  formatting, undo and redo, entity links, or opening the body). Idle moments
  that keep the revision, and 保存正文 on an unchanged body, read nothing. No
  extra save is made;
- the chapter or drift list changes (create, trash, restore);
- a remote original is accepted. This runs a reconcile, because receipts save
  open owners but not bodies without one.

The wording and number formats follow the renderer's zh-CN strings:

- Chapter list rows, outline chapter rows and 漂流 panel rows end with the
  chapter panel's compact count in quiet secondary text: “0 字”, “521 字”,
  “1.2k 字”, “12k 字”. Screen readers hear the full number.
- The chapter page shows “1,234 字” after its title, and the drift page shows
  it at the end of its title line. It reads 统计中… until the project's counts
  arrive.
- The window's status line sits at the trailing end of the message line:
  “当前 1,234 字 · 全书 5,678 字” for a chapter or drift page, with a
  chapter's 主线 and its total between them (“主线「北境」3,456 字”,
  [workspace](workspace.md#status-line)), “故事线 … 字” on a storyline page,
  and the book alone otherwise. The book total sums chapters
  only. It shows 统计中… until every live chapter has a count, and 正文统计中
  before the first read.
- 项目资料 shows “全书 1,234 字” under the status counts.
- A node without a canonical count shows nothing in rows or on its page.
  Today's words (今日字数) are derived from these counts on the Mac; see
  [whole book](whole-book.md).

## Acceptance

`pnpm apple:workspace-metrics:acceptance` generates
[the word-count report](acceptance/p3k-word-counts.json): document, core and
bridge suites. For every exported chapter and drift, the renderer's
`deriveCanonicalNodeProseProjection` over the durable Yjs state reproduces the
count, basis, outline and body cache, and `canReuseCanonicalProjection` reuses
the native rows. Reconcile writes no original and stamps nothing. A synthetic
y-prosemirror corpus replayed into native sessions matches renderer counts and
outlines. Native is not byte-compatible with the renderer: attribute key order
(hash-neutral) and mark order (affecting the body cache and basis hash) are
pinned with exact values.

Four programmatic AppKit cases in the
[binding report](acceptance/p2b-binding.json) (`--word-counts-only` runs only
these) drive the real chapter and drift pages, outline, 漂流 panel and project
sheet, wired as the app wires them, and compose the status line as the app
does. Counting and reconcile write no `sync_change_set` row and
change no `updated_at`.

- **Typing.** CJK and Latin text typed into a chapter page in three edits is
  read once, then shown in the page header, the outline row, the status line
  and the sheet total. 保存正文 on the unchanged body reads nothing. Undo and redo follow, and a
  1,234-word chapter reads “1.2k 字” in rows and “1,234 字” in its header.
- **Drifts.** A new drift and its typed body are counted on its page and panel
  row but not in the book total. Trash removes the count and restore returns it.
- **Project open.** Synthetic rows give one never-opened chapter a stale count
  and one no count. Rows show nothing for the uncounted chapter, and the totals
  read 统计中…. Selecting the project reconciles both in one read, and selecting
  it again only reads counts.
- **Trash and reopen.** Chapter trash removes the chapter from the book total
  and the outline, and restore returns it. After a cold reopen the first page
  shows 统计中… until the reconcile returns the same counts.

The chapter list and the window are part of the app, which the acceptance
binary does not build; the status line's text comes from the tab host
(`wordStatusLine`), which the suites read. The window was checked in an offscreen render.
Remote receipts, physical input, desktop XCTest and devices are not covered.
