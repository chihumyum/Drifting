//! The bottom timeline on GPUI's test platform over dr-testkit's 《慢钟》
//! (through F3): one lane per storyline with each chapter on its main
//! storyline's lane; 未归属 on request; the narrative axis and 未放置; a
//! chapter dragged with the mouse onto another lane changes its main
//! storyline and its place; dropped on 未归属 it leaves every storyline; a
//! double click on an empty spot makes a chapter there.

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
    let end = at(&t, 1, target, 16.0, cx);
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
