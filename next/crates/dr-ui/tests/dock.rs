//! The tab dock under GPUI's test platform: marks at rest, pills under the
//! hand, folding back only after its wait, staying open while one of its
//! pills is in the hand, and a pill dropped along the row taking its place.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::{Duration, Instant},
};

use dr_ui::{
    anim,
    components::{DockTab, Pill, TabDock},
    sand,
    tokens::{glass::PILL_HEIGHT, motion::dwell::DOCK_COLLAPSE},
};
use gpui::{
    Context, IntoElement, Modifiers, MouseButton, ParentElement as _, Render, Styled as _,
    TestAppContext, VisualTestContext, Window, div, point, px,
};

fn frame(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

struct Host {
    order: Vec<&'static str>,
    locked: bool,
    /// Whether the dock built its lock this frame (it does only when open).
    open: Rc<Cell<bool>>,
    drops: Rc<RefCell<Vec<String>>>,
}

struct Carried(usize);

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.open.set(false);
        let open = self.open.clone();
        let me = cx.entity();
        let drops = self.drops.clone();
        // Pills of fixed width (60px inside, 10px either side): pill i spans
        // 84 i .. 84 i + 80 once the dock is open.
        let tabs = self
            .order
            .iter()
            .map(|name| {
                DockTab::new(
                    Pill::new(*name)
                        .mark(sand::Kind::Element, None)
                        .content(|_, _| div().w(px(60.0)).h(px(20.0)).into_any_element()),
                )
            })
            .collect();
        // Shrink-wrapped, `ORIGIN` from the window's top left corner (the
        // test window reads its pointer back as the corner now and then).
        div()
            .size_full()
            .flex()
            .flex_row()
            .items_start()
            .pl(px(ORIGIN))
            .pt(px(ORIGIN))
            .child(
                TabDock::new("dock", tabs, Some(0))
                    .locked(self.locked)
                    .leading(move |_, _| {
                        open.set(true);
                        div().into_any_element()
                    })
                    .draggable(Carried, move |c: &Carried, to, _, cx| {
                        drops.borrow_mut().push(format!("{} -> {to}", c.0));
                        me.update(cx, |h, cx| {
                            let name = h.order.remove(c.0);
                            h.order.insert(to, name);
                            cx.notify();
                        });
                    }),
            )
    }
}

fn host(cx: &mut TestAppContext) -> (gpui::Entity<Host>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(|_, _| Host {
        order: vec!["一", "二", "三"],
        locked: false,
        open: Rc::default(),
        drops: Rc::default(),
    });
    cx.update(|window, _| window.activate_window());
    // The dock's motion reads its own clock; the test moves it by hand.
    anim::freeze(Some(Instant::now()));
    // The window's first frame finds the pointer in its corner, on the dock.
    cx.simulate_mouse_move(point(px(AWAY.0), px(AWAY.1)), None, Modifiers::default());
    frame(cx);
    pass(cx, DOCK_COLLAPSE + Duration::from_millis(60));
    (view, cx)
}

/// `d` passes: the dock's wait (the executor's clock) and its motion.
fn pass(cx: &mut VisualTestContext, d: Duration) {
    anim::freeze(Some(anim::now() + d));
    cx.executor().advance_clock(d);
    frame(cx);
}

/// Under the hand, and grown into pills.
fn open_it(cx: &mut VisualTestContext) {
    cx.simulate_mouse_move(at(MARKS), None, Modifiers::default());
    frame(cx);
    pass(cx, Duration::from_millis(400));
}

fn is_open(view: &gpui::Entity<Host>, cx: &mut VisualTestContext) -> bool {
    view.read_with(cx, |h, _| h.open.get())
}

/// Where the dock starts.
const ORIGIN: f32 = 40.0;
/// Over the resting marks (three marks of 20 in a 22px row).
const MARKS: (f32, f32) = (10.0, 11.0);
const AWAY: (f32, f32) = (600.0, 400.0);

