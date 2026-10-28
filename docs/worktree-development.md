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

```bash
pnpm dev:seed                      # instance "seed"
pnpm dev:seed --instance demo --no-watch
```

`pnpm dev:seed` takes the same options as `pnpm dev:worktree` (local-only; no
`--online`) and defaults to its own instance, `seed`. Before launching it checks
that the profile is not running, then seeds the profile's library
(`databases/drifting-library.db`) if it has no project yet: one project as the
app creates it (default facts and the built-in relation type), then the
[default seed scenario](../src/dev-cli/seeds/default-project.json) — storylines,
chapters with prose, inspirations, element categories and elements, relation
types and relations, comments and TODOs, project facts and Project Memory —
and a few material notes in nested folders. Every write is a journaled authored
change set through the same paths as the app and the General Agent tools
(`src/dev-cli/seed.ts`), so the seeded library behaves like one built by hand.
Later launches reuse it; choose a new `--instance` for a fresh copy. Images and
PDFs are not seeded (their import runs through the native asset pipeline). The
seed's tool calls leave one "Developer CLI workspace" Agent conversation, as any
`pnpm drifting workspace call` does.

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
its entities, journal and once-only behaviour. It uses disposable
synthetic fixtures; it does not open a daily-use library.
