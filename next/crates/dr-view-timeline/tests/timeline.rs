//! The bottom timeline on GPUI's test platform over dr-testkit's 《慢钟》
//! (through F3): one lane per storyline with each chapter on its main
//! storyline's lane; 未归属 on request; the narrative axis and 未放置; a
//! chapter dragged with the mouse onto another lane changes its main
//! storyline and its place; dropped on 未归属 it leaves every storyline; a
//! double click on an empty spot makes a chapter there; time pins are made,
//! renamed, moved, bound to an idea and deleted; act boundaries are dragged
//! between their neighbours, acts made by place, renamed and deleted; the
//! hover cards' own rows take a chapter off its storylines or the narrative
//! axis and add one to a storyline.

use std::time::{Duration, Instant};

use dr_shell::nav::Target;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_timeline::BottomTimeline;
use dr_view_timeline::model::{Axis, LaneId, RAIL_WIDTH, STRIP_HEIGHT};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{ListIn, chapter::ChapterList},
    dto::ChapterInfo,
};
use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, MouseButton, ParentElement as _,
    Render, Styled as _, TestAppContext, VisualTestContext, Window, div, point, px, size,
};

const VERSION: &str = "0.2.0-dev";

fn library() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
    lib.close().unwrap();
    let id = book.book.book_id().to_string();
    (dir, Library::open_dir(&root, VERSION).unwrap(), id)
}

/// A window with the workspace (not drawn) and the timeline along its foot.
struct Host {
    ws: Entity<Workspace>,
    timeline: Entity<BottomTimeline>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(div().flex_1())
            .child(div().h(px(240.0)).child(self.timeline.clone()))
    }
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Host>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let (host, cx) = cx.add_window_view(|window, cx| {
        let ws = cx.new(|cx| Workspace::new(window, cx));
        let timeline = dr_view_timeline::make(ws.downgrade(), cx);
        Host { ws, timeline }
    });
    cx.simulate_resize(size(px(1200.0), px(600.0)));
    cx.update(|window, _| window.activate_window());
    wait_for(cx, |cx| {
        let t = timeline(&host, cx);
        t.read_with(cx, |t, _| t.layout().placed > 0)
    });
    (host, cx)
}

fn timeline(host: &Entity<Host>, cx: &mut VisualTestContext) -> Entity<BottomTimeline> {
    host.read_with(cx, |h, _| h.timeline.clone())
}

