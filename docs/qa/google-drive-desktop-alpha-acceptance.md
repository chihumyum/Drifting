# Google Drive desktop Alpha acceptance

Status: **NOT RUN — public Alpha release blocker**

For the Mobile V2 Desktop/iOS/Android hard gate and its strict sanitized report
validator, use
[`google-drive-three-platform-physical-acceptance.md`](google-drive-three-platform-physical-acceptance.md).
This desktop matrix remains the detailed two-Mac subset; neither document may
be passed by simulator or fake-provider evidence.

Use two isolated Apple Silicon Macs and one disposable production Google
account. Never record content, tokens, credential refs, or absolute paths.

Record for every run: date, operator, device/model, macOS, exact app SHA and
version, account subject hash, object counts, content hashes, error codes,
timings, and sanitized evidence path.

## Required P0 matrix

- [ ] Empty Drive: Mac A connects, discovery completes before local publish.
- [ ] Fresh Mac B: same account automatically discovers and restores all data.
- [ ] Concurrent edits: prose, fields, relations, order, and assets converge.
- [ ] Offline fork: both Macs edit independently, reconnect, and converge.
- [ ] Force quit during upload, download, discovery, and restore resumes from
      durable receipts without data loss or duplicate projects.
- [ ] Sleep/wake and restart refresh resume queued work.
- [ ] Reauthorize with the same account succeeds; a different account is
      rejected without replacing the credential.
- [ ] OAuth revoke and token expiry surface an actionable reauthorization path.
- [ ] Disconnect leaves all local projects, content, relations, and assets.
- [ ] After disconnect, edit prose and project structure locally, then connect
      the same Drive account again. The existing Project is rebound to its
      exact remote generation, the offline edits publish and converge, and no
      snapshot overwrite, second genesis, duplicate Project, or identity
      conflict occurs.
- [ ] Reconnect with immutable Drive history: leave at least one older
      generation locally `retired` or `purged` while its remote snapshot marker
      remains discoverable. Discovery skips that terminal local history and
      still rebinds the current active generation; it must not resurrect the
      older Project or report `local-project-sync-conflict`.
- [ ] 429, 5xx, offline, quota exhaustion, and invalid token expose actionable
      errors and can recover without a permanent queue stall.
- [ ] Valid images/PDFs near 64 MiB use resumable transfer and match hashes on
      Mac B.
- [ ] Repeated rounds produce no lost prose/assets, duplicate project, silent
      conflict discard, or permanent blockage.
- [ ] Multi-project renderer isolation: while three projects pull/apply remote
      changes, the open workspace never shows another project's outline, tabs,
      editor, relations, or bottom timeline.
- [ ] Project switching under load: rapidly switch A → B → C → A during a
      remote pull. Every visible workspace is either the last complete target
      project or its project-scoped loading screen; partial/mixed projections
      and oscillation are forbidden.
- [ ] Prose metric churn: remote Yjs revisions may defer derived word-count
      reconciliation, but must not reject the workspace refresh, rename tabs to
      "Untitled", or produce a repeating revision-conflict loop after sync is
      quiet.
- [ ] Device-local tabs: a project freshly restored from Drive starts with no
      tabs inherited from an older local test database. Tabs opened on that Mac
      persist across its own restart but do not appear on the other Mac.

Any failed row keeps the release blocked. Fake-provider and single-machine
tests may be attached as supporting evidence but cannot check a row above.

## Required multi-project isolation run

Use synthetic projects `A`, `B`, and `C`. Give every project unique canaries in
all visible surfaces: project title, two chapter titles and prose, one drift,
one storyline, one element, one image/PDF filename, one relation, and one
timeline marker. Capture canonical SQLite/Yjs/asset hashes before the run.

1. On Mac A, open at least two tabs in each project, including one split tab.
   Connect Drive and wait until Settings reports the connect/restore action is
   complete.
