# Native startup failure diagnostics

The startup collector now writes a separate `*.failed.json` when the renderer
reports a failed attempt. Its kind is `renderer_native_startup_failure`, its
status is `failed`, and both the measurement and normal-shutdown gates remain
unaccepted. No partial series contributes a percentile or a passing startup
report. Build/source hashes, the synthetic fixture specification and the number
of fully completed earlier samples are retained.

```sh
node scripts/run-renderer-startup.mjs --report=docs/renderer-performance/acceptance/f0-startup-focus.json --check-failure --historical
node scripts/run-renderer-startup.mjs --report=docs/renderer-performance/acceptance/f0-startup-editor-focus.json --check-failure --historical
```

These commands validate the historical diagnostics without asserting the current
source fingerprint. Omit `--historical` to require an exact current-source match.
Neither mode accepts a performance budget. The regular `--check` still requires a
complete six-process passing report. Build failures, missing reports and other
collector failures continue to fail the process; only an actual renderer
failure payload produces this companion record.

## What is observed

The acceptance-only renderer records up to 32 focus, blur and visibility events,
with timestamps, `document.hasFocus()`, visibility and the active element's tag.
On failure it captures the current document state, then queries the native
window's focused/visible flags. These IPC reads occur after the document
snapshot; they are not an atomic cross-layer observation, and the event trace
can continue while IPC is pending. Query errors remain explicit errors.
No editor text, input values, selection contents or identifiers enter the trace.

The isolated native build adds only `core:window:allow-is-focused` and
`core:window:allow-is-visible` to its copied desktop capability file. The
production capability file and product startup behavior are unchanged. The
collector does not activate, raise or refocus a failed window to make it pass.

## Captured results on M3 Pro / 36 GiB

| Record | Observed outcome |
| --- | --- |
| `acceptance/f0-startup-editor-focus.failed.json` | One complete startup/editor/normal-exit sample was accepted internally before attempt 2 failed. At 1,296 ms after the renderer time origin, the document and native window both reported unfocused while visible. The document had previously gained focus, then lost it. No passing six-sample report was generated. |
| `acceptance/f0-startup-focus.failed.json` | Attempt 1 failed at the shelf boundary, 579 ms after the renderer time origin. The document and native window both reported unfocused while visible. No focus transition was observed and no sample completed. This attempt was observed through the already-running process output, without launching separate polling commands during measurement. |

Both records bind to the same source/collector fingerprint but different newly
built, unsigned Release artifacts. They confirm native-window focus failures;
they do not identify which process or OS event caused them. The operator later
confirmed interacting with or switching application windows during this period.
External interaction therefore cannot be excluded; these captures do not
establish an intrinsic product defect. No JavaScript
runtime error was recorded by the probe in either attempt. They do not prove
that the shelf aggregate, editor ownership or another application caused the
loss of focus.

An initial hypothesis added `set_focus()` after the product's first
`window.show()`; a fresh build still failed and that product change was reverted.
A separate diagnostic relaunch reached the long editor with the application
active, but lacked the collector connection and was not a timing or full
acceptance run. No product focus fix is claimed.

The existing accepted `f0-native-startup.json` remains historical and unchanged.
The shelf-statistics change retains its SQLite evidence. Repeated native startup,
fixed M1/8 GB budgets, physical input, signed RC and the device matrix remain
open. These failures must be resolved or measured again under verified suitable
conditions before making startup improvement or regression claims.

## Current execution boundary

On 2026-09-14 the operator requested that autonomous optimization use only
headless checks, without occupying application windows. Native startup/focus
measurement is therefore suspended for this task. The proposed interactive
launch gate was removed before delivery. Continue with unit and integration
tests, isolated SQLite/Yjs recovery checks, headless browser acceptance and
production builds. Do not relabel those checks as native window, physical input
or fixed-device acceptance, and do not require a quiet desktop interval to
continue architecture work.
