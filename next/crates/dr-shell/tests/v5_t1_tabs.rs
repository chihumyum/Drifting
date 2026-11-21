//! T1 (`kernel-v5.md` §5, §8): the left column's Tabs come from the project
//! definition, an entry's mark is its own or its template's, and an entry
//! opens in one tab.
use std::{
    cell::Cell,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    actions::Undo,
    book::{
        Book,
        v3::{BookV3, is_glyph_mark, mark},
    },
    nav::{Open, Target},
    pages::PageViewHost,
    v3::{self, Rendered, sidebar::Sidebar, tabs},
};
use dr_ui::sand;
use dr_workspace::{Actor, Workspace, commands::v3::types::TabMount};
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Modifiers, Render, ScrollDelta,
    ScrollEvent, TestAppContext, VisualTestContext, Window, div, point, px,
};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn seed() -> (tempfile::TempDir, Workspace, String) {
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
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

fn root_of(v: &BookV3, template: &str) -> String {
    v.entries
        .iter()
        .find(|e| e.template.as_deref() == Some(template) && e.parent.is_none())
        .unwrap()
        .id
        .clone()
}

struct DummyPart;
impl Render for DummyPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// A window on `id`'s book, with stand-in level displays.
fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    id: &str,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
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
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        for display in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, display, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    (view, cx)
}

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait(
    view: &Entity<Shell>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&Shell, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn sidebar(view: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<Sidebar> {
    // The left column starts closed: open it, so the Tabs are drawn.
    if !view.read_with(cx, |ws, _| ws.left.open) {
        cx.update(|window, cx| view.update(cx, |ws, cx| ws.toggle_left(window, cx)));
    }
    wait(view, cx, "the left column", |ws, _| ws.v3_sidebar.is_some());
    view.read_with(cx, |ws, _| ws.v3_sidebar.clone().unwrap())
}

fn host(
    view: &Entity<Shell>,
    lib: &Workspace,
    id: &str,
    cx: &mut VisualTestContext,
) -> PageViewHost {
    PageViewHost {
        workspace: view.downgrade(),
        library: lib.clone(),
        book_id: id.to_owned(),
        book: view.read_with(cx, |ws, _| ws.book.clone()),
    }
}

fn tabs_of(ws: &Shell) -> Vec<(String, TabMount)> {
    ws.book
        .v3()
        .unwrap()
        .project
        .tabs
        .iter()
        .map(|t| (t.id.clone(), t.mount.clone()))
        .collect()
}

/// The Tabs' names as the column shows them.
fn names(sidebar: &Entity<Sidebar>, cx: &mut VisualTestContext) -> Vec<String> {
    sidebar.read_with(cx, |s, cx| {
        s.state(cx)["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    })
}

fn tab_on(ws: &Shell, mount: &TabMount) -> Option<String> {
    tabs_of(ws)
        .into_iter()
        .find(|(_, m)| m == mount)
        .map(|(id, _)| id)
}

/// A level under `root`: the first entry living there that holds entries.
fn level_under(v: &BookV3, root: &str) -> String {
    v.levels[root]
        .children
        .iter()
        .find(|id| v.has_below(id))
        .unwrap()
        .clone()
}

#[gpui::test]
fn managing_adds_reorders_and_removes_tabs_named_after_their_mounts(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    // A writing project: 「全部」 and the four outermost levels first (the
    // seed adds 0.1's text materials after them), on 「全部」.
    assert_eq!(
        names(&sidebar, cx)[..5],
        ["全部", "书稿", "构想", "要素", "故事线"]
    );
    let root_tab = view.read_with(cx, |ws, _| tab_on(ws, &TabMount::Root).unwrap());
    sidebar.read_with(cx, |s, cx| {
        assert_eq!(
            s.state(cx)["selected"],
            json!(root_tab),
            "opens on 「全部」"
        );
    });
    let (manuscript, elements, category, chapter) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let manuscript = root_of(v, "tpl-manuscript");
        let elements = root_of(v, "tpl-elements");
        let category = level_under(v, &elements);
        let chapter = v
            .entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap()
            .id
            .clone();
        (manuscript, elements, category, chapter)
    });

    // A Tab is called by what it shows: renaming the entry renames it.
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": manuscript, "title": "正文"}),
    );
    wait(&view, cx, "the renamed entry", |ws, _| {
        ws.book.v3().unwrap().entry(&manuscript).unwrap().title == "正文"
    });
    pump(cx);
    assert_eq!(names(&sidebar, cx)[1], "正文");

    // Managing: what a Tab already shows and leaves are faint; a level no
    // Tab shows is lit.
    cx.update(|window, cx| sidebar.update(cx, |s, cx| s.set_managing(true, window, cx)));
    pump(cx);
    sidebar.read_with(cx, |s, cx| {
        let state = s.state(cx);
        assert_eq!(state["managing"], json!(true));
        let rows = state["structure"]["rows"].as_array().unwrap().clone();
        let lit = |row: &str| rows.iter().find(|r| r["row"] == row).unwrap()["lit"].clone();
        assert_eq!(lit("root"), json!(false));
        assert_eq!(lit(&manuscript), json!(false));
        assert_eq!(lit(&elements), json!(false));
        assert_eq!(lit(&category), json!(true));
        assert_eq!(lit(&chapter), json!(false), "a leaf is never a Tab");
        // No views to drag in: a Tab cannot mount one (DV, `kernel-v5.md`
        // §15 item 15).
        let views: Vec<String> = view
            .read(cx)
            .book
            .v3()
            .unwrap()
            .timeline_views
            .iter()
            .map(|tv| tv.id.clone())
            .collect();
        assert!(!views.is_empty());
        assert!(
            rows.iter()
                .all(|r| !views.iter().any(|v| r["row"] == json!(v)))
        );
    });

    // Dropped into the row: a Tab where the slot opened.
    let mount = TabMount::Entry {
        entry: category.clone(),
    };
    sidebar.update(cx, |s, cx| s.add_at(mount.clone(), 1, cx));
    wait(&view, cx, "the added Tab", |ws, _| {
        tab_on(ws, &mount).is_some()
    });
    let added = view.read_with(cx, |ws, _| tab_on(ws, &mount).unwrap());
    view.read_with(cx, |ws, _| assert_eq!(tabs_of(ws)[1].0, added));
    // It is lit no more, and the same thing never gets a second Tab.
    pump(cx);
    sidebar.read_with(cx, |s, cx| {
        let rows = s.state(cx)["structure"]["rows"].as_array().unwrap().clone();
        let row = rows.iter().find(|r| r["row"] == json!(category)).unwrap();
        assert_eq!(row["lit"], json!(false));
    });
    assert!(
        lib.call(&Actor::User, "tab.put", json!({"book": id, "mount": mount}),)
            .is_err(),
        "one Tab per thing"
    );

    // 「全部」 drags like any Tab and has no remove.
    sidebar.update(cx, |s, cx| s.move_to(&root_tab, 3, cx));
    wait(&view, cx, "「全部」 moved", |ws, _| {
        tabs_of(ws)[2].0 == root_tab
    });
    sidebar.update(cx, |s, cx| s.remove(&root_tab, cx));
    pump(cx);
    assert!(
        lib.call(
            &Actor::User,
            "tab.remove",
            json!({"book": id, "id": root_tab})
        )
        .is_err()
    );
    view.read_with(cx, |ws, _| assert!(tab_on(ws, &TabMount::Root).is_some()));

    // The badge removes a Tab, not what it shows; ⌘Z puts it back.
    sidebar.update(cx, |s, cx| s.remove(&added, cx));
    wait(&view, cx, "the removal", |ws, _| {
        tab_on(ws, &mount).is_none()
    });
    view.read_with(cx, |ws, _| {
        assert!(ws.book.v3().unwrap().entry(&category).is_some())
    });
    cx.update(|window, cx| {
        let focus = view.read(cx).focus_handle().clone();
        focus.focus(window, cx);
    });
    cx.dispatch_action(Undo);
    wait(&view, cx, "the undo", |ws, _| tab_on(ws, &mount).is_some());

    // Managing again (the column takes the keyboard): Esc ends it.
    cx.update(|window, cx| {
        sidebar.update(cx, |s, cx| {
            s.set_managing(false, window, cx);
            s.set_managing(true, window, cx);
        })
    });
    pump(cx);
    cx.simulate_keystrokes("escape");
    pump(cx);
    sidebar.read_with(cx, |s, _| assert!(!s.is_managing()));
}

#[gpui::test]
fn the_selected_tab_goes_with_the_project(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    // Left on 「构想」 (on another device, say).
    let ideas_tab = {
        let book = Book::load(&lib, &id).unwrap();
        let v = book.v3().unwrap();
        let ideas = root_of(v, "tpl-ideas");
        v.project
            .tabs
            .iter()
            .find(|t| {
                t.mount
                    == TabMount::Entry {
                        entry: ideas.clone(),
                    }
            })
            .unwrap()
            .id
            .clone()
    };
    call(&lib, "tab.select", json!({"book": id, "id": ideas_tab}));
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    pump(cx);
    sidebar.read_with(cx, |s, cx| {
        assert_eq!(
            s.state(cx)["selected"],
            json!(ideas_tab),
            "opens where it was left"
        )
    });
    // Choosing another Tab is remembered in the project.
    let book_tab = view.read_with(cx, |ws, _| tabs_of(ws)[1].0.clone());
    sidebar.update(cx, |s, cx| s.choose(&book_tab, cx));
    wait(&view, cx, "the remembered Tab", |ws, _| {
        ws.book.v3().unwrap().project.selected_tab.as_deref() == Some(book_tab.as_str())
    });
}

/// The Tab prototype (2026-11-15): a row that does not fit scrolls sideways,
/// under an upright wheel as under a sideways one, so the last Tab can be
/// reached; the manage button stays outside, at the row's end. The strip
/// once laid its Tabs out as a block, stretched to its own width, so there
/// was nothing to scroll (sc-scenarios-v5, 2026-11-16).
#[gpui::test]
fn a_tab_row_that_does_not_fit_scrolls_sideways(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    for n in 0..6 {
        let entry = call(
            &lib,
            "entry.create",
            json!({"book": id, "title": format!("A rather long outermost entry {n}"), "template": "tpl-group"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        call(
            &lib,
            "tab.put",
            json!({"book": id, "mount": {"kind": "entry", "entry": entry}}),
        );
    }
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    // The column slides open: measure the row once it is all there.
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(cx, |ws, _| ws.left.shown() < 1.0) {
        assert!(Instant::now() < deadline, "the left column opens");
        std::thread::sleep(Duration::from_millis(5));
        pump(cx);
    }
    pump(cx);
    let (first, last) = view.read_with(cx, |ws, _| {
        let tabs = tabs_of(ws);
        (tabs[0].0.clone(), tabs.last().unwrap().0.clone())
    });
    let selected =
        |cx: &mut VisualTestContext| sidebar.read_with(cx, |s, cx| s.state(cx)["selected"].clone());
    let strip = cx.debug_bounds("v3-tab-strip").expect("the Tab row");
    let end = point(strip.right() - px(3.), strip.center().y);
    let start = point(strip.left() + px(3.), strip.center().y);
    // The row overflows: what shows at its end is not the last Tab.
    cx.simulate_click(end, Modifiers::default());
    pump(cx);
    assert_ne!(selected(cx), json!(last), "the last Tab is past the edge");
    // An upright wheel scrolls it to the end.
    cx.simulate_mouse_move(strip.center(), None, Modifiers::default());
    cx.simulate_event(ScrollEvent {
        position: strip.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-20_000.))),
        ..Default::default()
    });
    pump(cx);
    cx.simulate_click(end, Modifiers::default());
    pump(cx);
    assert_eq!(
        selected(cx),
        json!(last),
        "the wheel brought the last Tab in"
    );
    // A sideways one scrolls it back to the start.
    cx.simulate_event(ScrollEvent {
        position: strip.center(),
        delta: ScrollDelta::Pixels(point(px(20_000.), px(0.))),
        ..Default::default()
    });
    pump(cx);
    cx.simulate_click(start, Modifiers::default());
    pump(cx);
    assert_eq!(selected(cx), json!(first), "and back to the first");
    // The strip keeps to its column; the manage button stays past it, at
    // the row's end, wherever the Tabs are scrolled.
    assert_eq!(cx.debug_bounds("v3-tab-strip"), Some(strip));
    let row = cx.debug_bounds("v3-tab-row").expect("the row");
    assert!(
        row.right() - strip.right() >= px(20.),
        "room for the manage button: {row:?} {strip:?}"
    );
}

/// The Tab prototype (2026-11-15): a project left on a Tab that is gone
/// since (removed on another device, say) opens on the first Tab, not on
/// 「全部」; only a project never left on a Tab opens on 「全部」.
#[gpui::test]
fn opening_on_a_tab_that_is_gone_goes_to_the_first_tab(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (ideas_tab, first_other) = {
        let book = Book::load(&lib, &id).unwrap();
        let v = book.v3().unwrap();
        let ideas = root_of(v, "tpl-ideas");
        let ideas_tab = v
            .project
            .tabs
            .iter()
            .find(|t| {
                t.mount
                    == TabMount::Entry {
                        entry: ideas.clone(),
                    }
            })
            .unwrap()
            .id
            .clone();
        (ideas_tab, v.project.tabs[1].id.clone())
    };
    // 「全部」 dragged to the end, so the first Tab is another one.
    call(
        &lib,
        "tab.move",
        json!({"book": id, "id": "tab-all", "place": "last"}),
    );
    call(&lib, "tab.select", json!({"book": id, "id": ideas_tab}));
    call(&lib, "tab.remove", json!({"book": id, "id": ideas_tab}));
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    pump(cx);
    sidebar.read_with(cx, |s, cx| {
        assert_eq!(s.state(cx)["selected"], json!(first_other), "the first Tab")
    });
}

#[gpui::test]
fn a_tab_whose_mount_is_gone_fades_comes_back_and_can_be_removed(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    let (ideas, storylines, view_id) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        (
            root_of(v, "tpl-ideas"),
            root_of(v, "tpl-storylines"),
            v.timeline_views[0].id.clone(),
        )
    });

    // A Tab on the book: faint once the project's book is off.
    sidebar.update(cx, |s, cx| s.add_at(TabMount::Book, usize::MAX, cx));
    wait(&view, cx, "the book Tab", |ws, _| {
        tab_on(ws, &TabMount::Book).is_some()
    });
    call(
        &lib,
        "project.update",
        json!({"book": id, "has_book": false}),
    );
    wait(&view, cx, "the book off", |ws, _| {
        ws.book.v3().unwrap().project.book.is_none()
    });
    pump(cx);
    sidebar.read_with(cx, |s, cx| {
        let tabs = s.state(cx)["tabs"].as_array().unwrap().clone();
        let book = tabs.iter().find(|t| t["mount"]["kind"] == "book").unwrap();
        assert_eq!(book["gone"], json!(true), "the Tab stays, faded");
        assert_eq!(book["name"], json!("成书"));
    });

    // The storylines' level in Recently Deleted: faint, called as before;
    // restored, it is lit again.
    let mount = TabMount::Entry {
        entry: storylines.clone(),
    };
    call(&lib, "entry.trash", json!({"book": id, "id": storylines}));
    wait(&view, cx, "the trash", |ws, _| {
        ws.book.v3().unwrap().entry(&storylines).is_none()
    });
    view.read_with(cx, |ws, cx| {
        let v = ws.book.v3().unwrap();
        assert!(tabs::is_gone(v, &mount));
        assert_eq!(tabs::mount_name(v, &mount, cx).as_ref(), "故事线");
    });
    call(&lib, "entry.restore", json!({"book": id, "id": storylines}));
    wait(&view, cx, "the restore", |ws, _| {
        !tabs::is_gone(ws.book.v3().unwrap(), &mount)
    });

    // A Tab cannot mount a view (DV, `kernel-v5.md` §15 item 15). One a
    // book stored before reads as gone while the view is still there, is
    // called by the view's name, and its 「去掉这个 Tab」 removes it and goes
    // back to the first Tab.
    let view_mount = TabMount::View {
        view: view_id.clone(),
    };
    let (book_id, stored_view) = (
        dr_model::id::BookId::parse(&id).unwrap(),
        dr_model::id::TimelineViewId::parse(&view_id).unwrap(),
    );
    lib.library()
        .open_doc(&format!("book:{id}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Import, move |doc| {
            dr_doc::v3::BorrowedBookV3::new(doc, &book_id)
                .unwrap()
                .txn()
                .project()
                .put_tab(&dr_model::v3::ProjectTab {
                    id: dr_model::id::TabId::parse("tab-old-view").unwrap(),
                    pos: None,
                    mount: dr_model::v3::TabMount::View { view: stored_view },
                    gone_title: None,
                })
                .unwrap();
        })
        .unwrap();
    wait(&view, cx, "the old view Tab", |ws, _| {
        tab_on(ws, &view_mount).is_some()
    });
    view.read_with(cx, |ws, cx| {
        let v = ws.book.v3().unwrap();
        assert!(v.timeline_view(&view_id).is_some(), "the view is there");
        assert!(tabs::is_gone(v, &view_mount));
        let name = v.timeline_view(&view_id).unwrap().name.clone();
        assert_eq!(tabs::mount_name(v, &view_mount, cx).as_ref(), name);
    });
    let view_tab = view.read_with(cx, |ws, _| tab_on(ws, &view_mount).unwrap());
    sidebar.update(cx, |s, cx| {
        s.choose(&view_tab, cx);
        s.remove_gone(&view_tab, cx);
    });
    wait(&view, cx, "the gone Tab removed", |ws, _| {
        tab_on(ws, &view_mount).is_none()
    });
    let first = view.read_with(cx, |ws, _| tabs_of(ws)[0].0.clone());
    sidebar.read_with(cx, |s, cx| {
        assert_eq!(s.state(cx)["selected"], json!(first))
    });

    // The ideas' Tab removed: the level is mounted nowhere, and still opens.
    let ideas_tab = view.read_with(cx, |ws, _| {
        tab_on(
            ws,
            &TabMount::Entry {
                entry: ideas.clone(),
            },
        )
        .unwrap()
    });
    sidebar.update(cx, |s, cx| s.remove(&ideas_tab, cx));
    wait(&view, cx, "the removal", |ws, _| {
        tabs_of(ws).iter().all(|t| t.0 != ideas_tab)
    });
    let target = Target::Entry {
        id: ideas.parse().unwrap(),
        module: None,
    };
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    wait(&view, cx, "the ideas page", |ws, cx| {
        ws.editors
            .get(&target.key())
            .and_then(|p| p.v3.clone())
            .is_some_and(|page| page.read(cx).synced)
    });
    view.read_with(cx, |ws, cx| {
        let page = ws.editors[&target.key()].v3.clone().unwrap();
        let page = page.read(cx);
        let below = page.sections.iter().find(|s| s.kind == "children").unwrap();
        assert!(below.registered, "the level shows what lives under it");
    });
}

