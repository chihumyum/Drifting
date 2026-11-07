//! Importing a Drifting 0.1.x library into 0.2 (module M10).
//!
//! The 0.2 program has no Yjs. It reads the 0.1 library's SQLite directly:
//! every authored table, the prose caches (`contentJson`) and the evidence of
//! how fresh each cache is, including the handoff stamp the last 0.1 release
//! writes (`docs/v2-handoff.md`). Plan and mapping:
//! `docs/rust-rewrite/modules/m10-import.md`.
//!
//! - [`locate`]: the 0.1 libraries on this device (the 0.1 registry rules);
//! - [`staging`]: the read-only copy the import works on, migrated up to the
//!   last 0.1 schema with [`schema`] (the frozen 0.1 migrations);
//! - [`tables`]: where each of the 100 old tables goes;
//! - [`time`]: 0.1 timestamps.
//!
//! The original library is never written: everything reads the staging copy.

pub mod anchors;
pub mod book;
pub mod error;
pub mod gate;
pub mod handoff;
pub mod legacy;
pub mod locate;
pub mod prose;
pub mod receipt;
pub mod run;
pub mod schema;
pub mod staging;
pub mod tables;
pub mod time;

pub use error::{ImportError, Result};

/// SHA-256 over this crate's sources and the 0.1 fixture generator: the
/// measurement evidence (`docs/rust-rewrite/acceptance/m10-import.json`)
/// records it, and is reported stale (not failed) when it no longer matches.
pub fn source_fingerprint() -> String {
    use sha2::{Digest, Sha256};
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<std::path::PathBuf> = vec![
        crate_dir.join("Cargo.toml"),
        crate_dir.join("build.rs"),
        crate_dir.join("../../../src/renderer/services/v2-handoff/m10-fixtures.test.ts"),
    ];
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
    }
    walk(&crate_dir.join("src"), &mut files);
    let mut keyed: Vec<(String, std::path::PathBuf)> = files
        .into_iter()
        .map(|p| {
            let rel = p
                .strip_prefix(crate_dir)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| p.to_string_lossy().into_owned());
            (rel, p)
        })
        .collect();
    keyed.sort();
    let mut h = Sha256::new();
    for (rel, p) in keyed {
        h.update(rel.as_bytes());
        h.update([0]);
        h.update(std::fs::read(&p).unwrap_or_default());
        h.update([0]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
