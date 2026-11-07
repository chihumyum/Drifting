//! Spike P0-B probe shell.
//!
//! ```text
//! prose-spike [--builtin] [--on-top]          the full synthetic book (100 chapters, 1.5M chars)
//! prose-spike chapter [--builtin] [--on-top]  one 20k-char chapter
//!                             PROSE_SPIKE_IME_LOG=1 prints every input-method call
//!                             PROSE_SPIKE_PRESENT_NOW=1 draws right after each edit
//! prose-spike window [--quick] [--out FILE]   frame-level measurements in a window
//! prose-spike headless [--out FILE]           write path and cold opens, no window
//! prose-spike check FILE...                   evidence matches sources and corpus
//! prose-spike input-source [ID]               print / select an enabled input source
//! ```
//!
//! Measure with `cargo run --release -p prose-spike -- …`.

mod bench;
mod platform;
mod report;
mod shell;
mod synth;

/// Prints GPUI's warnings and errors to stderr (it logs through `log`).
struct StderrLog;

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

fn main() {
    let _ = log::set_logger(&StderrLog).map(|()| log::set_max_level(log::LevelFilter::Warn));
    if std::env::var_os("PROSE_SPIKE_PRESENT_NOW").is_some() {
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
        Some("check") => {
            if !bench::check(&args[1..]) {
                std::process::exit(1);
            }
            println!("evidence matches the current sources and corpus");
        }
        Some("input-source") => {
            // Print the current input source, or select an enabled one by id.
            if let Some(id) = args.get(1)
                && !platform::input_source::select(id)
            {
                eprintln!("no enabled input source {id}");
                std::process::exit(1);
            }
            println!("{}", platform::input_source::current());
        }
        Some("chapter") => shell::run(false, flag("--builtin"), flag("--on-top")),
        _ => shell::run(true, flag("--builtin"), flag("--on-top")),
    }
}
