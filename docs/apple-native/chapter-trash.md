# Local chapter trash and restore

The native chapter workspace provides a recoverable trash workflow through one
shared Rust service. This batch adds no permanent deletion and does not depend
on Google Drive or its deferred synchronization redesign.

## Domain and prose transaction

Moving a chapter to trash sets `deleted_at` and records its `entity.trash`
lifecycle in the same transaction. Its incarnation stays unchanged. The chapter
disappears from normal chapter lists, outline and search while its title, scalar
book order, prose bytes and comments remain in the local database.

Restoring captures the authoritative full state from the retained SQLite
snapshot and update tail inside the core transaction. `content_json` does not
replace that source. The restored chapter enters the next incarnation and emits
one complete local original: domain seed, graph position, its storyline
memberships re-added in the new incarnation (the renderer's
`forceReincarnation` projection: observed tags removed, then added again),
the primary-storyline register and full prose state. Its System revision,
provenance, original and materialization receipt commit together. No published
migration changes.

Trash keeps a chapter's [storyline](storylines.md) links, as the renderer does.
Trash purges every [relation](relations.md) touching the chapter inside its
trash original, as the renderer does; restore does not bring them back.

## Native editor ownership

The native coordinator guards queued input, composition and failed saves before
changing the chapter lifecycle. The bridge saves the target owner while its
scope is still live, then executes the shared domain command. Only a successful
commit retires its Rust and Swift owner and closes all its tabs, including both
panes and hidden tabs on Mac. Failure keeps the existing editor, selection and
history available for retry. Other chapters retain their owners.

A successful restore returns the live and trash lists without automatically
opening an editor. Opening the chapter normally creates an owner for the new
incarnation. A retired handle cannot keep writing, and the old editor's undo
history is not transferred into the restored owner.

## Acceptance

`pnpm apple:workspace-trash:acceptance` generates
[the chapter lifecycle report](acceptance/p3b-chapter-trash.json) from synthetic
file-backed tests and the production TypeScript reducer. Its fixed groups cover
trash preserving prose and placement; restore entering a new incarnation and
remaining editable after cold reopen; and receipt faults rolling back while
retaining owners for retry. The TypeScript comparison verifies the existing
local data/original contract, not a Google Drive migration. Local System and
remote replay provenance are different roles and are recorded separately.

Programmatic AppKit, hosted UIKit and simulator UI results belong to their
native reports. Fault injection and cold reopen do not certify process-kill or
power-loss recovery, physical IME, real devices or signed distribution.

The current batch passes the fixed core/bridge and production-reducer groups.
[Programmatic AppKit evidence](acceptance/p2b-binding.json) covers target tabs,
other owners, input guards and transaction failure. The separate
[native report](acceptance/p2b-native.json) passes hosted UIKit and actual
iPhone/iPad simulator controls, including trash, process restart, restore and
continued input. Desktop XCTest, physical input methods and devices, and signed
distribution remain unexecuted for this batch.
