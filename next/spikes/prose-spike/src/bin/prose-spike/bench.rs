//! Probe-tier measurements (docs/rust-rewrite/benchmarks.md).
//!
//! `window` runs every frame-level scenario in one real window and writes
//! `p0-b-window.json`; `headless` measures the write path and cold opens
//! without a window and writes `p0-b-headless.json`; `check` verifies that
//! evidence files match the current sources and corpus.
//!
//! How "on screen" is timed: GPUI draws a frame on a display-link tick and
//! presents it; the frame becomes visible at the next vsync, which is also when
//! the next display-link tick runs `on_next_frame` callbacks. A probe armed
//! before an action records the end of the editor's next paint and then the
//! next tick. "Presented" below is that next tick.

use std::{
    cell::{Cell, RefCell},
    future::Future,
    rc::Rc,
    sync::{Arc, Mutex},
    task::{Poll, Waker},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use gpui::{App, AsyncApp, Context, EntityInputHandler, SharedString, Window, WindowHandle};
use prose_spike::{
    book::Book,
    doc::{BlockKind, ORIGIN_USER, ProseDoc},
    editor::{ProseEditor, ProseStyle},
    heights::estimate_height,
};

use crate::{
    platform,
    report::{self, J, percentile},
    shell::{self, Corpus, Root},
    synth,
};

// ----- a one-shot signal for awaiting frame callbacks ------------------------

struct SignalState<T> {
    value: Option<T>,
    waker: Option<Waker>,
}

pub struct Signal<T>(Rc<RefCell<SignalState<T>>>);

impl<T> Clone for Signal<T> {
    fn clone(&self) -> Self {
        Signal(self.0.clone())
    }
}

impl<T> Signal<T> {
    fn new() -> Signal<T> {
        Signal(Rc::new(RefCell::new(SignalState {
            value: None,
            waker: None,
        })))
    }

    /// First value wins.
    fn set(&self, value: T) {
        let waker = {
            let mut state = self.0.borrow_mut();
            if state.value.is_none() {
                state.value = Some(value);
            }
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    fn wait(&self) -> impl Future<Output = T> + '_ {
        std::future::poll_fn(move |cx| {
            let mut state = self.0.borrow_mut();
            match state.value.take() {
                Some(value) => Poll::Ready(value),
                None => {
                    state.waker = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        })
    }
}

#[derive(Clone, Copy)]
struct Frame {
    painted: Instant,
    presented: Instant,
}

/// Arms a probe on the editor's next paint; resolves `None` after a timeout.
fn arm(editor: &mut ProseEditor, cx: &mut Context<ProseEditor>) -> Signal<Option<Frame>> {
    let signal = Signal::new();
    let hook_signal = signal.clone();
    editor.after_next_paint(move |window, _cx| {
        let painted = Instant::now();
        window.on_next_frame(move |_, _| {
            hook_signal.set(Some(Frame {
                painted,
                presented: Instant::now(),
            }));
        });
    });
    let timeout = signal.clone();
    cx.spawn(async move |_, cx| {
        cx.background_executor().timer(Duration::from_secs(3)).await;
        timeout.set(None);
    })
    .detach();
    signal
}

async fn sleep(cx: &AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn editor_do<R>(
    window: &WindowHandle<Root>,
    cx: &mut AsyncApp,
    f: impl FnOnce(&mut ProseEditor, &mut Window, &mut Context<ProseEditor>) -> R,
) -> Option<R> {
    window
        .update(cx, |root, window, cx| {
            let editor = root.editor.clone()?;
            Some(editor.update(cx, |editor, cx| f(editor, window, cx)))
        })
        .ok()
        .flatten()
}

fn today() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() / 86_400) as i64;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

fn machine_json() -> J {
    let m = platform::machine();
    J::obj(vec![
        ("cpu", J::str(m.cpu)),
        ("model", J::str(m.model)),
        ("cores", J::Int(m.cores as i64)),
        ("memory_gb", J::Int(m.memory_gb as i64)),
        ("os", J::str(format!("macOS {}", m.os))),
    ])
}

fn build_json() -> J {
    J::obj(vec![
        (
            "profile",
            J::str(if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }),
        ),
        ("gpui", J::str("zed v1.27.0 (git tag), runtime_shaders")),
        ("loro", J::str("=1.17.1")),
    ])
}

fn corpus_json(name: &str, seed: u64, corpus: &Corpus) -> (&'static str, J) {
    let key = if name == "chapter" { "chapter" } else { "book" };
    (
        key,
        J::obj(vec![
            ("seed", J::str(format!("{seed:#x}"))),
            ("chapters", J::Int(corpus.snapshots.len() as i64)),
            ("chars", J::Int(corpus.chars as i64)),
            ("fingerprint", J::str(corpus.fingerprint.clone())),
        ]),
    )
}

fn verdict(value: f64, budget: f64) -> J {
    J::Bool(value.is_finite() && value <= budget)
}

// ----- window scenarios -------------------------------------------------------

pub fn run_window(out: Option<String>, quick: bool) {
    gpui_platform::application().run(move |cx: &mut App| {
        let book = Corpus::book();
        let chapter = Corpus::chapter();
        let titles: Vec<SharedString> = book
            .titles
            .iter()
            .cloned()
            .map(SharedString::from)
            .collect();
        let (window, display) = shell::open_window(cx, titles, true, true, true);
        let out = out.clone();
        cx.spawn(async move |cx| {
            let report = window_scenarios(window, &book, &chapter, display, quick, cx).await;
            let text = report.to_pretty();
            match &out {
                Some(path) => std::fs::write(path, text).expect("write the evidence file"),
                None => print!("{text}"),
            }
            let _ = window.update(cx, |_, window, _| window.remove_window());
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}

async fn open_and_probe(
    window: &WindowHandle<Root>,
    corpus: &Corpus,
    cx: &mut AsyncApp,
) -> (f64, f64, Option<f64>) {
    // Close whatever is open and let a frame pass.
    let _ = window.update(cx, |root, _, cx| {
        root.editor = None;
        cx.notify();
    });
    sleep(cx, Duration::from_millis(400)).await;
    let t0 = Instant::now();
    let signal = window
        .update(cx, |root, window, cx| {
            let book = corpus.open();
            let opened = Instant::now();
            let editor = root.open(book, window, cx);
            let signal = editor.update(cx, arm);
            let focus = gpui::Focusable::focus_handle(editor.read(cx), cx);
            window.focus(&focus, cx);
            (opened, signal)
        })
        .ok();
    let Some((opened, signal)) = signal else {
        return (f64::NAN, f64::NAN, None);
    };
    let frame = signal.wait().await;
    (
        ms(opened - t0),
        frame.map_or(f64::NAN, |f| ms(f.painted - t0)),
        frame.map(|f| ms(f.presented - t0)),
    )
}

async fn idle_cpu(
    window: &WindowHandle<Root>,
    seconds: u64,
    focused: bool,
    cx: &mut AsyncApp,
) -> f64 {
    let _ = editor_do(window, cx, |editor, window, cx| {
        if focused {
            let focus = gpui::Focusable::focus_handle(editor, cx);
            window.focus(&focus, cx);
        } else {
            window.blur(cx);
        }
    });
    sleep(cx, Duration::from_secs(2)).await;
    let (cpu0, t0) = (platform::cpu_time(), Instant::now());
    sleep(cx, Duration::from_secs(seconds)).await;
    let (cpu1, t1) = (platform::cpu_time(), Instant::now());
    (cpu1 - cpu0).as_secs_f64() / (t1 - t0).as_secs_f64() * 100.0
}

#[derive(Default)]
struct ScrollRun {
    ticks: Vec<Instant>,
    work: Vec<f64>,
    painted: Option<(Option<Instant>, Instant)>,
}

/// One scroll step per display-link tick: the step is issued inside the tick's
/// next-frame callback, before that tick draws, so the scroll never waits a
/// frame for the measurement loop.
#[allow(clippy::too_many_arguments)]
fn scroll_tick(
    window: &mut Window,
    cx: &mut App,
    editor: gpui::Entity<ProseEditor>,
    frame_start: Rc<Cell<Option<Instant>>>,
    step: f64,
    viewport: f64,
    run: Rc<RefCell<ScrollRun>>,
    done: Signal<()>,
) {
    {
        let mut state = run.borrow_mut();
        state.ticks.push(Instant::now());
        if let Some((Some(start), painted)) = state.painted.take() {
            state
                .work
                .push(ms(painted.saturating_duration_since(start)));
        }
    }
    let at_end = editor.update(cx, |editor, cx| {
        let (y, total) = editor.scroll_y();
        if y + viewport >= total - 1.0 {
            return true;
        }
        let (run, frame_start) = (run.clone(), frame_start.clone());
        editor.after_next_paint(move |_, _| {
            run.borrow_mut().painted = Some((frame_start.get(), Instant::now()));
        });
        editor.scroll_by_estimate(step, cx);
        false
    });
    if at_end || run.borrow().ticks.len() > 40_000 {
        done.set(());
        return;
    }
    window.on_next_frame(move |window, cx| {
        scroll_tick(window, cx, editor, frame_start, step, viewport, run, done)
    });
}

#[derive(Default)]
struct Typed {
    call: Vec<f64>,
    paint: Vec<f64>,
    present: Vec<f64>,
}

/// Types `keys` characters at 8 per second (every 90th is Enter).
async fn type_keys(window: &WindowHandle<Root>, keys: usize, cx: &mut AsyncApp) -> Typed {
    let pool: Vec<char> = "春风又绿江南岸明月何时照我还人间四月芳菲尽山寺桃花始盛开"
        .chars()
        .collect();
    let mut typed = Typed::default();
    let t0 = Instant::now();
    for i in 0..keys {
        // 8 keys a second, each shifted by a different fraction of a 120 Hz
        // frame: 125 ms is exactly 15 frames, so without the shift every key
        // would land at the same point of the refresh cycle.
        let phase = Duration::from_micros(((i * 37) % 64) as u64 * 8_333 / 64);
        let slot = t0 + Duration::from_millis(125 * i as u64) + phase;
        let now = Instant::now();
        if slot > now {
            sleep(cx, slot - now).await;
        }
        let text = pool[i % pool.len()].to_string();
        let start = Instant::now();
        let probe = editor_do(window, cx, |editor, window, cx| {
            let signal = arm(editor, cx);
            if i % 90 == 89 {
                editor.press_enter(window, cx);
            } else {
                editor.replace_text_in_range(None, &text, window, cx);
            }
            (signal, Instant::now())
        });
        let Some((signal, called)) = probe else { break };
        typed.call.push(ms(called - start));
        if let Some(frame) = signal.wait().await {
            typed.paint.push(ms(frame.painted - start));
            typed.present.push(ms(frame.presented - start));
        }
    }
    typed
}

async fn window_scenarios(
    window: WindowHandle<Root>,
    book: &Corpus,
    chapter: &Corpus,
    display: Option<(gpui::DisplayId, bool, f64)>,
    quick: bool,
    cx: &mut AsyncApp,
) -> J {
    let idle_seconds = if quick { 5 } else { 30 };
    let typing_keys = if quick { 40 } else { 480 };
    sleep(cx, Duration::from_millis(800)).await;
    let memory_start = platform::phys_footprint();

    // Open the full book (100 cold Loro snapshots → first screen), three times.
    let mut book_opens = Vec::new();
    for _ in 0..3 {
        book_opens.push(open_and_probe(&window, book, cx).await);
    }
    let book_present: Vec<f64> = book_opens.iter().filter_map(|o| o.2).collect();
    let book_import: Vec<f64> = book_opens.iter().map(|o| o.0).collect();
    let memory_book_open = platform::phys_footprint();
    sleep(cx, Duration::from_millis(600)).await;

    let idle_book = idle_cpu(&window, idle_seconds, true, cx).await;
    let idle_book_unfocused = idle_cpu(&window, idle_seconds, false, cx).await;

    // Jumps from the table of contents, ending on the last chapter.
    let last = book.snapshots.len() - 1;
    let targets = [last, 0, 50, last, 10, 90, last, 25, 75, last];
    let mut jumps = Vec::new();
    let mut jumps_to_last = Vec::new();
    for &target in &targets {
        let t0 = Instant::now();
        let signal = editor_do(&window, cx, |editor, window, cx| {
            let signal = arm(editor, cx);
            editor.jump_to_chapter(target, window, cx);
            signal
        });
        if let Some(signal) = signal
            && let Some(frame) = signal.wait().await
        {
            let latency = ms(frame.presented - t0);
            jumps.push(latency);
            if target == last {
                jumps_to_last.push(latency);
            }
        }
        sleep(cx, Duration::from_millis(250)).await;
    }

    // Scroll the whole book from top to bottom, half a viewport per frame.
    let _ = editor_do(&window, cx, |editor, window, cx| {
        editor.jump_to_chapter(0, window, cx)
    });
    sleep(cx, Duration::from_millis(600)).await;
    let memory_before_scroll = platform::phys_footprint();
    let viewport = editor_do(&window, cx, |editor, _, _| {
        f64::from(f32::from(editor.list_state().viewport_bounds().size.height))
    })
    .unwrap_or(700.0);
    let step = (viewport * 0.5).round();
    let run: Rc<RefCell<ScrollRun>> = Rc::default();
    let done: Signal<()> = Signal::new();
    let scroll_t0 = Instant::now();
    let cpu0 = platform::cpu_time();
    let _ = window.update(cx, |root, window, _cx| {
        if let Some(editor) = root.editor.clone() {
            let (frame_start, run, done) = (root.frame_start.clone(), run.clone(), done.clone());
            window.on_next_frame(move |window, cx| {
                scroll_tick(window, cx, editor, frame_start, step, viewport, run, done)
            });
        }
    });
    done.wait().await;
    let (work, interval) = {
        let run = run.borrow();
        let interval: Vec<f64> = run.ticks.windows(2).map(|w| ms(w[1] - w[0])).collect();
        (run.work.clone(), interval)
    };
    let scroll_seconds = scroll_t0.elapsed().as_secs_f64();
    let scroll_cpu = (platform::cpu_time() - cpu0).as_secs_f64() / scroll_seconds * 100.0;
    sleep(cx, Duration::from_millis(500)).await;
    let memory_after_scroll = platform::phys_footprint();
    let (estimate_error, measured_items, total_items, total_height) =
        editor_do(&window, cx, |editor, _, _| {
            let heights = editor.heights();
            let mut heights = heights.borrow_mut();
            (
                heights.mean_error().unwrap_or(f64::NAN),
                heights.measured_count(),
                heights.len(),
                heights.total(),
            )
        })
        .unwrap_or((f64::NAN, 0, 0, 0.0));
    let refresh = display.map_or(60.0, |d| if d.2 > 0.0 { d.2 } else { 60.0 });
    let frame_period = 1000.0 / refresh;
    let dropped = interval.iter().filter(|&&i| i > frame_period * 1.5).count();

    // Single 2万字 chapter: cold opens.
    let mut chapter_opens = Vec::new();
    for _ in 0..5 {
        chapter_opens.push(open_and_probe(&window, chapter, cx).await);
    }
    let chapter_present: Vec<f64> = chapter_opens.iter().filter_map(|o| o.2).collect();
    sleep(cx, Duration::from_millis(600)).await;

    // Typing at 8 characters per second in the middle of a body paragraph.
    let start_offset = editor_do(&window, cx, |editor, window, cx| {
        let doc = &mut editor.book_mut().chapters[0].doc;
        let lines = doc.visible_lines();
        let mut target = None;
        for ix in lines / 2..lines {
            let (kind, chars) = (doc.line(ix).kind, doc.line(ix).chars);
            if kind == BlockKind::Body && (60..400).contains(&chars) {
                target = Some(doc.line_start(ix) + chars / 2);
                break;
            }
        }
        let offset = target.unwrap_or(0);
        editor.select(0, offset..offset, window, cx);
        offset
    });
    sleep(cx, Duration::from_millis(500)).await;
    // Comparison: the same typing with the present-now hook on.
    platform::IMMEDIATE.store(true, std::sync::atomic::Ordering::Relaxed);
    let present_now = type_keys(&window, typing_keys / 3, cx).await;
    platform::IMMEDIATE.store(false, std::sync::atomic::Ordering::Relaxed);
    sleep(cx, Duration::from_millis(500)).await;
    let typing_t0 = Instant::now();
    let typing_cpu0 = platform::cpu_time();
    let typed = type_keys(&window, typing_keys, cx).await;
    let (key_call, key_paint, key_present) = (typed.call, typed.paint, typed.present);
    let typing_seconds = typing_t0.elapsed().as_secs_f64();
    let typing_cpu = (platform::cpu_time() - typing_cpu0).as_secs_f64() / typing_seconds * 100.0;

    // Pinyin composition: five marked-text updates, then the commit.
    let mut marked_present = Vec::new();
    let mut marked_bounds = Vec::new();
    let mut commits_written_once = true;
    let words = if quick { 6 } else { 40 };
    for w in 0..words {
        let steps = ["n", "ni", "ni h", "ni ha", "ni hao"];
        let loro_before = editor_do(&window, cx, |editor, _, _| {
            editor.book().chapters[0].doc.text().len_unicode()
        });
        for step in steps {
            let t0 = Instant::now();
            let probe = editor_do(&window, cx, |editor, window, cx| {
                let signal = arm(editor, cx);
                let len = step.encode_utf16().count();
                editor.replace_and_mark_text_in_range(None, step, Some(len..len), window, cx);
                // What the input method asks next: where to put the candidates.
                let tb = Instant::now();
                let marked = editor.marked_text_range(window, cx);
                let rect = marked
                    .and_then(|r| editor.bounds_for_range(r, gpui::Bounds::default(), window, cx));
                (signal, ms(tb.elapsed()), rect.is_some())
            });
            let Some((signal, bounds_ms, has_rect)) = probe else {
                break;
            };
            if has_rect {
                marked_bounds.push(bounds_ms);
            }
            if let Some(frame) = signal.wait().await {
                marked_present.push(ms(frame.presented - t0));
            }
            sleep(cx, Duration::from_millis(40)).await;
        }
        let loro_during = editor_do(&window, cx, |editor, _, _| {
            editor.book().chapters[0].doc.text().len_unicode()
        });
        let _ = editor_do(&window, cx, |editor, window, cx| {
            editor.replace_text_in_range(
                None,
                if w % 2 == 0 { "你好" } else { "世界" },
                window,
                cx,
            );
        });
        let loro_after = editor_do(&window, cx, |editor, _, _| {
            editor.book().chapters[0].doc.text().len_unicode()
        });
        if loro_before != loro_during || loro_after.zip(loro_before).map(|(a, b)| a - b) != Some(2)
        {
            commits_written_once = false;
        }
        sleep(cx, Duration::from_millis(120)).await;
    }

    let idle_chapter = idle_cpu(&window, idle_seconds, true, cx).await;
    let memory_end = platform::phys_footprint();

    let mb = |bytes: u64| J::Num((bytes as f64 / (1 << 20) as f64 * 10.0).round() / 10.0);
    let (display_builtin, display_hz) = display.map_or((false, 0.0), |d| (d.1, d.2));
    let open_book_median = percentile(&book_present, 50.0);
    let open_chapter_median = percentile(&chapter_present, 50.0);
    let key_p95 = percentile(&key_present, 95.0);
    let work_p95 = percentile(&work, 95.0);
    let interval_p95 = percentile(&interval, 95.0);
    let jump_last_max = report::max(&jumps_to_last);
    let marked_p95 = percentile(&marked_present, 95.0);

    J::obj(vec![
        ("schema", J::str("drifting.p0-b.window/1")),
        ("generated_at", J::str(today())),
        ("source_fingerprint", J::str(report::source_fingerprint())),
        ("quick", J::Bool(quick)),
        ("machine", machine_json()),
        (
            "display",
            J::obj(vec![
                ("builtin", J::Bool(display_builtin)),
                ("refresh_hz", J::Num(display_hz)),
            ]),
        ),
        ("build", build_json()),
        (
            "corpus",
            J::Obj(vec![
                {
                    let (k, v) = corpus_json("chapter", shell::CHAPTER_SEED, chapter);
                    (k.to_owned(), v)
                },
                {
                    let (k, v) = corpus_json("book", shell::BOOK_SEED, book);
                    (k.to_owned(), v)
                },
            ]),
        ),
        (
            "open_chapter",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "Click-equivalent: import the chapter's Loro snapshot, build the editor, until the frame with the first screen of text is presented. Five cold opens.",
                    ),
                ),
                (
                    "import_and_build_ms",
                    J::samples(&chapter_opens.iter().map(|o| o.0).collect::<Vec<_>>()),
                ),
                (
                    "first_paint_ms",
                    J::samples(&chapter_opens.iter().map(|o| o.1).collect::<Vec<_>>()),
                ),
                ("presented_ms", J::samples(&chapter_present)),
                ("median_ms", J::ms(open_chapter_median)),
                ("budget_ms", J::Num(80.0)),
                ("pass", verdict(open_chapter_median, 80.0)),
            ]),
        ),
        (
            "open_book",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "Import 100 chapter snapshots (1.5M chars), build the book view, until the first screen is presented. Three cold opens; heights of off-screen paragraphs are estimated afterwards on a background thread.",
                    ),
                ),
                ("import_and_build_ms", J::samples(&book_import)),
                ("presented_ms", J::samples(&book_present)),
                ("median_ms", J::ms(open_book_median)),
                ("budget_ms", J::Num(200.0)),
                ("pass", verdict(open_book_median, 200.0)),
            ]),
        ),
        (
            "keystroke_to_present",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "In-process: the same EntityInputHandler::replace_text_in_range call macOS insertText makes, at 8 chars/s with the key times spread evenly over a 120 Hz frame, in the middle of a paragraph of the 20k-char chapter (every 90th key is Enter), stock GPUI timing: the edit marks the window dirty and GPUI draws on the next display-link tick. Measured to the display-link tick after the frame that painted the change. Excludes AppKit event dispatch before insertText.",
                    ),
                ),
                ("handler_ms", report::summary(&key_call)),
                ("painted_ms", report::summary(&key_paint)),
                ("presented", report::summary(&key_present)),
                ("presented_samples_ms", J::samples(&key_present)),
                (
                    "present_now_comparison",
                    J::obj(vec![
                        (
                            "method",
                            J::str(
                                "Same typing with the present-now hook on: each edit sends setNeedsDisplay to GPUI's view, so Core Animation calls displayLayer and GPUI draws before the next display-link tick. GPUI stops and restarts the display link around that draw, so 'presented' (the next tick) is only an upper bound on this path.",
                            ),
                        ),
                        ("painted_ms", report::summary(&present_now.paint)),
                        ("presented", report::summary(&present_now.present)),
                        ("presented_samples_ms", J::samples(&present_now.present)),
                    ]),
                ),
                ("budget_p95_ms", J::Num(16.0)),
                ("pass", verdict(key_p95, 16.0)),
            ]),
        ),
        (
            "typing_cpu",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "Whole-process CPU time (getrusage user+sys) over the typing run, as percent of one core.",
                    ),
                ),
                ("seconds", J::Num((typing_seconds * 10.0).round() / 10.0)),
                ("keys", J::Int(typing_keys as i64)),
                ("percent", J::Num((typing_cpu * 100.0).round() / 100.0)),
                ("budget_percent", J::Num(15.0)),
                ("pass", verdict(typing_cpu, 15.0)),
            ]),
        ),
        (
            "idle_cpu",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "Editor focused, cursor blinking (530 ms), nothing else happening; whole-process CPU time over the window, as percent of one core.",
                    ),
                ),
                ("seconds", J::Int(idle_seconds as i64)),
                ("book_percent", J::Num((idle_book * 100.0).round() / 100.0)),
                (
                    "book_unfocused_no_blink_percent",
                    J::Num((idle_book_unfocused * 100.0).round() / 100.0),
                ),
                (
                    "chapter_percent",
                    J::Num((idle_chapter * 100.0).round() / 100.0),
                ),
                ("budget_percent", J::Num(1.0)),
                ("pass", J::Bool(idle_book <= 1.0 && idle_chapter <= 1.0)),
            ]),
        ),
        (
            "scroll_full_book",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "From the top of chapter 1 to the end of chapter 100, one step of half a viewport per frame, each step issued as soon as the previous frame was presented. work = render start to end of the editor's paint; interval = between consecutive presented ticks.",
                    ),
                ),
                ("frames", J::Int(work.len() as i64)),
                ("px_per_frame", J::Num(step)),
                ("seconds", J::Num((scroll_seconds * 10.0).round() / 10.0)),
                ("work", report::summary(&work)),
                ("interval", report::summary(&interval)),
                ("frames_over_1_5_periods", J::Int(dropped as i64)),
                ("cpu_percent", J::Num((scroll_cpu * 10.0).round() / 10.0)),
                ("work_samples_ms", J::samples(&work)),
                ("budget_p95_ms", J::Num(16.7)),
                (
                    "pass",
                    J::Bool(work_p95 <= 16.7 && interval_p95 <= 16.7 + 1.0),
                ),
            ]),
        ),
        (
            "jump",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "Table-of-contents click equivalent (scroll to the chapter's first item, cursor to its start) until presented; ten jumps, four of them to the last chapter.",
                    ),
                ),
                (
                    "targets",
                    J::Arr(targets.iter().map(|t| J::Int(*t as i64)).collect()),
                ),
                ("all_ms", J::samples(&jumps)),
                ("to_last_ms", J::samples(&jumps_to_last)),
                ("to_last_max_ms", J::ms(jump_last_max)),
                ("budget_ms", J::Num(150.0)),
                ("pass", verdict(jump_last_max, 150.0)),
            ]),
        ),
        (
            "memory",
            J::obj(vec![
                (
                    "method",
                    J::str("phys_footprint of the whole process (proc_pid_rusage), MB."),
                ),
                ("window_open_mb", mb(memory_start)),
                ("book_open_mb", mb(memory_book_open)),
                ("before_scroll_mb", mb(memory_before_scroll)),
                ("after_scroll_mb", mb(memory_after_scroll)),
                ("end_mb", mb(memory_end)),
                ("budget_mb", J::Num(800.0)),
                (
                    "pass",
                    J::Bool((memory_after_scroll as f64) / ((1 << 20) as f64) <= 800.0),
                ),
            ]),
        ),
        (
            "heights",
            J::obj(vec![
                ("items", J::Int(total_items as i64)),
                ("measured_after_scroll", J::Int(measured_items as i64)),
                ("total_px", J::Num(total_height.round())),
                (
                    "estimate_mean_abs_error",
                    J::Num((estimate_error * 1000.0).round() / 1000.0),
                ),
            ]),
        ),
        (
            "composition",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "In-process pinyin: five setMarkedText-equivalent updates per word, then insertText. Measures each update to presented, the bounds_for_range (candidate window) query, and that Loro's text length is unchanged while marked and grows by exactly the word on commit.",
                    ),
                ),
                ("words", J::Int(words as i64)),
                ("update_to_presented", report::summary(&marked_present)),
                ("bounds_query", report::summary(&marked_bounds)),
                ("marked_text_never_in_loro", J::Bool(commits_written_once)),
                ("budget_p95_ms", J::Num(16.0)),
                ("pass", J::Bool(marked_p95 <= 16.0 && commits_written_once)),
            ]),
        ),
        (
            "typing_start_offset",
            J::Int(start_offset.unwrap_or(0) as i64),
        ),
    ])
}