fn frame(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn chapters(lib: &Library, book: &str) -> Vec<ChapterInfo> {
    lib.run::<ChapterList>(
        &Actor::User,
        ListIn {
            book: book.to_owned(),
            trashed: false,
        },
    )
    .unwrap()
    .output
}

fn chapter(lib: &Library, book: &str, id: &str) -> ChapterInfo {
    chapters(lib, book)
        .into_iter()
        .find(|c| c.id == id)
        .unwrap()
}

#[gpui::test]
fn each_chapter_sits_on_its_main_storyline(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let layout = t.read_with(cx, |t, _| t.layout());
    let all = chapters(&lib, &book);
    let ws = host.read_with(cx, |h, _| h.ws.clone());
    let storylines = ws.read_with(cx, |w, _| w.book.storylines.clone());
    assert!(!storylines.is_empty());
    // One lane per storyline, in the book's order; 未归属 is hidden.
    assert_eq!(
        layout
            .lanes
            .iter()
            .map(|l| l.id.clone())
            .collect::<Vec<_>>(),
        storylines
            .iter()
            .map(|s| LaneId::Storyline(s.id.clone()))
            .collect::<Vec<_>>()
    );
    // Every placed chapter once, on its primary storyline's lane, in order.
    let drawn: usize = layout.lanes.iter().map(|l| l.clips.len()).sum();
    assert_eq!(drawn + layout.unaffiliated, all.len());
    for lane in &layout.lanes {
        let LaneId::Storyline(id) = &lane.id else {
            unreachable!()
        };
        for c in &lane.clips {
            let main = c.primary_storyline.as_ref().or(c.storylines.first());
            assert_eq!(main, Some(id), "{}", c.title);
        }
        let orders: Vec<f64> = lane.clips.iter().map(|c| c.book_order.unwrap()).collect();
        assert!(orders.windows(2).all(|w| w[0] <= w[1]));
        // The count is every chapter on the storyline, main or not.
        assert_eq!(
            lane.members,
            all.iter().filter(|c| c.storylines.contains(id)).count()
        );
    }
    // 未归属 shows on request.
    t.update(cx, |t, cx| t.toggle_unaffiliated(cx));
    let layout = t.read_with(cx, |t, _| t.layout());
    assert_eq!(layout.lanes.last().unwrap().id, LaneId::Unaffiliated);
    // Narrative order: a chapter without a narrative place waits in 未放置.
    t.update(cx, |t, cx| t.set_axis(Axis::Narrative, cx));
    let layout = t.read_with(cx, |t, _| t.layout());
    assert_eq!(
        layout.unplaced.len(),
        all.iter().filter(|c| c.narrative_order.is_none()).count()
    );
    assert!(layout.acts.is_empty());
    frame(cx);
}

/// The window point at `order` on lane `row`, `dx` into the clip.
fn at(
    t: &Entity<BottomTimeline>,
    row: usize,
    order: f64,
    dx: f32,
    cx: &mut VisualTestContext,
) -> gpui::Point<gpui::Pixels> {
    t.read_with(cx, |t, _| {
        let layout = t.layout();
        let body = t.body_bounds().unwrap();
        let height = f32::from(body.size.height) - STRIP_HEIGHT;
        let row_h = height / layout.lanes.len() as f32;
        let x = f32::from(body.origin.x) + RAIL_WIDTH - t.scroll_x() + layout.scale.x(order) + dx;
        let y = f32::from(body.origin.y) + STRIP_HEIGHT + row_h * (row as f32 + 0.5);
        point(px(x), px(y))
    })
}

#[gpui::test]
fn dragging_a_chapter_onto_another_lane_moves_it_there(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let layout = t.read_with(cx, |t, _| t.layout());
    // The first chapter of the first lane goes to the second lane, 12 order
    // units further on.
    let c = layout.lanes[0].clips[0].clone();
    let LaneId::Storyline(to) = layout.lanes[1].id.clone() else {
        unreachable!()
    };
    let from = c.book_order.unwrap();
    let target = from + 12.0;
    // Taken 10px in, the drag starts 6px on: the clip is held 16px in from
    // its left edge, and lands where its slab is seen.
    let start = at(&t, 0, from, 10.0, cx);
    // Past the middle of the second lane: the weighted slab goes over.
    let end = at(&t, 1, target, 16.0, cx);
    let end = point(end.x, end.y + px(2.0));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(
        point(start.x + px(6.0), start.y),
        MouseButton::Left,
        Modifiers::none(),
    );
    frame(cx);
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::none());
    frame(cx);
    let over = t.read_with(cx, |t, _| t.drop_target()).unwrap();
    assert_eq!(over.lane, LaneId::Storyline(to.clone()));
    assert!((over.order - target).abs() < 0.05, "{over:?}");
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    frame(cx);
    // Drawn there at once …
    let layout = t.read_with(cx, |t, _| t.layout());
    assert_eq!(layout.lane_of(&c.id), Some(1));
    // … and written: the new main storyline, the old main one gone, the
    // place in reading order where it was let go.
    let id = c.id.clone();
    wait_for(cx, |_| {
        chapter(&lib, &book, &id).primary_storyline.as_deref() == Some(to.as_str())
    });
    wait_for(cx, |_| {
        (chapter(&lib, &book, &id).book_order.unwrap() - target).abs() < 0.05
    });
    let now = chapter(&lib, &book, &id);
    assert!(now.storylines.contains(&to));
    if let Some(old) = &c.primary_storyline
        && old != &to
    {
        assert!(!now.storylines.contains(old));
    }
    // The snapshot caught up: still on the second lane.
    wait_for(cx, |cx| {
        t.read_with(cx, |t, _| t.layout().lane_of(&id) == Some(1))
    });
    // One drop is one step (F3's chapter.place): one undo puts back both
    // the storylines and the place.
    lib.undo(&Actor::User).unwrap();
    let back = chapter(&lib, &book, &id);
    assert_eq!(back.primary_storyline, c.primary_storyline);
    assert!((back.book_order.unwrap() - from).abs() < 1e-9);
}

