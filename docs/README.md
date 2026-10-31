# Drifting documentation

This directory holds Drifting's current product contracts, architecture notes,
runbooks and acceptance evidence. Current behavior is described by the
documents below; dated run reports are evidence for one checkout, not product
truth.

## Using Drifting

- [Quick start](quick-start.md)
- [Built-in sample project](sample-project.md)
- [Known issues](../KNOWN_ISSUES.md) and [support](../SUPPORT.md)
- [Release notes](releases/)
- [Project Home](project-home.md)
- [Materials](material-workbench.md): material tabs, notes, image and PDF comments
- [Element portraits](image-generation.md) (experimental)
- [Share links](share-links.md): read-only web copies and reader comments
- [Location links](location-links.md)
- [Relation types](relation-types.md)
- [Prose metrics and word counts](prose-metrics.md)
- Editor: [chapter-end menu](editor/chapter-end-menu.md),
  [entity links](editor/entity-links.md),
  [Markdown sharing](editor/markdown-sharing.md),
  [outline rail](editor/semantic-outline-rail.md),
  [split tabs](editor/split-tab-preview.md),
  [footer word count](editor/status-word-count.md),
  [element summary](editor/element-summary.md),
  [block spacing](editor/block-spacing.md),
  [title wrapping](editor/title-wrapping.md),
  [Ideas / 构想 terminology](editor/drift-terminology.md)

## Data, privacy and sync

- [Privacy boundary](../PRIVACY.md) and [security policy](../SECURITY.md)
- [Local images and PDFs](local-assets.md)
- [Manuscript export](manuscript-export.md): EPUB, PDF and Word
- [Markdown export and the automatic Markdown folder](local-data-export.md)
- [Markdown folder two-way sync](markdown-mirror.md)
- [Library backup and restore](library-backup.md): the complete `.drifting` package
- [Saving before quit](desktop-quit-persistence.md)
- [Crash and integrity reports](crash-reports.md) and
  [Sentry diagnostics](sentry-observability.md)
- [Hosted sync](hosted-sync/README.md) and
  [account settings](hosted-sync/account-settings.md)
- [Official service boundary](official-service.md)
- [SyncEngine architecture](sync-engine/README.md)

## Agent

- [Current Agent status](agent-runtime/acceptance/CURRENT_STATUS.md)
- Generated tool inventory:
  [`agent-capabilities.md`](agent-runtime/acceptance/agent-capabilities.md) and
  [`agent-capabilities.json`](agent-runtime/acceptance/agent-capabilities.json)
- [Roadmap and milestone policy](agent-runtime/ROADMAP.md)
- [Model providers and API keys](ai-provider-settings.md)
- [First Agent conversation](agent-runtime/agent-onboarding.md): connecting a model in the panel
- [Project Home check-in](agent-runtime/project-checkin.md) and
  [organize on return](agent-runtime/project-organize.md)
- [External agent access (local MCP)](agent-runtime/local-mcp.md)
- [Tool discovery](agent-runtime/tool-discovery.md)
- Runtime protocols:
  [author-owned writing](agent-runtime/author-owned-writing-policy.md),
  [context engineering](agent-runtime/context-engineering-protocol.md),
  [domain CRUD and transactions](agent-runtime/domain-crud-transaction-protocol.md),
  [durable turns and writes](agent-runtime/durable-commit-review-protocol.md),
  [long tasks](agent-runtime/long-task-execution-protocol.md),
  [providers and extensions](agent-runtime/provider-extension-protocol.md),
  [entity snapshot history](agent-runtime/entity-snapshot-history.md)
- [Headless debug bridge](agent-runtime/headless-debug.md),
  [execution control audit](agent-runtime/execution-control-audit.md),
  [prose read performance](agent-runtime/prose-read-performance.md)

## Development and release

- [Contributor quick start](contributor-quick-start.md),
  [contributing](../CONTRIBUTING.md) and [development guide](../DEV_GUIDE.md)
- [Isolated worktree development](worktree-development.md) and
  [seed workloads](development-seed-workloads.md)
- [Frontend debug bridge](frontend-debug.md)
- [Developer CLI](dev-cli/README.md) and its generated
  [capability inventory](dev-cli/acceptance/cli-capabilities.md)
- [Renderer UI architecture](renderer-ui-architecture.md)
- [Renderer performance](renderer-performance/README.md) and the
  [optimization plan](renderer-performance/optimization-plan.md)
- [Database read/write performance](database-read-write-performance.md) and
  [Rust reuse](rust-reuse-performance.md)
- [Releasing](releasing.md): GitHub Releases, signing and updates
- [Platform limitations](../src-tauri/UNSUPPORTED.md)
- Mobile (paused):
  [mobile UI foundation](mobile-ui-foundation.md),
  [device acceptance runbook](mobile-device-acceptance.md),
  [iOS Hosted integration](hosted-sync/ios.md),
  [voice-authored writing](voice-authored-capture.md) (unaccepted)

## Design system

[Design system](design-system/README.md) (sand and glass, desktop):
[materials](design-system/materials.md),
[surfaces](design-system/surfaces.md),
[typography](design-system/typography.md),
[components](design-system/components.md),
[interaction](design-system/interaction.md),
[motion](design-system/motion.md),
[workspace](design-system/workspace.md),
[acceptance](design-system/acceptance.md).

## Historical evidence

These record past work for one checkout and are not current product truth.

- [Source publication](source-publication-readiness.md) and
  [public history](public-history.md)
- [Mac Hosted acceptance, 2026-09-30](hosted-sync/native-session.md)
- [Prose metric batches](prose-metrics-performance-batches.md),
  [prose metric Rust benchmark](prose-metrics-rust-benchmark.md),
  [whole-book find benchmark](rust-book-search-benchmark.md)
- [Manual QA reports](qa/), including the
  [Review and sticky-note rail](qa/review-sticky-note-rail-2026-08-30.md) and
  the [native manual regression](qa/tauri-native-manual-regression.md)
- [Native and endurance acceptance](agent-runtime/native-endurance-acceptance.md)
- [Mobile V2 design snapshot](design/mobile-v2/README.md)
- Machine evidence in [`acceptance/`](acceptance/) and each area's `acceptance/` folder

## Evidence policy

- Generated capability files and deterministic acceptance JSON are checked-in
  machine evidence. Do not edit them by hand.
- Dated paid-provider, real-project or native run reports stay only when the
  evidence cannot be reproduced in an ordinary local test run.
- Completed phases and milestones are not re-narrated in current documents;
  retired documents remain recoverable from Git history.
- README and status documents link to the authoritative detail instead of
  copying tool counts, test counts or milestone narratives.
