//! How long the Markdown folder takes on dr-testkit's seeded libraries:
//! the first pass (every chapter and idea written), a pass with nothing to
//! do (and the same reading every file), and a pass merging one edited
//! file. Reference numbers only.
//!
//! ```text
//! cargo run --release -p dr-mirror --example mirror-measure -- [tiny|lite|heavy]
//! ```

use std::time::{Duration, Instant};

use dr_mirror::sync::Pass;
use dr_testkit::seed::{self, Preset};

fn main() {
    let preset = match std::env::args().nth(1).as_deref() {
        Some("tiny") => Preset::Tiny,
        Some("heavy") => Preset::Heavy,
        _ => Preset::Lite,
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options("measure")).unwrap();
    let books = seed::generate(preset, seed::DEFAULT_SEED).unwrap().books;
    for b in &books {
        seed::write_book(&lib, b).unwrap();
    }
    lib.close().unwrap();
    let ws = dr_workspace::Workspace::open_dir(&root, "measure").unwrap();
    let folder = dir.path().join("Markdown");
    let pass = Pass {
        ws: &ws,
        root: &folder,
        installation: "measure",
        app: "measure",
        settle: Duration::ZERO,
        thorough: false,
    };
    let t = Instant::now();
    let first = pass.run().unwrap();
    let first_ms = t.elapsed().as_millis();
    let t = Instant::now();
    let idle = pass.run().unwrap();
    let idle_ms = t.elapsed().as_millis();
    // Every file read and every document rendered (start-up, asked).
    let t = Instant::now();
    Pass {
        thorough: true,
        ..pass
    }
    .run()
    .unwrap();
    let thorough_ms = t.elapsed().as_millis();
    // Edit the longest file's middle paragraph.
    let mut files: Vec<_> = walk(&folder);
    files.sort_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
    let longest = files.last().unwrap().clone();
    let text = std::fs::read_to_string(&longest).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let mid = lines.len() / 2 + 3;
    let edited: String = lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            if i == mid {
                format!("{l}（改）\n")
            } else {
                format!("{l}\n")
            }
        })
        .collect();
    std::fs::write(&longest, edited).unwrap();
    let t = Instant::now();
    let one = pass.run().unwrap();
    let one_ms = t.elapsed().as_millis();
    let bytes: u64 = files
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .sum();
    println!(
        "{}: {} files, {:.1} MB; first pass {first_ms} ms ({} written); nothing to do {idle_ms} ms ({} written), reading everything {thorough_ms} ms; one edited file ({} KB) {one_ms} ms ({} merged)",
        preset.name(),
        files.len(),
        bytes as f64 / 1e6,
        first.written,
        idle.written,
        std::fs::metadata(&longest)
            .map(|m| m.len() / 1024)
            .unwrap_or(0),
        one.merged.len(),
    );
    ws.close();
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n == ".drifting") {
                continue;
            }
            out.extend(walk(&p));
        } else if p.extension().is_some_and(|x| x == "md") {
            out.push(p);
        }
    }
    out
}
