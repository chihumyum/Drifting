# Review panel and sticky-note rail acceptance

Updated: 2026-09-01

This document supersedes the original automatic comment-margin projection.
Review is the only project review list. It combines
comments, exceptions, Copilot suggestions, and TODOs without creating a second
TODO data model.

## Product contract

- Desktop Review lives in the ordinary right sidebar. Mobile uses the same
  Review content inside `MobileRightSidebar`, an almost-full-screen modal
  workspace that enters a short distance from the top.
- Review filters by type (`Both`, `Comments`, `TODOs`) and scope (`Current`,
  `Project`). Opening Review does not move, hide, or clear editor sticky notes.
- A Review card can be added to one entity editor's sticky-note rail. Cross-
  entity anchored or relation-linked items open their target editor before
  appearing there; project-floating items fall back to the focused editor.
- Sticky cards retain editing, relation, status, type, source, Copilot decision,
  and deletion actions. Anchored cards jump to their source; entity-level and
  project-floating cards do not pretend to have a text anchor.
- Each editor owns its rail membership and order for the working session. New
  cards go to the top. The state is session-only: it is neither project data nor
  `localStorage` state and therefore does not sync.
- Removing one card or clearing a rail changes only rail membership. Resolve,
  reopen, type conversion, Review open/close, and paper switching never remove
  a card. Deleting the underlying item removes its stale rail membership.
- Desktop defaults to an expanded vertical rail. Mobile defaults to one stacked
  deck and expands vertically on demand. The old per-card collapsed/expanded
  state no longer exists.
- The rail is a transparent overlay and must not reflow, tint, wash, or veil the
  manuscript.

## Visual contract

- Review is an ordinary workspace sidebar, not a separate card product. Its
  header reuses the compact `workspace-panel-header-row`; its scroll surface and
  rows reuse `workspace-list` and `workspace-list-row` with the same padding and
  spacing as Library.
- The Current/Project scope control is a self-contained compact text toggle. It
  must keep the panel-header type scale and hit area regardless of stylesheet
  import order; it does not inherit the editor or surrounding panel font size.
- Review rows do not introduce a border, shadow, large radius, or per-kind card
  wash. Type color belongs to the small semantic label. Secondary actions live
  in the shared `menu-surface`; only the action-menu trigger and sticky status
  remain in the row header.
- A Review row with a valid text anchor shows one small, unboxed left arrow
  immediately after its type label. Clicking either the arrow or the row body
  opens the target editor and jumps to the anchored text. Entity-level and
  project-floating rows show no marker. This does not change filtering,
  ordering, or relation behavior.
- Sticky notes are a distinct editor overlay presentation, but still obey the
  global `1px / 2px / 3px` radius ladder. Expanded notes and the stacked deck use
  `--radius-sm`, a hairline border, and no elevation shadow. The deck's offset
  layers are real bordered surfaces rather than a large soft shadow.
- Mobile increases interactive hit targets without changing those surface and
  radius rules.

## Ownership

- `ReviewPanel` owns list filtering, ordering, creation, relations, and the
  add/remove-to-rail affordance.
- `ReviewItemCard` owns shared content and one shared action menu. Panel rows and
  sticky notes select separate surface classes so editor-overlay presentation
  cannot leak into the flat sidebar list.
- `useEntityStickyNoteRail` owns the session registry. `StickyNoteRail` is only its
  editor projection and never discovers comments by target or relation.
- The four entity editor views own the rail viewport mount. Mobile paper chrome
  projects the current entity rail's visible state into its paper-tools toggle.

## Machine-checkable evidence

`src/renderer/components/editor/review-sticky-note-rail.acceptance.test.ts`
checks the four editor mounts, explicit session membership, absence of per-card
collapse state, mobile transparency, top-entry motion, and this contract.
`src/renderer/components/rightBars/review-panel-sticky-rail.acceptance.test.ts`
and `src/renderer/components/workspace-surface-language.acceptance.test.ts`
also enforce the shared panel/list primitives, action-menu ownership, compact
radius ladder, and absence of large-radius or elevated Review/sticky cards.

## Validation boundary

Automated acceptance and TypeScript validation cover source wiring and state
contracts. No Simulator, physical-device touch, VoiceOver/TalkBack, desktop
trackpad, or high-refresh motion session is claimed here; those remain manual
acceptance gates.
