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

General Agent is available through the provider-neutral local runtime installed by the renderer on
every Tauri target. A turn freezes a certified DeepSeek, Anthropic, or OpenAI provider/model pair
and reads that provider's BYOK credential lazily from native secure storage. It executes tools
through renderer repositories/use cases and routes prose writes through the live Yjs document. It
does not require the removed desktop Node/Claude CLI, a sidecar, or a remote runner.

Settings has one credential authority: **Models & API** owns the global `byok.<provider>` Keychain
entries. Copilot keeps its own provider/model route; General Agent chooses its provider/model in
the chat composer. See [`docs/ai-provider-settings.md`](docs/ai-provider-settings.md).

The standalone Shadow CI, Element Arc, and Goal Evolve products were retired on 2026-08-05.
General Agent remains the single agent surface: its durable long-task plan supports explicit review
work without reintroducing a second runtime, rule pipeline, or chapter-status state machine.
“Single” here means one product/runtime, not one conversation. The App imposes no numeric limit on
active conversations in the currently mounted project. Controls, activity and rejection feedback
are routed by session/turn; reads may overlap, while writes pass through the shared reader/writer
barrier and entity revision checks.

The same turn boundary freezes model-aware thinking and reasoning effort. OpenAI offers the
GPT-5.6 Sol/Terra/Luna family through the Responses API; DeepSeek and Anthropic retain their native
thinking state only across the active tool loop. Unsupported model/provider combinations are
disabled in Settings and normalized again at hydration and request boundaries.

The transport seam still supports future `sidecar` or `remote` implementations, but those are
extension points rather than prerequisites for the current product path. The current General Agent
runtime freezes the canonical chapter manifest for whole-book tasks, persists plans, steps,
constraints, and per-step review evidence across budget slices and restarts. Edit steps require an
accepted target-matching Yjs prose write; read-only QA steps require a verified exact-target read
plus fully cited structured review result. Verified context
compaction keeps canonical history while pinning current progress and active constraints. Durable
active-plan hints keep plan, chapter-read, and prose-edit tools available even for a generic
“continue” request. The Agent Panel streams from the canonical journal and offers an explicit
same-session continuation while a plan is active or after a budget boundary. Each visible author
message records its send time, and every terminal Agent turn records its wall-clock work duration;
canonical recovery restores both after a restart.

The model-facing virtual workspace remains an internal navigation abstraction. The panel renders
those calls as novel-domain activity (for example, reading a chapter or inspecting an element),
not host filesystem operations. Certified prose edits land directly in the live editor: automatic
mode plays the colored reveal, while review mode keeps the inline diff and accept/reject badge.
Only destructive structural operations use the chat permission card before execution.
Inline prose review is durable per block: SQLite is the decision authority, Yjs remains the prose
authority, and localStorage is only a rebuildable UI projection. A project reopen reconstructs
pending diffs, partial accept/reject choices, and interrupted guarded inverses from the write
ledger. Turn context commits are independently idempotent, so a lost SQLite success response does
not duplicate history or misreport an already-committed manuscript write.
The six workspace verbs also close the first-class domain lifecycle without making the model
reason about persistence internals. Nodes, elements, categories, storylines, comments/TODOs,
relations, storyline membership, project facts, and Agent memory have generated create/read/
update/delete/revert contracts. SQLite mutations, immutable receipts, and sync outbox rows commit
atomically; prose remains Yjs-authoritative; destructive graph/resource changes require an exact
argument-bound permission. Run `pnpm --dir client eval:agent:crud` for the real file-backed
SQLite/Yjs fault and restart matrix.
Long tasks additionally detect chapter creation, removal, rename, and reorder
against their frozen whole-book manifest. The Agent must explicitly reconcile
that drift before completion: added chapters become pending work, removed
unfinished chapters remain retired audit history, and a restored identity
reopens cleanly. Stop waits for the current tool's durable boundary; Steer is
applied once at the next model iteration; active plans remain manually
resumable after completion, failure, abort, or budget boundaries. Automatic
continuation has no aggregate work quota, but pauses after two automatic slices
without durable progress and never reauthorizes itself after App restart.
Product-generated continuation prompts remain in model context without
appearing as author chat messages. Run
`pnpm --dir client eval:agent:long-task` for the real SQLite migration,
fault/reopen, product Yjs/context, control, and continuation matrix; the
normative protocol is
[`long-task-execution-protocol.md`](docs/agent-runtime/long-task-execution-protocol.md).
Long-book context is provider-aware rather than a model-name guess. The default
driver declares a 200k window and 8,192-token response ceiling; a smaller
provider declaration is never enlarged and an undeclared custom driver falls
back to 32k. Author goals, vetoes, explicit facts, task state and accepted write
evidence are hash-bound and pinned across compaction. Structured literary
summaries require exact source citations, while unresolved contradictory facts
or instructions block all writes until a durable `ask_user` answer confirms the
exact conflict IDs. Project/prose search ranks mixed CJK/Latin evidence with
revision freshness, and oversized results page from hash-verified SQLite
artifacts across restart. Run `pnpm --dir client eval:agent:context` for
the real-novel, 200k multi-slice, compaction/restart/fault matrix; the normative
contract is
[`context-engineering-protocol.md`](docs/agent-runtime/context-engineering-protocol.md).
Agent conversations are independent flat sessions. A conversation has at most one active turn,
but the App imposes no admission cap on how many conversations in the mounted project may run
concurrently. Each Agent-authored Yjs transaction records its session/turn/call collaborator
identity, and every durable Yjs revision records an explicit `agent`, `user`, `remote`, `system`,
or `legacy` source independently of the compactable update log. A stale Agent is told whether the
winner was this same turn, another Agent conversation, the author, mixed sources, or an
external/unknown source; missing provenance is never guessed to mean a user edit. Yjs merges valid CRDT operations;
the durable revision CAS still rejects a semantically stale whole-object write. After two such
conflicts on the same target in one turn, that target is blocked for the rest of the turn so two
Agents cannot reread and overwrite each other forever. Switching projects stops turns owned by the
previous mounted project; restart restores durable plans for manual resume rather than replaying
active provider turns. There is no author-visible Agent checkpoint, manuscript rewind, or
conversation-fork hierarchy. Manuscript recovery belongs to the independent entity snapshot
history, while internal runtime checkpoints remain an implementation detail for durable context
and crash recovery. See
[`CONCURRENT_AGENT_SESSIONS_ACCEPTANCE_2026-08-05.md`](docs/agent-runtime/acceptance/CONCURRENT_AGENT_SESSIONS_ACCEPTANCE_2026-08-05.md).

