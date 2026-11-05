# Sync status in the desktop workspace

Since 2026-11-02 the desktop workspace shows Hosted sync outside Settings:

- Light states (a long transfer, a retry, being offline) show only as one sand
  mark in the paper's lower-left corner.
- Problems the author has to act on show on that mark and on the
  notification bell until they resolve.

Settings › Account keeps its fuller "Sync progress" row. The visual rules are
in [components.md](../design-system/components.md) under 稿纸角同步记号
(the paper-corner sync mark).

The change was prompted by a library whose sync runtime failed to start every
launch for a month without any sign outside Settings.

## States

`src/renderer/sync/sync-health.ts` derives every state from three inputs:

- the sanitized runtime snapshot (`productSyncRuntimeControl`)
- the sync authority (`mode === 'hosted'`, `status === 'cloud-paused'`)
- the Hosted session (`hostedStatus`)

The runtime snapshot only carries each SyncGeneration's latest cycle. A
`SyncHealthTracker` therefore remembers two things across snapshots: how long
the current run of cycles has been busy, and how many cycles in a row failed.
`sync-health-store.ts` starts observing with its first subscriber and keeps
observing after that. It wakes itself whenever a threshold is about to be
crossed.

| State | Mark | Shows when | Clears when |
| --- | --- | --- | --- |
| Synced, local library, paused | nothing | — | — |
| Syncing | cloud, breathing | a run of non-idle cycles has lasted `SYNC_MARK_SHOW_AFTER_MS` (3 s); gaps shorter than the linger count as one run | `SYNC_MARK_LINGER_MS` (1.5 s) after the last cycle goes idle |
| Retrying | cloud, blinking | the latest counted cycle failed and the failure is `SYNC_RETRY_SHOW_AFTER_MS` (30 s) old | a cycle succeeds |
| Offline | loose-sand cloud | `hostedStatus === 'offline'` or `diagnostics.online === false` | the session or the engine is online again |
| Problem: not started | danger seal | `activationFailed` | activation succeeds (retry, or the next launch) |
| Problem: session expired | danger seal | `hostedStatus === 'needs-reauth'` | the author signs in again |
| Problem: storage full | danger seal | a failed cycle reports `QUOTA_EXCEEDED` | a cycle succeeds |
| Problem: failing | danger seal | `SYNC_FAILING_CYCLES` (3) failed cycles in a row, or failing for `SYNC_FAILING_FOR_MS` (5 min) | a cycle succeeds |

Precedence on the paper is problem, then offline, then retrying, then syncing.

The paper shows only the open book: its SyncGenerations, including the
book's `:agent-chat` one. Not-started and session-expired stop every book, so
every book's paper shows them.

The bell collects problems from every book. Each book gets one row, and a
problem that stops every book gets a single row.

While the author types, the syncing cloud fades out and returns
`SYNC_MARK_TYPING_SETTLE_MS` (2 s) after the last keystroke. Problem marks,
offline and retrying do not fade.

The hover card shows the current round's items and bytes. `transferProgress`
describes one round, and a seal backlog is packed into rounds of at most
4,096 change sets. The card therefore does not claim a total across rounds.

## Actions

The paper's hover card and the bell's pinned row offer the same actions
(`features/sync-status/sync-status-actions.ts`):

- **Retry** runs `triggerManual` for the SyncGenerations in trouble, or for
  every one when the state names none. When sync could not start, it emits
  `sync:activation-retry` (`productSyncRuntimeControl.retryActivation()`). The
  production runtime supervisor answers that event with a reload.
- **Sign in again** opens the account dialog (`useOpenSignIn`).
- **Open Settings** opens the workspace Settings on Account
  (`settings:open`). This is where Hosted storage and the sync progress row
  are.

Storage full offers Open Settings, then Retry. Session expired offers only
Sign in again. Every other state offers Retry.

## Notifications

The desktop calls `useNotificationFeed({ transfers: false })`, so ordinary
transfers no longer add a row per cycle or make the bell blink.
`useSyncProblemNotifications` writes one `syncProblem` row per problem:

- The row stays first and cannot be removed or cleared.
- While any such row exists, the bell wears the danger seal.
- When the problem resolves, the same row becomes an ordinary "Sync resumed"
  row.

On the shelf the bell sits beside the account cell at the foot of the rail
and opens the center upward.
While the left sidebar is closed, a second bell floats under the left toggle.
It opens the center downward. The center is drawn only by the bell that
opened it (`centerOwner`).

The paused mobile shell keeps its row-per-transfer feed.
