# SyncEngine documentation

Start with the [Hosted sync contract](../hosted-sync/README.md). Hosted is the
only App sync provider.

## Current architecture

- [`agent-conversation-sync.md`](agent-conversation-sync.md): isolated settled
  history sync, portable continuation and concurrent branches.

- [`phase0-domain-manifest.md`](phase0-domain-manifest.md): authored and synced
  domain classification.
- [`phase1-local-runtime-boundary.md`](phase1-local-runtime-boundary.md): local
  runtime and network boundary.
- [`phase1-main-prose-authority.md`](phase1-main-prose-authority.md): Yjs prose
  authority.
- [`phase1-normalized-authority.md`](phase1-normalized-authority.md): normalized
  KV, aliases, Plot Grid, and ordered-list authority.
- [`phase1-remote-yjs-live-merge.md`](phase1-remote-yjs-live-merge.md): committed
  remote Yjs delivery to open editors.
- [`phase1-sqlite-reducer-materializer.md`](phase1-sqlite-reducer-materializer.md):
  deterministic SQLite materialization.
- [`phase2-checkpoint-restore.md`](phase2-checkpoint-restore.md): provider-neutral
  checkpoint capture and isolated restore.
- [`phase2-native-asset-pipeline.md`](phase2-native-asset-pipeline.md): native
  asset capture, upload, and install.
- [`phase3-durable-runtime.md`](phase3-durable-runtime.md): durable coordinator
  and convergence loop.
- [`phase3-app-provider-authority.md`](phase3-app-provider-authority.md): one
  App-wide provider/account authority.
- [`phase3-local-folder-provider.md`](phase3-local-folder-provider.md): test-only
  filesystem reference provider.
- [`phase3-production-runtime.md`](phase3-production-runtime.md): production
  composition boundary.
- [Hosted account and connection](../hosted-sync/README.md): sign-in, discovery,
  new-project provisioning, pause/resume and local-data-preserving disconnect.
- [`phase7-log-compaction.md`](phase7-log-compaction.md): Raft-style truncation
  of covered history on the provider and in the local journal, and
  lagging-replica catch-up from a snapshot.

## Evidence boundary

Phase documents contain historical implementation evidence and are not current
product promises. `pnpm hosted:acceptance` generates the active Hosted HTTP/SQLite
report. Source and
synthetic HTTP checks do not establish live account, email, cross-device,
signed-installation or production-service acceptance.
