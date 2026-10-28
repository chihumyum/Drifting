fn main() {
    for variable in ["DRIFTING_HOSTED_ORIGIN"] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    tauri_build::build()
}
