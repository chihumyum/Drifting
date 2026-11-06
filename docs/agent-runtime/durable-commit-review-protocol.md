# Durable turn, write and settlement-receipt protocol

This document defines the Milestone C transaction boundary. It is normative:
tests may add stronger guarantees, but product code must not introduce a second
source of truth that contradicts these rules.

## Current product behavior

Since 2026-10-17, Agent changes always commit directly. The composer has no
review-mode setting, no editor exposes accept/reject or review-all controls,
and large prose deletions do not escalate to post-write author review.
Since 2026-11-06 destructive operations do not pause for a pre-execution
confirmation either, and there is no setting for one.
The tool registry and generated capability inventory classify ordinary prose,
field and patch updates as automatic.

SQLite review rows are internal settlement receipts, not author decisions.
Migration `0018` (2026-11-05) retired the reject/revert half of the old review
protocol: its states and the columns that recorded them are gone, and a
database still holding a reject decision is refused rather than losing it. A
receipt left unsettled by a crash settles on project hydration or
interrupted-turn recovery. Every certified write still persists its preimage
and guarded effect-level inverse; that inverse backs the Revert column of the
generated capability inventory and is not an author-facing action. The author
undoes an Agent edit from entity snapshot history.

Sidebar A/M markers, group counts and tab dots are unread presentation.
Clicking an item marker marks only that entity read; a group count marks its
descendants; a group A/M marks the group itself; the sand dot on a
chapter/element/drift tab marks its panel. A tab shows no number: the dot hangs
off the label's upper corner without width, and the tab's tooltip names the
count. These buttons do not open editors, collapse groups, or switch tabs. Hover
replaces the label with a centered sand-brush check exactly one digit wide (`1ch`) and
one font em tall, preserving width, ink, background, border and shadow. Both directions
crossfade over 140 ms; reduced-motion preferences disable that transition.
Acknowledgement clears cached prose/field/Added presentation and remembers its
review ids, preventing replay after reload. A later Agent write is unread again.
An open reveal stops immediately; opening an acknowledged editor skips reveal.
Active tool pulses and pre-live guards belong to ongoing work and stay separate.
An M for an edit merged from the Markdown folder is blue and acknowledges the
same way (`docs/markdown-mirror.md`).

Run `node scripts/run-agent-unread-acceptance.mjs` to regenerate
`acceptance/unread-direct-edits.json`, or add `--check` to verify its source hash.
This covers production sidebar/animator components in isolated Chromium plus
synthetic store, SQLite/Yjs and legacy-recovery tests. Native interaction and
hosted-service acceptance are not part of this report.

## Authorities

| Concern | Authority | Rebuildable projection |
| --- | --- | --- |
| Manuscript prose | live Yjs document plus its persisted updates | editor DOM, `contentJson`, reveal overlays |
| Agent write execution | SQLite `agent_runtime_write_effect` state machine and certified receipt | tool result presentation |
| Write settlement | SQLite settlement receipt plus ordered receipt-block rows | Zustand/localStorage unread badges and reveal masks |
| Conversation adoption | committed SQLite turn checkpoint with the exact history hash | in-memory provider history and panel rendering |
| Animation | none; deliberately ephemeral | React reveal/commit maps |

LocalStorage is never permission, mutation or settlement authority. Losing it
may lose only unread presentation; opening a project settles unsettled receipts
from SQLite and immutable write evidence.

The `agent-edit-pending` localStorage cache is best-effort and limited to
512 Ki UTF-16 code units for the complete serialized v2 envelope (about 1 MiB
of text). Before/after prose and review batches can otherwise exceed the shared
WebView quota during Added first-open seeding. Oversized or corrupt caches are
discarded on read. Oversized snapshots, quota errors, and unavailable storage
never escape store actions: the complete live projection stays in memory and
only this cache key is evicted, if storage permits, so a stale snapshot cannot
resurrect an acknowledged reveal on reload. Other storage keys are untouched.
Persistence resumes on the next write that fits. Reload under storage pressure
may lose unread/reveal presentation; manuscript content and canonical write
receipts remain in Yjs/SQLite. This requires
no database migration or reset. Acceptance injects storage failures into the
production store and exhausts real localStorage in an isolated Chromium origin
before exercising reveal and sidebar acknowledgement. Native WKWebView quota
acceptance is not covered by that browser report.

