//! HC (`kernel-v5.md` §15 #46, `handoff/v5-tracks.md` HC): Project Home's
//! slot for the Agent's suggestion cards, with a stand-in for
//! `dr-view-agent`'s (the app wires the real one; its own test is
//! `dr-view-agent/tests/home_cards.rs`). Where the cards sit, that Home
//! leaves no gap without them, and when Home asks them to look.

use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
};
use dr_view_home::{AgentCards, clear_agent_cards, has_agent_cards, set_agent_cards, v3::Home};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, ParentElement as _, Render,
    Styled as _, TestAppContext, VisualTestContext, Window, div, point, px, size,
};
use serde_json::{Value, json};

/// Stands in for the Agent's cards: a fixed height, and a count of the
/// times Home asked it to look.
struct Stand {
    drawn: bool,
    shown: usize,
}

impl Render for Stand {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().w_full().h(px(120.0)).child("cards")
    }
}

type Made = Rc<RefCell<Vec<Entity<Stand>>>>;

fn register(made: &Made, cx: &mut gpui::App) {
    let made = made.clone();
    set_agent_cards(cx, move |_, _, cx| {
        let stand = cx.new(|_| Stand {
            drawn: true,
            shown: 0,
        });
        made.borrow_mut().push(stand.clone());
        AgentCards::new(stand, |s, _| s.drawn, |s, _, _| s.shown += 1)
    });
}

fn seed_library() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.rebuild_stale_indexes().unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(&root, "test").unwrap();
    (dir, lib, book)
}

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            break;
        }
        assert!(Instant::now() < deadline, "home timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn open_workspace<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
    made: &Made,
) -> (Entity<Workspace>, Entity<Home>, &'a mut VisualTestContext) {
    let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 17).unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings
            .set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .unwrap();
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.to_owned()),
                ..Default::default()
            },
            settings,
            cx,
        );
        Settings::update(cx, |s| {
            s.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .unwrap();
        });
        dr_view_home::init(cx);
        dr_view_home::set_today(day, cx);
        register(made, cx);
    });
    let (ws, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(1600.0)));
    vcx.update(|window, _| window.activate_window());
    wait(vcx, "workspace book ready", |vcx| {
        ws.read_with(vcx, |ws, _| {
            ws.book.id == book && ws.book.v3().is_some() && ws.v3_home.is_some()
        })
    });
    ws.update(vcx, |ws, cx| ws.open_home(cx));
    let home: Entity<Home> = ws.read_with(vcx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(vcx, "home with its cards", |vcx| {
        home.read_with(vcx, |h, _| h.loaded.is_some())
            && vcx.debug_bounds("v3-home-agent-cards").is_some()
            && vcx.debug_bounds("v3-home-project-template").is_some()
    });
    (ws, home, vcx)
}

fn stand(made: &Made) -> Entity<Stand> {
    let made = made.borrow();
    assert_eq!(made.len(), 1, "one Home makes its cards once");
    made[0].clone()
}

fn shown(made: &Made, vcx: &mut VisualTestContext) -> usize {
    stand(made).read_with(vcx, |s, _| s.shown)
}

fn first_entry(ws: &Entity<Workspace>, vcx: &mut VisualTestContext) -> Target {
    ws.read_with(vcx, |ws, _| {
        let v3 = ws.book.v3().unwrap();
        Target::Entry {
            id: v3.roots[0].parse().unwrap(),
            module: None,
        }
    })
}

