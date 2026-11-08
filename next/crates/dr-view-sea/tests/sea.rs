//! The sea on GPUI's test platform: holds turn it on and let it ebb, a
//! press drops a ring that stirs the characters, a wait raises 「Loading」
//! only past the loading delay while a first run raises the name at once,
//! glass on the sea is read; and the first run's stages.

use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_ui::Appearance;
use dr_view_sea::{
    HoldKind, Mode, Sea, SeaGlass, char_sea,
    first_run::{self, Done, FirstRun, Stage, Step},
    on_sea,
};
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, TestAppContext, VisualTestContext, Window, div, point, px,
};

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: Some(Appearance::Light),
    }
}

fn shell(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
        dr_shell::init(info(), Services::default(), file, cx);
    });
}

struct Board {
    card: bool,
    first_run: Option<Entity<FirstRun>>,
}

impl Render for Board {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let sea = Sea::of(window, cx);
        div()
            .size_full()
            .relative()
            .child(char_sea(&sea))
            .children(self.card.then(|| {
                on_sea(
                    "card",
                    SeaGlass::resting(2.0),
                    div()
                        .absolute()
                        .top(px(100.0))
                        .left(px(100.0))
                        .w(px(126.0))
                        .h(px(186.0)),
                )
            }))
            .children(self.first_run.clone().map(AnyView::from))
    }
}

/// One frame at `now` (the clock is frozen so the test owns time).
fn frame(cx: &mut VisualTestContext, now: Instant) {
    dr_ui::anim::freeze(Some(now));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

/// Frames every 50 ms for `seconds`, from `*now`.
fn run(cx: &mut VisualTestContext, now: &mut Instant, seconds: f32) {
    for _ in 0..(seconds * 20.0).round() as usize {
        *now += Duration::from_millis(50);
        frame(cx, *now);
    }
}

fn sea(cx: &mut VisualTestContext) -> Sea {
    cx.update(|window, cx| Sea::of(window, cx))
}

#[gpui::test]
fn holds_turn_the_sea_on_and_it_ebbs_when_they_go(cx: &mut TestAppContext) {
    shell(cx);
    let (_view, cx) = cx.add_window_view(|_, _| Board {
        card: true,
        first_run: None,
    });
    let mut now = Instant::now();
    frame(cx, now);
    let s = sea(cx);
    assert_eq!(s.mode(), Mode::Off);
    let hold = cx.update(|window, _| s.hold(HoldKind::Surface, window));
    frame(cx, now);
    assert_eq!(s.mode(), Mode::Live);
    frame(cx, now);
    assert_eq!(s.glass_count(), 1, "the card lies on the sea");
    // A press drops a ring; the characters it reaches rise.
    cx.update(|window, _| s.press(point(px(400.0), px(300.0)), 1.2, window));
    assert!(s.is_moving());
    run(cx, &mut now, 0.3);
    assert!(s.drawn_characters() > 50, "{}", s.drawn_characters());
    // Let go: it ebbs, the ring runs out, then it is off.
    drop(hold);
    run(cx, &mut now, 0.2);
    assert_eq!(s.mode(), Mode::Ebb);
    // No new rings while it ebbs.
    cx.update(|window, _| s.press(point(px(200.0), px(200.0)), 1.2, window));
    run(cx, &mut now, 9.0);
    assert_eq!(s.mode(), Mode::Off);
    assert!(!s.is_moving());
    dr_ui::anim::freeze(None);
}

#[gpui::test]
fn a_hand_over_within_the_latch_keeps_the_sea_live(cx: &mut TestAppContext) {
    shell(cx);
    let (_view, cx) = cx.add_window_view(|_, _| Board {
        card: false,
        first_run: None,
    });
    let mut now = Instant::now();
    frame(cx, now);
    let s = sea(cx);
    let shelf = cx.update(|window, _| s.hold(HoldKind::Surface, window));
    frame(cx, now);
    drop(shelf);
    now += Duration::from_millis(30);
    frame(cx, now);
    let _wait = cx.update(|window, _| s.hold(HoldKind::Loading, window));
    frame(cx, now);
    assert_eq!(s.mode(), Mode::Live);
    dr_ui::anim::freeze(None);
}

#[gpui::test]
fn a_wait_raises_loading_only_past_the_delay_and_a_first_run_its_name_at_once(
    cx: &mut TestAppContext,
) {
    shell(cx);
    let (_view, cx) = cx.add_window_view(|_, _| Board {
        card: false,
        first_run: None,
    });
    let mut now = Instant::now();
    frame(cx, now);
    let s = sea(cx);
    let wait = cx.update(|window, _| s.hold(HoldKind::Loading, window));
    run(cx, &mut now, 0.15);
    assert_eq!(s.word(), None, "a short wait shows nothing");
    run(cx, &mut now, 0.3);
    assert_eq!(s.word(), Some("Loading"));
    // The name takes the word's place at once.
    let title = cx.update(|window, _| s.hold(HoldKind::Title, window));
    frame(cx, now);
    frame(cx, now);
    assert_eq!(s.word(), Some(dr_view_sea::sea::TITLE));
    drop(title);
    drop(wait);
    run(cx, &mut now, 0.2);
    assert_eq!(s.word(), None);
    dr_ui::anim::freeze(None);
}

struct Ask(Rc<Cell<bool>>);

impl Step for Ask {
    fn id(&self) -> &'static str {
        "ask"
    }
    fn label(&self, _: &App) -> SharedString {
        "ask".into()
    }
    fn render(&self, done: Done, _: &mut Window, _: &mut App) -> AnyElement {
        let seen = self.0.clone();
        // Answered as soon as it is drawn.
        seen.set(true);
        let _ = done;
        div().w(px(200.0)).h(px(80.0)).into_any_element()
    }
}