For a prose write targeting an editor whose live `Y.Doc` is open,
the renderer installs an ephemeral block guard synchronously after the SQLite
transaction commits and immediately before the committed update enters that
`Y.Doc`. The guard is presentation only, is never persisted, and cannot create
or settle a receipt. Canonical receipt projection replaces the guard and pending
mask in one store transition; a failed live merge removes it. This closes the
post-commit window without weakening Yjs or SQLite authority.

## Write effect state machine

```text
claimed -> confirmed -> mutation_started -> effect_committed -> result_committed
                              |                    |
                              +-> uncertain        +-> failed (proved rollback only)
claimed/confirmed ---------------------------------------> declined/failed
```

- `mutation_started` is persisted before entering a renderer mutation use case.
- An exact/compensating write stores its preimage, forward operation and inverse
  before mutation; an irreversible write must not claim an exact inverse.
- A renderer receipt may prove an entered mutation committed after restart.
  Without proof, the effect is `uncertain` and is never blindly replayed.
- A settlement receipt may be created only for a `result_committed` effect and
  carries the same effect/session/turn/tool-call provenance.

## Settlement receipt state machine

```text
receipt: pending -> accepted -> accepted_effect
block:   pending -> accepted
```

- A certified prose write creates one deterministic receipt right after its
  effect reaches `result_committed`, then settles it to `accepted_effect` before
  its editor projection. Metadata and structural writes create none.
- A receipt that owns ordered block rows settles through them: each block is
  one SQLite compare-and-set, and the repository settles the parent receipt in
  the same transaction as its last block. A receipt without blocks settles
  through its own `pending -> accepted -> accepted_effect` compare-and-set.
  Current writes create receipts without blocks.
- Every transition is idempotent: replaying an already applied transition
  returns the settled row unchanged.
- Project hydration and interrupted-turn recovery settle every `pending` or
  `accepted` receipt of the mounted project; neither replays the write nor its
  editor projection.
- Migration `0018` dropped `decision_note_json`, `revert_effect_json`,
  `error_code`, `error_message`, `rejected_at` and `revert_started_at` from the
  receipt and the same columns (minus `rejected_at`) from its blocks. Its
  guard aborts the migration, leaving the source database untouched, when any
  receipt is outside `pending`/`accepted`/`accepted_effect` or any block is
  outside `pending`/`accepted`.

## Turn adoption rule

A completed model response is adopted into future provider context only after
the exact durable turn checkpoint commits. A failed commit must not mutate the
in-memory adopted history. Independently committed manuscript effects remain
real and are reconciled through their own ledger; their settlement receipts are
pinned into the next context instead of pretending the failed turn committed.

This deliberately separates two facts that can coexist:

1. a manuscript write committed and is visible;
2. the model turn containing that tool exchange was not durably adopted.

The UI and logs must report those facts separately. Retrying an idempotent turn
commit is allowed; reconstructing or silently adopting an uncommitted provider
history is not.

For small turns the checkpoint may carry the fully witnessed V2 provider
envelope. For a tool-heavy turn whose V2 serialization exceeds 512 KiB, the
commit uses bounded V4: exact canonical history stays in normalized message
rows while the checkpoint stores its message count/SHA-256 plus restart
summaries. Recovery must rebuild and match that digest before the same adoption
rule can succeed; a smaller checkpoint is never permission to trust less
history.

## Fault matrix

