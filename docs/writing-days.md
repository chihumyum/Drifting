# Writing days and the shelf's heatmap

Status: **current desktop feature** (2026-11-03). Mobile is paused.

The shelf shows a year of writing as a contribution graph: 53 weeks, Monday at
the top, one dab of sand for each day words were added to any book, and a
30-day strip on each book's card. The design is in
[components.md § 书架](design-system/components.md).

## What is counted

A day's words are the words a device **added** to a book that day: the book's
canonical chapter total (`sumCanonicalChapterWordCounts`) minus where it stood
when the day began. Deleting more than was written reads as zero, as the stats
panel's *today* does. Rewriting a passage to the same length counts nothing.
The day is the writer's own local calendar date.

Each device keeps its own row per book and day. Two Macs writing the same book
on the same day never overwrite each other: the shelf adds the rows of a day.
Words that arrive from another device while a book is open here are counted
where they were written, not again here (below).

## Storage and sync

`writing_day` (migration `0016_writing_day.sql`, `WritingDayTable`):

| Column | |
|---|---|
| `id` | uuid v7, the row's identity |
| `project_id` | the book; rows go with it when it is purged (cascade) |
| `day` | `YYYY-MM-DD` |
| `device_key` | `device-` and 24 hex characters: SHA-256 of `drifting.writing-day.v1\n` and the native installation identity (`services/writing-days/device-key.ts`). The synced row names the device without carrying the identity. |
| `words` | non-negative integer |
| `created_at`, `updated_at` | derived clock |

It is an authored, project-direct domain in the
[sync domain manifest](sync-engine/acceptance/sync-domain-manifest.md), entity
kind `writing-day`. A row is created with its day, device and words; afterwards
only `words` can be set (`day` and `deviceKey` are seed-only in the production
kernel, `words` must be a non-negative safe integer). Because only the owning
device writes a row, last-writer-wins never has two writers. Rows are captured
in checkpoints, restored on a new device, and carried by a `.driftingbook`
export like any other authored table; a checkpoint made before the table
restores it empty. The heatmap therefore follows the Hosted account.

## Recording

`services/writing-days/writing-day-recorder.ts`, started by
`ProjectRuntimeProvider` for the open book:

- Every time the canonical chapter total changes, the recorder tallies the
  day (`writing-day-tally.ts`, pure). The first time it sees a day it reads the
  device's row for it and starts the day below the total by the words already
  stored, so reopening a book keeps the morning's words.
- When a change from another device is applied (`sync:project-changed`,
  `sync:projects-restored`), totals that move in the following 8 seconds move
  the day's baseline instead of its words.
- It writes the row at most once a minute while the words move, and again when
  the window hides or the book closes. Each write is one journaled authored
  transaction (`withAtomicSyncTransaction`); a day without words writes no row.

The older device-local record (`localStorage` `writing-stats-storage`) is still
kept and still feeds the in-book stats (today, this week, streak).

## Backfill

Once per library (`library_state` key `writing-days-backfill`), the shelf turns
that older local record into rows for this device
(`services/writing-days/backfill.ts`): only books in the open library, only days
before today, only days this device has no row for. On the day the table
arrives the recorder takes today's earlier words from the same record. History
from before a book was first opened on this device does not exist and is not
invented.

## Reading

`readShelfWritingDays(since)` is one statement for the whole shelf: words per
book and day since the heatmap's first Monday, summed over devices, books in
Recently Deleted left out. `deriveWritingYear`, `summarizeWritingDays`,
`writingDayThresholds` and `writingDayLevel` (beside `deriveWritingStats` in
`store/writing-stats-store.ts`) lay the rows on the calendar. Levels are the
quartiles of the year's days written, all books together; a book shown alone
keeps the library's levels. The shelf reads again when its books change and
when a change from another device is applied.

## Evidence

- `src/renderer/store/writing-year.test.ts`: calendar, sums, streak, levels.
- `src/renderer/services/writing-days/writing-day-tally.test.ts`: baselines,
  stored words, remote moves, deletions.
- `src/renderer/services/writing-days/writing-days.integration.test.ts`: the
  recorder's rows and journal, the backfill and the shelf read on SQLite.
- `src/renderer/lib/sand-heat.test.ts`: the masks are seeded and stay in bounds.
- `src/renderer/views/shelf-sand-glass.acceptance.test.ts`: the shelf's rail,
  heatmap and strips.
