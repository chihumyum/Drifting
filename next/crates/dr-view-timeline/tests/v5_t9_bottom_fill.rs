//! T9's bottom fill (`kernel-v5.md` §17 「底栏视图铺满」, `W9Bottom`) over
//! dr-testkit's tiny seed: the bar and the filled panel each keep their own
//! scale and lane-name column, and however far the scale is pinched in, a
//! drawn card still shows its title's first whole character.

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace, book::Book, pages::BottomHost,
    workspace::FillPlace,
};
use dr_view_timeline::v3::{Timeline, model};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    Context, Entity, Modifiers, PinchEvent, Render, TestAppContext, TouchPhase, VisualTestContext,
    Window, div, prelude::*, px,
};
use serde_json::{Value, json};
use std::rc::Rc;

fn seed() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, lib, id)
}

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

struct Host {
    timeline: Entity<Timeline>,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.timeline.clone())
    }
}

fn frame(cx: &mut VisualTestContext) {
    cx.update(|w, cx| w.draw(cx).clear(cx));
    cx.run_until_parked();
}

/// A window with the timeline over `id`, and the workspace it asks
/// whether the bottom panel fills.
fn visual<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    id: &str,
) -> (Entity<Host>, Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.to_owned()),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        )
    });
    let book = Rc::new(Book::load(lib, id).unwrap());
    let ws_slot = Rc::new(std::cell::RefCell::new(None));
    let slot = ws_slot.clone();
    let (host, cx) = cx.add_window_view(|w, cx| {
        let ws = cx.new(|cx| Workspace::new(w, cx));
        *slot.borrow_mut() = Some(ws.clone());
        let host = BottomHost {
            workspace: ws.downgrade(),
            library: Some(lib.clone()),
            book_id: id.to_owned(),
            book,
            target: None,
        };
        Host {
            timeline: cx.new(|_| Timeline::new(&host)),
        }
    });
    cx.simulate_resize(gpui::size(px(1280.0), px(420.0)));
    let ws = ws_slot.borrow().clone().unwrap();
    frame(cx);
    (host, ws, cx)
}

/// The timeline reads the book again (as the shell's refresh does).
fn reload(
    host: &Entity<Host>,
    ws: &Entity<Workspace>,
    lib: &Library,
    id: &str,
    cx: &mut VisualTestContext,
) {
    let book = Rc::new(Book::load(lib, id).unwrap());
    let bottom = BottomHost {
        workspace: ws.downgrade(),
        library: Some(lib.clone()),
        book_id: id.to_owned(),
        book,
        target: None,
    };
    host.update(cx, |h, cx| {
        h.timeline.update(cx, |t, cx| t.refresh(&bottom, cx));
    });
    frame(cx);
    frame(cx);
}

fn fill(ws: &Entity<Workspace>, on: bool, cx: &mut VisualTestContext) {
    ws.update(cx, |ws, cx| {
        if on {
            // Reduced motion: the panel is at its new size at once.
            assert!(ws.enter_fill_with_motion(FillPlace::Bottom, true, cx));
        } else {
            assert!(ws.exit_fill_with_motion(true, cx));
        }
    });
    frame(cx);
    frame(cx);
}

fn pinch(cx: &mut VisualTestContext, at: gpui::Point<gpui::Pixels>, delta: f32) {
    cx.simulate_event(PinchEvent {
        position: at,
        delta,
        modifiers: Modifiers::none(),
        phase: TouchPhase::Moved,
    });
    frame(cx);
}

