//! The whole book in one editor (M05) on F8's heavy seed: 100 chapters,
//! 1.5 million characters, each chapter its own workspace session. Measures
//! what `benchmarks.md` budgets for the whole book: opening it (to the first
//! painted frame), scrolling from the first line to the last, jumping to the
//! last chapter, and the process's memory after the scroll.
//!
//! ```text
//! cargo run --release -p dr-editor --example book-bench            # print
//! cargo run --release -p dr-editor --example book-bench -- --write # m05-m1-book-bench.json
//! ```
//!
//! A window opens on the built-in display for about a minute; leave it alone.
//! The one-minute load before and after is recorded (other builds on the
//! machine skew frame times).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_editor::{BookEditor, EditorSettings};
use dr_testkit::evidence::{self, Evidence, Summary};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use futures::channel::oneshot;
use gpui::{
    App, AppContext, AsyncApp, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled,
    Window, WindowBounds, WindowHandle, WindowOptions, div, px, size,
};
use serde_json::{Value, json};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn summary(samples: &[f64]) -> Value {
    serde_json::to_value(Summary::of(samples)).expect("summary")
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

struct Root {
    book: Option<Entity<BookEditor>>,
    /// When the current frame started (the root renders first).
    frame_start: Rc<Cell<Instant>>,
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        self.frame_start.set(Instant::now());
        let mut root = div().size_full();
        if let Some(book) = &self.book {
            root = root.child(book.clone());
        }
        root
    }
}

async fn sleep(cx: &AsyncApp, d: Duration) {
    cx.background_executor().timer(d).await;
}

/// Runs `f` on the book's editor and resolves when the next frame with it
/// painted reaches the screen's next refresh (`None` after three seconds).
async fn and_painted(
    window: &WindowHandle<Root>,
    cx: &mut AsyncApp,
    f: impl FnOnce(&mut BookEditor, &mut Window, &mut Context<BookEditor>),
) -> Option<Instant> {
    let (tx, rx) = oneshot::channel::<Instant>();
    let armed = window.update(cx, |root, window, cx| {
        let book = root.book.clone()?;
        book.update(cx, |b, cx| {
            let editor = b.editor().clone();
            editor.update(cx, |e, _| {
                e.after_next_paint(move |window, _| {
                    window.on_next_frame(move |_, _| {
                        let _ = tx.send(Instant::now());
                    });
                })
            });
            f(b, window, cx);
        });
        Some(())
    });
    armed.ok().flatten()?;
    let timeout = cx.background_executor().timer(Duration::from_secs(3));
    match futures::future::select(rx, Box::pin(timeout)).await {
        futures::future::Either::Left((Ok(t), _)) => Some(t),
        _ => None,
    }
}

#[derive(Default)]
struct Scroll {
    ticks: Vec<Instant>,
    work: Vec<f64>,
    painted: Option<(Instant, Instant)>,
}

/// One frame of the scroll: half a viewport down, until the end.
fn scroll_tick(
    window: &mut Window,
    cx: &mut App,
    editor: Entity<gpui_prose::ProseEditor>,
    frame_start: Rc<Cell<Instant>>,
    step: f64,
    viewport: f64,
    run: Rc<RefCell<Scroll>>,
    done: Rc<RefCell<Option<oneshot::Sender<()>>>>,
) {
    {
        let mut r = run.borrow_mut();
        r.ticks.push(Instant::now());
        if let Some((start, painted)) = r.painted.take() {
            r.work.push(ms(painted.saturating_duration_since(start)));
        }
    }
    let at_end = editor.update(cx, |e, cx| {
        let (y, total) = e.scroll_y();
        if y + viewport >= total - 1.0 {
            return true;
        }
        let (run, frame_start) = (run.clone(), frame_start.clone());
        e.after_next_paint(move |_, _| {
            run.borrow_mut().painted = Some((frame_start.get(), Instant::now()));
        });
        e.scroll_by_estimate(step, cx);
        false
    });
    if at_end || run.borrow().ticks.len() > 60_000 {
        if let Some(tx) = done.borrow_mut().take() {
            let _ = tx.send(());
        }
        return;
    }
    window.on_next_frame(move |window, cx| {
        scroll_tick(window, cx, editor, frame_start, step, viewport, run, done)
    });
}

