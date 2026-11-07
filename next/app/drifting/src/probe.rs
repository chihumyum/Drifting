//! Development probes, off unless asked for:
//!
//! - `DRIFTING_DEV_PROBE=<file>` appends one JSON object per line: the
//!   window's appearance when it opens and the first frame.
//!   `-` writes to stderr instead.
//! - `DRIFTING_DEV_EXIT_AFTER_FIRST_FRAME=1` quits right after the first frame,
//!   for `script/measure-startup-mac`.
//!
//! The lines carry timings and appearance names only, never paths or text.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use dr_ui::Theme;
use gpui::{App, Window};

pub const PROBE_ENV: &str = "DRIFTING_DEV_PROBE";
pub const EXIT_AFTER_FIRST_FRAME_ENV: &str = "DRIFTING_DEV_EXIT_AFTER_FIRST_FRAME";

struct Probe {
    started: Instant,
    sink: Option<Sink>,
    exit_after_first_frame: bool,
}

enum Sink {
    Stderr,
    File(PathBuf),
}

static PROBE: OnceLock<Probe> = OnceLock::new();
static FIRST_FRAME_SEEN: AtomicBool = AtomicBool::new(false);

/// Call first thing in `main`, so timings count from there.
pub fn start() {
    let started = Instant::now();
    let sink = std::env::var_os(PROBE_ENV)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value == "-" {
                Sink::Stderr
            } else {
                Sink::File(PathBuf::from(value))
            }
        });
    let exit_after_first_frame =
        std::env::var(EXIT_AFTER_FIRST_FRAME_ENV).is_ok_and(|value| value == "1");
    PROBE
        .set(Probe {
            started,
            sink,
            exit_after_first_frame,
        })
        .ok();
}

/// GPUI's platform (`gpui_platform::application()`) exists; AppKit has not
/// started launching yet.
pub fn platform_created() {
    emit("platform_created", &[]);
}

/// GPUI has finished launching (AppKit's `applicationDidFinishLaunching`) and
/// runs the app's setup closure.
pub fn app_ready() {
    emit("app_ready", &[]);
}

/// F3's workspace over the library is open (`took`: on its own thread,
/// alongside the app's launch).
pub fn library_opened(took: std::time::Duration) {
    emit(
        "library_opened",
        &[("open_us", Value::Int(took.as_micros() as u64))],
    );
}

/// dr-ui and the shell are installed (fonts, settings, shortcuts, menus);
/// the window is next.
pub fn shell_ready() {
    emit("shell_ready", &[]);
}

/// Records the window's starting appearance and schedules the first-frame
/// hook. GPUI runs `on_next_frame` callbacks right after a frame is drawn.
pub fn window_opened(window: &mut Window, cx: &mut App) {
    let appearance = Theme::of(window, cx).appearance;
    emit(
        "window_opened",
        &[("appearance", Value::Str(appearance.slug()))],
    );
    window.on_next_frame(|_, cx| first_frame_drawn(cx));
}

fn first_frame_drawn(cx: &mut App) {
    if FIRST_FRAME_SEEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    emit("first_frame", &[("unix_ms", Value::Int(unix_ms))]);

    if PROBE
        .get()
        .is_some_and(|probe| probe.exit_after_first_frame)
    {
        cx.quit();
    }
}

enum Value {
    Str(&'static str),
    Int(u64),
}

fn emit(event: &str, fields: &[(&str, Value)]) {
    let Some(probe) = PROBE.get() else { return };
    let Some(sink) = &probe.sink else { return };
    let since_main_ms = probe.started.elapsed().as_secs_f64() * 1000.0;
    let mut line = format!("{{\"event\":\"{event}\",\"since_main_ms\":{since_main_ms:.1}");
    for (key, value) in fields {
        match value {
            Value::Str(text) => line.push_str(&format!(",\"{key}\":\"{text}\"")),
            Value::Int(number) => line.push_str(&format!(",\"{key}\":{number}")),
        }
    }
    line.push_str("}\n");
    let written = match sink {
        Sink::Stderr => std::io::stderr().write_all(line.as_bytes()),
        Sink::File(path) => OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(line.as_bytes())),
    };
    if let Err(error) = written {
        eprintln!("{PROBE_ENV}: {error}");
    }
}