#[gpui::test]
fn dropped_on_unaffiliated_a_chapter_leaves_every_storyline(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let c = t.read_with(cx, |t, _| t.layout().lanes[0].clips[0].clone());
    let order = c.book_order.unwrap();
    t.update(cx, |t, cx| {
        t.move_chapter(
            &c.id,
            dr_view_timeline::DropAt {
                lane: LaneId::Unaffiliated,
                order,
            },
            cx,
        )
    });
    let id = c.id.clone();
    wait_for(cx, |_| chapter(&lib, &book, &id).storylines.is_empty());
    assert!(chapter(&lib, &book, &id).primary_storyline.is_none());
    // It counts in 未归属, and shows there once the lane is shown.
    wait_for(cx, |cx| t.read_with(cx, |t, _| t.layout().unaffiliated > 0));
    t.update(cx, |t, cx| t.toggle_unaffiliated(cx));
    let layout = t.read_with(cx, |t, _| t.layout());
    assert_eq!(layout.lane_of(&id), Some(layout.lanes.len() - 1));
}

#[gpui::test]
fn the_narrative_axis_places_a_chapter_from_unplaced(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    t.update(cx, |t, cx| t.set_axis(Axis::Narrative, cx));
    let layout = t.read_with(cx, |t, _| t.layout());
    // Every chapter of 《慢钟》 has a narrative place: take one off.
    assert!(layout.unplaced.is_empty());
    let off = layout.lanes[1].clips[0].clone();
    lib.run::<dr_workspace::commands::chapter::ChapterUpdate>(
        &Actor::User,
        dr_workspace::commands::chapter::ChapterUpdateIn {
            book: book.clone(),
            id: off.id.clone(),
            narrative_order: Some(None),
            ..Default::default()
        },
    )
    .unwrap();
    wait_for(cx, |cx| {
        t.read_with(cx, |t, _| t.layout().unplaced.len() == 1)
    });
    let layout = t.read_with(cx, |t, _| t.layout());
    assert!(layout.lane_of(&off.id).is_none());
    let waiting = layout.unplaced[0].clone();
    assert_eq!(waiting.id, off.id);
    // 未放置's list opens from the header.
    t.update(cx, |t, cx| t.toggle_unplaced(cx));
    frame(cx);
    assert!(t.read_with(cx, |t, _| t.unplaced_open()));
    let LaneId::Storyline(to) = layout.lanes[0].id.clone() else {
        unreachable!()
    };
    t.update(cx, |t, cx| {
        t.move_chapter(
            &waiting.id,
            dr_view_timeline::DropAt {
                lane: LaneId::Storyline(to.clone()),
                order: 33.0,
            },
            cx,
        )
    });
    let id = waiting.id.clone();
    wait_for(cx, |_| {
        chapter(&lib, &book, &id).narrative_order == Some(33.0)
    });
    let now = chapter(&lib, &book, &id);
    assert_eq!(now.primary_storyline.as_deref(), Some(to.as_str()));
    // Its reading order did not move.
    assert_eq!(now.book_order, waiting.book_order);
}

