//! T9 (`kernel-v5.md` §17, `v5-tracks.md` T9) on GPUI's test platform, over
//! dr-testkit's 《慢钟》 where a book is needed: the overlapping moon pairs'
//! three looks and every cell of their state machine, clicked where they are
//! drawn; the pill row while a panel fills (dots that grow under the hand);
//! the pill row over immersive writing; the bottom fill's edges; ⌘[ out of a
//! fill; a new template from the left column's foot; and a library swap
//! while the material library fills.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Page, Target};
use dr_shell::pages::{self, BottomPane, BottomPanel, PageViewHost};
use dr_shell::panes::PaneId;
use dr_shell::settings::registry;
use dr_shell::workspace::{
    DOCK_NEW, DOCK_ROW, FillPlace, LEADING_INSET, MOON_DIM, MoonLook, RightTab, Side, moon_look,
};
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_ui::sand::Icon;
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Modifiers, MouseButton, Render,
    TestAppContext, VisualTestContext, Window, div, point, px, size,
};
use serde_json::json;

const VERSION: &str = "0.2.0-dev";

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: VERSION,
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

/// A library holding 《慢钟》 (dr-testkit's sample, written for Drifting).
fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&book).unwrap()).unwrap();
    lib.close().unwrap();
    (dir, Library::open_dir(&root, VERSION).unwrap())
}

