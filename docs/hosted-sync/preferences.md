# Account preferences

With a Hosted account connected, the settings that belong to the author follow
them to every Mac signed in to that account. Settings that depend on the machine
stay on it. The service side is the private service's account preferences v1
contract: one bounded bag per account, merged per key by change time.

## What follows the account

| Synced (`src/renderer/features/preference-sync/preference-fields.ts`) | Stays on the device |
| --- | --- |
| Theme, accent colour, Agent edit reveal | Prose font (installed and imported fonts differ per Mac) |
| Font size, line height, first-line indent, Tab indent, paragraph spacing, paper width | Interface text size |
| Immersive writing as you type, typewriter mode and its line position, caret colour | Line wrapping |
| Entity Link colour source, highlight, band style and per-kind colours | Agent provider, model, reasoning (bound to this Mac's keys) |
| Automatic element links | Destructive-operation switch, Agent first-run state, last conversation |
| Interface language | Crash-report consent |
| Agent per-turn iteration limit | Markdown folder location |
| Keyboard shortcuts (`shortcutBindings`) | API keys and the ChatGPT sign-in (system keychain, never synced) |

Settings descriptions that previously said a synced value was "saved on this
device only" no longer say so; device-bound settings keep saying it.

## Merge

Each device records, per synced key, when it last changed the value and whether
the account has accepted that change (`preference-sync-v1` in WebView storage).
It records changes while signed out too, so the first exchange after signing in
can tell which side changed last. Applying a value from the account is not
recorded as a local change.

One exchange (`preference-sync-core.ts`) reads the account's bag, sends the keys
changed here later than the account's copy plus keys the account does not hold
yet (a value never changed here is sent with the 1970 epoch, so it only fills a
gap), then adopts every key where the account holds the later change. The
service keeps per key the write with the latest time and clamps a time from a
clock running ahead to its own, so writes from several devices converge in any
order and a fast clock cannot win forever. A change made while an exchange is
in flight is kept for the next one. A value this version does not understand
(for example a theme added later) is left alone and not sent back.

Consequences:

- A new Mac takes the account's settings; its untouched defaults do not override them.
- A change made on a Mac before signing in wins only if it is later than the account's.
- After switching accounts, the new account's settings apply; changes recorded
  under the previous account are not carried over.
- Signing out or disconnecting keeps the current values; nothing more is exchanged.

## When it runs

The runtime (`preference-sync-runtime.ts`) is loaded only in Hosted-configured
builds. It exchanges while a verified session exists and the library's sync
authority is Hosted and not paused or transitioning: at start, on sign-in, when
the authority snapshot becomes syncable (the `sync:authority-changed` event
fires before the snapshot is re-read, so the runtime follows the snapshot),
coming online, on focus or resume (at most every 30
seconds), every five minutes, and one second after the last local change, so a
dragged slider is sent once. Failures retry with the shared single-flight
supervisor's backoff and never notify the author. A service without the route
(HTTP 404) is treated as unsupported for an hour: settings simply stay local.

## Evidence

`preference-sync-core.test.ts` drives several devices through a service with
the real merge rule: propagation, concurrent offline changes, a new device,
changes before sign-in, account switching, unknown values, a clock running
ahead, in-flight changes and idle exchanges. `preference-sync-runtime.test.ts`
covers the store wiring: the synced key set, one send after edits settle,
remote values not counted as local changes, pausing and an older service.
`preference-fields.test.ts` covers validation and the device-bound exclusions.
`preference-sync.hosted.integration.test.ts` runs two devices of one account and
a second account against the local disposable service; it is part of
`pnpm hosted:acceptance`.

On 2026-11-02 one native Mac instance (`pnpm dev:worktree --online --frontend-debug`
against the local service) was checked through the debug bridge, with a second
session of the same synthetic account playing the other Mac over HTTP: after
connecting, all 20 keys reached the account; a theme change arrived about a
second later; a caret colour and font size written by the other session applied
on the next focus, including the editor's CSS variables, and were not sent back.
That run found and fixed the authority-snapshot race above. Two native windows
side by side and physical-device behaviour remain unchecked.