/// A point relative to the dock.
fn at((x, y): (f32, f32)) -> gpui::Point<gpui::Pixels> {
    point(px(ORIGIN + x), px(ORIGIN + y))
}

/// The middle of open pill `i` (the empty lock and a gap of 4 before them).
fn pill(i: usize) -> gpui::Point<gpui::Pixels> {
    at((4.0 + 84.0 * i as f32 + 40.0, PILL_HEIGHT / 2.0))
}

#[gpui::test]
fn the_dock_opens_under_the_hand_and_folds_after_its_wait(cx: &mut TestAppContext) {
    let (view, cx) = host(cx);
    assert!(!is_open(&view, cx), "marks at rest");
    open_it(cx);
    assert!(is_open(&view, cx), "pills under the hand");
    cx.simulate_mouse_move(point(px(AWAY.0), px(AWAY.1)), None, Modifiers::default());
    frame(cx);
    pass(cx, DOCK_COLLAPSE - Duration::from_millis(60));
    assert!(is_open(&view, cx), "still waiting");
    pass(cx, Duration::from_millis(120));
    assert!(!is_open(&view, cx), "folded back");
    // Locked, it stays open with no one there.
    view.update(cx, |h, cx| {
        h.locked = true;
        cx.notify();
    });
    frame(cx);
    assert!(is_open(&view, cx));
}

#[gpui::test]
fn a_pill_in_the_hand_keeps_the_dock_open_and_lands_where_it_is_dropped(cx: &mut TestAppContext) {
    let (view, cx) = host(cx);
    open_it(cx);
    // Carried far below the row: the dock waits out its delay and stays.
    cx.simulate_mouse_down(pill(0), MouseButton::Left, Modifiers::default());
    for y in [20.0, 80.0, 200.0] {
        cx.simulate_mouse_move(at((44.0, y)), MouseButton::Left, Modifiers::default());
        frame(cx);
    }
    pass(cx, DOCK_COLLAPSE + Duration::from_millis(60));
    assert!(is_open(&view, cx), "open while its pill is in the hand");
    // Back along the row and let go over the third pill.
    for x in [60.0, 140.0, 212.0] {
        cx.simulate_mouse_move(
            at((x, PILL_HEIGHT / 2.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        frame(cx);
    }
    cx.simulate_mouse_up(pill(2), MouseButton::Left, Modifiers::default());
    frame(cx);
    // Let go over the row: it stays open past its wait.
    pass(cx, DOCK_COLLAPSE + Duration::from_millis(60));
    assert!(is_open(&view, cx), "still under the hand");
    let (drops, order) = view.read_with(cx, |h, _| (h.drops.borrow().clone(), h.order.clone()));
    assert_eq!(drops, vec!["0 -> 2".to_string()]);
    assert_eq!(order, vec!["二", "三", "一"]);
}

#[gpui::test]
fn let_go_off_the_row_nothing_moves_and_the_dock_folds(cx: &mut TestAppContext) {
    let (view, cx) = host(cx);
    open_it(cx);
    cx.simulate_mouse_down(pill(1), MouseButton::Left, Modifiers::default());
    for y in [20.0, 80.0, 200.0] {
        cx.simulate_mouse_move(at((128.0, y)), MouseButton::Left, Modifiers::default());
        frame(cx);
    }
    pass(cx, DOCK_COLLAPSE + Duration::from_millis(60));
    cx.simulate_mouse_up(at((128.0, 200.0)), MouseButton::Left, Modifiers::default());
    frame(cx);
    // Let go away from it, it waits as if just left.
    assert!(is_open(&view, cx), "waits once let go");
    pass(cx, DOCK_COLLAPSE + Duration::from_millis(60));
    let (drops, order) = view.read_with(cx, |h, _| (h.drops.borrow().clone(), h.order.clone()));
    assert!(drops.is_empty(), "{drops:?}");
    assert_eq!(order, vec!["一", "二", "三"]);
    assert!(!is_open(&view, cx), "folded once the pill was let go");
}
