# Google Drive three-platform physical acceptance

Status: **READY TO RUN — signed iOS/Android devices and real accounts required**

This is the executable Mobile V2 M8 hard-gate runbook. It combines the existing
desktop two-Mac matrix with signed physical iOS and Android behavior. A
Simulator, Emulator, fake provider, successful build, or prior single-machine
desktop run can support diagnosis but cannot pass any physical row here.

The machine contract is
[`google-drive-physical-evidence-contract.json`](google-drive-physical-evidence-contract.json).
Start from
[`google-drive-physical-evidence.template.json`](google-drive-physical-evidence.template.json),
but keep the working report and raw evidence outside the repository until every
row passes. The validator accepts no free-form notes or identifiers, requires an
evidence digest for every passed row, and fails closed on credential, account,
URL, and local-path shapes.

## Required lab

- one physical Mac running Desktop, one signed physical iPhone, and one signed
  physical Android phone;
- an additional fresh target for automatic discovery: preferably a second Mac,
  otherwise a fully isolated fresh Desktop installation on different physical
  hardware;
- one disposable production Google account for the matrix and a second
  disposable account used only to prove mismatch rejection;
- three synthetic Projects `A`, `B`, and `C`, each with unique synthetic
  canaries in prose, outline fields, relations, order, storyline, timeline,
  image/PDF assets, and Plot Grid;
- three artifacts produced from the same exact source commit, with artifact
  SHA-256, app version, OS version, signing status, and physical-device status
  recorded in the sanitized report.

Do not use a personal manuscript, personal Google account, production user
database, or a Project copied from the private official service. Do not record
an operator name, email, Google subject, client ID, credential reference,
token, provider URL/payload, signing identity, device serial, or absolute path.

## Evidence setup

1. Create a small working directory outside the repository. Copy the JSON
   template into it. Store screenshots, screen recordings, sanitized
   diagnostics, and canonical count/hash summaries there; never copy raw
   databases, provider payloads, or logs containing native paths.
2. Record the candidate source commit and hash each exact signed artifact with
   the platform's SHA-256 tool. The report stores only those hashes, not artifact
   locations or signing identities.
3. For each scenario, hash one or more sanitized supporting files. Put only the
   64-character lowercase digest in `evidenceSha256`. A `pass` without a digest
   is rejected.
4. Run the privacy and completeness check after every update:

   ```bash
   pnpm mobile:google-drive:acceptance -- <sanitized-report.json>
   ```

   The command succeeds only when all 40 rows pass on signed physical artifacts
   from one non-placeholder source commit. It prints a row count only; it does
   not echo report contents or the input path. During preparation,
   `pnpm mobile:google-drive:acceptance:contract` verifies the tracked open
   template without making a release claim.

## Phase A — identity, connect, refresh, and discovery

1. Start with an empty Drive app-data scope and fresh local Drifting state on
   the discovery target. On Desktop connect the matrix account. Confirm the
   visible action stays pending through discovery and ends in connected state.
   Pass `oauth.connect.desktop`.
2. Connect the same account on iOS and Android through the official system SDK
   UI. Confirm Settings never displays an account identifier or token and
   reaches connected state only after discovery. Pass `oauth.connect.ios` and
   `oauth.connect.android`.
3. Create Project `A` on Desktop and wait for a quiet outbox. On each fresh
   target, connect the same account without importing or entering a recovery
   code. Confirm `A` appears once and opens with matching canonical
   SQLite/Yjs/asset counts and hashes. Pass all three `discovery.fresh-device.*`
   rows.
4. Quit Desktop with `Cmd+Q`, terminate iOS from the app switcher, and force-stop
   Android from system Settings. Relaunch after the current access token would
   require SDK/native refresh, trigger sync, and confirm no account picker or
   duplicate Project. Pass all three `oauth.refresh-after-restart.*` rows.
5. Explicitly reauthorize on every platform with the same account. Then choose
   the second disposable account while the first authority is still owned.
   Same-account reauthorization must succeed; different-account selection must
   fail closed without replacing the credential, clearing local Projects, or
   publishing to the second account. Pass all six reauthorization/mismatch
   rows.
