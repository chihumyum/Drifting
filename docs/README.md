# Drifting Core documentation

This directory contains current product contracts, architecture notes, runbooks,
and acceptance evidence. Current behavior must be read from the sources below;
dated run reports are evidence for one checkout, not product truth.

## Desktop public Alpha

- [Sentry operational diagnostics and setup](sentry-observability.md)

- [Frozen release contract](alpha-release-contract.md)
- [Release runbook](desktop-alpha-release-runbook.md)
- [`0.1.0-alpha.1` release notes](releases/0.1.0-alpha.1.md)
- [Desktop quick start](quick-start.md)
- [Signed desktop RC acceptance](qa/desktop-alpha-release-candidate.md)
- [Known issues](../KNOWN_ISSUES.md)
- [Support](../SUPPORT.md)

The standalone Apple-native front-end and Google Drive sync were retired on
2026-10-28. Tauri and Hosted are the active client/service path. The public
release contract remains paused. See [onboarding and Hosted readiness](client-onboarding-and-hosted-readiness.md).

## Start here

| Question                                                   | Source                                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do I build and run the client?                         | [`../README.md`](../README.md)                                                                                                                                        |
| Where is the source-publication record?                    | [`source-publication-readiness.md`](source-publication-readiness.md)                                                                                                  |
| What is the canonical local image/PDF boundary?            | [`local-assets.md`](local-assets.md)                                                                                                                                  |
| How do materials open, and how are notes and media edited? | [`material-workbench.md`](material-workbench.md) — material tabs, note profile, region comments, retired url kind |
| How do element portraits get generated and kept?           | [`image-generation.md`](image-generation.md) — experimental ChatGPT subscription route, local inbox, material provenance                                            |
| How does account-free relational Markdown export work?     | [`local-data-export.md`](local-data-export.md)                                                                                                                        |
| How is the book exported as EPUB, PDF or Word?             | [`manuscript-export.md`](manuscript-export.md) — finished-manuscript scope, live Yjs read, native writers, sample-book evidence |
| How do share links and readers' comments work?             | [`share-links.md`](share-links.md) — Hosted only, link-readable copy, signed-in reader comments imported as anchored comments                                        |
| How do complete `.drifting` library backups and restore work? | [`library-backup.md`](library-backup.md) — local-only package, staged verification, pre-restore copy, additive asset merge                                        |
| What do crash and integrity reports send?                  | [`crash-reports.md`](crash-reports.md) — content-free, Hosted builds only, Settings → Privacy                                                                         |
| How do chapter/line location links work?                   | [`location-links.md`](location-links.md)                                                                                                                              |
| How do committed remote Yjs updates reach an open editor?  | [`sync-engine/phase1-remote-yjs-live-merge.md`](sync-engine/phase1-remote-yjs-live-merge.md)                                                                          |
| What does checkpoint capture/isolated restore implement?   | [`sync-engine/phase2-checkpoint-restore.md`](sync-engine/phase2-checkpoint-restore.md)                                                                                |
| What durable SyncEngine/reference convergence is complete? | [`sync-engine/phase3-durable-runtime.md`](sync-engine/phase3-durable-runtime.md)                                                                                      |
| How is one App-wide provider activated atomically?         | [`sync-engine/phase3-app-provider-authority.md`](sync-engine/phase3-app-provider-authority.md)                                                                        |
| What filesystem reference-provider durability is complete? | [`sync-engine/phase3-local-folder-provider.md`](sync-engine/phase3-local-folder-provider.md)                                                                          |
| What SyncEngine product controls and gates exist?          | [`sync-engine/phase6-product-controls.md`](sync-engine/phase6-product-controls.md)                                                                                    |
| What normalized KV/list/Plot Grid authority is complete?   | [`sync-engine/phase1-normalized-authority.md`](sync-engine/phase1-normalized-authority.md)                                                                            |
| What does General Agent support now?                       | [`agent-runtime/acceptance/CURRENT_STATUS.md`](agent-runtime/acceptance/CURRENT_STATUS.md)                                                                            |
| What tools and capability counts ship?                     | Generated [`agent-capabilities.md`](agent-runtime/acceptance/agent-capabilities.md) and [`agent-capabilities.json`](agent-runtime/acceptance/agent-capabilities.json) |
| How do coding agents run fast CRUD and E2E checks?         | [`dev-cli/README.md`](dev-cli/README.md) and generated [`cli-capabilities.md`](dev-cli/acceptance/cli-capabilities.md)                                                |
| How do agents inspect and operate a mobile WebView?        | [`frontend-debug.md`](frontend-debug.md)                                                                                                                             |
| What is the current milestone policy and open work?        | [`agent-runtime/ROADMAP.md`](agent-runtime/ROADMAP.md)                                                                                                                |
| What is the design system (sand and glass)?               | [`design-system/README.md`](design-system/README.md)                                                                                                                   |
| What are the renderer dependency rules?                    | [`renderer-ui-architecture.md`](renderer-ui-architecture.md)                                                                                                          |
| How will frontend architecture and performance improve?   | [`renderer-performance/optimization-plan.md`](renderer-performance/optimization-plan.md) and [execution evidence](renderer-performance/README.md)                                    |
| How do project relation types behave?                      | [`relation-types.md`](relation-types.md)                                                                                                                              |
| What is the mobile product boundary?                       | [`mobile-ui-foundation.md`](mobile-ui-foundation.md)                                                                                                                  |
| What voice-authored source exists, and why is it still unaccepted? | [`voice-authored-capture.md`](voice-authored-capture.md)                                                                                                      |
| How do Review and editor sticky notes behave?              | [`qa/review-sticky-note-rail-2026-08-30.md`](qa/review-sticky-note-rail-2026-08-30.md)                                                                               |
| What still needs physical-device testing?                  | [`mobile-device-acceptance.md`](mobile-device-acceptance.md)                                                                                                          |
| How does Project Home and workspace entry behave?          | [`project-home.md`](project-home.md)                                                                                                                                  |
| What does the Agent organize when the author returns?      | [`agent-runtime/project-organize.md`](agent-runtime/project-organize.md)                                                                                              |
| How are prose metrics and writing stats computed?          | [`prose-metrics.md`](prose-metrics.md)                                                                                                                                |
| What is the hosted-service boundary of a source build?     | [`official-service.md`](official-service.md)                                                                                                                          |
| How was the public commit history prepared?                | [`public-history.md`](public-history.md)                                                                                                                              |