/// A window over `library` (or none), with `more` registered after the
/// shell and the page module.
fn setup(
    cx: &mut TestAppContext,
    library: Option<Library>,
    more: impl FnOnce(&mut App),
) -> (Entity<Workspace>, &mut VisualTestContext) {
    if library.is_some() {
        // F3 reads and delivers events on its own threads.
        cx.executor().allow_parking();
    }
    cx.update(|cx| {
        dr_shell::init(
            info(),
            Services {
                deep_links: None,
                crash_reports: None,
                library,
                library_failure: None,
                book: None,
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::init(cx);
        // Structural movements land at once, as they have after 420 ms in
        // the app.
        Settings::update(cx, |f| f.set(registry::REDUCE_MOTION, json!(true), None)).unwrap();
        more(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    cx.simulate_resize(size(px(1280.0), px(800.0)));
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

/// Runs the app until `done` holds, at most ten seconds.
fn wait_for(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&Workspace, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The tests write the primary modifier as `cmd-`; elsewhere it is Ctrl.
fn keys(cx: &mut VisualTestContext, strokes: &str) {
    let strokes = if cfg!(target_os = "macos") {
        strokes.to_owned()
    } else {
        strokes.replace("cmd-", "ctrl-")
    };
    cx.simulate_keystrokes(&strokes);
}

fn chapter(n: u8) -> Target {
    Target::Entry {
        id: format!("ch-{n}").parse().unwrap(),
        module: Some("mod-prose".parse().unwrap()),
    }
}

fn center_of(cx: &mut VisualTestContext, selector: &'static str) -> gpui::Point<gpui::Pixels> {
    draw(cx);
    cx.debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"))
        .center()
}

/// A click where `selector` is drawn, as the hand would.
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = center_of(cx, selector);
    cx.simulate_mouse_move(at, None, Modifiers::none());
    cx.simulate_click(at, Modifiers::none());
    draw(cx);
}

/// The pointer resting on `selector`.
fn hover(cx: &mut VisualTestContext, selector: &'static str) {
    let at = center_of(cx, selector);
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
}

/// The pointer on the desk, away from every control.
fn rest_pointer(cx: &mut VisualTestContext) {
    cx.simulate_mouse_move(point(px(640.0), px(560.0)), None, Modifiers::none());
    draw(cx);
}

/// The pointer away from the dock, and the dock's wait before its pills
/// fold back (`dwell::DOCK_COLLAPSE`) over.
fn leave_dock(cx: &mut VisualTestContext) {
    rest_pointer(cx);
    cx.executor().advance_clock(Duration::from_millis(600));
    draw(cx);
}

/// A press on `selector` dragged `dx` across, as the hand would. The
/// sidebar edges' grips straddle the column's edge and the column clips the
/// outer half: the press lands on the inner half (`inward`, -1 or 1).
fn drag(cx: &mut VisualTestContext, selector: &'static str, inward: f32, dx: f32) {
    let from = center_of(cx, selector) + point(px(inward * 1.5), px(0.0));
    let to = from + point(px(dx), px(0.0));
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(
        from + point(px(dx.signum() * 8.0), px(0.0)),
        MouseButton::Left,
        Modifiers::none(),
    );
    draw(cx);
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::none());
    draw(cx);
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    draw(cx);
}

/// Whether `side` is open, and what fills.
fn state(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    side: Side,
) -> (bool, Option<FillPlace>) {
    view.read_with(cx, |ws, _| {
        let open = match side {
            Side::Left => ws.left.open,
            Side::Right => ws.right.open,
        };
        (open, ws.filled())
    })
}

fn look(view: &Entity<Workspace>, cx: &mut VisualTestContext, side: Side) -> MoonLook {
    view.read_with(cx, |ws, _| moon_look(ws, side))
}

struct Blank;
impl Render for Blank {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// `W25Final`'s table, clicked on the drawn moons for both sidebars:
///
/// | now    | the two         | crescent              | full moon                 |
/// | ------ | --------------- | --------------------- | ------------------------- |
/// | closed | hollow ☾ ahead  | open                  | filled (opened with it)   |
/// | open   | ☾ ahead         | closed                | filled                    |
/// | filled | ● ahead, ☾ back | closed (fill goes)    | open                      |
///
/// Pointing at the one behind only darkens it; pointing at the one in front
/// changes nothing. On Stats or Agent the right full moon is dim and does
/// nothing, and a fill that switches there falls back to open.
#[gpui::test]
fn the_moon_pairs_look_and_answer_every_cell_of_their_state_machine(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, None, |_| {});
    view.update_in(cx, |ws, window, cx| {
        if ws.left.open {
            ws.toggle_left(window, cx);
        }
        if ws.right.open {
            ws.toggle_right(window, cx);
        }
        ws.right.panes.reveal(RightTab::Review);
    });
    rest_pointer(cx);

    for (side, toggle, fill, place, icons) in [
        (
            Side::Left,
            "toggle-left",
            "fill-left",
            FillPlace::Left,
            [
                Icon::MoonLeftHollow,
                Icon::MoonLeft,
                Icon::MoonHollowfullLeft,
                Icon::MoonBlackLeft,
            ],
        ),
        (
            Side::Right,
            "toggle-right",
            "fill-right",
            FillPlace::Right,
            [
                Icon::MoonRightHollow,
                Icon::MoonRight,
                Icon::MoonHollowfullRight,
                Icon::MoonBlackRight,
            ],
        ),
    ] {
        let [cresc_hollow, cresc, full_hollow, full_black] = icons;
        let closed = MoonLook {
            crescent_in_front: true,
            front: cresc_hollow,
            back: full_hollow,
            back_opacity: MOON_DIM,
            can_fill: true,
        };
        let open = MoonLook {
            front: cresc,
            ..closed
        };
        let filled = MoonLook {
            crescent_in_front: false,
            front: full_black,
            back: cresc,
            back_opacity: MOON_DIM,
            can_fill: true,
        };
        assert_eq!(
            state(&view, cx, side),
            (false, None),
            "{side:?} starts closed"
        );
        assert_eq!(look(&view, cx, side), closed);

        // Closed: the crescent opens.
        click(cx, toggle);
        assert_eq!(state(&view, cx, side), (true, None));
        assert_eq!(look(&view, cx, side), open);
        // Open: the crescent closes.
        click(cx, toggle);
        assert_eq!(state(&view, cx, side), (false, None));
        assert_eq!(look(&view, cx, side), closed);
        // Closed: the full moon opens the sidebar and fills it.
        click(cx, fill);
        assert_eq!(state(&view, cx, side), (true, Some(place)));
        rest_pointer(cx);
        assert_eq!(look(&view, cx, side), filled);
        // Filled: the full moon goes back to open.
        click(cx, fill);
        assert_eq!(state(&view, cx, side), (true, None));
        rest_pointer(cx);
        assert_eq!(look(&view, cx, side), open);
        // Open: the full moon fills.
        click(cx, fill);
        assert_eq!(state(&view, cx, side), (true, Some(place)));
        // Filled: the crescent closes the sidebar and the fill goes with it.
        click(cx, toggle);
        assert_eq!(state(&view, cx, side), (false, None));
        rest_pointer(cx);
        assert_eq!(look(&view, cx, side), closed);

        // Pointing: the one behind gets darker and stays behind; the one in
        // front does not change.
        click(cx, toggle);
        rest_pointer(cx);
        hover(cx, fill);
        assert_eq!(
            look(&view, cx, side),
            MoonLook {
                back_opacity: 1.0,
                ..open
            }
        );
        hover(cx, toggle);
        assert_eq!(look(&view, cx, side), open);
        click(cx, fill);
        hover(cx, toggle);
        assert_eq!(
            look(&view, cx, side),
            MoonLook {
                back_opacity: 1.0,
                ..filled
            }
        );
        hover(cx, fill);
        assert_eq!(look(&view, cx, side), filled);
        click(cx, toggle);
        rest_pointer(cx);
        assert_eq!(state(&view, cx, side), (false, None));
    }

    // Stats, Relations, and Companion (Agent) all support Fill mode now:
    // the right full moon stays enabled, fills when clicked, and switching
    // between right tabs while filled keeps Fill active.
    click(cx, "toggle-right");
    for tab in [RightTab::Stats, RightTab::Relations, RightTab::Companion] {
        view.update(cx, |ws, cx| {
            ws.right.panes.reveal(tab);
            cx.notify();
        });
        rest_pointer(cx);
        let ready = MoonLook {
            crescent_in_front: true,
            front: Icon::MoonRight,
            back: Icon::MoonHollowfullRight,
            back_opacity: MOON_DIM,
            can_fill: true,
        };
        assert_eq!(look(&view, cx, Side::Right), ready);
        click(cx, "fill-right");
        assert_eq!(
            state(&view, cx, Side::Right),
            (true, Some(FillPlace::Right))
        );
        click(cx, "fill-right");
        assert_eq!(state(&view, cx, Side::Right), (true, None));
    }
    // Filled on Review, then switched to Stats and Companion: stays filled.
    view.update(cx, |ws, cx| {
        ws.right.panes.reveal(RightTab::Review);
        cx.notify();
    });
    click(cx, "fill-right");
    assert_eq!(
        state(&view, cx, Side::Right),
        (true, Some(FillPlace::Right))
    );
    view.update(cx, |ws, cx| {
        ws.right.panes.click(PaneId::Primary, RightTab::Stats);
        cx.notify();
    });
    draw(cx);
    assert_eq!(
        state(&view, cx, Side::Right),
        (true, Some(FillPlace::Right))
    );
    view.update(cx, |ws, cx| {
        ws.right.panes.click(PaneId::Primary, RightTab::Companion);
        cx.notify();
    });
    draw(cx);
    assert_eq!(
        state(&view, cx, Side::Right),
        (true, Some(FillPlace::Right))
    );
}

/// `W11Right`: above a filled panel the open documents are the same row of
/// dots as on the paper, growing into pills only under the hand.
#[gpui::test]
fn above_a_fill_the_pill_row_is_dots_that_grow_under_the_hand(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, None, |_| {});
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    leave_dock(cx);
    assert!(cx.debug_bounds(DOCK_ROW).is_some());
    assert!(
        cx.debug_bounds(DOCK_NEW).is_none(),
        "at rest the open documents are dots"
    );
    for place in [FillPlace::Left, FillPlace::Right, FillPlace::Bottom] {
        view.update_in(cx, |ws, window, cx| {
            ws.right.panes.reveal(RightTab::Review);
            assert!(ws.enter_fill(place, window, cx), "{place:?} fills");
        });
        leave_dock(cx);
        assert!(
            cx.debug_bounds(DOCK_NEW).is_none(),
            "{place:?} filled: still dots, not held open as pills"
        );
        hover(cx, DOCK_ROW);
        assert!(
            cx.debug_bounds(DOCK_NEW).is_some(),
            "{place:?} filled: under the hand the dots grow into pills"
        );
        view.update_in(cx, |ws, window, cx| {
            ws.exit_fill(window, cx);
        });
        leave_dock(cx);
    }
}

/// M26 with the top band out: the sidebars are not drawn, so the pill row
/// is centred on the whole window, not offset by their widths.
#[gpui::test]
fn over_immersive_writing_the_pill_row_is_centred_on_the_window(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, None, |_| {});
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
        if !ws.right.open {
            ws.toggle_right(window, cx);
        }
        ws.left.width = 320.0;
        ws.right.width = 260.0;
        ws.left.reveal.set(1.0);
        ws.right.reveal.set(1.0);
        ws.open(chapter(1), Open::KEEP, cx);
    });
    rest_pointer(cx);
    let row = cx.debug_bounds(DOCK_ROW).expect("the pill row");
    assert!(
        f32::from(row.left()) >= 320.0,
        "over the middle column: {row:?}"
    );

    view.update(cx, |ws, cx| ws.set_immersive(true, cx));
    draw(cx);
    assert!(cx.debug_bounds(DOCK_ROW).is_none(), "immersed, the dots go");
    cx.simulate_mouse_move(point(px(200.0), px(10.0)), None, Modifiers::none());
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.immersive && ws.immersion.top));
    let row = cx
        .debug_bounds(DOCK_ROW)
        .expect("the top band brings the dots back");
    assert_eq!(row.left(), px(LEADING_INSET));
    assert_eq!(row.right(), px(1280.0 - LEADING_INSET));
    assert_eq!(row.center().x, px(640.0), "centred on the whole window");
}

