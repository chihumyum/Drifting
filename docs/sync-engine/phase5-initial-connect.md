# Initial Hosted connection

Connection starts after Hosted authentication,
using `src/renderer/sync/hosted/connect.ts` and the shared checkpoint/restore engine.
It downloads validated cloud projects and publishes existing local projects before
one app-wide Hosted authority is activated. Retries own a durable attempt; local
writing remains available after a failed upload.

See [Hosted behavior and evidence](../hosted-sync/README.md).
