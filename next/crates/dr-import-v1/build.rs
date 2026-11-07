//! Embed the published 0.1 migrations (`drizzle/`, frozen since
//! 0.1.0-alpha.1) without copying them: the importer brings an older 0.1
//! library up to the last 0.1 schema on its staging copy, exactly as the 0.1
//! client did (`crates/drifting-core/src/database.rs`). `src/schema.rs` pins
//! every file's SHA-256, so an edited migration fails the build's tests.
//! When stage 7 deletes the old client, move the files into this crate.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let drizzle = manifest.join("../../../drizzle");
    let journal_path = drizzle.join("meta/_journal.json");
    println!("cargo:rerun-if-changed={}", journal_path.display());
    let journal: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&journal_path).expect("read drizzle/meta/_journal.json"),
    )
    .expect("parse the 0.1 migration journal");
    let mut out = String::from(
        "/// `(tag, when, sql)` of every published 0.1 migration, in journal order.\n\
         pub(crate) const EMBEDDED: &[(&str, i64, &str)] = &[\n",
    );
    for entry in journal["entries"].as_array().expect("journal entries") {
        let tag = entry["tag"].as_str().expect("tag");
        let when = entry["when"].as_i64().expect("when");
        let file = drizzle
            .join(format!("{tag}.sql"))
            .canonicalize()
            .expect("migration file");
        println!("cargo:rerun-if-changed={}", file.display());
        out.push_str(&format!(
            "    ({tag:?}, {when}, include_str!({:?})),\n",
            file.display().to_string()
        ));
    }
    out.push_str("];\n");
    let dest =
        PathBuf::from(std::env::var("OUT_DIR").expect("out dir")).join("legacy_migrations.rs");
    std::fs::write(dest, out).expect("write legacy_migrations.rs");
}
