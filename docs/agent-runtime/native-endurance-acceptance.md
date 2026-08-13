# Native and endurance acceptance

This is the Milestone J evidence contract. It separates build/runtime evidence
from human visual judgment instead of treating a successful bundle as proof
that every touch interaction looks correct.

## Native build gate

The release-like renderer is compiled into both mobile products, including the
Rust database/Yjs/Agent/MCP HTTP host:

```bash
VITE_API_BASE_URL=https://api.drifting.cc VITE_REQUIRE_AUTH=true \
VITE_AI_TRANSPORT=proxy VITE_CLOSED_BETA=false API_BASE_URL=https://api.drifting.cc \
APPLE_DEVELOPMENT_TEAM=<team> pnpm tauri ios build \
  --debug --target aarch64-sim --no-sign --archive-only --ci

VITE_API_BASE_URL=https://api.drifting.cc VITE_REQUIRE_AUTH=true \
VITE_AI_TRANSPORT=proxy VITE_CLOSED_BETA=false API_BASE_URL=https://api.drifting.cc \
pnpm tauri android build --debug --target aarch64 --apk --ci

pnpm eval:agent:native:verify
```

Verification hashes the iOS arm64 executable and Android APK, checks bundle id,
Mach-O architecture, packaged arm64 Rust library and Tauri configuration. It
does not launch a device, click controls or claim visual/touch acceptance; that
remains user-owned manual evidence under the repository working agreement.

## Endurance gate

One logical epoch represents 15 minutes of sustained author work. Every epoch
starts a fresh process and exercises the deterministic synthetic manuscript
oracle, checkpoint corruption/lost-ack recovery, automatic continuation,
Stop/Steer/stagnation, MCP HTTP session/timeout/cancel and durable grant
reopen/config/concurrency. No generated prose enters the report.

```bash
pnpm eval:agent:endurance:4h   # 16 epochs
pnpm eval:agent:endurance:12h  # 48 epochs
```

The default is accelerated workload-equivalent time: it proves operation and
restart volume without pretending wall-clock sleep adds semantic coverage. Add
`--wall-clock` to the underlying script when investigating timer, thermal or
OS-background behavior. The atomic `.checkpoint` file makes either mode
resumable and is invalidated when its hashed test/source set changes.

Each report records per-epoch result, duration and child maximum resident set.
No monotonic memory-growth verdict is inferred from one sample; the full series
is retained for inspection.

## Fault and authority boundary

- Provider/MCP network calls in deterministic gates use local fixtures/sockets.
- SQLite/Yjs recovery tests prefer concurrent author edits over Agent inverse or
  restore.
- Every epoch is a process-restart boundary; stale provider context, dynamic
  tool generation and permission authority must rebuild from durable state.
- Mobile stdio remains unsupported; mobile MCP uses the compiled native HTTP
  host.
- Physical device background suspension, keyboard/touch behavior, visual
  animation and live provider account availability are explicitly outside this
  automated report.
