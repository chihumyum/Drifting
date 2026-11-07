//! The whole book in one editor (M05) on F8's heavy seed: 100 chapters,
//! 1.5 million characters, each chapter its own workspace session. Measures
//! what `benchmarks.md` budgets for the whole book: opening it (to the first
//! drawn frame), scrolling from the first line to the last, jumping to the
//! last chapter, and the process's memory after the scroll.
//!
//! ```text
//! cargo run --release -p dr-editor --example book-bench            # print
//! cargo run --release -p dr-editor --example book-bench -- --write # m05-m1-book-bench.json
//! cargo run --release -p dr-editor --example book-bench -- --timeout 300
//! cargo run --release -p dr-editor --example book-bench -- --capture <dir> # two PNGs to look at
//! ```
//!
//! GPUI runs headless, as prose-bench's `decor` (F4d): its test platform,
//! the real macOS text system and the Metal renderer behind an offscreen
//! texture. No window opens, nothing waits for the display's frame clock,
//! and a window behind others cannot stall it. A frame is the CPU time of
//! one whole frame of the book's editor (render, layout, paint), as the
//! window benchmark's "work per frame"; the GPU's part and the display's
//! pacing are not in it. A watchdog ends the run after `--timeout` seconds
//! (default 900). The one-minute load before and after is recorded (other
//! builds on the machine skew the numbers).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_editor::{BookEditor, EditorSettings};
use dr_testkit::evidence::{self, Evidence, Summary};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, IntoElement,
    ParentElement, Render, Styled, Window, div, px, size,
};
use gpui_prose::ProseEditor;
use gpui_prose::layout::Item;
use serde_json::{Value, json};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const WIDTH: f32 = 900.;
const HEIGHT: f32 = 800.;
/// Frames a jump may take to settle (the caret's autoscroll after layout).
const SETTLE_FRAMES: usize = 5;
/// A one-minute load above this marks the numbers as reference only.
const BUSY_LOAD: f64 = 2.0;
/// A scroll that has not reached the end after this many frames is stuck.
const MAX_SCROLL_FRAMES: usize = 200_000;

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn summary(samples: &[f64]) -> Value {
    serde_json::to_value(Summary::of(samples)).expect("summary")
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

#[cfg(target_os = "macos")]
fn phys_footprint_mb() -> f64 {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: proc_pid_rusage writes a rusage_info_v4 into the buffer.
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

/// CPU time this thread has run, in ms: a frame's CPU time leaves out the
/// time the scheduler gave its core to other processes.
#[cfg(target_os = "macos")]
fn thread_cpu_ms() -> f64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime writes one timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}

#[cfg(not(target_os = "macos"))]
fn thread_cpu_ms() -> f64 {
    0.0
}

/// Ends the process if the run takes longer than `seconds`.
fn watchdog(seconds: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        eprintln!("book-bench: no result after {seconds} s, giving up");
        std::process::exit(3);
    });
}

fn step(what: &str, since: Instant) {
    eprintln!("[{:7.1} s] {what}", since.elapsed().as_secs_f64());
}

/// The page in the headless window: the book, when one is open.
struct Root {
    book: Option<Entity<BookEditor>>,
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().children(self.book.clone())
    }
}

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    root: Entity<Root>,
}

