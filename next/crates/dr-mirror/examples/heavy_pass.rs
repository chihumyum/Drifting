//! Times Markdown folder passes over the heavy seed (M40, 实现取舍):
//! the first projection, passes with nothing changed and a pass after one
//! outside edit, on one `Pass` as the worker keeps it.
//!
//! `cargo run --release -p dr-mirror --example heavy_pass`

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use dr_mirror::{Options, sync::Pass};
use dr_testkit::seed::{DEFAULT_SEED, Preset, generate_v3};
use dr_workspace::Workspace;

fn markdown(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            markdown(&path, out);
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

fn main() {
    let db = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(db.path(), "mirror-bench").unwrap();
    let seeded = generate_v3(Preset::Heavy, DEFAULT_SEED).unwrap();
    seeded.write_to(ws.library()).unwrap();
    seeded.write_files_to(ws.library()).unwrap();
    let mut options = Options::new(out.path(), "bench-installation", "bench-app");
    options.settle = Duration::ZERO;
    let pass = Pass::new(&ws, &options);

    let start = Instant::now();
    let first = pass.run().unwrap();
    println!(
        "first pass: {:?} ({} files written)",
        start.elapsed(),
        first.written
    );
    let mut files = Vec::new();
    markdown(out.path(), &mut files);
    files.sort();
    println!("markdown files: {}", files.len());

    for round in 1..=3 {
        let start = Instant::now();
        let report = pass.run().unwrap();
        assert_eq!(report.written, 0);
        println!("idle pass {round}: {:?}", start.elapsed());
    }

    let target = files
        .iter()
        .find(|p| fs::read_to_string(p).unwrap().contains("drifting-id: "))
        .unwrap();
    let mut text = fs::read_to_string(target).unwrap();
    text.push_str("\n外面加的一段。\n");
    fs::write(target, text).unwrap();
    let start = Instant::now();
    let report = pass.run().unwrap();
    assert_eq!(report.merged.len(), 1, "{report:?}");
    println!("pass after one outside edit: {:?}", start.elapsed());
    let start = Instant::now();
    pass.run().unwrap();
    println!("idle pass after the edit: {:?}", start.elapsed());
    ws.shutdown().unwrap();
}
