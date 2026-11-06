# Comments in the text

Status: anchors built on 2026-08-30 and drawn in sand on the desktop on
2026-10-29; on 2026-11-04 the editor's sticky-note rail was retired, the
paper toolbar's comment button became the switch for the marks in the text,
new comments moved to a floating composer beside the selection, and pointing
at an anchor in the text lights its card.

Notes and TODOs live in the right panel's Review. The editor holds no second
list of them: what the prose shows is where each one is anchored.

## The paper's comment toggle

- The comment button in the paper's lower-right toolbar shows or hides the
  anchors of open notes and TODOs in the text, together with their ticks on
  the scrollbar. It is one preference for every paper (`commentMarksVisible`
  in the settings store, on by default), kept on this device and not synced,
  like the outline and reference-link toggles. Chapter, idea, element,
  storyline, category and material-note papers and the whole-book reader all
  carry it; the number on it is the paper's open anchors (in the whole-book
  reader, its chapters' only: ideas are not in the book).
- Off, the prose draws only the anchor of the card under the pointer (Review
  or a TODO card) and of a selected comment (its card's jump to the text, its
  scroll tick, or one just written). It arrives as sand does and fades out when
  the pointer leaves or the selection ends.

## Pointing at an anchor

On the desktop, resting the pointer on an anchored passage for 0.12s
(`POINT_INTENT_MS`) lights its card in the right panel's Review: the card brings
its glass in as it does under the pointer, and the anchor's swash turns as when
its card is pointed at. Overlapping anchors light their cards together; moving
off the passage lets go at once; only passing over it, or dragging across it to
make a selection, lights nothing.

- The sand layer still takes no pointer, so the caret, selection and IME never
  meet it. `CommentSandPainter` listens for pointer moves on the scroller and,
  at most once a frame, finds the marks whose measured line boxes hold the
  pointer; after the intent it publishes them (`setPointedCommentHighlights`),
  and `CommentAnchorHighlights` feeds them back to the painter as hot.
- A card that lights up while the Review panel is open is scrolled into its
  list's view if it is outside it (`use-prose-pointed-card.ts`). A closed or
  off-screen panel is left alone: it does not open by itself.
- With the comment toggle off the text draws no anchors, so pointing at it does
  nothing.
- Scrolling under a still pointer is not followed; the next move finds what is
  under it.

## Writing a comment

Selecting text and choosing comment in the selection bar opens the floating
composer beside the selection (`EditorCommentComposer`, which uses the same
`CommentComposer` as regions drawn on images and PDFs): a paper field, note or
TODO as one of a set, cancel as a text button and save as the primary; `⌘↩`
saves and `Esc` cancels. The comment keeps the selection's text anchor and the
blocks it spans. Writing it selects it, so its anchor is drawn along the lines
even while the toggle is off. A request from another paper is not shown.

## Prose anchor highlights

- Every open block-anchored note and TODO keeps a light resting wash on its
  anchored prose in chapter, element, storyline and category editors, in
  material notes and in the whole-book reader, while the toggle is on.
  Resolved and converted items have no resting wash; Copilot proposals have
  none either.
- A precise text anchor paints only its text, and only while the live text still
  matches the captured selection (relocating to the nearest occurrence after
  earlier edits). Otherwise, or for whole-block anchors, the anchored blocks are
  washed. Unresolvable anchors paint nothing.
- Hovering a card in Review or the TODO workbench adds a stronger overlay on
  that item's anchor, including resolved and Copilot items.
- Highlights are display-only. They never change ProseMirror DOM, Yjs or
  exports, and painters re-resolve anchors 150ms after prose DOM mutations.
  Every shell draws each anchor in sand: a dry highlighter swash along
  every line it covers, on a text-free layer after the page inside
  `.editor__spread` that blends with the words like pigment (multiply /
  screen) so they keep their colour and read as lying on it
  (`lib/comment-sand.ts`). In the whole-book reader the anchor follows the copy
  of a chapter that is shown (live editor or static copy). Its geometry follows
  prose mutations on the next animation frame, the whole-book reader measures
  only rows near the viewport, and a hidden surface stops observing while
  keeping its sand. Selecting a comment draws its swash again along the lines
  until the author clicks or types in the prose; resolving fades it out. See `docs/design-system/materials.md` ("砂笔进正文").
- Strokes are per family (note rouge, TODO ochre, Copilot blue on hover) and
  add no border, left bar or layout change.

## Checks

- `comment-anchor-highlight.acceptance.test.ts` and
  `comment-sand.acceptance.test.ts`: which comments paint and how.
- `comment-marks-toggle.acceptance.test.ts`: the rail's removal, the composer
  on every entity editor, the toggle preference and its effect on the anchors
  and scroll ticks.
- `scroll-marker-model.test.ts`: comment ticks follow the toggle.
- `comment-sand.test.ts` (line hit test, the 0.12s intent) and
  `review-stats-sand-glass.render.test.ts` (a pointed card is lit).
- `node scripts/run-prose-point-acceptance.mjs` writes
  [`acceptance/prose-point.json`](acceptance/prose-point.json) from the real
  painter in Chromium with mouse input (rest, leave, pass over, drag, scroll);
  `--check` verifies it is current.
