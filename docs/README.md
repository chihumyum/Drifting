# Drifting Core documentation

This directory contains current product contracts, architecture notes, runbooks,
and acceptance evidence. Current behavior must be read from the sources below;
dated run reports are evidence for one checkout, not product truth.

## Desktop public Alpha

- [Frozen release contract](alpha-release-contract.md)
- [Release runbook](desktop-alpha-release-runbook.md)
- [Google Drive data-use disclosure](google-drive-data-use.md)
- [Desktop quick start](quick-start.md)
- [Google Drive two-Mac acceptance](qa/google-drive-desktop-alpha-acceptance.md)
- [Signed desktop RC acceptance](qa/desktop-alpha-release-candidate.md)
- [Known issues](../KNOWN_ISSUES.md)
- [Support](../SUPPORT.md)

## Start here

| Question                                                   | Source                                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do I build and run the client?                         | [`../README.md`](../README.md)                                                                                                                                        |
| Is the source repository ready to become public?           | [`source-publication-readiness.md`](source-publication-readiness.md)                                                                                                  |
| What is the canonical local image/PDF boundary?            | [`local-assets.md`](local-assets.md)                                                                                                                                  |
| How does account-free relational Markdown export work?     | [`local-data-export.md`](local-data-export.md)                                                                                                                        |
| What is the current Google Drive trust/restore contract?   | [`sync-engine/trusted-cloud-google-drive.md`](sync-engine/trusted-cloud-google-drive.md)                                                                              |
| How do committed remote Yjs updates reach an open editor?  | [`sync-engine/phase1-remote-yjs-live-merge.md`](sync-engine/phase1-remote-yjs-live-merge.md)                                                                          |
| What does checkpoint capture/isolated restore implement?   | [`sync-engine/phase2-checkpoint-restore.md`](sync-engine/phase2-checkpoint-restore.md)                                                                                |
| What durable SyncEngine/reference convergence is complete? | [`sync-engine/phase3-durable-runtime.md`](sync-engine/phase3-durable-runtime.md)                                                                                      |
| How is one App-wide provider activated atomically?         | [`sync-engine/phase3-app-provider-authority.md`](sync-engine/phase3-app-provider-authority.md)                                                                        |
| What filesystem reference-provider durability is complete? | [`sync-engine/phase3-local-folder-provider.md`](sync-engine/phase3-local-folder-provider.md)                                                                          |
| What native Google Drive transport is implemented?         | [`sync-engine/phase5-google-drive-native.md`](sync-engine/phase5-google-drive-native.md)                                                                              |
| How are OAuth refresh credentials owned across crashes?    | [`sync-engine/phase5-google-drive-credential-ownership.md`](sync-engine/phase5-google-drive-credential-ownership.md)                                                  |
| What SyncEngine product controls and gates exist?          | [`sync-engine/phase6-product-controls.md`](sync-engine/phase6-product-controls.md)                                                                                    |
| What normalized KV/list/Plot Grid authority is complete?   | [`sync-engine/phase1-normalized-authority.md`](sync-engine/phase1-normalized-authority.md)                                                                            |
| What does General Agent support now?                       | [`agent-runtime/acceptance/CURRENT_STATUS.md`](agent-runtime/acceptance/CURRENT_STATUS.md)                                                                            |
| What tools and capability counts ship?                     | Generated [`agent-capabilities.md`](agent-runtime/acceptance/agent-capabilities.md) and [`agent-capabilities.json`](agent-runtime/acceptance/agent-capabilities.json) |
| How do coding agents run fast CRUD and E2E checks?         | [`dev-cli/README.md`](dev-cli/README.md) and generated [`cli-capabilities.md`](dev-cli/acceptance/cli-capabilities.md)                                                |
| How do agents inspect and operate a mobile WebView?        | [`frontend-debug.md`](frontend-debug.md)                                                                                                                             |
| What is the current milestone policy and open work?        | [`agent-runtime/ROADMAP.md`](agent-runtime/ROADMAP.md)                                                                                                                |
| What is the frozen target design for Ambient Shadow?       | [`ambient-editor/README.md`](ambient-editor/README.md)                                                                                                                |
| What should the final Ambient author experience feel like? | [`ambient-editor/product-vision.md`](ambient-editor/product-vision.md)                                                                                                |
| What are the renderer dependency rules?                    | [`renderer-ui-architecture.md`](renderer-ui-architecture.md)                                                                                                          |
| How do project relation types behave?                      | [`relation-types.md`](relation-types.md)                                                                                                                              |
| What is the mobile product boundary?                       | [`mobile-ui-foundation.md`](mobile-ui-foundation.md)                                                                                                                  |
| What still needs physical-device testing?                  | [`mobile-device-acceptance.md`](mobile-device-acceptance.md)                                                                                                          |
| What is historically complete?                             | [`agent-runtime/acceptance/MILESTONE_HISTORY.md`](agent-runtime/acceptance/MILESTONE_HISTORY.md)                                                                      |