Writing policy is author-owned. Drifting does not inject editor focus or
selection, resolve “这里/这段” into a hidden target, impose a content-scope or
canon-patch gate, or add default style/POV/voice rules. The current author
request, editable project facts, and author-created or approved Agent memory are
the writing guidance. Project isolation, live Yjs writes, revision checks,
durable review, and destructive-operation approval remain data-safety
boundaries. Run
`pnpm --dir client eval:agent:writing` for the local `雾港纪事` read-only
corpus, unrestricted-target regression, rule-lifecycle checks and machine
report; the normative contract is
[`author-owned-writing-policy.md`](docs/agent-runtime/author-owned-writing-policy.md).
An optional paid DeepSeek writing canary is available through
`pnpm --dir client eval:agent:writing:live`.
Installed tool definitions are frozen for the turn, execution is revision-bound,
streamed arguments are validated only after complete assembly, and recoverable
empty/malformed or search-omitted calls receive one schema-visible repair iteration.

This is still not full Claude Code parity. The generated
[`agent-capabilities.md`](docs/agent-runtime/acceptance/agent-capabilities.md) is the authoritative
inventory for installed model tools, direct catalog certification, authored-object operations,
provider/MCP platform and deferred product capabilities. Runtime-discovered MCP tools use
project-scoped configuration, strict discovery/schema validation, exact durable grants and
generation-isolated lifecycle ownership. Desktop stdio runs in a bounded native child host;
Streamable HTTP uses a cancellable native request host on desktop/iOS/Android rather than WebView
fetch. The settings surface owns health, reconnect, enable/disable, secrets and grant revocation.
Run `pnpm --dir client eval:agent:extensions`; see the normative
[`provider-extension-protocol.md`](docs/agent-runtime/provider-extension-protocol.md) and the
[`current status`](docs/agent-runtime/acceptance/CURRENT_STATUS.md) and
[`roadmap`](docs/agent-runtime/ROADMAP.md) for the current acceptance boundary and execution order.

Native mobile compilation and long-running restart/fault volume are also
machine-gated. iOS arm64 Simulator and Android arm64 debug artifacts are built
and hash-verified; resumable 4h/12h workload-equivalent soaks run fresh-process
15-minute epochs against the local manuscript oracle and durable fault matrix.
See [`native-endurance-acceptance.md`](docs/agent-runtime/native-endurance-acceptance.md).
This evidence does not pretend that a bundle compile proves physical-device
touch, keyboard, background suspension or visual quality.

See [`src-tauri/UNSUPPORTED.md`](src-tauri/UNSUPPORTED.md) for the explicit platform limitations.

## License

MIT
