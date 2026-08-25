# Phase 3 App provider authority

Drifting has one App-wide sync provider authority. A project cannot select a
provider independently, and a cloud provider cannot coexist with local mode.
`src/renderer/sync/app-authority-repository.ts` is the production SQLite owner
of that boundary.

## Durable transition

Provider network work happens before activation. Starting a transition creates
one `sync_connect_attempt` plus one `sync_connect_generation_attempt` for every
active Project SyncGeneration and moves `sync_app_authority` into a non-stable
state. OAuth
access and refresh tokens never enter the renderer or SQLite; the attempt only
stores the account subject and an opaque native secure-storage reference.

Each project independently captures or restores its target checkpoint and records
the already-persisted remote commit marker. Activation then performs one SQLite
transaction:

1. verify every SyncGeneration has a durable commit marker (disconnect is the only
   marker-free target);
2. for a provider switch, retire every source SyncGeneration and activate its
   staged, same-ProjectSync `generationNumber + 1` target;
3. seal every per-project activation receipt and complete the global attempt;
4. remove the old provider cursor/bindings/account;
5. increment App authority generation exactly once;
6. install exactly one target account and one binding for every active project.

Any missing SyncGeneration, binding, marker, target generation, or account identity
rolls the entire transaction back. A blocked attempt remains resumable. A
cancelled provider switch retires its never-activated staged generations, preserving
the immutable attempt history.

Disconnect removes only provider cursor/account/binding state. It does not
delete the local project, SQLite journal, Yjs state, assets, or internal sync
identity. Drive to Hosted never mirrors two providers: it creates a new sync
generation through a checkpoint and switches all projects together.

## Runtime handoff

`listActiveRuntimeBindings()` exposes only provider-neutral `ProviderBinding`
values: `syncGenerationId`, account subject, authority generation and
opaque credential reference. It returns no bearer token, refresh token,
resumable session URI, or filesystem path. The durable engine may mount these bindings only while the authority is
stable and the individual binding is `ready`. Paused, reauth, update-blocked,
corruption-blocked, connecting, and genesis-publishing bindings are not runtime
registrations. An in-progress transition continues to use the current provider
until the final activation transaction commits.

## Machine acceptance

Run:

```bash
pnpm exec vitest run src/renderer/sync/app-authority-repository.integration.test.ts
```

The file-backed SQLite suite covers two-project Drive activation, exact binding
completeness and rollback, disconnect with cursor cleanup/local-data retention,
Drive-to-Hosted generation replacement, blocked/resume state, foreign keys and
integrity.

This phase does not itself make Google Drive selectable in Settings. The
production remote domain materializer
(`src/renderer/sync/reducer/production-domain-kernel.ts`, injected by
`src/renderer/sync/production-runtime.ts`) and account-scoped project discovery
(`src/renderer/sync/providers/google-drive/project-snapshot-discovery.ts`) have
since been delivered; product mounting now waits only on the platform-specific
OAuth release gates documented by later phases.
