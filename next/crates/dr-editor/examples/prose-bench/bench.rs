//! Probe-tier measurements (docs/rust-rewrite/benchmarks.md).
//!
//! `window` runs every frame-level scenario in one real window; `idle`
//! measures idle CPU with the chapter open; `headless` measures opening the
//! book and the write path without a window.
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
    task::{Poll, Waker},
    time::{Duration, Instant},
};

use gpui::{App, AsyncApp, Context, EntityInputHandler, Window, WindowHandle};
use gpui_prose::{
    BlockKind, Book, ProseDoc, ProseEditor, ProseStyle, layout::estimate_height, text::ORIGIN_USER,
};
use serde_json::{Value, json};

use crate::{
    corpus::{self, Corpus},
    platform,
    report::{self, ms, round3, samples, summary},
    shell::{self, Root},
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

fn set_present_now(window: &WindowHandle<Root>, on: bool, cx: &mut AsyncApp) {
    let _ = editor_do(window, cx, |editor, _, _| {
        editor.options_mut().present_now = on
    });
}

async fn sleep(cx: &AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
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

/// What storage holds of the first chapter in the editor (see
/// [`corpus::stored_len`]).
fn stored_len(window: &WindowHandle<Root>, cx: &mut AsyncApp) -> Option<usize> {
    editor_do(window, cx, |editor, _, _| {
        corpus::stored_len(&editor.book().chapters[0].doc)
    })
    .flatten()
}

fn display_json(display: Option<(gpui::DisplayId, bool, f64)>) -> Value {
    let (builtin, refresh_hz) = display.map_or((false, 0.0), |d| (d.1, d.2));
    json!({ "builtin": builtin, "refresh_hz": refresh_hz })
}

fn mb(bytes: u64) -> f64 {
    (bytes as f64 / (1 << 20) as f64 * 10.0).round() / 10.0
}

fn percent(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// The offset in the middle of a body paragraph of 60–400 characters in the
/// second half of the first chapter (where typing starts).
pub fn typing_offset(doc: &ProseDoc) -> usize {
    let lines = doc.visible_lines();
    (lines / 2..lines)
        .find_map(|ix| {
            let line = doc.line(ix);
            (line.kind == BlockKind::Body && (60..400).contains(&line.chars))
                .then(|| doc.line_start(ix) + line.chars / 2)
        })
        .unwrap_or(0)
}

// ----- window scenarios -------------------------------------------------------

pub fn run_window(write: bool, quick: bool) {
    let corpus = Rc::new(Corpus::heavy());
    gpui_platform::application().run(move |cx: &mut App| {
        let (window, display) = shell::open_window(cx, corpus.titles(), true, true, true);
        let corpus = corpus.clone();
        cx.spawn(async move |cx| {
            let load_start = report::load();
            let (results, held) = window_scenarios(window, &corpus, display, quick, cx).await;
            let load_end = report::load();
            let _ = window.update(cx, |_, window, _| window.remove_window());
            report::finish(
                "window",
                write,
                &corpus.shape,
                results,
                (load_start, load_end),
                &held,
            );
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}

/// Closes what is open, then opens `open()`'s book and waits for its first
/// frame: (sessions and documents ms, first paint ms, presented ms).
async fn open_and_probe(
    window: &WindowHandle<Root>,
    open: impl FnOnce() -> Book,
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
            let book = open();
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
    reached_end: bool,
}

/// A scroll that has not reached the end after this many ticks is stuck.
const MAX_SCROLL_TICKS: usize = 40_000;

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
    if at_end {
        run.borrow_mut().reached_end = true;
    }
    if at_end || run.borrow().ticks.len() > MAX_SCROLL_TICKS {
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
    corpus: &Corpus,
    display: Option<(gpui::DisplayId, bool, f64)>,
    quick: bool,
    cx: &mut AsyncApp,
) -> (Value, Vec<(&'static str, bool)>) {
    let idle_seconds = if quick { 5 } else { 30 };
    let typing_keys = if quick { 40 } else { 480 };
    sleep(cx, Duration::from_millis(800)).await;
    let memory_start = platform::phys_footprint();

    // Open the whole book (every chapter's session and document → first
    // screen), three times: the first loads the holders from SQLite (cold),
    // then the workspace is warm.
    let mut book_opens = Vec::new();
    for _ in 0..3 {
        book_opens.push(open_and_probe(&window, || corpus.book(), cx).await);
    }
    let book_present: Vec<f64> = book_opens.iter().filter_map(|o| o.2).collect();
    let book_built: Vec<f64> = book_opens.iter().map(|o| o.0).collect();
    let memory_book_open = platform::phys_footprint();
    sleep(cx, Duration::from_millis(600)).await;

    let idle_book = idle_cpu(&window, idle_seconds, true, cx).await;
    let idle_book_unfocused = idle_cpu(&window, idle_seconds, false, cx).await;

    // Jumps from the table of contents, ending on the last chapter.
    let last = corpus.chapters.len() - 1;
    let targets = [
        last,
        0,
        last / 2,
        last,
        10.min(last),
        last * 9 / 10,
        last,
        last / 4,
        last * 3 / 4,
        last,
    ];
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
    let (work, interval, reached_end) = {
        let run = run.borrow();
        let interval: Vec<f64> = run.ticks.windows(2).map(|w| ms(w[1] - w[0])).collect();
        (run.work.clone(), interval, run.reached_end)
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

    // The longest chapter alone: five opens (its holder is warm by now).
    let mut chapter_opens = Vec::new();
    for _ in 0..5 {
        chapter_opens.push(open_and_probe(&window, || corpus.chapter(), cx).await);
    }
    let chapter_present: Vec<f64> = chapter_opens.iter().filter_map(|o| o.2).collect();
    sleep(cx, Duration::from_millis(600)).await;

    // Typing at 8 characters per second in the middle of a body paragraph.
    let start_offset = editor_do(&window, cx, |editor, window, cx| {
        let offset = typing_offset(&editor.book().chapters[0].doc);
        editor.select(0, offset..offset, window, cx);
        offset
    });
    sleep(cx, Duration::from_millis(500)).await;
    // Comparison: the same typing with the present-now hook on.
    set_present_now(&window, true, cx);
    let present_now = type_keys(&window, typing_keys / 3, cx).await;
    set_present_now(&window, false, cx);
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
        let stored_before = stored_len(&window, cx);
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
        let stored_during = stored_len(&window, cx);
        let _ = editor_do(&window, cx, |editor, window, cx| {
            editor.replace_text_in_range(
                None,
                if w % 2 == 0 { "你好" } else { "世界" },
                window,
                cx,
            );
        });
        let stored_after = stored_len(&window, cx);
        if stored_before.is_none()
            || stored_before != stored_during
            || stored_after.zip(stored_before).map(|(a, b)| a - b) != Some(2)
        {
            commits_written_once = false;
        }
        sleep(cx, Duration::from_millis(120)).await;
    }

    let idle_chapter = idle_cpu(&window, idle_seconds, true, cx).await;
    let memory_end = platform::phys_footprint();

    let held = vec![
        ("the scroll reached the end of the book", reached_end),
        (
            "marked text never reached storage and each commit wrote its word once",
            commits_written_once,
        ),
    ];
    let results = json!({
        "quick": quick,
        "window_px": [1180, 820],
        "display": display_json(display),
        "gpui_build": report::gpui_build(),
        "chapters": corpus.chapters.len(),
        "book_chars": corpus.book_chars(),
        "chapter_chars": corpus.chapter_chars(),
        "open_chapter": {
            "method": "Click-equivalent on the longest chapter of the heavy seed: open its workspace session and document (dr_editor::SessionSource, warm holder), build the editor, until the frame with the first screen of text is presented. Five opens.",
            "sessions_and_documents_ms": samples(&chapter_opens.iter().map(|o| o.0).collect::<Vec<_>>()),
            "first_paint_ms": samples(&chapter_opens.iter().map(|o| o.1).collect::<Vec<_>>()),
            "presented_ms": samples(&chapter_present),
            "presented": summary(&chapter_present),
            "budget_median_ms": 80.0,
        },
        "open_book": {
            "method": "Open every chapter's session and document on all cores (as BookEditor does), build the book view, until the first screen is presented. Three opens: the first loads the holders from SQLite (cold), the others find them open. Heights of off-screen paragraphs are estimated afterwards on a background thread.",
            "sessions_and_documents_ms": samples(&book_built),
            "presented_ms": samples(&book_present),
            "presented": summary(&book_present),
            "budget_median_ms": 200.0,
        },
        "keystroke_to_present": {
            "method": "In-process: the same EntityInputHandler::replace_text_in_range call macOS insertText makes, at 8 chars/s with the key times spread evenly over a 120 Hz frame, in the middle of a paragraph of the longest chapter (every 90th key is Enter); each key is a dr-doc transaction through the workspace session, persisted before the call returns. Stock GPUI timing: the edit marks the window dirty and GPUI draws on the next display-link tick. Measured to the display-link tick after the frame that painted the change. Excludes AppKit event dispatch before insertText.",
            "handler": summary(&key_call),
            "painted": summary(&key_paint),
            "presented": summary(&key_present),
            "presented_samples_ms": samples(&key_present),
            "present_now_comparison": {
                "method": "Same typing with the present-now hook on: each edit sends setNeedsDisplay to GPUI's view, so Core Animation calls displayLayer and GPUI draws before the next display-link tick. GPUI stops and restarts the display link around that draw, so 'presented' (the next tick) is only an upper bound on this path.",
                "painted": summary(&present_now.paint),
                "presented": summary(&present_now.present),
                "presented_samples_ms": samples(&present_now.present),
            },
            "budget_p95_ms": 16.0,
        },
        "typing_cpu": {
            "method": "Whole-process CPU time (getrusage user+sys) over the typing run, as percent of one core (the workspace's holder and index threads included).",
            "seconds": (typing_seconds * 10.0).round() / 10.0,
            "keys": typing_keys,
            "percent": percent(typing_cpu),
            "budget_percent": 15.0,
        },
        "idle_cpu": {
            "method": "Editor focused, cursor blinking (530 ms), nothing else happening; whole-process CPU time over the window, as percent of one core.",
            "seconds": idle_seconds,
            "book_percent": percent(idle_book),
            "book_unfocused_no_blink_percent": percent(idle_book_unfocused),
            "chapter_percent": percent(idle_chapter),
            "budget_percent": 1.0,
        },
        "scroll_full_book": {
            "method": "From the top of the first chapter to the end of the last, one step of half a viewport per frame, each step issued as soon as the previous frame was presented. work = render start to end of the editor's paint; interval = between consecutive presented ticks.",
            "frames": work.len(),
            "reached_end": reached_end,
            "px_per_frame": step,
            "seconds": (scroll_seconds * 10.0).round() / 10.0,
            "work": summary(&work),
            "interval": summary(&interval),
            "frames_over_1_5_periods": dropped,
            "cpu_percent": (scroll_cpu * 10.0).round() / 10.0,
            "work_samples_ms": samples(&work),
            "budget_p95_ms": 16.7,
        },
        "jump": {
            "method": "Table-of-contents click equivalent (scroll to the chapter's first item, cursor to its start) until presented; ten jumps, four of them to the last chapter.",
            "targets": targets,
            "all_ms": samples(&jumps),
            "to_last_ms": samples(&jumps_to_last),
            "to_last_max_ms": round3(jumps_to_last.iter().copied().fold(0.0, f64::max)),
            "budget_ms": 150.0,
        },
        "memory_mb": {
            "method": "phys_footprint of the whole process (proc_pid_rusage), MB.",
            "window_open": mb(memory_start),
            "book_open": mb(memory_book_open),
            "before_scroll": mb(memory_before_scroll),
            "after_scroll": mb(memory_after_scroll),
            "end": mb(memory_end),
            "budget_after_scroll": 800.0,
        },
        "heights": {
            "items": total_items,
            "measured_after_scroll": measured_items,
            "total_px": total_height.round(),
            "estimate_mean_abs_error": if estimate_error.is_finite() { Some(round3(estimate_error)) } else { None },
        },
        "composition": {
            "method": "In-process pinyin: five setMarkedText-equivalent updates per word, then insertText. Measures each update to presented, the bounds_for_range (candidate window) query, and that the stored body (read on the document holder's thread) is unchanged while marked and grows by exactly the word on commit.",
            "words": words,
            "update_to_presented": summary(&marked_present),
            "bounds_query": summary(&marked_bounds),
            "marked_text_never_in_storage": commits_written_once,
            "budget_p95_ms": 16.0,
        },
        "typing_start_offset": start_offset.unwrap_or(0),
    });
    (results, held)
}

// ----- idle CPU only ----------------------------------------------------------

/// Idle CPU with the longest chapter open: focused with the caret blinking,
/// focused with a solid caret, and unfocused. For comparing GPUI builds (the
/// idle display-link patch); `PROSE_BENCH_GPUI` labels the build in the
/// evidence.
pub fn run_idle(write: bool, seconds: u64) {
    let corpus = Rc::new(Corpus::heavy());
    gpui_platform::application().run(move |cx: &mut App| {
        let (window, display) =
            shell::open_window(cx, vec![corpus.chapter_title()], false, true, true);
        let corpus = corpus.clone();
        cx.spawn(async move |cx| {
            let _ = window.update(cx, |root, window, cx| {
                let editor = root.open(corpus.chapter(), window, cx);
                let focus = gpui::Focusable::focus_handle(editor.read(cx), cx);
                window.focus(&focus, cx);
            });
            sleep(cx, Duration::from_secs(2)).await;
            let load_start = report::load();
            let blinking = idle_cpu(&window, seconds, true, cx).await;
            let _ = editor_do(&window, cx, |editor, _, cx| {
                editor.cursor_layer().update(cx, |layer, cx| layer.set_blink(None, cx));
            });
            let solid = idle_cpu(&window, seconds, true, cx).await;
            let unfocused = idle_cpu(&window, seconds, false, cx).await;
            let load_end = report::load();
            let all = [blinking, solid, unfocused];
            let results = json!({
                "method": "The longest chapter of the heavy seed open in a visible window (dr_editor::SessionSource); whole-process CPU time (getrusage) over each window, as percent of one core.",
                "display": display_json(display),
                "gpui_build": report::gpui_build(),
                "chapter_chars": corpus.chapter_chars(),
                "seconds": seconds,
                "focused_blinking_percent": percent(blinking),
                "focused_solid_caret_percent": percent(solid),
                "unfocused_percent": percent(unfocused),
                "budget_percent": 1.0,
            });
            let _ = window.update(cx, |_, window, _| window.remove_window());
            report::finish(
                "idle",
                write,
                &corpus.shape,
                results,
                (load_start, load_end),
                &[("every reading is a number", all.iter().all(|v| v.is_finite()))],
            );
            cx.update(|cx| cx.quit());
        })
        .detach();
    });
}

// ----- headless --------------------------------------------------------------

/// Characters typed for the write path, and inside an entity link.
const WRITE_KEYS: usize = 2000;
const LINK_KEYS: usize = 1000;

/// Types `keys` characters one at a time at `at`, `at + 1`, …; each
/// insert's time in ms.
fn type_into(doc: &mut ProseDoc, at: usize, keys: usize, text: &[char]) -> Vec<f64> {
    (0..keys)
        .map(|i| {
            let t = Instant::now();
            doc.replace(
                at + i..at + i,
                &text[i % text.len()].to_string(),
                ORIGIN_USER,
            );
            ms(t.elapsed())
        })
        .collect()
}

pub fn run_headless(write: bool) {
    let corpus = Corpus::heavy();
    let load_start = report::load();
    let longest = &corpus.chapters[corpus.longest].doc;
    let memory0 = platform::phys_footprint();

    // The longest chapter first, so its holder loads from SQLite (cold),
    // then five more opens with the holder open (warm).
    let t = Instant::now();
    drop(corpus.open(longest));
    let chapter_cold = ms(t.elapsed());
    let chapter_warm: Vec<f64> = (0..5)
        .map(|_| {
            let t = Instant::now();
            drop(corpus.open(longest));
            ms(t.elapsed())
        })
        .collect();

    // The whole book, every chapter's session and document on all cores:
    // the first time the other holders load from SQLite, then warm.
    let mut book_parallel = Vec::new();
    let mut memory_book = 0;
    for round in 0..4 {
        let t = Instant::now();
        let docs = corpus.open_all();
        book_parallel.push(ms(t.elapsed()));
        if round == 0 {
            memory_book = platform::phys_footprint();
        }
        drop(docs);
    }
    // On one thread, warm (P0-B measured one thread).
    let t = Instant::now();
    let docs: Vec<ProseDoc> = corpus
        .chapters
        .iter()
        .map(|c| corpus.open(&c.doc))
        .collect();
    let book_sequential = ms(t.elapsed());
    let paragraphs: usize = docs.iter().map(ProseDoc::visible_lines).sum();
    let book_chars: usize = docs.iter().map(ProseDoc::len_chars).sum();

    // Background height estimate for the whole book at the default column.
    let style = ProseStyle::default();
    let t = Instant::now();
    let mut estimate_sum = 0.0f32;
    for doc in &docs {
        for line in &doc.lines()[..doc.visible_lines()] {
            estimate_sum += estimate_height(&line.text, &style.metrics(line.kind), 680.0);
        }
    }
    let estimate_ms = ms(t.elapsed());
    let book_view = Book::new(
        docs.into_iter()
            .zip(corpus.titles())
            .map(|(doc, title)| gpui_prose::Chapter { title, doc })
            .collect(),
    );
    let items = book_view.item_count();
    drop(book_view);

    // The longest chapter with the seed's entity links and styles: typing
    // inside a link (each typed character joins the link's span, written
    // through the session).
    let mut doc = corpus.open(longest);
    let chapter_chars = doc.len_chars();
    let spans: usize = doc.lines().iter().map(|l| l.spans.len()).sum();
    let entity_spans: usize = doc
        .lines()
        .iter()
        .map(|l| {
            l.spans
                .iter()
                .filter(|s| s.marks.entities().next().is_some())
                .count()
        })
        .sum();
    let inside_link = doc
        .lines()
        .iter()
        .enumerate()
        .find_map(|(ix, line)| {
            let span = line
                .spans
                .iter()
                .find(|s| s.marks.entities().next().is_some() && s.range.len() > 3)?;
            Some((ix, line.char_of_byte(span.range.start) + 1))
        })
        .map(|(ix, inner)| doc.line_start(ix) + inner);
    let link_keys = match inside_link {
        Some(at) => type_into(&mut doc, at, LINK_KEYS, &['链']),
        None => Vec::new(),
    };
    let stays_in_link =
        inside_link.is_some_and(|at| doc.marks_before(at + LINK_KEYS).entities().next().is_some());

    // The write path: one keystroke = a dr-doc transaction in the holder's
    // write job, appended to SQLite before it returns, its event folded into
    // the editor's mirror.
    let pool: Vec<char> = "春风又绿江南岸明月何时照我还".chars().collect();
    let mid = typing_offset(&doc);
    let session_keys = type_into(&mut doc, mid, WRITE_KEYS, &pool);
    let mirror_follows = doc.mirror_snapshot() == doc.reread();

    // The same keystrokes on the standalone LoroSource (gpui-prose's
    // in-memory source, the chapter's paragraphs without marks): what the
    // editor and Loro cost without the holder thread and storage. This one
    // needs LoroSource: it is the comparison.
    let mut memory_doc = ProseDoc::from_paragraphs(
        doc.lines()[..doc.visible_lines()]
            .iter()
            .map(|l| (l.kind, l.text.as_str())),
    );
    let memory_keys = type_into(&mut memory_doc, mid, WRITE_KEYS, &pool);
    drop(memory_doc);
    drop(doc);
    let load_end = report::load();

    let held = [
        ("the book has 100 chapters", corpus.chapters.len() == 100),
        (
            "the chapter has an entity link to type in",
            inside_link.is_some(),
        ),
        ("typed text stays in the entity link", stays_in_link),
        (
            "the editor's mirror matches storage after the write path",
            mirror_follows,
        ),
    ];
    let session = summary(&session_keys);
    let results = json!({
        "chapters": corpus.chapters.len(),
        "book_chars": book_chars,
        "chapter_chars": chapter_chars,
        "open_book": {
            "method": "No window. Every chapter's workspace session and editor document (dr_editor::SessionSource → gpui_prose::ProseDoc: read the body on the holder thread, build the paragraph mirror). parallel_ms: on all cores, as BookEditor opens a book; the first round loads the holders from SQLite (cold, but for the longest chapter's), the next three find them open (warm). sequential_warm_ms: one thread, warm.",
            "parallel_ms": samples(&book_parallel),
            "cold_ms": round3(book_parallel[0]),
            "sequential_warm_ms": round3(book_sequential),
            "memory_mb": mb(memory_book.saturating_sub(memory0)),
            "paragraphs": paragraphs,
            "list_items": items,
            "height_estimate_ms": round3(estimate_ms),
            "estimated_height_px": f64::from(estimate_sum).round(),
            "budget_ms": 200.0,
        },
        "open_chapter": {
            "method": "The longest chapter's session and document: once cold (its holder loads from SQLite), then five times warm.",
            "cold_ms": round3(chapter_cold),
            "warm_ms": samples(&chapter_warm),
            "spans": spans,
            "entity_link_spans": entity_spans,
        },
        "keystroke_in_entity_link": {
            "method": "1000 single-character inserts inside one of the seed's entity links in the longest chapter, through the session; each typed character joins the link (ExpandType None, inside the span).",
            "keystroke": summary(&link_keys),
            "typed_text_stays_in_the_link": stays_in_link,
        },
        "write_per_keystroke": {
            "method": "2000 single-character inserts in the middle of a body paragraph of the longest chapter. session = ProseDoc::replace on dr_editor::SessionSource: a dr-doc transaction in the document holder's write job, appended to SQLite before it returns, its event folded into the paragraph mirror (Drifting's path). in_memory_loro = the same inserts on gpui-prose's standalone LoroSource holding the chapter's paragraphs (no holder thread, no storage), for comparison.",
            "session": session,
            "in_memory_loro": summary(&memory_keys),
            "mirror_matches_storage": mirror_follows,
            "budget_median_ms": 2.0,
        },
    });
    report::finish(
        "headless",
        write,
        &corpus.shape,
        results,
        (load_start, load_end),
        &held,
    );
}
