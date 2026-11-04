# Account-isolated libraries

Each Hosted account has its own library on a Mac, and a separate **local
library** holds writing done while signed out. Projects never move between
them on their own. Before this (alpha.3 and earlier) one library served every
account: connecting an account published every local project to it and
disconnecting kept them all, so switching accounts copied books into the other
account in both directions and left the previous account's sync state behind.

## What the author sees

- **Signing in** opens that account's library. A new one starts empty and
  restores the account's cloud projects as soon as the session is verified;
  books in the local library are never brought in. Signing back in to an
  account whose library is already on this Mac opens it as it was, and
  changes that had not uploaded continue then.
- **Signing out** (the account menu or Account settings) returns to the local
  library. The account's library stays on this Mac. The sign-out dialog still
  offers to upload pending changes first; it no longer offers to disconnect the
  library, because signing out already leaves it behind.
- **An expired session, offline use or a rejected credential is not a
  sign-out.** The author keeps writing the same library and signs in again to
  resume, exactly as before.
- The local library never connects to an account, and it does not receive the
  built-in sample twice; an account library never gets the sample.

Bringing a book from one library into another is a separate, explicit step:
export it as a `.driftingbook` file from the shelf in one library and import it
from the shelf's left column in the other. The import adds a new book with
fresh identities and, in an account library, publishes it like any new book;
see [moving a book between libraries](../book-transfer.md).

## How it works

A library is a whole native data root, not just a SQLite file: its database,
assets, sync objects and restore attempts, Markdown projections, MCP state,
safety backups and recovery receipts. Native stores garbage-collect against the
database that is open (sync objects, asset restore attempts, asset imports), so
two libraries must never share a root.

`libraries.json` in the App-local base root (`src-tauri/src/library_registry.rs`)
records each library's owner (`local` or an account subject) and the active
one. A process reads it once and runs on that library for its whole life:
`data_paths::app_local_root` resolves to the running library's root and every
native store already derives its folder from it. Switching writes the registry
and relaunches through the quit flush barrier (the same path as an installed
update), so no runtime, native store or renderer ever sees two libraries.
Mobile cannot relaunch and keeps a single library for now.

Library roots:

- `legacy`: the base root itself, the library an install had before this change.
  Upgrading moves no files. On its first launch the renderer claims its owner
  from its own sync authority: the account it is bound or connecting to, or
  `local`.
- `local`, `account-<first 16 bytes of SHA-256(account subject), hex>`: under
  `libraries/`. Hex ids stay distinct on case-insensitive volumes.

With `DRIFTING_DB_DIR` the legacy library's databases stay in that folder and
every other library uses a subfolder named by its relative root. Libraries
other than `legacy` grant the asset-protocol folders of their root at startup.
Crash reports and development logs are App-wide and stay beside the legacy
library's databases whichever library runs.

A development build cannot relaunch itself under `tauri dev`: the CLI stops its
frontend server once the process it started exits. The macOS development
runner (`scripts/run-signed-macos-dev.sh`) therefore passes
`DRIFTING_DEV_RELAUNCH_MARKER`; a relaunch writes that file and exits, and the
runner starts the binary again, forwarding stop signals to it.

A packaged macOS App relaunches through LaunchServices
(`src-tauri/src/macos_relaunch.rs`): a detached helper waits for the process
to exit, then reopens the bundle with `open -n`, passing on its `DRIFTING_*`
environment and arguments. `AppHandle::restart` spawned the executable
directly, which macOS does not activate, so after signing in or out (or an
installed update) the new window opened behind other Apps. Other platforms,
and a macOS binary outside an `.app`, still use `AppHandle::restart`.

Renderer (`src/renderer/services/account-library.ts`):

- `checkSession` opens the database, then settles the running library before
  `db:ready`: it claims an unclaimed library and, when a profile is cached
  (signed in or expired), relaunches onto that account's library if another
  one is running. A signed-out author keeps whatever library is open until an
  explicit choice, so an upgrade never hides an account's books.
- `adoptSession` and `refreshHostedSession` open the session account's library
  before checking ownership or binding sync. They persist the session token and
  profile (and mark the first-use guide seen) so the relaunched process adopts
  the session there; the calling flow waits until the relaunch.
- After a verified session on an account library that has never connected (no
  connect attempt recorded), the account's cloud projects are restored with the
  existing connect path. A library whose sync the author disconnected stays
  disconnected. Projects arrive together when the restore activates, so the
  shelf and Account settings show its progress meanwhile: finding the account's
  projects, the downloaded share of the asset bytes their snapshots declare,
  then adding them to the library. One connect runs per library at a time; a
  second request (such as **Connect** in Account settings) joins it.
- `logout` returns to the local library after the session is cleared.

The domain user id stays `drifting-library.db` in every library, so project
ownership filters and per-project renderer state need no migration. WebView
storage is shared by all libraries; per-project renderer state (recent items,
tabs, Agent conversation pointers) is keyed by project id.

## Already-mixed accounts

Libraries created before this change may already hold another account's books,
and Hosted accounts may hold copies of books from another account. This change
stops new mixing but does not remove existing copies; removing a cloud copy is
an explicit, per-project decision.

## Acceptance

`pnpm account-libraries:evidence` runs the native registry tests
(`cargo test --lib library_registry`: claiming, per-owner roots, switching
back, conflicts, corrupt registries, subject validation) and the renderer
suites (`src/renderer/services/account-library.test.ts`,
`src/renderer/store/auth.account-libraries.test.ts` and the auth and Hosted
settings acceptance tests: classification, relaunch decisions, first restore,
sign-in, failed relaunch, sign-out, copy) and writes
[`acceptance/account-libraries.json`](acceptance/account-libraries.json);
`pnpm account-libraries:check` verifies it is current.

A desktop development profile (`pnpm dev:worktree --frontend-debug`) was also
switched through the native commands on 2026-11-02: the upgraded library was
claimed `local` with the built-in sample; activating an account library
relaunched onto an empty shelf with its database under
`databases/libraries/account-…`; activating `local` relaunched onto the
original shelf, with the frontend server running throughout.

A packaged Debug build (`pnpm dev:worktree --build-app`) relaunched through
the quit flush barrier on 2026-11-04, triggered by a temporary hook that was
not committed: with `AppHandle::restart` the new process opened behind Safari;
through `macos_relaunch` it was the front App, the old process had exited, and
its `DRIFTING_*` environment was carried over.

Not yet covered: signing in against a Hosted service (relaunch, first restore,
sign-out back to local, pending uploads resuming), and mobile.
