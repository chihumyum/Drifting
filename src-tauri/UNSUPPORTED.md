# Explicit Tauri migration boundaries

These limitations are surfaced deliberately. None of them silently falls back to plaintext
storage, stale prose projections, or a fake successful operation.

## General Agent

The Anthropic General Agent is unavailable. The removed implementation required a desktop-only
Node/Claude CLI process. The renderer now owns a transport-neutral protocol and reports the stable
`GENERAL_AGENT_UNSUPPORTED` error.

Future workaround: implement either a packaged desktop sidecar or an authenticated remote desktop
runner. BYOK credentials must remain on the executing client, and every prose mutation must still
pass through the live Yjs document and existing renderer use cases.

## Android secure storage

macOS, iOS, Windows, and Linux use the OS credential store through `keyring`. Android currently
has no Keystore-backed implementation, so secure-storage commands reject explicitly. There is no
plaintext preference/file fallback. Until an Android Tauri plugin backed by Android Keystore is
added, authenticated cloud mode and BYOK Copilot/Shadow credentials are unavailable on Android;
local-only projects remain usable. Login intentionally fails closed instead of keeping a bearer
token only in volatile WebView memory and presenting a misleading successful session.

## Native OAuth bearer handoff

The current native OAuth callback returns the Better Auth bearer token through the custom
`drifting://` URL scheme. A 256-bit, ten-minute, single-use renderer state now prevents unsolicited
or replayed callback acceptance, but it does not make a bearer token in a custom-scheme URL a safe
production handoff: another installed application may claim the same scheme, and URLs can surface
in platform diagnostics.

Before a public release, replace the token query parameter with a short-lived, one-time
authorization code bound to PKCE, exchange that code from the app, and prefer verified iOS
Universal Links / Android App Links over an unverified custom scheme. The server must never log or
persist the resulting bearer token during that exchange.

## Legacy WebView preferences

SQLite databases and the asset cache are migrated automatically, and existing desktop Keychain
entries retain the same `Drifting` service/key names. Chromium Local Storage/LevelDB is not copied
into Tauri WebViews: its private on-disk encoding and the new WebView origins are not a stable data
contract. Users may need to sign in again and reselect UI preferences after the upgrade. A future
transitional release could export an explicit versioned preferences JSON before installing Tauri.

## Existing Tauri database name conflicts

The one-time Electron migration never overwrites an existing valid Tauri database with the same
filename and does not merge the two databases. It preserves the Tauri copy, leaves the Electron
source untouched, and then records the completed migration. This mainly affects earlier internal
Tauri builds that created data before the migration marker existed. Back up both copies and resolve
the conflict before first launch when the Electron database should remain authoritative; automatic
row-level merging is not supported.

## Legacy local-only materials

Old `source: local` rows keep their absolute desktop path and can still be opened through the OS
when that file exists. Arbitrary legacy paths are deliberately outside Tauri's inline asset scope,
so an old image may require re-import before it can render inside the app. The referenced file also
cannot appear on iOS/Android merely by syncing the row. New image/PDF picks are copied immediately
into app-owned storage before any upload is attempted. Formats with native transform support can
then be uploaded as canonical project assets; a HEIC/HEIF/AVIF pick remains a durable app-owned
local item when thumbnail generation or canonical asset upload cannot complete. Existing
local-only items need an explicit re-import/upload flow; automatic background upload is avoided
because it would require network access and user/project authorization during data migration.

## Large material files

Image and PDF imports larger than 64 MiB are rejected before an app-owned copy is created whenever
the picker exposes reliable file metadata. Android content providers may report an unknown length,
so the bounded copy is also a final guard and removes its temporary file on rejection. This ceiling
matches the current whole-file inspection and PDF thumbnail pipeline. Future support must use a
streaming source upload plus thumbnail degradation instead of increasing the mobile in-memory read
limit.

## Image codecs

PNG, JPEG, GIF, WebP, BMP, and TIFF inspection/resizing are native. HEIC/HEIF/AVIF files can be
imported durably into app-owned storage and opened by the OS, but native transformation and the
resulting canonical project-asset upload are unavailable until a mobile-safe codec is added. PDF
first-page thumbnails use the shared renderer `pdf.js` fallback on every target.

## Mobile interaction polish

The shell supports safe areas, dynamic viewport height, touch-sized chrome, and overlay sidebars.
Complex desktop surfaces such as the story graph, split editor, and plot grid still need dedicated
touch/soft-keyboard usability passes. They are not represented as complete mobile-native UX yet.