/// The bottom fill: no height grip (and the height stays), while its left
/// and right edges are the sidebars' edges and drag their widths, still
/// filled.
#[gpui::test]
fn the_bottom_fill_has_no_height_grip_and_its_edges_drag_the_sidebars(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, Some(lib), |cx| {
        pages::add_v3_bottom_panel(cx, BottomPane::Timeline, |_, _, cx| {
            Some(BottomPanel::new(cx.new(|_| Blank)))
        });
    });
    wait_for(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    cx.simulate_resize(size(px(1440.0), px(900.0)));
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
        if !ws.right.open {
            ws.toggle_right(window, cx);
        }
        ws.left.width = 300.0;
        ws.right.width = 300.0;
        ws.left.reveal.set(1.0);
        ws.right.reveal.set(1.0);
    });
    wait_for(&view, cx, "the timeline pane", |ws, cx| {
        ws.bottom_pane(cx) == Some(BottomPane::Timeline)
    });
    draw(cx);
    assert!(
        cx.debug_bounds("bottom-panel-grip").is_some(),
        "the bar's top edge drags its height"
    );
    let height = view.read_with(cx, |ws, _| ws.bottom_height());

    view.update_in(cx, |ws, window, cx| {
        assert!(ws.enter_fill(FillPlace::Bottom, window, cx));
    });
    draw(cx);
    assert!(
        cx.debug_bounds("bottom-panel-grip").is_none(),
        "filled, the height is not dragged"
    );
    let widths = |cx: &mut VisualTestContext| {
        view.read_with(cx, |ws, _| (ws.left.width, ws.right.width, ws.filled()))
    };
    let (left, right, _) = widths(cx);

    // The width follows the pointer (pressed 1.5 px inside the edge).
    drag(cx, "resize-left", -1.0, 40.0);
    let (l, r, filled) = widths(cx);
    assert!(
        (l - (left - 1.5 + 40.0)).abs() < 1.0,
        "the left edge: {left} → {l}"
    );
    assert_eq!(r, right);
    assert_eq!(filled, Some(FillPlace::Bottom), "still filled");

    drag(cx, "resize-right", 1.0, -40.0);
    let (l2, r, filled) = widths(cx);
    assert_eq!(l2, l);
    assert!(
        (r - (right - 1.5 + 40.0)).abs() < 1.0,
        "the right edge: {right} → {r}"
    );
    assert_eq!(filled, Some(FillPlace::Bottom), "still filled");
    assert_eq!(view.read_with(cx, |ws, _| ws.bottom_height()), height);
}

