# Drifting Core

The Tauri 2 client for Drifting, a local-first creative writing and story-planning application.

## Stack

- Tauri 2 and Rust for macOS, Windows, Linux, iOS, and Android
- React 19, TypeScript, and Vite
- SQLite through a dedicated Rust worker and Drizzle `sqlite-proxy`
- Yjs and Tiptap for live prose editing
- Zustand and TanStack Query for client state

The Rust SQLite boundary preserves BLOBs and signed 64-bit integers, embeds all Drizzle migrations,
and owns transaction isolation, WAL checkpointing, and database switching. Renderer code talks only
to typed Tauri platform contracts.

## Development

Prerequisites:

- Node.js 22.13 or newer and `pnpm`
- Rust 1.88 or newer, plus the platform prerequisites from the Tauri 2 documentation
- Xcode for iOS, or Android Studio/SDK for Android

```bash
pnpm install
pnpm --dir client dev
```

Development uses `.local-data/databases` through `DRIFTING_DB_DIR`. Production uses
the Tauri application-local data directory.

Useful commands:

```bash
pnpm --dir client typecheck
pnpm --dir client test
pnpm --dir client agent:capabilities:check
pnpm --dir client eval:agent:tool-reliability
pnpm --dir client eval:agent:durability
pnpm --dir client eval:agent:crud
pnpm --dir client eval:agent:long-task
pnpm --dir client eval:agent:working-memory
pnpm --dir client eval:agent:context
pnpm --dir client eval:agent:writing
pnpm --dir client eval:agent:p5
pnpm --dir client tauri:build
pnpm --dir client icons:mobile:check
pnpm mobile:ios:dev
pnpm --dir client tauri:ios:build
pnpm mobile:android:dev
pnpm --dir client tauri:android:build
```

The iOS and Android projects are already initialized under `src-tauri/gen/apple` and
`src-tauri/gen/android`. The `tauri:ios:init` and `tauri:android:init` scripts are only needed when
initializing a missing target, not for normal development.

### Mobile app icons

`src/assets/icon.icon` is the canonical Apple Icon Composer document. The iOS target compiles that
multilayer document directly, preserving its material, dark appearance specialization and
Xcode-generated compatibility renderings instead of selecting the legacy `AppIcon.appiconset` PNGs.

Android uses the same transparent iceberg outline as an adaptive foreground over a separate blue
gradient background. The foreground uses 90% of Android's central 66×66dp safe zone, and the same
outline supplies the monochrome layer for themed icons. After changing the Icon Composer artwork,
run `pnpm --dir client icons:mobile`, then
`pnpm --dir client icons:mobile:check`. The first command refreshes checked-in native icon
assets; the second verifies the iOS project wiring, Android layers, safe-zone bounds and density
matrix. A native rebuild/install is still required before judging the launcher result.

The two root-level mobile development commands select a connected device or prompt for a simulator,
build and install the native dev app, start it, and keep Vite hot reload attached. They default to the
local backend at the Mac's detected LAN IPv4 address on port 3000 and fail early when it is not
reachable. Device setup, explicit target selection, API overrides, inspection, and the manual checklist are documented in
[`docs/mobile-device-acceptance.md`](docs/mobile-device-acceptance.md).

`tauri:build` injects the public production API origin explicitly. Renderer builds do not load
ignored `.env*` files and fail if a `VITE_*API_KEY`, `VITE_*SECRET`, or `VITE_*TOKEN` variable would
be embedded. BYOK credentials belong in the native credential store, never in a distributable
bundle. The current pre-alpha artifacts set `VITE_CLOSED_BETA=false` so invited testers can create
accounts; change that explicit build flag when registration should be closed again.

The deterministic local demo seeder remains available without Electron or a
native Node addon:

```bash
pnpm --dir client demo:seed
pnpm --dir client demo:purge-local
```

## Layout

```text

├── src-tauri/          Rust host, SQLite gateway, native capabilities, mobile projects
├── src/renderer/       React application and platform contracts
├── drizzle/            Embedded, ordered SQLite migrations
├── scripts/            Development and asset-generation utilities
└── vite.renderer.config.ts
```

The workspace surface hierarchy, footer ownership, static-tab behavior, and radius boundaries are
defined in [`docs/design-system.md`](docs/design-system.md). The visual system keeps the existing
palette while treating the app as one coplanar desktop with only the manuscript page raised. The
mobile starting point and its explicit product gaps are tracked in
[`docs/mobile-ui-foundation.md`](docs/mobile-ui-foundation.md).

## Data migration

