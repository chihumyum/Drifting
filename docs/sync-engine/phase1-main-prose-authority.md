# Phase 1 main prose authority

Status: implemented and machine-checked for node, element, storyline, and
element-category prose.

## Frozen authority

Yjs is the only authored and mergeable authority for these four prose
families. Their SQLite `contentJson` columns remain useful local projections,
but they are never emitted as `field.set` registers and never appear in an
`entity.create` or `entity.restore` seed. Ordinary TipTap JSON owned by comments,
library text, and element patches is outside this rule and remains whole-value
LWW in protocol v1.

Every new prose owner records one deterministic full Yjs state in the same
authored SQLite transaction as its owner row and lifecycle mutation. That
transaction also advances the local Yjs revision, writes provenance, and stores
the immutable `yjs.update` mutation. UI creation, Markdown import, and Agent
structural creation all use this boundary. Restore captures and records a full
current Yjs state for incarnation `n+1` in the same restore change-set.

A checkpoint may still contain a `seed-only` body. The first closed-document
Agent write deterministically promotes that body to a complete authored Yjs
state before applying the edit; it does not continue writing the scalar as an
alternate authority.

## Projection paths

- Node content, outline, and prose metrics use `runDerivedTransaction()`.
- Element, storyline, and category `contentJson`-only updates use
  `runDerivedTransaction()`. A mixed update persists the projection locally but
  strips `contentJson` from the authored scalar payload.
- Closed-document Agent edits append their Yjs update first, then refresh the
  local projection. They do not compact update rows from a transient writer.
- Import passes the initial body into owner creation, avoiding a second scalar
  update after the owner commits.

The production remote reducer rejects a main-prose `contentJson` field register
as `domain.unsupported-field`. A prose lifecycle created or restored without
exactly one same-incarnation Yjs state update is blocked as
`yjs.lifecycle-state-count`; a semantic failure in that lifecycle bundle blocks
all effects from the incoming change-set rather than materializing a partial
owner. Accepted remote Yjs updates persist `remote`
revision provenance and deterministically refresh the local `contentJson`
projection inside the remote apply transaction.

## Machine acceptance

The focused suite covers atomic owner/Yjs persistence, rollback, projection
classification, all four restore families, remote fail-closed behavior, remote
projection, five Agent structural creation paths, checkpoint seed-only capture,
the local document session, and the UI/source architecture gate:

```text
pnpm exec vitest run \
  src/renderer/sync/journal/domain-mutation.test.ts \
  src/renderer/sync/journal/yjs-update.integration.test.ts \
  src/renderer/sync/journal/main-prose-authority.acceptance.test.ts \
  src/renderer/usecase/sync-lifecycle-restore.integration.test.ts \
  src/renderer/sync/reducer/production-domain-kernel.integration.test.ts \
  src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts \
  src/renderer/sync/checkpoint/checkpoint.integration.test.ts \
  src/renderer/services/node-prose-metrics.service.test.ts \
  src/renderer/services/yjs-document-session.test.ts \
  src/renderer/sync/app-authority-repository.integration.test.ts
```

Last observed on 2026-08-15: 10 files and 76 tests passed. Scoped ESLint and
the full TypeScript typecheck also passed. This is local/file-backed acceptance;
it does not claim real-account or physical-device Google Drive convergence.
