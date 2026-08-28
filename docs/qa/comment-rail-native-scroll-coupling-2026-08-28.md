# Comment rail visual and scroll coupling acceptance

Date: 2026-08-28

## Product contract

- Enabling the comment rail may reveal comment cards and their card-local
  controls. It must not add a color strip, gradient, wash, or opaque veil over
  the paper, and it must not reflow the manuscript.
- An anchored comment card and its manuscript block share one vertical scroll
  coordinate. During wheel, trackpad, or touch scrolling they must move as one
  surface, without a JavaScript-followed frame trailing the prose.

## Implementation boundary

- The node editor mounts `CommentRail` inside `editor__spread`, which is inside
  the native `editor-scroll` owner. The absolutely positioned rail remains an
  overlay and therefore does not consume manuscript layout width.
- The browser compositor supplies ordinary vertical motion for both prose and
  cards. Card layout is still measured when the rail mounts or its geometry
  changes. A `scroll` listener is retained only as a fallback for a future
  portal that is outside the native scroll tree.
- The mobile open-state rule keeps the rail background transparent. Rail width
  and padding size the cards only; no paper-covering visual layer is allowed.

## Machine-checkable evidence

`src/renderer/components/editor/comment-rail-scroll-coupling.acceptance.test.ts`
checks the node-editor nesting, native-scroll listener guard, transparent mobile
open state, and this durable contract.

## Validation boundary

The focused automated acceptance test and TypeScript validation cover source
wiring. No Simulator, physical-device touch, high-refresh display, or desktop
trackpad session is claimed by this document; those remain manual motion checks.