| Failure point | Durable observation after restart | Required recovery |
| --- | --- | --- |
| Before effect claim | no effect | no mutation, safe provider retry |
| After claim/confirm, before mutation | `claimed`/`confirmed` | replay the unentered operation with the same idempotency key |
| After `mutation_started`, before Yjs mutation | entered effect, no receipt | strategy inspection proves no commit or leaves `uncertain`; never blind replay |
| After Yjs mutation, before `effect_committed` | entered effect plus product receipt/revision | reconcile receipt and commit the original canonical result |
| After result, before receipt insert | `result_committed`, no settlement receipt | deterministically recreate the provenance-bound receipt and settle it |
| After receipt insert, before settlement | `pending` or `accepted` receipt | settle it on project hydration or interrupted-turn recovery |
| After settlement, before local projection | `accepted_effect` receipt | the write stands; only unread presentation may be lost |
| After model execution, before turn commit | effects may be committed, turn checkpoint absent | do not adopt provider history; surface commit failure and pin independent effect/receipt evidence next turn |

## Added first-open presentation

Structural creation has no before-snapshot. A successful domain create derives
one persisted Added presentation from the canonical `result_committed` payload,
keyed by the resolved entity id; provider-facing prose is never the authority
for that marker. Replaying an idempotent committed result may rebuild a missing
presentation marker but must not execute the mutation again.

The sidebar `A` marker outranks `M` but remains below active tool execution. It
clears only after every initial textual block completes its first-open reveal
(or is seen with reveal animation disabled),
or after empty-editor hydration proves there is no prose to reveal. Clicking its
sidebar marker explicitly acknowledges it before opening.

Creation treats every textual top-level block as `new` and, when reveal
animation is enabled, masks the durable live block before paint until its reveal
completes.

Stable block ids come from the schema-safe creation seed. Before those ids are
materialized, a ProseMirror decoration masks initial textual blocks; after
materialization, the ordinary block projection takes ownership atomically.
Long documents reveal on first viewport entry without exposing completed live
text underneath a duplicate animation. Masking preserves layout geometry.

Settings → Appearance → Agent edit reveal animation defaults to on and persists
locally. Turning it off immediately removes auto-reveal masks (including pre-live
guards and Added first-open masks) and skips prose/field typing and commit fades.
The gutter highlight, scrollbar ticks, and unread activity remain: auto prose
changes clear only after their result stays sufficiently in view for 500 ms;
scrolling away cancels that dwell, and offscreen changes remain unread. Missing
anchors retain the existing grace cleanup. Automatic write settlement is independent of this preference. Turning it off during a reveal
shows the live result and uses the same seen tracking without replaying motion.

Machine coverage for this preference lives in `settings-store-appearance.test.ts`,
`agent-decoration-controller.test.ts`, and `agent-edit-animation.test.ts`.

Prose reveal speed follows the current editor's outstanding paragraph count,
including offscreen pending changes and active reveal overlays. Receipt/block
identity deduplicates a pending change and its overlay; fields and other editors
do not inflate this count.
Each overlay samples the count when it starts. Relative to the original pace,
1–3 paragraphs run at 0.8×, 4–8 at 1×, 9–16 at 1.5×, 17–24 at 2×, 25–48 at
2.5×, and more than 48 at 3×. Both the original 500–2500 ms character-based
typing duration and the 320 ms commit fade are divided by that speed; typing stays within
167–3125 ms without distorting the requested ratios. New reveals slow down as
the queue drains, while an in-flight
reveal never restarts or changes pace because a sibling finished. The disabled
animation setting retains its independent 500 ms seen dwell. Timing and queue
selection are covered by `agent-edit-animation.test.ts`.

Reveal layout uses the live paragraph's measured border box at the configured
editor width, including paragraph padding/borders. Its resolved typography,
first-line indent, whitespace and wrapping rules are captured with the same
geometry snapshot. Resizes, replaced prose nodes and root/paragraph style changes
refresh that snapshot, so changing editor width or typography cannot leave the
overlay using its initial layout. `AgentRevealText` keeps the complete old text
in layout during erasure, then the complete new text during insertion. Unshown
characters use `visibility: hidden`, and the caret is out of flow. Rendering only
a changing prefix causes wrapping (including `text-wrap: pretty`, punctuation
and words) to relocate already-visible glyphs at line ends even with the correct
container width. The two phases never reserve old and new text simultaneously.
Field reveals and the paused mobile shell use this rendering.