#[gpui::test]
fn a_double_click_on_an_empty_spot_makes_a_chapter_there(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let before = chapters(&lib, &book).len();
    let layout = t.read_with(cx, |t, _| t.layout());
    let LaneId::Storyline(on) = layout.lanes[1].id.clone() else {
        unreachable!()
    };
    // The first empty stretch of the lane that is on screen.
    let clips: Vec<f64> = layout.lanes[1]
        .clips
        .iter()
        .filter_map(|c| c.book_order)
        .collect();
    let order = (0..200)
        .map(|i| layout.scale.min_order + 1.0 + i as f64)
        .find(|o| clips.iter().all(|c| *o < c - 0.5 || *o > c + 4.5))
        .unwrap();
    let spot = at(&t, 1, order, 0.0, cx);
    let visible = t.read_with(cx, |t, _| f32::from(t.body_bounds().unwrap().size.width));
    assert!(f32::from(spot.x) < visible, "{spot:?}");
    cx.simulate_click(spot, Modifiers::none());
    cx.simulate_event(gpui::MouseDownEvent {
        position: spot,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 2,
        first_mouse: false,
    });
    cx.simulate_event(gpui::MouseUpEvent {
        position: spot,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 2,
    });
    wait_for(cx, |_| chapters(&lib, &book).len() == before + 1);
    let made = chapters(&lib, &book)
        .into_iter()
        .max_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)))
        .unwrap();
    assert_eq!(made.primary_storyline.as_deref(), Some(on.as_str()));
    assert!((made.book_order.unwrap() - order).abs() < 0.05);
    // It opens.
    let ws = host.read_with(cx, |h, _| h.ws.clone());
    let target = Target::Chapter(made.id.parse().unwrap());
    wait_for(cx, |cx| {
        ws.read_with(cx, |w, _| w.nav.current() == Some(&target))
    });
}

#[gpui::test]
fn a_narrative_double_click_creates_and_undoes_the_whole_chapter_in_one_step(
    cx: &mut TestAppContext,
) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    t.update(cx, |t, cx| t.set_axis(Axis::Narrative, cx));
    frame(cx);
    let before = chapters(&lib, &book);
    let ids: Vec<_> = before.iter().map(|c| c.id.clone()).collect();
    let last = before
        .iter()
        .filter_map(|c| c.book_order)
        .fold(0.0, f64::max);
    let layout = t.read_with(cx, |t, _| t.layout());
    let LaneId::Storyline(on) = layout.lanes[1].id.clone() else {
        unreachable!()
    };
    let clips: Vec<_> = layout.lanes[1]
        .clips
        .iter()
        .filter_map(|c| c.narrative_order)
        .collect();
    let order = (0..200)
        .map(|i| layout.scale.min_order + 1.0 + i as f64)
        .find(|o| clips.iter().all(|c| *o < c - 0.5 || *o > c + 4.5))
        .unwrap();
    let spot = at(&t, 1, order, 0.0, cx);
    cx.simulate_click(spot, Modifiers::none());
    cx.simulate_event(gpui::MouseDownEvent {
        position: spot,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 2,
        first_mouse: false,
    });
    cx.simulate_event(gpui::MouseUpEvent {
        position: spot,
        button: MouseButton::Left,
        modifiers: Modifiers::none(),
        click_count: 2,
    });
    wait_for(cx, |_| chapters(&lib, &book).len() == before.len() + 1);
    let made = chapters(&lib, &book)
        .into_iter()
        .find(|c| !ids.contains(&c.id))
        .unwrap();
    assert_eq!(made.book_order, Some(last + 5.0));
    assert!((made.narrative_order.unwrap() - order).abs() < 0.05);
    assert_eq!(made.primary_storyline.as_deref(), Some(on.as_str()));
    assert_eq!(made.storylines, vec![on.clone()]);
    let ws = host.read_with(cx, |h, _| h.ws.clone());
    let target = Target::Chapter(made.id.parse().unwrap());
    wait_for(cx, |cx| {
        ws.read_with(cx, |w, _| w.nav.current() == Some(&target))
    });

    // The first undo must remove the chapter, rather than only removing
    // its narrative coordinate and leaving it in 未放置.
    lib.undo(&Actor::User).unwrap().unwrap();
    assert_eq!(
        chapters(&lib, &book)
            .into_iter()
            .map(|c| c.id)
            .collect::<Vec<_>>(),
        ids
    );
    lib.redo(&Actor::User).unwrap().unwrap();
    let restored = chapter(&lib, &book, &made.id);
    assert_eq!(restored.book_order, made.book_order);
    assert_eq!(restored.narrative_order, made.narrative_order);
    assert_eq!(restored.primary_storyline, made.primary_storyline);
    assert_eq!(restored.storylines, made.storylines);
}

