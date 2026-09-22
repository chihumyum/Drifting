# tao 0.35.3 iOS scene lifetime fix

Source: the published [tao 0.35.3 crate](https://crates.io/crates/tao/0.35.3),
archive SHA-256 `d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`.
The upstream Apache-2.0 license and attribution are retained. Cargo's local
`.cargo-ok` marker and the crate's standalone lockfile are omitted.

The only source modification is the one-line fix from
[tao#1245](https://github.com/tauri-apps/tao/pull/1245):
`configuration_for_connecting_scene_session` returns
`Retained::autorelease_ptr(config)` instead of a pointer borrowed from a local
`Retained` that is dropped on return. Without it, enabling the scene lifecycle
required by the iOS 27 SDK can crash during launch, especially in release mode.

We backport this line instead of pinning the merge commit because that commit
also differs from the published crate on other platforms. Tauri 2.11 requires
tao `^0.35`, while the fix was first released in 0.36. Remove the path patch when
the supported Tauri dependency line accepts a published crate with this fix.
Revalidate iOS cold start, foreground/background and desktop native checks then.
