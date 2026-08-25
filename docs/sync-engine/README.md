# SyncEngine documentation

Start with the
[`trusted-cloud Google Drive contract`](trusted-cloud-google-drive.md). It is
the authority for cloud trust, Google sign-in, automatic project discovery,
restore, and product terminology.

## Current architecture

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
- [`phase5-google-drive-native.md`](phase5-google-drive-native.md): native Drive
  transport and OAuth boundary.
- [`phase5-google-drive-credential-ownership.md`](phase5-google-drive-credential-ownership.md),
  [`phase5-google-drive-credential-revoke.md`](phase5-google-drive-credential-revoke.md),
  [`phase5-google-drive-reauthorize.md`](phase5-google-drive-reauthorize.md), and
  [`phase5-google-drive-mobile-oauth.md`](phase5-google-drive-mobile-oauth.md):
  native credential lifecycle.
- [`phase5-initial-connect.md`](phase5-initial-connect.md),
  [`phase5-google-drive-restore.md`](phase5-google-drive-restore.md), and
  [`phase5-sync-generation-provisioning.md`](phase5-sync-generation-provisioning.md):
  Google sign-in, automatic Project discovery, restore, and post-connect
  SyncGeneration provisioning.
- [`phase6-product-controls.md`](phase6-product-controls.md): user-facing sync
  controls and release gates.

## Evidence boundary

Phase documents link their machine-readable acceptance JSON and reproducible
commands where that evidence exists. The top-level product contract is
[`acceptance/trusted-cloud-google-drive-contract.json`](acceptance/trusted-cloud-google-drive-contract.json).
These reports cover local implementation and fake/native build boundaries;
they do not close the real-account, cross-device, or physical-device gates.

Physical-run claims use the evidence chain introduced on 2026-08-24:
`scripts/check-google-drive-physical-evidence.ts` validates
`docs/qa/google-drive-physical-evidence-contract.json`, run through
`pnpm mobile:google-drive:acceptance` or
`pnpm mobile:google-drive:acceptance:contract`.