6. On iOS and Android, remove or revoke the system SDK account outside Drifting
   while its opaque binding remains, then relaunch and sync. The app must show
   actionable reauthorization and must not silently create a new binding. Pass
   `oauth.sdk-state-loss.ios` and `.android` only after recovery with the same
   account succeeds.
7. Disconnect and revoke from Drifting on each platform. Local Projects must
   remain editable; reconnecting must require authorization and must rebind the
   existing current generation without a second genesis or duplicate Project.
   Pass all three `oauth.revoke.*` rows.

   If disconnect fails, copy a format-v2 sanitized diagnostic before resetting
   or reinstalling anything. `sync.googleDriveOperationTraces` must show the
   ordered renderer/native phases plus only allowlisted domain families,
   numeric codes, normalized reasons, HTTP status, and elapsed time. It must
   not contain raw error text, `NSError.userInfo`, a URL, token, account
   subject, email, absolute path, manuscript content, or exported trace ID.
   Retry the same durable attempt once with the diagnostic build; do not mark
   the revoke row passed merely because a Simulator build or error mapping test
   succeeds.

## Phase B — three-platform convergence and lifecycle

1. Populate Projects `A`, `B`, and `C` with unique synthetic canaries. In `A`,
   make concurrent Desktop/iOS/Android edits to prose, scalar fields, relations,
   order, storyline placement, timeline, and Plot Grid. After quiet, compare
   canonical per-Project counts and content/asset hashes. Pass
   `sync.three-platform-convergence`, `sync.prose-fields-relations-order`, and
   `sync.concurrent-edits` only when all devices agree.
2. Import one valid image, one PDF, and a synthetic incompressible asset near
   64 MiB. Interrupt upload and download by backgrounding, force-stopping, and
   temporary network loss. Resume without reimporting; bytes and hashes must
   match on all platforms, with no duplicate provider object or permanent
   receipt. Pass `sync.assets` and `sync.large-asset-resume`.
3. While work is queued, quit Desktop, terminate iOS, and force-stop Android.
   Relaunch each and prove durable outbox continuation. Repeat with iOS lock and
   background, Android lock and background, and Desktop sleep/wake. Pass
   `sync.outbox-restart`, both `sync.background-lock.*` rows,
   `sync.sleep-wake.desktop`, and both `sync.force-stop-recovery.*` rows.
4. Put all three platforms offline, edit distinct parts of `A`, delete a
   different synthetic entity on each, then reconnect in Android → Desktop →
   iOS order. Repeat with a Project deletion while disconnected. Convergence
   must preserve authored changes, apply the deletion exactly once, and never
   restore a purged historical generation. Pass `sync.offline-reconnect`,
   `sync.deletion`, and the relevant recovery row.
5. Continuously sync all three Projects while rapidly switching
   `A → B → C → A` at least ten times on every platform. No visible surface may
   mix another Project's outline, editor, relations, Super View, or timeline.
   Pass `sync.multi-project-isolation` and `sync.project-switch-under-load`.
6. Open different papers/tabs on each device, restart, and confirm local session
   state survives only on its originating device. Pass
   `sync.device-local-tabs`.

## Phase C — real-provider errors and final integrity

1. Using only the disposable account, safely produce a genuine provider quota
   refusal without generating a large repository or simulator cache. Confirm
   the bounded local outbox remains recoverable after quota is released. Pass
   `errors.quota`; a fake-provider quota result is insufficient.
2. Exercise genuine provider throttling and a transient provider/server failure
   with bounded synthetic objects. The visible category must be actionable,
   retries must honor backoff, and the queue must recover without manual data
   reset. Pass `errors.rate-limit` and `errors.server`; deterministic injection
   is supporting evidence only.
3. Repeat at least two complete edit/offline/restart rounds. Recompute every
   canonical Project/Yjs/asset hash and verify no lost prose/assets, duplicate
   Project, silent conflict discard, cross-Project row, permanent queue stall,
   token/UI disclosure, or private-data evidence. Pass
   `integrity.no-loss-or-duplicates`.

Any failed or not-run row keeps M8 open. Preserve the sanitized report and raw
evidence outside the repository for audit; only a validator-passing report may
be considered for durable repository evidence. Device availability, account
consent, signed artifacts, and real quota/throttling responses cannot be
substituted by code or Simulator automation.
