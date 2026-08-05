# General Agent newly-created prose presentation

This document defines the author-facing presentation contract for prose entities
created through the General Agent authored-object facade.

## Status contract

- A successful `write_object` create for a chapter, drift, element, storyline, or
  category records a persisted Added presentation keyed by the resolved domain
  entity id. The projection is derived from the canonical local
  `result_committed` payload (`data.result.operation === "created"`), never from
  provider-facing `modelData`; replaying that durable result reprojects a
  missing Added marker without rerunning the write.
- The corresponding left-sidebar cell or group header shows the monospace `A`
  marker. `A` takes priority over `M`; active tool execution still takes priority
  over both.
- Opening the entity does not clear `A`. The marker clears only after the
  first-open prose reveal finishes (or after the empty-editor hydration grace
  confirms there is no text to reveal).
- Ordinary writes to an existing object remain Modified and use `M`.
- The mode captured when creation starts governs the complete initial prose.
  In auto mode, every textual top-level block follows the Added reveal below.
  In approve mode, SQLite owns one pending review row per textual block; the
  editor shows the existing accept/reject controls, accepting plays the commit
  reveal, and rejecting removes only that block through the guarded Yjs inverse.

## First-open reveal

Structural creation has no before-snapshot. The schema-safe creation seed owns
stable block ids, and on the first editor mount `EditorReviewLayer` waits for
ProseMirror to materialize them, treats every textual top-level block as `new`,
and feeds those blocks into the existing auto reveal animator when creation
captured auto mode. If a durable approve-mode review already owns those ids,
Added seeding leaves the review intact instead of downgrading it to auto. Long
documents keep the existing on-viewport behavior: every block reveals when it
first enters the manuscript
viewport, and `A` remains until all seeded blocks have completed.

The shared auto-reveal contract applies equally to Added prose and edits of
existing objects: already-durable live prose must never paint as a completed
manuscript below the animation. Before stable ids exist, a ProseMirror node
decoration masks every textual top-level block; afterwards the normal auto-mode
projection masks each outstanding `new` or `changed` block. The reveal is armed
in the pre-paint layout phase, uses the first opaque editor ancestor as its
backdrop even when `.page` itself is transparent, and atomically swaps the
completed overlay for the real block. This preserves live Yjs as truth without
producing a visible "finished text, then type it again" pass. Masking preserves
block geometry, so off-screen blocks remain correctly anchored and reveal only
when they enter the viewport.

When an existing object is already open, its final Yjs update can arrive before
the durable review is projected into the editor store. The write coordinator
therefore stages a non-persisted guard after the SQLite commit but before the
live merge. That guard masks the affected `new`/`changed` ids immediately and is
replaced atomically by the canonical review mask; it is not a second review or
content authority.

The Added projection is persisted in localStorage so closing or reloading during
the first-open reveal resumes it. It is presentation only: SQLite/Yjs remain the
content authorities. If a later durable approve-mode review already owns a block,
that block is not replaced by the Added projection; the canonical review keeps
its mode and provenance.

## Machine acceptance

The following tests cover the contract:

- `src/renderer/lib/agent/tool-entity-ref.test.ts`: authored result target and
  `operation: created` resolve to the canonical Added entity.
- `src/renderer/store/agent-activity-store.test.ts`: a committed create result
  records the persistent Added projection.
- `src/renderer/lib/agent/runtime/drifting-write-tool-runtime.test.ts`: a
  `write_object` create records Added even when provider-facing `modelData` is
  natural language, and idempotent result replay restores the projection
  without applying the write twice.
- `src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts`:
  approve-mode creation persists every initial textual block as a SQLite-backed
  review, accepts selected blocks, rejects one through Yjs, and keeps the newly
  created object with only accepted prose.
- `src/renderer/store/agent-edit-store.test.ts`: first-open block seeding,
  completion, persistence shape, full approve-mode precedence, and atomic
  pre-live guard handoff.
- `src/renderer/components/editor/agent-added-file.test.ts`: every textual
  top-level block is planned as an ordered `new` reveal.
- `src/renderer/lib/extensions/agent-diff-decoration.test.ts`: pre-id Added prose
  plus pre-live and outstanding auto changes in existing files receive the same
  block mask; approve-mode and deletion changes do not.
- `src/renderer/components/editor/agent-edit-animation.test.ts`: transparent
  page surfaces fall through to an opaque reveal backdrop.
- `src/renderer/lib/agent/runtime/drifting-write-strategies.test.ts` and
  `yjs-prose-persistence-coordinator.integration.test.ts`: an existing-object auto
  write stages its guard before the live Yjs merge, then hands it to the exact
  durable review.

Native timing and appearance remain a manual author-visible boundary; automated
tests verify selection, identity, lifecycle, and collision behavior.
