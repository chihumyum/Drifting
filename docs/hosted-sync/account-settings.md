# Hosted account settings

The Tauri Account settings panel edits the Hosted display name and avatar and
changes the password. The local library identity, project ownership and sync
generations do not change. Source-default local-only builds cannot dispatch
these account requests. No retired account formats or compatibility adapters
are introduced.

## Profile contract v1

Authenticated `POST /api/auth/update-user` accepts only `name` and `image`.
Names are trimmed and must contain 1–80 UTF-16 code units. `image: null` removes
the avatar; omitted fields remain unchanged. Email, account ID and verification
state cannot be edited here.

The file picker accepts JPG, PNG and WebP up to 5 MiB. Selecting an image opens
a crop dialog with the original image: drag or use arrow keys to move it and
adjust the zoom slider. The preview stays within the image bounds. Confirming
encodes the selected region as a 256 × 256 JPEG, discarding source metadata;
Cancel leaves the previous avatar draft unchanged. Save profile publishes the
confirmed draft. Closing the dialog releases its temporary preview URL.
The profile carries a JPEG data URL capped at 128 KiB of image bytes. The
service validates the name, fields, encoding and byte limit. It stores the image
in the existing account profile; no public asset URL, external image fetch or
database migration is needed. SVG and remote URLs are not accepted as avatars.

Saving updates the account store, session display metadata and the origin-scoped
offline profile cache. The bookshelf, user menu, project titlebar and settings
rail use that profile. Avatar removal restores the name initial. Other active
clients see the new profile on their next session refresh. A failed save retains
the saved profile and editable draft; Cancel discards local edits.

## Password and session behavior

Account settings shows a Change password button. Its dialog contains the
current, new and confirmation fields; Cancel, backdrop dismissal or Escape
discards them without changing the password. The dialog owns keyboard focus and
Escape, then returns focus to its trigger. During submission dismissal is
disabled; a server rejection keeps the dialog open with an error, and success
closes it with a confirmation in settings.

`POST /api/auth/change-password` verifies `currentPassword` and accepts an
8–128-character `newPassword`. The UI confirms it, preserves whitespace and
rejects an unchanged password. It sends `revokeOtherSessions: true`: other
devices must sign in again, and this device receives a replacement bearer token.
Passwords remain only in form/request memory and are cleared after submission;
they never enter settings, profile caches or application logs.

The client stores and verifies the replacement session before rebinding sync.
If this fails after the password was changed, the UI explicitly asks for a new
sign-in with the new password; it never restores the revoked token. Delayed
responses cannot reauthenticate after logout. Profile mutations drain older
session refreshes. An in-flight sync rejection waits for an account mutation
and expires only the token that request used; a rotated session retries sync.

## Acceptance

`pnpm hosted:acceptance` regenerates the HTTP/SQLite client report, including
account mutation, credential race, offline profile and avatar input tests.
`node scripts/run-hosted-account-ui.mjs` regenerates
[browser evidence](acceptance/account-ui.json) for the actual React dialogs,
focus/dismissal behavior, pointer/keyboard crop adjustment and selected output
pixels with synthetic account actions; append `--check` to verify its source
fingerprint. Screenshots are kept in ignored local acceptance output.

The private service's own acceptance validates authenticated profile updates,
cross-session visibility and removal, invalid field/image rejection, unchanged
ownership, wrong/old-password rejection, bearer rotation, other-device revocation
and subsequent sync access over real HTTP/PostgreSQL. Service source remains in
that separate repository.

Browser forms, local service acceptance, native interaction and deployment are
separate gates. These reports do not claim a production deployment or native
file-picker/Keychain acceptance.
