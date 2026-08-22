# Google Drive data use

Last updated: 2026-08-20

Google Drive sync is optional and does not require a Drifting account. The
official desktop Alpha requests only OpenID identity and Google Drive
`appDataFolder` access. It uses the selected Google account as cross-device
access authority and stores Drifting-owned sync objects in that account's
hidden application-data folder.

When connected, Drifting can send project names and metadata, full manuscript
content encoded as Yjs checkpoints and updates, comments, relationships,
history needed for convergence, persistent Agent memory, and original imported
images and PDFs. These objects are not end-to-end encrypted against Google.
Google and the selected account are therefore inside the trust boundary.

Drifting does not send BYOK credentials, OAuth tokens as project objects,
device UI preferences, thumbnails, caches, or unrelated Drive files. The
`appDataFolder` permission does not grant Drifting general access to documents
visible in My Drive.

Disconnecting stops synchronization, preserves every local project, and asks
the native credential path to revoke access. It is not a promise that Google
immediately erases every previously uploaded object. The author can also remove
Drifting access from their Google Account and contact Google about account data.

Fresh-device restore is automatic after signing into the same Google subject:
Drifting discovers remote projects before publishing local-only projects. A
different account is rejected during reauthorization rather than silently
replacing the current authority.

See [PRIVACY.md](../PRIVACY.md) for the full client privacy boundary and
[the trusted-cloud contract](sync-engine/trusted-cloud-google-drive.md) for the
technical protocol.