2. On a Mac B installation with a fresh Drifting data directory, connect the
   same account. The connect button must show a spinner and action text for the
   entire discovery/restore operation; an enabled-looking idle control with an
   empty workspace is a failure.
3. Open project A on Mac B while the runtime is still cycling other projects.
   During A's pull/ingest/apply phases, the footer's project-scoped Drive status
   must distinguish checking from applying without unmounting or covering the
   last complete editor. Once remote commits require a fresh projection, an
   opaque read-only loading overlay must block interaction until the new
   project snapshot is published. B or C content must never render behind it.
4. Rapidly switch A → B → C → A at least ten times while both Macs produce
   remote changes. Record a screen capture containing the left outline, top
   tabs, central editor, and bottom timeline. A late hydrate from a previous
   route must not change any of those four surfaces.
5. Confirm Mac B did not receive Mac A's open/split tabs. Open tabs on Mac B,
   quit with `Cmd+Q`, restart, and confirm those Mac B tabs persist. This proves
   tabs are device-local UI state, not Drive-authored project data.
6. On Mac A, continuously edit prose while Mac B receives it. After the stream
   becomes quiet, verify word counts settle and the log contains no repeating
   `NodeProseMetricRevisionConflictError` loop. A transient derived-metric retry
   must not fail or partially publish the workspace.
7. Recompute canonical hashes and compare every project independently. Also
   query every visible row by `project_id`; no canary from A may be owned by B
   or C, and no cross-project mutation may have committed during rapid
   switching.

## Required disconnect and reconnect run

1. On Mac A, wait until a synthetic Project is fully converged, record its
   canonical SQLite/Yjs/asset hashes, and disconnect Google Drive from Settings.
2. While Settings reports Local mode, edit prose, rename and reorder nodes, and
   add one synthetic image or PDF. Quit with `Cmd+Q`, restart, and verify those
   local edits remain before reconnecting.
3. Connect the same Google account. Discovery must finish without
   `local-project-sync-conflict`. The existing Project must remain one Project
   with the same local identity; it must not be cleared and restored from the
   older Drive snapshot while connecting. Its connect receipt must reference
   the commit marker's existing durable `sync_remote_object.id`, including a
   database created with the earlier `provider-object` row-ID shape; it must not
   synthesize a new ID that violates the receipt foreign key.
4. Wait for convergence, then verify Mac B receives the offline edits and
   asset hashes. Mac A must not publish another genesis for the already-owned
   generation, and Drive discovery must not create a duplicate Project.
5. Repeat with a Project that originally arrived on Mac A through fresh-device
   restore. Historical restore receipts must not prevent the exact-generation
   rebind.
6. Repeat once more after deleting that Project while Drive is disconnected.
   Reconnect must resolve the detached generation's unique terminal journal
   identity, publish `sync-generation.purge`, retire its binding, and remove the
   Project from Mac B. It must not restore the deleted Project from Drive or
   fail because `sync_generation.project_id` is intentionally null.
7. On a fresh local data directory, force quit after discovery has authenticated
   a remote-only Project marker but before materialization commits. Relaunch and
   retry the same durable connect attempt: the resolved project-less staged
   generation must resume and activate exactly once. Repeat by cancelling the
   interrupted attempt, returning to Local mode, and starting a fresh connect;
   the cancelled restore shell may be restaged only when it has no Project,
   authored journal, provider binding, committed child, or activated child.
8. Before another reconnect, ensure Drive discovery returns at least one older
   generation whose local row is already `retired` or `purged`, sorted before
   the current active generation. Reconnect must leave the historical row in
   its terminal state, bind the current generation, and complete without a
   duplicate Project or `local-project-sync-conflict`. Repeat for both offline
   edits and an offline Project deletion.

Attach sanitized evidence with only project labels, counts, hashes, timestamps,
build SHA, sync phases, and error codes. Never attach prose, credentials, native
paths, or provider object payloads.
