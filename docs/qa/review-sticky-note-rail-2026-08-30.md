# Review panel and sticky-note rail acceptance

Updated: 2026-10-02

This document supersedes the original automatic comment-margin projection.
Review is the only project review list. It combines
comments, Copilot suggestions, and TODOs without creating a second
TODO data model.

## Product contract

- Desktop Review lives in the ordinary right sidebar. Mobile uses the same
  Review content inside `MobileRightSidebar`, an almost-full-screen modal
  workspace that enters a short distance from the top.
- Review filters by type (`Both`, `Comments`, `TODOs`) and scope (`Current`,
  `Project`). Opening Review does not move, hide, or clear editor sticky notes.
- The Current/Project scope is a saved UI preference. Desktop sidebar panes
  retain it independently per project, pane and Tab; other Review mounts keep
  the shared preference. Closing/reopening the panel and restarting retain it. Without a focused
  entity, Review temporarily displays Project and disables the toggle without
  overwriting the preference; focusing an entity restores the selected scope.
  Missing or invalid saved values fall back to Current.
- Review's toolbar uses the same sort menu as Chapter and Element panels.
  Created time and updated time both sort newest first, independently within
  open and resolved groups. Updated time is the default; the selected mode is
  saved as its own UI preference. Time order applies across anchor/relation
  types; equal timestamps use the comment ID for stable ordering.
- The resolved group is expanded when Review opens. Authors can collapse it;
  changing the sort mode preserves that choice. Desktop sidebar panes also
  retain it independently through Tab switches and close/reopen.
- Review items have only two authored kinds: `note` and `todo`. The retired
  Shadow author-exception kind is absent from the UI, domain, and Agent tools.
- A Review card can be added to one entity editor's sticky-note rail. Cross-
  entity anchored or relation-linked items open their target editor before
  appearing there; project-floating items fall back to the focused editor.
- Sticky cards retain editing, relation, status, type, source, Copilot decision,
  and deletion actions. Anchored cards jump to their source; entity-level and
  project-floating cards do not pretend to have a text anchor.
- Double-clicking a TODO card's text or unused space opens an inline editor in
  the TODO workbench, Review panel, and expanded sticky rail. Action buttons and
  relation controls keep their own behavior. Save or Cmd/Ctrl+Enter commits the
  content through `updateCommentBody`; Cancel or Escape discards the draft.
  Empty drafts cannot be saved, IME composition does not submit or cancel, and
  failed saves retain the draft for retry. Escape stays within the editor.
- TODO cards show a lower-right status ring: empty for open, checked for
  resolved. Clicking it resolves or reopens the same comment. The workbench
  retains its open-list/resolved-archive filtering. The ring shares a row with
  the relation button and stays vertically centered when relation chips wrap.
  Relation buttons use the stronger rule token for their dashed border.
- Hovering a Comment or TODO in Review, the expanded sticky rail, or the TODO
  workbench shows its source after the shared 220ms hover delay. The preview
  lists source/associated entity types and names, deduplicating the primary
  target. It resolves metadata only within the item's project; floating and
  unavailable targets have explicit labels.
- Text-bound items also show the original linked excerpt: exact text-anchor
  selection, then selected text, then saved paragraph snapshots. Missing
  excerpts are labeled. Hover reads hydrated metadata and creation snapshots,
  never live prose or repository queries. These excerpts can differ from the
  current manuscript.
- Source previews portal to `body`, use fixed positioning, flip at the sidebar
  edge, and stay within the viewport. Long excerpts scroll with the wheel over
  the originating card, following entity-preview behavior. Leaving, pressing
  Escape, starting an action, or entering the editor dismisses the preview.
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
  immediately after its type label. Clicking the arrow opens the target editor
  and jumps to the anchored text. Ordinary comment bodies also jump on click;
  TODO bodies reserve double-click for editing, with the arrow available in
  both Review and sticky presentations. Entity-level and
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

`pnpm exec node scripts/run-todo-edit-acceptance.mjs` generates
`docs/qa/todo-edit.json` from real card/editor components in an isolated headless
browser. Its 52 synthetic DOM checks cover edit entry in all three surfaces,
focus, current content, cancel/Escape, empty and unchanged drafts, IME, duplicate
submission, save failure/retry, action isolation, anchor navigation, status
toggle/rendering, and footer alignment/border contrast at 180px and 280px in
light and dark themes, including wrapped chips and an expanded picker.
They also exercise the actual Review sort menu, both time orders in open and
resolved groups, default expansion/manual collapse, independent persisted
preferences, older/invalid preference fallback, and immutable source ordering.
Scope checks exercise list filtering, persisted storage, panel remount,
rehydration, missing/invalid values, and temporary project fallback without
changing the saved Current preference.
Toolbar fit is measured at 280px/360px for all three desktop text sizes; narrow
toolbars can wrap without clipping or overlapping controls.
Hover checks cover Comments and all three TODO surfaces, delayed entry/leave,
source names and associated entities, precise selected text, portal placement,
right-edge flipping, long-excerpt scrolling, and dismissal for actions, editing and Escape.
`src/renderer/features/comments/comment-source-preview.test.ts` also verifies
project isolation, missing/floating targets, relation deduplication, exact text
selection precedence, and older/malformed snapshot fallback.
`pnpm exec node scripts/run-todo-edit-acceptance.mjs --check` verifies the recorded
checks and source fingerprint. Saves in this fixture use an in-memory callback;
SQLite persistence and native interaction are not claimed by that report.

## Validation boundary

Automated acceptance and TypeScript validation cover source wiring and state
contracts. No Simulator, physical-device touch, VoiceOver/TalkBack, desktop
trackpad, or high-refresh motion session is claimed here; those remain manual
acceptance gates.
