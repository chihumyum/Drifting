# Drifting

Drifting is a local-first creative writing and story-planning application built with Tauri 2,
Rust, React, SQLite, Yjs, and Tiptap.

This repository contains the Drifting client. The official hosted service and its private server
implementation are not included. A normal source build starts in local-only mode: no account or
server is required, sync is disabled, and BYOK AI requests use direct provider transport. Account,
cloud sync, billing, and proxy-backed AI require a separately operated compatible service.

This history was extracted and rewritten from the original private monorepo. Server-only changes,
credentials, private literary material, generated artifacts, personal email addresses, and layout
transitions were removed or normalized, so commit hashes differ from the private source history.

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

- Node.js 22.23.1 or newer and `pnpm` 10.17.1
- Rust 1.88 or newer, plus the platform prerequisites from the Tauri 2 documentation
- Xcode for iOS, or Android Studio/SDK for Android

```bash
pnpm install
pnpm dev
```

Development uses `.local-data/databases` through `DRIFTING_DB_DIR`. Production uses
the Tauri application-local data directory.

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm agent:capabilities:check
pnpm eval:agent:tool-reliability
pnpm eval:agent:durability
pnpm eval:agent:crud
pnpm eval:agent:long-task
pnpm eval:agent:working-memory
pnpm eval:agent:context
pnpm eval:agent:writing
pnpm eval:agent:p5
pnpm tauri:build
pnpm icons:mobile:check
pnpm mobile:ios:dev
pnpm tauri:ios:build
pnpm mobile:android:dev
pnpm tauri:android:build
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
run `pnpm icons:mobile`, then
`pnpm icons:mobile:check`. The first command refreshes checked-in native icon
assets; the second verifies the iOS project wiring, Android layers, safe-zone bounds and density
matrix. A native rebuild/install is still required before judging the launcher result.

The two root-level mobile development commands select a connected device or prompt for a simulator,
build and install the native dev app, start it, and keep Vite hot reload attached. They default to
local-only mode. An operator can explicitly enable a compatible service and provide its reachable
API origin. Device setup, target selection, service overrides, inspection, and the manual checklist are documented in
[`docs/mobile-device-acceptance.md`](docs/mobile-device-acceptance.md).

The default `tauri:build` is local-only. Operators can explicitly provide a compatible API origin
and enable network features; source builds do not receive automatic access to the official hosted
service. Renderer builds do not load
ignored `.env*` files and fail if a `VITE_*API_KEY`, `VITE_*SECRET`, or `VITE_*TOKEN` variable would
be embedded. BYOK credentials belong in the native credential store, never in a distributable
bundle.

The deterministic local demo seeder remains available without Electron or a
native Node addon:

```bash
pnpm demo:seed
pnpm demo:purge-local
```

## Layout

```text

├── src-tauri/          Rust host, SQLite gateway, native capabilities, mobile projects
├── src/renderer/       React application and platform contracts
├── drizzle/            Embedded, ordered SQLite migrations
├── packages/           Separately licensed shared packages
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
categories, storylines, memberships, first-class relation types and relations, comments/TODOs, project facts,
author rules, memory, and element patches use explicit generated tools. Exact
tool names, counts, provider models, context limits, MCP support, and deferred
capabilities come only from the generated
[`agent-capabilities.md`](docs/agent-runtime/acceptance/agent-capabilities.md).
Standalone Shadow CI, Element Arc, and Goal Evolve are retired.
The replacement direction is a frozen, not-yet-implemented Ambient Editor
design: [product boundary and document index](docs/ambient-editor/README.md).

Project relation labels are first-class synced definitions with direction,
endpoint roles, and allowed entity kinds. Existing free-text labels migrate to
visible `unconfigured` definitions without flipping or deleting edges; authors
configure them before creating new typed relations. The data, sync, Agent, and
desktop interaction boundary is documented in
[relation types](docs/relation-types.md).

Desktop and mobile use separate shells over the same project runtime and domain
core. Mobile compilation and automated workload-equivalent endurance gates do
not replace physical-device touch, IME, safe-area, background, or visual
acceptance.

Documentation entry points:

- [documentation index](docs/README.md)
- [developer CLI](docs/dev-cli/README.md)
- [current Agent status](docs/agent-runtime/acceptance/CURRENT_STATUS.md)
- [Agent roadmap and open work](docs/agent-runtime/ROADMAP.md)
- [Shadow Ambient Editor target design](docs/ambient-editor/README.md)
- [renderer UI architecture](docs/renderer-ui-architecture.md)
- [mobile device acceptance](docs/mobile-device-acceptance.md)
- [explicit Tauri limitations](src-tauri/UNSUPPORTED.md)

## Licensing and project policy

Except where a file or directory says otherwise, the Drifting client is licensed under
[GNU AGPL v3 or later](LICENSE). `packages/prose-metrics` is separately licensed under
[Apache License 2.0](packages/prose-metrics/LICENSE) so independently operated services can consume
the metrics contract without importing the AGPL client.

- [Contributing and CLA](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Privacy boundaries](PRIVACY.md)
- [Hosted-service boundary](docs/official-service.md)
- [Trademark policy](TRADEMARKS.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The source license does not grant permission to present a fork as the official Drifting product.
Forks that distribute binaries should replace the name, logos, bundle identifier, deep-link scheme,
and official service endpoints unless they have written trademark permission.

This repository is ready for source review, not an automatic binary-release
approval. Before distributing a desktop or mobile binary, bundle the applicable
license and third-party notices offline, link Corresponding Source to the exact
release tag or commit, configure real operator terms/privacy URLs, and complete
platform-specific license review. In particular, App Store or TestFlight
distribution under pure AGPL requires separate legal review because platform
terms may add restrictions that AGPL does not permit.
