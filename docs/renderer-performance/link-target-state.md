# Entity-link target lookup

`useEntityLinkConfiguration` now delegates target existence to
`lib/entity-link-target-state.ts`. Each lookup reads the current store snapshot
and uses the existing weak, collection-keyed ID index shared by other renderer
consumers. It does not create an index per editor, retain a second workspace
snapshot or capture old project data in a callback.

The previous resolver called `Array.some` for every link. Refreshing dangling
link decorations or resolving repeated navigation targets could therefore scan
the same entity collection repeatedly across editors. Initial index construction
still visits the whole requested collection. Further lookups reuse it until that
immutable collection is replaced. Index memory is proportional to indexed
collections; this change does not establish a memory reclamation budget.

The four tracked kinds remain element, node, storyline and category. An existing
row takes precedence over a stale trash flag; a missing row is trashed or gone
according to the current trash set. Kinds owned elsewhere, including patch,
retain their existing permissive navigation behavior. No persistence, prose,
editor session, refresh-trigger or migration behavior changes.

## Headless evidence

The ordinary headless renderer runner includes `entityTargetState` in
`acceptance/f2-link-target-state-browser.json`. Its deterministic CI validator
requires this section and rejects missing profiles, repeated scans and failed
lifecycle checks.

Nine profiles combine 100 / 1,000 / 5,000 records per tracked kind with
1 / 5 / 20 consumers and 500 target lookups per consumer. ID getters count actual
record visits in both the linear reference and the product resolver. This is a
single-build operation comparison; the reference reproduces the earlier lookup
algorithm and is not a timed historical application build. Each query deliberately
uses the last or an absent ID, so this describes the linear path's worst case,
not an average author document.

The recorded largest profile executes 10,000 lookups over four 5,000-row
collections: 50,000,000 linear record reads become 20,000 index-building reads;
repeating those queries reads zero collection rows. All nine profiles return the
same states as the reference. Twenty-five browser checks passed. Six unit tests
cover all tracked kinds, trash precedence, permissive patch navigation and
collection replacement/reuse. These counters exclude hash-map lookup cost and
full-document decoration traversal, neither of which is removed.

Two actual Tiptap editors, one visible and one hidden, mount the production
configuration hook. Checks cover soft deletion, hard deletion, restoration,
project replacement and return, and unchanged editor instances and prose.
These run in isolated headless Chromium; they do not occupy native application
windows or measure physical input or device budgets.

```bash
pnpm perf:renderer --ci --output=docs/renderer-performance/acceptance/f2-link-target-state-browser.json
pnpm perf:renderer:check --deterministic --report=docs/renderer-performance/acceptance/f2-link-target-state-browser.json
pnpm exec vitest run src/renderer/lib/entity-link-target-state.test.ts src/renderer/architecture/renderer-ci-contract.test.ts
```

The `--ci` generator verifies the exact source fingerprint before writing and
checks current provenance while collecting. Later commits retain the actual
pre-commit SHA and measured fingerprint; historical deterministic validation
alone does not certify current-source timings.