#[gpui::test]
fn an_entry_opens_in_one_tab_from_the_home_page_and_from_the_left_column(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let chapter = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        v.entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap()
            .id
            .clone()
    });
    let from_column = Target::Entry {
        id: chapter.parse().unwrap(),
        module: None,
    };
    let from_home = Target::Entry {
        id: chapter.parse().unwrap(),
        module: Some("mod-prose".parse().unwrap()),
    };
    view.update(cx, |ws, cx| ws.open(from_column.clone(), Open::PREVIEW, cx));
    pump(cx);
    view.update(cx, |ws, cx| ws.open(from_home.clone(), Open::KEEP, cx));
    pump(cx);
    view.read_with(cx, |ws, _| {
        assert_eq!(ws.nav.tabs().len(), 1);
        assert!(ws.nav.is_selected(&from_column) && ws.nav.is_selected(&from_home));
        assert_eq!(ws.editors.len(), 1, "one page");
    });
}

/// One entry is one page, whichever module a target names: closing an
/// entry's tab and opening it again by module in the same frame turns to
/// no other page. It used to turn from `entry:X` to `entry:X/<module>`,
/// drawing the one page view twice in a frame, underneath and in front;
/// with accessibility on, its focused element claimed the focus twice and
/// GPUI's debug builds panicked (sc-scenarios-v5, 2026-11-16). The test
/// platform has no accessibility, so this watches the turn itself.
#[gpui::test]
fn closing_an_entrys_tab_and_opening_it_by_module_in_one_frame_turns_no_page(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let chapters: Vec<String> = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        v.entries
            .iter()
            .filter(|e| e.template.as_deref() == Some("tpl-chapter"))
            .map(|e| e.id.clone())
            .take(2)
            .collect()
    });
    let page = Target::Entry {
        id: chapters[0].parse().unwrap(),
        module: None,
    };
    let by_module = Target::Entry {
        id: chapters[0].parse().unwrap(),
        module: Some("mod-prose".parse().unwrap()),
    };
    let turning = |cx: &mut VisualTestContext| cx.debug_bounds("page-main-under").is_some();
    // The home page turns to the entry's; let the turn finish.
    view.update(cx, |ws, cx| ws.open(page.clone(), Open::KEEP, cx));
    pump(cx);
    assert!(turning(cx), "the home page turns to the entry's");
    let deadline = Instant::now() + Duration::from_secs(10);
    while turning(cx) {
        assert!(Instant::now() < deadline, "the turn ends");
        std::thread::sleep(Duration::from_millis(5));
        pump(cx);
    }
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.current().cloned()),
        Some(page.clone())
    );
    // Closed and opened again by module before the next frame: what
    // `CloseActiveTab` does, then an open, in one update (the test platform
    // draws at the end of each).
    view.update(cx, |ws, cx| {
        assert!(ws.nav.close_active(), "the tab closes");
        assert!(ws.nav.current() != Some(&page));
        ws.open(by_module.clone(), Open::KEEP, cx);
    });
    pump(cx);
    view.read_with(cx, |ws, _| assert_eq!(ws.nav.current(), Some(&by_module)));
    assert!(!turning(cx), "the same page: nothing to turn from");
    // Another entry still turns the page.
    let other = Target::Entry {
        id: chapters[1].parse().unwrap(),
        module: None,
    };
    view.update(cx, |ws, cx| ws.open(other, Open::KEEP, cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(turning(cx), "another page turns in");
}

#[gpui::test]
fn a_mark_is_the_entrys_own_or_its_templates_and_every_surface_follows(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let (chapter, template) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let e = v
            .entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap();
        (e.id.clone(), e.template.clone().unwrap())
    });
    let target = Target::Entry {
        id: chapter.parse().unwrap(),
        module: None,
    };
    let seal = view.read_with(cx, |ws, _| ws.book.mark(&target).0);
    assert!(matches!(seal, sand::Kind::Chapter(_)));

    // One character of its own: every surface draws it (the left column,
    // tab pills and hover cards all read the book's mark).
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": chapter, "mark": "岬"}),
    );
    wait(&view, cx, "the mark", |ws, _| {
        matches!(ws.book.mark(&target).0, sand::Kind::Glyph(_))
    });
    view.read_with(cx, |ws, _| {
        let sand::Kind::Glyph(glyph) = ws.book.mark(&target).0 else {
            unreachable!()
        };
        assert_eq!(glyph.text().as_ref(), "岬");
        assert_eq!(
            ws.book
                .v3()
                .unwrap()
                .appearance(&chapter)
                .unwrap()
                .mark
                .as_deref(),
            Some("岬")
        );
    });
    // A sand mark of its own.
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": chapter, "mark": "compass"}),
    );
    wait(&view, cx, "the sand mark", |ws, _| {
        ws.book.mark(&target).0 == sand::Kind::Storyline
    });
    // ⌘Z: the character again.
    cx.update(|window, cx| {
        let focus = view.read(cx).focus_handle().clone();
        focus.focus(window, cx);
    });
    cx.dispatch_action(Undo);
    wait(&view, cx, "the undo", |ws, _| {
        matches!(ws.book.mark(&target).0, sand::Kind::Glyph(_))
    });
    // Back to the template's: it follows the template's mark.
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": chapter, "mark": null}),
    );
    wait(&view, cx, "the template's mark", |ws, _| {
        matches!(ws.book.mark(&target).0, sand::Kind::Chapter(_))
    });
    let mut tpl = view.read_with(cx, |ws, _| {
        serde_json::to_value(ws.book.v3().unwrap().template(&template).unwrap()).unwrap()
    });
    tpl["mark"] = json!("🌊");
    call(
        &lib,
        "entry_template.put",
        json!({"book": id, "template": tpl}),
    );
    wait(
        &view,
        cx,
        "the template's character",
        |ws, _| matches!(ws.book.mark(&target).0, sand::Kind::Glyph(g) if g.text().as_ref() == "🌊"),
    );
}

