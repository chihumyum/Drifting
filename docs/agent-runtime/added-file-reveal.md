# General Agent added-file presentation

This document defines the author-facing presentation contract for prose entities
created through the General Agent workspace facade.

## Status contract

- A successful `write_file` create for a chapter, drift, element, storyline, or
  category records a persisted Added presentation keyed by the resolved domain
  entity id.
- The corresponding left-sidebar cell or group header shows the monospace `A`
  marker. `A` takes priority over `M`; active tool execution still takes priority
  over both.
- Opening the entity does not clear `A`. The marker clears only after the
  first-open prose reveal finishes (or after the empty-editor hydration grace
  confirms there is no text to reveal).
- Ordinary writes to an existing file remain Modified and use `M`.

## First-open reveal

Structural creation has no before-snapshot and initially has no stable block
ids. On the first editor mount, `EditorReviewLayer` waits for ProseMirror to
assign ids, treats every textual top-level block as `new`, and feeds those blocks
into the existing auto reveal animator. Long documents keep the existing
on-viewport behavior: every block reveals when it first enters the manuscript
viewport, and `A` remains until all seeded blocks have completed.

The Added projection is persisted in localStorage so closing or reloading during
the first-open reveal resumes it. It is presentation only: SQLite/Yjs remain the
content authorities. If a later durable approve-mode review already owns a block,
that block is not replaced by the Added projection; the canonical review keeps
its mode and provenance.

## Machine acceptance

The following tests cover the contract:

- `src/renderer/lib/agent/tool-entity-ref.test.ts`: workspace result path and
  `operation: created` resolve to the canonical Added entity.
- `src/renderer/store/agent-activity-store.test.ts`: a committed create result
  records the persistent Added projection.
- `src/renderer/store/agent-edit-store.test.ts`: first-open block seeding,
  completion, persistence shape, and durable-review precedence.
- `src/renderer/components/editor/agent-added-file.test.ts`: every textual
  top-level block is planned as an ordered `new` reveal.

Native timing and appearance remain a manual author-visible boundary; automated
tests verify selection, identity, lifecycle, and collision behavior.
