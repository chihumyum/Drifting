# Contributor quick start

The source client runs locally without a Drifting service account, Google OAuth
configuration, BYOK key, maintainer certificate or `.env.local`. Configure your
own providers only when developing optional network features.

## Tools

- Node.js 22.23.1 or newer and pnpm 10.17.1.
- Rust 1.88 or newer and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
- On macOS: full Xcode, its command-line tools, and your own Apple Development
  certificate **with its private key**. The launcher checks revocation online.
  A Developer ID distribution certificate and a maintainer's team are not needed.

The supported Alpha target is macOS 13+ on Apple Silicon. Windows/Linux can run
source checks but are not currently release-supported targets.

## Set up macOS signing once

1. Open Xcode and finish its requested component setup. Select that Xcode in
   Settings → Locations → Command Line Tools.
2. In Xcode Settings → Apple Accounts, sign in with your own Apple Account and
   select your team. Apple provides a Personal Team for accounts without paid
   program membership; available capabilities remain subject to Apple.
3. Open Manage Certificates, click **+**, and create **Apple Development**.
   Keep the private key on this Mac. Copying only a `.cer` does not copy its key.
4. After installing project dependencies, run `pnpm dev:check`.

See Apple's [certificate creation](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html)
and [Personal Team documentation](https://developer.apple.com/help/account/basics/about-your-developer-account).
Do not export or commit your signing material to contribute to Drifting.

## Install and run

From a clean clone:

```bash
pnpm install --frozen-lockfile
pnpm dev:check
pnpm dev
```

On macOS, `pnpm dev` checks signing **before starting Cargo/Vite**. It pins the
verified identity for the runner, which checks it again immediately before
launch. Local builds use the same requirement. Debug data defaults to the
checkout's ignored `.local-data/databases` directory.

These checks work without an Apple certificate and do not launch the native app:

```bash
pnpm typecheck
pnpm test
pnpm security:dependencies
```

`pnpm perf:renderer --ci` additionally needs installed Google Chrome/Chromium;
set `DRIFTING_PERF_CHROME` to its executable if automatic detection fails.
It uses a disposable headless browser profile and synthetic documents.

## If signing fails

| Symptom | Next step |
| --- | --- |
| No Apple Development identity/private key | Create a development certificate in Xcode on this Mac; confirm its private key is present in Keychain Access. |
| Certificate is revoked/expired | Renew your own development certificate in Xcode and rerun `pnpm dev:check`. |
| OCSP verification fails | Check network access, system date and certificate status, then retry. Revocation checking remains required. |
| An old identity is explicitly pinned | Update or remove `DRIFTING_MACOS_DEV_SIGNING_IDENTITY` in your shell/ignored `.env.local`. An explicit pin never silently selects another certificate. |
| Google Drive is unavailable | Local editing still works. Optional Drive development requires your own Google OAuth client; see `.env.example`. |

No automatic ad-hoc fallback is introduced: it changes app/credential identity
and does not validate the existing secure-storage behavior. Signed distribution,
native keyboard/microphone and real-account sync acceptance remain separate.