// ----- headless --------------------------------------------------------------

pub fn run_headless(out: Option<String>) {
    let book = Corpus::book();
    let chapter = Corpus::chapter();

    // Cold opens without a window: import each snapshot, build the mirror.
    let memory0 = platform::phys_footprint();
    let t0 = Instant::now();
    let docs: Vec<ProseDoc> = book
        .snapshots
        .iter()
        .map(|b| ProseDoc::from_snapshot(b).unwrap())
        .collect();
    let import_ms = ms(t0.elapsed());
    let memory1 = platform::phys_footprint();
    let snapshot_bytes: usize = book.snapshots.iter().map(Vec::len).sum();
    let paragraphs: usize = docs.iter().map(|d| d.visible_lines()).sum();

    // Background height estimate for the whole book at the default column.
    let style = ProseStyle::default();
    let t1 = Instant::now();
    let mut estimate_sum = 0.0f32;
    for doc in &docs {
        for line in &doc.lines()[..doc.visible_lines()] {
            estimate_sum += estimate_height(&line.text, &style.metrics(line.kind), 680.0);
        }
    }
    let estimate_ms = ms(t1.elapsed());
    let book_view = Book::new(
        docs.into_iter()
            .zip(&book.titles)
            .map(|(doc, title)| prose_spike::book::Chapter {
                title: SharedString::from(title.clone()),
                doc,
            })
            .collect(),
    );
    let items = book_view.item_count();
    drop(book_view);

    let t2 = Instant::now();
    let single = ProseDoc::from_snapshot(&chapter.snapshots[0]).unwrap();
    let chapter_import_ms = ms(t2.elapsed());

    // The write path: one keystroke = Loro insert + commit (event folded into
    // the mirror) + appending the encoded update to SQLite.
    let mut doc = single;
    let updates: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let _sub = doc.loro().subscribe_local_update(Box::new({
        let updates = updates.clone();
        move |bytes| {
            updates.lock().unwrap().push(bytes.to_vec());
            true
        }
    }));
    let db_path = std::env::temp_dir().join(format!("prose-spike-{}.sqlite", std::process::id()));
    let db = rusqlite::Connection::open(&db_path).expect("open a scratch SQLite file");
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
         CREATE TABLE loro_update(doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, origin TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(doc_id, seq));",
    )
    .unwrap();
    let mut insert = db
        .prepare(
            "INSERT INTO loro_update(doc_id, seq, bytes, origin, ts) VALUES (1, ?1, ?2, ?3, ?4)",
        )
        .unwrap();
    let mid = doc.len_chars() / 2;
    let pool: Vec<char> = "春风又绿江南岸明月何时照我还".chars().collect();
    let mut loro_ms = Vec::new();
    let mut sqlite_ms = Vec::new();
    let mut total_ms = Vec::new();
    let mut update_bytes = Vec::new();
    for i in 0..2000usize {
        let at = mid + i;
        let text = pool[i % pool.len()].to_string();
        let t0 = Instant::now();
        doc.replace(at..at, &text, ORIGIN_USER).unwrap();
        let t1 = Instant::now();
        let pending: Vec<Vec<u8>> = std::mem::take(&mut *updates.lock().unwrap());
        for bytes in &pending {
            update_bytes.push(bytes.len() as f64);
            insert
                .execute(rusqlite::params![i as i64, bytes, ORIGIN_USER, i as i64])
                .unwrap();
        }
        let t2 = Instant::now();
        loro_ms.push(ms(t1 - t0));
        sqlite_ms.push(ms(t2 - t1));
        total_ms.push(ms(t2 - t0));
    }
    drop(insert);
    drop(db);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", db_path.display()));
    }
    let write_median = percentile(&total_ms, 50.0);

    let report = J::obj(vec![
        ("schema", J::str("drifting.p0-b.headless/1")),
        ("generated_at", J::str(today())),
        ("source_fingerprint", J::str(report::source_fingerprint())),
        ("machine", machine_json()),
        ("build", build_json()),
        (
            "corpus",
            J::Obj(vec![
                {
                    let (k, v) = corpus_json("chapter", shell::CHAPTER_SEED, &chapter);
                    (k.to_owned(), v)
                },
                {
                    let (k, v) = corpus_json("book", shell::BOOK_SEED, &book);
                    (k.to_owned(), v)
                },
            ]),
        ),
        (
            "write_per_keystroke",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "2000 single-character inserts in the middle of the 20k-char chapter. loro = LoroText::insert + commit (the text event is folded into the paragraph mirror); sqlite = INSERT of the commit's encoded update (subscribe_local_update) into a WAL database with synchronous=NORMAL on the local SSD.",
                    ),
                ),
                ("loro", report::summary(&loro_ms)),
                ("sqlite", report::summary(&sqlite_ms)),
                ("total", report::summary(&total_ms)),
                ("update_bytes_p50", J::Num(percentile(&update_bytes, 50.0))),
                ("budget_median_ms", J::Num(2.0)),
                ("pass", verdict(write_median, 2.0)),
            ]),
        ),
        (
            "cold_open",
            J::obj(vec![
                (
                    "method",
                    J::str(
                        "No window. Import Loro snapshots and build the paragraph mirror (LoroDoc::from_snapshot + to_delta).",
                    ),
                ),
                ("book_chapters", J::Int(book.snapshots.len() as i64)),
                ("book_paragraphs", J::Int(paragraphs as i64)),
                ("book_list_items", J::Int(items as i64)),
                (
                    "book_snapshot_mb",
                    J::Num((snapshot_bytes as f64 / (1 << 20) as f64 * 100.0).round() / 100.0),
                ),
                ("book_import_ms", J::ms(import_ms)),
                (
                    "book_import_memory_mb",
                    J::Num(
                        ((memory1.saturating_sub(memory0)) as f64 / (1 << 20) as f64 * 10.0)
                            .round()
                            / 10.0,
                    ),
                ),
                ("chapter_import_ms", J::ms(chapter_import_ms)),
                ("book_height_estimate_ms", J::ms(estimate_ms)),
                (
                    "book_estimated_height_px",
                    J::Num(f64::from(estimate_sum).round()),
                ),
            ]),
        ),
    ]);
    let text = report.to_pretty();
    match out {
        Some(path) => std::fs::write(path, text).expect("write the evidence file"),
        None => print!("{text}"),
    }
}

// ----- check -----------------------------------------------------------------

/// Verifies that evidence files were produced by the current sources and
/// corpus. Exit code 1 on mismatch.
pub fn check(paths: &[String]) -> bool {
    let source = report::source_fingerprint();
    let chapter = synth::fingerprint(&[synth::chapter(
        shell::CHAPTER_SEED,
        0,
        shell::CHAPTER_CHARS,
        true,
    )]);
    let book = synth::fingerprint(&synth::book(
        shell::BOOK_SEED,
        shell::BOOK_CHAPTERS,
        shell::BOOK_CHARS,
    ));
    let mut ok = true;
    for path in paths {
        let Ok(text) = std::fs::read_to_string(path) else {
            eprintln!("{path}: cannot read");
            ok = false;
            continue;
        };
        for (what, value) in [
            ("source_fingerprint", &source),
            ("fingerprint", &chapter),
            ("fingerprint", &book),
        ] {
            let needle = format!("\"{what}\": \"{value}\"");
            if !text.contains(&needle) {
                eprintln!("{path}: {what} {value} not found (stale evidence: rerun the bench)");
                ok = false;
            }
        }
    }
    ok
}
