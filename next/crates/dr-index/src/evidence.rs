//! The measurement evidence's source fingerprint (`dr-index-bench`,
//! `docs/rust-rewrite/acceptance/dr-text-index-m1.json`): SHA-256 over the
//! crates measured (dr-index, dr-text, prose-metrics) and the bench with its
//! corpus generator. A changed source reports the evidence as stale, not
//! failed (`simplifications.md`, section five). Not part of the index API.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
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

pub fn source_fingerprint() -> String {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for name in ["dr-index", "dr-text", "prose-metrics"] {
        let dir = crates.join(name);
        files.push(dir.join("Cargo.toml"));
        walk(&dir.join("src"), &mut files);
    }
    walk(&crates.join("dr-index/examples"), &mut files);
    let mut keyed: Vec<(String, PathBuf)> = files
        .into_iter()
        .map(|p| {
            let key = p
                .strip_prefix(&crates)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            (key, p)
        })
        .collect();
    keyed.sort();
    let mut h = Sha256::new();
    for (key, path) in keyed {
        h.update(key.as_bytes());
        h.update([0]);
        h.update(std::fs::read(&path).unwrap_or_default());
        h.update([0]);
    }
    format!("{:x}", h.finalize())
}
