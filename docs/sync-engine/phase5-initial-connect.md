# Initial Hosted connection

The former Google Drive connection implementation and its OAuth capability gates
were removed on 2026-10-28. Current connection starts after Hosted authentication,
using `src/renderer/sync/hosted/connect.ts` and the shared checkpoint/restore engine.
It downloads validated cloud projects and publishes existing local projects before
one app-wide Hosted authority is activated. Retries own a durable attempt; local
writing remains available after a failed upload.

Legacy Drive libraries retain the safe local-replica adoption path, including
quarantine preservation and integrity checks, without contacting Drive.
See [Hosted behavior and evidence](../hosted-sync/README.md).
