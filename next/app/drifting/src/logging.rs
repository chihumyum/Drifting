//! A stderr logger, so GPUI's own `log` warnings and errors (a font that did
//! not load, a shader that did not compile) are not silently dropped. F7
//! replaces it with `tracing` and log files.
//!
//! `DRIFTING_LOG=error|warn|info|debug|trace` sets the level (default `warn`).

use log::{LevelFilter, Log, Metadata, Record};

pub const LOG_ENV: &str = "DRIFTING_LOG";

struct StderrLogger;

impl Log for StderrLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{} {}] {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

pub fn init() {
    let level = parse_level(std::env::var(LOG_ENV).ok().as_deref());
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(level);
    }
}

fn parse_level(value: Option<&str>) -> LevelFilter {
    value
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(LevelFilter::Warn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_level_defaults_to_warn() {
        assert_eq!(parse_level(None), LevelFilter::Warn);
        assert_eq!(parse_level(Some("nonsense")), LevelFilter::Warn);
        assert_eq!(parse_level(Some("debug")), LevelFilter::Debug);
        assert_eq!(parse_level(Some(" info ")), LevelFilter::Info);
    }
}
