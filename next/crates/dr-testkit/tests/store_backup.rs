//! Whole-library backup measurement on the shared seed and real deriver.
//! Kept in dr-testkit so dr-store's dev-dependencies remain acyclic for hot reload.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use dr_store::Library;
use dr_store::asset::SourceImport;
use dr_store::backup;

const VERSION: &str = "0.2.0-test";

fn source<'a>(book: &'a str, asset: &'a str, path: &'a Path) -> SourceImport<'a> {
    SourceImport {
        book_id: book,
        asset_id: asset,
        source: path,
        mime: "image/png",
        ext: "png",
        dimensions: Some((4, 3)),
        limit: 1024,
    }
}

/// Manual measurement (run only on an idle machine): a whole-library backup
/// of a few hundred MB — the heavy seed (`DR_BACKUP_PRESET`) with its
/// derived index, plus `DR_BACKUP_ASSET_MIB` (default 200) incompressible
/// 1 MiB assets. Prints
/// each operation's time, how long the progress callback stays silent, and
/// the disk each step takes on top of the library. Everything lives in a
/// temporary folder that is removed afterwards.
/// `cargo test --release -p dr-testkit --test store_backup -- --ignored --nocapture`
#[test]
#[ignore = "manual measurement"]
fn measure_a_few_hundred_megabyte_backup() {
    use std::time::Instant;
    fn size(path: &Path) -> u64 {
        if path.is_file() {
            return fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        }
        fs::read_dir(path)
            .map(|d| d.filter_map(|e| e.ok()).map(|e| size(&e.path())).sum())
            .unwrap_or(0)
    }
    fn mib(bytes: u64) -> f64 {
        bytes as f64 / (1024.0 * 1024.0)
    }
    /// Seconds, longest silence between callbacks (from the start to the
    /// first, between any two, from the last to the end), and calls.
    fn timed<T>(f: impl FnOnce(&mut backup::ProgressFn<'_>) -> T) -> (T, f64, f64, usize) {
        let start = Instant::now();
        let mut last = start;
        let mut gap = 0f64;
        let mut calls = 0;
        let out = f(&mut |_| {
            let now = Instant::now();
            gap = gap.max((now - last).as_secs_f64());
            last = now;
            calls += 1;
            true
        });
        let end = Instant::now();
        gap = gap.max((end - last).as_secs_f64());
        (out, (end - start).as_secs_f64(), gap * 1e3, calls)
    }
    let assets_mib: usize = std::env::var("DR_BACKUP_ASSET_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let files = dir.path().join("files");
    fs::create_dir_all(&files).unwrap();
    let options = || {
        let mut o = dr_testkit::seed::library_options(VERSION);
        dr_index::attach(&mut o);
        o
    };
    let t = Instant::now();
    let lib = Library::open(&root, options()).unwrap();
    let preset = std::env::var("DR_BACKUP_PRESET")
        .ok()
        .and_then(|p| dr_testkit::seed::Preset::parse(&p))
        .unwrap_or(dr_testkit::seed::Preset::Heavy);
    let seeded = dr_testkit::seed::generate(preset, dr_testkit::seed::DEFAULT_SEED).unwrap();
    seeded.write_to(&lib).unwrap();
    lib.rebuild_stale_indexes().unwrap();
    let books: Vec<String> = lib
        .docs(None, Some("book"))
        .unwrap()
        .into_iter()
        .filter_map(|d| d.book_id)
        .collect();
    let mut rng = dr_testkit::rng::Rng::new(9);
    let blob = files.join("asset.bin");
    for i in 0..assets_mib {
        let bytes: Vec<u8> = (0..(1 << 17))
            .flat_map(|_| rng.next_u64().to_le_bytes())
            .collect();
        fs::write(&blob, &bytes).unwrap();
        let id = format!("asset-{i}");
        lib.import_asset(&SourceImport {
            limit: 2 << 20,
            ..source(&books[i % books.len()], &id, &blob)
        })
        .unwrap();
    }
    fs::remove_file(&blob).unwrap();
    lib.close().unwrap();
    let library = size(&root);
    println!(
        "library: {:.0} MiB ({:.0} MiB database, {assets_mib} assets), made in {:.0} s",
        mib(library),
        mib(size(&root.join("library.sqlite"))),
        t.elapsed().as_secs_f64()
    );

    let lib = Library::open(&root, options()).unwrap();
    let package = files.join("whole.drifting");
    let (summary, secs, gap, calls) = timed(|p| {
        lib.export_backup_with(&package, &HashMap::new(), p)
            .unwrap()
    });
    println!(
        "export: {secs:.1} s, longest silence {gap:.0} ms over {calls} calls; package {:.0} MiB \
         ({} documents, {} asset files)",
        mib(size(&package)),
        summary.documents,
        summary.asset_files
    );
    let (staged, secs, gap, calls) =
        timed(|p| backup::stage_with(&root, &package, VERSION, p).unwrap());
    println!(
        "check and stage: {secs:.1} s, longest silence {gap:.0} ms over {calls} calls; staging {:.0} MiB",
        mib(size(&root.join("restore-staging")))
    );
    lib.close().unwrap();
    let peak_before_restore = size(dir.path());
    let ((lib, outcome), secs, gap, calls) =
        timed(|p| Library::restore_staged_with(&root, &staged, options(), p).unwrap());
    let pre = outcome.pre_restore.as_deref().map(size).unwrap_or(0);
    println!(
        "restore: {secs:.1} s, longest silence {gap:.0} ms over {calls} calls; pre-restore copy {:.0} MiB",
        mib(pre)
    );
    println!(
        "disk on top of the library: {:.0} MiB before the restore (package + staging), \
         {:.0} MiB at most during it (+ the pre-restore copy)",
        mib(peak_before_restore - library),
        mib(peak_before_restore - library + pre)
    );
    lib.close().unwrap();
}