impl Headless {
    fn new() -> Headless {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(()),
            gpui_platform::current_headless_renderer,
        );
        // The workspace wakes the editor's event bridge from its own threads.
        cx.allow_parking();
        let mut slot = None;
        let window = cx
            .open_window(size(px(WIDTH), px(HEIGHT)), |_, cx| {
                let root = cx.new(|_| Root { book: None });
                slot = Some(root.clone());
                root
            })
            .expect("open the headless window");
        let mut h = Headless {
            cx,
            window: window.into(),
            root: slot.expect("the root"),
        };
        h.draw();
        h
    }

    fn update<R>(&mut self, f: impl FnOnce(&Entity<Root>, &mut Window, &mut gpui::App) -> R) -> R {
        let root = self.root.clone();
        self.cx
            .update_window(self.window, |_, window, cx| f(&root, window, cx))
            .expect("the window")
    }

    fn book<R>(
        &mut self,
        f: impl FnOnce(&mut BookEditor, &mut Window, &mut Context<BookEditor>) -> R,
    ) -> R {
        self.update(|root, window, cx| {
            let book = root.read(cx).book.clone().expect("an open book");
            book.update(cx, |b, cx| f(b, window, cx))
        })
    }

    fn editor(&mut self) -> Entity<ProseEditor> {
        self.update(|root, _, cx| {
            root.read(cx)
                .book
                .as_ref()
                .expect("an open book")
                .read(cx)
                .editor()
                .clone()
        })
    }

    /// Runs what is pending, then one frame (render, layout, paint), the
    /// editor re-rendered as a whole. The frame's CPU time in ms.
    fn draw(&mut self) -> f64 {
        self.cx.run_until_parked();
        self.frame()
    }

    /// One frame without running pending tasks first.
    fn frame(&mut self) -> f64 {
        self.update(|root, window, cx| {
            window.simulate_next_frame(cx);
            if let Some(book) = root.read(cx).book.clone() {
                let editor = book.read(cx).editor().clone();
                editor.update(cx, |_, cx| cx.notify());
            }
            root.update(cx, |_, cx| cx.notify());
            let t = Instant::now();
            window.draw(cx).clear(cx);
            ms(t.elapsed())
        })
    }

    fn top_item(&mut self) -> usize {
        let editor = self.editor();
        self.update(|_, _, cx| editor.read(cx).list_state().logical_scroll_top().item_ix)
    }

    /// The chapter at the top of the view.
    fn top_chapter(&mut self) -> usize {
        let editor = self.editor();
        self.update(|_, _, cx| {
            let e = editor.read(cx);
            match e.book().item(e.list_state().logical_scroll_top().item_ix) {
                Item::Title(chapter) | Item::Line(chapter, _) | Item::End(chapter) => chapter,
            }
        })
    }

    /// Draws the window into an image (`--capture`).
    fn save(&mut self, dir: Option<&Path>, name: &str) {
        let Some(dir) = dir else { return };
        let image = self
            .cx
            .capture_screenshot(self.window)
            .expect("capture the window");
        image.save(dir.join(name)).expect("write the screenshot");
    }
}

