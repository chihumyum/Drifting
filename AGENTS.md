# AGENTS.md

Guidance for coding agents working in this standalone Drifting client repository.

## Working agreements

- Use `pnpm` and preserve unrelated worktree changes.
- Before meaningful edits, inspect the relevant code and follow existing
  patterns. Do not treat generated acceptance evidence as hand-edited prose.
- Every completed feature milestone must update its durable documentation and
  machine-checkable acceptance evidence in the same change.
- Do not commit credentials, `.env` files, private manuscripts, personal paths,
  databases, signing material, or data copied from the private official service.
- Test fixtures must be synthetic or have documented redistribution rights.

## Repository boundary

- This repository contains the Tauri 2, Rust, React, and Vite client.
- Public source builds default to local-only mode. Account, hosted sync,
  payment, and other official hosted features belong to a separately operated
  service. Author-connected personal-cloud providers remain client capabilities.
- `packages/prose-metrics` is independently licensed under Apache-2.0. The
  remaining project-owned client source is AGPL-3.0-or-later.
- Keep service integration behind versioned network contracts. Do not import or
  mirror private service source.

## Pre-release compatibility policy

- Drifting has not shipped a public data-compatibility contract. Until this
  section is explicitly revised, architectural clarity takes priority over
  preserving historical development data or retired private-service behavior.
- Do not add migrators, fallback reads, dual writes, legacy enum values, dormant
  jobs, recovery UI, or adapter layers solely for old R2, hosted-service,
  absolute-path, or other pre-release formats. Delete obsolete representations
  and update the current schema, fixtures, documentation, and acceptance checks
  together. Local development databases may be reset.
- A future compatibility layer requires an explicit product decision recorded
  here and in the relevant architecture document, including the released source
  version, supported data population, migration guarantees, and removal policy.
- This policy does not relax current durability guarantees: once a current-format
  local write commits, its SQLite/Yjs state and app-owned asset bytes must still
  obey the documented transaction, deletion, and recovery boundaries.

## Data and editing invariants

- Live Yjs CRDT state is prose truth; `contentJson` is only a seed or cache.
- Automated prose writes go through `writeChapterProse` or the live `Y.Doc`.
- Drift nodes may be free-floating and `mainStorylineId` may be nullable.
- Agent review decisions are durable in SQLite while prose remains in Yjs.
- Preserve the renderer-owned, provider-neutral Agent protocol and its
  `local`/`sidecar`/`remote` seam. The generated capability inventory is the
  authority for the current tool surface; see
  `docs/agent-runtime/acceptance/agent-capabilities.md`.

## Retired Agent Products

- Standalone Shadow CI, Element Arc, and Goal Evolve are retired. Do not restore
  their panels, routes, storage, or eval harnesses as separate products.
- The frozen, unimplemented Ambient Editor target is indexed at
  `docs/ambient-editor/README.md`. It must use the shared renderer-owned Agent Runtime.

## UI rules

- Mobile quality should feel immediate and continuous, but Drifting defines its
  own navigation and top/bottom-bar behavior.
- Avoid inset-left vertical accent bars; use wash, spacing, or typography.
- Dropdowns and popovers portal to `body` with `position: fixed`.
- Preserve act/chapter/scene/beat/note semantics in the five-level outline.

## Checks

```bash
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
```
