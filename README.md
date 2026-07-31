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
pnpm --dir client eval:agent:p5
pnpm --dir client tauri:build
pnpm --dir client tauri:ios:init
pnpm --dir client tauri:ios:build
pnpm --dir client tauri:android:init
pnpm --dir client tauri:android:build
```

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

## Material file limit

Image and PDF imports currently have a 64 MiB hard limit on every target. The native picker checks
the selected file's metadata before creating an app-owned copy when the platform exposes a reliable
size, and the copy itself remains bounded for Android content providers whose size is unknown.
This matches the bounded in-memory inspection/thumbnail pipeline, so an accepted file can complete
material creation. Future large-file support should stream the source upload and allow thumbnail
degradation; it must not raise the mobile whole-file memory limit.

## Current boundary

General Agent is available through the provider-neutral local runtime installed by the renderer on
every Tauri target. It currently uses the user's DeepSeek BYOK credential from native secure
storage, executes tools through renderer repositories/use cases, and routes prose writes through
the live Yjs document. It does not require the removed desktop Node/Claude CLI, a sidecar, or a
remote runner.

The transport seam still supports future `sidecar` or `remote` implementations, but those are
extension points rather than prerequisites for the current product path. The current single-Agent
slice freezes the canonical chapter manifest for whole-book tasks, persists plans, steps,
constraints, and per-step review evidence across budget slices and restarts, and requires an
accepted target-matching Yjs prose write before a chapter step can complete. Verified context
compaction keeps canonical history while pinning current progress and active constraints. Durable
active-plan hints keep plan, chapter-read, and prose-edit tools available even for a generic
“continue” request. The Agent Panel streams from the canonical journal and offers an explicit
same-session continuation while a plan is active or after a budget boundary.

This is still not full Claude Code parity: 14 of 34 write tools are certified; the other 20 are
unavailable. Runtime-discovered MCP/plugin tools now have a project-scoped registry, strict schema
validation, central permission policy, and a transport-neutral MCP discovery bridge, but no
concrete stdio/Streamable HTTP connection or configuration UI is shipped. Multi-provider Agent
conformance, subagents, persistent `session`/`project` permission grants, unattended long-task
auto-looping, and native UI smoke remain deferred or unverified. See
[`docs/agent-runtime/acceptance/P5_PROGRESS_REPORT.md`](docs/agent-runtime/acceptance/P5_PROGRESS_REPORT.md)
for the exact acceptance boundary.

See [`src-tauri/UNSUPPORTED.md`](src-tauri/UNSUPPORTED.md) for the explicit platform limitations.

## License

MIT
