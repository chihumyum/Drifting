//! The rebuild of stale indexes on open must not hold up the author's
//! typing: it writes only when no holder has written for a while, and each
//! of its transactions is one document's.
//!
//! dr-store's test, on the seeds and the real deriver (dr-index); it lives
//! here because dr-store depending on either, even for tests, would close a
//! cycle that dx's hot patching refuses (see `dr-corpus`).

use std::path::Path;
use std::time::{Duration, Instant};

use dr_store::{Library, OpenDoc, Origin};

const VERSION: &str = "0.2.0-test";

/// A library of `preset` written without a deriver (every index stale), in
/// `dir`; returns a chapter to type in.
fn stale_library(dir: &Path, preset: dr_testkit::seed::Preset) -> String {
    let lib = Library::open(dir, dr_testkit::seed::library_options(VERSION)).unwrap();
    let seeded = dr_testkit::seed::generate(preset, dr_testkit::seed::DEFAULT_SEED).unwrap();
    seeded.write_to(&lib).unwrap();
    let chapter = lib
        .docs(None, Some("node"))
        .unwrap()
        .into_iter()
        .map(|d| d.doc_id)
        .next()
        .unwrap();
    lib.close().unwrap();
    chapter
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), target).unwrap();
        }
    }
}

fn options(quiet: Duration) -> dr_store::LibraryOptions {
    let mut o = dr_testkit::seed::library_options(VERSION);
    dr_index::attach(&mut o);
    o.background_quiet = quiet;
    o
}

fn type_for(h: &dr_store::DocHandle, how_long: Duration) {
    let until = Instant::now() + how_long;
    while Instant::now() < until {
        h.write(Origin::User, |doc| {
            doc.get_text("body").insert(1, "字").unwrap();
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// While the author keeps typing, the rebuild on open writes nothing (each
/// of its transactions would make a keystroke wait); once they stop, it
/// catches up.
#[test]
fn the_rebuild_waits_while_the_author_types_and_catches_up_after() {
    let dir = tempfile::tempdir().unwrap();
    let chapter = stale_library(dir.path(), dr_testkit::seed::Preset::Tiny);
    let lib = Library::open(dir.path(), options(Duration::from_millis(1500))).unwrap();
    let stale = lib.stale_index_docs().unwrap().len();
    assert!(stale > 10, "{stale}");
    let h = lib.open_doc(&chapter, OpenDoc::Existing).unwrap();
    type_for(&h, Duration::from_secs(3));
    assert_eq!(
        lib.stale_index_docs().unwrap().len(),
        stale,
        "nothing rebuilt while the author typed"
    );
    h.close();
    let t = Instant::now();
    while !lib.stale_index_docs().unwrap().is_empty() {
        assert!(
            t.elapsed() < Duration::from_secs(60),
            "{} still stale",
            lib.stale_index_docs().unwrap().len()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    lib.close().unwrap();
}

/// A rebuild waiting for a quiet moment does not hold up closing.
#[test]
fn closing_does_not_wait_for_a_quiet_moment() {
    let dir = tempfile::tempdir().unwrap();
    let chapter = stale_library(dir.path(), dr_testkit::seed::Preset::Tiny);
    let lib = Library::open(dir.path(), options(Duration::from_secs(600))).unwrap();
    let h = lib.open_doc(&chapter, OpenDoc::Existing).unwrap();
    type_for(&h, Duration::from_millis(100));
    h.close();
    let t = Instant::now();
    lib.close().unwrap();
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// Typing right after the library opens, with and without the rebuild of
/// every stale index: one character per write, every 10 ms, either without
/// a break or in bursts of 30 with a 700 ms pause (longer than
/// `background_quiet`, so the rebuild writes in the pauses and the first
/// key of a burst can meet one of its transactions). Prints write
/// latencies; run by hand:
/// `cargo test --release -p dr-store --test rebuild -- --ignored --nocapture`.
#[test]
#[ignore]
fn measure_typing_while_stale_indexes_are_rebuilt() {
    let base = tempfile::tempdir().unwrap();
    let seeded = base.path().join("seeded");
    let chapter = stale_library(&seeded, dr_testkit::seed::Preset::Heavy);
    let mut round = 0;
    for bursts in [false, true] {
        for rebuild in [true, false, true, false] {
            round += 1;
            let root = base.path().join(format!("run-{round}"));
            copy_dir(&seeded, &root);
            let mut o = dr_testkit::seed::library_options(VERSION);
            dr_index::attach(&mut o);
            o.rebuild_indexes_on_open = rebuild;
            let lib = Library::open(&root, o).unwrap();
            let stale_before = lib.stale_index_docs().unwrap().len();
            let h = lib.open_doc(&chapter, OpenDoc::Existing).unwrap();
            let (mut waits, mut firsts) = (Vec::new(), Vec::new());
            let started = Instant::now();
            for i in 0..400 {
                if bursts && i > 0 && i % 30 == 0 {
                    std::thread::sleep(Duration::from_millis(700));
                }
                let t = Instant::now();
                h.write(Origin::User, |doc| {
                    doc.get_text("body").insert(1, "字").unwrap();
                })
                .unwrap();
                let ms = t.elapsed().as_secs_f64() * 1000.0;
                waits.push(ms);
                if bursts && i % 30 == 0 {
                    firsts.push(ms);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let typing = started.elapsed();
            let stale_after_typing = lib.stale_index_docs().unwrap().len();
            h.close();
            let t = Instant::now();
            while rebuild && lib.stale_index_docs().unwrap().len() > 1 {
                std::thread::sleep(Duration::from_millis(20));
                assert!(
                    t.elapsed() < Duration::from_secs(120),
                    "the rebuild never finished"
                );
            }
            let caught_up = t.elapsed();
            waits.sort_by(f64::total_cmp);
            firsts.sort_by(f64::total_cmp);
            println!(
                "{} rebuild={rebuild}: stale {stale_before} -> {stale_after_typing} while typing {:.1} s; \
                 write p50 {:.3} p95 {:.3} p99 {:.3} max {:.1} ms{}; caught up {:.1} s after typing stopped",
                if bursts { "bursts" } else { "steady" },
                typing.as_secs_f64(),
                percentile(&waits, 0.5),
                percentile(&waits, 0.95),
                percentile(&waits, 0.99),
                waits[waits.len() - 1],
                if bursts {
                    format!(
                        "; first key of a burst p50 {:.3} max {:.1} ms",
                        percentile(&firsts, 0.5),
                        firsts[firsts.len() - 1]
                    )
                } else {
                    String::new()
                },
                caught_up.as_secs_f64(),
            );
            lib.close().unwrap();
        }
    }
}

/// Nor does it keep a dropped library alive: while it waits for a quiet
/// moment it holds no handle, so dropping the last one (without `close`)
/// releases the library at once (dr-cli does this before writing offline).
#[test]
fn a_dropped_library_is_released_while_the_rebuild_waits() {
    let dir = tempfile::tempdir().unwrap();
    let chapter = stale_library(dir.path(), dr_testkit::seed::Preset::Tiny);
    let lib = Library::open(dir.path(), options(Duration::from_secs(600))).unwrap();
    let h = lib.open_doc(&chapter, OpenDoc::Existing).unwrap();
    type_for(&h, Duration::from_millis(100));
    h.close();
    drop(lib);
    let t = Instant::now();
    let again = loop {
        match Library::open(dir.path(), options(Duration::from_secs(600))) {
            Ok(lib) => break lib,
            Err(e) => {
                assert!(t.elapsed() < Duration::from_secs(5), "still held: {e}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    again.close().unwrap();
}
