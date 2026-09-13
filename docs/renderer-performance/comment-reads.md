# Covered comment and action reads

Updating a comment body, anchor or status previously re-read every complete
comment row in the project. Updating an action likewise re-read every action's
payload and result. Both now use the existing immutable `0002` projection
journal's per-collection IDs and replacement revisions. No schema migration or
new persistence authority is introduced.

Within the existing capture transaction, up to 128 covered stable identities
read only the changed complete rows. Both collections order by `createdAt ASC,
rowid ASC`, now explicit in full, selected and per-comment action reads. If each
selected row existed in the trusted base and keeps its creation timestamp, the
previous array order remains valid. The merge preserves unchanged objects and
needs no complete ID query. The shared helper is confined to these two comment
row types; library ordering still uses its separate SQLite ID query.

Insertions, deletions, replacement (including identical IDs/timestamps), project
moves, ID changes, changed creation timestamps, oversized batches and unavailable
coverage fall back to a full affected collection or workspace. Parent deletion
captures cascaded action removal atomically. Empty ID reads issue no SQL, queries
remain project scoped, and read failures publish nothing. The existing database,
project, epoch and optimistic-publication checks remain authoritative. Initial
loads and fresh process recovery still capture the complete workspace.

## Headless acceptance

`acceptance/f6-comment-reads.json` runs one identical measurement probe against
the exact `842e8ca267dbbd14fc1b84e7ea8ae2feec90af9d` checkout and this change.
Fixtures contain 64 or 1,024 synthetic rows plus one existing seed row, with
8,200-character text in each of two JSON fields. A warm sample is excluded and
five captures are recorded per profile and revision. Every covered capture must
equal a separate full authoritative projection and the historical SQLite tie
order. The report includes 31 comment/action integration checks, 38 shared
coverage checks and four measurement cases.

| Collection / total rows | Complete payload rows before → after | Serialized gateway bytes before → after | Capture median ms before → after |
| --- | --- | --- | --- |
| Comments / 65 | 65 → 1 | 1,068,910 → 16,906 | 2.632 → 0.918 |
| Comments / 1,025 | 1,025 → 1 | 17,096,100 → 16,908 | 50.044 → 1.123 |
| Actions / 65 | 65 → 1 | 1,067,941 → 16,900 | 2.292 → 0.782 |
| Actions / 1,025 | 1,025 → 1 | 17,082,651 → 16,902 | 52.018 → 0.997 |

All profiles retain four queries. Total returned rows fall from 68/1,028 to
four: project, coverage clock, changed identity and selected full row. Bytes
are serialized gateway results, not disk pages or native IPC. These five-sample
Node timings include measurement serialization and concurrent host activity;
they do not establish an application or fixed-device latency budget.

`acceptance/f6-comment-recovery.json` runs the actual authored transaction and
workspace refresh queue for two scenarios: updating/resolving a comment, and
atomically updating/resolving a comment plus applying its action with payload
and result. For two seeds per scenario, the worker is killed at five observed
boundaries: before commit, after commit, queued refresh, captured before
publication, and published. Each of 20 SIGKILL cases has two fresh restarts.
Every restart checks the fixture, independent full-capture equality, unchanged
persistent rows (including journal/cursors), other-project isolation, SQLite
integrity and foreign keys. The warm capture must actually take the covered
comment/action path before publication; cold restarts must read the full state.

```bash
node scripts/run-workspace-comment-acceptance.mjs --baseline=842e8ca267dbbd14fc1b84e7ea8ae2feec90af9d
node scripts/run-workspace-comment-acceptance.mjs --check
node scripts/run-workspace-projection-recovery.mjs --comments
node scripts/run-workspace-projection-recovery.mjs --comments --check
pnpm exec vitest run src/renderer/architecture/workspace-comment-acceptance.test.ts
```

Ordinary checks require the current source fingerprint. Explicit `--historical`
validates the recorded contract without asserting current-source performance;
the read checker still verifies the identical measurement-probe hash. Fourteen
contract tests accept the two reports and reject missing profiles/cases, excess
payload rows/bytes, added ID queries/transfers, a changed probe, wrong scoped
recovery paths, disagreeing restarts and unsupported native/power-loss claims.

The implementation still merges an O(N) JavaScript array and initial capture
retains all bodies. Other collections, React publication, whole-app cost and
native/device recovery remain open. All work in this batch is headless; no
native window, OS focus, IME, touch or power-loss acceptance is claimed.
