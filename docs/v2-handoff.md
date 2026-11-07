# Handoff to Drifting 0.2

Status: **current behavior** of every build from this change on. Nothing is
visible to the author.

Drifting 0.2 is the Rust + GPUI + Loro rewrite (`docs/rust-rewrite/`). It
imports a 0.1.x library by reading its SQLite file directly and has no Yjs
(decision D5, [P0-E conclusion](rust-rewrite/spikes/p0-e-import.md)).
Everything it needs is already in SQLite except one fact: whether each prose
body's `contentJson` cache shows the current Yjs state. A cache lags when the
app quits inside the editor's 400 ms persist debounce, or between an Agent
write's Yjs append and its projection refresh. Chapters are repaired when a
book opens; element, storyline, category and material-note caches are not.

The handoff keeps every library ready: each cache equal to its Yjs rendering,
and a stamp in `library_state` that says so. Because the stamp is written on
every launch and quit, a library that has run any build with the handoff can
be imported exactly, even if the author skips the last 0.1.x release.

## What a pass does

`runV2Handoff` (`src/renderer/services/v2-handoff/handoff.ts`):

1. Lists every document with Yjs state (`yjs_updates` ∪ `yjs_snapshots`) and
   its `yjs_document_revision`. Only documents whose revision differs from
   their stamp entry are candidates; entries for documents without Yjs state
   are dropped.
2. In batches of 16, reads the persisted Yjs state and the owner's cache at
   one SQLite boundary, renders the state exactly as the node projection and
   the sync kernel do (`JSON.stringify(yDocToProsemirrorJSON(doc, 'default'))`),
   and rewrites a cache that differs:
   - chapters and ideas through `materializeCanonicalNodeProse`, so outline,
     word count and basis travel with the cache;
   - elements, storylines, categories and material notes by setting only the
     cache column, in a derived transaction, without changing `updated_at`;
     the open workspace's store is updated to match.
3. Re-reads revision and cache at one boundary and stamps only documents whose
   revision is unchanged and whose cache is byte-for-byte the rendering.
4. Renders the preview of any snapshot-history row whose preview is missing
   (at most 32 per pass).
5. Writes the stamp, with the author's preferences: raw, and per book for
   the books in this library.

Every write is a derived, never-journaled transaction: nothing syncs, and no
Yjs state changes. Documents whose owner row is gone (a deleted material keeps
its Yjs rows) are skipped and left unstamped.

## When it runs

`installV2HandoffRuntime` (`runtime.ts`), installed by `V2HandoffEffects` when
the library opens (`db:ready`):

- **Background**, 20 s after the library opens. Documents open in an editor
  are skipped: the editor owns their cache. Batches yield to the UI.
- **Quit barrier**: the `v2-handoff` step of `performLocalFlush`
  (`lib/persistence-lifecycle.ts`), after editors are saved and Yjs, asset and
  transaction queues are drained, and before the database checkpoint. Open
  documents are included. A running background pass stops at its next batch
  first. The step has a 1.5 s budget, stops between batches when it runs out,
  and never fails the flush: the next launch picks up what it left.

Measured on the stress seed (619 documents, 3.9 million characters): the first
pass takes 0.68 s; a pass with nothing changed takes 14 ms.

## The stamp

`library_state` key `v2-handoff`:

```json
{
  "version": 1,
  "appVersion": "0.1.0-alpha.11",
  "updatedAt": "2026-11-07T08:00:00.000Z",
  "documents": {
    "node-content:<nodeId>": { "revision": 12, "sha256": "<hex>" },
    "element:<elementId>": { "revision": 3, "sha256": "<hex>" }
  },
  "settings": {
    "capturedAt": "2026-11-07T08:00:00.000Z",
    "entries": { "settings-storage": "<raw value>", "shortcuts-storage": "<raw value>" }
  },
  "books": {
    "<projectId>": {
      "wordTarget": 80000,
      "dailyWordTarget": 1000,
      "relationTypeColors": { "<relationTypeId>": "#aabbcc" },
      "elementPins": { "<elementId>": [12.5, -40] }
    }
  }
}
```

- `revision` is the document's `yjs_document_revision.revision` when its cache
  was verified; `sha256` is the lower-case hex SHA-256 of the cache's UTF-8
  bytes.
- The importer trusts a body only when both still hold. A later edit moves the
  revision; a cache changed without a Yjs change fails the hash. Either way
  the importer asks instead of importing a wrong body, and does not fall back
  to a weaker rule for that document.
