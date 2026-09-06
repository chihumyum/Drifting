# Agent conversation synchronization

The Agent conversation extension synchronizes settled chat history and supports
continuing that history on another device. It is activated automatically for
projects with an active Google Drive binding. It backfills existing local
conversations and follows the app's pause, resume, disconnect and account
lifecycle. It does not transfer a running task or its authority.

## Storage and compatibility

Drive uses `driftingProtocol=agent-chat-v1`, separate from the released
`object-v2` project namespace. A namespace is selected when a native generation
handle opens; the default remains the project namespace. Native handle caches,
inventory, metadata validation, uploads and downloads respect that scope.
Project discovery still selects only object-v2 snapshot commits. Account-wide
Drive changes for unknown chat file IDs are harmless to the released parser.
Project v1 changesets, snapshots, included tables and schema version remain
unchanged. An extension object never creates or restores a project.

`0001_agent_chat_sync.sql` appends branch projections, immutable objects, local
execution bindings, a durable export queue, independent cursors and delivery
receipts. It leaves the published baseline unchanged and uses the existing
native shadow-migration safety snapshot path. Pending migrations require that
path even when a development build retains its package version. Chat content is classified as
`extension` and excluded from project v1; execution and transport state remain
local. The developer CLI does not expose generic CRUD for these tables.

SQLite triggers atomically enqueue conversation changes and terminal runtime
commits, including those made while the panel is unmounted. Export drains a
bounded batch of 16 conversations, at most 16 turns per conversation, and acknowledges the observed queue revision only. Backfill
uses missing local bindings as a resumable cursor. A failed export is recorded
per conversation rather than starving sibling histories.

## Portable history

Branch metadata has stable identity and immutable ancestry. Title updates use
a deterministic clock; deletion is monotonic and dominates late append.
Turn objects are immutable and explicitly reference their predecessor and
payload chunks. Content-addressed chunks contain normalized model messages,
finalized display records, verified summary candidates and required large
result bytes. Individual wire objects are bounded to 1 MiB; text chunks are
64 Ki UTF-16 code units and reconstructed payloads are bounded to 64 Mi code
units. Neither rendered JSON nor partial assistant output becomes model truth.
Failed/interrupted turns retain author intent and historical display without
replaying their unfinished actions. Legacy display-only histories remain
read-only.

All payload dependencies upload before their turn commit. Receivers validate
identity, protocol, hashes and dependencies before permitting continuation.
Downloaded content is committed before advancing a cursor; affected branches
are marked pending in the same transaction. A restart resumes projection even
if the download cursor was already acknowledged. Retries are idempotent. Missing dependencies wait, while conflicting identities are
quarantined. Native transfer files are transient and regenerated from SQLite
on retry; native logical keys are SHA-256 identities and the semantic identity is
verified inside each envelope. Staging files are discarded after use, and crash leftovers follow the existing
age-bounded native orphan collector. No durable chat record depends on a
native staging path. Live conversations pin local tool results against age-based
garbage collection; portable chunks remain until project deletion. Remote history is retained as immutable objects with
logical tombstones; this version performs no time-based remote garbage
collection.

## Continuation and presentation

A remote continuation creates a new locally owned branch and session. The
importer reconstructs complete canonical message history, validates tool-pair
topology and creates a local digest checkpoint. Summary candidates are reused
only when their source identity and hash validate; the normal context planner
checks them again. Large result reads are confined to the current session's
imported ancestry. No remote grants, executable tool calls, pending controls,
review settlements or write receipts are imported. New writes must obtain
fresh local evidence and permissions through the existing runtime.

A single continuation is collapsed in the history list. Concurrent paths stay
separate and share their prefix. Renaming/deleting applies to the selected
branch, and project-wide deletion applies to all branches. A late completion
cannot revive a tombstone. History-only changes emit
`agent:conversations-changed`; they do not rebuild the project workspace or
interrupt editor input. Desktop and mobile disable continuation for pending,
conflicting and display-only histories. Transfer diagnostics share the existing
notification surface and identify Agent conversations separately.

## Evidence and physical acceptance

Generated contract evidence is in
[`acceptance/agent-conversation-sync.json`](acceptance/agent-conversation-sync.json).
Regenerate it with `pnpm agent:conversation-sync:evidence`; verify it with
`pnpm agent:conversation-sync:check`. Integration tests use two independent
product SQLite databases and synthetic content.

The native/provider tests and source checks do **not** establish real-account
or physical-device acceptance. Before declaring that gate complete, use builds
from this change on macOS, iOS and Android and record: fresh-device restore,
continuation, offline forks, deletion, restart, account reauthorization and
continued bidirectional project sync with the previous client. Keep build
identity, date, platform and sanitized outcomes with the report. Do not commit
account data, manuscript content or credentials as evidence.
