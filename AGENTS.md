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
- For automated desktop UI acceptance, use `pnpm dev:worktree --no-watch`
  instead of the daily-use launcher. Each checkout gets its own database,
  application identity and port; use `--instance <name>` for parallel runs in
  one checkout and `--print-config` to inspect the non-secret JSON manifest.
  In a linked Git worktree plain `pnpm dev` uses that isolated profile by
  itself; `pnpm dev:seed` starts one with a synthetic sample project.
  See `docs/worktree-development.md`. Never point parallel apps at one database.

## Repository boundary

- This repository contains the Tauri 2, Rust, React, and Vite client.
- Public source builds default to local-only mode. Account, hosted sync,
  payment, and other official hosted features belong to a separately operated
  service. Hosted is the only supported sync provider. Google Drive sync and
  the standalone Apple-native front-end were retired on 2026-10-28. Do not
  restore their UI, transport, plugins or build gates. Preserve published
  migrations, stored recovery records and the local-replica adoption path.
  Tauri still uses `drifting-core`, `drifting-document` and `drifting-prose`;
  Apple platform adapters and Tauri iOS are not the retired front-end. See
  `docs/client-onboarding-and-hosted-readiness.md` and `docs/hosted-sync/README.md`.
- `packages/prose-metrics` is independently licensed under Apache-2.0. The
  remaining project-owned client source is AGPL-3.0-or-later.
- Keep service integration behind versioned network contracts. Do not import or
  mirror private service source.

## Public Alpha compatibility policy

- **Release contract and gates paused by the author on 2026-10-28** for a
  large restructuring; `docs/alpha-release-contract.md` is not in force and
  gates will be rebuilt once the client stabilizes. The migration rules below
  still apply unless the author says otherwise.
- `0.1.0-alpha.1` freezes the first public SQLite/domain/checkpoint baseline.
  Every later public `0.1.x` build must open and migrate every earlier public
  `0.1.x` database without asking the author to reset it.
- Published migrations are immutable. Add a new ordered migration; never
  rewrite a released migration or silently discard unknown data.
- As of 2026-08-26 the baseline is in force for daily use:
  `drizzle/0000_local_first_baseline.sql` is treated as published and must never
  be edited again. Every schema change from now on appends an ordered migration
  and passes the shadow-migration safety-snapshot path, so the maintainer's own
  working databases are inside the compatibility population.
- Development databases created before `0.1.0-alpha.1` remain outside the public
  compatibility population. Do not add fallback reads, dual writes, legacy enum
  values, dormant jobs, or adapters solely for retired R2, hosted-service, or
  absolute-path formats. A current-baseline database may be preserved; older
  development data must be exported or reset before entering the public line.
- Before a public migration can mutate local state, create and verify a native
  SQLite safety snapshot. On migration failure, leave the source database
  untouched, stop opening the workspace, and surface recovery guidance.
- Once a current-format local write commits, its SQLite/Yjs state and app-owned
  asset bytes must obey the documented transaction, deletion, and recovery
  boundaries.

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
pnpm ci:contract:check
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
```