/// Below 继续写, above the create row; a project with or without 成书 alike.
#[gpui::test]
fn the_cards_sit_below_continue_and_above_the_create_row(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed_library();
    let made = Made::default();
    let (ws, _home, vcx) = open_workspace(cx, &lib, &book, &made);
    let cards = vcx.debug_bounds("v3-home-agent-cards").unwrap();
    assert_eq!(cards.size.height, px(120.0));
    let today = vcx.debug_bounds("v3-home-today").unwrap();
    let block = vcx.debug_bounds("v3-home-project-template").unwrap();
    assert!(today.bottom() < cards.top() && cards.bottom() < block.top());

    // Right above them (one gap up) is the last 继续写 row: it opens a page.
    vcx.simulate_click(
        point(cards.left() + px(10.0), cards.top() - px(24.0 + 6.0)),
        Modifiers::none(),
    );
    wait(vcx, "继续写 opened a page", |vcx| {
        ws.read_with(vcx, |ws, _| ws.nav.active_tab().is_some())
    });
    ws.update(vcx, |ws, cx| ws.open_home(cx));
    wait(vcx, "home again", |vcx| {
        vcx.debug_bounds("v3-home-agent-cards").is_some()
    });
    // Right below them is the create row: its first button asks for a name.
    let cards = vcx.debug_bounds("v3-home-agent-cards").unwrap();
    vcx.simulate_click(
        point(cards.left() + px(10.0), cards.bottom() + px(24.0 + 6.0)),
        Modifiers::none(),
    );
    wait(vcx, "the create dialog", |vcx| {
        ws.read_with(vcx, |ws, _| ws.dialog.is_some())
    });
    vcx.update(|window, cx| {
        ws.update(cx, |ws, cx| ws.dismiss(window, cx));
    });

    // Without 成书 the cards are there just the same.
    call(
        &lib,
        "project.update",
        json!({"book": book, "has_book": false}),
    );
    wait(vcx, "成书 off", |vcx| {
        ws.read_with(vcx, |ws, _| {
            ws.book.v3().is_some_and(|v| v.project.book.is_none())
        }) && vcx.debug_bounds("v3-home-today").is_none()
    });
    assert!(vcx.debug_bounds("v3-home-agent-cards").is_some());
    vcx.update(|_, cx| clear_agent_cards(cx));
    lib.close();
}

/// Nothing to draw (or nothing registered): no slot and no gap; the blocks
/// below move up by exactly the cards' height and one gap.
#[gpui::test]
fn without_cards_home_leaves_no_gap(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed_library();
    let made = Made::default();
    let (_ws, home, vcx) = open_workspace(cx, &lib, &book, &made);
    let cards = vcx.debug_bounds("v3-home-agent-cards").unwrap();
    let today = vcx.debug_bounds("v3-home-today").unwrap();
    let block = vcx.debug_bounds("v3-home-project-template").unwrap();

    stand(&made).update(vcx, |s, cx| {
        s.drawn = false;
        cx.notify();
    });
    wait(vcx, "nothing drawn", |vcx| {
        vcx.debug_bounds("v3-home-agent-cards").is_none()
    });
    let moved = vcx.debug_bounds("v3-home-project-template").unwrap();
    assert_eq!(block.top() - moved.top(), cards.size.height + px(24.0));
    assert_eq!(vcx.debug_bounds("v3-home-today").unwrap(), today);

    stand(&made).update(vcx, |s, cx| {
        s.drawn = true;
        cx.notify();
    });
    wait(vcx, "drawn again", |vcx| {
        vcx.debug_bounds("v3-home-agent-cards").is_some()
    });
    assert_eq!(vcx.debug_bounds("v3-home-project-template").unwrap(), block);

    vcx.update(|_, cx| {
        clear_agent_cards(cx);
        assert!(!has_agent_cards(cx));
    });
    // A Home that made its cards keeps them; a new registration is for
    // the next Home. Nothing registered for a fresh Home: nothing drawn.
    assert!(home.read_with(vcx, |h, _| h.loaded.is_some()));
    lib.close();
}

#[gpui::test]
fn nothing_registered_draws_nothing(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed_library();
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
                library: Some(lib.clone()),
                book: Some(book.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_home::init(cx);
        clear_agent_cards(cx);
    });
    let (ws, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(1600.0)));
    wait(vcx, "home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == book && ws.v3_home.is_some())
            && vcx.debug_bounds("v3-home-project-template").is_some()
    });
    assert!(vcx.debug_bounds("v3-home-agent-cards").is_none());
    lib.close();
}

