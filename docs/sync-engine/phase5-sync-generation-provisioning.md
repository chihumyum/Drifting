# Phase 5 post-connect Project provisioning

Status: **the current contract provisions projects without blocking local
editing; real-account/device acceptance remains open**.

The product and every user-visible surface call this unit a Project.
`SyncGeneration` is the technical name for its current immutable-log generation.

Creating a project never waits for OAuth or provider I/O. Its authored SQLite
transaction creates the local Project, its SyncGeneration, journal, and,
when Google Drive authority is already active, a pending provider binding. The
project remains fully editable while provisioning runs.

```text
local Project + pending binding
  -> flush/capture genesis
  -> publish required blobs -> package -> commit marker
  -> ready binding -> sync:authority-changed
```

There is no application-managed Project content key or separate recovery
object. Google Drive can process the plaintext SyncEngine objects. HTTPS,
hash/size/schema validation, deterministic
logical identity, marker-last visibility, durable transfer receipts, and
response-loss reconciliation remain required integrity controls.

Only `ready` bindings mount the network runtime. The foreground provisioner is
single-flight, restart-safe, and retryable; transient failures use bounded
backoff. A binding becomes ready only after its genesis commit marker has a
durable published receipt. Network operations never execute inside SQLite
transactions.

Current provisioning evidence is
[`acceptance/phase5-sync-generation-provisioning.json`](acceptance/phase5-sync-generation-provisioning.json),
under the top-level
[`trusted-cloud contract`](acceptance/trusted-cloud-google-drive-contract.json).