#[gpui::test]
fn creating_a_chapter_does_not_open_it_in_another_book(cx: &mut TestAppContext) {
    use dr_workspace::commands::book::{BookCreate, BookCreateIn};
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let ws = host.read_with(cx, |h, _| h.ws.clone());
    let other = lib
        .run::<BookCreate>(
            &Actor::User,
            BookCreateIn {
                name: dr_testkit::samples::a_q().unwrap().book.view().meta().name,
                summary: String::new(),
            },
        )
        .unwrap()
        .output
        .id;
    let before = chapters(&lib, &book).len();
    // Both changes happen before the background create callback can run.
    cx.update(|window, cx| {
        t.update(cx, |t, cx| t.create_at(&LaneId::Book, 33.0, cx));
        ws.update(cx, |ws, cx| ws.open_book(&other, window, cx));
    });
    wait_for(cx, |cx| {
        chapters(&lib, &book).len() == before + 1 && ws.read_with(cx, |ws, _| ws.book.id == other)
    });
    assert!(ws.read_with(cx, |ws, _| ws.nav.current().is_none()));
    assert!(chapters(&lib, &other).is_empty());
}

/// What the timeline shows (书序 / 叙事时, 未归属, the zoom) is kept for the
/// book in the shell's per-book memory, and a timeline made for the book
/// again (the next run, another window) starts from it.
#[gpui::test]
fn what_the_timeline_shows_is_kept_for_the_book(cx: &mut TestAppContext) {
    let (_dir, library, _book) = library();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    t.update(cx, |t, cx| {
        t.set_axis(Axis::Narrative, cx);
        t.toggle_unaffiliated(cx);
        t.set_zoom(2.0, cx);
    });
    let ws = host.read_with(cx, |h, _| h.ws.clone());
    let kept = ws.read_with(cx, |ws, _| {
        ws.book_memory(dr_view_timeline::kept::KEY).cloned()
    });
    let kept = dr_view_timeline::kept::Kept::read(kept.as_ref());
    assert_eq!(
        (kept.axis, kept.unaffiliated, kept.zoom),
        (Axis::Narrative, true, 2.0)
    );
    let again = cx.update(|_, cx| dr_view_timeline::make(ws.downgrade(), cx));
    cx.run_until_parked();
    let shown = again.read_with(cx, |t, _| (t.axis(), t.unaffiliated_shown(), t.zoom()));
    assert_eq!(shown, (Axis::Narrative, true, 2.0));
}

fn pins(lib: &Library, book: &str) -> Vec<dr_workspace::commands::time_pin::TimePinInfo> {
    lib.run::<dr_workspace::commands::time_pin::TimePinList>(
        &Actor::User,
        dr_workspace::commands::BookIn {
            book: book.to_owned(),
        },
    )
    .unwrap()
    .output
}

fn acts(lib: &Library, book: &str) -> Vec<dr_workspace::dto::ActInfo> {
    lib.run::<dr_workspace::commands::chapter::ActList>(
        &Actor::User,
        dr_workspace::commands::BookIn {
            book: book.to_owned(),
        },
    )
    .unwrap()
    .output
}

fn double_click(cx: &mut VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    for click_count in [1, 2] {
        cx.simulate_event(gpui::MouseDownEvent {
            position: at,
            modifiers: Modifiers::none(),
            button: MouseButton::Left,
            click_count,
            first_mouse: false,
        });
        cx.simulate_event(gpui::MouseUpEvent {
            position: at,
            modifiers: Modifiers::none(),
            button: MouseButton::Left,
            click_count,
        });
    }
}

