# Mobile V2 M8 Google Drive Settings iOS Simulator and Android Emulator acceptance — 2026-08-23

Status: **configuration/status/error UI accepted; M8 real-account physical-device
release gate remains open**

## Checkout and evidence boundary

- Baseline HEAD: `f0553f3e4ae75ee14574e71a49ff037f2c3eda57`
- Source under test: that baseline plus the current M8 Settings candidate
- Build mode: local-only native debug; no Drifting account or hosted service
- iOS transport: DEV-only renderer bridge, `inputPath=synthetic-dom`,
  `nativeInput=false`
- Android transport: Android CDP, `inputPath=cdp-webview`,
  `nativeInput=false`

No Google login, account selection, OAuth grant, real Project discovery, or
real Drive transfer was attempted. Error presentation used a one-call in-memory
replacement of `connectGoogleDrive`, threw a safe reason code plus a deliberately
sensitive-looking message, then deleted the replacement to restore the product
command. The message did not render and no native or durable authority changed.

## Reused devices and storage policy

The run reused the existing `iPhone 16e / iOS 26.1` Simulator and the existing
`Persimmon_API_35 / Android API 35` AVD as `emulator-5554`. No Simulator,
Emulator, runtime, system image, NDK, package tree, or duplicate AVD was created
or downloaded. Existing native/package build caches were retained for M9.
Free disk space remained about 33 GiB during acceptance.

## iOS Simulator matrix

In the installed native shell's 390×763 CSS-pixel portrait viewport:

1. Native capabilities advertised OAuth, Drive transport, and sync object
   staging as available. Settings rendered `已就绪` with no missing capability
   marker; Google login was enabled but not activated against Google.
2. `document.body.scrollWidth`, the Settings root, and the scrollable content
   width all remained 390px. Google and export buttons measured 44px high.
3. An injected `offline` error rendered a localized recovery title, an explicit
   statement that unpublished changes remain safe locally, and only the code
   `offline`. The injected arbitrary message containing account/path wording did
   not appear.
4. Visible Back first closed the sync detail page to the vertical Settings
   index and then returned to the Project shelf.
5. Device pixels showed safe-area top spacing, a fixed compact header, vertical
   scrolling, readable Chinese copy, and no horizontal overflow.

## Android Emulator matrix

In the installed native shell's 412×915 CSS-pixel portrait viewport:

1. Native capabilities advertised the same complete ready state. Body width
   remained 412px and the safe-area-contained content had equal client and
   scroll widths of 402px. Both action buttons measured 44px high.
2. An injected `account-mismatch` error rendered the localized same-account
   recovery action and only the safe code `account-mismatch`; the arbitrary
   injected message did not render.
3. One real `adb shell input keyevent KEYCODE_BACK` closed sync detail while
   keeping Settings open. A second system Back returned to the shelf. This is
   genuine Android AppPlugin Back evidence, not a synthetic DOM tap.
4. Device pixels showed the same ready and error states, right-edge vertical
   scrolling, portrait containment, and no horizontal overflow.

## Deterministic evidence

- 19 focused Rust Google Drive tests passed.
- 19 focused native/provider/credential/product/restore/runtime/projection
  Vitest files passed with 104 tests.
- Five M8 Settings/Back acceptance files passed with 40 tests.
- Focused M8 lint and TypeScript checks passed.

The reproducible commands, rather than these changeable counts, remain the
machine authority in the sync acceptance JSON and repository test files.

## 2026-08-24 invalid-grant repair rerun

The reused iPhone 16e Simulator received the bundled arm64-simulator archive
without deleting its app data. The native package compiled the AppAuth
`invalid_grant` classifier, launched from the installed bundle, preserved the
existing synthetic Project, and opened the portrait **同步与数据** detail through
the visible Settings controls. Safe-area spacing, the compact header, vertical
scroll ownership, configured-ready capability row, and Google Drive action
remained intact.

Five focused repair suites passed 40 tests, including the fenced blocked-
disconnect reauthorization transaction, same-account mismatch behavior,
idempotent disconnect resume, native iOS error mapping, and the one-action
**Reauthorize and disconnect** presentation contract. Focused ESLint and the
full TypeScript check passed. The existing native build cache was reused; no
new Simulator, runtime, or device image was created.

The subsequent repository-wide gate passed 318 Vitest files / 1,867 tests,
with one explicitly skipped file/test and no failure. Full ESLint completed
with existing warnings only, TypeScript passed, the public-boundary scanner
accepted 1,510 publish candidates, and the generated Agent capability evidence
plus its 18 acceptance tests remained current. Twenty focused Rust Google Drive
tests and `cargo fmt --check` also passed.

The Simulator intentionally did not create a Google grant. Exact account
selection, renewed OAuth, and remote revoke remain physical-device evidence.

## Remaining hard gate

This run does not close any real-account or physical-device release gate.
Signed physical iOS and Android devices plus Desktop still must pass connect,
refresh/restart, same-account reauthorize, mismatch, SDK-state loss, revoke,
automatic discovery, Project convergence, assets, outbox, deletion, recovery,
concurrency, background/force-stop, quota/resume, and multi-Project isolation.
The report must identify exact build SHAs while omitting credentials, account
identifiers, signing material, and private Project data.

## Cleanup boundary

The exact debug app installations, screenshots, frontend-debug runs, and
temporary logs are task-created and are removed after documentation and code
checks. The two reused devices are shut down. Existing runtimes, AVD definition,
system images, NDK, dependency tree, and reusable build caches are retained.
