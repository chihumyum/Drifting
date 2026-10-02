# Editor focus handoff and projection work

The 2026-10-02 investigation of clicks that feel stalled found two avoidable
renderer costs. These are confirmed code paths, not a reproduced diagnosis of
every failure to focus in the author's running desktop application.

- `EntityEditorSession` synchronously serialized the entire dirty document and
  invoked projection persistence from `blur`. A browser focus handoff to another
  editor therefore waited for this work. Blur now schedules that projection in
  the next timer task and retains selection immediately. Ordinary edits retain
  the 400 ms debounce; explicit save and teardown still flush synchronously.
  The timer also waits while IME composition is active; explicit save and teardown
  still flush. The independent Yjs update queue is unchanged. The timer yields the current
  event; it does not move computation to a worker or guarantee a paint first.
- Chapter metric materialization constructed a complete deterministic Yjs seed
  from cached JSON before asking the coordinator for canonical state. Live and
  durable documents discarded that seed. It now passes a lazy seed loader;
  only a genuinely unseeded document reads/converts the fallback, inside the
  coordinator's existing SQLite transaction. Corrupt canonical state still
  fails closed; stale cache JSON cannot block an authoritative Yjs save.

## Evidence

The generated [focus report](acceptance/editor-focus-handoff.json) uses real
Tiptap and Yjs in isolated Chromium. It compares the previous synchronous blur
behavior with the current session for 5k, 50k and 200k synthetic characters.
Full-document serializations inside focus handoff fall from one to zero in all
three profiles. Each deferred projection still saves exactly once, preserves
the complete prose and leaves the incoming editor focused. The same run checks
menu cleanup, initial focus/selection preservation and collaborative format undo.
Its single timing sample per profile is diagnostic, not a latency budget.

Session unit tests cover debounce, blur followed by further typing, immediate
save/close after blur, listener cleanup and source identity. Product SQLite
integration tests verify zero seed conversions for both live and closed Yjs
documents, authoritative recovery from corrupt cache JSON, seed-only fallback,
revision conflicts and corrupt-seed rejection.

Batch validation covers the targeted session and product SQLite tests, typecheck,
and the focused Chromium run below. Full renderer acceptance and native input
remain separate gates.

```bash
pnpm perf:renderer --editor-focus --output=docs/renderer-performance/acceptance/editor-focus-handoff.json
pnpm exec vitest run src/renderer/features/editor/entity-editor-session.test.ts src/renderer/services/node-prose-metrics-batch.integration.test.ts src/renderer/services/node-prose-metrics.service.test.ts
```

The focused runner has a distinct report kind and rejects full-CI/input-budget
flags. It cannot substitute for complete renderer acceptance. The attempted
[full run](acceptance/editor-focus-full-harness.failed.json) stopped in an Agent
panel ownership check before reaching the editor scenario; this failure remains
open and is not classified as a focus regression or a passing suite.

The remaining coordinator capture still clones/hashes canonical Yjs state and
flushes snapshots twice. Automatic linking, review decoration and typewriter
layout also execute on the renderer. Their contribution to the reported click
stall has not been measured. The static audit found no unconditional plain-text
click handler that disables focus. Native WebKit physical-click/IME behavior,
the author's live project and the exact intermittent symptom remain unverified.