#[gpui::test]
fn time_pins_are_made_renamed_moved_bound_and_deleted(cx: &mut TestAppContext) {
    use dr_view_timeline::Mark;

    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    t.update(cx, |t, cx| t.set_axis(Axis::Narrative, cx));
    // 《慢钟》's five pins.
    wait_for(cx, |cx| t.read_with(cx, |t, _| t.pins().len() == 5));
    // A double click on the bare axis, far right of what shows: a pin there,
    // its name ready to type.
    let body = t.read_with(cx, |t, _| t.body_bounds().unwrap());
    let axis = cx.debug_bounds("timeline-time-axis").unwrap();
    let at = point(
        body.origin.x + body.size.width - px(30.0),
        axis.origin.y + px(STRIP_HEIGHT / 2.0),
    );
    let seeded: Vec<String> = pins(&lib, &book).into_iter().map(|p| p.id).collect();
    double_click(cx, at);
    wait_for(cx, |_| pins(&lib, &book).len() == 6);
    let made = pins(&lib, &book)
        .into_iter()
        .find(|p| !seeded.contains(&p.id))
        .expect("a new pin");
    assert!(!made.label.is_empty(), "the default label");
    wait_for(cx, |cx| {
        t.read_with(cx, |t, _| t.editing()) == Some(Mark::Pin(made.id.clone()))
    });
    cx.simulate_input("钟停");
    cx.simulate_keystrokes("enter");
    let id = made.id.clone();
    wait_for(cx, |_| {
        pins(&lib, &book)
            .iter()
            .any(|p| p.id == id && p.label.ends_with("钟停"))
    });
    // Moved along the axis.
    t.update(cx, |t, cx| t.move_mark(Mark::Pin(id.clone()), 3.5, cx));
    wait_for(cx, |_| {
        pins(&lib, &book)
            .iter()
            .any(|p| p.id == id && (p.narrative_order - 3.5).abs() < 1e-9)
    });
    // Bound to an idea no pin or act holds, then unbound: the label stays.
    let idea = host.read_with(cx, |h, cx| h.ws.read(cx).book.ideas[0].id.clone());
    t.update(cx, |t, cx| {
        t.bind(&Mark::Pin(id.clone()), Some(idea.clone()), cx)
    });
    wait_for(cx, |_| {
        pins(&lib, &book)
            .iter()
            .any(|p| p.id == id && p.idea.as_deref() == Some(idea.as_str()))
    });
    t.update(cx, |t, cx| t.bind(&Mark::Pin(id.clone()), None, cx));
    wait_for(cx, |_| {
        pins(&lib, &book)
            .iter()
            .any(|p| p.id == id && p.idea.is_none() && p.label.ends_with("钟停"))
    });
    // Deleted.
    t.update(cx, |t, cx| t.delete_pin(&id, cx));
    wait_for(cx, |_| pins(&lib, &book).len() == 5);
    wait_for(cx, |cx| t.read_with(cx, |t, _| t.pins().len() == 5));
}

