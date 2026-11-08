//! The workspace tour (M24) on GPUI's test platform, over a mock workspace
//! whose controls are anchors at fixed places: it comes up after its delay
//! with the ring on the first step's controls, Next and Back pass over a
//! step whose control is not drawn, a closed sidebar's toggle stands in for
//! its tabs until it opens, the ring follows a control that moves, a Super
//! View puts it away and it starts again from the top, and Done, Skip and
//! Esc end it and mark it seen so it does not start again.

use std::time::{Duration, Instant};

use dr_ui::anim;
use dr_view_sea::tour::{self, Shortcut, TourState, anchor, geometry, ids};
use gpui::{
    Bounds, Context, Entity, IntoElement, Modifiers, ParentElement as _, Pixels, Render, Size,
    Styled as _, TestAppContext, VisualTestContext, Window, div, point, px, size,
};

/// A workspace reduced to its marked controls.
struct Mock {
    left_open: bool,
    right_open: bool,
    super_entry: bool,
    anything: bool,
    /// Where the first left Panel Tab label starts.
    tabs_at: f32,
    covered: bool,
}

impl Default for Mock {
    fn default() -> Mock {
        Mock {
            left_open: true,
            right_open: true,
            super_entry: true,
            anything: true,
            tabs_at: 40.0,
            covered: false,
        }
    }
}

fn at(x: f32, y: f32, w: f32, h: f32) -> gpui::Div {
    div().absolute().left(px(x)).top(px(y)).w(px(w)).h(px(h))
}

impl Render for Mock {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut root = div().relative().size_full();
        if self.anything {
            if self.left_open {
                root = root
                    .child(anchor(
                        ids::LEFT_PANEL_TAB,
                        at(self.tabs_at, 10.0, 48.0, 20.0),
                    ))
                    .child(anchor(
                        ids::LEFT_PANEL_TAB,
                        at(self.tabs_at + 60.0, 10.0, 48.0, 20.0),
                    ))
                    .child(anchor(ids::PROJECT_HOME, at(12.0, 900.0, 28.0, 28.0)))
                    .child(anchor(ids::NOTIFICATIONS, at(44.0, 900.0, 28.0, 28.0)));
            } else {
                root = root.child(anchor(
                    ids::LEFT_SIDEBAR_CLOSED_TOGGLE,
                    at(80.0, 6.0, 28.0, 28.0),
                ));
            }
            if self.super_entry {
                root = root.child(anchor(ids::SUPER_VIEW_ENTRY, at(200.0, 44.0, 28.0, 28.0)));
            }
            if self.right_open {
                root = root.child(anchor(ids::AGENT_TAB, at(1800.0, 10.0, 40.0, 20.0)));
            } else {
                root = root.child(anchor(
                    ids::RIGHT_SIDEBAR_CLOSED_TOGGLE,
                    at(1880.0, 6.0, 28.0, 28.0),
                ));
            }
            root = root
                .child(anchor(ids::HOME_CREATE, at(600.0, 300.0, 400.0, 120.0)))
                .child(anchor(ids::TIMELINE_TOGGLE, at(1500.0, 1040.0, 28.0, 28.0)));
        }
        root.children(tour::layer(self.covered, window, cx))
    }
}

fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(x), px(y)), size(px(w), px(h)))
}

/// Delivers the frames the last one asked for and draws one, `n` times.
fn frames(cx: &mut VisualTestContext, n: usize) {
    for _ in 0..n {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }
    cx.run_until_parked();
}

fn open(cx: &mut TestAppContext, mock: Mock) -> (Entity<Mock>, &mut VisualTestContext) {
    cx.update(|cx| {
        dr_shell::Strings::install(dr_i18n::Locale::ZhCn, cx);
        tour::init(cx);
    });
    let (view, cx) = cx.add_window_view(|_, _| mock);
    frames(cx, 1);
    (view, cx)
}

fn current(cx: &mut VisualTestContext) -> Option<TourState> {
    cx.update(|window, cx| tour::current(window, cx))
}

fn running(cx: &mut VisualTestContext) -> bool {
    cx.update(|window, cx| tour::is_running(window, cx))
}

fn seen(cx: &mut VisualTestContext) -> bool {
    cx.update(|_, cx| tour::is_seen(cx))
}