On the first desktop Tauri launch, Drifting looks for the former desktop client's `Drifting`
application-data directory. SQLite files are copied with the SQLite online-backup API so WAL data
is included; copied databases must pass `integrity_check` before activation. The asset cache is
copied atomically, the source remains untouched, and a migration marker makes retries idempotent.
If the Tauri database directory already contains a valid database with the same filename, migration
preserves that Tauri file and does not merge or overwrite it with the Electron database. The legacy
source remains untouched, but users of an earlier internal Tauri build should back up and resolve
the two copies before first launch if the Tauri copy is not the one they intend to keep using.

The production database directories are normally:

- macOS: `~/Library/Application Support/cc.drifting.client/databases/`
- Windows: `%LOCALAPPDATA%\cc.drifting.client\databases\`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/cc.drifting.client/databases/`
- iOS/Android: the application container

## Mobile status

Desktop and mobile share the same React application and typed Tauri platform contracts. The current
native layer provides the Rust SQLite gateway, app-container file/material handling, asset caching
and transfer, lifecycle flush events, external-browser OAuth with queued deep links, and
OS-backed credential storage. Apple targets use Keychain through `keyring`; Android uses the
private Keystore-backed `drifting-secure-storage` plugin with no plaintext fallback.

The shell already handles safe areas, dynamic viewport height, responsive entry pages, and overlay
sidebars. A shared touch-target scale and mobile navigation model are still missing. This is a
portability baseline, not a claim of finished mobile-native UX. Story graph,
split editor, plot grid, soft-keyboard behavior, and dense touch interactions still require
device-specific product passes. Native desktop, iOS, and Android smoke results must remain explicit;
the checked-in Agent acceptance reports currently mark those manual smokes as not run.

OAuth currently returns through the custom `drifting://` scheme. PKCE and the one-time server
handoff protect token exchange, but public mobile distribution should replace the unverified scheme
with iOS Universal Links and Android App Links.

## Material file limit

Image and PDF imports currently have a 64 MiB hard limit on every target. The native picker checks
the selected file's metadata before creating an app-owned copy when the platform exposes a reliable
size, and the copy itself remains bounded for Android content providers whose size is unknown.
This matches the bounded in-memory inspection/thumbnail pipeline, so an accepted file can complete
material creation. Future large-file support should stream the source upload and allow thumbnail
degradation; it must not raise the mobile whole-file memory limit.

## Current boundary

Drifting uses one General Agent product with independent concurrent
conversations inside the currently mounted project. The provider-neutral local
runtime runs on every Tauri target, resolves the selected DeepSeek, Anthropic,
or OpenAI BYOK credential from native secure storage, and executes domain tools
through renderer-owned use cases.

Live Yjs is the prose authority. SQLite owns durable Agent history, effects,
plans, permissions, receipts, and ordered per-block review decisions.
localStorage and renderer stores are rebuildable presentation only. Long tasks
freeze a chapter manifest, persist progress and constraints across slices and
restart, stop at durable tool boundaries, and require explicit author action to
resume after restart.

Every project also owns one rolling `WORKING_MEMORY.md` shared by all of its
General Agent conversations. The current revision is injected at turn start;
before the final response the Agent must either checkpoint a high-signal update
or explicitly record a no-op. The document is author-readable, editable and
clearable in the desktop Agent panel. SQLite revision CAS prevents silent local
overwrites, sync uses the ordinary atomic outbox boundary, and deterministic
compaction retires the oldest completed entries after the soft token budget.
This short-lived context is separate from manuscript truth, project history and
long-term Agent rules.

The model-facing surface is domain-native: chapters, inspirations, elements,
categories, storylines, memberships, relations, comments/TODOs, project facts,
author rules, memory, and element patches use explicit generated tools. Exact
tool names, counts, provider models, context limits, MCP support, and deferred
capabilities come only from the generated
[`agent-capabilities.md`](docs/agent-runtime/acceptance/agent-capabilities.md).
Standalone Shadow CI, Element Arc, and Goal Evolve are retired.

Desktop and mobile use separate shells over the same project runtime and domain
core. Mobile compilation and automated workload-equivalent endurance gates do
not replace physical-device touch, IME, safe-area, background, or visual
acceptance.

Documentation entry points:

- [documentation index](docs/README.md)
- [current Agent status](docs/agent-runtime/acceptance/CURRENT_STATUS.md)
- [Agent roadmap and open work](docs/agent-runtime/ROADMAP.md)
- [renderer UI architecture](docs/renderer-ui-architecture.md)
- [mobile device acceptance](docs/mobile-device-acceptance.md)
- [explicit Tauri limitations](src-tauri/UNSUPPORTED.md)

## License

MIT
