# Durable turn, write and editor-review protocol

This document defines the Milestone C transaction boundary. It is normative:
tests may add stronger guarantees, but product code must not introduce a second
source of truth that contradicts these rules.

## Authorities

| Concern | Authority | Rebuildable projection |
| --- | --- | --- |
| Manuscript prose | live Yjs document plus its persisted updates | editor DOM, `contentJson`, reveal overlays |
| Agent write execution | SQLite `agent_runtime_write_effect` state machine and certified receipt | tool result presentation |
| Inline edit review | SQLite review plus ordered review-block rows | Zustand/localStorage pending badges and block diffs |
| Conversation adoption | committed SQLite turn checkpoint with the exact history hash | in-memory provider history and panel rendering |
| Animation | none; deliberately ephemeral | React reveal/commit maps |

LocalStorage is never permission, mutation or review authority. Losing it may
lose only presentation timing; opening a project reconstructs every unresolved
review from SQLite and immutable write evidence.

For an auto-mode prose write targeting an editor whose live `Y.Doc` is open,
the renderer installs an ephemeral block guard synchronously after the SQLite
transaction commits and immediately before the committed update enters that
`Y.Doc`. The guard is presentation only, is never persisted, and cannot create
or settle a review. Canonical review projection replaces the guard and pending
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
- A review may be created only for a `result_committed` effect and carries the
  same effect/session/turn/tool-call provenance.

## Review-block state machine

```text
pending -----------------------------> accepted
   |
   +-> revert_started -> reverted
             |
             +-> revert_failed -> revert_started
```

- Block identity and order are derived from the immutable certified write
  effect, then inserted in the same transaction as the parent review.
- Accepting a block is one SQLite compare-and-set.
- Rejecting a block first commits `revert_started`, then runs the guarded Yjs
  inverse, then commits `reverted`. A crash at either boundary is recoverable.
- Once every block is terminal, the repository settles the parent review in the
  same transaction: all reverted becomes `reverted`; any accepted block becomes
  `accepted_effect`. The canonical decision note contains the ordered decisions.
- Whole-effect review operations remain compatibility paths for effects that do
  not expose block review. New prose reviews use only the block state machine.

## Turn adoption rule

A completed model response is adopted into future provider context only after
the exact durable turn checkpoint commits. A failed commit must not mutate the
in-memory adopted history. Independently committed manuscript effects remain
real and are reconciled through their own ledger; their review/decision evidence
is pinned into the next context instead of pretending the failed turn committed.

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
| After result, before review insert | `result_committed`, no review | deterministically recreate the provenance-bound review and ordered blocks |
| After review insert, before local projection | pending SQLite review | project it from immutable effect on project hydration |
| After block accept, before local projection | block `accepted` | hydration hides only that block and preserves the rest |
| After `revert_started`, before Yjs inverse | block `revert_started`, agent postimage present | retry the guarded inverse |
| After Yjs inverse, before `reverted` | block `revert_started`, preimage already present | idempotent inverse recognizes/restores the same preimage, then records `reverted` |
| Concurrent unrelated author edit | live Yjs contains both histories | inverse touches only the certified block; unrelated blocks survive |
| Concurrent edit of the same certified block | postimage no longer matches | fail closed as `revert_failed`; never overwrite the author silently |
| After all blocks terminal, before UI cleanup | terminal parent review | hydration removes the batch; animation may be lost but content/decision cannot change |
| After model execution, before turn commit | effects may be committed, turn checkpoint absent | do not adopt provider history; surface commit failure and pin independent effect/review evidence next turn |

## Machine acceptance requirements

Milestone C cannot close from mocked UI tests alone. Its gate must exercise:

1. the real Drizzle migrations against a file-backed SQLite database;
2. multi-block accept, mixed accept/reject and reject-all settlement;
3. duplicate actions and invalid compare-and-set transitions;
4. loss/corruption of localStorage followed by project hydration;
5. restart from every `revert_started` boundary;
6. Yjs unrelated-author edits and same-block conflict behavior;
7. turn commit success, transient retry and permanent fail-closed context
   adoption;
8. deterministic report generation plus full typecheck/test/capability drift
   gates.

Native animation appearance still requires user visual acceptance, but the
animation selection and accepted/reverted direction must be covered by pure
tests. Reveal overlays and their per-block controls must portal into the
positioned in-flow editor spread and use scroll-content coordinates; they must
not chase asynchronously scrolled prose from a fixed body layer. Animation
failure never changes the durable decision. In auto mode, every already-durable
`new` or `changed` prose block is masked in the real ProseMirror flow until its
overlay completes, for existing files and Added first-open prose alike. The
completed overlay and real block swap atomically; the finished live text must
never paint underneath a duplicate reveal. Tests must cover the pre-live guard
running before `Y.applyUpdate`, its atomic handoff to the provenance-bound
review, and the ordinary pending-mask lifecycle.
