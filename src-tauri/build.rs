fn main() {
    for variable in [
        "DRIFTING_GOOGLE_DESKTOP_CLIENT_ID",
        "DRIFTING_GOOGLE_DESKTOP_CLIENT_SECRET",
        "DRIFTING_GOOGLE_IOS_CLIENT_ID",
        "DRIFTING_GOOGLE_IOS_REVERSED_CLIENT_ID",
        "DRIFTING_GOOGLE_ANDROID_CLIENT_ID",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    tauri_build::build()
}
