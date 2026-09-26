# Physical-device acceptance

The current [prerequisite diagnostic](acceptance/p2c-device-prerequisites.json)
records an available, paired iPhone with Developer Mode enabled and developer
services available. It does **not** record a successful installation or device
test run.

The device-target Rust build completed. The subsequent development-signed Native
Lab build failed because Xcode reported **No Accounts**. Its selected provisioning
profile also excluded the device and did not match the automatically selected
signing certificate. Local Apple Development identities and profiles exist; they
do not establish a usable authenticated Xcode account. Some other profiles cover
the device, so this is a Native Lab signing/profile gap rather than a missing
Developer Mode setting.

The next prerequisite is a usable Xcode developer-account session and a refreshed
development profile covering `cc.drifting.native-lab.ios`, the connected device,
and the chosen local signing identity. The attempt stopped without opening
Settings, modifying accounts, installing the app, or changing a production or
distribution identity.

## Reproduce the diagnostic

Private device and signing receipts stay in the ignored
`.local-data/apple-native/device-prerequisites` directory. The generator reads
`devices.json`, one `physical-<index>-details.json`, `signing-identities.log`,
`signing-profile-metadata.json`, `current-device-rust-build.log`,
`signed-device-build.log`, and `device-run-summary.log`.

```sh
node scripts/apple-device-prerequisite-diagnostic.mjs
node scripts/apple-device-prerequisite-diagnostic.mjs --check
# A different ignored receipt directory may be supplied with --input-dir=...
```

Generation asserts the actual device-query outcomes, Rust completion marker,
Native Lab device build arguments, failed build marker, and all three signing
errors. Counts come from the local identity inventory and metadata export; the
report contains only allowlisted observations and SHA-256 hashes of raw files.
Names, device identifiers, serial numbers, team/profile identifiers, certificate
names, and private filesystem paths are excluded. The stop receipt supplies the
attempt's exit status and explicitly unexecuted stages; it does not supply a
successful test result.

`--check` compares the report to local receipts when present. In a checkout
without private receipts it checks the public schema and diagnostic-generator
hash only, and says so. This attempt did not record a native source fingerprint;
the producer hash must not be interpreted as current-source runtime acceptance.

## Retry the device gate

After the account prerequisite is resolved, refresh the read-only device and
signing metadata and rebuild the current `aarch64-apple-ios` Rust bridge. Generate
the Xcode project with `xcodegen generate --spec native/apple/project.yml`.
Use an ignored `native/apple/Signing.local.xcconfig` for the local development
team, `CODE_SIGN_STYLE = Automatic`, and `CODE_SIGN_IDENTITY = Apple Development`.
The regular `apple:build:ios-device` command deliberately builds unsigned; it
does not consume that override automatically.

Run `xcodebuild` directly for `DriftingNativeIOS`, with the connected physical
destination, the ignored override via `-xcconfig`,
`DRIFTING_RUST_TARGET=aarch64-apple-ios`, `ARCHS=arm64`,
`CODE_SIGNING_ALLOWED=YES`, and development provisioning updates enabled.
Keep stdout/stderr and any device identifiers in ignored local files. If account
authentication is unavailable, retain the failure and stop rather than changing
accounts as part of the diagnostic.

Only after the signed build succeeds should `devicectl device install app` and
`devicectl device process launch` run for the synthetic Native Lab. Then run the
`DriftingNativeIOSBinding` hosted tests and `DriftingNativeIOS` UI tests against
that physical destination with separate result bundles. Record actual outcomes:
programmatic `UITextInput`, XCTest UI interaction, real OS IME composition,
physical touch, interruption recovery, and distribution are distinct evidence.
None of those device runtime gates ran in the recorded attempt.
