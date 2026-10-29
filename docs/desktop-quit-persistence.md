# Desktop quit persistence barrier

Before the desktop app exits, the renderer runs its local lifecycle flush:

- save the active editor
- drain Yjs, asset and authored-transaction queues
- checkpoint SQLite
- capture any Markdown projection change not yet published

Native code asks for this flush and waits for the renderer's confirmation, at
most `CLOSE_FLUSH_TIMEOUT` (5 s), then exits. See `request_flushed_shutdown`
in `src-tauri/src/lib.rs`.

## macOS Quit (2026-10-29)

These all end in `-[NSApplication terminate:]`:

- Cmd+Q
- the application menu's Quit item
- the Dock's Quit item
- AppleScript `quit`
- logout and shutdown

tao's application delegate does not implement `applicationShouldTerminate:`.
AppKit therefore terminated the process at once: Tauri never emitted
`ExitRequested`, and the flush above never ran. Measured on the heavy seed:
the process was gone 0.3 s after Quit, and the projection did not include text
the author had just written.

`src-tauri/src/macos_quit.rs` adds `applicationShouldTerminate:` to tao's
delegate class at startup, then assigns the delegate again so AppKit notices
the new method. The method cancels that termination and starts the same
flushed shutdown as `ExitRequested(code=None)`. The flush ends with
`AppHandle::exit(0)`, which stops the run loop without asking the delegate
again.

Measured on the heavy seed, quitting 0.5 s after an edit:

- The process exited 2.99 s after Quit, once the renderer confirmed. The flush
  included a cold sync-reducer load and one projection capture.
- The edit was in SQLite and in the published projection.
- With nothing pending, Quit still exits in about 0.3 s.

### Limits

- **Logout and shutdown**: returning "cancel" also cancels a logout or shutdown
  in progress. The app then quits by itself once its flush completes, and the
  user repeats the logout.
- **Slow flushes**: a flush longer than 5 s is cut off by the native deadline.
  The projection's pending manifest lets the next refresh repair a partially
  published projection.

### Verifying

Use the application menu's Quit item, or Cmd+Q. `app.exit(0)` and a SIGTERM
bypass the barrier.

External `sqlite3` readers do not see the app's uncheckpointed WAL. Copy the
database together with its `-wal` file, then open the copy.
