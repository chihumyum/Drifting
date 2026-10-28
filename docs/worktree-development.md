# Isolated desktop development and AI acceptance

Run from the checkout being tested:

```bash
pnpm dev:worktree --print-config
pnpm dev:worktree --no-watch
```

The first command prints a non-secret JSON manifest without creating files,
checking signing or starting an app. The second starts the Tauri client with
Vite HMR; `--no-watch` prevents Cargo from restarting it during automation.
Omit that flag for ordinary Rust development. macOS uses the same development
certificate check as `pnpm dev`.

The profile key is a hash of the canonical checkout path and instance name.
It works for Git worktrees, ordinary clones and detached checkouts, including
directory names containing spaces. A symlink to the same checkout resolves to
the same profile. Changing branches retains the profile; moving the checkout
changes it. Repeated launches reuse their synthetic test data.

```bash
# Two independent acceptance runs in one checkout:
pnpm dev:worktree --instance editor --no-watch
pnpm dev:worktree --instance sync-ui --no-watch

# Read machine output without pnpm's command banner:
node scripts/run-worktree-dev.mjs --instance editor --print-config

# If the deterministic port is already occupied:
pnpm dev:worktree --instance editor --port 25173 --no-watch
```

Each profile has:

- An absolute database directory under `.local-data/worktree-dev/<profileId>/databases`.
- A separate Tauri identifier, application-data directory, Keychain service,
  deep-link scheme and window title. Assets, installation identity and local MCP
  grants follow that application identity.
- A stable loopback Vite port shared by `devUrl`, HMR and CSP. An occupied port
  stops startup; the launcher never attaches to someone else's frontend.
- Its own Cargo target and Vite cache, so parallel builds cannot replace another
  running profile's binary. The first build per profile can take several minutes
  and uses additional disk space.
- Separate WebView state: persistent per-profile directories on Windows/Linux,
  and an ephemeral store on macOS. Browser preferences reset between macOS
  launches, while SQLite and app-owned assets remain persistent. The installed
  Tauri code generator cannot compile `dataStoreIdentifier`; ephemeral stores
  avoid that limitation without changing product Rust code. Changing the port
  also changes the frontend storage origin.

The launcher defaults to local-only mode and overrides inherited `DRIFTING_DB_DIR`,
`CARGO_TARGET_DIR`, app flags and custom runners. It retains host toolchain and
macOS signing configuration, but drops inherited app credentials, Hosted
configuration and debug-bridge endpoints. Vite does not read checkout dotenv
files for this launch. Generated configs and `profile.json` remain in the
ignored profile directory; no existing database or credentials are copied.

For an explicitly authorized Hosted acceptance run, use
`pnpm dev:worktree --online --instance sync-ui --no-watch`.
It reads the same exact service origin as `pnpm dev:online`, enables Hosted and
includes that origin in the profile identity and CSP. Another service gets a
different library and credential service; the default local profile is not uploaded.
Allow the manifest's exact development origin in the operator's service CORS
configuration when testing remote authentication. Do not enable wildcard CORS.

Use only synthetic data in these profiles. A fresh profile starts without cloud
bindings. Google Drive is temporarily suspended in all App builds. The launcher does not seed fixtures, grant MCP access or
claim UI acceptance (`pnpm dev:seed` below seeds one). Configure test-owned MCP
access from the isolated app if needed. Existing acceptance collectors keep their
own fixture workflows.

Keep one running launcher per profile. To get fresh state, choose a new
`--instance` name; there is deliberately no automatic reset/delete operation.
On macOS/Linux, stop the launcher with SIGINT or SIGTERM to stop its owned
process group. Release build commands are unchanged.

## Isolated macOS Debug packages

```bash
pnpm dev:worktree --build-app --instance package --print-config
pnpm dev:worktree --build-app --instance package --no-watch
```