fn scenarios(ws: &Workspace, book: &str, capture: Option<&Path>, since: Instant) -> Value {
    let mut h = Headless::new();
    let load_start = evidence::load_average();
    let memory_start = phys_footprint_mb();

    // Opening the whole book: every chapter's session and document, then the
    // first frame. The first time the holders load from SQLite (cold); then
    // twice more with the workspace still warm.
    let mut opens = Vec::new();
    let mut built = Vec::new();
    let mut first_frames = Vec::new();
    for round in 0..3 {
        h.update(|root, _, cx| {
            root.update(cx, |r, cx| {
                r.book = None;
                cx.notify();
            })
        });
        h.draw();
        h.cx.run_until_parked();
        let (ws2, book2) = (ws.clone(), book.to_owned());
        let t0 = Instant::now();
        h.update(|root, window, cx| {
            let view = cx.new(|cx| {
                BookEditor::open(ws2, &book2, EditorSettings::default(), window, cx)
                    .expect("open the book")
            });
            root.update(cx, |r, cx| {
                r.book = Some(view);
                cx.notify();
            });
        });
        built.push(ms(t0.elapsed()));
        first_frames.push(h.draw());
        opens.push(ms(t0.elapsed()));
        step(&format!("opened the book ({round})"), since);
    }
    h.save(capture, "book-open.png");
    let memory_open = phys_footprint_mb();
    let (chapters, chars) = h.book(|b, _, cx| {
        let docs: Vec<String> = b.chapter_docs().map(str::to_owned).collect();
        let chars: usize = b
            .editor()
            .read(cx)
            .book()
            .chapters
            .iter()
            .map(|c| c.doc.len_chars())
            .sum();
        (docs, chars)
    });

    // Jumps from the table of contents, ending on the last chapter: the
    // first frame after the jump, and the frames until the view stops moving.
    let last = chapters.len().saturating_sub(1);
    let targets = [last, 0, last / 2, last, 10.min(last), last * 9 / 10, last];
    let mut jumps = Vec::new();
    let mut to_last = Vec::new();
    let mut settled = Vec::new();
    let mut landed = true;
    for &target in &targets {
        let doc = chapters[target].clone();
        h.cx.run_until_parked();
        let t0 = Instant::now();
        h.book(|b, window, cx| {
            b.jump_to(&doc, window, cx);
        });
        h.frame();
        let first = ms(t0.elapsed());
        let mut top = h.top_item();
        let mut frames = 1;
        while frames < SETTLE_FRAMES {
            h.draw();
            frames += 1;
            let now = h.top_item();
            if now == top {
                break;
            }
            top = now;
        }
        settled.push(ms(t0.elapsed()));
        jumps.push(first);
        if target == last {
            to_last.push(first);
        }
        let at = h.book(|b, _, cx| b.reading_position(cx));
        landed &= at.is_some_and(|at| at.doc == doc);
    }
    h.save(capture, "book-last-chapter.png");
    step("jumped", since);

    // From the first line to the last, half a viewport per frame.
    let first = chapters[0].clone();
    h.book(|b, window, cx| {
        b.jump_to(&first, window, cx);
    });
    for _ in 0..3 {
        h.draw();
    }
    let memory_before_scroll = phys_footprint_mb();
    let editor = h.editor();
    let viewport = h.update(|_, _, cx| {
        f64::from(f32::from(
            editor.read(cx).list_state().viewport_bounds().size.height,
        ))
    });
    let step_px = (viewport * 0.5).round();
    let mut work = Vec::new();
    let mut cpu = Vec::new();
    let mut tasks = Vec::new();
    // (ms, CPU ms, frame, chapter at the top) of the frames over budget.
    let mut frames = Vec::new();
    let t0 = Instant::now();
    let mut reached_end = false;
    while work.len() < MAX_SCROLL_FRAMES {
        let t = Instant::now();
        h.cx.run_until_parked();
        tasks.push(ms(t.elapsed()));
        let t = Instant::now();
        let c = thread_cpu_ms();
        let at_end = h.update(|_, _, cx| {
            editor.update(cx, |e, cx| {
                let (y, total) = e.scroll_y();
                if y + viewport >= total - 1.0 {
                    return true;
                }
                e.scroll_by_estimate(step_px, cx);
                false
            })
        });
        if at_end {
            reached_end = true;
            break;
        }
        h.frame();
        let took = ms(t.elapsed());
        let took_cpu = thread_cpu_ms() - c;
        work.push(took);
        cpu.push(took_cpu);
        if took > 16.7 {
            let chapter = h.top_chapter();
            frames.push((took, took_cpu, work.len() - 1, chapter));
        }
        if work.len() % 2000 == 0 {
            step(&format!("scrolled {} frames", work.len()), since);
        }
    }
    let scroll_seconds = t0.elapsed().as_secs_f64();
    step("scrolled to the end", since);
    h.draw();
    let memory_after_scroll = phys_footprint_mb();
    let end_doc = h.book(|b, _, cx| b.reading_position(cx)).map(|at| at.doc);
    let load_end = evidence::load_average();
    drop(h);

    let open_max = opens.iter().copied().fold(0.0, f64::max);
    let busy = [load_start, load_end]
        .into_iter()
        .any(|l| l.is_none_or(|l| l > BUSY_LOAD));
    frames.sort_by(|a, b| b.0.total_cmp(&a.0));
    let over_budget = frames.len();
    let slowest: Vec<Value> = frames
        .iter()
        .take(8)
        .map(|&(took, took_cpu, frame, chapter)| {
            json!({"ms": round3(took), "cpu_ms": round3(took_cpu), "frame": frame, "chapter": chapter})
        })
        .collect();
    json!({
        "chapters": chapters.len(),
        "book_chars": chars,
        "window_px": [WIDTH, HEIGHT],
        "load_average_1m": { "start": load_start, "end": load_end },
        // Over this load other processes take whole frames from the bench:
        // the numbers are for reference, the final ones wait for an idle run.
        "conditions": {
            "busy_above_load_1m": BUSY_LOAD,
            "reference_only": busy,
        },
        "open_book": {
            "to_first_frame_ms": opens.iter().copied().map(round3).collect::<Vec<_>>(),
            "cold_ms": opens.first().copied().map(round3),
            "sessions_and_documents_ms": built.iter().copied().map(round3).collect::<Vec<_>>(),
            "first_frame_ms": first_frames.iter().copied().map(round3).collect::<Vec<_>>(),
            "max_ms": round3(open_max),
            "budget_ms": 200.0,
        },
        "jump": {
            "first_frame_ms": jumps.iter().copied().map(round3).collect::<Vec<_>>(),
            "settled_ms": settled.iter().copied().map(round3).collect::<Vec<_>>(),
            "to_last_max_ms": round3(to_last.iter().copied().fold(0.0, f64::max)),
            "landed_in_the_chapter": landed,
            "budget_ms": 150.0,
        },
        "scroll_full_book": {
            "frames": work.len(),
            "reached_end": reached_end,
            "ended_in_last_chapter": end_doc.as_deref() == chapters.last().map(String::as_str),
            "seconds": round3(scroll_seconds),
            "viewport_px": viewport,
            "step_px": step_px,
            "frame": summary(&work),
            "frame_cpu": summary(&cpu),
            "frames_over_16_7_ms": over_budget,
            "slowest": slowest,
            "pending_tasks_between_frames": summary(&tasks),
            "budget_p95_ms": 16.7,
        },
        "memory_mb": {
            "start": memory_start,
            "book_open": memory_open,
            "before_scroll": memory_before_scroll,
            "after_scroll": memory_after_scroll,
            "budget_after_scroll": 800.0,
        },
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let write = args.iter().any(|a| a == "--write");
    let capture = args
        .iter()
        .position(|a| a == "--capture")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    let timeout = args
        .iter()
        .position(|a| a == "--timeout")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(900);
    watchdog(timeout);
    let since = Instant::now();
    let dir = tempfile::tempdir().expect("temp dir");
    let seeded = seed::generate(Preset::Heavy, seed::DEFAULT_SEED).expect("seed");
    {
        let lib = dr_store::Library::open(dir.path(), library_options(VERSION)).expect("library");
        seeded.write_to(&lib).expect("write the seed");
        // Search and derived indexes built now: in a library that has been
        // open a while they are, and a rebuild in the background holds
        // SQLite's write lock in front of the keystrokes being measured.
        lib.rebuild_stale_indexes().expect("build the indexes");
        lib.close().expect("close");
    }
    step("seeded the heavy preset", since);
    let lib = dr_store::Library::open(dir.path(), library_options(VERSION)).expect("library");
    let ws = Workspace::open(lib, WorkspaceOptions::default()).expect("workspace");
    let book = ws
        .call(&Actor::User, "book.list", json!({}))
        .expect("books")["output"][0]["id"]
        .as_str()
        .expect("a book")
        .to_owned();
    let corpus = seeded.shape().to_json();
    // The generator's copy of the book is not part of what is measured.
    drop(seeded);
    if let Some(dir) = &capture {
        std::fs::create_dir_all(dir).expect("the capture folder");
    }
    let results = scenarios(&ws, &book, capture.as_deref(), since);
    let _ = ws.shutdown();
    step("done", since);
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
    // The contract, checked on the spot: no evidence without it.
    let held = [
        (
            "every jump landed in its chapter",
            &results["jump"]["landed_in_the_chapter"],
        ),
        (
            "the scroll reached the end",
            &results["scroll_full_book"]["reached_end"],
        ),
        (
            "the scroll ended in the last chapter",
            &results["scroll_full_book"]["ended_in_last_chapter"],
        ),
    ];
    let broken: Vec<&str> = held
        .iter()
        .filter(|(_, v)| v.as_bool() != Some(true))
        .map(|(what, _)| *what)
        .collect();
    if !broken.is_empty() {
        eprintln!("book-bench: not true: {}", broken.join("; "));
        std::process::exit(1);
    }
    if write {
        let root = evidence::workspace_root();
        let mut e = Evidence::new(
            "book-bench",
            "m05-m1",
            "cargo run --release -p dr-editor --example book-bench -- --write",
        )
        .inputs(
            &root,
            &[
                "crates/dr-editor",
                "crates/gpui-prose",
                "crates/dr-workspace",
                "crates/dr-store",
                "crates/dr-doc",
                "crates/dr-testkit/src/seed",
            ],
        )
        .expect("fingerprint the inputs");
        e.corpus = corpus;
        e.results = results;
        let path = e
            .write(&root.join(evidence::DIR))
            .expect("write the evidence");
        eprintln!("wrote {}", path.display());
    }
}
