//! Logs through `tracing`.
//!
//! - **Development** (`cargo run`, or any build outside an installed bundle):
//!   stderr, `warn` by default.
//! - **Installed** (inside a `.app`, or next to the NSIS uninstaller): a file
//!   per day in the platform's log folder (`paths`), the last 14 kept, `info`
//!   for Drifting's own crates and `warn` for everything else.
//!
//! `DRIFTING_LOG` overrides the level for both, in `tracing`'s target syntax
//! (`debug`, or `warn,dr_platform=trace`); setting it also turns stderr on in
//! an installed build. `DRIFTING_LOG_FILE=1` writes the file in development
//! too.
//!
//! GPUI reports fonts, shaders and windows that failed only through the
//! `log` crate (P0-A), so `log` records are forwarded into `tracing` and land
//! in the same outputs.

use std::path::{Path, PathBuf};
use std::str::FromStr as _;

use tracing::level_filters::LevelFilter;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{Layer as _, fmt};

pub const LOG_ENV: &str = "DRIFTING_LOG";
pub const LOG_FILE_ENV: &str = "DRIFTING_LOG_FILE";
/// Days of files kept.
pub const MAX_LOG_FILES: usize = 14;
const FILE_PREFIX: &str = "drifting";
const FILE_SUFFIX: &str = "log";

const STDERR_DEFAULT: &str = "warn";
const FILE_DEFAULT: &str = "warn,drifting=info,dr_platform=info";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogConfig {
    /// `None` keeps stderr quiet.
    pub stderr: Option<String>,
    /// The folder and the filter of the daily files.
    pub file: Option<(PathBuf, String)>,
}

impl LogConfig {
    pub fn for_build(log_dir: Option<&Path>) -> Self {
        Self::from_parts(
            installed(),
            std::env::var(LOG_ENV).ok().filter(|v| !v.trim().is_empty()),
            std::env::var(LOG_FILE_ENV).is_ok_and(|v| v == "1"),
            log_dir,
        )
    }

    fn from_parts(
        installed: bool,
        override_filter: Option<String>,
        file_in_development: bool,
        log_dir: Option<&Path>,
    ) -> Self {
        let stderr = if installed {
            override_filter.clone()
        } else {
            Some(
                override_filter
                    .clone()
                    .unwrap_or_else(|| STDERR_DEFAULT.into()),
            )
        };
        let file = (installed || file_in_development)
            .then_some(log_dir)
            .flatten()
            .map(|dir| {
                (
                    dir.to_path_buf(),
                    override_filter.unwrap_or_else(|| FILE_DEFAULT.into()),
                )
            });
        Self { stderr, file }
    }
}

/// Whether this process runs from an installed copy.
pub fn installed() -> bool {
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    if cfg!(target_os = "macos") {
        crate::update::install::bundle_of(&executable).is_some()
    } else {
        executable
            .parent()
            .is_some_and(|dir| dir.join("uninstall.exe").is_file())
    }
}

/// Where the subscriber writes, for Settings › About and feedback.
#[derive(Debug)]
pub struct Logging {
    pub log_dir: Option<PathBuf>,
}

fn parse(filter: &str) -> Targets {
    Targets::from_str(filter.trim())
        .unwrap_or_else(|_| Targets::new().with_default(LevelFilter::WARN))
}

fn most_verbose(targets: &Targets) -> LevelFilter {
    targets
        .iter()
        .map(|(_, level)| level)
        .chain(targets.default_level())
        .max()
        .unwrap_or(LevelFilter::OFF)
}

/// Installs the global subscriber. Call once, right after `crash::init`.
pub fn init(config: &LogConfig) -> Logging {
    let stderr_filter = config.stderr.as_deref().map(parse);
    let file = config.file.as_ref().and_then(|(dir, filter)| {
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(FILE_PREFIX)
            .filename_suffix(FILE_SUFFIX)
            .max_log_files(MAX_LOG_FILES)
            .build(dir)
            .ok()?;
        Some((dir.clone(), appender, parse(filter)))
    });

    let max_level = stderr_filter
        .iter()
        .chain(file.as_ref().map(|(_, _, filter)| filter))
        .map(most_verbose)
        .max()
        .unwrap_or(LevelFilter::OFF);

    let stderr_layer = stderr_filter.map(|filter| {
        fmt::layer()
            .with_writer(std::io::stderr)
            .with_target(true)
            .with_filter(filter)
    });
    let log_dir = file.as_ref().map(|(dir, _, _)| dir.clone());
    let file_layer = file.map(|(_, appender, filter)| {
        fmt::layer()
            .with_writer(appender)
            .with_ansi(false)
            .with_target(true)
            .with_thread_names(true)
            .with_filter(filter)
    });

    let installed = tracing_subscriber::registry()
        .with(stderr_layer)
        .with(file_layer)
        .try_init()
        .is_ok();
    if installed {
        // `log` records (GPUI's) go through the same filters.
        let _ = tracing_log::LogTracer::builder()
            .with_max_level(level_to_log(max_level))
            .init();
    }
    Logging { log_dir }
}

fn level_to_log(level: LevelFilter) -> log::LevelFilter {
    match level {
        LevelFilter::OFF => log::LevelFilter::Off,
        LevelFilter::ERROR => log::LevelFilter::Error,
        LevelFilter::WARN => log::LevelFilter::Warn,
        LevelFilter::INFO => log::LevelFilter::Info,
        LevelFilter::DEBUG => log::LevelFilter::Debug,
        _ => log::LevelFilter::Trace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_logs_to_stderr_and_installed_builds_to_files() {
        let dir = Path::new("/logs");
        let development = LogConfig::from_parts(false, None, false, Some(dir));
        assert_eq!(development.stderr.as_deref(), Some("warn"));
        assert_eq!(development.file, None);

        let installed = LogConfig::from_parts(true, None, false, Some(dir));
        assert_eq!(installed.stderr, None);
        assert_eq!(
            installed.file,
            Some((dir.to_path_buf(), FILE_DEFAULT.to_owned()))
        );

        let overridden = LogConfig::from_parts(true, Some("debug".into()), false, Some(dir));
        assert_eq!(overridden.stderr.as_deref(), Some("debug"));
        assert_eq!(overridden.file.unwrap().1, "debug");

        let both = LogConfig::from_parts(false, None, true, Some(dir));
        assert!(both.stderr.is_some() && both.file.is_some());
    }

    #[test]
    fn filters_parse_with_a_safe_fallback() {
        assert_eq!(most_verbose(&parse("warn")), LevelFilter::WARN);
        assert_eq!(
            most_verbose(&parse("warn,dr_platform=trace")),
            LevelFilter::TRACE
        );
        assert_eq!(most_verbose(&parse("=nonsense=")), LevelFilter::WARN);
        assert_eq!(most_verbose(&parse(FILE_DEFAULT)), LevelFilter::INFO);
    }

    #[test]
    fn the_test_runner_is_not_an_installed_copy() {
        assert!(!installed());
    }
}