`--build-app` builds and signs a Debug `.app` with embedded, production-minified
frontend assets, without starting Vite or launching the app. It uses a separate
profile key from the development-server mode. The manifest includes the bundle
and frontend paths; native databases use the generated identifier's Application
Support directory. Launch the returned `.app` in Finder or through computer use.
Its persistent WebView allows settings/restart checks while its distinct app
identity keeps that storage separate from daily use. Quit a running copy before
rebuilding the same instance; choose a new instance for fresh acceptance data.
The package uses the existing Apple Development signing preflight, produces no
updater artifacts and does not notarize or publish a release. `--online` remains
an explicit opt-in; see [Sentry acceptance](sentry-observability.md#isolated-mac-test-package)
for the separate diagnostic acceptance entry and evidence.

## `pnpm dev` in a linked worktree

The shared profile (identity `cc.drifting.client`, port 5173, its application
data and Keychain service) belongs to the main checkout's daily library. In the
main checkout, or outside Git, `pnpm dev` and `pnpm dev:online` are unchanged.
In a linked Git worktree (`git worktree add`, including agent worktrees) they
start that worktree's isolated profile instead, exactly as
`pnpm dev:worktree [--online]` would, so several people or agents can develop
in their own worktrees at once. `DRIFTING_DEV_SHARED_PROFILE=1 pnpm dev` keeps
the shared profile deliberately.

## Seeded profiles

**The lite seed is for fast functional verification. The default stress seed is
for validating performance and stability changes.** Both use isolated local-only
worktree profiles and the ordinary current-format application data model.

```bash
pnpm dev:seed --no-watch            # stress, instance "seed-stress-v2"
pnpm dev:seed:lite --no-watch       # lite, instance "seed-lite-v2"
pnpm dev:seed --lite --no-watch     # same lite preset
pnpm dev:seed --print-config        # non-mutating profile + preset manifest
```

| Data | Stress (default) | Lite (functional checks) |
| --- | --- | --- |
| Chapters | 100; **1,500,000 words**, 2,000–20,000 each | 20; **150,000 words**, 2,000–20,000 each |
| Elements | 300; **500,000 words**, 100–10,000 each | 30; **50,000 words**, 100–10,000 each |
| Inspirations | 200; **1,000,000 words**, 1,000–50,000 each | 10; **20,000 words**, 1,000–5,000 each |
| Material notes | 60; **500,000 words**, 500–10,000 each | 12; **20,000 words**, 500–4,000 each |
| Storylines / categories | 3 / 16; 60,000 / 16,000 body words | 2 / 6; 8,000 / 1,800 body words |
| TODOs / comments | 120 / 80; 30,000 / 40,000 body words | 12 / 8; 1,200 / 1,200 body words |
| Material folders | 12, including nested folders | 6, including nested folders |
| Image / PDF owners | 24 / 12, using shared source fixtures | 4 / 2 |
| Agent discussions | 24; **1,800 rounds**, 6–600 per discussion | 3; **24 rounds**, 4–12 per discussion |

The counts use Drifting's `@drifting/prose-metrics` contract: Han characters are
counted individually and Latin/digit tokens as words. Body budgets exclude
titles, summaries, aliases, KV attributes and duplicate storage/journal copies.
Length distributions are deterministic, include both documented endpoints and
sum exactly to their budgets. Markdown writes are remeasured after reconstructing
the persisted Yjs documents; `book_node.word_count` must match that content.
Material notes begin as rich-text JSON seeds with headings and checklists, as
ordinary fresh app notes do.

All names and prose are original synthetic fixtures. The
[scenario builder](../src/dev-cli/seeds/default-project.ts) uses the existing
journaled app/General Agent paths. The old tiny JSON seed is removed. Agent
history uses canonical runtime acceptance, event, tool-ledger and commit
repositories, with a verified final V4 checkpoint for each conversation. Large
replies and explicitly synthetic read-tool results exercise history rendering
and recovery. Seeding calls no model or external tool and records zero cost.
The developer CLI also retains its separate workspace audit conversation.

The [asset fixtures](../src/dev-cli/seeds/assets/README.md) are repository-owned
bytes with source/preview hashes. Stress creates six independent owners per
source; lite creates one. Originals remain shared while each profile has its
own native asset files and opaque sync objects. Metadata and owner bindings
commit together. These small attachments cover owner lists and preview paths;
they are not a large-PDF decoding benchmark.

Before launch the wrapper verifies that the selected profile's port is free,
then seeds only an empty library. Initial creation takes longer for stress;
progress is printed during the import. A completed seed is published from an
adjacent staging database. Failure preserves the original empty library and
can be retried. Later launches preserve edits and reuse the library. The v2
instance names avoid reusing the earlier short-prose `seed-large` library.
Explicit custom instances should be different for stress and lite:

```bash
pnpm dev:seed --instance perf-before --no-watch
pnpm dev:seed:lite --instance feature-smoke --no-watch
```

The manifest includes `seedPreset`, `seedRecipeVersion`, `databaseDirectory`
and `appLocalDataDirectory`. The latter resolves native asset storage, separately
from SQLite (on macOS, the generated identifier's Application Support folder).
`--print-config` creates no database, assets or window. The lower-level
`seed-main.ts --db <library.db> --preset stress|lite --app-local-data <directory>`
entry is for explicitly isolated libraries; never use a daily-use database.

See [seed workloads and performance/stability validation](development-seed-workloads.md)
for the required development workflow, measurements and acceptance boundaries.

## Machine-checkable contract

```bash
pnpm exec vitest run src/renderer/platform/worktree-dev-launcher.acceptance.test.ts
```

The contract checks independent checkout and instance identities, repeatable
paths, ignored conflicting environment settings, WebView separation, port
conflicts, real SQLite separation, generated Vite configuration, non-mutating
JSON inspection, launcher argument/environment delivery, linked-worktree
detection for `pnpm dev`, and the seeded launcher's order (port check, seed,
launch). `src/dev-cli/seed.integration.test.ts` seeds a real library and checks
the lite preset's exact word totals, graph integrity, every chapter/inspiration Yjs document,
source/preview/object hashes, completed/open and text-anchored review work,
canonical Agent transcript and checkpoint recovery after reopening,
once-only preservation of edits, and failed-seed retry. It uses disposable
synthetic fixtures; it does not open a daily-use library.

```bash
pnpm exec vitest run src/dev-cli/seeds/presets.test.ts src/dev-cli/seed.integration.test.ts
pnpm seed:acceptance                # generate both real SQLite/Yjs workloads and evidence
pnpm seed:acceptance --check        # validate source-matched generated evidence
```

The generated [preset evidence](dev-cli/acceptance/seed-presets.json) records exact
word totals/ranges and canonical Agent/asset counts. It proves corpus integrity;
it does not report UI latency, FPS, native memory or endurance performance.
