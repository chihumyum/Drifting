//! A covered window (another window over it, or a display gone to sleep)
//! draws no frames: GPUI stops its display link, so a motion that started
//! stays at the frame drawn last. The bridge draws such a window itself, so
//! a scenario drives it as on screen: input lands on what the window shows
//! now, and a pause ends with the window drawn as it is.
//!
//! Found 2026-11-17 with both displays asleep: the T9 scenario's wheel on
//! the Project Home went to a frame drawn as the Home was coming up, and the
//! PT3 scenario found the project row that drops in from the top still at
//! its first frame. Test windows draw only when something changes, so a
//! motion stops at its first frame here too (GPUI's `with_animation` asks
//! for the next frame, which nothing delivers): a page that slides in plays
//! the motion.
use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_debug_bridge::protocol::BridgeError;
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    pages::ModulePage,
};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace as Library;
use gpui::{
    Animation, AnimationExt as _, AppContext as _, Context, Entity, FocusHandle,
    InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, TestAppContext, VisualTestContext, Window,
    WindowVisibility, div, px, size,
};
use serde_json::{Value, json};

/// The sliding list, and its first row (which moves when the list scrolls).
const LIST: &str = "covered-sliding-list";
const ROW: &str = "covered-sliding-row";
/// Where the list starts its slide: far below the window.
const BELOW: f32 = 2000.0;
/// Short: the shell's own timers draw the window about 250 ms after a page
/// opens, and the pause has to end before that to show what it draws.
const SLIDE: Duration = Duration::from_millis(100);
const WINDOW_H: f32 = 520.0;

/// A page whose scrolling list slides up into place when it first shows.
struct Sliding {
    focus: FocusHandle,
}

impl Render for Sliding {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().relative().track_focus(&self.focus).child(
            div()
                .id("covered-sliding")
                .debug_selector(|| LIST.into())
                .absolute()
                .left_0()
                .right_0()
                .h(px(400.0))
                .overflow_y_scroll()
                .child(div().debug_selector(|| ROW.into()).h(px(50.0)))
                .children((0..40).map(|_| div().h(px(50.0))))
                .with_animation("covered-slide", Animation::new(SLIDE), |list, done| {
                    list.top(px(BELOW * (1.0 - done)))
                }),
        )
    }
}

fn setup(
    cx: &mut TestAppContext,
) -> (
    Entity<Workspace>,
    &mut VisualTestContext,
    Target,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "test").unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                book: Some(book.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        // Motions play (GPUI ends them at once when told to reduce motion).
        cx.set_reduce_motion(false);
        // A template's page is the sliding one.
        dr_shell::pages::add_page_view(cx, |target, _, _, cx| {
            let Target::Template(_) = target else {
                return None;
            };
            let view = cx.new(|cx| Sliding {
                focus: cx.focus_handle(),
            });
            let focus = view.read(cx).focus.clone();
            Some(ModulePage {
                view: view.into(),
                focus,
            })
        });
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    cx.simulate_resize(size(px(1000.0), px(WINDOW_H)));
    settle(cx, |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == book && ws.book.v3().is_some())
    });
    let target = ws.read_with(cx, |ws, _| {
        let id = ws.book.v3().unwrap().templates[0].id.clone();
        Target::Template(id.parse().expect("a template id"))
    });
    (ws, cx, target, dir)
}

/// Draws the window as the display would, until `done` holds.
fn settle(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx)
        });
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "the window did not settle");
        std::thread::sleep(Duration::from_millis(3));
    }
}

/// One bridge method, run to its answer; the test's clock keeps pace with
/// the wall clock the motions run on. Nothing here draws the window.
fn call(cx: &mut VisualTestContext, method: &'static str, params: Value) -> Value {
    let out: Rc<RefCell<Option<Result<Value, BridgeError>>>> = Rc::default();
    let put = out.clone();
    cx.update(|_, cx| {
        cx.spawn(async move |cx| {
            let answer = dr_debug_bridge::call(method, params, cx).await;
            *put.borrow_mut() = Some(answer);
        })
        .detach()
    });
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        if let Some(answer) = out.borrow_mut().take() {
            return answer.unwrap_or_else(|e| panic!("{method}: {e:?}"));
        }
        assert!(Instant::now() < until, "{method} did not answer");
        std::thread::sleep(Duration::from_millis(10));
        cx.executor().advance_clock(Duration::from_millis(10));
    }
}

fn top(cx: &mut VisualTestContext, selector: &'static str) -> f32 {
    f32::from(
        cx.debug_bounds(selector)
            .unwrap_or_else(|| panic!("{selector} drawn"))
            .origin
            .y,
    )
}

/// The window is covered and the sliding page comes up: the last frame is
/// the motion's first, the list below the window.
fn covered_page(ws: &Entity<Workspace>, cx: &mut VisualTestContext, target: &Target) {
    cx.simulate_visibility_change(WindowVisibility::Hidden);
    let target = target.clone();
    ws.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
    cx.run_until_parked();
    assert!(
        top(cx, LIST) > WINDOW_H,
        "the frame drawn last is the slide's first"
    );
}

/// The T9 scenario's step: the page came up while the window was covered,
/// time passed, and a wheel turns over where the list now is. It scrolls
/// the list, not what the frame drawn last had there.
#[gpui::test]
fn a_scroll_on_a_covered_window_lands_on_what_it_shows_now(cx: &mut TestAppContext) {
    let (ws, cx, target, _dir) = setup(cx);
    covered_page(&ws, cx, &target);
    std::thread::sleep(SLIDE + Duration::from_millis(150));
    let x = cx.update(|window, _| f32::from(window.viewport_size().width) / 2.0);
    call(
        cx,
        "input.scroll",
        json!({"x": x, "y": WINDOW_H / 2.0, "dy": 200}),
    );

    // Back on screen: the list is in place, scrolled by the wheel.
    cx.simulate_visibility_change(WindowVisibility::Visible);
    settle(cx, |cx| top(cx, LIST) < WINDOW_H / 2.0);
    let (list, row) = (top(cx, LIST), top(cx, ROW));
    assert!(
        row < list - 150.0,
        "the list scrolled: list {list}, row {row}"
    );
}

/// The PT3 scenario's step: a pause (`ui.wait` until a time; the settle
/// before a press or a screenshot is the same) on a covered window ends
/// with the window drawn as it is, the motion done, so the next step finds
/// the list where it stays.
#[gpui::test]
fn a_pause_on_a_covered_window_ends_with_it_drawn(cx: &mut TestAppContext) {
    let (ws, cx, target, _dir) = setup(cx);
    covered_page(&ws, cx, &target);
    let ms = (SLIDE + Duration::from_millis(60)).as_millis() as u64;
    let waited = call(cx, "ui.wait", json!({"until": "time", "ms": ms}));
    assert_eq!(waited["waitedMs"], ms);
    let list = top(cx, LIST);
    assert!(
        list < WINDOW_H / 2.0,
        "the frame drawn last has the list in place: {list}"
    );
}