/// Starts the tour and lets its delay run out.
fn start(cx: &mut VisualTestContext) -> TourState {
    assert!(cx.update(tour::maybe_start));
    frames(cx, 1);
    cx.executor().advance_clock(tour::START_DELAY);
    frames(cx, 3);
    current(cx).expect("the tour is up")
}

fn change(cx: &mut VisualTestContext, view: &Entity<Mock>, f: impl FnOnce(&mut Mock)) {
    cx.update(|_, cx| {
        view.update(cx, |m, cx| {
            f(m);
            cx.notify();
        })
    });
    frames(cx, 3);
}

#[gpui::test]
fn comes_up_after_its_delay_ringing_both_tab_rows(cx: &mut TestAppContext) {
    let (_, cx) = open(cx, Mock::default());
    assert!(cx.update(tour::maybe_start));
    frames(cx, 1);
    cx.executor()
        .advance_clock(tour::START_DELAY - Duration::from_millis(50));
    frames(cx, 2);
    assert!(running(cx));
    assert_eq!(current(cx), None, "up before its delay");
    cx.executor().advance_clock(Duration::from_millis(60));
    frames(cx, 3);
    let state = current(cx).expect("not up after its delay");
    assert_eq!((state.step, state.id, state.fallback), (0, "panels", false));
    // Both labels in one ring, 4px outside them.
    assert_eq!(state.target, rect(40.0, 10.0, 108.0, 20.0));
    assert_eq!(state.ring, rect(36.0, 6.0, 116.0, 28.0));
    // The card under the ring, left edges together.
    assert_eq!(state.card.origin, point(px(36.0), px(44.0)));
    assert_eq!(state.card.size.width, px(tour::CARD_WIDTH));
}

#[gpui::test]
fn next_and_back_pass_over_a_step_whose_control_is_not_drawn(cx: &mut TestAppContext) {
    let (_, cx) = open(
        cx,
        Mock {
            super_entry: false,
            ..Mock::default()
        },
    );
    assert_eq!(start(cx).id, "panels");
    // Return walks the tour: the Super View step has nothing to point at.
    cx.simulate_keystrokes("enter");
    frames(cx, 3);
    let state = current(cx).unwrap();
    assert_eq!((state.step, state.id), (2, "create"));
    assert_eq!(state.target, rect(600.0, 300.0, 400.0, 120.0));
    cx.dispatch_action(tour::Next);
    frames(cx, 3);
    let timeline = current(cx).unwrap();
    assert_eq!(timeline.id, "timeline");
    // Low in the window: the card goes above, right edges together.
    assert_eq!(timeline.card.right(), timeline.ring.right());
    assert!(timeline.card.bottom() <= timeline.ring.top());
    cx.dispatch_action(tour::Back);
    frames(cx, 3);
    assert_eq!(current(cx).unwrap().id, "create");
    cx.dispatch_action(tour::Back);
    frames(cx, 3);
    assert_eq!(current(cx).unwrap().id, "panels", "back past the gap");
}

#[gpui::test]
fn a_closed_sidebar_points_at_its_toggle_until_it_opens(cx: &mut TestAppContext) {
    let (view, cx) = open(
        cx,
        Mock {
            left_open: false,
            ..Mock::default()
        },
    );
    let state = start(cx);
    assert_eq!((state.id, state.fallback), ("panels", true));
    assert_eq!(state.target, rect(80.0, 6.0, 28.0, 28.0));
    // A round button keeps a round ring.
    assert_eq!(state.ring, rect(76.0, 2.0, 36.0, 36.0));
    change(cx, &view, |m| m.left_open = true);
    let state = current(cx).unwrap();
    assert_eq!((state.id, state.fallback), ("panels", false));
    assert_eq!(state.target, rect(40.0, 10.0, 108.0, 20.0));
}

#[gpui::test]
fn the_ring_follows_its_control(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, Mock::default());
    start(cx);
    change(cx, &view, |m| m.tabs_at = 240.0);
    let state = current(cx).unwrap();
    assert_eq!(state.target, rect(240.0, 10.0, 108.0, 20.0));
    assert_eq!(state.ring.origin, point(px(236.0), px(6.0)));
    assert_eq!(state.card.origin, point(px(236.0), px(44.0)));
}

