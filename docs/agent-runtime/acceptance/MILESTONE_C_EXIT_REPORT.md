# Milestone C exit report: durable commit and inline review

Status: **Completed**
Date: 2026-08-02

## Outcome

Turn context adoption, certified writes and editor review now have separate,
explicit authorities and an unambiguous recovery protocol. SQLite owns turn,
effect, review and ordered block decisions; Yjs owns prose; localStorage and
animations are rebuildable presentation only.

The normative protocol and crash matrix are in
[`../durable-commit-review-protocol.md`](../durable-commit-review-protocol.md).
The machine evidence is
[`milestone-c-durable-review.json`](milestone-c-durable-review.json).

## Shipped

- Migration `0071_agent_runtime_review_blocks` adds provenance-bound ordered
  review blocks with compare-and-set states `pending`, `accepted`,
  `revert_started`, `reverted` and `revert_failed`.
- Parent review settlement happens atomically with the last block transition.
  All reverted becomes `reverted`; a mixed/accepted result becomes
  `accepted_effect`, with the complete ordered decision note.
- Pending pre-0071 prose reviews are upgraded from immutable write evidence;
  settled historical rows are never rewritten.
- `acceptReviewBlock` and `rejectReviewBlock` are the canonical prose-review
  actions. Reject persists `revert_started` before the guarded Yjs inverse and
  retries `revert_started`/`revert_failed` safely after restart.
- Closed-document block inverse now refreshes `contentJson` and word count only
  after Yjs persistence. A lost projection or settlement acknowledgement can be
  retried without applying the prose mutation twice.
- Project hydration reconstructs missing/incorrect local editor state directly
  from SQLite plus immutable effect evidence. The local-only block decision API
  was removed.
- Editor per-block and accept/reject-all controls use the same durable block
  protocol. Accepted and reverted actions both plan colored reveal animations.
- Turn commit retries are safe across an ambiguous “SQLite committed, response
  lost” boundary. Exact existing messages/checkpoint are verified and adopted
  once; permanent failure keeps completed provider context unadopted while
  independently committed manuscript effects remain reconcilable.
- File-backed acceptance fixtures now discover every later Agent/Yjs migration,
  preventing test schema from silently stopping at migration 0070.

## Automated acceptance

Run:

```bash
pnpm --dir client eval:agent:durability
```

Result:

- 11 required test files discovered;
- 67/67 milestone tests passed;
- all 13 named invariant assertions matched exactly once;
- real file-backed product SQLite migrations and real Yjs snapshots/updates;
- injected post-Yjs block-settlement failure recovered on hydration;
- complete localStorage projection loss and partial-decision loss recovered;
- unrelated author edits survived inverse; same-block author edits failed closed;
- lost turn-commit acknowledgement adopted one exact history;
- TypeScript, targeted ESLint and generated capability drift checks passed.

Full Core regression after the implementation:

```bash
pnpm --dir client test
```

Result: **120 files, 792/792 tests passed**.

## Explicitly unverified here

- Native macOS/iOS/Android animation smoothness and badge placement require the
  user's visual/device pass; pure tests cover selection, identity and direction.
- A physical device kill/power-loss is represented by file/process restart and
  injected transaction failures, not destructive hardware testing.
- Server sync and multi-device convergence are outside this local transaction
  milestone and remain part of later domain/native endurance work.
- Provider network behavior is irrelevant to this storage protocol; provider
  conformance remains Milestone I.

Milestone D is now active.
