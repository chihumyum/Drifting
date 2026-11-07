//! Editor-tier benchmarks for gpui-prose (docs/rust-rewrite/benchmarks.md).
//!
//! ```text
//! prose-bench [--builtin] [--on-top]          the full synthetic book (100 chapters, 1.5M chars)
//! prose-bench chapter [--builtin] [--on-top]  one 20k-char chapter
//!                             PROSE_BENCH_IME_LOG=1 prints every input-method call
//!                             PROSE_BENCH_PRESENT_NOW=1 draws right after each edit
//! prose-bench window [--quick] [--out FILE]   frame-level measurements in a window
//! prose-bench headless [--out FILE]           write path and cold opens, no window
//! prose-bench present [--keys N] [--out FILE] on-glass latency under Instruments (xctrace)
//! prose-bench idle [--seconds N] [--out FILE] idle CPU only (for GPUI patch comparisons)
//! prose-bench milestone [--out FILE]         milestone 1 manifest: requirements, tests, evidence
//! prose-bench check FILE...                   evidence matches sources and corpus
//! ```
//!
//! Measure with `cargo run --release -p gpui-prose --example prose-bench -- …`.

#[cfg(target_os = "macos")]
mod bench;
#[cfg(target_os = "macos")]
mod platform;
#[cfg(target_os = "macos")]
mod report;
#[cfg(target_os = "macos")]
mod shell;
#[cfg(target_os = "macos")]
mod synth;
#[cfg(target_os = "macos")]
mod trace;

/// Prints GPUI's warnings and errors to stderr (it logs through `log`).
#[cfg(target_os = "macos")]
struct StderrLog;

#[cfg(target_os = "macos")]
impl log::Log for StderrLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!(
                "[{}] {}: {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }
    fn flush(&self) {}
}

#[cfg(target_os = "macos")]
fn main() {
    let _ = log::set_logger(&StderrLog).map(|()| log::set_max_level(log::LevelFilter::Warn));
    if std::env::var_os("PROSE_BENCH_PRESENT_NOW").is_some() {
        platform::IMMEDIATE.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|ix| args.get(ix + 1))
            .cloned()
    };
    match args.first().map(String::as_str) {
        Some("window") => bench::run_window(value("--out"), flag("--quick")),
        Some("headless") => bench::run_headless(value("--out")),
        Some("idle") => bench::run_idle(
            value("--out"),
            value("--seconds")
                .and_then(|s| s.parse().ok())
                .unwrap_or(30),
        ),
        Some("present") => trace::run_present(
            value("--out"),
            value("--keys").and_then(|s| s.parse().ok()).unwrap_or(160),
        ),
        Some("trace-typing") => trace::run_traced_typing(
            flag("--present-now"),
            value("--keys").and_then(|s| s.parse().ok()).unwrap_or(160),
            value("--report"),
        ),
        Some("milestone") => bench::run_milestone(value("--out")),
        Some("check") => {
            if !bench::check(&args[1..]) {
                std::process::exit(1);
            }
            println!("evidence matches the current sources and corpus");
        }
        Some("chapter") => shell::run(false, flag("--builtin"), flag("--on-top")),
        _ => shell::run(true, flag("--builtin"), flag("--on-top")),
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("prose-bench measures on macOS only (the reference machine)");
}