async fn scenarios(
    window: WindowHandle<Root>,
    ws: Workspace,
    book: String,
    cx: &mut AsyncApp,
) -> Value {
    sleep(cx, Duration::from_millis(800)).await;
    let load_start = evidence::load_average();
    let memory_start = phys_footprint_mb();

    // Opening the whole book: every chapter's session and document, then the
    // first frame. The first time the holders load from SQLite (cold); then
    // twice more with the holders still open (warm).
    let mut opens = Vec::new();
    let mut opened_docs = Vec::new();
    for _ in 0..3 {
        let _ = window.update(cx, |root, _, cx| {
            root.book = None;
            cx.notify();
        });
        sleep(cx, Duration::from_millis(400)).await;
        let t0 = Instant::now();
        let (ws2, book2) = (ws.clone(), book.clone());
        let ok = window.update(cx, |root, window, cx| {
            let view = cx.new(|cx| {
                BookEditor::open(ws2, &book2, EditorSettings::default(), window, cx)
                    .expect("open the book")
            });
            root.book = Some(view);
            cx.notify();
        });
        let built = t0.elapsed();
        if ok.is_err() {
            break;
        }
        opened_docs.push(ms(built));
        if let Some(t) = and_painted(&window, cx, |_, _, cx| cx.notify()).await {
            opens.push(ms(t - t0));
        }
    }
    let memory_open = phys_footprint_mb();
    let chapters = window
        .update(cx, |root, _, cx| {
            root.book
                .as_ref()
                .map(|b| {
                    b.read(cx)
                        .chapter_docs()
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let chars: usize = window
        .update(cx, |root, _, cx| {
            root.book.as_ref().map_or(0, |b| {
                b.read(cx)
                    .editor()
                    .read(cx)
                    .book()
                    .chapters
                    .iter()
                    .map(|c| c.doc.len_chars())
                    .sum()
            })
        })
        .unwrap_or(0);

    // Jumps from the table of contents, ending on the last chapter.
    let last = chapters.len().saturating_sub(1);
    let targets = [last, 0, last / 2, last, 10.min(last), last * 9 / 10, last];
    let mut jumps = Vec::new();
    let mut to_last = Vec::new();
    for &target in &targets {
        let doc = chapters[target].clone();
        let t0 = Instant::now();
        if let Some(t) = and_painted(&window, cx, move |b, window, cx| {
            b.jump_to(&doc, window, cx);
        })
        .await
        {
            jumps.push(ms(t - t0));
            if target == last {
                to_last.push(ms(t - t0));
            }
        }
        sleep(cx, Duration::from_millis(250)).await;
    }

    // From the first line to the last, half a viewport per frame.
    let first = chapters[0].clone();
    let _ = and_painted(&window, cx, move |b, window, cx| {
        b.jump_to(&first, window, cx);
    })
    .await;
    sleep(cx, Duration::from_millis(600)).await;
    let memory_before_scroll = phys_footprint_mb();
    let (tx, rx) = oneshot::channel::<()>();
    let run: Rc<RefCell<Scroll>> = Rc::default();
    let t0 = Instant::now();
    let started = window.update(cx, |root, window, cx| {
        let editor = root.book.as_ref()?.read(cx).editor().clone();
        let viewport = f64::from(f32::from(
            editor.read(cx).list_state().viewport_bounds().size.height,
        ));
        let step = (viewport * 0.5).round();
        let (frame_start, run, done) = (
            root.frame_start.clone(),
            run.clone(),
            Rc::new(RefCell::new(Some(tx))),
        );
        window.on_next_frame(move |window, cx| {
            scroll_tick(window, cx, editor, frame_start, step, viewport, run, done)
        });
        Some(viewport)
    });
    let viewport = started.ok().flatten().unwrap_or(0.0);
    let _ = rx.await;
    let scroll_seconds = t0.elapsed().as_secs_f64();
    sleep(cx, Duration::from_millis(500)).await;
    let memory_after_scroll = phys_footprint_mb();
    let (work, interval) = {
        let r = run.borrow();
        let interval: Vec<f64> = r.ticks.windows(2).map(|w| ms(w[1] - w[0])).collect();
        (r.work.clone(), interval)
    };
    let load_end = evidence::load_average();

    json!({
        "chapters": chapters.len(),
        "book_chars": chars,
        "load_average_1m": { "start": load_start, "end": load_end },
        "open_book": {
            "to_first_frame_ms": opens,
            "cold_ms": opens.first(),
            "sessions_and_documents_ms": opened_docs,
            "budget_ms": 200.0,
        },
        "jump": {
            "all_ms": jumps,
            "to_last_max_ms": to_last.iter().copied().fold(0.0, f64::max),
            "budget_ms": 150.0,
        },
        "scroll_full_book": {
            "frames": interval.len(),
            "seconds": (scroll_seconds * 1000.0).round() / 1000.0,
            "viewport_px": viewport,
            "work": summary(&work),
            "interval": summary(&interval),
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
    let write = std::env::args().any(|a| a == "--write");
    let dir = tempfile::tempdir().expect("temp dir");
    let t = Instant::now();
    let seeded = seed::generate(Preset::Heavy, seed::DEFAULT_SEED).expect("seed");
    {
        let lib = dr_store::Library::open(dir.path(), library_options(VERSION)).expect("library");
        seeded.write_to(&lib).expect("write the seed");
        lib.close().expect("close");
    }
    eprintln!(
        "seeded the heavy preset in {:.1} s",
        t.elapsed().as_secs_f64()
    );
    let lib = dr_store::Library::open(dir.path(), library_options(VERSION)).expect("library");
    let ws = Workspace::open(lib, WorkspaceOptions::default()).expect("workspace");
    let book = ws
        .call(&Actor::User, "book.list", json!({}))
        .expect("books")["output"][0]["id"]
        .as_str()
        .expect("a book")
        .to_owned();
    let corpus = seeded.shape().to_json();
    let results: Rc<RefCell<Option<Value>>> = Rc::default();
    let out = results.clone();
    let ws2 = ws.clone();
    gpui_platform::application().run(move |cx: &mut App| {
        gpui_prose::bind_keys(cx);
        let bounds = Bounds::centered(None, size(px(900.), px(800.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                |_, cx| {
                    cx.new(|_| Root {
                        book: None,
                        frame_start: Rc::new(Cell::new(Instant::now())),
                    })
                },
            )
            .expect("open the window");
        cx.activate(true);
        cx.spawn(async move |cx| {
            let r = scenarios(window, ws2, book, cx).await;
            *out.borrow_mut() = Some(r);
            let _ = window.update(cx, |_, window, _| window.remove_window());
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
    let Some(results) = results.borrow_mut().take() else {
        eprintln!("no results");
        std::process::exit(1);
    };
    let _ = ws.shutdown();
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
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
