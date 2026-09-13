# Shared link display inputs and retained hidden editors

Each `useEntityLinkConfiguration` previously subscribed to settings and workspace
color/trash inputs, rewrote shared resolvers, incremented the same global color
version, and sent a full dangling-link refresh. Renaming a target, toggling link
interaction or changing only a color could therefore scan every mounted editor.
Because each effect incremented the shared version separately, all but the last
editor could scan colors again on its next otherwise unrelated transaction.

`entity-link-presentation-registry.ts` now owns one subscription to each store
while editors are attached. It compares target ID membership and trash sets
separately from the existing shared color signature. Resolvers read current
stores at use time. Colors increment the shared version once; interaction only
updates the click preference; title, alias and body changes with unchanged
membership/appearance do not notify display consumers. Reentrant store changes
are reconciled before returning. Last-owner cleanup unsubscribes both stores
and releases the retained membership snapshot and color signature.

Each view still owns automatic-link configuration. Canonical views bind the
shared display subscription. Display work has its own per-view state in a weak map, released with the ProseMirror view. Hidden
views retain dirty liveness state and defer full color queries. Their document
updates still map existing decorations, render changed mark DOM and schedule
automatic linking. A hidden document change also makes liveness dirty so a
newly inserted or restored missing-target link can be corrected before reveal.
This does not suspend document, undo or persistence ownership.

Visible/preparing views flush dirty liveness and color work synchronously. A
color-only refresh does not call the dangling-decoration builder. Preparation
must finish before `useEntityEditor` reports ready; a retained hidden readiness
snapshot or a previous canonical binding does not satisfy the incoming owner.
Failed display refresh stays unready and retains dirty work for a retry. The
existing full initial plugin construction and per-mark rendering are unchanged;
this batch does not claim to eliminate initial mount or every hidden operation.

## Headless acceptance

The renderer harness records `entityLinkPresentation` in
`acceptance/f3-link-presentation-browser.json`. Its reference hook reproduces the
previous invalidation wiring from `248ca3cb` in the same build, using the same
real Tiptap editors and synthetic workspace. This is a work-count comparison,
not a historical complete-app timing comparison.

Profiles have 1/5/20 editors, 100 linked paragraphs (10,000 characters) per view,
and 5,000 nodes plus 5,000 elements. One view is presentation-active; the others
are retained and hidden. One hundred rename/target-map updates, color changes
and interaction toggles are measured separately, followed by a target deletion
and returning-view preparation. The trace also checks that a later unrelated
transaction does not repeat a color scan merely because another editor updated
the shared version.

For twenty editors, each batch of 100 rename or interaction changes falls from
2,000 full liveness scans (200,000 text nodes) and 2,000 color scans to zero.
For 100 color changes, color scans fall from 2,000 to 100 and liveness scans
from 2,000 to zero; the shared version increments 100 times instead of 2,000.
The following unrelated transaction incurs zero extra scans rather than 19.
A deletion scans one visible document instead of twenty. A returning hidden
view then performs one liveness scan and one color scan before becoming ready.
These are deterministic operation counts; there is no elapsed-time speedup claim.

All 40 browser checks pass. Additional real Tiptap/Yjs checks cover hidden document updates, layout readiness,
canonical rebinding, visible/hidden convergence, preserved undo, independent
CRDT replay, hidden automatic linking, display failure/retry and repeated
teardown. Seven registry unit tests cover single subscriptions, semantic filtering, deletion/recovery,
independent owners, reentrant updates and one hundred release/reconnect cycles.
The report checker rejects omitted scenarios, repeated versions, color-triggered
liveness scans, hidden work, failed behavior checks and missing lifecycle runs.

```bash
pnpm perf:renderer --ci --output=docs/renderer-performance/acceptance/f3-link-presentation-browser.json
pnpm perf:renderer:check --deterministic --current --report=docs/renderer-performance/acceptance/f3-link-presentation-browser.json
pnpm exec vitest run src/renderer/features/editor/entity-link-presentation-registry.test.ts src/renderer/architecture/renderer-ci-contract.test.ts
```

Counters exist only in the isolated acceptance build. Generated evidence keeps
its real pre-commit SHA and source fingerprint. Historical report validation
is not current-source timing verification. No native window, physical input,
SQLite restart, heap-retention measurement or fixed-device budget is inferred;
full F3 remains in progress.