/// Home asks the cards to look when it comes to the front (opened on Home,
/// the last tab closed, 项目主页) and when the window comes back with it in
/// front; not while a page is in front.
#[gpui::test]
fn home_asks_the_cards_to_look_when_it_comes_to_the_front(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed_library();
    let made = Made::default();
    let (ws, _home, vcx) = open_workspace(cx, &lib, &book, &made);
    // Opened on Home (and the new window coming to the front with it).
    let opened = shown(&made, vcx);
    assert!(opened >= 1, "the project opened on Home");

    // A page in front: Home is not, and asks nothing.
    let target = first_entry(&ws, vcx);
    ws.update(vcx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    wait(vcx, "a page in front", |vcx| {
        ws.read_with(vcx, |ws, _| ws.nav.active_tab().is_some())
    });
    vcx.deactivate_window();
    vcx.update(|window, _| window.activate_window());
    wait(vcx, "back with a page", |vcx| {
        vcx.update(|window, _| window.is_window_active())
    });
    assert_eq!(shown(&made, vcx), opened, "the window came back to a page");

    // 项目主页: Home in front again.
    ws.update(vcx, |ws, cx| ws.open_home(cx));
    wait(vcx, "home in front", |vcx| {
        vcx.debug_bounds("v3-home-agent-cards").is_some()
    });
    assert_eq!(shown(&made, vcx), opened + 1);

    // The window comes back with Home in front.
    vcx.deactivate_window();
    vcx.update(|window, _| window.activate_window());
    wait(vcx, "back on Home", |vcx| {
        vcx.update(|window, _| window.is_window_active())
    });
    assert_eq!(shown(&made, vcx), opened + 2);

    // Drawing again, or the book changing under Home, is not coming back.
    call(
        &lib,
        "book.update",
        json!({"book": book, "summary": "换一个简介"}),
    );
    wait(vcx, "the book changed", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.v3().is_some())
            && vcx.debug_bounds("v3-home-agent-cards").is_some()
    });
    assert_eq!(shown(&made, vcx), opened + 2);

    // The last tab closed: Home is in front again.
    ws.update(vcx, |ws, cx| ws.open(target, Open::KEEP, cx));
    wait(vcx, "a page again", |vcx| {
        ws.read_with(vcx, |ws, _| ws.nav.active_tab().is_some())
    });
    assert_eq!(ws.read_with(vcx, |ws, _| ws.nav.tabs().len()), 1);
    vcx.dispatch_action(dr_shell::actions::CloseActiveTab);
    wait(vcx, "home after the last tab", |vcx| {
        vcx.debug_bounds("v3-home-agent-cards").is_some()
    });
    assert_eq!(shown(&made, vcx), opened + 3);
    vcx.update(|_, cx| clear_agent_cards(cx));
    lib.close();
}

/// 编辑模板的工作区: no cards, and Home asks for no look there.
#[gpui::test]
fn a_templates_working_copy_shows_no_cards_and_asks_for_none(cx: &mut TestAppContext) {
    let (_dir, lib, book) = seed_library();
    let template = call(
        &lib,
        "project_template.save",
        json!({"book": book, "name": "合成模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let copy = call(&lib, "project_template.edit", json!({"id": template}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    let made = Made::default();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book, &made);
    let opened = shown(&made, vcx);
    assert!(opened >= 1);

    vcx.update(|window, cx| ws.update(cx, |ws, cx| ws.open_book(&copy, window, cx)));
    wait(vcx, "the working copy on Home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == copy)
            && home.read_with(vcx, |h, _| h.template_workspace() && h.loaded.is_some())
    });
    assert!(vcx.debug_bounds("v3-home-agent-cards").is_none());
    assert_eq!(
        shown(&made, vcx),
        opened,
        "opening the working copy asks for no look"
    );
    vcx.deactivate_window();
    vcx.update(|window, _| window.activate_window());
    wait(vcx, "back on the working copy", |vcx| {
        vcx.update(|window, _| window.is_window_active())
    });
    assert_eq!(shown(&made, vcx), opened, "nor does the window coming back");

    vcx.update(|window, cx| ws.update(cx, |ws, cx| ws.open_book(&book, window, cx)));
    wait(vcx, "the project again", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == book)
            && !home.read_with(vcx, |h, _| h.template_workspace())
            && vcx.debug_bounds("v3-home-agent-cards").is_some()
    });
    assert_eq!(shown(&made, vcx), opened + 1);
    vcx.update(|_, cx| clear_agent_cards(cx));
    lib.close();
}
