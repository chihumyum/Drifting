//! The aging suites with heap numbers, as a table.
//!
//! The `bench` program runs `chapter-aging` and `book-aging` like any other
//! suite. This example runs the same two with a counting allocator
//! installed, so the cases also say how much heap a loaded document holds
//! and what the first undo adds, and prints one line per metric instead of
//! JSON. With `--dump DIR` it also writes each chapter tier's Loro snapshot
//! to `DIR/<tier>.loro`, the input of `next/spikes/loro-undo-lab`.
//!
//! ```text
//! cargo run --release -p dr-testkit --example aging-bench -- [chapter|book] [--quick] [--out FILE] [--dump DIR]
//! ```
//!
//! Timings are measurements, never evidence: for a milestone use
//! `bench <suite> --milestone <m>`. See
//! `docs/rust-rewrite/spikes/history-aging.md`.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use dr_testkit::bench::aging::{self, HeapProbe};
use dr_testkit::bench::{Bench, Mode};
use dr_testkit::evidence::{self, Summary};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call goes straight to the system allocator; the counters
// only observe sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            if new_size >= layout.size() {
                let grown = new_size - layout.size();
                let now = LIVE.fetch_add(grown, Relaxed) + grown;
                PEAK.fetch_max(now, Relaxed);
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn print(bench: &Bench) {
    println!("# {}", bench.suite);
    for (name, case) in &bench.cases {
        println!("\n## {name}");
        for (key, value) in &case.shape {
            println!("  {key:28} {value}");
        }
        println!(
            "  {:28} {:>5} {:>10} {:>10} {:>10}",
            "ms", "n", "p50", "p95", "max"
        );
        for (metric, samples) in &case.samples_ms {
            let s = Summary::of(samples);
            println!(
                "  {metric:28} {:>5} {:>10.3} {:>10.3} {:>10.3}",
                s.n, s.p50, s.p95, s.max
            );
        }
    }
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let mode = if args.iter().any(|a| a == "--quick") {
        Mode::Quick
    } else {
        Mode::Full
    };
    if mode == Mode::Full && cfg!(debug_assertions) {
        eprintln!("aging-bench: a debug build; timings are not representative (add --release)");
    }
    aging::set_heap_probe(HeapProbe {
        live: || LIVE.load(Relaxed),
        reset_peak: || PEAK.store(LIVE.load(Relaxed), Relaxed),
        peak: || PEAK.load(Relaxed),
    });
    let which = args
        .first()
        .filter(|a| !a.starts_with("--"))
        .map(String::as_str);
    let mut out = Vec::new();
    eprintln!(
        "aging-bench: load average {:?}",
        evidence::machine()["loadAverage1m"]
    );
    if let Some(dir) = flag("--dump") {
        let n = aging::chapter_suite::dump(mode, std::path::Path::new(&dir))?;
        eprintln!("aging-bench: wrote {n} chapter snapshots to {dir}");
    }
    if matches!(which, None | Some("chapter")) {
        let mut bench = aging::chapter_suite::run(mode)?;
        bench.corpus["machineAtEnd"] = evidence::machine();
        print(&bench);
        out.push(serde_json::json!({ "corpus": bench.corpus, "results": bench.to_json() }));
    }
    if matches!(which, None | Some("book")) {
        let mut bench = aging::book_suite::run(mode)?;
        bench.corpus["machineAtEnd"] = evidence::machine();
        print(&bench);
        out.push(serde_json::json!({ "corpus": bench.corpus, "results": bench.to_json() }));
    }
    if let Some(path) = flag("--out") {
        let text = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())? + "\n";
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        eprintln!("aging-bench: wrote {path}");
    }
    Ok(())
}