#[gpui::test]
fn a_super_view_puts_it_away_and_it_starts_again_from_the_top(cx: &mut TestAppContext) {
    let (view, cx) = open(cx, Mock::default());
    start(cx);
    cx.dispatch_action(tour::Next);
    frames(cx, 3);
    assert_eq!(current(cx).unwrap().id, "super-views");
    change(cx, &view, |m| m.covered = true);
    assert_eq!(current(cx), None);
    assert!(running(cx));
    change(cx, &view, |m| m.covered = false);
    assert_eq!(current(cx).unwrap().id, "panels");
}

#[gpui::test]
fn done_ends_it_and_a_second_start_does_nothing(cx: &mut TestAppContext) {
    let (_, cx) = open(cx, Mock::default());
    start(cx);
    let ids: Vec<&str> = (0..6)
        .map(|k| {
            if k > 0 {
                cx.dispatch_action(tour::Next);
                frames(cx, 3);
            }
            current(cx).unwrap().id
        })
        .collect();
    assert_eq!(
        ids,
        [
            "panels",
            "super-views",
            "create",
            "timeline",
            "agent",
            "home"
        ]
    );
    // The torii and the bell in one ring.
    assert_eq!(current(cx).unwrap().target, rect(12.0, 900.0, 60.0, 28.0));
    assert!(!seen(cx));
    cx.dispatch_action(tour::Next);
    frames(cx, 2);
    assert!(!running(cx));
    assert_eq!(current(cx), None);
    assert!(seen(cx));
    assert!(!cx.update(tour::maybe_start));
    frames(cx, 1);
    cx.executor().advance_clock(tour::START_DELAY * 2);
    frames(cx, 2);
    assert_eq!(current(cx), None);
    // Settings' 「再次显示」.
    cx.update(|_, cx| tour::reset_seen(cx));
    assert!(!seen(cx));
    assert_eq!(start(cx).id, "panels");
}

#[gpui::test]
fn esc_skips_it_and_it_counts_as_seen(cx: &mut TestAppContext) {
    let (_, cx) = open(cx, Mock::default());
    start(cx);
    cx.simulate_keystrokes("escape");
    frames(cx, 2);
    assert!(!running(cx));
    assert!(seen(cx));
}

#[gpui::test]
fn the_cards_buttons_walk_and_skip(cx: &mut TestAppContext) {
    let (_, cx) = open(
        cx,
        Mock {
            right_open: false,
            ..Mock::default()
        },
    );
    // The card glides between steps: hold the clock, then let it land.
    let t0 = Instant::now();
    anim::freeze(Some(t0));
    let card = start(cx).card;
    // Next sits at the card's bottom right, Skip at its bottom left.
    let row = card.bottom() - px(23.0);
    cx.simulate_click(point(card.right() - px(22.0), row), Modifiers::default());
    frames(cx, 3);
    assert_eq!(current(cx).unwrap().id, "super-views");
    for _ in 0..3 {
        cx.dispatch_action(tour::Next);
        frames(cx, 3);
    }
    // The right sidebar is closed: its toggle, with the other sentence.
    let agent = current(cx).unwrap();
    assert_eq!((agent.id, agent.fallback), ("agent", true));
    assert_eq!(agent.target, rect(1880.0, 6.0, 28.0, 28.0));
    // Kept inside the window.
    assert!(agent.card.right() <= px(1920.0 - geometry::CARD_MARGIN));
    anim::freeze(Some(t0 + Duration::from_secs(1)));
    frames(cx, 2);
    let card = agent.card;
    cx.simulate_click(
        point(card.left() + px(22.0), card.bottom() - px(23.0)),
        Modifiers::default(),
    );
    frames(cx, 2);
    anim::freeze(None);
    assert!(!running(cx));
    assert!(seen(cx));
}

#[gpui::test]
fn with_nothing_to_point_at_it_ends_unseen(cx: &mut TestAppContext) {
    let (_, cx) = open(
        cx,
        Mock {
            anything: false,
            ..Mock::default()
        },
    );
    assert!(cx.update(tour::maybe_start));
    frames(cx, 1);
    cx.executor().advance_clock(tour::START_DELAY);
    frames(cx, 4);
    assert!(!running(cx));
    assert!(!seen(cx), "never shown, so not seen");
}