#[test]
fn marks_are_sand_names_or_one_character() {
    assert!(matches!(
        mark(Some("file-text"), "x"),
        sand::Kind::Chapter(_)
    ));
    assert_eq!(mark(Some("square"), "x"), sand::Kind::Element);
    assert!(matches!(mark(Some("岬"), "x"), sand::Kind::Glyph(_)));
    assert!(matches!(mark(Some("a"), "x"), sand::Kind::Glyph(_)));
    assert!(matches!(mark(Some("👩‍👩‍👧"), "x"), sand::Kind::Glyph(_)));
    // A name this build does not know is the square seal, not its letters.
    assert_eq!(mark(Some("future-mark"), "x"), sand::Kind::Element);
    assert!(!is_glyph_mark("future-mark") && !is_glyph_mark("ab") && !is_glyph_mark(""));
}

#[gpui::test]
fn dragging_in_the_book_tab_moves_in_the_dropped_layer(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());

    // The book reads from the root (DW): dragging in the Tab mounted on it
    // changes the order of the layer it is dropped in, here 书稿's manual
    // order.
    let (first, second, parent) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        assert!(v.project.book.is_some());
        let seq = v.book_entries();
        let parent = v.entry(&seq[0]).unwrap().parent.clone();
        let second = seq
            .iter()
            .skip(1)
            .find(|e| v.entry(e).unwrap().parent == parent)
            .unwrap()
            .clone();
        (seq[0].clone(), second, parent.unwrap())
    });
    let h = host(&view, &lib, &id, cx);
    cx.update(|_, cx| tabs::drop_in_book(&h, &second, &first, false, cx));
    wait(&view, cx, "the manual order", |ws, _| {
        let v = ws.book.v3().unwrap();
        let children = &v.levels[&parent].children;
        children.iter().position(|x| *x == second) < children.iter().position(|x| *x == first)
    });
    view.read_with(cx, |ws, _| {
        let seq = ws.book.v3().unwrap().book_entries();
        assert!(seq.iter().position(|x| *x == second) < seq.iter().position(|x| *x == first));
    });
}