/// ⌘[ first leaves the fill (the page stays); the next ⌘[ goes back.
#[gpui::test]
fn cmd_bracket_first_leaves_the_fill_then_goes_back(cx: &mut TestAppContext) {
    let (view, cx) = setup(cx, None, |_| {});
    view.update(cx, |ws, cx| {
        ws.open(chapter(1), Open::KEEP, cx);
        ws.open(chapter(2), Open::KEEP, cx);
    });
    for place in [FillPlace::Left, FillPlace::Bottom] {
        view.update_in(cx, |ws, window, cx| {
            assert!(ws.enter_fill(place, window, cx));
        });
        draw(cx);
        keys(cx, "cmd-[");
        assert_eq!(
            view.read_with(cx, |ws, _| (ws.filled(), ws.nav.page())),
            (None, Page::Target(chapter(2))),
            "{place:?}: the first ⌘[ leaves the fill"
        );
        if place == FillPlace::Left {
            assert!(view.read_with(cx, |ws, _| ws.left.open), "back to open");
        }
    }
    keys(cx, "cmd-[");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.page()),
        Page::Target(chapter(1)),
        "the next ⌘[ goes back"
    );
}

/// K5 from the left column's foot while the column does not fill: the new
/// template opens in K5's full editor, in a new pill, and nothing fills.
#[gpui::test]
fn a_new_template_from_the_left_foot_opens_the_full_editor_in_a_new_pill(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, Some(lib), dr_view_templates::init);
    wait_for(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
    });
    wait_for(&view, cx, "the left column", |ws, _| {
        ws.v3_sidebar.is_some()
    });
    let (tabs, templates) = view.read_with(cx, |ws, _| {
        (ws.nav.tabs().len(), ws.book.v3().unwrap().templates.len())
    });
    assert_eq!(view.read_with(cx, |ws, _| ws.filled()), None);

    // What the `+` in the template block at the column's foot calls.
    cx.update(|window, cx| {
        let host = view.read_with(cx, |ws, _| PageViewHost {
            workspace: view.downgrade(),
            library: ws.library.clone().unwrap(),
            book_id: ws.book_id.clone(),
            book: ws.book.clone(),
        });
        dr_shell::v3::create_template(host, window, cx);
    });
    wait_for(&view, cx, "the new template's pill", |ws, _| {
        ws.nav.tabs().len() == tabs + 1 && matches!(ws.nav.current(), Some(Target::Template(_)))
    });
    let target = view.read_with(cx, |ws, _| ws.nav.current().cloned().unwrap());
    let Target::Template(id) = &target else {
        unreachable!()
    };
    let made = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        (v.templates.len(), v.template(id.as_str()).is_some())
    });
    assert_eq!(made, (templates + 1, true), "the template was written");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.filled()),
        None,
        "nothing fills"
    );
    wait_for(&view, cx, "the full editor", |ws, _| {
        ws.module_page(&target).is_some()
    });
    let page = view.read_with(cx, |ws, _| ws.module_page(&target).cloned().unwrap());
    assert!(
        page.downcast::<dr_view_templates::TemplateEditor>().is_ok(),
        "the pill shows K5's full template editor"
    );
}