## Normative documents

- `agent-runtime/*-protocol.md`, `author-owned-writing-policy.md`, and
  `entity-snapshot-history.md` define runtime invariants.
- [`design-system/`](design-system/README.md) and `editor/*.md` define durable UI and
  editor contracts that are not obvious from a screenshot.
- [`ai-provider-settings.md`](ai-provider-settings.md) defines credential and
  provider-routing ownership.
- [`local-assets.md`](local-assets.md) and
  [`local-data-export.md`](local-data-export.md) define the current local asset
  and readable-export boundaries. The Markdown archive is not a lossless backup;
  [`library-backup.md`](library-backup.md) defines the restorable `.drifting` package.
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
- [`sync-engine/phase6-product-controls.md`](sync-engine/phase6-product-controls.md)
  points to current Hosted controls and local recovery settings.
- [`../src-tauri/UNSUPPORTED.md`](../src-tauri/UNSUPPORTED.md) defines explicit
  platform limitations.

## Evidence policy

- Generated capability files and deterministic acceptance JSON are checked-in
  machine evidence. Do not edit generated files by hand.
- Dated paid-provider, real-project, or native run reports may remain when the
  evidence cannot be reproduced in an ordinary local test run.
- Completed phase and milestone prose is not re-narrated in current documents;
  retired delivery documents and dated run reports remain recoverable from Git
  history.
- README and current-status documents link to authoritative detail instead of
  copying tool counts, test counts, or completed milestone narratives.
