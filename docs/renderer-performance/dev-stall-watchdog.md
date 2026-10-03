# Development renderer stall watchdog

Debug desktop builds (`pnpm dev`, `pnpm dev:worktree`) log every renderer
main-thread stall longer than one second. Release builds compile neither side.

- The renderer ([dev-watchdog.ts](../../src/renderer/lib/dev-watchdog.ts))
  sends a heartbeat every 250 ms while the page is visible.
- A native thread ([dev_watchdog.rs](../../src-tauri/src/dev_watchdog.rs))
  reports silence beyond 1 s plus one interval. Detection is native because a
  blocked WebView cannot report itself and a hard freeze may never recover.
- When the renderer runs again, its next heartbeat adds the measured timer delay,
  the last input and labelled work that overlapped the stall.

The log sits beside the database directory and the launcher prints its path:
`src-tauri/.local-data/logs/renderer-stalls.log` for `pnpm dev`, or the profile's
`logs/` directory for a worktree instance. Each line is one JSON record and the
file rotates to `renderer-stalls.1.log` above 2 MB.

| `event` | Meaning |
| --- | --- |
| `session` | A page loaded; `active` is its visibility. |
| `visibility` | The page became visible or hidden. Hidden pages are not watched. |
| `stall` | No heartbeat after `at` (last heartbeat); `lastContext` is the state then. On macOS, `sample` names a 3-second native stack sample of the WebView content process (`webContentPid`). |
| `stall-ongoing` | Still silent at 5 s, 15 s, 60 s, then every 5 minutes. |
| `stall-recovered` | Heartbeats resumed. `blocked: "renderer"` means the renderer timer was late (`renderer.blockedMs`); `"ipc-or-native"` means the renderer ran but delivery was late. |
| `stall-unrecovered` | A navigation or new renderer session replaced a stalled page. |

Context contains the hash route, window focus, active editor document size
and IME composition state, the last input event and open labelled work. It
never contains prose. Label suspected long work with `beginDevActivity` from
[dev-activity.ts](../../src/renderer/lib/dev-activity.ts); it is a no-op in
production. Agent token diffs (`agent-diff`, with token counts), Markdown
projection refreshes (`markdown-projection`), and sync reducer rebuilds and
snapshot writes (`sync-reducer-rebuild`, `sync-reducer-snapshot`) are labelled.

On macOS the native side reads the content process ID through WebKit's
private `_webProcessIdentifier` and runs `/usr/bin/sample` when a stall opens.
Samples are kept in `logs/stall-samples/` (newest 20). JavaScript frames are
opaque there, but script execution, garbage collection, layout and blocking
waits are distinguishable.

A paused Web Inspector debugger also stops heartbeats and is logged as a stall.
Reloads are excluded through the native page-load hook.

## Verification

Rust and Vitest unit tests cover detection, follow-up reports, recovery
classification, visibility, reloads, rotation, timestamps and activity
attribution:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib dev_watchdog
pnpm exec vitest run src/renderer/lib/dev-watchdog.test.ts
```

On 2026-10-04 an isolated `pnpm dev:worktree --no-watch` instance's WebContent
process was suspended with `SIGSTOP` for 7 s while visible. The log recorded
`stall` after 1.3 s of silence, `stall-ongoing` at 5 s and `stall-recovered` with
`blocked: "renderer"` and a 6.9 s renderer timer delay. The author's intermittent
editor freeze itself has not been reproduced.