#[gpui::test]
fn an_act_boundary_drags_between_its_neighbours_and_acts_are_made_by_place(
    cx: &mut TestAppContext,
) {
    use dr_view_timeline::Mark;

    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let before = acts(&lib, &book);
    assert_eq!(before.len(), 3);
    let second = before[1].clone();
    // Zoomed out so the second boundary shows.
    t.update(cx, |t, cx| t.set_zoom(0.5, cx));
    frame(cx);
    let from = second.start_order.unwrap();
    // The second act's boundary, dragged two units on with the mouse.
    let edge = cx
        .debug_bounds(Box::leak(
            format!("timeline-act-edge-{}", second.id).into_boxed_str(),
        ))
        .expect("the boundary's handle");
    let unit = t.read_with(cx, |t, _| t.layout().scale.unit());
    let start = edge.center();
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(
        point(start.x + px(6.0), start.y),
        MouseButton::Left,
        Modifiers::none(),
    );
    frame(cx);
    let end = point(start.x + px(6.0 + 2.0 * unit), start.y);
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::none());
    frame(cx);
    let held = t
        .read_with(cx, |t, _| t.mark_in_hand())
        .expect("the boundary is in the hand");
    assert_eq!(held.mark, Mark::Act(second.id.clone()));
    assert!((held.order - (from + 2.0)).abs() < 0.05, "{}", held.order);
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    let id = second.id.clone();
    wait_for(cx, |_| {
        acts(&lib, &book)
            .iter()
            .any(|a| a.id == id && (a.start_order.unwrap() - (from + 2.0)).abs() < 0.05)
    });
    // Never past a neighbour: dragged far on, it stops just before the
    // third act; far back past the head act, at the axis's start.
    let third = before[2].start_order.unwrap();
    t.update(cx, |t, cx| {
        t.move_mark(Mark::Act(id.clone()), third + 50.0, cx)
    });
    wait_for(cx, |_| {
        acts(&lib, &book).iter().any(|a| {
            a.id == id && {
                let s = a.start_order.unwrap();
                s < third && third - s < 0.05
            }
        })
    });
    assert!(before[0].start_order.is_none(), "卷一 is the head act");
    let axis_start = t.read_with(cx, |t, _| t.layout().scale.min_order);
    t.update(cx, |t, cx| {
        t.move_mark(Mark::Act(id.clone()), axis_start - 50.0, cx)
    });
    wait_for(cx, |_| {
        acts(&lib, &book)
            .iter()
            .any(|a| a.id == id && (a.start_order.unwrap() - axis_start).abs() < 1e-6)
    });
    // A double click on the bare rail: an act there, named by its place.
    let body = t.read_with(cx, |t, _| t.body_bounds().unwrap());
    let rail = cx.debug_bounds("timeline-act-rail").unwrap();
    let at = point(
        body.origin.x + body.size.width - px(30.0),
        rail.origin.y + px(STRIP_HEIGHT / 2.0),
    );
    double_click(cx, at);
    wait_for(cx, |_| acts(&lib, &book).len() == 4);
    let now = acts(&lib, &book);
    let place = now
        .iter()
        .position(|a| before.iter().all(|b| b.id != a.id))
        .expect("a new act");
    let made = now[place].clone();
    assert_eq!(made.name, dr_view_timeline::default_act_name(place + 1));
    // Renamed, then deleted.
    host.read_with(cx, |_, _| ());
    wait_for(cx, |cx| {
        host.read_with(cx, |h, cx| h.ws.read(cx).book.acts.len() == 4)
    });
    let mark = Mark::Act(made.id.clone());
    cx.update(|window, cx| t.update(cx, |t, cx| t.start_rename(mark, window, cx)));
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("尾声");
    cx.simulate_keystrokes("enter");
    let made_id = made.id.clone();
    wait_for(cx, |_| {
        acts(&lib, &book)
            .iter()
            .any(|a| a.id == made_id && a.name == "尾声")
    });
    t.update(cx, |t, cx| t.delete_act(&made_id, cx));
    wait_for(cx, |_| acts(&lib, &book).len() == 3);
}

#[gpui::test]
fn the_card_rows_move_a_chapter_off_its_storylines_or_the_axis(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let layout = t.read_with(cx, |t, _| t.layout());
    let c = layout.lanes[0].clips[0].clone();
    // 转移至未归属.
    t.update(cx, |t, cx| t.move_to_unaffiliated(&c.id, cx));
    let id = c.id.clone();
    wait_for(cx, |_| chapter(&lib, &book, &id).storylines.is_empty());
    // 回到未放置.
    t.update(cx, |t, cx| t.set_axis(Axis::Narrative, cx));
    let other = layout.lanes[1].clips[0].clone();
    assert!(other.narrative_order.is_some());
    t.update(cx, |t, cx| t.detach_from_narrative(&other.id, cx));
    let other_id = other.id.clone();
    wait_for(cx, |_| {
        chapter(&lib, &book, &other_id).narrative_order.is_none()
    });
    // 在此故事线中新建章节: on that storyline, past the last on the axis.
    let LaneId::Storyline(line) = layout.lanes[1].id.clone() else {
        unreachable!()
    };
    let count = chapters(&lib, &book).len();
    let last = chapters(&lib, &book)
        .iter()
        .filter_map(|c| c.narrative_order)
        .fold(f64::NEG_INFINITY, f64::max);
    t.update(cx, |t, cx| t.append_chapter(&line, cx));
    wait_for(cx, |_| chapters(&lib, &book).len() == count + 1);
    let made = chapters(&lib, &book)
        .into_iter()
        .max_by(|a, b| a.created_at.cmp(&b.created_at))
        .unwrap();
    wait_for(cx, |_| {
        let c = chapter(&lib, &book, &made.id);
        c.storylines.contains(&line) && c.narrative_order == Some(last + 5.0)
    });
    // It opens.
    wait_for(cx, |cx| {
        host.read_with(cx, |h, cx| {
            h.ws.read(cx).nav.current() == made.id.parse().ok().map(Target::Chapter).as_ref()
        })
    });
}

