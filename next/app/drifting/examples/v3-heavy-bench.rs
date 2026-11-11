//! End-to-end v3 heavy-book benchmark across the full `drifting` shell.
//!
//! Measures all eight author-facing paths on `dr_testkit::seed::generate_v3`
//! (`Preset::Heavy`, ~1.65M characters, 100 chapters, 300 elements, 200 ideas,
//! 60 materials, ~28.5k entity links):
//!
//! 1. `first_screen`: cold workspace open, `book.shelf`, `book.list`, shelf
//!    first frame and shelf cards ready;
//! 2. `open_book`: cold/warm `Book::load`, shelf-click to Project Home ready,
//!    Home redraw frames, and opening Whole Book inside the workspace;
//! 3. `typing_in_long_chapter`: cold/warm open of the longest (~20k-char)
//!    chapter, single-keystroke Loro + SQLite write latency, and full
//!    workspace frame CPU time per keystroke;
//! 4. `scrolling`: scrolling the ~20k-char chapter from top to bottom (driving
//!    live entity-link resolution and full chrome) and scrolling Whole Book
//!    inside the workspace;
//! 5. `chapter_switch`: clicking across 10 unvisited chapters (`Open::PREVIEW`),
//!    jumping to the 100th chapter, and switching between 5 open chapter tabs;
//! 6. `level_pages_and_left_sidebar`: toggling and switching root tabs in the
//!    v3 left sidebar, scrolling the 100-chapter manuscript sidebar list, and
//!    opening + scrolling level pages in all four displays (`list` manuscript
//!    order, `list` grouped by storyline, `grid`, `board`, `island`);
//! 7. `search`: `dr_view_search::v3::search` on 1-char, 2-char, 3-char, and
//!    0-hit queries (`LIMIT = 500`), plus `SearchPanel` end-to-end query and
//!    result scrolling;
//! 8. `timeline`: opening the bottom v3 `Timeline` on the 100-chapter book and
//!    scrolling horizontally across all placements.
//!
//! ```text
//! cargo run --release -p drifting --example v3-heavy-bench
//! cargo run --release -p drifting --example v3-heavy-bench -- --quick
//! cargo run --release -p drifting --example v3-heavy-bench -- --milestone v3-heavy-after
//! cargo run --release -p drifting --example v3-heavy-bench -- --output /tmp/out.json
//! ```

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_shell::book::Book;
use dr_shell::nav::{Open, Target};
use dr_shell::v3::{DisplaySurface, LevelHost};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as ShellWorkspace};
use dr_testkit::evidence::{self, Evidence, Summary};
use dr_testkit::seed::{self, DEFAULT_SEED, Preset};
use dr_view_elements::panel::v3::{Display as LevelKind, LevelDisplay, rows as level_rows};
use dr_view_search::LIMIT as SEARCH_LIMIT;
use dr_workspace::{Actor, Workspace as LibraryWorkspace};
use gpui::{
    AnyWindowHandle, App, AppContext as _, Entity, EntityInputHandler as _, HeadlessAppContext,
    PlatformInput, ScrollDelta, ScrollEvent, Window, point, px, size,
};
use serde_json::{Value, json};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const WIN_W: f32 = 1440.0;
const WIN_H: f32 = 900.0;
const BUSY_LOAD: f64 = 4.0;
const IDEAL_LOAD: f64 = 2.0;

const INPUTS: &[&str] = &[
    "app/drifting/examples/v3-heavy-bench.rs",
    "crates/dr-doc",
    "crates/dr-editor",
    "crates/dr-index",
    "crates/dr-model",
    "crates/dr-shell",
    "crates/dr-store",
    "crates/dr-view-elements",
    "crates/dr-view-home",
    "crates/dr-view-page",
    "crates/dr-view-search",
    "crates/dr-view-shelf",
    "crates/dr-view-timeline",
    "crates/dr-workspace",
    "crates/gpui-prose",
];

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn summary(samples: &[f64]) -> Value {
    serde_json::to_value(Summary::of(samples)).expect("summary")
}

#[cfg(target_os = "macos")]
fn phys_footprint_mb() -> f64 {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    let bytes = unsafe {
        let ok = libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V4,
            info.as_mut_ptr() as *mut libc::rusage_info_t,
        );
        if ok != 0 {
            return 0.0;
        }
        info.assume_init().ri_phys_footprint
    };
    (bytes as f64 / (1 << 20) as f64 * 10.0).round() / 10.0
}

#[cfg(not(target_os = "macos"))]
fn phys_footprint_mb() -> f64 {
    0.0
}

#[cfg(target_os = "macos")]
fn thread_cpu_ms() -> f64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}

#[cfg(not(target_os = "macos"))]
fn thread_cpu_ms() -> f64 {
    0.0
}

fn watchdog(seconds: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        eprintln!("v3-heavy-bench: watchdog expired after {seconds} s");
        std::process::exit(3);
    });
}

fn step(what: &str, since: Instant) {
    eprintln!("[{:7.2} s] {what}", since.elapsed().as_secs_f64());
}

fn call_ws(ws: &LibraryWorkspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name} failed: {e}"))["output"]
        .clone()
}

struct ShellHarness {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    ws: Entity<ShellWorkspace>,
    first_frame_ms: f64,
}