/// `Book::load` alone (no window): a lane holds what is hung on it, along
/// the view's scale (DV, `kernel-v5.md` §16 「泳道」).
#[test]
fn a_lane_lists_what_is_hung_on_it_along_its_scale() {
    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let v = book.v3().unwrap();
    let tv = &v.timeline_views[0];
    assert!(!tv.lanes.is_empty());
    for lane in &tv.lanes {
        let order = v.lane_entries(tv, &lane.entry);
        let at: Vec<Option<f64>> = order
            .iter()
            .map(|e| tv.placements.iter().find(|p| p.entry == *e).map(|p| p.at))
            .collect();
        let placed: Vec<f64> = at.iter().flatten().copied().collect();
        assert!(placed.windows(2).all(|w| w[0] <= w[1]), "along the scale");
        // Unplaced ones last.
        let first_unplaced = at.iter().position(Option::is_none).unwrap_or(at.len());
        assert!(at[first_unplaced..].iter().all(Option::is_none));
        // What is hung on it, each once; what only lives under it is not.
        let level = &v.levels[&lane.entry];
        let mut expect: Vec<&String> = level.members.iter().collect();
        expect.sort();
        expect.dedup();
        let mut got: Vec<&String> = order.iter().collect();
        got.sort();
        assert_eq!(got, expect);
    }
}