- `settings` are raw WebView storage values, which the 0.2 program cannot read
  itself. Only preference and layout keys are copied (`settings.ts`):
  the persisted settings, shortcuts, UI, sidebar, recent-entities, check-in and
  organize stores; view modes, panel sizes and widths; the shelf cover style;
  manuscript-export choices; per-book graph layouts, plot-grid ratios and edge
  styles; guide-seen flags. Session tokens, the Hosted profile, diagnostics,
  updater state, the preference-sync ledger and transient Agent state are
  never copied. Settings are app-wide, so each library carries a copy.
- `books` holds the per-book preferences already read out of their stores'
  own formats (`books.ts`), so 0.2 need not parse them: the writing plan of
  the persisted writing-stats store (`wordTarget`, `dailyWordTarget`; present
  only when the book has a plan, and `0` is a target the author turned off),
  the relation-type line colors of `drifting:edge-kind-meta:<projectId>`
  (version 2 only, as `useEdgeKindMeta` reads it), and the pins of the 关系
  layout in `super-element-view:relate:<projectId>` (`[x, y]` world px; not
  the computed positions or the layout mode). Only books in this library's
  `project` table are written, sorted by id; a book with nothing to say and
  an empty part are left out, so `{}` means storage had nothing for this
  library. Writing history is a rebuildable cache and is not copied. The
  section is additive within `version: 1`: a stamp without `books` was
  written before it existed, and the importer falls back to the raw values
  in `settings.entries` (colors and pins; `writing-stats-storage` is not on
  the settings allowlist, so such a stamp has no writing plan). When storage
  is unavailable, both `settings` and `books` keep the previous stamp's
  values.

`library_state` is device-local and never synced. Keychain entries stay where
they are; 0.2 reads them under the same service name.

## Machine acceptance

```bash
pnpm exec vitest run src/renderer/services/v2-handoff src/renderer/lib/persistence-lifecycle.test.ts
```

The integration suite builds 阿Q正传 as the first run writes it, appends edits
through the ordinary authored Yjs writer without their projection (the quit
inside the debounce), and checks that one pass:

- makes every cache equal to its Yjs rendering and stamps every document with
  its revision and hash, chapters with their basis;
- changes no `updated_at` and creates no sync change-set;
- revisits only documents whose revision moved, and leaves orphaned Yjs rows
  unstamped;
- leaves an open document to the quit pass;
- stops between batches when the budget runs out and finishes next time;
- renders a missing snapshot-history preview;
- copies allowlisted preferences and no credentials;
- stamps each book of this library (a 0 target kept, another library's book
  left out) and keeps the last `books` when storage is unavailable.

`books.test.ts` checks the per-book readers on their own: plans, colors and
pins; an older writing-stats payload read through the store's migration; and
malformed or other-version values ignored as the stores ignore them.

### Fixtures for the 0.2 importer

`m10-fixtures.test.ts` is skipped unless `DRIFTING_M10_FIXTURE_DIR` names an
output directory:

```bash
DRIFTING_M10_FIXTURE_DIR=/path/to/fixtures pnpm exec vitest run src/renderer/services/v2-handoff/m10-fixtures.test.ts
```

It writes three synthetic libraries, each `<name>/drifting-library.db`
(checkpointed and closed) with `<name>/app-local-data/` in the native asset
store's layout: `sample`, both built-in samples as the first run writes them,
illustration bytes included; `sample-stale`, that library after authored Yjs
edits without their cache projection (a chapter, element, storyline, category
and material note), three snapshot-history rows each on two documents from
the app's capture service, and no stamp; `sample-handoff`, that library after
per-book preferences in WebView storage and one quit pass. For these and any
`lite`/`stress` seed library already in the directory it writes
`truth/<name>.jsonl`, one line per document with Yjs state
(`documentId`, `revision`, and `prose`, the parsed rendering of its current
state) and per history row (`historyId`, `documentId`, `prose` from
`state_blob`), and a `manifest.json` with each library's projects and
counts. Even a library no one has edited has caches that are not the Yjs
bytes: the samples' chapter caches carry entity-link marks in their own
attribute order and without the schema's null defaults (same text), which is
why the importer judges a cache by revisions and the stamp, never by
comparing it with the Yjs bytes.

The lifecycle test checks that the handoff runs after every durability lane,
before the checkpoint, and that its failure does not fail the flush. The 0.2
side of the contract, including a cache edited after stamping, is in
[`rust-rewrite/acceptance/p0-e-import.json`](rust-rewrite/acceptance/p0-e-import.json).
