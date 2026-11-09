// The unbundled `cargo xtask dev` executable needs a privacy description too.
// The packaged app uses script/bundle-mac's Info.plist. Neither changes F7's
// development identity or the isolated worktree library/keychain profile.
// Apply to debug/release/dist alike, only to the macOS app executable and the
// opt-in debug-bridge acceptance examples, not to library/CLI targets. No
// Hardened Runtime or permission grant is enabled here.
fn main() {
    println!("cargo:rerun-if-changed=resources/microphone.plist");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let root = std::env::var("CARGO_MANIFEST_DIR").expect("manifest directory");
        println!(
            "cargo:rustc-link-arg-bin=drifting=-Wl,-sectcreate,__TEXT,__info_plist,{root}/resources/microphone.plist"
        );
        // The existing agent-acceptance host can exercise native capture with
        // loopback ASR + memory keys for the author's permission-only hand test.
        // Its automatic scenario never opens an input device.
        if std::env::var_os("CARGO_FEATURE_DEBUG_BRIDGE").is_some() {
            println!(
                "cargo:rustc-link-arg-examples=-Wl,-sectcreate,__TEXT,__info_plist,{root}/resources/microphone.plist"
            );
        }
    }
}
