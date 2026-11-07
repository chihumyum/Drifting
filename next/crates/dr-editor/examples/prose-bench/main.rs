//! Editor-tier benchmarks: gpui-prose on Drifting's storage
//! (docs/rust-rewrite/benchmarks.md, f4-editor.md).
//!
//! The corpus is F8's heavy seed (`dr_testkit::seed`, see `corpus.rs`),
//! written into a library in a temporary directory: the book is its 100
//! chapters (about 1.65 million characters), the chapter its longest (the
//! 20k-char chapter). The editor's documents open through
//! `dr_editor::SessionSource`, as Drifting opens them.
//!
//! ```text
//! prose-bench [--builtin] [--on-top]           the whole book in a window, to type into
//! prose-bench chapter [--builtin] [--on-top]   the longest chapter
//!                              PROSE_BENCH_IME_LOG=1 prints every input-method call
//!                              PROSE_BENCH_PRESENT_NOW=1 draws right after each edit
//! prose-bench window [--quick] [--write]       frame-level measurements in a window
//! prose-bench headless [--write]               opening and the write path, no window
//! prose-bench present [--keys N] [--write]     on-glass latency under Instruments (xctrace)
//! prose-bench idle [--seconds N] [--write]     idle CPU only (for GPUI patch comparisons)
//! prose-bench decor [--write]                  frames with and without a few hundred decorations (headless)
//! prose-bench capture [DIR] [--textures DIR]   screenshots of the paint layers and block styles (headless)
//! ```
//!
//! Run with `cargo run --release -p dr-editor --example prose-bench -- …`.
//! `headless`, `decor` and `capture` run GPUI headless; `window`, `present`
//! and `idle` open a window (keep it visible: GPUI stops drawing a covered
//! window) and take over the machine for minutes.
//!
//! Each measurement prints its results as JSON; `--write` also stores them
//! as F8 evidence, `f4e-m2-prose-bench-<subcommand>.json` in
//! `docs/rust-rewrite/acceptance/` (`cargo xtask check` reports it stale
//! when an input changes). The one-minute load at the start and the end is
//! recorded; above 2 the numbers are marked reference only. What must hold
//! (a scroll reaches the end, marked text stays out of storage, …) is
//! checked on the spot: if it does not, the run exits with 1 and writes
//! nothing.
//!
//! Every run ends after `--timeout <seconds>` (exit code 3): 900 for
//! `headless` and `decor`, 600 for `capture`, 1800 for `window`, 2400 for
//! `present`, 600 + 4 × `--seconds` for `idle`; the interactive windows run
//! until quit unless given one.

#[cfg(target_os = "macos")]
mod bench;
#[cfg(target_os = "macos")]
mod corpus;
#[cfg(target_os = "macos")]
mod decor;
#[cfg(target_os = "macos")]
mod platform;
#[cfg(target_os = "macos")]
mod report;
#[cfg(target_os = "macos")]
mod shell;
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

/// Ends the process if the run takes longer than `seconds` (0: never).
#[cfg(target_os = "macos")]
fn watchdog(what: &str, seconds: u64) {
    if seconds == 0 {
        return;
    }
    let what = what.to_owned();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(seconds));
        eprintln!("prose-bench {what}: no result after {seconds} s, giving up");
        std::process::exit(3);
    });
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
    let number = |name: &str| value(name).and_then(|s| s.parse::<u64>().ok());
    let write = flag("--write");
    let sub = args.first().map(String::as_str);
    let timeout = |default: u64| {
        watchdog(
            sub.unwrap_or("book"),
            number("--timeout").unwrap_or(default),
        );
    };
    match sub {
        Some("window") => {
            timeout(1800);
            bench::run_window(write, flag("--quick"));
        }
        Some("headless") => {
            timeout(900);
            bench::run_headless(write);
        }
        Some("decor") => {
            timeout(900);
            decor::run_decor(write);
        }
        Some("capture") => {
            timeout(600);
            let dir = args
                .get(1)
                .filter(|a| !a.starts_with("--"))
                .cloned()
                .unwrap_or_else(|| "f4d-capture".into());
            decor::run_capture(dir, value("--textures"));
        }
        Some("idle") => {
            let seconds = number("--seconds").unwrap_or(30);
            timeout(600 + 4 * seconds);
            bench::run_idle(write, seconds);
        }
        Some("present") => {
            timeout(2400);
            trace::run_present(write, number("--keys").unwrap_or(160) as usize);
        }
        // The process `present` runs under Instruments.
        Some("trace-typing") => {
            timeout(300);
            trace::run_traced_typing(
                flag("--present-now"),
                number("--keys").unwrap_or(160) as usize,
                value("--report"),
            );
        }
        Some("chapter") => {
            timeout(0);
            shell::run(false, flag("--builtin"), flag("--on-top"));
        }
        None => {
            timeout(0);
            shell::run(true, flag("--builtin"), flag("--on-top"));
        }
        Some(first) if first.starts_with("--") => {
            timeout(0);
            shell::run(true, flag("--builtin"), flag("--on-top"));
        }
        Some(other) => {
            eprintln!(
                "prose-bench: unknown subcommand {other:?} (chapter, window, headless, present, idle, decor, capture; see the top of main.rs)"
            );
            std::process::exit(2);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("prose-bench measures on macOS only (the reference machine)");
}