#[gpui::test]
fn shortcuts_read_as_the_registry_binds_them(cx: &mut TestAppContext) {
    cx.update(|cx| {
        let os = cx.platform_info().os;
        let new = tour::shortcut_text(Shortcut::Bound("newEntity"), cx);
        assert_eq!(
            new.as_deref(),
            Some(dr_shell::keymap::display("secondary-n", os).as_str())
        );
        let send = tour::shortcut_text(Shortcut::Keys("secondary-enter"), cx);
        if os == gpui::OperatingSystem::Mac {
            assert_eq!(new.as_deref(), Some("⌘N"));
            assert_eq!(send.as_deref(), Some("⌘↩"));
        } else {
            assert_eq!(send.as_deref(), Some("Ctrl+Enter"));
        }
        assert_eq!(
            tour::shortcut_text(Shortcut::Bound("noSuchShortcut"), cx),
            None
        );
        // Every step's shortcut exists in this build.
        for step in &tour::WORKSPACE_TOUR {
            for shortcut in step.shortcuts {
                assert!(tour::shortcut_text(*shortcut, cx).is_some(), "{}", step.id);
            }
        }
    });
}

// The 0.1 client's tour-geometry.test.ts, in a 1440 × 900 window.

const WINDOW: Size<Pixels> = Size {
    width: px(1440.0),
    height: px(900.0),
};

fn card() -> Size<Pixels> {
    size(px(268.0), px(150.0))
}

#[test]
fn a_split_sidebars_halves_are_ringed_together_and_unshown_ones_skipped() {
    assert_eq!(
        geometry::union([
            rect(94.0, 7.0, 150.0, 28.0),
            rect(300.0, 7.0, 160.0, 28.0),
            rect(0.0, 0.0, 0.0, 0.0),
        ]),
        Some(rect(94.0, 7.0, 366.0, 28.0))
    );
    assert_eq!(geometry::union([]), None);
    assert_eq!(geometry::union([rect(10.0, 10.0, 0.0, 20.0)]), None);
}

#[test]
fn a_round_button_keeps_a_round_ring_and_a_wide_row_soft_corners() {
    let round = geometry::ring(rect(100.0, 100.0, 28.0, 28.0), WINDOW);
    assert_eq!(
        round.bounds.size.width,
        px(28.0 + 2.0 * geometry::RING_OUTSET)
    );
    assert_eq!(round.radius, f32::from(round.bounds.size.height) / 2.0);
    assert_eq!(
        geometry::ring(rect(10.0, 10.0, 400.0, 80.0), WINDOW).radius,
        12.0
    );
    // Never past the window's edge.
    let top = geometry::ring(rect(0.0, 0.0, 120.0, 30.0), WINDOW);
    assert_eq!(top.bounds.origin, point(px(1.0), px(1.0)));
}

#[test]
fn the_card_sits_under_the_ring_left_edges_together() {
    let ring = rect(90.0, 3.0, 160.0, 36.0);
    assert_eq!(
        geometry::card_origin(ring, card(), WINDOW),
        point(px(90.0), px(3.0 + 36.0 + geometry::CARD_GAP))
    );
}

#[test]
fn at_the_bottom_it_goes_above_right_edges_together() {
    let ring = rect(1380.0, 852.0, 36.0, 36.0);
    assert_eq!(
        geometry::card_origin(ring, card(), WINDOW),
        point(
            px(1380.0 + 36.0 - 268.0),
            px(852.0 - geometry::CARD_GAP - 150.0)
        )
    );
}

#[test]
fn it_never_runs_off_the_window() {
    let ring = rect(1400.0, 3.0, 36.0, 36.0);
    assert_eq!(
        geometry::card_origin(ring, card(), WINDOW).x,
        px(1440.0 - geometry::CARD_MARGIN - 268.0)
    );
    let tall = geometry::card_origin(rect(0.0, 0.0, 300.0, 880.0), card(), WINDOW);
    assert_eq!(
        tall,
        point(px(300.0 + geometry::CARD_GAP), px(geometry::CARD_MARGIN))
    );
}