#[gpui::test]
fn spreading_sets_the_chapters_a_stride_apart_in_one_step(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let before: Vec<f64> = chapters(&lib, &book)
        .iter()
        .filter_map(|c| c.book_order)
        .collect();
    t.update(cx, |t, cx| t.spread(cx));
    let spread = |lib: &Library| {
        let mut orders: Vec<f64> = chapters(lib, &book)
            .iter()
            .filter_map(|c| c.book_order)
            .collect();
        orders.sort_by(f64::total_cmp);
        orders
    };
    wait_for(cx, |_| {
        spread(&lib)
            .windows(2)
            .all(|w| (w[1] - w[0] - 5.0).abs() < 1e-9)
    });
    // One step back.
    lib.undo(&Actor::User).unwrap();
    let mut was = before.clone();
    was.sort_by(f64::total_cmp);
    assert_eq!(spread(&lib), was);
    drop(host);
}

#[gpui::test]
fn the_cards_carry_the_timelines_own_rows(cx: &mut TestAppContext) {
    let (_dir, library, _book) = library();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let layout = t.read_with(cx, |t, _| t.layout());
    let c = layout.lanes[0].clips[0].clone();
    let LaneId::Storyline(line) = layout.lanes[0].id.clone() else {
        unreachable!()
    };
    let rows = t.update(cx, |t, cx| t.card_row_ids(&c.id, cx));
    assert_eq!(rows, ["timeline-unaffiliated"]);
    t.update(cx, |t, cx| t.set_axis(Axis::Narrative, cx));
    let rows = t.update(cx, |t, cx| t.card_row_ids(&c.id, cx));
    assert_eq!(rows, ["timeline-unaffiliated", "timeline-unplace"]);
    let rows = t.update(cx, |t, cx| t.card_row_ids(&line, cx));
    assert_eq!(rows, ["timeline-append"]);
}

#[gpui::test]
fn a_chapter_held_at_the_right_edge_scrolls_the_tracks(cx: &mut TestAppContext) {
    let (_dir, library, _book) = library();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let c = t.read_with(cx, |t, _| t.layout().lanes[0].clips[0].clone());
    assert_eq!(t.read_with(cx, |t, _| t.scroll_x()), 0.0);
    let start = at(&t, 0, c.book_order.unwrap(), 10.0, cx);
    let body = t.read_with(cx, |t, _| t.body_bounds().unwrap());
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(
        point(start.x + px(6.0), start.y),
        MouseButton::Left,
        Modifiers::none(),
    );
    frame(cx);
    // Held 4 px from the tracks' right edge: they scroll on their own.
    let edge = point(body.origin.x + body.size.width - px(4.0), start.y);
    cx.simulate_mouse_move(edge, MouseButton::Left, Modifiers::none());
    wait_for(cx, |cx| t.read_with(cx, |t, _| t.scroll_x() > 60.0));
    // Where it would land moved on with them.
    let over = t.read_with(cx, |t, _| t.drop_target()).unwrap();
    assert!(over.order > c.book_order.unwrap() + 40.0, "{over:?}");
    cx.simulate_mouse_up(
        point(start.x, px(5.0)),
        MouseButton::Left,
        Modifiers::none(),
    );
    frame(cx);
}

#[gpui::test]
fn the_keys_move_a_focused_act_boundary(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (host, cx) = setup(cx, library);
    let t = timeline(&host, cx);
    let second = acts(&lib, &book)[1].clone();
    let from = second.start_order.unwrap();
    frame(cx);
    let focus = t
        .read_with(cx, |t, _| t.act_focus(&second.id))
        .expect("the boundary's focus");
    cx.update(|window, cx| focus.focus(window, cx));
    frame(cx);
    cx.simulate_keystrokes("right right right left");
    // Two pixels' worth on (a unit is 20 px at zoom 1).
    let id = second.id.clone();
    wait_for(cx, |_| {
        acts(&lib, &book)
            .iter()
            .any(|a| a.id == id && (a.start_order.unwrap() - (from + 2.0 / 20.0)).abs() < 1e-9)
    });
}
