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
  See `docs/worktree-development.md`. Never point parallel apps at one database.

## Apple native migration

- **Paused by the author on 2026-09-29.** The Tauri client is the active
  client; do not start native batches, UI rework or acceptance refreshes unless
  the author resumes the migration. The archived state is tagged
  `apple-native-paused-2026-09-29`; see `docs/apple-native/README.md`. Keep
  shared Rust changes compatible with both clients.
- Follow `docs/apple-native/README.md` for the Apple-only target and staged gates.
- Shared native correctness lives in `crates/drifting-core`; Tauri adapters and
  `native/apple` must use that owner instead of duplicating migration logic.
- Native lab builds use synthetic data and separate application/data identity.
- Current implementation and all routine native acceptance are Mac-only. Finish
  the Mac front-end migration first; iPhone and iPad work and testing are deferred
  until the author discusses those platforms afterwards. Preserve shared Rust,
  existing UIKit code and historical results, but mobile is not a current gate.
- Native acceptance defaults to Mac. `--with-ios` explicitly adds mobile tests;
  `--ios-only` explicitly selects mobile-only, and `--include-ipad` also opts into
  mobile. Do not use these mobile options during the current Mac-only work.
- Open P2 document/IME/undo/recovery gates block only the affected editor or
  sync path, not the local writing loop; see `docs/apple-native/milestones.md`.
  A demonstrated data-loss or undo defect in the current batch still blocks it.
- The native client need not stay compatible or interoperable with the Tauri
  client for any feature (2026-09-27). New batches use native tests and Mac UI
  acceptance; do not add renderer parity oracles. Existing parity reports stay
  as regression evidence; retire or narrow one when native intentionally
  diverges.
- Iterate with targeted tests. Before each batch commit run `pnpm apple:refresh`
  (regenerates only stale evidence, in dependency order, then macOS acceptance)
  and `pnpm apple:check`. Related features may share one batch. Keep topic docs
  short; `milestones.md` holds status and open gates, not history.
- The Yrs document module requires Rust 1.96. Keep process-termination and
  power-loss durability evidence distinct.
- Default native acceptance excludes desktop XCTest input. On this host it
  repeatedly opened System Settings and timed out. The user permits desktop
  interaction, but repair the failing input path before repeatedly rerunning
  it. Keep omitted/failed UI evidence explicit; targeted app inspection is fine.

## Repository boundary

- This repository contains the Tauri 2, Rust, React, and Vite client.
- Public source builds default to local-only mode. Account, hosted sync,
  payment, and other official hosted features belong to a separately operated
  service. Google Drive is temporarily suspended in the App (2026-10-01):
  Hosted is the only enabled sync provider. Retain Drive schema, implementation
  and recovery data, but do not restore its UI or background execution without
  the author's request. See `docs/hosted-sync/README.md`.
- `packages/prose-metrics` is independently licensed under Apache-2.0. The
  remaining project-owned client source is AGPL-3.0-or-later.
- Keep service integration behind versioned network contracts. Do not import or
  mirror private service source.

## Public Alpha compatibility policy

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