/// Runs `replace` with `job` and waits for its outcome.
fn swap_library(
    cx: &mut VisualTestContext,
    job: impl FnOnce(&std::path::Path, dr_store::LibraryOptions) -> Result<dr_store::Library, String>
    + Send
    + 'static,
) -> Result<(), String> {
    let got = std::rc::Rc::new(std::cell::RefCell::new(None));
    let put = got.clone();
    cx.update(|_, cx| {
        dr_shell::library::replace(cx, job, move |result, _| *put.borrow_mut() = Some(result))
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        // Frames go on as in the app.
        draw(cx);
        if let Some(result) = got.borrow_mut().take() {
            return result;
        }
        assert!(Instant::now() < deadline, "the swap did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A PDF in the book's library: the library asks the previews for its page
/// count.
fn add_pdf(lib: &Library) {
    let book = lib.call(&Actor::User, "book.list", json!({})).unwrap()["output"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    lib.call(
        &Actor::User,
        "asset.put",
        json!({
            "book": &book,
            "id": "00000000-0000-7000-8000-0000000000a1",
            "kind": "pdf",
            "mime": "application/pdf",
            "size": 68,
            "sha256": "00000000000000000000000000000000000000000000000000000000000000a1",
        }),
    )
    .unwrap();
}

/// The material library filled, with a file whose preview it asks for:
/// the library is let go and swapped (the job can open it itself, so it was
/// closed), and the new one fills again. Before, the previews' cache kept
/// the old library and the swap failed (`progress.md`, M35).
#[gpui::test]
fn a_library_swap_lets_go_while_the_material_library_fills(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    add_pdf(&lib);
    let root = lib.library().paths().root.clone();
    let (view, cx) = setup(cx, Some(lib), dr_view_material::init);
    wait_for(&view, cx, "the book", |ws, _| {
        ws.book.v3().is_some_and(|v| !v.materials.is_empty())
    });
    let fill_library = |view: &Entity<Workspace>, cx: &mut VisualTestContext| {
        view.update_in(cx, |ws, window, cx| {
            if !ws.right.open {
                ws.toggle_right(window, cx);
            }
            ws.right.reveal.set(1.0);
            ws.right.panes.reveal(RightTab::Library);
            assert!(ws.enter_fill(FillPlace::Right, window, cx));
        });
        // The library draws its files (and asks for their previews).
        let until = Instant::now() + Duration::from_millis(400);
        while Instant::now() < until {
            draw(cx);
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    fill_library(&view, cx);

    let seen = root.clone();
    let swapped = swap_library(cx, move |root, options| {
        assert_eq!(root, seen.as_path());
        // Only a closed library opens.
        dr_store::Library::open(root, options).map_err(|e| e.to_string())
    });
    assert_eq!(swapped, Ok(()));
    wait_for(&view, cx, "the new library's book", |ws, cx| {
        ws.library.is_some() && ws.book.v3().is_some() && cx.global::<Services>().library.is_some()
    });
    fill_library(&view, cx);
    assert_eq!(
        view.read_with(cx, |ws, _| ws.filled()),
        Some(FillPlace::Right)
    );
    // And it lets go again.
    let swapped = swap_library(cx, |root, options| {
        dr_store::Library::open(root, options).map_err(|e| e.to_string())
    });
    assert_eq!(swapped, Ok(()));
}