/// A point on `track` inside the window (a lane is as wide as the whole
/// scale, its centre can be far off to the right).
fn on_track(cx: &mut VisualTestContext, track: &'static str) -> gpui::Point<gpui::Pixels> {
    let b = cx.debug_bounds(track).expect("the lane is drawn");
    gpui::point(b.left() + px(120.0), b.center().y)
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// `W9Bottom`: the bar spreads a unit over 24 px and a lane over 36, the
/// filled panel over 100 and 76; each is pinched on its own and keeps its
/// own. The lane-name column is 96 wide in the bar, 140 filled.
#[gpui::test]
fn the_bar_and_the_fill_each_keep_their_scale_and_name_column(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (host, ws, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    let lane = t.read_with(cx, |t, _| t.lanes()[0].id.clone());
    let track = leak(format!("v3-track-{lane}"));

    let drawn = |cx: &mut VisualTestContext| {
        let rail = cx.debug_bounds("v3-lane-rail").expect("the name column");
        let track = cx.debug_bounds(track).expect("the lane");
        (f32::from(rail.size.width), f32::from(track.size.height))
    };
    assert_eq!(t.read_with(cx, |t, _| t.scale()), model::BAR);
    assert_eq!(drawn(cx), (96.0, 36.0));

    // Pinched in the bar: only the bar's scale moves.
    let at = on_track(cx, track);
    pinch(cx, at, 0.25);
    assert_eq!(t.read_with(cx, |t, _| t.scale().step), 30.0);
    assert_eq!(t.read_with(cx, |t, _| t.zoom()), 1.25);

    fill(&ws, true, cx);
    assert_eq!(
        t.read_with(cx, |t, _| t.scale()),
        model::FILLED,
        "the fill starts from its own scale"
    );
    assert_eq!(drawn(cx), (140.0, 76.0));
    let at = on_track(cx, track);
    pinch(cx, at, -0.5);
    assert_eq!(t.read_with(cx, |t, _| t.scale().step), 50.0);
    // ⌥ pinches the lanes.
    cx.simulate_event(PinchEvent {
        position: at,
        delta: 0.5,
        modifiers: Modifiers::alt(),
        phase: TouchPhase::Moved,
    });
    frame(cx);
    assert_eq!(t.read_with(cx, |t, _| t.scale().band), 114.0);
    assert_eq!(drawn(cx), (140.0, 114.0));

    fill(&ws, false, cx);
    assert_eq!(
        t.read_with(cx, |t, _| t.scale()),
        model::Scale {
            step: 30.0,
            band: model::BAR.band
        },
        "the bar kept its own"
    );
    assert_eq!(drawn(cx), (96.0, 36.0));
    fill(&ws, true, cx);
    assert_eq!(
        t.read_with(cx, |t, _| t.scale()),
        model::Scale {
            step: 50.0,
            band: 114.0
        },
        "and so did the fill"
    );

    // Each stays within W9Bottom's range.
    for _ in 0..12 {
        pinch(cx, at, 1.0);
    }
    assert_eq!(t.read_with(cx, |t, _| t.scale().step), model::STEP_RANGE.1);
    for _ in 0..12 {
        pinch(cx, at, -0.6);
    }
    assert_eq!(t.read_with(cx, |t, _| t.scale().step), model::STEP_RANGE.0);
}

/// `kernel-v5.md` §17: the narrowest card shows the first one or two whole
/// characters of its title, never half a character, never nothing. A short
/// placement pinched to the densest scale is still drawn wide enough for
/// its first character, and that character is what its title shows.
#[gpui::test]
fn the_narrowest_drawn_card_still_shows_a_whole_first_character(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (host, ws, cx) = visual(cx, &lib, &id);
    let t = host.read_with(cx, |h, _| h.timeline.clone());
    let (view, lane, entry) = t.read_with(cx, |t, _| {
        let lane = t
            .lanes()
            .into_iter()
            .find(|l| !l.act_track && !l.clips.is_empty())
            .expect("a lane with a card");
        let clip = lane
            .clips
            .iter()
            .min_by(|a, b| a.at.total_cmp(&b.at))
            .unwrap()
            .clone();
        (t.view().unwrap().id.clone(), lane.id, clip)
    });
    // A quarter of a unit long, at the start of the scale.
    call(
        &lib,
        "timeline_view.place",
        json!({"book": id, "view": view, "entry": entry.entry, "at": entry.at, "span": 0.25}),
    );
    reload(&host, &ws, &lib, &id, cx);
    let title = Book::load(&lib, &id)
        .unwrap()
        .v3()
        .unwrap()
        .entry(&entry.entry)
        .unwrap()
        .title
        .clone();
    assert!(!title.is_empty());

    // Pinched in as far as it goes: the span itself is 3 px.
    let track = leak(format!("v3-track-{lane}"));
    let at = on_track(cx, track);
    for _ in 0..8 {
        pinch(cx, at, -0.6);
    }
    assert_eq!(t.read_with(cx, |t, _| t.scale().step), model::STEP_RANGE.0);

    let card = cx
        .debug_bounds(leak(format!("v3-clip-{lane}-{}", entry.entry)))
        .expect("the card is drawn");
    let shown = cx
        .debug_bounds(leak(format!("v3-clip-title-{lane}-{}", entry.entry)))
        .expect("its title is drawn");
    let (first_w, min_w, fits) = cx.update(|window, cx| {
        let theme = dr_ui::Theme::of(window, cx);
        let size = px((theme.scale.caption - 1.0).max(11.0));
        let font = dr_ui::fonts::Role::Ui.font(dr_ui::fonts::weight::REGULAR);
        let first: String = title.chars().take(1).collect();
        let run = gpui::TextRun {
            len: first.len(),
            font: font.clone(),
            color: gpui::Hsla::transparent_black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let first_w = f32::from(
            window
                .text_system()
                .layout_line(&first, size, &[run], None)
                .width,
        );
        let min_w = model::card_min_width(&title, 2.0, size, font.clone(), window);
        let fits =
            model::slice_whole_chars(&title, f32::from(shown.size.width), size, font, window);
        (first_w, min_w, fits)
    });
    assert!(first_w > 0.0);
    assert!(
        f32::from(card.size.width) >= min_w - 0.5,
        "the card is {card:?}, its least is {min_w}"
    );
    assert!(
        f32::from(card.size.width) > 0.25 * model::STEP_RANGE.0 + 8.0,
        "wider than its 3 px span and the old 8 px floor"
    );
    assert!(
        f32::from(shown.size.width) + 0.5 >= first_w,
        "the title has room for its first character: {shown:?} for {first_w}"
    );
    assert!(!fits.is_empty(), "a whole first character shows");
    assert!(title.starts_with(&fits));
    assert!(!fits.contains('…'));
}
