# Project-owned retroactive entity links

Creating an element emits `element:element-created` with the persisted element's
project ID. Previously, every mounted editor installed its own application
listener and tested only editor liveness, auto-link enablement and self/parent
exclusions. It did not compare projects. A late creation event from one project
could scan and mark matching text in another project's mounted editor.

`useEntityEditor` now delegates this responsibility to
`features/editor/useRetroactiveEntityLinks.ts`. A shared registry routes one
application subscription to owners registered for the event's project. The
binding is attached only for the canonical editor instance and is retired in
layout cleanup when that instance, source or readiness changes. Every owner is
independently releasable; delivery skips owners disposed during a callback and
does not deliver the current event to newly attached owners.

The same-project behavior is preserved: hidden canonical editors still link
prose, auto-link disabled views do not, and an element editor or patch does not
link to itself or its parent. Destruction and canonical retirement block later
events. Linking still uses the existing live Tiptap/Yjs transaction and
`addToHistory: false`; no event queue, persistence owner or visibility-based
prose suspension is added. Other automatic-link, picker and CRUD paths are
outside this event-routing change.

## Headless acceptance

The ordinary renderer harness records `retroactiveEntityLinks` in
`acceptance/f3-editor-link-events-browser.json`. Its old-listener reference
reproduces the previous node-editor routing behavior in the same build. This is
a behavior/work comparison, not a timed historical app build.

Groups of 1, 5 and 20 actual editors contain 40 synthetic paragraphs each. A
foreign-project event previously invokes every listener and links the matching
text. The product hook must instead leave every foreign document unchanged,
with zero linking calls and zero text-node visits. A same-project event must
still link every editor, including hidden views. Counters are injected only in
the isolated acceptance build; ordinary product builds contain no counters.

Further checks cover self/parent exclusions, disabled, unready and destroyed
editors, layout-time A→B rebinding, canonical retirement, and visible/hidden
editors sharing one Y.Doc. Independent Yjs update replay verifies that expected
marks are in canonical CRDT state. Repeated attach/detach cycles must leave no
application listener or subsequent work. Five registry unit tests also cover
reentrant attachment/disposal and independent registrations of one callback.

The generated report passes all 126 scenario checks. With 20 editors, a foreign
event falls from 20 linking calls and 800 text-node visits to zero, and all 20
documents remain unchanged. The one shared application listener is released
after every group and after 100 attach/detach cycles. Same-project events still
visit all 800 text nodes and link all 20 editors. CI contract tests reject an
omitted section, foreign work, missing hidden-editor updates, leaked listeners
and failed behavior checks.

```bash
pnpm perf:renderer --ci --output=docs/renderer-performance/acceptance/f3-editor-link-events-browser.json
pnpm perf:renderer:check --deterministic --report=docs/renderer-performance/acceptance/f3-editor-link-events-browser.json
pnpm exec vitest run src/renderer/features/editor/project-element-created-registry.test.ts src/renderer/architecture/renderer-ci-contract.test.ts
```

The generator checks the current source fingerprint while collecting; the
report keeps its actual pre-commit SHA. Later historical contract validation
does not certify current-source timing. This batch does not measure native
windows, physical input, SQLite restart or device performance. Matching-project
editors still scanned their documents and constructed regexes within those scans
at this milestone. The subsequent [literal matching change](link-matching.md)
removes those allocations while preserving traversal. Neither result claims a
whole-app speedup or full F3 completion.