impl ShellHarness {
    fn open_on_shelf(lib: LibraryWorkspace) -> Self {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(dr_ui::Assets::new()),
            gpui_platform::current_headless_renderer,
        );
        cx.allow_parking();
        cx.update(|cx| {
            dr_ui::init(cx).expect("bundled fonts initialized");
            let info = ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            };
            let services = Services {
                library: Some(lib),
                ..Services::default()
            };
            dr_shell::init(info, services, SettingsFile::in_memory(), cx);
            dr_shell::Settings::set_device_memory(
                cx,
                dr_shell::workspace::FIRST_RUN_DONE,
                Some(true.into()),
            );
            dr_view_sea::shell::init(cx);
            dr_view_shelf::init(cx);
            dr_view_home::init(cx);
            dr_view_page::init(cx);
            dr_view_elements::init(cx);
            dr_view_templates::init(cx);
            dr_view_timeline::init(cx);
            dr_view_plot::init(cx);
            dr_view_material::init(cx);
            dr_view_import::init(cx);
            dr_view_transfer::init(cx);
        });

        let mut slot = None;
        let t0 = Instant::now();
        let window = cx
            .open_window(size(px(WIN_W), px(WIN_H)), |window, cx| {
                let ws = cx.new(|cx| ShellWorkspace::new(window, cx));
                slot = Some(ws.clone());
                ws
            })
            .expect("open workspace window");
        let handle: AnyWindowHandle = window.into();
        cx.update_window(handle, |_, window, cx| {
            window.simulate_next_frame(cx);
            window.draw(cx).clear(cx);
        })
        .expect("draw first shelf frame");
        let first_frame_ms = ms(t0.elapsed());
        Self {
            cx,
            window: handle,
            ws: slot.expect("workspace entity"),
            first_frame_ms,
        }
    }

    fn update<R>(
        &mut self,
        f: impl FnOnce(&Entity<ShellWorkspace>, &mut Window, &mut App) -> R,
    ) -> R {
        let ws = self.ws.clone();
        self.cx
            .update_window(self.window, |_, window, cx| f(&ws, window, cx))
            .expect("update workspace window")
    }

    /// Pumps parked background tasks, marks the workspace dirty, and draws one frame.
    /// Returns `(wall_ms, thread_cpu_ms)` for the draw itself.
    fn draw(&mut self) -> (f64, f64) {
        self.cx.run_until_parked();
        self.frame()
    }

    fn frame(&mut self) -> (f64, f64) {
        self.update(|ws, window, cx| {
            window.simulate_next_frame(cx);
            ws.update(cx, |_, cx| cx.notify());
            let cpu0 = thread_cpu_ms();
            let t0 = Instant::now();
            window.draw(cx).clear(cx);
            (ms(t0.elapsed()), (thread_cpu_ms() - cpu0).max(0.0))
        })
    }

    fn wait_until(
        &mut self,
        label: &str,
        timeout: Duration,
        mut done: impl FnMut(&ShellWorkspace, &App) -> bool,
    ) {
        let deadline = Instant::now() + timeout;
        loop {
            self.cx.run_until_parked();
            let ready = self.update(|ws, window, cx| {
                window.simulate_next_frame(cx);
                window.draw(cx).clear(cx);
                done(ws.read(cx), cx)
            });
            if ready {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {label} after {:?}",
                timeout
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn wheel_frame(&mut self, at_x: f32, at_y: f32, dx: f32, dy: f32) -> f64 {
        self.cx.run_until_parked();
        self.update(|_, window, cx| {
            window.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position: point(px(at_x), px(at_y)),
                    delta: ScrollDelta::Pixels(point(px(dx), px(dy))),
                    ..Default::default()
                }),
                cx,
            );
            window.simulate_next_frame(cx);
            let cpu0 = thread_cpu_ms();
            window.draw(cx).clear(cx);
            (thread_cpu_ms() - cpu0).max(0.0)
        })
    }

    fn target_ready(&mut self, target: &Target) -> bool {
        let key = target.key();
        self.update(|ws, _, cx| {
            let owner = ws.entity_id();
            let ws_ref = ws.read(cx);
            let Some(page) = ws_ref.editors.get(&key) else {
                return false;
            };
            let (ready, loading, failed) = ws_ref.page_status(owner, &key, page, cx);
            assert!(!failed, "target {key} failed to open");
            ready && !loading && page.view.is_some()
        })
    }

    fn open_target_and_wait(&mut self, target: Target, how: Open) -> f64 {
        let t0 = Instant::now();
        let t_clone = target.clone();
        self.update(|ws, _, cx| {
            ws.update(cx, |ws, cx| ws.open(t_clone, how, cx));
        });
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            self.cx.run_until_parked();
            self.frame();
            if self.target_ready(&target) {
                // Draw one settled frame with the mounted editor.
                self.frame();
                return ms(t0.elapsed());
            }
            assert!(
                Instant::now() < deadline,
                "timed out opening target {}",
                target.key()
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

struct Config {
    quick: bool,
    milestone: Option<String>,
    output: Option<PathBuf>,
    timeout: u64,
}

fn parse_args() -> Config {
    let mut cfg = Config {
        quick: false,
        milestone: None,
        output: None,
        timeout: 900,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--quick" => cfg.quick = true,
            "--milestone" => {
                cfg.milestone = Some(args.next().expect("--milestone needs a name"));
            }
            "--output" => {
                cfg.output = Some(PathBuf::from(args.next().expect("--output needs a path")));
            }
            "--timeout" => {
                cfg.timeout = args
                    .next()
                    .expect("--timeout needs seconds")
                    .parse()
                    .expect("seconds");
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    cfg
}

fn seed_library(dir: &Path, preset: Preset) -> (String, Value) {
    let seeded = seed::generate_v3(preset, DEFAULT_SEED).expect("generate v3 seed");
    let shape = seeded.shape().to_json();
    let book_id = seeded.books[0].book_id().to_string();
    let lib = dr_store::Library::open(dir, dr_workspace::library_options("v3-heavy-bench"))
        .expect("open library");
    seeded.write_to(&lib).expect("write seed");
    lib.rebuild_stale_indexes().expect("build derived indexes");
    lib.close().expect("close seeded library");
    (book_id, shape)
}

fn main() {
    let cfg = parse_args();
    watchdog(cfg.timeout);
    let since = Instant::now();
    let preset = if cfg.quick {
        Preset::Tiny
    } else {
        Preset::Heavy
    };

    let temp = tempfile::tempdir().expect("tempdir");
    let lib_dir = temp.path().join("library");
    step(&format!("seeding v3 {} library", preset.name()), since);
    let (book_id, shape) = seed_library(&lib_dir, preset);
    step(&format!("seeded book {book_id}"), since);

    let load_before = evidence::load_average();
    let mem_before_mb = phys_footprint_mb();

    // -------------------------------------------------------------------------
    // 1. Cold queries (`first_screen` + cold `Book::load`)
    // -------------------------------------------------------------------------
    let t_ws = Instant::now();
    let cold_ws_shelf =
        LibraryWorkspace::open_dir(&lib_dir, "v3-heavy-bench").expect("open cold ws (shelf)");
    let cold_workspace_open_ms = round3(ms(t_ws.elapsed()));

    let t_shelf_q = Instant::now();
    let shelf_json = call_ws(&cold_ws_shelf, "book.shelf", json!({}));
    let cold_book_shelf_query_ms = round3(ms(t_shelf_q.elapsed()));
    assert_eq!(shelf_json.as_array().map(Vec::len), Some(1));
    cold_ws_shelf.shutdown().expect("shutdown cold shelf ws");

    let cold_ws_list =
        LibraryWorkspace::open_dir(&lib_dir, "v3-heavy-bench").expect("open cold ws (list)");
    let t_list_q = Instant::now();
    let list_json = call_ws(&cold_ws_list, "book.list", json!({}));
    let cold_book_list_query_ms = round3(ms(t_list_q.elapsed()));
    assert_eq!(list_json.as_array().map(Vec::len), Some(1));
    cold_ws_list.shutdown().expect("shutdown cold list ws");

    let cold_ws_book =
        LibraryWorkspace::open_dir(&lib_dir, "v3-heavy-bench").expect("open cold ws (book load)");
    let t_book_cold = Instant::now();
    let loaded_book = Book::load(&cold_ws_book, &book_id).expect("cold Book::load");
    let cold_book_load_ms = round3(ms(t_book_cold.elapsed()));
    assert!(loaded_book.v3().is_some());

    let warm_reps = if cfg.quick { 2 } else { 5 };
    let mut warm_book_loads = Vec::with_capacity(warm_reps);
    for _ in 0..warm_reps {
        let t = Instant::now();
        let b = Book::load(&cold_ws_book, &book_id).expect("warm Book::load");
        assert!(b.v3().is_some());
        warm_book_loads.push(ms(t.elapsed()));
    }
    cold_ws_book.shutdown().expect("shutdown cold book ws");
    step(
        &format!(
            "cold queries: ws_open={cold_workspace_open_ms}ms shelf={cold_book_shelf_query_ms}ms list={cold_book_list_query_ms}ms book_load={cold_book_load_ms}ms"
        ),
        since,
    );

    // -------------------------------------------------------------------------
    // Reopen fresh cold workspace for the full GPUI window journey.
    // -------------------------------------------------------------------------
    let app_lib =
        LibraryWorkspace::open_dir(&lib_dir, "v3-heavy-bench").expect("open app workspace");
    let t_window = Instant::now();
    let mut h = ShellHarness::open_on_shelf(app_lib.clone());
    let shelf_first_frame_ms = round3(h.first_frame_ms);
    h.wait_until("shelf cards ready", Duration::from_secs(30), |ws, cx| {
        ws.shelf_open
            && ws
                .shelf
                .as_ref()
                .and_then(|s| s.view.clone().downcast::<dr_view_shelf::Shelf>().ok())
                .is_some_and(|s| s.read(cx).cards_ms.is_some())
    });
    let shelf_cards_ready_ms = round3(ms(t_window.elapsed()));
    let shelf_reported_cards_ms = h.update(|ws, _, cx| {
        ws.read(cx)
            .shelf
            .as_ref()
            .and_then(|s| s.view.clone().downcast::<dr_view_shelf::Shelf>().ok())
            .and_then(|s| s.read(cx).cards_ms)
            .unwrap_or(0.0)
    });
    step(
        &format!(
            "first_screen: first_frame={shelf_first_frame_ms}ms cards_ready={shelf_cards_ready_ms}ms"
        ),
        since,
    );

    // -------------------------------------------------------------------------
    // 2. Open book -> Project Home ready
    // -------------------------------------------------------------------------
    let t_open_book = Instant::now();
    let bid = book_id.clone();
    h.update(|ws, window, cx| {
        ws.update(cx, |ws, cx| ws.open_book(&bid, window, cx));
    });
    h.wait_until(
        "book open to Project Home",
        Duration::from_secs(30),
        |ws, _| {
            !ws.shelf_open && !ws.book.is_empty() && ws.book_memory_ready() && !ws.sea.waiting()
        },
    );
    h.frame();
    let open_book_to_home_ms = round3(ms(t_open_book.elapsed()));

    let mut home_frames = Vec::new();
    for _ in 0..(if cfg.quick { 4 } else { 10 }) {
        home_frames.push(h.draw().1);
    }
    let mem_after_home_mb = phys_footprint_mb();
    step(
        &format!("open_book: open_to_home={open_book_to_home_ms}ms"),
        since,
    );

    // Inspect chapter IDs and pick the longest chapter for typing & scrolling.
    let (chapter_ids, manuscript_level_id, root_ids) = h.update(|ws, _, cx| {
        let v3 = ws.read(cx).book.v3().expect("v3 book loaded");
        let ms_level = v3
            .levels
            .iter()
            .find(|(_, l)| l.settings.is_manuscript)
            .expect("manuscript level")
            .0
            .clone();
        let mut seen = BTreeSet::new();
        let chapters: Vec<String> = v3
            .manuscript
            .iter()
            .filter(|m| seen.insert(m.entry.clone()))
            .map(|m| m.entry.clone())
            .collect();
        let roots = v3.roots.clone();
        (chapters, ms_level, roots)
    });
    assert!(!chapter_ids.is_empty(), "seed has chapters");

    // Measure character lengths via SQLite doc_stats without warming prose holders!
    let (longest_id, longest_chars) = {
        let mut best = (chapter_ids[0].clone(), 0usize);
        for cid in &chapter_ids {
            let doc_id = format!("body:{cid}/mod-prose");
            let chars = app_lib
                .library()
                .doc_stats(&doc_id)
                .ok()
                .flatten()
                .map(|s| s.chars as usize)
                .unwrap_or(0);
            if chars > best.1 {
                best = (cid.clone(), chars);
            }
        }
        best
    };

    // -------------------------------------------------------------------------
    // 3. Long chapter open (cold & warm) + typing latency
    // -------------------------------------------------------------------------
    let long_target = Target::Entry {
        id: longest_id.parse().expect("valid entry id"),
        module: None,
    };
    let open_long_chapter_cold_ms = round3(h.open_target_and_wait(long_target.clone(), Open::KEEP));

    let warm_ch_reps = if cfg.quick { 2 } else { 5 };
    let mut open_long_chapter_warm = Vec::with_capacity(warm_ch_reps);
    for _ in 0..warm_ch_reps {
        let key = long_target.clone();
        h.update(|ws, _, cx| {
            ws.update(cx, |ws, cx| {
                ws.nav.forget(&key);
                ws.editors.remove(&key.key());
                cx.notify();
            });
        });
        h.draw();
        open_long_chapter_warm.push(h.open_target_and_wait(long_target.clone(), Open::KEEP));
    }

    // Place caret near the middle of the ~20k-char chapter and type characters.
    let prose_entity = h.update(|ws, window, cx| {
        let page = ws
            .read(cx)
            .editors
            .get(&long_target.key())
            .expect("long chapter mounted");
        let prose = page.view.as_ref().expect("page view").prose(cx);
        prose.update(cx, |e, cx| {
            let mid = e.book().chapters[0].doc.len_chars() / 2;
            e.select(0, mid..mid, window, cx);
        });
        prose
    });
    h.draw();

    let keystrokes = if cfg.quick { 16 } else { 80 };
    const STREAM: &[char] = &[
        '春', '风', '吹', '又', '生', '，', '夜', '航', '星', '河', '。',
    ];
    let mut keystroke_write_ms = Vec::with_capacity(keystrokes);
    let mut keystroke_frame_cpu_ms = Vec::with_capacity(keystrokes);
    let mut keystroke_total_ms = Vec::with_capacity(keystrokes);
    for i in 0..keystrokes {
        let s = STREAM[i % STREAM.len()].to_string();
        let p = prose_entity.clone();
        h.cx.run_until_parked();
        let t_total = Instant::now();
        let write_ms = h.update(|_, window, cx| {
            let tw = Instant::now();
            p.update(cx, |e, cx| {
                e.replace_text_in_range(None, &s, window, cx);
            });
            ms(tw.elapsed())
        });
        let (_, frame_cpu) = h.frame();
        keystroke_write_ms.push(write_ms);
        keystroke_frame_cpu_ms.push(frame_cpu);
        keystroke_total_ms.push(ms(t_total.elapsed()));
    }
    step(
        &format!(
            "typing_in_long_chapter ({longest_chars} chars): cold_open={open_long_chapter_cold_ms}ms write_p50={:.3}ms frame_p95={:.3}ms",
            Summary::of(&keystroke_write_ms).p50,
            Summary::of(&keystroke_frame_cpu_ms).p95,
        ),
        since,
    );

    // -------------------------------------------------------------------------
    // 4. Scrolling the ~20k-char chapter from top to bottom
    // -------------------------------------------------------------------------
    {
        let p = prose_entity.clone();
        h.update(|_, window, cx| {
            p.update(cx, |e, cx| {
                e.select(0, 0..0, window, cx);
                e.list_state().scroll_to_reveal_item(0);
            });
        });
        h.draw();
    }
    let mut chapter_scroll_frames = Vec::new();
    let mut last_top = (usize::MAX, px(0.0));
    let mut stuck = 0usize;
    let max_ch_frames = if cfg.quick { 40 } else { 600 };
    for _ in 0..max_ch_frames {
        let p = prose_entity.clone();
        let top = h.update(|_, _, cx| {
            let ls = p.read(cx).list_state();
            let t = ls.logical_scroll_top();
            ls.scroll_by(px(360.0));
            (t.item_ix, t.offset_in_item)
        });
        let (_, cpu) = h.frame();
        chapter_scroll_frames.push(cpu);
        let now_top = h.update(|_, _, cx| {
            let t = p.read(cx).list_state().logical_scroll_top();
            (t.item_ix, t.offset_in_item)
        });
        if now_top == top && now_top == last_top {
            stuck += 1;
            if stuck >= 2 {
                break;
            }
        } else {
            stuck = 0;
        }
        last_top = now_top;
    }
    step(
        &format!(
            "scrolling (long chapter, {} frames): p50={:.3}ms p95={:.3}ms max={:.3}ms",
            chapter_scroll_frames.len(),
            Summary::of(&chapter_scroll_frames).p50,
            Summary::of(&chapter_scroll_frames).p95,
            Summary::of(&chapter_scroll_frames).max,
        ),
        since,
    );

    // -------------------------------------------------------------------------
    // 5. Chapter switching (`Open::PREVIEW`, jump to last, and open-tab switch)
    // -------------------------------------------------------------------------
    let preview_count = (if cfg.quick { 3 } else { 10 }).min(chapter_ids.len());
    let stride = (chapter_ids.len() / preview_count.max(1)).max(1);
    let mut preview_switches = Vec::with_capacity(preview_count);
    for i in 0..preview_count {
        let idx = (i * stride + 1).min(chapter_ids.len() - 1);
        let target = Target::Entry {
            id: chapter_ids[idx].parse().expect("chapter id"),
            module: None,
        };
        preview_switches.push(h.open_target_and_wait(target, Open::PREVIEW));
    }

    let last_chapter_target = Target::Entry {
        id: chapter_ids
            .last()
            .expect("last chapter")
            .parse()
            .expect("chapter id"),
        module: None,
    };
    // Ensure last chapter is opened fresh if preview already landed on it.
    h.update(|ws, _, cx| {
        let k = last_chapter_target.clone();
        ws.update(cx, |ws, cx| {
            ws.nav.forget(&k);
            ws.editors.remove(&k.key());
            cx.notify();
        });
    });
    h.draw();
    let jump_to_last_chapter_ms = round3(h.open_target_and_wait(last_chapter_target, Open::KEEP));

    let keep_count = (if cfg.quick { 3 } else { 5 }).min(chapter_ids.len());
    let mut kept_targets = Vec::with_capacity(keep_count);
    for cid in chapter_ids.iter().take(keep_count) {
        let t = Target::Entry {
            id: cid.parse().expect("chapter id"),
            module: None,
        };
        h.open_target_and_wait(t.clone(), Open::KEEP);
        kept_targets.push(t);
    }
    let tab_switches = if cfg.quick { 6 } else { 15 };
    let mut open_tab_switch_ms = Vec::with_capacity(tab_switches);
    for i in 0..tab_switches {
        let t = kept_targets[i % kept_targets.len()].clone();
        h.cx.run_until_parked();
        let t0 = Instant::now();
        h.update(|ws, _, cx| {
            ws.update(cx, |ws, cx| ws.open(t, Open::KEEP, cx));
        });
        h.frame();
        open_tab_switch_ms.push(ms(t0.elapsed()));
    }
    step(
        &format!(
            "chapter_switch: preview_p50={:.3}ms last={jump_to_last_chapter_ms}ms tab_p50={:.3}ms",
            Summary::of(&preview_switches).p50,
            Summary::of(&open_tab_switch_ms).p50,
        ),
        since,
    );

    // Also measure Whole Book open + workspace scroll frames (before closing heavy tabs).
    let open_whole_book_tab_ms = round3(h.open_target_and_wait(Target::Book, Open::KEEP));
    let wb_prose = h.update(|ws, _, cx| {
        ws.read(cx)
            .editors
            .get(&Target::Book.key())
            .expect("whole book mounted")
            .view
            .as_ref()
            .expect("whole book view")
            .prose(cx)
    });
    let wb_scroll_n = if cfg.quick { 25 } else { 150 };
    let mut wb_workspace_scroll_frames = Vec::with_capacity(wb_scroll_n);
    for _ in 0..wb_scroll_n {
        let p = wb_prose.clone();
        h.update(|_, _, cx| {
            p.read(cx).list_state().scroll_by(px(420.0));
        });
        let (_, cpu) = h.frame();
        wb_workspace_scroll_frames.push(cpu);
    }
    // Close Whole Book tab so subsequent sidebar/timeline/search measurements measure their own cost cleanly.
    h.update(|ws, _, cx| {
        ws.update(cx, |ws, cx| {
            ws.nav.forget(&Target::Book);
            ws.editors.remove(&Target::Book.key());
            cx.notify();
        });
    });
    h.draw();
    step(
        &format!(
            "whole_book_in_workspace: open={open_whole_book_tab_ms}ms scroll_p95={:.3}ms",
            Summary::of(&wb_workspace_scroll_frames).p95,
        ),
        since,
    );

    // -------------------------------------------------------------------------
    // 6. Left sidebar + Level pages (all 4 displays)
    // -------------------------------------------------------------------------
    // Ensure left sidebar is open.
    let sidebar_open_frame_ms = {
        let is_open = h.update(|ws, _, cx| ws.read(cx).left.open);
        if is_open {
            h.update(|ws, window, cx| ws.update(cx, |ws, cx| ws.toggle_left(window, cx)));
            h.draw();
        }
        let t0 = Instant::now();
        h.update(|ws, window, cx| ws.update(cx, |ws, cx| ws.toggle_left(window, cx)));
        h.draw();
        // Advance structural reveal so sidebar is fully visible.
        std::thread::sleep(Duration::from_millis(220));
        h.draw();
        round3(ms(t0.elapsed()) - 220.0_f64.min(ms(t0.elapsed())))
    };

    let mut sidebar_tab_switch_ms = Vec::new();
    for rid in &root_ids {
        let rid = rid.clone();
        let t0 = Instant::now();
        h.update(|ws, _, cx| {
            if let Some(sb) = ws.read(cx).v3_sidebar.clone() {
                sb.update(cx, |sb, cx| sb.select(&rid, cx));
            }
        });
        h.draw();
        sidebar_tab_switch_ms.push(ms(t0.elapsed()));
    }
    // Select manuscript root in sidebar and scroll it with wheel events.
    h.update(|ws, _, cx| {
        if let Some(sb) = ws.read(cx).v3_sidebar.clone() {
            sb.update(cx, |sb, cx| sb.select(&manuscript_level_id, cx));
        }
    });
    h.draw();
    let sb_scroll_n = if cfg.quick { 10 } else { 40 };
    let mut sidebar_scroll_frames = Vec::with_capacity(sb_scroll_n);
    for _ in 0..sb_scroll_n {
        sidebar_scroll_frames.push(h.wheel_frame(140.0, 420.0, 0.0, -240.0));
    }

    // Measure `rows()` computation directly for manuscript list & grouped-by-storyline list,
    // plus open the manuscript level `EntryPage` in each of the 4 displays:
    // `list`, `grid`, `board`, `island`.
    let book_snapshot: Rc<Book> = h.update(|ws, _, cx| ws.read(cx).book.clone());
    let mut grouped_rows_ms = Vec::new();
    for _ in 0..(if cfg.quick { 3 } else { 15 }) {
        let t0 = Instant::now();
        let r = level_rows(
            &book_snapshot,
            &manuscript_level_id,
            LevelKind::List,
            true,
            &BTreeSet::new(),
            4,
        );
        assert!(!r.is_empty());
        grouped_rows_ms.push(ms(t0.elapsed()));
    }

    let ms_target = Target::Entry {
        id: manuscript_level_id.parse().expect("manuscript level id"),
        module: None,
    };
    let mut display_metrics = serde_json::Map::new();
    for display_name in ["list", "grid", "board", "island"] {
        call_ws(
            &app_lib,
            "entry.update",
            json!({
                "book": book_id,
                "id": manuscript_level_id,
                "overrides": { "display": display_name }
            }),
        );
        h.wait_until("level display updated", Duration::from_secs(15), |ws, _| {
            ws.book
                .v3()
                .and_then(|v| v.levels.get(&manuscript_level_id))
                .is_some_and(|l| l.settings.display == display_name)
        });
        // Reopen the level page cleanly to measure mounting + first frame + scroll frames.
        h.update(|ws, _, cx| {
            let k = ms_target.clone();
            ws.update(cx, |ws, cx| {
                ws.nav.forget(&k);
                ws.editors.remove(&k.key());
                cx.notify();
            });
        });
        h.draw();
        let t_open = Instant::now();
        let k = ms_target.clone();
        h.update(|ws, _, cx| ws.update(cx, |ws, cx| ws.open(k, Open::KEEP, cx)));
        h.wait_until(
            "level EntryPage synced",
            Duration::from_secs(15),
            |ws, cx| {
                ws.editors
                    .get(&ms_target.key())
                    .and_then(|p| p.v3.as_ref())
                    .is_some_and(|v3| v3.read(cx).synced)
            },
        );
        let (_, first_cpu) = h.frame();
        let open_ms = round3(ms(t_open.elapsed()));

        let scroll_n = if cfg.quick { 8 } else { 30 };
        let mut scroll_cpu = Vec::with_capacity(scroll_n);
        for _ in 0..scroll_n {
            scroll_cpu.push(h.wheel_frame(760.0, 380.0, 0.0, -240.0));
        }
        display_metrics.insert(
            display_name.to_owned(),
            json!({
                "open_ms": open_ms,
                "first_frame_cpu_ms": round3(first_cpu),
                "scroll_frame_cpu_ms": summary(&scroll_cpu),
            }),
        );
    }
    // Also measure a standalone grouped-by-storyline `LevelDisplay` mount + draw on manuscript!
    let grouped_display_frame_cpu_ms = {
        let host = h.update(|ws, _, cx| LevelHost {
            page: dr_shell::pages::PageViewHost {
                workspace: ws.downgrade(),
                library: ws.read(cx).library.clone().expect("library"),
                book_id: book_id.clone(),
                book: ws.read(cx).book.clone(),
            },
            level: manuscript_level_id.clone(),
            surface: DisplaySurface::Page,
        });
        let mut samples = Vec::new();
        for _ in 0..(if cfg.quick { 3 } else { 10 }) {
            let b = host.page.book.clone();
            let h_clone = LevelHost {
                page: dr_shell::pages::PageViewHost {
                    workspace: host.page.workspace.clone(),
                    library: host.page.library.clone(),
                    book_id: host.page.book_id.clone(),
                    book: b.clone(),
                },
                level: host.level.clone(),
                surface: DisplaySurface::Page,
            };
            let cpu0 = thread_cpu_ms();
            h.update(|_, _, cx| {
                let entity = cx.new(|_| LevelDisplay::new(h_clone, LevelKind::List));
                entity.update(cx, |ld, cx| {
                    ld.grouped = true;
                    ld.refresh(b, cx);
                });
            });
            samples.push((thread_cpu_ms() - cpu0).max(0.0));
        }
        samples
    };
    // Restore manuscript overrides to null.
    call_ws(
        &app_lib,
        "entry.update",
        json!({
            "book": book_id,
            "id": manuscript_level_id,
            "overrides": null
        }),
    );
    h.wait_until(
        "manuscript overrides restored",
        Duration::from_secs(15),
        |ws, _| {
            ws.book
                .v3()
                .and_then(|v| v.levels.get(&manuscript_level_id))
                .is_some_and(|l| l.settings.display == "list")
        },
    );
    step("level_pages_and_left_sidebar complete", since);

    // -------------------------------------------------------------------------
    // 7. Search (`dr_view_search::v3::search` direct + `SearchPanel` e2e)
    // -------------------------------------------------------------------------
    // Pick deterministic queries that exercise 1-char cap, 2-char prose, 3-char element/patch, and 0-hit full scan.
    let sample_element_title = h.update(|ws, _, cx| {
        ws.read(cx)
            .book
            .v3()
            .and_then(|v| {
                v.entries
                    .iter()
                    .find(|e| e.template.as_deref() == Some("tpl-character"))
                    .map(|e| e.title.chars().take(3).collect::<String>())
            })
            .unwrap_or_else(|| "人物".to_owned())
    });
    let queries = [
        ("1char", "的".to_owned()),
        ("2char", "目光".to_owned()),
        ("3char_entity", sample_element_title),
        ("miss_0hit", "龘靐齉爩".to_owned()),
    ];
    let search_reps = if cfg.quick { 3 } else { 15 };
    let mut direct_search = serde_json::Map::new();
    for (label, q) in &queries {
        let mut samples = Vec::with_capacity(search_reps);
        let mut last_groups = 0usize;
        let mut last_rows = 0usize;
        for _ in 0..search_reps {
            let t0 = Instant::now();
            let groups = dr_view_search::v3::search(&app_lib, &book_id, q, SEARCH_LIMIT)
                .expect("v3::search");
            samples.push(ms(t0.elapsed()));
            last_groups = groups.len();
            last_rows = groups.iter().map(|g| g.rows.len()).sum();
        }
        direct_search.insert(
            (*label).to_owned(),
            json!({
                "query_len_chars": q.chars().count(),
                "groups": last_groups,
                "rows": last_rows,
                "latency_ms": summary(&samples),
            }),
        );
    }

    // End-to-end SearchPanel open + query + result scroll.
    let t_search_open = Instant::now();
    h.update(|ws, window, cx| ws.update(cx, |ws, cx| ws.toggle_search(window, cx)));
    let (_, _) = h.draw();
    let search_panel_open_ms = round3(ms(t_search_open.elapsed()));

    let mut panel_e2e_ms = Vec::new();
    for (_, q) in &queries {
        let q = q.clone();
        let t0 = Instant::now();
        h.update(|ws, _, cx| {
            let panel = ws.read(cx).search.clone().expect("search panel open");
            panel.update(cx, |p, cx| p.set_query(&q, cx));
        });
        h.wait_until(
            "search panel finished",
            Duration::from_secs(15),
            |ws, cx| {
                ws.search
                    .as_ref()
                    .is_some_and(|p| !p.read(cx).is_searching())
            },
        );
        h.frame();
        panel_e2e_ms.push(ms(t0.elapsed()));
    }
    // Set back to 1char (500 hits) and scroll the result list.
    h.update(|ws, _, cx| {
        let panel = ws.read(cx).search.clone().expect("search panel open");
        panel.update(cx, |p, cx| p.set_query("的", cx));
    });
    h.wait_until("search 1char ready", Duration::from_secs(15), |ws, cx| {
        ws.search
            .as_ref()
            .is_some_and(|p| !p.read(cx).is_searching())
    });
    let mut search_scroll_frames = Vec::new();
    for _ in 0..(if cfg.quick { 8 } else { 25 }) {
        search_scroll_frames.push(h.wheel_frame(720.0, 320.0, 0.0, -240.0));
    }
    // Close search panel.
    h.update(|ws, window, cx| {
        ws.update(cx, |ws, cx| {
            ws.dismiss(window, cx);
        });
    });
    h.draw();
    step(
        &format!(
            "search: 1char_p50={:.3}ms miss_p50={:.3}ms panel_e2e_p50={:.3}ms",
            direct_search["1char"]["latency_ms"]["p50"]
                .as_f64()
                .unwrap_or(0.0),
            direct_search["miss_0hit"]["latency_ms"]["p50"]
                .as_f64()
                .unwrap_or(0.0),
            Summary::of(&panel_e2e_ms).p50,
        ),
        since,
    );

    // -------------------------------------------------------------------------
    // 8. Timeline (open + horizontal scroll across 100 placed chapters)
    // -------------------------------------------------------------------------
    // Ensure timeline is hidden first, then toggle it open and measure open + scroll frames.
    {
        let hidden = h.update(|ws, _, cx| ws.read(cx).bottom.layout.timeline_hidden);
        if !hidden {
            h.update(|ws, _, cx| ws.update(cx, |ws, cx| ws.toggle_timeline(cx)));
            h.draw();
        }
    }
    let t_tl = Instant::now();
    h.update(|ws, _, cx| ws.update(cx, |ws, cx| ws.toggle_timeline(cx)));
    let (_, timeline_first_cpu_ms) = h.draw();
    let timeline_open_ms = round3(ms(t_tl.elapsed()));
    std::thread::sleep(Duration::from_millis(220));
    h.draw();

    let tl_scroll_n = if cfg.quick { 12 } else { 60 };
    let mut timeline_scroll_frames = Vec::with_capacity(tl_scroll_n);
    for _ in 0..tl_scroll_n {
        // Horizontal scroll wheel over the bottom timeline panel (y = 800 in 1440x900).
        timeline_scroll_frames.push(h.wheel_frame(720.0, 800.0, -320.0, 0.0));
    }
    step(
        &format!(
            "timeline: open={timeline_open_ms}ms first_cpu={timeline_first_cpu_ms:.3}ms scroll_p95={:.3}ms",
            Summary::of(&timeline_scroll_frames).p95,
        ),
        since,
    );

    let load_after = evidence::load_average();
    let mem_end_mb = phys_footprint_mb();
    let load_1m_max = load_before.unwrap_or(0.0).max(load_after.unwrap_or(0.0));

    let metrics = json!({
        "preset": preset.name(),
        "load_1m_before": load_before,
        "load_1m_after": load_after,
        "idle_under_4": load_1m_max < BUSY_LOAD,
        "idle_under_2": load_1m_max < IDEAL_LOAD,
        "budgets_ms": {
            "open_project_heavy": 150.0,
            "open_20k_chapter_release": 50.0,
            "open_whole_book_release": 100.0,
            "jump_to_last_chapter_release": 80.0,
            "scroll_frame_p95_release": 8.3,
            "scroll_frame_p95_60hz": 16.7,
            "keystroke_write_median_release": 1.0,
            "keystroke_frame_p95_release": 8.3,
            "switch_tab": 50.0,
        },
        "memory_mb": {
            "before": mem_before_mb,
            "after_home": mem_after_home_mb,
            "end": mem_end_mb,
        },
        "1_first_screen": {
            "cold_workspace_open_ms": cold_workspace_open_ms,
            "cold_book_shelf_query_ms": cold_book_shelf_query_ms,
            "cold_book_list_query_ms": cold_book_list_query_ms,
            "shelf_first_frame_ms": shelf_first_frame_ms,
            "shelf_cards_ready_ms": shelf_cards_ready_ms,
            "shelf_reported_cards_ms": round3(shelf_reported_cards_ms),
        },
        "2_open_book": {
            "cold_book_load_ms": cold_book_load_ms,
            "warm_book_load_ms": summary(&warm_book_loads),
            "open_book_to_home_ms": open_book_to_home_ms,
            "home_redraw_frame_cpu_ms": summary(&home_frames),
            "open_whole_book_tab_ms": open_whole_book_tab_ms,
        },
        "3_typing_in_long_chapter": {
            "chapter_chars": longest_chars,
            "open_long_chapter_cold_ms": open_long_chapter_cold_ms,
            "open_long_chapter_warm_ms": summary(&open_long_chapter_warm),
            "keystrokes": keystrokes,
            "keystroke_write_ms": summary(&keystroke_write_ms),
            "keystroke_frame_cpu_ms": summary(&keystroke_frame_cpu_ms),
            "keystroke_total_ms": summary(&keystroke_total_ms),
        },
        "4_scrolling": {
            "long_chapter_frames": chapter_scroll_frames.len(),
            "long_chapter_scroll_frame_cpu_ms": summary(&chapter_scroll_frames),
            "whole_book_workspace_frames": wb_workspace_scroll_frames.len(),
            "whole_book_workspace_scroll_frame_cpu_ms": summary(&wb_workspace_scroll_frames),
        },
        "5_chapter_switch": {
            "preview_switch_ms": summary(&preview_switches),
            "jump_to_last_chapter_ms": jump_to_last_chapter_ms,
            "open_tab_switch_ms": summary(&open_tab_switch_ms),
        },
        "6_level_pages_and_left_sidebar": {
            "sidebar_open_frame_ms": sidebar_open_frame_ms,
            "sidebar_root_tab_switch_ms": summary(&sidebar_tab_switch_ms),
            "sidebar_manuscript_scroll_frame_cpu_ms": summary(&sidebar_scroll_frames),
            "manuscript_grouped_rows_compute_ms": summary(&grouped_rows_ms),
            "manuscript_grouped_display_mount_cpu_ms": summary(&grouped_display_frame_cpu_ms),
            "level_page_displays": display_metrics,
        },
        "7_search": {
            "direct": direct_search,
            "panel_open_ms": search_panel_open_ms,
            "panel_query_e2e_ms": summary(&panel_e2e_ms),
            "panel_scroll_frame_cpu_ms": summary(&search_scroll_frames),
        },
        "8_timeline": {
            "open_ms": timeline_open_ms,
            "first_frame_cpu_ms": round3(timeline_first_cpu_ms),
            "scroll_frame_cpu_ms": summary(&timeline_scroll_frames),
        },
    });

    let root = evidence::workspace_root();
    let milestone_label = cfg.milestone.as_deref().unwrap_or("adhoc");
    let generated_by = format!(
        "cargo run --release -p drifting --example v3-heavy-bench -- --milestone {milestone_label}"
    );
    let mut ev = Evidence::new("v3-heavy-app-bench", milestone_label, &generated_by)
        .inputs(&root, INPUTS)
        .expect("fingerprint evidence inputs");
    ev.corpus = shape;
    ev.results = metrics;

    let rendered = serde_json::to_string_pretty(&ev).expect("serialize evidence");
    println!("{rendered}");

    if let Some(out) = &cfg.output {
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).expect("create output parent");
        }
        std::fs::write(out, format!("{rendered}\n")).expect("write --output json");
        eprintln!("wrote {}", out.display());
    }
    if cfg.milestone.is_some() {
        let dest = ev
            .write(&root.join(evidence::DIR))
            .expect("write milestone evidence");
        eprintln!("wrote {}", dest.display());
    }

    drop(h);
    app_lib.shutdown().ok();
}
