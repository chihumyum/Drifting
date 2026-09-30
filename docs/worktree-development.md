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

The launcher forces local-only mode and overrides inherited `DRIFTING_DB_DIR`,
`CARGO_TARGET_DIR`, app flags and custom runners. It retains host toolchain and
macOS signing configuration, but drops inherited app credentials, Hosted
configuration and debug-bridge endpoints. Vite does not read checkout dotenv
files for this launch. Generated configs and `profile.json` remain in the
ignored profile directory; no existing database or credentials are copied.

Use only synthetic data in these profiles. A fresh profile starts without cloud
bindings. Google Drive is temporarily suspended in all App builds; this launcher
also disables Hosted, so its library stays local. It does not seed fixtures, grant MCP access or
claim UI acceptance. Configure test-owned MCP access from the isolated app if
needed. Existing acceptance collectors keep their own fixture workflows.

Keep one running launcher per profile. To get fresh state, choose a new
`--instance` name; there is deliberately no automatic reset/delete operation.
On macOS/Linux, stop the launcher with SIGINT or SIGTERM to stop its owned
process group. The ordinary `pnpm dev` and release build commands are unchanged.

## Machine-checkable contract

```bash
pnpm exec vitest run src/renderer/platform/worktree-dev-launcher.acceptance.test.ts
```

The contract checks independent checkout and instance identities, repeatable
paths, ignored conflicting environment settings, WebView separation, port
conflicts, real SQLite separation, generated Vite configuration, non-mutating
JSON inspection, and launcher argument/environment delivery. It uses disposable
synthetic fixtures; it does not open a daily-use library.
