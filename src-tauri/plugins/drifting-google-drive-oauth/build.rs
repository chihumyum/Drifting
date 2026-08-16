const COMMANDS: &[&str] = &["authorize", "freshToken", "revoke", "handleUrl"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .try_build()
        .expect("failed to build Drifting Google Drive OAuth plugin");
}
