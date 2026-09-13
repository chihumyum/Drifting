# Literal matching for retroactive entity links

After the project-routing fix, every matching editor still walked its document
and created one escaped `RegExp` per text node and normalized name. Every match
also created an identical ProseMirror mark. These allocations multiplied by
open editors, paragraphs and aliases even though matching was purely literal.

`lib/retroactive-entity-links.ts` now owns the document operation separately from
the extension's typing, configuration and display plugins. The existing
`linkEntityInDoc` extension export remains available. Each call trims and
deduplicates names, searches with `String.indexOf` and lazily creates one mark
for all matches in that document. No names, marks or documents are cached across
calls, and neither the project registry nor the persistence owner changes.

Each alias still advances by its own UTF-16 length. Searches remain case
sensitive and literal, including regular-expression punctuation. Different
aliases may overlap; they are deliberately not combined into one alternation,
which would omit parts of overlapping matches such as `aba` and `bab` in
`abab`. Matching does not cross ProseMirror text-node or formatting boundaries.
Existing same-target mark runs are skipped. Other target replacement,
transaction order, `targetBlockId: null` and `addToHistory: false` are preserved.

## Reproducible headless evidence

`acceptance/f3-link-matching.json` compares the exact historical escape helper
and linking function from `dd785f82` with the current function. The generator
checks their pinned source hashes and executes both against real ProseMirror
documents and synthetic editor-state holders. Seventy-two fixed/seeded cases
compare full document JSON, ordered steps, selection, history metadata and
repeated invocation; twelve unit tests separately assert specific matching and
allocation boundaries.

Nine measurement profiles combine 5,000/20,000/50,000 characters with 1/5/20
editors, each using eight names and 100-character paragraphs. Allocation and
traversal counters are separate from one warmup and five alternating timing
samples. The generator consumes resulting documents and records fixture/output
hashes. Timings exclude fixture creation, counters and serialization; they do
not measure rendering, input-to-paint or app startup. Every text node and alias
is still searched, so total traversal remains proportional to document and
alias counts.

All 72 comparisons passed. For 20 editors with 50,000 characters each, regex
constructions drop from 80,000 to zero and mark creations from 10,000 to 20.
Text-node visits remain 10,000 and dispatches remain 20. Measured medians are:

| Characters per editor | Editors | Baseline median (ms) | Current median (ms) |
| --- | ---: | ---: | ---: |
| 5,000 | 1 | 0.220 | 0.127 |
| 5,000 | 5 | 0.974 | 0.629 |
| 5,000 | 20 | 4.978 | 1.969 |
| 20,000 | 1 | 0.867 | 0.560 |
| 20,000 | 5 | 4.472 | 2.780 |
| 20,000 | 20 | 21.535 | 13.318 |
| 50,000 | 1 | 3.256 | 2.319 |
| 50,000 | 5 | 14.485 | 15.895 |
| 50,000 | 20 | 78.688 | 54.579 |

The 50,000-character/five-editor profile is slower in this run despite fewer
allocations. These short Node samples include runtime scheduling and GC; they
do not establish an across-the-board latency improvement.

`acceptance/f3-link-matching-browser.json` runs actual Tiptap editors with local
history and shared Yjs state. All 19 matching checks pass, covering overlapping aliases,
Unicode and punctuation, no extra undo item, idempotency, author edits before
and after linking, undo/redo, a hidden shared view, independent Yjs replay and a
subsequent peer update. The prior project's 126 routing/lifecycle checks and
all other deterministic renderer contracts run in the same headless build.

```bash
node --conditions=import --import=tsx scripts/measure-retroactive-links.ts
node --conditions=import --import=tsx scripts/measure-retroactive-links.ts --check
pnpm perf:renderer --ci --output=docs/renderer-performance/acceptance/f3-link-matching-browser.json
pnpm perf:renderer:check --deterministic --current --report=docs/renderer-performance/acceptance/f3-link-matching-browser.json
```

Collection verifies the final source fingerprint and preserves its real
pre-commit SHA. Historical comparison validation requires explicit
`--check --historical`, retains the baseline hashes and behavioral/allocation
contract, and does not require historical Git objects in ordinary shallow CI.
Default `--check` still rejects stale current-source evidence. Wall-clock
speedups are diagnostic rather than a CI threshold. Native windows, physical
input, SQLite restart and device budgets are not measured; full F3 remains open.