/// T9 review item 5: the left column redraws every frame. What its filled
/// Tab shows is refreshed when the book changes, not on every redraw (a
/// refresh sorts the whole list and may read update times from the
/// library).
#[gpui::test]
fn a_filled_tab_refreshes_its_list_only_when_the_book_changes(cx: &mut TestAppContext) {
    use dr_shell::workspace::FillPlace;
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    let refreshes = Rc::new(Cell::new(0usize));
    let made = Rc::new(Cell::new(0usize));
    let (count, makes) = (refreshes.clone(), made.clone());
    cx.update(|_, cx| {
        v3::add_level_display(cx, "list", move |_, _, cx| {
            makes.set(makes.get() + 1);
            let count = count.clone();
            Rendered::new(cx.new(|_| DummyPart)).on_refresh(move |_, _| count.set(count.get() + 1))
        });
    });
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    cx.update(|window, cx| {
        view.update(cx, |ws, cx| {
            ws.enter_fill(FillPlace::Left, window, cx);
        })
    });
    wait(&view, cx, "the filled column", |ws, _| {
        ws.is_filled(FillPlace::Left) && ws.fill_progress(FillPlace::Left) >= 1.0
    });
    wait(&view, cx, "the filled list", |_, _| made.get() > 0);
    let before = refreshes.get();
    for _ in 0..12 {
        // Every frame draws the column again.
        sidebar.update(cx, |_, cx| cx.notify());
        pump(cx);
    }
    assert_eq!(
        refreshes.get(),
        before,
        "redrawing with the same book refreshes nothing"
    );
    let revision = view.read_with(cx, |ws, _| ws.book.v3().unwrap().revision.clone());
    let root = view.read_with(cx, |ws, _| root_of(ws.book.v3().unwrap(), "tpl-manuscript"));
    call(
        &lib,
        "entry.create",
        json!({"book": id, "parent": root, "template": "tpl-chapter", "title": "Synthetic refresh"}),
    );
    wait(&view, cx, "the new book", |ws, _| {
        ws.book.v3().is_some_and(|v| v.revision != revision)
    });
    pump(cx);
    let after = refreshes.get();
    assert!(after > before, "a new book refreshes the list");
    for _ in 0..12 {
        sidebar.update(cx, |_, cx| cx.notify());
        pump(cx);
    }
    assert_eq!(refreshes.get(), after);
}
