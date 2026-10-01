# Plot Planner: clear contents

The desktop Editor's Plot Planner toolbar includes **Clear** (清空). The shared
confirmation dialog explains that this clears all row/column labels and cell
text in the current chapter or drift's planner. Cancel leaves the draft intact.
Rows, columns, their order and identities, cell dimensions, and prose stay intact.
The action cannot be undone through the prose editor's undo history.

Clearing reads the current draft, including text not yet saved by the debounce,
and emits one snapshot. The dock immediately flushes it through the existing
serialized mutation queue. This retains field-level sync authority and never
writes an empty `plotGridJson` directly. Closing the dock or switching its node
cancels any pending clear confirmation; repeated clicks do not queue duplicates.

Machine-checkable evidence uses synthetic fixtures:

```bash
pnpm exec vitest run src/renderer/domain/plot-grid.test.ts src/renderer/usecase/plot-grid-write.integration.test.ts src/renderer/store/confirmation-store.test.ts
```

The domain case checks text removal, preserved layout, source immutability, and
repeat-clear no-op mutations. The SQLite integration case checks a single
field-mutation transaction, the stored sparse projection, preserved cell
identity, unchanged Yjs prose bytes, and isolation from another chapter's planner.
The shared confirmation tests cover cancellation and queue behavior. These are
automated source/data checks; they do not certify native desktop UI interaction.
