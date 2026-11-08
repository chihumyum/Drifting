# AGENTS.md

Guidance for coding agents working in this standalone Drifting client repository.

## Working agreements

- Use `pnpm` and preserve unrelated worktree changes.
- Develop and validate in a separate Git worktree, then merge locally into
  `main`. Do not open pull requests unless the author explicitly requests one.
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
  For DOM-level checks start `pnpm drifting frontend serve --platform desktop`
  and add `--frontend-debug` to the launch; desktop acceptance needs no iOS
  Simulator. See `docs/worktree-development.md`. Never point parallel apps at
  one database.

## Repository boundary

- This repository contains the Tauri 2, Rust, React, and Vite client.
- Public source builds default to local-only mode. Account, hosted sync,
  payment, and other official hosted features belong to a separately operated
  service. Hosted is the only sync provider. Google Drive sync and the
  standalone Apple-native front-end have been removed; do not restore them.
  Migration `0014` turns a library still bound to Drive into a local library.
  Tauri still uses `drifting-core`, `drifting-document` and `drifting-prose`;
  Apple platform adapters and Tauri iOS are not the removed front-end. See
  `docs/hosted-sync/README.md`.
- `packages/prose-metrics` and its Rust port `next/crates/prose-metrics` are
  independently licensed under Apache-2.0; `next/crates/gpui-prose`,
  `next/crates/gpui-ime` and `next/crates/prose-linebreak` under MIT OR
  Apache-2.0. The remaining project-owned client source is
  AGPL-3.0-or-later.
- Keep service integration behind versioned network contracts. Do not import or
  mirror private service source.

## New workspace (`next/`)

- `next/` is the Rust + GPUI + Loro rewrite of the desktop client; the plan is
  `docs/rust-rewrite/`. It is its own Cargo workspace with its own toolchain
  file and lockfile, and shares no code with the 0.1 client. Every other rule in
  this file keeps applying to the 0.1 client (`src/`, `src-tauri/`, `crates/`,
  `drizzle/`, …) until the switch-over.
- GPUI is pinned to a Zed release tag and Loro exactly; other dependencies go
  in `[workspace.dependencies]`, pinned at least to a minor version. One
  workspace member per line, sorted. Keep `[patch.crates-io]` in step with the
  Zed tag. See `next/README.md`.
- The Agent runtime in `next/` has one in-process driver only. The
  `local`/`sidecar`/`remote` seam rule under "Data and editing invariants"
  applies to the 0.1 client alone (author decision, 2026-11-07).
- Development builds carry the bundle id `cc.drifting.next.dev`. Do not give a
  `next/` build the release client's identity before F7's hand-over.
- Zed's `editor`, `text`, `rope`, `ui` and `theme` crates are GPL-3.0; do not
  copy from them. `gpui`, its platform crates and `sum_tree` are Apache-2.0.
- Checks, run in `next/` (CI: `.github/workflows/next.yml`, macOS and Windows,
  when `next/`, `docs/rust-rewrite/` or the old resources `next/` still uses
  change):

  ```bash
  cargo fmt --all --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  cargo xtask check
  ```

  `cargo xtask check` runs the new workspace's gates: privacy and
  credentials, large files, retired products, terms (H1/H2/H3 are never
  scenes or beats), pinned migrations, licences, dependency direction,
  measured evidence and `cargo audit` (`--skip audit` offline). See
  `docs/rust-rewrite/foundations/f8-testkit.md`.
- Test data in `next/` comes from `dr_testkit::seed` (presets tiny / lite /
  heavy / showcase) and `dr_testkit::samples`; do not write another corpus.
  Contract evidence is asserted in tests, never committed as JSON; measured
  evidence is committed only at a milestone
  (`cargo run --release -p dr-testkit --bin bench -- <suite> --milestone <m>`).
- Run a `next/` development build with `cargo xtask dev`: in a linked worktree
  it sets `DRIFTING_PROFILE` to the worktree's name, so parallel builds never
  share a library or a lock (`--instance <name>` for a second one,
  `--print-config` to inspect). `cargo xtask dev --hot` runs it under
  `dx serve --hot-patch` (dx 0.7.10, GPUI's `hot-reload`): a view's render
  code patches into the running window without a restart; debug builds
  only, and like the bridge never on by default or in a release script
  (gate `hot-reload`, `cargo xtask check-binary`). Offline library changes
  go through `cargo drifting workspace …`: the app closed, a backup first,
  `--yes`.
- Desktop acceptance of `next/` drives the real window through F8's debug
  bridge: `cargo xtask dev --debug-bridge`, then `cargo drifting app …`
  (open, type, key, text, state, screenshot), or a scenario with
  `--app target/debug/drifting`, which runs under a throwaway profile. The
  bridge is a development-only feature: never turn it on by default or in a
  release script (`cargo xtask check`, `cargo xtask check-binary`).

## Public Alpha compatibility policy

- Releases are published on GitHub as described in `docs/releasing.md`;
  publishing a release is what offers it to installed apps as an update.
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
- Agent writes commit directly. Their settlement receipts are durable in
  SQLite while prose remains in Yjs; migration `0018` retired the reject/revert
  review states. Undo goes through entity snapshot history.
- Preserve the renderer-owned, provider-neutral Agent protocol and its
  `local`/`sidecar`/`remote` seam. The generated capability inventory is the
  authority for the current tool surface; see
  `docs/agent-runtime/acceptance/agent-capabilities.md`.

## Retired Agent Products

- Standalone Shadow CI, Element Arc, and Goal Evolve are retired. Do not restore
  their panels, routes, storage, or eval harnesses as separate products.
  Migration `0017` dropped the Goal route columns and the Claude SDK
  `sdk_session_id`; every runtime session belongs to a chat conversation.
- Copilot (element extraction and patch suggestions, rolling block summaries,
  ⇧⌘I inline edit and inline ask) was retired on 2026-10-30; proactive AI goes
  through the Agent. Do not restore its UI, settings, runtime or the Google
  BYOK route. Keep the `block_section` table, its sync domain and the stored
  `copilot` comment enum values; typed TODO markers still project into todos.
  The last commit with Copilot is tagged `copilot-retired-2026-10-30`.
- The frozen Ambient Editor (Shadow) design was retired unimplemented on
  2026-10-30. Proactive Agent work grows from the Project Home check-in
  (`docs/agent-runtime/project-checkin.md`) on the shared renderer-owned
  Agent Runtime.

## UI rules

- Mobile quality should feel immediate and continuous, but Drifting defines its
  own navigation and top/bottom-bar behavior.
- Avoid inset-left vertical accent bars; use wash, spacing, or typography.
- Dropdowns and popovers portal to `body` with `position: fixed`.
- The outline is act / chapter / H1 / H2 / H3. Acts and chapters are the
  book's structure; H1, H2 and H3 are three heading levels whose meaning the
  author decides. Call them H1/H2/H3 only: never scene, beat, note or any other
  fixed role, in UI copy, Agent prompts, export or docs, and treat the three
  levels alike.

## Checks

```bash
pnpm ci:contract:check
pnpm public:check
pnpm lint
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
```