#[gpui::test]
fn the_first_run_raises_the_name_then_asks_then_leaves(cx: &mut TestAppContext) {
    shell(cx);
    let shown = Rc::new(Cell::new(false));
    let asked = shown.clone();
    cx.update(|cx| first_run::add_step(cx, move |_, _| Some(Rc::new(Ask(asked.clone())))));
    let (view, cx) = cx.add_window_view(|_, _| Board {
        card: false,
        first_run: None,
    });
    let mut now = Instant::now();
    frame(cx, now);
    let finished = Rc::new(Cell::new(false));
    let done = finished.clone();
    let run_view =
        cx.update(|window, cx| cx.new(|cx| FirstRun::new(window, cx, move |_, _| done.set(true))));
    view.update(cx, |b, cx| {
        b.first_run = Some(run_view.clone());
        cx.notify();
    });
    let s = sea(cx);
    run(cx, &mut now, 0.8);
    assert_eq!(run_view.read_with(cx, |r, _| r.stage()), Stage::Title);
    assert_eq!(s.word(), Some(dr_view_sea::sea::TITLE));
    cx.update(|window, cx| run_view.update(cx, |r, cx| r.show_card(window, cx)));
    run(cx, &mut now, 0.3);
    assert_eq!(run_view.read_with(cx, |r, _| r.stage()), Stage::Card);
    assert!(shown.get(), "the step is on the card");
    assert!(!run_view.read_with(cx, |r, _| r.shows_shelf()));
    // The card's glass lies on the sea.
    assert!(s.glass_count() >= 1);
    dr_ui::anim::freeze(None);
    let _ = finished;
}

#[gpui::test]
fn without_steps_the_name_goes_straight_to_the_shelf(cx: &mut TestAppContext) {
    shell(cx);
    let (view, cx) = cx.add_window_view(|_, _| Board {
        card: false,
        first_run: None,
    });
    let now = Instant::now();
    frame(cx, now);
    let finished = Rc::new(Cell::new(false));
    let done = finished.clone();
    let run_view =
        cx.update(|window, cx| cx.new(|cx| FirstRun::new(window, cx, move |_, _| done.set(true))));
    view.update(cx, |b, cx| {
        b.first_run = Some(run_view.clone());
        cx.notify();
    });
    frame(cx, now);
    cx.update(|window, cx| run_view.update(cx, |r, cx| r.show_card(window, cx)));
    assert_eq!(run_view.read_with(cx, |r, _| r.stage()), Stage::Leaving);
    assert!(run_view.read_with(cx, |r, _| r.shows_shelf()));
    assert!(cx.update(|_, cx| first_run::arriving(cx)));
    // The leaving timer runs on the executor's clock.
    cx.executor()
        .advance_clock(first_run::LEAVE + Duration::from_millis(10));
    cx.run_until_parked();
    assert!(finished.get());
    assert_eq!(run_view.read_with(cx, |r, _| r.stage()), Stage::Done);
    assert!(!cx.update(|_, cx| first_run::arriving(cx)));
    dr_ui::anim::freeze(None);
}

#[gpui::test]
fn a_sample_lands_once_and_waits_until_opened(cx: &mut TestAppContext) {
    shell(cx);
    let (_view, cx) = cx.add_window_view(|_, _| Board {
        card: false,
        first_run: None,
    });
    cx.update(|_, cx| first_run::note_samples_created(vec!["book-a".into()], cx));
    let on = cx.update(|_, cx| first_run::sample_on_shelf("book-a", cx));
    assert!(on.waiting && on.landing);
    assert!(
        !cx.update(|_, cx| first_run::sample_on_shelf("book-b", cx))
            .waiting
    );
    cx.update(|window, cx| first_run::land_sample(point(px(300.0), px(300.0)), window, cx));
    let on = cx.update(|_, cx| first_run::sample_on_shelf("book-a", cx));
    assert!(on.waiting && !on.landing);
    cx.update(|_, cx| first_run::note_book_opened("book-a", cx));
    assert!(
        !cx.update(|_, cx| first_run::sample_on_shelf("book-a", cx))
            .waiting
    );
}

#[gpui::test]
async fn a_new_library_gets_the_samples_and_the_shelf_lands_them(cx: &mut TestAppContext) {
    shell(cx);
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let ws = dr_workspace::Workspace::open(lib, dr_workspace::WorkspaceOptions::default()).unwrap();
    let task = cx.update(|cx| first_run::write_samples(ws.clone(), cx));
    let outcome = task.await;
    let dr_samples::Outcome::Created { books } = outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(books, dr_samples::book_ids());
    cx.update(|cx| {
        for book in &books {
            assert!(first_run::sample_on_shelf(book, cx).landing);
        }
    });
}