On the desktop, prose reveals play in place instead (`AgentRevealText` with
`mode="overwrite"`, `agentRevealFrame` in `agent-edit-animation.ts`): the diff
is grouped into changed places, played one after another from each place's
start, one character a step. When the old words are longer, they are deleted
from the front, the text after them closing up, until both sides are as long,
and are then overwritten; when they are shorter, they are overwritten first and
the rest of the new words is inserted, pushing the text after them on. A place
that only adds or only deletes simply inserts or deletes. The overwritten
characters keep their places; text after the place moves as it would under a
person's editing. The duration counts steps (each place's longer side) rather
than deleted plus inserted characters, under the same tiers. Added words show
in the story green and rewritten words in purple, with a matching 18% ground
during the reveal only. At completion the ground fades for 180 ms (ease-out)
while the text and opaque overlay stay fully visible and the real paragraph
stays masked; only then does the atomic handoff occur. The overlay
keeps its opaque paper-coloured backdrop, so while it is still taller than the
committed paragraph it covers the next paragraph's first lines, which come back
as it shortens and never move. When it hands over, the same words stay coloured
in the live prose (`lib/agent-recent-changes.ts`, painted through the CSS Custom
Highlight API by `AgentRecentChangeHighlights`) until the author's pointer
touches them, by moving onto them or by the page scrolling them under a pointer
held still (every frame checks the path the pointer travelled through the
content since the last one; a leap of more than half the scroller, such as a
search jump, counts only where it lands); they then ease back to ink over
300 ms. The marks live in
memory for the app's run, survive tab switches and show in the whole-book
reader; editing the words away or a later Agent change to the block drops them.

The isolated Chromium check
`pnpm exec tsx scripts/check-agent-reveal-layout.mjs` compares glyph positions
at three page widths with and without first-line indent, using synthetic prose.
It exercises production reveal markup at every character boundary for insertion,
deletion and replacement in manuscript and entity editor styles, and reproduces
the prior prefix-based line shifts. Regenerate `acceptance/reveal-layout.json` with
`--output=docs/agent-runtime/acceptance/reveal-layout.json`. This verifies renderer
layout, not Tauri/WKWebView visual acceptance.

Added state may be cached in localStorage only as a rebuildable presentation.
SQLite/Yjs remain authoritative, and presentation failure after a committed
effect cannot reverse success or invite a duplicate create.

Focused coverage includes `tool-entity-ref.test.ts`, Agent activity/edit store
tests, `agent-added-file.test.ts`, diff-decoration and animation tests, write
runtime replay tests, and the domain CRUD/Yjs integration suites.

## Machine acceptance requirements

Milestone C cannot close from mocked UI tests alone. Its gate must exercise:

1. the real Drizzle migrations against a file-backed SQLite database;
2. ordered receipt blocks settling their parent receipt atomically;
3. duplicate actions and invalid compare-and-set transitions;
4. a receipt left unsettled after the prose committed, settled on project or
   session hydration without replaying the write;
5. loss of localStorage followed by project hydration;
6. turn commit success, transient retry and permanent fail-closed context
   adoption;
7. deterministic report generation plus full typecheck/test/capability drift
   gates.

Native animation appearance still requires user visual acceptance, but the
animation selection must be covered by pure tests. Reveal overlays must portal
into the positioned in-flow editor spread and use scroll-content coordinates;
they must not chase asynchronously scrolled prose from a fixed body layer.
Animation failure never changes the durable write. With reveal animation
enabled, every already-durable `new` or `changed` prose block is masked in the
real ProseMirror flow until its overlay completes, for existing files and Added
first-open prose alike. The completed overlay and real block swap atomically;
the finished live text must never paint underneath a duplicate reveal. Tests
must cover the pre-live guard running before `Y.applyUpdate`, its atomic
handoff to the provenance-bound receipt, and the ordinary pending-mask
lifecycle.