## Normative documents

- `agent-runtime/*-protocol.md`, `author-owned-writing-policy.md`, and
  `entity-snapshot-history.md` define runtime invariants.
- [`design-system.md`](design-system.md) and `editor/*.md` define durable UI and
  editor contracts that are not obvious from a screenshot.
- [`ai-provider-settings.md`](ai-provider-settings.md) defines credential and
  provider-routing ownership.
- [`local-assets.md`](local-assets.md) and
  [`local-data-export.md`](local-data-export.md) define the current local asset
  and readable-export boundaries. The Markdown archive is not a lossless backup.
- [`sync-engine/trusted-cloud-google-drive.md`](sync-engine/trusted-cloud-google-drive.md)
  is the current authority for the Google trust boundary, Google-sign-in plus
  automatic project discovery, and the Project-only user vocabulary. Drifting
  does not E2EE synced projects against Google and has no recovery code, QR, or
  application-managed Project content key.
- [`sync-engine/README.md`](sync-engine/README.md) indexes current SyncEngine
  architecture and current phase evidence.
- [`sync-engine/phase2-checkpoint-restore.md`](sync-engine/phase2-checkpoint-restore.md)
  records the implemented provider-neutral checkpoint/restore core and its
  reproducible SQLite acceptance boundary.
- [`sync-engine/phase1-remote-yjs-live-merge.md`](sync-engine/phase1-remote-yjs-live-merge.md)
  records the post-commit live-document delivery order, replayable SQLite-tail
  coverage barrier, no-echo rule and compaction/crash acceptance.
- [`sync-engine/phase1-normalized-authority.md`](sync-engine/phase1-normalized-authority.md)
  records the stable KV/alias/Plot Grid model, fractional-indexing list
  authority, explicit rebalance contract and checkpoint projection rebuild.
- [`sync-engine/phase2-native-asset-pipeline.md`](sync-engine/phase2-native-asset-pipeline.md)
  records the opaque-ref native capture/install ports, durable blob lane,
  restart reconciliation and real SIGKILL recovery evidence.
- [`sync-engine/phase3-durable-runtime.md`](sync-engine/phase3-durable-runtime.md)
  records the journal-to-object-log coordinator, crash/convergence evidence and
  the explicit domain-kernel, remote-asset and composition gates before product
  activation.
- [`sync-engine/phase3-app-provider-authority.md`](sync-engine/phase3-app-provider-authority.md)
  records the all-project provider transition, generation replacement, durable
  activation receipts, and local-data-preserving disconnect transaction.
- [`sync-engine/phase3-local-folder-provider.md`](sync-engine/phase3-local-folder-provider.md)
  records the opaque-reference filesystem provider, conformance matrix and
  child-process SIGKILL durability evidence.
- [`sync-engine/phase5-google-drive-native.md`](sync-engine/phase5-google-drive-native.md)
  records the trusted-cloud `appDataFolder` transport and native credential
  boundary. Native OAuth source/build evidence does not close any
  real-account/device gate, so this is not a release claim.
- [`sync-engine/phase5-google-drive-credential-ownership.md`](sync-engine/phase5-google-drive-credential-ownership.md)
  records the App-wide singleton credential, provisional/claimed native state,
  credential-first SQLite ordering and retryable crash matrix. Real-account
  `SIGKILL` and Keychain restart gates remain open.
- [`sync-engine/phase6-product-controls.md`](sync-engine/phase6-product-controls.md)
  records the Google-sign-in, automatic-discovery, status and diagnostics
  surfaces, plus the real-account and physical-lifecycle gates that still
  prevent a public Google Drive claim.
- [`ambient-editor/technical-architecture.md`](ambient-editor/technical-architecture.md)
  and [`ambient-editor/delivery-and-acceptance.md`](ambient-editor/delivery-and-acceptance.md)
  define the approved future Ambient design and progressive gates. They are
  design contracts, not evidence that Ambient behavior ships.
- [`../src-tauri/UNSUPPORTED.md`](../src-tauri/UNSUPPORTED.md) defines explicit
  platform limitations.

## Evidence policy

- Generated capability files and deterministic acceptance JSON are checked-in
  machine evidence. Do not edit generated files by hand.
- Dated paid-provider, real-project, or native run reports may remain when the
  evidence cannot be reproduced in an ordinary local test run.
- Completed phase and milestone prose is summarized in one historical index;
  full deleted reports remain recoverable from Git.
- README and current-status documents link to authoritative detail instead of
  copying tool counts, test counts, or completed milestone narratives.
