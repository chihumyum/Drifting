//! Creates an unused acceptance profile's library from testkit lite and media.
//! Usage: cargo run -p dr-view-material --example v3-media-fixture -- <new-library>
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args_os()
        .nth(1)
        .ok_or("give a fresh library path")?;
    let root = std::path::PathBuf::from(root);
    if root.exists() {
        return Err("refusing to change an existing library".into());
    }
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test"))?;
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Lite,
        dr_testkit::seed::DEFAULT_SEED,
    )?;
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store)?;
    let ws = dr_workspace::Workspace::open(store, Default::default())?;
    let result = dr_view_material::import::import_bytes(
        &ws,
        &book,
        None,
        dr_testkit::media::png(960, 640),
        "G4 synthetic image",
    )?;
    println!(
        "{}",
        serde_json::json!({"book": book, "image": result.material})
    );
    ws.shutdown()?;
    Ok(())
}
